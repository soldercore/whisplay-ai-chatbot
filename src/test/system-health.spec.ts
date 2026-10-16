import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import axios from "axios";
import { collectSystemHealth, systemHealthTool } from "../config/system-health";
import { executeToolCall } from "../config/tool-execution";
import { withToolSignal } from "../utils/operation-lifecycle";
import { toolsRelevantTo } from "../config/tool-router";

const os = require("node:os"), fs = require("node:fs"), cp = require("node:child_process");
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function sources(t: any) {
  const opened: string[] = [], commands: any[] = [];
  const files: Record<string, string> = {
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\nMemFree: 100 kB\nSwapTotal: 50 kB\nSwapFree: 20 kB\n",
    "/sys/class/thermal/thermal_zone0/type": "cpu-thermal\n",
    "/sys/class/thermal/thermal_zone0/temp": "65000\n",
  };
  let samples = 0;
  t.mock.method(os, "cpus", () => [{ model: "Fixture", speed: 1, times: samples++ === 0
    ? { user: 100, sys: 50, nice: 0, irq: 0, idle: 850 }
    : { user: 130, sys: 70, nice: 0, irq: 0, idle: 900 } }]);
  t.mock.method(os, "loadavg", () => [1, 2, 3]);
  t.mock.method(os, "totalmem", () => 800);
  t.mock.method(os, "freemem", () => 200);
  t.mock.method(os, "uptime", () => 1234);
  const descriptors = new Map<number, string>();
  t.mock.method(fs, "openSync", (file: string) => {
    assert.ok(Object.prototype.hasOwnProperty.call(files, file), "only fixed public metric paths may be opened");
    opened.push(file); const fd = opened.length + 100; descriptors.set(fd, file); return fd;
  });
  t.mock.method(fs, "readSync", (fd: number, buffer: Buffer) => buffer.write(files[descriptors.get(fd)!]));
  t.mock.method(fs, "closeSync", (fd: number) => { descriptors.delete(fd); });
  t.mock.method(fs, "statfsSync", () => ({ bsize: 4096n, blocks: 1000n, bfree: 400n, bavail: 350n }));
  t.mock.method(cp, "execFile", (command: string, args: string[], options: any, callback: Function) => {
    commands.push({ command, args, options });
    callback(null, "Id=ollama.service\nLoadState=loaded\nActiveState=active\nSubState=running\nEnvironment=PRIVATE_SECRET\n\nId=unlisted.service\nActiveState=active\n");
  });
  return { opened, commands, files, descriptors, sampleCount: () => samples };
}
async function collect(t: any, platform: NodeJS.Platform = "linux") {
  const pending = collectSystemHealth(platform); await flush(); t.mock.timers.tick(100); return await pending as any;
}

test("system health reports independently expected measured values and only allowlisted service fields", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const s = sources(t);
  const result = await collect(t);
  assert.equal(result.cpu.utilizationPercent, 50);
  assert.deepEqual(result.cpu.loadAverage, [1, 2, 3]);
  assert.deepEqual(result.memory, { totalBytes: 1024000, availableBytes: 256000, freeBytes: 102400,
    usedBytes: 768000, swapTotalBytes: 51200, swapFreeBytes: 20480 });
  assert.deepEqual(result.disk, { scope: "assistant data filesystem", totalBytes: 4096000,
    freeBytes: 1638400, availableBytes: 1433600, usedBytes: 2457600 });
  assert.equal(result.temperatureCelsius, 65); assert.equal(result.uptimeSeconds, 1234);
  assert.deepEqual(result.services, { available: true, units: [{ unit: "ollama.service", load: "loaded", active: "active", sub: "running" }] });
  assert.equal(JSON.stringify(result).includes("PRIVATE_SECRET"), false);
  assert.equal(s.descriptors.size, 0);
  assert.equal(s.commands[0].command, "systemctl");
  assert.deepEqual(s.commands[0].args, ["show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState",
    "chatbot.service", "whisplay-daemon.service", "ollama.service", "whisplay-whisper.service", "whisplay-piper.service"]);
  assert.equal(s.commands[0].options.timeout, 5000);
  assert.equal(s.commands[0].options.killSignal, "SIGKILL");
  assert.equal(s.commands[0].options.maxBuffer, 16384);
  assert.equal(s.commands[0].options.shell, undefined);
});

test("non-Linux health has real portable metrics and explicitly unavailable Linux-only measurements", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const s = sources(t);
  const result = await collect(t, "win32");
  assert.equal(result.cpu.utilizationPercent, 50); assert.equal(result.cpu.loadAverage, null);
  assert.equal(result.memory.totalBytes, 800); assert.equal(result.memory.freeBytes, 200);
  assert.equal(result.memory.availableBytes, null); assert.equal(result.memory.swapTotalBytes, null);
  assert.equal(result.temperatureCelsius, null); assert.equal(result.services.available, false);
  assert.deepEqual(s.opened, []); assert.deepEqual(s.commands, []);
});

