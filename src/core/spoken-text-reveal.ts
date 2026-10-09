/**
 * How much of the answer text the screen may show, following the voice.
 *
 * The LLM streams text long before Piper has spoken it. The screen now shows a
 * sentence only when its audio starts (StreamResponser's sentence-play event)
 * and reveals it over that sentence's real audio duration. With a reveal plan
 * (speech-timing.ts: whole words over the measured speaking time, punctuation
 * aligned with the pauses in the audio) the words follow that plan; without
 * one the pace is linear over the duration. Piper reports no word timings:
 * sentence start, speech start/end and pauses are measured, word positions in
 * between are estimates.
 *
 * Sentences without audio (TTS failed, nothing speakable, no TTS available) are
 * revealed at once when their turn comes, so text is never lost.
 */
import { RevealStep } from "./speech-timing";

export class SpokenTextReveal {
  private revealedChars = 0;
  private timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly tickMs = 120,
  ) {}

  /** Characters of the display text that may be shown. */
  get revealed(): number {
    return this.revealedChars;
  }

  /**
   * A sentence's audio starts: reveal [charStart, charEnd) over durationMs, or
   * by `plan` (steps relative to charStart, ms from the audio start).
   */
  sentenceStarted(charStart: number, charEnd: number, durationMs: number, plan?: RevealStep[]): void {
    this.stopTimer();
    const from = Math.max(this.revealedChars, charStart);
    if (!(durationMs > 0) || charEnd <= from) {
      this.set(charEnd);
      return;
    }
    if (plan && plan.length > 0) {
      this.followPlan(charStart, charEnd, plan);
      return;
    }
    const startedAt = Date.now();
    this.set(from);
    this.timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      this.set(from + Math.round((charEnd - from) * progress));
      if (progress >= 1) this.stopTimer();
    }, this.tickMs);
  }

  private followPlan(charStart: number, charEnd: number, plan: RevealStep[]): void {
    const startedAt = Date.now();
    let next = 0;
    const step = () => {
      this.timer = null;
      const elapsed = Date.now() - startedAt;
      while (next < plan.length && plan[next].atMs <= elapsed) {
        this.set(Math.min(charEnd, charStart + plan[next].chars));
        next++;
      }
      if (next < plan.length) this.timer = setTimeout(step, Math.max(0, plan[next].atMs - elapsed));
    };
    step();
  }

  /** Playback finished (or there is no audio at all): show everything. */
  revealAll(): void {
    this.stopTimer();
    this.set(Number.MAX_SAFE_INTEGER);
  }

  /** A new answer starts or the answer was interrupted. */
  reset(): void {
    this.stopTimer();
    this.revealedChars = 0;
  }

  private set(chars: number): void {
    if (chars <= this.revealedChars) return;
    this.revealedChars = chars;
    this.onChange();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer as ReturnType<typeof setInterval>);
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
      this.timer = null;
    }
  }
}
