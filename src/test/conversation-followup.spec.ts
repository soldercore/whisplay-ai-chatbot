import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";

// Conversational follow-ups: after an ordinary spoken answer the existing bounded follow-up listen reopens, up to a small limit.
// The real state handlers (listening, wake_listening, asr, answer, sleep) run against stubbed devices; a tiny driver plays the
// state machine so whole conversations can be checked.
Object.assign(process.env, {
  LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true", OLLAMA_MODEL: "fixture", ENABLE_THINKING: "false", WEB_SEARCH_ENABLED: "false",
  MEMORY_ENABLED: "false",
});
delete process.env.CONVERSATION_FOLLOWUPS;
const pc = require("../utils/pending-clarification");
const { composeIdleStatus } = require("../utils/ui-status");

const events: any[] = [];
const noop = () => {};
const loose = () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : noop) });
let isDown = false;
const stubs: Record<string, any> = {
  "../../device/display": {
    onButtonPressed: noop, onButtonReleased: noop, onButtonDoubleClick: noop, display: (s: any) => events.push({ display: s }),
    getCurrentStatus: () => ({ text: "x" }), onCameraCapture: noop, onTextInput: noop, isButtonDown: () => isDown,
  },
  "../../device/audio": {
    recordAudio: async (_f: string, seconds: number) => { events.push({ record: seconds, at: Date.now() }); },
    recordAudioManually: () => ({ result: new Promise(() => {}), stop: noop }), recordFileFormat: "wav", getDynamicVoiceDetectLevel: async () => 25,
    voiceDetectEndSilenceSec: 1.5,
  },
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
(Module as any)._load = load;

// ---- Scripted conversation driver -------------------------------------------------------------------------------------
type Turn = { heard: string; reply?: string; tools?: string[]; fail?: boolean };
const sleepFor = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function makeCtx(script: Turn[], over: any = {}) {
  const queue: string[] = [];
  const log: string[] = [];
  let turn = 0;   // index of the user turn being answered: script[0] is the wake-word request
  const ctx: any = {
    answerId: 0, enterMusicAfterAnswer: false, musicDisplayText: "", isFromWakeListening: false, clarificationListen: false, wakeRecordMaxSec: 60,
    recordingsDir: "/tmp", currentRecordFilePath: "", wakeSessionActive: false, endAfterAnswer: false, enableCamera: false, currentFlowName: "sleep",
    conversationFollowUps: 0, conversationCapture: false, asrText: "", answerDisplayText: "", partialThinking: "", thinkingSentences: [],
    wakeSessionLastSpeechAt: 0, shouldContinueWakeSession: () => false, endWakeSession: () => { ctx.wakeSessionActive = false; },
    pauseWakeWordListener: async () => {}, shouldEndAfterAnswer: (text: string) => /\b(goodbye|stop|byebye)\b/i.test(text),
    idleStatus: () => composeIdleStatus({ capriReady: false, pendingClarification: pc.clarificationRemainingMs() > 0 }), scheduleIdleRefresh: noop,
    resetToolCallDisplay: noop, appendToolCallDisplay: noop, finishToolCallDisplay: noop, keepCommandToolDisplayRunning: noop,
    finishCommandToolDisplay: noop, revealAllAnswerText: noop, partialThinkingCallback: noop, composeAnswerDisplayText: (t: string) => t,
    updateAnswerDisplayText: noop, streamResponser: { partial: noop, endPartial: noop, stop: noop, getPlayEndPromise: () => Promise.resolve() },
    transitionTo: (name: string) => { log.push(name); ctx.currentFlowName = name; queue.push(name); },
    recognizeAudio: async () => {
      const t = script[turn + 1];
      if (!t) return "";
      turn += 1;
      return t.heard;
    },
    ...over,
  };
  stubs["../../cloud-api/server"].chatWithLLMStream = async (_prompt: any, partial: (t: string) => void, end: () => void, _think: any, tool: any) => {
    const t = script[turn];
    for (const name of t?.tools ?? []) { tool(name); tool(name, "[success] done"); }
    if (t?.fail) throw new Error("llm down");
    if (t?.reply) partial(t.reply);
    end();
  };
  return { ctx, log, queue, record: events };
}

/** Run states until the conversation returns to sleep (or nothing is queued). Resolves with the visited state names. */
async function drive(h: ReturnType<typeof makeCtx>, first: string, limitMs = 8000) {
  const started = Date.now();
  h.queue.push(first);
  h.ctx.currentFlowName = first;
  while (Date.now() - started < limitMs) {
    const name = h.queue.shift();
    if (!name) { await sleepFor(60); if (!h.queue.length) { await sleepFor(450); if (!h.queue.length) break; } continue; }
    flowStates[name](h.ctx);
    if (name === "sleep") break;
    await sleepFor(40);
  }
  return h.log.slice();
}
const startedByWakeWord = (h: ReturnType<typeof makeCtx>) => {   // what the Capri command handler does before the answer state
  h.ctx.conversationFollowUps = 0; h.ctx.conversationCapture = false; h.ctx.asrText = "First question.";
};
const recordedCount = () => events.filter(e => e.record !== undefined).length;
const reset = () => { events.length = 0; pc.clearClarification(); delete process.env.CONVERSATION_FOLLOWUPS; };

// ---- Pure rules --------------------------------------------------------------------------------------------------------
test("configuration: default 3, 0 disables, capped at 5, garbage falls back", () => {
  assert.equal(pc.conversationFollowUpLimit({}), 3);
  assert.equal(pc.conversationFollowUpLimit({ CONVERSATION_FOLLOWUPS: "" }), 3);
  assert.equal(pc.conversationFollowUpLimit({ CONVERSATION_FOLLOWUPS: "0" }), 0, "the off switch");
  assert.equal(pc.conversationFollowUpLimit({ CONVERSATION_FOLLOWUPS: "2" }), 2);
  assert.equal(pc.conversationFollowUpLimit({ CONVERSATION_FOLLOWUPS: "99" }), 5);
  assert.equal(pc.conversationFollowUpLimit({ CONVERSATION_FOLLOWUPS: "-4" }), 0);
  assert.equal(pc.conversationFollowUpLimit({ CONVERSATION_FOLLOWUPS: "abc" }), 3);
});

test("a follow-up is allowed only for a plain, completed, conversational answer", () => {
  pc.clearClarification();
  const ok = { used: 0, limit: 3, wakeSessionActive: false, endAfterAnswer: false, toolRan: false, failed: false, answered: true, musicNext: false };
  assert.equal(pc.shouldContinueConversation(ok), true);
  for (const [name, bad] of Object.entries({
    "limit reached": { used: 3 }, "disabled": { limit: 0 }, "wake session": { wakeSessionActive: true }, "goodbye": { endAfterAnswer: true },
    "a tool or device action ran": { toolRan: true }, "failure": { failed: true }, "nothing was said": { answered: false }, "music next": { musicNext: true },
  })) assert.equal(pc.shouldContinueConversation({ ...ok, ...bad }), false, name);
  pc.markClarification(10_000, { listen: false });
  assert.equal(pc.shouldContinueConversation(ok), false, "a pending clarification keeps its own one-shot rules");
  pc.clearClarification();
});

test("noise and stock phrases are not conversation", () => {
  for (const text of ["", "  ", ".", "...", "a", "you", "You.", "Thank you.", "thanks for watching", "Bye.", "uh", "Hmm..."]) assert.equal(pc.isNoiseTranscript(text), true, JSON.stringify(text));
  for (const text of ["What about tomorrow?", "Tell me more.", "Why is that?", "Yes", "No thanks, not today"]) assert.equal(pc.isNoiseTranscript(text), false, text);
});

// ---- Whole conversations -------------------------------------------------------------------------------------------------
test("three natural follow-ups, then back to idle without a fourth", async () => {
  reset();
  const h = makeCtx([
    { heard: "What is the capital of Norway?", reply: "Oslo." }, { heard: "And of Sweden?", reply: "Stockholm." },
    { heard: "And Denmark?", reply: "Copenhagen." }, { heard: "And Finland?", reply: "Helsinki." }, { heard: "And Iceland?", reply: "Reykjavik." },
  ]);
  startedByWakeWord(h);
  h.ctx.asrText = "What is the capital of Norway?";
  const states = await drive(h, "answer");
  assert.deepEqual(states.filter(s => s === "wake_listening").length, 3, `exactly 3 follow-up listens: ${states.join(">")}`);
  assert.equal(states.filter(s => s === "asr").length, 3);
  assert.equal(states.at(-1), "sleep", "then normal idle");
  assert.equal(recordedCount(), 3, "one recording per follow-up: no duplicate microphone sessions");
  assert.equal(h.ctx.conversationFollowUps, 3);
  assert.ok(events.every(e => e.record === undefined || e.record === 7), "each follow-up is the existing 7 s bounded capture");
});

test("silence returns to idle at once and no further listening is started", async () => {
  reset();
  const h = makeCtx([{ heard: "Tell me a fact.", reply: "Octopuses have three hearts." }, { heard: "" }]);
  startedByWakeWord(h); h.ctx.asrText = "Tell me a fact.";
  const states = await drive(h, "answer");
  assert.equal(states.at(-1), "sleep");
  assert.equal(states.filter(s => s === "wake_listening").length, 1, "one listen, silence, idle");
  assert.equal(recordedCount(), 1);
});

test("a stock phrase invented on noise is silence for a conversational follow-up, but unchanged for a clarification answer", async () => {
  reset();
  const h = makeCtx([]);
  h.ctx.recognizeAudio = async () => "Thank you.";
  h.ctx.conversationCapture = true; h.ctx.isFromWakeListening = true; h.ctx.currentFlowName = "asr";
  flowStates.asr(h.ctx); await sleepFor(60);
  assert.equal(h.log.at(-1), "sleep", "treated as silence");
  assert.equal(h.ctx.conversationCapture, false, "the marker is consumed");
  const c = makeCtx([]);          // a clarification answer: conversationCapture is false
  c.ctx.recognizeAudio = async () => "Thank you.";
  c.ctx.isFromWakeListening = true; c.ctx.currentFlowName = "asr";
  flowStates.asr(c.ctx); await sleepFor(60);
  assert.equal(c.log.at(-1), "answer", "the existing clarification behaviour is untouched");
  assert.equal(c.ctx.asrText, "Thank you.");
});

test("the follow-up count is bounded by the setting; 0 turns the feature off", async () => {
  reset(); process.env.CONVERSATION_FOLLOWUPS = "1";
  const script = [{ heard: "One.", reply: "A." }, { heard: "Two.", reply: "B." }, { heard: "Three.", reply: "C." }];
  const a = makeCtx(script); startedByWakeWord(a); a.ctx.asrText = "Zero.";
  const sa = await drive(a, "answer");
  assert.equal(sa.filter(s => s === "wake_listening").length, 1, "limit 1");
  reset(); process.env.CONVERSATION_FOLLOWUPS = "0";
  const b = makeCtx(script); startedByWakeWord(b); b.ctx.asrText = "Zero.";
  const sb = await drive(b, "answer");
  assert.deepEqual(sb, ["sleep"], "switched off: straight back to idle, exactly as before");
  assert.equal(recordedCount(), 0);
  delete process.env.CONVERSATION_FOLLOWUPS;
});

test("device actions and other tools never open a follow-up", async () => {
  for (const tool of ["setTvScreenAndReply", "searchLocalMemory", "web_search", "getSystemHealth"]) {
    reset();
    const h = makeCtx([{ heard: "x", reply: "Done.", tools: [tool] }]);
    startedByWakeWord(h); h.ctx.asrText = "Do it.";
    // answer is the first turn here: make the stub script start at turn 0
    (h.ctx as any).recognizeAudio = async () => "";
    stubs["../../cloud-api/server"].chatWithLLMStream = async (_p: any, partial: any, end: any, _t: any, toolCb: any) => { toolCb(tool); toolCb(tool, "[success] ok"); partial("Done."); end(); };
    const states = await drive(h, "answer");
    assert.deepEqual(states, ["sleep"], `${tool}: back to idle`);
    assert.equal(recordedCount(), 0, `${tool}: the microphone was not reopened`);
  }
});

test("a failed answer, an empty answer and a goodbye end the conversation", async () => {
  for (const [name, turn, endAfter] of [["llm failure", { heard: "x", fail: true }, false], ["empty answer", { heard: "x", reply: "  " }, false], ["goodbye", { heard: "x", reply: "Goodbye." }, true]] as const) {
    reset();
    const h = makeCtx([turn as any]);
    startedByWakeWord(h); h.ctx.asrText = "Hi."; h.ctx.endAfterAnswer = endAfter;
    stubs["../../cloud-api/server"].chatWithLLMStream = async (_p: any, partial: any, end: any) => { if ((turn as any).fail) throw new Error("llm down"); if ((turn as any).reply) partial((turn as any).reply); end(); };
    const states = await drive(h, "answer");
    assert.equal(states.includes("wake_listening"), false, name);
    assert.equal(recordedCount(), 0, name);
  }
});

test("recording never starts before playback has fully ended, and waits the existing settle after it", async () => {
  reset();
  let endPlayback: () => void = noop;
  const h = makeCtx([]);
  h.ctx.streamResponser.getPlayEndPromise = () => new Promise<void>(resolve => { endPlayback = resolve; });
  startedByWakeWord(h); h.ctx.asrText = "Tell me about Oslo.";
  stubs["../../cloud-api/server"].chatWithLLMStream = async (_p: any, partial: any, end: any) => { partial("A cold city."); end(); };
  h.ctx.currentFlowName = "answer";
  flowStates.answer(h.ctx);
  await sleepFor(500);
  assert.equal(h.log.length, 0, "while Piper is still playing nothing is armed to record");
  assert.equal(recordedCount(), 0);
  const ended = Date.now(); endPlayback();
  await sleepFor(150);
  assert.equal(h.log.includes("wake_listening"), false, "still inside the settle period");
  await sleepFor(300);
  assert.deepEqual(h.log, ["wake_listening"]);
  assert.ok(Date.now() - ended >= pc.CLARIFICATION_SETTLE_MS - 20, "at least the existing 300 ms settle after the playback ended");
});

test("stale callbacks cannot reopen the microphone: interruption, a new answer, or the end of the conversation", async () => {
  for (const [name, interfere] of [
    ["button interruption", (c: any) => { c.currentFlowName = "listening"; }],
    ["a newer answer replaced it", (c: any) => { c.answerId += 1; }],
    ["conversation ended (idle)", (c: any) => { c.currentFlowName = "sleep"; }],
  ] as const) {
    reset();
    const h = makeCtx([]);
    startedByWakeWord(h); h.ctx.asrText = "Hi.";
    stubs["../../cloud-api/server"].chatWithLLMStream = async (_p: any, partial: any, end: any) => { partial("Hello."); end(); };
    h.ctx.currentFlowName = "answer";
    flowStates.answer(h.ctx);
    await sleepFor(120);               // the answer finished and the settle timer is pending
    interfere(h.ctx);
    await sleepFor(450);
    assert.equal(h.log.length, 0, name);
    assert.equal(recordedCount(), 0, name);
    assert.equal(h.ctx.conversationFollowUps, 0, `${name}: nothing counted`);
  }
});

test("a button turn and a typed turn start the counters correctly", async () => {
  reset();
  const h = makeCtx([]);
  h.ctx.conversationFollowUps = 3; h.ctx.conversationCapture = true; isDown = true;
  flowStates.listening(h.ctx);
  assert.equal(h.ctx.conversationFollowUps, 0, "a button turn is a new conversation");
  assert.equal(h.ctx.conversationCapture, false);
  isDown = false;
  const s = makeCtx([]); s.ctx.conversationCapture = true;
  flowStates.sleep(s.ctx);
  assert.equal(s.ctx.conversationCapture, false, "idle clears a leftover marker");
  const chatFlow = fs.readFileSync(path.join(__dirname, "..", "core", "ChatFlow.ts"), "utf8");
  assert.match(chatFlow, /this\.endWakeSession\(\);\s*this\.conversationFollowUps = 0;[^\n]*\s*this\.conversationCapture = false;/, "the Capri command handler resets the counter");
});

test("clarification follow-ups are unchanged: they still listen once, and are not counted or noise-filtered", async () => {
  reset();
  pc.markClarification(10_000);                          // an armed host question
  const h = makeCtx([]);
  h.ctx.asrText = "Make the screen black.";
  stubs["../../cloud-api/server"].chatWithLLMStream = async (_p: any, partial: any, end: any) => { partial("Do you mean the TV screen or Whisplay's screen?"); end(); };
  h.ctx.currentFlowName = "answer";
  flowStates.answer(h.ctx);
  await sleepFor(500);
  assert.deepEqual(h.log, ["wake_listening"], "the clarification listen");
  assert.equal(h.ctx.clarificationListen, true);
  assert.equal(h.ctx.conversationCapture, false, "not a conversational capture");
  assert.equal(h.ctx.conversationFollowUps, 0, "not counted");
  // A repeated question does not reopen the microphone, and the conversation rule does not override that.
  reset(); pc.markClarification(10_000, { listen: false });
  const r = makeCtx([]); r.ctx.asrText = "Make the screen dark.";
  r.ctx.currentFlowName = "answer";
  flowStates.answer(r.ctx);
  await sleepFor(500);
  assert.deepEqual(r.log, ["sleep"], "no reopen for a repeated clarification question: straight back to idle");
  pc.clearClarification();
});

test("Whisper failure or silence in a follow-up returns to idle with nothing acted on", async () => {
  reset();
  const rejected = makeCtx([]);
  rejected.ctx.recognizeAudio = async () => { throw new Error("whisper down"); };
  rejected.ctx.isFromWakeListening = true; rejected.ctx.conversationCapture = true; rejected.ctx.currentFlowName = "asr";
  flowStates.asr(rejected.ctx); await sleepFor(80);
  assert.equal(rejected.log.at(-1), "sleep");
  assert.equal(rejected.ctx.asrText, "");
  const slowSilence = makeCtx([]);
  slowSilence.ctx.recognizeAudio = () => new Promise<string>(resolve => setTimeout(() => resolve(""), 150));   // a slow recogniser that finds nothing
  slowSilence.ctx.isFromWakeListening = true; slowSilence.ctx.conversationCapture = true; slowSilence.ctx.currentFlowName = "asr";
  flowStates.asr(slowSilence.ctx); await sleepFor(300);
  assert.equal(slowSilence.log.at(-1), "sleep");
});

test("back-to-back conversations: the second one gets its own full set of follow-ups, and turns are never duplicated", async () => {
  reset();
  const script = [{ heard: "One.", reply: "A." }, { heard: "Two.", reply: "B." }, { heard: "Three.", reply: "C." }, { heard: "Four.", reply: "D." }];
  const first = makeCtx(script); startedByWakeWord(first); first.ctx.asrText = "Zero.";
  const s1 = await drive(first, "answer");
  assert.equal(s1.filter(s => s === "wake_listening").length, 3);
  const second = makeCtx([{ heard: "Five.", reply: "E." }, { heard: "" }]);
  second.ctx.conversationFollowUps = first.ctx.conversationFollowUps;      // exhausted by the first conversation
  second.ctx.asrText = "New topic.";
  second.ctx.conversationFollowUps = 0; second.ctx.conversationCapture = false;   // what the next Capri command / button press does
  const s2 = await drive(second, "answer");
  assert.equal(s2.filter(s => s === "wake_listening").length, 1, "a fresh conversation listens again");
  assert.equal(s2.filter(s => s === "asr").length, 1, "each heard turn is processed once");
});
