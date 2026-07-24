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

// The mermaid init config, regression-locked. The vendored mermaid (11.16)
// only honors the TOP-LEVEL htmlLabels key — with only the flowchart-scoped
// key set, flowchart node labels come out as <foreignObject> HTML, which the
// DOMPurify pass strips (its SVG profile excludes foreignObject), so every
// node box rendered EMPTY while edge labels survived (feedback #8/#9,
// 2026-07-24). Verified by rendering in Chromium against the vendored
// library; this locks the config shape so the fix can't silently regress.
import { MERMAID_INIT, repairMermaidLabels } from "./markdown.js";

describe("MERMAID_INIT", () => {
  test("keeps labels as SVG text: top-level htmlLabels false (the key 11.16 reads)", () => {
    assert.equal(MERMAID_INIT.htmlLabels, false);
  });

  test("keeps the flowchart-scoped key too (documented intent, older versions)", () => {
    assert.equal(MERMAID_INIT.flowchart?.htmlLabels, false);
  });

  test("keeps strict sanitization and no auto-start", () => {
    assert.equal(MERMAID_INIT.securityLevel, "strict");
    assert.equal(MERMAID_INIT.startOnLoad, false);
  });

  test("never renders the bomb error SVG into the page (feedback #12)", () => {
    // Without this, a parse failure APPENDS mermaid's error diagram to
    // document.body — visible junk behind the input pane.
    assert.equal(MERMAID_INIT.suppressErrorRendering, true);
  });
});

// repairMermaidLabels — the one-retry source repair for the model mistake
// that made feedback #12's diagram unparseable: parentheses in UNQUOTED
// flowchart node labels. Only ever applied to a source that already failed
// to render, so these assert the transform alone.
describe("repairMermaidLabels", () => {
  test("quotes an unquoted [label] containing parentheses (the feedback #12 shape)", () => {
    assert.equal(
      repairMermaidLabels("B[autogrow() — public/js/app.js:591-596]"),
      'B["autogrow() — public/js/app.js:591-596"]',
    );
    // Multiple nodes on one line, each repaired independently.
    assert.equal(
      repairMermaidLabels("A[calls f(x)] --> B[then g(y)]"),
      'A["calls f(x)"] --> B["then g(y)"]',
    );
  });

  test("leaves already-quoted, paren-free, and quote-containing labels alone", () => {
    for (const src of [
      'E["form submit handler — public/js/app.js:686"]', // already quoted
      "A[Keystroke in #input textarea]", // no parens — valid as-is
      'X[mix of "quote" and (paren)]', // contains a quote — unrepairable, untouched
      "P -->|direct reply| Q[stream answer]", // edge labels untouched
    ]) {
      assert.equal(repairMermaidLabels(src), src);
    }
  });

  test("repairs the full feedback #12 diagram without touching its quoted labels", () => {
    const src = [
      "flowchart TD",
      '    A[Keystroke in #input textarea] -->|"input" event| B[autogrow() — public/js/app.js:591-596]',
      '    C --> E["form submit handler — public/js/app.js:686"]',
      "    E --> F[read input.value, clear + autogrow — app.js:687-700]",
      "    F --> G[\"sendMessage(text, opts) — public/js/stream.js:1247\"]",
    ].join("\n");
    const out = repairMermaidLabels(src);
    assert.ok(out.includes('B["autogrow() — public/js/app.js:591-596"]'));
    assert.ok(out.includes('E["form submit handler — public/js/app.js:686"]')); // unchanged
    assert.ok(out.includes('G["sendMessage(text, opts) — public/js/stream.js:1247"]')); // unchanged
    assert.ok(out.includes("F[read input.value, clear + autogrow — app.js:687-700]")); // no parens — unchanged
  });

  test("junk input passes through", () => {
    assert.equal(repairMermaidLabels(/** @type {any} */ (null)), null);
  });
});
