// Automatic web search with the Ollama provider.
// A fake Ollama server streams /api/chat NDJSON exactly like Ollama and records
// every request; ollama-llm.ts, llm-tools.ts and the router are the real modules.
// Only the tools' network/hardware side (web_search, setVolume) is stubbed.
// Run with: npm test
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "http";
import fs from "fs";
import path from "path";

type ChatRequest = { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };
type Responder = (request: ChatRequest) => object[];

const chatRequests: ChatRequest[] = [];
let responders: Responder[] = [];

const chunk = (message: object) => ({ model: "test", message: { role: "assistant", content: "", ...message }, done: false });
const done = { model: "test", message: { role: "assistant", content: "" }, done: true };
const say = (text: string): object[] => [...text.split(/(?<= )/).map((part) => chunk({ content: part })), done];
const callTool = (name: string, args: object): object[] => [
  chunk({ tool_calls: [{ function: { name, arguments: args } }] }),
  done,
];
// A model that answers only from the tool output it was given.
const groundedModel: Responder = (request) => {
  const toolText = request.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  if (/could not check this right now/.test(toolText)) return say("I could not check this right now.");
  const date = toolText.match(/November 19, 2026/);
  return say(date ? `GTA 6 launches on ${date[0]}.` : "I could not verify that.");
};

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (data) => (body += data));
  req.on("end", () => {
    if (req.url === "/api/show") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model_info: { "qwen3.context_length": 32768 } }));
      return;
    }
    const request = JSON.parse(body) as ChatRequest;
    chatRequests.push(request);
    const responder = responders.shift() || (() => say("(no scripted reply)"));
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    for (const line of responder(request)) res.write(`${JSON.stringify(line)}\n`);
    res.end();
  });
});

let ollama: any;
let llmFuncMap: Record<string, (args: any) => Promise<string>>;
let realWebSearch: (args: any) => Promise<string>;
let needsCurrentInformation: (question: string, now?: Date) => boolean;
let searchTypeFor: (question: string) => string;
let parseDuckDuckGoHtml: (html: string, limit: number) => any[];
const searches: any[] = [];
const volumeCalls: any[] = [];
let historyBefore = new Set<string>();
let chatHistoryDir = "";

const GTA_RESULTS =
  "[success]Source: duckduckgo_html\nSearch Results:\n\n[1] Grand Theft Auto VI is Now Set to Launch November 19, 2026\n" +
  "URL: https://www.rockstargames.com/newswire/article/ak3ak31a49a221\n\n" +
  "Answer the user's question using only these search results.";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, {
    OLLAMA_ENDPOINT: `http://127.0.0.1:${(server.address() as any).port}`,
    OLLAMA_MODEL: "test",
    OLLAMA_ENABLE_TOOLS: "true",
    ENABLE_THINKING: "false",
    WEB_SEARCH_ENABLED: "true",
    LLM_SERVER: "test",
    TTS_SERVER: "test",
    ASR_SERVER: "test",
    MEMORY_ENABLED: "false",
    WAKE_WORD_ENABLED: "false",
  });
  chatHistoryDir = require("../utils/dir").chatHistoryDir;
  historyBefore = new Set(fs.readdirSync(chatHistoryDir));
  llmFuncMap = require("../config/llm-tools").llmFuncMap;
  ({ needsCurrentInformation, searchTypeFor } = require("../config/web-search-router"));
  ({ parseDuckDuckGoHtml } = require("../config/web-search"));
  ollama = require("../cloud-api/local/ollama-llm").default;
  realWebSearch = llmFuncMap.web_search;
  llmFuncMap.setVolume = async (args: any) => {
    volumeCalls.push(args);
    return `Volume set to ${args.percent}%`;
  };
});

beforeEach(() => {
  chatRequests.length = 0;
  searches.length = 0;
  volumeCalls.length = 0;
  responders = [];
  llmFuncMap.web_search = async (args: any) => {
    searches.push(args);
    return GTA_RESULTS;
  };
  ollama.resetChatHistory();
});

after(() => {
  server.close();
  for (const file of fs.readdirSync(chatHistoryDir)) {
    if (!historyBefore.has(file)) fs.rmSync(path.join(chatHistoryDir, file), { force: true });
  }
});

const ask = async (question: string) => {
  let answer = "";
  const toolEvents: string[] = [];
  await ollama.chatWithLLMStream(
    [{ role: "user", content: question }],
    (part: string) => (answer += part),
    () => {},
    () => {},
    (name: string, result?: string) => toolEvents.push(result === undefined ? name : `${name}:done`),
  );
  return { answer: answer.trim(), toolEvents };
};

const toolNames = (request: ChatRequest) => (request.tools || []).map((tool) => tool.function.name).sort();

// ---- Routing ----------------------------------------------------------------

test("clearly time-sensitive questions are routed to web search", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  for (const question of [
    "When is GTA 6 coming out?",
    "When is GTA VI releasing?",
    "When will GTA VI be released?",
    "Who is the current president of the United States?",
    "What's the latest AI news?",
    "What is the weather in Oslo today?",
    "What happened yesterday?",
    "What is the current Bitcoin price?",
    "Who won the last Champions League final?",
    "Is it going to rain tomorrow in London?",
    "What is the newest iPhone?",
    "Who is the president of France?",
    "What happened in 2026?",
    "What's the price of gold?",
  ]) {
    assert.equal(needsCurrentInformation(question, now), true, question);
  }
});

