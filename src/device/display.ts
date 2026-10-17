import { exec } from "child_process";
import { spawnOwned, stopOwnedChild, onAppShutdown, shutdownApplication, appSignal } from "../utils/app-lifecycle";
import { existsSync } from "fs";
import { resolve } from "path";
import { Socket } from "net";
import { getCurrentTimeTag } from "../utils";
import { WebDisplayServer } from "./web-display";
import { webAudioBridge } from "./web-audio-bridge";
import dotEnv from "dotenv";

dotEnv.config();

const DOUBLE_CLICK_WINDOW_MS = 800;
const DOUBLE_CLICK_MAX_PRESS_MS = 350;

export interface Status {
  status: string;
  emoji: string;
  text: string;
  terminal_text: string;
  tool_placeholders: Record<string, string>;
  text_input_enabled?: boolean;
  scroll_speed: number;
  scroll_sync?: {
    char_end: number;
    duration_ms: number;
  };
  brightness: number;
  RGB: string;
  battery_color: string;
  battery_level: number | undefined;
  image: string;
  camera_mode: boolean;
  camera_capture?: boolean;
  capture_image_path: string;
  wifi_signal_level: number;
  vpn_connected: boolean;
  rag_icon_visible: boolean;
  image_icon_visible: boolean;
  music_progress: number | undefined;
  music_duration_ms: number | undefined;
  approval_mode: boolean;
}

export class WhisplayDisplay {
  private currentStatus: Status = {
    status: "starting",
    emoji: "😊",
    text: "",
    terminal_text: "",
    tool_placeholders: {},
    text_input_enabled: false,
    scroll_speed: 3,
    scroll_sync: undefined,
    brightness: 100,
    RGB: "#00FF30",
    battery_color: "#000000",
    battery_level: undefined,
    image: "",
    camera_mode: false,
    capture_image_path: "",
    wifi_signal_level: 0,
    vpn_connected: false,
    rag_icon_visible: false,
    image_icon_visible: false,
    music_progress: undefined,
    music_duration_ms: undefined,
    approval_mode: false,
  };

  private client = null as Socket | null;
  private buttonPressedCallback: () => void = () => {};
  private buttonReleasedCallback: () => void = () => {};
  private buttonDoubleClickCallback: (() => void) | null = null;
  private buttonDown = false;
  private onCameraCaptureCallback: () => void = () => {};
  private textInputCallback: (text: string) => void = () => {};
  private isReady: Promise<void>;
  private pythonProcess: any; // Placeholder for Python process if needed
  private buttonPressTimeArray: number[] = [];
  private buttonReleaseTimeArray: number[] = [];
  private webDisplay: WebDisplayServer | null = null;
  private deviceEnabled: boolean;
  private cameraEnabled: boolean;
  private receiveBuffer = "";
  private textCounterTimer: NodeJS.Timeout | null = null;
  private textCounterTemplate: string | null = null;
  private textCounterStartAt = 0;
  private daemonSocketPath = "/tmp/whisplay-daemon.sock";

  constructor() {
    const envDeviceEnabled = parseBoolEnv("WHISPLAY_DEVICE_ENABLED", true);
    const daemonDetected = existsSync(this.daemonSocketPath);
    this.deviceEnabled = envDeviceEnabled || daemonDetected;
    if (!envDeviceEnabled && daemonDetected) {
      console.log(
        `[Display] Detected whisplay-daemon at ${this.daemonSocketPath}, enabling hardware path automatically.`,
      );
    }
    this.cameraEnabled = parseBoolEnv("ENABLE_CAMERA", false);
    const webCameraEnabled = parseBoolEnv("WEB_CAMERA_ENABLED", false);
    if (this.cameraEnabled && !webCameraEnabled) {
      this.ensureCameraDaemon();
    }
    const webEnabled = parseBoolEnv("WHISPLAY_WEB_ENABLED", false);
    if (webEnabled) {
      const port = parseInt(process.env.WHISPLAY_WEB_PORT || "17880", 10);
      const host = process.env.WHISPLAY_WEB_HOST || "0.0.0.0";
      this.webDisplay = new WebDisplayServer({
        host,
        port,
        onButtonPress: () => this.handleButtonPressedEvent(),
        onButtonRelease: () => this.handleButtonReleasedEvent(),
        onTextInput: (text: string) => this.handleTextInputEvent(text),
      });
      this.webDisplay.updateStatus(this.currentStatus);
    }

    if (this.deviceEnabled) {
      this.isReady = this.startPythonProcess()
        .then(() => this.connectWithRetry(15, () => {}))
        .catch(error => { console.error("[Lifecycle] Display startup failed:", error); shutdownApplication(1); });
    } else {
      this.isReady = Promise.resolve();
    }
  }

