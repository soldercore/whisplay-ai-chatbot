/**
 * Chooses which tools a small local model is offered for a request. Tools that
 * read private data (memory), change the device (volume), create images, or
 * search the web are offered only when the request may need them; all other
 * tools are always offered.
 *
 * Without this, qwen3 1.7B (thinking off) calls some tool for ordinary
 * questions that end in an instruction: "What is 2 plus 2? Answer in one
 * sentence." searched memory repeatedly, with the memory tools removed it
 * called setVolume, and "Describe a sunset in one sentence." searched the web.
 * Every extra tool round costs a full model call, which is slow on a Pi.
 */
import { mayConcernUserMemory } from "./memory-commands";
import { needsCurrentInformation } from "./web-search-router";

const MENTIONS_VOLUME =
  /\b(volume|louder|quieter|softer|loud|quiet|mute|unmute|sound|hear|speaker|turn (it|this|that|the sound|the music)? ?(up|down))\b/i;

export const mentionsVolume = (text: string): boolean => MENTIONS_VOLUME.test(text || "");

const MENTIONS_IMAGE =
  /\b(draw|drawing|paint|painting|sketch|doodle|picture|pictures|image|images|photo|photos|illustrat\w*|artwork|wallpaper|logo|poster|portrait|cartoon)\b/i;

export const mentionsImage = (text: string): boolean => MENTIONS_IMAGE.test(text || "");

// The user asks for a short answer from what the model knows: an answer-format
// instruction or plain arithmetic. Time-sensitive questions still get web search.
const ANSWER_FORMAT =
  /\b(in (one|a single|1|two|2|three|3|a few) (sentences?|words?|lines?)|one[- ]sentence|briefly|keep it (short|brief)|short answer|in short|in simple (terms|words)|explain simply)\b/i;
const ARITHMETIC = /\d\s*(plus|minus|times|multiplied by|divided by|over|[+\-*×÷/x])\s*\d/i;

export const isDirectAnswerRequest = (text: string): boolean =>
  (ANSWER_FORMAT.test(text || "") || ARITHMETIC.test(text || "")) && !needsCurrentInformation(text || "");

const mayNeedWeb = (text: string): boolean => !isDirectAnswerRequest(text);

// Gated tools in a fixed order after the always-offered ones. Ollama renders
// the tools before the conversation, so a change in the offered set makes it
// re-read everything after the first changed tool; the most often offered
// (web) tools come first to keep that part short.
const RELEVANT_WHEN: [string, (text: string) => boolean][] = [
  ["web_search", mayNeedWeb],
  ["fetch_webpage", mayNeedWeb],
  ["searchLocalMemory", mayConcernUserMemory],
  ["storeLocalMemory", mayConcernUserMemory],
  ["setVolume", mentionsVolume],
  ["increaseVolume", mentionsVolume],
  ["decreaseVolume", mentionsVolume],
  ["generateImage", mentionsImage],
  ["showPreviouslyGeneratedImage", mentionsImage],
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
 * The tools to offer for the user's request: tools without a rule always, in
 * their original order, then the gated tools that apply. A follow-up also keeps
 * the tools its previous request qualified for.
 */
export const toolsRelevantTo = <T extends { function: { name: string } }>(
  request: string,
  tools: T[],
  previousRequest = "",
): T[] => {
  const always = tools.filter((tool) => !RULES.has(tool.function.name));
  const gated = tools
    .filter((tool) => {
      const relevant = RULES.get(tool.function.name);
      return relevant && (relevant(request) || (isFollowUp(request) && relevant(previousRequest)));
    })
    .sort((a, b) => GATED_ORDER.get(a.function.name)! - GATED_ORDER.get(b.function.name)!);
  return [...always, ...gated];
};
