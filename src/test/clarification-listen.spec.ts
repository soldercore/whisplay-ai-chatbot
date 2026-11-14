import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import Module from "node:module";
import { PassThrough } from "node:stream";

// One bounded automatic listen for the answer to a host clarification question. The microphone, display and daemon
// are fixtures; the real state handlers (wake_listening, asr, sleep) run against them.
Object.assign(process.env, {
  LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true", OLLAMA_MODEL: "fixture", ENABLE_THINKING: "false", WEB_SEARCH_ENABLED: "false",
  WHISPLAY_VOICE_CONTROL_ENABLED: "true", MEMORY_ENABLED: "false", OLLAMA_WARMUP_ATTEMPTS: "1",
});
const pc = require("../utils/pending-clarification");
const dc = require("../config/device-commands");
const tv = require("../device/lg-c1-volume");

test("the listen request is one-shot, only for a first question, and only while its window is open", async () => {
  pc.clearClarification();
  assert.equal(pc.takeListenRequest(), false, "nothing pending");
  pc.markClarification(10_000);
  assert.equal(pc.takeListenRequest(), true);
  assert.equal(pc.takeListenRequest(), false, "never twice for one question");
  assert.ok(pc.clarificationRemainingMs() > 0, "the answer context outlives the listen");
  assert.equal(pc.clarificationDisplayMs(), 0, "after the automatic listen the screen is not left claiming a turn");
  pc.markClarification(10_000, { listen: false });
  assert.equal(pc.takeListenRequest(), false, "a repeated question does not reopen the microphone");
  assert.ok(pc.clarificationDisplayMs() > 0, "but the idle hint stays for the remaining window");
  pc.markClarification(40);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(pc.takeListenRequest(), false, "an expired window never listens");
  pc.markClarification(10_000); pc.clearClarification();
  assert.equal(pc.takeListenRequest(), false, "cleared by the next message");
});

test("the listen is skipped when a wake session or an ending conversation owns the flow, and is bounded", () => {
  pc.markClarification(10_000);
  assert.equal(pc.shouldListenAfterAnswer({ wakeSessionActive: true, endAfterAnswer: false }), false);
  assert.equal(pc.shouldListenAfterAnswer({ wakeSessionActive: false, endAfterAnswer: true }), false);
  assert.equal(pc.shouldListenAfterAnswer({ wakeSessionActive: false, endAfterAnswer: false }), true, "armed question was still available");
  assert.equal(pc.shouldListenAfterAnswer({ wakeSessionActive: false, endAfterAnswer: false }), false);
  pc.clearClarification();
  assert.equal(pc.clarificationListenSeconds({}), 7);
  assert.equal(pc.clarificationListenSeconds({ CLARIFICATION_LISTEN_SEC: "1" } as any), 3);
  assert.equal(pc.clarificationListenSeconds({ CLARIFICATION_LISTEN_SEC: "600" } as any), 10, "never the 60 s wake-session limit");
  assert.equal(pc.clarificationListenSeconds({ CLARIFICATION_LISTEN_SEC: "abc" } as any), 7);
  assert.ok(pc.CLARIFICATION_SETTLE_MS >= 200 && pc.CLARIFICATION_SETTLE_MS <= 500, "settle after playback, without a noticeable gap");
});

