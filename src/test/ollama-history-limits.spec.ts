import { test } from "node:test";
import assert from "node:assert/strict";
import { boundOllamaHistory } from "../cloud-api/local/ollama-history-limits";
import type { OllamaMessage } from "../type";

test("history message cap removes whole older turns and preserves call/result pairs", () => {
  const messages: OllamaMessage[] = [{ role: "system", content: "System" }];
  for (let i = 0; i < 50; i++) messages.push({ role: "user", content: `question ${i}` },
    { role: "assistant", content: "", tool_calls: [[{ function: { index: 0, name: "probe", arguments: {} } }]] },
    { role: "tool", tool_name: "probe", content: "[success]done" }, { role: "assistant", content: "Done" });
  assert.equal(boundOllamaHistory(messages), false);
  assert.equal(messages.length, 197);
  assert.equal(messages[1].content, "question 1");
  for (let i = 1; i < messages.length; i += 4) assert.deepEqual(messages.slice(i, i + 4).map(m => m.role), ["user", "assistant", "tool", "assistant"]);
});

test("history bytes are bounded independently of message count and Unicode length", () => {
  const messages: OllamaMessage[] = [{ role: "system", content: "System" },
    { role: "user", content: "old" }, { role: "assistant", content: "æ".repeat(2 * 1024 * 1024) },
    { role: "user", content: "new" }, { role: "assistant", content: "New answer" }];
  assert.equal(boundOllamaHistory(messages), false);
  assert.deepEqual(messages, [{ role: "system", content: "System" }, { role: "user", content: "new" }, { role: "assistant", content: "New answer" }]);
});

test("a single oversized turn is omitted explicitly without orphaned tool metadata", () => {
  const messages: OllamaMessage[] = [{ role: "system", content: "System" }, { role: "user", content: "current" },
    { role: "tool", content: "x".repeat(4 * 1024 * 1024), tool_name: "probe" }];
  assert.equal(boundOllamaHistory(messages), true);
  assert.equal(messages.length, 2);
  assert.match(messages[1].content, /Oversized.*Completion.*not verified/);
  assert.equal(boundOllamaHistory(messages), false, "idempotent cleanup");
});
