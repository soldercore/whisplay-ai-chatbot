import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { readOllamaNDJSON } from "../cloud-api/local/ollama-ndjson";

type Plan = { chunks: Buffer[]; stop?: "error" | "close"; interleave?: boolean; afterFirstChunk?: () => void };
const line = (value: unknown, ending = "\n") => Buffer.from(JSON.stringify(value) + ending);
const done = { done: true };
const text = (content: string) => ({ message: { content } });
const tool = (label: string) => ({ message: { tool_calls: [
  { function: { name: "transportProbe", arguments: { label } } },
] } });
const finish = () => ({ chunks: [line({ ...text("Finished."), done: true })] });
const split = (bytes: Buffer, cuts: number[]) => {
  const points = [0, ...cuts, bytes.length];
  return points.slice(0, -1).map((start, index) => bytes.subarray(start, points[index + 1]));
};

let plans: Plan[] = [];
let effects: string[] = [];
let errors: string[] = [];
const requests: any[] = [];
const clients = new Map<string, any>();
const originalPost = axios.post;
const originalError = console.error;
const originalWarn = console.warn;
const modulePath = require.resolve("../cloud-api/local/ollama-llm");

before(() => {
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/);
  Object.assign(process.env, { LLM_SERVER: "test", ASR_SERVER: "test", TTS_SERVER: "test",
    MEMORY_ENABLED: "false", WEB_SEARCH_ENABLED: "false", ENABLE_THINKING: "true",
    CONTEXT_AUTO_COMPACT_ENABLED: "false", OLLAMA_MODEL: "test", WAKE_WORD_ENABLED: "false" });
  require("../plugin").pluginRegistry.register({ name: "transport-fixture", displayName: "Transport fixture",
    version: "1", type: "llm-tools", activate: () => ({ getTools: () => [{ execution: "bounded", type: "function",
      function: { name: "transportProbe", description: "Test fixture", parameters: { type: "object",
        properties: { label: { type: "string" } }, required: ["label"] } },
      func: async ({ label }: { label: string }) => { effects.push(label); return "[success]Stored."; },
    }] }) });
  // Real provider + real tool registry/executor. Only the HTTP byte source is
  // replaced, so transport chunk boundaries are deterministic (no TCP coalescing).
  axios.post = (async (url: string, body: any, config: any) => {
    if (url.endsWith("/api/show")) return { data: { model_info: { context_length: 32768 } } };
    requests.push(body);
    const plan = plans.shift();
    assert.ok(plan, "every model request must have a scripted response");
    const stream = new PassThrough();
    const abort = () => stream.destroy(new Error("Request cancelled"));
    config?.signal?.addEventListener("abort", abort, { once: true });
    stream.once("close", () => config?.signal?.removeEventListener("abort", abort));
    let index = 0;
    const deliver = () => {
      if (stream.destroyed) return;
      if (plan.interleave && index < plan.chunks.length) {
        stream.write(plan.chunks[index++]);
        if (index === 1) plan.afterFirstChunk?.();
        setImmediate(deliver);
        return;
      }
      while (index < plan.chunks.length) stream.write(plan.chunks[index++]);
      if (plan.stop === "error") stream.destroy(new Error("Simulated transport failure"));
      else if (plan.stop === "close") stream.destroy();
      else stream.end();
    };
    setImmediate(deliver);
    return { data: stream };
  }) as typeof axios.post;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

after(() => { axios.post = originalPost; console.error = originalError; console.warn = originalWarn; });

function client(enabled = true, rounds = 4) {
  const key = `${enabled}:${rounds}`;
  if (!clients.has(key)) {
    Object.assign(process.env, { OLLAMA_ENABLE_TOOLS: String(enabled), OLLAMA_MAX_TOOL_ROUNDS: String(rounds) });
    delete require.cache[modulePath];
    clients.set(key, require("../cloud-api/local/ollama-llm").default);
  }
  return clients.get(key);
}

async function ask(provider: any) {
  let answer = "", thinking = "", ends = 0;
  const events: unknown[] = [];
  await provider.chatWithLLMStream([{ role: "user", content: "Use the approved transport probe if needed." }],
    (part: string) => answer += part, () => ends++, (part: string) => thinking += part,
    (name: string, result?: string) => events.push([name, result]));
  assert.equal(ends, 1, "end callback must run once on success and failure");
  return { answer, thinking, events, ends };
}

async function run(script: Plan[], enabled = true, rounds = 4) {
  plans = [...script]; effects = []; errors = []; requests.length = 0;
  const provider = client(enabled, rounds);
  provider.resetChatHistory();
  const result = await ask(provider);
  assert.equal(plans.length, 0, "all scripted requests must have been consumed");
  return { ...result, effects: [...effects], errors: [...errors] };
}

test("A complete record preserves existing behavior", async () => {
  const result = await run([{ chunks: [line({ ...text("Hello."), done: true })] }]);
  assert.equal(result.answer, "Hello.");
  assert.deepEqual(result.errors, []);
});

test("B multiple records in one chunk are processed once in order", async () => {
  const result = await run([{ chunks: [Buffer.concat([line(text("First ")), line({ ...text("second."), done: true })])] }]);
  assert.equal(result.answer, "First second.");
});

test("C two chunks reconstruct a JSON record without loss", async () => {
  const bytes = line({ ...text("Reconstructed."), done: true });
  const result = await run([{ chunks: split(bytes, [23]) }]);
  assert.equal(result.answer, "Reconstructed.");
  assert.deepEqual(result.errors, []);
});

test("D three chunks reconstruct a CRLF record including split CR/LF", async () => {
  const bytes = line({ ...text("Three pieces."), done: true }, "\r\n");
  assert.equal((await run([{ chunks: split(bytes, [11, bytes.length - 1]) }])).answer, "Three pieces.");
});

test("E UTF-8 bytes in content and tool arguments remain exact", async () => {
  const bytes = Buffer.concat([line(text("æøå")), line(tool("æøå")), line(done)]);
  const cuts = [...bytes.keys()].filter(index => index > 0 && (bytes[index] & 0xc0) === 0x80);
  const result = await run([{ chunks: split(bytes, cuts) }, finish()]);
  assert.equal(result.answer, "æøåFinished.");
  assert.deepEqual(result.effects, ["æøå"]);
});

test("F mixed chunks carry a remainder, whole records and another prefix", async () => {
  const a = line(text("A")), b = line(text("B")), c = line(text("C")), d = line({ ...text("D"), done: true });
  const result = await run([{ chunks: [a.subarray(0, 9), Buffer.concat([a.subarray(9), b, c, d.subarray(0, 7)]), d.subarray(7)] }]);
  assert.equal(result.answer, "ABCD");
});

test("G empty and whitespace lines are safely ignored with LF and CRLF", async () => {
  const result = await run([{ chunks: [Buffer.concat([Buffer.from("\n\r\n  \r\n"), line(text("Okay"), "\r\n"), Buffer.from("\n"), line(done)])] }]);
  assert.equal(result.answer, "Okay");
  assert.deepEqual(result.errors, []);
});

test("H EOF halfway through a record reports truncation without success", async () => {
  const result = await run([{ chunks: [Buffer.from('{"message":{"content":"Unfinished')] }]);
  assert.equal(result.answer, "");
  assert.deepEqual(result.effects, []);
  assert.match(result.errors.join(" "), /truncat/i);
});

test("I incomplete or undelimited tool-call records never execute", async () => {
  for (const bytes of [line(tool("unsafe")).subarray(0, 70), Buffer.from(JSON.stringify({ ...tool("unsafe"), done: true }))]) {
    const result = await run([{ chunks: [bytes] }]);
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.events, []);
    assert.match(result.errors.join(" "), /truncat/i);
  }
  // Even an already complete call must wait for a complete, successful stream.
  const result = await run([{ chunks: [line(tool("unsafe")), line(done), Buffer.from('{"unfinished":')] }]);
  assert.deepEqual(result.effects, []);
});

