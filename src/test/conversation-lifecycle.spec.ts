import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

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
  appSignal: { aborted: false },
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
const stubs: Record<string, any> = {
  "../utils/app-lifecycle": fakeLifecycle,
  "../../device/display": {
    onButtonPressed: (fn: any) => { pressed = fn || undefined; }, onButtonReleased: noop, onButtonDoubleClick: noop, display: noop,
    getCurrentStatus: () => ({ text: "x" }), onCameraCapture: noop, onTextInput: noop, isButtonDown: () => false,
  },
  "../../device/audio": { recordAudio: async () => { events.push("record"); }, recordAudioManually: () => ({ result: new Promise(() => {}), stop: noop }),
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
(Module as any)._load = load;

// ---- A ChatFlow-shaped harness: the same transitionTo contract as ChatFlow (stop Capri when leaving sleep, start it in sleep) ----
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Exit = { name: string; turns: { heard: string; reply?: string; tools?: string[]; fail?: boolean }[]; limit?: string; interrupt?: boolean; asrThrows?: boolean };

function makeFlow(exit: Exit) {
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

const EXITS: Exit[] = [
  { name: "silence in the follow-up window", turns: [{ heard: "q", reply: "Answer one." }] },
  { name: "normal completion and the maximum follow-up count", limit: "2", turns: [{ heard: "q", reply: "A." }, { heard: "q2", reply: "B." }, { heard: "q3", reply: "C." }, { heard: "q4", reply: "D." }] },
  { name: "goodbye", turns: [{ heard: "q", reply: "A." }, { heard: "goodbye", reply: "Goodbye." }] },
  { name: "ASR failure", turns: [{ heard: "q", reply: "A." }], asrThrows: true },
  { name: "tool or device action", turns: [{ heard: "q", reply: "Done.", tools: ["setTvScreenAndReply"] }] },
  { name: "answer failure", turns: [{ heard: "q", fail: true }] },
  { name: "button interruption during the follow-up window", turns: [{ heard: "q", reply: "A." }], interrupt: true },
  { name: "a noise-only follow-up", turns: [{ heard: "q", reply: "A." }, { heard: "Thank you." }] },
];

test("every conversation exit returns to idle with exactly one healthy Capri child, over 24 cycles", async () => {
  let cycles = 0;
  for (let round = 0; round < 3; round++) {
    for (const exit of EXITS) {
      if (exit.limit) process.env.CONVERSATION_FOLLOWUPS = exit.limit; else delete process.env.CONVERSATION_FOLLOWUPS;
      children.length = 0; maxAlive = 0; events.length = 0; pressed = undefined; pc.clearClarification();
      const flow = makeFlow(exit);
      // idle: Capri starts and reports ready
      flow.ctx.currentFlowName = "sleep"; flow.listener.start();
      await wait(60);
      assert.equal(aliveCount(), 1, `${exit.name}: one Capri child while idle`);
      assert.equal(flow.readyCount(), 1);
      // the user wakes Capri with a command (the child prints it, the real listener stops the child and notifies the flow)
      const first = children[0];
      flow.visited.length = 0;
      first.stdout.write(`CAPRI_COMMAND ${JSON.stringify(exit.turns[0].heard === "q" ? "tell me something" : exit.turns[0].heard)}\n`);
      await wait(80);
      assert.equal(first.alive, false, `${exit.name}: the child released the microphone before the conversation`);
      await runStates(flow, exit);
      await wait(120);
      // the invariant
      assert.equal(flow.ctx.currentFlowName, "sleep", `${exit.name}: back to idle (${flow.visited.join(">")})`);
      assert.equal(aliveCount(), 1, `${exit.name}: exactly one Capri child after the conversation (${children.length} spawned)`);
      assert.equal(children.at(-1)!.alive, true);
      assert.ok(flow.readyCount() >= 2, `${exit.name}: the new child reported READY`);
      assert.ok(maxAlive <= 1, `${exit.name}: never two Capri children at once (max ${maxAlive})`);
      assert.equal(flow.ctx.conversationCapture, false, `${exit.name}: no leftover follow-up marker`);
      await flow.listener.stop();
      assert.equal(aliveCount(), 0, `${exit.name}: shutdown leaves no child`);
      cycles += 1;
    }
  }
  delete process.env.CONVERSATION_FOLLOWUPS;
  assert.equal(cycles, 24);
});

test("a stale follow-up timer from an abandoned conversation cannot reopen the microphone after idle returned", async () => {
  delete process.env.CONVERSATION_FOLLOWUPS; children.length = 0; events.length = 0; pc.clearClarification();
  const flow = makeFlow({ name: "stale", turns: [{ heard: "q", reply: "A." }] });
  flow.ctx.asrText = "Hi."; flow.ctx.currentFlowName = "answer";
  flowStates.answer(flow.ctx);
  await wait(100);                         // the answer finished; the 300 ms settle timer is pending
  flow.ctx.transitionTo("sleep");          // something else ended the conversation first (idle restarts Capri)
  flow.queue.length = 0;
  await wait(500);
  assert.deepEqual(flow.visited, ["sleep"], "the stale timer opened nothing");
  assert.equal(events.filter(e => e === "record").length, 0);
  assert.equal(aliveCount(), 1, "Capri is running");
  await flow.listener.stop();
});
