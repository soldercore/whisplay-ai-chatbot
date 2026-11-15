import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { PassThrough } from "node:stream";

// Multi-action TV requests. No device is contacted: handlers are recorders and Ollama is a fixture.
Object.assign(process.env, {
  LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "true", OLLAMA_MODEL: "fixture", ENABLE_THINKING: "false",
  WEB_SEARCH_ENABLED: "false", WHISPLAY_VOICE_CONTROL_ENABLED: "true", ASSISTANT_PERSONA: "glados",
  MEMORY_ENABLED: "false", OLLAMA_WARMUP_ATTEMPTS: "1",
});
const chain = require("../config/action-chain");
const tv = require("../device/lg-c1-volume");
const dc = require("../config/device-commands");

const kinds = (plan: any) => plan?.steps?.map((s: any) => s.kind === "audio" ? `audio:${s.command.action}${s.command.volume ?? s.command.mute ?? ""}` : s.kind === "search" ? `search:${s.query}` : s.kind);

// ---- Planning -----------------------------------------------------------------------------------------------------------
test("the example request becomes three ordered steps", () => {
  assert.deepEqual(kinds(chain.planChain("Turn on the TV, search YouTube for Interstellar soundtrack, and set the volume to 10.")),
    ["power-on", "search:Interstellar soundtrack", "audio:setVolume10"]);
  assert.deepEqual(kinds(chain.planChain("Turn on the TV, search YouTube for Interstellar soundtrack and set the volume to 10")),
    ["power-on", "search:Interstellar soundtrack", "audio:setVolume10"], "no commas or final full stop are needed");
});

test("two-step chains, polite requests and spoken order", () => {
  assert.deepEqual(kinds(chain.planChain("Turn on the TV and set the volume to 10.")), ["power-on", "audio:setVolume10"]);
  assert.deepEqual(kinds(chain.planChain("Could you turn on the TV and set the volume to 10?")), ["power-on", "audio:setVolume10"]);
  assert.deepEqual(kinds(chain.planChain("Mute the TV, then turn off the TV screen")), ["audio:setMute", "screen"].map(x => x === "audio:setMute" ? "audio:setMutetrue" : x));
  assert.deepEqual(kinds(chain.planChain("Set the TV volume to 5 and turn off the TV.")), ["audio:setVolume5", "power-off"]);
});

test("power-on always runs first and power-off last, whatever the spoken order", () => {
  assert.deepEqual(kinds(chain.planChain("Set the volume to 10 and turn on the TV.")), ["power-on", "audio:setVolume10"]);
  assert.deepEqual(kinds(chain.planChain("Search YouTube for jazz, set the TV volume to 8, and turn on the TV")), ["power-on", "search:jazz", "audio:setVolume8"]);
});

test("a bare volume means the TV only inside a TV chain; standing alone it keeps its meaning", () => {
  assert.equal(chain.planChain("Set the volume to 10."), undefined);
  assert.equal(chain.planChain("Set the volume to 10 and turn off your screen."), undefined, "no TV involved: not a chain");
  assert.equal(chain.planChain("Tell me about YouTube and set the volume to 10."), undefined, "a mention of YouTube is not a TV request");
  assert.deepEqual(dc.parseDeviceCommand("Set the volume to 10.")?.args, { action: "volume", level: 10 });
});

test("YouTube queries keep their own 'and', and a command boundary ends them", () => {
  assert.equal(chain.planChain("Search YouTube for Tom and Jerry."), undefined, "a single request is routed as before");
  assert.equal(chain.planChain("Search YouTube for rock and roll"), undefined);
  assert.deepEqual(kinds(chain.planChain("Search YouTube for Tom and Jerry and set the TV volume to 10")), ["search:Tom and Jerry", "audio:setVolume10"]);
  assert.deepEqual(kinds(chain.planChain("Turn on the TV, search YouTube for Stop and Go, then set the volume to 4")), ["power-on", "search:Stop and Go", "audio:setVolume4"]);
  // an 'and play ...' that is not a supported request stays part of the query
  assert.equal(chain.planChain("Search YouTube for make it rain and play it loud"), undefined);
  // the old defect: the whole tail used to become the search
  assert.equal(tv.getYoutubeSearchQuery("Search YouTube for Interstellar soundtrack and set the TV volume to 10"), "Interstellar soundtrack and set the TV volume to 10");
  assert.deepEqual(kinds(chain.planChain("Search YouTube for Interstellar soundtrack and set the TV volume to 10")), ["search:Interstellar soundtrack", "audio:setVolume10"]);
});

