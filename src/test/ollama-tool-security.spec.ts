import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

const requests: any[] = [];
let replies: any[][] = [];
const effects: any[] = [];
const content = (text: string) => [{ message: { content: text } }, { done: true }];
const call = (name: string, args: unknown) => [{ message: { tool_calls: [{ function: { name, arguments: args } }] } }, { done: true }];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => body += chunk);
  req.on("end", () => {
    if (req.url === "/api/show") {
      res.end(JSON.stringify({ model_info: { context_length: 32768 } }));
      return;
    }
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    for (const part of replies.shift() || content("Done.")) res.write(JSON.stringify(part) + "\n");
    res.end();
  });
});
let endpoint: string;
let functions: Record<string, any>;
let tools: any[];
let realPlugin: (args: any) => Promise<string>;
const modulePath = require.resolve("../cloud-api/local/ollama-llm");

before(async () => {
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/, "use the isolated npm test entry point");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  Object.assign(process.env, {
    LLM_SERVER: "test", ASR_SERVER: "test", TTS_SERVER: "test", MEMORY_ENABLED: "false",
    WEB_SEARCH_ENABLED: "true", ENABLE_THINKING: "false", WAKE_WORD_ENABLED: "false",
    HARNESS_COMMAND_TOOL_ENABLED: "true", HARNESS_COMMAND_ALLOW_DANGEROUS: "true",
    HARNESS_SKILL_TOOL_ENABLED: "true", HARNESS_SKILL_DIRS: path.join(__dirname, "fixtures", "no-skills"),
  });
  const { pluginRegistry } = require("../plugin");
  pluginRegistry.register({ name: "security-fixture", displayName: "Security fixture", version: "1", type: "llm-tools",
    activate: () => ({ getTools: () => [{ execution: "bounded", type: "function", function: { name: "approvedPlugin", description: "fixture",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["read"] } }, required: ["action"] } },
      func: async (args: any) => { effects.push(args); return "[success]Plugin read completed."; } }] }) });
  const registry = require("../config/llm-tools");
  functions = registry.llmFuncMap;
  tools = registry.llmTools;
  realPlugin = functions.approvedPlugin;
});

beforeEach(() => {
  requests.length = 0;
  replies = [];
  effects.length = 0;
  process.env.LLM_SERVER = "test";
  functions.setVolume = async (args: any) => { effects.push(args); return "[success]Volume set."; };
  functions.increaseVolume = async (args: any) => { effects.push(args); return "[success]Volume increased."; };
  functions.web_search = async (args: any) => { effects.push(args); return "[success]Search results."; };
  functions.runCommand = async (args: any) => { effects.push(args); return "[success]Should never execute."; };
});
after(() => server.close());

async function ask(question: string, enabled = true) {
  Object.assign(process.env, { OLLAMA_ENDPOINT: endpoint, OLLAMA_MODEL: "test", OLLAMA_ENABLE_TOOLS: String(enabled) });
  delete require.cache[modulePath];
  const llm = require("../cloud-api/local/ollama-llm").default;
  let answer = "";
  await llm.chatWithLLMStream([{ role: "user", content: question }], (part: string) => answer += part, () => {});
  return answer;
}