test("missing metrics and services remain unavailable without exposing raw errors", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); sources(t);
  t.mock.method(fs, "openSync", () => { throw new Error("private path and secret"); });
  t.mock.method(fs, "statfsSync", () => { throw new Error("unavailable"); });
  t.mock.method(cp, "execFile", (_cmd: string, _args: string[], _options: any, callback: Function) => callback(new Error("private secret")));
  t.mock.method(os, "cpus", () => []);
  const result = await collect(t);
  assert.equal(result.memory.totalBytes, null); assert.equal(result.disk, null);
  assert.equal(result.temperatureCelsius, null); assert.equal(result.cpu.utilizationPercent, null);
  assert.equal(result.services.available, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("a missing unit does not discard measured status for other allowlisted services", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); sources(t);
  t.mock.method(cp, "execFile", (_cmd: string, _args: string[], _options: any, callback: Function) => callback(new Error("one missing unit"),
    "Id=ollama.service\nLoadState=loaded\nActiveState=active\nSubState=running\n\nId=chatbot.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\n"));
  const result = await collect(t);
  assert.deepEqual(result.services, { available: true, units: [
    { unit: "ollama.service", load: "loaded", active: "active", sub: "running" },
    { unit: "chatbot.service", load: "not-found", active: "inactive", sub: "dead" },
  ] });
});

test("unknown thermal sensor type and zero CPU delta do not fabricate CPU values", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const s = sources(t);
  s.files["/sys/class/thermal/thermal_zone0/type"] = "gpu-sensor\n";
  t.mock.method(os, "cpus", () => [{ times: { user: 1, nice: 0, sys: 1, irq: 0, idle: 8 } }]);
  const result = await collect(t);
  assert.equal(result.temperatureCelsius, null); assert.equal(result.cpu.utilizationPercent, null);
  assert.equal(s.opened.includes("/sys/class/thermal/thermal_zone0/temp"), false);
});

test("health authorization rejects disabled, unoffered and arbitrary command/path arguments before measuring", async t => {
  const s = sources(t);
  for (const variant of ["disabled", "unoffered", "arguments"]) {
    const result = await executeToolCall("getSystemHealth", variant === "arguments" ? { command: "reboot", path: "/etc/shadow" } : {}, {
      enabled: variant !== "disabled", allowedTools: variant === "unoffered" ? [] : [systemHealthTool],
      registeredTools: [systemHealthTool], handlers: { getSystemHealth: systemHealthTool.func },
    });
    assert.equal(result.status, "rejected");
  }
  assert.deepEqual(s.opened, []); assert.deepEqual(s.commands, []);
});

test("health sampling cancellation clears its timer before files or processes are touched", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const s = sources(t);
  const controller = new AbortController();
  const pending = withToolSignal(controller.signal, () => collectSystemHealth("linux"));
  const rejected = assert.rejects(pending, /fixture cancelled/);
  controller.abort(new Error("fixture cancelled")); await rejected;
  t.mock.timers.tick(1000); await flush();
  assert.deepEqual(s.opened, []); assert.deepEqual(s.commands, []);
});

test("health is offered for the target request and not unrelated conversation", () => {
  assert.deepEqual(toolsRelevantTo("GLaDOS, how is your system doing?", [systemHealthTool]), [systemHealthTool]);
  assert.deepEqual(toolsRelevantTo("Tell me a joke.", [systemHealthTool]), []);
});

test("health deadline aborts an active status process without retry or fabricated status", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); sources(t);
  let attempts = 0, aborted = 0;
  t.mock.method(cp, "execFile", (_cmd: string, _args: string[], options: any, callback: Function) => {
    attempts++;
    options.signal.addEventListener("abort", () => { aborted++; callback(new Error("cancelled")); }, { once: true });
  });
  const pending = collectSystemHealth("linux");
  const rejected = assert.rejects(pending, /timed out/);
  await flush(); t.mock.timers.tick(100); await flush();
  assert.equal(attempts, 1);
  t.mock.timers.tick(9900); await rejected;
  assert.equal(aborted, 1); assert.equal(attempts, 1);
});

test("normal Ollama conversation executes registered health tool and receives its actual measurement result", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const s = sources(t);
  Object.assign(process.env, { LLM_SERVER: "test", OLLAMA_ENABLE_TOOLS: "true", WEB_SEARCH_ENABLED: "false",
    MEMORY_ENABLED: "false", CONTEXT_AUTO_COMPACT_ENABLED: "false" });
  const requests: any[] = [];
  t.mock.method(axios, "post", async (_url: string, body: any) => {
    requests.push(body);
    const stream = new PassThrough();
    const record = requests.length === 1 ? { message: { tool_calls: [{ function: { name: "getSystemHealth", arguments: {} } }] }, done: true }
      : { message: { content: "CPU utilization is 50 percent and temperature is 65 Celsius." }, done: true };
    setImmediate(() => stream.end(JSON.stringify(record) + "\n"));
    return { data: stream };
  });
  // The local Windows host is simulated as Linux only for this measurement test.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    const provider = require("../cloud-api/local/ollama-llm").default;
    t.after(() => provider.cancelActiveRequest());
    let answer = "", ends = 0;
    const pending = provider.chatWithLLMStream([{ role: "user", content: "GLaDOS, how is your system doing?" }],
      (text: string) => answer += text, () => ends++);
    for (let i = 0; i < 10 && s.sampleCount() === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(s.sampleCount(), 1, "advance time only after actual tool sampling starts");
    t.mock.timers.tick(100); await pending;
    assert.equal(answer, "CPU utilization is 50 percent and temperature is 65 Celsius."); assert.equal(ends, 1);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].tools.some((tool: any) => tool.function.name === "getSystemHealth"));
    const result = requests[1].messages.find((message: any) => message.role === "tool");
    assert.equal(result.tool_name, "getSystemHealth");
    const metrics = JSON.parse(result.content.slice("[success]".length));
    assert.equal(metrics.cpu.utilizationPercent, 50); assert.equal(metrics.temperatureCelsius, 65);
  } finally { Object.defineProperty(process, "platform", originalPlatform); }
});
