// TTS pipeline tests: StreamResponser -> piper-http-tts -> audio.ts playback.
// Piper is a local fake HTTP server, curl is real, SoX is fixtures/fake-sox.js.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import childProcess from "child_process";
import type { Socket } from "net";

const FAKE_SOX = path.join(__dirname, "fixtures", "fake-sox.js");
const soxLog = path.join(os.tmpdir(), `whisplay-fake-sox-${process.pid}.log`);

const spawned: string[] = [];
const realSpawn = childProcess.spawn;
(childProcess as any).spawn = (command: string, args: string[] = [], options: any = {}) => {
  spawned.push(command);
  if (command === "sox") {
    return realSpawn(process.execPath, [FAKE_SOX, ...args], {
      ...options,
      env: { ...process.env, FAKE_SOX_LOG: soxLog },
    });
  }
  return realSpawn(command, args, options);
};

const fnv1a = (buffer: Buffer): string => {
  let hash = 0x811c9dc5;
  for (const byte of buffer) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const makeWav = (seed: number, ms: number): Buffer => {
  const rate = 22050;
  const samples = Math.round((rate * ms) / 1000);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  const freq = 200 + (seed % 50) * 23;
  for (let i = 0; i < samples; i++) {
    wav.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  }
  return wav;
};

type Mode = "ok" | "error500" | "html200" | "reset" | "hang";
let mode: Mode = "ok";
const requests: { text: string; length_scale: number }[] = [];
const wavHashByText = new Map<string, string>();
const sockets = new Set<Socket>();

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const payload = JSON.parse(body);
    requests.push(payload);
    if (mode === "hang") return;
    if (mode === "reset") {
      req.socket.destroy();
      return;
    }
    if (mode === "error500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Voice model not loaded" }));
      return;
    }
    if (mode === "html200") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Piper is starting</body></html>");
      return;
    }
    const wav = makeWav(requests.length, 300 + payload.text.length * 10);
    wavHashByText.set(payload.text, fnv1a(wav));
    // Later requests finish first, which is what Piper does with short sentences.
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(wav);
    }, Math.max(20, 120 - requests.length * 15));
  });
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

let piperHttpTTS: (text: string) => Promise<any>;
let playAudioData: (params: any) => Promise<void>;
let StreamResponser: any;
let ttsDir: string;
let filesBefore = new Set<string>();

const soxLogLines = (): string[] =>
  fs.existsSync(soxLog) ? fs.readFileSync(soxLog, "utf8").trim().split("\n").filter(Boolean) : [];

const capture = async (method: "error" | "warn", run: () => Promise<void>): Promise<string> => {
  const original = console[method];
  let output = "";
  console[method] = (...args: any[]) => {
    output += `${args.join(" ")}\n`;
  };
  try {
    await run();
  } finally {
    console[method] = original;
  }
  return output;
};

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  Object.assign(process.env, {
    PIPER_HTTP_HOST: "127.0.0.1",
    PIPER_HTTP_PORT: String(port),
    PIPER_HTTP_TIMEOUT_SEC: "2",
    PIPER_HTTP_LENGTH_SCALE: "1",
    TTS_SERVER: "test",
    ASR_SERVER: "test",
    LLM_SERVER: "test",
    ALSA_OUTPUT_DEVICE: "playback",
    WEB_AUDIO_ENABLED: "false",
    FAKE_SOX_PLAY_SCALE: "0.05",
  });
  ttsDir = require("../utils/dir").ttsDir;
  filesBefore = new Set(fs.readdirSync(ttsDir));
  piperHttpTTS = require("../cloud-api/local/piper-http-tts").default;
  playAudioData = require("../device/audio").playAudioData;
  StreamResponser = require("../core/StreamResponsor").StreamResponser;
});

after(() => {
  sockets.forEach((socket) => socket.destroy());
  server.close();
  for (const file of fs.readdirSync(ttsDir)) {
    if (!filesBefore.has(file)) fs.rmSync(path.join(ttsDir, file), { force: true });
  }
  fs.rmSync(soxLog, { force: true });
});

const newTempFiles = (): string[] =>
  fs.readdirSync(ttsDir).filter((file) => !filesBefore.has(file) && !file.endsWith("_converted.wav"));

test("successful Piper response is converted and returned with its duration", async () => {
  mode = "ok";
  const result = await piperHttpTTS('He said "hello" there.');
  assert.ok(result.filePath?.endsWith("_converted.wav"));
  assert.ok(fs.existsSync(result.filePath));
  assert.ok(Math.abs(result.duration - (300 + 23 * 10)) < 40, `duration ${result.duration}`);
  assert.deepEqual(requests[requests.length - 1], { text: 'He said "hello" there.', length_scale: 1 });
  assert.deepEqual(newTempFiles(), []);
});

