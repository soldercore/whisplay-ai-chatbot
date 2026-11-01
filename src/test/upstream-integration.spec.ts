import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import ts from "typescript";
import { combineFunction, formatToolResultsForLog } from "../utils";

const project = path.resolve(__dirname, "../..");
function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): any {
  const filename = path.join(project, file);
  const source = file.endsWith(".ts") ? ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText : fs.readFileSync(filename, "utf8");
  const exports = {};
  vm.runInNewContext(source, { exports, __dirname: path.dirname(filename), Buffer, URL, AbortController,
    console: { log() {}, warn() {}, error() {} }, process, setTimeout, clearTimeout,
    require(name: string) {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    }, ...globals }, { filename });
  return exports;
}
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

test("ALSA resolver preserves explicit devices and detects unified/legacy cards", () => {
  for (const [env, cards, expected] of [
    [{}, " 2 [whisplaysound ]: fixture", ["whisplaysound", "hw:whisplaysound,0", "playback"]],
    [{}, " 1 [wm8960soundcard ]: fixture", ["wm8960soundcard", "hw:wm8960soundcard,0", "plughw:wm8960soundcard,0"]],
    [{}, "", [undefined, "default", "default"]],
    [{ SOUND_CARD_INDEX: "4", ALSA_INPUT_DEVICE: "capture", ALSA_OUTPUT_DEVICE: "speaker" }, "",
      ["4", "capture", "speaker"]],
  ] as [NodeJS.ProcessEnv, string, (string | undefined)[]][]) {
    const result = load("src/device/audio-device.ts", { "dotenv/config": {},
      fs: { readFileSync: () => cards } }, { process: { env } });
    assert.deepEqual([result.soundCardRef, result.alsaInputDevice, result.alsaOutputDevice], expected);
  }
});

test("ambient sampling uses owned capture and upstream first-sample sensitivity", async () => {
  const calls: string[][] = [];
  const detector = load("src/device/voice-detect.ts", {
    "./audio-device": { alsaInputDevice: "hw:fixture,0" },
    "../utils/app-lifecycle": { spawnOwned(_command: string, args: string[]) {
      calls.push(args);
      const child: any = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => { child.stderr.write("RMS amplitude: 0.01\n"); child.emit("close", 0); });
      return child;
    } },
  }, { process: { env: {} } });
  assert.equal(await detector.getDynamicVoiceDetectLevel(), 2);
  assert.equal(calls[0][2], "hw:fixture,0");
});

test("wake listening waits for chime and cannot start after changed state, ended session or shutdown", async () => {
  for (const interruption of ["none", "state", "session", "shutdown"]) {
    let finishChime: () => void = () => {};
    const chime = new Promise<void>(resolve => { finishChime = resolve; });
    const app = new AbortController(), states: string[] = [];
    const noop = () => {};
    class Machine { constructor(private ctx: any) {} transitionTo(state: string) { this.ctx.currentFlowName = state; } }
    const Flow = load("src/core/ChatFlow.ts", {
      "./audio-timing": require("../core/audio-timing"),
      "./../utils/index": { getCurrentTimeTag: () => "test" }, "../utils": {},
      "../device/display": { display: noop }, "../cloud-api/server": {},
      "../cloud-api/llm": { isImMode: false },
      "./StreamResponsor": { StreamResponser: class {} },
      "./spoken-text-reveal": { SpokenTextReveal: class {} },
      "../utils/dir": {}, dotenv: { config: noop }, "../device/wakeword": {}, "../device/im-bridge": {},
      "./chat-flow/stateMachine": { FlowStateMachine: Machine }, "./chat-flow/states": { flowStates: {} },
      "../device/audio": { playWakeupChime: () => chime },
      "../device/music-player": { isMusicPlaying: () => false },
      "../utils/app-lifecycle": { appSignal: app.signal },
    }, { process: { env: {} } }).default;
    const ctx = new Flow(); ctx.transitionTo = (state: string) => { states.push(state); };
    const pending = ctx.startWakeSession(); assert.equal(states.length, 0);
    if (interruption === "state") ctx.currentFlowName = "answer";
    if (interruption === "session") ctx.endWakeSession();
    if (interruption === "shutdown") app.abort();
    finishChime(); await pending;
    assert.deepEqual(states, interruption === "none" ? ["wake_listening"] : []);
  }
});

