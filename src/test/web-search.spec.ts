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
const pageRequests: string[] = [];
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
  if (req.method === "GET") {
    pageRequests.push(req.url!);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><title>Documentation</title><body>Page ${req.url}</body></html>`);
    return;
  }
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
  assert.match(require("../utils/dir").dataDir, /\.test-artifacts/);
  // These tests fetch fixture pages only through the loopback server.
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) delete process.env[key];
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
    return `[success]Volume set to ${args.percent}%`;
  };
});

beforeEach(() => {
  chatRequests.length = 0;
  pageRequests.length = 0;
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
  let ends = 0;
  const toolEvents: string[] = [];
  await ollama.chatWithLLMStream(
    [{ role: "user", content: question }],
    (part: string) => (answer += part),
    () => ends++,
    () => {},
    (name: string, result?: string) => toolEvents.push(result === undefined ? name : `${name}:done`),
  );
  return { answer: answer.trim(), toolEvents, ends };
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

test("greetings and clear small talk never become current-information requests because of recency words", () => {
  for (const question of ["How are you doing today?", "How are you doing?", "How are you feeling right now?",
    "Hey GLaDOS, how are you doing today?", "Hi! How are you today?", "How's your day going?",
    "What are you up to today?", "What's up?", "What's new with you today?", "Hello, GLaDOS!",
    "Tell me a joke today.", "Let's chat for a bit.", "Thanks for your help today."]) {
    assert.equal(needsCurrentInformation(question), false, question);
  }
});

test("greeting-like wording does not suppress mixed, quoted, ambiguous or real current-information questions", () => {
  for (const question of ["How are you doing today? What's the weather in Oslo?",
    "Hi! What's the latest AI news?", "Search the web for 'How are you doing today?'",
    "How is Apple doing today?", "What's happening today?", "What's new in AI today?"]) {
    assert.equal(needsCurrentInformation(question), true, question);
  }
});

test("small talk drops inherited tools while preserving ordering and legitimate follow-ups", () => {
  const { toolsRelevantTo } = require("../config/tool-router");
  const tools = ["fixtureFirst", "web_search", "setVolume", "fetch_webpage", "fixtureLast"]
    .map(name => ({ function: { name } }));
  assert.deepEqual(toolsRelevantTo("What's up?", tools, "Set the volume to 50 percent.")
    .map((tool: any) => tool.function.name), ["fixtureFirst", "fetch_webpage", "fixtureLast"]);
  assert.deepEqual(toolsRelevantTo("A bit more.", tools, "Set the volume to 50 percent.")
    .map((tool: any) => tool.function.name), ["fixtureFirst", "web_search", "fetch_webpage", "fixtureLast", "setVolume"]);
});

// ---- Search results ----------------------------------------------------------

test("intent priority preserves explicit/mixed searches and excludes local personal/creative requests", () => {
  for (const question of ["I feel tired today.", "I am feeling exhausted tonight.",
    "Tell me a bedtime story tonight.", "Please write a short poem tomorrow."]) {
    assert.equal(needsCurrentInformation(question), false, question);
  }
  for (const question of ["Search the web for the capital of Norway. Answer in one sentence.",
    "Could you please search online for DNS? Keep it short.",
    "I feel tired today. What is the weather in Oslo?",
    "I feel tired today and what happened in Oslo",
    "Tell me a story tonight and check the football scores",
    "Tell me a story about the latest news.", "What is the weather in Oslo today?"]) {
    assert.equal(needsCurrentInformation(question), true, question);
    assert.equal(require("../config/tool-router").isDirectAnswerRequest(question), false, question);
  }
  for (const question of ["Do not search the web. Explain DNS in one sentence.",
    "Why do people search the web?"]) {
    assert.equal(require("../config/web-search-router").hasExplicitWebSearch(question), false, question);
  }
});

for (const question of ["I feel tired today.", "Tell me a bedtime story tonight."]) {
  test(`local intent has no prefetch: ${question}`, async () => {
    responders = [() => say("A local response.")];
    const result = await ask(question);
    assert.equal(result.answer, "A local response.");
    assert.deepEqual(searches, []); assert.deepEqual(result.toolEvents, []);
    assert.equal(toolNames(chatRequests[0]).includes("web_search"), false);
  });
  for (const mode of ["native", "json"]) test(`local intent denies proposed search (${mode}): ${question}`, async () => {
    responders = [() => mode === "native" ? callTool("web_search", { query: question })
      : say(JSON.stringify({ name: "web_search", arguments: { query: question } }))];
    await ask(question);
    assert.deepEqual(searches, [], "handler execution, not UI placeholders, is the assertion");
    assert.equal(chatRequests.length, 1);
  });
}

test("explicit search with a short-answer hint executes once before generation", async () => {
  const question = "Search the web for the capital of Norway. Answer in one sentence.";
  responders = [() => say("Oslo is the capital of Norway.")];
  const result = await ask(question);
  assert.deepEqual(searches, [{ query: question, search_type: "web" }]);
  assert.deepEqual(result.toolEvents, ["web_search", "web_search:done"]);
  assert.equal(result.answer, "Oslo is the capital of Norway.");
  assert.ok(chatRequests[0].messages.some(message => message.role === "tool"));
});

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

test("news search normalizes the Pi utterance and falls back from unrelated results", async t => {
  const urls: string[] = [];
  t.mock.method(require("../cloud-api/proxy-fetch"), "proxyFetch", async (url: string) => {
    urls.push(url);
    const body = urls.length === 1
      ? '<rss><item><title>Oppo phone release</title><link>https://example.com/oppo</link></item></rss>'
      : '<a class="result__a" href="https://example.com/pi">Raspberry Pi news update</a>';
    return new Response(body, { status: 200 });
  });
  const result = await realWebSearch({ query: "Search where the latest Raspberry Pi news.", search_type: "news" });
  assert.equal(urls.length, 2);
  for (const url of urls) assert.equal(new URL(url).searchParams.get("q"), "the latest Raspberry Pi news.");
  assert.match(result, /^\[success\]Source: duckduckgo_html/);
  assert.match(result, /Raspberry Pi news update/);
  assert.doesNotMatch(result, /Oppo/);
});

test("relevant Google News is retained and irrelevant entries are excluded", async t => {
  let calls = 0;
  t.mock.method(require("../cloud-api/proxy-fetch"), "proxyFetch", async () => {
    calls++;
    return new Response('<rss><item><title>Raspberry Pi news</title><link>https://example.com/pi</link></item>' +
      '<item><title>Oppo phone</title><link>https://example.com/oppo</link></item></rss>');
  });
  const result = await realWebSearch({ query: "What's the latest Raspberry Pi news?", search_type: "news" });
  assert.equal(calls, 1); assert.match(result, /Raspberry Pi news/); assert.doesNotMatch(result, /Oppo/);
});

test("irrelevant results from both news sources yield a direct unverified answer", async t => {
  let calls = 0;
  t.mock.method(require("../cloud-api/proxy-fetch"), "proxyFetch", async () => {
    calls++;
    return new Response(calls === 1
      ? '<rss><item><title>Oppo phone</title><link>https://example.com/oppo</link></item></rss>'
      : '<a class="result__a" href="https://example.com/phone">Another phone</a>');
  });
  const result = await realWebSearch({ query: "latest Raspberry Pi news", search_type: "news" });
  assert.equal(calls, 2);
  assert.equal(result, "[response]I couldn't find relevant news results to verify that right now.");
});

test("empty news results and provider failures cannot generate fabricated claims", async t => {
  let mode = "empty", calls = 0;
  t.mock.method(require("../cloud-api/proxy-fetch"), "proxyFetch", async () => {
    calls++;
    if (mode === "failure") throw new Error("unavailable");
    return new Response(calls % 2 ? "<rss></rss>" : "<html></html>");
  });
  for (mode of ["empty", "failure"]) {
    calls = 0;
    assert.equal(await realWebSearch({ query: "latest Raspberry Pi news", search_type: "news" }),
      "[response]I couldn't find relevant news results to verify that right now.");
    assert.equal(calls, 2);
  }
});

test("a cancelled news request does not start a fallback", async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(require("../cloud-api/proxy-fetch"), "proxyFetch", async () => {
    calls++; controller.abort(new Error("cancelled")); throw new Error("cancelled");
  });
  const { withToolSignal } = require("../utils/operation-lifecycle");
  const rawSearch = require("../config/web-search").webSearchTools.find((tool: any) => tool.function.name === "web_search").func;
  await assert.rejects(withToolSignal(controller.signal, () => rawSearch({ query: "Raspberry Pi news", search_type: "news" })));
  assert.equal(calls, 1);
});

test("relevant news respects the requested result limit", async t => {
  t.mock.method(require("../cloud-api/proxy-fetch"), "proxyFetch", async () => new Response(
    '<rss><item><title>Raspberry Pi one</title><link>https://example.com/one</link></item>' +
    '<item><title>Raspberry Pi two</title><link>https://example.com/two</link></item></rss>'));
  const result = await realWebSearch({ query: "Raspberry Pi news", search_type: "news", num_results: 1 });
  assert.match(result, /Raspberry Pi one/); assert.doesNotMatch(result, /Raspberry Pi two/);
});

test("failed automatic news search returns a host answer without asking the model", async () => {
  llmFuncMap.web_search = async () => "[response]I couldn't find relevant news results to verify that right now.";
  const result = await ask("Search where the latest Raspberry Pi news.");
  assert.equal(result.answer, "I couldn't find relevant news results to verify that right now.");
  assert.equal(result.ends, 1); assert.equal(chatRequests.length, 0);
});

for (const automatic of [true, false]) {
  test(`unavailable news is delivered without a model-generated claim (${automatic ? "prefetch" : "native call"})`, async t => {
    t.mock.method(require("../cloud-api/proxy-fetch"), "proxyFetch", async () => new Response("<html></html>"));
    llmFuncMap.web_search = realWebSearch;
    if (!automatic) responders = [() => callTool("web_search", { query: "Raspberry Pi news", search_type: "news" })];
    const result = await ask(automatic ? "Latest Raspberry Pi news?" : "Find information about Raspberry Pi.");
    assert.equal(result.answer, "I couldn't find relevant news results to verify that right now.");
    assert.equal(result.ends, 1); assert.equal(chatRequests.length, automatic ? 0 : 1);
  });
}

test("explicit search normalization retains topics, qualifiers and non-command questions", () => {
  const { normalizeSearchQuery } = require("../config/web-search");
  for (const [input, expected] of [
    ["Search where the latest Raspberry Pi news.", "the latest Raspberry Pi news."],
    ["Search the web for Raspberry Pi 5 prices in Norway", "Raspberry Pi 5 prices in Norway"],
    ["Look up weather in Oslo", "weather in Oslo"],
    ["When is GTA 6 coming out?", "When is GTA 6 coming out?"],
    ["Search for", "Search for"],
  ]) assert.equal(normalizeSearchQuery(input), expected);
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

test("the reported greeting reaches the model without a forced search or injected tool result", async () => {
  responders = [() => say("Operational. Thank you for asking.")];
  const result = await ask("How are you doing today?");
  assert.deepEqual(searches, []); assert.deepEqual(result.toolEvents, []);
  assert.equal(chatRequests.length, 1); assert.equal(result.ends, 1);
  assert.equal(toolNames(chatRequests[0]).includes("web_search"), false);
  assert.equal(toolNames(chatRequests[0]).includes("fetch_webpage"), true, "unrelated tool behavior is preserved");
  assert.equal(chatRequests[0].messages.some(message => message.role === "tool"), false);
  assert.equal(result.answer, "Operational. Thank you for asking.");
});

for (const mode of ["native", "JSON fallback"] as const) {
  test(`small talk cannot execute a model-proposed search (${mode})`, async () => {
    const call = { query: "How are you doing", search_type: "web" };
    responders = [() => mode === "native" ? callTool("web_search", call)
      : say(JSON.stringify({ name: "web_search", arguments: call })), () => say("Should not require a search.")];
    const result = await ask("How are you doing?");
    assert.deepEqual(searches, []); assert.equal(chatRequests.length, 1); assert.equal(result.ends, 1);
    assert.equal(toolNames(chatRequests[0]).includes("web_search"), false);
    if (mode === "native") assert.match(result.answer, /Completion was not verified/);
    else assert.equal(result.answer, "Sorry, I didn't catch that. Could you say it again?");
  });

  test(`a previous search cannot grant search permission to the next greeting (${mode})`, async () => {
    responders = [groundedModel];
    await ask("What's the latest AI news?");
    assert.equal(searches.length, 1);
    const previous = JSON.parse(JSON.stringify(chatRequests[0].messages));
    responders = [() => mode === "native" ? callTool("web_search", { query: "latest AI news", search_type: "web" })
      : say(JSON.stringify({ name: "web_search", arguments: { query: "latest AI news", search_type: "web" } })), () => say("No additional search needed.")];
    await ask("What's up?");
    assert.equal(searches.length, 1, "only the preceding genuine search may execute");
    assert.equal(chatRequests.length, 2);
    assert.equal(toolNames(chatRequests[1]).includes("web_search"), false);
    assert.deepEqual(chatRequests[1].messages.slice(0, previous.length), previous, "existing history remains unchanged");
    assert.equal(chatRequests[1].messages[chatRequests[1].messages.length - 1].content, "What's up?");
  });
}

for (const [question, automatic] of [["What's new?", false], ["Search the web for 'How are you doing today?'", true],
  ["How are you doing today? What's the weather in Oslo?", true]] as const) {
  test(`real or ambiguous search remains available: ${question}`, async () => {
    assert.equal(needsCurrentInformation(question), automatic);
    const args = { query: question, search_type: "web" };
    responders = automatic ? [() => say("Here are the requested results.")]
      : [() => callTool("web_search", args), () => say("Here are the requested results.")];
    const result = await ask(question);
    assert.deepEqual(searches, [args]);
    assert.ok(toolNames(chatRequests[0]).includes("web_search"));
    assert.equal(result.answer, "Here are the requested results.");
    assert.equal(chatRequests.length, automatic ? 1 : 2);
  });
}

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

for (const mode of ["native", "JSON fallback"] as const) {
  const fetchCall = (args: object) => mode === "native"
    ? callTool("fetch_webpage", args)
    : say(JSON.stringify({ name: "fetch_webpage", arguments: args }));

  test(`distinct webpage URLs remain distinct across rounds (${mode})`, async () => {
    for (const field of ["url", "current_url"]) {
      for (const paths of [["/guide-a", "/guide/a"], ["/Guide", "/guide"], ["/doc?q=a-b", "/doc?q=a/b"]]) {
        ollama.resetChatHistory();
        chatRequests.length = 0;
        pageRequests.length = 0;
        const base = `http://127.0.0.1:${(server.address() as any).port}`;
        responders = [() => fetchCall({ [field]: base + paths[0] }),
          () => fetchCall({ [field]: base + paths[1] }), () => say("Both pages checked.")];
        const result = await ask("Compare these documentation pages.");
        assert.deepEqual(pageRequests, paths, `${field}: ${paths.join(" vs ")}`);
        assert.equal(result.answer, "Both pages checked.");
        assert.equal(result.ends, 1);
        assert.deepEqual(result.toolEvents, ["fetch_webpage", "fetch_webpage:done", "fetch_webpage", "fetch_webpage:done"]);
        assert.equal(chatRequests.length, 3);
        assert.ok(toolNames(chatRequests[2]).includes("fetch_webpage"), "no false duplicate forced a no-tools answer");
        assert.deepEqual(chatRequests[2].messages.filter(m => m.role === "tool").map(m => m.content.split("\n")[0]),
          paths.map(p => `[success]URL: ${base}${p}`));
      }
    }
  });

  test(`an identical webpage call is still suppressed across rounds (${mode})`, async () => {
    const url = `http://127.0.0.1:${(server.address() as any).port}/same`;
    responders = [() => fetchCall({ url, max_chars: 500 }), () => fetchCall({ max_chars: 500, url }),
      () => say("Already checked.")];
    const result = await ask("Read this documentation page.");
    assert.deepEqual(pageRequests, ["/same"]);
    assert.deepEqual(result.toolEvents, ["fetch_webpage", "fetch_webpage:done"]);
    assert.equal(result.answer, "Already checked.");
    assert.equal(result.ends, 1);
    assert.equal(chatRequests.length, 3);
    assert.equal(chatRequests[2].tools, undefined, "actual duplicate takes the existing no-tools path");
  });
}

