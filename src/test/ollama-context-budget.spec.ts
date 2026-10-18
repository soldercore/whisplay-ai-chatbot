import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import axios from "axios";
import { discoverRuntimeContext, fitOllamaPrompt, PromptMessage, promptMessageTokens } from "../cloud-api/local/ollama-context-budget";
import { OllamaResourceLimitError } from "../cloud-api/local/ollama-resource-limits";

const runtime = { effective: 4096, source: "/api/ps" as const };
test("injected memory/RAG expire with trimmed turns while global instructions and active results survive", () => {
  const global = { role: "system", content: "Permanent global instructions." };
  const messages: PromptMessage[] = [global];
  const turns: PromptMessage[][] = [];
  for (let i = 0; i < 30; i++) {
    const turn = [
      { role: "system", content: `Memory ${i}: ` + "m".repeat(150), contextScope: "turn" },
      { role: "system", content: `RAG ${i}: ` + "k".repeat(150), contextScope: "turn" },
      { role: "user", content: `Question ${i}` },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "probe", arguments: { i } } }] },
      { role: "tool", tool_name: "probe", content: `[success]Result ${i}` },
      { role: "assistant", content: `Answer ${i}` },
    ];
    turns.push(turn); messages.push(...turn);
  }
  const extraGlobal = { role: "system", content: "Another permanent instruction." };
  messages.splice(7, 0, extraGlobal);
  const before = JSON.stringify(messages);
  const fitted = fitOllamaPrompt(messages, undefined, runtime);
  assert.ok(fitted.messages.includes(global)); assert.ok(fitted.messages.includes(extraGlobal));
  assert.equal(fitted.messages.includes(turns[0][0]), false);
  assert.deepEqual(fitted.messages.slice(-6), turns.at(-1));
  for (const turn of turns) {
    const kept = fitted.messages.includes(turn[2]);
    for (const message of turn) assert.equal(fitted.messages.includes(message), kept, "whole turn including its preceding context and tools");
  }
  assert.ok(fitted.estimatedTokens <= fitted.requestBudget);
  assert.equal(JSON.stringify(messages), before, "request trimming never mutates history");
  assert.equal(promptMessageTokens(turns[0][0]), promptMessageTokens({ role: "system", content: turns[0][0].content }), "host marker is not a wire token");
});

test("current scoped context stays mandatory through final-answer instructions and fails closed if oversized", () => {
  const current: PromptMessage[] = [{ role: "system", content: "Persona" },
    { role: "system", content: "Current memory", contextScope: "turn" },
    { role: "system", content: "Current knowledge", contextScope: "turn" },
    { role: "user", content: "Actual question" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "probe", arguments: {} } }] },
    { role: "tool", content: "[success]Actual result" },
    { role: "user", content: "Answer using the available results." }];
  assert.deepEqual(fitOllamaPrompt(current, undefined, runtime, undefined, 128, 3).messages, current);
  assert.throws(() => fitOllamaPrompt(current.map((m, i) => i === 1 ? { ...m, content: "x".repeat(20000) } : m),
    undefined, runtime, undefined, 128, 3), OllamaResourceLimitError);
});

function conversation() {
  const messages: PromptMessage[] = [{ role: "system", content: "Required static safety instructions." }];
  for (let turn = 0; turn < 40; turn++) messages.push(
    { role: "user", content: `Old question ${turn}: ` + "x".repeat(160) },
    { role: "assistant", content: `Old answer ${turn}: ` + "y".repeat(160) });
  messages.push({ role: "system", content: "Relevant memory: keep this exact context.", contextScope: "turn" },
    { role: "user", content: "Newest user question." },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "fixture", arguments: {} } }] },
    { role: "tool", tool_name: "fixture", content: "[success]Required active result, exactly preserved." });
  return messages;
}

test("runtime lookup selects only the target model and refreshes the effective slot", async t => {
  let queries = 0;
  t.mock.method(axios, "get", async (url: string, options: any) => {
    assert.equal(url, "http://fixture/api/ps"); assert.ok(options.signal instanceof AbortSignal);
    return { data: { models: [{ name: "other:latest", context_length: 40960 },
      { name: "target:latest", context_length: ++queries === 1 ? 4096 : 8192 }] } };
  });
  assert.deepEqual(await discoverRuntimeContext("http://fixture", "target"), runtime);
  assert.deepEqual(await discoverRuntimeContext("http://fixture", "target"), { effective: 8192, source: "/api/ps" });
  assert.equal(queries, 2);
});

for (const [label, models] of [
  ["unloaded", []], ["wrong model", [{ name: "target-other:latest", context_length: 40960 }]],
  ["missing context", [{ model: "target" }]], ["string context", [{ name: "target", context_length: "40960" }]],
  ["invalid context", [{ name: "target", context_length: -1 }]], ["malformed", null],
  ["ambiguous", [{ name: "target", context_length: 8192 }, { name: "target:latest", context_length: 40960 }]],
] as [string, unknown][]) test(`runtime fallback is 4096 for ${label}`, async t => {
  t.mock.method(axios, "get", async () => ({ data: { models } }));
  assert.deepEqual(await discoverRuntimeContext("http://fixture", "target"), { effective: 4096, source: "fallback" });
});

