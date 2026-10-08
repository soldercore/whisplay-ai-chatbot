import fs from "fs";
import path from "path";
import moment from "moment";
import { LLMTool, ToolReturnTag } from "../type";
import { dataDir } from "../utils/dir";
import {
  containsSecret,
  isSensitiveForAutoSave,
  normalizeSubject,
  parseFact,
  parseMemoryCommand,
  toSecondPerson,
} from "./memory-commands";
import { memoryReply } from "./persona";

type MemoryExchange = {
  at: string;
  user: string;
  assistant: string;
};

type MemorySession = {
  id: string;
  title: string;
  summary: string;
  summaryUpdatedAt?: string;
  startedAt: string;
  updatedAt: string;
  exchanges: MemoryExchange[];
  keywords: string[];
};

type UserMemory = {
  id: string;
  kind: "preference" | "context" | "fact";
  content: string;
  // Set for "my <subject> is <value>" facts so an update replaces the old value.
  subject?: string;
  value?: string;
  createdAt: string;
  updatedAt: string;
  keywords: string[];
};

type MemoryStore = {
  version: 1;
  sessions: MemorySession[];
  userMemories: UserMemory[];
  // Set once "Remember ..." commands from saved conversations were imported.
  rememberedFactsImported?: boolean;
};

const memoryEnabled = (process.env.MEMORY_ENABLED || "").toLowerCase() === "true";
const memoryAutoSave = process.env.MEMORY_AUTO_SAVE !== "false" && memoryEnabled;
const memoryDir = path.resolve(
  process.env.MEMORY_DIR || path.join(dataDir, "memory"),
);
const memoryStorePath = path.join(memoryDir, "memory.json");
const memoryMaxSessions = parseInt(process.env.MEMORY_MAX_SESSIONS || "200", 10);
const memoryMaxSessionExchanges = parseInt(
  process.env.MEMORY_MAX_SESSION_EXCHANGES || "20",
  10,
);
const memoryMaxSearchResults = parseInt(
  process.env.MEMORY_MAX_SEARCH_RESULTS || "4",
  10,
);
const memoryWakeupMaxItems = parseInt(process.env.MEMORY_WAKEUP_MAX_ITEMS || "5", 10);
const memoryProfileText = (process.env.MEMORY_PROFILE_TEXT || "").trim();
const memorySummaryPromptPrefix =
  process.env.MEMORY_SUMMARY_PROMPT_PREFIX ||
  "Summarize the following user-assistant conversation into a concise memory for future recall. Preserve user preferences, facts, decisions, open tasks, and important context. Do not quote the transcript verbatim. Write in English. Keep it under 80 words:";
const memorySessionIdleMs =
  parseInt(
    process.env.MEMORY_SESSION_IDLE_SECONDS ||
      process.env.CHAT_HISTORY_RESET_TIME ||
      "300",
    10,
  ) * 1000;

const UNTITLED = "Untitled conversation";
const HAN = /\p{Script=Han}/u;

let activeSessionId = "";
let lastExchangeAt = 0;
let writeQueue: Promise<void> = Promise.resolve();
let recalledMemoryKeys = new Set<string>();
let recalledMemoryTexts = new Map<string, string>();
// User turns answered by handleMemoryCommand; they are not auto-saved.
const handledCommandTexts = new Set<string>();

const nowIso = (): string => new Date().toISOString();

const ensureMemoryDir = (): void => {
  if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
};

const emptyStore = (): MemoryStore => ({
  version: 1,
  sessions: [],
  userMemories: [],
});

