import { AsyncLocalStorage } from "node:async_hooks";

export class OperationTimeoutError extends Error {}

// Invalid/zero settings never disable a deadline. Upper bound avoids timer
// overflow; defaults leave room for CPU-only model loading/prefill on Pi.
export function timeoutSetting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 7_200_000 ? value : fallback;
}

export function operationDeadline(ms: number, parent?: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason || new Error("Operation cancelled"));
  const timer = setTimeout(() => controller.abort(new OperationTimeoutError(`Operation timed out after ${ms}ms`)), ms);
  if (parent?.aborted) cancel();
  else parent?.addEventListener("abort", cancel, { once: true });
  return { controller, signal: controller.signal, dispose() {
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
  } };
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled");
}

// This bounds waiting, not arbitrary underlying work. Callers must also pass
// the same signal to abortable I/O, or use an independently bounded operation.
export function waitForOperation<T>(work: Promise<T>, signal: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation cancelled"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then(value => {
      if (settled) { try { disposeLate?.(value); } catch {} return; }
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, error => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

// Native request-local context carries cancellation through existing registered
// handler wrappers without a global mutable signal or model-supplied argument.
const toolSignals = new AsyncLocalStorage<AbortSignal>();
export const currentToolSignal = (): AbortSignal | undefined => toolSignals.getStore();
export const withToolSignal = <T>(signal: AbortSignal, work: () => T): T => toolSignals.run(signal, work);
