#!/usr/bin/env node
// Test double for the two SoX invocations on the TTS path:
//   conversion: sox -v 0.9 <in.wav> -r 48000 -c 2 -b 16 <out.wav>
//   playback:   sox -q <file> -t alsa <device>
// Conversion copies the WAV unchanged; playback "plays" it by sleeping for its
// duration and appends "PLAY <fnv1a-hash> <ms> <device>" to $FAKE_SOX_LOG.
const fs = require("fs");

const args = process.argv.slice(2);
const valueOptions = new Set(["-t", "-v", "-r", "-c", "-b", "-e"]);
const positionals = [];
for (let i = 0; i < args.length; i++) {
  if (valueOptions.has(args[i])) {
    i++;
    continue;
  }
  if (args[i].startsWith("-") && args[i] !== "-") continue;
  positionals.push(args[i]);
}
const isPlayback = args.some((arg, i) => arg === "-t" && args[i + 1] === "alsa");

const log = (line) => {
  if (process.env.FAKE_SOX_LOG) fs.appendFileSync(process.env.FAKE_SOX_LOG, `${line}\n`);
};

const fnv1a = (buffer) => {
  let hash = 0x811c9dc5;
  for (const byte of buffer) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const readWav = (file) => {
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (error) {
    process.stderr.write(`sox FAIL formats: can't open input file \`${file}': No such file or directory\n`);
    process.exit(2);
  }
  if (data.length < 12 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
    process.stderr.write(`sox FAIL formats: can't open input file \`${file}': WAVE: RIFF header not found\n`);
    process.exit(2);
  }
  return data;
};

const durationMs = (wav) => {
  const byteRate = wav.readUInt32LE(28);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return Math.round((Math.min(size, wav.length - offset - 8) * 1000) / byteRate);
    offset += 8 + size;
  }
  return 0;
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (isPlayback) {
  const [file, device] = positionals;
  if (process.env.FAKE_SOX_PLAY_FAIL === "1") {
    process.stderr.write(`sox FAIL sox: \`${device}': cannot open audio device\n`);
    process.exit(1);
  }
  const wav = readWav(file);
  const ms = durationMs(wav);
  log(`PLAY ${fnv1a(wav)} ${ms} ${device}`);
  sleep(ms * Number(process.env.FAKE_SOX_PLAY_SCALE || "1"));
  process.exit(0);
} else {
  const [input, output] = positionals;
  const wav = readWav(input);
  sleep(Number(process.env.FAKE_SOX_CONVERT_MS || "30"));
  fs.writeFileSync(output, wav);
  log(`CONVERT ${fnv1a(wav)} ${output}`);
  process.exit(0);
}
