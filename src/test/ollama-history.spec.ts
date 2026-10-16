import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const captured: { raw: string; body: any }[] = [];
const effects: { name: string; args: any }[] = [];
let replies: object[][] = [];
const finish = (content = "Ready.") => [{ message: { content }, done: true }];
const call = (name: string, args: unknown, index = 0, id?: string) => ({
  ...(id === undefined ? {} : { id }), function: { index, name, arguments: args },
});
const calls = (toolCalls: object[], content = "") => [
  { message: { content, tool_calls: toolCalls } }, { done: true },
];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    if (req.url === "/api/show") {
      res.end(JSON.stringify({ model_info: { context_length: 32768 } }));
      return;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    captured.push({ raw, body: JSON.parse(raw) });
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    for (const record of replies.shift() || finish("Unexpected extra request.")) res.write(JSON.stringify(record) + "\n");
    res.end();
  });
});
let endpoint: string;
const clients = new Map<string, any>();
const providerPath = require.resolve("../cloud-api/local/ollama-llm");

before(async () => {
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  Object.assign(process.env, { LLM_SERVER: "test", ASR_SERVER: "test", TTS_SERVER: "test",
    OLLAMA_MODEL: "test", WEB_SEARCH_ENABLED: "false", MEMORY_ENABLED: "false",
    CONTEXT_AUTO_COMPACT_ENABLED: "false", ENABLE_THINKING: "false", WAKE_WORD_ENABLED: "false" });
  const { pluginRegistry } = require("../plugin");
  pluginRegistry.register({ name: "history-fixture", displayName: "History fixture", type: "llm-tools", version: "1",
    activate: () => ({ getTools: () => ["historyAlpha", "historyBeta"].map(name => ({ execution: "bounded", type: "function",
      function: { name, description: "Test fixture", parameters: { type: "object", properties: {
        label: { type: "string" }, details: { type: "object", properties: {
          count: { type: "integer" }, enabled: { type: "boolean" }, tags: { type: "array", items: { type: "string" } },
        }, required: ["count", "enabled", "tags"] },
      }, required: ["label"] } },
      func: async (args: any) => {
        effects.push({ name, args });
        return `[success]${name}:${args.label}`;
      },
    })) }) });
});
beforeEach(() => { captured.length = 0; effects.length = 0; replies = []; });
after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

function client(enabled = true, rounds = 4) {
  const key = `${enabled}:${rounds}`;
  if (!clients.has(key)) {
    Object.assign(process.env, { OLLAMA_ENDPOINT: endpoint, OLLAMA_ENABLE_TOOLS: String(enabled), OLLAMA_MAX_TOOL_ROUNDS: String(rounds) });
    delete require.cache[providerPath];
    clients.set(key, require("../cloud-api/local/ollama-llm").default);
  }
  const provider = clients.get(key);
  provider.resetChatHistory();
  return provider;
}
async function ask(provider: any, question = "Use the history tool.", history: object[] = []) {
  let answer = "", ends = 0;
  const events: string[] = [];
  await provider.chatWithLLMStream([...history, { role: "user", content: question }],
    (part: string) => answer += part, () => ends++, undefined,
    (name: string, result?: string) => events.push(`${name}:${result === undefined ? "start" : "result"}`));
  assert.equal(ends, 1);
  return { answer, events };
}
const wireMessages = (request: number) => JSON.parse(captured[request].raw).messages.slice(1);

test("A native assistant tool calls preserve arguments, index and supplied ID on the wire", async () => {
  const args = { label: "æøå", details: { count: 2, enabled: true, tags: ["a", "ø"] } };
  replies = [calls([call("historyAlpha", args, 7, "provided-alpha-id")], "Checking. "), finish()];
  const result = await ask(client());
  assert.equal(result.answer, "Checking. Ready.");
  assert.deepEqual(effects, [{ name: "historyAlpha", args }]);
  assert.deepEqual(wireMessages(1)[1], { role: "assistant", content: "Checking. ", tool_calls: [
    { id: "provided-alpha-id", function: { index: 7, name: "historyAlpha", arguments: {
      label: "æøå", details: { count: 2, enabled: true, tags: ["a", "ø"] },
    } } },
  ] });
});

test("B tool results preserve role, tool_name and exact result content", async () => {
  replies = [calls([call("historyBeta", { label: "result" })]), finish()];
  await ask(client());
  assert.deepEqual(wireMessages(1)[2], {
    role: "tool", content: "[success]historyBeta:result", tool_name: "historyBeta",
  });
});

