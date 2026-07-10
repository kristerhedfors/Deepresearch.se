// Node tests for markdown.js's pure table repair (normalizeLlmMarkdown).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeLlmMarkdown } from "./markdown.js";

// The DOM rendering (marked + DOMPurify) is verified live; the pure table
// repair — the fix for GLM emitting a whole table on one line with rows
// joined by "||" and no blank line before it — is what decides whether the
// table renders, so it's covered here.
describe("normalizeLlmMarkdown", () => {
  test("splits a table collapsed onto one line and detaches it from preceding prose", () => {
    const collapsed =
      "Baserat på opinionsdata från juni 2026.| Parti | Opinion | Mandat || :--- | :--- | :--- || S | 32.4 % | 118 || L | 2.7 % | 0 |";
    const out = normalizeLlmMarkdown(collapsed);
    const lines = out.split("\n");
    // A blank line now precedes the header, and each row is on its own line.
    assert.ok(/^Baserat på opinionsdata från juni 2026\.$/.test(lines[0]));
    assert.equal(lines[1], "");
    assert.equal(lines[2], "| Parti | Opinion | Mandat |");
    assert.equal(lines[3], "| :--- | :--- | :--- |");
    assert.equal(lines[4], "| S | 32.4 % | 118 |");
    assert.equal(lines[5], "| L | 2.7 % | 0 |");
    // No "||" survives.
    assert.ok(!out.includes("||"));
  });

  test("inserts a blank line before a table that only lacks one (rows already on their own lines)", () => {
    const src = "Intro paragraph.\n| A | B |\n| :--- | :--- |\n| 1 | 2 |";
    const out = normalizeLlmMarkdown(src);
    assert.equal(out, "Intro paragraph.\n\n| A | B |\n| :--- | :--- |\n| 1 | 2 |");
  });

  test("leaves already well-formed tables untouched", () => {
    const good = "Intro.\n\n| A | B |\n| :--- | :--- |\n| 1 | 2 |\n\nAfter.";
    assert.equal(normalizeLlmMarkdown(good), good);
  });

  test("is a no-op on text with no table (even if it contains a stray pipe)", () => {
    const s = "Some **bold** text with a | pipe and a [1] citation.";
    assert.equal(normalizeLlmMarkdown(s), s);
  });

  test("handles non-string / empty input safely", () => {
    assert.equal(normalizeLlmMarkdown(""), "");
    assert.equal(normalizeLlmMarkdown(null), null);
    assert.equal(normalizeLlmMarkdown(undefined), undefined);
  });
});
