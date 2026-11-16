import fs from "node:fs";
import path from "node:path";
import { tvAdjustVolume } from "./lg-c1-volume";
import type { TvAdjustResult, TvAudioState, TvPlan } from "./lg-c1-volume";
import { onAppShutdown } from "../utils/app-lifecycle";

// Automatic TV volume ducking for one voice conversation (TV_DUCKING=1, default off).
// begin(): Capri heard the wake word -> lower the LG C1 once, in the background (the microphone never waits for it).
// end():   the conversation is over (ChatFlow back in "sleep") -> restore, but ONLY if the TV still shows the volume we set.
// Follow-ups (clarification, question) never pass through "sleep", so the TV stays lowered across them.
// A tiny state file lets a restart or crash recover; it is trusted only while fresh and only if the TV still matches it.

type Tv = (decide: (current: TvAudioState) => TvPlan | Promise<TvPlan>) => Promise<TvAdjustResult>;
type DuckRecord = { before: number; ducked: number; output?: string; at: number };
type Options = { tv?: Tv; env?: NodeJS.ProcessEnv; now?: () => number; stateFile?: string; log?: (line: string) => void; idleMs?: number };

const defaultStateFile = path.resolve(__dirname, "../../data/.glados-tv/duck-state.json");
const STATE_TTL_MS = 10 * 60_000;   // a leftover older than this is obsolete and is deleted, never applied
const UNREACHABLE_PAUSE_MS = 30_000;   // after "TV unavailable" do not probe again for a while

export class TvDucker {
  private phase: "idle" | "ducking" | "ducked" | "restoring" = "idle";
  private record?: DuckRecord;
  private wantEnd = false;
  private rebegin = false;
  private unreachableUntil = 0;
  private watchdog?: NodeJS.Timeout;
  private readonly tv: Tv;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly stateFile: string;
  private readonly log: (line: string) => void;
  private readonly idleMs?: number;

  constructor(options: Options = {}) {
    this.tv = options.tv ?? tvAdjustVolume;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.stateFile = options.stateFile ?? defaultStateFile;
    this.log = options.log ?? (line => console.info(line));
    this.idleMs = options.idleMs;
  }

  get enabled(): boolean { return ["1", "true"].includes((this.env.TV_DUCKING ?? "").trim().toLowerCase()); }
  get active(): boolean { return this.phase !== "idle"; }

  /** Target volume for a current volume, or undefined when the TV is already quiet enough that ducking would not help. */
  private plan(current: number): number | undefined {
    const raw = parseInt((this.env.TV_DUCK_PERCENT ?? "").trim(), 10);
    const percent = Number.isFinite(raw) ? Math.min(90, Math.max(10, raw)) : 40;
    const target = Math.max(3, Math.round(current * percent / 100));
    return current <= 6 || target > current - 3 ? undefined : target;
  }

  private readState(): DuckRecord | undefined {
    try {
      const value = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const ok = [value?.before, value?.ducked, value?.at].every(n => Number.isInteger(n)) && value.before >= 0 && value.before <= 100 &&
        value.ducked >= 0 && value.ducked <= 100 && (value.output === undefined || typeof value.output === "string");
      return ok ? value as DuckRecord : undefined;
    } catch { return undefined; }
  }

