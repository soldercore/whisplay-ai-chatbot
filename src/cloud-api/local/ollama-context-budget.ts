import axios from "axios";
import { checkCancelled, operationDeadline, timeoutSetting, waitForOperation } from "../../utils/operation-lifecycle";
import { OllamaResourceLimitError } from "./ollama-resource-limits";
import { ollamaTurnStart } from "./ollama-history-limits";

export type RuntimeContext = { effective: number; source: "/api/ps" | "fallback" };
export type PromptMessage = { role: string; content: string; [key: string]: unknown };

const canonicalModel = (name: string): string =>
  name.substring(name.lastIndexOf("/") + 1).includes(":") ? name : `${name}:latest`;

// Runtime slots can change when a model is reloaded. Do not cache /api/ps or
// substitute /api/show's advertised training/model capacity for this value.
export async function discoverRuntimeContext(endpoint: string, model: string, signal?: AbortSignal): Promise<RuntimeContext> {
  const deadline = operationDeadline(timeoutSetting("OLLAMA_METADATA_TIMEOUT_MS", 300_000), signal);
  try {
    const response = await waitForOperation(axios.get(`${endpoint}/api/ps`, {
      signal: deadline.signal, maxContentLength: 2 * 1024 * 1024,
    }), deadline.signal);
    checkCancelled(signal);
    const matches = Array.isArray(response.data?.models) ? response.data.models.filter((entry: any) =>
      [entry?.name, entry?.model].some(name => typeof name === "string" && canonicalModel(name) === canonicalModel(model))) : [];
    if (matches.length === 1 && Number.isSafeInteger(matches[0].context_length) && matches[0].context_length > 0) {
      return { effective: matches[0].context_length, source: "/api/ps" };
    }
  } catch {
    checkCancelled(signal);
  } finally { deadline.dispose(); }
  return { effective: 4096, source: "fallback" };
}

// A deterministic, deliberately conservative estimate, not the model's tokenizer.
// Count serialized UTF-8 bytes / 3, plus framing per message and tool list.
// The separate 15% (minimum 256 token) margin covers template/tokenizer variance.
export const promptMessageTokens = ({ contextScope, ...message }: PromptMessage): number =>
  16 + Math.ceil(Buffer.byteLength(JSON.stringify(message), "utf8") / 3);
const toolTokens = (tools?: unknown): number => tools ? 64 + Math.ceil(Buffer.byteLength(JSON.stringify(tools), "utf8") / 3) : 0;

export function fitOllamaPrompt<T extends PromptMessage>(
  messages: T[], tools: unknown, runtime: RuntimeContext, advertised?: number,
  expectedOutput?: number, activeUserIndex = messages.map(message => message.role).lastIndexOf("user"),
) {
  const outputReserve = Number.isSafeInteger(expectedOutput) && expectedOutput! > 0 ? expectedOutput! : 1024;
  const safetyReserve = Math.max(256, Math.ceil(runtime.effective * 0.15));
  const requestBudget = runtime.effective - outputReserve - safetyReserve;
  const toolsReserve = toolTokens(tools);
  const costs = messages.map(promptMessageTokens);
  // Only explicitly scoped injected context expires with a removed turn.
  // Global instructions and the whole active turn remain mandatory.
  const activeStart = ollamaTurnStart(messages, activeUserIndex);
  const protectedMessage = (index: number) => index === 0
    || messages[index].role === "system" && messages[index].contextScope !== "turn"
    || activeUserIndex < 0 || index >= activeStart;
  const systemReserve = costs[0] || 0;
  const contextReserve = messages.reduce((sum, message, index) => sum + (index > 0 && message.role === "system" && protectedMessage(index) ? costs[index] : 0), 0);
  const activeReserve = messages.reduce((sum, message, index) => sum + (index > 0 && message.role !== "system" && protectedMessage(index) ? costs[index] : 0), 0);
  const historyBudget = requestBudget - toolsReserve - systemReserve - contextReserve - activeReserve;
  console.log(`[Ollama] advertised_context=${advertised ?? "unknown"} effective_context=${runtime.effective} request_budget=${requestBudget} history_budget=${Math.max(0, historyBudget)} source=${runtime.source} reserves=system:${systemReserve},context:${contextReserve},active:${activeReserve},tools:${toolsReserve},output:${outputReserve},safety:${safetyReserve}`);
  if (historyBudget < 0) throw new OllamaResourceLimitError("required prompt exceeds the effective runtime context budget");

  let kept = messages.map((_, index) => index);
  const total = () => toolsReserve + kept.reduce((sum, index) => sum + costs[index], 0);
  const before = total();
  // Drop complete oldest turns, never part of an assistant/tool exchange.
  const boundaries = [1];
  for (let index = 2; index <= activeUserIndex; index++) if (messages[index]?.role === "user") {
    const start = ollamaTurnStart(messages, index);
    if (!boundaries.includes(start)) boundaries.push(start);
  }
  for (let group = 0; total() > requestBudget && group + 1 < boundaries.length; group++) {
    const start = boundaries[group], end = boundaries[group + 1];
    kept = kept.filter(index => index < start || index >= end || protectedMessage(index));
  }
  const estimatedTokens = total();
  if (estimatedTokens > requestBudget) throw new OllamaResourceLimitError("prompt cannot fit without dropping required context");
  if (kept.length !== messages.length) console.log(`[Ollama] prompt_trimmed=${messages.length - kept.length} estimated_before=${before} estimated_after=${estimatedTokens} request_budget=${requestBudget}`);
  return { messages: kept.map(index => messages[index]), requestBudget, historyBudget, estimatedTokens,
    reserves: { system: systemReserve, context: contextReserve, active: activeReserve, tools: toolsReserve, output: outputReserve, safety: safetyReserve } };
}
