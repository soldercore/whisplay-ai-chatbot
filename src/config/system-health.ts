import os from "node:os";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { dataDir } from "../utils/dir";
import type { LLMTool } from "../type";
import { checkCancelled, currentToolSignal, operationDeadline, timeoutSetting } from "../utils/operation-lifecycle";

const UNITS = ["chatbot.service", "whisplay-daemon.service", "ollama.service", "whisplay-whisper.service", "whisplay-piper.service"] as const;
type HealthFile = "/proc/meminfo" | "/sys/class/thermal/thermal_zone0/type" | "/sys/class/thermal/thermal_zone0/temp";

function readMetric(file: HealthFile): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const bytes = Buffer.alloc(16385);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return count <= 16384 ? bytes.subarray(0, count).toString("utf8") : null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

function safe<T>(read: () => T): T | null { try { return read(); } catch { return null; } }
function metricNumber(value: number): number | null { return Number.isFinite(value) && value >= 0 ? value : null; }

function sampleWait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, 100);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function serviceStatus(signal: AbortSignal): Promise<object> {
  checkCancelled(signal);
  return new Promise(resolve => {
    execFile("systemctl", ["show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState", ...UNITS], {
      timeout: 5000, killSignal: "SIGKILL", maxBuffer: 16384, signal, windowsHide: true,
    }, (error, stdout) => {
      if (error && !stdout) { resolve({ available: false, reason: "systemd status unavailable" }); return; }
      const units: object[] = [];
      for (const block of stdout.split(/\r?\n\r?\n/)) {
        const fields: Record<string, string> = {};
        for (const line of block.split(/\r?\n/)) {
          const match = line.match(/^(Id|LoadState|ActiveState|SubState)=([a-zA-Z0-9_.@-]+)$/);
          if (match) fields[match[1]] = match[2];
        }
        if (UNITS.includes(fields.Id as typeof UNITS[number])) units.push({ unit: fields.Id,
          load: fields.LoadState || null, active: fields.ActiveState || null, sub: fields.SubState || null });
      }
      resolve({ available: units.length > 0, units });
    });
  });
}

// Optional platform argument is for host tests, not exposed in the tool schema.
export async function collectSystemHealth(platform = process.platform): Promise<object> {
  const deadline = operationDeadline(timeoutSetting("SYSTEM_HEALTH_TIMEOUT_MS", 10_000), currentToolSignal());
  try {
    checkCancelled(deadline.signal);
    const first = safe(() => os.cpus().map(cpu => cpu.times));
    const started = performance.now();
    await sampleWait(deadline.signal);
    const second = safe(() => os.cpus().map(cpu => cpu.times));
    const sampleWindowMs = Math.round(performance.now() - started);
    let utilizationPercent: number | null = null;
    if (first?.length && second?.length === first.length) {
      const totals = (cpus: typeof first) => cpus!.reduce((sum, times) => ({
        idle: sum.idle + times.idle, total: sum.total + times.idle + times.user + times.nice + times.sys + times.irq,
      }), { total: 0, idle: 0 });
      const before = totals(first), after = totals(second);
      const total = after.total - before.total, idle = after.idle - before.idle;
      if (total > 0 && idle >= 0 && idle <= total) utilizationPercent = Math.round((1 - idle / total) * 10000) / 100;
    }
    const linux = platform === "linux";
    const meminfo = linux ? readMetric("/proc/meminfo") : null;
    const memory = (name: string) => {
      const match = meminfo?.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, "m"));
      return match ? metricNumber(Number(match[1]) * 1024) : null;
    };
    const totalBytes = linux ? memory("MemTotal") : safe(() => metricNumber(os.totalmem()));
    const availableBytes = memory("MemAvailable");
    const freeBytes = linux ? memory("MemFree") : safe(() => metricNumber(os.freemem()));
    const type = linux ? readMetric("/sys/class/thermal/thermal_zone0/type")?.trim() : null;
    const rawTemperature = type && /^(cpu-thermal|bcm2835_thermal)$/.test(type)
      ? readMetric("/sys/class/thermal/thermal_zone0/temp")?.trim() : null;
    const temperatureCelsius = rawTemperature && /^\d+$/.test(rawTemperature)
      ? metricNumber(Number(rawTemperature) / 1000) : null;
    const disk = safe(() => {
      const stat = fs.statfsSync(dataDir, { bigint: true });
      const bytes = (blocks: bigint) => { const n = Number(blocks * stat.bsize); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
      return { scope: "assistant data filesystem", totalBytes: bytes(stat.blocks), freeBytes: bytes(stat.bfree),
        availableBytes: bytes(stat.bavail), usedBytes: bytes(stat.blocks - stat.bfree) };
    });
    const services = linux ? await serviceStatus(deadline.signal)
      : { available: false, reason: "systemd requires Linux" };
    checkCancelled(deadline.signal);
    return {
      sampledAt: new Date().toISOString(), platform,
      cpu: { utilizationPercent, sampleWindowMs,
        loadAverage: linux ? safe(() => os.loadavg()) : null },
      memory: { totalBytes, availableBytes, freeBytes,
        usedBytes: totalBytes !== null && availableBytes !== null && availableBytes <= totalBytes ? totalBytes - availableBytes : null,
        swapTotalBytes: memory("SwapTotal"), swapFreeBytes: memory("SwapFree") },
      disk, temperatureCelsius, uptimeSeconds: safe(() => metricNumber(os.uptime())), services,
      note: "Null metrics are unavailable; service status does not prove backend health.",
    };
  } finally { deadline.dispose(); }
}

export const systemHealthTool: LLMTool = {
  execution: "abortable", type: "function", function: {
    name: "getSystemHealth", description: "Read this device's CPU, memory, disk, temperature, uptime and service status. Call with {} only; no arguments. Null means unavailable.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  func: async () => "[success]" + JSON.stringify(await collectSystemHealth()),
};

// A success tag alone does not establish usable measurements. In particular,
// another available metric cannot stand in for a requested missing sensor.
export function hasSystemHealthMeasurements(output: string, question: string): boolean {
  try {
    const report = JSON.parse(output.replace(/^\[(success|response)\]/, ""));
    if (!report || typeof report !== "object" || Array.isArray(report)) return false;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const requested: boolean[] = [];
    if (/\btemperature\b/i.test(question)) requested.push(number(report.temperatureCelsius));
    if (/\b(cpu|processor)\s+(usage|utili[sz]ation|load)\b/i.test(question)) requested.push(number(report.cpu?.utilizationPercent));
    if (/\b(ram|memory)\b/i.test(question)) {
      requested.push(number(/\b(using|used|usage)\b/i.test(question) ? report.memory?.usedBytes : report.memory?.totalBytes));
    }
    if (/\b(disk|storage)\b/i.test(question)) requested.push(number(report.disk?.availableBytes));
    if (/\bswap\b/i.test(question)) requested.push(number(report.memory?.swapTotalBytes) && number(report.memory?.swapFreeBytes));
    if (/\buptime\b/i.test(question)) requested.push(number(report.uptimeSeconds));
    if (/\bservices?\b/i.test(question)) requested.push(report.services?.available === true && Array.isArray(report.services.units) && report.services.units.length > 0);
    if (requested.length) return requested.every(Boolean);
    return [report.cpu?.utilizationPercent, report.memory?.totalBytes, report.memory?.usedBytes,
      report.disk?.availableBytes, report.temperatureCelsius].some(number);
  } catch { return false; }
}
