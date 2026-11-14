// A host-side question that expects the user's next request as its answer (for example "TV screen or Whisplay's
// screen?"). The 30 s context is kept by the provider; this module only tracks the window, one optional automatic
// listen for the first question, and the display hint. It never touches the microphone itself.
let until = 0;
let listenArmed = false;
let listenSpent = false;

/** Start the clarification window. Only a first question arms the automatic listen; a repeated question does not. */
export const markClarification = (ms: number, options: { listen?: boolean } = {}): void => {
  until = Date.now() + ms;
  listenArmed = options.listen !== false;
  listenSpent = false;
};
export const clearClarification = (): void => { until = 0; listenArmed = false; listenSpent = false; };
export const clarificationRemainingMs = (): number => Math.max(0, until - Date.now());

/** True exactly once per armed question, and only while its window is open. */
export const takeListenRequest = (): boolean => {
  if (!listenArmed || clarificationRemainingMs() <= 0) return false;
  listenArmed = false;
  listenSpent = true;
  return true;
};

/** After the answer finished playing: reopen the existing capture once, unless a wake session or an ending conversation owns the flow. */
export const shouldListenAfterAnswer = (state: { wakeSessionActive: boolean; endAfterAnswer: boolean }): boolean =>
  !state.wakeSessionActive && !state.endAfterAnswer && takeListenRequest();

/** Window for the idle hint: none once the automatic listen has been used, so the screen is not left claiming a turn. */
export const clarificationDisplayMs = (): number => (listenSpent ? 0 : clarificationRemainingMs());

/** Pause between the end of playback and opening the microphone, so the speaker output is not captured. */
export const CLARIFICATION_SETTLE_MS = 300;

/** Bounded capture window (seconds) for the one short follow-up answer. */
export const clarificationListenSeconds = (env: NodeJS.ProcessEnv = process.env): number => {
  const value = parseInt(env.CLARIFICATION_LISTEN_SEC || "7", 10);
  return Number.isFinite(value) ? Math.min(10, Math.max(3, value)) : 7;
};

/** Status string for the idle screen: the existing generic state while a question is pending, otherwise "idle". */
export const idleStatusFor = (remainingMs: number): "Your turn" | "idle" => (remainingMs > 0 ? "Your turn" : "idle");
