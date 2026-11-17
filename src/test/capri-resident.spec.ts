import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

// The resident Capri process (CAPRI_RESIDENT, default on): the REAL WakeWordListener against a fake Python child that speaks the
// stdin protocol (resume / pause, CAPRI_PAUSED only after its microphone is closed). One microphone owner at all times.
process.env.CAPRI_WAKE_WORD_ENABLED = "true";
delete process.env.CAPRI_RESIDENT;

type Mode = "normal" | "ignore-pause" | "ignore-resume" | "broken-stdin" | "never-exits";
const mic = { owners: 0, max: 0 };
const children: FakeResident[] = [];
let nextMode: Mode[] = [];
let stdio: unknown[] = [];

class FakeResident extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); alive = true; listening = false; pid: number; commands: string[] = [];
  stdin: Writable;
  constructor(pid: number, public mode: Mode) {
    super();
    this.pid = pid;
    this.stdin = new Writable({ write: (chunk, _enc, done) => {
      if (this.mode === "broken-stdin" || !this.alive) return done(new Error("EPIPE"));
      for (const line of chunk.toString().split("\n").filter(Boolean)) this.command(line);
      done();
    } });
    setTimeout(() => this.say("CAPRI_PAUSED"), 5);               // the detector is loaded; no microphone yet
  }
  say(line: string) { if (this.alive) this.stdout.write(`${line}\n`); }
  open() { this.listening = true; mic.owners += 1; mic.max = Math.max(mic.max, mic.owners); }
  close() { if (this.listening) { this.listening = false; mic.owners -= 1; } }
  command(line: string) {
    this.commands.push(line);
    if (line === "resume" && this.mode !== "ignore-resume" && !this.listening) {
      this.say("CAPRI_RESUMED");
      setTimeout(() => { if (this.alive && !this.listening) { this.open(); this.say("CAPRI_READY"); } }, 3);
    } else if (line === "pause" && this.mode !== "ignore-pause") {
      setTimeout(() => { this.close(); this.say("CAPRI_PAUSED"); }, 4);   // SoX exits first, then the acknowledgement
    }
  }
  heardCommand(text: string) {            // what the script does after a command: close the microphone, then acknowledge
    this.say(`CAPRI_COMMAND ${JSON.stringify(text)}`);
    setTimeout(() => { this.close(); this.say("CAPRI_PAUSED"); }, 4);
  }
  crash() { this.close(); this.alive = false; this.emit("exit", 1); this.emit("close", 1); }
}

const appSignal = { aborted: false };
const fakeLifecycle = {
  appSignal,
  spawnOwned: (_cmd: string, _args: string[], options: any) => {
    stdio.push(options.stdio[0]);
    const child = new FakeResident(2000 + children.length, nextMode.shift() ?? "normal");
    children.push(child);
    return child;
  },
  stopOwnedChild: (child: FakeResident) => new Promise<void>((resolve, reject) => setTimeout(() => {
    if (child.mode === "never-exits") return reject(new Error("Owned child exit was not confirmed"));
    child.close(); child.alive = false; child.emit("exit", null); child.emit("close", null); resolve();
  }, 5)),
};
const load = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  return request === "../utils/app-lifecycle" ? fakeLifecycle : load.call(this, request, parent, isMain);
};
const { WakeWordListener } = require("../device/wakeword");
(Module as any)._load = load;
WakeWordListener.timeouts = { loadMs: 300, resumeMs: 80, pauseMs: 80 };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = () => children.filter(c => c.alive);
async function done(listener: any) {    // teardown: nothing wanted, every fake process gone (no retry can leak into the next test)
  await listener.stop().catch(() => undefined);
  for (const child of alive()) child.crash();
}
function reset(...modes: Mode[]) { children.length = 0; mic.owners = 0; mic.max = 0; nextMode = modes; stdio = []; }

test("fifty pause/resume cycles reuse one process; stop resolves only after the microphone is closed", async () => {
  reset();
  const listener = new WakeWordListener(true);
  let ready = 0;
  listener.on("ready", () => { ready += 1; });
  for (let i = 0; i < 50; i++) {
    listener.start();
    await wait(25);
    assert.equal(mic.owners, 1, `cycle ${i}: listening`);
    await listener.stop();
    assert.equal(mic.owners, 0, `cycle ${i}: stop resolved while the microphone was still open`);
  }
  assert.equal(children.length, 1, "the model is loaded once");
  assert.deepEqual(stdio, ["pipe"]);
  assert.equal(mic.max, 1);
  assert.equal(ready, 50);
  await done(listener);
});

