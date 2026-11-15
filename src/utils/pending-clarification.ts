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

// ---- Conversational follow-ups ------------------------------------------------------------------------------------
// After an ordinary spoken answer the same bounded listen (the settle and the 7 s window above) can reopen, so a conversation
// continues without saying "Capri" again. It is a short chain: silence, a device or tool action, a failure, an interruption or
// an ending phrase all return to normal idle operation.

/** Maximum automatic follow-up turns per conversation. CONVERSATION_FOLLOWUPS=0 disables them (default 3, at most 5). */
export const conversationFollowUpLimit = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = (env.CONVERSATION_FOLLOWUPS ?? "").trim();
  if (raw === "") return 3;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(5, Math.max(0, value)) : 3;
};

export interface ConversationState {
  used: number;                 // follow-ups already taken in this conversation
  limit: number;
  wakeSessionActive: boolean;   // the old wake-session loop owns the flow
  endAfterAnswer: boolean;      // the user said goodbye / stop, or the model ended the conversation
  toolRan: boolean;             // any tool or host-routed device action ran in this turn
  failed: boolean;              // the answer did not complete
  answered: boolean;            // some text was actually produced
  musicNext: boolean;
}

/** True when the finished answer is an ordinary conversational reply that may be followed by one more listen. */
export const shouldContinueConversation = (s: ConversationState): boolean =>
  s.limit > 0 && s.used < s.limit && !s.wakeSessionActive && !s.endAfterAnswer && !s.toolRan && !s.failed && s.answered
  && !s.musicNext && clarificationRemainingMs() === 0;   // a pending clarification keeps its own, existing one-shot rules

const NOISE_TRANSCRIPTS = /^(?:you|thank you|thanks|thanks for watching|bye|goodbye|okay|ok|uh|um|hmm|mm|huh|oh|ah)$/;

/** A follow-up capture that heard nothing usable: empty, punctuation only, or the stock phrases speech recognition invents on noise. */
export const isNoiseTranscript = (text: string): boolean => {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  return words.length < 2 || NOISE_TRANSCRIPTS.test(words);
};

// ---- Question-triggered follow-ups -------------------------------------------------------------------------------
// When the reply itself ends with a genuine question to the user, the same bounded listen reopens, independently of the general
// conversational follow-ups above. QUESTION_FOLLOWUPS=N allows up to N follow-ups per conversation (default 0 = off, at most 5).

export const questionFollowUpLimit = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = (env.QUESTION_FOLLOWUPS ?? "").trim();
  if (raw === "") return 0;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(5, Math.max(0, value)) : 0;
};

const RHETORICAL_TAIL = /\b(?:isn'?t it|aren'?t (?:they|you)|wasn'?t it|doesn'?t it|don'?t you think|wouldn'?t you say|am i wrong|right|correct|okay|ok|no|yes|huh|eh|really|seriously|who knows|who cares|who would have thought|can you believe it|how (?:surprising|shocking|fascinating|wonderful))\s*\?$/i;
const RHETORICAL_OPEN = /^(?:who (?:knows|cares|would have thought)|what (?:does it matter|difference does it make)|why (?:would|should) (?:anyone|anybody|i|we)|how (?:could|would) (?:anyone|anybody|i))\b/i;
const ASKS_USER = /\b(?:you|your|yours|yourself)\b|^(?:what|which|who|where|when|why|how|do|does|did|are|is|can|could|would|will|shall|should|have|has)\b/i;

/** True when the reply ENDS with a question put to the user. A question followed by more text, a quoted question, a tag or
 *  stock rhetorical question, or a very short one ("Really?") does not count. */
export const isGenuineQuestion = (text: string): boolean => {
  const body = text.replace(/\s+/g, " ").replace(/[\s\p{Extended_Pictographic}️]+$/gu, "").trim();
  if (!body.endsWith("?")) return false;                                   // also rejects ?" and ?) (inside a quote or an aside)
  const sentence = (body.split(/(?<=[.!?…])\s+/).pop() ?? "").trim();
  if (!sentence.endsWith("?")) return false;
  const quotes = (sentence.match(/["“”]/g) ?? []).length;
  if (quotes % 2 === 1 || /^["“‘]/.test(sentence)) return false;  // the question sits inside a quotation
  if (sentence.split(" ").filter(Boolean).length < 3) return false;
  if (RHETORICAL_TAIL.test(sentence) || RHETORICAL_OPEN.test(sentence)) return false;
  return ASKS_USER.test(sentence);
};

/** Status string for the idle screen: the existing generic state while a question is pending, otherwise "idle". */
export const idleStatusFor = (remainingMs: number): "Your turn" | "idle" => (remainingMs > 0 ? "Your turn" : "idle");
