import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import { appSignal, spawnOwned as spawn, stopOwnedChild } from "../utils/app-lifecycle";
import { resolve } from "path";
import dotenv from "dotenv";
dotenv.config();

const pythonBinary = process.env.WAKE_WORD_PYTHON_PATH || "python3";

export class WakeWordListener extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: string = "";
  private stopping: Promise<void> | null = null;
  private wakePending: boolean = false;
  private pendingSpeechEnd: { at: number; agoMs: number } | undefined;   // from the wake script's own last loud frame
  private wanted = false;
  private restartPending = false;
  private generation = 0;

  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly capri = false) { super(); }

  start(): void {
    const enabled = (this.capri ? process.env.CAPRI_WAKE_WORD_ENABLED : process.env.WAKE_WORD_ENABLED)?.toLowerCase();
    if (enabled !== "true" || appSignal.aborted) return;
    this.wanted = true;
    this.generation++;

    if (this.stopping) {
      if (!this.restartPending) {
        this.restartPending = true;
        void this.stopping.then(() => {
          this.restartPending = false;
          if (this.wanted && !appSignal.aborted) this.start();
        }, () => { this.restartPending = false; });
      }
      return;
    }
    if (this.process) return;

    const scriptPath = resolve(__dirname, this.capri ? "../../python/capri_wake.py" : "../../python/wakeword.py");
    const child = spawn(pythonBinary, [scriptPath], {
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.buffer = "";
    this.wakePending = false;

    child.stdout?.on("data", (data: Buffer) => {
      if (this.process !== child || appSignal.aborted) return;
      this.buffer += data.toString();
      let newlineIndex = this.buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (this.capri && line === "CAPRI_READY") {
          this.emit("ready");   // the passive listener is running; it is not recording a command
        } else if (this.capri && line === "CAPRI_AUDIO") {
          if (this.wanted) this.emit("audio");   // sound passed the start level in the active command capture
        } else if (this.capri && line === "CAPRI_PROCESSING") {
          if (this.wanted) this.emit("processing");   // the command capture ended; transcription follows
        } else if (this.capri && line.startsWith("CAPRI_TIMING ")) {
          const agoMs = Number(line.slice("CAPRI_TIMING ".length));
          this.pendingSpeechEnd = Number.isFinite(agoMs) && agoMs >= 0 && agoMs < 60_000 ? { at: performance.now(), agoMs } : undefined;
        } else if (this.capri && (line === "CAPRI_LISTENING" || line === "CAPRI_IDLE")) {
          if (this.wanted) this.emit(line === "CAPRI_LISTENING" ? "listening" : "idle");
        } else if ((this.capri ? line.startsWith("CAPRI_COMMAND ") : line.startsWith("WAKE")) && !this.wakePending) {
          this.wakePending = true;
          // The wake-word process owns the capture device. Do not notify the
          // chat flow until it and its SoX child have released the microphone.
          const stopped = this.stop();
          const speechEndAt = this.pendingSpeechEnd ? this.pendingSpeechEnd.at - this.pendingSpeechEnd.agoMs : undefined;
          this.pendingSpeechEnd = undefined;
          const generation = this.generation;
          void stopped.then(() => {
            if (this.generation !== generation || appSignal.aborted) return;
            if (!this.capri) {
              this.emit("wake", line);
              return;
            }
            const command: unknown = JSON.parse(line.slice("CAPRI_COMMAND ".length));
            if (typeof command === "string" && command.trim()) this.emit("command", command.trim(), speechEndAt);
          }).catch(error => console.error("[WakeWord] Microphone release failed:", error));
        } else if (line) {
          console.log(`[WakeWord] ${line}`);
        }
        newlineIndex = this.buffer.indexOf("\n");
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        console.error(`[WakeWord] ${message}`);
      }
    });

    child.on("close", (code) => {
      console.log(`[WakeWord] process exited with code ${code}`);
      if (this.process === child) {
        this.process = null;
        if (this.capri && this.wanted && !appSignal.aborted) {
          this.emit("unavailable");
          this.emit("idle");
          this.retry = setTimeout(() => {
            this.retry = undefined;
            if (this.wanted && !appSignal.aborted) this.start();
          }, 1500);
        }
      }
    });
    child.once("error", error => {
      console.error("[WakeWord] Process failed:", error);
      if (!child.pid && this.process === child) this.process = null;
    });
  }

  stop(): Promise<void> {
    this.wanted = false;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    this.generation++;
    if (this.stopping) return this.stopping;
    const child = this.process;
    if (!child) return Promise.resolve();

    // Share the custom application's ownership boundary: wait for confirmed
    // exit, and terminate only our own Python/SoX process group. Never report
    // release merely because a kill timer or an error event fired.
    this.stopping = stopOwnedChild(child).then(() => {
      if (this.process === child) {
        this.process = null;
      }
    }).finally(() => { this.stopping = null; });
    return this.stopping;
  }
}
