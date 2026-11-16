import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { PassThrough } from "node:stream";

// Self-knowledge answers come from configuration, registered tools and the daemon capability report. Ollama and
// the daemon are fixtures; matched questions must never reach the model.
Object.assign(process.env, {
  LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true", OLLAMA_MODEL: "qwen3.5:2b-q4_K_M", ENABLE_THINKING: "false",
  ASR_SERVER: "faster-whisper", TTS_SERVER: "piper-http", PIPER_HTTP_VOICE: "glados", FASTER_WHISPER_MODEL_SIZE_OR_PATH: "base",
  FASTER_WHISPER_LANGUAGE: "en", WEB_SEARCH_ENABLED: "false", WHISPLAY_VOICE_CONTROL_ENABLED: "true", MEMORY_ENABLED: "false",
  OLLAMA_WARMUP_ATTEMPTS: "1",
});
const sk = require("../config/self-knowledge");

const production = {
  LLM_SERVER: "ollama", OLLAMA_MODEL: "qwen3.5:2b-q4_K_M", OLLAMA_ENDPOINT: "http://localhost:11434", ASR_SERVER: "faster-whisper",
  FASTER_WHISPER_MODEL_SIZE_OR_PATH: "base", FASTER_WHISPER_LANGUAGE: "en", TTS_SERVER: "piper-http", PIPER_HTTP_VOICE: "glados",
  WEB_SEARCH_PROVIDER: "tavily", IMAGE_GENERATION_SERVER: "openai",
};
const registered = ["whisplay", "getSystemHealth", "web_search", "generateImage", "showPreviouslyGeneratedImage", "searchLocalMemory", "storeLocalMemory"];
const capabilities = { api: 1, readable: ["audio"], actions: {
  brightness: { supported: true }, volume: { supported: true }, mute: { supported: true }, lock: { supported: true },
  reboot: { supported: false, reason: "x" }, shutdown: { supported: false, reason: "x" }, wifi_join: { supported: false, reason: "y" } } };
const facts = (over: any = {}) => ({ env: production, tools: registered, boardModel: "Raspberry Pi 5 Model B Rev 1.1", tvConfigured: true, capabilities, ...over });
const reply = (topic: string, over: any = {}) => sk.selfKnowledgeReply(topic, facts(over));

test("facts are derived from the running configuration, not from the model", () => {
  assert.equal(reply("model"), "My language model is qwen3.5:2b-q4_K_M, served locally by Ollama on this device.");
  assert.equal(reply("stt"), "Speech recognition is faster-whisper, model base, language en, running on this device.");
  assert.equal(reply("tts"), "My voice is synthesized by piper-http with the glados voice, running on this device.");
  const where = reply("hardware");
  assert.match(where, /^I run on this device, a Raspberry Pi 5 Model B Rev 1\.1\./);
  assert.match(where, /language model, speech recognition and speech synthesis all run on this device/);
  assert.match(where, /Web search and image generation use online services\./);
  assert.match(reply("model", { env: { ...production, OLLAMA_MODEL: "other:1b" } }), /other:1b/);
  assert.match(reply("model", { env: { ...production, OLLAMA_ENDPOINT: "http://192.168.1.9:11434" } }), /remote address/);
  assert.match(reply("tts", { env: { ...production, TTS_SERVER: "openai" } }), /not a local engine/);
  assert.match(reply("hardware", { env: { ...production, ASR_SERVER: "tencent" } }), /not local engines: speech recognition/);
});

test("supported capabilities are listed from the registry and daemon; unavailable ones are stated as unavailable", () => {
  const tools = reply("tools");
  assert.match(tools, /^I have device controls for screen brightness, speaker volume, mute, and locking the screen\. I also have system health readings, /);
  for (const part of ["system health readings", "TV volume, screen, power and navigation commands", "web search", "image generation", "saved memory"]) assert.match(tools, new RegExp(part));
  assert.doesNotMatch(tools, /music/);
  const limits = reply("limits");
  assert.match(limits, /^I cannot set timers, alarms or timed reminders\. I cannot play music because no music library is configured\./);

  assert.match(limits, /restarting the Raspberry Pi, shutting the Raspberry Pi down, and joining Wi-Fi networks/);
  assert.doesNotMatch(limits, /search the web|generate images|control a TV/);
  // A tool that is not registered is unavailable; a registered one is supported but not verified.
  assert.match(reply("limits", { tools: ["whisplay"], tvConfigured: false }), /cannot play music.*cannot search the web\. I cannot generate images\. I cannot control a TV\./);
  assert.match(reply("music", { tools: [...registered, "playMusic"] }), /^Yes\. Local music playback is set up\. I have not checked that the library is readable/);
  assert.match(reply("music"), /^No\. Music playback is not set up here because no music library is configured\./);
  assert.match(reply("search"), /needs the internet\. I have not tested the connection/);
  assert.match(reply("search", { tools: ["whisplay"] }), /^No\. Web search is not available\./);
  assert.match(reply("image"), /online service\. I have not tested the connection/);
  assert.match(reply("tv"), /have not checked that the TV is reachable/);
  assert.match(reply("tv", { tvConfigured: false }), /^No\. TV control is not set up/);
  assert.match(reply("memory"), /^Yes\./); assert.match(reply("memory", { tools: ["whisplay"] }), /^No\./);
  assert.equal(reply("timer"), "I can't set timers, alarms or timed reminders yet, so nothing has been scheduled.");
});