test("runtime HTTP failure uses fallback but parent cancellation propagates", async t => {
  t.mock.method(axios, "get", async () => { throw new Error("offline"); });
  assert.deepEqual(await discoverRuntimeContext("http://fixture", "target"), { effective: 4096, source: "fallback" });
  const controller = new AbortController(); controller.abort(new Error("fixture cancelled"));
  await assert.rejects(discoverRuntimeContext("http://fixture", "target", controller.signal), /fixture cancelled/);
});

test("40960 advertised / 4096 effective trims oldest turns without changing required messages", () => {
  const messages = conversation(), original = JSON.stringify(messages);
  const result = fitOllamaPrompt(messages, undefined, runtime, 40960, 128);
  assert.equal(result.requestBudget, 3353); // 4096 - 128 output - ceil(4096 * .15)
  assert.equal(result.reserves.safety, 615);
  assert.ok(result.messages.length < messages.length);
  assert.equal(result.messages[0], messages[0]);
  assert.deepEqual(result.messages.slice(-4), messages.slice(-4));
  assert.equal(result.messages.includes(messages[1]), false);
  assert.equal(JSON.stringify(messages), original, "stored/live history is not rewritten");
  assert.ok(result.messages.every((message, index) => index === 0 || messages.indexOf(message) > messages.indexOf(result.messages[index - 1])));
  assert.ok(result.estimatedTokens <= result.requestBudget);
  assert.equal(result.historyBudget, result.requestBudget - result.reserves.system - result.reserves.context - result.reserves.active - result.reserves.tools);
  const keptUser = result.messages.find(message => message.role === "user")!;
  const keptStart = messages.indexOf(keptUser);
  if (keptStart > 3) {
    const previousTurn = messages.slice(keptStart - 2, keptStart);
    assert.ok(result.estimatedTokens + previousTurn.reduce((sum, message) => sum + promptMessageTokens(message), 0) > result.requestBudget,
      "trim only as many complete oldest turns as required");
  }
});

test("within-budget messages and completed tool pairs keep exact order and identity", () => {
  const messages = conversation().slice(-4);
  messages.unshift({ role: "system", content: "Static." });
  const result = fitOllamaPrompt(messages, [{ function: { name: "fixture" } }], runtime, 40960, 256);
  assert.deepEqual(result.messages, messages);
  assert.ok(result.messages.every((message, index) => message === messages[index]));
  assert.equal(result.requestBudget, 3225);
});

test("budget accounts for tools and output and rejects oversized mandatory content before generation", () => {
  const messages = [{ role: "system", content: "Safety" }, { role: "user", content: "Newest" }];
  const small = fitOllamaPrompt(messages, undefined, runtime, 40960, 128);
  const tools = [{ function: { name: "fixture", description: "x".repeat(600) } }];
  const withTools = fitOllamaPrompt(messages, tools, runtime, 40960, 512);
  assert.equal(small.requestBudget - withTools.requestBudget, 384);
  assert.ok(withTools.historyBudget < small.historyBudget - 384);
  assert.throws(() => fitOllamaPrompt([...messages, { role: "tool", content: "x".repeat(20000) }], tools, runtime), OllamaResourceLimitError);
  assert.throws(() => fitOllamaPrompt(messages, tools, runtime, 40960, 4096), OllamaResourceLimitError);
});

test("UTF-8 and tool metadata are included in the estimate", () => {
  const message = { role: "assistant", content: "æøå", tool_calls: [{ function: { name: "fixture", arguments: { text: "ø" } } }] };
  assert.equal(promptMessageTokens(message), 16 + Math.ceil(Buffer.byteLength(JSON.stringify(message), "utf8") / 3));
  assert.ok(promptMessageTokens(message) > promptMessageTokens({ role: "assistant", content: "æøå" }));
});

