import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { LLMTool, Message } from "../type";

const successReply = "The image has been generated, please check on the screen.";
const failureReply = "Sorry, the image generation failed. Please try again later.";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let outcome: unknown;
let throws = false;
let calls: unknown[] = [];
let images: string[] = [];
let imageNumber = 0;
let imageDir: string;
let provider: typeof import("../cloud-api/local/image-generation-tool-llm").default;
let handlers: typeof import("../config/llm-tools").llmFuncMap;
let registeredHandler: (args: any) => Promise<string>;

// Only this test backend is admitted. Production image tools remain unmigrated
// and blocked; actual providers, models and image services are never started.
const tool: LLMTool = {
  execution: "bounded", type: "function", function: {
    name: "generateImage", description: "Isolated image fixture",
    parameters: { type: "object", properties: {
      prompt: { type: "string" }, withImageContext: { type: "boolean" },
    }, required: ["prompt"] },
  },
  func: async args => {
    calls.push(args);
    if (throws) throw new Error("Image fixture failed");
    if (outcome === "[success]Image file saved." || outcome === "[response]Image file saved.") {
      const file = path.join(imageDir, `direct-image-${imageNumber++}.png`);
      fs.writeFileSync(file, png);
      images.push(file);
    }
    return outcome as string;
  },
};

before(() => {
  imageDir = require("../utils/dir").imageDir;
  assert.match(imageDir, /\.test-artifacts/);
  Object.assign(process.env, { LLM_SERVER: "image-tool-direct", IMAGE_GENERATION_SERVER: "",
    WEB_SEARCH_ENABLED: "false", MEMORY_ENABLED: "false", MEMPALACE_ENABLED: "false" });
  require("../plugin").pluginRegistry.register({ name: "direct-image-fixture", displayName: "Fixture", version: "1",
    type: "llm-tools", activate: () => ({ getTools: () => [tool] }) });
  handlers = require("../config/llm-tools").llmFuncMap;
  registeredHandler = handlers.generateImage;
  provider = require("../cloud-api/local/image-generation-tool-llm").default;
});

beforeEach(t => {
  assert.ok("mock" in t);
  t.mock.method(Math, "random", () => 0);
  t.mock.method(console, "error", () => {});
  outcome = "[success]Image file saved.";
  throws = false; calls = []; images = [];
  tool.execution = "bounded";
  handlers.generateImage = registeredHandler;
  process.env.LLM_SERVER = "image-tool-direct";
});

afterEach(() => { tool.execution = "bounded"; handlers.generateImage = registeredHandler; });

async function ask(messages: Message[] = [{ role: "user", content: "Draw a cube based on this image." }]) {
  let text = "", ends = 0;
  const events: { name: string; result?: string }[] = [];
  await provider.chatWithLLMStream(messages, chunk => text += chunk, () => ends++, undefined,
    (name, result) => events.push({ name, result }));
  return { text, ends, events };
}

for (const tag of ["[success]", "[response]"]) {
  test(`direct image mode preserves confirmed ${tag} success through the real executor`, async () => {
    outcome = `${tag}Image file saved.`;
    const result = await ask();
    assert.equal(result.text, successReply);
    assert.equal(result.ends, 1);
    assert.deepEqual(calls, [{ prompt: "Draw a cube based on this image.", withImageContext: true }]);
    assert.equal(images.length, 1);
    assert.deepEqual(fs.readFileSync(images[0]), png);
    assert.deepEqual(result.events, [{ name: "generateImage", result: undefined }, { name: "generateImage", result: outcome }]);
  });
}

for (const tag of ["[error]", "[rejected]", "[unverified]"]) {
  test(`direct image mode never presents ${tag} as success`, async () => {
    outcome = `${tag}Generation was not confirmed.`;
    const result = await ask();
    assert.equal(result.text, failureReply);
    assert.equal(result.ends, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(images, []);
    assert.deepEqual(result.events, [{ name: "generateImage", result: undefined }, { name: "generateImage", result: outcome }]);
  });
}

const unexpected: [string, unknown][] = [
  ["untagged success-looking text", "Image file saved."], ["empty string", ""], ["whitespace", "   "],
  ["undefined", undefined], ["null", null], ["number", 42], ["boolean", false],
  ["object", { success: true }], ["array", ["success"]], ["unknown tag", "[successish]Image file saved."],
];
for (const [label, value] of unexpected) {
  test(`direct image mode fails closed for ${label}`, async () => {
    outcome = value;
    const result = await ask();
    assert.equal(result.text, failureReply);
    assert.equal(result.ends, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(images, []);
    assert.equal(result.events.length, 2);
    assert.match(result.events[1].result!, /^\[unverified\]/);
  });
}

test("direct image mode reports handler exceptions as failure and ends once", async () => {
  throws = true;
  const result = await ask();
  assert.equal(result.text, failureReply);
  assert.equal(result.ends, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(images, []);
  assert.match(result.events[1].result!, /^\[error\]/);
});

for (const [label, messages] of [
  ["blank prompt", [{ role: "user", content: "   " }]], ["no user prompt", []],
] as [string, Message[]][]) {
  test(`direct image mode cannot report success with ${label}`, async () => {
    const result = await ask(messages);
    assert.equal(result.text, failureReply);
    assert.equal(result.ends, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(images, []);
    assert.deepEqual(result.events, []);
  });
}

test("direct image mode cannot report success when the tool is absent", async () => {
  delete handlers.generateImage;
  const result = await ask();
  assert.equal(result.text, failureReply);
  assert.equal(result.ends, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(images, []);
  assert.deepEqual(result.events, [{ name: "generateImage", result: "[error]generateImage tool not found" }]);
});

test("direct image mode preserves lifecycle rejection without invoking the backend", async () => {
  delete tool.execution;
  const result = await ask();
  assert.equal(result.text, failureReply);
  assert.equal(result.ends, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(images, []);
  assert.match(result.events[1].result!, /^\[rejected\].*bounded cancellation contract/);
});

test("direct image mode preserves disabled-tool rejection without invoking the backend", async () => {
  process.env.LLM_SERVER = "ollama";
  process.env.OLLAMA_ENABLE_TOOLS = "false";
  const result = await ask();
  assert.equal(result.text, failureReply);
  assert.equal(result.ends, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(images, []);
  assert.equal(result.events[1].result, "[rejected]Tool execution is disabled.");
});
