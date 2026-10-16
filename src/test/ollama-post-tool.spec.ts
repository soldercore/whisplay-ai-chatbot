import { test, before, after, TestContext } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import axios from "axios";

const FAILURE = "I couldn't produce a usable answer.";
const ANSWER = "CPU temperature is 65 Celsius. RAM usage is 768000 bytes.";
const PRIVATE_THINKING = "Internal reasoning is not an answer.";
const requests: any[] = [];
let plans: { records: any[]; cancel?: boolean }[] = [];
let toolOutcome: string | Error = "[success]Probe completed.";
let effects = 0;
let provider: any;
const audioPath = require.resolve("../device/audio");
const originalAudio = require.cache[audioPath];
const audioText = new WeakMap<Buffer, string>();
let played: string[] = [];
const compiled = new Map<string, string>();
const healthCall = () => ({ message: { tool_calls: [{ function: { name: "getSystemHealth", arguments: {} } }] }, done: true });
const probeCall = (label: string) => ({ message: { tool_calls: [{ function: { name: "postToolProbe", arguments: { label } } }] }, done: true });
const visible = () => [{ message: { content: "CPU temperature is 65 Celsius. " } },
  { message: { content: "RAM usage is 768000 bytes." }, done: true }];

before(() => {
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/);
  Object.assign(process.env, { LLM_SERVER: "test", OLLAMA_ENABLE_TOOLS: "true", WEB_SEARCH_ENABLED: "false",
    MEMORY_ENABLED: "false", MEMPALACE_ENABLED: "false", CONTEXT_AUTO_COMPACT_ENABLED: "false",
    WAKE_WORD_ENABLED: "false", ENABLE_THINKING: "true" });
  require.cache[audioPath] = { id: audioPath, filename: audioPath, loaded: true, exports: {
    playAudioData: async (result: { buffer: Buffer }) => { played.push(audioText.get(result.buffer)!); }, stopPlaying() {},
  } } as NodeModule;
  require("../plugin").pluginRegistry.register({ name: "post-tool-fixture", displayName: "Fixture", version: "1",
    type: "llm-tools", activate: () => ({ getTools: () => [{ execution: "bounded", type: "function", function: {
      name: "postToolProbe", description: "Fixture", parameters: { type: "object",
        properties: { label: { type: "string" } }, required: ["label"] },
    }, func: async () => { if (toolOutcome instanceof Error) throw toolOutcome; effects++; return toolOutcome; } }] }) });
  for (const file of ["core/ChatFlow.ts", "core/chat-flow/states.ts"]) {
    compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText);
  }
});
after(() => { if (originalAudio) require.cache[audioPath] = originalAudio; else delete require.cache[audioPath]; });

function evaluate(file: string, dependencies: Record<string, any>) {
  const exported: any = {};
  vm.runInNewContext(compiled.get(file)!, { exports: exported, process, console, Date, setTimeout, clearTimeout,
    setInterval, clearInterval, require: (name: string) => {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      if (["lodash", "moment", "dotenv"].includes(name)) return require(name);
      throw new Error(`Unexpected production dependency: ${name}`);
    } });
  return exported;
}