test("the whole request is validated before anything runs: unsupported, unsafe and ambiguous clauses refuse", () => {
  for (const [text, mention] of [
    ["Turn on the TV and change the channel to five.", "change the channel"],
    ["Turn on the TV, search YouTube for jazz, and open Netflix.", "open netflix"],
    ["Search YouTube for jazz, then reboot the Raspberry Pi.", "reboot"],
    ["Turn on the TV and set the volume to 200.", "volume"],
  ]) {
    const plan = chain.planChain(text);
    assert.ok(plan && "refusal" in plan, text);
    assert.match(plan.refusal.toLowerCase(), new RegExp(mention), text);
    assert.match(plan.refusal, /Nothing was changed\./);
  }
  assert.deepEqual(chain.planChain("Turn on the TV and set your volume to 10."), { refusal: dc.TV_MIXED_REPLY }, "different devices are never reinterpreted");
  assert.deepEqual(chain.planChain("Mute the TV and lower your brightness."), { refusal: dc.TV_MIXED_REPLY });
  for (const text of ["Turn on the TV and turn off the TV.", "Turn off the TV and set the volume to 5.", "Set the TV volume to 10 and set the TV volume to 20.",
    "Turn on the TV, turn off the TV screen, set the TV volume to 10, mute the TV, and search YouTube for jazz."]) {
    const plan = chain.planChain(text);
    assert.ok(plan && "refusal" in plan, text);
  }
});

test("everything that is not a chain is left exactly as it was", () => {
  for (const text of ["Turn on the TV.", "Turn the TV back on, please.", "Search YouTube for Interstellar soundtrack.", "Lower the TV volume a bit.",
    "Open YouTube on the TV.", "What time is it, and what is the weather?", "Turn on the TV and the lights.", "Tell me a joke and then sing.",
    "Is the TV on?", "", "and", "Turn on the TV, please.", "Tell me about the TV and play a song."]) {
    assert.equal(chain.planChain(text), undefined, JSON.stringify(text));
  }
});

