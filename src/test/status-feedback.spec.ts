import { test } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { PassThrough } from "node:stream";

// Status feedback: host-routed actions use the existing tool-call callbacks (start, then finish with an outcome
// marker), outcomes are taken only from the action's own reply, and a pending clarification only drives a display
// status. Devices and Ollama are fixtures.
Object.assign(process.env, {
  LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true", OLLAMA_MODEL: "fixture", ENABLE_THINKING: "false", WEB_SEARCH_ENABLED: "false",
  WHISPLAY_VOICE_CONTROL_ENABLED: "true", MEMORY_ENABLED: "false", OLLAMA_WARMUP_ATTEMPTS: "1",
});
const outcome = require("../config/action-outcome");
const pending = require("../utils/pending-clarification");
const tv = require("../device/lg-c1-volume");
const dc = require("../config/device-commands");

test("outcomes come only from the action's own reply", () => {
  const ok = ["Screen off.", "Screen on.", "Powering off.", "Volume adjusted.", "TV muted.", "TV unmuted.", "Waking the TV.", "Opening YouTube.",
    "Notification displayed.", "TV volume is already at zero.", "TV volume is already at maximum.", "The TV is already on."];
  const unverified = ["TV screen change is unverified.", "TV power-off is unverified.", "TV audio change is unverified.", "TV volume change is unverified.",
    "TV wake-up is unverified.", "YouTube opening is unverified.", "TV notification is unverified.", "Sent. Playback unverified.",
    "I can't verify the TV's state right now.", "The TV isn't responding on the network, so it is most likely off or in standby. I can't confirm that."];
  const failed = ["I couldn't change the TV screen.", "I couldn't power off the TV.", "I couldn't adjust TV volume.", "I couldn't change the TV audio.",
    "I couldn't wake the TV.", "I couldn't open YouTube.", "I couldn't display the TV notification.", "TV playback didn't reach the requested state.",
    "I couldn't send the TV command."];
  for (const r of ok) assert.equal(outcome.actionOutcome(r), "ok", r);
  for (const r of unverified) assert.equal(outcome.actionOutcome(r), "unverified", r);
  for (const r of failed) assert.equal(outcome.actionOutcome(r), "failed", r);
  // Anything unrecognised is neutral: no claim is made.
  for (const r of ["The TV is on.", "Use a whole TV volume from zero to one hundred.", "Device control is disabled.", "Something new.", "Done!", ""]) {
    assert.equal(outcome.actionOutcome(r), undefined, r);
  }
  assert.equal(outcome.actionOutcome("", true), "ok", "an empty playback reply means verified success");
  assert.equal(outcome.hostActionResult("Screen off."), "[host:ok]Screen off.");
  assert.equal(outcome.hostActionResult(""), "[host:done]", "never an empty result: empty means started");
  assert.equal(outcome.hostActionResult("", true), "[host:ok]");
  assert.equal(outcome.toolDisplayOutcome("[host:failed]x"), "failed");
  // Model tool results and anything else keep their existing display.
  for (const r of ["[success]{\"status\":\"completed\"}", "[error]boom", "status=completed", "", undefined, "[host:done]x", "[host:weird]x"]) {
    assert.equal(outcome.toolDisplayOutcome(r), undefined, String(r));
  }
});

