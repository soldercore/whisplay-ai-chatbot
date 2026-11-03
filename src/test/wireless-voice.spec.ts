import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { parseDeviceCommand, powerRequest } from "../config/device-commands";
import { withWhisplayQuestion, whisplayTool } from "../config/whisplay-tools";
import { deviceResultSpeech } from "../config/device-result-speech";
import axios from "axios";
import { cancelWhisplayHandoff } from "../device/whisplay-control";

const variants:[string,object][] = [
  ...["Turn on Wi-Fi", "Enable your wireless connection", "I need Wi-Fi", "I want to use WiFi", "Switch your wireless on"].map(q=>[q,{action:"wifi",enabled:true}] as [string,object]),
  ...["Turn Wi-Fi off", "I don't need Wi-Fi anymore", "I do not want to use wireless anymore"].map(q=>[q,{action:"wifi",enabled:false}] as [string,object]),
  ...["Are you connected?", "What's your Wi-Fi signal?", "What's your Wi-Fi SSID?", "Is Wi-Fi off?", "My Wi-Fi isn't working", "What's wrong with your connection?"].map(q=>[q,{action:"status",scope:"wifi"}] as [string,object]),
  ["What networks are available?",{action:"wifi_scan"}], ["Find nearby Wi-Fi networks",{action:"wifi_scan"}],
  ["Disconnect from Wi-Fi",{action:"wifi_profile",operation:"disconnect"}],
  ["Connect to my Wi-Fi",{action:"capabilities"}],
  ...["I want to use Bluetooth", "Enable Bluetooth", "Switch Bluetooth on"].map(q=>[q,{action:"bluetooth",enabled:true}] as [string,object]),
  ...["Switch Bluetooth off", "I don't need Bluetooth anymore"].map(q=>[q,{action:"bluetooth",enabled:false}] as [string,object]),
  ...["Bluetooth is already off", "Is Bluetooth working?", "List known Bluetooth devices"].map(q=>[q,{action:"status",scope:"bluetooth"}] as [string,object]),
  ["Find nearby Bluetooth devices",{action:"bluetooth_scan"}],
  ["Connect to my headphones",{action:"bluetooth_device",operation:"connect",device:"headphones"}],
  ["Pair with my Bluetooth headphones",{action:"bluetooth_device",operation:"pair",device:"headphones"}],
  ...["Shut down", "Turn yourself off", "Power down Whisplay", "Turn the whole system off", "Switch off the Raspberry Pi"].map(q=>[q,{action:"shutdown"}] as [string,object]),
  ...["Restart the system", "Reboot yourself"].map(q=>[q,{action:"reboot"}] as [string,object]),
  ["Can you shut down?",{action:"capabilities"}], ["GLaDOS, can you shut down?",{action:"capabilities"}],
  ["Can you restart?",{action:"capabilities"}],
  ["Turn off your screen",{action:"lock"}], ["Exit GLaDOS",{action:"home"}], ["Go Home",{action:"home"}],
];
test("natural wireless/power intentions route without Qwen; questions never mutate",()=>{
  for(const [q,args] of variants) assert.deepEqual(parseDeviceCommand(q),{name:"whisplay",args},q);
  for(const q of ["I don't want to lose my connection", "What if you shut down?", "Don't reboot yourself",
    "Restart after dinner", "Is Bluetooth off and should I enable it?", "If WiFi is off enable it",
    "Explain how to connect headphones", "Remember that I want Bluetooth", "Shut down and disable Wi-Fi"])
    assert.equal(parseDeviceCommand(q),undefined,q);
  assert.equal(powerRequest("Can you shut down?"),"capability");
  assert.equal(powerRequest("Can you restart?"),"clarify");
});

test("spoken wireless results reflect verified state, signal, unavailable privilege and power boundaries",()=>{
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED="true";
  const say=(r:object,q="")=>deviceResultSpeech("whisplay","[success]"+JSON.stringify(r),undefined,q)!;
  assert.match(say({status:"completed",action:"bluetooth",enabled:false}),/disabled/);
  assert.match(say({status:"completed",action:"bluetooth",enabled:false,changed:false}),/already disabled/);
  assert.doesNotMatch(say({status:"completed",action:"bluetooth"}),/is enabled/);
  assert.match(say({scope:"wifi",wifi:{enabled:true,connected:[{active:true,ssid:"Synthetic lab",ipv4:"10.0.0.4",signal:67}]}},"What's your Wi-Fi signal?"),/67 percent/);
  assert.match(say({scope:"wifi",wifi:{enabled:true,connected:[{active:true,signal:null}]}},"What's your Wi-Fi signal?"),/strength is unavailable/);
  const caps={api:1,readable:["wifi"],actions:{shutdown:{supported:false},reboot:{supported:false},wifi_profile:{supported:false}}};
  assert.match(say(caps,"Can you shut down?"),/unavailable/);
  assert.match(say(caps,"Can you restart?"),/Do you mean/);
  assert.match(say(caps,"Connect to my Wi-Fi"),/offline recovery/);
  for(const action of ["shutdown","reboot"]) assert.match(say({status:"awaiting_physical_confirmation",action}),/entire system\?.*physical button.*Cancel/);
  assert.match(deviceResultSpeech("whisplay",'[error]{"reason":"Disruptive Wi-Fi changes unavailable until automatic recovery is verified"}')!,/unavailable until offline recovery/);
  delete process.env.WHISPLAY_VOICE_CONTROL_ENABLED;
});

