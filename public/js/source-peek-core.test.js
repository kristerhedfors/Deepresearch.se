// Node tests for the source-peek pure core (source-peek-core.js): reference
// parsing, snapshot path resolution, language classification, and the
// dependency-free tokenizer the popover renders from.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REF_CHARS,
  highlightLines,
  isMarkdownPath,
  languageForPath,
  parseSourceRef,
  resolveSourcePath,
  tokenLines,
  tokenizeSource,
} from "./source-peek-core.js";

// ---- parseSourceRef ----------------------------------------------------------

test("parseSourceRef accepts plain repo paths", () => {
  assert.deepEqual(parseSourceRef("src/pipeline.js"), {
    path: "src/pipeline.js",
    start: null,
    end: null,
  });
  assert.deepEqual(parseSourceRef("public/js/agent-spec-core.js"), {
    path: "public/js/agent-spec-core.js",
    start: null,
    end: null,
  });
  assert.equal(parseSourceRef("CLAUDE.md").path, "CLAUDE.md");
  assert.equal(parseSourceRef("wrangler.toml").path, "wrangler.toml");
  assert.equal(parseSourceRef(".claude/skills/deploy/SKILL.md").path, ".claude/skills/deploy/SKILL.md");
  assert.equal(parseSourceRef("sdk/AGENTS.json").path, "sdk/AGENTS.json");
});

test("parseSourceRef accepts bare basenames with a known extension", () => {
  assert.equal(parseSourceRef("agent-spec-core.js").path, "agent-spec-core.js");
  assert.equal(parseSourceRef("drc.js").path, "drc.js");
});

test("parseSourceRef parses line and range suffixes (hyphen and dashes)", () => {
  assert.deepEqual(parseSourceRef("src/chat.js:120"), { path: "src/chat.js", start: 120, end: 120 });
  assert.deepEqual(parseSourceRef("agent-spec-core.js:34-45"), {
    path: "agent-spec-core.js",
    start: 34,
    end: 45,
  });
  assert.deepEqual(parseSourceRef("src/chat.js:10–16"), { path: "src/chat.js", start: 10, end: 16 });
  // An inverted range clamps to the start line rather than rejecting.
  assert.deepEqual(parseSourceRef("src/chat.js:30-20"), { path: "src/chat.js", start: 30, end: 30 });
});

test("parseSourceRef tolerates leading ./ and / forms", () => {
  assert.equal(parseSourceRef("./src/quota.js").path, "src/quota.js");
  assert.equal(parseSourceRef("/js/markdown.js").path, "js/markdown.js");
});

test("parseSourceRef rejects non-file inline code", () => {
  for (const s of [
    "", "npm test", "developer_mode", "runPipeline", "example.com", "deepresearch.se",
    "v1.5", "2.5", "https://x.se/a.js", "a b.js", "../etc/passwd.txt", "src//x.js",
    "{p,ci}", "incognito: true", "a".repeat(MAX_REF_CHARS) + ".js", "foo.unknownext",
  ]) {
    assert.equal(parseSourceRef(s), null, `should reject: ${s}`);
  }
});

// ---- resolveSourcePath -------------------------------------------------------

const PATHS = [
  "CLAUDE.md",
  "src/pipeline.js",
  "src/chat.js",
  "public/js/agent-spec-core.js",
  "public/js/markdown.js",
  "public/cure/drc.js",
  "sdk/pair-cli.mjs",
  "docs/AGENT-PLATFORM.md",
  "public/js/settings.js",
  "src/settings.js",
];

test("resolveSourcePath: exact match wins alone", () => {
  assert.deepEqual(resolveSourcePath(PATHS, "src/pipeline.js"), ["src/pipeline.js"]);
  assert.deepEqual(resolveSourcePath(PATHS, "CLAUDE.md"), ["CLAUDE.md"]);
});

test("resolveSourcePath: case-insensitive exact", () => {
  assert.deepEqual(resolveSourcePath(PATHS, "claude.md"), ["CLAUDE.md"]);
});

test("resolveSourcePath: unique basename resolves", () => {
  assert.deepEqual(resolveSourcePath(PATHS, "agent-spec-core.js"), ["public/js/agent-spec-core.js"]);
  assert.deepEqual(resolveSourcePath(PATHS, "drc.js"), ["public/cure/drc.js"]);
});

test("resolveSourcePath: suffix qualification narrows an ambiguous basename", () => {
  assert.deepEqual(resolveSourcePath(PATHS, "js/settings.js"), ["public/js/settings.js"]);
  // A bare ambiguous basename returns every candidate for the picker.
  assert.deepEqual(resolveSourcePath(PATHS, "settings.js").sort(), [
    "public/js/settings.js",
    "src/settings.js",
  ]);
});

test("resolveSourcePath: a misplaced directory still finds the file by basename", () => {
  assert.deepEqual(resolveSourcePath(PATHS, "src/agent-spec-core.js"), [
    "public/js/agent-spec-core.js",
  ]);
});

