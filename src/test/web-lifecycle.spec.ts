import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { executeToolCall } from "../config/tool-execution";
import type { LLMTool } from "../type";

let tool: LLMTool;
let searchTool: LLMTool;
let response: () => Response;
const signals: AbortSignal[] = [];
const proxyPath = require.resolve("../cloud-api/proxy-fetch");
const original = require.cache[proxyPath];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
before(() => {
  process.env.WEB_SEARCH_ENABLED = "true";
  process.env.WEB_TOOL_TIMEOUT_MS = "50";
  require.cache[proxyPath] = { id: proxyPath, filename: proxyPath, loaded: true, exports: {
    proxyFetch: async (_url: string, options: RequestInit) => { signals.push(options.signal!); return response(); },
  } } as NodeModule;
  tool = require("../config/web-search").webSearchTools.find((item: LLMTool) => item.function.name === "fetch_webpage");
  searchTool = require("../config/web-search").webSearchTools.find((item: LLMTool) => item.function.name === "web_search");
});
after(() => { if (original) require.cache[proxyPath] = original; else delete require.cache[proxyPath]; });
const invoke = (signal?: AbortSignal) => executeToolCall("fetch_webpage", { url: "http://fixture.invalid/page" }, {
  enabled: true, allowedTools: [tool], registeredTools: [tool], handlers: { fetch_webpage: tool.func }, signal,
});

test("web tool consumes successful body while retaining exact page text", async () => {
  response = () => new Response("<title>Fixture</title><p>Measured page æøå.</p>");
  const result = await invoke();
  assert.equal(result.status, "success");
  assert.match(result.output, /Measured page æøå/);
  assert.equal(signals[signals.length - 1].aborted, true, "HTTP scope disposed after body");
});

test("web deadline covers a body that stalls after HTTP headers", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = 0;
  response = () => new Response(new ReadableStream({ cancel() { cancelled++; } }));
  const pending = invoke(); await flush();
  t.mock.timers.tick(50);
  const result = await pending;
  assert.equal(result.status, "error");
  assert.match(result.output, /timed out/);
  assert.equal(cancelled, 1);
});

test("parent cancellation aborts active HTTP, cancels its reader and removes linkage", async () => {
  let cancelled = 0;
  response = () => new Response(new ReadableStream({ cancel() { cancelled++; } }));
  const parent = new AbortController(), pending = invoke(parent.signal);
  await flush(); parent.abort(new Error("fixture cancelled"));
  assert.equal((await pending).status, "unverified");
  await flush();
  assert.equal(cancelled, 1);
  assert.equal(signals[signals.length - 1].aborted, true);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
});

test("web body byte cap cancels excessive input instead of retaining it", async () => {
  let cancelled = 0;
  response = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled++; },
  }));
  const result = await invoke();
  assert.equal(result.status, "error");
  assert.match(result.output, /exceeds 2097152 bytes/);
  assert.equal(cancelled, 1);
});

test("cancelled news search cannot start its legacy fallback HTTP operation", async () => {
  const before = signals.length;
  response = () => new Response(new ReadableStream({ cancel() {} }));
  const parent = new AbortController();
  const pending = executeToolCall("web_search", { query: "fixture news", search_type: "news" }, {
    enabled: true, allowedTools: [searchTool], registeredTools: [searchTool], handlers: { web_search: searchTool.func }, signal: parent.signal,
  });
  await flush(); parent.abort(); await pending; await flush();
  assert.equal(signals.length, before + 1);
});