const makeId = (prefix: string): string =>
  `${prefix}_${moment().format("YYYYMMDD_HHmmss")}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const textPreview = (text: string, max = 220): string => {
  const compactText = text.replace(/\s+/g, " ").trim();
  return compactText.length > max
    ? `${compactText.slice(0, Math.max(0, max - 1))}...`
    : compactText;
};

const sentence = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalized = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
};

const uniqueStrings = (items: string[]): string[] =>
  Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));

const searchTokens = (text: string): string[] => {
  const lower = text.toLowerCase();
  const words = lower.match(/[\p{L}\p{N}_-]+/gu) || [];
  const chineseChunks = lower.match(/[\p{Script=Han}]{2,}/gu) || [];
  const grams = chineseChunks.flatMap((chunk) => {
    const result: string[] = [];
    for (let i = 0; i < chunk.length - 1; i += 1) {
      result.push(chunk.slice(i, i + 2));
    }
    return result;
  });
  return uniqueStrings([...words, ...grams]).filter((item) => item.length > 1);
};

const persistedKeywords = (text: string): string[] => {
  const lower = text.toLowerCase();
  const shortPhrases = lower
    .split(/[。！？!?，,；;\n\r]+/)
    .map((item) => textPreview(item, 24))
    .filter((item) => item.length >= 4 && /[\p{L}\p{N}]/u.test(item));
  const asciiWords = lower.match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  const numericTerms = lower.match(/[a-z]*\d+(?:\.\d+)?%?/g) || [];
  const chinesePhrases = (lower.match(/[\p{Script=Han}]{4,}/gu) || [])
    .map((item) => textPreview(item, 24))
    .filter((item) => item.length >= 4);
  return uniqueStrings([...shortPhrases, ...asciiWords, ...numericTerms, ...chinesePhrases])
    .filter((item) => item.length >= 3)
    .slice(0, 24);
};

const titleFromText = (text: string): string => {
  const clean = textPreview(text, 36).replace(/[。！？!?，,：:；;.]+$/g, "");
  return clean || UNTITLED;
};

const titleFromSummary = (summary: string, fallback: string): string => {
  const normalized = summary
    .replace(/\s+/g, " ")
    .replace(/^(用户)?(查询|询问|提问|想知道|讨论|聊到|关注|偏好)[：:，,\s]*/i, "")
    .replace(/^上次(聊|讨论|提到)[：:，,\s]*/i, "")
    .replace(/^(the )?user (asked about|asked|discussed|wanted to know|mentioned)[:,\s]*/i, "")
    .trim();
  const firstSentence = normalized
    .split(/[。！？!?；;\n\r]|\.(?:\s|$)/)[0]
    .trim();
  const colonTopic = firstSentence.split(/[：:]/)[0]?.trim();
  const firstClause = (colonTopic && colonTopic.length >= 4 ? colonTopic : firstSentence)
    .split(/[，,]/)
    .map((item) => item.trim())
    .find((item) => item.length >= 4) || firstSentence || normalized;
  const title = titleFromText(firstClause);
  return title === UNTITLED ? fallback : title;
};

const buildHeuristicSessionSummary = (session: MemorySession): string => {
  const userTexts = session.exchanges
    .slice(-5)
    .map((exchange) => textPreview(exchange.user, 90));
  const assistantTexts = session.exchanges
    .slice(-3)
    .map((exchange) => textPreview(exchange.assistant, 90));
  return textPreview(
    [
      userTexts.length > 0 ? `The user said: ${userTexts.join("; ")}` : "",
      assistantTexts.length > 0 ? `The assistant replied: ${assistantTexts.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join(". "),
    420,
  );
};

// Older stores may hold Chinese summaries and titles; never feed those to the
// model (it then answers in Chinese). The stored text itself is left as is.
const englishSummary = (session: MemorySession): string =>
  session.summary && !HAN.test(session.summary)
    ? session.summary
    : buildHeuristicSessionSummary(session);

const englishTitle = (session: MemorySession): string =>
  !HAN.test(session.title || "")
    ? session.title
    : titleFromText(session.exchanges[0]?.user || "");

