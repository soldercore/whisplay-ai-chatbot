/**
 * Chooses which tools a small local model is offered for a request. Tools that
 * read private data (memory), change the device (volume) or create images are
 * offered only when the request may need them. Built-in web and device tools
 * likewise need a relevant request. Plugin tools without routing rules retain
 * their existing availability.
 *
 * Without this, qwen3 1.7B (thinking off) calls some tool for ordinary
 * questions that end in an instruction: "What is 2 plus 2? Answer in one
 * sentence." searched memory repeatedly, with the memory tools removed it
 * called setVolume, and "Describe a sunset in one sentence." searched the web.
 * Every extra tool round costs a full model call, which is slow on a Pi.
 */
import { mayConcernUserMemory } from "./memory-commands";
import { isCasualConversation, needsCurrentInformation } from "./web-search-router";
import * as deviceCommands from "./device-commands";
import { needsWhisplayCapabilities, requiresWhisplayTool } from "./whisplay-tools";

const { parseDeviceCommand, settingFollowUpText, suppressesMonitoringTools } = deviceCommands;
// Some installed builds export a newer target guard than their source tree.
const isExternalTvRequest = (text: string): boolean => {
  const guard = (deviceCommands as typeof deviceCommands & {
    isExternalTvRequest?: (request: string) => boolean;
  }).isExternalTvRequest;
  return guard?.(text) ?? /\b(?:(?:tv|television) (?:volume|sound)|(?:volume|sound) (?:on|of|for) (?:the |my |our |your )?(?:tv|television))\b/i.test(text);
};

const MENTIONS_VOLUME =
  /\b(volume|louder|quieter|softer|loud|quiet|mute|unmute|sound|hear|speaker|turn (it|this|that|the sound|the music)? ?(up|down))\b/i;

export const mentionsVolume = (text: string): boolean => MENTIONS_VOLUME.test(text || "");

const MENTIONS_IMAGE =
  /\b(draw|drawing|paint|painting|sketch|doodle|picture|pictures|image|images|photo|photos|illustrat\w*|artwork|wallpaper|logo|poster|portrait|cartoon)\b/i;

export const mentionsImage = (text: string): boolean => MENTIONS_IMAGE.test(text || "");

// Offering a tool is broader than requiring it. Only explicit requests for
// current local measurements are routed before the model; concepts stay chat.
export const needsSystemHealth = (text: string): boolean => {
  if (suppressesMonitoringTools(text)) return false;
  // Leave device/service intent to the model with both grounded tools available.
  if (process.env.WHISPLAY_VOICE_CONTROL_ENABLED === "true" && /\b(services?|ssh|wi-?fi|bluetooth|capabilit\w*|functions?)\b/i.test(text)) return false;
  if (/\b(explain|define|definition|joke|story|pretend|imagine)\b|\bhow (do|does|can|should|would)\b/i.test(text)) return false;
  const subject = /\b(system|device|cpu|processor|ram|memory|swap|disk|storage|temperature|uptime|services?)\b/i.test(text);
  const measurement = /\b(health|status|doing|running|usage|using|utili[sz]ation|load|temperature|swap|space|uptime)\b/i.test(text);
  const local = /\b(your|you|this system|this device|the system|the cpu|the disk|left|remaining|available|free|currently|current|right now|system health|system status|uptime|service status)\b/i.test(text)
    || /\b(check|report|show|measure|read)\b/i.test(text);
  return subject && measurement && local && /\b(how|what|check|report|show|measure|read|get|tell|is|are)\b/i.test(text);
};

// The user asks for a short answer from what the model knows: an answer-format
// instruction or plain arithmetic. Time-sensitive questions still get web search.
// ollama-llm.ts also blocks an unsolicited web call for these questions.
const ANSWER_FORMAT =
  /\b(in (one|a single|1|two|2|three|3|a few) (sentences?|words?|lines?)|one[- ]sentence|briefly|keep it (short|brief)|short answer|in short|in simple (terms|words)|explain simply)\b/i;
const ARITHMETIC = /\d\s*(plus|minus|times|multiplied by|divided by|over|[+\-*×÷/x])\s*\d/i;

export const isDirectAnswerRequest = (text: string): boolean =>
  (ANSWER_FORMAT.test(text || "") || ARITHMETIC.test(text || "")) && !needsCurrentInformation(text || "");

