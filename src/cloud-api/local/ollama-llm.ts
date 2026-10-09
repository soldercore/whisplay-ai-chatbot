import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { isEmpty } from "lodash";
import {
  shouldResetChatHistory,
  systemPrompt,
  updateLastMessageTime,
} from "../../config/llm-config";
import { llmTools, llmFuncMap } from "../../config/llm-tools";
import dotenv from "dotenv";
import {
  LLMTool,
  Message,
  OllamaFunctionCall,
  OllamaMessage,
  ToolReturnTag,
} from "../../type";
import { ChatWithLLMStreamFunction, SummaryTextWithLLMFunction } from "../interface";
import { chatHistoryDir } from "../../utils/dir";
import moment from "moment";
import {
  extractToolResponse,
  stimulateStreamResponse,
} from "../../config/common";
import { defaultPortMap } from "./common";
import {
  consumePendingCapturedImgForChat,
  hasPendingCapturedImgForChat,
} from "../../utils/image";
import { compactMessagesForContextWindow } from "../context-window";
import { getWebSearchSystemNote } from "../../config/web-search";
import {
  needsCurrentInformation,
  searchTypeFor,
} from "../../config/web-search-router";
import { interpretHeldAnswer, startsWithMarkup } from "../../config/spoken-text-guard";
import { isDirectAnswerRequest, toolsRelevantTo } from "../../config/tool-router";

dotenv.config();

// Ollama LLM configuration
const ollamaEndpoint =
  process.env.OLLAMA_ENDPOINT || `http://localhost:${defaultPortMap.ollama}`;
const ollamaModel = process.env.OLLAMA_MODEL || "deepseek-r1:1.5b";
const ollamaEnableTools = process.env.OLLAMA_ENABLE_TOOLS === "true";
const ollamaMaxToolRounds = Math.max(
  0,
  parseInt(process.env.OLLAMA_MAX_TOOL_ROUNDS || "4", 10) || 0,
);
const ollamaPredictNum = process.env.OLLAMA_PREDICT_NUM
  ? parseInt(process.env.OLLAMA_PREDICT_NUM)
  : undefined;
const enableThinking = process.env.ENABLE_THINKING === "true";
const useCapturedImageInChat =
  (process.env.USE_CAPTURED_IMAGE_IN_CHAT || "false").toLowerCase() ===
  "true";

const llmServer = process.env.LLM_SERVER || "";

let ollamaContextWindowCache: number | undefined;

const findContextWindowValue = (value: unknown): number | undefined => {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(context_length|num_ctx|context.*length)$/i.test(key) &&
      Number.isFinite(Number(child)) &&
      Number(child) > 0
    ) {
      return Number(child);
    }
    const nested = findContextWindowValue(child);
    if (nested) return nested;
  }
  return undefined;
};

const resolveOllamaContextWindow = async (): Promise<number | undefined> => {
  if (ollamaContextWindowCache) return ollamaContextWindowCache;
  const response = await axios.post(`${ollamaEndpoint}/api/show`, {
    model: ollamaModel,
  });
  ollamaContextWindowCache =
    findContextWindowValue(response.data?.model_info) ||
    findContextWindowValue(response.data?.details) ||
    findContextWindowValue(response.data);
  return ollamaContextWindowCache;
};

const chatHistoryFileName = `ollama_chat_history_${moment().format(
  "YYYY-MM-DD_HH-mm-ss",
)}.json`;

const messages: OllamaMessage[] = [
  {
    role: "system",
    content: systemPrompt,
  },
];

// ---- Timing diagnostics -------------------------------------------------------
// One log line per model request, so a slow answer can be attributed on the
// device: prompt tokens read (prompt_eval_*), tokens generated (eval_*), model
// load and time to the first streamed token. Ollama counts reused (cached)
// prompt tokens in prompt_eval_count, so a prompt rate far above the device's
// usual rate means most of the prompt came from its cache. "kept" tells how many
// leading parts (system prompt, tool list, then messages) equal the previous
// request; Ollama has to re-read everything after the first changed part.
type OllamaStats = {
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
};

