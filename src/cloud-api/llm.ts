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
import { AsyncLocalStorage } from "node:async_hooks";

dotenv.config();

let _chatWithLLMStream: ChatWithLLMStreamFunction = noop as any;
let cancelLLMRequest: () => void = noop;
let resetChatHistory: ResetChatHistoryFunction = noop as any;
let summaryTextWithLLM: SummaryTextWithLLMFunction = async (text, _) => text;

const MAX_FUNCTION_CALL_DEPTH = 5;
const requestDepth = new AsyncLocalStorage<number>();

const chatWithLLMStream: ChatWithLLMStreamFunction = async (
  inputMessages,
  partialCallback,
  endCallBack,
  partialThinkingCallback?,
  invokeFunctionCallback?,
) => {
  const functionCallDepth = requestDepth.getStore() || 0;
  const isTopLevel = functionCallDepth === 0;
  if (isTopLevel) {
    cancelLLMRequest();
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
  if (functionCallDepth >= MAX_FUNCTION_CALL_DEPTH) {
    console.warn(`[LLM] Function call depth exceeded ${MAX_FUNCTION_CALL_DEPTH}, stopping.`);
    endCallBack();
    return;
  }
  return requestDepth.run(functionCallDepth + 1, () => _chatWithLLMStream(
      inputMessages,
      partialCallback,
      endCallBack,
      partialThinkingCallback,
      invokeFunctionCallback,
  ));
};

const llmServer: LLMServer = (
  process.env.LLM_SERVER || LLMServer.test
).toLowerCase() as LLMServer;

console.log(`Current LLM Server: ${llmServer}`);

// Activate LLM plugin
try {
  const llmProvider = pluginRegistry.activatePluginSync<"llm">("llm", llmServer);
  _chatWithLLMStream = llmProvider.chatWithLLMStream;
  cancelLLMRequest = llmProvider.cancelActiveRequest || noop;
  resetChatHistory = llmProvider.resetChatHistory;
  if (llmProvider.summaryTextWithLLM) {
    summaryTextWithLLM = llmProvider.summaryTextWithLLM;
  }
} catch (e: any) {
  console.warn(e.message);
}

const isImMode = llmServer === LLMServer.whisplayim;

export { chatWithLLMStream, resetChatHistory, summaryTextWithLLM, isImMode, cancelLLMRequest };
