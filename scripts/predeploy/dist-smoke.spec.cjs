// Runs against ./dist in the current directory (a copy of production dist).
// No real Ollama, Whisplay daemon or TV: axios and the control socket are fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const dist = path.resolve("dist");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dist-smoke-"));
Object.assign(process.env, {
  CLEAN_DATA_FOLDER_ON_START: "false", ASR_SERVER: "test", TTS_SERVER: "test",
  MEMORY_ENABLED: "false", MEMPALACE_ENABLED: "false", ENABLE_RAG: "false", ENABLE_CAMERA: "false",
  VISION_SERVER: "", IMAGE_GENERATION_SERVER: "", MUSIC_LIBRARY_DIRS: "", WAKE_WORD_ENABLED: "false",
  WHISPLAY_DEVICE_ENABLED: "false", WHISPLAY_WEB_ENABLED: "false", TEMP: root, TMP: root, TMPDIR: root,
  WHISPLAY_VOICE_CONTROL_ENABLED: "true", LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true",
  WEB_SEARCH_ENABLED: "false", OLLAMA_MODEL: "fixture", ENABLE_THINKING: "false",
});
const directories = {};
for (const key of ["dataDir", "asrDir", "ttsDir", "recordingsDir", "chatHistoryDir", "imageDir", "cameraDir", "cameraFeedDir", "knowledgeDir"]) {
  directories[key] = path.join(root, key);
  fs.mkdirSync(directories[key]);
}
for (const [file, exports] of [["utils/dir.js", directories], ["plugin/loader.js", { loadExternalPlugins() {} }]]) {
  const filename = path.join(dist, file);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

test("production dist: conversation, Whisplay control and f44fb1f guards", async t => {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\dist-smoke-${process.pid}` : path.join(root, "control.sock");
  process.env.WHISPLAY_CONTROL_SOCKET = socket;
  const calls = [];
  const server = net.createServer(c => c.once("data", chunk => {
    const r = JSON.parse(chunk.toString());
    calls.push(r.payload);
    const { action, change, level } = r.payload;
    c.end(JSON.stringify({ ok: true, payload: { status: "completed", action, actual: level ?? 80 + change, previous: 80 } }) + "\n");
  }));
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => new Promise(resolve => server.close(() => resolve())));

  const axios = require("axios");
  let inference = 0, proposed;
  t.mock.method(axios, "post", async (_url, body) => {
    if (!body.messages?.length) return { data: { done: true } };
    inference++;
    const message = { content: proposed ? JSON.stringify({ name: "whisplay", arguments: proposed }) : "Four." };
    const stream = new PassThrough();
    setImmediate(() => stream.end(JSON.stringify({ message, done: true }) + "\n"));
    return { data: stream };
  });
  t.mock.method(axios, "get", async () => ({ data: { models: [{ name: "fixture", context_length: 4096 }] } }));

  const provider = require(path.join(dist, "cloud-api/local/ollama-llm.js")).default;
  const ask = async q => {
    calls.length = 0; inference = 0;
    let reply = "", ends = 0;
    await provider.chatWithLLMStream([{ role: "user", content: q }], p => { reply += p; }, () => { ends++; });
    console.log("SMOKE", JSON.stringify({ q, inference, calls, reply }));
    assert.equal(ends, 1);
    return reply;
  };
  const fresh = () => { provider.resetChatHistory(); proposed = undefined; };

  await t.test("ordinary conversation reaches the model", async () => {
    fresh();
    assert.equal(await ask("What is 2 plus 2?"), "Four.");
    assert.equal(inference, 1); assert.deepEqual(calls, []);
    // Informational question: must never reach the device, whatever the model says.
    assert.doesNotMatch(await ask("How do I lower the volume?"), /request failed/);
    assert.deepEqual(calls, []);
  });
  await t.test("explicit Whisplay volume command still executes without inference", async () => {
    fresh();
    await ask("Lower the volume.");
    assert.deepEqual(calls, [{ action: "volume", change: -10 }]); assert.equal(inference, 0);
  });
  await t.test("negated command changes nothing", async () => {
    fresh();
    assert.match(await ask("Don't lower the volume."), /No device setting changed/);
    assert.deepEqual(calls, []); assert.equal(inference, 0);
  });
  await t.test("f44fb1f: sub-minimum brightness is refused before IPC and before inference", async () => {
    fresh(); proposed = { action: "brightness", level: 30 };
    assert.match(await ask("Set your display brightness to 3 percent."), /between 20 and 100 percent/);
    assert.deepEqual(calls, []); assert.equal(inference, 0);
  });
  await t.test("f44fb1f: unhandled TV-targeted request cannot change Whisplay", async () => {
    fresh(); proposed = { action: "brightness", change: -10 };
    assert.match(await ask("Please lower the TV brightness."), /cannot control the TV/);
    assert.deepEqual(calls, []); assert.equal(inference, 0);
    fresh(); proposed = { action: "volume", change: -10 };
    assert.match(await ask("No, I meant the TV."), /cannot control the TV/);
    assert.deepEqual(calls, []);
  });
  await t.test("TV parsers from the November 12 build are still loaded and unchanged", async () => {
    const tv = require(path.join(dist, "device/lg-c1-volume.js"));
    assert.equal(tv.getTvScreenAction("Turn off the TV screen."), "off");
    assert.equal(tv.getTvScreenAction("Wake up the TV screen."), "on");
    assert.equal(tv.getTvScreenAction("Turn off the TV"), undefined);
    assert.equal(tv.isTurnOffTv("Turn off the TV"), true);
    assert.equal(tv.isTvVolumeDown("Lower the TV volume."), true);
    assert.equal(tv.isTvVolumeDown("Lower the volume."), false);
  });
});
