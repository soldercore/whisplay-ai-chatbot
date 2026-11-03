import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import axios from "axios";
import { PassThrough } from "node:stream";
import { parseDeviceCommand } from "../config/device-commands";
import { requiresWhisplayTool } from "../config/whisplay-tools";
import { deviceResultSpeech } from "../config/device-result-speech";

const addressQuestions = ["What's your IP address?", "What is your local IP address?", "GLaDOS, what's your IP?",
  "Can you check your IP address?", "Please show me your Wi-Fi IP address.", "Tell me what your IP address is.",
  "Which IP address are you using?", "What IP address do you have?", "What's Whisplay's IP address?",
  "What is the IP address of this Raspberry Pi?"];
test("clear device address requests require an existing read-only lookup", () => {
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED = "true";
  for (const question of addressQuestions) {
    assert.deepEqual(parseDeviceCommand(question), {name:"whisplay",args:{action:"status",scope:"wifi"},metric:"ip"}, question);
    assert.equal(requiresWhisplayTool(question), true, question);
  }
  assert.equal(parseDeviceCommand("Could you find out the current value of your local IP address?"),undefined);
  assert.equal(requiresWhisplayTool("Could you find out the current value of your local IP address?"),true,
    "uncertain device-address wording must still ground Qwen's answer");
});

const statusQuestions: [string,string][] = [
  ["What's your Wi-Fi status?","wifi"], ["Is your Wi-Fi connected?","wifi"],
  ["Can you check if Wi-Fi is connected?","wifi"], ["Do you have a Wi-Fi connection?","wifi"],
  ["What's your Bluetooth status?","bluetooth"], ["Check whether Bluetooth is enabled.","bluetooth"],
  ["Which Bluetooth devices are connected?","bluetooth"], ["Is your Bluetooth on?","bluetooth"],
  ["Is the SSH service running?","services"], ["What's the status of SSH?","services"],
  ["Show your service status.","services"], ["Which services are running?","services"],
];
test("unambiguous Wi-Fi, Bluetooth and service questions select read-only status", () => {
  for (const [question, scope] of statusQuestions) {
    assert.deepEqual(parseDeviceCommand(question), {name:"whisplay",args:{action:"status",scope}},question);
  }
  for (const question of ["What's your system health?", "How is your system doing?", "Show me system information."]) {
    assert.deepEqual(parseDeviceCommand(question),{name:"getSystemHealth",args:{}},question);
  }
});

test("concepts, other devices, unsupported address types and mixed requests stay with Qwen", () => {
  for (const q of ["What is an IP address?", "What is Wi-Fi?", "What is Bluetooth?", "What's my IP address?",
    "What's your public IP address?", "What's your IPv6 address?", "What's my laptop's IP address?",
    "Tell me a joke about your IP address", "Remember that my IP address is 10.0.0.9",
    "Check your IP address and turn off Wi-Fi", "If Bluetooth is on restart SSH", "Don't check your IP address"]) {
    assert.equal(parseDeviceCommand(q),undefined,q);
  }
  for (const q of ["What is an IP address?","Explain your IP address","Tell me a joke about your IP address"]) {
    assert.equal(requiresWhisplayTool(q),false,q);
  }
});

test("IP replies contain validated measured IPv4 and interface, or explicit unavailability", () => {
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED="true";
  const speak=(wifi:any)=>deviceResultSpeech("whisplay","[success]"+JSON.stringify({scope:"wifi",wifi}),"ip");
  assert.match(speak({enabled:true,device:"wlan0",connected:[{ipv4:"192.168.8.223",active:true}]})!,/192\.168\.8\.223.*wlan0/);
  for (const wifi of [undefined, {available:false}, {enabled:false,device:"wlan0",connected:[]},
    {enabled:true,device:"wlan0",connected:[{ipv4:"",active:true}]},
    {enabled:true,device:"wlan0",connected:[{ipv4:"invented address",active:true}]}]) {
    assert.match(speak(wifi)!,/unavailable|no .*address.*reported/i);
    assert.doesNotMatch(speak(wifi)!,/invented address|not a physical|192\.168/);
  }
  assert.match(deviceResultSpeech("whisplay",'[error]{"reason":"socket unavailable"}',"ip")!,/lookup failed|unavailable/i);
  assert.match(deviceResultSpeech("whisplay",'[success]null',"ip")!,/unavailable/i);
});

