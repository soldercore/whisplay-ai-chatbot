// Fixed host limits. Mutable accounting belongs to one public user request.
export type OllamaRequestBudget = {
  toolAttempts: number;
  transportBytes: number;
  failure?: string;
};

export const createOllamaRequestBudget = (): OllamaRequestBudget => ({ toolAttempts: 0, transportBytes: 0 });

export class OllamaResourceLimitError extends Error {}

function fail(budget: OllamaRequestBudget, reason: string): never {
  budget.failure = reason;
  throw new OllamaResourceLimitError(reason);
}

function checkActive(budget: OllamaRequestBudget): void {
  if (budget.failure) throw new OllamaResourceLimitError(budget.failure);
}

export function checkModelToolCount(budget: OllamaRequestBudget, count: number): void {
  checkActive(budget);
  if (count > 4) fail(budget, "model response exceeds 4 tool calls");
}

// Charge the entire admitted batch before authorization, including calls that
// authorization/validation later reject. An oversized batch executes nothing
// and permanently closes this request's budget; it is never partially charged.
export function reserveToolAttempts(budget: OllamaRequestBudget, count: number, modelTriggered = true): void {
  if (modelTriggered) checkModelToolCount(budget, count);
  else checkActive(budget);
  if (budget.toolAttempts + count > 8) fail(budget, "user request exceeds 8 tool attempts");
  budget.toolAttempts += count;
}

export function countTransportBytes(budget: OllamaRequestBudget, responseBytes: number, incoming: number): number {
  checkActive(budget);
  const next = responseBytes + incoming;
  budget.transportBytes += incoming; // Raw bytes received, before UTF-8 decoding.
  if (next > 2 * 1024 * 1024) fail(budget, "model response exceeds 2097152 transport bytes");
  if (budget.transportBytes > 8 * 1024 * 1024) fail(budget, "user request exceeds 8388608 transport bytes");
  return next;
}

export function countResponseTextBytes(budget: OllamaRequestBudget, previous: number, record: any): number {
  checkActive(budget);
  let next = previous;
  for (const text of [record?.message?.content, record?.message?.thinking]) {
    if (typeof text === "string") next += Buffer.byteLength(text, "utf8");
  }
  if (next > 256 * 1024) fail(budget, "model response exceeds 262144 content/thinking UTF-8 bytes");
  return next;
}