test("HTTP error status returns no audio and never converts the error body", async () => {
  mode = "error500";
  const linesBefore = soxLogLines().length;
  let result: any;
  const errors = await capture("error", async () => {
    result = await piperHttpTTS("This request fails.");
  });
  assert.deepEqual(result, { duration: 0 });
  assert.match(errors, /HTTP 500/);
  assert.match(errors, /Voice model not loaded/);
  assert.equal(soxLogLines().length, linesBefore);
  assert.deepEqual(newTempFiles(), []);
});

test("a 200 response that is not WAV audio returns no audio", async () => {
  mode = "html200";
  const linesBefore = soxLogLines().length;
  let result: any;
  const errors = await capture("error", async () => {
    result = await piperHttpTTS("Piper is warming up.");
  });
  assert.deepEqual(result, { duration: 0 });
  assert.match(errors, /no WAV audio/);
  assert.match(errors, /Piper is starting/);
  assert.equal(soxLogLines().length, linesBefore);
  assert.deepEqual(newTempFiles(), []);
});

test("a dropped connection returns no audio", async () => {
  mode = "reset";
  let result: any;
  const errors = await capture("error", async () => {
    result = await piperHttpTTS("Connection drops.");
  });
  assert.deepEqual(result, { duration: 0 });
  assert.match(errors, /Piper process exited with code \d+/);
});

test("a stalled Piper request times out instead of blocking playback", async () => {
  mode = "hang";
  const started = Date.now();
  let result: any;
  await capture("error", async () => {
    result = await piperHttpTTS("Piper never answers.");
  });
  assert.deepEqual(result, { duration: 0 });
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started}ms`);
});

test("requests started in the same millisecond keep their own audio", async () => {
  mode = "ok";
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  let pending: Promise<any>[];
  try {
    pending = ["First sentence.", "Second sentence.", "Third sentence."].map((text) => piperHttpTTS(text));
  } finally {
    Date.now = realNow;
  }
  const results = await Promise.all(pending);
  const paths = results.map((result) => result.filePath);
  assert.equal(new Set(paths).size, 3);
  ["First sentence.", "Second sentence.", "Third sentence."].forEach((text, i) => {
    assert.equal(fnv1a(fs.readFileSync(paths[i])), wavHashByText.get(text), text);
  });
});

test("a zero-duration result is skipped without starting SoX", async () => {
  const before = spawned.length;
  await playAudioData({ duration: 0 });
  await playAudioData({ duration: 0, filePath: "" });
  assert.equal(spawned.length, before);
});

test("a playback failure is reported with SoX stderr and does not throw", async () => {
  mode = "ok";
  const { filePath, duration } = await piperHttpTTS("Playback fails.");
  process.env.FAKE_SOX_PLAY_FAIL = "1";
  try {
    const errors = await capture("error", () => playAudioData({ filePath, duration }));
    assert.match(errors, /Audio playback error: 1/);
    assert.match(errors, /cannot open audio device/);
  } finally {
    delete process.env.FAKE_SOX_PLAY_FAIL;
  }
});

test("playback goes to ALSA_OUTPUT_DEVICE", async () => {
  mode = "ok";
  const { filePath, duration } = await piperHttpTTS("Playback works.");
  await playAudioData({ filePath, duration });
  const last = soxLogLines().filter((line) => line.startsWith("PLAY")).pop() || "";
  const [, hash, , device] = last.split(" ");
  assert.equal(device, "playback");
  assert.equal(hash, wavHashByText.get("Playback works."));
});

test("a sentence that purifies to nothing is reported and not synthesized", async () => {
  const synthesized = new Set<string>();
  const responder = new StreamResponser(async (text: string) => {
    synthesized.add(text);
    return { duration: 0 };
  });
  const warnings = await capture("warn", async () => {
    responder.partial("Done! \u{1F600}\u{1F600}\u{1F600}");
    responder.endPartial();
    await responder.getPlayEndPromise();
  });
  assert.deepEqual([...synthesized], ["Done!"], "only the speakable sentence reaches TTS");
  assert.match(warnings, /nothing left to speak/);
  assert.match(warnings, /\\ud83d\\ude00|\u{1F600}/u);
});

test("a streamed answer is spoken sentence by sentence, in order", async () => {
  mode = "ok";
  const answer = "Sure, here is the forecast. Tomorrow looks clear and cool. Expect light wind. Anything else?";
  const sentences = ["Sure,", "here is the forecast.", "Tomorrow looks clear and cool.", "Expect light wind.", "Anything else?"];
  const playsBefore = soxLogLines().filter((line) => line.startsWith("PLAY")).length;
  const responder = new StreamResponser(piperHttpTTS);
  for (let i = 0; i < answer.length; i += 15) {
    responder.partial(answer.slice(i, i + 15));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  responder.endPartial();
  await responder.getPlayEndPromise();
  const played = soxLogLines()
    .filter((line) => line.startsWith("PLAY"))
    .slice(playsBefore)
    .map((line) => line.split(" ")[1]);
  assert.deepEqual(played, sentences.map((sentence) => wavHashByText.get(sentence)));
});
