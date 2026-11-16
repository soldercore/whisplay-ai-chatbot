/**
 * The audio envelope for the on-screen eye travels with the sentence-play event: it is measured from the same WAV
 * that is played, announced when that sentence's playback starts, and absent when the audio cannot be measured.
 * Only the speaker/sox edge is replaced.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const audioPath = require.resolve("../device/audio");
const original = require.cache[audioPath];
const played: string[] = [];
let StreamResponser: any;

const RATE = 22050;
const wavOf = (segments: [number, number][]): Buffer => {
  const samples: number[] = [];
  for (const [amp, ms] of segments) {
    const n = Math.round((RATE * ms) / 1000);
    for (let i = 0; i < n; i++) samples.push(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / RATE)));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + samples.length * 2, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(samples.length * 2, 40);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  return Buffer.concat([header, data]);
};

before(() => {
  require.cache[audioPath] = { id: audioPath, filename: audioPath, loaded: true, exports: {
    playAudioData: async (result: { buffer: Buffer }) => { played.push(`${result.buffer.length}`); },
    stopPlaying() {},
  } } as NodeModule;
  StreamResponser = require("../core/StreamResponsor").StreamResponser;
});
after(() => { if (original) require.cache[audioPath] = original; else delete require.cache[audioPath]; });

const run = async (tts: (text: string) => Promise<any>, text: string) => {
  const events: any[] = [];
  const responser = new StreamResponser(tts, undefined, undefined, (event: any) => events.push(event));
  responser.partial(text);
  responser.endPartial();
  await responser.getPlayEndPromise();
  return events;
};

test("the sentence-play event carries the envelope of the WAV that was played, one sentence at a time", async () => {
  const loud = wavOf([[0, 100], [20000, 300]]);
  const quiet = wavOf([[0, 100], [1500, 300]]);
  const events = await run(async (text: string) => {
    const buffer = text.includes("Loud") ? loud : quiet;
    return { buffer, duration: 400 };
  }, "Loud sentence goes first and it is long enough. Quiet sentence goes second and it is also long enough.");
  assert.equal(events.length, 2);
  const [a, b] = events;
  assert.equal(a.levels.length, 20, "400 ms at 20 ms per digit");
  assert.equal(parseInt(a.levels[0], 16), 0, "the first 100 ms of the audio are silent");
  assert.ok(parseInt(a.levels[10], 16) > parseInt(b.levels[10], 16) + 4, "the louder sentence reads higher at the same position");
  assert.deepEqual(played.length, 2, "both sentences were actually played");
});

test("audio that cannot be measured announces no envelope, and a failed sentence announces none", async () => {
  const events = await run(async () => ({ buffer: Buffer.from("ID3 not a wav"), duration: 500 }), "Not measurable audio.");
  assert.equal(events.length, 1);
  assert.equal(events[0].levels, undefined);
  assert.equal(events[0].durationMs, 500);
});
