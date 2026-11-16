// Host-side answers to whole, clearly identified questions about this assistant itself. Facts come from the
// running configuration, the registered tool names and the Whisplay daemon's capability report; the model is
// never asked, so it cannot invent hardware, services, internet access or abilities. Anything that cannot be
// read is reported as unverified. Other conversation is untouched (no match returns undefined).
import fs from "node:fs";
import path from "node:path";

export type SelfTopic =
  | "model" | "hardware" | "stt" | "tts" | "tools" | "limits"
  | "music" | "timer" | "search" | "image" | "internet" | "tv" | "memory";

const TIMING = "(?:in (?:an?|\\d+|[a-z]+(?: and a half)?) (?:seconds?|minutes?|hours?|days?)|at \\S.*|tomorrow|tonight|later)";

const PATTERNS: [SelfTopic, RegExp][] = [
  ["model", /^(?:(?:what|which) (?:ai |llm |language )?(?:model|brain)(?: are you| do you (?:use|run on|run)| are you (?:using|running)| powers you| runs you)|(?:what|which) ai are you(?: using| running)?)$/],
  ["hardware", /^(?:where do you run|where are you running|what (?:hardware|computer|device|board) (?:do you run on|are you running on|are you on)|what are you running on|what raspberry pi are you (?:on|running on)|(?:are|do) you (?:running|run) (?:locally|on a raspberry pi|in the cloud)|are you (?:local|in the cloud|a raspberry pi))$/],
  ["stt", /^(?:(?:what|which) (?:speech(?: |-)?(?:recognition|to(?: |-)?text)|stt|asr|transcription|speech recogni[sz]er)(?: engine| model| system| software)? (?:do you use|are you using|do you run|is this)|how do you (?:transcribe|recogni[sz]e) (?:my )?(?:speech|voice))$/],
  ["tts", /^(?:(?:what|which) (?:text(?: |-)?to(?: |-)?speech|tts|voice|speech synthesi[sz]er)(?: engine| model| system| software)? (?:do you use|are you using|is this)|what voice (?:is this|are you using))$/],
  ["tools", /^(?:(?:what|which) (?:tools|functions|skills|abilities) do you have|what tools (?:are|do you have) available|(?:list|name) your tools)$/],
  ["limits", /^(?:what (?:can't|cannot|can not) you do|what are you (?:not able|unable) to do|what are your (?:limits|limitations)|what (?:don't|do not) you support)$/],
  ["music", /^(?:(?:can|could|do) you (?:play (?:some |any )?(?:music|songs?)|(?:play|put on) (?:a )?(?:song|track))|(?:do you have|is there) (?:a )?music(?: player| playback)?)$/],
  ["timer", new RegExp(`^(?:(?:can|could|do) you (?:set|start|make) (?:me )?(?:an? )?(?:timers?|alarms?|reminders?|countdowns?)(?: (?:for|at) .+)?|(?:set|start|make) (?:me )?(?:an? )?(?:timer|alarm|countdown)(?: (?:for|at) .+)?|(?:wake me up|remind me) ${TIMING}(?: .+)?|remind me to .+ ${TIMING}|remind me ${TIMING} to .+)$`)],
  ["search", /^(?:can|could|do) you (?:search the (?:web|internet)|browse(?: the (?:web|internet))?|look things up(?: online)?|google(?: things)?)$/],
  ["image", /^(?:can|could|do) you (?:generate|make|create|draw) (?:me )?(?:an? )?(?:pictures?|images?|photos?)$/],
  ["internet", /^(?:(?:are you|do you have) (?:connected to the internet|online|internet access)|(?:can you|do you) (?:access|reach) the internet)$/],
  ["tv", /^(?:can|could|do) you (?:control|operate|use) (?:the |my )?(?:tv|television)$/],
  ["memory", /^(?:can|could|do) you (?:remember|save|store) (?:things|what i (?:say|tell you)|facts)$/],
];

function normalize(text: string): string {
  if (text.length > 160) return "";
  return text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim()
    .replace(/[.!?]+$/, "").replace(/^(?:hey )?glados[, ]+/, "")
    .replace(/^(?:please|tell me|can you tell me|could you tell me),? /, "").replace(/,? please$/, "").trim();
}

export function selfKnowledgeTopic(text: string): SelfTopic | undefined {
  const q = normalize(text);
  return q ? PATTERNS.find(([, pattern]) => pattern.test(q))?.[0] : undefined;
}

export type SelfFacts = {
  env: NodeJS.ProcessEnv;
  tools: string[];                    // names registered with the model
  boardModel?: string;                // /proc/device-tree/model, when readable
  tvConfigured: boolean;
  capabilities?: unknown;             // daemon capability report; undefined when it could not be read
};

