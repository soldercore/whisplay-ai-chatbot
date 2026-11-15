import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";

// TV ducking (TV_DUCKING) with a stateful fake LG C1 behind the same single-connection interface the real module offers.
const noop = () => {};
const fakeLifecycle = { appSignal: { aborted: false }, onAppShutdown: noop, spawnOwned: noop, stopOwnedChild: noop };
const load = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
  return request === "../utils/app-lifecycle" ? fakeLifecycle : load.call(this, request, parent, isMain);
};
const ducking = require("../device/tv-ducking");
(Module as any)._load = load;

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tv-duck-"));
let counter = 0;

class FakeTv {
  volume = 20; muted = false; output = "tv_speaker"; online = true; dropDuringSet = false; latency = 0; beforeSet: (() => void) | undefined;
  reads = 0; sets: number[] = [];
  fn = async (decide: (c: any) => any) => {
    this.reads += 1;
    if (this.latency) await wait(this.latency);   // slow connection / handshake
    if (!this.online) return { status: "UNAVAILABLE" };
    const current = { value: this.volume, output: this.output, muted: this.muted };
    const plan = await decide(current);
    if ("skip" in plan) return { status: "SKIPPED", reason: plan.skip, current };
    this.beforeSet?.();
    if (this.dropDuringSet) { this.online = false; return { status: "UNVERIFIED", before: current.value }; }
    this.sets.push(plan.target); this.volume = plan.target;
    return { status: "SET", before: current.value, actual: plan.target };
  };
}

function setup(Class: any = ducking.TvDucker, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const tv = new FakeTv();
  const stateFile = path.join(dir, `state-${counter++}.json`);
  const logs: string[] = [];
  const clock = { t: 1_000_000 };
  const make = () => new Class({ tv: tv.fn, env: { TV_DUCKING: "1", ...env }, stateFile, log: (l: string) => logs.push(l), now: () => clock.t, ...extra });
  return { tv, stateFile, logs, clock, ducker: make(), make };
}

test("TV on at 20: duck for the conversation, then restore to exactly 20 and clear the state", async () => {
  const { tv, stateFile, ducker } = setup();
  ducker.begin(); await wait(30);
  assert.equal(tv.volume, 8);
  assert.ok(fs.existsSync(stateFile));
  if (process.platform !== "win32") assert.equal(fs.statSync(stateFile).mode & 0o077, 0, "state file is private");
  ducker.end(); await wait(30);
  assert.equal(tv.volume, 20);
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(ducker.active, false);
});

test("disabled by default: no TV access at all", async () => {
  const { tv, ducker } = setup(ducking.TvDucker, { TV_DUCKING: "" });
  ducker.begin(); await wait(20); ducker.end(); await wait(20);
  assert.equal(tv.reads, 0);
});

test("TV off or unreachable: nothing changes, no state, and no repeated probing", async () => {
  const { tv, stateFile, ducker, clock } = setup();
  tv.online = false;
  ducker.begin(); await wait(20);
  assert.equal(tv.volume, 20); assert.equal(fs.existsSync(stateFile), false); assert.equal(ducker.active, false);
  ducker.begin(); await wait(20);
  assert.equal(tv.reads, 1, "second wake within 30 s does not probe the TV again");
  clock.t += 31_000; tv.online = true;
  ducker.begin(); await wait(30);
  assert.equal(tv.volume, 8, "works again once the pause is over");
});

test("already quiet: no change, no state", async () => {
  for (const volume of [0, 3, 6]) {
    const { tv, stateFile, ducker } = setup();
    tv.volume = volume;
    ducker.begin(); await wait(20);
    assert.equal(tv.volume, volume); assert.deepEqual(tv.sets, []); assert.equal(fs.existsSync(stateFile), false);
  }
  const { tv, ducker } = setup(); tv.volume = 7;
  ducker.begin(); await wait(20);
  assert.equal(tv.volume, 3, "7 is loud enough to duck");
});

