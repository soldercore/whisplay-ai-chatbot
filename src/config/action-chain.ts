// Several TV actions in one spoken request ("Turn on the TV, search YouTube for X, and set the volume to 10").
//
// This file only PLANS and ORDERS: every clause must be recognised by the same whole-sentence matchers that route a single
// command, nothing the model wrote is ever executed, and the whole request is validated before the first action runs.
// EXECUTION reuses the existing verified handlers (passed in), and the one spoken reply is composed here from their own
// replies, so only outcomes the handlers verified are stated. Anything that is not a chain returns undefined and the request
// is routed exactly as before.
import { getTvAudioCommand, getTvScreenAction, getYoutubeSearchQuery, isOpenYoutubeOnTv, isTurnOffTv, isTurnOnTv, isTvVolumeDown } from "../device/lg-c1-volume";
import { isMixedDeviceRequest, mentionsExternalTv, TV_MIXED_REPLY } from "./device-commands";
import { personaName } from "./persona";

type AudioCommand = NonNullable<ReturnType<typeof getTvAudioCommand>>;
export type ChainStep =
  | { kind: "power-on" } | { kind: "power-off" } | { kind: "screen"; on: boolean } | { kind: "volume-down" }
  | { kind: "audio"; command: AudioCommand } | { kind: "search"; query: string } | { kind: "youtube" };
export type ChainPlan = { steps: ChainStep[] } | { refusal: string };

const MAX_STEPS = 4;
// A boundary only counts when a request verb follows it, so "the TV and the lights" is not split.
const VERB = /^(?:turn|switch|power|set|change|adjust|search|find|look|open|launch|start|mute|unmute|lower|raise|increase|decrease|reduce|bring|make|put|shut|wake|show|play|pause|stop|resume|tell|give|read|check|send|record|press|reboot|restart|enable|disable|connect|close|exit|lock|unlock|call|email|text|remind|order|buy|schedule)\b/i;
const DELIMITER = /\s*,\s*(?:and\s+(?:then\s+)?|then\s+)?|\s+(?:and\s+then|then|and\s+also|and)\s+/gi;

type Boundary = { start: number; end: number; explicit: boolean };
function boundaries(text: string): Boundary[] {
  const found: Boundary[] = [];
  for (const m of text.matchAll(DELIMITER)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (VERB.test(text.slice(end))) found.push({ start, end, explicit: m[0].includes(",") || /\bthen\b/i.test(m[0]) });
  }
  return found;
}

function normalise(text: string): string | undefined {
  let t = text.trim().replace(/[’]/g, "'").replace(/\s+/g, " ");
  if (!t || t.length > 400) return;
  const polite = /^(?:(?:hey )?glados[, ]+)?(?:can|could|would|will) you (?:please )?/i.test(t);
  t = t.replace(/^(?:hey )?glados[, ]+/i, "").replace(/^(?:(?:can|could|would|will) you )/i, "").replace(/^please,? +/i, "");
  t = t.replace(/[.!]+$/, "").replace(/,? please$/i, "");
  if (polite) t = t.replace(/\?+$/, "");
  if (t.includes("?")) return;
  return t.trim();
}

// In a chain that is about the TV, a bare "volume" clause means the TV. Standing alone it keeps meaning Whisplay's speaker.
function tvify(clause: string): string {
  if (mentionsExternalTv(clause)) return clause;
  return clause
    .replace(/^(?:set|change|adjust) (?:the )?volume to (.+)$/i, "set the tv volume to $1")
    .replace(/^(?:turn|bring) (?:the )?volume (up|down)$/i, "turn the tv volume $1")
    .replace(/^(?:turn|bring) (up|down) (?:the )?volume$/i, "turn $1 the tv volume")
    .replace(/^(lower|reduce|decrease|raise|increase) (?:the )?volume((?: a little| a bit| slightly)?)$/i, "$1 the tv volume$2")
    .replace(/^(mute|unmute)(?: (?:it|the sound))?$/i, "$1 the tv");
}

type Clause = ChainStep | { invalid: string };
function clause(text: string, tvContext: boolean): Clause | undefined {
  const x = tvContext ? tvify(text.trim()) : text.trim();
  const screen = getTvScreenAction(x);
  if (screen) return { kind: "screen", on: screen === "on" };
  if (isTvVolumeDown(x)) return { kind: "volume-down" };
  const audio = getTvAudioCommand(x);
  if (audio) return audio.action === "invalidVolume" ? { invalid: "a TV volume outside zero to one hundred" } : { kind: "audio", command: audio };
  const query = getYoutubeSearchQuery(x);
  if (query) return { kind: "search", query };
  if (isOpenYoutubeOnTv(x)) return { kind: "youtube" };
  if (isTurnOnTv(x)) return { kind: "power-on" };
  if (isTurnOffTv(x)) return { kind: "power-off" };
}

