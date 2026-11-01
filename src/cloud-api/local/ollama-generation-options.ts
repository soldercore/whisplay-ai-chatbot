/** Optional runner tuning. Unset preserves the model's own defaults. */
export function ollamaDraftOptions(env: NodeJS.ProcessEnv = process.env): { draft_num_predict?: number } {
  const text = env.OLLAMA_DRAFT_NUM_PREDICT?.trim();
  if (!text) return {};
  if (!/^(0|[1-9][0-9]?)$/.test(text) || Number(text) > 16) {
    throw new Error("OLLAMA_DRAFT_NUM_PREDICT must be an integer between 0 and 16");
  }
  return { draft_num_predict: Number(text) };
}
