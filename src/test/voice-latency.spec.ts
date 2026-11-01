import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import cp from "node:child_process";
import { PassThrough } from "node:stream";
import axios from "axios";
import { beginVoiceTiming, currentVoiceTiming, finishVoiceTiming, modelTiming, segmentVoiceTiming,
  voiceEvent, withVoiceTiming } from "../core/audio-timing";
const cli = require("../../scripts/pi-latency.cjs");

function capture(t: any) {
  const old = process.env.WHISPLAY_LATENCY_DIAGNOSTICS;
  process.env.WHISPLAY_LATENCY_DIAGNOSTICS = "true";
  t.after(() => { if (old === undefined) delete process.env.WHISPLAY_LATENCY_DIAGNOSTICS; else process.env.WHISPLAY_LATENCY_DIAGNOSTICS = old; });
  const rows: any[] = [];
  t.mock.method(console, "log", (line: string) => { const r = cli.parseEvent(line); if (r) rows.push(r); });
  return rows;
}

test("timing is opt-in, ignores conversation fields and cannot fail the caller", t => {
  const rows = capture(t); delete process.env.WHISPLAY_LATENCY_DIAGNOSTICS;
  assert.equal(beginVoiceTiming("manual"), undefined);
  withVoiceTiming(undefined, () => voiceEvent("asr_start")); assert.equal(rows.length, 0);
  process.env.WHISPLAY_LATENCY_DIAGNOSTICS = "true";
  const ctx = beginVoiceTiming("manual");
  withVoiceTiming(ctx, () => voiceEvent("asr_start", { text: "Private conversation", secret: "credential", duration_ms: 12 }));
  assert.equal(JSON.stringify(rows).includes("Private"), false);
  assert.equal(JSON.stringify(rows).includes("credential"), false);
  assert.equal(rows.at(-1).duration_ms, 12);
  t.mock.method(console, "log", () => { throw new Error("closed output"); });
  assert.doesNotThrow(() => withVoiceTiming(ctx, () => voiceEvent("asr_complete")));
});

test("timings are monotonic despite a wall-clock adjustment", t => {
  const rows = capture(t); let clock = 100;
  t.mock.method(performance, "now", () => clock);
  const ctx = beginVoiceTiming("manual"); clock = 350;
  t.mock.method(Date, "now", () => -100000);
  voiceEvent("asr_start", {}, ctx);
  assert.equal(rows.at(-1).at_ms, 250);
});

test("interrupted asynchronous work cannot emit into a subsequent interaction", async t => {
  const rows = capture(t), old = beginVoiceTiming("manual");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = withVoiceTiming(old, async () => { voiceEvent("asr_start"); await gate; voiceEvent("asr_complete"); });
  finishVoiceTiming(old, "interrupted");
  const next = beginVoiceTiming("manual");
  await withVoiceTiming(next, async () => { release(); await pending; voiceEvent("asr_start"); });
  assert.equal(rows.filter(r => r.event === "asr_complete").length, 0);
  assert.equal(rows.filter(r => r.event === "asr_start").length, 2);
  assert.notEqual(old!.turn.id, next!.turn.id);
  assert.equal(currentVoiceTiming(), undefined);
});

test("segment contexts survive task scheduling under a different segment", async t => {
  const rows = capture(t), ctx = beginVoiceTiming("text");
  await withVoiceTiming(ctx, async () => {
    const one = segmentVoiceTiming(1), two = segmentVoiceTiming(2);
    await withVoiceTiming(two, () => Promise.resolve().then(() => withVoiceTiming(one, () => voiceEvent("tts_start"))));
  });
  assert.equal(rows.at(-1).id, ctx!.turn.id); assert.equal(rows.at(-1).segment, 1);
});

test("model rounds retain actual cache counts, missing fields, first-content and error state", t => {
  const rows = capture(t), ctx = beginVoiceTiming("text");
  withVoiceTiming(ctx, () => {
    const one = modelTiming(0); one.submit("qwen3.5:2b-q4_K_M", false);
    one.finish({ prompt_eval_count: 10, prompt_eval_cached_count: 0 });
    const two = modelTiming(1); two.submit("qwen3.5:2b-q4_K_M", false); two.content(); two.content();
    two.finish({ prompt_eval_cached_count: 91, eval_count: 4, eval_duration: 1e9 });
    const failed = modelTiming(null); failed.submit("qwen3.5:2b-q4_K_M", false); failed.finish(undefined, "timeout");
  });
  assert.equal(rows.filter(r => r.event === "llm_first_content").length, 1);
  const done = rows.filter(r => r.event === "llm_complete");
  assert.deepEqual(done.map(r => r.call), [1, 2, 3]);
  assert.equal(done[0].prompt_eval_cached_count, 0); assert.equal(done[0].eval_duration, null);
  assert.equal(done[1].prompt_eval_cached_count, 91); assert.equal(done[2].outcome, "timeout");
  assert.equal(done[2].prompt_eval_cached_count, null);
});

