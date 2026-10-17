import axios from "axios";
import net from "node:net";
import { resolve } from "node:path";
import { appSignal, spawnOwned, stopOwnedChild } from "./app-lifecycle";
import { checkCancelled } from "./operation-lifecycle";

type Service = { name: string; host: string; port: number; path: string; args: string[] };
const local = (host: string) => ["localhost", "127.0.0.1", "0.0.0.0"].includes(host);

// Validate the complete RIFF container and require a usable PCM format/data
// pair. Content-Type is unreliable in Piper 1.8.
function validPcmWav(data: unknown): boolean {
  if (!Buffer.isBuffer(data) || data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF"
    || data.toString("ascii", 8, 12) !== "WAVE" || data.readUInt32LE(4) + 8 !== data.length) return false;
  let offset = 12, format = false, audio = false, blockAlign = 0;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4), start = offset + 8, end = start + size;
    if (end > data.length || end + (size % 2) > data.length) return false;
    if (id === "fmt ") {
      if (size < 16 || data.readUInt16LE(start) !== 1) return false;
      const channels = data.readUInt16LE(start + 2), rate = data.readUInt32LE(start + 4);
      const byteRate = data.readUInt32LE(start + 8), align = data.readUInt16LE(start + 12);
      const bits = data.readUInt16LE(start + 14);
      if (!channels || !rate || !bits || bits % 8 || align !== channels * bits / 8 || byteRate !== rate * align) return false;
      format = true; blockAlign = align;
    }
    if (id === "data") { if (!format || !size || size % blockAlign) return false; audio = true; }
    offset = end + (size % 2);
  }
  return format && audio && offset === data.length;
}

export async function portAvailable(port: number, host = "0.0.0.0"): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function compatibleService(service: Pick<Service, "name" | "host" | "port" | "path">): Promise<boolean> {
  const base = `http://${service.host === "0.0.0.0" ? "127.0.0.1" : service.host}:${service.port}`;
  const options = { timeout: 1500, signal: appSignal, proxy: false as const,
    maxContentLength: 65536, validateStatus: () => true };
  try {
    if (service.name === "Piper") {
      const response = await axios.post(`${base}${service.path}`, { text: "Hello." }, {
        ...options, timeout: 15000, maxContentLength: 2 * 1024 * 1024, responseType: "arraybuffer",
      });
      return response.status === 200 && validPcmWav(response.data);
    }
    const response = await axios.post(`${base}/recognize`, {}, options);
    return response.status === 400 && response.data?.error === "Invalid JSON";
  } catch { checkCancelled(appSignal); return false; }
}

export async function ensureLocalService(service: Service, startupMs = 120_000): Promise<void> {
  if (!local(service.host)) return; // Remote services remain externally managed.
  checkCancelled(appSignal);
  if (await compatibleService(service)) {
    console.log(`[Lifecycle] Reusing compatible external ${service.name}`);
    return;
  }
  if (!await portAvailable(service.port)) throw new Error(`${service.name} port ${service.port} is occupied by an incompatible or unready service; nothing was stopped`);
  checkCancelled(appSignal);
  const child = spawnOwned("python3", service.args, { detached: process.platform !== "win32", stdio: "inherit" });
  let exited = false;
  const failed = () => { exited = true; };
  child.once("exit", failed); child.once("error", failed);
  try {
    const until = Date.now() + startupMs;
    while (Date.now() < until) {
      checkCancelled(appSignal);
      if (exited) throw new Error(`${service.name} exited before readiness`);
      if (await compatibleService(service)) {
        if (exited) throw new Error(`${service.name} lost its startup race`);
        console.log(`[Lifecycle] Owned ${service.name} ready`);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); appSignal.removeEventListener("abort", abort); reject(appSignal.reason); };
        const timer = setTimeout(() => { appSignal.removeEventListener("abort", abort); resolve(); }, 250);
        appSignal.addEventListener("abort", abort, { once: true });
        if (appSignal.aborted) abort();
      });
    }
    throw new Error(`${service.name} startup timed out`);
  } catch (error) { await stopOwnedChild(child); throw error; }
  finally { child.off("exit", failed); child.off("error", failed); }
}

export async function prepareLocalServices(env = process.env): Promise<void> {
  const port = (value: string | undefined, fallback: number) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error("Invalid local service port");
    return n;
  };
  if ((env.ASR_SERVER || "").trim().toLowerCase() === "faster-whisper") {
    const p = port(env.FASTER_WHISPER_PORT, 8803);
    await ensureLocalService({ name: "Faster-Whisper", host: env.FASTER_WHISPER_HOST || "localhost", port: p, path: "/recognize",
      args: [resolve(__dirname, "../../python/speech-service/faster-whisper-host.py"), "--port", String(p)] });
  }
  if ((env.TTS_SERVER || "").trim().toLowerCase() === "piper-http") {
    const p = port(env.PIPER_HTTP_PORT, 8805), host = env.PIPER_HTTP_HOST || "localhost";
    const requestPath = (env.PIPER_HTTP_PATH || "").trim();
    await ensureLocalService({ name: "Piper", host, port: p, path: requestPath && !requestPath.startsWith("/") ? `/${requestPath}` : requestPath,
      args: ["-m", "piper.http_server", "-m", env.PIPER_HTTP_MODEL || "en_US-amy-medium", "--port", String(p), "--host", host] });
  }
}