  private maybeEmitDoubleClick(): void {
    if (!this.buttonDoubleClickCallback) return;

    const now = Date.now();
    this.buttonPressTimeArray = this.buttonPressTimeArray.filter(
      (time) => now - time <= DOUBLE_CLICK_WINDOW_MS,
    );
    this.buttonReleaseTimeArray = this.buttonReleaseTimeArray.filter(
      (time) => now - time <= DOUBLE_CLICK_WINDOW_MS,
    );
    if (
      this.buttonPressTimeArray.length < 2 ||
      this.buttonReleaseTimeArray.length < 2
    ) {
      return;
    }

    const firstPress =
      this.buttonPressTimeArray[this.buttonPressTimeArray.length - 2];
    const secondPress =
      this.buttonPressTimeArray[this.buttonPressTimeArray.length - 1];
    const firstRelease =
      this.buttonReleaseTimeArray[this.buttonReleaseTimeArray.length - 2];
    const secondRelease =
      this.buttonReleaseTimeArray[this.buttonReleaseTimeArray.length - 1];
    const firstPressDuration = firstRelease - firstPress;
    const secondPressDuration = secondRelease - secondPress;
    const doubleClickDetected =
      firstPress <= firstRelease &&
      firstRelease <= secondPress &&
      secondPress <= secondRelease &&
      secondRelease - firstPress <= DOUBLE_CLICK_WINDOW_MS &&
      firstPressDuration <= DOUBLE_CLICK_MAX_PRESS_MS &&
      secondPressDuration <= DOUBLE_CLICK_MAX_PRESS_MS;

    if (doubleClickDetected) {
      this.buttonPressTimeArray = [];
      this.buttonReleaseTimeArray = [];
      this.buttonDoubleClickCallback();
    }
  }

