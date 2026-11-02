import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import axios from "axios";
import { deviceResultSpeech } from "../config/device-result-speech";

test("operating speech never promotes unavailable capabilities or changes metric labels", () => {
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED = "true";
  const caps = deviceResultSpeech("whisplay", '[success]' + JSON.stringify({ api:1, readable:['audio'],
    actions:{volume:{supported:true},recording:{supported:false},shutdown:{supported:false}} }))!;
  assert.match(caps,/Available controls are speaker volume/);
  assert.match(caps,/Not available through this connection: GLaDOS recording lock, shutdown/);
  const health = deviceResultSpeech("getSystemHealth", '[success]'+JSON.stringify({
    cpu:{utilization:{value:7.5,unit:'%'}},temperature:{value:33.1,unit:'°C'},
    memory:{used:{value:1.11,unit:'GiB'},available:{value:14.52,unit:'GiB'}},disk:{available:{value:47.58,unit:'GiB'}} }))!;
  assert.match(health,/RAM used is 1.11 gibibytes, and RAM available is 14.52 gibibytes/);
  assert.match(health,/Storage available is 47.58 gibibytes/);
  assert.doesNotMatch(health,/healthy|adequate|partition|73/);
  delete process.env.WHISPLAY_VOICE_CONTROL_ENABLED;
});

for (const succeeds of [true,false]) test(`unexecuted success prose is held; bounded retry ${succeeds ? 'uses real dispatcher' : 'fails closed'}`, async t => {
  Object.assign(process.env,{WHISPLAY_VOICE_CONTROL_ENABLED:'true',LLM_SERVER:'ollama',OLLAMA_ENABLE_TOOLS:'true',
    WEB_SEARCH_ENABLED:'false',OLLAMA_MODEL:'fixture',ENABLE_THINKING:'false'});
  t.after(()=>{delete process.env.WHISPLAY_VOICE_CONTROL_ENABLED;});
  const socketPath=process.platform==='win32'?`\\\\.\\pipe\\voice-ground-${process.pid}-${succeeds}`:path.join(os.tmpdir(),`ground-${succeeds}.sock`);
  process.env.WHISPLAY_CONTROL_SOCKET=socketPath;
  const rpc:any[]=[];
  const server=net.createServer(connection=>connection.once('data',chunk=>{
    rpc.push(JSON.parse(chunk.toString()));
    connection.end(JSON.stringify({ok:true,payload:{status:'completed',action:'volume',previous:80,actual:70,unit:'%',verification:'mixer_readback'}})+'\n');
  }));
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{delete process.env.WHISPLAY_CONTROL_SOCKET;await new Promise<void>(resolve=>server.close(()=>resolve()));});
  let rounds=0;
  t.mock.method(axios,'get',async(url:string)=>({data:url.endsWith('/api/ps')?{models:[{name:'fixture',context_length:4096}]}:{model_info:{'fixture.context_length':4096}}}));
  t.mock.method(axios,'post',async(_url:string,body:any)=>{
    if (!body.messages?.length) return {data:{done:true}};
    const stream=new PassThrough();
    const round=rounds++;
    assert.ok(round<2,'at most one grounding retry');
    setImmediate(()=>stream.end(JSON.stringify({message:round===1&&succeeds?{content:'',tool_calls:[{function:{name:'whisplay',arguments:{action:'volume',change:-10}}}]}:{content:'I have already lowered the volume.'},done:true})+'\n'));
    return {data:stream};
  });
  for(const file of ['../config/llm-tools','../cloud-api/local/ollama-llm'])delete require.cache[require.resolve(file)];
  const provider=require('../cloud-api/local/ollama-llm').default;
  const parts:string[]=[];
  await provider.chatWithLLMStream([{role:'user',content:'Could you work out how to adjust your speaker so it is a little quieter?'}],(part:string)=>parts.push(part),()=>{});
  assert.equal(rounds,2);
  assert.doesNotMatch(parts.join(''),/already lowered/);
  assert.equal(rpc.length,succeeds?1:0);
  assert.match(parts.join(''),succeeds?/Speaker volume is set to 70 percent/:/No change was confirmed/);
});
