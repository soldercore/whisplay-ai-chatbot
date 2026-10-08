// Local memory: commands, persistence, English output, file safety, and the
// Ollama path (tool calls, spoken-JSON guard, web search compatibility).
// A fake Ollama server stands in for the model; memory files go to a temp dir.
// Run with: npm test
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

type ChatRequest = { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[]; stream?: boolean };
type Responder = (request: ChatRequest) => object[];

const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisplay-memory-spec-"));
const storePath = path.join(memoryDir, "memory.json");
const chatRequests: ChatRequest[] = [];
let responders: Responder[] = [];

const chunk = (message: object) => ({ model: "test", message: { role: "assistant", content: "", ...message }, done: false });
const done = { model: "test", message: { role: "assistant", content: "" }, done: true };
const say = (text: string): object[] => [...text.split(/(?<= )/).map((part) => chunk({ content: part })), done];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (data) => (body += data));
  req.on("end", () => {
    const request = body ? JSON.parse(body) : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/api/show") return res.end(JSON.stringify({ model_info: { "qwen3.context_length": 32768 } }));
    if (req.url === "/api/generate") return res.end(JSON.stringify({ response: "The user likes short answers." }));
    if (request.stream === false) return res.end(JSON.stringify(done)); // keep-alive request
    chatRequests.push(request);
    const responder = responders.shift() || (() => say("(no scripted reply)"));
    for (const line of responder(request)) res.write(`${JSON.stringify(line)}\n`);
    res.end();
  });
});

let llm: any;
let memory: any;
let commands: any;
let guard: any;
let llmFuncMap: Record<string, (args: any) => Promise<string>>;
const searches: any[] = [];

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, {
    OLLAMA_ENDPOINT: `http://127.0.0.1:${(server.address() as any).port}`,
    OLLAMA_MODEL: "test",
    OLLAMA_ENABLE_TOOLS: "true",
    ENABLE_THINKING: "false",
    WEB_SEARCH_ENABLED: "true",
    LLM_SERVER: "ollama",
    TTS_SERVER: "test",
    ASR_SERVER: "test",
    MEMORY_ENABLED: "true",
    MEMORY_AUTO_SAVE: "true",
    MEMORY_DIR: memoryDir,
    WAKE_WORD_ENABLED: "false",
    ASSISTANT_PERSONA: "default",
  });
  commands = require("../config/memory-commands");
  guard = require("../config/spoken-text-guard");
  memory = require("../config/local-memory");
  llmFuncMap = require("../config/llm-tools").llmFuncMap;
  llm = require("../cloud-api/llm");
  llmFuncMap.web_search = async (args: any) => {
    searches.push(args);
    return "[success]Search Results:\n[1] Grand Theft Auto VI is Now Set to Launch November 19, 2026";
  };
  await new Promise((resolve) => setTimeout(resolve, 100)); // let the keep-alive request finish
});

beforeEach(() => {
  chatRequests.length = 0;
  searches.length = 0;
  responders = [];
  llm.resetChatHistory();
});