const sanitizeStore = (parsed: any): MemoryStore => {
  const sessions: MemorySession[] = (Array.isArray(parsed?.sessions) ? parsed.sessions : [])
    .filter((session: any) => session && typeof session === "object" && session.id)
    .map((session: any) => ({
      ...session,
      title: `${session.title || UNTITLED}`,
      summary: `${session.summary || ""}`,
      startedAt: `${session.startedAt || session.updatedAt || nowIso()}`,
      updatedAt: `${session.updatedAt || session.startedAt || nowIso()}`,
      exchanges: (Array.isArray(session.exchanges) ? session.exchanges : []).filter(
        (exchange: any) => exchange && typeof exchange.user === "string",
      ),
      keywords: Array.isArray(session.keywords) ? session.keywords : [],
    }));
  const userMemories: UserMemory[] = (
    Array.isArray(parsed?.userMemories) ? parsed.userMemories : []
  )
    .filter((memory: any) => memory && typeof memory.content === "string" && memory.content.trim())
    .map((memory: any) => ({
      ...memory,
      id: `${memory.id || makeId("memory")}`,
      kind: memory.kind || "fact",
      createdAt: `${memory.createdAt || nowIso()}`,
      updatedAt: `${memory.updatedAt || memory.createdAt || nowIso()}`,
      keywords: Array.isArray(memory.keywords) ? memory.keywords : [],
    }));
  return {
    version: 1,
    sessions,
    userMemories,
    ...(parsed?.rememberedFactsImported ? { rememberedFactsImported: true } : {}),
  };
};

const normalizeStoreKeywords = (store: MemoryStore): MemoryStore => {
  store.sessions.forEach((session) => {
    if (session.summary) {
      session.title = titleFromSummary(session.summary, session.title);
    }
    session.keywords = persistedKeywords(
      [session.title, session.summary, ...session.exchanges.map((exchange) => exchange.user)]
        .filter(Boolean)
        .join("\n"),
    );
  });
  store.userMemories.forEach((memory) => {
    memory.keywords = persistedKeywords(memory.content);
  });
  return store;
};

const readStore = (): MemoryStore => {
  if (!memoryEnabled) return emptyStore();
  ensureMemoryDir();
  if (!fs.existsSync(memoryStorePath)) return emptyStore();
  let raw = "";
  try {
    raw = fs.readFileSync(memoryStorePath, "utf8");
    return normalizeStoreKeywords(sanitizeStore(JSON.parse(raw)));
  } catch (error: any) {
    // Keep the unreadable file instead of overwriting it on the next save.
    const backup = `${memoryStorePath}.corrupt-${moment().format("YYYYMMDD-HHmmss")}`;
    try {
      fs.renameSync(memoryStorePath, backup);
      console.error(`[Memory] Could not read ${memoryStorePath} (${error.message}); kept it as ${backup}`);
    } catch (renameError: any) {
      console.error(`[Memory] Could not read ${memoryStorePath}: ${error.message}`);
    }
    return emptyStore();
  }
};

const writeStore = (store: MemoryStore): void => {
  ensureMemoryDir();
  const normalized = normalizeStoreKeywords(store);
  const trimmed: MemoryStore = {
    version: 1,
    sessions: normalized.sessions
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, memoryMaxSessions)),
    userMemories: normalized.userMemories,
    // Files written by this version never need the one-time import below.
    rememberedFactsImported: true,
  };
  // Write a temp file and rename it, so a power cut cannot leave half a file.
  const tempPath = `${memoryStorePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(trimmed, null, 2)}\n`);
  fs.renameSync(tempPath, memoryStorePath);
};

const enqueueWrite = (fn: () => void | Promise<void>): void => {
  writeQueue = writeQueue
    .then(() => fn())
    .catch((error) => console.error(`[Memory] Write failed: ${error.message}`));
};

const buildSessionSummary = async (
  session: MemorySession,
  summaryText?: (text: string, promptPrefix: string) => Promise<string>,
): Promise<string> => {
  const fallback = buildHeuristicSessionSummary(session);
  if (!summaryText) return fallback;

  const transcript = session.exchanges
    .slice(-6)
    .map((exchange) => `User: ${exchange.user}\nAssistant: ${exchange.assistant}`)
    .join("\n\n");
  if (!transcript.trim()) return fallback;

  try {
    const summary = await summaryText(transcript, memorySummaryPromptPrefix);
    const normalizedSummary = (summary || "").trim();
    const looksLikeTranscript =
      normalizedSummary === transcript.trim() ||
      (/\bUser:/.test(normalizedSummary) && /\bAssistant:/.test(normalizedSummary));
    const usable = normalizedSummary && !looksLikeTranscript && !HAN.test(normalizedSummary);
    return textPreview(usable ? normalizedSummary : fallback, 600);
  } catch (error: any) {
    console.error(`[Memory] Summary generation failed: ${error.message}`);
    return fallback;
  }
};

