/**
 * Chooses which tools a small local model is offered for a request. Tools that
 * read private data (memory) or change the device (volume) are offered only
 * when the request may concern them; all other tools are always offered.
 *
 * Without this, qwen3 1.7B (thinking off) calls some tool for ordinary
 * questions that end in an instruction: "What is 2 plus 2? Answer in one
 * sentence." searched memory repeatedly, and with the memory tools removed it
 * called setVolume instead.
 */
import { mayConcernUserMemory } from "./memory-commands";

const MENTIONS_VOLUME =
  /\b(volume|louder|quieter|softer|loud|quiet|mute|unmute|sound|hear|speaker|turn (it|this|that|the sound|the music)? ?(up|down))\b/i;

export const mentionsVolume = (text: string): boolean => MENTIONS_VOLUME.test(text || "");

const RELEVANT_WHEN: Record<string, (text: string) => boolean> = {
  searchLocalMemory: mayConcernUserMemory,
  storeLocalMemory: mayConcernUserMemory,
  setVolume: mentionsVolume,
  increaseVolume: mentionsVolume,
  decreaseVolume: mentionsVolume,
};

// A short or elliptical follow-up ("What about her birthday?", "A bit more.")
// continues the previous request; a self-contained question does not.
const FOLLOW_UP =
  /^\s*(and|also|plus|but|so|then|too|what about|how about|anything else|what else|more|she|he|they|her|his|their|it|that|this|those|them)\b/i;

export const isFollowUp = (text: string): boolean => {
  const words = `${text || ""}`.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && (words.length <= 3 || FOLLOW_UP.test(text));
};

/**
 * The tools to offer for the user's request; tools without a rule are always
 * kept. A follow-up also keeps the tools its previous request qualified for.
 */
export const toolsRelevantTo = <T extends { function: { name: string } }>(
  request: string,
  tools: T[],
  previousRequest = "",
): T[] =>
  tools.filter((tool) => {
    const relevant = RELEVANT_WHEN[tool.function.name];
    if (!relevant) return true;
    return relevant(request) || (isFollowUp(request) && relevant(previousRequest));
  });
