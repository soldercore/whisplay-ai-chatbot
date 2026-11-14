import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { PassThrough } from "node:stream";

// Natural-language TV commands. No device is contacted: the TV actions are replaced by recorders,
// and Ollama is a fixture, so these tests also show which requests never reach the model.
Object.assign(process.env, {
  LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true", OLLAMA_MODEL: "fixture", ENABLE_THINKING: "false",
  WEB_SEARCH_ENABLED: "false", WHISPLAY_VOICE_CONTROL_ENABLED: "true", ASSISTANT_PERSONA: "glados",
  MEMORY_ENABLED: "false", OLLAMA_WARMUP_ATTEMPTS: "1",
});
const tv = require("../device/lg-c1-volume");
const dc = require("../config/device-commands");

const screen = (q: string) => tv.getTvScreenAction(q);
const power = (q: string) => tv.isTurnOffTv(q) ? "off" : tv.isTurnOnTv(q) ? "on" : undefined;
const audio = (q: string) => tv.isTvVolumeDown(q) ? "down" : tv.getTvAudioCommand(q)?.action;

test("TV volume: different wordings of the same supported intent", () => {
  for (const q of ["Turn up the TV volume.", "Make the TV louder.", "Turn the volume up on the TV.", "Could you make the TV louder, please?",
    "Raise the TV volume a little.", "Make the television louder a bit."]) assert.equal(audio(q), "volumeUp", q);
  for (const q of ["Turn the TV volume down.", "Make the television quieter.", "Lower the TV volume a bit.", "Turn the volume down on the TV.",
    "Would you lower the TV volume slightly?"]) assert.equal(audio(q), "down", q);
  assert.deepEqual(tv.getTvAudioCommand("Set the TV volume to twenty."), { action: "setVolume", volume: 20 });
  assert.deepEqual(tv.getTvAudioCommand("Mute the TV."), { action: "setMute", mute: true });
});

test("TV screen and TV standby stay separate intents", () => {
  for (const q of ["Turn off the TV screen.", "Switch off the TV display.", "Turn the picture off but keep the sound.",
    "Make the TV screen black.", "Could you turn off the TV screen please?", "Turn off the TV picture."]) {
    assert.equal(screen(q), "off", q);
    assert.equal(power(q), undefined, `${q} must never be standby`);
  }
  for (const q of ["Turn on the TV screen.", "Turn the TV screen back on."]) { assert.equal(screen(q), "on", q); assert.equal(power(q), undefined, q); }
  for (const q of ["Turn off the TV.", "Put the television in standby.", "Put the TV on standby.", "Switch the TV off.", "Could you turn off the TV, please?"]) {
    assert.equal(power(q), "off", q);
    assert.equal(screen(q), undefined, `${q} is not screen-only`);
  }
  for (const q of ["Turn on the TV.", "Turn the TV back on.", "Switch the TV back on."]) assert.equal(power(q), "on", q);
});

test("questions, ambiguous statements and unsupported actions are not TV commands", () => {
  for (const q of ["How do I lower the TV volume?", "Is the TV on?", "Why is the TV screen black?", "What is the TV volume?", "Can you hear the TV?",
    "Do you know how to turn off the TV?", "I can't hear the TV.", "The TV is too loud.", "Turn off the TV in ten minutes.", "Turn off the TV and the lights.",
    "Don't turn off the TV.", "If it is late, turn off the TV."]) {
    assert.equal(screen(q), undefined, q); assert.equal(power(q), undefined, q); assert.equal(audio(q), undefined, q);
  }
  for (const q of ["I can't hear the TV.", "The TV is too loud.", "The TV is too quiet."]) assert.ok(dc.isUnclearTvObservation(q), q);
  assert.ok(!dc.isUnclearTvObservation("How do I lower the TV volume?"));
  assert.ok(dc.isUnclearVolumeObservation("It's too loud. Turn it down.") && dc.isUnclearVolumeObservation("It's too loud."));
  for (const q of ["Change the TV channel.", "Switch the TV to HDMI two.", "Open Netflix on the TV."]) assert.ok(dc.isExternalTvRequest(q), q);
  assert.ok(!dc.isExternalTvRequest("How do I lower the TV volume?"));
});