test("C complete authorized interaction reaches the actual next HTTP request in order", async () => {
  replies = [calls([call("historyAlpha", { label: "complete" })]), finish()];
  const result = await ask(client());
  assert.deepEqual(result.events, ["historyAlpha:start", "historyAlpha:result"]);
  assert.deepEqual(effects, [{ name: "historyAlpha", args: { label: "complete" } }]);
  assert.equal(captured.length, 2);
  assert.deepEqual(wireMessages(1), [
    { role: "user", content: "Use the history tool." },
    { role: "assistant", content: "", tool_calls: [
      { function: { index: 0, name: "historyAlpha", arguments: { label: "complete" } } },
    ] },
    { role: "tool", content: "[success]historyAlpha:complete", tool_name: "historyAlpha" },
  ]);
});

test("D multiple packages and repeated tool names retain calls and corresponding result order", async () => {
  replies = [[{ message: { tool_calls: [call("historyAlpha", { label: "first" }, 2), call("historyBeta", { label: "second" }, 4)] } },
    { message: { tool_calls: [call("historyAlpha", { label: "third" }, 6)] } }, { done: true }], finish()];
  await ask(client());
  assert.deepEqual(effects.map(effect => [effect.name, effect.args.label]), [
    ["historyAlpha", "first"], ["historyBeta", "second"], ["historyAlpha", "third"],
  ]);
  assert.deepEqual(wireMessages(1).slice(1), [
    { role: "assistant", content: "", tool_calls: [
      { function: { index: 2, name: "historyAlpha", arguments: { label: "first" } } },
      { function: { index: 4, name: "historyBeta", arguments: { label: "second" } } },
      { function: { index: 6, name: "historyAlpha", arguments: { label: "third" } } },
    ] },
    { role: "tool", content: "[success]historyAlpha:first", tool_name: "historyAlpha" },
    { role: "tool", content: "[success]historyBeta:second", tool_name: "historyBeta" },
    { role: "tool", content: "[success]historyAlpha:third", tool_name: "historyAlpha" },
  ]);
});

test("E ordinary turns keep roles, content and order without introducing tool metadata", async () => {
  const provider = client();
  replies = [finish("Hello æøå."), finish("Next answer.")];
  await ask(provider, "Hello.");
  await ask(provider, "Next question.");
  assert.deepEqual(wireMessages(1), [
    { role: "user", content: "Hello." }, { role: "assistant", content: "Hello æøå." },
    { role: "user", content: "Next question." },
  ]);
  assert.deepEqual(effects, []);
});

test("G historical calls are context only and rejected results never become successes", async () => {
  const history = [
    { role: "assistant", content: "", tool_calls: [[call("historyAlpha", { label: "old" })]] },
    { role: "tool", tool_name: "historyAlpha", content: "[rejected]Prior operation denied." },
  ];
  replies = [finish("Acknowledged.")];
  const result = await ask(client(), "Acknowledge this history.", history);
  assert.deepEqual(result.events, []);
  assert.deepEqual(effects, []);
  assert.deepEqual(wireMessages(0).slice(0, 2), [
    { role: "assistant", content: "", tool_calls: [{ function: { index: 0, name: "historyAlpha", arguments: { label: "old" } } }] },
    { role: "tool", tool_name: "historyAlpha", content: "[rejected]Prior operation denied." },
  ]);
});

test("H/J supplied native identifiers survive actual HTTP serialization without extra fields", async () => {
  const history = [
    { role: "assistant", content: "Original assistant.", internalOnly: "omit", tool_calls: [[
      call("historyBeta", { label: "linked" }, 3, "existing-native-id"),
    ]] },
    { role: "tool", content: "[error]Prior tool failed.", tool_name: "historyBeta", tool_call_id: "existing-native-id", internalOnly: "omit" },
  ];
  replies = [finish("No execution.")];
  await ask(client(), "Continue.", history);
  assert.deepEqual(wireMessages(0), [
    { role: "assistant", content: "Original assistant.", tool_calls: [
      { id: "existing-native-id", function: { index: 3, name: "historyBeta", arguments: { label: "linked" } } },
    ] },
    { role: "tool", content: "[error]Prior tool failed.", tool_name: "historyBeta", tool_call_id: "existing-native-id" },
    { role: "user", content: "Continue." },
  ]);
  assert.deepEqual(Object.keys(captured[0].body.messages[0]).sort(), ["content", "role"]);
  assert.deepEqual(effects, []);
});