test("muted TV stays muted and is never touched", async () => {
  const { tv, stateFile, ducker } = setup();
  tv.muted = true;
  ducker.begin(); await wait(20); ducker.end(); await wait(20);
  assert.equal(tv.muted, true); assert.deepEqual(tv.sets, []); assert.equal(fs.existsSync(stateFile), false);
});

test("the user mutes during the conversation: restore leaves the TV muted and alone", async () => {
  const { tv, ducker } = setup();
  ducker.begin(); await wait(30);
  tv.muted = true;
  ducker.end(); await wait(30);
  assert.equal(tv.muted, true); assert.equal(tv.volume, 8);
});

test("the user changes the volume during the conversation: respected, never overwritten", async () => {
  const { tv, stateFile, ducker } = setup();
  ducker.begin(); await wait(30);
  tv.volume = 12;
  ducker.end(); await wait(30);
  assert.equal(tv.volume, 12);
  assert.equal(fs.existsSync(stateFile), false, "the record is obsolete");
});

test("audio output changed: nothing is restored", async () => {
  const { tv, ducker } = setup();
  ducker.begin(); await wait(30);
  tv.output = "external_arc";
  ducker.end(); await wait(30);
  assert.equal(tv.volume, 8);
});

test("TV disconnects mid-conversation: not claimed restored; the next conversation adopts the original volume", async () => {
  const { tv, stateFile, ducker, logs } = setup();
  ducker.begin(); await wait(30);
  tv.online = false;
  ducker.end(); await wait(30);
  assert.ok(logs.some(l => /NOT_RESTORED/.test(l)) && !logs.some(l => /RESTORED volume/.test(l)));
  assert.ok(fs.existsSync(stateFile), "kept for recovery");
  tv.online = true;
  ducker.begin(); await wait(30);
  assert.equal(tv.volume, 8, "no second duck on top of the first");
  ducker.end(); await wait(30);
  assert.equal(tv.volume, 20, "original volume, not 8 -> 3");
});

test("ducking fails during the command: the TV is not trusted, the state stays for recovery", async () => {
  const { tv, stateFile, ducker, logs } = setup();
  tv.dropDuringSet = true;
  ducker.begin(); await wait(30);
  assert.ok(logs.some(l => /UNVERIFIED/.test(l)));
  assert.ok(fs.existsSync(stateFile));
});

test("crash while ducked: a restart restores once, only when the TV still matches the saved state", async () => {
  const first = setup();
  first.ducker.begin(); await wait(30);
  assert.equal(first.tv.volume, 8);
  const restarted = first.make();                       // new process, same state file and TV
  await restarted.recover();
  assert.equal(first.tv.volume, 20);
  assert.equal(fs.existsSync(first.stateFile), false);
  await restarted.recover();                            // nothing left to do
  assert.equal(first.tv.volume, 20);
});

test("restart with stale or no-longer-matching recovery data never restores blindly", async () => {
  // older than the limit
  const a = setup();
  a.ducker.begin(); await wait(30);
  a.clock.t += 11 * 60_000;
  await a.make().recover();
  assert.equal(a.tv.volume, 8, "stale state is not applied"); assert.equal(fs.existsSync(a.stateFile), false);
  // TV was changed after the crash
  const b = setup();
  b.ducker.begin(); await wait(30);
  b.tv.volume = 15;
  await b.make().recover();
  assert.equal(b.tv.volume, 15); assert.equal(fs.existsSync(b.stateFile), false);
  // TV is off
  const c = setup();
  c.ducker.begin(); await wait(30);
  c.tv.online = false;
  await c.make().recover();
  assert.equal(fs.existsSync(c.stateFile), true, "kept until it expires; nothing was claimed");
  // garbage state
  const d = setup();
  fs.writeFileSync(d.stateFile, "{not json");
  await d.make().recover();
  assert.equal(fs.existsSync(d.stateFile), false); assert.equal(d.tv.reads, 0);
});

