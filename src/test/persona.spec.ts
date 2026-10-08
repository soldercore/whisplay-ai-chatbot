// Assistant persona selection (ASSISTANT_PERSONA): prompt choice and fallback,
// system prompt composition, and persona wording of memory command replies.
// Run with: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
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
    "never invent facts about the user",
    "English only",
    "at most three short sentences",
    "no emojis, no actions or stage directions",
    "Never call yourself an AI language model",
    "never end by offering more help",
    "call emergency services now, without jokes",
  ]) {
    assert.ok(glados.includes(rule), rule);
  }
  assert.equal(/User:|GLaDOS:|"/.test(glados), false, "no example dialogue the model could repeat");
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