test("unknown or failed lookups are reported as unverified, never guessed", () => {
  assert.match(reply("hardware", { boardModel: undefined }), /^I run on this Whisplay device, but I cannot read the board model\./);
  assert.equal(reply("model", { env: {} }), "I cannot read which language model is configured.");
  assert.equal(reply("stt", { env: {} }), "I cannot read which speech recognition is configured.");
  assert.equal(reply("tts", { env: {} }), "I cannot read which speech synthesis is configured.");
  assert.match(reply("tools", { capabilities: undefined }), /device controls, which I could not verify just now/);
  assert.match(reply("limits", { capabilities: undefined }), /I could not verify which device controls are unsupported just now/);
  assert.match(reply("tools", { capabilities: { api: 1 } }), /which I could not verify just now/);
  assert.match(reply("tools", { tools: [], tvConfigured: false }), /^I have no tools registered right now\./);
  assert.match(reply("tools", { tools: ["getSystemHealth"], tvConfigured: false }), /^I have system health readings\. Ask what/);
  const internet = reply("internet");
  assert.match(internet, /I have not tested internet access, so I cannot confirm it\./);
  assert.doesNotMatch(internet, /\b(connected|online now|yes)\b/i);
  assert.doesNotMatch(reply("limits") + reply("tools") + reply("hardware"), /\b(is running|is active|is working|is reachable)\b/);
});

test("only clearly identified self-knowledge questions match", () => {
  const positives: [string, string][] = [
    ["What model are you?", "model"], ["Which AI model are you using?", "model"], ["What language model do you use?", "model"],
    ["Where do you run?", "hardware"], ["Are you running locally?", "hardware"], ["What hardware do you run on?", "hardware"],
    ["What speech recognition do you use?", "stt"], ["Which STT are you using?", "stt"],
    ["What text to speech do you use?", "tts"], ["What voice are you using?", "tts"],
    ["What tools do you have?", "tools"], ["What can't you do?", "limits"], ["What are your limitations?", "limits"],
    ["Can you play music?", "music"], ["Can you set a timer for ten minutes?", "timer"], ["Set a timer for five minutes.", "timer"],
    ["Remind me to call mum in an hour.", "timer"], ["Can you search the web?", "search"], ["Can you generate images?", "image"],
    ["Are you connected to the internet?", "internet"], ["Can you control the TV?", "tv"], ["Hey GLaDOS, what model are you?", "model"],
  ];
  for (const [q, topic] of positives) assert.equal(sk.selfKnowledgeTopic(q), topic, q);
  for (const q of ["What model of car should I buy?", "Tell me about the Raspberry Pi 5.", "What is a language model?", "Where do you think I should run?",
    "Can you play the guitar?", "Do you like music?", "What voice do you like?", "What can you do?", "Remind me of my favorite color.", "Remind me what I said about the router.",
    "How do I set a timer on my phone?", "Is the TV on?", "Turn off the TV.", "Hello.", "What is 2 plus 2?", "Can you remember my name?", "",
    "What model are you and what is the weather today?", "x".repeat(200)]) {
    assert.equal(sk.selfKnowledgeTopic(q), undefined, q);
  }
});

// ---- Through the provider: no model request, retained history, daemon read only when needed ----
const requests: any[] = [];
const daemonReads: any[] = [];
let daemonReply: () => Promise<any> = async () => capabilities;
const control = require("../device/whisplay-control");
control.whisplayRequest = async (command: string, payload: any) => { daemonReads.push([command, payload]); return daemonReply(); };