const LOCAL_SERVERS = new Set(["ollama", "faster-whisper", "whisper", "whisper-http", "vosk", "piper", "piper-http", "espeak"]);
const ONLINE_NOTE = "I have not tested the connection right now";
const has = (facts: SelfFacts, ...names: string[]) => names.some(name => facts.tools.includes(name));
const list = (items: string[]) => items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;

function isLoopback(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try { return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(endpoint).hostname); } catch { return false; }
}

function modelAnswer(facts: SelfFacts): string {
  const server = (facts.env.LLM_SERVER || "").toLowerCase();
  const model = facts.env.OLLAMA_MODEL || "";
  if (server === "ollama" && model) {
    return isLoopback(facts.env.OLLAMA_ENDPOINT)
      ? `My language model is ${model}, served locally by Ollama on this device.`
      : `My language model is ${model}, served by Ollama at a remote address.`;
  }
  return server ? `My language model is served by ${server}. I cannot read its exact model name.` : "I cannot read which language model is configured.";
}

function sttAnswer(facts: SelfFacts): string {
  const server = (facts.env.ASR_SERVER || "").toLowerCase();
  if (!server) return "I cannot read which speech recognition is configured.";
  const size = facts.env.FASTER_WHISPER_MODEL_SIZE_OR_PATH;
  const detail = server === "faster-whisper" && size ? `, model ${path.basename(size)}` : "";
  const language = server === "faster-whisper" && facts.env.FASTER_WHISPER_LANGUAGE ? `, language ${facts.env.FASTER_WHISPER_LANGUAGE}` : "";
  return `Speech recognition is ${server}${detail}${language}${LOCAL_SERVERS.has(server) ? ", running on this device" : ", which is not a local engine"}.`;
}

function ttsAnswer(facts: SelfFacts): string {
  const server = (facts.env.TTS_SERVER || "").toLowerCase();
  if (!server) return "I cannot read which speech synthesis is configured.";
  const voice = server.startsWith("piper") && facts.env.PIPER_HTTP_VOICE ? ` with the ${facts.env.PIPER_HTTP_VOICE} voice` : "";
  return `My voice is synthesized by ${server}${voice}${LOCAL_SERVERS.has(server) ? ", running on this device" : ", which is not a local engine"}.`;
}

function hardwareAnswer(facts: SelfFacts): string {
  const board = facts.boardModel ? `I run on this device, a ${facts.boardModel}.` : "I run on this Whisplay device, but I cannot read the board model.";
  const parts = [["language model", facts.env.LLM_SERVER], ["speech recognition", facts.env.ASR_SERVER], ["speech synthesis", facts.env.TTS_SERVER]]
    .filter(([, value]) => value) as [string, string][];
  const remote = parts.filter(([, value]) => !LOCAL_SERVERS.has(value.toLowerCase())).map(([label]) => label);
  const locality = !parts.length ? "" : remote.length
    ? ` These parts are not local engines: ${list(remote)}.`
    : " The language model, speech recognition and speech synthesis all run on this device.";
  const online = [has(facts, "web_search", "webSearch", "fetch_webpage") ? "web search" : "", has(facts, "generateImage") ? "image generation" : ""].filter(Boolean);
  return board + locality + (online.length ? ` ${list(online).replace(/^./, c => c.toUpperCase())} use online services.` : "");
}

function actionList(capabilities: unknown): { supported: string[]; unsupported: string[] } | undefined {
  const report = capabilities as { actions?: Record<string, { supported?: boolean }> } | undefined;
  if (!report || typeof report !== "object" || !report.actions || typeof report.actions !== "object") return;
  const label: Record<string, string> = {
    brightness: "screen brightness", volume: "speaker volume", mute: "mute", lock: "locking the screen", home: "returning Home",
    recording: "locking recording", wifi: "Wi-Fi switching", wifi_scan: "Wi-Fi scans", wifi_profile: "Wi-Fi profile changes",
    wifi_join: "joining Wi-Fi networks", bluetooth: "Bluetooth switching", bluetooth_scan: "Bluetooth scans",
    bluetooth_device: "Bluetooth devices", service: "starting services", reboot: "restarting the Raspberry Pi", shutdown: "shutting the Raspberry Pi down",
  };
  const names = Object.keys(report.actions);
  const pick = (value: boolean) => names.filter(name => (report.actions![name]?.supported === true) === value).map(name => label[name] || name);
  return { supported: pick(true), unsupported: pick(false) };
}

function toolsAnswer(facts: SelfFacts): string {
  const items: string[] = [];
  let device = "";
  if (has(facts, "whisplay")) {
    const actions = actionList(facts.capabilities);
    device = actions ? `I have device controls for ${list(actions.supported.slice(0, 4))}.` : "I have device controls, which I could not verify just now.";
  }
  if (has(facts, "getSystemHealth")) items.push("system health readings");
  if (facts.tvConfigured) items.push("TV volume, screen, power and navigation commands");
  if (has(facts, "web_search", "webSearch", "fetch_webpage")) items.push("web search");
  if (has(facts, "generateImage")) items.push("image generation");
  if (has(facts, "searchLocalMemory", "storeLocalMemory")) items.push("saved memory");
  if (has(facts, "playMusic", "playMusicRandom")) items.push("local music playback");
  const rest = items.length ? `${device ? "I also have" : "I have"} ${list(items)}.` : "";
  return device || rest ? `${[device, rest].filter(Boolean).join(" ")} Ask what I cannot do for the limits.` : "I have no tools registered right now.";
}

