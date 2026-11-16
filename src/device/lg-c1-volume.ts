import fs from "node:fs";
import { isIPv4, connect } from "node:net";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { checkServerIdentity } from "node:tls";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import type LGTV from "lgtv2";
import WebSocket from "ws";
import { deviceCommandText, deviceNumber } from "../config/device-commands";
import { checkCancelled, operationDeadline, waitForOperation } from "../utils/operation-lifecycle";

const data = path.resolve(__dirname, "../../data");
const settingsDir = path.join(data, ".glados-tv");
const operationMs = 1850;
const pairingMs = 45000;
const maxFileSize = 16 * 1024;

const defaults = {
  SUCCESS: ["Volume adjusted."],
  FAILED: ["I couldn't adjust TV volume."],
  UNKNOWN: ["TV volume change is unverified."],
  ALREADY_AT_MINIMUM: ["TV volume is already at zero."],
};
type Status = keyof typeof defaults;
type Target = { host: string; fingerprint: string };
type Volume = { value: number; output?: string };
type Result =
  | { status: "SUCCESS"; before: number; after: number }
  | { status: "ALREADY_AT_MINIMUM"; before: 0 }
  | { status: "UNKNOWN"; before?: number; after?: number }
  | { status: "FAILED" };

class TvError extends Error {}

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const isKey = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{8,256}$/.test(value);
const isPrivateIPv4 = (host: string): boolean =>
  isIPv4(host) && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);

function readJson(file: string, privateFile = false): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > maxFileSize ||
        (privateFile && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.nlink !== 1))) {
      throw new TvError("Unsafe or oversized configuration file");
    }
    const bytes = Buffer.alloc(maxFileSize + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > maxFileSize) throw new TvError("Oversized configuration file");
    return JSON.parse(bytes.toString("utf8", 0, size));
  } finally {
    fs.closeSync(fd);
  }
}

function loadResponses(): typeof defaults {
  try {
    const file = asObject(readJson(path.join(data, "glados-tv-responses.json")));
    const statuses = Object.keys(defaults) as Status[];
    if (file && statuses.every(status => {
      const variants = file[status];
      return Array.isArray(variants) && variants.length >= 1 && variants.length <= 3 &&
        new Set(variants).size === variants.length &&
        variants.every(line => typeof line === "string" && line.trim() === line && line.length > 0 &&
          line.length <= 180 && !/[\x00-\x1f<>]/.test(line));
    })) return file as typeof defaults;
    console.warn("[TV volume] Invalid response configuration. Using built-in replies.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[TV volume] Could not load response configuration. Using built-in replies.");
    }
  }
  return defaults;
}

const replies = loadResponses();
const nextReply: Partial<Record<Status, number>> = {};
const youtubeReplies = {
  SUCCESS: ["Opening YouTube."],
  FAILED: ["I couldn't open YouTube."],
  UNKNOWN: ["YouTube opening is unverified."],
};
type YoutubeStatus = keyof typeof youtubeReplies;
const nextYoutubeReply: Partial<Record<YoutubeStatus, number>> = {};
const navigationReplies = {
  SENT: [""],
  FAILED: ["I couldn't send that TV control."],
};
type NavigationStatus = keyof typeof navigationReplies;
const nextNavigationReply: Partial<Record<NavigationStatus, number>> = {};
const navigationButtons = {
  up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT", ok: "ENTER", okay: "ENTER", select: "ENTER", back: "BACK", home: "HOME",
} as const;
type TvNavigationButton = (typeof navigationButtons)[keyof typeof navigationButtons];
const pointerInput = "ssap://com.webos.service.networkinput/getPointerInputSocket";
const playbackButtons = { play: "PLAY", pause: "PAUSE", stop: "STOP" } as const;
type TvPlaybackAction = keyof typeof playbackButtons;
const playbackStates = { play: "playing", pause: "paused", stop: "stopped" } as const;

function replyFor<S extends string>(status: S, variants: Record<S, string[]>, next: Partial<Record<S, number>>): string {
  const options = variants[status];
  const index = next[status] ?? 0;
  next[status] = (index + 1) % options.length;
  return options[index];
}