const getActiveSession = (store: MemoryStore, userText: string): MemorySession => {
  const shouldStartNew =
    !activeSessionId ||
    (lastExchangeAt > 0 && Date.now() - lastExchangeAt > memorySessionIdleMs);
  if (!shouldStartNew) {
    const found = store.sessions.find((session) => session.id === activeSessionId);
    if (found) return found;
  }

  recalledMemoryKeys = new Set<string>();
  recalledMemoryTexts = new Map<string, string>();
  const session: MemorySession = {
    id: makeId("session"),
    title: titleFromText(userText),
    summary: "",
    startedAt: nowIso(),
    updatedAt: nowIso(),
    exchanges: [],
    keywords: persistedKeywords(userText),
  };
  activeSessionId = session.id;
  store.sessions.unshift(session);
  console.log(`[Memory] Started session: ${session.title}`);
  return session;
};

const scoreText = (query: string, text: string, keywords: string[] = []): number => {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  let score = lowerText.includes(lowerQuery) && lowerQuery.length > 1 ? 4 : 0;
  for (const token of searchTokens(query)) {
    if (lowerText.includes(token)) score += 2;
    if (keywords.includes(token)) score += 2;
  }
  return score;
};

type SearchResult = {
  key: string;
  score: number;
  text: string;
};

// ---- Facts ------------------------------------------------------------------

const factSubject = (memory: UserMemory): string =>
  memory.subject || parseFact(memory.content)?.subject || "";

const factValue = (memory: UserMemory): string =>
  memory.value || parseFact(memory.content)?.value || "";

/** The fact as said to the user: "your favorite color is blue". */
const factForUser = (memory: UserMemory): string =>
  factSubject(memory) && factValue(memory)
    ? `your ${factSubject(memory)} is ${factValue(memory)}`
    : toSecondPerson(memory.content);

/**
 * The fact as given to the model. In a system message "you" is the assistant,
 * so facts about the user must be in the third person.
 */
const factForModel = (memory: UserMemory): string =>
  factSubject(memory) && factValue(memory)
    ? `The user's ${factSubject(memory)} is ${factValue(memory)}.`
    : `The user told you: "${memory.content.replace(/[.!?]$/, "")}".`;

const STOPWORDS = new Set([
  "my", "the", "a", "an", "is", "are", "was", "were", "of", "to", "and", "what", "about",
  "that", "your", "i", "me", "do", "you", "it",
]);

const topicWords = (topic: string): string[] =>
  normalizeSubject(topic)
    .split(" ")
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));

const containsWord = (haystack: string, word: string): boolean =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(haystack);

const findFacts = (store: MemoryStore, topic: string): UserMemory[] => {
  const subject = normalizeSubject(topic);
  const exact = store.userMemories.filter((memory) => factSubject(memory) === subject);
  if (exact.length > 0) return exact;
  const words = topicWords(topic);
  if (words.length === 0) return [];
  return store.userMemories.filter((memory) => {
    const haystack = normalizeSubject(`${factSubject(memory)} ${memory.content}`);
    const hits = words.filter((word) => containsWord(haystack, word)).length;
    return hits > 0 && hits >= Math.ceil(words.length / 2);
  });
};

const forgetRecall = (memory: UserMemory): void => {
  recalledMemoryKeys.delete(`user:${memory.id}`);
  recalledMemoryTexts.delete(`user:${memory.id}`);
};

type SaveResult =
  | { status: "saved" | "unchanged"; memory: UserMemory }
  | { status: "updated"; memory: UserMemory; previous: string };