test("reports distinguish release proxy, generated text, synthesis, spawn and unavailable physical sound", () => {
  const events = [["capture_stop_requested",100], ["capture_finalized",120], ["asr_precheck_start",125],
    ["asr_start",140], ["asr_complete",500], ["llm_first_content",1500], ["speakable_segment",2000],
    ["tts_audio_ready",2500], ["playback_submit",2510], ["sox_spawn",2520], ["interaction_end",4000]]
    .map(([event,at_ms]) => ({ id:"x",event,at_ms,...(event === "interaction_end" ? { outcome:"completed" } : {}) }));
  const r = cli.report(events)[0];
  assert.equal(r.asr_ms,360); assert.equal(r.capture_finalization_ms,20);
  assert.equal(r.from_reference_ms.first_content,1400); assert.equal(r.from_reference_ms.first_speakable,1900);
  assert.equal(r.from_reference_ms.sox_process_spawn,2420); assert.equal(r.from_reference_ms.physically_audible_speech,null);
  assert.equal(r.from_reference_ms.actual_playback_start,null);
  assert.equal(cli.report(events.filter(r => r.event !== "capture_stop_requested"))[0].from_reference_ms.first_content,null);
  assert.equal(cli.report(events.filter(r => r.event !== "interaction_end"))[0].outcome,"incomplete");
});

test("thermal decoding separates active and historical throttling", () => {
  const historical = cli.throttle("throttled=0x50000");
  assert.equal(historical.active.throttled,false); assert.equal(historical.historical.throttled,true);
  const active = cli.throttle("throttled=0x5"); assert.equal(active.active.undervoltage,true);
  assert.equal(active.historical.undervoltage,false); assert.equal(cli.throttle(null),null);
});

test("metadata collection strips credentials, custom prompts and malformed log records", () => {
  const c = cli.safeConfig({ OLLAMA_MODEL:"qwen3.5:2b-q4_K_M", API_KEY:"secret", SYSTEM_PROMPT:"private", ENABLE_THINKING:"false" });
  assert.equal(c.OLLAMA_MODEL,"qwen3.5:2b-q4_K_M"); assert.equal(c.custom_system_prompt_present,true);
  assert.equal(JSON.stringify(c).includes("secret"),false); assert.equal(JSON.stringify(c).includes("private"),false);
  for (const line of ["Private conversation", "[AudioTiming] interaction null", "[AudioTiming] interaction []", "[AudioTiming] interaction invalid"]) assert.equal(cli.parseEvent(line),null);
});

test("benchmark refuses unexpected residency/context without automatic unload or configuration changes", () => {
  const digest = "b".repeat(64), model = { name:"qwen3.5:2b-q4_K_M",context_length:4096,digest };
  assert.doesNotThrow(() => cli.residency({ models:[model] },"warm",digest));
  assert.doesNotThrow(() => cli.residency({ models:[] },"cold",digest));
  for (const models of [[],[{ ...model,context_length:8192 }],[model,model],[{ ...model,digest:"a".repeat(64) }]]) assert.throws(() => cli.residency({ models },"warm",digest));
  assert.throws(() => cli.residency({ models:[model] },"cold",digest),/nothing was unloaded/);
  const show = { details:{ family:"qwen35",quantization_level:"Q4_K_M" } };
  assert.doesNotThrow(() => cli.localModel(show));
  assert.throws(() => cli.localModel({ ...show,remote_host:"https://example.com" }),/remote\/unknown/);
  assert.throws(() => cli.localModel({}),/remote\/unknown/);
});

test("benchmark endpoint is loopback-only and execution cannot start inference on PC/cloud", async () => {
  assert.equal(cli.endpointFor({ OLLAMA_ENDPOINT:"http://localhost:11434" }),"http://localhost:11434");
  for (const endpoint of ["http://example.com", "http://user:password@localhost", "http://localhost/api", "http://localhost?key=secret"]) assert.throws(() => cli.endpointFor({ OLLAMA_ENDPOINT:endpoint }));
  await assert.rejects(cli.main(["benchmark","identical","--confirm-idle"]),/PC\/cloud|application lock/);
  const plan = JSON.parse(execFileSync("bash",["scripts/pi-latency.sh","plan"],{encoding:"utf8"}));
  assert.equal(plan.model,"qwen3.5:2b-q4_K_M"); assert.equal(plan.options.num_predict,96); assert.equal(plan.thinking,false);
});

