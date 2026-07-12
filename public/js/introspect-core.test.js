// Node tests for the introspection shared pure core (introspect-core.js):
// the deterministic intent gate (with the Swedish-parity suite invariant 6
// requires), snapshot validation, path-mention extraction, and the
// context-block builder's structure + caps.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupIntrospectionModels,
  parseIntrospectionChoice,
  MAX_INLINE_FILE_CHARS,
  MAX_INLINE_FILES,
  MAX_INLINE_TOTAL_CHARS,
  ORIENTATION_CHARS,
  buildIntrospectionBlock,
  introspectionActive,
  introspectionIntent,
  mentionedSnapshotPaths,
  snapshotIndex,
  validateSnapshot,
} from "./introspect-core.js";

/** A small snapshot fixture in the bundler's exact shape. */
const snap = () =>
  /** @type {any} */ (
    validateSnapshot({
      v: 1,
      digest: "abc123def4567890",
      count: 4,
      bytes: 0,
      files: [
        { p: "CLAUDE.md", s: 40, t: "# CLAUDE.md\n\nProject orientation text." },
        { p: "src/pipeline.js", s: 30, t: "// the pipeline phase flow\nexport const x = 1;\n" },
        { p: "public/js/stream.js", s: 20, t: "// client send loop\n" },
        { p: "wrangler.toml", s: 10, t: "name = \"deepresearch-se\"\n" },
      ],
    })
  );

// ---- the intent gate --------------------------------------------------------

test("introspectionIntent: English request forms", () => {
  for (const s of [
    "Show me your source code",
    "Let's look at this site's codebase",
    "explain deepresearch.se's architecture",
    "How are you implemented?",
    "how were you built, exactly?",
    "what's the code behind this site?",
    "enter introspection mode please",
    "introspect your pipeline",
  ]) {
    assert.equal(introspectionIntent(s), true, s);
  }
});

test("introspectionIntent: Swedish parity — same breadth as English", () => {
  for (const s of [
    "Visa mig din källkod",
    "visa källkoden bakom sajten", // definite form + bakom
    "berätta om sajtens kodbas",
    "förklara webbplatsens arkitektur",
    "Hur är du implementerad?",
    "hur är du byggd egentligen?",
    "gå in i introspektionsläget",
    "introspektera din pipeline",
    "beskriv din egen implementation",
  ]) {
    assert.equal(introspectionIntent(s), true, s);
  }
});

test("introspectionIntent: ordinary questions never trigger", () => {
  for (const s of [
    "find the Linux kernel source code",
    "what is your source for that claim?",
    "how are you today?",
    "hur är läget?",
    "var hittar jag källkod till Linux?",
    "explain the architecture of Rome's aqueducts",
    "förklara arkitekturen i romerska akvedukter",
    "",
  ]) {
    assert.equal(introspectionIntent(s), false, s);
  }
});

// ---- mode stickiness ---------------------------------------------------------

test("introspectionActive: an earlier message keeps the mode on for follow-ups", () => {
  assert.equal(introspectionActive(["show me your source code", "what does that function do?"]), true);
  assert.equal(introspectionActive(["what does that function do?"]), false);
});

test("introspectionActive: a directory-qualified snapshot path engages the mode", () => {
  assert.equal(introspectionActive(["read src/pipeline.js for me"], snap()), true);
  // a bare basename is too generic to ACTIVATE (it only guides inlining)
  assert.equal(introspectionActive(["my app has a pipeline.js too"], snap()), false);
  // without a snapshot the path trigger is off
  assert.equal(introspectionActive(["read src/pipeline.js for me"]), false);
});

// ---- snapshot validation --------------------------------------------------------

test("validateSnapshot: accepts the bundler shape, recomputes count/bytes", () => {
  const s = snap();
  assert.ok(s);
  assert.equal(s.count, 4);
  assert.equal(s.bytes, 100);
  assert.equal(s.digest, "abc123def4567890");
});

test("validateSnapshot: rejects junk", () => {
  assert.equal(validateSnapshot(null), null);
  assert.equal(validateSnapshot({}), null);
  assert.equal(validateSnapshot({ v: 2, files: [{ p: "a", s: 1, t: "x" }] }), null);
  assert.equal(validateSnapshot({ v: 1, files: [] }), null);
  assert.equal(validateSnapshot({ v: 1, files: [{ p: "", s: 1, t: "x" }] }), null);
});

// ---- path mentions ---------------------------------------------------------------

test("mentionedSnapshotPaths: exact paths, root files, and basenames", () => {
  const s = snap();
  assert.deepEqual(mentionedSnapshotPaths("look at src/pipeline.js", s), ["src/pipeline.js"]);
  // root-level files match by name even in exactOnly mode
  assert.deepEqual(mentionedSnapshotPaths("what does wrangler.toml set?", s, { exactOnly: true }), ["wrangler.toml"]);
  assert.deepEqual(mentionedSnapshotPaths("CLAUDE.md says what?", s), ["CLAUDE.md"]);
  // basenames resolve for inlining…
  assert.deepEqual(mentionedSnapshotPaths("open stream.js", s), ["public/js/stream.js"]);
  // …but not in exactOnly (activation) mode
  assert.deepEqual(mentionedSnapshotPaths("open stream.js", s, { exactOnly: true }), []);
  assert.deepEqual(mentionedSnapshotPaths("no paths here", s), []);
});

