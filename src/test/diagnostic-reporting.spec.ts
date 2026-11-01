import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import cp from "node:child_process";
import axios from "axios";
import { diagnosticEvent, diagnosticFailure } from "../utils/diagnostic-events";
const cli = require("../../scripts/pi-latency.cjs");
const session = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const invoke = (args: string[], input?: string) => spawnSync(process.execPath,
  ["-r", "ts-node/register/transpile-only", "scripts/pi-latency.cjs", ...args], { encoding:"utf8", input,timeout:10000 });
const file = (rows: object[]) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"diagnostic-report-")), name=path.join(root,"voice.jsonl");
  fs.writeFileSync(name,rows.map(r=>JSON.stringify(r)).join("\n")); return name;
};

test("empty reports fail explicitly instead of returning a successful empty array", () => {
  const result=invoke(["report",file([])]);
  assert.equal(result.status,65);
  const value=JSON.parse(result.stdout);
  assert.equal(value.status,"failed");assert.equal(value.reason,"no_interaction_measurements");
});

test("startup/Python failure and original process exit survive collection and reporting", () => {
  const rows=[{kind:"diagnostic_event",session_id:session,event:"display_failure",phase:"startup",error_type:"OSError",frame:"chatbot-ui.py",line:1144},
    {kind:"diagnostic_session",session_id:session,event:"startup_failure",phase:"startup",reason:"display_failure"},
    {kind:"diagnostic_session",session_id:session,event:"end",phase:"cleanup",exit_code:17,app_exit_code:17,cleanup_verified:true}];
  const input="PRIVATE transcript\n"+rows.map(x=>JSON.stringify({...x,message:"PRIVATE password"})).join("\n")+"\n";
  const collected=invoke(["collect"],input);
  assert.equal(collected.status,17);assert.equal(collected.stdout.includes("PRIVATE"),false);
  const parsed=collected.stdout.trim().split("\n").map(x=>JSON.parse(x));
  const result=invoke(["report",file(parsed)]);
  assert.equal(result.status,17);const report=JSON.parse(result.stdout);
  assert.equal(report.status,"failed");assert.equal(report.sessions[0].error_type,"OSError");
  assert.equal(report.completed_interactions,0);
});

test("collector refuses an empty or wholly unrecognized session", () => {
  for(const input of ["","Private text only\n","{\"secret\":\"PRIVATE\"}\n"]){
    const result=invoke(["collect"],input);assert.equal(result.status,65);assert.equal(result.stdout,"");
  }
});

test("valid completed turns remain measurable while operator SIGINT status is preserved", () => {
  const id="123-"+session;
  const rows=[{id,event:"interaction_start",at_ms:0},{id,event:"interaction_end",at_ms:100,outcome:"completed"},
    {kind:"diagnostic_session",session_id:session,event:"cleanup_verified",phase:"cleanup",remaining:0},
    {kind:"diagnostic_session",session_id:session,event:"end",phase:"cleanup",exit_code:130,app_exit_code:0,cleanup_verified:true}];
  const result=invoke(["report",file(rows)]);assert.equal(result.status,130);
  const report=JSON.parse(result.stdout);assert.equal(report.status,"measured");assert.equal(report.completed_interactions,1);
});

test("production restart readiness requires verified release, even after a diagnostic startup failure", () => {
  for(const verified of [false,true]){
    const rows=[{kind:'diagnostic_session',session_id:session,event:'start',phase:'startup'},
      {kind:'diagnostic_session',session_id:session,event:'cleanup_verified',phase:'cleanup',remaining:0},
      {kind:'diagnostic_session',session_id:session,event:'end',phase:'cleanup',exit_code:17,cleanup_verified:verified}];
    const result=invoke(['verify-cleanup',file(rows)]);
    assert.equal(result.status,verified?0:1);
    if(verified)assert.equal(JSON.parse(result.stdout).verified,true);
    else assert.equal(JSON.parse(result.stdout).reason,'cleanup_unverified');
  }
});

