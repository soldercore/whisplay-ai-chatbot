import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { withToolSignal } from "../utils/operation-lifecycle";
import { spawn as nativeSpawn } from "node:child_process";

function mempalace(platform = "win32", realChild = false) {
  const children: any[] = [], commands: any[] = [], kills: any[] = [];
  const exported: any = {};
  const source = fs.readFileSync(path.join(__dirname, "../config/mempalace.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const spawn = (command: string, args: string[], options: any) => {
    commands.push({ command, args, options });
    if (realChild) {
      const child = nativeSpawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], options);
      children.push(child); return child;
    }
    const child: any = new EventEmitter();
    child.pid = 12345 + children.length;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal: string) => { kills.push([child.pid, signal]); child.emit("close", null); return true; };
    children.push(child); return child;
  };
  vm.runInNewContext(compiled, { exports: exported, console, setTimeout, clearTimeout,
    process: { env: { MEMPALACE_ENABLED: "true", MEMPALACE_PYTHON_PATH: "fixture-python" }, platform,
      kill: (pid: number, signal: string) => { kills.push([pid, signal]); children.find(c => c.pid === -pid).emit("close", null); } },
    require: (name: string) => {
      if (name === "child_process") return { spawn };
      if (name === "dotenv") return { config() {} };
      if (name === "../type") return require("../type");
      if (name === "../utils/operation-lifecycle") return require("../utils/operation-lifecycle");
      if (name === "node:string_decoder" || name === "moment") return require(name);
      throw new Error(`Unexpected MemPalace dependency ${name}`);
    } });
  const invoke = () => exported.mempalaceTools.find((tool: any) => tool.function.name === "mempalaceStatus").func({});
  return { invoke, children, commands, kills };
}

test("fixed MemPalace process completes once, preserves fragmented UTF-8 and removes listeners", async () => {
  const f = mempalace(), done = f.invoke(), child = f.children[0];
  const bytes = Buffer.from("æøå status");
  child.stdout.write(bytes.subarray(0, 1)); child.stdout.write(bytes.subarray(1)); child.emit("close", 0);
  assert.equal(await done, "[success]æøå status");
  assert.deepEqual(Array.from(f.commands[0].args), ["-m", "mempalace.cli", "status"]);
  assert.equal(f.commands[0].options.shell, undefined);
  assert.equal(f.commands[0].options.windowsHide, true);
  assert.deepEqual(f.kills, []);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("close"), 0);
});

test("MemPalace timeout kills the fixed child, caps concurrency, and permits work only after cleanup", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = mempalace(), first = f.invoke(), second = f.invoke();
  assert.match(await f.invoke(), /^\[error\].*process limit/);
  assert.equal(f.children.length, 2);
  t.mock.timers.tick(30_000);
  assert.match(await first, /^\[error\].*timed out/);
  assert.match(await second, /^\[error\].*timed out/);
  assert.deepEqual(f.kills, [[12345, "SIGKILL"], [12346, "SIGKILL"]]);
  const next = f.invoke(); f.children[2].emit("close", 0); await next;
  assert.equal(f.children.length, 3);
});

test("Linux cancellation kills the dedicated process group and drops its abort listener", async () => {
  const f = mempalace("linux"), controller = new AbortController();
  const done = withToolSignal(controller.signal, f.invoke);
  assert.equal(f.commands[0].options.detached, true);
  controller.abort();
  assert.match(await done, /^\[error\].*cancelled/);
  assert.deepEqual(f.kills, [[-12345, "SIGKILL"]]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("excessive child output is killed instead of accumulated", async () => {
  const f = mempalace(), done = f.invoke();
  f.children[0].stdout.write(Buffer.alloc(512 * 1024 + 1));
  assert.match(await done, /^\[error\].*output limit/);
  assert.equal(f.kills.length, 1);
});

test("spawn error settles the operation and releases its process slot", async () => {
  const f = mempalace(), done = f.invoke();
  f.children[0].emit("error", new Error("fixture spawn error"));
  assert.match(await done, /^\[error\].*spawn error/);
  const next = f.invoke(); f.children[1].emit("close", 0); await next;
});

test("volume uses fixed argument arrays, finite process timeout and no shell", () => {
  const exported: any = {}, calls: any[] = [];
  const source = fs.readFileSync(path.join(__dirname, "../utils/volume.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, {
    exports: exported, process: { env: { SOUND_CARD_NAME: "whisplaysound" } }, console,
    require: (name: string) => name === "child_process" ? { execFileSync: (...args: any[]) => { calls.push(args); return Buffer.from(": values=50"); } }
      : { readFileSync: () => "" },
  });
  assert.equal(exported.getCurrentLogPercent(), 50);
  exported.setVolumeByAmixer(40);
  assert.deepEqual(Array.from(calls[1][1]), ["-c", "whisplaysound", "cset", "name=speaker", "40"]);
  for (const [command, , options] of calls) {
    assert.equal(command, "amixer"); assert.equal(options.timeout, 5000);
    assert.equal(options.killSignal, "SIGKILL"); assert.equal(options.maxBuffer, 65536);
  }
});

test("native child cancellation waits for process exit and leaves no live child", { timeout: 10000 }, async t => {
  const f = mempalace("win32", true), controller = new AbortController();
  const done = withToolSignal(controller.signal, f.invoke);
  const child = f.children[0];
  t.after(() => { if (!child.killed) child.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
  controller.abort();
  assert.match(await done, /^\[error\].*cancelled/);
  assert.equal(child.killed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.throws(() => process.kill(child.pid, 0), /ESRCH|no such process/i);
});

test("leaving the real ChatFlow answer state invokes provider cancellation", () => {
  const exported: any = {}; let cancels = 0; const noop = () => {};
  class Machine { constructor(private ctx: any) {} transitionTo(state: string) { this.ctx.currentFlowName = state; } }
  const modules: Record<string, any> = {
    dotenv: { config: noop }, "./../utils/index": { getCurrentTimeTag: () => "test" },
    "../utils": {}, "../device/display": { display: noop }, "../cloud-api/server": {},
    "../cloud-api/llm": { isImMode: false, cancelLLMRequest: () => cancels++ },
    "./StreamResponsor": { StreamResponser: class {} }, "./spoken-text-reveal": { SpokenTextReveal: class {} },
    "./chat-flow/stateMachine": { FlowStateMachine: Machine }, "./chat-flow/states": { flowStates: {} },
    "../device/music-player": { isMusicPlaying: () => false },
  };
  const source = fs.readFileSync(path.join(__dirname, "../core/ChatFlow.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText, {
    exports: exported, console, process: { env: {} }, require: (name: string) => modules[name] || {},
  });
  const ctx = new exported.default();
  ctx.currentFlowName = "answer"; ctx.transitionTo("listening"); assert.equal(cancels, 1);
  ctx.transitionTo("sleep"); assert.equal(cancels, 1);
  ctx.currentFlowName = "answer"; ctx.transitionTo("answer"); assert.equal(cancels, 1);
});