// Real health collector, registry/executor, Ollama NDJSON, answer state,
// ChatFlow display callbacks and StreamResponser. Only OS/model/audio edges
// are simulated; the model's actual Pi output is not inferred from this fixture.
async function run(t: TestContext, script: any[][], options: { rounds?: number; outcome?: string | Error; cancelLast?: boolean;
  question?: string; enabled?: boolean; healthOutput?: string | Error; omitHealth?: boolean; cancelHealth?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1_700_000_000_000 });
  // Let Node deliver its one-time experimental-API warning before capturing
  // application errors; no application operation has started yet.
  await new Promise<void>(resolve => setImmediate(resolve));
  requests.length = 0; effects = 0; played = []; toolOutcome = options.outcome ?? "[success]Probe completed.";
  plans = script.map((records, i) => ({ records, cancel: options.cancelLast && i === script.length - 1 }));
  const logs: string[] = [], errors: string[] = [], synthesized: string[] = [], displayed: any[] = [];
  const events: { name: string; result?: string }[] = [];
  let samples = 0, reads = 0, serviceCalls = 0, ends = 0, rawText = "";
  t.mock.method(console, "log", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  t.mock.method(console, "time", () => {}); t.mock.method(console, "timeEnd", () => {});
  const os = require("node:os"), cp = require("node:child_process");
  t.mock.method(os, "cpus", () => [{ times: samples++ === 0
    ? { user: 100, sys: 50, nice: 0, irq: 0, idle: 850 }
    : { user: 130, sys: 70, nice: 0, irq: 0, idle: 900 } }]);
  t.mock.method(os, "loadavg", () => [1, 2, 3]); t.mock.method(os, "uptime", () => 1234);
  const metrics: Record<string, string> = {
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\nMemFree: 100 kB\nSwapTotal: 50 kB\nSwapFree: 20 kB\n",
    "/sys/class/thermal/thermal_zone0/type": "cpu-thermal\n", "/sys/class/thermal/thermal_zone0/temp": "65000\n",
  };
  const descriptors = new Map<number, string>();
  t.mock.method(fs, "openSync", (file: string) => { assert.ok(file in metrics); descriptors.set(++reads, file); return reads; });
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer) => buffer.write(metrics[descriptors.get(fd)!]));
  t.mock.method(fs, "closeSync", (fd: number) => { descriptors.delete(fd); });
  t.mock.method(fs, "statfsSync", () => ({ bsize: 4096n, blocks: 1000n, bfree: 400n, bavail: 350n }));
  t.mock.method(cp, "execFile", (_command: string, _args: string[], _options: any, callback: Function) => {
    serviceCalls++; callback(null, "Id=ollama.service\nLoadState=loaded\nActiveState=active\nSubState=running\n");
  });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", platform));
  process.env.OLLAMA_MAX_TOOL_ROUNDS = String(options.rounds ?? 4);
  process.env.OLLAMA_ENABLE_TOOLS = String(options.enabled ?? true);
  const registry = require("../config/llm-tools");
  let healthCalls = 0;
  const realHealth = registry.llmFuncMap.getSystemHealth;
  t.mock.method(registry.llmFuncMap, "getSystemHealth", async (args: unknown) => {
    healthCalls++;
    assert.deepEqual(args, {}, "host and model health calls must retain the strict empty argument contract");
    if (options.healthOutput instanceof Error) throw options.healthOutput;
    return options.healthOutput ?? realHealth(args);
  });
  if (options.omitHealth) {
    const index = registry.llmTools.findIndex((tool: any) => tool.function.name === "getSystemHealth");
    assert.ok(index >= 0);
    const removed = registry.llmTools.splice(index, 1);
    t.after(() => registry.llmTools.splice(index, 0, ...removed));
  }
  const healthCallsAtGeneration: number[] = [];
  t.mock.method(axios, "post", async (_url: string, body: any) => {
    healthCallsAtGeneration.push(healthCalls);
    requests.push(JSON.parse(JSON.stringify(body)));
    const plan = plans.shift(); assert.ok(plan, "no unplanned model request or automatic retry");
    const stream = new PassThrough();
    setImmediate(() => {
      stream.end(plan.records.map(record => JSON.stringify(record) + "\n").join(""));
      if (plan.cancel) provider.cancelActiveRequest();
    });
    return { data: stream };
  });
  delete require.cache[require.resolve("../cloud-api/local/ollama-llm")];
  provider = require("../cloud-api/local/ollama-llm").default;
  t.after(() => provider.cancelActiveRequest());
  let completed = false;
  const noop = () => {};
  const display = { display: (payload: any) => displayed.push(payload), onButtonPressed: noop,
    onButtonReleased: noop, onButtonDoubleClick: noop };
  const chat = (input: any, partial: Function, end: Function, thinking: Function, invoke: Function) =>
    provider.chatWithLLMStream(input, (text: string) => { rawText += text; partial(text); },
      () => { ends++; end(); }, thinking, (name: string, result?: string) => { events.push({ name, result }); invoke(name, result); });
  const images = { clearPendingCapturedImgForChat: noop, getLatestDisplayImg: noop };
  const utils = require("../utils");
  const states = evaluate("core/chat-flow/states.ts", {
    "../../device/display": display, "../../device/audio": {}, "../../cloud-api/server": { chatWithLLMStream: chat, llmServer: "ollama" },
    "../../cloud-api/llm": { isImMode: false }, "../Knowledge": {}, "../../cloud-api/knowledge": { enableRAG: false },
    "../../utils/dir": require("../utils/dir"), "../../utils/image": images, "../../cloud-api/whisplay-im/whisplay-im": {},
    "./camera-mode": {}, "../../utils": utils, "../../device/music-player": {},
    "../../config/local-memory": { prepareMemoryPrompt: () => "", autoSaveExchange: noop },
    "../../config/unsupported-reminder": require("../config/unsupported-reminder"),
  }).flowStates;
  class Machine {
    constructor(private ctx: any) {}
    transitionTo(state: string) { const wasAnswer = this.ctx.currentFlowName === "answer"; this.ctx.currentFlowName = state;
      if (wasAnswer && state === "sleep") completed = true; }
  }
  const Flow = evaluate("core/ChatFlow.ts", {
    "./../utils/index": utils, "../utils": utils, "../device/display": display,
    "../cloud-api/server": { ttsProcessor: async (text: string) => {
      synthesized.push(text); const buffer = Buffer.from(text); audioText.set(buffer, text); return { buffer, duration: 10 };
    } }, "../cloud-api/llm": { isImMode: false, cancelLLMRequest: () => provider.cancelActiveRequest() },
    "./StreamResponsor": require("../core/StreamResponsor"), "./spoken-text-reveal": require("../core/spoken-text-reveal"),
    "../utils/dir": require("../utils/dir"), "../device/wakeword": {}, "../device/im-bridge": {},
    "./chat-flow/stateMachine": { FlowStateMachine: Machine }, "./chat-flow/states": { flowStates: states },
    "../device/audio": {}, "../device/music-player": { isMusicPlaying: () => false },
  }).default;
  const ctx = new Flow();
  t.after(() => { ctx.streamResponser.stop(); ctx.resetToolCallDisplay(); });
  // Exercise ordinary model-driven calls independently of mandatory local-state
  // routing; explicit health requests are covered separately below.
  ctx.asrText = options.question ?? "Explain CPU temperature in general.";
  ctx.currentFlowName = "answer";
  const historyDir = require("../utils/dir").chatHistoryDir;
  const previousHistoryFile = fs.readdirSync(historyDir)[0];
  const historyBefore = previousHistoryFile ? JSON.parse(fs.readFileSync(path.join(historyDir, previousHistoryFile), "utf8")) : [];
  states.answer(ctx);
  for (let i = 0; i < 80 && !completed; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (options.cancelHealth && samples === 1) provider.cancelActiveRequest();
    t.mock.timers.tick(100);
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
  assert.equal(completed, true, "answer state must finish without waiting for wall-clock sleeps");
  assert.equal(ends, 1); assert.equal(plans.length, 0);
  assert.deepEqual(played, synthesized, "every synthesized sentence reaches the playback boundary in order");
  assert.equal(descriptors.size, 0);
  const historyFiles = fs.readdirSync(historyDir);
  assert.equal(historyFiles.length, 1);
  const history = JSON.parse(fs.readFileSync(path.join(historyDir, historyFiles[0]), "utf8"));
  return { rawText, synthesized, displayed, events, logs, errors, samples, reads, serviceCalls, history,
    healthCalls, healthCallsAtGeneration, historyBefore };
}