test("one session at a time: repeated wakes do not duplicate ducking, follow-ups stay ducked", async () => {
  const { tv, ducker } = setup();
  ducker.begin(); ducker.begin(); ducker.begin(); await wait(30);
  ducker.begin(); await wait(20);
  assert.deepEqual(tv.sets, [8], "exactly one duck");
  assert.equal(tv.volume, 8);
  ducker.end(); await wait(30);
  assert.deepEqual(tv.sets, [8, 20]);
});

test("end while the duck is still in flight: restored right after it lands", async () => {
  const { tv, ducker } = setup();
  ducker.begin(); ducker.end(); await wait(60);
  assert.equal(tv.volume, 20);
});

test("a new wake word while the restore is running starts a fresh session afterwards", async () => {
  const { tv, ducker } = setup();
  ducker.begin(); await wait(30);
  ducker.end(); ducker.begin(); await wait(80);
  assert.equal(tv.volume, 8);
  ducker.end(); await wait(30);
  assert.equal(tv.volume, 20);
});

test("safety timer restores a conversation that never reaches idle", async () => {
  const { tv, ducker } = setup(ducking.TvDucker, {}, { idleMs: 60 });
  ducker.begin(); await wait(30);
  await wait(120);
  assert.equal(tv.volume, 20);
  const again = setup(ducking.TvDucker, {}, { idleMs: 80 });
  again.ducker.begin(); await wait(30);
  again.ducker.touch(); await wait(50); again.ducker.touch(); await wait(50);
  assert.equal(again.tv.volume, 8, "activity postpones the timer");
  await wait(120);
  assert.equal(again.tv.volume, 20);
});

test("TV_DUCK_PERCENT is clamped", () => {
  const plan = (percent: string, v: number) => (new ducking.TvDucker({ env: { TV_DUCKING: "1", TV_DUCK_PERCENT: percent }, tv: async () => ({}) }) as any).plan(v);
  assert.equal(plan("", 20), 8); assert.equal(plan("50", 20), 10); assert.equal(plan("0", 20), 3); assert.equal(plan("500", 50), 45);
});

// ---- Asynchronous safety -----------------------------------------------------------------------------------------------------
test("a delayed duck can never lower the TV after the conversation has ended", async () => {
  const { tv, stateFile, ducker } = setup();
  tv.latency = 80;                                   // the connection is slow
  ducker.begin(); await wait(20);
  ducker.end();                                      // the conversation is already over
  await wait(300);
  assert.equal(tv.volume, 20); assert.deepEqual(tv.sets, [], "nothing was ever sent"); assert.equal(fs.existsSync(stateFile), false);
  assert.equal(ducker.active, false);
});

test("the conversation ends after the duck decision but before the command lands: restored right after", async () => {
  const { tv, ducker } = setup();
  tv.beforeSet = () => ducker.end();                 // end() arrives exactly between the decision and the command
  ducker.begin(); await wait(60);
  assert.equal(tv.volume, 20); assert.equal(ducker.active, false);
});

test("rapid start/stop transitions never leave the volume lowered", async () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 40; round++) {
    const { tv, ducker } = setup(ducking.TvDucker, {}, { idleMs: 5000 });
    tv.latency = Math.floor(random() * 25);
    const operations = 2 + Math.floor(random() * 8);
    for (let i = 0; i < operations; i++) {
      if (i % 2 === 0) ducker.begin(); else ducker.end();
      await wait(Math.floor(random() * 20));
    }
    ducker.end();                                    // the final state is always "conversation over"
    await wait(300);
    assert.equal(tv.volume, 20, `round ${round}: restored (sets ${tv.sets})`);
    assert.equal(ducker.active, false, `round ${round}`);
  }
});

test("a wake word queued behind a restore is dropped when its conversation ends first", async () => {
  const { tv, ducker } = setup();
  ducker.begin(); await wait(30);
  tv.latency = 40;
  ducker.end(); ducker.begin(); ducker.end();        // restore running, new wake word, new conversation already over
  await wait(300);
  assert.equal(tv.volume, 20); assert.equal(ducker.active, false);
});