// Only whole, explicit English TV commands reach these matchers.
// A polite modal request ("Could you make the TV louder, please?") is a command; other questions never are.
const politeTvRequest = /^(?:(?:hey )?glados[, ]+)?(?:can|could|would|will) you (?:please )?(?=(?:turn|switch|put|make|lower|raise|increase|decrease|reduce|bring|mute|unmute|set|power|shut)\b)/i;
function tvCommandText(question: string): string {
  const polite = politeTvRequest.test(question.trim());
  if (question.length > 240 || (polite ? question.trim().replace(/\?+$/, "").includes("?") : question.includes("?"))) return "";
  return question.trim().toLowerCase()
    .replace(/[’]/g, "'").replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "").replace(/^(?:hey )?glados[, ]+/, "")
    .replace(/^(?:(?:can|could|would|will) you )(?=.)/, polite ? "" : "$&")
    .replace(/^please,? /, "").replace(/,? please$/, "")
    .replace(/\bt[. ]+v\.?(?= |,|'|$)/g, "tv")
    .replace(/\btelevision\b/g, "tv").replace(/\byou tube\b/g, "youtube")
    .replace(/^tv, /, "tv ").trim();
}

const tvTarget = "(?:(?:the|my|that|this) )?tv";
const tvVolume = "(?:(?:the |my |that )?tv volume|volume (?:on|of|for) " + tvTarget + "|" + tvTarget + "'s volume)";
const tvMatch = (body: string): RegExp => new RegExp("^(?:" + body + ")$");
const powerPattern = (direction: "on" | "off") => tvMatch(
  "(?:turn|switch|power) (?:" + direction + " " + tvTarget + "|" + tvTarget + " " + direction + ")"
  + "|tv (?:power )?" + direction
  + (direction === "off"
    ? "|shut (?:down " + tvTarget + "|" + tvTarget + " down)|(?:put|set|send) " + tvTarget + " (?:in|into|on|to) (?:standby|sleep)|tv standby"
    : "|(?:turn|switch|power) (?:back on " + tvTarget + "|" + tvTarget + " back on)"));
const powerOn = powerPattern("on");
const powerOff = powerPattern("off");
const youtubeOnTv = tvMatch(
  "(?:open|launch|start) youtube (?:on|on to) " + tvTarget + "|tv (?:open|launch|start) youtube");
const direction = "(up|down|left|right)";
const choice = "(ok|okay|select|enter|back|home)";
const navigation = tvMatch(
  "tv (?:(?:go |move |press )?" + direction + "|(?:press )?" + choice + ")"
  + "|(?:move|go|scroll) " + direction + " on " + tvTarget
  + "|(?:press )?(ok|okay|select|enter) on " + tvTarget
  + "|(?:go |navigate )?(back) on " + tvTarget
  + "|(?:go (?:back )?to |open |show )?(home)(?: screen| menu)? on " + tvTarget
  + "|" + tvTarget + " (?:go (?:back )?(?:to )?|open )(home)(?: screen| menu)?"
  + "|(?:open|show) " + tvTarget + " (home)(?: screen| menu)?");
const playback = tvMatch(
  "tv (play|pause|stop|resume|continue)(?: playback| video)?"
  + "|(play|pause|stop|resume|continue)(?: (?:the )?(?:playback|video))? on " + tvTarget
  );
const slightly = "(?: (?:a little(?: bit)?|a bit|slightly))?";   // TV volume moves one step either way
const lowerVolumeRequest = tvMatch("(?:" +
  "(?:turn|bring) down (?:the )?" + tvVolume + "|(?:turn|bring) (?:the )?" + tvVolume + " down"
  + "|(?:turn|bring) (?:the )?volume down on " + tvTarget
  + "|(?:lower|reduce|decrease) (?:the )?" + tvVolume + "|tv volume down"
  + "|make " + tvTarget + " quieter)" + slightly);
const raiseVolumeRequest = tvMatch("(?:" +
  "tv volume up|(?:turn|bring) up (?:the )?" + tvVolume + "|(?:turn|bring) (?:the )?" + tvVolume + " up"
  + "|(?:turn|bring) (?:the )?volume up on " + tvTarget
  + "|(?:raise|increase) (?:the )?" + tvVolume + "|make " + tvTarget + " louder)" + slightly);
const muteRequest = tvMatch("(mute|unmute) " + tvTarget + "|tv (mute|unmute)|(?:turn|switch) (?:the )?sound (off|on) on " + tvTarget);
const setVolumeRequest = tvMatch("(?:set|change|adjust) (?:the )?" + tvVolume + " to (.+)"
  + "|set (?:the )?volume to (.+) on " + tvTarget
  + "|tv volume (?:to )?(.+)");

const screenTarget = "(?:" + tvTarget + " (?:screen|display|picture)|(?:the )?display|(?:the )?(?:screen|display) on " + tvTarget + ")";
const screenOn = tvMatch(
  "(?:turn|switch) (?:(?:back )?on " + screenTarget + "|" + screenTarget + " (?:back )?on)"
  + "|wake (?:up " + screenTarget + "|" + screenTarget + " up)"
  + "|tv screen on");
const screenOff = tvMatch(
  "(?:turn|switch) (?:off " + screenTarget + "|" + screenTarget + " off)|tv screen off"
  + "|make " + tvTarget + " (?:screen|display) (?:black|dark)"
  + "|(?:turn|switch) (?:off (?:the )?picture|(?:the )?picture off) (?:but|and) (?:keep|leave) (?:the )?sound(?: on)?");
const tvNotification = tvMatch(
  "(?:show|display) (?:me )?(?:a )?(?:glados )?(?:notification|message) on " + tvTarget);

export function getTvScreenAction(question: string): "on" | "off" | undefined {
  const text = tvCommandText(question);
  if (screenOn.test(text)) return "on";
  if (screenOff.test(text)) return "off";
}

export const isTvNotification = (question: string): boolean => tvNotification.test(tvCommandText(question));

export function getYoutubeSearchQuery(question: string): string | undefined {
  if (question.length > 240 || /[?\p{C}]/u.test(question)) return;
  const text = question.trim().replace(/^(?:hey )?glados[, ]+/i, "")
    .replace(/^please,? +/i, "").replace(/[.!]+$/, "").trim();
  const match = /^search you ?tube for (.+)$/i.exec(text)
    ?? /^(?:search for|find|look up) (.+) on you ?tube$/i.exec(text);
  const query = match?.[1].trim();
  if (query && [...query].length <= 160 && /[\p{L}\p{N}]/u.test(query)) return query;
}

export const isOpenYoutubeOnTv = (question: string): boolean => youtubeOnTv.test(tvCommandText(question));
export const isTurnOnTv = (question: string): boolean => powerOn.test(tvCommandText(question));
export const isTurnOffTv = (question: string): boolean => powerOff.test(tvCommandText(question));
export const isTvVolumeDown = (question: string): boolean => lowerVolumeRequest.test(tvCommandText(question));

const navigationDirection = tvMatch("(?:go |move |navigate |press |scroll )?" + direction);
const navigationSelect = tvMatch("(?:press )?(?:ok|okay|select|choose|enter)(?: this)?");
const navigationBack = tvMatch("(?:go |navigate )?back|previous screen");
const navigationHome = tvMatch("(?:go (?:back )?(?:to )?|open |show )?(?:the )?home(?: screen| menu)?");
const navigationTarget = new RegExp(" on " + tvTarget + "$");

export function getTvNavigationButton(question: string, tvContext = false): TvNavigationButton | undefined {
  const text = tvCommandText(question);
  const key = navigation.exec(text)?.slice(1).find(Boolean);
  if (key) return key === "enter" ? "ENTER" : navigationButtons[key as keyof typeof navigationButtons];

  const command = text.replace(/^tv /, "").replace(navigationTarget, "");
  if (command === text && !tvContext) return;
  const step = navigationDirection.exec(command)?.[1];
  if (step) return navigationButtons[step as keyof typeof navigationButtons];
  if (navigationSelect.test(command)) return "ENTER";
  if (navigationBack.test(command)) return "BACK";
  if (navigationHome.test(command)) return "HOME";
}

export function getTvPlaybackAction(question: string): TvPlaybackAction | undefined {
  const key = playback.exec(tvCommandText(question))?.slice(1).find(Boolean);
  if (key === "resume" || key === "continue") return "play";
  return key as TvPlaybackAction | undefined;
}

type TvAudioCommand =
  | { action: "volumeUp" }
  | { action: "setMute"; mute: boolean }
  | { action: "setVolume"; volume: number }
  | { action: "invalidVolume" };

export function getTvAudioCommand(question: string): TvAudioCommand | undefined {
  const text = tvCommandText(question);
  if (raiseVolumeRequest.test(text)) return { action: "volumeUp" };
  const mute = muteRequest.exec(text)?.slice(1).find(Boolean);
  if (mute) return { action: "setMute", mute: mute === "mute" || mute === "off" };
  if (lowerVolumeRequest.test(text)) return;
  const argument = setVolumeRequest.exec(text)?.slice(1).find(Boolean);
  if (!argument) return;
  const value = argument.replace(/(?: ?%| percent)$/, "");
  const volume = /^(?:\d{1,3}|[a-z]+(?:[ -][a-z]+)?)$/.test(value) ? deviceNumber(value) : undefined;
  if (volume !== undefined) return { action: "setVolume", volume };
  // Explicit set operations still report an invalid number. A TV volume mention
  // by itself does not turn into a request.
  if (/^(?:set|change|adjust) /.test(text) || /^tv volume (?:to |[-+]?\d)/.test(text)) return { action: "invalidVolume" };
}

function getTarget(): Target {
  const info = fs.lstatSync(settingsDir);
  if (!info.isDirectory() || fs.realpathSync(settingsDir) !== settingsDir ||
      info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new TvError("Unsafe TV settings directory");
  }
  const file = asObject(readJson(path.join(settingsDir, "target.json"), true));
  if (!file || typeof file.host !== "string" || !isPrivateIPv4(file.host) ||
      typeof file.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(file.fingerprint)) {
    throw new TvError("Invalid TV address or certificate fingerprint");
  }
  return { host: file.host, fingerprint: file.fingerprint };
}

function getClientKey(target: Target, filename = "client-key.json"): string | undefined {
  try {
    const file = asObject(readJson(path.join(settingsDir, filename), true));
    if (!file || file.host !== target.host || file.fingerprint !== target.fingerprint || !isKey(file.key)) {
      throw new TvError("TV credential does not match the configured target");
    }
    return file.key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function saveClientKey(target: Target, key: string, filename = "client-key.json"): void {
  const temp = fs.mkdtempSync(path.join(settingsDir, ".pair-"));
  const file = path.join(temp, "credential");
  try {
    fs.writeFileSync(file, JSON.stringify({ ...target, key }), { mode: 0o600, flag: "wx", flush: true });
    // Exclusive publication: two concurrent setup sessions cannot replace a valid key.
    fs.linkSync(file, path.join(settingsDir, filename));
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmdirSync(temp);
  }
}

function parseVolume(payload: Record<string, unknown>): Volume | undefined {
  const status = asObject(payload.volumeStatus) ?? payload;
  const value = status.volume;
  const output = status.soundOutput ?? payload.soundOutput;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) return;
  return { value, ...(typeof output === "string" ? { output } : {}) };
}

async function readVolume(client: LGTV, parent: AbortSignal): Promise<Volume | undefined> {
  checkCancelled(parent);
  const deadline = operationDeadline(300, parent);
  try {
    const result = await waitForOperation(client.request("ssap://audio/getVolume"), deadline.signal);
    return parseVolume(asObject(result) ?? {});
  } catch {
    checkCancelled(parent);
    return undefined;
  } finally {
    deadline.dispose();
  }
}

async function withClient<T>(target: Target, timeout: number, parent: AbortSignal | undefined,
  allowPairing: boolean, work: (client: LGTV, signal: AbortSignal) => Promise<T>,
  purpose: "volume" | "youtube" | "navigation" | "power" | "screen" | "toast" = "volume"): Promise<T> {
  checkCancelled(parent);
  const youtube = purpose === "youtube";
  const navigation = purpose === "navigation";
  const power = purpose === "power";
  const filename = {volume:"client-key.json", youtube:"youtube-client-key.json", navigation:"navigation-client-key.json",
    power:"power-client-key.json", screen:"screen-client-key.json", toast:"toast-client-key.json"}[purpose];
  const key = getClientKey(target, filename);
  const volumeKey = purpose === "volume" ? undefined : getClientKey(target);
  const youtubeKey = navigation || power ? getClientKey(target, "youtube-client-key.json") : undefined;
  const navigationKey = power ? getClientKey(target, "navigation-client-key.json") : undefined;
  if (youtube && (!volumeKey || key === volumeKey)) throw new TvError("A separate YouTube credential is required");
  if (navigation && (!volumeKey || !youtubeKey || key === volumeKey || key === youtubeKey)) {
    throw new TvError("A separate TV navigation credential is required");
  }
  if (power && (!volumeKey || !youtubeKey || !navigationKey || [volumeKey, youtubeKey, navigationKey].includes(key ?? ""))) {
    throw new TvError("A separate TV power credential is required");
  }
  const otherKeys = purpose === "screen" || purpose === "toast" ? [
    volumeKey,
    getClientKey(target, "youtube-client-key.json"),
    getClientKey(target, "navigation-client-key.json"),
    getClientKey(target, "power-client-key.json"),
    getClientKey(target, purpose === "screen" ? "toast-client-key.json" : "screen-client-key.json"),
  ].filter(isKey) : [];
  if (key && otherKeys.includes(key)) throw new TvError("A separate TV credential is required");
  if (!key && !allowPairing) throw new TvError("LG C1 is not paired. Run the local pairing command first");
  const Client = require("lgtv2") as typeof LGTV;
  if (!key) console.info("[TV volume] Approve the webOS pairing prompt on the LG C1. Waiting up to 45 seconds.");
  // The installed ws supports closeTimeout, which its older type declarations omit.
  const wsOptions = { maxPayload: (youtube ? 128 : 16) * 1024, followRedirects: false, perMessageDeflate: false, closeTimeout: 75 };
  const client = new Client({
    host: target.host, secure: true, verifyCert: target.fingerprint,
    clientKey: key ?? "", timeout: purpose === "volume" ? 300 : 800, handshakeTimeout: 1200,
    reconnect: false, keepalive: false, learnMac: false,
    wsOptions,
    saveKey: (received, callback) => {
      try {
        if (!allowPairing || !isKey(received) || key || received === volumeKey || received === youtubeKey ||
            received === navigationKey || otherKeys.includes(received)) throw new TvError("Unexpected TV credential change");
        saveClientKey(target, received, filename);
        callback();
      } catch {
        callback(new TvError("Could not securely save the TV credential"));
      }
    },
  });
  const send = client.send.bind(client);
  client.send = (type, uri, payload, callback) => send(type, uri, type === "register" ? {
    forcePairing: false, pairingType: "PROMPT",
    manifest: { manifestVersion: 1, appVersion: "1.0", permissions: youtube
      ? ["LAUNCH", "READ_INSTALLED_APPS", "READ_RUNNING_APPS"]
      : navigation ? ["CONTROL_MOUSE_AND_KEYBOARD"]
      : power ? ["CONTROL_POWER", "READ_POWER_STATE"]
      : purpose === "screen" ? ["CONTROL_TV_SCREEN"]
      : purpose === "toast" ? ["WRITE_NOTIFICATION_TOAST"] : ["CONTROL_AUDIO"] },
    ...(key ? { "client-key": key } : {}),
  } : payload, callback);
  const deadline = operationDeadline(timeout, parent);
  try {
    let connectionLost: (reason: Error) => void = () => {};
    const failure = new Promise<never>((_, reject) => { connectionLost = reject; });
    const connected = new Promise<void>(resolve => client.once("connect", resolve));
    client.on("error", () => connectionLost(new TvError("TV connection or authorization failed")));
    client.on("close", () => connectionLost(new TvError("TV connection closed")));
    client.on("prompt", () => {
      if (!allowPairing) connectionLost(new TvError("TV authorization requires local pairing"));
    });
    const run = async () => {
      await connected;
      if (!isKey(client.clientKey) || client.clientKey !== getClientKey(target, filename)) {
        throw new TvError("TV pairing credential was not confirmed");
      }
      return work(client, deadline.signal);
    };
    return await waitForOperation(Promise.race([run(), failure]), deadline.signal);
  } finally {
    await client.disconnect();
    deadline.dispose();
  }
}

async function lowerVolume(parent?: AbortSignal): Promise<Result> {
  let before: Volume | undefined;
  let after: Volume | undefined;
  let sent = false;
  try {
    const target = getTarget();
    return await withClient(target, operationMs, parent, false, async (client, signal) => {
      before = await readVolume(client, signal);
      if (before?.value === 0) return { status: "ALREADY_AT_MINIMUM", before: 0 };
      checkCancelled(signal);
      if (!client.connected) throw new TvError("TV connection closed before volumeDown");
      sent = true;
      await waitForOperation(client.request("ssap://audio/volumeDown"), signal);
      for (const pause of [0, 125, 275]) {
        if (pause) await delay(pause, undefined, { signal });
        after = await readVolume(client, signal);
        if (!before) break;
        if (after && after.output === before.output && after.value < before.value) {
          return { status: "SUCCESS", before: before.value, after: after.value };
        }
      }
      return { status: "UNKNOWN", before: before?.value, after: after?.value };
    });
  } catch (error) {
    if (parent?.aborted) throw error;
    if (sent && (error as NodeJS.ErrnoException).code !== "ESSAP") return { status: "UNKNOWN", before: before?.value, after: after?.value };
    // Never log peer payloads, connection options or credentials.
    console.warn("[TV volume]", error instanceof TvError ? error.message : "TV setup or command failed");
    return { status: "FAILED" };
  }
}

export async function lowerTvVolumeAndReply(signal?: AbortSignal): Promise<string> {
  const started = performance.now();
  const result = await lowerVolume(signal);
  console.info(`[TV volume] action=volumeDown result=${JSON.stringify(result)} llm_requests=0 total_ms=${Math.round(performance.now() - started)}`);
  return replyFor(result.status, replies, nextReply);
}

async function readTvAudio(client: LGTV, signal: AbortSignal): Promise<{ volume?: Volume; muted?: boolean }> {
  checkCancelled(signal);
  try {
    const payload = asObject(await waitForOperation(client.request("ssap://audio/getStatus"), signal)) ?? {};
    const mute = asObject(payload.volumeStatus)?.muteStatus ?? payload.mute ?? payload.muted;
    return { volume: parseVolume(payload), muted: typeof mute === "boolean" ? mute : undefined };
  } catch {
    checkCancelled(signal);
    return {};
  }
}

export async function changeTvAudioAndReply(command: TvAudioCommand, parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  if (command.action === "invalidVolume" || (command.action === "setVolume" &&
      (!Number.isInteger(command.volume) || command.volume < 0 || command.volume > 100))) {
    console.info("[TV audio] action=setVolume status=INVALID llm_requests=0");
    return "Use a whole TV volume from zero to one hundred.";
  }
  const { action } = command;
  const args = action === "setVolume" ? { volume: command.volume } : action === "setMute" ? { mute: command.mute } : {};
  let sent = false;
  let before: number | boolean | undefined;
  let after: number | boolean | undefined;
  let status: "SUCCESS" | "FAILED" | "UNKNOWN" = "FAILED";
  let reply = "I couldn't change the TV audio.";
  try {
    const verified = await withClient(getTarget(), operationMs, parent, false, async (client, signal) => {
      const prior = await readTvAudio(client, signal);
      before = action === "setMute" ? prior.muted : prior.volume?.value;
      if (action === "volumeUp" && before === 100) {
        after = before;
        return "TV volume is already at maximum.";
      }
      checkCancelled(signal);
      if (!client.connected) throw new TvError("TV disconnected before the audio request");
      sent = true;
      await waitForOperation(client.request(`ssap://audio/${action}`, args), signal);
      for (const pause of [0, 125, 275]) {
        if (pause) await delay(pause, undefined, { signal });
        const actual = await readTvAudio(client, signal);
        after = action === "setMute" ? actual.muted : actual.volume?.value;
        if (action === "setMute" && after === command.mute) return command.mute ? "TV muted." : "TV unmuted.";
        if (action === "setVolume" && after === command.volume) return "Volume adjusted.";
        if (action === "volumeUp" && prior.volume && actual.volume &&
            prior.volume.output === actual.volume.output && actual.volume.value > prior.volume.value) {
          return "Volume adjusted.";
        }
      }
    });
    if (verified) {
      status = "SUCCESS";
      reply = verified;
    } else status = "UNKNOWN";
  } catch (error) {
    if (parent?.aborted) throw error;
    if (sent && (error as NodeJS.ErrnoException).code !== "ESSAP") status = "UNKNOWN";
  }
  if (status === "UNKNOWN") reply = "TV audio change is unverified.";
  console.info(`[TV audio] action=${action} status=${status} result=${JSON.stringify({before, after})} llm_requests=0 total_ms=${Math.round(performance.now() - started)}`);
  return reply;
}

// ---- Session ducking support (TV_DUCKING): one connection that reads the audio state, lets the caller decide, then sets an exact
// volume with ONE setVolume command (a single webOS overlay) and verifies it. Only audio calls are used: a TV in standby refuses the connection, so this can never switch it on.
export type TvAudioState = { value: number; output?: string; muted?: boolean };
export type TvPlan = { target: number } | { skip: string };
export type TvAdjustResult =
  | { status: "SET"; before: number; actual: number }
  | { status: "SKIPPED"; reason: string; current: TvAudioState }
  | { status: "UNVERIFIED"; before: number; actual?: number }
  | { status: "UNAVAILABLE" };

export async function tvAdjustVolume(decide: (current: TvAudioState) => TvPlan | Promise<TvPlan>): Promise<TvAdjustResult> {
  let sent = false;
  let before = -1;
  try {
    return await withClient(getTarget(), operationMs, undefined, false, async (client, signal): Promise<TvAdjustResult> => {
      const current = await readTvAudio(client, signal);
      if (!current.volume) return { status: "UNAVAILABLE" };
      const state: TvAudioState = { value: current.volume.value, output: current.volume.output, muted: current.muted };
      before = state.value;
      const plan = await decide(state);
      if ("skip" in plan) return { status: "SKIPPED", reason: plan.skip, current: state };
      if (!Number.isInteger(plan.target) || plan.target < 0 || plan.target > 100) return { status: "SKIPPED", reason: "invalid target", current: state };
      checkCancelled(signal);
      if (!client.connected) throw new TvError("TV disconnected before the volume request");
      sent = true;
      await waitForOperation(client.request("ssap://audio/setVolume", { volume: plan.target }), signal);
      let actual: number | undefined;
      for (const pause of [0, 125, 275]) {
        if (pause) await delay(pause, undefined, { signal });
        const now = await readTvAudio(client, signal);
        actual = now.volume?.value;
        if (actual === plan.target) return { status: "SET", before, actual };
      }
      return { status: "UNVERIFIED", before, actual };
    });
  } catch {
    return sent ? { status: "UNVERIFIED", before } : { status: "UNAVAILABLE" };
  }
}

const appList = "ssap://com.webos.applicationManager/listLaunchPoints";
const foreground = "ssap://com.webos.applicationManager/getForegroundAppInfo";

async function findYoutube(client: LGTV, signal: AbortSignal): Promise<string> {
  checkCancelled(signal);
  const data = asObject(await waitForOperation(client.request(appList), signal));
  const ids = new Set<string>();
  for (const item of Array.isArray(data?.launchPoints) ? data.launchPoints : []) {
    const app = asObject(item);
    if (typeof app?.title === "string" && app.title.trim().toLowerCase() === "youtube" &&
        typeof app.id === "string" && /^[a-zA-Z0-9._-]{1,128}$/.test(app.id)) ids.add(app.id);
  }
  if (ids.size !== 1) throw new TvError("YouTube could not be uniquely identified on the TV");
  return [...ids][0];
}

async function readForeground(client: LGTV, signal: AbortSignal): Promise<unknown> {
  checkCancelled(signal);
  return asObject(await waitForOperation(client.request(foreground), signal))?.appId;
}

export async function openYoutubeAndReply(parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  let sent = false;
  let accepted = false;
  let appId: string | undefined;
  let status: YoutubeStatus;
  try {
    status = await withClient(getTarget(), 4800, parent, false, async (client, signal) => {
      appId = await findYoutube(client, signal);
      checkCancelled(signal);
      if (!client.connected) throw new TvError("TV connection closed before YouTube launch");
      sent = true;
      await waitForOperation(client.request("ssap://com.webos.applicationManager/launch", { id: appId }), signal);
      accepted = true;
      for (const pause of [0, 150, 350, 600, 950]) {
        if (pause) await delay(pause, undefined, { signal });
        if (await readForeground(client, signal) === appId) return "SUCCESS";
      }
      return "UNKNOWN";
    }, "youtube");
  } catch (error) {
    if (parent?.aborted) throw error;
    status = accepted || (sent && (error as NodeJS.ErrnoException).code !== "ESSAP") ? "UNKNOWN" : "FAILED";
  }
  console.info(`[TV YouTube] status=${status} app_id=${appId ?? "-"} llm_requests=0 total_ms=${Math.round(performance.now() - started)}`);
  return replyFor(status, youtubeReplies, nextYoutubeReply);
}

export async function searchYoutubeAndReply(query: string, parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  let sent = false;
  let status: "SENT" | "FAILED" | "UNKNOWN";
  try {
    status = await withClient(getTarget(), 4800, parent, false, async (client, signal) => {
      const id = await findYoutube(client, signal);
      if (id !== "youtube.leanback.v4") return "FAILED";
      // The leanback app reads q from /tv. Send the same URL in both launcher fields.
      const encodedQuery = new URLSearchParams({ q: query }).toString().replace(/\+/g, "%20");
      const link = "https://www.youtube.com/tv?" + encodedQuery;
      checkCancelled(signal);
      if (!client.connected) throw new TvError("TV connection closed before YouTube search");
      sent = true;
      const result = asObject(await waitForOperation(client.request("ssap://system.launcher/launch",
        { id, contentId: link, params: { contentTarget: link } }), signal));
      return result?.returnValue === true ? "SENT" : result?.returnValue === false ? "FAILED" : "UNKNOWN";
    }, "youtube");
  } catch (error) {
    if (parent?.aborted) throw error;
    status = sent && (error as NodeJS.ErrnoException).code !== "ESSAP" ? "UNKNOWN" : "FAILED";
  }
  console.info("[TV YouTube search] status=%s llm_requests=0 total_ms=%d",
    status, Math.round(performance.now() - started));
  if (status === "SENT") return "Search sent to YouTube.";
  if (status === "UNKNOWN") return "I couldn't verify the YouTube search request.";
  return "I couldn't send the YouTube search.";
}

async function pairYoutube(): Promise<void> {
  const appId = await withClient(getTarget(), pairingMs, undefined, true, async (client, signal) => {
    const id = await findYoutube(client, signal);
    try {
      const current = await readForeground(client, signal);
      console.info(`[TV YouTube] Foreground lookup ${typeof current === "string" ? "available" : "unavailable"}`);
    } catch {
      checkCancelled(signal);
      console.warn("[TV YouTube] Foreground lookup unavailable");
    }
    return id;
  }, "youtube");
  console.info(`[TV YouTube] Authorization confirmed. YouTube app ID: ${appId}.`);
}

async function getPointerUrl(client: LGTV, target: Target, signal: AbortSignal): Promise<URL> {
  checkCancelled(signal);
  const response = asObject(await waitForOperation(client.request(pointerInput), signal));
  if (typeof response?.socketPath !== "string") throw new TvError("TV did not provide a pointer socket");
  const url = new URL(response.socketPath);
  if (url.protocol !== "wss:" || url.hostname !== target.host || url.port !== "3001" ||
      url.username || url.password || url.search || url.hash ||
      !/^\/resources\/[a-zA-Z0-9._/-]+$/.test(url.pathname)) {
    throw new TvError("TV supplied an unexpected pointer socket");
  }
  return url;
}

async function sendTvButton(url: URL, target: Target, button: TvNavigationButton | (typeof playbackButtons)[TvPlaybackAction],
  signal: AbortSignal, beforeSend?: () => Promise<void>): Promise<void> {
  checkCancelled(signal);
  // lgtv2 opens pointer URLs supplied by the TV without applying its main socket pin.
  // This socket checks the same pin before sending exactly one button frame.
  const options = {
    rejectUnauthorized: false, followRedirects: false, perMessageDeflate: false,
    handshakeTimeout: 1100, maxPayload: 4096, closeTimeout: 75,
  };
  const socket = new WebSocket(url, options);
  let sent = false;
  try {
    await waitForOperation(new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.once("close", () => reject(new TvError("TV pointer socket closed")));
      let verified = false;
      socket.once("upgrade", response => {
        const certificate = (response.socket as TLSSocket).getPeerCertificate();
        verified = certificate?.fingerprint256?.replace(/:/g, "").toLowerCase() === target.fingerprint;
        if (!verified) reject(new TvError("TV pointer certificate mismatch"));
      });
      socket.once("open", async () => {
        if (!verified || signal.aborted) {
          reject(new TvError("TV pointer connection could not be verified"));
          return;
        }
        if (beforeSend) {
          try {
            await beforeSend();
            if (signal.aborted || socket.readyState !== WebSocket.OPEN) throw new TvError("TV pointer closed before HOME");
          } catch (error) { reject(error); return; }
        }
        socket.send(`type:button\nname:${button}\n\n`, error => error ? reject(error) : resolve());
      });
    }), signal);
    sent = true;
  } finally {
    if (sent) socket.close();
    else socket.terminate();
  }
}