test("Whisplay's own commands are unchanged and never take the TV", () => {
  assert.deepEqual(dc.parseDeviceCommand("Turn off the screen.")?.args, { action: "lock" });
  assert.deepEqual(dc.parseDeviceCommand("Make yourself quieter.")?.args, { action: "volume", change: -10 });
  assert.deepEqual(dc.parseDeviceCommand("Turn your volume down.")?.args, { action: "volume", change: -10 });
  assert.ok(dc.mentionsExternalTv("Turn the volume up on the TV.") && dc.mentionsExternalTv("pause the T.V.") && !dc.mentionsExternalTv("Turn the volume up."));
});

// ---- Provider routing with fixture Ollama and recorded TV actions ----
const calls: string[] = [];
const results: Record<string, string> = {};
const requests: any[] = [];
const originals: Record<string, any> = {};
for (const name of ["setTvScreenAndReply", "turnOffTvAndReply", "turnOnTvAndReply", "lowerTvVolumeAndReply", "changeTvAudioAndReply"]) {
  originals[name] = tv[name];
  tv[name] = async (...args: any[]) => { calls.push(`${name}${args[0] && typeof args[0] !== "object" ? `(${args[0]})` : args[0]?.action ? `(${args[0].action})` : ""}`); return results[name] ?? "fixture reply"; };
}

async function ask(t: any, question: string, replies: Record<string, string> = {}) {
  calls.length = 0; requests.length = 0;
  Object.keys(results).forEach(k => delete results[k]); Object.assign(results, replies);
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
  return text;
}

test("routed TV requests run exactly one TV action and never reach the model", async t => {
  const cases: [string, string][] = [
    ["Put the television in standby.", "turnOffTvAndReply"],
    ["Could you turn off the TV, please?", "turnOffTvAndReply"],
    ["Turn the TV back on.", "turnOnTvAndReply"],
    ["Turn the picture off but keep the sound.", "setTvScreenAndReply(off)"],
    ["Turn off the TV screen.", "setTvScreenAndReply(off)"],
    ["Lower the TV volume a bit.", "lowerTvVolumeAndReply"],
    ["Turn the volume up on the TV.", "changeTvAudioAndReply(volumeUp)"],
  ];
  for (const [question, call] of cases) {
    const text = await ask(t, question);
    assert.deepEqual(calls, [call], question);
    assert.equal(requests.length, 0, `${question} used the model`);
    assert.equal(text.trim(), "fixture reply");
    t.mock.restoreAll();
  }
});

test("failed and unknown device results are spoken as returned, never upgraded to success", async t => {
  for (const [question, fn, reply] of [
    ["Put the TV in standby.", "turnOffTvAndReply", "TV power-off is unverified."],
    ["Turn the TV back on.", "turnOnTvAndReply", "I couldn't wake the TV."],
    ["Make the TV screen black.", "setTvScreenAndReply", "TV screen change is unverified."],
    ["Turn the volume down on the TV.", "lowerTvVolumeAndReply", "I couldn't adjust TV volume."],
  ]) {
    const text = await ask(t, question, { [fn]: reply });
    assert.equal(text.trim(), reply, question);
    assert.equal(requests.length, 0);
    t.mock.restoreAll();
  }
});

test("unsupported TV actions, observations and questions get honest handling and no Whisplay tool", async t => {
  let text = await ask(t, "Open Netflix on the TV.");
  assert.equal(text.trim(), dc.TV_UNSUPPORTED_REPLY); assert.deepEqual(calls, []); assert.equal(requests.length, 0);
  t.mock.restoreAll();
  text = await ask(t, "I can't hear the TV.");
  assert.equal(text.trim(), dc.TV_VOLUME_PROMPT); assert.deepEqual(calls, []); assert.equal(requests.length, 0);
  t.mock.restoreAll();
  text = await ask(t, "How do I lower the TV volume?");
  assert.deepEqual(calls, [], "a question is not a command");
  assert.equal(requests.length, 1, "one plain model answer; no retry demanding a Whisplay tool");
  assert.ok(!(requests[0].tools || []).some((tool: any) => tool.function.name === "whisplay"), "Whisplay controls must not be offered for a TV request");
  t.mock.restoreAll();
});