type Parsed = { steps: ChainStep[] } | { unsupported: string };
function parse(text: string, tvContext: boolean): Parsed {
  for (const b of boundaries(text)) {
    const step = clause(text.slice(0, b.start), tvContext);
    if (!step) continue;                                   // the left part is not a request yet (a longer query may follow)
    if ("invalid" in step) return { unsupported: text.slice(0, b.start).trim() };
    const rest = parse(text.slice(b.end).trim(), tvContext);
    if ("steps" in rest) return { steps: [step, ...rest.steps] };
    // A plain "and" inside a YouTube query is part of the query; a comma or "then" ends it.
    if (step.kind === "search" && !b.explicit) continue;
    return rest;
  }
  const whole = clause(text, tvContext);
  if (!whole) return { unsupported: text.trim() };
  if ("invalid" in whole) return { unsupported: text.trim() };
  return { steps: [whole] };
}

const label = (step: ChainStep): string => step.kind === "power-on" || step.kind === "power-off" ? "power" : step.kind === "screen" ? "screen"
  : step.kind === "volume-down" || (step.kind === "audio" && step.command.action !== "setMute") ? "volume" : step.kind === "audio" ? "mute" : "YouTube";
const refuse = (reason: string): ChainPlan => ({ refusal: `${reason} Nothing was changed.` });
const quote = (text: string): string => `"${text.length > 60 ? text.slice(0, 57) + "..." : text}"`;

/** undefined = not a chain: route the request exactly as before. */
export function planChain(question: string): ChainPlan | undefined {
  if (!/,|\band\b|\bthen\b/i.test(question)) return;
  const text = normalise(question);
  if (!text) return;
  const cuts = boundaries(text);
  if (!cuts.length) return;
  const pieces: string[] = [];
  let from = 0;
  for (const b of cuts) { pieces.push(text.slice(from, b.start)); from = b.end; }
  pieces.push(text.slice(from));
  // The chain is about the TV only when the TV is named or a clause is itself a YouTube request (always the TV). A mere
  // mention of YouTube in a conversation does not make a bare "volume" clause refer to the TV.
  const tvContext = mentionsExternalTv(text) || pieces.some(piece => { const c = clause(piece, false); return !!c && "kind" in c && (c.kind === "search" || c.kind === "youtube"); });
  if (!tvContext) return;                                  // a request about no TV at all is never a chain
  // Hijack guard: at least one clause must be a recognised TV request, otherwise it is ordinary conversation.
  if (!pieces.some(piece => { const c = clause(piece, true); return !!c && !("invalid" in c); })) return;
  if (isMixedDeviceRequest(text)) return { refusal: TV_MIXED_REPLY };
  const parsed = parse(text, true);
  if ("unsupported" in parsed) return refuse(`I can't do ${quote(parsed.unsupported)} in a chain.`);
  const { steps } = parsed;
  if (steps.length < 2) return;                            // one request: the existing single-command path
  if (steps.length > MAX_STEPS) return refuse(`That is more than ${MAX_STEPS} requests at once.`);
  const seen = new Set<string>();
  for (const step of steps) {
    const key = label(step);
    if (seen.has(key)) return refuse(`You gave me two ${key} requests.`);
    seen.add(key);
  }
  const on = steps.findIndex(s => s.kind === "power-on"), off = steps.findIndex(s => s.kind === "power-off");
  if (on >= 0 && off >= 0) return refuse("Turning the TV on and off in one request is contradictory.");
  if (off === 0) return refuse("I can't do anything with the TV after switching it off.");
  const ordered = [...steps.filter(s => s.kind === "power-on"), ...steps.filter(s => s.kind !== "power-on" && s.kind !== "power-off"), ...steps.filter(s => s.kind === "power-off")];
  return { steps: ordered };
}

// ---- Execution ------------------------------------------------------------------------------------------------------------
export type StepOutcome = "done" | "noop" | "sent" | "failed" | "unverified" | "skipped";
export type StepResult = { step: ChainStep; outcome: StepOutcome; reply: string };
export type ChainHandlers = {
  powerOn(): Promise<string>; powerOff(): Promise<string>; screen(on: boolean): Promise<string>; volumeDown(): Promise<string>;
  audio(command: AudioCommand): Promise<string>; search(query: string): Promise<string>; youtube(): Promise<string>;
};

