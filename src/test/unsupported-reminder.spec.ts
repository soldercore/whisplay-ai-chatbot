import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import axios from "axios";

const REPLY = "I can't set timed reminders yet, so no reminder has been created.";
const FALSE_PROMISE = "In two minutes, I will call the doctor for you.";
const requests: any[] = [], effects: unknown[] = [];
const originalPost = axios.post;
let llm: any, provider: any;
let modelReply = FALSE_PROMISE;
let volumeRequest = false;
let holdNextResponse = false;
let firstChunkDelivered: () => void = () => {};
const audioPath = require.resolve("../device/audio");
const originalAudio = require.cache[audioPath];
const volumePath = require.resolve("../utils/volume");
const originalVolume = require.cache[volumePath];

before(() => {
  const dirs = require("../utils/dir");
  assert.match(dirs.dataDir, /\.test-artifacts/);
  Object.assign(process.env, { LLM_SERVER: "ollama", OLLAMA_MODEL: "test", OLLAMA_ENABLE_TOOLS: "true",
    WEB_SEARCH_ENABLED: "false", ENABLE_THINKING: "false", CONTEXT_AUTO_COMPACT_ENABLED: "false",
    MEMORY_ENABLED: "true", MEMORY_DIR: path.join(dirs.dataDir, "memory"), ASSISTANT_PERSONA: "default" });
  // No mixer, audio device, real HTTP endpoint or external plugin is used.
  require.cache[audioPath] = { id: audioPath, filename: audioPath, loaded: true, exports: {
    playAudioData: async () => {}, stopPlaying() {},
  } } as NodeModule;
  require.cache[volumePath] = { id: volumePath, filename: volumePath, loaded: true, exports: {
    setVolumeByAmixer: (percent: number) => effects.push(percent), getCurrentLogPercent: () => 20,
  } } as NodeModule;
  axios.post = (async (url: string, body: any, config: any) => {
    if (url.endsWith("/api/show")) return { data: { model_info: { context_length: 32768 } } };
    if (body.stream === false) return { data: { done: true, done_reason: "load" } };
    requests.push(body);
    const stream = new PassThrough();
    if (holdNextResponse) {
      holdNextResponse = false;
      const abort = () => stream.destroy(new Error("Fixture request cancelled"));
      config.signal.addEventListener("abort", abort, { once: true });
      stream.once("close", () => config.signal.removeEventListener("abort", abort));
      setImmediate(() => { stream.write('{"message":{"content":"'); firstChunkDelivered(); });
      return { data: stream };
    }
    const records = volumeRequest && requests.length === 1
      ? [{ message: { tool_calls: [{ function: { name: "setVolume", arguments: { percent: 40 } } }] } }, { done: true }]
      : [{ message: { content: modelReply }, done: true }];
    setImmediate(() => { for (const record of records) stream.write(JSON.stringify(record) + "\n"); stream.end(); });
    return { data: stream };
  }) as typeof axios.post;
  llm = require("../cloud-api/llm");
  provider = require("../cloud-api/local/ollama-llm").default;
});
beforeEach(() => { requests.length = 0; effects.length = 0; modelReply = FALSE_PROMISE; volumeRequest = false; holdNextResponse = false; llm.resetChatHistory(); });
after(() => {
  axios.post = originalPost;
  for (const [filename, original] of [[audioPath, originalAudio], [volumePath, originalVolume]] as const) {
    if (original) require.cache[filename] = original; else delete require.cache[filename];
  }
});

async function ask(question: string, selected = llm) {
  let answer = "", ends = 0;
  const events: string[] = [];
  await selected.chatWithLLMStream([{ role: "user", content: question }], (part: string) => answer += part,
    () => ends++, undefined, (name: string) => events.push(name));
  return { answer, ends, events };
}

