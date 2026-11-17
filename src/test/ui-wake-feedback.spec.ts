import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import Module from "node:module";
process.env.CAPRI_RESIDENT = "0";   // these fakes exit after each listen; the resident protocol: capri-resident and conversation-lifecycle specs

// Wake acknowledgement, no calibration when the recorder ignores it, and no Whisper call for an empty recording.
// The real state handler, the real wake-word parser and the real recording check run against fixtures.
Object.assign(process.env, { LLM_SERVER: "ollama", MEMORY_ENABLED: "false", WEB_SEARCH_ENABLED: "false", CAPRI_WAKE_WORD_ENABLED: "true" });
const timing = require("../utils/response-timing");
const { recordingHasAudio } = require("../utils/empty-recording");
const ui = require("../utils/ui-status");

const events: any[] = [];
const noop = () => {};
const loose = () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : noop) });
const audio = { onsetFix: true, levelCalls: 0 };
const stubs: Record<string, any> = {
  "../../device/display": {
    onButtonPressed: noop, onButtonReleased: noop, onButtonDoubleClick: noop, display: (status: any) => events.push({ display: status }),
    getCurrentStatus: () => ({ text: "x" }), onCameraCapture: noop, onTextInput: noop, isButtonDown: () => false,
  },
  "../../device/audio": {
    recordAudio: async (file: string, seconds: number, level: number) => { events.push({ record: seconds, level }); return file; },
    recordAudioManually: () => ({ result: Promise.resolve(""), stop: noop }), recordFileFormat: "wav",
    getDynamicVoiceDetectLevel: async () => { audio.levelCalls += 1; return 25; }, voiceDetectEndSilenceSec: 1.5,
    get recorderOnsetFix() { return audio.onsetFix; },
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-wake-"));
const makeCtx = () => {
  const transitions: string[] = [];
  return { answerId: 0, enterMusicAfterAnswer: false, musicDisplayText: "", isFromWakeListening: false, clarificationListen: false, wakeRecordMaxSec: 5,
    recordingsDir: dir, currentRecordFilePath: "", wakeSessionActive: false, currentFlowName: "wake_listening", transitions,
    transitionTo: (name: string) => { transitions.push(name); }, endWakeSession: noop } as any;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statuses = () => events.filter(e => e.display).map(e => e.display.status);

test("with the onset fix the follow-up capture starts at once: no calibration, no calibration screen", async () => {
  events.length = 0; audio.levelCalls = 0; audio.onsetFix = true; timing.resetTiming();
  const ctx = makeCtx();
  flowStates.wake_listening(ctx);
  assert.deepEqual(statuses(), ["listening|auto"], "straight to listening, synchronously: the recorder is started in the same tick");
  assert.equal(events.some(e => e.record !== undefined), true, "the recorder was started immediately");
  await sleep(50);
  assert.equal(audio.levelCalls, 0, "the ambient level is never measured");
  assert.equal(events.find(e => e.display).display.text, "Listening...", "no level readout without a level");
  assert.deepEqual(ctx.transitions, ["asr"]);
});

test("without the onset fix the calibration and its screen are unchanged", async () => {
  events.length = 0; audio.levelCalls = 0; audio.onsetFix = false; timing.resetTiming();
  const ctx = makeCtx();
  flowStates.wake_listening(ctx);
  await sleep(50);
  assert.deepEqual(statuses(), ["detecting", "listening|auto"]);
  assert.equal(audio.levelCalls, 1);
  assert.equal(events.find(e => e.record !== undefined).level, 25, "the measured level still goes to the recorder");
  assert.match(events.filter(e => e.display)[1].display.text, /Detect level: 25%/);
  audio.onsetFix = true;
});

test("Capri: the wake word is acknowledged when the detector fires, before the command capture reports listening", async () => {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 4243; child.kill = noop;
  const lifecycle = { appSignal: { aborted: false, addEventListener: noop, removeEventListener: noop }, spawnOwned: () => child, stopOwnedChild: async () => {} };
  (Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    return request === "../utils/app-lifecycle" ? lifecycle : load.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../device/wakeword")];
  const { WakeWordListener } = require("../device/wakeword");
  (Module as any)._load = load;
  const listener = new WakeWordListener(true);
  const seen: any[] = [];
  for (const name of ["ready", "heard", "listening", "idle"]) listener.on(name, (...args: any[]) => seen.push([name, ...args]));
  listener.start();
  const send = (line: string) => child.stdout.emit("data", Buffer.from(line + "\n"));
  send("CAPRI_READY");
  send(`CAPRI_WAKE ${(Date.now() / 1000 - 0.05).toFixed(3)}`);
  const heard = seen.find(e => e[0] === "heard");
  assert.ok(heard, "heard is emitted from the detector line alone");
  assert.ok(heard[1] >= 40 && heard[1] < 400, `the age of the detection is reported (${heard[1]} ms)`);
  assert.deepEqual(seen.map(e => e[0]), ["ready", "heard"], "no listening state yet");
  send("CAPRI_LISTENING"); send("CAPRI_IDLE");
  assert.deepEqual(seen.map(e => e[0]), ["ready", "heard", "listening", "idle"]);
  send("CAPRI_WAKE nonsense");
  assert.equal(seen[seen.length - 1][0], "heard");
  assert.equal(seen[seen.length - 1][1], undefined, "a malformed timestamp reports no latency, never a guess");
});

test("the acknowledgement is an idle-layout status with a well-formed token; listening stays a separate status", () => {
  assert.equal(ui.uiStatus("idle", "capri", "heard"), "idle|capri,heard");
  assert.notEqual(ui.uiStatus("idle", "capri", "heard").split("|")[0], "listening");
});

test("an empty, missing or header-only recording is not sent to speech recognition; real audio is", () => {
  const wav = path.join(dir, "a.wav");
  assert.equal(recordingHasAudio(path.join(dir, "missing.wav")), false);
  fs.writeFileSync(wav, Buffer.alloc(0)); assert.equal(recordingHasAudio(wav), false);
  fs.writeFileSync(wav, Buffer.alloc(44)); assert.equal(recordingHasAudio(wav), false, "a header with no samples");
  fs.writeFileSync(wav, Buffer.alloc(45)); assert.equal(recordingHasAudio(wav), true);
  fs.writeFileSync(wav, Buffer.alloc(32492)); assert.equal(recordingHasAudio(wav), true, "the 1.0 s soft-word recording");
  const mp3 = path.join(dir, "a.mp3");
  fs.writeFileSync(mp3, Buffer.alloc(0)); assert.equal(recordingHasAudio(mp3), false);
  fs.writeFileSync(mp3, Buffer.alloc(10)); assert.equal(recordingHasAudio(mp3), true);
  assert.equal(recordingHasAudio(dir), false, "a directory is not a recording");
});