  startPythonProcess(): Promise<void> {
    // No shell child: track the actual Python PID and connect only after our
    // own child confirms its bind, never to another process on the same port.
    const child = spawnOwned("python3", ["-u", "chatbot-ui.py"], {
      cwd: resolve(__dirname, "../../python"), stdio: ["ignore", "pipe", "pipe"],
    });
    this.pythonProcess = child;
    return new Promise((resolveReady, reject) => {
      let ready = false, line = "";
      const timer = setTimeout(() => reject(new Error("Display readiness timed out")), 60_000);
      child.stdout!.on("data", (data: Buffer) => {
        console.log(data.toString());
        if (ready) return;
        line = (line + data.toString()).slice(-4096);
        if (line.includes("[Socket] Listening on")) {
          ready = true; clearTimeout(timer); resolveReady();
        }
      });
      child.stderr!.on("data", (data: Buffer) => console.error(data.toString()));
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => {
        clearTimeout(timer);
        if (!ready) reject(new Error("Display child exited before readiness"));
        else if (!appSignal.aborted) shutdownApplication(1);
      });
    });
  }

  killPythonProcess(): void {
    this.client?.destroy();
    if (this.pythonProcess) void stopOwnedChild(this.pythonProcess);
  }

  async connectWithRetry(
    retries: number = 10,
    outerResolve: () => void,
  ): Promise<void> {
    if (!this.deviceEnabled) {
      outerResolve();
      return;
    }
    await new Promise((resolve, reject) => {
      const attemptConnection = (attempt: number) => {
        if (appSignal.aborted) { reject(new Error("Display startup cancelled")); return; }
        this.connect()
          .then(() => {
            resolve(true);
          })
          .catch((err) => {
            if (attempt < retries && !appSignal.aborted) {
              console.log(`Connection attempt ${attempt} failed, retrying...`);
              setTimeout(() => attemptConnection(attempt + 1), 5000);
            } else {
              console.error("Failed to connect after multiple attempts:", err);
              reject(err);
            }
          });
      };
      attemptConnection(1);
    });
    outerResolve();
  }

  async connect(): Promise<void> {
    console.log("Connecting to local display socket...");
    return new Promise<void>((resolve, reject) => {
      // 销毁原来的this.client
      if (this.client) {
        this.client.destroy();
      }
      this.client = new Socket();
      const socket = this.client;
      socket.setTimeout(5000, () => socket.destroy(new Error("Display connection timed out")));
      this.client.connect(12345, "0.0.0.0", () => {
        socket.setTimeout(0);
        console.log("Connected to local display socket");
        this.receiveBuffer = "";
        this.sendToDisplay(JSON.stringify(this.currentStatus));
        resolve();
      });
      this.client.on("data", (data: Buffer) => {
        this.receiveBuffer += data.toString();
        while (this.receiveBuffer.includes("\n")) {
          const newlineIndex = this.receiveBuffer.indexOf("\n");
          const line = this.receiveBuffer.slice(0, newlineIndex).trim();
          this.receiveBuffer = this.receiveBuffer.slice(newlineIndex + 1);
          if (!line || line === "OK") {
            continue;
          }
          console.log(
            `[${getCurrentTimeTag()}] Received data from Whisplay hat:`,
            line,
          );
          try {
            const json = JSON.parse(line);
            if (json.event === "button_pressed") {
              this.handleButtonPressedEvent();
            }
            if (json.event === "button_released") {
              this.handleButtonReleasedEvent();
            }
            if (json.event === "camera_capture") {
              this.handleCameraCaptureEvent();
            }
            if (json.event === "exit_camera_mode") {
              this.display({ camera_mode: false });
            }
            if (json.event === "app_exit_requested") {
              console.log("[WhisplayApp] Exit requested by daemon");
              shutdownApplication();
            }
          } catch {
            // ignore invalid non-json lines
          }
        }
      });
      this.client.on("error", (err: any) => {
        reject(err);
      });
    });
  }

  onButtonPressed(callback: () => void): void {
    this.buttonPressedCallback = callback;
  }

  onButtonReleased(callback: () => void): void {
    this.buttonReleasedCallback = callback;
  }

  onButtonDoubleClick(callback: (() => void) | null): void {
    this.buttonDoubleClickCallback = callback || null;
  }

  onCameraCapture(callback: () => void): void {
    this.onCameraCaptureCallback = callback;
  }

  onTextInput(callback: (text: string) => void): void {
    this.textInputCallback = callback;
  }

  private async sendToDisplay(data: string): Promise<void> {
    if (!this.deviceEnabled) {
      return;
    }
    await this.isReady;
    try {
      this.client?.write(`${data}\n`, "utf8", () => {
        // console.log("send", data);
      });
    } catch (error) {
      console.error("Failed to update display.");
    }
  }

  getCurrentStatus(): Status {
    return this.currentStatus;
  }

  private stopTextCounter(): void {
    if (this.textCounterTimer) {
      clearInterval(this.textCounterTimer);
      this.textCounterTimer = null;
    }
    this.textCounterTemplate = null;
    this.textCounterStartAt = 0;
  }

  private startTextCounter(template: string): void {
    this.stopTextCounter();
    this.textCounterTemplate = template;
    this.textCounterStartAt = Date.now();
    this.textCounterTimer = setInterval(() => {
      if (!this.textCounterTemplate) {
        this.stopTextCounter();
        return;
      }
      const elapsedSec = Math.floor((Date.now() - this.textCounterStartAt) / 1000);
      const renderedText = this.textCounterTemplate.replace(
        /\{count\}/g,
        `${elapsedSec}`,
      );
      if (this.currentStatus.text === renderedText) {
        return;
      }
      this.currentStatus.text = renderedText;
      const data = JSON.stringify({ text: renderedText, brightness: 100 });
      this.sendToDisplay(data);
      this.webDisplay?.updateStatus(this.currentStatus);
    }, 1000);
  }

  async display(newStatus: Partial<Status> = {}): Promise<void> {
    const previousText = this.currentStatus.text || "";
    const hasTextOverride = Object.prototype.hasOwnProperty.call(
      newStatus,
      "text",
    );
    const normalizedStatus: Partial<Status> = { ...newStatus };
    if (hasTextOverride) {
      const incomingText = `${newStatus.text ?? ""}`;
      if (incomingText.includes("{count}")) {
        this.startTextCounter(incomingText);
        const initialText = incomingText.replace(/\{count\}/g, "0");
        normalizedStatus.text = initialText;
      } else {
        this.stopTextCounter();
      }
    }

    const {
      status,
      emoji,
      text,
      terminal_text,
      tool_placeholders,
      text_input_enabled,
      RGB,
      brightness,
      scroll_sync,
      battery_level,
      battery_color,
      image,
      camera_mode,
      camera_capture,
      capture_image_path,
      wifi_signal_level,
      vpn_connected,
      rag_icon_visible,
      image_icon_visible,
      music_progress,
      music_duration_ms,
      approval_mode,
    } = {
      ...this.currentStatus,
      ...normalizedStatus,
    };

    const changedValues = Object.entries(normalizedStatus).filter(
      ([key, value]) => (this.currentStatus as any)[key] !== value,
    );

    const isTextChanged = changedValues.some(([key]) => key === "text");

    this.currentStatus.status = status;
    this.currentStatus.emoji = emoji;
    this.currentStatus.text = text;
    this.currentStatus.terminal_text = terminal_text;
    this.currentStatus.tool_placeholders = tool_placeholders;
    this.currentStatus.text_input_enabled = text_input_enabled;
    this.currentStatus.RGB = RGB;
    this.currentStatus.brightness = brightness;
    this.currentStatus.scroll_sync = scroll_sync;
    this.currentStatus.battery_level = battery_level;
    this.currentStatus.battery_color = battery_color;
    this.currentStatus.image = image;
    this.currentStatus.camera_mode = camera_mode;
    this.currentStatus.capture_image_path = capture_image_path;
    this.currentStatus.wifi_signal_level = wifi_signal_level;
    this.currentStatus.vpn_connected = vpn_connected;
    this.currentStatus.rag_icon_visible = rag_icon_visible;
    this.currentStatus.image_icon_visible = image_icon_visible;
    this.currentStatus.music_progress = music_progress;
    this.currentStatus.music_duration_ms = music_duration_ms;
    this.currentStatus.approval_mode = approval_mode;
    
    const changedValuesObj = Object.fromEntries(changedValues);
    changedValuesObj.brightness = 100;
    if (
      isTextChanged &&
      typeof changedValuesObj.text === "string" &&
      changedValuesObj.text.startsWith(previousText)
    ) {
      changedValuesObj.text_delta = changedValuesObj.text.slice(previousText.length);
      delete changedValuesObj.text;
    }
    const data = JSON.stringify(changedValuesObj);
    if (isTextChanged) {
      console.log("send data:", formatDisplayPayloadForLog(changedValuesObj));
    }

    if (normalizedStatus.camera_capture) {
      const capturePath = normalizedStatus.capture_image_path || this.currentStatus.capture_image_path;
      if (capturePath) {
        const webCamEnabled = parseBoolEnv("WEB_CAMERA_ENABLED", false);
        if (webCamEnabled && webAudioBridge.isCameraAvailable()) {
          // Request capture from browser camera regardless of physical device state.
          webAudioBridge
            .requestCameraCapture(capturePath)
            .then(() => this.handleCameraCaptureEvent())
            .catch((e) =>
              console.error("[WebCamera] Capture failed:", e),
            );
        } else if (!this.deviceEnabled) {
          // No physical hardware and no web camera: use the Pi camera daemon.
          this.sendCameraDaemonCommand("capture", { path: capturePath });
          this.handleCameraCaptureEvent();
        }
        // When deviceEnabled=true and no web camera: chatbot-ui.py handles the capture.
      }
    }

    this.sendToDisplay(data);
    this.webDisplay?.updateStatus(this.currentStatus);
  }

  private handleButtonPressedEvent(): void {
    this.buttonDown = true;
    this.buttonPressTimeArray.push(Date.now());
    console.log("emit pressed");
    this.buttonPressedCallback();
  }

  private handleButtonReleasedEvent(): void {
    this.buttonDown = false;
    this.buttonReleaseTimeArray.push(Date.now());
    console.log("emit released");
    this.buttonReleasedCallback();
    this.maybeEmitDoubleClick();
  }

  isButtonDown(): boolean {
    return this.buttonDown;
  }

  private handleCameraCaptureEvent(): void {
    this.onCameraCaptureCallback();
  }

  private handleTextInputEvent(text: string): void {
    this.textInputCallback(text);
  }

  stopWebDisplay(): void {
    this.webDisplay?.close();
    this.webDisplay = null;
  }

  private ensureCameraDaemon(): void {
    const command = `cd ${resolve(
      __dirname,
      "../../python",
    )} && python3 camera.py --ensure-daemon`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.warn("[CameraDaemon] ensure failed:", error.message);
        return;
      }
      if (stdout?.trim()) {
        console.log(stdout.trim());
      }
      if (stderr?.trim()) {
        console.warn(stderr.trim());
      }
    });
  }

  private sendCameraDaemonCommand(
    cmd: string,
    payload: Record<string, unknown> = {},
  ): void {
    const port = parseInt(process.env.WHISPLAY_CAMERA_DAEMON_PORT || "18765", 10);
    const socket = new Socket();
    socket.setTimeout(1000);
    socket.connect(port, "127.0.0.1", () => {
      socket.write(`${JSON.stringify({ cmd, ...payload })}\n`);
      socket.end();
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.on("timeout", () => {
      socket.destroy();
    });
  }
}

// Create a singleton instance to maintain backward compatibility
const displayInstance = new WhisplayDisplay();

export const display = displayInstance.display.bind(displayInstance);
export const getCurrentStatus =
  displayInstance.getCurrentStatus.bind(displayInstance);
export const onButtonPressed =
  displayInstance.onButtonPressed.bind(displayInstance);
export const onButtonReleased =
  displayInstance.onButtonReleased.bind(displayInstance);
export const onButtonDoubleClick =
  displayInstance.onButtonDoubleClick.bind(displayInstance);
export const onCameraCapture =
  displayInstance.onCameraCapture.bind(displayInstance);
export const onTextInput =
  displayInstance.onTextInput.bind(displayInstance);
export const isButtonDown =
  displayInstance.isButtonDown.bind(displayInstance);

onAppShutdown(() => {
  displayInstance.killPythonProcess();
  displayInstance.stopWebDisplay();
});
process.on("keyboardInterrupt", () => shutdownApplication());

function parseBoolEnv(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (!raw) {
    return defaultValue;
  }
  return raw.toLowerCase() === "true" || raw === "1";
}

function formatDisplayPayloadForLog(payload: Record<string, any>): string {
  const logPayload = { ...payload };

  if (typeof logPayload.text_delta === "string") {
    logPayload.deltaText = summarizeLogText(logPayload.text_delta);
    delete logPayload.text_delta;
  }

  if (typeof logPayload.text === "string") {
    logPayload.textPreview = summarizeLogText(logPayload.text);
    logPayload.textLength = logPayload.text.length;
    delete logPayload.text;
  }

  return JSON.stringify(logPayload);
}

function summarizeLogText(text: string, maxChars = 80): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... (${text.length} chars)`;
}
