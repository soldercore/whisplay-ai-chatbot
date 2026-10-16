import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { getEventListeners } from "node:events";
import axios from "axios";

const originalPost = axios.post;
const requests: any[] = [], streams: PassThrough[] = [], signals: AbortSignal[] = [];
let plans: ("silent" | "headers" | "late" | "tool" | "pending-tool" | "normal")[] = [];
let late!: (value: any) => void;
let effects = 0;
const providerPath = require.resolve("../cloud-api/local/ollama-llm");
let provider: any;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const line = (record: unknown) => JSON.stringify(record) + "\n";
const proposal = { message: { tool_calls: [{ function: { name: "lifecycleProbe", arguments: {} } }] } };
before(() => {
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/);
  Object.assign(process.env, { LLM_SERVER: "test", OLLAMA_ENABLE_TOOLS: "true", WEB_SEARCH_ENABLED: "false",
    MEMORY_ENABLED: "false", CONTEXT_AUTO_COMPACT_ENABLED: "false", ENABLE_THINKING: "false",
    OLLAMA_REQUEST_TIMEOUT_MS: "100", OLLAMA_STREAM_IDLE_TIMEOUT_MS: "50" });
  require("../plugin").pluginRegistry.register({ name: "lifecycle-fixture", displayName: "Fixture", type: "llm-tools", version: "1",
    activate: () => ({ getTools: () => [{ execution: "bounded", type: "function", function: {
      name: "lifecycleProbe", description: "Fixture", parameters: {},
    }, func: async () => { effects++; return "[success]done"; } }] }) });
  axios.post = (async (_url: string, body: any, config: any) => {
    requests.push(body); signals.push(config.signal);
    const plan = plans.shift() || "normal";
    if (plan === "late") return new Promise(resolve => { late = resolve; });
    if (plan === "headers") return new Promise((_resolve, reject) => {
      config.signal.addEventListener("abort", () => reject(config.signal.reason), { once: true });
    });
    const stream = new PassThrough(); streams.push(stream);
    // Microtasks give the real provider time to attach its reader.
    void flush().then(() => {
      if (stream.destroyed) return;
      if (plan === "tool" || plan === "pending-tool") stream.write(line(proposal));
      if (plan === "normal") stream.end(line({ message: { content: "Normal." }, done: true }));
      else if (plan === "tool") stream.end(line({ done: true }));
      else stream.write('{"partial":');
    });
    return { data: stream };
  }) as typeof axios.post;
});
beforeEach(() => {
  requests.length = 0; streams.length = 0; signals.length = 0; effects = 0; plans = [];
  process.env.OLLAMA_MAX_TOOL_ROUNDS = "4";
  delete require.cache[providerPath]; provider = require("../cloud-api/local/ollama-llm").default;
});
after(() => { axios.post = originalPost; });
afterEach(async () => {
  provider.cancelActiveRequest();
  for (const stream of streams) stream.destroy();
  await new Promise<void>(resolve => setImmediate(resolve));
});
function ask(question = "Use a lifecycle probe if needed.") {
  const result = { text: "", ends: 0, events: [] as string[] };
  const done = provider.chatWithLLMStream([{ role: "user", content: question }], (text: string) => result.text += text,
    () => result.ends++, undefined, (name: string) => result.events.push(name));
  return { result, done };
}

test("total request deadline aborts an HTTP operation waiting for headers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); plans = ["headers"];
  const running = ask(); await flush();
  t.mock.timers.tick(100); await running.done;
  assert.equal(signals[0].aborted, true);
  assert.equal(running.result.text, "The request timed out. Completion was not verified.");
  assert.equal(running.result.ends, 1);
  assert.equal(effects, 0);
});

test("late HTTP responses after cancellation are destroyed, not parsed", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); plans = ["late"];
  const running = ask(); await flush(); t.mock.timers.tick(100); await running.done;
  const stream = new PassThrough(); late({ data: stream }); await flush();
  assert.equal(stream.destroyed, true);
  assert.equal(running.result.ends, 1); assert.equal(effects, 0);
});

test("idle stream timeout does not dispatch complete pending tool proposals", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); plans = ["pending-tool"];
  const running = ask(); await flush(); t.mock.timers.tick(50); await running.done;
  assert.equal(running.result.text, "The request timed out. Completion was not verified.");
  assert.equal(running.result.ends, 1); assert.equal(effects, 0);
  assert.equal(streams[0].destroyed, true);
  assert.deepEqual(running.result.events, []);
  for (const signal of signals) assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("explicit cancellation ends the request, drops abandoned history and never emits a later promise", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  plans = ["silent"];
  const running = ask("Abandon this question."); await flush();
  provider.cancelActiveRequest(); await running.done;
  assert.equal(running.result.text, ""); assert.equal(running.result.ends, 1);
  assert.equal(streams[0].destroyed, true);
  plans = ["normal"]; const next = ask("New question."); await next.done;
  assert.equal(next.result.text, "Normal.");
  assert.deepEqual(requests[1].messages.slice(1), [{ role: "user", content: "New question." }]);
});

test("final no-tools timeout removes unexecuted proposal and keeps earlier completed results", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  process.env.OLLAMA_MAX_TOOL_ROUNDS = "1";
  delete require.cache[providerPath]; provider = require("../cloud-api/local/ollama-llm").default;
  plans = ["tool", "tool", "silent"];
  const running = ask();
  for (let i = 0; i < 10 && requests.length < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.length, 3);
  t.mock.timers.tick(50); await running.done;
  assert.equal(effects, 1); assert.equal(running.result.ends, 1);
  plans = ["normal"]; await ask("Continue.").done;
  const history = requests[3].messages.slice(1);
  assert.equal(history.filter((m: any) => m.tool_calls?.length).length, 1);
  assert.deepEqual(history.filter((m: any) => m.role === "tool"), [{ role: "tool", tool_name: "lifecycleProbe", content: "[success]done" }]);
  assert.equal(history[history.length - 2].content, "The request timed out. Completion was not verified.");
});

test("successful completion disposes request deadlines and keeps lifecycle metadata off the wire", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); plans = ["tool", "normal"];
  const running = ask(); await running.done;
  t.mock.timers.tick(1000);
  assert.equal(running.result.text, "Normal."); assert.equal(running.result.ends, 1);
  assert.equal(effects, 1);
  assert.equal(JSON.stringify(requests[0].tools).includes('"execution"'), false);
  assert.equal(signals[0].aborted, false);
  for (const signal of signals) assert.equal(getEventListeners(signal, "abort").length, 0);
});

test("oversized user input cannot start generation or enter retained history", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const running = ask("x".repeat(262144)); await running.done;
  assert.match(running.result.text, /Resource limit exceeded: user input exceeds 262144 UTF-8 bytes/);
  assert.equal(running.result.ends, 1); assert.equal(requests.length, 0);
  plans = ["normal"]; await ask("Continue.").done;
  assert.deepEqual(requests[0].messages.slice(1).map((message: any) => message.content), [
    "[Input omitted: exceeds 262144 UTF-8 bytes.]", running.result.text, "Continue.",
  ]);
});
