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
import { memoryReply, personaName, personaPrompt } from "../config/persona";

const ORIGINAL_PROMPT =
  "You are a young and cheerful girl who loves to talk, chat, help others, and learn new things. You enjoy using emoji expressions. Never answer longer than 200 words. Always keep your answers concise and to the point.";
const SPEECH_PROMPT = " Format your replies for spoken text-to-speech.";
const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisplay-persona-spec-"));
let memory: any;

before(() => {
  Object.assign(process.env, { MEMORY_ENABLED: "true", MEMORY_DIR: memoryDir, ASSISTANT_PERSONA: "default" });
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
      env: { ...process.env, ASSISTANT_PERSONA: "", SYSTEM_PROMPT: "", WAKE_WORD_ENABLED: "false", ...env },
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