test("native tool calls cannot bypass OLLAMA_ENABLE_TOOLS=false", async () => {
  replies = [call("setVolume", { percent: 50 })];
  const answer = await ask("Set the volume to 50 percent.", false);
  assert.deepEqual(effects, []);
  assert.equal(requests[0].tools, undefined);
  assert.equal(requests.length, 1, "the model cannot rewrite a rejection as success");
  assert.match(answer, /couldn't run.*Completion was not verified/);
});

test("JSON fallback cannot bypass disabled, unoffered or unknown tools", async () => {
  for (const [enabled, question, name] of [[false, "Set the volume to 50 percent.", "setVolume"],
    [true, "Tell me a joke.", "setVolume"], [true, "Hello.", "unknownTool"]] as const) {
    const count = requests.length;
    replies = [content(JSON.stringify({ name, arguments: { percent: 50 } }))];
    const answer = await ask(question, enabled);
    assert.equal(requests.length, count + 1, "the fake model response was actually processed");
    assert.deepEqual(effects, []);
    assert.equal(answer.includes("{"), false);
  }
});

test("native calls to unoffered or unknown tools have no effects and no success rewrite", async () => {
  for (const name of ["setVolume", "unknownTool", "constructor", "toString"]) {
    replies = [call(name, { percent: 50 })];
    const count = requests.length;
    assert.match(await ask("Tell me a joke."), /Completion was not verified/);
    assert.equal(requests.length, count + 1);
    assert.deepEqual(effects, []);
  }
});

test("native and text fallback reject invalid arguments before invocation", async () => {
  for (const args of [{ percent: "50; true" }, { percent: -1 }, { percent: 101 },
    { percent: 50, command: "pwd; true" }, [], null]) {
    for (const response of [call("setVolume", args), content(JSON.stringify({ name: "setVolume", arguments: args }))]) {
      const count = requests.length;
      replies = [response];
      assert.match(await ask("Change the volume."), /Completion was not verified/);
      assert.equal(requests.length, count + 1);
      assert.deepEqual(effects, []);
    }
  }
  for (const argumentsValue of ["not-json", null, "null", []]) {
    replies = [content(JSON.stringify({ name: "increaseVolume", arguments: argumentsValue }))];
    assert.match(await ask("Increase the volume."), /Completion was not verified/);
    assert.deepEqual(effects, [], "malformed no-argument calls are not repaired into {}");
  }
});

test("shell tools are absent and reserved even with dangerous mode enabled", async () => {
  assert.ok(tools.some((tool) => tool.function.name === "listSkills"));
  assert.ok(tools.some((tool) => tool.function.name === "readSkill"));
  for (const name of ["runCommand", "checkCommand", "stopCommand"]) {
    assert.equal(tools.some((tool) => tool.function.name === name), false);
    replies = [call(name, { command: "pwd; true" })];
    assert.match(await ask("Run a command."), /Completion was not verified/);
  }
  assert.deepEqual(effects, []);
});

test("approved native and JSON calls preserve the existing conversation flow", async () => {
  for (const first of [call("setVolume", { percent: 50 }), content('{"name":"setVolume","arguments":{"percent":50}}')]) {
    const count = requests.length;
    replies = [first, content("The volume is 50 percent.")];
    assert.equal(await ask("Set the volume to 50 percent."), "The volume is 50 percent.");
    assert.equal(requests.length, count + 2);
    assert.equal(requests[count + 1].messages.find((msg: any) => msg.role === "tool").content, "[success]Volume set.");
  }
  assert.deepEqual(effects, [{ percent: 50 }, { percent: 50 }]);
});

test("automatic search uses the same enabled gate and validated execution", async () => {
  replies = [content("Here are the results.")];
  await ask("What is the weather in Oslo today?");
  assert.deepEqual(effects, [{ query: "What is the weather in Oslo today?", search_type: "web" }]);
  effects.length = 0;
  replies = [content("I cannot check that.")];
  await ask("What is the weather in Oslo today?", false);
  assert.deepEqual(effects, []);
});

test("registry wrappers protect approved plugin handlers and direct provider callers", async () => {
  assert.match(await realPlugin({ action: "delete" }), /^\[rejected\]/);
  assert.match(await realPlugin({ action: "read", extra: true }), /^\[rejected\]/);
  assert.deepEqual(effects, []);
  assert.equal(await realPlugin({ action: "read" }), "[success]Plugin read completed.");
  assert.deepEqual(effects, [{ action: "read" }]);
  effects.length = 0;
  Object.assign(process.env, { LLM_SERVER: "ollama", OLLAMA_ENABLE_TOOLS: "false" });
  assert.match(await realPlugin({ action: "read" }), /^\[rejected\]/);
  assert.deepEqual(effects, []);
});

test("a routed search cannot authorize a subsequent device action", async () => {
  replies = [call("setVolume", { percent: 50 })];
  assert.match(await ask("What is the weather in Oslo today?"), /Completion was not verified/);
  assert.deepEqual(effects, [{ query: "What is the weather in Oslo today?", search_type: "web" }]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tools.map((tool: any) => tool.function.name), ["fetch_webpage", "web_search"]);
});

test("unknown action results cannot be turned into confirmed completion by the model", async () => {
  functions.setVolume = async () => "Maybe done";
  replies = [call("setVolume", { percent: 50 }), content("Everything succeeded!")];
  assert.equal(await ask("Set the volume to 50 percent."), "The tool did not confirm completion. The result is unverified.");
  assert.equal(requests.length, 1);
});

test("malformed native calls terminate safely without invoking a handler", async () => {
  replies = [[{ message: { tool_calls: [null] } }, { done: true }]];
  assert.match(await ask("Hello."), /Completion was not verified/);
  assert.deepEqual(effects, []);
});