test("voice preflight refuses a wrong or unconfirmed baseline instead of restoring it", () => {
  const good = { OLLAMA_MODEL:"qwen3.5:2b-q4_K_M",LLM_SERVER:"ollama",ASSISTANT_PERSONA:"glados",GLADOS_PERSONA_VARIANT:"A",ENABLE_THINKING:"false",ASR_SERVER:"faster-whisper",TTS_SERVER:"piper-http" };
  assert.equal(cli.baselineConfig(good),"http://127.0.0.1:11434");
  for (const change of [{ OLLAMA_MODEL:"gemma4:e2b-it-q4_K_M" }, { GLADOS_PERSONA_VARIANT:"D" },
    { ENABLE_THINKING:undefined }, { SYSTEM_PROMPT:"Private" }, { TTS_SERVER:"other" }]) assert.throws(() => cli.baselineConfig({ ...good,...change }),/Nothing was changed/);
  assert.throws(() => cli.baselineConfig({ ...good,FASTER_WHISPER_HOST:"192.0.2.1" }),/Pi-local/);
  assert.throws(() => cli.baselineConfig({ ...good,WEB_AUDIO_ENABLED:"true" }),/Whisplay hardware/);
});

for (const mode of ["identical", "incremental", "cold"]) test(`benchmark ${mode} protocol uses fixed settings and preserves complete histories (simulated model only)`, async t => {
  const rows: any[] = [], requests: any[] = [], realRead = fs.readFileSync;
  const oldPersona = process.env.ASSISTANT_PERSONA, oldLock = process.env.WHISPLAY_APPLICATION_LOCK, oldSystem = process.env.SYSTEM_PROMPT;
  t.after(() => {
    for (const [key, old] of [["ASSISTANT_PERSONA", oldPersona], ["WHISPLAY_APPLICATION_LOCK", oldLock], ["SYSTEM_PROMPT", oldSystem]]) {
      if (old === undefined) delete process.env[key!]; else process.env[key!] = old;
    }
  });
  delete process.env.SYSTEM_PROMPT;
  const lock = `/tmp/whisplay-chatbot-${process.getuid!()}/application.lock`;
  process.env.WHISPLAY_APPLICATION_LOCK = lock;
  t.mock.method(fs, "readFileSync", (...args: any[]) => args[0] === "/proc/device-tree/model" ? "Raspberry Pi 5 Model B" : (realRead as any)(...args));
  t.mock.method(fs, "readlinkSync", () => lock);
  t.mock.method(cp, "execFileSync", () => { throw new Error("optional hardware utility unavailable"); });
  t.mock.method(console, "log", (line: string) => rows.push(JSON.parse(line)));
  const digest = "b".repeat(64), model = { name:"qwen3.5:2b-q4_K_M",digest,context_length:4096 };
  t.mock.method(axios, "get", async (url: string, opts: any) => {
    assert.equal(opts.proxy,false); assert.equal(opts.maxRedirects,0);
    if (url.endsWith("/api/version")) return { data:{ version:"0.34.4" } };
    if (url.endsWith("/api/tags")) return { data:{ models:[model] } };
    assert.ok(url.endsWith("/api/ps")); return { data:{ models:mode === "cold" && !requests.length ? [] : [model] } };
  });
  t.mock.method(axios, "post", async (url: string, body: any) => {
    if (url.endsWith("/api/show")) return { data:{ parameters:"presence_penalty 1.5",details:{ family:"qwen35",quantization_level:"Q4_K_M" } } };
    assert.ok(url.endsWith("/api/chat")); requests.push(JSON.parse(JSON.stringify(body)));
    const data = new PassThrough();
    setImmediate(() => data.end(JSON.stringify({ message:{content:"DNS maps names to addresses."},done:true,done_reason:"stop",eval_count:8,eval_duration:1e9,prompt_eval_count:40,prompt_eval_duration:2e9,prompt_eval_cached_count:requests.length > 1 ? 30 : 0 })+"\n"));
    return { data };
  });
  await cli.benchmark(mode,"http://127.0.0.1:11434");
  assert.equal(requests.length,mode === "cold" ? 1 : 3);
  for (const request of requests) {
    assert.equal(request.model,model.name); assert.equal(request.think,false); assert.equal(request.truncate,false); assert.deepEqual(request.tools,[]);
    assert.deepEqual(request.options,{temperature:0.7,top_k:20,top_p:0.95,presence_penalty:1.5,seed:42,num_ctx:4096,num_predict:96});
  }
  if (mode === "identical") assert.deepEqual(requests,[requests[0],requests[0],requests[0]]);
  if (mode === "incremental") {
    assert.deepEqual(requests.map(r => r.messages.length),[2,4,6]);
    assert.deepEqual(requests[2].messages.slice(0,2),requests[0].messages);
    assert.equal(requests[2].messages[2].content,"DNS maps names to addresses.");
  }
  assert.equal(rows.at(-1).kind,"benchmark_end");
  assert.equal(rows.filter(r => r.kind === "generation")[0].load_duration,null);
  assert.equal(JSON.stringify(rows).includes("DNS maps names to addresses."),false);
});