test("J thinking, content, tool packages, ordering and done keep existing aggregation", async () => {
  const records = [ { message: { thinking: "Think æ" } }, text("Before "), tool("first ø"),
    { message: { thinking: " then å" } }, tool("second å"), { ...text("After "), done: true } ];
  const bytes = Buffer.concat(records.map(record => line(record)));
  const result = await run([{ chunks: [...bytes].map(byte => Buffer.from([byte])) }, finish()]);
  assert.equal(result.thinking, "Think æ then å");
  assert.equal(result.answer, "Before After Finished.");
  assert.deepEqual(result.effects, ["first ø", "second å"]);
  assert.deepEqual(result.events, [["transportProbe", undefined], ["transportProbe", undefined],
    ["transportProbe", "[success]Stored."], ["transportProbe", "[success]Stored."]]);
  const dir = require("../utils/dir").chatHistoryDir;
  const history = fs.readdirSync(dir).flatMap(name => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
  const assistant = history.find((message: any) => message.role === "assistant" && message.content === "Before After ");
  assert.deepEqual(assistant.tool_calls, [tool("first ø").message.tool_calls, tool("second å").message.tool_calls]);
});

test("K complete malformed JSON is logged and skipped, with no dispatch from it", async () => {
  const bad = Buffer.from('{"message":{"tool_calls":["transportProbe"]},broken}\n');
  const result = await run([{ chunks: [Buffer.concat([bad, line(text("After malformed.")), line(done)])] }]);
  assert.equal(result.answer, "After malformed.");
  assert.deepEqual(result.effects, []);
  assert.match(result.errors.join(" "), /parsing/i);
});

test("L transport error, premature close and Ollama error cannot dispatch pending tools", async () => {
  for (const stop of ["error", "close"] as const) {
    const result = await run([{ chunks: [line(tool("unsafe")), Buffer.from('{"partial":')], stop }]);
    assert.deepEqual(result.effects, []);
    assert.match(result.errors.join(" "), /failure|closed|truncat/i);
    assert.match(result.errors.join(" "), /truncat/i);
  }
  const result = await run([{ chunks: [line(tool("unsafe")), line({ error: "Simulated Ollama failure" }), line(done)] }]);
  assert.deepEqual(result.effects, []);
  assert.equal(result.answer, "");
  assert.match(result.errors.join(" "), /Simulated Ollama failure/);
  const missingDone = await run([{ chunks: [line(tool("unsafe"))] }]);
  assert.deepEqual(missingDone.effects, []);
  assert.match(missingDone.errors.join(" "), /done/);
});

test("M disabled tools stay disabled after fragmented native and JSON fallback calls", async () => {
  for (const record of [tool("blocked"), text(JSON.stringify({ name: "transportProbe", arguments: { label: "blocked" } }))]) {
    const bytes = Buffer.concat([line(record), line(done)]);
    const result = await run([{ chunks: [...bytes].map(byte => Buffer.from([byte])) }], false);
    assert.deepEqual(result.effects, []);
    assert.equal(requests[0].tools, undefined);
  }
});

test("N every single-byte boundary gives identical parsing and application results", async () => {
  const representatives = [
    {
      bytes: Buffer.concat([line({ message: { thinking: "æøå" } }, "\r\n"), line({ ...text("Text æøå."), done: true })]),
      expected: { answer: "Text æøå.", thinking: "æøå", events: [], ends: 1, effects: [], errors: [] },
      hasTool: false,
    },
    {
      bytes: Buffer.concat([line(text("Prefix æ")), line(tool("æøå"), "\r\n"), line(done)]),
      expected: { answer: "Prefix æFinished.", thinking: "", events: [
        ["transportProbe", undefined], ["transportProbe", "[success]Stored."],
      ], ends: 1, effects: ["æøå"], errors: [] },
      hasTool: true,
    },
  ];
  let singleSplits = 0;
  for (const { bytes, expected, hasTool } of representatives) {
    const evaluate = (chunks: Buffer[]) => run([{ chunks }, ...(hasTool ? [finish()] : [])]);
    assert.deepEqual(await evaluate([bytes]), expected);
    assert.deepEqual(await evaluate([...bytes].map(byte => Buffer.from([byte]))), expected);
    // Exhaustive: includes every split inside every multibyte UTF-8 character,
    // CR/LF, JSON string, tool name/arguments and done marker. No sampled cuts.
    for (let boundary = 1; boundary < bytes.length; boundary++) {
      assert.deepEqual(await evaluate(split(bytes, [boundary])), expected, `byte boundary ${boundary}/${bytes.length}`);
      singleSplits++;
    }
    const cuts: number[] = [];
    for (let position = 1, step = 1; position < bytes.length; step++) {
      cuts.push(position); position += (step % 11) + 1;
    }
    assert.deepEqual(await evaluate(split(bytes, cuts)), expected);
  }
  console.log(`[NDJSON boundary invariance] lengths=${representatives.map(({ bytes }) => bytes.length).join(",")} exhaustive single splits=${singleSplits}`);
});

test("O sequential and concurrent requests cannot share buffered fragments", async () => {
  const bad = Buffer.from(JSON.stringify(tool("must never execute")));
  await run([{ chunks: [bad.subarray(0, 45)] }]);
  const sequential = await run([{ chunks: [line({ ...text("Independent æøå."), done: true })] }]);
  assert.equal(sequential.answer, "Independent æøå.");
  assert.deepEqual(sequential.effects, []);
  const first = client(true), second = client(false);
  first.resetChatHistory(); second.resetChatHistory();
  plans = [ { chunks: split(bad.subarray(0, -4), [15, 40]), interleave: true },
    { chunks: split(line({ ...text("Concurrent øå."), done: true }), [10, 30]), interleave: true } ];
  effects = []; errors = [];
  const [broken, valid] = await Promise.all([ask(first), ask(second)]);
  assert.equal(broken.answer, "");
  assert.equal(valid.answer, "Concurrent øå.");
  assert.deepEqual(effects, []);
  assert.match(errors.join(" "), /truncat/i);
  assert.equal(plans.length, 0);

  // The public provider deliberately cancels an older request on a new
  // question. Preserve that behavior, including disposal of its partial line.
  let firstChunk!: () => void;
  const started = new Promise<void>(resolve => { firstChunk = resolve; });
  const abandoned = Buffer.concat([line(tool("abandoned")), line(done)]);
  first.resetChatHistory(); effects = []; errors = [];
  plans = [{ chunks: split(abandoned, [40]), interleave: true, afterFirstChunk: firstChunk },
    { chunks: [line({ ...text("New question."), done: true })] }];
  const older = ask(first);
  await started;
  const newer = ask(first);
  const [cancelled, replacement] = await Promise.all([older, newer]);
  assert.equal(cancelled.answer, "");
  assert.equal(replacement.answer, "New question.");
  assert.deepEqual(effects, []);
  assert.match(errors.join(" "), /cancel/i);
  assert.equal(plans.length, 0);
});

test("final no-tools answer stream also reconstructs records and rejects truncation", async () => {
  const bytes = Buffer.concat([line({ message: { thinking: "æøå" } }), line({ ...text("Final æøå."), done: true })]);
  const result = await run([{ chunks: [line(tool("limit")), line(done)] },
    { chunks: [...bytes].map(byte => Buffer.from([byte])) }], true, 0);
  assert.equal(result.answer, "Final æøå.");
  assert.equal(result.thinking, "æøå");
  assert.deepEqual(result.effects, []);
  const failed = await run([{ chunks: [line(tool("limit")), line(done)] },
    { chunks: [Buffer.from('{"message":{"content":"incomplete')] }], true, 0);
  assert.equal(failed.answer, "");
  assert.match(failed.errors.join(" "), /truncat/i);
});

// The limit is specified independently of the implementation constant.
const RECORD_LIMIT = 1024 * 1024;
const RECORD_LIMIT_REPLY = "Resource limit exceeded: Ollama NDJSON record exceeds 1048576 UTF-8 bytes. Tool execution stopped for this request. Completion was not verified.";
// Record reconstruction is independent of the provider's smaller 256 KiB
// accumulated text budget. Keep the exact original record-boundary assertions.
async function readRecordText(chunks: Buffer[]) {
  errors = [];
  const stream = new PassThrough();
  let answer = "";
  const completion = readOllamaNDJSON(stream, record => { answer += record.message?.content || ""; });
  for (const chunk of chunks) stream.write(chunk);
  stream.end();
  await completion;
  return { answer, errors: [...errors] };
}
function sizedRecord(size: number, prefix = "", ending = "\n", isDone = true) {
  const overhead = Buffer.byteLength(JSON.stringify({ ...text(prefix), done: isDone }));
  const content = prefix + "x".repeat(size - overhead);
  const bytes = line({ ...text(content), done: isDone }, ending);
  assert.equal(bytes.length - Buffer.byteLength(ending), size);
  return { bytes, content };
}

test("record limit: a record below 1 MiB is accepted", async () => {
  const record = sizedRecord(RECORD_LIMIT - 1);
  const result = await readRecordText([record.bytes]);
  assert.equal(result.answer, record.content);
  assert.deepEqual(result.errors, []);
});

test("record limit: exactly 1 MiB is accepted with LF and split CRLF", async () => {
  for (const ending of ["\n", "\r\n"]) {
    const record = sizedRecord(RECORD_LIMIT, "", ending);
    const result = await readRecordText(split(record.bytes, [record.bytes.length - 1]));
    assert.equal(result.answer, record.content);
    assert.deepEqual(result.errors, []);
  }
});

test("record limit: a complete record exceeding 1 MiB is rejected before parsing", async () => {
  const exact = sizedRecord(RECORD_LIMIT).bytes;
  for (const chunks of [
    [sizedRecord(RECORD_LIMIT + 1).bytes],
    // A CR deferred as a potential delimiter must count if more data follows.
    [exact.subarray(0, -1), Buffer.from("\r"), Buffer.from("x\n")],
  ]) {
    const result = await run([{ chunks }]);
    assert.equal(result.answer, RECORD_LIMIT_REPLY);
    assert.deepEqual(result.effects, []);
    assert.match(result.errors.join(" "), /record exceeds 1048576 UTF-8 bytes/);
  }
});

test("record limit: Unicode is counted as UTF-8 bytes across character boundaries", async () => {
  const exact = sizedRecord(RECORD_LIMIT, "æøå");
  const insideCharacter = exact.bytes.indexOf(Buffer.from("æ")) + 1;
  assert.ok(exact.bytes.toString("utf8").length - 1 < RECORD_LIMIT);
  const accepted = await readRecordText(split(exact.bytes, [insideCharacter]));
  assert.equal(accepted.answer, exact.content);
  assert.deepEqual(accepted.errors, []);
  const oversized = sizedRecord(RECORD_LIMIT + 1, "æøå");
  assert.ok(oversized.bytes.toString("utf8").length - 1 < RECORD_LIMIT,
    "a JavaScript character limit would incorrectly accept this record");
  const rejected = await run([{ chunks: split(oversized.bytes, [insideCharacter]) }]);
  assert.equal(rejected.answer, RECORD_LIMIT_REPLY);
  assert.match(rejected.errors.join(" "), /record exceeds 1048576 UTF-8 bytes/);
});

test("record limit: fragmented oversized data is rejected before EOF or newline", async () => {
  const oversized = Buffer.alloc(RECORD_LIMIT + 1, "x");
  const stream = new PassThrough();
  const records: unknown[] = [];
  const completion = readOllamaNDJSON(stream, record => records.push(record))
    .then(() => undefined, (error: Error) => error);
  for (const chunk of split(oversized, [4096, RECORD_LIMIT])) stream.write(chunk);
  const destroyedBeforeEOF = stream.destroyed;
  stream.end(); // Capture the state before allowing EOF to settle a regression.
  const error = await completion;
  assert.equal(destroyedBeforeEOF, true);
  assert.deepEqual(records, []);
  assert.match(error?.message || "", /record exceeds 1048576 UTF-8 bytes/);
});

test("record limit: multiple valid records can share a chunk larger than 1 MiB", async () => {
  const first = sizedRecord(600 * 1024, "æ", "\r\n", false);
  const second = sizedRecord(600 * 1024, "øå");
  const chunk = Buffer.concat([first.bytes, second.bytes]);
  assert.ok(chunk.length > RECORD_LIMIT);
  const result = await readRecordText([chunk]);
  assert.equal(result.answer, first.content + second.content);
  assert.deepEqual(result.errors, []);
});

test("record limit: oversized failure blocks all pending native and JSON-fallback tools", async () => {
  for (const pending of [tool("blocked"), text(JSON.stringify({ name: "transportProbe", arguments: { label: "blocked" } }))]) {
    const result = await run([{ chunks: [Buffer.concat([
      line(pending), sizedRecord(RECORD_LIMIT + 1).bytes, line(done),
    ])] }]);
    assert.deepEqual(result.effects, []);
    assert.deepEqual(result.events, []);
    assert.equal(result.answer, RECORD_LIMIT_REPLY);
    assert.match(result.errors.join(" "), /record exceeds 1048576 UTF-8 bytes/);
  }
});
