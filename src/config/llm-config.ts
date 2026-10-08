require("dotenv").config();
import { personaName, personaPrompt } from "./persona";

// ASSISTANT_PERSONA selects the persona (see persona.ts); default keeps SYSTEM_PROMPT or the original prompt.
const baseSystemPrompt = personaPrompt();
console.log(`[Persona] ${personaName()}`);

const speechFriendlyPrompt =
  " Format your replies for spoken text-to-speech. Do not use Markdown formatting that sounds awkward when read aloud, such as tables, code blocks, headings, bullet lists, numbered lists, inline links, footnote markers, or decorative separators. Use natural conversational sentences and plain punctuation instead.";

const wakeWordEnabled =
  (process.env.WAKE_WORD_ENABLED || "").toLowerCase() === "true";

const wakeWordConversationToolPrompt = wakeWordEnabled
  ? " If the endConversation tool is available and the user clearly wants to end the current conversation, call that tool before giving your brief final reply."
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

export const systemPrompt = `${baseSystemPrompt}${speechFriendlyPrompt}${wakeWordConversationToolPrompt}`;
