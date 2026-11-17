import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
process.env.CAPRI_RESIDENT = "0";   // these fakes exit after each listen; the resident protocol: capri-resident and conversation-lifecycle specs

// Question-triggered follow-ups (QUESTION_FOLLOWUPS) on the real state handlers and the real Capri listener (fake children).
// Invariant: whenever the device is idle (flow "sleep"), exactly one Capri child is running and has reported READY; whenever it is
// not idle, no Capri child holds the microphone. Checked over repeated conversations that end in every exit path, using the REAL
// WakeWordListener (start/stop/restart logic) with fake child processes and the REAL state handlers with stubbed devices.
Object.assign(process.env, {
  LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true", OLLAMA_MODEL: "fixture", ENABLE_THINKING: "false", WEB_SEARCH_ENABLED: "false",
  MEMORY_ENABLED: "false", CAPRI_WAKE_WORD_ENABLED: "true",
});
delete process.env.CONVERSATION_FOLLOWUPS;
const pc = require("../utils/pending-clarification");
const { composeIdleStatus } = require("../utils/ui-status");

// ---- Fake Capri children ----------------------------------------------------------------------------------------------
class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); alive = true; pid: number;
  constructor(pid: number) { super(); this.pid = pid; }
}
const children: FakeChild[] = [];
let maxAlive = 0;
const aliveCount = () => children.filter(c => c.alive).length;
const fakeLifecycle = {
  appSignal: { aborted: false }, onAppShutdown: () => {},
  spawnOwned: () => {
    const child = new FakeChild(1000 + children.length);
    children.push(child);
    maxAlive = Math.max(maxAlive, aliveCount());
    setImmediate(() => child.stdout.write("CAPRI_READY\n"));
    return child;
  },
  stopOwnedChild: (child: FakeChild) => new Promise<void>(resolve => setTimeout(() => {   // confirmed exit, like the real helper
    child.alive = false;
    child.emit("close", null);
    resolve();
  }, 15)),
};

const noop = () => {};
const loose = () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : noop) });
let pressed: (() => void) | undefined;
const events: any[] = [];
const atRecord: number[] = [];
let currentTv: any = { volume: 0 };
const recordSeconds: number[] = [];
const stubs: Record<string, any> = {
  "../utils/app-lifecycle": fakeLifecycle,
  "../../device/display": {
    onButtonPressed: (fn: any) => { pressed = fn || undefined; }, onButtonReleased: noop, onButtonDoubleClick: noop, display: noop,
    getCurrentStatus: () => ({ text: "x" }), onCameraCapture: noop, onTextInput: noop, isButtonDown: () => false,
  },
  "../../device/audio": { recordAudio: async (_f: string, seconds: number) => { events.push("record"); recordSeconds.push(seconds); atRecord.push(currentTv.volume); }, recordAudioManually: () => ({ result: new Promise(() => {}), stop: noop }),
    recordFileFormat: "wav", getDynamicVoiceDetectLevel: async () => 25, voiceDetectEndSilenceSec: 1.5 },
  "../../cloud-api/server": { chatWithLLMStream: noop, llmServer: "ollama" },
  "../../cloud-api/llm": { isImMode: false, summaryTextWithLLM: noop },
  "../Knowledge": { getSystemPromptWithKnowledge: async () => "" },
  "../../cloud-api/knowledge": { enableRAG: false },
  "../../utils/dir": { cameraDir: "/tmp" },
  "../../utils/image": { clearPendingCapturedImgForChat: noop, getLatestGenImg: () => "", getLatestDisplayImg: () => "", setLatestCapturedImg: noop, setPendingCapturedImgForChat: noop },
  "../../cloud-api/whisplay-im/whisplay-im": { sendWhisplayIMMessage: noop },
  "./camera-mode": { enterCameraMode: noop, handleCameraModePress: noop, handleCameraModeRelease: noop, onCameraModeExit: noop, resetCameraModeControl: noop },
  "../../device/music-player": loose(),
  "../../config/local-memory": { autoSaveExchange: noop, prepareMemoryMessage: () => undefined },
  "../../device/whisplay-control": { whisplayHandoffTicket: () => undefined, presentWhisplayHandoff: async () => {}, cancelWhisplayHandoff: noop },
};
const load = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  return request in stubs ? stubs[request] : load.call(this, request, parent, isMain);
};
const { flowStates } = require("../core/chat-flow/states");
const { WakeWordListener } = require("../device/wakeword");
const ducking = require("../device/tv-ducking");
(Module as any)._load = load;

