import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once, getEventListeners } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { compatibleService, portAvailable } from "../utils/local-services";

// Fresh modules and explicit virtual clocks: no app, hardware, model or data imports.
function load(file: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}): any {
  const filename = path.resolve(__dirname, "..", file);
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, __dirname: path.dirname(filename), Buffer, AbortController,
    console: { log() {}, error() {} }, process, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name: string) {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    }, ...globals });
  return exports;
}

function clock() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    Date: { now: () => now },
    setTimeout(run: () => void, ms: number) { const id = ++next; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    tick(ms: number) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].run();
      }
      now = end;
    },
    size: () => timers.size,
  };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function child() {
  const c: any = new EventEmitter();
  c.pid = 123; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.signals = [];
  c.kill = (signal: string) => { c.signals.push(signal); return true; };
  return c;
}
function lifecycle(real = false, platform = "win32") {
  const time = clock(), groups: any[] = [], children: any[] = [];
  const api = load("utils/app-lifecycle.ts", { child_process: { spawn: (...args: any[]) => {
    const c = real ? Reflect.apply(spawn, undefined, args) : child(); children.push(c); return c;
  } } }, { ...(real ? {} : time), process: { platform, kill: (...args: any[]) => groups.push(args) } });
  return { api, time, groups, children };
}

test("owned shutdown is idempotent, awaits exit, clears timers and rejects new work", async () => {
  const { api, time } = lifecycle();
  const c = api.spawnOwned("fixture", []), external = child(); let hooks = 0, complete = false;
  api.onAppShutdown(() => { hooks++; void api.stopOwnedChild(c); });
  const first = api.stopApplication();
  assert.equal(api.stopApplication(), first);
  first.then(() => { complete = true; }); await flush();
  assert.equal(api.appSignal.aborted, true); assert.equal(hooks, 1);
  assert.deepEqual(c.signals, ["SIGTERM"]); assert.equal(complete, false);
  assert.throws(() => api.spawnOwned("fixture", []), /shutting down/);
  await api.stopOwnedChild(external); assert.deepEqual(external.signals, []);
  c.emit("exit", 0); await first;
  assert.equal(time.size(), 0); assert.equal(complete, true);
});

test("stubborn owned children escalate at 3s and settle at 5s with no unresolved cleanup", async () => {
  const { api, time } = lifecycle(); const c = api.spawnOwned("fixture", []);
  const done = api.stopOwnedChild(c); assert.equal(api.stopOwnedChild(c), done);
  const rejection = assert.rejects(done, /exit was not confirmed/);
  c.emit("error", new Error("signal failed")); // An error is not evidence of exit.
  time.tick(2999); assert.deepEqual(c.signals, ["SIGTERM"]);
  time.tick(1); assert.deepEqual(c.signals, ["SIGTERM", "SIGKILL"]);
  time.tick(2000); await rejection; assert.equal(time.size(), 0);
});

test("natural child exit/spawn failure clears ownership and cannot signal reused PIDs", async () => {
  const { api } = lifecycle();
  const done = api.spawnOwned("fixture", []), failed = api.spawnOwned("fixture", []);
  done.emit("exit", 0); failed.pid = undefined; failed.emit("error", new Error("spawn failure"));
  await api.stopApplication(); assert.deepEqual(done.signals, []); assert.deepEqual(failed.signals, []);
});

test("Linux detached ownership signals only its own group", async () => {
  const { api, groups } = lifecycle(false, "linux");
  const c = api.spawnOwned("fixture", [], { detached: true }); const done = api.stopOwnedChild(c);
  assert.deepEqual(groups, [[-123, "SIGTERM"]]); c.emit("exit", 0); await done;
});

test("real native child exits before coordinated shutdown resolves", async () => {
  const { api } = lifecycle(true);
  const c = api.spawnOwned(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await once(c.stdout, "data"); const exited = once(c, "exit");
    await api.stopApplication(); await exited;
    assert.ok(c.exitCode !== null || c.signalCode !== null);
  } finally { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); }
});

