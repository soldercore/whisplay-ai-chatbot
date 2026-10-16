import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import axios from "axios";
import { collectSystemHealth, hasSystemHealthMeasurements, systemHealthTool } from "../config/system-health";
import { executeToolCall } from "../config/tool-execution";
import { withToolSignal } from "../utils/operation-lifecycle";
import { needsSystemHealth, toolsRelevantTo } from "../config/tool-router";

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

test("health advertises an explicit zero-argument contract without search options", () => {
  const definition = JSON.parse(JSON.stringify(systemHealthTool)).function;
  assert.match(definition.description, /call with \{\}/i);
  assert.match(definition.description, /no arguments/i);
  assert.deepEqual(definition.parameters, {
    type: "object", properties: {}, required: [], additionalProperties: false,
  });
});

test("the reported num_results argument and other extra fields reject before any measurement", async t => {
  const s = sources(t);
  for (const args of [{ num_results: 2 }, { query: "cpu" }, { limit: 2 },
    { command: "reboot" }, { path: "/etc/shadow" }, { options: { num_results: 2 } }]) {
    const result = await executeToolCall("getSystemHealth", args, {
      enabled: true, allowedTools: [systemHealthTool], registeredTools: [systemHealthTool],
      handlers: { getSystemHealth: systemHealthTool.func },
    });
    assert.deepEqual(result, { status: "rejected", output: "[rejected]Invalid tool arguments or unsupported schema." });
  }
  assert.equal(s.sampleCount(), 0);
  assert.deepEqual(s.opened, []); assert.deepEqual(s.commands, []);
});

test("empty health arguments execute through validation and return measured data", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const s = sources(t);
  const pending = executeToolCall("getSystemHealth", {}, {
    enabled: true, allowedTools: [systemHealthTool], registeredTools: [systemHealthTool],
    handlers: { getSystemHealth: systemHealthTool.func },
  });
  await flush(); assert.equal(s.sampleCount(), 1);
  t.mock.timers.tick(100);
  const result = await pending;
  assert.equal(result.status, "success");
  assert.match(result.output, /^\[success\]/);
  const metrics = JSON.parse(result.output.slice("[success]".length));
  assert.equal(metrics.cpu.utilizationPercent, 50);
  assert.equal(metrics.uptimeSeconds, 1234);
  assert.equal(s.sampleCount(), 2); assert.equal(s.descriptors.size, 0);
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

test("mandatory health intent distinguishes local measurements from greetings and concepts", () => {
  for (const question of ["How is your system doing?", "What's your CPU temperature?", "How much RAM are you using?",
    "How much memory are you using?", "How much disk space is left?", "Check your system status today.",
    "What is your CPU usage right now?", "What is your uptime?", "Show service status."]) {
    assert.equal(needsSystemHealth(question), true, question);
    assert.deepEqual(toolsRelevantTo(question, [systemHealthTool]), [systemHealthTool], question);
  }
  for (const question of ["How are you doing?", "What is RAM?", "Explain CPU temperature in general.",
    "How does CPU temperature affect performance?", "Tell me a story about a computer system."]) {
    assert.equal(needsSystemHealth(question), false, question);
  }
});

test("health usability requires measured values for each specifically requested metric", () => {
  const output = (report: unknown) => "[success]" + JSON.stringify(report);
  const fallback = { temperatureCelsius: 65, memory: { usedBytes: 768000 }, disk: { availableBytes: 1433600 } };
  for (const report of [null, [], {}, { cpu: { utilizationPercent: null } }, { memory: { usedBytes: "768000" } }]) {
    assert.equal(hasSystemHealthMeasurements(output(report), "How is your system doing?"), false);
  }
  assert.equal(hasSystemHealthMeasurements("[success]broken JSON", "How is your system doing?"), false);
  assert.equal(hasSystemHealthMeasurements(output(fallback), "How is your system doing?"), true);
  for (const [question, report] of [
    ["What's your CPU temperature?", { ...fallback, temperatureCelsius: null }],
    ["How much RAM are you using?", { ...fallback, memory: { totalBytes: 1024000, usedBytes: null } }],
    ["How much disk space is left?", { ...fallback, disk: { totalBytes: 4096000, availableBytes: null } }],
    ["What is your CPU usage?", fallback],
    ["What is your uptime?", { ...fallback, uptimeSeconds: null }],
    ["Show service status.", { ...fallback, services: { available: false, units: [] } }],
    ["Show your uptime and service status.", { ...fallback, uptimeSeconds: 1234, services: { available: false } }],
  ] as [string, object][]) {
    assert.equal(hasSystemHealthMeasurements(output(report), question), false, question);
  }
  assert.equal(hasSystemHealthMeasurements(output({ temperatureCelsius: 0 }), "What's your CPU temperature?"), true);
  assert.equal(hasSystemHealthMeasurements(output({ memory: { usedBytes: 0 } }), "How much RAM are you using?"), true);
  assert.equal(hasSystemHealthMeasurements(output({ disk: { availableBytes: 0 } }), "How much disk space is left?"), true);
  assert.equal(hasSystemHealthMeasurements(output({ uptimeSeconds: 1234 }), "What is your uptime?"), true);
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
    const record = { message: { content: "CPU utilization is 50 percent and temperature is 65 Celsius." }, done: true };
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
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools, undefined, "measurements are already present; do not request another execution");
    const result = requests[0].messages.find((message: any) => message.role === "tool");
    assert.equal(result.tool_name, "getSystemHealth");
    const metrics = JSON.parse(result.content.slice("[success]".length));
    assert.equal(metrics.cpu.utilizationPercent, 50); assert.equal(metrics.temperatureCelsius, 65);
  } finally { Object.defineProperty(process, "platform", originalPlatform); }
});