// ---- A ChatFlow-shaped harness: the same transitionTo contract as ChatFlow (stop Capri when leaving sleep, start it in sleep) ----
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Exit = { name: string; turns: { heard: string; reply?: string; tools?: string[]; fail?: boolean }[]; limit?: string; interrupt?: boolean; asrThrows?: boolean };

function makeFlow(exit: Exit, duck?: any) {
  const listener = new WakeWordListener(true);
  const visited: string[] = [];
  let turn = 0;
  const ctx: any = {
    answerId: 0, enterMusicAfterAnswer: false, musicDisplayText: "", isFromWakeListening: false, clarificationListen: false, wakeRecordMaxSec: 60,
    recordingsDir: "/tmp", currentRecordFilePath: "", wakeSessionActive: false, endAfterAnswer: false, enableCamera: false, currentFlowName: "sleep",
    conversationFollowUps: 0, conversationCapture: false, asrText: "", answerDisplayText: "", partialThinking: "", thinkingSentences: [],
    wakeSessionLastSpeechAt: 0, shouldContinueWakeSession: () => false, endWakeSession: () => { ctx.wakeSessionActive = false; },
    pauseWakeWordListener: async () => {}, shouldEndAfterAnswer: (t: string) => /\b(goodbye|stop|byebye)\b/i.test(t),
    idleStatus: () => composeIdleStatus({ capriReady: false, pendingClarification: false }), scheduleIdleRefresh: noop,
    resetToolCallDisplay: noop, appendToolCallDisplay: noop, finishToolCallDisplay: noop, keepCommandToolDisplayRunning: noop,
    finishCommandToolDisplay: noop, revealAllAnswerText: noop, partialThinkingCallback: noop, composeAnswerDisplayText: (t: string) => t,
    updateAnswerDisplayText: noop, streamResponser: { partial: noop, endPartial: noop, stop: noop, getPlayEndPromise: () => Promise.resolve() },
    transitionTo: (name: string) => {
      visited.push(name);
      ctx.currentFlowName = name;
      duck?.touch();
      if (name === "sleep") duck?.end();                // ChatFlow.transitionTo: the only place a conversation ends
      if (name !== "sleep") void listener.stop();      // ChatFlow.transitionTo: leaving idle releases the microphone first
      queue.push(name);
      if (name === "sleep") listener.start();           // ... and idle restarts Capri
    },
    recognizeAudio: async () => {
      if (exit.asrThrows) throw new Error("whisper down");
      const t = exit.turns[turn + 1];
      if (!t) return "";
      turn += 1;
      return t.heard;
    },
  };
  const queue: string[] = [];
  stubs["../../cloud-api/server"].chatWithLLMStream = async (_p: any, partial: any, end: any, _t: any, tool: any) => {
    const t = exit.turns[turn];
    for (const name of t?.tools ?? []) { tool(name); tool(name, "[success] done"); }
    if (t?.fail) throw new Error("llm down");
    if (t?.reply) partial(t.reply);
    end();
  };
  let ready = 0;
  listener.on("listening", () => { if (ctx.currentFlowName === "sleep") duck?.begin(); });   // what ChatFlow does
  listener.on("idle", () => { if (ctx.currentFlowName === "sleep") duck?.end(); });
  listener.on("ready", () => { ready += 1; });
  listener.on("command", (text: string) => {            // what ChatFlow does for a Capri command
    if (ctx.currentFlowName !== "sleep") return;
    ctx.answerId += 1; ctx.endWakeSession(); ctx.conversationFollowUps = 0; ctx.conversationCapture = false;
    ctx.asrText = text;
    ctx.transitionTo("answer");
  });
  return { ctx, listener, visited, queue, readyCount: () => ready, turns: () => turn };
}

async function runStates(flow: ReturnType<typeof makeFlow>, exit: Exit) {
  const started = Date.now();
  while (Date.now() - started < 9000) {
    const name = flow.queue.shift();
    if (!name) { await wait(40); if (!flow.queue.length && flow.ctx.currentFlowName === "sleep" && flow.visited.at(-1) === "sleep") break; continue; }
    if (name === "sleep") { flowStates.sleep(flow.ctx); continue; }
    flowStates[name](flow.ctx);
    if (exit.interrupt && name === "wake_listening") { await wait(20); pressed?.(); }   // the user presses the button during the follow-up window
    await wait(30);
  }
}