async function ask(t: any, question: string) {
  requests.length = 0; daemonReads.length = 0;
  t.mock.method(axios, "post", async (_url: string, body: any) => {
    if (!body.messages?.length) return { data: { done: true } };
    requests.push(JSON.parse(JSON.stringify(body)));
    const stream = new PassThrough();
    setImmediate(() => stream.end(JSON.stringify({ message: { content: "Model reply." }, done: true }) + "\n"));
    return { data: stream };
  });
  t.mock.method(axios, "get", async () => ({ data: { models: [{ name: "fixture", context_length: 4096 }] } }));
  const provider = require("../cloud-api/local/ollama-llm").default;
  provider.resetChatHistory();
  let text = "";
  await provider.chatWithLLMStream([{ role: "user", content: question }], (chunk: string) => { text += chunk; }, () => {});
  return text.trim();
}

test("matched questions are answered by the host without the model", async t => {
  const cases: [string, RegExp][] = [
    ["What model are you?", /^My language model is qwen3\.5:2b-q4_K_M, served locally by Ollama on this device\.$/],
    ["What speech recognition do you use?", /^Speech recognition is faster-whisper, model base/],
    ["What text to speech do you use?", /^My voice is synthesized by piper-http with the glados voice/],
    ["Can you set a timer for ten minutes?", /^I can't set timers, alarms or timed reminders yet, so nothing has been scheduled\.$/],
    ["Can you play music?", /^No\. Music playback is not set up here/],
  ];
  for (const [question, expected] of cases) {
    const text = await ask(t, question);
    assert.match(text, expected, question);
    assert.equal(requests.length, 0, `${question} reached the model`);
    assert.equal(daemonReads.length, 0, `${question} needlessly read the daemon`);
    t.mock.restoreAll();
  }
  // The existing honest reminder refusal is unchanged and still comes first.
  assert.equal(await ask(t, "Remind me in 10 minutes to stretch."), "I can't set timed reminders yet, so no reminder has been created.");
  assert.equal(requests.length, 0); t.mock.restoreAll();
});

test("limits and tools read the daemon once and survive a failed or malformed read", async t => {
  let text = await ask(t, "What can't you do?");
  assert.equal(daemonReads.length, 1); assert.deepEqual(daemonReads[0], ["control.read", { scope: "capabilities" }]);
  assert.match(text, /restarting the Raspberry Pi/); assert.equal(requests.length, 0); t.mock.restoreAll();
  daemonReply = async () => { throw new Error("daemon unavailable"); };
  text = await ask(t, "What tools do you have?");
  assert.match(text, /could not verify just now/); assert.equal(requests.length, 0); t.mock.restoreAll();
  daemonReply = async () => ({ unexpected: true });
  text = await ask(t, "What can't you do?");
  assert.match(text, /could not verify which device controls are unsupported just now/); t.mock.restoreAll();
  daemonReply = async () => capabilities;
});

test("ordinary conversation and existing commands still reach their existing paths", async t => {
  for (const question of ["Tell me about the Raspberry Pi 5.", "What is a language model?", "Do you like music?", "Hello."]) {
    const text = await ask(t, question);
    assert.equal(text, "Model reply.", question); assert.equal(requests.length, 1, question); assert.equal(daemonReads.length, 0);
    t.mock.restoreAll();
  }
  // Device and TV routing run before the model as before (a TV state question is still host-routed).
  const text = await ask(t, "What is the TV playing?");
  assert.match(text, /can't verify that about the TV/); assert.equal(requests.length, 0); t.mock.restoreAll();
});

test("the answered exchange is kept in history so a follow-up sees what was said", async t => {
  const provider = require("../cloud-api/local/ollama-llm").default;
  await ask(t, "What model are you?");
  let text = "";
  t.mock.restoreAll();
  t.mock.method(axios, "post", async (_url: string, body: any) => {
    if (!body.messages?.length) return { data: { done: true } };
    requests.push(JSON.parse(JSON.stringify(body)));
    const stream = new PassThrough();
    setImmediate(() => stream.end(JSON.stringify({ message: { content: "Fine." }, done: true }) + "\n"));
    return { data: stream };
  });
  t.mock.method(axios, "get", async () => ({ data: { models: [{ name: "fixture", context_length: 4096 }] } }));
  requests.length = 0;
  await provider.chatWithLLMStream([{ role: "user", content: "Thanks." }], (chunk: string) => { text += chunk; }, () => {});
  const sent = JSON.stringify(requests[0].messages);
  assert.match(sent, /What model are you\?/); assert.match(sent, /served locally by Ollama/);
});