test("the tool tag shows running, elapsed and the outcome", () => {
  assert.equal(outcome.formatToolTag({ name: "tv-screen" }), "% tv-screen...");
  assert.equal(outcome.formatToolTag({ name: "tv-power", elapsedSeconds: 12 }), "% tv-power 12s...");
  assert.equal(outcome.formatToolTag({ name: "tv-screen", outcome: "ok" }), "% tv-screen.ok");
  assert.equal(outcome.formatToolTag({ name: "tv-screen", outcome: "failed" }), "% tv-screen.failed");
  assert.equal(outcome.formatToolTag({ name: "tv-screen", outcome: "unverified", elapsedSeconds: 30 }), "% tv-screen.unverified");
  // The UI's own tag parser must accept every produced form as one tag.
  const parser = /(?<![A-Za-z0-9])[%％﹪]\s*([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)(?:\s+([0-9]+s))?/i;
  for (const tag of ["% tv-screen...", "% tv-power 12s...", "% tv-screen.ok", "% tv-screen.failed", "% tv-screen.unverified"]) {
    assert.ok(parser.test(tag), tag);
  }
  assert.equal(parser.exec("% tv-screen.unverified")?.[1], "tv-screen.unverified");
});

test("a pending clarification drives a display status, expires, and is cleared", async () => {
  assert.equal(pending.clarificationRemainingMs(), 0);
  assert.equal(pending.idleStatusFor(pending.clarificationRemainingMs()), "idle");
  pending.markClarification(80);
  assert.ok(pending.clarificationRemainingMs() > 0 && pending.clarificationRemainingMs() <= 80);
  assert.equal(pending.idleStatusFor(pending.clarificationRemainingMs()), "Your turn");
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(pending.clarificationRemainingMs(), 0, "expired without any further call");
  assert.equal(pending.idleStatusFor(pending.clarificationRemainingMs()), "idle");
  pending.markClarification(10_000); pending.clearClarification();
  assert.equal(pending.clarificationRemainingMs(), 0);
  // The status never claims the microphone: it must classify as neither listening nor transcribing in the UI,
  // which is covered by the UI self-test; here only the exact strings are fixed.
  assert.deepEqual([pending.idleStatusFor(1), pending.idleStatusFor(0)], ["Your turn", "idle"]);
});

// ---- Provider: callbacks around host-routed actions ----
const events: string[] = [];
const results: Record<string, string | Error> = {};
const requests: any[] = [];
const fake = (name: string) => async () => { events.push(`run:${name}`); const r = results[name] ?? "fixture reply"; if (r instanceof Error) throw r; return r; };
for (const name of ["setTvScreenAndReply", "turnOffTvAndReply", "turnOnTvAndReply", "lowerTvVolumeAndReply", "changeTvAudioAndReply", "tvPowerStatusAndReply", "changeTvPlaybackAndReply"]) tv[name] = fake(name);

async function ask(t: any, question: string, replies: Record<string, string | Error> = {}) {
  events.length = 0; requests.length = 0;
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
  await provider.chatWithLLMStream([{ role: "user", content: question }],
    (chunk: string) => { events.push(`say:${chunk.trim()}`); text += chunk; }, () => {}, undefined,
    (name: string, result?: string) => { events.push(result === undefined ? `start:${name}` : `finish:${name}:${result}`); });
  return text.trim();
}

test("host-routed actions announce start, then exactly one finish with the outcome, before the reply", async t => {
  const cases: [string, string, string, string, string][] = [
    ["Put the television in standby.", "turnOffTvAndReply", "tv-power", "Powering off.", "ok"],
    ["Put the TV in standby.", "turnOffTvAndReply", "tv-power", "TV power-off is unverified.", "unverified"],
    ["Turn off the TV.", "turnOffTvAndReply", "tv-power", "I couldn't power off the TV.", "failed"],
    ["Turn off the TV screen.", "setTvScreenAndReply", "tv-screen", "Screen off.", "ok"],
    ["Make the TV screen black.", "setTvScreenAndReply", "tv-screen", "TV screen change is unverified.", "unverified"],
    ["Turn the picture off but keep the sound.", "setTvScreenAndReply", "tv-screen", "I couldn't change the TV screen.", "failed"],
    ["Lower the TV volume a bit.", "lowerTvVolumeAndReply", "tv-volume", "Volume adjusted.", "ok"],
    ["Make the TV louder.", "changeTvAudioAndReply", "tv-audio", "TV audio change is unverified.", "unverified"],
    ["Is the TV on?", "tvPowerStatusAndReply", "tv-status", "The TV is on.", "done"],
  ];
  for (const [question, fn, label, reply, expected] of cases) {
    const text = await ask(t, question, { [fn]: reply });
    assert.equal(text, reply, question);
    const marker = expected === "done" ? "[host:done]" : `[host:${expected}]`;
    assert.deepEqual(events, [`start:${label}`, `run:${fn}`, `finish:${label}:${marker}${reply}`, `say:${reply}`], question);
    assert.equal(requests.length, 0, `${question} used the model`);
    t.mock.restoreAll();
  }
});

test("a silent verified playback result is a success tag with no spoken reply", async t => {
  const text = await ask(t, "Pause on the TV.", { changeTvPlaybackAndReply: "" });
  assert.equal(text, "");
  assert.deepEqual(events, ["start:tv-playback", "run:changeTvPlaybackAndReply", "finish:tv-playback:[host:ok]"]);
  t.mock.restoreAll();
});

test("an action that throws still finishes its tag, so no state is left running", async t => {
  const starts = () => events.filter(e => e.startsWith("start:")).length, finishes = () => events.filter(e => e.startsWith("finish:")).length;
  await ask(t, "Turn off the TV.", { turnOffTvAndReply: new Error("boom") });
  assert.equal(starts(), 1); assert.equal(finishes(), 1);
  assert.ok(events.some(e => e === "finish:tv-power:[host:unverified]"), "an interrupted action is shown as unverified, never as success");
  t.mock.restoreAll();
});

test("normal conversation, self-knowledge and prompts show no action status", async t => {
  for (const question of ["Hello.", "What is 2 plus 2?", "What model are you?", "Can you set a timer for ten minutes?", "Make the screen black.", "I can't hear the TV.",
    "Turn off the TV and mute yourself.", "What is the TV playing?", "Open Netflix on the TV."]) {
    await ask(t, question);
    assert.deepEqual(events.filter(e => /^(start|finish):/.test(e)), [], question);
    t.mock.restoreAll();
  }
  const text = await ask(t, "Hello.");
  assert.equal(text, "Model reply."); assert.equal(requests.length, 1);
  t.mock.restoreAll();
});

test("clarification pending is set only when the host is actually waiting, and ends when it is answered or ignored", async t => {
  pending.clearClarification();
  let text = await ask(t, "Make the screen black.");
  assert.equal(text, dc.SCREEN_TARGET_PROMPT);
  assert.ok(pending.clarificationRemainingMs() > 25_000, "pending for the answer window");
  t.mock.restoreAll();
  text = await ask(t, "The TV.", { setTvScreenAndReply: "Screen off." });
  assert.equal(pending.clarificationRemainingMs(), 0, "answering consumes it");
  assert.deepEqual(events, ["start:tv-screen", "run:setTvScreenAndReply", "finish:tv-screen:[host:ok]Screen off.", "say:Screen off."]);
  t.mock.restoreAll();
  await ask(t, "Make the screen dark."); assert.ok(pending.clarificationRemainingMs() > 0); t.mock.restoreAll();
  await ask(t, "Hello."); assert.equal(pending.clarificationRemainingMs(), 0, "an unrelated message cancels it"); t.mock.restoreAll();
  // Other prompts are hints, not pending questions.
  for (const question of ["I can't hear the TV.", "It's too loud.", "What can't you do?"]) {
    await ask(t, question); assert.equal(pending.clarificationRemainingMs(), 0, question); t.mock.restoreAll();
  }
});
