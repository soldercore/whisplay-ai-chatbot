/**
 * Recognises explicit memory commands in what the user said, so the local
 * memory can save, update, forget and recall facts without an LLM round trip.
 * Small local models call the memory tools unreliably (several rounds, wrong
 * tool, JSON spoken as text); these commands are common and unambiguous.
 */

export type MemoryCommand =
  | { type: "remember"; statement: string }
  | { type: "update"; statement: string }
  | { type: "forget"; topic: string }
  | { type: "recall"; topic: string; explicit: boolean };

const LEADING_FILLER =
  /^(?:(?:hey|hi|ok|okay|so|well|please|oh|and|also|now|alright|actually|no|wait|correction|update)\b[\s,:-]*)+/i;

const clean = (text: string): string =>
  `${text || ""}`
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!?。！？]+$/u, "");

// Topics that are not about a stored fact ("forget it", "never mind").
const VAGUE_TOPIC = /^(it|that|this|them|everything|all|all of (it|that)|about (it|that))$/i;

export const parseMemoryCommand = (input: string): MemoryCommand | null => {
  const raw = clean(input);
  if (!raw) return null;

  // Recall: "do you remember my ...", "what is my ...". Checked first so that
  // "do you remember ..." is never read as "remember ...".
  let match = raw.match(
    /^(?:(?:do|can) you (?:still )?(?:remember|recall|know)|what do you (?:remember|know) about|remind me(?: of| what| about)?)\s+(my\s.+)$/i,
  );
  if (match) return { type: "recall", topic: match[1], explicit: true };
  match = raw
    .replace(LEADING_FILLER, "")
    .match(/^(?:what|who|where|when|which)(?:'s|'re| is| are| was| were)\s+(my\s.+?)(?:\s+again)?$/i);
  if (match) return { type: "recall", topic: match[1], explicit: false };

  const text = raw.replace(LEADING_FILLER, "");

  match = text.match(
    /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:remember|memorize|memorise|keep in mind|note|make a note)(?:\s+that)?[\s,:]+(.+)$/i,
  ) || text.match(/^(?:don't|do not) forget(?:\s+that)?[\s,:]+(.+)$/i);
  if (match && !/^(when|how|why|where|if)\b/i.test(match[1])) {
    return { type: "remember", statement: clean(match[1]) };
  }

  match = text.match(
    /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?forget\s+(?:about\s+|that\s+|the fact that\s+|what (?:i|you) (?:told you|said|know) about\s+)?(.+)$/i,
  ) || text.match(
    /^(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:delete|erase|remove|clear)\s+(my\s.+?)(?:\s+from (?:your )?memory)?$/i,
  );
  if (match && !VAGUE_TOPIC.test(clean(match[1]))) {
    return { type: "forget", topic: clean(match[1]) };
  }

  // A plain statement such as "Actually, my favorite color is green". Only
  // used to update a fact that is already saved; it never creates one.
  match = text.match(/^(my\s.+?\s(?:is|are)\s.+)$/i);
  if (match && !/\?$/.test(input.trim())) return { type: "update", statement: clean(match[1]) };

  return null;
};

const SPELLING: [RegExp, string][] = [
  [/\bfavourite\b/g, "favorite"],
  [/\bcolour\b/g, "color"],
];

/** Normalised subject of a "my <subject>" phrase, e.g. "favorite color". */
export const normalizeSubject = (text: string): string => {
  let subject = clean(text).toLowerCase().replace(/^my\s+/, "");
  for (const [pattern, replacement] of SPELLING) subject = subject.replace(pattern, replacement);
  return subject.replace(/[^\p{L}\p{N}' -]/gu, "").replace(/\s+/g, " ").trim();
};

/** "my favorite color is blue" -> { subject: "favorite color", value: "blue" } */
export const parseFact = (statement: string): { subject: string; value: string } | null => {
  const match = clean(statement).match(/^my\s+(.+?)\s+(?:is|are)\s+(.+)$/i);
  if (!match) return null;
  const subject = normalizeSubject(match[1]);
  const value = clean(match[2]);
  return subject && value ? { subject, value } : null;
};

const SECOND_PERSON: [RegExp, string][] = [
  [/\bi am\b/gi, "you are"],
  [/\bi'm\b/gi, "you're"],
  [/\bi was\b/gi, "you were"],
  [/\bi've\b/gi, "you've"],
  [/\bi'll\b/gi, "you'll"],
  [/\bi'd\b/gi, "you'd"],
  [/\bmyself\b/gi, "yourself"],
  [/\bmine\b/gi, "yours"],
  [/\bmy\b/gi, "your"],
  [/\bme\b/gi, "you"],
  [/\bi\b/gi, "you"],
];

/** Turns the user's own words into what the assistant says back to them. */
export const toSecondPerson = (text: string): string => {
  let result = clean(text);
  for (const [pattern, replacement] of SECOND_PERSON) result = result.replace(pattern, replacement);
  return result;
};

// Credentials and similar secrets are never stored, even when asked.
const SECRET =
  /\b(pass ?words?|passcodes?|pin(?: codes?| numbers?)?|security codes?|cvv|cvc|credit card|debit card|card numbers?|social security|ssn|passport numbers?|bank account|account numbers?|iban|routing numbers?|api keys?|secret keys?|private keys?|seed phrases?|recovery phrases?|access tokens?|one[- ]time codes?|otp)\b/i;
// Long digit runs (cards, accounts, IDs, phone numbers) are not auto-saved.
const LONG_NUMBER = /\d(?:[\s.-]?\d){8,}/;

export const containsSecret = (text: string): boolean => SECRET.test(text || "");

export const isSensitiveForAutoSave = (text: string): boolean =>
  containsSecret(text) || LONG_NUMBER.test(text || "");
