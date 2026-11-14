// Response timing from real runtime events, on a monotonic clock. One turn at a time. Every duration needs both of its
// events; a missing event yields no value, never an estimate. No transcripts or audio are stored.
export type TimingPath = "button" | "auto" | "capri";
export type ResponseMetric = { kind: "resp" | "act"; seconds: number };
type Marks = {
  path: TimingPath;
  speechEnd?: number;        // user stopped speaking (definition per path, below)
  transcribed?: number;      // recognised text available
  firstText?: number;        // first text from the model or a host reply
  firstAudible?: number;     // first sentence of audio actually started playing
  finished?: number;         // playback ended
  actionDone?: number;       // first host-routed action finished (outcome known)
  toolMs: number;
  toolStartedAt?: number;
};

let clock: () => number = () => performance.now();
let turn: Marks | undefined;
let metric: (ResponseMetric & { at: number }) | undefined;

export const setClock = (fn: () => number): void => { clock = fn; };
export const resetTiming = (): void => { turn = undefined; metric = undefined; clock = () => performance.now(); };
export const hasTurn = (): boolean => turn !== undefined;
export const clearTurn = (): void => { turn = undefined; };

/**
 * Event definitions (all monotonic):
 *  speech end  button: the moment the button was released (the user may have stopped speaking a little earlier).
 *              auto:   when the recorder stopped, minus the end-of-silence it waits for. The recorder stops only after that much
 *                      quiet, so this is an approximation within the recorder's own 0.1 s detection windows; when the time limit
 *                      ended the capture it is the stop time itself.
 *              capri:  the wake script's own last loud frame (20 ms frames), reported as an age when the line is printed.
 *  first audible  the first sentence's playback was started: its audio is fully synthesised and the player process was launched.
 *              It is NOT the moment sound leaves the speaker: the player takes about 5-20 ms to start (measured in the app log),
 *              the sound card adds its buffer, and the clip begins with 50-80 ms of silence. Queued or still-synthesising
 *              audio is never counted.
 *  action done the host-routed device action returned its verified, failed or unverified outcome.
 * speechEndAt is a monotonic timestamp.
 */
export function beginTurn(path: TimingPath, speechEndAt?: number): void {
  const at = clock();
  turn = { path, toolMs: 0, speechEnd: typeof speechEndAt === "number" && Number.isFinite(speechEndAt) && speechEndAt <= at ? speechEndAt : undefined };
}

export function mark(name: "transcribed" | "firstText" | "firstAudible" | "finished"): void {
  if (turn && turn[name] === undefined) turn[name] = clock();
}

/** Playback of a sentence started. Only audio that exists counts (a failed or silent sentence reports a duration of 0). */
export function markAudible(durationMs: number): void {
  if (durationMs > 0) mark("firstAudible");
}

export function toolStarted(): void {
  if (turn && turn.toolStartedAt === undefined) turn.toolStartedAt = clock();
}

export function toolFinished(hostAction: boolean): void {
  if (!turn) return;
  const at = clock();
  if (turn.toolStartedAt !== undefined) { turn.toolMs += at - turn.toolStartedAt; turn.toolStartedAt = undefined; }
  if (hostAction && turn.actionDone === undefined) turn.actionDone = at;
}

const between = (from?: number, to?: number): number | undefined =>
  from !== undefined && to !== undefined && to >= from && to - from < 120_000 ? to - from : undefined;

export type TurnSummary = {
  path: TimingPath; speechToTranscriptMs?: number; transcriptToFirstTextMs?: number; firstAudibleMs?: number;
  actionMs?: number; totalMs?: number; toolMs?: number; metric?: ResponseMetric;
};

/** End the turn: the one shown value (ACTION for a device command, else RESPONSE) plus the secondary durations. */
export function finishTurn(): TurnSummary | undefined {
  if (!turn) return undefined;
  mark("finished");
  const t = turn;
  turn = undefined;
  const firstAudibleMs = between(t.speechEnd, t.firstAudible);
  const actionMs = between(t.speechEnd, t.actionDone);
  const summary: TurnSummary = {
    path: t.path,
    speechToTranscriptMs: between(t.speechEnd, t.transcribed),
    transcriptToFirstTextMs: between(t.transcribed, t.firstText),
    firstAudibleMs, actionMs, totalMs: between(t.speechEnd, t.finished),
    toolMs: t.toolMs > 0 ? t.toolMs : undefined,
  };
  const shown = actionMs !== undefined ? { kind: "act" as const, seconds: actionMs / 1000 }
    : firstAudibleMs !== undefined ? { kind: "resp" as const, seconds: firstAudibleMs / 1000 } : undefined;
  summary.metric = shown;
  metric = shown ? { ...shown, at: clock() } : undefined;
  return summary;
}

/** The last measured value while it is recent, for the idle screen. */
export function recentMetric(maxAgeMs: number): (ResponseMetric & { expiresInMs: number }) | undefined {
  if (!metric) return undefined;
  const left = maxAgeMs - (clock() - metric.at);
  return left > 0 ? { kind: metric.kind, seconds: metric.seconds, expiresInMs: left } : undefined;
}

export const diagnosticsLine = (s: TurnSummary): string => {
  const f = (v?: number) => (v === undefined ? "-" : `${Math.round(v)}ms`);
  return `[ResponseTiming] path=${s.path} speech_end->transcript=${f(s.speechToTranscriptMs)} transcript->first_text=${f(s.transcriptToFirstTextMs)} `
    + `first_audible=${f(s.firstAudibleMs)} action=${f(s.actionMs)} tool=${f(s.toolMs)} total=${f(s.totalMs)}`;
};
