import { purifyTextForTTS, splitSentences } from "../utils";
import dotenv from "dotenv";
import { playAudioData, stopPlaying } from "../device/audio";
import { TTSResult } from "../type";

dotenv.config();

type TTSFunc = (text: string) => Promise<TTSResult>;
type SentencesCallback = (sentences: string[]) => void;
type TextCallback = (text: string) => void;
// Fired when a sentence's audio starts, with its position in the display text
// (sentences joined by spaces). durationMs is 0 when the sentence has no audio
// (TTS or playback failed), so its text can be shown at once.
type SentencePlayCallback = (payload: {
  charStart: number;
  charEnd: number;
  durationMs: number;
  sentenceIndex: number;
  sentence: string;
}) => void;

export class StreamResponser {
  private ttsFunc: TTSFunc;
  private sentencesCallback?: SentencesCallback;
  private textCallback?: TextCallback;
  private sentencePlayCallback?: SentencePlayCallback;
  private partialContent: string = "";
  private playEndResolve: () => void = () => {};
  private speakQueue: {
    sentenceIndex: number;
    sentence: string;
    ttsPromise: Promise<TTSResult>;
  }[] = [];
  private parsedSentences: string[] = [];
  private displaySentences: string[] = [];
  private isPlaying: boolean = false;
  // True from the first partial() until endPartial()/stop(): the answer is still
  // being generated, so an empty audio queue is a pause, not the end of playback.
  private streamOpen: boolean = false;
  private ttsChain: Promise<void> = Promise.resolve();
  private hasStartedTTS: boolean = false;
  private firstTTSPromise: Promise<TTSResult> | null = null;
  private activeTTSCount = 0;
  private pendingTTSQueue: {
    text: string;
    resolve: (result: TTSResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private readonly maxConcurrentTTS = Math.max(
    1,
    parseInt(process.env.TTS_CONCURRENCY_LIMIT || "5", 10) || 5,
  );

  constructor(
    ttsFunc: TTSFunc,
    sentencesCallback?: SentencesCallback,
    textCallback?: TextCallback,
    sentencePlayCallback?: SentencePlayCallback
  ) {
    this.ttsFunc = async (text) => {
      console.time("[TTS time]");
      try {
        return await this.synthesizeWithRetry(ttsFunc, text);
      } finally {
        console.timeEnd("[TTS time]");
      }
    };
    this.sentencesCallback = sentencesCallback;
    this.textCallback = textCallback;
    this.sentencePlayCallback = sentencePlayCallback;
  }

  private getCharStartForSentence(sentenceIndex: number): number {
    return sentenceIndex > 0 ? this.getCharEndForSentence(sentenceIndex - 1) + 1 : 0;
  }

  private getCharEndForSentence(sentenceIndex: number): number {
    if (sentenceIndex < 0 || sentenceIndex >= this.displaySentences.length) {
      return 0;
    }
    return this.displaySentences.slice(0, sentenceIndex + 1).join(" ").length;
  }

  private synthesizeWithRetry = async (
    ttsFunc: TTSFunc,
    text: string,
  ): Promise<TTSResult> => {
    const maxEmptyRetries = Math.max(
      0,
      parseInt(process.env.TTS_EMPTY_RETRY_COUNT || "1", 10) || 0,
    );
    let lastResult: TTSResult = { duration: 0 };

    for (let attempt = 0; attempt <= maxEmptyRetries; attempt++) {
      lastResult = await ttsFunc(text);
      if (this.hasPlayableAudio(lastResult)) {
        return lastResult;
      }
      if (attempt < maxEmptyRetries) {
        console.warn(
          `[TTS] Empty audio result, retrying (${attempt + 1}/${maxEmptyRetries})...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    return lastResult;
  };

  private hasPlayableAudio = (result: TTSResult): boolean => {
    return !!(
      result &&
      result.duration > 0 &&
      (result.filePath || result.base64 || result.buffer)
    );
  };

  private isPlaybackIdle = (): boolean =>
    !this.isPlaying &&
    this.speakQueue.length === 0 &&
    !this.partialContent &&
    this.activeTTSCount === 0 &&
    this.pendingTTSQueue.length === 0;

  private playAudioInOrder = async (): Promise<void> => {
    // Prevent multiple concurrent calls
    if (this.isPlaying) {
      console.log(
        "Audio playback already in progress, skipping duplicate call"
      );
      return;
    }
    let currentIndex = 0;
    const playNext = async () => {
      if (currentIndex < this.speakQueue.length) {
        this.isPlaying = true;
        const item = this.speakQueue[currentIndex];
        const announce = (durationMs: number) =>
          this.sentencePlayCallback?.({
            charStart: this.getCharStartForSentence(item.sentenceIndex),
            charEnd: this.getCharEndForSentence(item.sentenceIndex),
            durationMs,
            sentenceIndex: item.sentenceIndex,
            sentence: item.sentence,
          });
        try {
          const playParams = await item.ttsPromise;
          console.log(
            `Playing audio ${currentIndex + 1}/${this.speakQueue.length}`
          );
          announce(this.hasPlayableAudio(playParams) ? playParams.duration : 0);
          await playAudioData(playParams);
        } catch (error) {
          console.error("Audio playback error:", error);
          // Without audio the sentence's text is shown at once.
          announce(0);
        }
        currentIndex++;
        playNext();
      } else if (this.partialContent || this.streamOpen) {
        // More text is coming (e.g. after a tool call). Finishing here would
        // restart the sentence positions and the screen text mid-answer.
        await new Promise((resolve) => setTimeout(resolve, this.partialContent ? 1000 : 100));
        playNext();
      } else {
        console.log(
          `Play all audio completed. Total: ${this.speakQueue.length}`
        );
        this.isPlaying = false;
        this.playEndResolve();
        this.speakQueue.length = 0;
        this.speakQueue = [];
        this.displaySentences.length = 0;
        this.hasStartedTTS = false;
        this.firstTTSPromise = null;
        this.pendingTTSQueue.length = 0;
      }
    };
    playNext();
  };

  private enqueueTTS = (text: string): Promise<TTSResult> => {
    if (!this.hasStartedTTS) {
      this.hasStartedTTS = true;
      const task = this.ttsChain.then(() => this.ttsFunc(text));
      this.ttsChain = task.then(
        () => undefined,
        () => undefined,
      );
      this.firstTTSPromise = task;
      return task;
    }

    return (this.firstTTSPromise || Promise.resolve({ duration: 0 })).then(
      () => this.enqueueLimitedTTS(text),
      () => this.enqueueLimitedTTS(text),
    );
  };

  private enqueueLimitedTTS = (text: string): Promise<TTSResult> => {
    return new Promise((resolve, reject) => {
      this.pendingTTSQueue.push({ text, resolve, reject });
      this.pumpTTSQueue();
    });
  };

  private pumpTTSQueue = (): void => {
    while (
      this.activeTTSCount < this.maxConcurrentTTS &&
      this.pendingTTSQueue.length > 0
    ) {
      const item = this.pendingTTSQueue.shift();
      if (!item) {
        return;
      }
      this.activeTTSCount++;
      this.ttsFunc(item.text)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeTTSCount = Math.max(0, this.activeTTSCount - 1);
          this.pumpTTSQueue();
        });
    }
  };

  partial = (text: string): void => {
    this.streamOpen = true;
    this.partialContent += text;
    // replace newlines with spaces
    this.partialContent = this.partialContent.replace(/\n/g, " ");
    const { sentences, remaining } = splitSentences(this.partialContent);
    if (sentences.length > 0) {
      this.parsedSentences.push(...sentences);
      const startIndex = this.displaySentences.length;
      // Display text is the sentences joined by single spaces; positions in the
      // sentence-play event refer to it.
      this.displaySentences.push(...sentences.map((sentence) => sentence.trim()));
      this.sentencesCallback?.(this.displaySentences);
      // remove emoji
      const length = this.speakQueue.length;
      const queueItems: {
        sentenceIndex: number;
        sentence: string;
        ttsPromise: Promise<TTSResult>;
      }[] = [];
      sentences.forEach((sentence, index) => {
        const purified = purifyTextForTTS(sentence);
        if (!purified) {
          // TEMPORARY (Phase 0 TTS diagnostics)
          console.warn("[TTS-DIAG] nothing left to speak after purifyTextForTTS:", JSON.stringify(sentence));
          return;
        }
        const ttsPromise = this.enqueueTTS(purified);
        queueItems.push({
          sentenceIndex: startIndex + index,
          sentence: this.displaySentences[startIndex + index],
          ttsPromise,
        });
      });
      if (queueItems.length > 0) {
        this.speakQueue.push(...queueItems);
        if (length === 0 && !this.isPlaying) {
          this.playAudioInOrder();
        }
      }
    }
    this.partialContent = remaining;
  };

  endPartial = (): void => {
    this.streamOpen = false;
    if (this.partialContent.trim()) {
      this.parsedSentences.push(this.partialContent);
      this.displaySentences.push(this.partialContent.trim());
      this.sentencesCallback?.(this.displaySentences);
      const text = purifyTextForTTS(this.partialContent);
      if (!text) {
        // TEMPORARY (Phase 0 TTS diagnostics)
        console.warn("[TTS-DIAG] nothing left to speak after purifyTextForTTS:", JSON.stringify(this.partialContent));
      }
      if (text) {
        const length = this.speakQueue.length;
        this.speakQueue.push({
          sentenceIndex: this.displaySentences.length - 1,
          sentence: this.displaySentences[this.displaySentences.length - 1],
          ttsPromise: this.enqueueTTS(text),
        });
        if (length === 0 && !this.isPlaying) {
          this.playAudioInOrder();
        }
      }
    }
    this.partialContent = "";
    this.textCallback?.(this.displaySentences.join(" "));
    this.parsedSentences.length = 0;
  };

  getPlayEndPromise = (): Promise<void> => {
    return new Promise((resolve) => {
      if (this.isPlaybackIdle()) {
        resolve();
        return;
      }
      this.playEndResolve = resolve;
    });
  };

  stop = (): void => {
    this.streamOpen = false;
    this.speakQueue = [];
    this.speakQueue.length = 0;
    this.partialContent = "";
    this.parsedSentences.length = 0;
    this.displaySentences.length = 0;
    this.isPlaying = false;
    this.ttsChain = Promise.resolve();
    this.hasStartedTTS = false;
    this.firstTTSPromise = null;
    this.activeTTSCount = 0;
    this.pendingTTSQueue.length = 0;
    this.playEndResolve();
    stopPlaying();
  };
}