class FakeTv {
  volume = 20; muted = false; output = "tv_speaker"; online = true; sets: number[] = [];
  fn = async (decide: (c: any) => any) => {
    if (!this.online) return { status: "UNAVAILABLE" };
    const current = { value: this.volume, output: this.output, muted: this.muted };
    const plan = await decide(current);
    if ("skip" in plan) return { status: "SKIPPED", reason: plan.skip, current };
    this.sets.push(plan.target); this.volume = plan.target;
    return { status: "SET", before: current.value, actual: plan.target };
  };
}
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tv-duck-flow-")), "state.json");

type Turn2 = { heard: string; reply?: string; tools?: string[]; fail?: boolean };
async function talk(env: Record<string, string>, turns: Turn2[], opts: { asrThrows?: boolean; tv?: FakeTv; arm?: boolean } = {}) {
  for (const key of ["QUESTION_FOLLOWUPS", "CONVERSATION_FOLLOWUPS"]) delete process.env[key];
  Object.assign(process.env, { CONVERSATION_FOLLOWUPS: "0" }, env);
  children.length = 0; maxAlive = 0; events.length = 0; atRecord.length = 0; pressed = undefined; pc.clearClarification();
  if (opts.arm) pc.markClarification(10_000);
  const tv = opts.tv ?? new FakeTv();
  currentTv = tv;
  const duck = new ducking.TvDucker({ tv: tv.fn, env: { TV_DUCKING: "1" }, stateFile, log: noop });
  const exit: Exit = { name: "d", turns: turns as any, asrThrows: opts.asrThrows };
  const flow = makeFlow(exit, duck);
  flow.ctx.currentFlowName = "sleep"; flow.listener.start();
  await wait(60);
  flow.visited.length = 0;
  children[0].stdout.write("CAPRI_LISTENING\n");           // wake word heard: the command capture starts, the TV is lowered in the background
  await wait(60);
  const duckedDuringCapture = tv.volume;
  children[0].stdout.write(`CAPRI_COMMAND ${JSON.stringify("tell me about AI")}\n`);
  await wait(80);
  await runStates(flow, exit);
  await wait(150);
  const result = { tv, flow, duck, duckedDuringCapture, visited: flow.visited.slice(), alive: aliveCount(), atRecord: atRecord.slice() };
  await flow.listener.stop();
  return result;
}
const q1 = { heard: "q", reply: "AI has enormous potential. What interests you most about it?" };
const q2 = { heard: "Building my own assistant.", reply: "Splendid. Which part of it do you find hardest?" };
const plain = { heard: "q", reply: "AI has enormous potential." };

test("plain conversation: lowered as soon as the wake word is heard, restored when idle, Capri back", async () => {
  const r = await talk({}, [plain]);
  assert.equal(r.duckedDuringCapture, 8, "lowered while the command is still being captured");
  assert.deepEqual(r.tv.sets, [8, 20]);
  assert.equal(r.tv.volume, 20);
  assert.equal(r.visited.at(-1), "sleep"); assert.equal(r.alive, 1);
  assert.equal(r.duck.active, false);
});

test("question follow-ups keep the TV lowered; one duck and one restore for the whole conversation", async () => {
  const r = await talk({ QUESTION_FOLLOWUPS: "3" }, [q1, q2, { heard: "More.", reply: "Splendid. That is a lot of wiring." }]);
  assert.ok(r.atRecord.length >= 2, `follow-up recordings happened: ${r.atRecord.length}`);
  assert.ok(r.atRecord.every(v => v === 8), `TV stayed lowered while listening: ${r.atRecord}`);
  assert.deepEqual(r.tv.sets, [8, 20]);
  assert.equal(r.tv.volume, 20); assert.equal(r.alive, 1);
});

test("clarification follow-up keeps the TV lowered", async () => {
  const r = await talk({}, [{ heard: "q", reply: "Do you mean the TV screen or Whisplay's screen?" }, { heard: "The TV.", reply: "Done." }], { arm: true });
  assert.ok(r.atRecord.length >= 1, "the clarification listened");
  assert.ok(r.atRecord.every(v => v === 8), `lowered while the clarification listened: ${r.atRecord}`);
  assert.deepEqual(r.tv.sets, [8, 20]);
  assert.equal(r.tv.volume, 20);
});

