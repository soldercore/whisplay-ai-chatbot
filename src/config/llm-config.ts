require("dotenv").config();
import { personaName, personaPrompt } from "./persona";

// ASSISTANT_PERSONA selects the persona (see persona.ts); default keeps SYSTEM_PROMPT or the original prompt.
const baseSystemPrompt = personaPrompt();
console.log(`[Persona] ${personaName()}`);

// One owner per rule. The GLaDOS persona already sets reply length ("Simple questions: usually one to three sentences"), "Give detail
// when requested" and plain spoken sentences, so the shared block adds only what it lacks (no Markdown, accuracy and safety, no
// implementation detail). Repeating the length rule here contradicted it (one to three against one or two sentences).
const speechFriendlyPrompt = personaName() === "glados"
  ? " Format your replies for spoken text-to-speech. Use plain conversational prose without Markdown. Expand for accuracy or safety. Omit needless implementation details."
  : " Format your replies for spoken text-to-speech. Simple questions: one or two natural sentences, usually 25 to 40 words; shorter when sufficient. Expand for requested detail, accuracy or safety. Omit needless implementation details. Use plain conversational prose without Markdown.";

const wakeWordEnabled =
  (process.env.WAKE_WORD_ENABLED || "").toLowerCase() === "true";

const wakeWordConversationToolPrompt = wakeWordEnabled
  ? " If the endConversation tool is available and the user clearly wants to end the current conversation, call that tool before giving your brief final reply."
  : "";

// Device operating contract, separate from the unchanged character prompt.
const deviceOperatingPrompt = process.env.WHISPLAY_VOICE_CONTROL_ENABLED === "true"
  ? " Device operations: use whisplay for capabilities, live device state and changes. Use getSystemHealth for actual CPU, RAM, temperature and storage. Before answering what you can do, read capabilities. Report only supplied measurements and their labels. Do not calculate percentages or invent health assessments, diagnoses or service resource use. Give a brief factual answer after tool results. Pending confirmation means nothing has changed; the physical button is required."
  : "";

// default 5 minutes
export const CHAT_HISTORY_RESET_TIME = parseInt(process.env.CHAT_HISTORY_RESET_TIME || "300" , 10) * 1000; // convert to milliseconds

export let lastMessageTime = 0;

export const updateLastMessageTime = (): void => {
  lastMessageTime = Date.now();
}

export const shouldResetChatHistory = (): boolean => {
  return Date.now() - lastMessageTime > CHAT_HISTORY_RESET_TIME;
}

export const systemPrompt = `${baseSystemPrompt}${speechFriendlyPrompt}${wakeWordConversationToolPrompt}${deviceOperatingPrompt}`;