for (const question of [
  "Can you remind me in two minutes to call the doctor?",
  "Remind me in two minutes to call the doctor.",
  "Remind me to call the doctor in two minutes.",
  "Can you remind me tomorrow to call the doctor?",
  "Set a reminder for tomorrow to call the doctor.",
  "Please remind me in 2 minutes to call the doctor.",
  "Could you set a reminder for two minutes from now to call the doctor?",
]) test(`unsupported direct reminder bypasses generation: ${question}`, async () => {
  assert.deepEqual(await ask(question), { answer: REPLY, ends: 1, events: [] });
  assert.deepEqual(requests, []);
  assert.deepEqual(effects, []);
});

for (const question of [
  "What does remind mean?", "Can you explain how reminders work?", "What is a reminder schedule?",
  "What does schedule mean?", "How do I schedule an appointment?", "What is a phone call?",
  "Why would someone call the doctor?", "Hello, how are you?",
  'Explain the sentence "Remind me in two minutes to call the doctor."',
  "Remind me of the plot of Portal.", "Can you remind me what photosynthesis means?",
  "What does I will mean?",
]) test(`non-action text retains normal generation: ${question}`, async () => {
  modelReply = "Ordinary model answer.";
  assert.deepEqual(await ask(question), { answer: "Ordinary model answer.", ends: 1, events: [] });
  assert.equal(requests.length, 1);
});

test("guarded turn is retained exactly in disk and next-request history without fabricated tool results", async () => {
  const question = "Can you remind me in two minutes to call the doctor?";
  assert.equal((await ask(question)).answer, REPLY);
  const historyDir = require("../utils/dir").chatHistoryDir;
  const saved = fs.readdirSync(historyDir).flatMap((name: string) => JSON.parse(fs.readFileSync(path.join(historyDir, name), "utf8")));
  const exchange = [{ role: "user", content: question }, { role: "assistant", content: REPLY }];
  assert.deepEqual(saved.slice(-2), exchange);
  modelReply = "Nothing was scheduled.";
  await ask("What happened?");
  assert.deepEqual(requests[0].messages.slice(1), [...exchange, { role: "user", content: "What happened?" }]);
  assert.deepEqual(effects, []);
});

test("supported volume action keeps central authorization and real handler dispatch", async () => {
  volumeRequest = true; modelReply = "The volume is 40 percent.";
  assert.equal((await ask("Set the volume to 40 percent.")).answer, modelReply);
  assert.deepEqual(effects, [40]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.find((m: any) => m.role === "tool").content, "[success]Volume set to 40%");
});

test("supported deterministic memory action is preserved and reminder is not stored as a fact", async () => {
  assert.match((await ask("Remember that my favorite color is blue.")).answer, /favorite color is blue/);
  const store = path.join(process.env.MEMORY_DIR!, "memory.json");
  const before = fs.readFileSync(store, "utf8");
  assert.equal((await ask("Remind me tomorrow to call the doctor.")).answer, REPLY);
  assert.equal(fs.readFileSync(store, "utf8"), before);
  assert.deepEqual(requests, []);
});

test("direct provider callers receive the same pre-generation refusal", async () => {
  assert.equal((await ask("Remind me in two minutes to call the doctor.", provider)).answer, REPLY);
  assert.deepEqual(requests, []);
});

test("guarded replacement cancels an unfinished answer and retains only the truthful new exchange", async () => {
  const ready = new Promise<void>(resolve => { firstChunkDelivered = resolve; });
  holdNextResponse = true;
  const abandoned = ask("Tell me about Portal.");
  await ready;
  const question = "Remind me in two minutes to call the doctor.";
  assert.deepEqual(await ask(question), { answer: REPLY, ends: 1, events: [] });
  assert.deepEqual(await abandoned, { answer: "", ends: 1, events: [] });
  assert.equal(requests.length, 1, "only the abandoned request reached generation");
  modelReply = "No reminder exists.";
  await ask("What happened?");
  assert.deepEqual(requests[1].messages.slice(1), [
    { role: "user", content: question }, { role: "assistant", content: REPLY },
    { role: "user", content: "What happened?" },
  ]);
  assert.deepEqual(effects, []);
});

