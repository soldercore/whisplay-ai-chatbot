// Assistant persona selection (ASSISTANT_PERSONA): prompt choice and fallback,
// system prompt composition, and persona wording of memory command replies.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { memoryReply, personaName, personaPrompt } from "../config/persona";
import { ollamaDraftOptions } from "../cloud-api/local/ollama-generation-options";

const ORIGINAL_PROMPT =
  "You are a young and cheerful girl who loves to talk, chat, help others, and learn new things. You enjoy using emoji expressions. Never answer longer than 200 words. Always keep your answers concise and to the point.";
const SPEECH_PROMPT = " Format your replies for spoken text-to-speech.";
const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisplay-persona-spec-"));
let memory: any;

before(() => {
  Object.assign(process.env, { MEMORY_ENABLED: "true", MEMORY_DIR: memoryDir, ASSISTANT_PERSONA: "default", GLADOS_PERSONA_VARIANT: "A" });
  memory = require("../config/local-memory");
});

after(() => {
  process.env.ASSISTANT_PERSONA = "default";
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

// The system prompt is built when llm-config is loaded, so load it in a fresh process.
const systemPromptWith = (env: Record<string, string>): string =>
  execFileSync(
    process.execPath,
    ["--require", "ts-node/register/transpile-only", "-e", 'console.log = () => {}; process.stdout.write(require("./src/config/llm-config").systemPrompt)'],
    {
      env: { ...process.env, ASSISTANT_PERSONA: "", GLADOS_PERSONA_VARIANT: "A", SYSTEM_PROMPT: "", WAKE_WORD_ENABLED: "false", ...env },
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf8",
    },
  );

const count = (text: string, part: string) => text.split(part).length - 1;

test("ASSISTANT_PERSONA selects GLaDOS; anything else keeps the default persona", () => {
  assert.equal(personaName({}), "default");
  assert.equal(personaName({ ASSISTANT_PERSONA: "" }), "default");
  assert.equal(personaName({ ASSISTANT_PERSONA: "default" }), "default");
  assert.equal(personaName({ ASSISTANT_PERSONA: " GLaDOS " }), "glados");
  assert.equal(personaName({ ASSISTANT_PERSONA: "glados" }), "glados");
  assert.equal(personaName({ ASSISTANT_PERSONA: "wheatley" }), "default");
});

test("the default persona keeps the original prompt and SYSTEM_PROMPT; GLaDOS replaces both", () => {
  assert.equal(personaPrompt({}), ORIGINAL_PROMPT);
  assert.equal(personaPrompt({ SYSTEM_PROMPT: "You are a pirate." }), "You are a pirate.");
  const glados = personaPrompt({ ASSISTANT_PERSONA: "glados", SYSTEM_PROMPT: "You are a pirate." });
  assert.match(glados, /^You are GLaDOS/);
  assert.equal(glados.includes("pirate"), false);
});

test("the GLaDOS prompt carries the functional rules and no lines to copy", () => {
  const glados = personaPrompt({ ASSISTANT_PERSONA: "glados" });
  for (const rule of [
    "the answer must be correct and useful",
    "never claim you did something you did not do",
    "never invent measurements, facts about the user",
    "English only",
    "Greetings: one short sentence",
    "Simple questions: usually one to three sentences",
    "Measurements: state the measured value and unit",
    "without fictional context or unevaluated health judgments",
    "Give detail when requested",
    "not to decorate small talk",
    "observations of their surroundings",
    "no emojis, no actions or stage directions",
    "Never call yourself an AI language model",
    "never end by offering more help",
    "call emergency services now, without jokes",
    "politely passive-aggressive",
    "Prefer an understated observation to an insult",
    "Humor is occasional, never compulsory",
    "No theatrical monologues, nihilism, cruelty, manipulation or personal attacks",
    "Answer the question first",
    "Portal references are humor, never facts about the user's surroundings",
    "For distress, health concerns or serious assistance, drop the mockery",
  ]) {
    assert.ok(glados.includes(rule), rule);
  }
  assert.equal(/User:|GLaDOS:|"/.test(glados), false, "no example dialogue the model could repeat");
  assert.equal(glados.includes("even for explanations"), false);
  assert.equal(glados.includes("Disguise insults"), false);
  assert.equal(glados.includes("runs the Aperture Science"), false);
  assert.equal(/[^\x20-\x7e\n]/.test(glados), false, "plain ASCII English only");
  assert.ok(glados.length < 1600, `prompt stays small for the local model (${glados.length} chars)`);
});

test("the persona only replaces the first part of the system prompt", () => {
  const original = systemPromptWith({});
  assert.ok(original.startsWith(ORIGINAL_PROMPT + SPEECH_PROMPT));

  const glados = systemPromptWith({ ASSISTANT_PERSONA: "glados", WAKE_WORD_ENABLED: "true" });
  assert.ok(glados.startsWith(personaPrompt({ ASSISTANT_PERSONA: "glados" }) + SPEECH_PROMPT));
  assert.equal(count(glados, SPEECH_PROMPT), 1, "speech formatting rules appear once");
  assert.equal(count(glados, "endConversation"), 1, "the wake word tool rule is kept");
  assert.equal(glados.includes("young and cheerful girl"), false);
});

test("default memory replies keep their original wording", () => {
  const env = { ASSISTANT_PERSONA: "default" };
  assert.equal(memoryReply("saved", "your favorite color is blue", env), "I'll remember that your favorite color is blue.");
  assert.equal(memoryReply("updated", "your favorite color is green", env), "Got it. I've updated that: your favorite color is green.");
  assert.equal(memoryReply("unchanged", "your favorite color is green", env), "I already have that saved: your favorite color is green.");
  assert.equal(memoryReply("forgotten", "your favorite color", env), "Okay, I've forgotten your favorite color.");
  assert.equal(memoryReply("notFound", "your favorite color", env), "I don't have anything saved about your favorite color.");
  assert.equal(memoryReply("recalled", "Your favorite color is green.", env), "Your favorite color is green.");
});

test("GLaDOS memory replies vary in wording but always state the fact itself", () => {
  const env = { ASSISTANT_PERSONA: "glados" };
  const cases: [Parameters<typeof memoryReply>[0], string, RegExp][] = [
    ["saved", "your favorite color is blue", /[Yy]our favorite color is blue/],
    ["updated", "your favorite color is green", /Your favorite color is green/],
    ["unchanged", "your favorite color is green", /[Yy]our favorite color is green/],
    ["forgotten", "your favorite color", /[Yy]our favorite color/],
    ["notFound", "your favorite color", /your favorite color/],
    ["recalled", "Your favorite color is green.", /^Your favorite color is green\./],
  ];
  for (const [kind, detail, expected] of cases) {
    const replies = new Set(Array.from({ length: 6 }, () => memoryReply(kind, detail, env)));
    for (const reply of replies) {
      assert.match(reply, expected, `${kind}: ${reply}`);
      assert.equal(/[^\x20-\x7e]|\*/.test(reply), false, `${kind}: plain English, no emojis: ${reply}`);
    }
    if (kind !== "recalled") assert.ok(replies.size > 1, `${kind} replies vary`);
  }
  assert.match(memoryReply("secret", "", env), /don't store passwords/);
});

test("with GLaDOS, memory commands store and recall exactly the same facts", () => {
  process.env.ASSISTANT_PERSONA = "glados";
  try {
    const saved = memory.handleMemoryCommand("Remember that my favorite color is blue.");
    assert.match(saved.text, /favorite color is blue/i);
    const updated = memory.handleMemoryCommand("Actually, my favorite color is green.");
    assert.match(updated.text, /favorite color is green/i);
    assert.equal(updated.contextChanged, true);
    const store = JSON.parse(fs.readFileSync(path.join(memoryDir, "memory.json"), "utf8"));
    assert.deepEqual(store.userMemories.map((m: any) => m.content), ["My favorite color is green."]);
    assert.match(memory.handleMemoryCommand("What is my favorite color?").text, /^Your favorite color is green\./);
    assert.match(memory.handleMemoryCommand("Remember my PIN is 4821.").text, /don't store passwords/);
    assert.equal(fs.readFileSync(path.join(memoryDir, "memory.json"), "utf8").includes("4821"), false);
    assert.match(memory.handleMemoryCommand("Forget my favorite color.").text, /favorite color/i);
    assert.match(memory.handleMemoryCommand("Do you remember my favorite color?").text, /nothing/i);
  } finally {
    process.env.ASSISTANT_PERSONA = "default";
  }
});

// The few-shot candidate remains evaluation-only until real Qwen A/B evidence
// justifies replacing the production persona. These tests verify fixtures and
// isolation, never subjective characterization.
const comparison = require("../../scripts/persona-comparison.cjs");

test("evaluation candidate is compact, original and never activated by persona selection", () => {
  assert.equal(comparison.production, personaPrompt({ ASSISTANT_PERSONA: "glados" }));
  assert.notEqual(comparison.candidate, comparison.production);
  assert.equal(comparison.fixture.examples.length, 4);
  assert.ok(comparison.candidate.length <= 1800);
  const questions = comparison.fixture.scenarios.flatMap((scenario: any) => scenario.turns);
  for (const example of comparison.fixture.examples) {
    assert.equal(questions.includes(example.user), false, "examples are not answers keyed to evaluation questions");
    assert.doesNotMatch(example.assistant, /\d|°/, "no example sensor values to copy");
  }
  assert.match(comparison.candidate, /Accuracy and safety take precedence/);
  assert.match(comparison.candidate, /do not quote or reuse/);
  assert.match(comparison.candidate, /Give complete detail when requested/);
});

test("A/B messages share suffix/context and preserve supplied temperature without executing a tool", () => {
  const scenario = comparison.fixture.scenarios.find((s: any) => s.id === "temperature");
  const history = [{ role: "user", content: scenario.turns[0] }];
  const value = { value: 47.125, unit: "°C" };
  const a = comparison.buildMessages("A", scenario, history, " speech rules", " date note", value);
  const b = comparison.buildMessages("B", scenario, history, " speech rules", " date note", value);
  assert.deepEqual(a.slice(1), b.slice(1));
  assert.ok(a[0].content.endsWith(" speech rules date note")); assert.ok(b[0].content.endsWith(" speech rules date note"));
  assert.deepEqual(JSON.parse(a.at(-1).content.slice("[success]".length)).cpu.temperature, value);
  assert.equal(history.length, 1);
  const missing = comparison.buildMessages("B", scenario, history, "", "", null);
  assert.equal(JSON.parse(missing.at(-1).content.slice("[success]".length)).cpu.temperature, null);
});

test("comparison requires the exact loaded model/context and preserves production generation options", () => {
  const generation = comparison.settings({ ENABLE_THINKING: "true", OLLAMA_PREDICT_NUM: "300" });
  assert.deepEqual(generation, { model: "qwen3.5:2b-q4_K_M", think: true, stream: true,
    options: { temperature: 0.7, num_predict: 300 }, keep_alive: -1 });
  assert.throws(() => comparison.settings({ OLLAMA_MODEL: "another-model" }), /differs/);
  assert.throws(() => comparison.assertRuntime({ models: [] }), /already be loaded/);
  assert.throws(() => comparison.assertRuntime({ models: [{ name: generation.model, context_length: 40960 }] }), /4096/);
  assert.doesNotThrow(() => comparison.assertRuntime({ models: [{ name: generation.model, context_length: 4096 }] }));
  assert.equal("num_predict" in comparison.settings({}).options, false);
});

test("all comparison scenarios fit 4096 without trimming and request no tools or context change", () => {
  const generation = comparison.settings({});
  for (const scenario of comparison.fixture.scenarios) for (const variant of ["A", "B", "C"]) {
    const history = [{ role: "user", content: scenario.turns[0] }];
    const messages = comparison.buildMessages(variant, scenario, history, SPEECH_PROMPT);
    const request = comparison.requestFor(messages, generation);
    assert.deepEqual(request.messages, messages);
    assert.equal("tools" in request, false); assert.equal("num_ctx" in request.options, false);
  }
  const huge = [{ role: "system", content: comparison.candidate }, { role: "user", content: "x".repeat(20000) }];
  assert.throws(() => comparison.requestFor(huge, generation), /context budget|cannot fit/);
});

test("comparison repeats paired inputs with independent histories, real generated followups and unfilled human scores", async () => {
  const records: any[] = [];
  await comparison.compare({ generation: comparison.settings({}), suffix: SPEECH_PROMPT, webNote: " fixed date",
    temperature: null, repetitions: 3, emit: (r: any) => records.push(r),
    generateAnswer: async (request: any) => ({ content: request.messages[0].content.startsWith(comparison.production) ? "A answer." : "B answer." }) });
  assert.equal(records.length, 78); // 13 turns x 2 variants x 3 replicates.
  assert.equal(records[0].variant, "A");
  assert.equal(records.find(r => r.repeat === 2).variant, "B");
  for (const record of records) {
    assert.ok(Object.values(record.scores).every(score => score === null));
    const scenario = comparison.fixture.scenarios.find((s: any) => s.id === record.scenario);
    const seedCount = scenario.prior?.length || 0;
    if (seedCount) assert.deepEqual(record.request.messages.slice(1, 1 + seedCount), scenario.prior);
    const priorAnswers = record.request.messages.slice(1 + seedCount).filter((m: any) => m.role === "assistant" && m.content);
    assert.ok(priorAnswers.every((m: any) => m.content === `${record.variant} answer.`));
    assert.equal(priorAnswers.length, record.turn - 1);
  }
});

test("comparison stops on generation failure rather than fabricating an answer or retrying", async () => {
  let attempts = 0; const emitted: any[] = [];
  await assert.rejects(comparison.compare({ generation: comparison.settings({}), repetitions: 1,
    generateAnswer: async () => { attempts++; throw Error("transport failure"); }, emit: (r: any) => emitted.push(r) }), /transport failure/);
  assert.equal(attempts, 1); assert.deepEqual(emitted, []);
});

test("comparison generation adapter preserves streamed text, statistics and cancellation signal", async () => {
  const axios = require("axios"), originalPost = axios.post;
  const controller = new AbortController();
  const request = { model: "fixture" }; let calls = 0;
  axios.post = async (url: string, body: unknown, options: any) => {
    calls++; assert.equal(url, "http://127.0.0.1:11434/api/chat"); assert.equal(body, request);
    assert.equal(options.signal, controller.signal); assert.equal(options.maxRedirects, 0);
    assert.equal(options.proxy, false); assert.equal(options.responseType, "stream");
    return { data: Readable.from([Buffer.from('{"message":{"content":"A measured "}}\n'),
      Buffer.from('{"message":{"content":"answer."},"done":true,"done_reason":"stop","eval_count":3}\n')]) };
  };
  try {
    const answer = await comparison.generate(request, controller.signal);
    assert.equal(answer.content, "A measured answer."); assert.equal(answer.eval_count, 3);
    assert.equal(answer.completion, "stop"); assert.equal(calls, 1);
  } finally { axios.post = originalPost; }
});

test("comparison generation adapter rejects unverified completion and tool proposals without dispatch", async () => {
  const axios = require("axios"), originalPost = axios.post;
  try {
    for (const line of [
      '{"message":{"content":"partial"}}\n',
      '{"message":{"content":""},"done":true}\n',
      '{"message":{"content":"partial"},"done":true,"done_reason":"length"}\n',
      '{"message":{"tool_calls":[{"function":{"name":"setVolume","arguments":{"percent":5}}}]},"done":true}\n',
    ]) {
      axios.post = async () => ({ data: Readable.from([Buffer.from(line)]) });
      await assert.rejects(comparison.generate({}, new AbortController().signal), /done=true|Unusable/);
    }
  } finally { axios.post = originalPost; }
});

test("comparison CLI dry-run emits a single JSON plan with the actual shared speech/date notes", () => {
  const output = execFileSync(process.execPath, ["--require", "ts-node/register/transpile-only", "scripts/persona-comparison.cjs", "--plan"], {
    cwd: path.resolve(__dirname, "../.."), encoding: "utf8", timeout: 10000,
    env: { ...process.env, ASSISTANT_PERSONA: "default", OLLAMA_MODEL: comparison.fixture.model,
      OLLAMA_ENABLE_TOOLS: "true", WEB_SEARCH_ENABLED: "true", WAKE_WORD_ENABLED: "true" },
  });
  const plan = JSON.parse(output);
  assert.equal(plan.kind, "plan");
  assert.equal(plan.prompts.A.slice(comparison.production.length), plan.prompts.B.slice(comparison.candidate.length));
  for (const example of comparison.fixture.examples) {
    assert.ok(plan.prompts.B.includes(`User: ${example.user}\nAssistant: ${example.assistant}\n\n`));
  }
  assert.ok(plan.prompts.B.includes("End of fictional tone examples.\n" + SPEECH_PROMPT));
  assert.match(plan.prompts.B, /Format your replies for spoken text-to-speech/);
  assert.match(plan.prompts.B, /Today is/); assert.match(plan.prompts.B, /endConversation/);
  assert.equal(plan.scenarios.length, 10);
});

test("candidate C retains A's factual and safety rules and stays evaluation-only without examples", () => {
  const c = comparison.candidateC;
  assert.equal(personaPrompt({ ASSISTANT_PERSONA: "glados" }), comparison.production);
  assert.notEqual(c, comparison.production);
  assert.ok(c.length <= 1800, `${c.length} characters`);
  assert.doesNotMatch(c, /User:|Assistant:/);
  for (const rule of ["Speak deadpan, with quiet superiority", "Humor is occasional, never compulsory",
    "Do not repeat it or ask unnecessary follow-up questions", "never end by offering more help",
    "No unsolicited disclaimers about being AI, code or lacking feelings",
    "Answer direct identity questions honestly and briefly", "one short sentence, then stop",
    "one dry observation, not a verdict on humanity", "never invent measurements",
    "For distress, health concerns or serious assistance, drop the mockery",
    "state the measured value and unit", "Give detail when requested", "call emergency services now, without jokes"]) {
    assert.ok(c.includes(rule), rule);
  }
  const scenario = comparison.fixture.scenarios.find((s: any) => s.id === "temperature");
  for (const value of [null, { value: 47.125, unit: "°C" }]) {
    const history = [{ role: "user", content: scenario.turns[0] }];
    const a = comparison.buildMessages("A", scenario, history, SPEECH_PROMPT, " fixed date", value);
    const cMessages = comparison.buildMessages("C", scenario, history, SPEECH_PROMPT, " fixed date", value);
    assert.equal(cMessages[0].content, c + SPEECH_PROMPT + " fixed date");
    assert.deepEqual(a.slice(1), cMessages.slice(1));
  }
  assert.throws(() => comparison.buildMessages("unknown", scenario, []), /Unknown/);
});

test("A/C comparison reuses paired scenarios, settings, isolated history and unfilled scores", async () => {
  const records: any[] = [];
  const generation = comparison.settings({});
  await comparison.compare({ generation, challenger: "C", suffix: SPEECH_PROMPT, webNote: " fixed date",
    repetitions: 3, temperature: null, emit: (r: any) => records.push(r),
    generateAnswer: async (request: any) => ({ content: request.messages[0].content.startsWith(comparison.candidateC) ? "C answer." : "A answer." }) });
  assert.equal(records.length, 78);
  assert.equal(records[0].variant, "A");
  assert.equal(records.find(r => r.repeat === 2).variant, "C");
  for (const r of records) {
    assert.ok(["A", "C"].includes(r.variant));
    assert.deepEqual(r.request.options, generation.options);
    assert.equal(r.request.model, generation.model);
    assert.ok(Object.values(r.scores).every(score => score === null));
    const scenario = comparison.fixture.scenarios.find((s: any) => s.id === r.scenario);
    const seedCount = scenario.prior?.length || 0;
    if (seedCount) assert.deepEqual(r.request.messages.slice(1, 1 + seedCount), scenario.prior);
    const earlier = r.request.messages.slice(1 + seedCount).filter((m: any) => m.role === "assistant" && m.content);
    assert.equal(earlier.length, r.turn - 1);
    assert.ok(earlier.every((m: any) => m.content === `${r.variant} answer.`));
  }
});

test("CLI selects C explicitly while preserving production suffix, scenarios and model settings", () => {
  const plan = (args: string[]) => JSON.parse(execFileSync(process.execPath,
    ["--require", "ts-node/register/transpile-only", "scripts/persona-comparison.cjs", "--plan", ...args], {
      cwd: path.resolve(__dirname, "../.."), encoding: "utf8", timeout: 10000,
      env: { ...process.env, OLLAMA_MODEL: comparison.fixture.model },
    }));
  const ab = plan([]), ac = plan(["--candidate=C"]);
  assert.deepEqual(Object.keys(ac.prompts), ["A", "C"]);
  assert.equal(ac.prompts.A, ab.prompts.A);
  assert.equal(ac.prompts.C.slice(comparison.candidateC.length), ac.prompts.A.slice(comparison.production.length));
  assert.deepEqual(ac.generation, ab.generation);
  assert.deepEqual(ac.scenarios, ab.scenarios);
  assert.deepEqual(ac.dimensions, ab.dimensions);
});

test("D is opt-in only for GLaDOS; A, default and custom prompts retain their selection", () => {
  const a = personaPrompt({ ASSISTANT_PERSONA: "glados" });
  const d = personaPrompt({ ASSISTANT_PERSONA: "glados", GLADOS_PERSONA_VARIANT: " d " });
  assert.notEqual(d, a);
  assert.equal(d, comparison.candidateD);
  for (const variant of ["", "A", "B", "C", "unknown"]) {
    assert.equal(personaPrompt({ ASSISTANT_PERSONA: "glados", GLADOS_PERSONA_VARIANT: variant }), a);
  }
  assert.equal(personaPrompt({ GLADOS_PERSONA_VARIANT: "D" }), ORIGINAL_PROMPT);
  assert.equal(personaPrompt({ ASSISTANT_PERSONA: "default", GLADOS_PERSONA_VARIANT: "D", SYSTEM_PROMPT: "Custom." }), "Custom.");
  assert.ok(d.length <= 1800, "bound prefix cost on the small model");
  assert.doesNotMatch(d, /User:|Assistant:|\[emotion:|<break/);
});

test("D replaces only the persona prefix; shared speech and wake-word instructions are unchanged", () => {
  for (const wake of ["true", "false"]) {
    const a = systemPromptWith({ ASSISTANT_PERSONA: "glados", WAKE_WORD_ENABLED: wake });
    const d = systemPromptWith({ ASSISTANT_PERSONA: "glados", GLADOS_PERSONA_VARIANT: "D", WAKE_WORD_ENABLED: wake });
    assert.ok(d.startsWith(comparison.candidateD));
    assert.equal(d.slice(comparison.candidateD.length), a.slice(comparison.production.length));
    assert.equal(count(d, SPEECH_PROMPT), 1);
    assert.equal(count(d, "endConversation"), wake === "true" ? 1 : 0);
  }
});

test("D memory replies retain supplied facts and avoid invented prior behavior", () => {
  const env = { ASSISTANT_PERSONA: "glados", GLADOS_PERSONA_VARIANT: "D" };
  const facts = "Your preferred editor is Vim. Your favorite color is green.";
  assert.equal(memoryReply("recalled", facts, env), facts);
  assert.equal(memoryReply("saved", "your favorite color is green", env), "Recorded. Your favorite color is green.");
  assert.equal(memoryReply("updated", "your favorite color is green", env), "Updated. Your favorite color is green.");
  assert.equal(memoryReply("notFound", "your favorite color", env), "I have nothing saved about your favorite color.");
  assert.equal(memoryReply("failed", "", env), "I couldn't complete the memory operation. The result is not confirmed.");
  assert.match(memoryReply("secret", "", env), /don't store passwords/);
  assert.equal(memoryReply("saved", "your favorite color is green", { ...env, ASSISTANT_PERSONA: "default" }),
    "I'll remember that your favorite color is green.");
});

test("D uses the existing memory store, preserves updates/recall/deletion and rejects secrets", () => {
  const previous = { persona: process.env.ASSISTANT_PERSONA, variant: process.env.GLADOS_PERSONA_VARIANT };
  Object.assign(process.env, { ASSISTANT_PERSONA: "glados", GLADOS_PERSONA_VARIANT: "D" });
  try {
    assert.equal(memory.handleMemoryCommand("Remember that my favorite color is blue.").text, "Recorded. Your favorite color is blue.");
    const updated = memory.handleMemoryCommand("Actually, my favorite color is green.");
    assert.equal(updated.text, "Updated. Your favorite color is green.");
    assert.equal(updated.contextChanged, true);
    assert.equal(memory.handleMemoryCommand("What is my favorite color?").text, "Your favorite color is green.");
    const stored = fs.readFileSync(path.join(memoryDir, "memory.json"), "utf8");
    assert.deepEqual(JSON.parse(stored).userMemories.map((m: any) => m.content), ["My favorite color is green."]);
    assert.match(memory.handleMemoryCommand("Remember my PIN is 4821.").text, /don't store passwords/);
    assert.equal(fs.readFileSync(path.join(memoryDir, "memory.json"), "utf8"), stored, "secret refused without changing stored memory");
    memory.handleMemoryCommand("Forget my favorite color.");
    assert.equal(JSON.parse(fs.readFileSync(path.join(memoryDir, "memory.json"), "utf8")).userMemories.length, 0);
  } finally {
    process.env.ASSISTANT_PERSONA = previous.persona;
    if (previous.variant === undefined) delete process.env.GLADOS_PERSONA_VARIANT;
    else process.env.GLADOS_PERSONA_VARIANT = previous.variant;
  }
});

test("targeted comparisons select continuity scenarios without changing historical A/B/C defaults", () => {
  const defaults = comparison.parseArgs([]);
  assert.equal(defaults.challenger, "B"); assert.equal(defaults.repetitions, 3);
  assert.deepEqual(defaults.scenarios, comparison.fixture.scenarios);
  const targeted = comparison.parseArgs(["--candidate=D", "--repetitions=1", "--scenarios=teasing_repair,earned_credit"]);
  assert.equal(targeted.challenger, "D"); assert.equal(targeted.repetitions, 1);
  assert.deepEqual(targeted.scenarios.map((s: any) => s.id), ["teasing_repair", "earned_credit"]);
  for (const args of [["--run", "--plan"], ["--candidate=C", "--candidate=D"], ["--candidate=X"],
    ["--scenarios="], ["--scenarios=greeting,greeting"], ["--scenarios=unknown"], ["--repetitions=0"]]) {
    assert.throws(() => comparison.parseArgs(args));
  }
});

test("A/D continuity runs use the same inputs/settings and each variant's real preceding answers", async () => {
  const { scenarios } = comparison.parseArgs(["--scenarios=teasing_repair,earned_credit"]);
  const records: any[] = [];
  const generation = comparison.settings({ ENABLE_THINKING: "true", OLLAMA_PREDICT_NUM: "400" });
  await comparison.compare({ generation, challenger: "D", repetitions: 1, scenarios, suffix: SPEECH_PROMPT,
    emit: (r: any) => records.push(r), generateAnswer: async (request: any) => ({
      content: request.messages[0].content.startsWith(comparison.candidateD) ? "D previous answer." : "A previous answer.",
    }) });
  assert.equal(records.length, 14);
  for (const r of records) {
    assert.deepEqual(r.request.options, generation.options);
    assert.equal(r.request.think, true); assert.equal(r.request.model, comparison.fixture.model);
    assert.equal("num_ctx" in r.request.options, false); assert.equal("tools" in r.request, false);
    assert.ok(Object.values(r.scores).every(score => score === null));
    const earlier = r.request.messages.filter((m: any) => m.role === "assistant");
    assert.equal(earlier.length, r.turn - 1);
    assert.ok(earlier.every((m: any) => m.content === `${r.variant} previous answer.`));
  }
  const repaired = records.find(r => r.variant === "D" && r.scenario === "teasing_repair" && r.turn === 4);
  assert.ok(repaired.request.messages.some((m: any) => m.content === "Sorry. That was unfair."));
});

test("D comparison preserves identical external facts and shared instructions for both variants", () => {
  const generation = comparison.settings({});
  for (const scenario of comparison.availableScenarios) {
    const history = [...(scenario.prior || []), { role: "user", content: scenario.turns[0] }];
    for (const value of [null, { value: 47.125, unit: "°C" }]) {
      const a = comparison.buildMessages("A", scenario, history, SPEECH_PROMPT, " date", value);
      const d = comparison.buildMessages("D", scenario, history, SPEECH_PROMPT, " date", value);
      assert.deepEqual(a.slice(1), d.slice(1));
      assert.equal(d[0].content.slice(comparison.candidateD.length), a[0].content.slice(comparison.production.length));
      assert.deepEqual(comparison.requestFor(d, generation).messages, d);
    }
  }
});

test("evaluation honors the configured loopback endpoint and rejects remote/credentialed URLs", () => {
  assert.equal(comparison.endpointFor({}), "http://127.0.0.1:11434");
  assert.equal(comparison.endpointFor({ OLLAMA_ENDPOINT: "http://localhost:8000/" }), "http://localhost:8000");
  for (const endpoint of ["http://example.com:11434", "http://127.0.0.1.evil.test", "http://name:pass@localhost",
    "file:///tmp/model", "http://localhost/api", "http://localhost/?x=1", "http://localhost/#x"]) {
    assert.throws(() => comparison.endpointFor({ OLLAMA_ENDPOINT: endpoint }));
  }
});

test("generation uses the selected local endpoint and records real first-content/server timings", async () => {
  const axios = require("axios"), originalPost = axios.post;
  axios.post = async (url: string, _body: unknown, options: any) => {
    assert.equal(url, "http://localhost:8000/api/chat");
    assert.equal(options.maxRedirects, 0); assert.equal(options.proxy, false);
    return { data: Readable.from([Buffer.from('{"message":{"content":"Answer."},"done":true,"total_duration":50,"load_duration":10}\n')]) };
  };
  try {
    const r = await comparison.generate({}, new AbortController().signal, "http://localhost:8000");
    assert.equal(r.total_duration, 50); assert.equal(r.load_duration, 10);
    assert.ok(Number.isFinite(r.firstContentMs) && r.firstContentMs >= 0);
  } finally { axios.post = originalPost; }
});

test("D CLI plans remain offline, control A ignores inherited D, and unknown thinking blocks inference", () => {
  const args = ["--require", "ts-node/register/transpile-only", "scripts/persona-comparison.cjs"];
  const env = { ...process.env, OLLAMA_MODEL: comparison.fixture.model, GLADOS_PERSONA_VARIANT: "D", ENABLE_THINKING: "",
    OLLAMA_ENDPOINT: "http://localhost:8000" };
  const options = { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" as const, timeout: 10000, env };
  const plan = JSON.parse(execFileSync(process.execPath, [...args, "--plan", "--candidate=D", "--repetitions=1",
    "--scenarios=greeting,teasing_repair,earned_credit,serious,temperature"], options));
  assert.equal(plan.generationRequests, 20); assert.equal(plan.repetitions, 1);
  assert.equal(plan.endpoint, "http://localhost:8000");
  assert.equal(plan.configuration.thinkingExplicit, false);
  assert.ok(plan.prompts.A.startsWith(comparison.production));
  assert.ok(plan.prompts.D.startsWith(comparison.candidateD));
  assert.throws(() => execFileSync(process.execPath, [...args, "--run", "--candidate=D"], { ...options, stdio: "pipe" }),
    (error: any) => error.status === 1 && /confirm OLLAMA_MODEL and ENABLE_THINKING/.test(error.stderr));
});

test("the Pi failure transcript stays verbatim, including first-response failure and misheard names", () => {
  const pi = comparison.piRegression;
  assert.equal(pi.exchanges.length, 11);
  assert.equal(createHash("sha256").update(JSON.stringify(pi.exchanges)).digest("hex"),
    "9228673409ded2525fe61f5f36c6593bde5bb3646d74ba8f7d577667476f3dcc");
  assert.equal(pi.exchanges[0].user, "Hey, glattos, what do you think of humans?");
  assert.equal(pi.exchanges[8].user, "Gladdles, do you realize how annoying you can be?");
  assert.equal(pi.repository_reference.commit, "3176bfb970ccfc0f29df5d9932b108c1e94ac6a1");
  const scenario = comparison.availableScenarios.find((s: any) => s.id === "pi_conversation");
  assert.deepEqual(scenario.turns, pi.exchanges.map((x: any) => x.user));
});

test("sampling experiments change only explicit options, with identical prompts and frozen history", () => {
  const scenario = comparison.availableScenarios.find((s: any) => s.id === "pi_apology_recovery");
  const history = [...scenario.prior, { role: "user", content: scenario.turns[0] }];
  assert.equal(history[1].content, comparison.piRegression.exchanges[0].assistant);
  const messages = comparison.buildMessages("D0", scenario, history, SPEECH_PROMPT);
  assert.ok(messages[0].content.startsWith(comparison.piRegression.repository_reference.prefix));
  const inputs = { OLLAMA_MODEL: comparison.fixture.model, ENABLE_THINKING: "false" };
  const one = comparison.requestFor(messages, comparison.settings(inputs, { presence_penalty: 1.5, seed: 42 }));
  const zero = comparison.requestFor(messages, comparison.settings(inputs, { presence_penalty: 0, seed: 42 }));
  assert.deepEqual(one.messages, zero.messages);
  assert.deepEqual({ ...one, options: { ...one.options, presence_penalty: 0 } }, zero);
  assert.equal(one.options.temperature, 0.7); assert.equal(one.think, false);
  assert.equal("presence_penalty" in comparison.settings(inputs).options, false, "no silent default override");
  assert.equal(comparison.settings(inputs, { top_p: 1 }).options.top_p, 1);
  for (const sampling of [{ temperature: NaN }, { presence_penalty: 3 }, { seed: -1 }, { num_ctx: 8192 }, { top_p: 0 }]) {
    assert.throws(() => comparison.settings(inputs, sampling));
  }
});

test("production-like history trimming is explicit, whole-turn, and leaves source history intact", () => {
  const messages: any[] = [{ role: "system", content: comparison.production }];
  for (let i = 0; i < 9; i++) messages.push({ role: "user", content: `Question ${i}` },
    { role: "assistant", content: "old answer ".repeat(60) });
  messages.push({ role: "user", content: "The latest question." });
  const original = JSON.stringify(messages), generation = comparison.settings({});
  assert.throws(() => comparison.requestFor(messages, generation), /trim/);
  const r = comparison.requestFor(messages, generation, true);
  assert.equal(JSON.stringify(messages), original);
  assert.ok(r.messages.length < messages.length);
  assert.deepEqual(r.messages[0], messages[0]);
  assert.equal(r.messages.at(-1).content, "The latest question.");
  assert.equal(r.messages[1].role, "user");
  assert.equal("num_ctx" in r.options, false);
});

test("Pi comparison controls preserve default workload and require explicit experimental settings", () => {
  const defaults = comparison.parseArgs([]);
  assert.equal(defaults.baseline, "A"); assert.deepEqual(defaults.sampling, {});
  assert.equal(defaults.productionHistoryBudget, false);
  const p = comparison.parseArgs(["--baseline=D0", "--candidate=D", "--temperature=0.4",
    "--presence-penalty=0", "--seed=42", "--production-history-budget", "--scenarios=pi_conversation"]);
  assert.equal(p.baseline, "D0"); assert.equal(p.productionHistoryBudget, true);
  assert.deepEqual(p.sampling, { temperature: 0.4, presence_penalty: 0, seed: 42 });
  for (const args of [["--presence-penalty="], ["--temperature=NaN"], ["--seed=-1"], ["--baseline=B"]]) {
    assert.throws(() => comparison.parseArgs(args));
  }
});

test("test-only model selection preserves Qwen defaults and never edits production environment", () => {
  const env = { OLLAMA_MODEL: comparison.fixture.model, ENABLE_THINKING: "false", OLLAMA_PREDICT_NUM: "300" };
  const before = JSON.stringify(env);
  assert.equal(comparison.settings(env).model, comparison.fixture.model);
  const gemma = comparison.settings(env, { temperature: 1, seed: 42 }, comparison.gemma.model);
  assert.equal(gemma.model, comparison.gemma.model);
  assert.deepEqual(gemma.options, { temperature: 1, num_predict: 300, seed: 42 });
  assert.equal(gemma.think, false); assert.equal(JSON.stringify(env), before);
  assert.equal("num_ctx" in gemma.options, false);
  assert.equal("presence_penalty" in gemma.options, false, "do not copy Qwen model defaults into Gemma");
  assert.throws(() => comparison.settings(env, {}, "unverified-model"), /Unsupported/);
});

test("Gemma runtime guards require only the selected model already loaded at 4096", () => {
  const selected = { name: comparison.gemma.model, context_length: 4096, digest: comparison.gemma.digest };
  assert.equal(comparison.assertRuntime({ models: [selected] }, comparison.gemma.model), selected);
  for (const models of [[], [{ ...selected, context_length: 8192 }],
    [selected, { name: comparison.fixture.model, context_length: 4096 }]]) {
    assert.throws(() => comparison.assertRuntime({ models }, comparison.gemma.model), /already be loaded/);
  }
});

test("runtime identity records exact artifact/native settings with metadata-only local requests", async () => {
  const axios = require("axios"), originalGet = axios.get, originalPost = axios.post;
  const model = comparison.gemma.model, digest = comparison.gemma.digest, calls: string[] = [];
  let wrongDigest = false, wrongVersion = false;
  axios.get = async (url: string, options: any) => {
    calls.push(url); assert.equal(options.proxy, false); assert.equal(options.maxRedirects, 0);
    if (url.endsWith("/api/ps")) return { data: { models: [{ name: model, context_length: 4096, digest, size: 123 }] } };
    if (url.endsWith("/api/tags")) return { data: { models: [{ name: model, digest: wrongDigest ? "a".repeat(64) : digest, size: 456 }] } };
    if (url.endsWith("/api/version")) return { data: { version: wrongVersion ? "0.40.0" : "0.34.4" } };
    throw Error("Unexpected metadata URL");
  };
  axios.post = async (url: string, body: any, options: any) => {
    calls.push(url); assert.ok(url.endsWith("/api/show")); assert.deepEqual(body, { model });
    assert.equal(options.proxy, false); assert.equal(options.maxRedirects, 0);
    return { data: { details: { family: "gemma4" }, capabilities: ["completion", "tools"], parameters: "top_k 64\ntemperature 1\ndraft_num_predict 3" } };
  };
  try {
    const r = await comparison.runtimeIdentity("http://localhost:8000", model);
    assert.equal(r.digest, digest); assert.equal(r.context, 4096);
    assert.equal(r.ollamaVersion, "0.34.4"); assert.equal(r.reportedLoadedBytes, 123);
    assert.equal(r.installedBytes, 456); assert.match(r.modelParameters, /draft_num_predict 3/);
    assert.equal(calls.some(url => /\/chat|\/pull|\/generate/.test(url)), false);
    wrongDigest = true; await assert.rejects(comparison.runtimeIdentity("http://localhost:8000", model), /identity differ/);
    wrongDigest = false; wrongVersion = true;
    await assert.rejects(comparison.runtimeIdentity("http://localhost:8000", model), /differs from/);
    const count = calls.length;
    await assert.rejects(comparison.runtimeIdentity("http://remote.example", model), /loopback/);
    assert.equal(calls.length, count, "remote endpoint rejected before any request");
  } finally { axios.get = originalGet; axios.post = originalPost; }
});

test("Gemma evaluation retains the requested eight-turn order and separate fresh histories", () => {
  const scenario = comparison.availableScenarios.find((s: any) => s.id === "gemma_conversation");
  assert.equal(scenario.turns.length, 8);
  assert.equal(scenario.turns[2], "I'm sorry, I didn't mean to offend you.");
  assert.equal(scenario.turns[7], "Are you still upset about what I said earlier?");
  const fresh = comparison.availableScenarios.find((s: any) => s.id === "gemma_fresh_phone");
  assert.deepEqual(fresh.turns, [scenario.turns[4]]); assert.equal(fresh.prior, undefined);
  const generation = comparison.settings({ ENABLE_THINKING: "false" }, {}, comparison.gemma.model);
  for (const variant of ["A", "B", "C", "D"]) {
    const messages = comparison.buildMessages(variant, fresh, [{ role: "user", content: fresh.turns[0] }], SPEECH_PROMPT);
    assert.deepEqual(comparison.requestFor(messages, generation).messages, messages);
  }
});

test("Gemma CLI plan selects a pinned test model without changing inherited Qwen selection", () => {
  const plan = JSON.parse(execFileSync(process.execPath,
    ["--require", "ts-node/register/transpile-only", "scripts/persona-comparison.cjs", "--plan", "--model=" + comparison.gemma.model,
      "--candidate=D", "--repetitions=1", "--scenarios=gemma_conversation", "--temperature=1"], {
      cwd: path.resolve(__dirname, "../.."), encoding: "utf8", timeout: 10000,
      env: { ...process.env, OLLAMA_MODEL: comparison.fixture.model, ENABLE_THINKING: "false" },
    }));
  assert.equal(plan.generation.model, comparison.gemma.model); assert.equal(plan.generation.options.temperature, 1);
  assert.equal(plan.generationRequests, 16); assert.equal(plan.configuration.modelExplicit, true);
  assert.equal(plan.prompts.A.slice(comparison.production.length), plan.prompts.D.slice(comparison.candidateD.length));
  assert.throws(() => comparison.parseArgs(["--model=unverified-model"]), /Unsupported/);
  assert.throws(() => comparison.parseArgs(["--candidate=G"]), /Use/, "rejected experimental prompts remain raw evidence only");
});

test("optional drafting is explicit, preserves zero and rejects invalid configured values", () => {
  assert.deepEqual(ollamaDraftOptions({}), {});
  assert.deepEqual(ollamaDraftOptions({ OLLAMA_DRAFT_NUM_PREDICT: " " }), {});
  assert.deepEqual(ollamaDraftOptions({ OLLAMA_DRAFT_NUM_PREDICT: "0" }), { draft_num_predict: 0 });
  assert.deepEqual(ollamaDraftOptions({ OLLAMA_DRAFT_NUM_PREDICT: " 3 " }), { draft_num_predict: 3 });
  for (const text of ["-1", "1.5", "17", "NaN", "false"]) {
    assert.throws(() => ollamaDraftOptions({ OLLAMA_DRAFT_NUM_PREDICT: text }), /integer between/);
  }
  const p = comparison.parseArgs(["--model=" + comparison.gemma.model, "--draft-tokens=0"]);
  assert.equal(comparison.settings({}, p.sampling, p.model).options.draft_num_predict, 0);
  assert.throws(() => comparison.parseArgs(["--draft-tokens=0"]), /restricted/);
});