export async function navigateTvAndReply(button: TvNavigationButton, parent?: AbortSignal): Promise<{ reply: string; sent: boolean }> {
  const started = performance.now();
  let status: NavigationStatus = "FAILED";
  try {
    if (!Object.values(navigationButtons).includes(button)) throw new TvError("Unsupported TV button");
    const target = getTarget();
    await withClient(target, 2700, parent, false, async (client, signal) => {
      const url = await getPointerUrl(client, target, signal);
      await sendTvButton(url, target, button, signal);
    }, "navigation");
    status = "SENT";
  } catch (error) {
    if (parent?.aborted) throw error;
  }
  console.info(`[TV navigation] button=${button} status=${status} llm_requests=0 total_ms=${Math.round(performance.now() - started)}`);
  return { reply: replyFor(status, navigationReplies, nextNavigationReply), sent: status === "SENT" };
}

async function verifyTvPlayback(client: LGTV, action: TvPlaybackAction, signal: AbortSignal): Promise<"SUCCESS" | "FAILED" | "UNKNOWN"> {
  let confirmedOtherState = false;
  for (const pause of [0, 180, 350]) {
    if (pause) await delay(pause, undefined, { signal });
    checkCancelled(signal);
    try {
      const payload = asObject(await waitForOperation(client.request("ssap://com.webos.media/getForegroundAppInfo"), signal));
      const entries = payload?.foregroundAppInfo;
      if (!Array.isArray(entries) || entries.length !== 1) return "UNKNOWN";
      const entry = asObject(entries[0]);
      const state = entry?.type === "media" ? entry.playState : undefined;
      if (state === playbackStates[action]) return "SUCCESS";
      confirmedOtherState = state === "playing" || state === "paused" || state === "stopped";
    } catch {
      checkCancelled(signal);
      return "UNKNOWN";
    }
  }
  return confirmedOtherState ? "FAILED" : "UNKNOWN";
}

