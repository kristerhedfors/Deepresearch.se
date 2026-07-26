import test from "node:test";
import assert from "node:assert/strict";

import { truncateChars } from "./embed-truncate.mjs";

test("truncateChars leaves short-enough text untouched", () => {
  assert.equal(truncateChars("hello", 10), "hello");
  assert.equal(truncateChars("hello", 5), "hello");
});

test("truncateChars cuts to the budget on plain text", () => {
  assert.equal(truncateChars("abcdefgh", 3), "abc");
});

test("truncateChars never leaves a lone high surrogate (the Berget 400)", () => {
  // "👍" is two UTF-16 units, so a budget landing between them orphans the
  // high half — the exact input that makes Berget's tokenizer reject the batch
  // with "TextEncodeInput must be Union[…]" instead of a length error.
  const s = "ab👍cd";
  const cut = truncateChars(s, 3);
  assert.equal(cut, "ab");
  for (const t of [s, cut, truncateChars(s, 4), truncateChars(s, 5)]) {
    const last = t.charCodeAt(t.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `lone high surrogate in ${JSON.stringify(t)}`);
  }
  // A budget that clears the whole pair keeps it whole.
  assert.equal(truncateChars(s, 4), "ab👍");
});

test("truncateChars keeps every emoji-containing prefix well-formed", () => {
  const s = "👍👎 ok 🎯 done";
  for (let n = 0; n <= s.length + 2; n++) {
    const t = truncateChars(s, n);
    assert.equal(t, [...t].join(""), `unpaired surrogate at budget ${n}`);
    assert.ok(t.length <= Math.max(n, 0));
  }
});

test("truncateChars handles nullish and non-positive budgets", () => {
  assert.equal(truncateChars(undefined, 10), "");
  assert.equal(truncateChars(null, 10), "");
  assert.equal(truncateChars("abc", 0), "");
  assert.equal(truncateChars("abc", -1), "");
});
