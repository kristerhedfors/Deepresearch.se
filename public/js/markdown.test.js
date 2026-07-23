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

// The pure segment parser behind clickable inline [n] citations. The DOM
// wiring (linkifyCitations) is verified live; this decides which text runs
// become footer anchors, so it's covered here.
import { citationSegments } from "./markdown.js";

describe("citationSegments", () => {
  test("marks a known [n] citation and keeps the surrounding text", () => {
    const segs = citationSegments("The sky is blue [1] per NASA.", new Set([1]));
    assert.deepEqual(segs, [
      { text: "The sky is blue ", ref: null },
      { text: "[1]", ref: 1 },
      { text: " per NASA.", ref: null },
    ]);
  });

  test("linkifies several citations, including consecutive [1][2]", () => {
    const segs = citationSegments("Both agree [1][2] on this [10].", new Set([1, 2, 10]));
    assert.deepEqual(
      segs.filter((s) => s.ref != null).map((s) => s.ref),
      [1, 2, 10],
    );
    // Text between them is preserved.
    assert.equal(segs.map((s) => s.text).join(""), "Both agree [1][2] on this [10].");
  });

  test("leaves a bracketed number with no matching source as plain text", () => {
    const segs = citationSegments("An array index a[3] and cite [1].", new Set([1]));
    // [3] is NOT a source → stays text; only [1] becomes a ref.
    assert.deepEqual(
      segs.filter((s) => s.ref != null).map((s) => s.text),
      ["[1]"],
    );
    assert.equal(segs.map((s) => s.text).join(""), "An array index a[3] and cite [1].");
  });

  test("returns a single plain segment when there are no valid sources", () => {
    assert.deepEqual(citationSegments("Plain [1] text.", new Set()), [
      { text: "Plain [1] text.", ref: null },
    ]);
  });

  test("handles empty / non-string input safely", () => {
    assert.deepEqual(citationSegments("", new Set([1])), []);
    assert.deepEqual(citationSegments(/** @type {any} */ (null), new Set([1])), []);
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

// The pure fence scanner behind mermaid diagram rendering. The DOM/library
// wiring (renderMermaidBlocks) is verified live; this decides WHICH code
// blocks are drawn — above all that a half-streamed (unterminated) fence is
// never rendered — so it's covered here.
import { completeMermaidSources } from "./markdown.js";

describe("completeMermaidSources", () => {
  test("extracts a complete mermaid block", () => {
    const md = "Intro.\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nAfter.";
    assert.deepEqual(completeMermaidSources(md), ["graph TD\n  A-->B"]);
  });

  test("extracts multiple blocks in order", () => {
    const md = "```mermaid\ngraph TD\nA-->B\n```\ntext\n```mermaid\nsequenceDiagram\nA->>B: hi\n```";
    assert.deepEqual(completeMermaidSources(md), [
      "graph TD\nA-->B",
      "sequenceDiagram\nA->>B: hi",
    ]);
  });

  test("ignores an unterminated fence (mid-stream)", () => {
    const md = "Answer so far…\n\n```mermaid\ngraph TD\n  A-->B";
    assert.deepEqual(completeMermaidSources(md), []);
  });

  test("only the closed block renders while a later one is still streaming", () => {
    const md = "```mermaid\ngraph TD\nA-->B\n```\n\n```mermaid\ngraph LR\nC-->";
    assert.deepEqual(completeMermaidSources(md), ["graph TD\nA-->B"]);
  });

  test("ignores non-mermaid fences and empty blocks", () => {
    assert.deepEqual(completeMermaidSources("```js\nlet x = 1;\n```"), []);
    assert.deepEqual(completeMermaidSources("```mermaid\n\n```"), []);
  });

  test("handles non-string / empty input safely", () => {
    assert.deepEqual(completeMermaidSources(""), []);
    assert.deepEqual(completeMermaidSources(/** @type {any} */ (null)), []);
    assert.deepEqual(completeMermaidSources(/** @type {any} */ (undefined)), []);
  });
});