test("host rejects Qwen mutation proposals for status, observations, ambiguity and wrong target before IPC",async t=>{
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED="true";
  const socket=process.platform==="win32"?`\\\\.\\pipe\\wireless-${process.pid}`:path.join(os.tmpdir(),`wl-${process.pid}.sock`);
  process.env.WHISPLAY_CONTROL_SOCKET=socket;
  const calls:any[]=[];
  const server=net.createServer(c=>c.once('data',b=>{
    const request=JSON.parse(b.toString());calls.push(request);
    c.end(JSON.stringify({ok:true,payload:{status:"completed",action:request.payload.action,enabled:request.payload.enabled,verification:"fixture"}})+'\n');
  }));
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  t.after(async()=>{delete process.env.WHISPLAY_VOICE_CONTROL_ENABLED;delete process.env.WHISPLAY_CONTROL_SOCKET;await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const invoke=(q:string,p:any)=>withWhisplayQuestion(q,()=>whisplayTool.func(p));
  for(const [q,p] of [
    ["Is Wi-Fi off?",{action:"wifi",enabled:false}], ["Bluetooth is already off",{action:"bluetooth",enabled:false}],
    ["My Wi-Fi isn't working",{action:"wifi",enabled:false}], ["I don't want to lose my connection",{action:"wifi_profile",operation:"disconnect"}],
    ["Can you shut down?",{action:"shutdown"}], ["Can you restart?",{action:"reboot"}],
    ["Turn off your screen",{action:"shutdown"}], ["Exit GLaDOS",{action:"shutdown"}],
    ["Shut down",{action:"reboot"}], ["Enable Wi-Fi",{action:"bluetooth",enabled:true}],
    ["Enable Bluetooth",{action:"bluetooth",enabled:false}], ["Bluetooth seems disabled",{action:"bluetooth",enabled:true}],
    ["Why is your wireless broken?",{action:"wifi",enabled:false}],
  ] as [string,any][]) assert.match(await invoke(q,p),/^\[error\]/,q);
  assert.equal(calls.length,0);
  for(const [q,p] of [["Turn yourself off",{action:"shutdown"}], ["I don't need Bluetooth anymore",{action:"bluetooth",enabled:false}],
    ["Could you arrange for Bluetooth to be enabled?",{action:"bluetooth",enabled:true}]] as [string,any][])
    assert.match(await invoke(q,p),/^\[success\]/,q);
  assert.equal(calls.length,3,"unfamiliar clear requests retain the validated Qwen fallback");
});

test("public Ollama path executes wireless reads/settings and defers power without inference or voice authorization",async t=>{
  Object.assign(process.env,{WHISPLAY_VOICE_CONTROL_ENABLED:"true",LLM_SERVER:"ollama",OLLAMA_ENABLE_TOOLS:"true",
    WEB_SEARCH_ENABLED:"false",OLLAMA_MODEL:"fixture",ENABLE_THINKING:"false"});
  const socket=process.platform==="win32"?`\\\\.\\pipe\\wireless-flow-${process.pid}`:path.join(os.tmpdir(),`wlf-${process.pid}.sock`);
  process.env.WHISPLAY_CONTROL_SOCKET=socket;
  const calls:any[]=[]; const ticket="e".repeat(32);
  const server=net.createServer(c=>c.once('data',b=>{
    const r=JSON.parse(b.toString());calls.push(r);
    let payload:any;
    if(r.cmd==="control.cancel") payload={status:"cancelled"};
    else if(r.cmd==="control.read") payload=r.payload.scope==="capabilities"
      ? {api:1,readable:["wifi","bluetooth"],actions:{shutdown:{supported:false},reboot:{supported:false}}}
      : {wifi:{enabled:true,device:"wlan0",connected:[{active:true,ssid:"Synthetic Lab",ipv4:"10.0.0.4",signal:73}]}};
    else if(r.payload.action==="shutdown") payload={status:"awaiting_physical_confirmation",action:"shutdown",ticket,changed:false};
    else if(r.payload.action==="wifi") {c.end(JSON.stringify({ok:false,error:"Fixed privilege helper unavailable"})+'\n');return;}
    else payload={status:"completed",action:r.payload.action,enabled:r.payload.enabled,verification:"radio_readback"};
    c.end(JSON.stringify({ok:true,payload})+'\n');
  }));
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  t.after(async()=>{delete process.env.WHISPLAY_VOICE_CONTROL_ENABLED;delete process.env.WHISPLAY_CONTROL_SOCKET;await new Promise<void>(resolve=>server.close(()=>resolve()));});
  let inference=0;
  t.mock.method(axios,"post",async(_url:string,body:any)=>{
    if(!body.messages?.length)return {data:{done:true}};
    inference++;throw new Error("Clear device requests must not call Qwen");
  });
  delete require.cache[require.resolve('../cloud-api/local/ollama-llm')];
  const provider=require('../cloud-api/local/ollama-llm').default;
  const ask=async(q:string)=>{let answer="";await provider.chatWithLLMStream([{role:'user',content:q}],(s:string)=>answer+=s,()=>{});return answer;};
  assert.match(await ask("What's your Wi-Fi signal?"),/73 percent/);
  assert.match(await ask("I want to use Bluetooth"),/Bluetooth is enabled/);
  assert.match(await ask("I don't need Bluetooth anymore"),/Bluetooth is disabled/);
  const before=calls.length;
  assert.match(await ask("GLaDOS, can you shut down?"),/unavailable/);
  assert.ok(calls.slice(before).every(r=>r.cmd==="control.read"));
  assert.match(await ask("Enable Wi-Fi"),/unavailable.*helper/i);
  assert.match(await ask("Turn yourself off"),/entire system\?.*physical button/);
  assert.equal(inference,0);
  assert.ok(!calls.some(r=>r.cmd==="control.present"),"speech alone cannot present/accept the physical dialog");
  cancelWhisplayHandoff(ticket);
  await new Promise<void>(resolve=>setTimeout(resolve,20));
});
