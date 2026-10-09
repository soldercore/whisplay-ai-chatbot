/**
 * How much of the answer text the screen may show, following the voice.
 *
 * The LLM streams text long before Piper has spoken it. The screen now shows a
 * sentence only when its audio starts (StreamResponser's sentence-play event)
 * and reveals it over that sentence's real audio duration. Within a sentence
 * the pace is linear: Piper reports no word timings, so the sentence start and
 * end are exact (up to the audio output latency) and the words in between are
 * an even spread of the measured duration, not word-level timing.
 *
 * Sentences without audio (TTS failed, nothing speakable, no TTS available) are
 * revealed at once when their turn comes, so text is never lost.
 */
export class SpokenTextReveal {
  private revealedChars = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: () => void,
    private readonly tickMs = 120,
  ) {}

  /** Characters of the display text that may be shown. */
  get revealed(): number {
    return this.revealedChars;
  }

  /** A sentence's audio starts: reveal [charStart, charEnd) over durationMs. */
  sentenceStarted(charStart: number, charEnd: number, durationMs: number): void {
    this.stopTimer();
    const from = Math.max(this.revealedChars, charStart);
    if (!(durationMs > 0) || charEnd <= from) {
      this.set(charEnd);
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
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