test("manual volume changes beat pending operations", async () => {
  // the user changes the volume while the duck is still connecting: it works from the volume the TV really has, and restores to that
  const a = setup(); a.tv.latency = 40; a.ducker.begin(); await wait(10); a.tv.volume = 15; await wait(120);
  assert.equal(a.tv.volume, 6);
  a.tv.latency = 0; a.ducker.end(); await wait(40);
  assert.equal(a.tv.volume, 15, "never jumps to a stale original");
  // the user changes the volume while a restore is pending
  const b = setup(); b.ducker.begin(); await wait(30);
  b.tv.latency = 40; b.ducker.end(); await wait(10); b.tv.volume = 17; await wait(120);
  assert.equal(b.tv.volume, 17, "the restore re-reads the TV after its connection is up");
});

test("a crash around any volume operation is recovered or left alone, never guessed", async () => {
  // crash after the state was saved but before the command was sent: the TV never changed, nothing to restore
  const a = setup(); a.tv.beforeSet = () => { throw new Error("process died"); };
  a.ducker.begin(); await wait(30);
  assert.equal(a.tv.volume, 20);
  a.tv.beforeSet = undefined; await a.make().recover();
  assert.equal(a.tv.volume, 20); assert.equal(fs.existsSync(a.stateFile), false);
  // crash after the command landed: restart restores
  const b = setup(); b.ducker.begin(); await wait(30);
  await b.make().recover();
  assert.equal(b.tv.volume, 20);
  // recovery is idempotent
  const c = setup(); c.ducker.begin(); await wait(30);
  const next = c.make(); await next.recover(); await next.recover();
  assert.equal(c.tv.volume, 20);
});

test("disabling the feature does not abandon a recoverable ducked volume", async () => {
  const { tv, stateFile, ducker, clock } = setup();
  ducker.begin(); await wait(30);
  assert.equal(tv.volume, 8);
  const disabled = new ducking.TvDucker({ tv: tv.fn, env: { TV_DUCKING: "0" }, stateFile, log: noop, now: () => clock.t });   // restart with the feature off
  assert.equal(disabled.enabled, false);
  await disabled.recover();
  assert.equal(tv.volume, 20, "recovery runs even though ducking is now off");
  assert.equal(fs.existsSync(stateFile), false);
  disabled.begin(); await wait(30);
  assert.equal(tv.volume, 20, "and a disabled ducker never lowers again");
});

