/**
 * recordAudio's time limit: with a speech limit the duration is only the WAITING window. Speech that starts inside the window is not
 * cut at its end; silence still ends it; without the option the old hard limit applies. SoX is replaced by a small script that
 * writes the recording file the way the real recorder does: nothing until sound starts, then audio until it ends.
 */
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "child_process";

const SCRIPT = `
const fs = require("fs");
const args = process.argv.slice(1);
const out = args[args.indexOf("-r") + 2];
const [start, speech] = (process.env.FAKE_REC_PLAN || "0,0").split(",").map(Number);
fs.writeFileSync(out, Buffer.alloc(44));          // the header exists from the start, as with SoX
setTimeout(() => {
  const timer = setInterval(() => fs.appendFileSync(out, Buffer.alloc(2048)), 50);
  setTimeout(() => { clearInterval(timer); process.exit(0); }, speech);
}, start);
`;
let plan = "0,0";
const realSpawn = childProcess.spawn;
(childProcess as any).spawn = (command: string, args: string[] = [], options: any = {}) =>
  command === "sox" && args[0] === "-t" && args[1] === "alsa"
    ? realSpawn(process.execPath, ["-e", SCRIPT, "--", ...args], { ...options, env: { ...process.env, FAKE_REC_PLAN: plan } })
    : realSpawn(command, args, options);

let recordAudio: (file: string, seconds: number, level: number, speechLimitSec?: number) => Promise<string>;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whisplay-rec-"));

before(() => {
  Object.assign(process.env, { TTS_SERVER: "test", ASR_SERVER: "test", LLM_SERVER: "test", WEB_AUDIO_ENABLED: "false", ALSA_INPUT_DEVICE: "capture" });
  recordAudio = require("../device/audio").recordAudio;
});

const size = (file: string): number => fs.statSync(file).size;
const run = async (startMs: number, speechMs: number, waitSec: number, limit?: number) => {
  plan = `${startMs},${speechMs}`;
  const file = path.join(tmp, `rec-${Date.now()}-${Math.random()}.wav`);
  const began = Date.now();
  await recordAudio(file, waitSec, 30, limit);
  return { bytes: size(file), ms: Date.now() - began };
};

test("speech that starts inside the waiting window is not cut at its end", { skip: process.platform === "win32" }, async () => {
  const withLimit = await run(300, 1500, 1, 5);          // starts at 0.3 s, lasts 1.5 s, the window is 1 s
  assert.ok(withLimit.bytes > 44 + 2048 * 25, `the whole 1.5 s of speech was kept (${withLimit.bytes} bytes)`);
  assert.ok(withLimit.ms >= 1700 && withLimit.ms < 3500, `it ended when the speech ended (${withLimit.ms} ms)`);
  const old = await run(300, 1500, 1);                    // no speech limit: the old hard limit
  assert.ok(old.bytes < withLimit.bytes && old.ms < 1500, `without the option it is still cut at the window (${old.ms} ms)`);
});

test("silence still waits only for the window, and a very long speech is bounded by the speech limit", { skip: process.platform === "win32" }, async () => {
  const quiet = await run(5000, 1000, 1, 5);              // nothing is said inside the window
  assert.ok(quiet.ms < 1600 && quiet.bytes <= 44, `no speech: the recording ends at the window (${quiet.ms} ms)`);
  const long = await run(200, 20000, 1, 2);               // speech longer than window + limit
  assert.ok(long.ms >= 2800 && long.ms < 4500, `the speech limit ends it, not the window (${long.ms} ms)`);
});