test("resolveSourcePath: unknown file returns []", () => {
  assert.deepEqual(resolveSourcePath(PATHS, "src/nope.js"), []);
  assert.deepEqual(resolveSourcePath([], "src/pipeline.js"), []);
});

// ---- languageForPath ---------------------------------------------------------

test("languageForPath classifies the repo's file kinds", () => {
  assert.equal(languageForPath("src/pipeline.js"), "js");
  assert.equal(languageForPath("sdk/pair-cli.mjs"), "js");
  assert.equal(languageForPath("sdk/MANIFEST.json"), "json");
  assert.equal(languageForPath("CLAUDE.md"), "md");
  assert.equal(languageForPath("public/app.css"), "css");
  assert.equal(languageForPath("public/index.html"), "html");
  assert.equal(languageForPath("wrangler.toml"), "hash");
  assert.equal(languageForPath("scripts/x.sh"), "hash");
  assert.equal(languageForPath("LICENSE.txt"), "text");
  assert.ok(isMarkdownPath("docs/TESTING.md"));
  assert.ok(!isMarkdownPath("src/chat.js"));
});

// ---- tokenizer ---------------------------------------------------------------

/** Reassemble a token stream — every tokenizer test asserts losslessness. */
const joined = (tokens) => tokens.map((t) => t.t).join("");

test("tokenizeSource(js) classifies comments, strings, keywords, numbers", () => {
  const src = `// hi\nconst n = 42;\nlet s = "a\\"b";\n/* block\nstill */ return \`t\${n}\`;`;
  const toks = tokenizeSource(src, "js");
  assert.equal(joined(toks), src);
  const by = (c) => toks.filter((t) => t.c === c).map((t) => t.t);
  assert.ok(by("c").includes("// hi"));
  assert.ok(by("c").some((t) => t.startsWith("/* block")));
  assert.ok(by("s").includes('"a\\"b"'));
  assert.ok(by("k").includes("const") && by("k").includes("return") && by("k").includes("let"));
  assert.ok(by("n").includes("42"));
  // Identifiers stay plain.
  assert.ok(toks.some((t) => t.t === "n" && t.c === ""));
});

test("tokenizeSource(js) survives unterminated strings and comments", () => {
  for (const src of ['const a = "unclosed', "/* never closed", "`half template"]) {
    assert.equal(joined(tokenizeSource(src, "js")), src);
  }
});

test("tokenizeSource(json/css/html/hash) basics", () => {
  const j = tokenizeSource('{"a": 1, "b": true}', "json");
  assert.equal(joined(j), '{"a": 1, "b": true}');
  assert.ok(j.some((t) => t.t === '"a"' && t.c === "s"));
  assert.ok(j.some((t) => t.t === "true" && t.c === "k"));

  const c = tokenizeSource("/* x */ .a { width: 10px; color: #fff; }", "css");
  assert.ok(c.some((t) => t.c === "c") && c.some((t) => t.t === "#fff" && t.c === "n"));

  const h = tokenizeSource('<!-- c --><div class="x">t</div>', "html");
  assert.ok(h.some((t) => t.c === "c"));
  assert.ok(h.some((t) => t.t.startsWith("<div") && t.c === "k"));
  assert.ok(h.some((t) => t.t === "t" && t.c === ""));

  const t = tokenizeSource('name = "x" # tail\n# full line', "hash");
  assert.ok(t.some((tk) => tk.t === '"x"' && tk.c === "s"));
  assert.ok(t.some((tk) => tk.t === "# tail" && tk.c === "c"));
  assert.ok(t.some((tk) => tk.t === "# full line" && tk.c === "c"));
});

test("tokenizeSource(md) marks headings and fences, keeps text plain", () => {
  const src = "# Title\nplain prose\n```js\ncode\n```";
  const toks = tokenizeSource(src, "md");
  assert.equal(joined(toks), src);
  assert.ok(toks.some((t) => t.t === "# Title" && t.c === "k"));
  assert.ok(toks.some((t) => t.t === "```js" && t.c === "c"));
  assert.ok(toks.some((t) => t.t === "plain prose" && t.c === ""));
});

test("tokenizeSource on unknown language returns one plain token", () => {
  assert.deepEqual(tokenizeSource("anything", "text"), [{ t: "anything", c: "" }]);
  assert.deepEqual(tokenizeSource("", "js"), []);
});

// ---- tokenLines / highlightLines --------------------------------------------

test("tokenLines splits multi-line tokens and preserves classes", () => {
  const lines = tokenLines([{ t: "/* a\nb */", c: "c" }, { t: " x", c: "" }]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], [{ t: "/* a", c: "c" }]);
  assert.deepEqual(lines[1], [{ t: "b */", c: "c" }, { t: " x", c: "" }]);
});

test("highlightLines line count matches the source line count", () => {
  const src = "const a = 1;\n\n// end\n";
  const lines = highlightLines(src, "js");
  assert.equal(lines.length, src.split("\n").length);
  assert.deepEqual(lines[1], []); // the blank line
});