export async function changeTvPlaybackAndReply(action: TvPlaybackAction, parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  let sent = false;
  let status: "SUCCESS" | "FAILED" | "UNKNOWN" = "FAILED";
  try {
    if (!Object.prototype.hasOwnProperty.call(playbackButtons, action)) throw new TvError("Unsupported playback action");
    const target = getTarget();
    status = await withClient(target, 2700, parent, false, async (client, signal) => {
      const url = await getPointerUrl(client, target, signal);
      await sendTvButton(url, target, playbackButtons[action], signal);
      sent = true;
      return verifyTvPlayback(client, action, signal);
    }, "navigation");
  } catch (error) {
    if (parent?.aborted) throw error;
    if (sent) status = "UNKNOWN";
  }
  console.info(`[TV playback] action=${action} status=${status} sent=${sent} llm_requests=0 total_ms=${Math.round(performance.now() - started)}`);
  if (status === "SUCCESS") return "";
  if (status === "UNKNOWN") return "Sent. Playback unverified.";
  return sent ? "TV playback didn't reach the requested state." : "I couldn't send the TV command.";
}

export async function setTvScreenAndReply(action: "on" | "off", parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  const expected = action === "on" ? "on" : "screen_off";
  let sent = false;
  let status: "SUCCESS" | "FAILED" | "UNKNOWN";
  try {
    const target = getTarget();
    const deadline = operationDeadline(4500, parent);
    try {
      // The panel key cannot read power state on this TV. Use the existing
      // power credential for the read only; send panel commands with its own key.
      const before = await wakePower(target, deadline.signal);
      if (before === expected) status = "SUCCESS";
      else if (before !== (action === "on" ? "screen_off" : "on")) status = "FAILED";
      else status = await withClient(target, 3000, deadline.signal, false, async (client, signal) => {
        checkCancelled(signal);
        const endpoint = action === "on" ? "turnOnScreen" : "turnOffScreen";
        sent = true;
        const result = asObject(await waitForOperation(client.request(
          "ssap://com.webos.service.tvpower/power/" + endpoint, { standbyMode: "active" }), signal));
        if (result?.returnValue === false) return "FAILED";
        if (result?.returnValue === true && result.state === (action === "on" ? "Active" : "Screen Off")) {
          return "SUCCESS";
        }
        return "UNKNOWN";
      }, "screen");
    } finally {
      deadline.dispose();
    }
  } catch (error) {
    if (parent?.aborted) throw error;
    status = sent && (error as NodeJS.ErrnoException).code !== "ESSAP" ? "UNKNOWN" : "FAILED";
  }
  console.info("[TV screen] action=%s status=%s sent=%s llm_requests=0 total_ms=%d",
    action, status, sent, Math.round(performance.now() - started));
  if (status === "SUCCESS") return action === "off" ? "Screen off." : "Screen on.";
  if (status === "UNKNOWN") return "TV screen change is unverified.";
  return "I couldn't change the TV screen.";
}

