import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import Module from "node:module";
process.env.CAPRI_RESIDENT = "0";   // these fakes exit after each listen; the resident protocol: capri-resident and conversation-lifecycle specs

// Truthful microphone and response feedback. The recorder, display and Capri child process are fixtures; the real
// state handlers, the real wake-word parser and the real timing module run against them.
Object.assign(process.env, { LLM_SERVER: "ollama", MEMORY_ENABLED: "false", WEB_SEARCH_ENABLED: "false", CAPRI_WAKE_WORD_ENABLED: "true" });
const ui = require("../utils/ui-status");
const timing = require("../utils/response-timing");

test("status tokens: only well-formed tokens are sent, and the idle status says what is really running", () => {
  assert.equal(ui.uiStatus("idle"), "idle");
  assert.equal(ui.uiStatus("listening", "auto", false, undefined, null, "audio"), "listening|auto,audio");
  assert.equal(ui.uiStatus("listening", "answer:7"), "listening|answer:7");
  for (const bad of ["BAD", "a b", "x|y", "t,u", "", "a:b:c", "resp:-1"]) assert.equal(ui.uiStatus("idle", bad), "idle", bad);
  assert.equal(ui.composeIdleStatus({ capriReady: false, pendingClarification: false }), "idle", "no claim about Capri until it reports ready");
  assert.equal(ui.composeIdleStatus({ capriReady: true, pendingClarification: false }), "idle|capri");
  assert.equal(ui.composeIdleStatus({ capriReady: true, metric: { kind: "resp", seconds: 1.84 }, pendingClarification: false }), "idle|capri,resp:1.8");
  assert.equal(ui.composeIdleStatus({ capriReady: true, metric: { kind: "act", seconds: 2.04 }, pendingClarification: true }), "idle|capri,act:2.0,pend:capri");
  assert.equal(ui.composeIdleStatus({ capriReady: false, pendingClarification: true }), "idle|pend:button");
  // The passive listener is never described as recording: "capri" appears only on the idle status.
  assert.doesNotMatch(ui.composeIdleStatus({ capriReady: true, pendingClarification: false }), /listening|rec/);
});

test("response timing: every value needs both of its real events", () => {
  let now = 0;
  timing.resetTiming(); timing.setClock(() => now);
  // Button turn: RESPONSE is release -> first audible sentence.
  now = 5000; timing.beginTurn("button", 5000);
  now = 5400; timing.mark("transcribed");
  now = 6500; timing.mark("firstText");
  now = 7200; timing.mark("firstAudible");
  now = 7300; timing.mark("firstAudible");   // a later sentence must not move the first
  now = 12000;
  let s = timing.finishTurn();
  assert.deepEqual([s.speechToTranscriptMs, s.transcriptToFirstTextMs, s.firstAudibleMs, s.totalMs], [400, 1100, 2200, 7000]);
  assert.deepEqual(s.metric, { kind: "resp", seconds: 2.2 });
  assert.match(timing.diagnosticsLine(s), /^\[ResponseTiming\] path=button speech_end->transcript=400ms transcript->first_text=1100ms first_audible=2200ms action=- tool=- total=7000ms$/);
  assert.equal(timing.recentMetric(20_000).seconds, 2.2);
  now = 12000 + 21_000;
  assert.equal(timing.recentMetric(20_000), undefined, "a stale value is not shown");

  // Device command: the shown value is the action (speech end -> verified outcome); tool time is secondary.
  now = 100_000; timing.beginTurn("capri", 100_000 - 1800);   // the wake script reported speech ended 1.8 s ago
  now = 100_100; timing.mark("transcribed");
  now = 100_200; timing.toolStarted();
  now = 100_900; timing.toolFinished(true);
  now = 101_300; timing.mark("firstAudible");
  now = 103_000;
  s = timing.finishTurn();
  assert.equal(s.actionMs, 2700); assert.equal(s.toolMs, 700); assert.equal(s.firstAudibleMs, 3100);
  assert.deepEqual(s.metric, { kind: "act", seconds: 2.7 }, "a device command reports the action, not the later speech");

  // A model tool (not host-routed) does not turn the value into an action.
  now = 200_000; timing.beginTurn("auto", 199_000);
  now = 200_100; timing.toolStarted(); now = 200_500; timing.toolFinished(false); now = 201_000; timing.mark("firstAudible");
  assert.equal(timing.finishTurn().metric.kind, "resp");

  // Missing events: nothing is invented.
  now = 300_000; timing.beginTurn("auto", 299_000); now = 303_000;
  s = timing.finishTurn();
  assert.equal(s.firstAudibleMs, undefined); assert.equal(s.metric, undefined, "no audible reply: no RESPONSE value");
  timing.beginTurn("button"); timing.mark("firstAudible");
  s = timing.finishTurn();
  assert.equal(s.metric, undefined, "no speech-end event: no value");
  timing.beginTurn("capri", 400_000 + 5); now = 400_000;
  timing.mark("firstAudible");
  assert.equal(timing.finishTurn().metric, undefined, "a speech end in the future is rejected");
  now = 500_000; timing.beginTurn("auto", 500_000 - 200_000); now = 500_000; timing.mark("firstAudible");
  assert.equal(timing.finishTurn().metric, undefined, "an implausible 200 s span is not shown");
  assert.equal(timing.finishTurn(), undefined, "no turn, no summary");
  timing.beginTurn("button", now); timing.clearTurn(); assert.equal(timing.hasTurn(), false, "typed input clears the turn");
  timing.resetTiming();
});

