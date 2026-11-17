import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
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
const recordSeconds: number[] = [];
const stubs: Record<string, any> = {
  "../utils/app-lifecycle": fakeLifecycle,
  "../../device/display": {
    onButtonPressed: (fn: any) => { pressed = fn || undefined; }, onButtonReleased: noop, onButtonDoubleClick: noop, display: noop,
    getCurrentStatus: () => ({ text: "x" }), onCameraCapture: noop, onTextInput: noop, isButtonDown: () => false,
  },
  "../../device/audio": { recordAudio: async (_f: string, seconds: number) => { events.push("record"); recordSeconds.push(seconds); }, recordAudioManually: () => ({ result: new Promise(() => {}), stop: noop }),
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

const questionLike = { reply: "AI has enormous potential. What interests you most about it?" };
const statement = { reply: "AI has enormous potential. It also has enormous paperwork." };

// ---- Pure rules ----------------------------------------------------------------------------------------------------------
test("QUESTION_FOLLOWUPS: off by default, N enables up to N (max 3), garbage is off", () => {
  assert.equal(pc.questionFollowUpLimit({}), 0, "disabled until physically verified");
  assert.equal(pc.questionFollowUpLimit({ QUESTION_FOLLOWUPS: "" }), 0);
  assert.equal(pc.questionFollowUpLimit({ QUESTION_FOLLOWUPS: "3" }), 3);
  assert.equal(pc.questionFollowUpLimit({ QUESTION_FOLLOWUPS: "99" }), 3, "never more than 3 consecutive question follow-ups");
  assert.equal(pc.questionFollowUpLimit({ QUESTION_FOLLOWUPS: "-1" }), 0);
  assert.equal(pc.questionFollowUpLimit({ QUESTION_FOLLOWUPS: "abc" }), 0);
});

test("the rule is literal: the trimmed reply ends with a question mark", () => {
  for (const text of [
    "AI has enormous potential. What interests you most about it?", "What is your favourite colour?", "Ready?", "Fascinating, isn't it?",
    "Is that all?\n", "  Do you want to hear more?  \n\t", "Hm? Really?",
  ]) assert.equal(pc.endsWithQuestionMark(text), true, JSON.stringify(text));
  for (const text of [
    "AI has enormous potential.", "", "   ", "Who knows? Not me.", "What is life? Nobody can say.",
    'As they say, "What is life?"', "“Why is the sky blue?”", "She wondered (what do you want?)", "Shall I continue? 😊", "Really…",
  ]) assert.equal(pc.endsWithQuestionMark(text), false, JSON.stringify(text));
  assert.equal(pc.QUESTION_LISTEN_SECONDS, 5);
});

// ---- Whole conversations (the real state handlers) -----------------------------------------------------------------------
async function conversation(env: Record<string, string>, turns: Turn2[], opts: { asrThrows?: boolean; interrupt?: boolean } = {}) {
  for (const key of ["QUESTION_FOLLOWUPS", "CONVERSATION_FOLLOWUPS"]) delete process.env[key];
  Object.assign(process.env, { CONVERSATION_FOLLOWUPS: "0" }, env);   // the general feature stays off unless a test says otherwise
  children.length = 0; maxAlive = 0; events.length = 0; pressed = undefined; pc.clearClarification();
  const exit: Exit = { name: "q", turns: turns as any, asrThrows: opts.asrThrows, interrupt: opts.interrupt };
  const flow = makeFlow(exit);
  flow.ctx.currentFlowName = "sleep"; flow.listener.start();
  await wait(60);
  flow.visited.length = 0;
  children[0].stdout.write(`CAPRI_COMMAND ${JSON.stringify("tell me about AI")}\n`);
  await wait(80);
  await runStates(flow, exit);
  await wait(120);
  const listens = flow.visited.filter(s => s === "wake_listening").length;
  const result = { flow, listens, visited: flow.visited.slice(), alive: aliveCount(), maxAlive, ready: flow.readyCount(), records: events.filter(e => e === "record").length };
  await flow.listener.stop();
  return result;
}
type Turn2 = { heard: string; reply?: string; tools?: string[]; fail?: boolean };
const q1 = { heard: "q", reply: "AI has enormous potential. What interests you most about it?" };
const q2 = { heard: "Building my own assistant.", reply: "Splendid. Which part of it do you find hardest?" };
const q3 = { heard: "The voice.", reply: "Voices are hard. Do you want some advice?" };
const q4 = { heard: "Yes.", reply: "Practise. Does that help you at all?" };

test("a question opens one follow-up, and the answer to it continues naturally", async () => {
  const r = await conversation({ QUESTION_FOLLOWUPS: "3", CONVERSATION_FOLLOWUPS: "0" }, [q1, { heard: "Building my own assistant.", reply: "Splendid. That is a lot of wiring." }]);
  assert.equal(r.listens, 1, r.visited.join(">"));
  assert.equal(r.visited.at(-1), "sleep");
  assert.equal(r.flow.turns(), 1, "the heard answer reached the answer state once");
  assert.equal(r.alive, 1, "Capri is back");
});

test("a statement opens nothing, and with the switch off a question opens nothing either", async () => {
  const a = await conversation({ QUESTION_FOLLOWUPS: "3", CONVERSATION_FOLLOWUPS: "0" }, [{ heard: "q", ...statement }]);
  assert.equal(a.listens, 0, "statement");
  assert.equal(a.records, 0);
  const b = await conversation({ CONVERSATION_FOLLOWUPS: "0" }, [q1, q2]);
  assert.equal(b.listens, 0, "default: disabled");
  const c = await conversation({ QUESTION_FOLLOWUPS: "0", CONVERSATION_FOLLOWUPS: "0" }, [q1, q2]);
  assert.equal(c.listens, 0, "explicitly off");
  assert.equal(c.alive, 1);
});

test("consecutive questions chain, bounded by the limit; the general switch stays independent", async () => {
  const chain = await conversation({ QUESTION_FOLLOWUPS: "3", CONVERSATION_FOLLOWUPS: "0" }, [q1, q2, q3, q4, { heard: "More.", reply: "Another. Why do you ask?" }]);
  assert.equal(chain.listens, 3, `exactly 3: ${chain.visited.join(">")}`);
  assert.equal(chain.visited.at(-1), "sleep");
  assert.equal(chain.records, 3, "one recording per follow-up");
  const two = await conversation({ QUESTION_FOLLOWUPS: "2", CONVERSATION_FOLLOWUPS: "0" }, [q1, q2, q3, q4]);
  assert.equal(two.listens, 2);
  // a statement in the middle of a chain ends it; the general feature (off) is not what continued it
  const broken = await conversation({ QUESTION_FOLLOWUPS: "3", CONVERSATION_FOLLOWUPS: "0" }, [q1, { heard: "Fine.", ...statement }, q3]);
  assert.equal(broken.listens, 1);
  assert.equal(broken.visited.at(-1), "sleep");
});

test("silence, noise, goodbye and ASR failure return to idle", async () => {
  const silent = await conversation({ QUESTION_FOLLOWUPS: "3" }, [q1]);                  // the follow-up hears nothing
  assert.equal(silent.listens, 1); assert.equal(silent.visited.at(-1), "sleep"); assert.equal(silent.alive, 1);
  const noise = await conversation({ QUESTION_FOLLOWUPS: "3" }, [q1, { heard: "Thank you." }]);
  assert.equal(noise.listens, 1); assert.equal(noise.flow.turns(), 1); assert.equal(noise.visited.at(-1), "sleep");
  const bye = await conversation({ QUESTION_FOLLOWUPS: "3" }, [q1, { heard: "goodbye", reply: "Farewell. Will you come back soon?" }]);
  assert.equal(bye.listens, 1, "the goodbye answer opens nothing, even though it asks a question");
  assert.equal(bye.visited.at(-1), "sleep");
  const broken = await conversation({ QUESTION_FOLLOWUPS: "3" }, [q1], { asrThrows: true });
  assert.equal(broken.listens, 1); assert.equal(broken.visited.at(-1), "sleep"); assert.equal(broken.alive, 1);
});

test("tool and device actions, failures and replies not ending in a question mark open nothing", async () => {
  const tool = await conversation({ QUESTION_FOLLOWUPS: "3" }, [{ heard: "q", reply: "Screen off. Anything else you need?", tools: ["setTvScreenAndReply"] }]);
  assert.equal(tool.listens, 0, "device action");
  const failed = await conversation({ QUESTION_FOLLOWUPS: "3" }, [{ heard: "q", fail: true }]);
  assert.equal(failed.listens, 0, "failure");
  const quoted = await conversation({ QUESTION_FOLLOWUPS: "3" }, [{ heard: "q", reply: 'The old riddle goes: "What walks on four legs in the morning?"' }]);
  assert.equal(quoted.listens, 0, "quoted");
  const notLast = await conversation({ QUESTION_FOLLOWUPS: "3" }, [{ heard: "q", reply: "What is the meaning of life? Nobody can say." }]);
  assert.equal(notLast.listens, 0, "the question is not the end of the reply");
  for (const r of [tool, failed, quoted, notLast]) assert.equal(r.alive, 1);
});

test("an existing clarification question keeps its own one-shot behaviour and is not counted as a conversation", async () => {
  delete process.env.CONVERSATION_FOLLOWUPS; process.env.QUESTION_FOLLOWUPS = "3";
  children.length = 0; events.length = 0; pc.clearClarification();
  pc.markClarification(10_000);                                 // an armed host question
  const flow = makeFlow({ name: "c", turns: [{ heard: "q", reply: "Do you mean the TV screen or Whisplay's screen?" }] });
  flow.ctx.asrText = "Make the screen black."; flow.ctx.currentFlowName = "answer";
  flowStates.answer(flow.ctx);
  await wait(500);
  assert.deepEqual(flow.visited, ["wake_listening"]);
  assert.equal(flow.ctx.conversationCapture, false, "the clarification listen, not a conversational one");
  assert.equal(flow.ctx.conversationFollowUps, 0, "not counted");
  // a repeated clarification question (listen already spent) must not be turned into a question follow-up
  pc.clearClarification(); pc.markClarification(10_000, { listen: false });
  const repeat = makeFlow({ name: "r", turns: [{ heard: "q", reply: "Do you mean the TV screen or Whisplay's screen?" }] });
  repeat.ctx.currentFlowName = "answer";
  flowStates.answer(repeat.ctx);
  await wait(500);
  assert.deepEqual(repeat.visited, ["sleep"]);
  pc.clearClarification();
});

test("stale callbacks cannot reopen the microphone for a question reply", async () => {
  for (const [name, interfere] of [
    ["button interruption", (c: any) => { c.currentFlowName = "listening"; }],
    ["a newer answer replaced it", (c: any) => { c.answerId += 1; }],
    ["conversation ended", (c: any) => { c.currentFlowName = "sleep"; }],
  ] as const) {
    process.env.QUESTION_FOLLOWUPS = "3"; delete process.env.CONVERSATION_FOLLOWUPS; events.length = 0; pc.clearClarification();
    const flow = makeFlow({ name, turns: [q1] });
    flow.ctx.asrText = "Hi."; flow.ctx.currentFlowName = "answer";
    flowStates.answer(flow.ctx);
    await wait(120);
    interfere(flow.ctx);
    await wait(450);
    assert.equal(flow.visited.length, 0, name);
    assert.equal(flow.ctx.conversationFollowUps, 0, `${name}: nothing counted`);
    assert.equal(events.filter(e => e === "record").length, 0, name);
  }
});

test("recording starts only after playback has ended, plus the existing settle", async () => {
  process.env.QUESTION_FOLLOWUPS = "3"; delete process.env.CONVERSATION_FOLLOWUPS; events.length = 0; pc.clearClarification();
  let endPlayback: () => void = noop;
  const flow = makeFlow({ name: "p", turns: [q1] });
  flow.ctx.streamResponser.getPlayEndPromise = () => new Promise<void>(resolve => { endPlayback = resolve; });
  flow.ctx.asrText = "Hi."; flow.ctx.currentFlowName = "answer";
  flowStates.answer(flow.ctx);
  await wait(500);
  assert.equal(flow.visited.length, 0, "Piper is still playing: nothing is armed");
  const ended = Date.now(); endPlayback();
  await wait(150);
  assert.equal(flow.visited.length, 0, "inside the settle");
  await wait(300);
  assert.deepEqual(flow.visited, ["wake_listening"]);
  assert.ok(Date.now() - ended >= pc.CLARIFICATION_SETTLE_MS - 20);
});

test("repeated question -> silence -> idle -> Capri cycles: 20 cycles, one healthy Capri each time", async () => {
  for (let i = 0; i < 20; i++) {
    const turns: Turn2[] = i % 4 === 0 ? [q1] : i % 4 === 1 ? [q1, q2] : i % 4 === 2 ? [q1, { heard: "Fine.", ...statement }] : [q1, { heard: "Thank you." }];
    const r = await conversation({ QUESTION_FOLLOWUPS: "3", CONVERSATION_FOLLOWUPS: "0" }, turns, { asrThrows: i % 5 === 4 });
    assert.equal(r.visited.at(-1), "sleep", `cycle ${i}: idle (${r.visited.join(">")})`);
    assert.equal(r.alive, 1, `cycle ${i}: exactly one Capri child`);
    assert.ok(r.ready >= 2, `cycle ${i}: the new child reported READY`);
    assert.ok(r.maxAlive <= 1, `cycle ${i}: never two Capri children`);
    assert.equal(r.flow.ctx.conversationCapture, false);
  }
  for (const key of ["QUESTION_FOLLOWUPS", "CONVERSATION_FOLLOWUPS"]) delete process.env[key];
});

test("the rule is simple and deterministic: even a sarcastic reply that ends with a question mark follows up", async () => {
  const r = await conversation({ QUESTION_FOLLOWUPS: "3" }, [{ heard: "q", reply: "You failed again. Fascinating, isn't it?" }]);
  assert.equal(r.listens, 1);
  assert.equal(r.visited.at(-1), "sleep");
  assert.equal(r.alive, 1);
});

test("a question follow-up listens for 5 seconds; clarification and the general feature keep 7", async () => {
  recordSeconds.length = 0;
  await conversation({ QUESTION_FOLLOWUPS: "3" }, [q1]);
  assert.deepEqual(recordSeconds, [5], "question-triggered: 5 s");
  recordSeconds.length = 0;
  await conversation({ CONVERSATION_FOLLOWUPS: "3", QUESTION_FOLLOWUPS: "0" }, [{ heard: "q", reply: "A plain statement." }]);
  assert.deepEqual(recordSeconds, [7], "general conversational follow-up: the unchanged 7 s");
  recordSeconds.length = 0;
  for (const key of ["QUESTION_FOLLOWUPS", "CONVERSATION_FOLLOWUPS"]) delete process.env[key];
  pc.clearClarification(); pc.markClarification(10_000);        // an armed host question
  const flow = makeFlow({ name: "c", turns: [{ heard: "q", reply: "Do you mean the TV screen or Whisplay's screen?" }] });
  flow.ctx.asrText = "Make the screen black."; flow.ctx.currentFlowName = "answer";
  flowStates.answer(flow.ctx);
  await wait(500);
  assert.equal(flow.ctx.followUpSeconds, undefined, "a clarification listen does not use the question window");
  flowStates.wake_listening(flow.ctx);
  await wait(60);
  assert.deepEqual(recordSeconds, [7], "clarification: the unchanged 7 s");
  pc.clearClarification();
});
