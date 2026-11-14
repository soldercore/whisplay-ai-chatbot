// Outcome of a host-routed device action, derived only from the reply the action itself returned (those replies
// already say verified / failed / unverified). It never infers device state: an unrecognised reply is neutral.
export type ActionOutcome = "ok" | "failed" | "unverified";

const UNVERIFIED = /unverified|can't verify|couldn't verify|could not verify|can't confirm|not verified/i;
const FAILED = /\b(?:couldn't|could not|didn't|failed|unable)\b/i;
// Only replies the TV code returns after its own verification: a power/screen state read, a volume or mute read-back, the
// foreground-app read for YouTube, or power "on" plus the Home screen for wake. Replies that rest on the TV merely accepting a
// command ("Notification displayed."), or that report no change ("already at maximum", "already on"), stay neutral.
const SUCCESS = /^(?:Screen o(?:n|ff)\.|Powering off\.|Volume adjusted\.|TV (?:un)?muted\.|Waking the TV\.|Opening YouTube\.)$/;

export function actionOutcome(reply: string, emptyMeansVerified = false): ActionOutcome | undefined {
  const text = reply.trim();
  if (!text) return emptyMeansVerified ? "ok" : undefined;
  if (UNVERIFIED.test(text)) return "unverified";
  if (FAILED.test(text)) return "failed";
  return SUCCESS.test(text) ? "ok" : undefined;
}

// Marker passed through the existing (functionName, result) tool callback. Never empty: an empty result means "started".
export function hostActionResult(reply: string, emptyMeansVerified = false): string {
  return `[host:${actionOutcome(reply, emptyMeansVerified) ?? "done"}]${reply}`;
}

/** Outcome of a result string, only for the host marker above; every other tool result is left as it was. */
export function toolDisplayOutcome(result?: string): ActionOutcome | undefined {
  const match = /^\[host:(ok|failed|unverified)\]/.exec(result || "");
  return match ? (match[1] as ActionOutcome) : undefined;
}

/** Inline tool tag text. A finished host action shows its outcome as a dotted suffix the UI already parses as part of the tag. */
export function formatToolTag(item: { name: string; elapsedSeconds?: number; outcome?: ActionOutcome }): string {
  if (item.outcome) return `% ${item.name}.${item.outcome}`;
  return item.elapsedSeconds && item.elapsedSeconds >= 10 ? `% ${item.name} ${item.elapsedSeconds}s...` : `% ${item.name}...`;
}