test("silence, goodbye, ASR failure, failed answer and device action all restore", async () => {
  const cases: [string, Record<string, string>, Turn2[], { asrThrows?: boolean }][] = [
    ["silence after a question", { QUESTION_FOLLOWUPS: "3" }, [q1], {}],
    ["goodbye", { QUESTION_FOLLOWUPS: "3" }, [q1, { heard: "goodbye", reply: "Farewell. Will you come back soon?" }], {}],
    ["asr failure", { QUESTION_FOLLOWUPS: "3" }, [q1], { asrThrows: true }],
    ["failed answer", {}, [{ heard: "q", fail: true }], {}],
    ["device action", { QUESTION_FOLLOWUPS: "3" }, [{ heard: "q", reply: "Screen off. Anything else?", tools: ["setTvScreenAndReply"] }], {}],
  ];
  for (const [name, env, turns, opts] of cases) {
    const r = await talk(env, turns, opts);
    assert.equal(r.tv.volume, 20, name);
    assert.equal(r.visited.at(-1), "sleep", name);
    assert.deepEqual(r.tv.sets, [8, 20], name);
    assert.equal(r.alive, 1, `${name}: Capri available`);
    assert.equal(r.duck.active, false, name);
  }
});

test("a volume the user sets during the conversation is respected at the end", async () => {
  const manual = new FakeTv();
  const done = talk({}, [plain], { tv: manual });
  setTimeout(() => { manual.volume = 25; }, 140);   // the user (or a TV command) sets 25 while GLaDOS is talking
  const m = await done;
  assert.equal(m.tv.volume, 25, "the user's own volume wins");
  assert.deepEqual(m.tv.sets, [8], "no restore was sent over it");
});

test("TV off: the conversation is unaffected; muted TV stays muted; quiet TV untouched", async () => {
  const off = new FakeTv(); off.online = false;
  const a = await talk({ QUESTION_FOLLOWUPS: "3" }, [q1], { tv: off });
  assert.deepEqual(a.tv.sets, []); assert.equal(a.visited.at(-1), "sleep"); assert.equal(a.alive, 1);
  const muted = new FakeTv(); muted.muted = true;
  const b = await talk({}, [plain], { tv: muted });
  assert.deepEqual(b.tv.sets, []); assert.equal(b.tv.muted, true);
  const quiet = new FakeTv(); quiet.volume = 4;
  const c = await talk({}, [plain], { tv: quiet });
  assert.deepEqual(c.tv.sets, []); assert.equal(c.tv.volume, 4);
});

test("20 repeated conversations: never a duplicate duck, always restored, Capri healthy every time", async () => {
  const tv = new FakeTv();
  for (let i = 0; i < 20; i++) {
    const turns: Turn2[] = i % 3 === 0 ? [q1] : i % 3 === 1 ? [q1, q2] : [plain];
    const r = await talk({ QUESTION_FOLLOWUPS: "3" }, turns, { tv, asrThrows: i % 5 === 4 });
    assert.equal(tv.volume, 20, `cycle ${i}`);
    assert.equal(r.alive, 1, `cycle ${i}`);
    assert.equal(r.visited.at(-1), "sleep", `cycle ${i}`);
  }
  assert.equal(tv.sets.length, 40, "exactly one duck and one restore per conversation");
  for (const key of ["QUESTION_FOLLOWUPS", "CONVERSATION_FOLLOWUPS"]) delete process.env[key];
});

test("ChatFlow wiring: lower on the Capri listening event, end on idle and on every return to sleep, recover at start", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../core/ChatFlow.ts"), "utf8").replace(/\r\n/g, "\n");
  const listening = source.slice(source.indexOf('on("listening"'), source.indexOf('on("audio"'));
  assert.match(listening, /tvDucker\.begin\(\)/);
  const idle = source.slice(source.indexOf('on("idle"'), source.indexOf('on("command"'));
  assert.match(idle, /tvDucker\.end\(\)/);
  const transition = source.slice(source.indexOf("transitionTo = (flowName"), source.indexOf("/** Idle status with tokens"));
  assert.match(transition, /tvDucker\.touch\(\);\n\s+if \(flowName === "sleep"\) tvDucker\.end\(\);/);
  assert.match(source, /void tvDucker\.recover\(\)/);
  const command = source.slice(source.indexOf('on("command"'), source.indexOf("this.wakeWordListener.start();"));
  assert.doesNotMatch(command, /tvDucker/, "the command path never touches the TV");
});
