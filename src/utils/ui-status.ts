// The display status string may carry comma separated tokens after a "|": "<status>|capri,resp:1.8". The UI classifies
// the status exactly as before and only uses the tokens to word its panes (see python/whisplay_ui/visual_state.py).
export const uiStatus = (status: string, ...tokens: Array<string | false | undefined | null>): string => {
  const list = tokens.filter((token): token is string => typeof token === "string" && /^[a-z]+(?::[0-9a-z.]+)?$/.test(token));
  return list.length ? `${status}|${list.join(",")}` : status;
};

/** Idle status for the panes: Capri running (never implies recording), the last measured value, a pending clarification. */
export const composeIdleStatus = (state: { capriReady: boolean; metric?: { kind: "resp" | "act"; seconds: number }; pendingClarification: boolean }): string =>
  uiStatus("idle", state.capriReady && "capri", state.metric && `${state.metric.kind}:${state.metric.seconds.toFixed(1)}`,
    state.pendingClarification && (state.capriReady ? "pend:capri" : "pend:button"));
