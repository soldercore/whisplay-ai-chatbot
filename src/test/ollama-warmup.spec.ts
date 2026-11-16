import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import axios from "axios";

// The warm-up runs when the provider module is imported with LLM_SERVER=ollama, so each case
// scripts axios, then imports a fresh copy of the provider. Ollama itself is never contacted.
const providerPath = require.resolve("../cloud-api/local/ollama-llm");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const originalPost = axios.post;
let posts: { at: number; signal?: AbortSignal }[] = [];
let inFlight = 0, maxInFlight = 0;
let logs: string[] = [], errors: string[] = [];
let realLog: typeof console.log, realError: typeof console.error;

type Step = "ok" | "fail" | { fail: number };   // { fail: ms } = a failure that takes ms to arrive

function install(steps: Step[], opts: { attempts?: number; delayMs?: number } = {}) {
  Object.assign(process.env, {
    LLM_SERVER: "ollama", OLLAMA_MODEL: "fixture", MEMORY_ENABLED: "false", WEB_SEARCH_ENABLED: "false",
    OLLAMA_WARMUP_ATTEMPTS: String(opts.attempts ?? 4), OLLAMA_WARMUP_RETRY_DELAY_MS: String(opts.delayMs ?? 20),
  });
  posts = []; inFlight = 0; maxInFlight = 0;
  let n = 0;
  (axios as any).post = async (_url: string, body: any, config: any) => {
    if (!body.messages?.length) {
      posts.push({ at: Date.now(), signal: config?.signal });
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const step = steps[Math.min(n++, steps.length - 1)];
      try {
        if (typeof step === "object") { await sleep(step.fail); throw new Error("Request failed with status code 500"); }
        if (step === "fail") throw new Error("Request failed with status code 500");
        return { data: { done: true, done_reason: "load" } };
      } finally { inFlight--; }
    }
    return { data: {} };
  };
  (axios as any).get = async () => ({ data: { models: [] } });
  delete require.cache[providerPath];
  require("../cloud-api/local/ollama-llm");
}

beforeEach(() => {
  logs = []; errors = [];
  realLog = console.log; realError = console.error;
  console.log = (...a: any[]) => { logs.push(a.join(" ")); };
  console.error = (...a: any[]) => { errors.push(a.join(" ")); };
});
afterEach(() => { console.log = realLog; console.error = realError; (axios as any).post = originalPost; });

test("initial load fails, the retry succeeds, and nothing more is sent", async () => {
  install(["fail", "ok"]);
  await sleep(150);
  assert.equal(posts.length, 2);
  assert.equal(errors.filter(e => /warm-up attempt 1\/4 failed/.test(e)).length, 1);
  assert.equal(errors.filter(e => /gave up/.test(e)).length, 0);
  assert.equal(logs.filter(l => /keep-alive response/.test(l)).length, 1);
  assert.ok(posts[1].at - posts[0].at >= 15, "retry waited for the configured delay");
});

test("repeated failures stop at the configured limit and are logged clearly", async () => {
  install(["fail"], { attempts: 3 });
  await sleep(250);
  assert.equal(posts.length, 3);
  assert.equal(errors.filter(e => /warm-up attempt \d\/3 failed/.test(e)).length, 2);
  const final = errors.filter(e => /Error initializing Ollama model: .*gave up after 3 attempts/.test(e));
  assert.equal(final.length, 1, errors.join("\n"));
  await sleep(120);
  assert.equal(posts.length, 3, "no attempt after the limit");
});

test("a successful first load triggers no retry", async () => {
  install(["ok"]);
  await sleep(150);
  assert.equal(posts.length, 1);
  assert.equal(errors.length, 0);
  assert.equal(logs.filter(l => /keep-alive response/.test(l)).length, 1);
});

test("a single attempt configured means no retry, and the failure is still reported", async () => {
  install(["fail"], { attempts: 1 });
  await sleep(120);
  assert.equal(posts.length, 1);
  assert.equal(errors.filter(e => /gave up after 1 attempt;/.test(e)).length, 1);
});

test("attempts never overlap, even when failures are slow and the delay is short", async () => {
  install([{ fail: 40 }], { attempts: 4, delayMs: 5 });
  await sleep(400);
  assert.equal(posts.length, 4);
  assert.equal(maxInFlight, 1);
});

test("the retry timer does not keep the process alive", () => {
  const script = `
    const axios = require("axios");
    Object.assign(process.env, { LLM_SERVER: "ollama", OLLAMA_MODEL: "fixture", MEMORY_ENABLED: "false", WEB_SEARCH_ENABLED: "false",
      OLLAMA_WARMUP_RETRY_DELAY_MS: "60000" });
    let posts = 0;
    axios.post = async () => { posts++; throw new Error("Request failed with status code 500"); };
    axios.get = async () => ({ data: { models: [] } });
    require(${JSON.stringify(providerPath)});
    process.on("exit", () => console.error("posts=" + posts));
  `;
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--require", "ts-node/register/transpile-only",
    "--require", path.resolve(__dirname, "fixtures/isolate-tests.cjs"), "-e", script],
    { encoding: "utf8", timeout: 20_000, cwd: path.resolve(__dirname, "../..") });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 15_000, "process exited without waiting for the 60 s retry");
  assert.match(result.stderr, /posts=1/);
  assert.match(result.stderr, /warm-up attempt 1\/4 failed/);
});

// Last: this aborts the process-wide application signal.
test("shutdown cancels a pending retry", async () => {
  install([{ fail: 5 }, "ok"], { attempts: 4, delayMs: 200 });
  await sleep(60);
  assert.equal(posts.length, 1);
  assert.equal(errors.filter(e => /warm-up attempt 1\/4 failed/.test(e)).length, 1, "a retry is now pending");
  await require("../utils/app-lifecycle").stopApplication();
  await sleep(450);
  assert.equal(posts.length, 1, "the pending retry was cancelled");
  assert.equal(logs.filter(l => /keep-alive response/.test(l)).length, 0);
});