const saveFact = (
  store: MemoryStore,
  statement: string,
  kind: UserMemory["kind"] = "fact",
): SaveResult => {
  const content = sentence(textPreview(statement, 300));
  const fact = parseFact(statement);
  const now = nowIso();
  if (fact) {
    const existing = store.userMemories.filter((memory) => factSubject(memory) === fact.subject);
    if (existing.length > 0) {
      const [keep, ...duplicates] = existing;
      store.userMemories = store.userMemories.filter((memory) => !duplicates.includes(memory));
      const previous = factValue(keep);
      Object.assign(keep, { content, subject: fact.subject, value: fact.value, updatedAt: now });
      forgetRecall(keep);
      return previous.toLowerCase() !== fact.value.toLowerCase()
        ? { status: "updated", memory: keep, previous }
        : { status: "unchanged", memory: keep };
    }
  } else {
    const same = store.userMemories.find(
      (memory) => memory.content.toLowerCase().replace(/[.!?]$/, "") === content.toLowerCase().replace(/[.!?]$/, ""),
    );
    if (same) {
      same.updatedAt = now;
      return { status: "unchanged", memory: same };
    }
  }
  const memory: UserMemory = {
    id: makeId("memory"),
    kind,
    content,
    ...(fact ? { subject: fact.subject, value: fact.value } : {}),
    createdAt: now,
    updatedAt: now,
    keywords: persistedKeywords(content),
  };
  store.userMemories.unshift(memory);
  return { status: "saved", memory };
};

/** Removes matching facts and scrubs them from saved conversations. */
const forgetTopic = (store: MemoryStore, topic: string): number => {
  const facts = findFacts(store, topic);
  store.userMemories = store.userMemories.filter((memory) => !facts.includes(memory));
  facts.forEach(forgetRecall);

  const words = topicWords(topic);
  const values = facts.map(factValue).filter(Boolean).map((value) => value.toLowerCase());
  const mentions = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (words.length > 0 && words.every((word) => containsWord(lower, word))) ||
      values.some((value) => words.some((word) => containsWord(lower, word)) && lower.includes(value));
  };
  store.sessions = store.sessions.filter((session) => {
    const before = session.exchanges.length;
    session.exchanges = session.exchanges.filter(
      (exchange) => !mentions(`${exchange.user}\n${exchange.assistant}`),
    );
    if (session.exchanges.length !== before || mentions(`${session.title}\n${session.summary}`)) {
      if (session.exchanges.length === 0) return false;
      session.summary = buildHeuristicSessionSummary(session);
      session.title = titleFromText(session.exchanges[0].user);
    }
    return true;
  });
  return facts.length;
};

// ---- Search & prompt --------------------------------------------------------

const buildSearchMatches = (query: string): SearchResult[] => {
  if (!memoryEnabled || !query.trim()) return [];
  const store = readStore();
  const memoryMatches = store.userMemories
    .map((memory) => ({
      key: `user:${memory.id}`,
      // Saved facts rank above conversation summaries.
      score: scoreText(query, memory.content, memory.keywords) + 10,
      text: `Saved fact: ${factForModel(memory)}`,
    }))
    .filter((item) => item.score > 10);
  const sessionMatches = store.sessions
    .filter((session) => session.id !== activeSessionId)
    .map((session) => {
      const body = [
        session.title,
        session.summary,
        ...session.exchanges.slice(-6).map((exchange) => `${exchange.user}\n${exchange.assistant}`),
      ].join("\n");
      return {
        key: `session:${session.id}`,
        score: scoreText(query, body, session.keywords),
        text: `Earlier conversation "${englishTitle(session)}" (${session.updatedAt.slice(0, 10)}): ${englishSummary(session)}`,
      };
    })
    .filter((item) => item.score > 0);

  return [...memoryMatches, ...sessionMatches].sort((a, b) => b.score - a.score) as SearchResult[];
};

const markRecalled = (items: SearchResult[]): void => {
  items.forEach((item) => {
    recalledMemoryKeys.add(item.key);
    recalledMemoryTexts.set(item.key, item.text);
  });
};

