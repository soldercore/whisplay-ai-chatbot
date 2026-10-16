import { LLMTool, ToolReturnTag } from "../type";
import { cloneDeep } from "lodash";
import { transformToGeminiType } from "../utils";
import { addImageGenerationTools } from "./image-generation";
import { addVisionTools } from "./vision";
import { addWebSearchTools } from "./web-search";
import { addLocalMemoryTools } from "./local-memory";
import { addMemPalaceTools } from "./mempalace";
import { addHarnessCommandTools } from "./harness-command";
import { pluginRegistry } from "../plugin";
import { BLOCKED_TOOL_NAMES, executeToolCall } from "./tool-execution";
import type { ToolExecutionResult } from "./tool-execution";
import { systemHealthTool } from "./system-health";

// ── Collect tools from all llm-tools plugins ────────────────
const pluginTools: LLMTool[] = [];

const wakeWordEnabled =
  (process.env.WAKE_WORD_ENABLED || "").toLowerCase() === "true";

if (wakeWordEnabled) {
  pluginTools.push({
    execution: "bounded",
    type: "function",
    function: {
      name: "endConversation",
      description:
        "Mark the current wakeword conversation to end after your next reply. Call this when the user clearly wants to stop, end, or wrap up the conversation. Do not mention the function name.",
      parameters: {},
    },
    func: async () => {
      return `${ToolReturnTag.Success}This conversation will end after your reply.`;
    },
  });
}

const activated = pluginRegistry.activateAllPluginsSync("llm-tools");
for (const { name, provider } of activated) {
  try {
    const tools = provider.getTools();
    pluginTools.push(...tools);
    console.log(
      `[LLM-Tools] Loaded ${tools.length} tool(s) from llm-tools plugin: ${name}`,
    );
  } catch (e: any) {
    console.error(`[LLM-Tools] Failed to get tools from ${name}:`, e.message);
  }
}

// ── Add image-generation, vision & web search tools ──────────
addImageGenerationTools(pluginTools);
addVisionTools(pluginTools);
addWebSearchTools(pluginTools);
addLocalMemoryTools(pluginTools);
addMemPalaceTools(pluginTools);
addHarnessCommandTools(pluginTools);
pluginTools.push(systemHealthTool);

// ── Exported aggregated tool lists ──────────────────────────
// Activation/registration is application-owned. External plugins remain trusted
// code, but cannot restore reserved shell tools through the model registry.
const registeredTools = pluginTools.filter((tool) => !BLOCKED_TOOL_NAMES.has(tool.function.name));
const rawHandlers: Record<string, (params: any) => Promise<string>> = Object.create(null);
const toolsEnabled = (): boolean => (process.env.LLM_SERVER || "").toLowerCase() !== "ollama"
  || process.env.OLLAMA_ENABLE_TOOLS === "true";

export const llmTools: LLMTool[] = registeredTools.map((tool) => {
  rawHandlers[tool.function.name] = tool.func;
  return Object.defineProperty({
    ...tool,
    function: cloneDeep(tool.function),
    func: async (args) => (await executeToolCall(tool.function.name, args, {
      enabled: toolsEnabled(), allowedTools: registeredTools, registeredTools,
      handlers: rawHandlers,
    })).output,
  }, "execution", { value: tool.execution, enumerable: false });
});

export const llmToolsForGemini: LLMTool[] =
  (process.env.LLM_SERVER || "").toLowerCase() === "gemini"
    ? llmTools.map((tool) => {
        const newTool = cloneDeep(tool);
        if (newTool.function && newTool.function.parameters) {
          newTool.function.parameters = transformToGeminiType(
            newTool.function.parameters,
          );
        }
        return newTool;
      })
    : [];

export const llmFuncMap = llmTools.reduce(
  (acc, tool) => {
    acc[tool.function.name] = tool.func;
    return acc;
  },
  Object.create(null) as Record<string, (params: any) => Promise<string>>,
);

// Ollama must additionally authorize against the exact list sent for this
// model round. The same executor covers native calls, text fallback and prefetch.
export const executeLLMTool = (
  name: unknown, args: unknown,
  context: { enabled: boolean; allowedTools: readonly LLMTool[]; signal?: AbortSignal },
): Promise<ToolExecutionResult> => executeToolCall(name, args, {
  ...context, enabled: context.enabled && toolsEnabled(),
  registeredTools: llmTools, handlers: llmFuncMap,
});