test("rapid and overlapping start/stop never makes two microphone owners and ends in the last requested state", async () => {
  reset();
  const listener = new WakeWordListener(true);
  const stops: Promise<void>[] = [];
  listener.start();
  stops.push(listener.stop());              // while loading
  listener.start();
  await wait(12);                           // a resume is pending
  stops.push(listener.stop());
  listener.start();
  stops.push(listener.stop());
  listener.start();                         // the last request: listening
  for (const stopped of stops) await stopped;
  await wait(60);
  assert.equal(mic.max, 1);
  assert.equal(mic.owners, 1);
  assert.equal(children.length, 1);
  const released = listener.stop();
  listener.stop();
  await released;
  assert.equal(mic.owners, 0);
  const paused = children[0].commands.filter(c => c === "pause").length;
  await listener.stop();                    // already paused: nothing is sent, resolves at once
  assert.equal(children[0].commands.filter(c => c === "pause").length, paused);
  await done(listener);
});

test("a command is handed to the app only after the pause acknowledgement, and the next start resumes the same process", async () => {
  reset();
  const listener = new WakeWordListener(true);
  const heard: { text: string; owners: number }[] = [];
  listener.on("command", (text: string) => heard.push({ text, owners: mic.owners }));
  listener.start();
  await wait(25);
  children[0].heardCommand("turn off the TV");
  children[0].say(`CAPRI_COMMAND ${JSON.stringify("ignored duplicate")}`);
  await wait(40);
  assert.deepEqual(heard, [{ text: "turn off the TV", owners: 0 }]);
  listener.start();
  await wait(25);
  assert.equal(mic.owners, 1);
  children[0].heardCommand("what time is it");
  await wait(40);
  assert.equal(heard.length, 2, "a new listen accepts its own command");
  assert.equal(children.length, 1);
  await done(listener);
});

test("a pause that is not acknowledged in time discards the process; the next start uses a new one", async () => {
  reset("ignore-pause");
  const listener = new WakeWordListener(true);
  listener.start();
  await wait(25);
  await listener.stop();
  assert.equal(children[0].alive, false, "killed with a confirmed exit");
  assert.equal(mic.owners, 0);
  assert.equal(alive().length, 0);
  listener.start();
  await wait(40);
  assert.equal(children.length, 2);
  assert.equal(mic.owners, 1);
  assert.equal(mic.max, 1);
  await done(listener);
});

test("a resume that is not acknowledged in time is restarted with a new process", async () => {
  reset("ignore-resume");
  const listener = new WakeWordListener(true);
  listener.start();
  await wait(160);
  assert.equal(children[0].alive, false);
  assert.equal(children.length, 2);
  assert.equal(mic.owners, 1);
  await done(listener);
});

test("a failed stdin write is treated like a lost process", async () => {
  reset("broken-stdin");
  const listener = new WakeWordListener(true);
  listener.start();
  await wait(60);
  assert.equal(children[0].alive, false);
  assert.equal(children.length, 2);
  assert.equal(mic.owners, 1);
  await done(listener);
});

test("an unexpected exit while listening restarts Capri; an exit while paused restarts it on the next start", async () => {
  reset();
  const listener = new WakeWordListener(true);
  let unavailable = 0;
  listener.on("unavailable", () => { unavailable += 1; });
  listener.start();
  await wait(25);
  children[0].crash();
  assert.equal(unavailable, 1);
  await wait(1600);                        // the existing 1.5 s retry
  assert.equal(children.length, 2);
  assert.equal(mic.owners, 1);
  await listener.stop();
  children[1].crash();                     // while paused and not wanted: no retry
  await wait(30);
  assert.equal(children.length, 2);
  listener.start();
  await wait(40);
  assert.equal(children.length, 3);
  assert.equal(mic.owners, 1);
  assert.equal(mic.max, 1);
  await done(listener);
});

test("a kill without a confirmed exit rejects stop and starts no second owner until the old process has exited", async () => {
  reset("never-exits");
  const listener = new WakeWordListener(true);
  children.length = 0;
  listener.start();
  await wait(25);
  children[0].mode = "never-exits";
  children[0].command = () => undefined;   // ignores the pause
  await assert.rejects(listener.stop());
  listener.start();
  await wait(60);
  assert.equal(children.length, 1, "no new process while the old one may still hold the microphone");
  children[0].crash();                     // it finally exits
  await wait(40);
  assert.equal(children.length, 2);
  await done(listener);
});

test("CAPRI_RESIDENT=0 keeps the former one-process-per-listen behaviour", async () => {
  reset();
  process.env.CAPRI_RESIDENT = "0";
  const listener = new WakeWordListener(true);
  delete process.env.CAPRI_RESIDENT;
  listener.start();
  await wait(10);
  await listener.stop();
  assert.equal(children[0].alive, false, "stop ends the process");
  listener.start();
  assert.equal(children.length, 2);
  assert.deepEqual(stdio, ["ignore", "ignore"]);
  assert.deepEqual(children[0].commands, []);
  await listener.stop();
});