function assertDelivered(result: Awaited<ReturnType<typeof run>>, text: string) {
  assert.equal(result.synthesized.join(" "), text);
  assert.ok(result.displayed.some(payload => payload.status === "answering" && payload.text?.includes(text)), "actual ChatFlow display receives the answer");
  assert.equal(result.synthesized.join(" ").includes(PRIVATE_THINKING), false);
}

test("scenario A: measured health results reach round 1 and visible text reaches display, TTS and playback", async t => {
  const result = await run(t, [[healthCall()], visible()]);
  assertDelivered(result, ANSWER); assert.equal(result.rawText, ANSWER);
  assert.equal(result.samples, 2); assert.equal(result.serviceCalls, 1);
  const tool = requests[1].messages.find((message: any) => message.role === "tool");
  assert.equal(tool.tool_name, "getSystemHealth"); assert.match(tool.content, /^\[success\]/);
  const metrics = JSON.parse(tool.content.slice("[success]".length));
  assert.equal(metrics.temperatureCelsius, 65); assert.equal(metrics.memory.usedBytes, 768000);
  assert.equal(result.events[1].result, tool.content); assert.deepEqual(result.errors, []);
});

for (const [label, records] of [
  ["thinking-only", [{ message: { thinking: PRIVATE_THINKING }, done: true, eval_count: 23 }]],
  ["empty with 23 generated tokens", [{ done: true, eval_count: 23 }]],
  ["whitespace-only", [{ message: { content: "   " }, done: true }]],
  ["non-speakable emoji", [{ message: { content: "🤖" }, done: true }]],
] as [string, any[]][]) {
  test(`scenario B: ${label} post-tool completion delivers an honest audible failure`, async t => {
    const first = healthCall(); (first.message as any).thinking = PRIVATE_THINKING;
    const result = await run(t, [[first], records]);
    assertDelivered(result, FAILURE);
    assert.equal(requests.length, 2, "never retry the tool or model automatically");
    assert.equal(result.samples, 2);
    assert.match(result.events[1].result!, /^\[success\]/);
    assert.equal(result.history[result.history.length - 1].content, FAILURE, "save the truthful failure, not an empty assistant answer");
    if (label.startsWith("empty")) assert.ok(result.logs.some(line => line.includes("round=1") && line.includes("first-token=-")));
  });
}

