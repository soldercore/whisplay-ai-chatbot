import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import axios from "axios";
import { PassThrough } from "node:stream";

test("simple commands execute centrally with zero inference, accurate history and unchanged fallback",async t=>{
  Object.assign(process.env,{WHISPLAY_VOICE_CONTROL_ENABLED:"true",LLM_SERVER:"ollama",OLLAMA_ENABLE_TOOLS:"true",
    WEB_SEARCH_ENABLED:"false",OLLAMA_MODEL:"fixture",ENABLE_THINKING:"false"});
  const socketPath=process.platform==="win32"?`\\\\.\\pipe\\fast-device-${process.pid}`:path.join(os.tmpdir(),`fast-device-${process.pid}.sock`);
  process.env.WHISPLAY_CONTROL_SOCKET=socketPath;
  let volume=80;const requests:any[]=[];
  const server=net.createServer(c=>c.once("data",chunk=>{
    const r=JSON.parse(chunk.toString());requests.push(r);
    let payload:any;
    if(r.cmd==="control.read")payload=r.payload.scope==="services"?{services:{ssh:"Running"},glados:"Running"}:{speaker_percent:volume};
    else if(r.payload.action==="volume"){
      const previous=volume;volume=r.payload.level??volume+r.payload.change;
      payload={status:"completed",action:"volume",previous,actual:volume,unit:"%"};
    }else if(r.payload.action==="home")payload={status:"awaiting_speech_handoff",action:"home",ticket:"c".repeat(32),changed:false};
    else payload={services:{ssh:"Running"},glados:"Running"};
    c.end(JSON.stringify({ok:true,payload})+"\n");
  }));
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{delete process.env.WHISPLAY_CONTROL_SOCKET;delete process.env.WHISPLAY_VOICE_CONTROL_ENABLED;await new Promise<void>(resolve=>server.close(()=>resolve()));});
  let inference=0;
  t.mock.method(axios,"get",async(url:string)=>({data:url.endsWith('/api/ps')?{models:[{name:'fixture',context_length:4096}]}:{}}));
  t.mock.method(axios,"post",async(_url:string,body:any)=>{
    if(!body.messages?.length)return {data:{done:true}};
    inference++;
    const question=[...body.messages].reverse().find((m:any)=>m.role==='user')?.content||'';
    const privateProposal={function:{name:'whisplay',arguments:{action:'wifi_join',network:'Synthetic Lab',password:'SyntheticToolPassword99'}}};
    const message=question.includes('native proposal')?{content:'',tool_calls:[privateProposal]}:
      question.includes('JSON proposal')?{content:JSON.stringify({name:'whisplay',arguments:privateProposal.function.arguments})}:
      question.includes('work out how')?{content:'',tool_calls:[{function:{name:'whisplay',arguments:{action:'volume',change:-20}}}]}:{content:"A normal conversational reply."};
    const stream=new PassThrough();setImmediate(()=>stream.end(JSON.stringify({message,done:true})+'\n'));
    return {data:stream};
  });
  for(const file of ['../config/llm-tools','../cloud-api/local/ollama-llm'])delete require.cache[require.resolve(file)];
  const provider=require('../cloud-api/local/ollama-llm').default;
  const ask=async(question:string)=>{let reply="";let ends=0;await provider.chatWithLLMStream([{role:'user',content:question}],(p:string)=>reply+=p,()=>ends++);assert.equal(ends,1);return reply;};
  assert.match(await ask("Turn your volume down a little."),/70 percent/);
  assert.equal(inference,0,"no model round to interpret or rewrite a simple command");
  assert.equal(volume,70);
  await ask("Turn volume down by 30%");
  assert.equal(volume,40,"explicit relative amount uses live state and absolute daemon setting");
  await ask("Set volume to 73 percent");assert.equal(volume,73);
  assert.match(await ask("Can you check whether SSH is working?"),/SSH is running/);
  assert.match(await ask("Take me back to Home."),/Home after this reply/);
  for (const phrase of ["Go Home.","Bring me Home.","Exit GLaDOS.","Close GLaDOS.","Turn off GLaDOS."]) {
    const start=requests.length;
    assert.match(await ask(phrase),/Home after this reply/);
    assert.deepEqual(requests.slice(start).map(r=>[r.cmd,r.payload.action]),[["control.execute","home"]]);
    assert.equal(inference,0,"clear exit never calls Qwen");
  }
  const privateStart=requests.length;
  assert.match(await ask("My Wi-Fi password is SyntheticPrivateValue99"),/local Network screen/);
  assert.equal(requests.length,privateStart);assert.equal(inference,0);
  assert.ok(!requests.some(r=>r.cmd==='control.present'),'handoff remains owned by speech/memory completion');
  const calls=requests.length;
  process.env.OLLAMA_ENABLE_TOOLS="false";
  assert.match(await ask("Turn volume down a little"),/No change was confirmed/);
  assert.equal(requests.length,calls,"disabled tools cannot execute on fast path");
  process.env.OLLAMA_ENABLE_TOOLS="true";
  assert.equal(inference,0);
  assert.match(await ask("Tell me a short joke about robots."),/normal conversational reply/);
  assert.equal(inference,1,"ordinary conversation keeps Qwen");
  assert.match(await ask("Could you work out how to adjust your volume so it is a little quieter?"),/63 percent/);
  assert.equal(inference,2,"uncertain phrasing still uses Qwen, with no result-rewrite generation");
  assert.equal(volume,63,"host enforces 10 even when fallback model proposes 20");
  const toolLogs:string[]=[];
  t.mock.method(console,'log',(...args:any[])=>toolLogs.push(args.map(String).join(' ')));
  const beforePrivate=requests.length;
  await ask("Inspect my WiFi native proposal");
  await ask("Inspect my WiFi JSON proposal");
  assert.equal(requests.length,beforePrivate,"unsupported credential parameters never reach device IPC");
  assert.ok(!toolLogs.join(' ').includes('SyntheticToolPassword99'),"native and JSON tool logs redact invalid credential fields");
  const {chatHistoryDir}=require('../utils/dir');
  const file=fs.readdirSync(chatHistoryDir).map((n:string)=>path.join(chatHistoryDir,n)).sort((a:string,b:string)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  const history=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.ok(!JSON.stringify(history).includes('SyntheticPrivateValue99'));
  assert.ok(!JSON.stringify(history).includes('SyntheticToolPassword99'));
  assert.ok(history.some((m:any)=>m.role==='user'&&m.content==='Turn your volume down a little.'));
  assert.ok(history.some((m:any)=>m.role==='tool'&&m.content.includes('"actual":70')));
  assert.ok(history.some((m:any)=>m.role==='assistant'&&m.content==='Speaker volume is set to 70 percent.'));
});