test("reported conversation is corrected through real dispatch with zero inference and preserved history", async t => {
  Object.assign(process.env,{WHISPLAY_VOICE_CONTROL_ENABLED:"true",LLM_SERVER:"ollama",OLLAMA_ENABLE_TOOLS:"true",
    WEB_SEARCH_ENABLED:"false",OLLAMA_MODEL:"fixture",ENABLE_THINKING:"false"});
  const socketPath=process.platform==="win32"?`\\\\.\\pipe\\live-status-${process.pid}`:path.join(os.tmpdir(),`live-status-${process.pid}.sock`);
  process.env.WHISPLAY_CONTROL_SOCKET=socketPath;
  const calls:any[]=[]; let unavailable=false;
  const server=net.createServer(c=>c.once("data",chunk=>{
    const request=JSON.parse(chunk.toString());calls.push(request);
    assert.equal(request.cmd,"control.read","a live-information question must never mutate the device");
    const scope=request.payload.scope;
    const payload=scope==="wifi"?{wifi:{enabled:true,device:"wlan0",connected:[{ipv4:"192.168.8.223",active:true}]}}:
      scope==="bluetooth"?{bluetooth:{enabled:false,devices:[]}}:{services:{ssh:"Running",piper:"Stopped"},glados:"Running"};
    c.end(JSON.stringify(unavailable?{ok:false,error:"NetworkManager unavailable"}:{ok:true,payload})+"\n");
  }));
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));
  t.after(async()=>{delete process.env.WHISPLAY_CONTROL_SOCKET;await new Promise<void>(resolve=>server.close(()=>resolve()));});
  let inference=0, healthCalls=0;
  t.mock.method(axios,"get",async()=>({data:{models:[{name:"fixture",context_length:4096}]}}));
  const rejectedReply="I cannot provide an IP address as I am not a physical device with network connectivity.";
  t.mock.method(axios,"post",async(_url:string,body:any)=>{
    if(!body.messages?.length)return {data:{done:true}};
    inference++;const stream=new PassThrough();
    setImmediate(()=>stream.end(JSON.stringify({message:{content:rejectedReply},done:true})+"\n"));
    return {data:stream};
  });
  const health=require("../config/system-health");
  t.mock.method(health.systemHealthTool,"func",async()=>{
    healthCalls++;return '[success]'+JSON.stringify({cpu:{utilization:{value:7.5,unit:"%"}},temperature:{value:33.1,unit:"°C"},
      memory:{available:{value:12,unit:"GiB"},used:{value:3,unit:"GiB"}},disk:{available:{value:47,unit:"GiB"}}});
  });
  const provider=require("../cloud-api/local/ollama-llm").default;
  const ask=async(q:string,prior:any[]=[])=>{let text="",ends=0;const tools:string[]=[];
    await provider.chatWithLLMStream([...prior,{role:"user",content:q}],(p:string)=>text+=p,()=>ends++,undefined,
      (name:string,result?:string)=>{if(result)tools.push(name);});
    assert.equal(ends,1);return {text,tools};};
  const previous=[{role:"user",content:"What's your IP address?"},{role:"assistant",content:rejectedReply}];
  const reply=await ask("What's your IP address?",previous);
  assert.deepEqual(reply.tools,["whisplay"]);assert.match(reply.text,/192\.168\.8\.223.*wlan0/);
  assert.doesNotMatch(reply.text,/not a physical device|cannot provide/);assert.equal(inference,0);
  const {chatHistoryDir}=require("../utils/dir");
  const saved=fs.readdirSync(chatHistoryDir).map((n:string)=>path.join(chatHistoryDir,n)).sort((a:string,b:string)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
  const history=JSON.parse(fs.readFileSync(saved,"utf8"));
  assert.ok(history.some((m:any)=>m.role==="tool"&&m.content.includes('192.168.8.223')));
  assert.ok(history.some((m:any)=>m.role==="assistant"&&m.content===reply.text));
  for(const [q,scope] of statusQuestions){const start=calls.length;await ask(q);
    assert.deepEqual(calls.slice(start).map(r=>r.payload),[{scope}]);}
  assert.match((await ask("What's your system health?")).text,/33\.1 degrees Celsius/);
  assert.equal(healthCalls,1);assert.equal(inference,0);
  unavailable=true;assert.match((await ask("What's your IP address?")).text,/lookup failed|unavailable/i);
  unavailable=false;
  process.env.OLLAMA_ENABLE_TOOLS="false";const start=calls.length;
  assert.match((await ask("What's your IP address?")).text,/lookup failed|unavailable/i);assert.equal(calls.length,start);
  process.env.OLLAMA_ENABLE_TOOLS="true";
  assert.equal(inference,0,"lookup failure and disabled tools cannot fall back to an invented model answer");
  await ask("How are you?");assert.equal(inference,1,"normal conversation still reaches Qwen");
  await ask("What is an IP address?");assert.equal(inference,2,"conceptual questions still reach Qwen");
  const beforeAmbiguous=calls.length;
  const uncertain=await ask("Could you find out the current value of your local IP address?");
  assert.equal(inference,4,"uncertain interpretation retains Qwen and its existing bounded grounding retry");
  assert.equal(calls.length,beforeAmbiguous,"a model that declines the tool cannot fabricate its result");
  assert.doesNotMatch(uncertain.text,/not a physical device|cannot provide an IP/);
  assert.match(uncertain.text,/could not verify|unavailable/i);
});