const DONE = /^(?:Waking the TV\.|Powering off\.|Screen o(?:n|ff)\.|Volume adjusted\.|TV (?:un)?muted\.|Opening YouTube\.)$/;
const NOOP = /^(?:The TV is already on\.|TV volume is already at (?:zero|maximum)\.)$/;
export function classify(reply: string): StepOutcome {
  const text = reply.trim();
  if (/unverified|can't verify|couldn't verify|could not verify|can't confirm|not verified/i.test(text)) return "unverified";
  if (/\b(?:couldn't|could not|didn't|failed|unable)\b/i.test(text)) return "failed";
  if (DONE.test(text)) return "done";
  if (NOOP.test(text)) return "noop";
  if (text === "Search sent to YouTube.") return "sent";
  return "unverified";                                     // an unrecognised reply is never upgraded to success
}

export async function runChain(steps: ChainStep[], handlers: ChainHandlers, aborted: () => boolean = () => false): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let tvOn = true;
  for (const step of steps) {
    if (aborted()) break;
    if (!tvOn && step.kind !== "power-on") { results.push({ step, outcome: "skipped", reply: "" }); continue; }
    let reply = "";
    try {
      reply = step.kind === "power-on" ? await handlers.powerOn() : step.kind === "power-off" ? await handlers.powerOff()
        : step.kind === "screen" ? await handlers.screen(step.on) : step.kind === "volume-down" ? await handlers.volumeDown()
        : step.kind === "audio" ? await handlers.audio(step.command) : step.kind === "search" ? await handlers.search(step.query) : await handlers.youtube();
    } catch (error) {
      if (aborted()) throw error;
      reply = "";                                           // a thrown handler is a failure, not a success
    }
    const outcome = reply ? classify(reply) : "failed";
    results.push({ step, outcome, reply });
    if (step.kind === "power-on" && outcome !== "done" && outcome !== "noop") tvOn = false;   // nothing else works on a TV that is not confirmed on
  }
  return results;
}

// ---- The one spoken reply ---------------------------------------------------------------------------------------------------
const verified = (r: StepResult): string => {
  const s = r.step;
  switch (s.kind) {
    case "power-on": return r.outcome === "noop" ? "the TV was already on" : "the TV is on";
    case "power-off": return "the TV is in standby";
    case "screen": return `the TV screen is ${s.on ? "on" : "off"}`;
    case "volume-down": return r.outcome === "noop" ? "the TV volume was already at zero" : "the TV volume is down a step";
    case "audio":
      if (s.command.action === "setVolume") return `the TV volume is ${s.command.volume}`;
      if (s.command.action === "setMute") return `the TV is ${s.command.mute ? "muted" : "unmuted"}`;
      return r.outcome === "noop" ? "the TV volume was already at maximum" : "the TV volume is up a step";
    case "search": return "the search request went to YouTube";   // sent, not shown: results are not verified
    case "youtube": return "YouTube is open";
  }
};
const failed = (s: ChainStep): string => {
  switch (s.kind) {
    case "power-on": return "turn the TV on";
    case "power-off": return "switch the TV off";
    case "screen": return `turn the TV screen ${s.on ? "on" : "off"}`;
    case "volume-down": return "lower the TV volume";
    case "audio": return s.command.action === "setVolume" ? `set the TV volume to ${s.command.volume}` : s.command.action === "setMute" ? `${s.command.mute ? "mute" : "unmute"} the TV` : "raise the TV volume";
    case "search": return "send the YouTube search";
    case "youtube": return "open YouTube";
  }
};
const noun = (s: ChainStep): string => {
  switch (s.kind) {
    case "power-on": case "power-off": return "the power change";
    case "screen": return "the screen change";
    case "volume-down": return "the volume change";
    case "audio": return s.command.action === "setMute" ? "the mute change" : "the volume change";
    case "search": return "the YouTube search";
    case "youtube": return "opening YouTube";
  }
};
const list = (items: string[]): string => items.length < 2 ? items.join("") : items.length === 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1) + ".";
const flourishes = ["Do try to look pleased.", "Efficiency, as ever.", "You are welcome."];
let flourish = 0;

export function composeChainReply(results: StepResult[]): string {
  if (!results.length) return "";
  const good = results.filter(r => r.outcome === "done" || r.outcome === "noop" || r.outcome === "sent");
  const bad = results.filter(r => r.outcome === "failed" || r.outcome === "unverified");
  const skipped = results.filter(r => r.outcome === "skipped");
  const parts: string[] = [];
  if (good.length) parts.push(sentence(list(good.map(verified))));
  if (bad.length) {
    const hard = bad.filter(r => r.outcome === "failed"), soft = bad.filter(r => r.outcome === "unverified");
    if (hard.length) parts.push(sentence(`I couldn't ${list(hard.map(r => failed(r.step)))}`));
    if (soft.length) parts.push(sentence(`I couldn't confirm ${list(soft.map(r => noun(r.step)))}`));
  }
  if (skipped.length) parts.push(sentence(`I skipped ${list(skipped.map(r => noun(r.step)))} because the TV did not confirm it was on`));
  if (!bad.length && !skipped.length && personaName() === "glados") parts.push(flourishes[flourish++ % flourishes.length]);
  return parts.join(" ");
}
