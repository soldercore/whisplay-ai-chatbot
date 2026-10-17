import { ChildProcess, spawn } from "child_process";

// Ownership belongs to actual ChildProcess objects, never names or port owners.
const children = new Map<ChildProcess, boolean>();
const childStops = new WeakMap<ChildProcess, Promise<void>>();
const hooks = new Set<() => void>();
const controller = new AbortController();
let stopping: Promise<void> | undefined;
let installed = false;
export const appSignal = controller.signal;
export const onAppShutdown = (hook: () => void): void => { hooks.add(hook); };

export function ownChild<T extends ChildProcess>(child: T, group = false): T {
  if (controller.signal.aborted) throw new Error("Application is shutting down");
  children.set(child, group && process.platform !== "win32");
  // A failed spawn has no PID. A later signal error is not proof of exit.
  const failedSpawn = () => { if (!child.pid) forget(); };
  const forget = () => { children.delete(child); child.off("error", failedSpawn); };
  child.once("exit", forget);
  child.on("error", failedSpawn);
  return child;
}

// Keeps normal spawn arguments/stdio/formatting intact, including test doubles.
export const spawnOwned: typeof spawn = ((...args: any[]) => {
  if (controller.signal.aborted) throw new Error("Application is shutting down");
  const options = Array.isArray(args[1]) ? args[2] : args[1];
  return ownChild(Reflect.apply(spawn, undefined, args), !!options?.detached);
}) as typeof spawn;

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!children.has(child) || !child.pid) return;
  try {
    if (children.get(child)) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error: any) {
    if (error.code !== "ESRCH") console.error(`[Lifecycle] ${signal} failed for owned child`, error.code);
  }
}

export function stopOwnedChild(child: ChildProcess): Promise<void> {
  const pending = childStops.get(child);
  if (pending) return pending;
  if (!children.has(child)) return Promise.resolve();
  const stopped = new Promise<void>((resolve, reject) => {
    let killTimer: ReturnType<typeof setTimeout>;
    let endTimer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(killTimer); clearTimeout(endTimer);
      child.off("exit", finish); child.off("error", failedSpawn);
    };
    const finish = () => { cleanup(); resolve(); };
    const failedSpawn = () => { if (!child.pid) finish(); };
    child.once("exit", finish); child.on("error", failedSpawn);
    killTimer = setTimeout(() => signalChild(child, "SIGKILL"), 3000);
    endTimer = setTimeout(() => {
      console.error("[Lifecycle] Owned child did not exit after TERM/KILL", child.pid);
      cleanup(); reject(new Error("Owned child exit was not confirmed"));
    }, 5000);
    signalChild(child, "SIGTERM");
  });
  childStops.set(child, stopped);
  return stopped;
}

// Called once by signals, startup failure or the daemon's app-exit event.
export function stopApplication(): Promise<void> {
  if (!stopping) {
    controller.abort(new Error("Application shutdown"));
    stopping = Promise.resolve().then(async () => {
      for (const hook of hooks) { try { hook(); } catch (e) { console.error("[Lifecycle] Cleanup failed", e); } }
      await Promise.all([...children.keys()].map(stopOwnedChild));
    });
  }
  return stopping;
}

export function shutdownApplication(code = 0): void {
  void stopApplication().then(() => process.exit(code), () => process.exit(1));
}

export function installAppShutdown(): void {
  if (installed) return;
  installed = true;
  process.on("SIGINT", () => shutdownApplication());
  process.on("SIGTERM", () => shutdownApplication());
  process.on("uncaughtException", error => { console.error(error); shutdownApplication(1); });
  process.on("unhandledRejection", error => { console.error(error); shutdownApplication(1); });
  // Last resort for an explicit exit in an unmigrated provider. Never signal a
  // child that already exited (its PID may now belong to somebody else).
  process.on("exit", () => { for (const child of children.keys()) signalChild(child, "SIGKILL"); });
}