test("first audible counts only synthesised audio whose playback started, never an empty or failed sentence", () => {
  let now = 0;
  timing.resetTiming(); timing.setClock(() => now);
  now = 1000; timing.beginTurn("button", 1000);
  now = 1800; timing.markAudible(0);          // a sentence with no audio (failed or silent): the sentence-play event still fires
  now = 2100; timing.markAudible(1450);       // the first real sentence
  now = 2600; timing.markAudible(900);
  now = 4000;
  const s = timing.finishTurn();
  assert.equal(s.firstAudibleMs, 1100, "measured to the first sentence that actually played");
  now = 5000; timing.beginTurn("button", 5000); now = 5500; timing.markAudible(0); now = 6000;
  assert.equal(timing.finishTurn().metric, undefined, "no audio at all: no RESPONSE value");
  timing.resetTiming();
});

test("response and action stay separate measurements", () => {
  let now = 0;
  timing.resetTiming(); timing.setClock(() => now);
  now = 0; timing.beginTurn("auto", 0);
  now = 500; timing.toolStarted(); now = 1900; timing.toolFinished(true);   // device action finished at 1.9 s
  now = 2600; timing.markAudible(1000);                                      // its spoken result starts at 2.6 s
  now = 4000;
  const s = timing.finishTurn();
  assert.equal(s.actionMs, 1900); assert.equal(s.firstAudibleMs, 2600);
  assert.deepEqual(s.metric, { kind: "act", seconds: 1.9 }, "the action value, not the later speech");
  now = 10_000; timing.beginTurn("auto", 10_000); now = 10_800; timing.toolStarted(); now = 11_000; timing.toolFinished(false); now = 11_500; timing.markAudible(1000);
  assert.deepEqual(timing.finishTurn().metric, { kind: "resp", seconds: 1.5 }, "a model tool call is not a device action");
  timing.resetTiming();
});

