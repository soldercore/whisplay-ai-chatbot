/**
 * Chooses which tools a small local model is offered for a request. Tools that
 * read private data (memory), change the device (volume) or create images are
 * offered only when the request may need them; all other tools, including web
 * search, are always offered except web_search for clear conversational turns.
 *
 * Without this, qwen3 1.7B (thinking off) calls some tool for ordinary
 * questions that end in an instruction: "What is 2 plus 2? Answer in one
 * sentence." searched memory repeatedly, with the memory tools removed it
 * called setVolume, and "Describe a sunset in one sentence." searched the web.
 * Every extra tool round costs a full model call, which is slow on a Pi.
 */
import { mayConcernUserMemory } from "./memory-commands";
import { isCasualConversation, needsCurrentInformation } from "./web-search-router";

const MENTIONS_VOLUME =
  /\b(volume|louder|quieter|softer|loud|quiet|mute|unmute|sound|hear|speaker|turn (it|this|that|the sound|the music)? ?(up|down))\b/i;

export const mentionsVolume = (text: string): boolean => MENTIONS_VOLUME.test(text || "");

const MENTIONS_IMAGE =
  /\b(draw|drawing|paint|painting|sketch|doodle|picture|pictures|image|images|photo|photos|illustrat\w*|artwork|wallpaper|logo|poster|portrait|cartoon)\b/i;

export const mentionsImage = (text: string): boolean => MENTIONS_IMAGE.test(text || "");

// Offering a tool is broader than requiring it. Only explicit requests for
// current local measurements are routed before the model; concepts stay chat.
export const needsSystemHealth = (text: string): boolean => {
  if (/\b(explain|define|definition|joke|story|pretend|imagine)\b|\bhow (do|does|can|should|would)\b/i.test(text)) return false;
  const subject = /\b(system|device|cpu|processor|ram|memory|swap|disk|storage|temperature|uptime|services?)\b/i.test(text);
  const measurement = /\b(health|status|doing|running|usage|using|utili[sz]ation|load|temperature|swap|space|uptime)\b/i.test(text);
  const local = /\b(your|you|this system|this device|the system|the cpu|the disk|left|remaining|available|free|currently|current|right now|system health|system status|uptime|service status)\b/i.test(text)
    || /\b(check|report|show|measure|read)\b/i.test(text);
  return subject && measurement && local && /\b(how|what|check|report|show|measure|read|get|tell|is|are)\b/i.test(text);
};

// The user asks for a short answer from what the model knows: an answer-format
// instruction or plain arithmetic. Time-sensitive questions still get web search.
// The web tools stay offered for these (removing them changes the tool list,
// which makes Ollama re-read the whole conversation, about a minute on a Pi);
// ollama-llm.ts does not run a web call made for such a request.
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
  ["getSystemHealth", (text: string) => needsSystemHealth(text) || /\b(system (health|status|load)|your (system|status|health)|cpu|memory usage|swap|disk (usage|space)|temperature|uptime|service status)\b/i.test(text)],
];
const RULES = new Map(RELEVANT_WHEN);
const GATED_ORDER = new Map(RELEVANT_WHEN.map(([name], index) => [name, index]));

// A short or elliptical follow-up ("What about her birthday?", "A bit more.")
// continues the previous request; a self-contained question does not.
const FOLLOW_UP =
  /^\s*(and|also|plus|but|so|then|too|what about|how about|anything else|what else|more|she|he|they|her|his|their|it|that|this|those|them)\b/i;

export const isFollowUp = (text: string): boolean => {
  const words = `${text || ""}`.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && (words.length <= 3 || FOLLOW_UP.test(text));
};

/**
 * The tools to offer: ungated tools in original order (except web_search for
 * clear small talk), then gated tools that apply. A follow-up also keeps
 * the tools its previous request qualified for.
 */
export const toolsRelevantTo = <T extends { function: { name: string } }>(
  request: string,
  tools: T[],
  previousRequest = "",
): T[] => {
  // A greeting is a new conversational intent even after a previous search.
  // Keep ordering and all other tool eligibility unchanged. Native/JSON calls
  // still pass through the existing exact offered-list authorization boundary.
  const casual = isCasualConversation(request);
  const always = tools.filter((tool) => !RULES.has(tool.function.name)
    && !(casual && tool.function.name === "web_search"));
  const gated = tools
    .filter((tool) => {
      const relevant = RULES.get(tool.function.name);
      return relevant && (relevant(request) || (!casual && isFollowUp(request) && relevant(previousRequest)));
    })
    .sort((a, b) => GATED_ORDER.get(a.function.name)! - GATED_ORDER.get(b.function.name)!);
  return [...always, ...gated];
};