export async function showTvNotificationAndReply(parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  let sent = false;
  let status: "SUCCESS" | "FAILED" | "UNKNOWN";
  try {
    status = await withClient(getTarget(), 3000, parent, false, async (client, signal) => {
      checkCancelled(signal);
      sent = true;
      const result = asObject(await waitForOperation(client.request("ssap://system.notifications/createToast",
        { message: "GLaDOS: Connection verified." }), signal));
      return result?.returnValue === true ? "SUCCESS" : result?.returnValue === false ? "FAILED" : "UNKNOWN";
    }, "toast");
  } catch (error) {
    if (parent?.aborted) throw error;
    status = sent && (error as NodeJS.ErrnoException).code !== "ESSAP" ? "UNKNOWN" : "FAILED";
  }
  console.info("[TV notification] status=%s llm_requests=0 total_ms=%d",
    status, Math.round(performance.now() - started));
  if (status === "SUCCESS") return "Notification displayed.";
  if (status === "UNKNOWN") return "TV notification is unverified.";
  return "I couldn't display the TV notification.";
}

async function pairScreen(): Promise<void> {
  await withClient(getTarget(), pairingMs, undefined, true, async () => {}, "screen");
  console.info("[TV screen] Pairing confirmed.");
}

async function pairToast(): Promise<void> {
  await withClient(getTarget(), pairingMs, undefined, true, async () => {}, "toast");
  console.info("[TV notification] Pairing confirmed.");
}