const searchStore = (query: string, mark = true): string[] => {
  const results = buildSearchMatches(query)
    .filter((item) => !recalledMemoryKeys.has(item.key))
    .slice(0, Math.max(1, memoryMaxSearchResults));

  if (mark) {
    markRecalled(results);
  }

  return results.map((item) => item.text);
};

const searchStoreForTool = (query: string): string => {
  const matches = buildSearchMatches(query);
  const fresh = matches
    .filter((item) => !recalledMemoryKeys.has(item.key))
    .slice(0, Math.max(1, memoryMaxSearchResults));
  if (fresh.length > 0) {
    markRecalled(fresh);
    return fresh.map((item) => item.text).join("\n");
  }

  const alreadyRecalled = matches
    .filter((item) => recalledMemoryKeys.has(item.key))
    .slice(0, Math.max(1, memoryMaxSearchResults))
    .map((item) => recalledMemoryTexts.get(item.key) || item.text);
  if (alreadyRecalled.length > 0) {
    return [
      "Memory already recalled.",
      ...alreadyRecalled.map((item) => `Recalled: ${item}`),
    ].join("\n");
  }

  return "No saved memories match. If the question was about the user, say you don't have that saved and do not guess; otherwise just answer it.";
};

const shouldSearchHistory = (userText: string): boolean =>
  /之前|上次|以前|刚才|历史|记得|回忆|聊过|说过|提到|last time|previous|before|remember|earlier|we talked|did i (tell|say|mention)/i.test(
    userText,
  );

const inferPreference = (userText: string): string => {
  const text = textPreview(userText, 240);
  if (/记住|以后|偏好|我喜欢|我不喜欢|我希望|不要|别再|下次/.test(text)) {
    return text;
  }
  return "";
};

// Starts a new memory session after the idle time without writing anything;
// a session is only stored once an exchange is auto-saved.
const rollSessionIfIdle = (): void => {
  if (activeSessionId && lastExchangeAt > 0 && Date.now() - lastExchangeAt > memorySessionIdleMs) {
    activeSessionId = "";
    recalledMemoryKeys = new Set<string>();
    recalledMemoryTexts = new Map<string, string>();
  }
};

export const prepareMemoryPrompt = (userText: string): string => {
  if (!memoryEnabled) return "";
  try {
    return buildMemoryPrompt(userText);
  } catch (error: any) {
    // A memory problem must not stop the assistant from answering.
    console.error(`[Memory] Could not prepare memory context: ${error.message}`);
    return "";
  }
};

const buildMemoryPrompt = (userText: string): string => {
  rollSessionIfIdle();
  const store = readStore();

  const wakeupItems = store.userMemories
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .filter((memory) => !recalledMemoryKeys.has(`user:${memory.id}`))
    .filter((memory) => !HAN.test(memory.content))
    .slice(0, Math.max(0, memoryWakeupMaxItems))
    .map((memory) => {
      const text = factForModel(memory);
      markRecalled([{ key: `user:${memory.id}`, score: 0, text: `Saved fact: ${text}` }]);
      return `- ${text}`;
    });
  const searchResults = shouldSearchHistory(userText) ? searchStore(userText) : [];
  const sections = [
    memoryProfileText ? `User profile:\n${memoryProfileText}` : "",
    wakeupItems.length > 0
      ? `Facts the user told you about themselves (when you mention them, talk to the user as "you"):\n${wakeupItems.join("\n")}`
      : "",
    searchResults.length > 0
      ? `Possibly relevant earlier conversations:\n${searchResults.map((item) => `- ${item}`).join("\n")}`
      : "",
  ].filter(Boolean);

  if (sections.length === 0) return "";
  return [
    "Local memory about this user. Use it only when relevant, answer in English, and never invent details that are not listed here.",
    ...sections,
  ].join("\n\n");
};

// ---- Memory commands --------------------------------------------------------

export type MemoryCommandReply = {
  text: string;
  // True when saved facts changed or were removed: the conversation context
  // may still contain the old value and should be cleared.
  contextChanged: boolean;
};

