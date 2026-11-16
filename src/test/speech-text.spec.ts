/** purifyTextForTTS: operators between operands are spoken; other symbols keep being dropped. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { purifyTextForTTS } from "../utils";

test("arithmetic expressions keep their operators in speech", () => {
  assert.equal(purifyTextForTTS("6 × 3 = 18"), "6 times 3 equals 18");
  assert.equal(purifyTextForTTS("17 * 6 = 102"), "17 times 6 equals 102");
  assert.equal(purifyTextForTTS("2+2=4"), "2 plus 2 equals 4");
  assert.equal(purifyTextForTTS("12 ÷ 4 = 3"), "12 divided by 4 equals 3");
  assert.equal(purifyTextForTTS("12 / 4 = 3"), "12 divided by 4 equals 3");
  assert.equal(purifyTextForTTS("9 − 4 = 5"), "9 minus 4 equals 5");
  assert.equal(purifyTextForTTS("9 - 4 = 5"), "9 minus 4 equals 5");
  assert.equal(purifyTextForTTS("x = 5"), "x equals 5");
});

test("ordinary text, links, markdown and other symbols behave as before", () => {
  assert.equal(purifyTextForTTS("Visit https://example.com/a?b=c+d now"), "Visit link now");
  assert.equal(purifyTextForTTS("The answer is **102**."), "The answer is 102.");
  assert.equal(purifyTextForTTS("Pages 5-7 and C++ are fine"), "Pages 5，7 and C are fine");
  assert.equal(purifyTextForTTS("Call +44 20 7946 0958"), "Call 44 20 7946 0958");
  assert.equal(purifyTextForTTS("and/or either/or"), "and or either or");
  assert.equal(purifyTextForTTS("He said 1/2 a cup"), "He said 1 2 a cup");
  assert.equal(purifyTextForTTS("# Title"), "Title");
  assert.equal(purifyTextForTTS("a_b ~ c"), "a b c");
});