function isConfirmedOff(state: unknown): state is "standby" | "off" {
  return state === "standby" || state === "off";
}

export async function turnOffTvAndReply(parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  let sent = false;
  let confirmed: "standby" | "off" | undefined;
  let status: "SUCCESS" | "FAILED" | "UNKNOWN" = "FAILED";
  try {
    await withClient(getTarget(), 5500, parent, false, async (client, signal) => {
      let resolveOff: () => void = () => {};
      const off = new Promise<void>(resolve => { resolveOff = resolve; });
      const observeState = (state: unknown) => {
        if (isConfirmedOff(state)) {
          confirmed = state;
          resolveOff();
        }
      };
      const subscription = client.subscribePowerState((error, result) => {
        if (!error) observeState(result?.state);
      });
      try {
        try {
          const current = await waitForOperation(client.getPowerState(), signal);
          observeState(current.state);
        } catch {
          checkCancelled(signal);
        }
        if (confirmed) return;
        checkCancelled(signal);
        if (!client.connected) throw new TvError("TV disconnected before power-off");
        sent = true;
        const request = client.request("ssap://system/turnOff").catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ESSAP") throw error;
          // A TV entering standby can drop the socket before answering the request.
          // An explicit power-state event can still establish the outcome.
        });
        await waitForOperation(Promise.race([request, off]), signal);
        await waitForOperation(off, signal);
      } finally {
        if (subscription !== undefined && client.connected) client.unsubscribe(subscription);
      }
    }, "power");
    if (confirmed) status = "SUCCESS";
  } catch (error) {
    if (parent?.aborted) throw error;
    if (confirmed) status = "SUCCESS";
    else if (sent && (error as NodeJS.ErrnoException).code !== "ESSAP") status = "UNKNOWN";
  }
  console.info(`[TV standby] status=${status} sent=${sent} state=${confirmed ?? "-"} llm_requests=0 total_ms=${Math.round(performance.now() - started)}`);
  if (status === "SUCCESS") return "Powering off.";
  if (status === "UNKNOWN") return "TV power-off is unverified.";
  return "I couldn't power off the TV.";
}

