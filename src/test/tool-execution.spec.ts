import { test } from "node:test";
import assert from "node:assert/strict";
import { executeToolCall, ToolExecutionContext } from "../config/tool-execution";
import type { LLMTool, ToolParameterSchema } from "../type";

function fixture(schema: ToolParameterSchema = {
  type: "object", properties: { percent: { type: "number", minimum: 0, maximum: 100 } }, required: ["percent"],
}) {
  const calls: unknown[] = [];
  const tool: LLMTool = { execution: "bounded", type: "function", function: { name: "setVolume", description: "test", parameters: schema },
    func: async (args) => { calls.push(args); return "[success]Volume changed."; } };
  const context: ToolExecutionContext = { enabled: true, allowedTools: [tool], registeredTools: [tool],
    handlers: Object.assign(Object.create(null), { setVolume: tool.func }) };
  return { calls, tool, context };
}

test("disabled, unoffered, unknown and inherited tool names have zero side effects", async () => {
  for (const mode of ["disabled", "unoffered", "unknown", "toString", "constructor", "__proto__"]) {
    const { calls, context } = fixture();
    if (mode === "disabled") context.enabled = false;
    if (mode === "unoffered") context.allowedTools = [];
    const name = ["disabled", "unoffered"].includes(mode) ? "setVolume" : mode;
    assert.equal((await executeToolCall(name, { percent: 40 }, context)).status, "rejected", mode);
    assert.deepEqual(calls, []);
  }
});

test("type, range, required, extra fields, prototypes and argument bounds reject before invocation", async () => {
  for (const args of [undefined, null, [], "{}", {}, { percent: "40" }, { percent: true },
    { percent: -1 }, { percent: 101 }, { percent: NaN }, { percent: Infinity },
    { percent: 40, command: "pwd; true" }, JSON.parse('{"percent":40,"__proto__":{}}'),
    Object.create({ percent: 40 }), { percent: "x".repeat(70000) }]) {
    const { calls, context } = fixture();
    assert.equal((await executeToolCall("setVolume", args, context)).status, "rejected");
    assert.deepEqual(calls, []);
  }
});

test("accessor arguments are not evaluated and validated input is a separate snapshot", async () => {
  const { calls, context } = fixture();
  let reads = 0;
  const malicious = { get percent() { reads++; return 40; } };
  assert.equal((await executeToolCall("setVolume", malicious, context)).status, "rejected");
  assert.equal(reads, 0);
  const args = { percent: 40 };
  const pending = executeToolCall("setVolume", args, context);
  args.percent = 101;
  assert.equal((await pending).status, "success");
  assert.deepEqual(calls, [{ percent: 40 }]);
});

test("enum, array items, nested required fields and no-argument schemas are enforced", async () => {
  const { context, calls } = fixture({ type: "object", properties: {
    action: { type: "string", enum: ["read", "list"] },
    items: { type: "array", minItems: 1, maxItems: 2, items: { type: "object",
      properties: { name: { type: "string", minLength: 1, maxLength: 8 } }, required: ["name"] } },
  }, required: ["action", "items"] });
  for (const args of [{ action: "delete", items: [{ name: "a" }] }, { action: "read", items: [] },
    { action: "read", items: [{}] }, { action: "read", items: [{ name: "" }] },
    { action: "read", items: [{ name: "a", extra: true }] }]) {
    assert.equal((await executeToolCall("setVolume", args, context)).status, "rejected");
  }
  assert.equal(calls.length, 0);
  assert.equal((await executeToolCall("setVolume", { action: "read", items: [{ name: "a" }] }, context)).status, "success");
  const noArgs = fixture({});
  assert.equal((await executeToolCall("setVolume", {}, noArgs.context)).status, "success");
  assert.equal((await executeToolCall("setVolume", { surprise: 1 }, noArgs.context)).status, "rejected");
});

test("reserved command tools remain blocked even if a plugin registers them", async () => {
  for (const name of ["runCommand", "checkCommand", "stopCommand"]) {
    const { context, tool, calls } = fixture({ type: "object", properties: { command: { type: "string" } } });
    tool.function.name = name;
    (context.handlers as any)[name] = tool.func;
    for (const command of ["pwd", "pwd; true", "find /tmp -exec true {} +", "awk 'BEGIN{system(\"true\")}'", "echo x > file", "$(true)"]) {
      assert.equal((await executeToolCall(name, { command }, context)).status, "rejected");
    }
    assert.deepEqual(calls, []);
  }
});

test("unsupported schemas and duplicate definitions fail closed", async () => {
  const { context, tool, calls } = fixture();
  (tool.function.parameters as any).pattern = "anything";
  assert.equal((await executeToolCall("setVolume", { percent: 40 }, context)).status, "rejected");
  delete (tool.function.parameters as any).pattern;
  context.registeredTools = [tool, tool];
  assert.equal((await executeToolCall("setVolume", { percent: 40 }, context)).status, "rejected");
  assert.deepEqual(calls, []);
});

test("handler success, rejection, failure and unknown output are distinct", async () => {
  for (const [output, status] of [["[success]done", "success"], ["[response]description", "success"],
    ["[rejected]no permission", "rejected"], ["[error]failed", "error"], ["Done!", "unverified"], ["", "unverified"], [undefined, "unverified"]]) {
    const { context } = fixture();
    (context.handlers as any).setVolume = async () => output;
    assert.equal((await executeToolCall("setVolume", { percent: 40 }, context)).status, status);
  }
  const { context } = fixture();
  (context.handlers as any).setVolume = () => { throw new Error("secret must not reach output"); };
  const failure = await executeToolCall("setVolume", { percent: 40 }, context);
  assert.equal(failure.status, "error");
  assert.equal(failure.output.includes("secret"), false);
});

test("cancellation before dispatch rejects; cancellation after start never claims success", async () => {
  const { context, calls } = fixture();
  const controller = new AbortController();
  context.signal = controller.signal;
  controller.abort();
  assert.equal((await executeToolCall("setVolume", { percent: 40 }, context)).status, "rejected");
  assert.deepEqual(calls, []);
  const next = new AbortController();
  context.signal = next.signal;
  (context.handlers as any).setVolume = async () => { next.abort(); return "[success]done"; };
  assert.equal((await executeToolCall("setVolume", { percent: 40 }, context)).status, "unverified");
});