test("a new memory command is independent of an unfinished model request and cancels it", async () => {
  const ready = new Promise<void>(resolve => { firstChunkDelivered = resolve; });
  holdNextResponse = true;
  const abandoned = ask("Tell me about Portal.");
  await ready;
  const saved = await ask("Remember that my favorite animal is a penguin.");
  assert.match(saved.answer, /favorite animal is a penguin/);
  assert.equal(saved.ends, 1);
  assert.deepEqual(await abandoned, { answer: "", ends: 1, events: [] });
  assert.equal(requests.length, 1, "deterministic memory must not generate another model answer");
});

for (const ragEnabled of [false, true]) test(`recognized text uses existing TTS/display without RAG or summary generation (RAG=${ragEnabled})`, async () => {
  const { StreamResponser } = require("../core/StreamResponsor");
  const synthesized: string[] = [], displayed: string[] = [], played: string[] = [];
  const stream = new StreamResponser(async (text: string) => { synthesized.push(text); return { duration: 1, buffer: Buffer.alloc(0) }; },
    (sentences: string[]) => displayed.push(sentences.join(" ")), undefined,
    ({ sentence }: { sentence: string }) => played.push(sentence));
  // Run the actual answer state with hardware, ASR and prompt preparation stubbed.
  const exported: any = {};
  const noop = () => {};
  let ragQueries = 0, summaryCalls = 0;
  const saved: unknown[] = [];
  const stubs: Record<string, any> = {
    "../../device/display": { display: noop, onButtonPressed: noop, onButtonReleased: noop, onButtonDoubleClick: noop },
    "../../device/audio": {}, "../../cloud-api/server": { chatWithLLMStream: llm.chatWithLLMStream, llmServer: "ollama" },
    "../../cloud-api/llm": { isImMode: false, summaryTextWithLLM: () => { summaryCalls++; } },
    "../Knowledge": { getSystemPromptWithKnowledge: async () => { ragQueries++; return "Fixture knowledge."; } },
    "../../cloud-api/knowledge": { enableRAG: ragEnabled }, "../../utils/dir": require("../utils/dir"),
    "../../utils/image": { clearPendingCapturedImgForChat: noop, getLatestDisplayImg: noop },
    "../../cloud-api/whisplay-im/whisplay-im": {}, "./camera-mode": {}, "../../utils": {},
    "../../device/music-player": {}, "../../config/local-memory": { prepareMemoryPrompt: () => "",
      autoSaveExchange: (user: string, answer: string, summarize?: Function) => {
        saved.push([user, answer]); summarize?.("Fixture transcript.", "Summarize.");
      } },
    "../../config/unsupported-reminder": require("../config/unsupported-reminder"),
  };
  const source = fs.readFileSync(path.join(__dirname, "../core/chat-flow/states.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  vm.runInNewContext(compiled, { exports: exported, console, require: (name: string) => {
    if (name === "moment" || name === "lodash") return require(name);
    if (Object.prototype.hasOwnProperty.call(stubs, name)) return stubs[name];
    throw new Error(`Unexpected state dependency ${name}`);
  } });
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const ctx: any = { asrText: "Can you remind me in two minutes to call the doctor?", answerId: 1,
    currentFlowName: "answer", knowledgePrompts: [], streamResponser: stream, resetToolCallDisplay: noop,
    revealAllAnswerText: noop, transitionTo: () => { ctx.currentFlowName = "sleep"; finish(); } };
  exported.flowStates.answer(ctx);
  await completed;
  const spokenChunks = ["I can't set timed reminders yet,", "so no reminder has been created."];
  assert.deepEqual(synthesized, spokenChunks);
  assert.deepEqual(displayed, [REPLY]);
  assert.deepEqual(played, spokenChunks);
  assert.deepEqual(requests, []);
  assert.deepEqual(effects, []);
  assert.equal(ragQueries, 0);
  assert.equal(summaryCalls, 0);
  assert.deepEqual(saved, [[ctx.asrText, REPLY]], "ordinary conversation saving still receives the truthful exchange");
});