test("the real TV adapter sends exactly one setVolume command and no ramp", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../device/lg-c1-volume.ts"), "utf8").replace(/\r\n/g, "\n");
  const body = source.slice(source.indexOf("export async function tvAdjustVolume"), source.indexOf('const appList = "ssap'));
  assert.equal(body.split("audio/setVolume").length - 1, 1);
  assert.doesNotMatch(body, /for \(let i|while \(|steps/);
});

// ---- The tests must fail when the safeguards are removed ---------------------------------------------------------------------
async function violations(Class: any): Promise<string[]> {
  const found: string[] = [];
  const check = (ok: boolean, what: string) => { if (!ok) found.push(what); };
  { const s = setup(Class); s.tv.muted = true; s.ducker.begin(); await wait(30); check(s.tv.volume === 20 && s.tv.sets.length === 0, "touched a muted TV"); }
  { const s = setup(Class); s.ducker.begin(); await wait(30); s.tv.volume = 12; s.ducker.end(); await wait(30); check(s.tv.volume === 12, "overrode the user's volume"); }
  { const s = setup(Class); s.ducker.begin(); await wait(30); s.tv.muted = true; s.ducker.end(); await wait(30); check(s.tv.sets.length === 1, "changed a muted TV on restore"); }
  { const s = setup(Class); s.ducker.begin(); await wait(30); s.tv.output = "external_arc"; s.ducker.end(); await wait(30); check(s.tv.volume === 8, "restored on another output"); }
  { const s = setup(Class); s.ducker.begin(); s.ducker.begin(); await wait(30); check(s.tv.sets.length === 1, "duplicated ducking"); }
  { const s = setup(Class); s.tv.volume = 5; s.ducker.begin(); await wait(30); check(s.tv.sets.length === 0, "changed an already quiet TV"); }
  { const s = setup(Class); s.tv.online = false; s.ducker.begin(); await wait(20); s.ducker.begin(); await wait(20); check(s.tv.reads === 1, "retried an unreachable TV"); }
  { const s = setup(Class); s.ducker.begin(); await wait(30); s.clock.t += 11 * 60_000; await s.make().recover(); check(s.tv.volume === 8, "applied stale recovery data"); }
  { const s = setup(Class); s.ducker.begin(); await wait(30); const state = fs.existsSync(s.stateFile); check(state, "no crash-recovery state before the first command"); }
  { const s = setup(Class); s.ducker.begin(); await wait(30); s.tv.online = false; s.ducker.end(); await wait(30); s.tv.online = true; s.ducker.begin(); await wait(30); s.ducker.end(); await wait(30); check(s.tv.volume === 20, "lost the original volume after a failed restore"); }
  { const s = setup(Class); s.tv.latency = 80; s.ducker.begin(); await wait(20); s.ducker.end(); await wait(300); check(s.tv.volume === 20 && s.tv.sets.length === 0, "a delayed duck lowered the TV after the conversation"); }
  { const s = setup(Class); s.ducker.begin(); await wait(30); s.tv.latency = 40; s.ducker.end(); s.ducker.begin(); s.ducker.end(); await wait(300); check(s.tv.volume === 20, "a stale wake word re-ducked after the conversation"); }
  return found;
}

test("the safeguards hold in the real implementation", async () => {
  assert.deepEqual(await violations(ducking.TvDucker), []);
});

test("every essential safeguard is caught by the tests when removed", async () => {
  const sourcePath = path.resolve(__dirname, "../device/tv-ducking.ts");
  const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
  const mutants: [string, string, string][] = [
    ["begin ignores mute", 'if (current.muted) return { skip: "muted" };   // never unmute, never touch a muted TV', ""],
    ["restore overrides user volume", 'if (current.value !== record.ducked) return { skip: "volume changed by user" };', ""],
    ["restore ignores mute", 'if (current.muted) return { skip: "muted" };                      // the user muted: leave it', ""],
    ["restore ignores output change", 'if (current.output !== record.output) return { skip: "output changed" };', ""],
    ["duplicate ducking allowed", 'if (this.phase !== "idle") { this.wantEnd = false; this.touch(); return; }', ""],
    ["stale state trusted", "return age >= 0 && age < STATE_TTL_MS;", "return true;"],
    ["quiet TV is ducked", "return current <= 6 || target > current - 3 ? undefined : target;", "return target;"],
    ["unreachable TV re-probed", "if (this.now() < this.unreachableUntil) return;", ""],
    ["state not saved before the command", "this.writeState(planned);", ""],
    ["leftover not adopted", "adopted = leftover;", ""],
    ["delayed duck lands after the conversation ended", 'if (this.wantEnd) return { skip: "conversation already ended" };', ""],
    ["queued wake word survives a finished conversation", "this.rebegin = false; return; }   // a wake word queued", "return; }   // a wake word queued"],
  ];
  for (const [name, from, to] of mutants) {
    assert.equal(source.split(from).length - 1, 1, `mutation point exists: ${name}`);
    const file = path.resolve(__dirname, `../device/.mutant-${counter++}.ts`);
    fs.writeFileSync(file, source.replace(from, to));
    try {
      (Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
        return request === "../utils/app-lifecycle" ? fakeLifecycle : load.call(this, request, parent, isMain);
      };
      const Mutant = require(file).TvDucker;
      (Module as any)._load = load;
      assert.notEqual((await violations(Mutant)).filter(Boolean).length, 0, `the tests do not notice: ${name}`);
    } finally { fs.rmSync(file, { force: true }); }
  }
});