// Gated tools in a fixed order after the always-offered ones. Ollama renders
// the tools before the conversation, so a change in the offered set makes it
// re-read everything after the first changed tool.
const RELEVANT_WHEN: [string, (text: string) => boolean][] = [
  ["searchLocalMemory", mayConcernUserMemory],
  ["storeLocalMemory", mayConcernUserMemory],
  ["setVolume", mentionsVolume],
  ["increaseVolume", mentionsVolume],
  ["decreaseVolume", mentionsVolume],
  ["generateImage", mentionsImage],
  ["showPreviouslyGeneratedImage", mentionsImage],
  ["getSystemHealth", (text: string) => needsSystemHealth(text) || /\b(system (health|status|load)|your (system|status|health)|cpu|memory usage|swap|disk (usage|space)|temperature|uptime|service status|(?:ram|memory|disk|storage) (?:is )?(?:left|remaining|available|free))\b/i.test(text)],
];
const RULES = new Map(RELEVANT_WHEN);
const GATED_ORDER = new Map(RELEVANT_WHEN.map(([name], index) => [name, index]));
const ASKS_FOR_OPTIONAL_SEARCH = /^\s*(?:what(?:'s| is) new[?.!\s]*$|(?:please )?find (?:more )?information (?:about|on)\b)/i;
const ASKS_TO_READ_PAGE = /https?:\/\/|\b(?:open|read|fetch|follow|compare|summari[sz]e)\b.*\b(?:links?|(?:web|documentation) ?pages?)\b/i;

// Keep plain location facts and factual corrections conversational. These are
// deliberately narrow forms: ambiguous requests retain existing tool routing.
// Do not suppress a tool for current info, an explicit action, or a gated intent.
const PLAIN_LOCATION_FACT =
  /^\s*(?:my|our)\s+[a-z][a-z0-9' -]{0,64}\s+(?:is|was|are|were)\s+(?:in|at|on|under|near|inside|outside|behind|beside)\b/i;
const FACTUAL_CORRECTION =
  /^\s*(?:i\s+(?:was\s+talking\s+about|meant|told\s+you)|(?:actually|no)[,.:]?\s*i\s+(?:meant|was\s+talking\s+about|moved|left|put))\b/i;
const POSSIBLE_TOOL_INTENT =
  /\b(?:turn|switch|enable|disable|set|change|check|show|search|look\s+up|find|open|close|play|stop|start|restart|remember|forget|save|store|draw|create|generate|send|fetch|browse|delete|remove|control|execute|run|install|uninstall|wi-?fi|bluetooth|brightness|screen|services?|ssh|goodbye|goodnight|help\s+me)\b/i;

// Plain personal statements should be part of this conversation, not treated
// as implicit commands to search or permanently store personal information.
const PLAIN_PERSONAL_UPDATE =
  /^\s*(?:i\s+(?:prefer|like|love)\b|i(?:['’]m| am)\s+(?:going|travell?ing)\s+to\b)/i;

// Answer an immediately preceding preference from conversation context. A
// general question about a preference stays eligible for long-term memory.
const RECENT_PREFERENCE_QUESTION =
  /^\s*how\s+do\s+i\s+(?:prefer|like)\s+to\s+([a-z]+)\s*[?.!]*$/i;
const preferenceAlreadyStated = (question: string, previous: string): boolean => {
  const match = RECENT_PREFERENCE_QUESTION.exec(question);
  if (!match || !/\bi\s+(?:prefer|like)\b/i.test(previous)) return false;
  const topic = match[1].replace(/e$/i, "");
  const mentionsTopic = new RegExp(`\\b${topic}[a-z]*\\b`, "i").test(previous);
  const transport = /^(?:travel|commute)$/i.test(match[1]) &&
    /\b(?:trains?|rail|buses?|cars?|planes?|flights?|bikes?|bicycles?)\b/i.test(previous);
  return mentionsTopic || transport;
};


// A correction of a recently stated travel plan is conversational context,
// not an instruction to operate a device or update permanent memory.
const PLAIN_TRAVEL_CORRECTION =
  /^\s*(?:(?:actually|no)[,.:]?\s*)?i(?:['’]ve| have)\s+(?:changed|updated|switched)\s+(?:my\s+)?(?:destination|travel\s+plans?|trip|route)\s+to\b/i;

// These questions refer to the immediately corrected travel plan. Let the
// model read the conversation instead of offering long-term memory tools.
// Other personal questions remain eligible for stored memory lookup.
const RECENT_TRAVEL_QUESTION =
  /^\s*(?:where\s+am\s+i\s+going(?:\s+now)?(?:\s*,?\s+and\s+how\s+do\s+i\s+prefer\s+to\s+travel)?|how\s+do\s+i\s+prefer\s+to\s+travel)\s*[?.!]*$/i;

// A short or elliptical follow-up ("What about her birthday?", "A bit more.")
// continues the previous request; a self-contained question does not.
const FOLLOW_UP =
  /^\s*(and|also|plus|but|so|then|too|what about|how about|anything else|what else|more|she|he|they|her|his|their|it|that|this|those|them)\b/i;

export const isFollowUp = (text: string): boolean => {
  const words = `${text || ""}`.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && (words.length <= 3 || FOLLOW_UP.test(text));
};

/**
 * Keep plugin tool order and offer built-in tools for relevant requests.
 * A contextual follow-up may retain memory, volume or image tools.
 */
export const toolsRelevantTo = <T extends { function: { name: string } }>(
  request: string,
  tools: T[],
  previousRequest = "",
): T[] => {
  const casual = isCasualConversation(request);
  const passivePersonalUpdate = PLAIN_PERSONAL_UPDATE.test(request);
  const plainConversationUpdate = PLAIN_LOCATION_FACT.test(request) || FACTUAL_CORRECTION.test(request) || passivePersonalUpdate || PLAIN_TRAVEL_CORRECTION.test(request);
  if (plainConversationUpdate
      && !needsCurrentInformation(request)
      && !/[?]/.test(request)
      && !/https?:\/\/|www\./i.test(request)
      && !POSSIBLE_TOOL_INTENT.test(request)
      && !tools.some(({ function: { name } }) => RULES.get(name)?.(request)
        && !(passivePersonalUpdate && (name === "searchLocalMemory" || name === "storeLocalMemory")))) {
    return [];
  }
  if (preferenceAlreadyStated(request, previousRequest)
      && !needsCurrentInformation(request)
      && !POSSIBLE_TOOL_INTENT.test(request)
      && !/https?:\/\/|www\./i.test(request)) {
    return [];
  }
  if (PLAIN_TRAVEL_CORRECTION.test(previousRequest)
      && RECENT_TRAVEL_QUESTION.test(request)
      && !needsCurrentInformation(request)) {
    return [];
  }
  if (suppressesMonitoringTools(request)) {
    tools = tools.filter(({function: {name}}) => name !== "getSystemHealth" && name !== "whisplay");
  }
  const web = !casual && (needsCurrentInformation(request) || ASKS_FOR_OPTIONAL_SEARCH.test(request));
  const direct = parseDeviceCommand(request)?.name;
  const externalTv = isExternalTvRequest(request);
  const whisplay = !casual && !externalTv
    && (direct === "whisplay" || requiresWhisplayTool(request) || needsWhisplayCapabilities(request) || !!settingFollowUpText(request));
  const health = !casual && (direct === "getSystemHealth" || !!RULES.get("getSystemHealth")?.(request));
  const always = tools.filter(({ function: { name } }) => {
    switch (name) {
      case "web_search":
      case "webSearch":
        return web;
      case "webImageSearch":
        return web || (mentionsImage(request) && /\b(?:search|find|look up)\b/i.test(request));
      case "fetch_webpage":
        return web || ASKS_TO_READ_PAGE.test(request);
      case "whisplay":
        return whisplay;
      case "getSystemHealth":
        return health;
      default:
        return !RULES.has(name);
    }
  });
  const gated = tools
    .filter((tool) => {
      if (tool.function.name === "getSystemHealth") return false;
      if (externalTv && ["setVolume", "increaseVolume", "decreaseVolume"].includes(tool.function.name)) return false;
      const relevant = RULES.get(tool.function.name);
      return relevant && (relevant(request) || (!casual && isFollowUp(request) && relevant(previousRequest)));
    })
    .sort((a, b) => GATED_ORDER.get(a.function.name)! - GATED_ORDER.get(b.function.name)!);
  return [...always, ...gated];
};
