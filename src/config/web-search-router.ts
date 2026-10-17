/**
 * Deterministic routing for questions that clearly need current information.
 *
 * Small local models (e.g. qwen3 1.7B) often answer these from stale training
 * data instead of calling web_search. When a question carries an unambiguous
 * time-sensitivity signal, the LLM provider runs web_search first and gives the
 * model the results. Everything else is left to the model's own tool choice.
 * Signals are deliberately narrow: a missed question falls back to the model,
 * while a false positive costs an unnecessary search.
 */

const RECENCY =
  /\b(today|tonight|tomorrow|yesterday|right now|at the moment|currently|latest|newest|recent|recently|this (week|weekend|month|year|season)|last (night|week|weekend|month))\b/i;
// "current" except physics ("electric current", "direct current", ...).
const CURRENT = /\bcurrent\b/i;
const PHYSICS_CURRENT = /\b(electric|electrical|alternating|direct|ac|dc)\s+current\b|\bcurrent\s+(flow|through|in a circuit|density)\b/i;
const LIVE_DATA =
  /\b(weather|forecast|news|headlines?|exchange rate|price of|(bitcoin|btc|ethereum|crypto|stock|share|gold|silver|oil|gas|petrol|fuel|electricity) prices?)\b/i;
// The date is in the system prompt, so "what day is it today?" needs no search.
const DATE_ONLY =
  /^\s*(what(?:'s| is) (?:the )?(?:date|day)(?: is it)?(?: today)?|what day is (?:it|today)(?: today)?)\s*\??\s*$/i;
const RELEASE_OR_RESULT =
  /\b(release date|launch date|releasing|be released|launching|be launched|coming out|come out|comes out|who won|who is winning|who's winning|election results?)\b/i;
const OFFICE_HOLDER =
  /\bwho(?: is|'s| are)(?: the)? (president|prime minister|chancellor|ceo|king|queen|pope|leader|mayor|governor)\b/i;
const YEAR = /\b(20\d\d)\b/g;

const CASUAL_QUESTION = new RegExp(
  "^(?:how are you(?: doing| feeling)?|how have you been|how(?:'s| is) it going|" +
  "how(?:'s| is| has) your day(?: going| been)?|what(?:'s| is) up(?: with you)?|" +
  "what are you up to|what(?:'s| is) new with you|tell me (?:a|another) joke|" +
  "let(?:'s| us) chat(?: for a bit)?|(?:thanks|thank you)(?: for your help)?)" +
  "(?: (?:today|tonight|right now|now|at the moment|this morning|this afternoon|this evening|so far(?: today)?))?$", "i",
);

// Match a whole, clearly conversational utterance, not a keyword somewhere in
// a request. Mixed requests, quoted search queries and unclear subjects remain
// eligible for search. This rule also bounds model-selected search permission.
export const isCasualConversation = (question: string): boolean => {
  let text = `${question || ""}`.replace(/’/g, "'").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
  const greeting = /^(?:hi|hey|hello|good morning|good afternoon|good evening|good night|bye|goodbye)(?:[, ]+glados)?$/i;
  if (greeting.test(text)) return true;
  text = text.replace(/^(?:hi|hey|hello|good morning|good afternoon|good evening)[,!. ]+/i, "")
    .replace(/^glados[,!. ]+/i, "").replace(/[, ]+glados$/i, "").trim();
  return greeting.test(text) || CASUAL_QUESTION.test(text);
};

export const needsCurrentInformation = (
  question: string,
  now: Date = new Date(),
): boolean => {
  const text = `${question || ""}`.trim();
  if (!text || DATE_ONLY.test(text) || isCasualConversation(text)) return false;
  if (RECENCY.test(text)) return true;
  if (CURRENT.test(text) && !PHYSICS_CURRENT.test(text)) return true;
  if (LIVE_DATA.test(text) || RELEASE_OR_RESULT.test(text) || OFFICE_HOLDER.test(text)) {
    return true;
  }
  const recentYear = now.getFullYear() - 1;
  for (const match of text.matchAll(YEAR)) {
    if (parseInt(match[1], 10) >= recentYear) return true;
  }
  return false;
};

/** web_search search_type for a routed question. */
export const searchTypeFor = (question: string): "news" | "web" =>
  /\b(news|headlines?)\b/i.test(question) ? "news" : "web";
