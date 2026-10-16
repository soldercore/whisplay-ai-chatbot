import type { LLMTool } from "../type";

export type ToolExecutionResult = {
  status: "success" | "rejected" | "error" | "unverified";
  // Success means the trusted handler reported success, not verified goal completion.
  output: string;
};

export type ToolExecutionContext = {
  enabled: boolean;
  allowedTools: readonly LLMTool[];
  registeredTools: readonly LLMTool[];
  handlers: Readonly<Record<string, (args: any) => Promise<string>>>;
  signal?: AbortSignal;
};

// Reserved even if an external plugin tries to register the old command names.
export const BLOCKED_TOOL_NAMES = new Set(["runCommand", "checkCommand", "stopCommand"]);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const SCHEMA_KEYS = new Set([
  "type", "properties", "required", "items", "enum", "additionalProperties",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  "description", "title", "default",
]);

// Validate the supported JSON-schema subset before looking at values. Unsupported
// constraints fail closed, including constraints on optional fields not supplied.
function validSchema(schema: unknown, depth = 0): boolean {
  if (!record(schema) || depth > 12 || Object.keys(schema).some((key) => !SCHEMA_KEYS.has(key))) return false;
  if (schema.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return false;
  if (schema.properties !== undefined && (!record(schema.properties) || Object.entries(schema.properties).some(
    ([key, child]) => ["__proto__", "constructor", "prototype"].includes(key) || !validSchema(child, depth + 1),
  ))) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(
    (key: unknown) => typeof key !== "string" || !own(schema.properties || {}, key),
  ))) return false;
  if (schema.items !== undefined && !validSchema(schema.items, depth + 1)) return false;
  if (schema.type === "array" && schema.items === undefined) return false;
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    const bound = schema[key];
    const lengthBound = key.endsWith("Length") || key.endsWith("Items");
    if (bound !== undefined && (!Number.isFinite(bound)
      || lengthBound && (!Number.isInteger(bound) || bound < 0))) return false;
  }
  return true;
}

function matchesSchema(value: unknown, schema: Record<string, any>, root = false, depth = 0): boolean {
  if (depth > 12) return false;
  const type = schema.type || (root || schema.properties ? "object" : undefined);
  if (!type) return false;
  if (schema.enum && !schema.enum.some((item: unknown) => JSON.stringify(item) === JSON.stringify(value))) return false;
  switch (type) {
    case "object": {
      if (!record(value)) return false;
      const properties = schema.properties || {};
      if ((schema.required || []).some((key: string) => !own(value, key))) return false;
      return Object.keys(value).every((key) => own(properties, key)
        ? matchesSchema(value[key], properties[key], false, depth + 1)
        : schema.additionalProperties === true);
    }
    case "array": return Array.isArray(value) && value.length <= (schema.maxItems ?? 1024)
      && value.length >= (schema.minItems ?? 0)
      && value.every((item) => matchesSchema(item, schema.items, false, depth + 1));
    case "string": return typeof value === "string" && value.length >= (schema.minLength ?? 0)
      && value.length <= (schema.maxLength ?? 32768);
    case "number":
    case "integer": return typeof value === "number" && Number.isFinite(value)
      && (type !== "integer" || Number.isInteger(value))
      && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

// JSON-only, bounded snapshot: no coercion, accessors, prototypes or mutation of
// arguments after validation. No serialization hooks are called on model input.
function copyArguments(value: unknown, depth = 0, budget = { nodes: 4096 }): any {
  if (--budget.nodes < 0 || depth > 12) throw new Error("argument bounds");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !record(value)) throw new Error("non-JSON argument");
  if (Object.getOwnPropertySymbols(value).length) throw new Error("non-JSON key");
  const copy: any = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("unsafe key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!own(descriptor, "value")) throw new Error("accessor argument");
    copy[key] = copyArguments(descriptor.value, depth + 1, budget);
  }
  return copy;
}

export async function executeToolCall(
  name: unknown, args: unknown, context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const reject = (reason: string): ToolExecutionResult => ({ status: "rejected", output: `[rejected]${reason}` });
  if (!context.enabled) return reject("Tool execution is disabled.");
  if (context.signal?.aborted) return reject("The request was cancelled.");
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(name)) return reject("Invalid tool name.");
  if (BLOCKED_TOOL_NAMES.has(name)) return reject("General command execution is disabled pending a safe implementation.");
  const registered = context.registeredTools.filter((tool) => tool.function.name === name);
  if (registered.length !== 1 || !own(context.handlers, name)) return reject("Unknown or ambiguous tool.");
  const allowed = context.allowedTools.filter((tool) => tool.function.name === name);
  if (allowed.length !== 1) return reject("The tool is not allowed for this request.");
  const tool = registered[0];
  let validated: Record<string, unknown>;
  try {
    validated = copyArguments(args);
    if (JSON.stringify(validated).length > 65536 || !record(validated)
      || !validSchema(tool.function.parameters)
      || !matchesSchema(validated, tool.function.parameters, true)) return reject("Invalid tool arguments or unsupported schema.");
  } catch {
    return reject("Invalid tool arguments.");
  }
  if (context.signal?.aborted) return reject("The request was cancelled.");
  try {
    const output: unknown = await context.handlers[name](validated);
    if (context.signal?.aborted) return { status: "unverified", output: "[unverified]The request was cancelled after the tool started; completion is unknown." };
    if (typeof output !== "string" || !output.trim()) return { status: "unverified", output: "[unverified]The tool returned no usable result; completion is unknown." };
    if (output.startsWith("[rejected]")) return { status: "rejected", output };
    if (output.startsWith("[error]")) return { status: "error", output };
    if (output.startsWith("[success]") || output.startsWith("[response]")) return { status: "success", output };
    return { status: "unverified", output: output.startsWith("[unverified]") ? output : `[unverified]${output}` };
  } catch {
    // An exception may occur after a side effect. Never claim nothing happened.
    return { status: "error", output: "[error]The tool failed during execution; completion was not verified." };
  }
}
