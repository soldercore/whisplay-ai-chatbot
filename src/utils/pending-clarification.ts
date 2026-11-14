// A host-side question that expects the user's next request as its answer (for example "TV screen or Whisplay's
// screen?"). This only drives a display hint; it never opens the microphone.
let until = 0;
export const markClarification = (ms: number): void => { until = Date.now() + ms; };
export const clearClarification = (): void => { until = 0; };
export const clarificationRemainingMs = (): number => Math.max(0, until - Date.now());

/** Status string for the idle screen: the existing generic state while a question is pending, otherwise "idle". */
export const idleStatusFor = (remainingMs: number): "Your turn" | "idle" => (remainingMs > 0 ? "Your turn" : "idle");