test("I authorized JSON fallback keeps the existing normalized assistant call and named result", async () => {
  replies = [finish('{"name":"historyAlpha","arguments":{"label":"fallback ø"}}'), finish()];
  await ask(client());
  assert.deepEqual(effects, [{ name: "historyAlpha", args: { label: "fallback ø" } }]);
  assert.deepEqual(wireMessages(1).slice(1), [
    { role: "assistant", content: "", tool_calls: [
      { function: { index: 0, name: "historyAlpha", arguments: { label: "fallback ø" } } },
    ] },
    { role: "tool", content: "[success]historyAlpha:fallback ø", tool_name: "historyAlpha" },
  ]);
});

test("I rejected JSON fallback stays rejected in later history and is never replayed", async () => {
  const provider = client();
  replies = [finish('{"name":"historyAlpha","arguments":{"label":42}}'), finish("Understood.")];
  const rejected = await ask(provider);
  assert.match(rejected.answer, /Completion was not verified/);
  assert.equal(captured.length, 1);
  await ask(provider, "Continue normally.");
  assert.deepEqual(effects, []);
  const history = wireMessages(1);
  assert.deepEqual(history[1], { role: "assistant", content: "", tool_calls: [
    { function: { index: 0, name: "historyAlpha", arguments: { label: 42 } } },
  ] });
  assert.deepEqual(history[2], { role: "tool", content: "[rejected]Invalid tool arguments or unsupported schema.", tool_name: "historyAlpha" });
});

test("G/I disabled native and JSON fallback calls have no effects and cannot replay", async () => {
  const cases = [
    { response: calls([call("historyAlpha", { label: "blocked" })]), expected: [
      { role: "assistant", content: "", tool_calls: [
        { function: { index: 0, name: "historyAlpha", arguments: { label: "blocked" } } },
      ] },
      { role: "tool", content: "[rejected]Tool execution is disabled.", tool_name: "historyAlpha" },
      { role: "assistant", content: "I couldn't run the requested tool. Completion was not verified." },
    ] },
    { response: finish('{"name":"historyAlpha","arguments":{"label":"blocked"}}'), expected: [
      { role: "assistant", content: "Sorry, I didn't catch that. Could you say it again?" },
    ] },
  ];
  for (const { response, expected } of cases) {
    const provider = client(false);
    replies = [response, finish("Understood.")];
    const previousCount = captured.length;
    await ask(provider);
    assert.equal(captured.length, previousCount + 1);
    await ask(provider, "Continue normally.");
    assert.equal(captured[captured.length - 1].body.tools, undefined);
    assert.deepEqual(wireMessages(captured.length - 1).slice(1, -1), expected);
    assert.deepEqual(effects, []);
  }
});

test("final no-tools projection retains both completed and pending tool history", async () => {
  const prior = [
    { role: "assistant", content: "Already checked.", tool_calls: [[call("historyBeta", { label: "prior" }, 9, "prior-native-id")]] },
    { role: "tool", content: "[error]Prior check failed.", tool_name: "historyBeta", tool_call_id: "prior-native-id" },
  ];
  replies = [calls([call("historyAlpha", { label: "first" }, 0, "first-native-id")]),
    calls([call("historyBeta", { label: "limit" }, 0, "pending-native-id")]), finish("Final answer.")];
  await ask(client(true, 1), "Use the history tool.", prior);
  assert.equal(captured.length, 3);
  assert.equal(captured[2].body.tools, undefined);
  assert.deepEqual(effects, [{ name: "historyAlpha", args: { label: "first" } }]);
  assert.deepEqual(wireMessages(2).slice(0, 6), [
    { role: "assistant", content: "Already checked.", tool_calls: [
      { id: "prior-native-id", function: { index: 9, name: "historyBeta", arguments: { label: "prior" } } },
    ] },
    { role: "tool", content: "[error]Prior check failed.", tool_name: "historyBeta", tool_call_id: "prior-native-id" },
    { role: "user", content: "Use the history tool." },
    { role: "assistant", content: "", tool_calls: [
      { id: "first-native-id", function: { index: 0, name: "historyAlpha", arguments: { label: "first" } } },
    ] },
    { role: "tool", content: "[success]historyAlpha:first", tool_name: "historyAlpha" },
    { role: "assistant", content: "", tool_calls: [
      { id: "pending-native-id", function: { index: 0, name: "historyBeta", arguments: { label: "limit" } } },
    ] },
  ]);
  assert.equal(wireMessages(2)[6].role, "user");
  assert.match(wireMessages(2)[6].content, /^You have already checked enough tool results/);
});
