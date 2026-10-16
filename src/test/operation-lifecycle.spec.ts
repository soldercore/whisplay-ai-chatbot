import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { operationDeadline, waitForOperation, currentToolSignal, timeoutSetting } from "../utils/operation-lifecycle";
import { executeToolCall, ToolExecutionContext } from "../config/tool-execution";
import { readOllamaNDJSON } from "../cloud-api/local/ollama-ndjson";
import type { LLMTool } from "../type";

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(handler: () => Promise<string>, parent?: AbortSignal) {
  const tool: LLMTool = { execution: "abortable", type: "function", function: {
    name: "probe", description: "Fixture", parameters: {},
  }, func: handler };
  const context: ToolExecutionContext = { enabled: true, allowedTools: [tool], registeredTools: [tool],
    handlers: { probe: handler }, signal: parent };
  return { tool, context, run: () => executeToolCall("probe", {}, context) };
}

test("timeouts cannot be disabled by malformed, zero or overflowing configuration", () => {
  const previous = process.env.TEST_OPERATION_TIMEOUT;
  try {
    for (const value of ["0", "-1", "NaN", "Infinity", "9000000000", "1.5", ""]) {
      process.env.TEST_OPERATION_TIMEOUT = value;
      assert.equal(timeoutSetting("TEST_OPERATION_TIMEOUT", 123), 123);
    }
    process.env.TEST_OPERATION_TIMEOUT = "120000";
    assert.equal(timeoutSetting("TEST_OPERATION_TIMEOUT", 123), 120000);
  } finally { if (previous === undefined) delete process.env.TEST_OPERATION_TIMEOUT; else process.env.TEST_OPERATION_TIMEOUT = previous; }
});

test("deadlines propagate parent cancellation and release their listener", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const deadline = operationDeadline(100, parent.signal);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  parent.abort(new Error("parent cancelled"));
  assert.equal(deadline.signal.aborted, true);
  assert.match(deadline.signal.reason.message, /parent cancelled/);
  deadline.dispose();
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  const finished = operationDeadline(20);
  finished.dispose();
  t.mock.timers.tick(100);
  assert.equal(finished.signal.aborted, false);
});

test("cancelled waits settle once and dispose responses that arrive later", async () => {
  const controller = new AbortController();
  let deliver!: (value: number) => void;
  const disposed: number[] = [];
  const completion = waitForOperation(new Promise<number>(resolve => { deliver = resolve; }), controller.signal,
    value => disposed.push(value));
  const rejected = assert.rejects(completion, /cancelled/);
  controller.abort(new Error("cancelled"));
  await rejected;
  deliver(42); await flush();
  assert.deepEqual(disposed, [42]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("unsupported lifecycle contract fails closed before handler invocation", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return "[success]done"; });
  delete f.tool.execution;
  assert.equal((await f.run()).status, "rejected");
  assert.equal(calls, 0);
});

test("tool timeout aborts its actual operation, clears timers, and never retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = process.env.TOOL_EXECUTION_TIMEOUT_MS;
  process.env.TOOL_EXECUTION_TIMEOUT_MS = "50";
  let calls = 0, effects = 0, aborted = 0;
  const f = fixture(() => new Promise(resolve => {
    calls++;
    const timer = setTimeout(() => { effects++; resolve("[success]late"); }, 100);
    currentToolSignal()!.addEventListener("abort", () => {
      aborted++; clearTimeout(timer); resolve("[unverified]cancelled");
    }, { once: true });
  }));
  try {
    const completion = f.run(); await flush();
    t.mock.timers.tick(50);
    assert.equal((await completion).status, "unverified");
    t.mock.timers.tick(1000); await flush();
    assert.equal(aborted, 1); assert.equal(calls, 1); assert.equal(effects, 0);
  } finally { if (previous === undefined) delete process.env.TOOL_EXECUTION_TIMEOUT_MS; else process.env.TOOL_EXECUTION_TIMEOUT_MS = previous; }
});

test("parallel tools have isolated signals and bounded global admission", async () => {
  const parents = Array.from({ length: 4 }, () => new AbortController());
  const signals: AbortSignal[] = [];
  const f = fixture(() => new Promise(resolve => {
    const signal = currentToolSignal()!; signals.push(signal);
    signal.addEventListener("abort", () => resolve("[unverified]cancelled"), { once: true });
  }));
  const pending = parents.map(parent => executeToolCall("probe", {}, { ...f.context, signal: parent.signal }));
  await flush();
  assert.equal((await f.run()).status, "rejected");
  parents[0].abort(); await flush();
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  for (const parent of parents) parent.abort();
  await Promise.all(pending);
  assert.equal((await fixture(async () => "[success]free").run()).status, "success");
  for (const parent of parents) assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("tool output cap counts UTF-8 bytes and preserves exact-limit results", async () => {
  const exact = "[success]" + "æ".repeat(32763) + "x";
  assert.equal(Buffer.byteLength(exact), 65536);
  assert.equal((await fixture(async () => exact).run()).output, exact);
  assert.equal((await fixture(async () => exact + "ø").run()).status, "unverified");
});

test("NDJSON idle timeout destroys the stream and releases timers and abort listeners", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = process.env.OLLAMA_STREAM_IDLE_TIMEOUT_MS;
  process.env.OLLAMA_STREAM_IDLE_TIMEOUT_MS = "50";
  const stream = new PassThrough(), parent = new AbortController();
  const completion = readOllamaNDJSON(stream, () => {}, undefined, parent.signal);
  const rejected = assert.rejects(completion, /idle timeout/);
  stream.write('{"incomplete":');
  t.mock.timers.tick(49); assert.equal(stream.destroyed, false);
  t.mock.timers.tick(1); await rejected;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(stream.destroyed, true);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  for (const event of ["data", "end", "error", "close"]) assert.equal(stream.listenerCount(event), 0);
  if (previous === undefined) delete process.env.OLLAMA_STREAM_IDLE_TIMEOUT_MS; else process.env.OLLAMA_STREAM_IDLE_TIMEOUT_MS = previous;
});

test("NDJSON success and external abort both remove their lifecycle listeners", async () => {
  for (const abort of [false, true]) {
    const stream = new PassThrough(), parent = new AbortController();
    const completion = readOllamaNDJSON(stream, () => {}, undefined, parent.signal);
    if (abort) {
      const rejected = assert.rejects(completion, /fixture cancellation/);
      parent.abort(new Error("fixture cancellation")); await rejected;
      assert.equal(stream.destroyed, true);
    } else { stream.end('{"done":true}\n'); await completion; }
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    assert.equal(stream.listenerCount("data"), 0);
  }
});

test("queued transport abort error is consumed and its error sink is removed on close", async () => {
  const stream = new PassThrough(), parent = new AbortController();
  parent.signal.addEventListener("abort", () => stream.destroy(new Error("queued transport error")), { once: true });
  const completion = readOllamaNDJSON(stream, () => {}, undefined, parent.signal);
  const rejected = assert.rejects(completion, /cancelled/);
  parent.abort(new Error("cancelled"));
  await rejected;
  await new Promise<void>(resolve => setImmediate(resolve));
  for (const event of ["data", "end", "error", "close"]) assert.equal(stream.listenerCount(event), 0);
});