after(() => {
  server.close();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

const readStore = () => JSON.parse(fs.readFileSync(storePath, "utf8"));
const facts = () => readStore().userMemories.map((m: any) => m.content);

const ask = async (question: string) => {
  let answer = "";
  const memoryPrompt = memory.prepareMemoryPrompt(question);
  const messages = [...(memoryPrompt ? [{ role: "system", content: memoryPrompt }] : []), { role: "user", content: question }];
  await llm.chatWithLLMStream(messages, (part: string) => (answer += part), () => {});
  memory.autoSaveExchange(question, answer, async () => "The user likes short answers.");
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { answer: answer.trim(), memoryPrompt };
};

// Runs a snippet in a fresh Node process, i.e. after a restart.
const inNewProcess = (snippet: string): string =>
  execFileSync(process.execPath, ["--require", "ts-node/register/transpile-only", "-e", snippet], {
    env: { ...process.env, MEMORY_DIR: memoryDir },
    cwd: path.join(__dirname, "..", ".."),
    encoding: "utf8",
  });

// ---- Command parsing ----------------------------------------------------------

test("memory commands are recognised in natural phrasing", () => {
  const cases: [string, object | null][] = [
    ["Remember that my favorite color is blue.", { type: "remember", statement: "my favorite color is blue" }],
    ["Please remember my dog's name is Max", { type: "remember", statement: "my dog's name is Max" }],
    ["Don't forget that I'm allergic to peanuts.", { type: "remember", statement: "I'm allergic to peanuts" }],
    ["What is my favorite color?", { type: "recall", topic: "my favorite color", explicit: false }],
    ["Do you remember my favourite colour?", { type: "recall", topic: "my favourite colour", explicit: true }],
    ["Actually, my favorite color is green.", { type: "update", statement: "my favorite color is green" }],
    ["Forget my favorite color.", { type: "forget", topic: "my favorite color" }],
    ["Please delete my address from memory", { type: "forget", topic: "my address" }],
    ["Forget it.", null],
    ["Clear the screen.", null],
    ["What is the capital of France?", null],
    ["When is GTA 6 coming out?", null],
    ["Is my favorite color blue?", null],
  ];
  for (const [text, expected] of cases) assert.deepEqual(commands.parseMemoryCommand(text), expected, text);
  assert.equal(commands.toSecondPerson("I'm allergic to peanuts and my dog is Max"), "you're allergic to peanuts and your dog is Max");
});

// ---- Save, retrieve, update, forget -------------------------------------------

test("saving, retrieving, updating and forgetting a preference never calls the model", async () => {
  assert.equal((await ask("Remember that my favorite color is blue.")).answer, "I'll remember that your favorite color is blue.");
  assert.deepEqual(facts(), ["My favorite color is blue."]);
  assert.equal(readStore().userMemories[0].subject, "favorite color");

  llm.resetChatHistory(); // a new conversation
  assert.equal((await ask("What is my favorite color?")).answer, "Your favorite color is blue.");

  assert.equal((await ask("Actually, my favorite color is green.")).answer, "Got it. I've updated that: your favorite color is green.");
  assert.deepEqual(facts(), ["My favorite color is green."], "the old value is replaced, not duplicated");
  assert.equal((await ask("What is my favorite color?")).answer, "Your favorite color is green.");

  assert.equal((await ask("Forget my favorite color.")).answer, "Okay, I've forgotten your favorite color.");
  assert.deepEqual(facts(), []);
  assert.equal((await ask("Do you remember my favorite color?")).answer, "I don't have anything saved about your favorite color.");
  const history = JSON.stringify(readStore().sessions).toLowerCase();
  assert.equal(history.includes("favorite color"), false, "forgotten facts are scrubbed from saved conversations");

  assert.equal(chatRequests.length, 0, "no LLM request for memory commands");
});

test("an unknown fact is not invented and other statements are not saved silently", async () => {
  responders = [() => say("I don't know your shoe size yet.")];
  const { answer } = await ask("What is my shoe size?");
  assert.equal(chatRequests.length, 1, "a recall with no saved match is left to the model");
  assert.equal(answer, "I don't know your shoe size yet.");

  responders = [() => say("Nice to meet you, Sam!")];
  await ask("My name is Sam.");
  assert.equal(facts().includes("My name is Sam."), false, "a plain statement does not create a fact");
});

test("secrets are never saved, even when asked", async () => {
  const { answer } = await ask("Remember that my bank PIN is 4821.");
  assert.match(answer, /won't save passwords, PINs/);
  assert.equal(facts().some((fact: string) => /4821/.test(fact)), false);
  assert.equal(JSON.stringify(readStore()).includes("4821"), false, "not in conversation history either");
});

// ---- Persistence, migration, damaged files ------------------------------------

test("facts persist across a restart", async () => {
  await ask("Remember that my dog's name is Max.");
  const output = inNewProcess(
    `const m = require("./src/config/local-memory"); console.log(m.handleMemoryCommand("What is my dog's name?").text);`,
  );
  assert.match(output, /Your dog's name is Max\./);
});

test("an older store with only a remembered conversation is imported once, with a backup", () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisplay-memory-legacy-"));
  const legacy = {
    version: 1,
    sessions: [{
      id: "session_old", title: "蓝色", summary: "用户偏好：蓝色；事实：最爱颜色为蓝",
      startedAt: "2026-10-08T10:15:00.000Z", updatedAt: "2026-10-08T10:15:30.000Z", keywords: [],
      exchanges: [{ at: "2026-10-08T10:15:20.000Z", user: "Remember that my favorite color is blue.", assistant: "Got it!" }],
    }],
    userMemories: [],
  };
  fs.writeFileSync(path.join(legacyDir, "memory.json"), JSON.stringify(legacy));
  const output = execFileSync(process.execPath, ["--require", "ts-node/register/transpile-only", "-e",
    `const m = require("./src/config/local-memory"); console.log("REPLY " + m.handleMemoryCommand("What is my favorite color?").text);
     console.log("PROMPT " + m.prepareMemoryPrompt("Tell me about my preferences from last time"));`],
  { env: { ...process.env, MEMORY_DIR: legacyDir }, cwd: path.join(__dirname, "..", ".."), encoding: "utf8" });
  assert.match(output, /REPLY Your favorite color is blue\./);
  const promptLine = output.split("\n").find((line) => line.startsWith("PROMPT")) || "";
  assert.equal(/\p{Script=Han}/u.test(output.split("PROMPT")[1] || ""), false, `no Chinese in the prompt: ${promptLine}`);
  const files = fs.readdirSync(legacyDir);
  const backup = files.find((file) => file.startsWith("memory.json.bak-"));
  assert.ok(backup, `backup kept: ${files}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacyDir, backup!), "utf8")), legacy, "backup is the original file");
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

test("a corrupted store is kept as a backup and memory keeps working", async () => {
  fs.writeFileSync(storePath, "{ this is not json");
  const { answer } = await ask("Remember that my favorite drink is tea.");
  assert.equal(answer, "I'll remember that your favorite drink is tea.");
  const backup = fs.readdirSync(memoryDir).find((file) => file.startsWith("memory.json.corrupt-"));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(memoryDir, backup!), "utf8"), "{ this is not json");
});

test("a store with missing fields is repaired on read", async () => {
  fs.writeFileSync(storePath, JSON.stringify({ sessions: [{ id: "s1" }, null], userMemories: [{ content: "My favorite fruit is mango." }, {}] }));
  assert.equal((await ask("What is my favorite fruit?")).answer, "Your favorite fruit is mango.");
});

test("a failed write gives an honest reply", async () => {
  fs.rmSync(`${storePath}.tmp`, { recursive: true, force: true });
  fs.mkdirSync(`${storePath}.tmp`); // makes the next write fail
  try {
    assert.equal((await ask("Remember that my car is red.")).answer, "Sorry, I couldn't reach my memory just now. Please try again.");
  } finally {
    fs.rmSync(`${storePath}.tmp`, { recursive: true, force: true });
  }
});

// ---- English ---------------------------------------------------------------

test("summaries and prompts stay in English", async () => {
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, sessions: [], userMemories: [] }));
  responders = [() => say("Paris is the capital of France.")];
  await ask("What is the capital of France?");
  memory.autoSaveExchange("Tell me a fun fact.", "Honey never spoils.", async () => "用户询问了趣闻");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const summaries = readStore().sessions.map((session: any) => session.summary).join(" ");
  assert.equal(/\p{Script=Han}/u.test(summaries), false, summaries);

  memory.autoSaveExchange("Another question.", "Another answer.", async () => {
    throw new Error("timeout of 60000ms exceeded");
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match(readStore().sessions[0].summary, /^The user said:/, "a failed summary falls back to an English one");
});

test("facts reach the model about the user, in the third person, after a memory command", async () => {
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, sessions: [], userMemories: [] }));
  await ask("Remember that my favorite color is blue.");
  await ask("Actually, my favorite color is green.");
  await ask("What is my favorite color?"); // answered without the model
  const prompt = memory.prepareMemoryPrompt("Which color do I like?");
  assert.match(prompt, /- The user's favorite color is green\./, "the current value is offered to the model's next turn");
  assert.equal(/Your favorite color|blue/.test(prompt), false, prompt);
});

// ---- Ollama path: tool calls, spoken JSON, web search ------------------------

test("a tool call written as JSON text is run, not spoken", async () => {
  await ask("Remember that my favorite color is blue.");
  responders = [
    () => say('{"name": "searchLocalMemory", "arguments": {"query": "color I like"}}'),
    (request) => {
      const tool = request.messages.find((m) => m.role === "tool");
      return say(/blue/i.test(tool?.content || "") ? "You like blue." : "I don't know.");
    },
  ];
  const { answer } = await ask("Which color do I like?");
  assert.equal(chatRequests.length, 2);
  assert.equal(answer, "You like blue.");
  assert.equal(answer.includes("{"), false);
});

test("internal markup is never spoken", () => {
  const tools = new Set(["searchLocalMemory"]);
  assert.deepEqual(guard.interpretHeldAnswer('```json\n{"name":"searchLocalMemory","arguments":{"query":"x"}}\n```', tools).toolCall,
    { function: { index: 0, name: "searchLocalMemory", arguments: { query: "x" } } });
  assert.deepEqual(guard.interpretHeldAnswer('<tool> {"name": "searchLocalMemory", "arguments": {"query": "sister"}} </tool>', tools).toolCall,
    { function: { index: 0, name: "searchLocalMemory", arguments: { query: "sister" } } });
  assert.equal(guard.interpretHeldAnswer('{"name":"unknownTool","arguments":{}}', tools).spoken, guard.FALLBACK_REPLY);
  assert.equal(guard.interpretHeldAnswer('{"name": "searchLocal', tools).spoken, guard.FALLBACK_REPLY);
  assert.equal(guard.interpretHeldAnswer("[success]Stored local memory. Your color is blue.", tools).spoken, "Stored local memory. Your color is blue.");
  assert.equal(guard.interpretHeldAnswer("<response> Green it is! </response>", tools).spoken, "Green it is!");
  assert.equal(guard.startsWithMarkup("Sure, blue."), false);
});

test("automatic web search still works with memory enabled", async () => {
  responders = [(request) => say(/November 19, 2026/.test(request.messages.map((m) => m.content).join(" ")) ? "GTA 6 launches on November 19, 2026." : "Not sure.")];
  const { answer } = await ask("When is GTA 6 coming out?");
  assert.deepEqual(searches, [{ query: "When is GTA 6 coming out?", search_type: "web" }]);
  assert.equal(answer, "GTA 6 launches on November 19, 2026.");

  await ask("Remember that the GTA 6 party is at my place.");
  assert.equal(searches.length, 1, "a memory command never triggers a web search");
});
