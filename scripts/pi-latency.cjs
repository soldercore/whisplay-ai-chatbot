// Measurement only. No model management, services, config writes or private text.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const MODEL = 'qwen3.5:2b-q4_K_M';
const PREFIX = '[AudioTiming] interaction ';
const diagnosticError=(reason,message)=>Object.assign(new Error(message),{diagnosticReason:reason});
function modelParameters(text) {
 const result={};for(const line of (text||'').split('\n')){const [key,value]=line.trim().split(/\s+/);
  if(['temperature','top_k','top_p','presence_penalty','draft_num_predict'].includes(key)&&Number.isFinite(Number(value)))result[key]=Number(value);
 }return result;
}
function parseSession(line) {
 let r;try{r=JSON.parse(line);}catch{return null;}
 if(!r||!['diagnostic_session','diagnostic_event'].includes(r.kind)||
  !['start','child_started','stop_requested','startup_failure','runtime_failure','collection_failure','cleanup_start','cleanup_verified','cleanup_failure','escalation','end','command_failure','display_ready','application_ready','display_failure','node_failure'].includes(r.event)||
  !['startup','runtime','collection','cleanup'].includes(r.phase))return null;
 const out={kind:r.kind,event:r.event,phase:r.phase};
 if(typeof r.session_id==='string'&&/^[a-f0-9-]{36}$/.test(r.session_id))out.session_id=r.session_id;
 for(const key of ['child_pid','signal','remaining','exit_code','app_exit_code','measurement_events','line'])
  if(r[key]===null||Number.isSafeInteger(r[key]))out[key]=r[key];
 const safeValues={reason:new Set(['display_failure','node_failure','display_not_ready','display_spawn_failed','startup_failed','module_missing','required_file_missing','permission_denied','port_in_use','display_port_in_use',
  'application_exited_before_ready','application_exit_nonzero','startup_timeout','no_interaction_events','owned_exit_unverified','supervisor_error','guardian_terminated','output_closed','output_backpressure','supervisor_prerequisites','display_prerequisites','not_pi','model_residency','baseline_mismatch','missing_build','runtime_version','remote_speech_host','browser_audio','cleanup_unverified','command_failed']),
  error_type:new Set(['ModuleNotFoundError','ImportError','FileNotFoundError','PermissionError','OSError','RuntimeError','ValueError','TypeError','AttributeError','SyntaxError','Exception']),
  module:new Set(['PIL','PIL.Image','numpy','cairosvg','gpiod','spidev','WhisPlay','picamera2','cv2']),
  frame:new Set(['chatbot-ui.py','utils.py','whisplay_client.py','whisplay.py','fonts.py','diagnostic_display.py'])};
 for(const key of ['reason','error_type','module','frame'])if(safeValues[key].has(r[key]))out[key]=r[key];
 if(typeof r.cleanup_verified==='boolean')out.cleanup_verified=r.cleanup_verified;
 return out;
}
function displayPreflight(env) {
 const child=cp.spawnSync('python3',['-B',path.join(__dirname,'../python/diagnostic_display.py'),'--preflight'],
  {env,encoding:'utf8',timeout:15000,maxBuffer:131072,stdio:['ignore','pipe','pipe']});
 let data;try{data=JSON.parse((child.stdout||'').trim().split('\n').at(-1));}catch{}
 if(data?.kind==='display_preflight')console.log(JSON.stringify(data));
 if(child.status!==0||data?.ok!==true){
  if(data?.kind==='display_preflight')console.error(JSON.stringify(data));
  throw diagnosticError('display_prerequisites','Display prerequisites failed; inspect display_preflight checks');
 }
 return data;
}
function compiledBuild() {
 const hashes={};
 for(const [file,marker] of [['core/audio-timing.js','WHISPLAY_LATENCY_DIAGNOSTICS'],['utils/diagnostic-events.js','diagnosticFailure'],['device/display.js','diagnostic_display.py'],['index.js','diagnosticFailure']]){
  const text=read(path.join(__dirname,'../dist',file));
  if(!text?.includes(marker))throw diagnosticError('missing_build','Diagnostic emitted build is missing or stale; compile the reviewed checkout first');
  hashes[file]=crypto.createHash('sha256').update(text).digest('hex');
 }
 return {protocol:2,sha256:hashes};
}
function endpointFor(env) {
 const url=new URL(env.OLLAMA_ENDPOINT||'http://127.0.0.1:11434');
 if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
  url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('A credential-free loopback Ollama endpoint is required');
 return url.origin;
}
const options = Object.freeze({temperature:0.7,top_k:20,top_p:0.95,presence_penalty:1.5,seed:42,num_ctx:4096,num_predict:96});
const read = file => { try { return fs.readFileSync(file,'utf8').trim().replace(/\0/g,''); } catch { return null; } };
const command = (name,args) => { try { return cp.execFileSync(name,args,{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']}).trim(); } catch { return null; } };
function throttle(text) {
 const match = /^throttled=(0x[0-9a-f]+)$/i.exec(text||'');
 if(!match)return null;
 const mask=parseInt(match[1],16);
 return {raw:match[1],active:{undervoltage:!!(mask&1),frequency_capped:!!(mask&2),throttled:!!(mask&4),soft_temperature_limit:!!(mask&8)},
  historical:{undervoltage:!!(mask&65536),frequency_capped:!!(mask&131072),throttled:!!(mask&262144),soft_temperature_limit:!!(mask&524288)}};
}
function snapshot() {
 const info=read('/proc/meminfo')||'',mem=key=>{const m=new RegExp('^'+key+':\\s+(\\d+) kB','m').exec(info);return m?Number(m[1])*1024:null;};
 const cpu=(read('/proc/stat')||'').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);
 return {wall_time:new Date().toISOString(),hardware:read('/proc/device-tree/model'),
  cpu_temperature_c:! /cpu|soc/i.test(read('/sys/class/thermal/thermal_zone0/type')||'')||read('/sys/class/thermal/thermal_zone0/temp')===null?null:Number(read('/sys/class/thermal/thermal_zone0/temp'))/1000,
  cpu_frequency_khz:read('/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq'),
  measured_arm_clock:command('vcgencmd',['measure_clock','arm']),throttling:throttle(command('vcgencmd',['get_throttled'])),
  available_ram_bytes:mem('MemAvailable'),swap_total_bytes:mem('SwapTotal'),swap_free_bytes:mem('SwapFree'),cpu_ticks:cpu,
  inference_process_snapshot:command('ps',['-C','ollama,llama-server','-o','pid=,comm=,pcpu=,rss=']),
  process_cpu_note:'ps %CPU is a lifetime average; cpu_ticks deltas measure system activity over the benchmark.'};
}
function safeConfig(env) {
 const out={};
 for(const key of ['OLLAMA_MODEL','LLM_SERVER','ASR_SERVER','TTS_SERVER','ASSISTANT_PERSONA','GLADOS_PERSONA_VARIANT',
  'ENABLE_THINKING','OLLAMA_CONTEXT_LENGTH','OLLAMA_PREDICT_NUM','OLLAMA_DRAFT_NUM_PREDICT','WHISPLAY_LATENCY_DIAGNOSTICS']) {
  const value=env[key];out[key]=typeof value==='string'&&/^[a-zA-Z0-9_.:/-]{1,120}$/.test(value)?value:null;
 }
 out.custom_system_prompt_present=Boolean(env.SYSTEM_PROMPT);
 out.asr_host_is_loopback=['localhost','127.0.0.1','::1','[::1]'].includes(env.FASTER_WHISPER_HOST||'localhost');
 out.tts_host_is_loopback=['localhost','127.0.0.1','::1','[::1]'].includes(env.PIPER_HTTP_HOST||'localhost');
 out.web_audio_enabled=['true','1'].includes((env.WEB_AUDIO_ENABLED||'').toLowerCase());
 try { endpointFor({OLLAMA_ENDPOINT:env.OLLAMA_ENDPOINT});out.ollama_endpoint_is_loopback=true; }catch{out.ollama_endpoint_is_loopback=false;}
 return out;
}
function parseEvent(line) {
 const at=line.indexOf(PREFIX);if(at<0)return null;
 let r;try{r=JSON.parse(line.slice(at+PREFIX.length));}catch{return null;}
 if(!r||typeof r!=='object'||Array.isArray(r))return null;
 if(!/^\d+-[a-f0-9-]{36}$/.test(r.id||'')||!/^[a-z_]{1,48}$/.test(r.event||'')||!Number.isFinite(r.at_ms)||r.at_ms<0)return null;
 const out={id:r.id,event:r.event,at_ms:r.at_ms};
 for(const key of ['segment','call','round','duration_ms','chars','code','temperature','prompt_eval_count','prompt_eval_cached_count',
  'prompt_eval_duration','eval_count','eval_duration','load_duration','total_duration'])
  if(r[key]===null||Number.isFinite(r[key]))out[key]=r[key];
 for(const key of ['origin','outcome','model','build','persona','variant','done_reason','asr','tts'])
  if(typeof r[key]==='string'&&/^[a-zA-Z0-9_.:/-]{1,120}$/.test(r[key]))out[key]=r[key];
 for(const key of ['thinking','custom_prompt_present'])if(typeof r[key]==='boolean')out[key]=r[key];
 if(typeof r.wall_time==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(r.wall_time))out.wall_time=r.wall_time;
 return out;
}
const difference=(a,b)=>a!==undefined&&b!==undefined&&b>=a?Math.round((b-a)*1000)/1000:null;
function report(events) {
 const groups=new Map();for(const event of events){if(!groups.has(event.id))groups.set(event.id,[]);groups.get(event.id).push(event);}
 return [...groups].map(([id,rows])=>{
  const first=name=>rows.find(r=>r.event===name)?.at_ms;
  const ref=first('capture_stop_requested');
  const calls=rows.filter(r=>r.event==='llm_complete').map(r=>({...r,
   client_request_ms:difference(rows.find(x=>x.event==='llm_submit'&&x.call===r.call)?.at_ms,r.at_ms),
   request_preparation_ms:difference(rows.find(x=>x.event==='llm_prepare_start'&&x.call===r.call)?.at_ms,rows.find(x=>x.event==='llm_submit'&&x.call===r.call)?.at_ms),
   first_content_ms:difference(rows.find(x=>x.event==='llm_submit'&&x.call===r.call)?.at_ms,rows.find(x=>x.event==='llm_first_content'&&x.call===r.call)?.at_ms),
   output_tokens_per_second:typeof r.eval_count==='number'&&r.eval_duration>0?r.eval_count/(r.eval_duration/1e9):null}));
  const end=rows.find(r=>r.event==='interaction_end');
  return {id,outcome:end?.outcome||'incomplete',reference:ref===undefined?'physical_speech_end_unavailable':'button_release_proxy_not_physical_speech_end',
   end_of_speech_detection_ms:null,capture_finalization_ms:difference(ref,first('capture_finalized')),
   asr_precheck_ms:difference(first('asr_precheck_start'),first('asr_start')),
   asr_ms:difference(first('asr_start'),first('asr_complete')),asr_total_ms:difference(first('asr_precheck_start'),first('asr_complete')),
   context_preparation_ms:difference(first('prompt_prepare_start'),first('llm_answer_start')),
   from_reference_ms:{first_content:difference(ref,first('llm_first_content')),first_speakable:difference(ref,first('speakable_segment')),
    first_complete_piper_file:difference(ref,first('piper_file_available')),first_audio_ready:difference(ref,first('tts_audio_ready')),playback_submission:difference(ref,first('playback_submit')),
    sox_process_spawn:difference(ref,first('sox_spawn')),actual_playback_start:null,physically_audible_speech:null,
    response_end:end?.outcome==='completed'?difference(ref,end.at_ms):null},
   segments:[...new Set(rows.map(r=>r.segment).filter(Number.isFinite))].map(segment=>{
    const at=name=>rows.find(r=>r.segment===segment&&r.event===name)?.at_ms;
    return {segment,tts_slot_wait_ms:difference(at('speakable_segment'),at('tts_start')),
     synthesis_ms:difference(at('tts_start'),at('tts_audio_ready')),piper_http_ms:difference(at('piper_http_start'),at('piper_http_complete')),
     piper_postprocess_ms:difference(at('piper_http_complete'),at('piper_wav_ready')),
     playback_submission_to_spawn_ms:difference(at('playback_submit'),at('sox_spawn'))};}),calls};
 });
}
function residency(ps,mode,digest) {
 const models=ps?.models;
 if(!Array.isArray(models))throw Error('Malformed /api/ps');
 if(mode==='cold'){if(models.length)throw Error('Cold test refused: a model is already resident; nothing was unloaded');return;}
 if(models.length!==1||![models[0].name,models[0].model].includes(MODEL)||models[0].context_length!==4096||models[0].digest!==digest)
  throw diagnosticError('model_residency','Only the verified Qwen must already be resident at context 4096. Nothing was switched or unloaded.');
}
function localModel(show) {
 if(show?.remote_host||show?.remote_model||show?.details?.family!=='qwen35'||show?.details?.quantization_level!=='Q4_K_M')
  throw Error('Local Qwen35 Q4_K_M artifact required; remote/unknown model refused');
}
function ensurePi() {
 if(!/Raspberry Pi 5/.test(read('/proc/device-tree/model')||''))throw diagnosticError('not_pi','Inference is restricted to the actual Raspberry Pi 5; PC/cloud runs refused');
}
function ensurePiLock() {
 ensurePi();
 const lock=`/tmp/whisplay-chatbot-${process.getuid()}/application.lock`;
 let inherited;try{inherited=fs.readlinkSync('/proc/self/fd/9');}catch{}
 if(inherited!==lock||process.env.WHISPLAY_APPLICATION_LOCK!==lock)throw Error('Use pi-latency.sh so the same-user application lock is held');
}
function baselineConfig(env) {
 for(const key of ['FASTER_WHISPER_HOST','PIPER_HTTP_HOST'])
  if(!['localhost','127.0.0.1','::1','[::1]'].includes(env[key]||'localhost'))throw diagnosticError('remote_speech_host','Remote speech inference refused; speech hosts must be Pi-local');
 if(['true','1'].includes((env.WEB_AUDIO_ENABLED||'').toLowerCase()))throw diagnosticError('browser_audio','Browser audio is not the requested Whisplay hardware test');
 if(env.OLLAMA_MODEL!==MODEL||env.LLM_SERVER!=='ollama'||env.ASSISTANT_PERSONA!=='glados'||
  ![undefined,'','A'].includes(env.GLADOS_PERSONA_VARIANT)||env.ENABLE_THINKING!=='false'||env.SYSTEM_PROMPT||
  env.ASR_SERVER!=='faster-whisper'||env.TTS_SERVER!=='piper-http')
  throw diagnosticError('baseline_mismatch','Actual candidate configuration is not the requested Qwen + A / thinking=false / Faster-Whisper / Piper HTTP baseline. Nothing was changed.');
 return endpointFor({OLLAMA_ENDPOINT:env.OLLAMA_ENDPOINT});
}
async function benchmark(mode,endpoint) {
 ensurePiLock();
 const axios=require('axios');const {requestFor}=require('./persona-comparison.cjs');
 endpoint=endpointFor({OLLAMA_ENDPOINT:endpoint});
 const transport={proxy:false,maxRedirects:0,timeout:10000,maxContentLength:2*1024*1024};
 const get=async p=>(await axios.get(endpoint+p,transport)).data;
 const version=await get('/api/version');if(version.version!=='0.34.4')throw Error('Runtime is not the confirmed Ollama 0.34.4');
 const tags=await get('/api/tags'),tag=tags.models?.find(x=>x.name===MODEL||x.model===MODEL);
 if(!tag||!/^[a-f0-9]{64}$/.test(tag.digest))throw Error('Required Qwen artifact is not installed; no pull was attempted');
 const show=(await axios.post(endpoint+'/api/show',{model:MODEL},transport)).data;
 localModel(show);
 const beforePS=await get('/api/ps');residency(beforePS,mode,tag.digest);
 process.env.ASSISTANT_PERSONA='glados';
 const oldLog=console.log;let system;try{console.log=()=>{};system=require('../src/config/llm-config').systemPrompt;}finally{console.log=oldLog;}
 if(process.env.SYSTEM_PROMPT)throw Error('Custom SYSTEM_PROMPT present; fixed baseline benchmark refused');
 const {readOllamaNDJSON}=require('../src/cloud-api/local/ollama-ndjson');
 const before=snapshot();console.log(JSON.stringify({kind:'benchmark_start',mode,version:version.version,model:MODEL,digest:tag.digest,
  model_parameters:modelParameters(show.parameters),context:4096,thinking:false,options,tools:[],before,pre_request_residency:beforePS,
  concurrency:'Operator confirmed no other clients; application lock excludes the supported same-user launcher only.'}));
 const initial=[{role:'system',content:system},{role:'user',content:'Explain what DNS does.'}];
 const history=initial.map(x=>({...x}));const outputs=[];
 const turns=['Explain what DNS does.','Why is the TTL useful?','Does restarting a router prove a DNS problem was fixed?'];
 for(let i=0;i<(mode==='cold'?1:3);i++) {
  const ps=await get('/api/ps');residency(ps,mode==='cold'&&i===0?'cold':'warm',tag.digest);
  if(mode==='incremental'&&i)history.push({role:'user',content:turns[i]});
  const messages=mode==='incremental'?history:initial;
  const started=performance.now();
  const body=requestFor(messages,{model:MODEL,think:false,stream:true,truncate:false,keep_alive:-1,options:{...options}});body.tools=[];
  const prepared=performance.now(),controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('Benchmark deadline')),120000);
  let text='',stats,firstContentMs=null;
  try {
   const response=await axios.post(endpoint+'/api/chat',body,{...transport,timeout:120000,responseType:'stream',signal:controller.signal});
   await readOllamaNDJSON(response.data,r=>{
    if(r.message?.content){firstContentMs??=performance.now()-prepared;text+=r.message.content;}
    if(r.message?.thinking||r.message?.tool_calls?.length)throw Error('Unexpected thinking/tool output; benchmark refused');
    if(Buffer.byteLength(text)>65536)throw Error('Output exceeds benchmark byte limit');
    if(r.done)stats=r;
   },undefined,controller.signal);
   if(!stats||!text.trim())throw Error('Missing completed response/content');
  }finally{clearTimeout(timer);}
  const row={kind:'generation',index:i+1,pre_request_residency:ps,request_sha256:crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
   preparation_ms:prepared-started,first_content_ms:firstContentMs,elapsed_ms:performance.now()-prepared,output_chars:text.length,
   done_reason:stats.done_reason||null};
  for(const key of ['load_duration','prompt_eval_count','prompt_eval_cached_count','prompt_eval_duration','eval_count','eval_duration','total_duration'])
   row[key]=Number.isFinite(stats[key])?stats[key]:null;
  row.decode_tokens_per_second=typeof row.eval_count==='number'&&row.eval_duration>0?row.eval_count/(row.eval_duration/1e9):null;
  row.prompt_tokens_per_second=typeof row.prompt_eval_count==='number'&&row.prompt_eval_duration>0?row.prompt_eval_count/(row.prompt_eval_duration/1e9):null;
  console.log(JSON.stringify(row));outputs.push(row.eval_count);
  if(mode==='incremental')history.push({role:'assistant',content:text});
  residency(await get('/api/ps'),'warm',tag.digest);
 }
 const after=snapshot(),total=x=>x.cpu_ticks.reduce((a,b)=>a+b,0),delta=total(after)-total(before),idle=x=>(x.cpu_ticks[3]||0)+(x.cpu_ticks[4]||0);
 console.log(JSON.stringify({kind:'benchmark_end',after,cpu_busy_percent:delta>0?100*(1-(idle(after)-idle(before))/delta):null,
  output_length_differs_over_20_percent:outputs.every(n=>typeof n==='number'&&n>0)?Math.max(...outputs)>1.2*Math.min(...outputs):null,
  caveat:'Token limit is a maximum. Unequal output lengths, prefix reuse and different thermal states limit total-time comparisons. Cached counts are server reports only.'}));
}
async function main(args) {
 const [mode='plan',arg,...rest]=args;
 if(mode==='plan'){console.log(JSON.stringify({model:MODEL,context:4096,thinking:false,options,tools:[],experiments:['identical:3','incremental:3','cold:1'],inference:'Pi-only, explicit command, application lock and operator idle confirmation required. No model unloading.'}));return;}
 if(mode==='collect'){
  let measured=0,lastExit;
  const rl=require('node:readline').createInterface({input:process.stdin});for await(const line of rl){
   const r=parseEvent(line)||parseEvent(PREFIX+line)||parseSession(line);
   if(r){if(r.id)measured++;if(r.event==='end')lastExit=r.exit_code;console.log(JSON.stringify(r));}
  }
  process.exitCode=Number.isSafeInteger(lastExit)&&lastExit!==0?lastExit:measured?0:65;return;
 }
 if(mode==='resource-check')return displayPreflight({...require('dotenv').parse(fs.readFileSync('.env')),...process.env,WHISPLAY_LATENCY_DIAGNOSTICS:'true'});
 if(mode==='snapshot'){console.log(JSON.stringify(snapshot(),null,2));return;}
 if(mode==='verify-cleanup'){
  const records=fs.readFileSync(arg,'utf8').split('\n').map(parseSession).filter(Boolean);
  const start=records.filter(r=>r.event==='start').at(-1);
  const end=records.filter(r=>r.event==='end').at(-1);
  if(!start?.session_id||end?.session_id!==start.session_id||!end?.cleanup_verified||!records.some(r=>r.session_id===start.session_id&&r.event==='cleanup_verified'&&r.remaining===0))
   throw diagnosticError('cleanup_unverified','Diagnostic resource release was not verified; do not restart production');
  console.log(JSON.stringify({kind:'diagnostic_cleanup',verified:true}));return;
 }
 if(mode==='voice-check'&&arg==='--confirm-idle'){
  ensurePi(); // Read-only preflight is permitted while production owns the lock.
  const env={...require('dotenv').parse(fs.readFileSync('.env')),...process.env};
  displayPreflight({...env,WHISPLAY_LATENCY_DIAGNOSTICS:'true'});
  const endpoint=baselineConfig(env),axios=require('axios');
  const opts={proxy:false,maxRedirects:0,timeout:10000,maxContentLength:2*1024*1024};
  const version=(await axios.get(endpoint+'/api/version',opts)).data;if(version.version!=='0.34.4')throw diagnosticError('runtime_version','Unexpected Ollama version');
  const ps=(await axios.get(endpoint+'/api/ps',opts)).data;
  const tags=(await axios.get(endpoint+'/api/tags',opts)).data;
  const tag=tags.models?.find(x=>x.name===MODEL||x.model===MODEL);
  if(!tag||!/^[a-f0-9]{64}$/.test(tag.digest))throw Error('Installed Qwen identity is unavailable');
  residency(ps,'warm',tag.digest);
  const show=(await axios.post(endpoint+'/api/show',{model:MODEL},opts)).data;localModel(show);
  const build=compiledBuild();
  console.log(JSON.stringify({kind:'voice_preflight',config:safeConfig(env),version:version.version,digest:tag.digest,model_parameters:modelParameters(show.parameters),residency:ps,build}));return;
 }
 if(mode==='report'){
  const lines=fs.readFileSync(arg,'utf8').split('\n');if(lines.length>100000)throw Error('Report input exceeds 100000 lines');
  const rows=lines.filter(Boolean).map(line=>parseEvent(PREFIX+line)).filter(Boolean);
  const sessions=lines.filter(Boolean).map(parseSession).filter(Boolean),interactions=report(rows);
  const failures=sessions.filter(r=>r.event.endsWith('failure'));
  const lastEnd=sessions.filter(r=>r.event==='end').at(-1);
  const lastStart=sessions.filter(r=>r.event==='start').at(-1);
  const complete=interactions.filter(r=>r.outcome==='completed').length;
  const closed=!lastStart||(lastEnd?.cleanup_verified===true&&lastEnd.session_id===lastStart.session_id);
  const status=!rows.length||failures.length?'failed':complete&&closed?'measured':'incomplete';
  console.log(JSON.stringify({schema_version:1,status,reason:!rows.length?'no_interaction_measurements':null,
   sessions,completed_interactions:complete,interactions},null,2));
  process.exitCode=lastEnd?.exit_code||((status==='measured')?0:65);return;
 }
 if(mode==='inspect'){
  if(!/^\d+$/.test(arg||''))throw Error('inspect requires the actual chatbot Node PID, not a guessed service');
  const cwd=fs.readlinkSync(`/proc/${arg}/cwd`),initial=Object.fromEntries(fs.readFileSync(`/proc/${arg}/environ`,'utf8').split('\0').filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
  const configFile=path.join(cwd,'.env');
  const parsed=fs.existsSync(configFile)?require('dotenv').parse(fs.readFileSync(configFile)):{};
  console.log(JSON.stringify({kind:'inspection',pid:Number(arg),source_commit:command('git',['-C',cwd,'rev-parse','HEAD']),
   compiled_entry_sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd,'dist/index.js'))).digest('hex'),
   declared_initial_environment:safeConfig(initial),declared_file_config:safeConfig(parsed),snapshot:snapshot(),
   warning:'On-disk source/config and initial process environment are not proof of loaded runtime configuration. Require correlated runtime_config and llm_submit events for active settings. No settings were changed.'},null,2));
  const endpoint=endpointFor({OLLAMA_ENDPOINT:process.env.OLLAMA_ENDPOINT||'http://127.0.0.1:11434'});
  const axios=require('axios');for(const route of ['/api/version','/api/tags','/api/ps'])console.log(JSON.stringify({kind:route,data:(await axios.get(endpoint+route,{proxy:false,maxRedirects:0,timeout:10000,maxContentLength:2*1024*1024})).data}));return;
 }
 if(mode==='benchmark'&&['identical','incremental','cold'].includes(arg)&&rest.length===1&&rest[0]==='--confirm-idle')
  return benchmark(arg,process.env.OLLAMA_ENDPOINT||'http://127.0.0.1:11434');
 throw Error('Use plan | snapshot | inspect NODE_PID | collect | report FILE | benchmark identical|incremental|cold --confirm-idle');
}
module.exports={throttle,safeConfig,parseEvent,parseSession,displayPreflight,compiledBuild,report,residency,localModel,endpointFor,baselineConfig,benchmark,main};
if(require.main===module)main(process.argv.slice(2)).catch(error=>{
 const failure={kind:'diagnostic_session',event:'command_failure',phase:process.argv[2]==='report'?'collection':'startup',
  reason:error.diagnosticReason||(error.code==='ENOENT'?'required_file_missing':'command_failed'),exit_code:1};
 console.log(JSON.stringify(failure));console.error(JSON.stringify(failure));process.exitCode=1;
});
