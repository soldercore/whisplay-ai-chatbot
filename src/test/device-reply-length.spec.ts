import {test} from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import {PassThrough} from "node:stream";
import {deviceResultSpeech} from "../config/device-result-speech";
import {personaPrompt} from "../config/persona";

const caps={api:1,readable:["capabilities","apps","display","audio","network","wifi","bluetooth","services"],
  actions:{brightness:{supported:true},volume:{supported:true},home:{supported:true},lock:{supported:true},
    recording:{supported:true,physical_confirmation:true},bluetooth:{supported:true,physical_confirmation:true},
    service:{supported:false},reboot:{supported:false},shutdown:{supported:false}},notes:["TECHNICAL_METADATA_NOT_FOR_SPEECH"]};
const output=(r:unknown)=>"[success]"+JSON.stringify(r);
const words=(s:string)=>s.trim().split(/\s+/).length;
const sentences=(s:string)=>(s.match(/[.!?](?:\s|$)/g)||[]).length;
const env=()=>Object.assign(process.env,{WHISPLAY_VOICE_CONTROL_ENABLED:"true",ASSISTANT_PERSONA:"glados",GLADOS_PERSONA_VARIANT:"A"});

test("simple live-capability overview is short, varied, useful and free of metadata",()=>{
  env();const replies=new Set<string>();
  for(let i=0;i<6;i++){
    const text=deviceResultSpeech("whisplay",output(caps),undefined,"What can you do?")!;
    replies.add(text);assert.ok(words(text)>=25&&words(text)<=40,text);
    assert.ok(sentences(text)>=1&&sentences(text)<=2,text);
    assert.match(text,/brightness|screen/);assert.match(text,/volume|speaker|sound/);
    assert.match(text,/connections|network/);assert.match(text,/Home/);
    assert.doesNotMatch(text,/metadata|api|socket|helper|shutdown|reboot|microphone gain|framebuffer|[{}]/i);
  }
  assert.ok(replies.size>=3,"presentation varies without an extra model generation");
});

test("summary claims only live supported controls, while explicitly requested details remain complete",()=>{
  env();const sparse={api:1,readable:["audio"],actions:{volume:{supported:true},shutdown:{supported:false},recording:{supported:false}}};
  const short=deviceResultSpeech("whisplay",output(sparse),undefined,"What can you do?")!;
  assert.match(short,/volume|sound|speaker/);assert.doesNotMatch(short,/brightness|Home|shutdown|recording/);
  const detail=deviceResultSpeech("whisplay",output(caps),undefined,"List all your capabilities and limitations in detail.")!;
  assert.ok(words(detail)>40);assert.match(detail,/Not available.*shutdown/);
  assert.match(detail,/recording lock|microphone mute/);assert.match(detail,/physical confirmation/);
  assert.ok(words(deviceResultSpeech("whisplay",output(caps),undefined,"Keep it brief, without technical details.")!)<=40);
});

test("simple status replies are concise without concealing faults or requested measurements",()=>{
  env();const r={services:{ssh:"Running",ollama:"Running",whisper:"Running",piper:"Failed",daemon:"Running"},glados:"Running",backend_readiness:"not_tested"};
  const ssh=deviceResultSpeech("whisplay",output(r),undefined,"Is SSH working?")!;
  assert.match(ssh,/SSH is running/i);assert.doesNotMatch(ssh,/Ollama|Piper|backend readiness|systemd/);
  assert.match(ssh,/not.*tested/i);
  const all=deviceResultSpeech("whisplay",output(r),undefined,"What's currently running?")!;
  assert.match(all,/Piper.*failed/i);assert.match(all,/SSH/);assert.ok(sentences(all)<=2,all);
  const health={cpu:{utilization:{value:7.5,unit:"%"}},temperature:{value:33.1,unit:"°C"},
    memory:{used:{value:1.11,unit:"GiB"},available:{value:14.52,unit:"GiB"}},disk:{available:{value:47.58,unit:"GiB"}}};
  const measured=deviceResultSpeech("getSystemHealth",output(health),undefined,"What's your system health?")!;
  assert.ok(sentences(measured)<=2,measured);
  for(const value of ["7.5","33.1","1.11","14.52","47.58"])assert.ok(measured.includes(value));
  assert.doesNotMatch(measured,/healthy|adequate|protocol|systemd/i);
});