let previousRequestShape: string[] = [];

const requestShape = (sent: { role: string; content: string }[], tools?: LLMTool[]): string => {
  const [system, ...rest] = sent;
  const shape = [
    `${system?.role}:${system?.content}`,
    `tools:${(tools || []).map((tool) => tool.function.name).join(",")}`,
    ...rest.map((msg) => `${msg.role}:${msg.content}`),
  ];
  let kept = 0;
  while (kept < shape.length && shape[kept] === previousRequestShape[kept]) kept++;
  previousRequestShape = shape;
  return `tools=${(tools || []).length} msgs=${sent.length} kept=${kept}/${shape.length}`;
};

const rate = (count?: number, ns?: number): string =>
  count && ns ? (count / (ns / 1e9)).toFixed(1) : "-";
const ms = (ns?: number): number => Math.round((ns || 0) / 1e6);

const logOllamaTiming = (
  label: string,
  stats: OllamaStats | undefined,
  startedAt: number,
  firstTokenAt: number,
  detail = "",
): void => {
  const s = stats || {};
  console.log(
    `[Ollama timing] ${label}${detail ? ` ${detail}` : ""}` +
      ` prompt=${s.prompt_eval_count ?? 0} tok/${ms(s.prompt_eval_duration)} ms (${rate(s.prompt_eval_count, s.prompt_eval_duration)} tok/s)` +
      ` gen=${s.eval_count ?? 0} tok/${ms(s.eval_duration)} ms (${rate(s.eval_count, s.eval_duration)} tok/s)` +
      ` load=${ms(s.load_duration)} ms first-token=${firstTokenAt ? `${firstTokenAt - startedAt} ms` : "-"}` +
      ` total=${Date.now() - startedAt} ms`,
  );
};

// Loads the model and keeps it loaded without evaluating a prompt: Ollama
// answers a chat request with no messages with done_reason "load". The former
// warmup sent the system prompt and all tools (~965 tokens), which took 65 s of
// prompt evaluation on a Pi 5, and a first question had to wait for it.
const keepAliveOllama = () => {
  axios
    .post(`${ollamaEndpoint}/api/chat`, {
      model: ollamaModel,
      messages: [],
      stream: false,
      keep_alive: -1,
    })
    .then((response) => {
      console.log("Ollama keep-alive response:", response.data);
    })
    .catch((err) => {
      console.error("Error initializing Ollama model:", err.message);
    });
};

if (llmServer.trim().toLowerCase() === "ollama") {
  // Load the model into memory once at startup (load only, no prompt).
  keepAliveOllama();
}

const resetChatHistory = (): void => {
  messages.length = 0;
  messages.push({
    role: "system",
    content: systemPrompt,
  });
};

type ToolLoopState = {
  round: number;
  signatures: Set<string>;
  // Set after a routed web search: the next request offers only the read-only
  // web tools, so the model cannot follow up with an unrelated tool that has
  // side effects (e.g. setVolume). Removing tools entirely makes qwen3 echo the
  // raw tool output instead of answering.
  webToolsOnly?: boolean;
  // Aborted when a newer question supersedes this answer (see chatWithLLMStream).
  signal?: AbortSignal;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

// Text arguments are compared without case and punctuation, so "What is 2 plus 2"
// and "what is 2 plus 2?" count as the same call.
const normalizeArguments = (value: unknown): unknown => {
  if (typeof value === "string") return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (Array.isArray(value)) return value.map(normalizeArguments);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeArguments(item)]),
    );
  }
  return value;
};

const toolCallSignature = (call: OllamaFunctionCall): string =>
  `${call.function?.name || ""}:${stableStringify(normalizeArguments(call.function?.arguments || {}))}`;