const commandKey = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Answers explicit memory commands ("remember that ...", "what is my ...",
 * "actually, my ... is ...", "forget my ...") directly from the local store.
 * Returns null when the text is not a memory command, or when the model should
 * answer (a recall with no saved match, an update of an unknown fact).
 */
export const handleMemoryCommand = (userText: string): MemoryCommandReply | null => {
  if (!memoryEnabled) return null;
  const command = parseMemoryCommand(userText);
  if (!command) return null;

  const reply = (text: string, contextChanged = false): MemoryCommandReply => {
    handledCommandTexts.add(commandKey(userText));
    // The memory prompt prepared for this turn never reaches the model (and the
    // caller clears the history when facts changed), so offer the saved facts
    // to the model again on its next turn.
    recalledMemoryKeys = new Set<string>();
    recalledMemoryTexts = new Map<string, string>();
    console.log(`[Memory] Handled "${command.type}" command without the LLM`);
    return { text, contextChanged };
  };

  try {
    if (command.type === "remember" || command.type === "update") {
      if (containsSecret(command.statement)) {
        return reply(memoryReply("secret"));
      }
      const store = readStore();
      if (command.type === "update") {
        const fact = parseFact(command.statement);
        if (!fact || findFacts(store, fact.subject).length === 0) return null;
      }
      const result = saveFact(store, command.statement);
      writeStore(store);
      const said = factForUser(result.memory);
      if (result.status === "updated") {
        return reply(memoryReply("updated", said), true);
      }
      if (result.status === "unchanged") {
        return reply(memoryReply("unchanged", said));
      }
      return reply(memoryReply("saved", said));
    }

    if (command.type === "forget") {
      const store = readStore();
      const removed = forgetTopic(store, command.topic);
      if (removed === 0) {
        return reply(memoryReply("notFound", toSecondPerson(command.topic)));
      }
      writeStore(store);
      return reply(memoryReply("forgotten", toSecondPerson(command.topic)), true);
    }

    const facts = findFacts(readStore(), command.topic);
    if (facts.length > 0) {
      return reply(memoryReply("recalled", facts.slice(0, 3).map((memory) => sentence(factForUser(memory))).join(" ")));
    }
    return command.explicit
      ? reply(memoryReply("notFound", toSecondPerson(command.topic)))
      : null;
  } catch (error: any) {
    console.error(`[Memory] ${command.type} command failed: ${error.message}`);
    return reply(memoryReply("failed"));
  }
};

// ---- Auto-save --------------------------------------------------------------

export function autoSaveExchange(
  userText: string,
  assistantText: string,
  summaryText?: (text: string, promptPrefix: string) => Promise<string>,
): void {
  if (!memoryAutoSave) return;
  if (!userText.trim() || !assistantText.trim()) return;
  // Memory commands are already stored as facts; saving the exchange too would
  // keep a forgotten value in the conversation history.
  if (handledCommandTexts.delete(commandKey(userText))) return;
  if (isSensitiveForAutoSave(userText) || isSensitiveForAutoSave(assistantText)) {
    console.log("[Memory] Exchange contains sensitive details; not saved.");
    return;
  }

  enqueueWrite(async () => {
    // Step 1: append the exchange (synchronous read-modify-write).
    const store = readStore();
    const session = getActiveSession(store, userText);
    const exchange: MemoryExchange = {
      at: nowIso(),
      user: textPreview(userText, 1200),
      assistant: textPreview(assistantText, 1600),
    };
    session.exchanges.push(exchange);
    session.exchanges = session.exchanges.slice(-Math.max(1, memoryMaxSessionExchanges));
    if (session.exchanges.length === 1) {
      session.title = titleFromText(userText);
    }
    session.updatedAt = nowIso();
    lastExchangeAt = Date.now();

    const preference = inferPreference(userText);
    if (preference && !containsSecret(preference)) {
      saveFact(store, preference, "preference");
    }
    writeStore(store);
    const sessionCopy: MemorySession = { ...session, exchanges: session.exchanges.slice() };

    // Step 2: summarize without holding the store, so facts saved or forgotten
    // meanwhile are not overwritten.
    const summary = await buildSessionSummary(sessionCopy, summaryText);

    // Step 3: store the summary if the exchange still exists.
    const latest = readStore();
    const target = latest.sessions.find((item) => item.id === session.id);
    if (!target || !target.exchanges.some((item) => item.at === exchange.at)) return;
    target.summary = summary;
    target.summaryUpdatedAt = nowIso();
    target.title = titleFromSummary(summary, target.title);
    target.keywords = persistedKeywords([target.title, summary, userText, assistantText].join("\n"));
    writeStore(latest);
    console.log(`[Memory] Saved exchange to: ${target.title}`);
  });
}