const wakeLogin = "glados-tv-wake";
const anonymousRpcSession = "00000000000000000000000000000000";
const wakeReplies = {
  SUCCESS: ["Waking the TV."],
  FAILED: ["I couldn't wake the TV."],
  UNKNOWN: ["TV wake-up is unverified."],
  ALREADY_ON: ["The TV is already on."],
};
type WakeStatus = keyof typeof wakeReplies;
const nextWakeReply: Partial<Record<WakeStatus, number>> = {};

function wakeCredentials(): { host: string; password: string; certificate: string; fingerprint: string } {
  const config = asObject(readJson(path.join(settingsDir, "wake-rpc.json"), true));
  if (!config || typeof config.password !== "string" || !/^[a-f0-9]{64}$/.test(config.password) ||
      typeof config.certificate !== "string" || typeof config.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(config.fingerprint)) throw new TvError("Invalid TV wake configuration");
  const certificate = new X509Certificate(config.certificate);
  // The router address is the one IPv4 address in the pinned router certificate.
  const addresses = (certificate.subjectAltName ?? "").split(/,\s*/)
    .filter(entry => entry.startsWith("IP Address:")).map(entry => entry.slice(11)).filter(entry => isIPv4(entry));
  const host = addresses.length === 1 ? addresses[0] : "";
  if (certificate.fingerprint256.replace(/:/g, "").toLowerCase() !== config.fingerprint || !isPrivateIPv4(host) ||
      certificate.checkIP(host) !== host) throw new TvError("Invalid router certificate");
  return { host, password: config.password, certificate: config.certificate, fingerprint: config.fingerprint };
}

class WakeRejected extends Error {}

async function wakeRpc(credentials: ReturnType<typeof wakeCredentials>, id: number, session: string,
  object: "session" | "glados.tv", method: "login" | "wake", args: Record<string, unknown>,
  parent: AbortSignal): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: "call", params: [session, object, method, args] });
  const deadline = operationDeadline(2300, parent);
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = https.request({
        hostname: credentials.host, path: "/cgi-bin/luci/admin/ubus", method: "POST", agent: false,
        ca: credentials.certificate, rejectUnauthorized: true, minVersion: "TLSv1.2",
        checkServerIdentity: (host, cert) => checkServerIdentity(host, cert) ??
          (cert.fingerprint256.replace(/:/g, "").toLowerCase() === credentials.fingerprint
            ? undefined : new TvError("Router certificate pin mismatch")),
        signal: deadline.signal,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, response => {
        response.once("error", reject);
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new TvError("Router HTTPS request rejected"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) {
            reject(new TvError("Oversized RPC response"));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.once("end", () => {
          try {
            const value = asObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            if (value?.jsonrpc === "2.0" && value.id === id && asObject(value.error)?.code === -32002) {
              throw new WakeRejected("RPC access denied");
            }
            if (value?.jsonrpc !== "2.0" || value.id !== id || !Array.isArray(value.result)) {
              throw new TvError("Invalid RPC response");
            }
            if (value.result[0] === 6) throw new WakeRejected("RPC access denied");
            const result = asObject(value.result[1]);
            if (value.result[0] !== 0 || !result) throw new TvError("RPC failed");
            resolve(result);
          } catch (error) { reject(error); }
        });
      });
      request.once("error", reject);
      request.end(body);
    });
  } finally { deadline.dispose(); }
}

async function wakePower(target: Target, parent: AbortSignal): Promise<unknown> {
  try {
    return await withClient(target, 1500, parent, false, (client, signal) =>
      waitForOperation(client.getPowerState(), signal).then(reply => reply.state), "power");
  } catch {
    checkCancelled(parent);
    return undefined;
  }
}

async function wakePortUnavailable(host: string, parent: AbortSignal): Promise<boolean> {
  const deadline = operationDeadline(450, parent);
  const socket = connect({ host, port: 3001 });
  try {
    return await waitForOperation(new Promise<boolean>((resolve, reject) => {
      socket.once("connect", () => resolve(false));
      socket.once("error", error => {
        if (["ECONNREFUSED", "ETIMEDOUT"].includes((error as NodeJS.ErrnoException).code ?? "")) resolve(true);
        else reject(error);
      });
    }), deadline.signal);
  } catch {
    checkCancelled(parent);
    return deadline.signal.aborted;
  } finally {
    socket.destroy();
    deadline.dispose();
  }
}

