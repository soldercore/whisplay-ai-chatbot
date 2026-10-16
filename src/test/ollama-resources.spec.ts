import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import axios from "axios";
import { readOllamaNDJSON } from "../cloud-api/local/ollama-ndjson";

const line = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const finish = (content = "Finished.") => [line({ message: { content }, done: true })];
const call = (label: unknown, name = "budgetProbe") => ({ function: {
  index: 0, name, arguments: name === "web_search" ? { query: label } : { label },
} });
const calls = (...items: object[]) => [line({ message: { tool_calls: items } }), line({ done: true })];
const fallback = (label: string) => finish(JSON.stringify({ name: "budgetProbe", arguments: { label } }));
const limitReply = (reason: string) => `Resource limit exceeded: ${reason}. Tool execution stopped for this request. Completion was not verified.`;
const responseCallsError = limitReply("model response exceeds 4 tool calls");
const requestCallsError = limitReply("user request exceeds 8 tool attempts");
const responseBytesError = limitReply("model response exceeds 2097152 transport bytes");
const requestBytesError = limitReply("user request exceeds 8388608 transport bytes");
const textError = limitReply("model response exceeds 262144 content/thinking UTF-8 bytes");

// Exact raw wire length, independently constructed using many small valid
// records. Padding is not content/thinking, and no record approaches 1 MiB.
function transport(size: number, tail = finish()) {
  const chunks: Buffer[] = [];
  let remaining = size - tail.reduce((sum, chunk) => sum + chunk.length, 0);
  const overhead = line({ padding: "" }).length;
  assert.ok(remaining >= 0);
  while (remaining >= overhead) {
    const length = Math.min(65536, remaining);
    chunks.push(line({ padding: "x".repeat(length - overhead) }));
    remaining -= length;
  }
  if (remaining) chunks.push(Buffer.from("\n".repeat(remaining)));
  chunks.push(...tail);
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.length, 0), size);
  return chunks;
}

let plans: Buffer[][] = [];
const requests: any[] = [], effects: unknown[] = [], errors: string[] = [];
const originalPost = axios.post, originalError = console.error, originalWarn = console.warn;
const providerPath = require.resolve("../cloud-api/local/ollama-llm");
let provider: any;

before(() => {
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/);
  Object.assign(process.env, { LLM_SERVER: "test", ASR_SERVER: "test", TTS_SERVER: "test",
    OLLAMA_MODEL: "test", OLLAMA_ENABLE_TOOLS: "true", WEB_SEARCH_ENABLED: "true",
    MEMORY_ENABLED: "false", WAKE_WORD_ENABLED: "false", CONTEXT_AUTO_COMPACT_ENABLED: "false" });
  require("../plugin").pluginRegistry.register({ name: "budget-fixture", displayName: "Budget fixture",
    version: "1", type: "llm-tools", activate: () => ({ getTools: () => [{ type: "function",
      function: { name: "budgetProbe", description: "Fixture", parameters: { type: "object",
        properties: { label: { type: "string" } }, required: ["label"] } },
      func: async ({ label }: { label: string }) => { effects.push(label); return `[success]${label}`; },
    }] }) });
  require("../config/llm-tools").llmFuncMap.web_search = async ({ query }: { query: string }) => {
    effects.push(query); return `[success]${query}`;
  };
  axios.post = (async (_url: string, body: any) => {
    requests.push(body);
    const chunks = plans.shift() || finish("Unexpected extra request.");
    const stream = new PassThrough();
    setImmediate(() => { for (const chunk of chunks) { if (stream.destroyed) break; stream.write(chunk); } stream.end(); });
    return { data: stream };
  }) as typeof axios.post;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});
beforeEach(() => { plans = []; requests.length = 0; effects.length = 0; errors.length = 0; });
after(() => { axios.post = originalPost; console.error = originalError; console.warn = originalWarn; });