function services({ occupied = false, responses = [] as any[], startupExit = false } = {}) {
  const time = clock(), controller = new AbortController(), children: any[] = [], stopped: any[] = [], requests: any[] = [];
  const request = async (...args: any[]) => {
    requests.push(args); const value = responses.shift();
    if (value instanceof Error) throw value;
    return value || { status: 503, data: {} };
  };
  const api = load("utils/local-services.ts", {
    axios: { get: request, post: request }, "node:path": path,
    "node:net": { createServer() { const server: any = new EventEmitter();
      server.listen = (_port: number, _host: string, ready: () => void) => occupied ? server.emit("error", new Error("occupied")) : ready();
      server.close = (done: () => void) => done(); return server;
    } },
    "./operation-lifecycle": { checkCancelled(signal: AbortSignal) { if (signal.aborted) throw signal.reason; } },
    "./app-lifecycle": { appSignal: controller.signal,
      spawnOwned(command: string, args: string[], options: any) {
        const c = child(); Object.assign(c, { command, args, options }); children.push(c);
        if (startupExit) Promise.resolve().then(() => c.emit("exit", 1)); return c;
      }, async stopOwnedChild(c: any) { stopped.push(c); c.emit("exit", 0); },
    },
  }, time);
  return { api, time, controller, children, stopped, requests };
}
const whisper = { name: "Faster-Whisper", host: "localhost", port: 8803, path: "/recognize", args: ["fixture.py"] };
const whisperReady = { status: 400, data: { error: "Invalid JSON" } };
function pcmWav(length = 108588): Buffer {
  const wav = Buffer.alloc(length);
  wav.write("RIFF", 0); wav.writeUInt32LE(length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24); wav.writeUInt32LE(44100, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(length - 44, 40);
  return wav;
}

test("compatible external Whisper and Piper are reused without spawning or owning them", async () => {
  const f = services({ responses: [whisperReady, { status: 200, data: pcmWav() }] });
  await f.api.ensureLocalService(whisper);
  await f.api.ensureLocalService({ ...whisper, name: "Piper", path: "/synthesize" });
  assert.equal(f.children.length, 0); assert.equal(f.stopped.length, 0);
  assert.equal(JSON.stringify(f.requests[0][1]), "{}"); assert.equal(f.requests[0][2].signal, f.controller.signal);
  assert.equal(f.requests[0][2].timeout, 1500);
});

test("occupied incompatible port fails closed without starting/killing a process", async () => {
  const f = services({ occupied: true });
  await assert.rejects(f.api.ensureLocalService(whisper), /occupied.*nothing was stopped/);
  assert.equal(f.children.length, 0); assert.equal(f.stopped.length, 0);
});

test("Piper probes configured synthesis endpoint with bounded valid text", async () => {
  const f = services({ responses: [{ status: 200, data: pcmWav() }] });
  await f.api.prepareLocalServices({ TTS_SERVER: "piper-http", PIPER_HTTP_HOST: "127.0.0.1", PIPER_HTTP_PATH: "synthesize" });
  assert.equal(f.requests[0][0], "http://127.0.0.1:8805/synthesize");
  assert.equal(JSON.stringify(f.requests[0][1]), '{"text":"Hello."}');
  assert.equal(f.requests[0][2].timeout, 15000); assert.equal(f.requests[0][2].maxContentLength, 2 * 1024 * 1024);
  assert.equal(f.requests[0][2].responseType, "arraybuffer");
  assert.equal(f.children.length, 0); assert.equal(f.stopped.length, 0);
});

for (const [name, response] of [
  ["HTTP error", { status: 500, data: pcmWav() }],
  ["HTML", { status: 200, data: Buffer.from("<html>not audio</html>") }],
  ["truncated WAV", { status: 200, data: pcmWav().subarray(0, 100) }],
  ["invalid PCM format", { status: 200, data: (() => { const b = pcmWav(); b.writeUInt16LE(3, 20); return b; })() }],
  ["invalid chunk length", { status: 200, data: (() => { const b = pcmWav(); b.writeUInt32LE(999999, 40); return b; })() }],
  ["transport timeout", new Error("timeout")],
] as [string, any][]) test(`invalid Piper response fails closed without touching external service: ${name}`, async () => {
  const f = services({ occupied: true, responses: [response] });
  await assert.rejects(f.api.ensureLocalService({ ...whisper, name: "Piper", path: "/synthesize" }), /occupied/);
  assert.equal(f.children.length, 0); assert.equal(f.stopped.length, 0);
});

test("owned service waits for readiness and retains existing startup arguments", async () => {
  const f = services({ responses: [{ status: 503 }, whisperReady] });
  await f.api.prepareLocalServices({ ASR_SERVER: "faster-whisper", FASTER_WHISPER_PORT: "8803" });
  assert.equal(f.children.length, 1); assert.equal(f.children[0].command, "python3");
  assert.equal(f.children[0].args[0], path.resolve(__dirname, "../../python/speech-service/faster-whisper-host.py"));
  assert.deepEqual(Array.from(f.children[0].args.slice(1)), ["--port", "8803"]);
  assert.equal(f.stopped.length, 0); assert.equal(f.time.size(), 0);
});

test("startup failure cleans only the failed owned child; a fresh attempt can recover", async () => {
  const f = services({ startupExit: true });
  const rejection = assert.rejects(f.api.ensureLocalService(whisper), /exited/);
  await flush(); f.time.tick(250); await rejection;
  assert.deepEqual(f.stopped, f.children);
  const retry = services({ responses: [{ status: 503 }, whisperReady] });
  await retry.api.ensureLocalService(whisper); assert.equal(retry.children.length, 1);
});

test("startup timeout clears owned child/listeners and has a deterministic deadline", async () => {
  const f = services(); const work = f.api.ensureLocalService(whisper, 500);
  const rejection = assert.rejects(work, /startup timed out/);
  await flush(); f.time.tick(250); await flush(); f.time.tick(250); await rejection;
  assert.deepEqual(f.stopped, f.children); assert.equal(f.time.size(), 0);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
});

test("shutdown aborts startup wait, cleans its child, and removes the abort listener", async () => {
  const f = services(); const work = f.api.ensureLocalService(whisper);
  const rejection = assert.rejects(work, /cancelled/); await flush();
  f.controller.abort(new Error("cancelled")); await rejection;
  assert.equal(f.time.size(), 0); assert.deepEqual(f.stopped, f.children);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
});

test("remote/unselected services are untouched and invalid ports reject", async () => {
  const f = services();
  await f.api.ensureLocalService({ ...whisper, host: "external.invalid" });
  await f.api.prepareLocalServices({ ASR_SERVER: "test", TTS_SERVER: "test" });
  await assert.rejects(f.api.prepareLocalServices({ TTS_SERVER: "piper-http", PIPER_HTTP_PORT: "0" }), /Invalid/);
  assert.equal(f.requests.length, 0); assert.equal(f.children.length, 0);
});

test("real loopback probes distinguish compatible APIs, wrong APIs and occupied ports", async () => {
  let mode = "piper";
  const server = http.createServer((req, res) => {
    if (mode === "piper" && req.url === "/synthesize") {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        if (body !== '{"text":"Hello."}') { res.statusCode = 500; return res.end("<html>error</html>"); }
        res.setHeader("Content-Type", "text/html"); res.end(pcmWav());
      });
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 400;
    res.end(JSON.stringify({ error: mode === "whisper" ? "Invalid JSON" : "unrelated endpoint" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    assert.equal(await portAvailable(port, "127.0.0.1"), false);
    assert.equal(await compatibleService({ name: "Piper", host: "127.0.0.1", port, path: "/synthesize" }), true);
    mode = "whisper";
    assert.equal(await compatibleService({ ...whisper, host: "127.0.0.1", port }), true);
    mode = "wrong";
    assert.equal(await compatibleService({ ...whisper, host: "127.0.0.1", port }), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.equal(await portAvailable(port, "127.0.0.1"), true);
});

test("Piper probe rejects oversized responses and connection resets", async () => {
  let reset = false;
  const server = http.createServer((_req, res) => {
    if (reset) { res.destroy(); return; }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(Buffer.alloc(2 * 1024 * 1024 + 1));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    const service = { name: "Piper", host: "127.0.0.1", port, path: "/synthesize" };
    assert.equal(await compatibleService(service), false);
    reset = true; assert.equal(await compatibleService(service), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Linux bootstrap guard accepts only the expected inherited lock inode", () => {
  let env: Record<string, string> = {}, fd = { dev: 1, ino: 2 };
  const api = load("utils/app-launch-lock.ts", { "node:fs": {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, uid: 1000, dev: 1, ino: 2 }),
    fstatSync: (n: number) => { assert.equal(n, 9); return fd; },
  } }, { process: { platform: "linux", getuid: () => 1000, env } });
  assert.throws(() => api.requireLauncherLock(), /instance lock required/);
  env.WHISPLAY_APPLICATION_LOCK = "/tmp/whisplay-chatbot-1000/application.lock";
  assert.doesNotThrow(() => api.requireLauncherLock());
  fd = { dev: 1, ino: 3 }; assert.throws(() => api.requireLauncherLock(), /instance lock required/);
});

for (const failure of ["none", "lock", "port", "services"]) test(`bootstrap orders exclusive lock/readiness before hardware imports: ${failure}`, async () => {
  const events: string[] = [];
  load("index.ts", {
    dotenv: { config() { events.push("env"); } }, "node:fs": { existsSync: () => false },
    "./utils/app-launch-lock": { requireLauncherLock() { events.push("lock"); if (failure === "lock") throw Error("duplicate"); } },
    "./utils/app-lifecycle": { appSignal: { aborted: false }, installAppShutdown() {}, onAppShutdown() {}, shutdownApplication(code: number) { events.push(`exit${code}`); } },
    "./utils/local-services": { async portAvailable() { events.push("port"); return failure !== "port"; },
      async prepareLocalServices() { events.push("services"); if (failure === "services") throw Error("unready"); } },
    "./core/ChatFlow": { __esModule: true, default: class { constructor() { events.push("chat"); } } },
    "./device/display": {},
    "./status/battery-status": { startBatteryStatus() {} }, "./status/wifi-status": { startWifiStatus() {} },
    "./status/vpn-status": { startVpnStatus() {} },
  }, { process: { env: {} } });
  await flush();
  assert.deepEqual(events, failure === "none" ? ["lock", "env", "port", "services", "chat"]
    : failure === "lock" ? ["lock", "exit1"] : failure === "port" ? ["lock", "env", "port", "exit1"]
    : ["lock", "env", "port", "services", "exit1"]);
});

test("display connects only after its own child announces readiness; early exit fails", async () => {
  const spawned: any[] = [], exits: number[] = [], sockets: any[] = [], time = clock();
  const env: Record<string, string> = { WHISPLAY_DEVICE_ENABLED: "false" };
  const api = load("device/display.ts", {
    child_process: {}, fs: { existsSync: () => false }, path, dotenv: { config() {} }, "../utils": {},
    "./web-display": {}, "./web-audio-bridge": {},
    "../utils/app-lifecycle": { appSignal: { aborted: false }, onAppShutdown() {}, stopOwnedChild: async () => {},
      shutdownApplication: (code: number) => exits.push(code), spawnOwned: (...args: any[]) => { const c = child(); c.args = args; spawned.push(c); return c; } },
    net: { Socket: class extends EventEmitter {
      constructor() { super(); sockets.push(this); } setTimeout() {} destroy() {} write() {}
      connect(_port: number, _host: string, ready: () => void) { ready(); }
    } },
  }, { ...time, process: { env, on() {} } });
  env.WHISPLAY_DEVICE_ENABLED = "true";
  new api.WhisplayDisplay(); assert.equal(sockets.length, 0);
  assert.deepEqual(Array.from(spawned[0].args[1]), ["-u", "chatbot-ui.py"]);
  spawned[0].stdout.write("[Socket] Listen"); await flush(); assert.equal(sockets.length, 0);
  spawned[0].stdout.write("ing on 0.0.0.0:12345"); await flush(); assert.equal(sockets.length, 1);
  new api.WhisplayDisplay(); spawned[1].emit("exit", 1); await flush();
  assert.deepEqual(exits, [1]); assert.equal(sockets.length, 1); assert.equal(time.size(), 0);
});
