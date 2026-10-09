/**
 * Where the speech is inside one sentence's audio, and when each word of the
 * sentence should appear on screen.
 *
 * Piper reports no word timings. What the audio itself shows reliably is when
 * speech starts and ends (Piper pads every sentence with 40-230 ms of
 * silence) and where it pauses (100-500 ms at most commas, colons and full
 * stops). speechTimingFromWav() measures that from the PCM samples. The reveal
 * plan spreads the words over the speaking time only, aligns punctuation with
 * the pauses it can match, and reveals whole words (a partly shown word is held
 * back by the renderer). Word positions between two anchors are an even spread
 * by characters: an estimate, not a word timestamp.
 */

export type SpeechTiming = {
  speechStartMs: number;
  speechEndMs: number;
  pauses: [number, number][]; // [start, end] of silences inside the speech
};

export type RevealStep = { atMs: number; chars: number };

const FRAME_MS = 10;
const MIN_PAUSE_MS = 120;

/** Speech start/end and pauses of a 16-bit PCM WAV; undefined for anything else. */
export const speechTimingFromWav = (wav: Buffer): SpeechTiming | undefined => {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let offset = 12;
  let data: Buffer | undefined;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = wav.subarray(body, Math.min(wav.length, body + size));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!data || bits !== 16 || channels < 1 || rate < 1000) return undefined;

  const samplesPerFrame = Math.max(1, Math.round((rate * FRAME_MS) / 1000)) * channels;
  const frames = Math.floor(data.length / 2 / samplesPerFrame);
  if (frames < 1) return undefined;
  const rms: number[] = [];
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < samplesPerFrame; i++) {
      const s = data.readInt16LE((f * samplesPerFrame + i) * 2);
      sum += s * s;
    }
    const value = Math.sqrt(sum / samplesPerFrame);
    rms.push(value);
    peak = Math.max(peak, value);
  }
  const threshold = Math.max(300, peak * 0.05);
  const voiced = rms.map((value) => value > threshold);
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first < 0) return undefined;

  const pauses: [number, number][] = [];
  let run = 0;
  for (let f = first; f <= last; f++) {
    if (!voiced[f]) {
      run++;
      continue;
    }
    if (run * FRAME_MS >= MIN_PAUSE_MS) pauses.push([(f - run) * FRAME_MS, f * FRAME_MS]);
    run = 0;
  }
  return { speechStartMs: first * FRAME_MS, speechEndMs: (last + 1) * FRAME_MS, pauses };
};

type Word = { start: number; end: number; weight: number; punctuated: boolean };

// A CJK character is a word of its own (no spaces between words), with any
// full-width punctuation after it; anything else splits at whitespace.
const WORD_RE =
  /[⺀-⿿぀-鿿가-힯豈-﫿][　-〿＀-￯"'”’)]*|[^\s⺀-⿿぀-鿿가-힯豈-﫿]+/g;

const wordsOf = (text: string): Word[] => {
  const words: Word[] = [];
  let match: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((match = WORD_RE.exec(text))) {
    const token = match[0];
    const after = match.index + token.length;
    words.push({
      start: match.index,
      // Reveal the following space too: a word that ends the visible text is held back by the renderer.
      end: after < text.length && /\s/.test(text[after]) ? after + 1 : after,
      weight: Math.max(1, token.replace(/[^\p{L}\p{N}]/gu, "").length),
      punctuated: /[,;:.!?…—–)，。！？；：、）]["'”’)\]」』]*$/.test(token),
    });
  }
  return words;
};

/**
 * When each word of a sentence appears, in ms from the start of its audio.
 * Without timing the words are spread over the whole duration, each appearing
 * when its end is due.
 */
export const revealPlan = (text: string, durationMs: number, timing?: SpeechTiming): RevealStep[] => {
  const words = wordsOf(text);
  if (words.length === 0 || !(durationMs > 0)) return [{ atMs: 0, chars: text.length }];
  const speechStart = timing ? Math.max(0, timing.speechStartMs) : 0;
  const speechEnd = timing ? Math.min(durationMs, Math.max(speechStart + 1, timing.speechEndMs)) : durationMs;
  const pauses = (timing?.pauses || []).filter(([a, b]) => a >= speechStart && b <= speechEnd && b > a);

  // Cumulative weight before each word, and the weight up to each punctuation boundary.
  const total = words.reduce((sum, word) => sum + word.weight, 0);
  const before: number[] = [];
  let acc = 0;
  for (const word of words) {
    before.push(acc);
    acc += word.weight;
  }

  // Anchors (time, weight): speech start, matched pauses, speech end. A pause is
  // matched to the punctuation boundary whose even-spread time is closest.
  const spoken = speechEnd - speechStart - pauses.reduce((sum, [a, b]) => sum + (b - a), 0);
  const evenTime = (weight: number): number => {
    // Time at which `weight` is reached when spreading over speaking time, skipping pauses.
    let t = speechStart + (weight / total) * Math.max(1, spoken);
    for (const [a, b] of pauses) if (t >= a) t += b - a;
    return t;
  };
  const anchors: { time: number; weight: number }[] = [{ time: speechStart, weight: 0 }];
  const unmatched: [number, number][] = [];
  let nextWord = 0;
  for (const [a, b] of pauses) {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = nextWord; i < words.length - 1; i++) {
      if (!words[i].punctuated) continue;
      const distance = Math.abs(evenTime(before[i] + words[i].weight) - a);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    }
    // Only a nearby boundary: a pause in the middle of a phrase stays unmatched.
    if (best >= 0 && bestDistance <= Math.max(400, 0.25 * spoken)) {
      const weight = before[best] + words[best].weight;
      anchors.push({ time: a, weight }, { time: b, weight });
      nextWord = best + 1;
    } else {
      unmatched.push([a, b]);
    }
  }
  anchors.push({ time: speechEnd, weight: total });

  // Between two anchors: linear in weight over the speaking time, so the text
  // also stands still during an unmatched pause. A word appears when its first
  // sound is due.
  const timeForWeight = (weight: number): number => {
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1];
      const b = anchors[i];
      if (weight < b.weight || i === anchors.length - 1) {
        if (b.weight === a.weight) return a.time;
        const inside = unmatched.filter(([p, q]) => p >= a.time && q <= b.time);
        const speaking = b.time - a.time - inside.reduce((sum, [p, q]) => sum + (q - p), 0);
        let t = a.time + ((weight - a.weight) / (b.weight - a.weight)) * Math.max(1, speaking);
        for (const [p, q] of inside) if (t >= p) t += q - p;
        return Math.min(b.time, t);
      }
    }
    return speechEnd;
  };
  // Without measured timing (e.g. MP3 audio) the pauses are unknown, so a word
  // appears only when the even spread reaches its end: it may lag, never lead.
  const due = (i: number): number => (timing ? before[i] : before[i] + words[i].weight);
  return words.map((word, i) => ({
    atMs: Math.round(Math.min(speechEnd, timeForWeight(due(i)))),
    chars: i === words.length - 1 ? text.length : word.end,
  }));
};
