import dotenv from "dotenv";
import fs from "node:fs";
import { requireLauncherLock } from "./utils/app-launch-lock";
import { installAppShutdown, shutdownApplication, onAppShutdown, appSignal } from "./utils/app-lifecycle";
import { prepareLocalServices, portAvailable } from "./utils/local-services";

async function main(): Promise<void> {
  requireLauncherLock();
  dotenv.config();
  installAppShutdown();
  const device = ["true", "1"].includes((process.env.WHISPLAY_DEVICE_ENABLED || "true").toLowerCase())
    || fs.existsSync("/tmp/whisplay-daemon.sock");
  if (device && !await portAvailable(12345)) throw new Error("Display port 12345 is occupied; duplicate/unknown display was not adopted");
  // Establish daemon focus/exit handling while cold speech services load.
  // Importing ChatFlow/providers still waits for service readiness below.
  require("./device/display");
  await prepareLocalServices();
  if (appSignal.aborted) return;
  // Import conversation providers only after exclusive launch and readiness.
  const { default: ChatFlow } = require("./core/ChatFlow");
  onAppShutdown(() => require("./cloud-api/llm").cancelLLMRequest());
  require("./status/battery-status").startBatteryStatus();
  require("./status/wifi-status").startWifiStatus();
  require("./status/vpn-status").startVpnStatus();
  new ChatFlow({ enableCamera: process.env.ENABLE_CAMERA === "true" });
}

void main().catch(error => { console.error("[Lifecycle] Startup failed:", error.message); shutdownApplication(1); });