function limitsAnswer(facts: SelfFacts): string {
  const limits = ["I cannot set timers, alarms or timed reminders."];
  if (!has(facts, "playMusic", "playMusicRandom")) limits.push("I cannot play music because no music library is configured.");
  if (!has(facts, "web_search", "webSearch", "fetch_webpage")) limits.push("I cannot search the web.");
  if (!has(facts, "generateImage")) limits.push("I cannot generate images.");
  if (!facts.tvConfigured) limits.push("I cannot control a TV.");
  const actions = actionList(facts.capabilities);
  const device = !has(facts, "whisplay") ? "" : actions
    ? actions.unsupported.length ? ` My device daemon reports these as unsupported: ${list(actions.unsupported)}.` : ""
    : " I could not verify which device controls are unsupported just now.";
  return `${limits.join(" ")}${device} I also cannot check anything I have no tool for.`;
}

export function selfKnowledgeReply(topic: SelfTopic, facts: SelfFacts): string {
  switch (topic) {
    case "model": return modelAnswer(facts);
    case "hardware": return hardwareAnswer(facts);
    case "stt": return sttAnswer(facts);
    case "tts": return ttsAnswer(facts);
    case "tools": return toolsAnswer(facts);
    case "limits": return limitsAnswer(facts);
    case "timer": return "I can't set timers, alarms or timed reminders yet, so nothing has been scheduled.";
    case "music": return has(facts, "playMusic", "playMusicRandom")
      ? "Yes. Local music playback is set up. I have not checked that the library is readable right now."
      : "No. Music playback is not set up here because no music library is configured.";
    case "search": return has(facts, "web_search", "webSearch", "fetch_webpage")
      ? `Web search is set up through ${facts.env.WEB_SEARCH_PROVIDER || "its default provider"} and needs the internet. ${ONLINE_NOTE}.`
      : "No. Web search is not available.";
    case "image": return has(facts, "generateImage")
      ? `Image generation is set up through ${facts.env.IMAGE_GENERATION_SERVER || "an online provider"}, an online service. ${ONLINE_NOTE}.`
      : "No. Image generation is not available.";
    case "internet": {
      const online = [has(facts, "web_search", "webSearch", "fetch_webpage") ? "web search" : "", has(facts, "generateImage") ? "image generation" : ""].filter(Boolean);
      return online.length
        ? `Conversation runs on this device, but ${list(online)} need the internet. I have not tested internet access, so I cannot confirm it.`
        : "Conversation runs on this device and does not need the internet. I have not tested internet access, so I cannot confirm it.";
    }
    case "tv": return facts.tvConfigured
      ? "I can send TV volume, mute, screen, power and navigation commands. I have not checked that the TV is reachable right now."
      : "No. TV control is not set up here.";
    case "memory": return has(facts, "searchLocalMemory", "storeLocalMemory")
      ? "Yes. I can save facts you ask me to remember and recall them later."
      : "No. Saved memory is turned off.";
  }
}

// ---- Fact gathering (the only impure part) ------------------------------------------------------
function readBoardModel(): string | undefined {
  try { return fs.readFileSync("/proc/device-tree/model", "utf8").replace(/\0+$/, "").trim() || undefined; } catch { return undefined; }
}

export type SelfDeps = {
  env?: NodeJS.ProcessEnv;
  tools: () => string[];
  readCapabilities?: () => Promise<unknown>;
  boardModel?: () => string | undefined;
  tvConfigured?: () => boolean;
};

const tvConfiguredOnDisk = (): boolean => {
  try { return fs.statSync(path.resolve(__dirname, "../../data/.glados-tv")).isDirectory(); } catch { return false; }
};

/** Answer a matched question, or return undefined so the request continues to the model unchanged. */
export async function answerSelfKnowledge(text: string, deps: SelfDeps): Promise<string | undefined> {
  const topic = selfKnowledgeTopic(text);
  if (!topic) return undefined;
  const needsDevice = topic === "tools" || topic === "limits";
  let capabilities: unknown;
  if (needsDevice && deps.readCapabilities) {
    try { capabilities = await deps.readCapabilities(); } catch { capabilities = undefined; }
  }
  return selfKnowledgeReply(topic, {
    env: deps.env ?? process.env,
    tools: deps.tools(),
    boardModel: (deps.boardModel ?? readBoardModel)(),
    tvConfigured: (deps.tvConfigured ?? tvConfiguredOnDisk)(),
    capabilities,
  });
}