test("identical webpage calls in independent requests do not share suppression state", async () => {
  const url = `http://127.0.0.1:${(server.address() as any).port}/again`;
  responders = [() => callTool("fetch_webpage", { url }), () => say("First checked."),
    () => say(JSON.stringify({ name: "fetch_webpage", arguments: { url } })), () => say("Second checked.")];
  assert.equal((await ask("Read this documentation page.")).answer, "First checked.");
  // Keep the same provider and its conversation history for the next request.
  assert.equal((await ask("Read that documentation page again.")).answer, "Second checked.");
  assert.deepEqual(pageRequests, ["/again", "/again"]);
  assert.equal(chatRequests.length, 4);
  assert.ok(toolNames(chatRequests[3]).includes("fetch_webpage"));
});

test("other tools keep working (setVolume)", async () => {
  responders = [() => callTool("setVolume", { percent: 50 }), () => say("Done, the volume is 50 percent.")];
  const { answer } = await ask("Set the volume to 50 percent.");

  assert.deepEqual(volumeCalls, [{ percent: 50 }]);
  assert.deepEqual(searches, []);
  assert.equal(toolNames(chatRequests[0]).length, 5);
  assert.equal(chatRequests[1].messages.find((m) => m.role === "tool")?.content, "[success]Volume set to 50%");
  assert.equal(answer, "Done, the volume is 50 percent.");
});