for (const loaded of [true, false]) for (const finalPath of [false, true]) test(`actual ${finalPath ? "final no-tools" : "normal"} HTTP request uses ${loaded ? "runtime" : "fallback"}, not advertised capacity`, async t => {
  Object.assign(process.env, { LLM_SERVER: "test", OLLAMA_MODEL: "target", OLLAMA_ENDPOINT: "http://fixture",
    OLLAMA_ENABLE_TOOLS: "false", OLLAMA_MAX_TOOL_ROUNDS: "0", OLLAMA_PREDICT_NUM: "128",
    CONTEXT_AUTO_COMPACT_ENABLED: "true", WEB_SEARCH_ENABLED: "false", MEMORY_ENABLED: "false" });
  const logs: string[] = [], captured: any[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => logs.push(args.join(" ")));
  let discoveries = 0;
  t.mock.method(axios, "get", async () => {
    discoveries++; return { data: { models: loaded ? [{ name: "target:latest", context_length: 4096 }] : [] } };
  });
  t.mock.method(axios, "post", async (url: string, body: any) => {
    if (url.endsWith("/api/show")) return { data: { model_info: { "qwen3.context_length": 40960 } } };
    assert.equal(url, "http://fixture/api/chat");
    captured.push(body);
    const record = finalPath && captured.length === 1
      ? { message: { tool_calls: [{ function: { name: "fixture", arguments: {} } }] }, done: true }
      : { message: { content: "Ready." }, done: true };
    const stream = new PassThrough(); setImmediate(() => stream.end(JSON.stringify(record) + "\n"));
    return { data: stream };
  });
  const file = require.resolve("../cloud-api/local/ollama-llm"); delete require.cache[file];
  const provider = require(file).default; t.after(() => provider.cancelActiveRequest());
  const input = conversation().slice(1);
  let answer = "", ends = 0;
  await provider.chatWithLLMStream(input, (text: string) => answer += text, () => ends++);
  assert.equal(answer, "Ready."); assert.equal(ends, 1);
  assert.equal(captured.length, finalPath ? 2 : 1); assert.equal(discoveries, captured.length);
  for (const request of captured) {
    assert.ok(request.messages.every((message: any) => !("contextScope" in message)), "host lifetime metadata never reaches the model");
    assert.equal(request.options.num_ctx, undefined);
    assert.match(request.messages[0].content, /Format your replies for spoken text-to-speech/);
    assert.ok(request.messages.some((message: any) => message.content === "Newest user question."));
    assert.ok(request.messages.some((message: any) => message.content === "[success]Required active result, exactly preserved."));
    assert.equal(request.messages.some((message: any) => message.content.startsWith("Old question 0:")), false);
    const estimate = request.messages.reduce((sum: number, message: any) => sum + promptMessageTokens(message), 0);
    assert.ok(estimate <= 3353, "the actual serialized request fits the independently calculated input budget");
  }
  assert.ok(logs.some(line => line.includes("advertised_context=40960 effective_context=4096 request_budget=3353") && line.includes(`source=${loaded ? "/api/ps" : "fallback"}`)));
  assert.equal(logs.some(line => line.includes("context_window=40960")), false);
});

test("old assistant/tool exchanges are trimmed together and retained turns are never rewritten", () => {
  const messages = conversation();
  const call = { role: "assistant", content: "", tool_calls: [{ function: { name: "old", arguments: {} } }] };
  const result = { role: "tool", content: "[success]Old result.", tool_name: "old" };
  messages.splice(2, 1, call, result);
  const fitted = fitOllamaPrompt(messages, undefined, runtime, 40960, 128).messages;
  assert.equal(fitted.includes(call), false); assert.equal(fitted.includes(result), false);
  assert.deepEqual(fitted.slice(-4), messages.slice(-4));
});

test("oversized newest input fails closed before the actual generation HTTP boundary", async t => {
  Object.assign(process.env, { LLM_SERVER: "test", OLLAMA_MODEL: "target", OLLAMA_ENDPOINT: "http://fixture",
    OLLAMA_ENABLE_TOOLS: "false", OLLAMA_PREDICT_NUM: "128", CONTEXT_AUTO_COMPACT_ENABLED: "false" });
  let generated = 0;
  t.mock.method(axios, "get", async () => ({ data: { models: [] } }));
  t.mock.method(axios, "post", async () => { generated++; throw new Error("must not generate"); });
  const file = require.resolve("../cloud-api/local/ollama-llm"); delete require.cache[file];
  const provider = require(file).default;
  let answer = "", ends = 0;
  await provider.chatWithLLMStream([{ role: "user", content: "x".repeat(20000) }],
    (text: string) => answer += text, () => ends++);
  assert.equal(generated, 0); assert.equal(ends, 1);
  assert.match(answer, /Resource limit exceeded: required prompt exceeds the effective runtime context budget/);
});

test("memory summary reserves its existing 160 output tokens and rejects an oversized transcript", async t => {
  Object.assign(process.env, { LLM_SERVER: "test", OLLAMA_MODEL: "target", OLLAMA_ENDPOINT: "http://fixture",
    OLLAMA_PREDICT_NUM: "4000", CONTEXT_AUTO_COMPACT_ENABLED: "false" });
  const generated: any[] = [], logs: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => logs.push(args.join(" ")));
  t.mock.method(axios, "get", async () => ({ data: { models: [{ model: "target", context_length: 4096 }] } }));
  t.mock.method(axios, "post", async (url: string, body: any) => {
    assert.equal(url, "http://fixture/api/generate"); generated.push(body); return { data: { response: "Summary." } };
  });
  const file = require.resolve("../cloud-api/local/ollama-llm"); delete require.cache[file];
  const provider = require(file).default;
  assert.equal(await provider.summaryTextWithLLM("Short transcript.", "Summarize."), "Summary.");
  assert.deepEqual(generated[0].options, { num_predict: 160 });
  assert.equal(generated[0].prompt, "Summarize.\n\nShort transcript.\n\n");
  await assert.rejects(provider.summaryTextWithLLM("x".repeat(20000), "Summarize."), OllamaResourceLimitError);
  assert.equal(generated.length, 1);
  assert.ok(logs.some(line => line.includes("output:160") && line.includes("effective_context=4096")));
});