// ---- Execution and the one reply ---------------------------------------------------------------------------------------------
function handlers(log: string[], replies: Record<string, string | Error> = {}) {
  const run = (name: string, fallback: string) => async () => {
    log.push(name);
    const reply = replies[name] ?? fallback;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return {
    powerOn: run("powerOn", "Waking the TV."), powerOff: run("powerOff", "Powering off."), screen: run("screen", "Screen off."), volumeDown: run("volumeDown", "Volume adjusted."),
    audio: run("audio", "Volume adjusted."), search: run("search", "Search sent to YouTube."), youtube: run("youtube", "Opening YouTube."),
  };
}
const example = () => chain.planChain("Turn on the TV, search YouTube for Interstellar soundtrack, and set the volume to 10.").steps;

test("steps run in order and the reply states only what was verified", async () => {
  const log: string[] = [];
  const results = await chain.runChain(example(), handlers(log));
  assert.deepEqual(log, ["powerOn", "search", "audio"]);
  const reply = chain.composeChainReply(results);
  assert.match(reply, /^The TV is on, the search request went to YouTube and the TV volume is 10\./);
  assert.doesNotMatch(reply, /result|display|showing|playing|found/i, "a sent search is never described as results");
  assert.equal(reply.split("\n").length, 1);
});

test("a failed prerequisite skips its dependents and says so", async () => {
  for (const bad of ["I couldn't wake the TV.", "TV wake-up is unverified."]) {
    const log: string[] = [];
    const results = await chain.runChain(example(), handlers(log, { powerOn: bad }));
    assert.deepEqual(log, ["powerOn"], "nothing dependent runs");
    const reply = chain.composeChainReply(results);
    assert.match(reply, /skipped the YouTube search and the volume change because the TV did not confirm it was on/);
    assert.doesNotMatch(reply, /The TV is on|volume is 10/);
  }
  const log: string[] = [];
  const already = await chain.runChain(example(), handlers(log, { powerOn: "The TV is already on." }));
  assert.deepEqual(log, ["powerOn", "search", "audio"], "an already-on TV is a satisfied prerequisite");
  assert.match(chain.composeChainReply(already), /^The TV was already on, /);
});

test("an independent failure does not stop the other steps and is reported plainly", async () => {
  const log: string[] = [];
  const results = await chain.runChain(example(), handlers(log, { search: "I couldn't send the YouTube search." }));
  assert.deepEqual(log, ["powerOn", "search", "audio"]);
  const reply = chain.composeChainReply(results);
  assert.match(reply, /^The TV is on and the TV volume is 10\. I couldn't send the YouTube search\.$/);
  const unverified = chain.composeChainReply(await chain.runChain(example(), handlers([], { audio: "TV audio change is unverified." })));
  assert.match(unverified, /I couldn't confirm the volume change\./);
  assert.doesNotMatch(unverified, /volume is 10/);
});

test("a thrown handler is a failure, an unknown reply is never success, and an abort stops the chain", async () => {
  const thrown = chain.composeChainReply(await chain.runChain(example(), handlers([], { search: new Error("boom") })));
  assert.match(thrown, /I couldn't send the YouTube search\./);
  const odd = chain.composeChainReply(await chain.runChain(example(), handlers([], { audio: "Something else entirely." })));
  assert.match(odd, /couldn't confirm the volume change/);
  let stop = false;
  const log: string[] = [];
  const h = handlers(log);
  const original = h.powerOn;
  h.powerOn = async () => { const r = await original(); stop = true; return r; };
  await assert.doesNotReject(chain.runChain(example(), h, () => stop));
  assert.deepEqual(log, ["powerOn"], "nothing runs after an abort");
});

test("the closing remark appears only with the GLaDOS persona and only when everything was verified", async () => {
  const ok = chain.composeChainReply(await chain.runChain(example(), handlers([])));
  assert.match(ok, /(?:Do try to look pleased|Efficiency, as ever|You are welcome)\.$/);
  const failedReply = chain.composeChainReply(await chain.runChain(example(), handlers([], { search: "I couldn't send the YouTube search." })));
  assert.doesNotMatch(failedReply, /Efficiency|pleased|welcome/);
  process.env.ASSISTANT_PERSONA = "default";
  try { assert.doesNotMatch(chain.composeChainReply(await chain.runChain(example(), handlers([]))), /Efficiency|pleased|welcome/); }
  finally { process.env.ASSISTANT_PERSONA = "glados"; }
});

// ---- Through the real provider: one reply, no model, existing handlers ---------------------------------------------------------
const calls: string[] = [];
const results: Record<string, string> = {};
const requests: any[] = [];
const defaults: Record<string, string> = {
  turnOnTvAndReply: "Waking the TV.", turnOffTvAndReply: "Powering off.", setTvScreenAndReply: "Screen off.", lowerTvVolumeAndReply: "Volume adjusted.",
  changeTvAudioAndReply: "Volume adjusted.", searchYoutubeAndReply: "Search sent to YouTube.", openYoutubeAndReply: "Opening YouTube.",
};
for (const name of Object.keys(defaults)) {
  tv[name] = async (...args: any[]) => {
    const arg = args[0];
    calls.push(`${name}${typeof arg === "string" ? `(${arg})` : arg?.action ? `(${arg.action}${arg.volume ?? ""})` : ""}`);
    return results[name] ?? defaults[name];
  };
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
  const chunks: string[] = [];
  const tags: string[] = [];
  await provider.chatWithLLMStream([{ role: "user", content: question }], (chunk: string) => { chunks.push(chunk); }, () => {}, undefined, (name: string, result?: string) => { tags.push(result ? `${name}:${result.slice(0, 11)}` : name); });
  return { text: chunks.join(""), chunks, tags };
}

test("the example runs the existing handlers in order and speaks once", async t => {
  const out = await ask(t, "Turn on the TV, search YouTube for Interstellar soundtrack, and set the volume to 10.");
  assert.deepEqual(calls, ["turnOnTvAndReply", "searchYoutubeAndReply(Interstellar soundtrack)", "changeTvAudioAndReply(setVolume10)"]);
  assert.equal(requests.length, 0, "the model is never involved");
  assert.equal(out.chunks.length, 1, "exactly one spoken reply, no per-step speech");
  assert.match(out.text, /^The TV is on, the search request went to YouTube and the TV volume is 10\./);
  assert.ok(out.tags.filter(x => x.startsWith("tv-")).length >= 3, "progress is shown as the usual tool tags");
});

test("a failed power-on stops the dependents through the real provider", async t => {
  const out = await ask(t, "Turn on the TV and set the volume to 10.", { turnOnTvAndReply: "I couldn't wake the TV." });
  assert.deepEqual(calls, ["turnOnTvAndReply"]);
  assert.match(out.text, /skipped the volume change because the TV did not confirm it was on/);
  assert.equal(out.chunks.length, 1);
});

test("unsupported, mixed-device and negated requests run nothing", async t => {
  let out = await ask(t, "Turn on the TV and change the channel to five.");
  assert.deepEqual(calls, []); assert.match(out.text, /Nothing was changed/); assert.equal(requests.length, 0);
  out = await ask(t, "Turn on the TV and set your volume to 10.");
  assert.deepEqual(calls, []); assert.equal(out.text, dc.TV_MIXED_REPLY);
  out = await ask(t, "Don't turn on the TV and set the volume to 10.");
  assert.deepEqual(calls, []); assert.equal(out.text, "Understood. No device setting changed.");
});

test("single requests are routed exactly as before", async t => {
  await ask(t, "Turn on the TV."); assert.deepEqual(calls, ["turnOnTvAndReply"]);
  await ask(t, "Search YouTube for Tom and Jerry."); assert.deepEqual(calls, ["searchYoutubeAndReply(Tom and Jerry)"]);
  await ask(t, "Set the TV volume to 10."); assert.deepEqual(calls, ["changeTvAudioAndReply(setVolume10)"]);
  await ask(t, "Turn off the TV."); assert.deepEqual(calls, ["turnOffTvAndReply"]);
  await ask(t, "Set the volume to 10."); assert.deepEqual(calls, [], "a bare volume still means Whisplay's speaker");
});

test("the old search-query defect is fixed through the provider", async t => {
  await ask(t, "Search YouTube for Interstellar soundtrack and set the TV volume to 10");
  assert.deepEqual(calls, ["searchYoutubeAndReply(Interstellar soundtrack)", "changeTvAudioAndReply(setVolume10)"]);
});

// ---- The tests must fail when a safeguard is removed -----------------------------------------------------------------------------
async function violations(mod: any): Promise<string[]> {
  const found: string[] = [];
  const check = (ok: boolean, what: string) => { if (!ok) found.push(what); };
  const steps = (text: string) => kinds(mod.planChain(text));
  check(JSON.stringify(steps("Turn on the TV and set the volume to 10.")) === JSON.stringify(["power-on", "audio:setVolume10"]), "bare volume is not the TV inside a TV chain");
  check(JSON.stringify(steps("Set the volume to 10 and turn on the TV.")) === JSON.stringify(["power-on", "audio:setVolume10"]), "power-on is not first");
  check(JSON.stringify(steps("Search YouTube for Tom and Jerry and set the TV volume to 10")) === JSON.stringify(["search:Tom and Jerry", "audio:setVolume10"]), "query boundary is wrong");
  check(mod.planChain("Search YouTube for make it rain and play it loud") === undefined, "a legitimate query containing 'and' was split");
  check(!!mod.planChain("Turn on the TV and change the channel to five.")?.refusal, "an unsupported clause did not stop the whole chain");
  check(mod.planChain("Turn on the TV and set your volume to 10.")?.refusal === dc.TV_MIXED_REPLY, "different devices were reinterpreted");
  check(!!mod.planChain("Turn off the TV and set the volume to 5.")?.refusal, "a request after power-off was accepted");
  check(mod.planChain("Tell me about YouTube and set the volume to 10.") === undefined, "ordinary conversation was hijacked");
  check(mod.planChain("Tell me about the TV and play a song.") === undefined, "a request with no TV action was treated as a chain");
  check(!!mod.planChain("Set the TV volume to 10 and set the TV volume to 20.")?.refusal, "duplicate requests were accepted");
  const log: string[] = [];
  await mod.runChain(example(), handlers(log, { powerOn: "I couldn't wake the TV." }));
  check(log.length === 1, "dependents ran after a failed prerequisite");
  const reply = mod.composeChainReply(await mod.runChain(example(), handlers([], { audio: "Something else entirely." })));
  check(!/volume is 10/.test(reply), "an unknown reply was reported as success");
  const log2: string[] = [];
  await mod.runChain(example(), handlers(log2, { search: "I couldn't send the YouTube search." }));
  check(log2.length === 3, "an independent failure stopped the chain");
  return found;
}

test("the safeguards hold in the real implementation", async () => {
  assert.deepEqual(await violations(chain), []);
});

test("every essential safeguard is caught when removed", async () => {
  const sourcePath = path.resolve(__dirname, "../config/action-chain.ts");
  const source = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
  const mutants: [string, string, string][] = [
    ["bare volume not TV in a chain", "  if (mentionsExternalTv(clause)) return clause;\n  return clause\n", "  return clause; return clause\n"],
    ["no reordering", "const ordered = [...steps.filter(s => s.kind === \"power-on\"), ...steps.filter(s => s.kind !== \"power-on\" && s.kind !== \"power-off\"), ...steps.filter(s => s.kind === \"power-off\")];", "const ordered = steps;"],
    ["explicit-boundary rule removed", "if (step.kind === \"search\" && !b.explicit) continue;", ""],
    ["unsupported clause tolerated", "if (\"unsupported\" in parsed) return refuse(`I can't do ${quote(parsed.unsupported)} in a chain.`);", "if (\"unsupported\" in parsed) return;"],
    ["mixed devices not refused", "if (isMixedDeviceRequest(text)) return { refusal: TV_MIXED_REPLY };", ""],
    ["request after power-off allowed", "if (off === 0) return refuse(\"I can't do anything with the TV after switching it off.\");", ""],
    ["hijack guard removed", "if (!pieces.some(piece => { const c = clause(piece, true); return !!c && !(\"invalid\" in c); })) return;", ""],
    ["YouTube mention counts as TV context", "const tvContext = mentionsExternalTv(text) || pieces.some(piece => { const c = clause(piece, false); return !!c && \"kind\" in c && (c.kind === \"search\" || c.kind === \"youtube\"); });", "const tvContext = mentionsExternalTv(text) || /\\byou ?tube\\b/i.test(text);"],
    ["duplicates allowed", "if (seen.has(key)) return refuse(`You gave me two ${key} requests.`);", ""],
    ["dependents run after a failed prerequisite", "if (step.kind === \"power-on\" && outcome !== \"done\" && outcome !== \"noop\") tvOn = false;", ""],
    ["unknown reply counts as success", "return \"unverified\";                                     // an unrecognised reply is never upgraded to success", "return \"done\";"],
    ["an independent failure stops the chain", "const outcome = reply ? classify(reply) : \"failed\";", "const outcome = reply ? classify(reply) : \"failed\"; if (outcome === \"failed\" && step.kind !== \"power-on\") { results.push({ step, outcome, reply }); break; }"],
  ];
  for (const [name, from, to] of mutants) {
    assert.equal(source.split(from).length - 1, 1, `mutation point exists: ${name}`);
    const file = path.resolve(__dirname, `../config/.mutant-chain-${Math.floor(Math.random() * 1e9)}.ts`);
    fs.writeFileSync(file, source.replace(from, to));
    try {
      const mutant = require(file);
      assert.notEqual((await violations(mutant)).length, 0, `the tests do not notice: ${name}`);
    } finally { fs.rmSync(file, { force: true }); }
  }
});
