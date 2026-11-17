/**
 * Deterministic routing for questions that clearly need current information.
 *
 * Small local models can answer these from stale training
 * data instead of calling web_search. When a question carries an unambiguous
 * time-sensitivity signal, the LLM provider runs web_search first and gives the
 * model the results. Everything else is left to the model's own tool choice.
 * Signals are deliberately narrow: a missed question falls back to the model,
 * while a false positive costs an unnecessary search.
 */

// A user's past activity ("I recently got a cat") is not a request for live facts.
// Recency only forces search when the user asks about the outside world.
const RECENCY =
  /\b(right now|at the moment|currently|latest|newest|recent|recently|this (week|weekend|month|year|season)|last (night|week|weekend|month))\b/i;
const WORLD_UPDATE =
  /\b(?:what(?:'s| is)? new|what (?:happened|changed)|what(?:'s| is) happening|what is going on|how (?:has|have|is|are|did)|who (?:won|is winning)|any (?:updates?|news)|(?:recent|latest|newest) (?:news|updates?|changes?|discoveries|findings|research|developments)|(?:released|launched|announced) recently|is (?:that|this) true|fact.check|verify)\b/i;
const FACT_REQUEST = /^(?:what|who|whom|when|where|how|which|is|are|was|were|did|does|do|will|can|could|has|have|any|tell me|find|check|show me|give me|search|explain|summarize)\b/i;
// Deictic day words are weak on their own ("what should I cook tonight?", "if tomorrow is Wednesday...").
// They count only beside a cue that the question asks about something happening in the world, never inside a hypothetical.
const DAY_WORD = /\b(today|tonight|tomorrow|yesterday)\b/i;
const EVENT_CUE =
  /\b(rain|raining|snow|snowing|storm|temperature|hot|cold|warm|windy|sunny|cloudy|sunrise|sunset|stocks?|stock market|markets?|scores?|won|win|lose|lost|beat|trending|match|game|playing|showing|happen(?:ed|s|ing)?|going on|traffic|flights?|trains?|buses|late|delayed|cancell?ed|worth|opens?|closes?|what(?:'s| is) new|how (?:is|are|has|have) (?!you\b)\S+ (?:doing|performing|been))\b/i;
const HYPOTHETICAL = /\b(if|suppose|assuming|imagine|let's say)\b/i;
// A statement ("I'm running late today") is conversation; only a question asks about the world.
const QUESTION = /\?\s*$|^\s*(?:what|who|whom|when|where|how|which|is|are|was|were|did|does|do|will|can|could|has|have|any)\b/i;
// "Current" can mean electric current, a private situation, or a live fact.
// Search only for clearly public, changeable information.
const PHYSICS_CURRENT =
  /\b(?:electric(?:al)?|alternating|direct|ac|dc)\s+current\b|\bcurrent\s+(?:flow(?:s|ing)?|through|in\s+(?:a|the)\s+circuit|density|draw)\b|\b(?:flow|flows|flowing)\s+of\s+(?:electric(?:al)?\s+)?current\b/i;
const CURRENT_LIVE =
  /\bcurrent(?:ly)?\b.{0,80}\b(?:president|prime minister|chancellor|ceo|king|queen|pope|mayor|governor|leader|government|politic(?:s|al)|polic(?:y|ies)|laws?|regulations?|weather|forecast|temperature|prices?|rates?|exchange|value|version|release|status|situation|score|standings|results?|stocks?|markets?|traffic|flight|train|bus|trending|events?|time|date)\b|\b(?:president|prime minister|ceo|weather|forecast|prices?|rates?|version|release|status|situation|score|results?|stock|market|traffic|leader|policy|policies|government)\b.{0,80}\bcurrent(?:ly)?\b/i;
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
// A year in a personal anecdote is not a reason to search.
const YEAR_EVENT =
  /\b(?:news|elections?|results?|scores?|winn?(?:er|ers|ing)?|releases?|released|launch(?:ed|ing|es)?|announc(?:ed|ements?)|events?|changes?|changed|happened|trends?|statistics?|earnings|prices?|movies?|films?|games?|products?|who won|came out|coming out)\b/i;
// Explicit opt-outs take precedence over automatic routing.
const WEB_OPT_OUT =
  /\b(?:do not|don't|dont|never|without|no need to)\s+(?:search(?:ing)?(?:\s+(?:the\s+)?(?:web|internet|online))?|brows(?:e|ing)(?:\s+the\s+web)?|googl(?:e|ing)|look(?:ing)?\s+(?:it\s+|this\s+|that\s+)?up(?:\s+online)?)\b/i;

// Direct requests outrank answer-format hints. Match request clauses, not a
// mention of searching (or "do not search") inside ordinary conversation.
export const hasExplicitWebSearch = (text: string): boolean =>
  /(?:^|[.!?;]\s*|\band\s+)(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:search (?:the (?:web|internet)|online)|look (?:it |this |that )?up online|look up .+? (?:online|on the web)|google\s+\S)/i.test(text.trim());

const PERSONAL_CONVERSATION = /^(?:i feel|i'm feeling|i am feeling)\s+[\p{L}' -]+[.!?]*$/iu;
const CREATIVE_REQUEST = /^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:tell me|write(?: me)?|make up|invent)\s+(?:(?:a|an|another|short|bedtime|funny)\s+)*(?:story|poem|joke)\b[^.!?;]*[.!?]*$/i;
const ADDITIONAL_REQUEST = /\b(?:and|but|also)\s+(?:what|who|when|where|how|why|can|could|would|tell|find|check|look|search|show|give)\b/i;

// Narrow exclusions for non-live questions that contain misleading trigger words.
// Explicit web-search requests still take precedence over these exclusions.
const PERSONAL_NON_LIVE = /^(?:what are you(?: currently)? doing|what(?:'s| is) your (?:current )?mood|i recently (?:got|adopted) (?:a|an) [^?.!]{1,80}[.!]\s*what should i name (?:it|him|her|them))\s*[?.!]*$/i;
// Voice ASR may separate personal context from advice with a comma, a period,
// or no punctuation at all. Do not add one brittle regex per sentence.
const JOKE_REQUEST = /^(?:(?:(?:can|could|would) you|please)\s+)?(?:tell me|make up|write(?: me)?)\s+(?:a\s+|another\s+)?(?:funny\s+|recent\s+|new\s+|latest\s+|fresh\s+)*joke\b/i;
const MARKET_EVENT = /\b(?:bitcoin|btc|crypto|ethereum|stocks?|shares?)\b.{0,40}\b(?:up|down|trading|worth)\b|\b(?:up|down|trading|worth)\b.{0,40}\b(?:bitcoin|btc|crypto|ethereum|stocks?|shares?)\b/i;
const PERSONAL_ADVICE =
  /^(?:(?:i|we|my|our)\b.{0,200}?\b(?:what (?:should|can) (?:i|we)|how (?:should|can|do) (?:i|we)|can you (?:help|suggest|recommend)|what (?:would|do) you (?:suggest|recommend)|any (?:ideas|tips))\b|(?:what|which|where|when)\b.{0,90}?\bshould (?:i|we)\b|how (?:can|should|do) (?:i|we)\b|(?:should|could) (?:i|we)\b|can you (?:help me|suggest|recommend)\b)/i;
// Strong external facts must remain searchable even inside a personal question.
const LIVE_SUBJECT =
  /\b(?:weather|forecast|news|headlines?|traffic|flights?|trains?|buses|exchange rates?|price of|prices?|scores?|election(?:s| results?)?|release dates?|launch dates?|current (?:president|ceo|prime minister|king|weather|price|exchange rate)|recent (?:research|discoveries|findings|developments|updates?)|latest (?:news|updates?|research|findings))\b/i;
const EDUCATIONAL =
  /^(?:explain (?:how|why) .{0,150}\b(?:works?|forms?|functions?|flows?|happens?|occurs?|is formed|is created)|(?:how|why) (?:does|do|did) .+\b(?:work|form|function|flow|happen|occur)|define |teach me (?:how|what)|what (?:is|are) (?:an? |the )?(?:weather|electric current|electrical current|alternating current|direct current|exchange rate|stock market|current density)\s*[?.!]?$)/i;
const PRIVATE_CURRENT =
  /\b(?:my|our|your)\b.{0,60}\b(?:current|currently|status|version|progress)\b|\bcurrent\s+(?:status|version|progress|state)\s+(?:of|on)\s+(?:my|our|your)\b/i;
const SELF_STATUS =
  /\b(?:my|our|your)\s+(?:(?:\w+\s+){0,2})?current\s+(?:mood|setup|project|situation|workload|feelings?|plans?|progress)\b|\b(?:what (?:are|were) you (?:currently )?doing|what are you doing right now|how are you feeling right now|what have you been doing recently|what(?:'s| is) new with you(?: this week| recently| right now)?)\b/i;
const IDIOM_NON_LIVE = /^(?:what(?:'s| is) the price of (?:happiness|love|peace|freedom)|who(?:'s| is) the king of rock (?:and|&) roll)\s*[?.!]*$/i;

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
const isPersonalAdvice = (text: string): boolean =>
  PERSONAL_ADVICE.test(text) && !LIVE_SUBJECT.test(text);

export const isCasualConversation = (question: string): boolean => {
  let text = `${question || ""}`.replace(/’/g, "'").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "").trim();
  if (hasExplicitWebSearch(text)) return false;
  if (PERSONAL_NON_LIVE.test(text) || IDIOM_NON_LIVE.test(text)
    || (JOKE_REQUEST.test(text) && !LIVE_SUBJECT.test(text) && !ADDITIONAL_REQUEST.test(text))
    || isPersonalAdvice(text)) return true;
  // Only whole personal/creative requests qualify. Mixed/live-data requests
  // retain search; recency alone does not turn a feeling or story into research.
  if (!LIVE_DATA.test(text) && !RELEASE_OR_RESULT.test(text) && !OFFICE_HOLDER.test(text)
    && !ADDITIONAL_REQUEST.test(text)
    && !/\b(latest|newest|news|research|studies|current|forecast)\b/i.test(text)
    && (PERSONAL_CONVERSATION.test(text) || CREATIVE_REQUEST.test(text))) return true;
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
  const text = `${question || ""}`.replace(/’/g, "'").replace(/\s+/g, " ").trim();
  if (!text || WEB_OPT_OUT.test(text)) return false;
  if (hasExplicitWebSearch(text)) return true;
  if (DATE_ONLY.test(text) || isCasualConversation(text)) return false;
  if (SELF_STATUS.test(text) && !LIVE_SUBJECT.test(text) && !ADDITIONAL_REQUEST.test(text)) return false;
  if (PRIVATE_CURRENT.test(text) && !LIVE_SUBJECT.test(text)) return false;

  const asks = FACT_REQUEST.test(text) || QUESTION.test(text);
  const personal = isPersonalAdvice(text);
  const educational = EDUCATIONAL.test(text);

  // A static explanation is not automatically a request for today's facts.
  // Explicit live subjects like "weather tomorrow" still win below.
  if (DAY_WORD.test(text) && (EVENT_CUE.test(text) || MARKET_EVENT.test(text))
    && asks && !HYPOTHETICAL.test(text)
    && !personal && !educational) return true;
  // A statement followed by a question ("I feel tired today and what happened in Oslo"): the question clause is judged with the
  // day word of the whole utterance. Past-dated history questions and hypotheticals stay with the model.
  const mixed = ADDITIONAL_REQUEST.exec(text);
  if (mixed && DAY_WORD.test(text) && !HYPOTHETICAL.test(text) && !personal && !educational) {
    const clause = text.slice(mixed.index);
    if ((WORLD_UPDATE.test(clause) || EVENT_CUE.test(clause) || MARKET_EVENT.test(clause)) && !/\b1\d{3}\b|\b(?:you|we|i)\s+(?:told|said|mentioned|talked|discussed)\b|\bearlier\b|\blast time\b/i.test(clause)) return true;
  }
  if (LIVE_DATA.test(text) && !educational) return true;
  if (RELEASE_OR_RESULT.test(text) || OFFICE_HOLDER.test(text)) return true;

  // Recent personal experiences and advice should not cause network calls.
  // For ambiguous "recently/currently", require an external fact request.
  if (RECENCY.test(text) && !personal && !educational) {
    const personalSubject = /\b(?:my|our|your)\b/i.test(text);
    if (/\b(?:latest|newest)\b/i.test(text) && asks
      && (!personalSubject || LIVE_SUBJECT.test(text))) return true;
    if (WORLD_UPDATE.test(text) && (!personalSubject || LIVE_SUBJECT.test(text))) return true;
    if (asks && !/^(?:i|we|my|our)\b/i.test(text) && !personalSubject) return true;
  }
  if (!PHYSICS_CURRENT.test(text) && CURRENT_LIVE.test(text) && asks && !personal && !educational) return true;

  // A bare mention of the current year is not live-data intent.
  if (!personal && !educational && asks && YEAR_EVENT.test(text)) {
    for (const match of text.matchAll(YEAR)) {
      if (parseInt(match[1], 10) >= now.getFullYear() - 1) return true;
    }
  }
  return false;
};

/** web_search search_type for a routed question. */
export const searchTypeFor = (question: string): "news" | "web" =>
  /\b(news|headlines?)\b/i.test(question) ? "news" : "web";