// ---- The real wake_listening handler with a recorder fixture ----
const events: any[] = [];
const noop = () => {};
const loose = () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : noop) });
let recorder: (file: string, seconds: number) => Promise<void> = async () => {};
const stubs: Record<string, any> = {
  "../../device/display": {
    onButtonPressed: noop, onButtonReleased: noop, onButtonDoubleClick: noop, display: (status: any) => events.push({ display: status }),
    getCurrentStatus: () => ({ text: "x" }), onCameraCapture: noop, onTextInput: noop, isButtonDown: () => false,
  },
  "../../device/audio": {
    recordAudio: async (file: string, seconds: number) => { events.push({ record: seconds }); await recorder(file, seconds); return file; },
    recordAudioManually: () => ({ result: Promise.resolve(""), stop: noop }), recordFileFormat: "wav", getDynamicVoiceDetectLevel: async () => 25, voiceDetectEndSilenceSec: 1.5,
  },
  "../../cloud-api/server": { chatWithLLMStream: noop, llmServer: "ollama" }, "../../cloud-api/llm": { isImMode: false, summaryTextWithLLM: noop },
  "../Knowledge": { getSystemPromptWithKnowledge: async () => "" }, "../../cloud-api/knowledge": { enableRAG: false }, "../../utils/dir": { cameraDir: "/tmp" },
  "../../utils/image": { clearPendingCapturedImgForChat: noop, getLatestGenImg: () => "", getLatestDisplayImg: () => "", setLatestCapturedImg: noop, setPendingCapturedImgForChat: noop },
  "../../cloud-api/whisplay-im/whisplay-im": { sendWhisplayIMMessage: noop },
  "./camera-mode": { enterCameraMode: noop, handleCameraModePress: noop, handleCameraModeRelease: noop, onCameraModeExit: noop, resetCameraModeControl: noop },
  "../../device/music-player": loose(), "../../config/local-memory": { autoSaveExchange: noop, prepareMemoryMessage: () => undefined },
  "../../device/whisplay-control": { whisplayHandoffTicket: () => undefined, presentWhisplayHandoff: async () => {}, cancelWhisplayHandoff: noop },
};
const load = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) { return request in stubs ? stubs[request] : load.call(this, request, parent, isMain); };
const { flowStates } = require("../core/chat-flow/states");
(Module as any)._load = load;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-feedback-"));
const makeCtx = (over: any = {}) => {
  const transitions: string[] = [];
  return { answerId: 0, enterMusicAfterAnswer: false, musicDisplayText: "", isFromWakeListening: false, clarificationListen: false, wakeRecordMaxSec: 60,
    recordingsDir: dir, currentRecordFilePath: "", wakeSessionActive: false, currentFlowName: "wake_listening", transitions,
    transitionTo: (name: string) => { transitions.push(name); }, endWakeSession: noop, ...over } as any;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statuses = () => events.filter(e => e.display).map(e => e.display.status);

test("audio detection comes from the recorder's own output: only real growth shows AUDIO, once", async () => {
  events.length = 0; timing.resetTiming();
  recorder = async (file) => {
    fs.writeFileSync(file, Buffer.alloc(44));         // header only: the recorder has opened the file, nothing heard yet
    await sleep(600);
    assert.deepEqual(statuses(), ["detecting", "listening|auto"], "waiting is not hearing");
    fs.appendFileSync(file, Buffer.alloc(8000));      // sound passed the start level
    await sleep(700);
    fs.appendFileSync(file, Buffer.alloc(8000));      // more speech: no second event
    await sleep(100);
  };
  const ctx = makeCtx();
  flowStates.wake_listening(ctx);
  await sleep(1900);
  assert.deepEqual(statuses(), ["detecting", "listening|auto", "listening|auto,audio"]);
  assert.deepEqual(ctx.transitions, ["asr"]);
  assert.equal(timing.hasTurn(), true, "the recording end started a timing turn");
  const before = statuses().length;
  await sleep(600);
  assert.equal(statuses().length, before, "polling stopped with the recording");
});

test("silence: no audio status, a bounded capture, and no recognised-speech state", async () => {
  events.length = 0; timing.resetTiming();
  recorder = async (file, seconds) => { fs.writeFileSync(file, Buffer.alloc(44)); await sleep(900); };
  const ctx = makeCtx({ clarificationListen: true });
  flowStates.wake_listening(ctx);
  await sleep(1300);
  assert.deepEqual(statuses(), ["detecting", "listening|answer:7"], "never AUDIO without sound");
  assert.equal(events.find(e => e.record !== undefined).record, 7, "bounded capture");
  assert.deepEqual(ctx.transitions, ["asr"]);
});

test("a failed recorder returns to sleep and stops polling", async () => {
  events.length = 0;
  recorder = async () => { throw new Error("microphone busy"); };
  const ctx = makeCtx();
  const errors = console.error; console.error = noop;
  flowStates.wake_listening(ctx);
  await sleep(500);
  console.error = errors;
  assert.deepEqual(ctx.transitions, ["sleep"]);
  const before = statuses().length;
  await sleep(500);
  assert.equal(statuses().length, before, "no leftover poller");
});

test("the LED is the recording colour only while recording; transcription is the working colour", async () => {
  events.length = 0;
  recorder = async () => { await sleep(150); };
  const ctx = makeCtx({ recognizeAudio: async () => "", isFromWakeListening: true, shouldEndAfterAnswer: () => false, shouldContinueWakeSession: () => false, wakeSessionLastSpeechAt: 0 });
  flowStates.wake_listening(ctx);
  await sleep(500);
  const colours = events.filter(e => e.display).map(e => [e.display.status, e.display.RGB]);
  assert.deepEqual(colours.map(c => c[1]), ["#00ff00", "#00ff00"], "detecting and listening: the capture is running");
  events.length = 0;
  flowStates.asr(ctx);
  await sleep(50);
  const asr = events.find(e => e.display).display;
  assert.deepEqual([asr.status, asr.RGB], ["recognizing", "#ff6800"], "recording is over: the LED leaves the recording colour before Whisper finishes");
});

// ---- The real Capri listener parser with a fake child ----
test("Capri lifecycle: ready is passive, audio is the active capture, processing ends it, and the command carries the real end of speech", async () => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4242; child.kill = noop;
  const lifecycle = { appSignal: { aborted: false, addEventListener: noop, removeEventListener: noop }, spawnOwned: () => child, stopOwnedChild: async () => {} };
  (Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    return request === "../utils/app-lifecycle" ? lifecycle : load.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../device/wakeword")];
  const { WakeWordListener } = require("../device/wakeword");
  (Module as any)._load = load;
  const listener = new WakeWordListener(true);
  const seen: any[] = [];
  for (const name of ["ready", "listening", "audio", "processing", "idle", "unavailable", "command"]) listener.on(name, (...args: any[]) => seen.push([name, ...args]));
  listener.start();
  const send = (line: string) => child.stdout.emit("data", Buffer.from(line + "\n"));
  const logged: string[] = [];
  const realLog = console.log; console.log = (...args: any[]) => { logged.push(args.join(" ")); };
  send("CAPRI_READY");
  console.log = realLog;
  assert.deepEqual(logged, ["[WakeWord] CAPRI_READY"], "the existing log line is kept: the deploy health check and operators read it");
  assert.deepEqual(seen.map(e => e[0]), ["ready"], "the passive listener is ready; that alone is not a recording");
  send("CAPRI_LISTENING"); send("CAPRI_AUDIO"); send("CAPRI_PROCESSING");
  assert.deepEqual(seen.map(e => e[0]), ["ready", "listening", "audio", "processing"]);
  const arrival = performance.now();
  send("CAPRI_TIMING 1500");
  send('CAPRI_COMMAND "turn off the tv screen"');
  await sleep(30);
  const command = seen.find(e => e[0] === "command");
  assert.equal(command[1], "turn off the tv screen");
  assert.ok(Math.abs(command[2] - (arrival - 1500)) < 60, "speech end = when the timing line arrived minus the reported age");
  assert.ok(command[2] <= performance.now(), "never in the future");
  // A malformed or absent timing value yields no speech end rather than a guess.
  const second = new WakeWordListener(true);
  const got: any[] = [];
  second.on("command", (...args: any[]) => got.push(args));
  second.start();
  send("CAPRI_TIMING nonsense"); send('CAPRI_COMMAND "hello"');
  await sleep(30);
  assert.equal(got.length, 1);
  assert.equal(got[0][0], "hello");
  assert.equal(got[0][1], undefined, "no valid timing: no speech end is invented");
});
