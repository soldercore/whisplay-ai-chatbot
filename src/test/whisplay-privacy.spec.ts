import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { redactWifiCredentials, privateWhisplayCall, WIFI_PRIVATE } from "../config/whisplay-privacy";

test("Wi-Fi credential topics are withheld only when device voice control is enabled",()=>{
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED="true";
  for(const phrase of ["My Wi-Fi password is SyntheticSecret99","Connect to my wireless network with passphrase SyntheticSecret99",
    "The SSID security key is SyntheticSecret99","My wifi PSK is SyntheticSecret99"]) assert.equal(redactWifiCredentials(phrase),WIFI_PRIVATE);
  for(const phrase of ["Are you connected to Wi-Fi?","Remember that my favorite color is green","Tell me a joke","Enable Bluetooth"]) {
    assert.equal(redactWifiCredentials(phrase),phrase);
  }
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED="false";
  assert.equal(redactWifiCredentials("My WiFi password is SyntheticSecret99"),"My WiFi password is SyntheticSecret99");
});

test("invalid Whisplay proposal values are withheld without accepting unknown parameters",()=>{
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED="true";
  for(const args of [{action:"wifi_join",network:"Lab",password:"SyntheticSecret99"},
    JSON.stringify({action:"wifi_join",network:"Lab",passphrase:"SyntheticSecret99"}),
    ["SyntheticSecret99"],"SyntheticSecret99",{action:{password:"SyntheticSecret99"}}]) {
    const cleaned=privateWhisplayCall({function:{name:"whisplay",arguments:args}});
    assert.ok(!JSON.stringify(cleaned).includes("SyntheticSecret99"));
  }
});

test("recognized Wi-Fi credentials never reach transcript logs, display or answer/memory input",async()=>{
  process.env.WHISPLAY_VOICE_CONTROL_ENABLED="true";
  const logs:any[]=[],displayed:any[]=[];const noop=()=>{};
  const exported:any={};
  const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,"../core/chat-flow/states.ts"),"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  vm.runInNewContext(source,{exports:exported,process,Date,console:{log:(...args:any[])=>logs.push(args)},setTimeout,clearTimeout,
    require:(name:string)=>name==="../../config/whisplay-privacy"?require("../config/whisplay-privacy"):
      name==="../../device/display"?{display:(value:any)=>displayed.push(value),onButtonDoubleClick:noop,onButtonPressed:noop,onButtonReleased:noop}:
      ["moment","lodash"].includes(name)?require(name):{}});
  const ctx:any={currentFlowName:"asr",recognizeAudio:async()=>"My Wi-Fi password is SyntheticSecret99",
    shouldEndAfterAnswer:()=>false,transitionTo(state:string){this.currentFlowName=state;}};
  exported.flowStates.asr(ctx);
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(ctx.currentFlowName,"answer");assert.equal(ctx.asrText,WIFI_PRIVATE);
  assert.ok(!JSON.stringify([logs,displayed,ctx.asrText]).includes("SyntheticSecret99"));
});