async function wakeHome(target: Target, parent: AbortSignal): Promise<boolean> {
  let homeAttempted = false;
  for (const pause of [0, 300, 500, 750, 1000]) {
    if (pause) await delay(pause, undefined, { signal: parent });
    let phase = "navigation_auth";
    try {
      await withClient(target, 8500, parent, false, async (client, signal) => {
        phase = "pointer_url";
        const url = await getPointerUrl(client, target, signal);
        phase = "pointer_handshake";
        await sendTvButton(url, target, "HOME", signal, async () => {
          homeAttempted = true;
          phase = "home_settle";
          console.info("[TV wake] remote=ready settle_ms=5000");
          await delay(5000, undefined, { signal });
          phase = "home_write";
        });
        console.info("[TV wake] home=sent");
      }, "navigation");
    } catch {
      console.info("[TV wake] phase=%s result=failed", phase);
      checkCancelled(parent);
    }
    if (homeAttempted) break;
  }
  if (!homeAttempted) return false;
  for (const pause of [100, 350, 700, 1000]) {
    await delay(pause, undefined, { signal: parent });
    try {
      const app = await withClient(target, 1400, parent, false, readForeground, "youtube");
      if (app === "com.webos.app.home") return true;
    } catch { checkCancelled(parent); }
  }
  return false;
}

export async function turnOnTvAndReply(parent?: AbortSignal, onWakeSent?: (text: string) => void): Promise<string> {
  const started = performance.now();
  const deadline = operationDeadline(20000, parent);
  let attempted = false;
  let active = false;
  let home = false;
  let status: WakeStatus = "FAILED";
  try {
    const target = getTarget();
    const signal = deadline.signal;
    const before = await wakePower(target, signal);
    if (before === "on" || before === "screen_off" || before === "screen_saver") {
      status = "ALREADY_ON";
    } else if (!isConfirmedOff(before) && (before !== undefined || !await wakePortUnavailable(target.host, signal))) {
      status = "UNKNOWN";
    } else {
      const credentials = wakeCredentials();
      const login = await wakeRpc(credentials, 1, anonymousRpcSession, "session", "login",
        { username: wakeLogin, password: credentials.password, timeout: 20 }, signal);
      const session = login.ubus_rpc_session;
      if (typeof session !== "string" || !/^[a-f0-9]{32}$/.test(session) || session === anonymousRpcSession) {
        throw new TvError("Invalid router RPC session");
      }
      checkCancelled(signal);
      attempted = true;
      let wakeSent = false;
      try {
        const reply = await wakeRpc(credentials, 2, session, "glados.tv", "wake", {}, signal);
        if (reply.sent === false) throw new WakeRejected("Router did not send the wake packet");
        wakeSent = reply.sent === true;
      } catch (error) {
        checkCancelled(signal);
        if (error instanceof WakeRejected) throw error;
        // A lost response leaves the outcome uncertain. Check the TV; never resend.
      }
      if (wakeSent && onWakeSent && !signal.aborted) {
        console.info("[TV wake] progress=wake_sent total_ms=%d", Math.round(performance.now() - started));
        onWakeSent(wakeReplies.SUCCESS[0]);
      }
      const bootLimit = performance.now() + 10500;
      do {
        active = await wakePower(target, signal) === "on";
        if (active) break;
        await delay(650, undefined, { signal });
      } while (performance.now() < bootLimit);
      if (active) home = await wakeHome(target, signal);
      status = active && home ? "SUCCESS" : "UNKNOWN";
    }
  } catch (error) {
    if (parent?.aborted) throw error;
    if (attempted && !(error instanceof WakeRejected)) status = "UNKNOWN";
  } finally { deadline.dispose(); }
  console.info("[TV wake] status=%s attempted=%s active=%s home=%s llm_requests=0 total_ms=%d",
    status, attempted, active, home, Math.round(performance.now() - started));
  return replyFor(status, wakeReplies, nextWakeReply);
}

// Spoken power status from the existing read-only power-state query. A state we cannot read is never guessed.
export function describeTvPower(state: unknown, unreachable: boolean): string {
  if (state === "on") return "The TV is on.";
  if (state === "screen_off") return "The TV is on, with its screen off.";
  if (state === "screen_saver") return "The TV is on, showing its screen saver.";
  if (isConfirmedOff(state)) return "The TV is in standby.";
  if (state === undefined && unreachable) return "The TV isn't responding on the network, so it is most likely off or in standby. I can't confirm that.";
  return "I can't verify the TV's state right now.";
}

export async function tvPowerStatusAndReply(parent?: AbortSignal): Promise<string> {
  const started = performance.now();
  const deadline = operationDeadline(3000, parent);
  let state: unknown;
  let unreachable = false;
  try {
    const target = getTarget();
    state = await wakePower(target, deadline.signal);
    if (state === undefined) unreachable = await wakePortUnavailable(target.host, deadline.signal);
  } catch (error) {
    if (parent?.aborted) throw error;
  } finally { deadline.dispose(); }
  console.info("[TV status] state=%s unreachable=%s llm_requests=0 total_ms=%d", String(state ?? "-"), unreachable, Math.round(performance.now() - started));
  return describeTvPower(state, unreachable);
}

async function pairPower(): Promise<void> {
  await withClient(getTarget(), pairingMs, undefined, true, async (client, signal) => {
    const result = await waitForOperation(client.getPowerState(), signal);
    if (result.state === "unknown") throw new TvError("TV power state is unavailable");
    console.info(`[TV standby] Authorization confirmed. Current state: ${result.state}.`);
  }, "power");
}

async function pairNavigation(): Promise<void> {
  const target = getTarget();
  await withClient(target, pairingMs, undefined, true, (client, signal) => getPointerUrl(client, target, signal), "navigation");
  console.info("[TV navigation] Authorization confirmed. Secure pointer socket available.");
}

export async function pair(): Promise<void> {
  const target = getTarget();
  const result = await withClient(target, pairingMs, undefined, true, async (client, signal) => {
    const volume = await readVolume(client, signal);
    return volume?.value;
  });
  console.info(`[TV volume] Authorization confirmed. Reported volume: ${result ?? "unavailable"}.`);
}

if (require.main === module) {
  const command = process.argv[2];
  const run = new Map([["--pair", pair], ["--pair-youtube", pairYoutube],
    ["--pair-navigation", pairNavigation], ["--pair-power", pairPower], ["--pair-screen", pairScreen], ["--pair-toast", pairToast]]).get(command);
  if (process.argv.length !== 3 || !run) process.exitCode = 2;
  else run().catch(error => {
    console.error("[TV volume] Pairing failed:", error instanceof TvError ? error.message : "TV setup or connection failed");
    process.exitCode = 1;
  });
}