// ---- Real state handlers with stubbed devices ----
const events: any[] = [];
const noop = () => {};
const loose = () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : noop) });
let asrResult = "";
const stubs: Record<string, any> = {
  "../../device/display": {
    onButtonPressed: (fn: unknown) => events.push({ button: fn ? "pressed-handler" : "none" }), onButtonReleased: noop, onButtonDoubleClick: noop,
    display: (status: any) => events.push({ display: status }), getCurrentStatus: () => ({ text: "x" }), onCameraCapture: noop, onTextInput: noop, isButtonDown: () => false,
  },
  "../../device/audio": {
    recordAudio: async (file: string, seconds: number, level: number) => { events.push({ record: { seconds, level } }); },
    recordAudioManually: () => ({ result: Promise.resolve(""), stop: noop }), recordFileFormat: "wav", getDynamicVoiceDetectLevel: async () => 25,
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

const makeCtx = (over: any = {}) => {
  const transitions: string[] = [];
  const ctx: any = {
    answerId: 0, enterMusicAfterAnswer: false, musicDisplayText: "", isFromWakeListening: false, clarificationListen: false, wakeRecordMaxSec: 60,
    recordingsDir: "/tmp", currentRecordFilePath: "", wakeSessionActive: false, endAfterAnswer: false, enableCamera: false, currentFlowName: "asr",
    transitions, transitionTo: (name: string) => { transitions.push(name); }, endWakeSession: () => { ctx.wakeSessionActive = false; },
    recognizeAudio: async () => asrResult, shouldEndAfterAnswer: () => false, pauseWakeWordListener: async () => {},
    wakeSessionLastSpeechAt: 0, shouldContinueWakeSession: () => false, ...over,
  };
  return ctx;
};
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

test("wake_listening after a clarification records once, bounded, with the LED and status only while capturing", async () => {
  events.length = 0;
  const ctx = makeCtx({ clarificationListen: true });
  flowStates.wake_listening(ctx);
  await settle();
  const shown = events.filter(e => e.display).map(e => e.display.status);
  assert.deepEqual(shown, ["detecting", "listening"], "status moves detecting then listening");
  const listening = events.find(e => e.display?.status === "listening").display;
  assert.equal(listening.RGB, "#00ff00", "the existing microphone LED colour");
  const recordAt = events.findIndex(e => e.record), listeningAt = events.findIndex(e => e.display?.status === "listening");
  assert.ok(listeningAt < recordAt, "the LED turns on right before recording starts, not earlier or later");
  assert.deepEqual(events[recordAt].record.seconds, 7, "the clarification capture is bounded, not the 60 s wake limit");
  assert.equal(ctx.clarificationListen, false, "one-shot: consumed on entry");
  assert.deepEqual(ctx.transitions, ["asr"]);
  // The next entry is an ordinary wake_listening with the normal limit.
  events.length = 0;
  const next = makeCtx();
  flowStates.wake_listening(next);
  await settle();
  assert.equal(events.find(e => e.record).record.seconds, 60);
});

test("silence is never an answer: an empty transcript returns to sleep without any action", async () => {
  asrResult = "";
  const ctx = makeCtx({ isFromWakeListening: true });
  flowStates.asr(ctx);
  await settle();
  assert.deepEqual(ctx.transitions, ["sleep"], "back to normal wake-word operation");
  assert.equal(ctx.asrText, undefined, "nothing was passed on as a request");
});

test("a heard answer goes to the normal answer flow and the pending handler decides", async () => {
  asrResult = "The TV.";
  const ctx = makeCtx({ isFromWakeListening: true });
  flowStates.asr(ctx);
  await settle();
  assert.deepEqual(ctx.transitions, ["answer"]);
  assert.equal(ctx.asrText, "The TV.");
});

test("the idle hint shows only while the automatic listen is not covering the question", async () => {
  const sleepStatus = () => { events.length = 0; const ctx = makeCtx({ currentFlowName: "sleep" }); flowStates.sleep(ctx); return events.filter(e => e.display).map(e => e.display.status).pop(); };
  pc.clearClarification();
  assert.equal(sleepStatus(), "idle");
  pc.markClarification(5_000, { listen: false });
  assert.equal(sleepStatus(), "Your turn", "pending and no automatic listen: the existing hint");
  pc.markClarification(5_000); pc.takeListenRequest();
  assert.equal(sleepStatus(), "idle", "after the automatic listen window the hint is gone");
  pc.clearClarification();
});

// ---- Provider: lifecycle and the false-success fix ----
const requests: any[] = [];
const fakeResults: Record<string, string> = {};
for (const name of ["setTvScreenAndReply"]) tv[name] = async () => fakeResults[name] ?? "fixture reply";
async function ask(t: any, question: string) {
  requests.length = 0;
  t.mock.method(axios, "post", async (_url: string, body: any) => {
    if (!body.messages?.length) return { data: { done: true } };
    requests.push(JSON.parse(JSON.stringify(body)));
    const stream = new PassThrough();
    setImmediate(() => stream.end(JSON.stringify({ message: { content: "Model reply." }, done: true }) + "\n"));
    return { data: stream };
  });
  t.mock.method(axios, "get", async () => ({ data: { models: [{ name: "fixture", context_length: 4096 }] } }));
  const provider = require("../cloud-api/local/ollama-llm").default;
  let text = "";
  await provider.chatWithLLMStream([{ role: "user", content: question }], (chunk: string) => { text += chunk; }, () => {});
  return text.trim();
}
const sentToModel = () => JSON.stringify(requests[0]?.messages ?? []);

test("only the first clarification question arms the listen; an answer resolves it; a repeat does not re-arm", async t => {
  require("../cloud-api/local/ollama-llm").default.resetChatHistory();
  pc.clearClarification();
  assert.equal(await ask(t, "Make the screen black."), dc.SCREEN_TARGET_PROMPT); t.mock.restoreAll();
  assert.equal(pc.takeListenRequest(), true, "the first question armed one listen");
  assert.equal(pc.takeListenRequest(), false);
  // The heard answer is routed by the existing pending handler and executes exactly once.
  fakeResults.setTvScreenAndReply = "Screen off.";
  assert.equal(await ask(t, "The TV."), "Screen off."); t.mock.restoreAll();
  assert.equal(pc.takeListenRequest(), false, "resolving the question arms nothing");
  // A question that stays ambiguous after an answer attempt is asked again without another automatic listen.
  assert.equal(await ask(t, "Make the screen dark."), dc.SCREEN_TARGET_PROMPT); t.mock.restoreAll();
  assert.equal(await ask(t, "Turn the screen on."), dc.SCREEN_TARGET_PROMPT); t.mock.restoreAll();
  assert.equal(pc.takeListenRequest(), false, "the repeated question did not re-arm");
  assert.ok(pc.clarificationRemainingMs() > 25_000, "the 30 s context is kept for a wake-word answer");
  pc.clearClarification();
});

test("an unrelated or unanswered message gets no fabricated success: the unfulfilled request leaves the model's history", async t => {
  require("../cloud-api/local/ollama-llm").default.resetChatHistory();
  assert.equal(await ask(t, "Make the screen black."), dc.SCREEN_TARGET_PROMPT); t.mock.restoreAll();
  assert.equal(await ask(t, "Hello."), "Model reply.");
  const sent = sentToModel();
  assert.doesNotMatch(sent, /Make the screen black/, "the model never sees the unfulfilled request");
  assert.doesNotMatch(sent, /Do you mean the TV screen/, "nor our clarification question");
  assert.match(sent, /Hello\./);
  t.mock.restoreAll();
  // An answered question is a fulfilled exchange and stays.
  assert.equal(await ask(t, "Make the screen black."), dc.SCREEN_TARGET_PROMPT); t.mock.restoreAll();
  fakeResults.setTvScreenAndReply = "Screen off.";
  assert.equal(await ask(t, "The TV."), "Screen off."); t.mock.restoreAll();
  await ask(t, "Thanks.");
  assert.match(sentToModel(), /Make the screen black/, "a resolved exchange is real history");
  t.mock.restoreAll();
  // A normal conversation is unaffected: one model request, history intact.
  require("../cloud-api/local/ollama-llm").default.resetChatHistory();
  await ask(t, "Hello."); assert.equal(requests.length, 1); t.mock.restoreAll();
  await ask(t, "What is 2 plus 2?"); assert.match(sentToModel(), /Hello\./); assert.equal(requests.length, 1);
});