function provider(options: { env?: NodeJS.ProcessEnv; create?: (request: any, round: number) => any; image?: string } = {}) {
  const calls: { api: string; request: any }[] = [];
  let writes = 0, toolRuns = 0;
  const create = (api: string) => async (request: any) => {
    calls.push({ api, request: JSON.parse(JSON.stringify(request)) });
    if (options.create) return options.create(request, calls.length);
    if (request.stream) return (async function* () {
      if (api === "responses") {
        yield { type: "response.output_text.delta", delta: "local fixture answer" };
        yield { type: "response.completed", response: { id: "response-fixture" } };
      } else yield { choices: [{ delta: { content: "local fixture answer" } }] };
    })();
    return api === "responses" ? { id: "response-fixture", output_text: "local fixture answer", output: [] }
      : { choices: [{ message: { content: "local fixture answer" } }] };
  };
  const api = load("src/cloud-api/openai/openai-llm.ts", {
    dotenv: { config() {} }, fs: { ...fs, writeFileSync() { writes++; } }, path,
    lodash: require("lodash"), moment: require("moment"),
    "../../config/llm-config": { shouldResetChatHistory: () => false, systemPrompt: "custom persona", updateLastMessageTime() {} },
    "../../type": require("../type"), "../../utils": { combineFunction, formatToolResultsForLog },
    "./openai": { openai: { responses: { create: create("responses") }, chat: { completions: { create: create("chat") } } } },
    "../../config/llm-tools": { llmTools: [{ type: "function", function: { name: "probe", parameters: {} } }],
      llmFuncMap: { probe: async () => { toolRuns++; return "[rejected]fixture permission denied"; } } },
    "../../utils/dir": { chatHistoryDir: "/disposable" },
    "../../utils/image": { hasPendingCapturedImgForChat: () => !!options.image,
      consumePendingCapturedImgForChat: () => options.image, getImageMimeType: () => "image/png" },
    "../context-window": { compactMessagesForContextWindow: async () => {} },
  }, { process: { env: options.env || {} } }).default;
  return { api, calls, writes: () => writes, toolRuns: () => toolRuns };
}

for (const streaming of [true, false]) {
  for (const [base, mode, expected] of [
    [undefined, "auto", "responses"], ["http://127.0.0.1:8808/v1", "auto", "chat"],
    ["http://127.0.0.1:8808/v1", "responses", "responses"], [undefined, "chat-completions", "chat"],
  ]) test(`provider API selection: ${mode}/${base || "official"}, stream=${streaming}`, async () => {
    const f = provider({ env: { OPENAI_API_BASE_URL: base, OPENAI_API_MODE: mode, OPENAI_USE_STREAM: String(streaming) } });
    let ended = 0, text = "";
    await f.api.chatWithLLMStream([{ role: "user", content: "question" }], (part: string) => { text += part; }, () => { ended++; });
    assert.equal(f.calls[0].api, expected); assert.equal(ended, 1);
    assert.equal(text, "local fixture answer"); assert.equal(f.writes(), 1);
  });
}

test("Responses function continuation retains rejected result and completes exactly once", async () => {
  const f = provider({ env: { OPENAI_USE_STREAM: "false" }, create: (_request, round) => round === 1
    ? { id: "first", output_text: "", output: [{ type: "function_call", call_id: "call-1", name: "probe", arguments: "{}" }] }
    : { id: "second", output_text: "The action was rejected.", output: [] } });
  let ended = 0;
  await f.api.chatWithLLMStream([{ role: "user", content: "question" }], () => {}, () => { ended++; });
  assert.equal(f.toolRuns(), 1); assert.equal(ended, 1);
  assert.equal(f.calls[1].request.previous_response_id, "first");
  assert.deepEqual(f.calls[1].request.input, [{ type: "function_call_output", call_id: "call-1", output: "[rejected]fixture permission denied" }]);
});