test("rejected health arguments remain audible rejection with no measurements or follow-up model call", async t => {
  const first = healthCall(); first.message.tool_calls[0].function.arguments = { num_results: 2 } as any;
  const result = await run(t, [[first]]);
  assertDelivered(result, "I couldn't run the requested tool. Completion was not verified.");
  assert.equal(result.samples, 0); assert.equal(requests.length, 1); assert.match(result.events[1].result!, /^\[rejected\]/);
});

test("failed tool execution remains an audible unverified result", async t => {
  const result = await run(t, [[probeCall("fail")]], { outcome: new Error("Fixture failure") });
  assertDelivered(result, "The tool did not confirm completion. The result is unverified.");
  assert.equal(effects, 0); assert.equal(requests.length, 1); assert.match(result.events[1].result!, /^\[error\]/);
});

test("multiple tool rounds preserve ordered results and deliver only the terminal answer", async t => {
  const first = healthCall(); (first.message as any).thinking = PRIVATE_THINKING;
  const next = probeCall("second"); (next.message as any).thinking = PRIVATE_THINKING;
  const result = await run(t, [[first], [next], visible()]);
  assertDelivered(result, ANSWER); assert.equal(requests.length, 3); assert.equal(effects, 1);
  assert.deepEqual(requests[2].messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_name), ["getSystemHealth", "postToolProbe"]);
});

test("an empty terminal round after a side effect reports failure without repeating the effect", async t => {
  const result = await run(t, [[probeCall("once")], [{ done: true }]]);
  assertDelivered(result, FAILURE); assert.equal(effects, 1); assert.equal(requests.length, 2);
});

for (const thinking of [false, true]) test(`final no-tools path reports ${thinking ? "thinking-only" : "empty"} completion without re-execution`, async t => {
  const result = await run(t, [[probeCall("first")], [probeCall("second")],
    [{ message: thinking ? { thinking: PRIVATE_THINKING } : {}, done: true }]], { rounds: 1 });
  assertDelivered(result, FAILURE); assert.equal(effects, 1); assert.equal(requests.length, 3);
  assert.equal(requests[2].tools, undefined);
  assert.equal(result.history[result.history.length - 1].content, FAILURE);
});

test("normal round-0 visible streaming remains unchanged", async t => {
  const result = await run(t, [visible()]);
  assertDelivered(result, ANSWER); assert.equal(requests.length, 1); assert.equal(result.samples, 0);
});

test("empty round-0 completion also cannot silently appear successful", async t => {
  assertDelivered(await run(t, [[{ done: true }]]), FAILURE);
});

test("cancellation of the post-tool stream never emits the empty-answer fallback", async t => {
  const result = await run(t, [[healthCall()], [{ done: true }]], { cancelLast: true });
  assert.equal(result.rawText, ""); assert.deepEqual(result.synthesized, []); assert.equal(requests.length, 2);
});

