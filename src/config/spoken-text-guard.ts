/**
 * Keeps internal text out of speech. Small models sometimes print a tool call
 * as plain JSON instead of a real tool call, or echo markers such as
 * "[success]" and "<response>". An answer that starts with such markup is
 * held back until it is complete and then interpreted here.
 */

export const FALLBACK_REPLY = "Sorry, I didn't catch that. Could you say it again?";

export type ToolCallFromText = {
  function: { index: number; name: string; arguments: unknown };
};

/** True when an answer starting this way must not be spoken before it is complete. */
export const startsWithMarkup = (text: string): boolean => /^[{[<`]/.test(text.trimStart());

const parseArguments = (value: unknown): unknown => {
  if (value === undefined) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value; // Preserve malformed input so the executor rejects it.
    }
  }
  return value;
};

export const interpretHeldAnswer = (
  text: string,
  toolNames: Set<string>,
): { toolCall?: ToolCallFromText; spoken: string; deniedToolAttempts?: number } => {
  const body = text.trim().replace(/^(?:\[(?:success|error|response|rejected|unverified)\]\s*)+/i, "");
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
      // Fallback supports one call. Never silently execute just the first
      // member of a multi-call batch; report all its attempts for accounting.
      if (Array.isArray(parsed) && parsed.length > 1
        && parsed.some(item => typeof (item?.name ?? item?.function?.name) === "string")) {
        return { spoken: FALLBACK_REPLY, deniedToolAttempts: parsed.length };
      }
      if (typeof name === "string" && toolNames.has(name)) {
        // Explicit null is invalid input, not a missing no-argument object.
        const args = Object.prototype.hasOwnProperty.call(call, "arguments") ? call.arguments
          : Object.prototype.hasOwnProperty.call(call, "parameters") ? call.parameters
          : call.function?.arguments;
        return { toolCall: { function: { index: 0, name, arguments: parseArguments(args) } }, spoken: "" };
      }
      // Accounting only: this grants no tool call or execution permission.
      if (typeof name === "string") return { spoken: FALLBACK_REPLY, deniedToolAttempts: 1 };
    } catch {
      // Unparseable JSON-like text is not spoken either.
    }
    return { spoken: FALLBACK_REPLY };
  }

  const spoken = body
    .replace(/<\/?(?:response|answer|tool_call|tool_response|tool)>/gi, "")
    .replace(/\[(?:success|error|response|rejected|unverified)\]/gi, "")
    .trim();
  return { spoken: spoken || FALLBACK_REPLY };
};