for (const mode of ["native", "json"] as const) {
  for (const valid of [true, false]) {
    test(`health ${mode} conversation ${valid ? "returns measurements for {}" : "rejects the Pi num_results call"}`, async t => {
      t.mock.timers.enable({ apis: ["setTimeout"] }); const s = sources(t);
      Object.assign(process.env, { LLM_SERVER: "test", OLLAMA_ENABLE_TOOLS: "true", WEB_SEARCH_ENABLED: "true",
        MEMORY_ENABLED: "false", CONTEXT_AUTO_COMPACT_ENABLED: "false" });
      const requests: any[] = [], events: { name: string; result?: string }[] = [];
      const args = valid ? {} : { num_results: 2 };
      t.mock.method(axios, "post", async (_url: string, body: any) => {
        requests.push(JSON.parse(JSON.stringify(body)));
        const tool = requests[requests.length - 1].tools.find((item: any) => item.function.name === "getSystemHealth");
        assert.equal(tool.function.parameters.type, "object");
        assert.deepEqual(tool.function.parameters.properties, {});
        assert.deepEqual(tool.function.parameters.required || [], []);
        assert.equal(tool.function.parameters.additionalProperties, false);
        assert.equal(tool.function.description, systemHealthTool.function.description);
        assert.ok(requests[0].tools.some((item: any) => item.function.name === "web_search"), "keep the real competing search schema");
        const call = { name: "getSystemHealth", arguments: args };
        const record = requests.length > 1 ? { message: { content: "CPU utilization is 50 percent." }, done: true }
          : mode === "native" ? { message: { tool_calls: [{ function: call }] }, done: true }
            : { message: { content: JSON.stringify(call) }, done: true };
        const stream = new PassThrough();
        setImmediate(() => stream.end(JSON.stringify(record) + "\n"));
        return { data: stream };
      });
      // Reload the provider/registry so this test includes both real advertised
      // schemas, independently of the preceding test's web-disabled registry.
      delete require.cache[require.resolve("../config/web-search")];
      delete require.cache[require.resolve("../config/llm-tools")];
      delete require.cache[require.resolve("../cloud-api/local/ollama-llm")];
      const provider = require("../cloud-api/local/ollama-llm").default;
      t.after(() => provider.cancelActiveRequest());
      let answer = "", ends = 0;
      // A conceptual question still offers the health tool but does not mandate
      // sampling. Keep testing the model's native/JSON argument validation here.
      const pending = provider.chatWithLLMStream([{ role: "user", content: "Explain CPU temperature in general." }],
        (text: string) => answer += text, () => ends++, undefined,
        (name: string, result?: string) => events.push({ name, result }));
      if (valid) {
        for (let i = 0; i < 10 && s.sampleCount() === 0; i++) await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(s.sampleCount(), 1);
        t.mock.timers.tick(100);
      }
      await pending;
      assert.equal(ends, 1);
      assert.deepEqual(events.map(event => event.name), ["getSystemHealth", "getSystemHealth"]);
      if (valid) {
        assert.equal(answer, "CPU utilization is 50 percent."); assert.equal(requests.length, 2);
        const result = requests[1].messages.find((message: any) => message.role === "tool");
        assert.equal(result.tool_name, "getSystemHealth");
        assert.equal(JSON.parse(result.content.slice("[success]".length)).cpu.utilizationPercent, 50);
        assert.equal(s.sampleCount(), 2);
      } else {
        assert.equal(answer, "I couldn't run the requested tool. Completion was not verified.");
        assert.equal(requests.length, 1, "no retry, argument stripping or alternate execution");
        assert.equal(events[1].result, "[rejected]Invalid tool arguments or unsupported schema.");
        assert.equal(s.sampleCount(), 0); assert.deepEqual(s.opened, []); assert.deepEqual(s.commands, []);
      }
    });
  }
}