for (const question of ["How is your system doing?", "What's your CPU temperature?",
  "How much RAM are you using?", "How much memory are you using?", "How much disk space is left?"]) {
  test(`required health is measured before the model can answer: ${question}`, async t => {
    // The model never requests a tool. Before the fix it could answer from no
    // measurements, just as in the supplied Pi evidence.
    const result = await run(t, [visible()], { question });
    assert.equal(result.healthCalls, 1); assert.equal(result.samples, 2);
    assert.deepEqual(result.healthCallsAtGeneration, [1]);
    assert.equal(requests.length, 1); assert.equal(requests[0].tools, undefined);
    assert.deepEqual(result.events.map(event => event.name), ["getSystemHealth", "getSystemHealth"]);
    const tool = requests[0].messages.find((message: any) => message.role === "tool");
    assert.equal(tool.tool_name, "getSystemHealth"); assert.match(tool.content, /^\[success\]/);
    const metrics = JSON.parse(tool.content.slice("[success]".length));
    assert.equal(metrics.temperatureCelsius, 65); assert.equal(metrics.memory.usedBytes, 768000);
    assert.equal(metrics.disk.availableBytes, 1433600);
    assertDelivered(result, ANSWER);
  });
}

for (const question of ["How are you doing?", "What is RAM?", "How does CPU temperature affect performance?"]) {
  test(`ordinary conversation does not force a local measurement: ${question}`, async t => {
    const result = await run(t, [[{ message: { content: "Hello, test subject." }, done: true }]], { question });
    assertDelivered(result, "Hello, test subject.");
    assert.equal(result.healthCalls, 0); assert.equal(result.samples, 0); assert.equal(requests.length, 1);
  });
}

for (const [label, healthOutput] of [
  ["exception", new Error("Fixture health failure")], ["error", "[error]Unavailable"],
  ["rejected", "[rejected]Unavailable"], ["unverified", "[unverified]Unknown result"],
  ["invalid JSON", "[success]Not JSON"], ["empty report", "[success]{}"],
  ["no measurements", '[success]{"cpu":{"utilizationPercent":null},"memory":{"usedBytes":null},"disk":null,"temperatureCelsius":null}'],
] as [string, string | Error][]) {
  test(`required health fails closed before generation on ${label}`, async t => {
    const result = await run(t, [], { question: "How is your system doing?", healthOutput });
    assertDelivered(result, "I couldn't retrieve my system health.");
    assert.equal(result.healthCalls, 1); assert.equal(requests.length, 0);
    assert.equal(result.samples, 0); assert.equal(effects, 0);
  });
}

for (const options of [{ enabled: false }, { omitHealth: true }]) {
  test(`required health cannot bypass authorization: ${JSON.stringify(options)}`, async t => {
    const result = await run(t, [], { question: "How is your system doing?", ...options });
    assertDelivered(result, "I couldn't retrieve my system health.");
    assert.equal(result.healthCalls, 0); assert.equal(result.samples, 0); assert.equal(requests.length, 0);
    assert.match(result.events[1].result!, /^\[rejected\]/);
  });
}

test("a missing requested temperature cannot be replaced with other available metrics", async t => {
  const result = await run(t, [], { question: "What's your CPU temperature?",
    healthOutput: '[success]{"temperatureCelsius":null,"memory":{"usedBytes":768000}}' });
  assertDelivered(result, "I couldn't retrieve my system health.");
  assert.equal(result.healthCalls, 1); assert.equal(requests.length, 0);
});

test("a model request cannot execute health a second time after mandatory measurement", async t => {
  const result = await run(t, [[healthCall()], visible()], { question: "How is your system doing?" });
  assert.equal(result.healthCalls, 1); assert.equal(result.samples, 2); assert.equal(requests.length, 2);
  assert.deepEqual(result.events.map(event => event.name), ["getSystemHealth", "getSystemHealth"]);
  assert.ok(requests.every(request => request.tools === undefined));
  assertDelivered(result, ANSWER);
});

test("mandatory health preserves the existing empty-final-answer fallback", async t => {
  const result = await run(t, [[{ done: true }]], { question: "How is your system doing?" });
  assertDelivered(result, FAILURE); assert.equal(result.healthCalls, 1); assert.equal(requests.length, 1);
});

test("cancelling mandatory sampling emits neither fabricated health nor a failure for the abandoned answer", async t => {
  const result = await run(t, [], { question: "How is your system doing?", cancelHealth: true });
  assert.equal(result.healthCalls, 1); assert.equal(result.samples, 1);
  assert.equal(result.reads, 0); assert.equal(result.serviceCalls, 0); assert.equal(requests.length, 0);
  assert.equal(result.rawText, ""); assert.deepEqual(result.synthesized, []);
  assert.deepEqual(result.history, result.historyBefore, "abandoned work must not add a user turn or stale tool results");
});