const previousToolResultFor = (toolName: string): string => {
  const previous = [...messages]
    .reverse()
    .find((message) => message.role === "tool" && message.tool_name === toolName);
  return previous?.content || "";
};

// Today's date and when to search, added to the system message at request time
// (only when tools are enabled) so the date never goes stale.
const withRequestSystemNote = <T extends { role: string; content: string }>(
  msg: T,
  index: number,
): T => {
  const note = ollamaEnableTools ? getWebSearchSystemNote() : "";
  return note && index === 0 && msg.role === "system"
    ? { ...msg, content: `${msg.content}${note}` }
    : msg;
};

/**
 * Runs web_search before the first model call when the user's question
 * clearly needs current information (see web-search-router), and adds the
 * call and its result to the conversation as if the model had made it.
 */
const prefetchWebSearchIfNeeded = async (
  inputMessages: Message[],
  toolLoopState: ToolLoopState,
  invokeFunctionCallback?: (functionName: string, result?: string) => void,
): Promise<void> => {
  const search = llmFuncMap.web_search;
  if (!ollamaEnableTools || !search) return;
  const lastUser = [...inputMessages].reverse().find((msg) => msg.role === "user");
  const question = typeof lastUser?.content === "string" ? lastUser.content.trim() : "";
  if (!question || !needsCurrentInformation(question)) return;

  const args = { query: question, search_type: searchTypeFor(question) };
  console.log(`[WebSearch] Time-sensitive question, searching first: ${JSON.stringify(args)}`);
  invokeFunctionCallback?.("web_search");
  const result = await search(args).catch((err: Error) => {
    console.error("Error executing function web_search:", err);
    return `${ToolReturnTag.Error}Error executing function web_search: ${err.message}`;
  });
  invokeFunctionCallback?.("web_search", result);
  if (toolLoopState.signal?.aborted) return;

  const call = { function: { index: 0, name: "web_search", arguments: args } };
  messages.push(
    { role: "assistant", content: "", tool_calls: [[call]] },
    { role: "tool", content: result, tool_name: "web_search" },
  );
  toolLoopState.signatures.add(toolCallSignature(call));
  toolLoopState.webToolsOnly = true;
};

const WEB_TOOL_NAMES = new Set(["web_search", "fetch_webpage"]);
const toolsForRequest = (toolLoopState: ToolLoopState) => {
  if (!ollamaEnableTools) return undefined;
  if (toolLoopState.webToolsOnly) {
    return llmTools.filter((tool) => WEB_TOOL_NAMES.has(tool.function.name));
  }
  // Memory and volume tools only when the request (or the request a follow-up
  // continues) concerns them; see tool-router.
  const [latest, previous] = messages
    .filter((msg) => msg.role === "user")
    .reverse()
    .map((msg) => (typeof msg.content === "string" ? msg.content : ""));
  return toolsRelevantTo(latest || "", llmTools, previous || "");
};