  private writeState(record: DuckRecord): void {
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flush: true });
      fs.renameSync(temp, this.stateFile);
    } catch { fs.rmSync(temp, { force: true }); throw new Error("duck state not persisted"); }
  }

  private clearState(): void { fs.rmSync(this.stateFile, { force: true }); }
  private fresh(record: DuckRecord): boolean { const age = this.now() - record.at; return age >= 0 && age < STATE_TTL_MS; }

  /** Wake word heard: lower the TV once for this conversation. Never awaited by the caller. */
  begin(): void {
    if (!this.enabled) return;
    if (this.phase === "restoring") { this.rebegin = true; return; }
    if (this.phase !== "idle") { this.wantEnd = false; this.touch(); return; }   // one session at a time: no second duck
    if (this.now() < this.unreachableUntil) return;
    this.phase = "ducking";
    this.wantEnd = false;
    void this.runBegin().catch(() => { this.phase = "idle"; });
  }

  private async runBegin(): Promise<void> {
    const started = this.now();
    let adopted: DuckRecord | undefined;
    let planned: DuckRecord | undefined;
    const result = await this.tv(async current => {
      if (this.wantEnd) return { skip: "conversation already ended" };   // a slow connection must not lower the TV after the conversation
      if (current.muted) return { skip: "muted" };   // never unmute, never touch a muted TV
      const leftover = this.readState();
      if (leftover && this.fresh(leftover) && leftover.output === current.output && leftover.ducked === current.value) {
        adopted = leftover;   // an earlier restore could not run: this TV is still at our level, keep the original volume
        return { skip: "already ducked" };
      }
      const target = this.plan(current.value);
      if (target === undefined) return { skip: "already quiet" };
      planned = { before: current.value, ducked: target, output: current.output, at: this.now() };
      this.writeState(planned);   // persisted BEFORE the command: a crash around it is recoverable
      return { target };
    });
    const ms = this.now() - started;
    if (result.status === "SET") {
      this.record = planned; this.phase = "ducked";
      this.log(`[TV duck] begin status=SET before=${result.before} ducked=${result.actual} total_ms=${ms}`);
    } else if (result.status === "UNVERIFIED") {
      this.record = planned; this.phase = planned ? "ducked" : "idle";
      this.log(`[TV duck] begin status=UNVERIFIED before=${result.before} actual=${result.actual ?? "-"} total_ms=${ms}`);
    } else if (result.status === "SKIPPED" && adopted) {
      this.record = adopted; this.phase = "ducked";
      this.log(`[TV duck] begin status=ADOPTED before=${adopted.before} ducked=${adopted.ducked}`);
    } else {
      if (result.status === "UNAVAILABLE") this.unreachableUntil = this.now() + UNREACHABLE_PAUSE_MS;
      if (planned) this.clearState();
      this.phase = "idle";
      this.log(`[TV duck] begin status=${result.status === "SKIPPED" ? "SKIPPED reason=" + result.reason : result.status} total_ms=${ms}`);
    }
    if (this.phase === "ducked") this.touch();
    if (this.wantEnd) this.end();
  }

  /** Keeps the safety timer honest: any flow activity postpones it. */
  touch(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
    if (this.phase !== "ducked" && this.phase !== "ducking") return;
    const raw = parseInt((this.env.TV_DUCK_IDLE_SECONDS ?? "").trim(), 10);
    const ms = this.idleMs ?? (Number.isFinite(raw) ? Math.min(600, Math.max(15, raw)) : 120) * 1000;
    this.watchdog = setTimeout(() => { this.watchdog = undefined; this.log("[TV duck] safety timer"); this.end(); }, ms);
    this.watchdog.unref?.();
  }

  /** The conversation is over (or never started): restore, but only when the TV still shows the volume we set. */
  end(): void {
    if (this.phase === "ducking") { this.wantEnd = true; return; }
    if (this.phase === "restoring") { this.rebegin = false; return; }   // a wake word queued behind this restore belongs to a conversation that is already over
    if (this.phase !== "ducked" || !this.record) return;
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = undefined; }
    this.phase = "restoring";
    const record = this.record;
    void this.runEnd(record).catch(() => undefined).finally(() => {
      this.record = undefined; this.phase = "idle";
      if (this.rebegin) { this.rebegin = false; this.begin(); }
    });
  }

  private async runEnd(record: DuckRecord): Promise<void> {
    const started = this.now();
    const result = await this.tv(current => {
      if (current.muted) return { skip: "muted" };                      // the user muted: leave it
      if (current.output !== record.output) return { skip: "output changed" };
      if (current.value !== record.ducked) return { skip: "volume changed by user" };
      return { target: record.before };
    });
    const ms = this.now() - started;
    if (result.status === "UNAVAILABLE" || result.status === "UNVERIFIED") {
      // Not restored and not claimed as restored; the fresh state file stays for a restart or the next conversation.
      this.log(`[TV duck] end status=${result.status} NOT_RESTORED total_ms=${ms}`);
      return;
    }
    this.clearState();   // restored, or the TV no longer matches: the record is complete or obsolete
    this.log(result.status === "SET" ? `[TV duck] end status=RESTORED volume=${result.actual} total_ms=${ms}` : `[TV duck] end status=LEFT reason=${result.reason} total_ms=${ms}`);
  }

  /** Startup: finish a restore a crash or restart interrupted, only while the record is fresh and the TV still matches. */
  async recover(): Promise<void> {
    const record = this.readState();
    if (!record) { if (fs.existsSync(this.stateFile)) this.clearState(); return; }
    if (!this.fresh(record)) { this.clearState(); this.log("[TV duck] recovery: obsolete state removed"); return; }
    this.phase = "restoring";
    try { await this.runEnd(record); } finally { this.phase = "idle"; if (this.rebegin) { this.rebegin = false; this.begin(); } }
  }

  /** Application shutdown: best effort. If it cannot finish, the state file lets the next start recover. */
  shutdown(): void {
    if (this.phase === "ducked") this.end();
  }
}

export const tvDucker = new TvDucker();
onAppShutdown(() => tvDucker.shutdown());