test("brevity never truncates a pending confirmation or modifies the preserved IP reply",()=>{
  env();const pending=deviceResultSpeech("whisplay",output({status:"awaiting_physical_confirmation",action:"recording",requested:{enabled:false}}))!;
  assert.match(pending,/Nothing has changed/);assert.match(pending,/Cancel is selected first/);assert.match(pending,/button/);
  assert.match(pending,/After this reply I will stop GLaDOS/);
  assert.equal(deviceResultSpeech("whisplay",output({scope:"wifi",wifi:{device:"wlan0",enabled:true,connected:[{active:true,ipv4:"192.168.8.223"}]}}),"ip","What's your IP address?"),
    "Local Wi-Fi IPv4 address is 192.168.8.223 on wlan0.");
});

test("shared speech guidance is shorter than before and leaves persona A intact",()=>{
  env();const {systemPrompt}=require("../config/llm-config");
  assert.ok(systemPrompt.startsWith(personaPrompt()));
  const speech=systemPrompt.slice(personaPrompt().length).split(" Device operations:")[0];
  assert.match(speech,/one or two/);assert.match(speech,/25 to 40/);assert.match(speech,/accuracy|safety/);
  const old=" Format your replies for spoken text-to-speech. Do not use Markdown formatting that sounds awkward when read aloud, such as tables, code blocks, headings, bullet lists, numbered lists, inline links, footnote markers, or decorative separators. Use natural conversational sentences and plain punctuation instead.";
  assert.ok(speech.length<=old.length,"do not expand the shared prompt for this presentation fix");
});

test("capability overview and requested detail keep one live lookup and zero inference",async t=>{
  env();Object.assign(process.env,{LLM_SERVER:"ollama",OLLAMA_ENABLE_TOOLS:"true",OLLAMA_MODEL:"fixture",WEB_SEARCH_ENABLED:"false"});
  const socketPath=process.platform==="win32"?`\\\\.\\pipe\\short-reply-${process.pid}`:path.join(os.tmpdir(),`short-reply-${process.pid}.sock`);
  process.env.WHISPLAY_CONTROL_SOCKET=socketPath;const calls:any[]=[];
  const server=net.createServer(c=>c.once("data",data=>{const r=JSON.parse(data.toString());calls.push(r);c.end(JSON.stringify({ok:true,payload:caps})+"\n");}));
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{delete process.env.WHISPLAY_CONTROL_SOCKET;await new Promise<void>(resolve=>server.close(()=>resolve()));});
  let inference=0;
  t.mock.method(axios,"get",async()=>({data:{models:[{name:"fixture",context_length:4096}]}}));
  t.mock.method(axios,"post",async(_url:string,body:any)=>{
    if(!body.messages?.length)return {data:{done:true}};
    inference++;const s=new PassThrough();setImmediate(()=>s.end(JSON.stringify({message:{content:"A concise conversational answer."},done:true})+"\n"));return {data:s};
  });
  const provider=require("../cloud-api/local/ollama-llm").default;
  const ask=async(content:string)=>{let text="",ends=0;await provider.chatWithLLMStream([{role:"user",content}],(p:string)=>text+=p,()=>ends++);assert.equal(ends,1);return text;};
  const first=await ask("What can you do?");const second=await ask("What can you do?");
  for(const answer of [first,second]){assert.ok(words(answer)>=25&&words(answer)<=40,answer);assert.ok(sentences(answer)<=2);}
  assert.notEqual(first,second);
  const detail=await ask("What can you do in detail?");assert.ok(words(detail)>40);assert.match(detail,/shutdown/);
  assert.equal(inference,0);assert.equal(calls.length,3);
  assert.ok(calls.every(r=>r.cmd==="control.read"&&r.payload.scope==="capabilities"));
  await ask("How are you?");assert.equal(inference,1,"ordinary conversation remains generated, not a canned host response");
});
