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
  private wanted = false;
  private restartPending = false;
  private generation = 0;

  start(): void {
    const enabled = (process.env.WAKE_WORD_ENABLED || "").toLowerCase();
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

    const scriptPath = resolve(__dirname, "../../python/wakeword.py");
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
        if (line.startsWith("WAKE") && !this.wakePending) {
          this.wakePending = true;
          // The wake-word process owns the capture device. Do not notify the
          // chat flow until it and its SoX child have released the microphone.
          const stopped = this.stop();
          const generation = this.generation;
          void stopped.then(() => {
            if (this.generation === generation && !appSignal.aborted) this.emit("wake", line);
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
      }
    });
    child.once("error", error => {
      console.error("[WakeWord] Process failed:", error);
      if (!child.pid && this.process === child) this.process = null;
    });
  }

  stop(): Promise<void> {
    this.wanted = false;
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
