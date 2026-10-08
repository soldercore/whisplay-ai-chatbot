/**
 * Keeps internal text out of speech. Small models sometimes print a tool call
 * as plain JSON instead of a real tool call, or echo markers such as
 * "[success]" and "<response>". An answer that starts with such markup is
 * held back until it is complete and then interpreted here.
 */

export const FALLBACK_REPLY = "Sorry, I didn't catch that. Could you say it again?";

export type ToolCallFromText = {
  function: { index: number; name: string; arguments: Record<string, any> };
};

/** True when an answer starting this way must not be spoken before it is complete. */
export const startsWithMarkup = (text: string): boolean => /^[{[<`]/.test(text.trimStart());

const parseArguments = (value: unknown): Record<string, any> => {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
};

export const interpretHeldAnswer = (
  text: string,
  toolNames: Set<string>,
): { toolCall?: ToolCallFromText; spoken: string } => {
  const body = text.trim().replace(/^(?:\[(?:success|error|response)\]\s*)+/i, "");
  const tagged = body.match(/<(tool_call|tool)>\s*([\s\S]*?)\s*(?:<\/\1>|$)/i);
  const candidate = (tagged ? tagged[2] : body)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (/^(?:\{|\[\s*\{)/.test(candidate)) {
    try {
      const parsed = JSON.parse(candidate);
      const call = Array.isArray(parsed) ? parsed[0] : parsed;
      const name = call?.name ?? call?.function?.name;
      if (typeof name === "string" && toolNames.has(name)) {
        const args = call.arguments ?? call.parameters ?? call.function?.arguments;
        return { toolCall: { function: { index: 0, name, arguments: parseArguments(args) } }, spoken: "" };
      }
    } catch {
      // Unparseable JSON-like text is not spoken either.
    }
    return { spoken: FALLBACK_REPLY };
  }

  const spoken = body
    .replace(/<\/?(?:response|answer|tool_call|tool_response|tool)>/gi, "")
    .replace(/\[(?:success|error|response)\]/gi, "")
    .trim();
  return { spoken: spoken || FALLBACK_REPLY };
};
