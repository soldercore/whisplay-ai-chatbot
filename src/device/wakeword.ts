import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import { appSignal, spawnOwned as spawn, stopOwnedChild } from "../utils/app-lifecycle";
import { resolve } from "path";
import dotenv from "dotenv";
dotenv.config();

const pythonBinary = process.env.WAKE_WORD_PYTHON_PATH || "python3";

export class WakeWordListener extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private stopping: Promise<void> | null = null;
  private wakePending: boolean = false;
  private pendingSpeechEnd: { at: number; agoMs: number } | undefined;   // from the wake script's own last loud frame
  private wanted = false;
  private restartPending = false;
  private generation = 0;

  private retry: ReturnType<typeof setTimeout> | undefined;

  // Resident Capri (CAPRI_RESIDENT, default on; "0" = one process per listen as before). One Python process keeps openWakeWord
  // loaded; start() resumes its microphone and stop() pauses it. stop() resolves only after the process printed CAPRI_PAUSED, which
  // it does after its SoX child has exited. All pause/resume steps run one at a time in settle(). A step that is not acknowledged in
  // time, a failed write or an exit discards the process (confirmed exit) and a new one is started when Capri is wanted again.
  static timeouts = { loadMs: 30_000, resumeMs: 2_000, pauseMs: 2_500 };
  private readonly resident: boolean;
  private listening = false;   // resume acknowledged and no pause acknowledged since: the microphone may be open
  private expected: { line: string; finish: (ok: boolean) => void } | null = null;
  private settling: Promise<void> | null = null;
  private releaseWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private unconfirmed: ChildProcess | null = null;   // killed without a confirmed exit: never start a second microphone owner

  constructor(private readonly capri = false) {
    super();
    this.resident = capri && process.env.CAPRI_RESIDENT !== "0";
  }

  start(): void {
    const enabled = (this.capri ? process.env.CAPRI_WAKE_WORD_ENABLED : process.env.WAKE_WORD_ENABLED)?.toLowerCase();
    if (enabled !== "true" || appSignal.aborted) return;
    this.wanted = true;
    this.generation++;
    if (this.resident) { void this.settle(); return; }

    if (this.stopping) {
      if (!this.restartPending) {
        this.restartPending = true;
        void this.stopping.then(() => {
          this.restartPending = false;
          if (this.wanted && !appSignal.aborted) this.start();
        }, () => { this.restartPending = false; });
      }
      return;
    }
    if (this.process) return;
    this.launch();
  }

  private launch(): ChildProcess {
    const scriptPath = resolve(__dirname, this.capri ? "../../python/capri_wake.py" : "../../python/wakeword.py");
    const child = spawn(pythonBinary, [scriptPath], {
      env: process.env,
      detached: process.platform !== "win32",
      stdio: [this.resident ? "pipe" : "ignore", "pipe", "pipe"],
    });
    child.stdin?.on("error", () => undefined);   // a write to an exited process: handled by its exit
    this.process = child;
    this.buffer = "";
    this.wakePending = false;

    child.stdout?.on("data", (data: Buffer) => {
      if (this.process !== child || appSignal.aborted) return;
      this.buffer += data.toString();
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (this.capri && line === "CAPRI_READY") {
          console.log(`[WakeWord] ${line}`);   // unchanged log line: health checks and operators rely on it
          this.emit("ready");   // the passive listener is running; it is not recording a command
        } else if (this.capri && line === "CAPRI_AUDIO") {
          console.log(`[WakeWord] ${line}`);
          if (this.wanted) this.emit("audio");   // sound passed the start level in the active command capture
        } else if (this.capri && line.startsWith("CAPRI_WAKE ")) {
          // The detector fired: acknowledge at once. The command capture is NOT running yet (probe and chime follow).
          const sentAt = Number(line.slice("CAPRI_WAKE ".length));
          const agoMs = Number.isFinite(sentAt) ? Math.max(0, Date.now() - sentAt * 1000) : undefined;
          if (this.wanted) this.emit("heard", agoMs);
        } else if (this.capri && line === "CAPRI_PROCESSING") {
          console.log(`[WakeWord] ${line}`);
          if (this.wanted) this.emit("processing");   // the command capture ended; transcription follows
        } else if (this.capri && line.startsWith("CAPRI_TIMING ")) {
          console.log(`[WakeWord] ${line}`);
          const agoMs = Number(line.slice("CAPRI_TIMING ".length));
          this.pendingSpeechEnd = Number.isFinite(agoMs) && agoMs >= 0 && agoMs < 60_000 ? { at: performance.now(), agoMs } : undefined;
        } else if (this.resident && (line === "CAPRI_PAUSED" || line === "CAPRI_RESUMED")) {
          this.listening = line === "CAPRI_RESUMED";
          if (this.listening) this.wakePending = false;   // a new listen: its command is accepted
          if (this.expected?.line === line) this.expected.finish(true);
        } else if (this.capri && (line === "CAPRI_LISTENING" || line === "CAPRI_IDLE")) {
          if (this.wanted) this.emit(line === "CAPRI_LISTENING" ? "listening" : "idle");
        } else if ((this.capri ? line.startsWith("CAPRI_COMMAND ") : line.startsWith("WAKE")) && !this.wakePending) {
          this.wakePending = true;
          // The wake-word process owns the capture device. Do not notify the
          // chat flow until it and its SoX child have released the microphone.
          const stopped = this.stop();
          const speechEndAt = this.pendingSpeechEnd ? this.pendingSpeechEnd.at - this.pendingSpeechEnd.agoMs : undefined;
          this.pendingSpeechEnd = undefined;
          const generation = this.generation;
          void stopped.then(() => {
            if (this.generation !== generation || appSignal.aborted) return;
            if (!this.capri) {
              this.emit("wake", line);
              return;
            }
            const command: unknown = JSON.parse(line.slice("CAPRI_COMMAND ".length));
            if (typeof command === "string" && command.trim()) this.emit("command", command.trim(), speechEndAt);
          }).catch(error => console.error("[WakeWord] Microphone release failed:", error));
        } else if (line) {
          console.log(`[WakeWord] ${line}`);
        }
        newlineIndex = this.buffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        console.error(`[WakeWord] ${message}`);
      }
    });

    const lost = () => {
      if (this.process !== child) return;
      this.process = null;
      this.listening = false;
      this.expected?.finish(false);
      if (this.capri && this.wanted && !appSignal.aborted) {
        this.emit("unavailable");
        this.emit("idle");
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (this.wanted && !appSignal.aborted) this.start();
        }, 1500);
      }
      if (this.resident) this.flushRelease();
    };
    child.on("close", (code) => {
      console.log(`[WakeWord] process exited with code ${code}`);
      lost();
    });
    child.once("error", error => {
      console.error("[WakeWord] Process failed:", error);
      if (!child.pid && this.process === child) {
        if (this.resident) lost();
        else this.process = null;
      }
    });
    return child;
  }

  private settle(): Promise<void> {
    if (!this.settling) {
      this.settling = (async () => {
        for (let step = this.nextStep(); step; step = this.nextStep()) {
          await step();
          this.flushRelease();
        }
      })().finally(() => {
        this.settling = null;
        this.flushRelease();
        if (this.nextStep()) void this.settle();   // asked for while the last step was finishing
      });
    }
    return this.settling;
  }

  private nextStep(): (() => Promise<void>) | null {
    if (appSignal.aborted || this.unconfirmed) return null;
    const child = this.process;
    if (this.wanted) {
      if (!child) return this.retry ? null : () => this.expect(this.launch(), "CAPRI_PAUSED", WakeWordListener.timeouts.loadMs);
      return this.listening ? null : () => this.send(child, "resume", "CAPRI_RESUMED", WakeWordListener.timeouts.resumeMs);
    }
    return child && this.listening ? () => this.send(child, "pause", "CAPRI_PAUSED", WakeWordListener.timeouts.pauseMs) : null;
  }

  private send(child: ChildProcess, command: string, line: string, ms: number): Promise<void> {
    const acknowledged = this.expect(child, line, ms);
    const fail = this.expected!.finish;
    try {
      child.stdin!.write(`${command}
`, error => { if (error) fail(false); });
    } catch {
      fail(false);
    }
    return acknowledged;
  }

  /** Waits for `line` from this process. Not acknowledged in time (or the process ended): discard it with a confirmed exit. */
  private expect(child: ChildProcess, line: string, ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.expected?.finish === finish) this.expected = null;
        if (ok || this.process !== child) return resolve();
        console.error(`[WakeWord] Capri did not acknowledge ${line}; restarting it`);
        this.process = null;
        this.listening = false;
        stopOwnedChild(child).catch(() => {
          this.unconfirmed = child;
          child.once("exit", () => { this.unconfirmed = null; void this.settle(); });
        }).finally(resolve);
      };
      const timer = setTimeout(() => finish(false), ms);
      this.expected = { line, finish };
    });
  }

  private flushRelease(): void {
    if (this.listening && !this.unconfirmed) return;
    const waiters = this.releaseWaiters.splice(0);
    for (const waiter of waiters) {
      if (this.unconfirmed) waiter.reject(new Error("Capri microphone release was not confirmed"));
      else waiter.resolve();
    }
  }

  stop(): Promise<void> {
    this.wanted = false;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    this.generation++;
    if (this.resident) {
      const released = new Promise<void>((resolve, reject) => this.releaseWaiters.push({ resolve, reject }));
      void this.settle();
      return released;
    }
    if (this.stopping) return this.stopping;
    const child = this.process;
    if (!child) return Promise.resolve();

    // Share the custom application's ownership boundary: wait for confirmed
    // exit, and terminate only our own Python/SoX process group. Never report
    // release merely because a kill timer or an error event fired.
    this.stopping = stopOwnedChild(child).then(() => {
      if (this.process === child) {
        this.process = null;
      }
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