test("stable questions are left to the model", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  for (const question of [
    "What is the capital of France?",
    "Tell me a joke about cats.",
    "How do I boil an egg?",
    "What is 12 times 7?",
    "Who wrote Romeo and Juliet?",
    "What is electric current?",
    "Set the volume to 50 percent.",
    "What day is it today?",
    "What happened in 1969?",
    "When was Windows 95 released?",
    "What is 2 plus 2? Answer in one sentence.",
    "Explain price elasticity.",
    "",
  ]) {
    assert.equal(needsCurrentInformation(question, now), false, question);
  }
});

test("news questions use the news search type", () => {
  assert.equal(searchTypeFor("What's the latest AI news?"), "news");
  assert.equal(searchTypeFor("When is GTA 6 coming out?"), "web");
});

// ---- Search results ----------------------------------------------------------

test("DuckDuckGo results keep their snippets", () => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures", "duckduckgo-results.html"), "utf8");
  assert.deepEqual(parseDuckDuckGoHtml(html, 5), [
    {
      title: "Bitcoin price today, BTC to USD live price, marketcap and chart ...",
      url: "https://coinmarketcap.com/currencies/bitcoin/",
      snippet: "The live Bitcoin price today is $81,017.22 USD. It's updated in real-time.",
    },
    { title: "Today's Bitcoin price - CoinDesk", url: "https://www.coindesk.com/price/bitcoin" },
  ]);
});

test("a failed search tells the model to say it could not check", async () => {
  const result = await realWebSearch({ query: "" });
  assert.match(result, /^\[error\]Failed to search web: query is required/);
  assert.match(result, /Tell the user you could not check this right now\. Do not guess/);
});

// ---- Ollama conversation flow -----------------------------------------------

test("a time-sensitive question searches first and the answer uses the results", async () => {
  responders = [groundedModel];
  const question = "When is GTA 6 coming out?";
  const { answer, toolEvents } = await ask(question);

  assert.deepEqual(searches, [{ query: question, search_type: "web" }]);
  assert.deepEqual(toolEvents, ["web_search", "web_search:done"]);
  assert.equal(chatRequests.length, 1);
  const [request] = chatRequests;
  assert.deepEqual(toolNames(request), ["fetch_webpage", "web_search"], "only read-only web tools after a routed search");
  assert.match(request.messages[0].content, /Today is .+\d{4}\./);
  assert.match(request.messages[0].content, /call web_search before answering/);
  assert.deepEqual(request.messages.slice(-3).map((m) => m.role), ["user", "assistant", "tool"]);
  assert.equal(request.messages[request.messages.length - 1].content, GTA_RESULTS);
  assert.equal(answer, "GTA 6 launches on November 19, 2026.");
});

test("streamed Ollama tool calls are parsed, executed and their results sent back", async () => {
  const args = { query: "Artemis program status", search_type: "web" };
  responders = [() => [chunk({ content: "Let me check. " }), ...callTool("web_search", args)], groundedModel];
  const { answer } = await ask("Tell me about the Artemis moon program.");

  assert.deepEqual(searches, [args]);
  assert.equal(chatRequests.length, 2);
  assert.deepEqual(toolNames(chatRequests[0]), ["fetch_webpage", "web_search"], "the model chose the tool itself; volume tools are not offered");
  const toolMessage = chatRequests[1].messages.find((m) => m.role === "tool");
  assert.equal(toolMessage?.content, GTA_RESULTS);
  assert.equal(answer, "Let me check. GTA 6 launches on November 19, 2026.");
});

test("an ordinary question is answered without searching", async () => {
  responders = [() => say("The capital of France is Paris.")];
  const { answer } = await ask("What is the capital of France?");

  assert.deepEqual(searches, []);
  assert.equal(chatRequests.length, 1);
  assert.deepEqual(toolNames(chatRequests[0]), ["fetch_webpage", "web_search"], "web tools stay available");
  assert.equal(chatRequests[0].messages.some((m) => m.role === "tool"), false);
  assert.equal(answer, "The capital of France is Paris.");
});

test("when the search fails the answer says so instead of guessing", async () => {
  llmFuncMap.web_search = async (args: any) => {
    searches.push(args);
    return realWebSearch({ ...args, query: "" });
  };
  responders = [groundedModel];
  const { answer } = await ask("What is the current Bitcoin price?");

  assert.equal(searches.length, 1);
  assert.match(chatRequests[0].messages[chatRequests[0].messages.length - 1].content, /^\[error\]/);
  assert.equal(answer, "I could not check this right now.");
});

test("a repeated identical search is not executed again", async () => {
  const question = "What is the weather in Oslo today?";
  responders = [() => callTool("web_search", { query: question, search_type: "web" }), groundedModel];
  await ask(question);

  assert.equal(searches.length, 1);
  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests[1].tools, undefined, "the final answer request offers no tools");
});

test("other tools keep working (setVolume)", async () => {
  responders = [() => callTool("setVolume", { percent: 50 }), () => say("Done, the volume is 50 percent.")];
  const { answer } = await ask("Set the volume to 50 percent.");

  assert.deepEqual(volumeCalls, [{ percent: 50 }]);
  assert.deepEqual(searches, []);
  assert.equal(toolNames(chatRequests[0]).length, 5);
  assert.equal(chatRequests[1].messages.find((m) => m.role === "tool")?.content, "Volume set to 50%");
  assert.equal(answer, "Done, the volume is 50 percent.");
});
