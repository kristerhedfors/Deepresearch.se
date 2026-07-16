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

// The same-origin documentation-image allowlist (HELP mode): the ONLY <img>
// sources an answer may render inline. Everything else — external hosts,
// protocol-relative, traversal — stays forbidden (the tracking-pixel class).
import { isSafeDocImage } from "./markdown.js";

describe("isSafeDocImage", () => {
  test("allows only the fixed same-origin doc-image prefixes", () => {
    assert.equal(isSafeDocImage("/introspect/docs-img/docs/img/encryption/rver-app.png"), true);
    assert.equal(isSafeDocImage("/help/img/header.png"), true);
  });
  test("rejects everything else", () => {
    for (const src of [
      "https://evil.example/x.png",
      "//evil.example/x.png",
      "/introspect/docs-img/../../../api/logout",
      "/introspect/docs-img//evil",
      "/icons/icon-192.png",
      "data:image/png;base64,AAAA",
      "",
      null,
      undefined,
    ]) {
      assert.equal(isSafeDocImage(/** @type {any} */ (src)), false, String(src));
    }
  });
});