// ---- the block --------------------------------------------------------------------

test("buildIntrospectionBlock: markers, index, orientation, capability line", () => {
  const block = buildIntrospectionBlock(snap(), { latestText: "how are you built?" });
  assert.ok(block.startsWith("\n\n--- Introspection: deepresearch.se source snapshot"));
  assert.ok(block.trimEnd().endsWith("--- End of introspection snapshot ---"));
  assert.match(block, /You DO have access to this site's own implementation/);
  assert.match(block, /src\/pipeline\.js\t30/); // the index row
  assert.match(block, /# CLAUDE\.md — architecture orientation/);
  assert.match(block, /Project orientation text/);
  assert.match(block, /digest abc123def456/);
  // no sandbox → the enable-the-sandbox pointer, not the /src pointer
  assert.match(block, /enable the execution sandbox/);
});

test("buildIntrospectionBlock: sandboxMounted flips the pointer to /src", () => {
  const block = buildIntrospectionBlock(snap(), { sandboxMounted: true });
  assert.match(block, /mounted at \/src inside the Linux sandbox/);
  assert.doesNotMatch(block, /enable the execution sandbox/);
});

test("buildIntrospectionBlock: inlines named files in full", () => {
  const block = buildIntrospectionBlock(snap(), { latestText: "explain src/pipeline.js" });
  assert.match(block, /# src\/pipeline\.js \(30 bytes\)/);
  assert.match(block, /the pipeline phase flow/);
});

test("buildIntrospectionBlock: per-file and total inline caps truncate honestly", () => {
  const big = "x".repeat(MAX_INLINE_FILE_CHARS + 500);
  const s = /** @type {any} */ (
    validateSnapshot({
      v: 1,
      digest: "",
      files: [
        { p: "src/a.js", s: big.length, t: big },
        { p: "src/b.js", s: big.length, t: big },
        { p: "src/c.js", s: big.length, t: big },
      ],
    })
  );
  const block = buildIntrospectionBlock(s, { latestText: "read src/a.js src/b.js src/c.js" });
  assert.match(block, /# src\/a\.js \(\d+ bytes, truncated\)/);
  assert.match(block, /truncated — full file in the snapshot\/sandbox/);
  // total budget: a + b hit MAX_INLINE_TOTAL_CHARS, c is named-but-not-inlined
  assert.ok(block.length < MAX_INLINE_TOTAL_CHARS + s.files.length * 200 + 20_000);
  assert.match(block, /# src\/c\.js — not inlined \(block budget reached/);
  assert.ok(MAX_INLINE_FILES >= 3);
});

test("snapshotIndex: one row per file", () => {
  assert.equal(snapshotIndex(snap()).split("\n").length, 4);
});

// ---- the model picker grouping ---------------------------------------------------

test("groupIntrospectionModels: private first + recommended, remote labeled as remote", () => {
  const { groups, recommended } = groupIntrospectionModels(
    [
      { id: "openai", label: "OpenAI", models: ["gpt-5.6-sol", "gpt-5.4-mini"] },
      { id: "groq", label: "Groq", models: ["llama-4"] },
    ],
    [
      { id: "mistral-small", name: "Mistral Small", up: true },
      { id: "downmodel", name: "Down Model", up: false },
    ],
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, "private");
  assert.equal(groups[0].options.length, 3);
  assert.match(groups[0].options[0].label, /your key \(private\)/);
  assert.equal(groups[1].kind, "remote");
  assert.match(groups[1].options[0].label, /remote \(this site's server\)/);
  assert.equal(groups[1].options[1].disabled, true); // down models stay visible but disabled
  assert.equal(recommended, "p:openai:gpt-5.6-sol"); // the privacy-obvious choice
});

test("groupIntrospectionModels: no keys → remote only, nothing recommended", () => {
  const { groups, recommended } = groupIntrospectionModels([], [{ id: "m1" }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "remote");
  assert.equal(recommended, "");
});

test("groupIntrospectionModels: DRC shape — private only (no server catalog)", () => {
  const { groups } = groupIntrospectionModels([{ id: "berget", label: "Berget", models: ["m"] }], []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, "private");
});

test("parseIntrospectionChoice round-trips both kinds and rejects junk", () => {
  assert.deepEqual(parseIntrospectionChoice("p:openai:gpt-5.6-sol"), {
    kind: "private",
    providerId: "openai",
    model: "gpt-5.6-sol",
  });
  // model ids may contain colons — split at the FIRST one only
  assert.deepEqual(parseIntrospectionChoice("p:x:a:b"), { kind: "private", providerId: "x", model: "a:b" });
  assert.deepEqual(parseIntrospectionChoice("s:mistral-small"), { kind: "server", model: "mistral-small" });
  assert.equal(parseIntrospectionChoice("p:broken"), null);
  assert.equal(parseIntrospectionChoice("s:"), null);
  assert.equal(parseIntrospectionChoice(""), null);
  assert.equal(parseIntrospectionChoice(null), null);
});