const answerFromAvailableToolResults = async ({
  instruction,
  partialCallback,
  endResolve,
  endCallback,
  partialThinkingCallback,
  signal,
}: {
  instruction: string;
  partialCallback: (partialAnswer: string) => void;
  endResolve: () => void;
  endCallback: () => void;
  partialThinkingCallback?: (partialThinking: string) => void;
  signal?: AbortSignal;
}): Promise<void> => {
  let finalAnswer = "";
  let finalThinking = "";
  try {
    const requestMessages = [
      ...messages.map((msg, index) =>
        withRequestSystemNote({ role: msg.role, content: msg.content }, index),
      ),
      {
        role: "user",
        content: instruction,
      },
    ];
    const shape = requestShape(requestMessages);
    const startedAt = Date.now();
    let firstTokenAt = 0;
    let stats: OllamaStats | undefined;
    const response = await axios.post(
      `${ollamaEndpoint}/api/chat`,
      {
        model: ollamaModel,
        messages: requestMessages,
        think: enableThinking,
        stream: true,
        options: {
          temperature: 0.7,
          num_predict: ollamaPredictNum,
        },
        keep_alive: -1,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        responseType: "stream",
        signal,
      },
    );

    await new Promise<void>((resolve) => {
      response.data.on("data", (chunk: Buffer) => {
        const dataLines = chunk
          .toString()
          .split("\n")
          .filter((line) => line.trim() !== "");

        for (const line of dataLines) {
          try {
            const parsedData = JSON.parse(line);
            if (!firstTokenAt && (parsedData.message?.content || parsedData.message?.thinking)) {
              firstTokenAt = Date.now();
            }
            if (parsedData.done) stats = parsedData;
            if (parsedData.message?.content) {
              const content = parsedData.message.content;
              partialCallback(content);
              finalAnswer += content;
            }
            if (parsedData.message?.thinking) {
              const thinking = parsedData.message.thinking;
              partialThinkingCallback?.(thinking);
              finalThinking += thinking;
            }
          } catch (error) {
            console.error("Error parsing final answer data:", error, line);
          }
        }
      });
      response.data.on("end", resolve);
      response.data.on("error", (error: Error) => {
        console.error("Error streaming final answer:", error.message);
        resolve();
      });
    });
    logOllamaTiming("final-answer", stats, startedAt, firstTokenAt, shape);

    if (finalThinking.trim()) {
      console.log(`[Ollama] Final no-tools thinking length: ${finalThinking.length}`);
    }
    if (signal?.aborted) return;
    messages.push({
      role: "assistant",
      content: finalAnswer,
    });
  } catch (error: any) {
    console.error("Error generating final answer from tool results:", error.message);
  } finally {
    endResolve();
    endCallback();
  }
};

