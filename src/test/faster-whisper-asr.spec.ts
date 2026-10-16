import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import axios from "axios";

const originalPost = axios.post;
const requests: { url: string; body: any }[] = [];
let transcription = "GLaDOS, can you hear me? Give me a short response.";
const modulePath = require.resolve("../cloud-api/local/faster-whisper-asr");
const events = ["SIGINT", "SIGTERM", "exit", "uncaughtException", "unhandledRejection"] as const;
const lifecycle: import("node:events").EventEmitter = process;
let listeners: Map<string, Function[]>;

before(() => {
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/);
  // ASR_SERVER=test prevents launching the Python service on module import.
  process.env.ASR_SERVER = "test";
  axios.post = (async (url: string, body: any) => {
    requests.push({ url, body });
    return { data: { recognition: transcription, language: "en", time_cost: 0.01 } };
  }) as typeof axios.post;
});
beforeEach(() => { requests.length = 0; listeners = new Map(events.map(event => [event, lifecycle.listeners(event)])); });
afterEach(() => {
  // Module reloads exercise import-time configuration; remove only their own
  // lifecycle listeners so test cases do not accumulate process handlers.
  for (const event of events) for (const listener of lifecycle.listeners(event)) {
    if (!listeners.get(event)!.includes(listener)) lifecycle.removeListener(event, listener as (...args: any[]) => void);
  }
});
after(() => { axios.post = originalPost; });

function client(hint?: string, requestType = "filePath") {
  Object.assign(process.env, { FASTER_WHISPER_HOST: "localhost", FASTER_WHISPER_PORT: "8803",
    FASTER_WHISPER_REQUEST_TYPE: requestType });
  delete process.env.FASTER_WHISPER_LANGUAGE; // Preserve the existing default English selection.
  if (hint === undefined) delete process.env.FASTER_WHISPER_INITIAL_PROMPT;
  else process.env.FASTER_WHISPER_INITIAL_PROMPT = hint;
  delete require.cache[modulePath];
  return require("../cloud-api/local/faster-whisper-asr");
}

test("configured shortest hint is supplied in the actual HTTP request with English unchanged", async () => {
  await client("GLaDOS").recognizeAudio("fixture.wav");
  assert.deepEqual(requests, [{ url: "http://localhost:8803/recognize",
    body: { filePath: "fixture.wav", language: "en", initial_prompt: "GLaDOS" } }]);
});

test("unset or blank hint preserves the legacy request without prompting", async () => {
  for (const hint of [undefined, "", "  "]) {
    requests.length = 0;
    await client(hint).recognizeAudio("fixture.wav");
    assert.deepEqual(requests[0].body, { filePath: "fixture.wav", language: "en" });
  }
});

test("base64 request carries the same hint without changing audio", async () => {
  const file = path.join(require("../utils/dir").asrDir, "hint-fixture.wav");
  const bytes = Buffer.from("synthetic request bytes, not a speech fixture");
  fs.writeFileSync(file, bytes);
  await client("GLaDOS", "base64").recognizeAudio(file);
  assert.deepEqual(requests[0].body, { base64: bytes.toString("base64"), language: "en", initial_prompt: "GLaDOS" });
});

for (const text of [
  "GLaDOS, can you hear me? Give me a short response.",
  "Gladdles, can you hear me? Give me a short response.", "Gladles?",
  "What is the capital of Norway?", "I meant to say gladdles, not gladles.",
  'She said "Gladdles, can you hear me?"', "First sentence. Gladdles, can you hear me?",
]) test(`ASR response is returned verbatim without normalization: ${text}`, async () => {
  transcription = text;
  assert.equal(await client("GLaDOS").recognizeAudio("fixture.wav"), text);
});

test("both real Python HTTP handlers forward the hint to their model call", () => {
  const python = process.platform === "win32" ? "python" : "python3";
  const output = execFileSync(python, ["-B", "python/test/test_faster_whisper_host.py"], {
    cwd: path.resolve(__dirname, "../.."), encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.match(output, /\[INIT\] Model loaded/);
});