// ---- One-time repair of older stores ----------------------------------------

/**
 * Older versions only kept "Remember that ..." requests inside conversation
 * history (often with a Chinese summary), so they were never found again.
 * Imports them as facts once, oldest first, after backing up the file.
 */
const importRememberedFacts = (): void => {
  if (!fs.existsSync(memoryStorePath)) return;
  const store = readStore();
  if (store.rememberedFactsImported) return;
  const exchanges = store.sessions
    .flatMap((session) => session.exchanges)
    .sort((a, b) => `${a.at}`.localeCompare(`${b.at}`));
  let imported = 0;
  for (const exchange of exchanges) {
    const command = parseMemoryCommand(exchange.user);
    if (command?.type === "remember" && !containsSecret(command.statement)) {
      if (saveFact(store, command.statement).status !== "unchanged") imported += 1;
    }
  }
  if (imported > 0) {
    const backup = `${memoryStorePath}.bak-${moment().format("YYYYMMDD-HHmmss")}`;
    fs.copyFileSync(memoryStorePath, backup);
    console.log(`[Memory] Imported ${imported} remembered fact(s) from saved conversations (backup: ${backup})`);
  }
  writeStore(store);
};

// ---- Tools ------------------------------------------------------------------

export const localMemoryTools: LLMTool[] = [];

if (memoryEnabled) {
  console.log(`[Memory] Enabled, store: ${memoryStorePath}`);
  try {
    importRememberedFacts();
  } catch (error: any) {
    console.error(`[Memory] Could not import remembered facts: ${error.message}`);
  }
  localMemoryTools.push(
    {
      type: "function",
      function: {
        name: "searchLocalMemory",
        description:
          // No concrete example here or below: the 1.7B model copies it into the
          // arguments (it searched for and saved "My favorite color is blue").
          "Look up what the user told you earlier about themselves, or what you talked about before. Use the user's own words as the query.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "What to search for in local memory",
            },
          },
          required: ["query"],
        },
      },
      func: async (params: { query: string }) => {
        return `${ToolReturnTag.Success}${searchStoreForTool(`${params?.query || ""}`)}`;
      },
    },
    {
      type: "function",
      function: {
        name: "storeLocalMemory",
        description:
          "Save something the user asked you to remember about themselves. Write it in English in the first person, as the user would say it.",
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The fact to remember, in English",
            },
            kind: {
              type: "string",
              description: "Memory type",
              enum: ["preference", "context", "fact"],
            },
          },
          required: ["content"],
        },
      },
      func: async (params: { content: string; kind?: "preference" | "context" | "fact" }) => {
        const content = textPreview(`${params?.content || ""}`, 300);
        if (!content) return `${ToolReturnTag.Error}Memory content is empty.`;
        if (containsSecret(content)) {
          return `${ToolReturnTag.Error}Not saved: secrets such as passwords are never stored. Tell the user.`;
        }
        const store = readStore();
        const result = saveFact(store, content, params?.kind || "fact");
        writeStore(store);
        return `${ToolReturnTag.Success}Saved: ${factForModel(result.memory)} Confirm this to the user in one short sentence.`;
      },
    },
  );
}

export const addLocalMemoryTools = (tools: LLMTool[]): void => {
  if (localMemoryTools.length > 0) {
    console.log(
      `[Memory] Adding ${localMemoryTools.length} tool(s): ${localMemoryTools
        .map((tool) => tool.function.name)
        .join(", ")}`,
    );
    tools.push(...localMemoryTools);
  }
};
