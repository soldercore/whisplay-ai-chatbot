/**
 * Word pacing of the spoken answer text: speech measured from the WAV samples
 * (start, end, pauses) and the reveal plan built from it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { revealPlan, speechTimingFromWav, RevealStep } from "../core/speech-timing";
import { SpokenTextReveal } from "../core/spoken-text-reveal";

const RATE = 22050;

/** 16-bit mono WAV from [kind, ms] segments: "speech" is a loud tone, "silence" near-zero noise. */
const wav = (segments: ["speech" | "silence", number][], extraChunk = false): Buffer => {
  const samples: number[] = [];
  for (const [kind, ms] of segments) {
    const n = Math.round((RATE * ms) / 1000);
    for (let i = 0; i < n; i++) {
      samples.push(kind === "speech" ? Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / RATE)) : (i % 7) - 3);
    }
  }
  const list = extraChunk ? Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]) : Buffer.alloc(0);
  const header = Buffer.alloc(36);
  header.write("RIFF", 0);
  header.writeUInt32LE(28 + list.length + 8 + samples.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(samples.length * 2, 4);
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  return Buffer.concat([header, list, dataHeader, data]);
};

const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} not within ${tolerance} of ${expected}`);

/** When (ms) the plan first shows the text up to and including `word`. */
const shownAt = (plan: RevealStep[], text: string, word: string): number => {
  const end = text.indexOf(word) + word.length;
  const step = plan.find((s) => s.chars >= end);
  assert.ok(step, `"${word}" is revealed`);
  return step!.atMs;
};

test("speech start, end and pauses are measured from the WAV samples", () => {
  const timing = speechTimingFromWav(
    wav([["silence", 100], ["speech", 500], ["silence", 200], ["speech", 400], ["silence", 150]]),
  );
  assert.ok(timing);
  near(timing!.speechStartMs, 100, 10, "speech start");
  near(timing!.speechEndMs, 1200, 10, "speech end");
  assert.equal(timing!.pauses.length, 1);
  near(timing!.pauses[0][0], 600, 10, "pause start");
  near(timing!.pauses[0][1], 800, 10, "pause end");
});

test("short gaps are not pauses, and other chunks before the data are skipped", () => {
  const timing = speechTimingFromWav(wav([["speech", 300], ["silence", 60], ["speech", 300]], true));
  assert.ok(timing);
  near(timing!.speechStartMs, 0, 10, "speech start");
  assert.deepEqual(timing!.pauses, []);
});

test("anything that is not measurable 16-bit PCM gives no timing", () => {
  assert.equal(speechTimingFromWav(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00 not a wav at all, an mp3 body")), undefined);
  assert.equal(speechTimingFromWav(Buffer.alloc(10)), undefined);
  assert.equal(speechTimingFromWav(wav([["silence", 500]])), undefined, "only silence");
  const eightBit = wav([["speech", 300]]);
  eightBit.writeUInt16LE(8, 34);
  assert.equal(speechTimingFromWav(eightBit), undefined, "8-bit");
  const truncated = wav([["speech", 300]]).subarray(0, 50);
  assert.doesNotThrow(() => speechTimingFromWav(truncated));
});

test("the plan reveals whole words with their space, within the speech, ending on the full text", () => {
  const text = "Well done, test subject. You have passed the first chamber.";
  const timing = { speechStartMs: 120, speechEndMs: 2600, pauses: [] as [number, number][] };
  const plan = revealPlan(text, 2800, timing);
  assert.equal(plan.length, text.split(" ").length, "one step per word");
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (i < plan.length - 1) assert.equal(text[step.chars - 1], " ", `step ${i} ends after a space`);
    if (i > 0) {
      assert.ok(step.atMs >= plan[i - 1].atMs, "times never go back");
      assert.ok(step.chars > plan[i - 1].chars, "text only grows");
    }
    assert.ok(step.atMs >= 120 && step.atMs <= 2600, `step ${i} inside the speech (${step.atMs})`);
  }
  assert.equal(plan[0].atMs, 120, "the first word appears when speech starts, not with the leading silence");
  assert.equal(plan[plan.length - 1].chars, text.length, "the final word and its full stop are revealed");
  assert.ok(plan[plan.length - 1].atMs < 2600, "the final word appears while it is spoken");
});

test("words after a pause wait for it; the text stands still during the pause", () => {
  const text = "Well done, test subject. You have passed the first chamber.";
  // Pauses at the comma and at the full stop, as Piper GLaDOS speaks it.
  const pauses: [number, number][] = [[600, 800], [1500, 1900]];
  const plan = revealPlan(text, 3200, { speechStartMs: 100, speechEndMs: 3000, pauses });
  assert.ok(shownAt(plan, text, "done,") < 600, "the word before the comma pause is shown before it");
  assert.ok(shownAt(plan, text, "test") >= 800, "the word after the comma waits for the pause to end");
  assert.ok(shownAt(plan, text, "subject.") < 1500, "the sentence end is shown before its pause");
  assert.equal(shownAt(plan, text, "You"), 1900, "the next phrase starts when speech resumes");
  for (const step of plan) {
    for (const [a, b] of pauses) assert.ok(!(step.atMs > a && step.atMs < b), `nothing appears inside a pause (${step.atMs})`);
  }
});

test("a pause in the middle of a phrase is skipped, not matched to far punctuation", () => {
  const text = "Please proceed to the chamber lock, where you will be monitored.";
  const pause: [number, number] = [300, 450]; // early, far from the comma
  const plan = revealPlan(text, 2600, { speechStartMs: 50, speechEndMs: 2500, pauses: [pause] });
  for (const step of plan) assert.ok(!(step.atMs > pause[0] && step.atMs < pause[1]), "nothing appears inside it");
  assert.ok(shownAt(plan, text, "lock,") > 1000, "the comma is not pulled forward to the early pause");
});

test("without measured timing (e.g. MP3) a word appears only once its share of the time has passed", () => {
  const text = "Cake is a lie.";
  const plan = revealPlan(text, 1000);
  // Letter weights 4, 2, 1, 3 of 10: words end at 400, 600, 700 and 1000 ms.
  assert.deepEqual(plan.map((s) => s.atMs), [400, 600, 700, 1000]);
  assert.equal(plan[plan.length - 1].chars, text.length);
});

test("Chinese text is paced character by character", () => {
  const text = "你好，测试对象。";
  const plan = revealPlan(text, 1000, { speechStartMs: 0, speechEndMs: 1000, pauses: [] });
  assert.equal(plan.length, 6, "one step per character, punctuation attached");
  assert.equal(plan[1].chars, 3, "the comma comes with the character before it");
  assert.equal(plan[0].atMs, 0);
  assert.ok(plan[5].atMs < 1000 && plan[5].chars === text.length);
});

test("nothing speakable or no duration reveals the sentence at once", () => {
  assert.deepEqual(revealPlan("...", 0), [{ atMs: 0, chars: 3 }]);
  assert.deepEqual(revealPlan("   ", 500), [{ atMs: 0, chars: 3 }]);
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("SpokenTextReveal follows a plan, capped at the sentence, and stops on reset", async () => {
  const reveal = new SpokenTextReveal(() => {}, 5);
  reveal.sentenceStarted(10, 30, 300, [
    { atMs: 0, chars: 6 },
    { atMs: 60, chars: 12 },
    { atMs: 120, chars: 40 }, // beyond the sentence: capped
  ]);
  assert.equal(reveal.revealed, 16, "the first word at once");
  await wait(30);
  assert.equal(reveal.revealed, 16, "the second word is not shown early");
  await wait(60);
  assert.equal(reveal.revealed, 22);
  await wait(60);
  assert.equal(reveal.revealed, 30, "capped at the sentence end");

  reveal.reset();
  reveal.sentenceStarted(0, 20, 300, [{ atMs: 0, chars: 5 }, { atMs: 40, chars: 20 }]);
  reveal.reset();
  await wait(80);
  assert.equal(reveal.revealed, 0, "an interrupted answer reveals nothing more");

  reveal.sentenceStarted(0, 20, 300, [{ atMs: 0, chars: 5 }, { atMs: 200, chars: 20 }]);
  reveal.revealAll();
  assert.equal(reveal.revealed, Number.MAX_SAFE_INTEGER, "playback end shows everything");
  reveal.reset();
});
