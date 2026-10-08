import { noop } from "lodash";
import dotenv from "dotenv";
import { LLMServer } from "../type";
import {
  ChatWithLLMStreamFunction,
  ResetChatHistoryFunction,
  SummaryTextWithLLMFunction,
} from "./interface";
import { pluginRegistry, LLMProvider } from "../plugin";
import { handleMemoryCommand } from "../config/local-memory";

dotenv.config();

let _chatWithLLMStream: ChatWithLLMStreamFunction = noop as any;
let resetChatHistory: ResetChatHistoryFunction = noop as any;
let summaryTextWithLLM: SummaryTextWithLLMFunction = async (text, _) => text;

const MAX_FUNCTION_CALL_DEPTH = 5;
let functionCallDepth = 0;

const chatWithLLMStream: ChatWithLLMStreamFunction = async (
  inputMessages,
  partialCallback,
  endCallBack,
  partialThinkingCallback?,
  invokeFunctionCallback?,
) => {
  const isTopLevel = functionCallDepth === 0;
  if (isTopLevel) {
    // Explicit memory commands are answered from the local store without an
    // LLM round trip; the reply is spoken and displayed like any answer.
    const lastUser = [...inputMessages].reverse().find((message) => message.role === "user");
    const memoryReply =
      typeof lastUser?.content === "string" ? handleMemoryCommand(lastUser.content) : null;
    if (memoryReply) {
      if (memoryReply.contextChanged) resetChatHistory();
      partialCallback(memoryReply.text);
      endCallBack();
      return;
    }
  }
  functionCallDepth++;
  if (functionCallDepth > MAX_FUNCTION_CALL_DEPTH) {
    console.warn(`[LLM] Function call depth exceeded ${MAX_FUNCTION_CALL_DEPTH}, stopping.`);
    functionCallDepth = 0;
    endCallBack();
    return;
  }
  try {
    return await _chatWithLLMStream(
      inputMessages,
      partialCallback,
      endCallBack,
      partialThinkingCallback,
      invokeFunctionCallback,
    );
  } finally {
    if (isTopLevel) {
      functionCallDepth = 0;
    }
  }
};

const llmServer: LLMServer = (
  process.env.LLM_SERVER || LLMServer.test
).toLowerCase() as LLMServer;

console.log(`Current LLM Server: ${llmServer}`);

// Activate LLM plugin
try {
  const llmProvider = pluginRegistry.activatePluginSync<"llm">("llm", llmServer);
  _chatWithLLMStream = llmProvider.chatWithLLMStream;
  resetChatHistory = llmProvider.resetChatHistory;
  if (llmProvider.summaryTextWithLLM) {
    summaryTextWithLLM = llmProvider.summaryTextWithLLM;
  }
} catch (e: any) {
  console.warn(e.message);
}

const isImMode = llmServer === LLMServer.whisplayim;

export { chatWithLLMStream, resetChatHistory, summaryTextWithLLM, isImMode };