test("Responses image input preserves bytes and provider errors do not fire duplicate completion", async () => {
  const image = path.join(require("../utils/dir").imageDir, "provider-fixture.png");
  fs.writeFileSync(image, Buffer.from("synthetic image"));
  const f = provider({ image, env: { OPENAI_USE_STREAM: "false", USE_CAPTURED_IMAGE_IN_CHAT: "true" } });
  await f.api.chatWithLLMStream([{ role: "user", content: "image question" }], () => {}, () => {});
  assert.equal(f.calls[0].request.input[1].content[1].image_url, `data:image/png;base64,${Buffer.from("synthetic image").toString("base64")}`);
  for (const streaming of [true, false]) {
    const broken = provider({ env: { OPENAI_USE_STREAM: String(streaming) }, create: () => { throw new Error("fixture HTTP failure"); } });
    let ended = 0;
    await assert.rejects(broken.api.chatWithLLMStream([{ role: "user", content: "question" }], () => {}, () => { ended++; }), /fixture HTTP failure/);
    assert.equal(ended, 0);
  }
});

test("Hailo ASR client preserves request format and uses app cancellation without exit handlers", async () => {
  const controller = new AbortController(), requests: any[] = [];
  for (const kind of ["filePath", "base64"]) {
    const api = load("src/cloud-api/local/hailo-whisper-asr.ts", {
      axios: { post: async (...args: any[]) => { requests.push(args); return { data: { recognition: "GLaDOS" } }; } },
      dotenv: { config() {} }, fs: { readFileSync: () => Buffer.from("audio fixture") },
      "./common": { defaultPortMap: { hailoWhisper: 8807 } },
      "../../utils/app-lifecycle": { appSignal: controller.signal },
    }, { process: { env: { HAILO_WHISPER_REQUEST_TYPE: kind } } });
    assert.equal(await api.recognizeAudio("original.wav"), "GLaDOS");
    const [url, body, config] = requests[requests.length - 1];
    assert.equal(url, "http://localhost:8807/recognize");
    assert.equal(body.language, "en"); assert.equal(config.signal, controller.signal);
    assert.equal(config.timeout, 20000);
    assert.equal(kind === "filePath" ? body.filePath : body.base64,
      kind === "filePath" ? "original.wav" : Buffer.from("audio fixture").toString("base64"));
  }
});

test("daemon registration orders autostart/launch and fails if registration or capability is rejected", async () => {
  for (const reject of ["", "app.register", "app.autostart.set"]) {
    const calls: string[] = [];
    const state = { argv: ["node", "register", "--autostart"], cwd: () => project, exitCode: 0 };
    load("scripts/register-whisplay-daemon-app.js", {
      fs: { existsSync: () => true }, path,
      net: { createConnection() {
        const socket: any = new EventEmitter();
        socket.setTimeout = () => {}; socket.end = () => {};
        socket.write = (line: string) => {
          const request = JSON.parse(line); calls.push(request.cmd);
          if (request.cmd === "app.register") assert.match(request.payload.launch_command, /run_chatbot\.sh/);
          queueMicrotask(() => socket.emit("data", Buffer.from(JSON.stringify({ ok: request.cmd !== reject, error: "fixture rejection" }) + "\n")));
        };
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      } },
    }, { process: state });
    await flush();
    assert.equal(state.exitCode, reject ? 1 : 0);
    assert.deepEqual(calls, reject === "app.register" ? ["app.register"]
      : reject === "app.autostart.set" ? ["app.register", "app.autostart.set"]
      : ["app.register", "app.autostart.set", "app.launch"]);
  }
});
