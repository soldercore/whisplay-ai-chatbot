import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { whisplayHandoffTicket } from "../device/whisplay-control";
import * as lifecycle from "../utils/operation-lifecycle";

for (const interrupted of [false,true]) test(`device handoff waits for speech and memory; interrupted=${interrupted}`, async () => {
  let finishAudio!:()=>void, finishSave!:()=>void;
  const audio=new Promise<void>(resolve=>{finishAudio=resolve;});
  const save=new Promise<void>(resolve=>{finishSave=resolve;});
  let shown=0,cancelled=0,saved=0;
  const ticket='b'.repeat(32),noop=()=>{};
  const ctx:any={answerId:1,currentFlowName:'answer',asrText:'Take me back to Home.',
    resetToolCallDisplay:noop,partialThinkingCallback:noop,appendToolCallDisplay:noop,finishToolCallDisplay:noop,
    revealAllAnswerText:noop,transitionTo(state:string){this.currentFlowName=state;},
    streamResponser:{partial:noop,endPartial:noop,getPlayEndPromise:()=>audio,stop:noop}};
  const dependencies:Record<string,any>={
    '../../device/display':{display:noop,onButtonPressed:noop,onButtonReleased:noop},'../../device/audio':{},
    '../../cloud-api/server':{llmServer:'ollama',chatWithLLMStream:async(_input:any,partial:Function,end:Function,_thinking:Function,invoke:Function)=>{
      invoke('whisplay','[success]'+JSON.stringify({status:'awaiting_speech_handoff',ticket}));
      partial('I will return Home after this reply.');end();}},
    '../../cloud-api/llm':{isImMode:false,summaryTextWithLLM:()=>{throw new Error('No extra summary inference during handoff');}},
    '../Knowledge':{},'../../cloud-api/knowledge':{enableRAG:false},'../../utils/dir':{},
    '../../utils/image':{clearPendingCapturedImgForChat:noop,getLatestDisplayImg:noop},
    '../../cloud-api/whisplay-im/whisplay-im':{},'./camera-mode':{},'../../utils':{},'../../device/music-player':{},
    '../../config/local-memory':{prepareMemoryPrompt:()=>'',autoSaveExchange:(_user:string,_answer:string,summarize:unknown)=>{
      assert.equal(summarize,undefined);saved++;return save;}},
    '../../config/unsupported-reminder':{unsupportedReminderReply:()=>null},
    '../../device/whisplay-control':{whisplayHandoffTicket,presentWhisplayHandoff:async()=>{shown++;},cancelWhisplayHandoff:()=>{cancelled++;}},
    '../../utils/operation-lifecycle':lifecycle,
  };
  const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../core/chat-flow/states.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
  const exported:any={};
  vm.runInNewContext(source,{exports:exported,console,process,Date,setTimeout,clearTimeout,
    require:(name:string)=>Object.prototype.hasOwnProperty.call(dependencies,name)?dependencies[name]:['moment','lodash'].includes(name)?require(name):(()=>{throw new Error(name);})()});
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  exported.flowStates.answer(ctx);await flush();
  assert.equal(shown,0);assert.equal(saved,0);
  finishAudio();await flush();
  assert.equal(shown,0);assert.equal(saved,1);
  if(interrupted){ctx.currentFlowName='listening';ctx.answerId++;}
  finishSave();await flush();
  assert.equal(shown,interrupted?0:1);
  assert.equal(cancelled,interrupted?1:0);
});