function client(rounds = 4, enabled = true) {
  Object.assign(process.env, { OLLAMA_MAX_TOOL_ROUNDS: String(rounds), OLLAMA_ENABLE_TOOLS: String(enabled) });
  delete require.cache[providerPath];
  provider = require("../cloud-api/local/ollama-llm").default;
  return provider;
}
async function ask(question = "Use the approved probe.", selected = provider) {
  let answer = "", thinking = "", ends = 0;
  await selected.chatWithLLMStream([{ role: "user", content: question }],
    (part: string) => answer += part, () => ends++, (part: string) => thinking += part);
  assert.equal(ends, 1);
  return { answer, thinking };
}
async function nextHistory() {
  plans = [finish("Next answer.")];
  await ask("Continue normally.");
  return requests[requests.length - 1].messages.slice(1);
}
const result = (label: string) => ({ role: "tool", tool_name: "budgetProbe", content: `[success]${label}` });
const assistantCalls = (...labels: string[]) => ({ role: "assistant", content: "", tool_calls: labels.map(label => call(label)) });

test("tool response limits admit three and four calls, reject five atomically", async () => {
  for (const size of [3, 4, 5]) {
    client(); effects.length = 0; requests.length = 0;
    const labels = Array.from({ length: size }, (_, i) => `item${i}`);
    plans = [calls(...labels.map(label => call(label)))];
    if (size <= 4) plans.push(finish());
    const answer = await ask();
    assert.deepEqual(effects, size <= 4 ? labels : []);
    assert.equal(answer.answer, size <= 4 ? "Finished." : responseCallsError);
    assert.equal(requests.length, size <= 4 ? 2 : 1);
  }
});

test("request limit admits seven/eight attempts and rejects the ninth without executing it", async () => {
  for (const total of [7, 8, 9]) {
    client(); effects.length = 0;
    plans = [calls(...["a", "b", "c", "d"].map(label => call(label))),
      calls(...["e", "f", "g", ...(total >= 8 ? ["h"] : [])].map(label => call(label)))];
    plans.push(total === 9 ? calls(call("i")) : finish());
    const answer = await ask();
    assert.equal(answer.answer, total === 9 ? requestCallsError : "Finished.");
    assert.deepEqual(effects, total === 7 ? ["a", "b", "c", "d", "e", "f", "g"] : ["a", "b", "c", "d", "e", "f", "g", "h"]);
  }
});

test("remaining two attempts cannot partially admit a four-call batch; earlier history survives", async () => {
  client();
  plans = [calls(call("a"), call("b"), call("c")), calls(call("d"), call("e"), call("f")),
    calls(call("g"), call("h"), call("i"), call("j"))];
  assert.equal((await ask()).answer, requestCallsError);
  assert.deepEqual(effects, ["a", "b", "c", "d", "e", "f"]);
  assert.equal(requests.length, 3);
  assert.deepEqual(await nextHistory(), [
    { role: "user", content: "Use the approved probe." }, assistantCalls("a", "b", "c"), result("a"), result("b"), result("c"),
    assistantCalls("d", "e", "f"), result("d"), result("e"), result("f"),
    { role: "assistant", content: requestCallsError }, { role: "user", content: "Continue normally." },
  ]);
});

test("oversized native batches leave no tool metadata or fabricated results in subsequent history", async () => {
  client(); plans = [calls(...["a", "b", "c", "d", "e"].map(label => call(label)))];
  assert.equal((await ask()).answer, responseCallsError);
  assert.deepEqual(await nextHistory(), [{ role: "user", content: "Use the approved probe." },
    { role: "assistant", content: responseCallsError }, { role: "user", content: "Continue normally." }]);
  assert.deepEqual(effects, []);
});