const chatWithLLMStreamInternal = async (
  inputMessages: Message[] = [],
  partialCallback: (partialAnswer: string) => void,
  endCallback: () => void,
  partialThinkingCallback?: (partialThinking: string) => void,
  invokeFunctionCallback?: (functionName: string, result?: string) => void,
  toolLoopState: ToolLoopState = { round: 0, signatures: new Set<string>() },
): Promise<void> => {
  if (toolLoopState.signal?.aborted) {
    endCallback();
    return;
  }
  if (shouldResetChatHistory()) {
    resetChatHistory();
  }
  updateLastMessageTime();
  messages.push(...(inputMessages as OllamaMessage[]));
  if (toolLoopState.round === 0) {
    await prefetchWebSearchIfNeeded(inputMessages, toolLoopState, invokeFunctionCallback);
  }
  // A cancelled answer must not compact the history the newer question uses.
  if (toolLoopState.signal?.aborted) {
    endCallback();
    return;
  }
  await compactMessagesForContextWindow({
    provider: "ollama",
    model: ollamaModel,
    messages,
    tools: ollamaEnableTools ? llmTools : undefined,
    outputReserveTokens: ollamaPredictNum,
    contextWindowResolver: resolveOllamaContextWindow,
    invokeFunctionCallback,
  });
  if (toolLoopState.signal?.aborted) {
    endCallback();
    return;
  }
  let endResolve: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    endResolve = resolve;
  }).finally(() => {
    // save chat history to file
    fs.writeFileSync(
      path.join(chatHistoryDir, chatHistoryFileName),
      JSON.stringify(messages, null, 2),
    );
  });
  let partialAnswer = "";
  let partialThinking = "";
  // An answer that starts with JSON or markup is held back from speech until
  // it is complete (see spoken-text-guard); everything else streams as before.
  let contentMode: "undecided" | "stream" | "hold" = "undecided";
  const functionCallsPackages: OllamaFunctionCall[][] = [];

  try {
    const lastUserMessageIndex = messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role === "user")
      .map(({ index }) => index)
      .pop();
    const capturedImagePath =
      useCapturedImageInChat &&
      lastUserMessageIndex !== undefined &&
      hasPendingCapturedImgForChat()
        ? consumePendingCapturedImgForChat()
        : "";
    const capturedImageBase64 = capturedImagePath
      ? fs.readFileSync(capturedImagePath).toString("base64")
      : "";

    const requestTools = toolsForRequest(toolLoopState);
    const requestMessages = messages.map((msg, index) => ({
      role: msg.role,
      content: withRequestSystemNote(msg, index).content,
      ...(capturedImageBase64 &&
      msg.role === "user" &&
      lastUserMessageIndex !== undefined &&
      index === lastUserMessageIndex
        ? { images: [capturedImageBase64] }
        : {}),
    }));
    const shape = requestShape(requestMessages, requestTools);
    const startedAt = Date.now();
    let firstTokenAt = 0;
    let stats: OllamaStats | undefined;
    const response = await axios.post(
      `${ollamaEndpoint}/api/chat`,
      {
        model: ollamaModel,
        messages: requestMessages,
        think: enableThinking,
        stream: true,
        options: {
          temperature: 0.7,
          num_predict: ollamaPredictNum,
        },
        tools: requestTools,
        keep_alive: -1,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        responseType: "stream",
        signal: toolLoopState.signal,
      },
    );
    let streamClosed = false;
    // A cancelled request ends the stream with an error instead of "end".
    response.data.on("error", (error: Error) => {
      if (streamClosed) return;
      streamClosed = true;
      console.warn(`[Ollama] Stream stopped: ${error.message}`);
      endResolve();
      endCallback();
    });

    response.data.on("data", (chunk: Buffer) => {
      const data = chunk.toString();
      const dataLines = data.split("\n");
      const filteredLines = dataLines.filter((line) => line.trim() !== "");

      for (const line of filteredLines) {
        try {
          const parsedData = JSON.parse(line);
          if (
            !firstTokenAt &&
            (parsedData.message?.content || parsedData.message?.thinking || parsedData.message?.tool_calls)
          ) {
            firstTokenAt = Date.now();
          }
          if (parsedData.done) stats = parsedData;

          // Handle content from Ollama
          if (parsedData.message?.content) {
            const content = parsedData.message.content;
            partialAnswer += content;
            if (contentMode === "stream") {
              partialCallback(content);
            } else if (contentMode === "undecided" && partialAnswer.trim()) {
              contentMode = startsWithMarkup(partialAnswer) ? "hold" : "stream";
              if (contentMode === "stream") partialCallback(partialAnswer);
            }
          }

          // Handle thinking from Ollama
          if (parsedData.message?.thinking) {
            const thinking = parsedData.message.thinking;
            partialThinkingCallback?.(thinking);
            partialThinking += thinking;
          }

          // Handle tool calls from Ollama
          if (parsedData.message?.tool_calls) {
            // tool_calls format: [[{"function":{"index":0,"name":"setVolume","arguments":{"percent":50}}}]]
            functionCallsPackages.push(parsedData.message.tool_calls);
          }
        } catch (error) {
          console.error("Error parsing data:", error, line);
        }
      }
    });

    response.data.on("end", async () => {
      if (streamClosed) return;
      streamClosed = true;
      console.log("Stream ended");
      logOllamaTiming(`round=${toolLoopState.round}`, stats, startedAt, firstTokenAt, shape);
      if (toolLoopState.signal?.aborted) {
        endResolve();
        endCallback();
        return;
      }
      if (contentMode === "hold") {
        // A tool call written as text runs only if that tool was offered.
        const offered = requestTools ? requestTools.map((tool) => tool.function.name) : Object.keys(llmFuncMap);
        const held = interpretHeldAnswer(partialAnswer, new Set(offered));
        if (held.toolCall && functionCallsPackages.length === 0) {
          console.warn(`[LLM] Tool call arrived as text; running ${held.toolCall.function.name} instead of speaking it.`);
          functionCallsPackages.push([held.toolCall]);
          partialAnswer = "";
        } else {
          partialAnswer = held.spoken;
          if (partialAnswer) partialCallback(partialAnswer);
        }
      }
      const functionCalls = functionCallsPackages.flat().map((call, index) => ({
        id: `call_${Date.now()}_${Math.random()}_${index}`,
        type: "function",
        function: call.function,
      }));
      console.log(
        "functionCallsPackages: ",
        JSON.stringify(functionCallsPackages),
      );
      console.log("functionCalls: ", JSON.stringify(functionCalls));
      messages.push({
        role: "assistant",
        content: partialAnswer,
        tool_calls: functionCallsPackages as any,
      });

      if (!isEmpty(functionCalls)) {
        if (toolLoopState.round >= ollamaMaxToolRounds) {
          console.warn(`[ToolLoop] Reached OLLAMA_MAX_TOOL_ROUNDS=${ollamaMaxToolRounds}.`);
          await answerFromAvailableToolResults({
            instruction:
              "You have already checked enough tool results for this request. Answer the user's latest request now using the available conversation and tool results. Do not call or ask for another tool. Do not mention internal tool instructions, raw status markers such as [success], exit_code, duration_ms, timed_out, truncated, or phrases like previous tool result.",
            partialCallback,
            endResolve,
            endCallback,
            partialThinkingCallback,
            signal: toolLoopState.signal,
          });
          return;
        }

        const duplicateCall = functionCalls.find((call) =>
          toolLoopState.signatures.has(toolCallSignature(call)),
        );
        if (duplicateCall) {
          const signature = toolCallSignature(duplicateCall);
          const name = duplicateCall.function?.name || "tool";
          const previous = previousToolResultFor(name);
          console.warn(`[ToolLoop] Repeated tool call blocked: ${signature}`);
          await answerFromAvailableToolResults({
            instruction: [
              `The ${name} tool was already called for this request, so do not call it again.`,
              "Answer the user's latest request now using the available result below.",
              "Do not mention internal tool instructions, raw status markers such as [success], exit_code, duration_ms, timed_out, truncated, or phrases like previous tool result.",
              previous ? `\nAvailable ${name} result:\n${previous}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            partialCallback,
            endResolve,
            endCallback,
            partialThinkingCallback,
            signal: toolLoopState.signal,
          });
          return;
        }

        for (const call of functionCalls) {
          toolLoopState.signatures.add(toolCallSignature(call));
        }

        const latestUser = [...messages].reverse().find((msg) => msg.role === "user");
        const directAnswer = isDirectAnswerRequest(typeof latestUser?.content === "string" ? latestUser.content : "");
        const results = await Promise.all(
          functionCalls.map(async (call: OllamaFunctionCall) => {
            const {
              function: { arguments: args, name },
            } = call;
            const func = llmFuncMap[name! as string];
            if (directAnswer && WEB_TOOL_NAMES.has(name as string)) {
              // A direct-answer request ("in one sentence", arithmetic) needs no search;
              // a short result costs far less to read than real search results.
              console.warn(`[ToolLoop] ${name} not run for a direct-answer request.`);
              return [name, `${ToolReturnTag.Error}Not needed. Answer this question directly from your own knowledge.`];
            }
            if (func) {
              invokeFunctionCallback?.(name! as string);
              return [
                name,
                await func(args)
                  .then((res) => {
                    invokeFunctionCallback?.(name! as string, res);
                    return res;
                  })
                  .catch((err) => {
                    console.error(`Error executing function ${name}:`, err);
                    return `Error executing function ${name}: ${err.message}`;
                  }),
              ];
            } else {
              console.error(`Function ${name} not found`);
              return [name, `Function ${name} not found`];
            }
          }),
        );

        if (toolLoopState.signal?.aborted) {
          endResolve();
          endCallback();
          return;
        }

        const newMessages: OllamaMessage[] = results.map(
          ([name, result]: any) => ({
            role: "tool",
            content: result as string,
            tool_name: name as string,
          }),
        );

        // Directly extract and return the tool result if available
        const describeMessage = newMessages.find((msg) =>
          msg.content.startsWith(ToolReturnTag.Response),
        );
        const responseContent = extractToolResponse(
          describeMessage?.content || "",
        );
        if (responseContent) {
          console.log(
            `[LLM] Tool response starts with "[response]", return it directly.`,
          );
          newMessages.push({
            role: "assistant",
            content: responseContent,
          });
          // append responseContent in chunks
          await stimulateStreamResponse({
            content: responseContent,
            partialCallback,
            endResolve,
            endCallback,
          });
          return;
        }

        await chatWithLLMStreamInternal(
          newMessages as Message[],
          partialCallback,
          () => {
            endResolve();
            endCallback();
          },
          partialThinkingCallback,
          invokeFunctionCallback,
          {
            round: toolLoopState.round + 1,
            signatures: toolLoopState.signatures,
            signal: toolLoopState.signal,
          },
        );
        return;
      } else {
        endResolve();
        endCallback();
      }
    });
  } catch (error: any) {
    console.error("Error:", error.message);
    endResolve();
    endCallback();
  }

  return promise;
};

// The answer in progress. A new question (the user asked again before the
// answer finished) cancels it: Ollama serves one request at a time, so the new
// question would otherwise wait for the old answer and all its tool rounds, and
// the shared history would mix both questions.
let activeAnswer: {
  controller: AbortController;
  historyLength: number;
  inputMessages: Message[];
} | null = null;

const chatWithLLMStream: ChatWithLLMStreamFunction = async (
  inputMessages: Message[] = [],
  partialCallback: (partialAnswer: string) => void,
  endCallback: () => void,
  partialThinkingCallback?: (partialThinking: string) => void,
  invokeFunctionCallback?: (functionName: string, result?: string) => void,
): Promise<void> => {
  if (activeAnswer) {
    console.warn("[Ollama] New question before the previous answer finished; cancelling the previous answer.");
    activeAnswer.controller.abort();
    // Drop the unanswered question and everything after it (tool calls and
    // results) from the history. Its messages are found by identity, since a
    // compaction may have shortened the history meanwhile.
    const abandoned = activeAnswer.inputMessages as unknown[];
    const start = messages.findIndex((message) => abandoned.includes(message));
    messages.length = start >= 0 ? start : Math.min(messages.length, activeAnswer.historyLength);
  }
  if (shouldResetChatHistory()) {
    resetChatHistory();
  }
  const answer = { controller: new AbortController(), historyLength: messages.length, inputMessages };
  activeAnswer = answer;
  try {
    await chatWithLLMStreamInternal(
      inputMessages,
      partialCallback,
      endCallback,
      partialThinkingCallback,
      invokeFunctionCallback,
      { round: 0, signatures: new Set<string>(), signal: answer.controller.signal },
    );
  } finally {
    if (activeAnswer === answer) activeAnswer = null;
  }
};

const summaryTextWithLLM: SummaryTextWithLLMFunction = async (
  text: string, promptPrefix: string
): Promise<string> => {
  const prompt = `${promptPrefix}\n\n${text}\n\n`;

  // Bounded so a slow memory summary cannot occupy the model indefinitely.
  const startedAt = Date.now();
  const response = await axios.post(
    `${ollamaEndpoint}/api/generate`,
    {
      model: ollamaModel,
      prompt: prompt,
      stream: false,
      think: false,
      options: { num_predict: 160 },
    },
    { timeout: 60000 },
  );
  // The summary runs after the answer and occupies the model meanwhile.
  logOllamaTiming("memory-summary", response.data, startedAt, 0);

  if (response.data && response.data.response) {
    const summary = response.data.response;
    console.log("Ollama summary:", summary);
    return summary;
  } else {
    console.log("No summary returned from Ollama.");
    return "";
  }
}

export default { chatWithLLMStream, resetChatHistory, summaryTextWithLLM };