test("completed interactions do not turn a missing session footer into a successful session", () => {
  const id='123-'+session;
  const rows=[{kind:'diagnostic_session',session_id:session,event:'start',phase:'startup'},
    {id,event:'interaction_end',outcome:'completed',at_ms:100}];
  const result=invoke(['report',file(rows)]);
  assert.equal(result.status,65);assert.equal(JSON.parse(result.stdout).status,'incomplete');
});

test("Node startup diagnostics are opt-in and expose codes rather than private messages", t => {
  const old=process.env.WHISPLAY_LATENCY_DIAGNOSTICS;
  t.after(()=>{if(old===undefined)delete process.env.WHISPLAY_LATENCY_DIAGNOSTICS;else process.env.WHISPLAY_LATENCY_DIAGNOSTICS=old;});
  const rows:string[]=[];t.mock.method(console,"log",(line:string)=>rows.push(line));
  delete process.env.WHISPLAY_LATENCY_DIAGNOSTICS;diagnosticEvent("display_ready");assert.equal(rows.length,0);
  process.env.WHISPLAY_LATENCY_DIAGNOSTICS="true";
  diagnosticFailure(Object.assign(new Error("PRIVATE token"),{code:"MODULE_NOT_FOUND"}));
  assert.equal(rows.length,1);assert.match(rows[0],/module_missing/);assert.equal(rows[0].includes("PRIVATE"),false);
  assert.doesNotThrow(()=>diagnosticFailure({code:'__proto__',message:{secret:'PRIVATE'}}));
  assert.match(rows.at(-1)!,/startup_failed/);assert.equal(rows.at(-1)!.includes('PRIVATE'),false);
});

test("display prerequisites report missing resources before any display process can start", t => {
  const messages:string[]=[];t.mock.method(console,"log",(line:string)=>messages.push(line));
  t.mock.method(cp,"spawnSync",(_command:any,args:any)=>{
    assert.ok(args.includes("--preflight"));
    return {status:1,stdout:JSON.stringify({kind:"display_preflight",ok:false,hardware_initialized:false,checks:[{resource:"base_font",ok:false}]}),stderr:"PRIVATE"};
  });
  assert.throws(()=>cli.displayPreflight({}),/Display prerequisites failed/);
  assert.equal(JSON.parse(messages[0]).checks[0].resource,"base_font");assert.equal(messages[0].includes("PRIVATE"),false);
});

test("preflight rejects stale emitted files before application launch", t => {
  t.mock.method(fs,"readFileSync",()=>"WHISPLAY_LATENCY_DIAGNOSTICS");
  assert.throws(()=>cli.compiledBuild(),/missing or stale/);
});

test("read-only voice preflight does not require or acquire the production application lock", async t => {
  const saved={...process.env};
  Object.assign(process.env,{LLM_SERVER:"ollama",OLLAMA_MODEL:"qwen3.5:2b-q4_K_M",ASR_SERVER:"faster-whisper",TTS_SERVER:"piper-http",ASSISTANT_PERSONA:"glados",GLADOS_PERSONA_VARIANT:"A",ENABLE_THINKING:"false",WEB_AUDIO_ENABLED:"false"});
  delete process.env.SYSTEM_PROMPT;
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
  const read=fs.readFileSync;
  t.mock.method(fs,"readFileSync",(...args:any[])=>args[0]==="/proc/device-tree/model"?"Raspberry Pi 5":args[0]===".env"?Buffer.from(""):(read as any)(...args));
  t.mock.method(fs,"readlinkSync",()=>{throw new Error("Production lock must not be inspected/acquired");});
  t.mock.method(cp,"spawnSync",()=>({status:0,stdout:JSON.stringify({kind:"display_preflight",ok:true,hardware_initialized:false})}));
  t.mock.method(console,"log",()=>{});
  t.mock.method(axios,"get",async()=>({data:{version:"unexpected"}}));
  await assert.rejects(cli.main(["voice-check","--confirm-idle"]),/Unexpected Ollama version/);
});