test("native and JSON fallback share the eight-attempt request budget", async () => {
  client(10);
  plans = [calls(call("a"), call("b"), call("c"), call("d")), fallback("e"), fallback("f"), fallback("g"), fallback("h"), fallback("i")];
  assert.equal((await ask()).answer, requestCallsError);
  assert.deepEqual(effects, ["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.equal(requests.length, 6);
});

test("automatic search consumes the same request budget", async () => {
  client();
  const question = "What is the weather in Oslo today?";
  plans = [calls(...["a", "b", "c", "d"].map(label => call(label, "web_search"))),
    calls(...["e", "f", "g"].map(label => call(label, "web_search"))), calls(call("h", "web_search"))];
  assert.equal((await ask(question)).answer, requestCallsError);
  assert.deepEqual(effects, [question, "a", "b", "c", "d", "e", "f", "g"]);
});

test("authorization/validation rejects never execute; admitted valid operations still run", async () => {
  client(); plans = [calls(call("a"), call("blocked", "unknownTool"), call(42), call("b"))];
  assert.equal((await ask()).answer, "I couldn't run the requested tool. Completion was not verified.");
  assert.deepEqual(effects, ["a", "b"]);
  assert.equal(requests.length, 1, "Phase 1 rejection still terminates; there is no invalid-call retry path");
});

test("independent requests have independent counters without resetting conversation history", async () => {
  client();
  for (let turn = 0; turn < 2; turn++) {
    plans = [calls(call("a"), call("b"), call("c"), call("d")), calls(call("e"), call("f"), call("g"), call("h")), finish()];
    assert.equal((await ask()).answer, "Finished.");
  }
  assert.deepEqual(effects, ["a", "b", "c", "d", "e", "f", "g", "h", "a", "b", "c", "d", "e", "f", "g", "h"]);
});

test("raw per-response transport accepts below/exactly 2 MiB, rejects one byte over", async () => {
  for (const size of [2097151, 2097152, 2097153]) {
    client(); plans = [transport(size)];
    assert.equal((await ask()).answer, size <= 2097152 ? "Finished." : responseBytesError);
    assert.deepEqual(effects, []);
  }
});

test("raw request transport accepts exactly 8 MiB and rejects the next byte", async () => {
  for (const overflow of [false, true]) {
    client(); effects.length = 0;
    plans = [transport(2097152, calls(call("a"))), transport(2097152, calls(call("b"))),
      transport(2097152, calls(call("c"))), transport(2097152, overflow ? calls(call("d")) : finish())];
    if (overflow) plans.push([Buffer.from("\n")]);
    assert.equal((await ask()).answer, overflow ? requestBytesError : "Finished.");
    assert.deepEqual(effects, overflow ? ["a", "b", "c", "d"] : ["a", "b", "c"]);
  }
});

test("transport accounting is isolated between independent requests", async () => {
  client();
  for (let turn = 0; turn < 2; turn++) {
    plans = [transport(2097152, calls(call("a"))), transport(2097152, calls(call("b"))),
      transport(2097152, calls(call("c"))), transport(2097152)];
    assert.equal((await ask()).answer, "Finished.");
  }
});

test("combined content/thinking uses UTF-8 bytes, including fragmented multibyte characters", async () => {
  const content = "æøå".repeat(20000); // 120,000 UTF-8 bytes.
  for (const extra of [0, 1]) {
    client();
    const thinking = "x".repeat(142144 + extra);
    const bytes = line({ message: { content, thinking }, done: true });
    const cut = bytes.indexOf(Buffer.from("ø")) + 1;
    plans = [[bytes.subarray(0, cut), bytes.subarray(cut)]];
    const answer = await ask();
    assert.equal(answer.answer, extra ? textError : content);
    assert.equal(answer.thinking, extra ? "" : thinking);
  }
});

test("content/thinking accumulates across records and blocks pending tool execution on failure", async () => {
  for (const pending of [calls(call("pending"))[0], fallback("pending")[0]]) {
    client(); requests.length = 0;
    plans = [[pending, line({ message: { thinking: "x".repeat(131072) } }),
      line({ message: { thinking: "y".repeat(131073) } }), line({ done: true })]];
    const answer = await ask();
    assert.equal(answer.answer, textError);
    assert.deepEqual(effects, []);
    assert.equal(requests.length, 1);
  }
});

test("transport failure discards failed-round history and pending tools, preserving prior results", async () => {
  client(); plans = [calls(call("earlier")), transport(2097153, [line({ message: { content: "Uncommitted." } }), ...calls(call("pending"))])];
  assert.match((await ask()).answer, /Resource limit exceeded/);
  assert.deepEqual(effects, ["earlier"]);
  assert.deepEqual(await nextHistory(), [{ role: "user", content: "Use the approved probe." },
    assistantCalls("earlier"), result("earlier"), { role: "assistant", content: responseBytesError },
    { role: "user", content: "Continue normally." }]);
});

test("final no-tools responses enforce transport and text limits without retaining rejected pending calls", async () => {
  for (const [chunks, expected] of [[transport(2097153), responseBytesError],
    [[line({ message: { content: "x".repeat(262145) }, done: true })], textError]] as const) {
    client(0); plans = [calls(call("pending")), [...chunks]];
    assert.equal((await ask()).answer, expected);
    assert.equal(requests[1].tools, undefined);
    assert.deepEqual(effects, []);
    assert.deepEqual(await nextHistory(), [{ role: "user", content: "Use the approved probe." },
      { role: "assistant", content: expected }, { role: "user", content: "Continue normally." }]);
  }
});

test("final no-tools responses consume the remaining request transport budget", async () => {
  client(); plans = [transport(2097152, calls(call("a"))), transport(2097152, calls(call("b"))),
    transport(2097152, calls(call("c"))), transport(2097152, calls(call("a"))), finish()];
  assert.equal((await ask()).answer, requestBytesError);
  assert.equal(requests[4].tools, undefined);
  assert.deepEqual(effects, ["a", "b", "c"]);
  assert.deepEqual(await nextHistory(), [{ role: "user", content: "Use the approved probe." },
    assistantCalls("a"), result("a"), assistantCalls("b"), result("b"), assistantCalls("c"), result("c"),
    { role: "assistant", content: requestBytesError }, { role: "user", content: "Continue normally." }]);
});

test("disabled tools and invalid arguments still fail closed within resource limits", async () => {
  for (const [enabled, name] of [[false, "budgetProbe"], [true, "runCommand"], [true, "checkCommand"], [true, "stopCommand"]] as const) {
    client(4, enabled); plans = [calls(call("blocked", name))];
    assert.equal((await ask()).answer, "I couldn't run the requested tool. Completion was not verified.");
    assert.deepEqual(effects, []);
  }
});

test("multi-call JSON fallback is never partially executed or used to bypass batch limits", async () => {
  for (const size of [2, 5]) {
    client(); effects.length = 0;
    plans = [finish(JSON.stringify(Array.from({ length: size }, (_, i) => ({ name: "budgetProbe", arguments: { label: `item${i}` } }))))];
    assert.equal((await ask()).answer, size > 4 ? responseCallsError : "Sorry, I didn't catch that. Could you say it again?");
    assert.deepEqual(effects, []);
  }
});

test("unoffered JSON fallback still consumes an attempt and cannot bypass an exhausted budget", async () => {
  client();
  plans = [calls(call("a"), call("b"), call("c"), call("d")), calls(call("e"), call("f"), call("g"), call("h")),
    finish('{"name":"unknownTool","arguments":{}}')];
  assert.equal((await ask()).answer, requestCallsError);
  assert.deepEqual(effects, ["a", "b", "c", "d", "e", "f", "g", "h"]);
});

test("actual authorization rejects consume eight reservations; ninth attempt cannot reach dispatch", async () => {
  const { createOllamaRequestBudget, reserveToolAttempts } = require("../cloud-api/local/ollama-resource-limits");
  const registry = require("../config/llm-tools");
  const budget = createOllamaRequestBudget();
  for (let index = 0; index < 7; index++) {
    reserveToolAttempts(budget, 1);
    const rejected = await registry.executeLLMTool("budgetProbe", { label: 42 }, { enabled: true, allowedTools: registry.llmTools });
    assert.equal(rejected.status, "rejected");
    assert.equal(budget.toolAttempts, index + 1);
    assert.deepEqual(effects, []);
  }
  reserveToolAttempts(budget, 1);
  const accepted = await registry.executeLLMTool("budgetProbe", { label: "eighth" }, { enabled: true, allowedTools: registry.llmTools });
  assert.equal(accepted.status, "success");
  assert.equal(budget.toolAttempts, 8);
  assert.deepEqual(effects, ["eighth"]);
  assert.throws(() => reserveToolAttempts(budget, 1), /user request exceeds 8 tool attempts/);
  assert.throws(() => reserveToolAttempts(budget, 0), /user request exceeds 8 tool attempts/,
    "a failed request cannot resume even with a different batch size");
  assert.deepEqual(effects, ["eighth"]);
});

test("provider charges mixed authorization-rejected and valid calls before dispatch", async () => {
  const limits = require("../cloud-api/local/ollama-resource-limits");
  const original = limits.reserveToolAttempts;
  const charged: number[] = [];
  limits.reserveToolAttempts = (budget: any, count: number, modelTriggered?: boolean) => {
    original(budget, count, modelTriggered); charged.push(budget.toolAttempts);
  };
  try {
    client(); plans = [calls(call("allowed"), call(42), call("denied", "unknownTool"))];
    assert.equal((await ask()).answer, "I couldn't run the requested tool. Completion was not verified.");
    assert.deepEqual(charged, [3]);
    assert.deepEqual(effects, ["allowed"]);
  } finally { limits.reserveToolAttempts = original; }
});

test("streamed partial text is not committed to history after text-budget failure", async () => {
  client(); plans = [[line({ message: { content: "Partial." } }),
    line({ message: { thinking: "x".repeat(262144) } }), line({ done: true })]];
  assert.equal((await ask()).answer, "Partial." + textError);
  assert.deepEqual(await nextHistory(), [{ role: "user", content: "Use the approved probe." },
    { role: "assistant", content: textError }, { role: "user", content: "Continue normally." }]);
});

test("interleaved independent provider requests do not share transport or tool accounting", async () => {
  const first = client(), second = client();
  plans = [transport(2097152, calls(call("a1"))), transport(2097152, calls(call("b1"))),
    transport(2097152, calls(call("a2"))), transport(2097152, calls(call("b2"))),
    transport(2097152, calls(call("a3"))), transport(2097152, calls(call("b3"))),
    transport(2097152), transport(2097152)];
  const answers = await Promise.all([ask("Use the approved probe.", first), ask("Use the approved probe.", second)]);
  assert.deepEqual(answers, [{ answer: "Finished.", thinking: "" }, { answer: "Finished.", thinking: "" }]);
  assert.deepEqual(effects, ["a1", "b1", "a2", "b2", "a3", "b3"]);
});

test("transport overflow destroys the stream before EOF rather than waiting for completion", async () => {
  const stream = new PassThrough();
  const completion = readOllamaNDJSON(stream, () => {}).then(() => undefined, (error: Error) => error);
  for (const chunk of transport(2097152)) stream.write(chunk);
  assert.equal(stream.destroyed, false);
  stream.write(Buffer.from("\n"));
  const destroyedBeforeEOF = stream.destroyed;
  stream.end();
  const failure = await completion;
  assert.equal(destroyedBeforeEOF, true);
  assert.equal(failure?.message, "model response exceeds 2097152 transport bytes");
});

test("already buffered native and fallback proposals cannot execute after transport overflow", async () => {
  for (const prefix of [calls(call("pending"))[0], fallback("pending")[0]]) {
    client(); requests.length = 0;
    plans = [[prefix, ...transport(2097153 - prefix.length)]];
    assert.equal((await ask()).answer, responseBytesError);
    assert.deepEqual(effects, []);
    assert.equal(requests.length, 1);
  }
});

test("existing record-size budget failures preserve history in normal and final streams", async () => {
  const oversized = line({ padding: "x".repeat(1048576 - Buffer.byteLength(JSON.stringify({ padding: "" })) + 1) });
  const expected = limitReply("Ollama NDJSON record exceeds 1048576 UTF-8 bytes");
  for (const final of [false, true]) {
    client(final ? 0 : 4); effects.length = 0;
    plans = [calls(call("earlier")), [oversized]];
    assert.equal((await ask()).answer, expected);
    assert.deepEqual(effects, final ? [] : ["earlier"]);
    assert.deepEqual(await nextHistory(), [{ role: "user", content: "Use the approved probe." },
      ...(final ? [] : [assistantCalls("earlier"), result("earlier")]),
      { role: "assistant", content: expected }, { role: "user", content: "Continue normally." }]);
  }
});
