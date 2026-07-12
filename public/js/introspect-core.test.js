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
  externalSourceIntent,
  introspectionActive,
  introspectionIntent,
  mentionedSnapshotPaths,
  snapshotIndex,
  validateSnapshot,
  chunkSourceText,
  snapshotChunks,
  quantizeInt8,
  int8ToB64,
  b64ToInt8,
  cosineF32Int8,
  retrieveSourceChunks,
  validateRagIndex,
  SOURCE_CHUNK_TARGET,
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

// ---- external-source intent (the introspection search re-enabler) -----------

test("externalSourceIntent: English request forms", () => {
  for (const s of [
    "search the web for the latest on this",
    "look it up online",
    "do a web search please",
    "google it and tell me",
    "find sources on the web",
    "can you cite sources for that?",
    "include external references",
    "what are the latest developments here",
    "give me up-to-date info",
    "what's new in this space",
    "compare it with LangChain's approach",
    "compare our security posture with local projects", // object between verb and preposition
    "deepresearch versus other tools",
  ]) {
    assert.equal(externalSourceIntent(s), true, s);
  }
});

test("externalSourceIntent: Swedish parity — same breadth as English", () => {
  for (const s of [
    "sök på nätet efter det här",
    "gör en webbsökning",
    "googla det åt mig",
    "hitta källor på webben",
    "ange några källor",
    "inkludera externa referenser",
    "vad är den senaste utvecklingen",
    "vilka är de aktuella nyheterna",
    "jämför det med LangChain",
    "jämför er säkerhet med lokala projekt", // object between verb and preposition
    "sök på internet",
  ]) {
    assert.equal(externalSourceIntent(s), true, s);
  }
});

test("externalSourceIntent: pure introspection asks never trigger it (search stays off)", () => {
  for (const s of [
    "gimme source code examples",
    "tell me about the security implementation",
    "how does the current pipeline work?", // "current" alone is not external
    "show me the latest version of pipeline.js", // "latest version" of OWN file — still introspection
    "explain how you handle quotas",
    "visa mig källkodsexempel",
    "berätta om säkerhetsimplementationen",
    "hur fungerar den nuvarande pipelinen?",
    "",
  ]) {
    assert.equal(externalSourceIntent(s), false, s);
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
  assert.ok(block.startsWith("\n\n--- Introspection: deepresearch.se source"));
  assert.ok(block.trimEnd().endsWith("--- End of introspection source ---"));
  assert.match(block, /You DO have this site's own source here/);
  assert.match(block, /Never say you have no access to the source or that this isn't a coding tool/);
  assert.match(block, /src\/pipeline\.js\t30/); // the index row
  assert.match(block, /# CLAUDE\.md — architecture orientation/);
  assert.match(block, /Project orientation text/);
  assert.match(block, /digest abc123def456/);
});

test("buildIntrospectionBlock: sandboxMounted adds the /src pointer", () => {
  const withSb = buildIntrospectionBlock(snap(), { sandboxMounted: true });
  assert.match(withSb, /mounted at \/src inside the Linux sandbox/);
  const noSb = buildIntrospectionBlock(snap(), {});
  assert.doesNotMatch(noSb, /mounted at \/src inside the Linux sandbox/);
});

test("buildIntrospectionBlock: RAG-retrieved chunks are shown as relevant excerpts", () => {
  const block = buildIntrospectionBlock(snap(), {
    latestText: "code examples from site",
    retrieved: [
      { p: "src/pipeline.js", text: "export function runPipeline() {}", score: 0.84 },
      { p: "src/chat.js", text: "export function handleChat() {}", score: 0.8 },
    ],
  });
  assert.match(block, /Source excerpts most relevant to this question/);
  assert.match(block, /## src\/pipeline\.js/);
  assert.match(block, /export function runPipeline/);
  assert.match(block, /export function handleChat/);
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
  assert.match(groups[0].options[0].label, /🇺🇸/); // OpenAI → US flag
  assert.equal(groups[1].kind, "remote");
  assert.match(groups[1].options[0].label, /remote \(this site's server\)/);
  assert.match(groups[1].options[0].label, /🇸🇪/); // Berget catalog entry (no provider field) → SE flag
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

// ---- source RAG core --------------------------------------------------------------

test("chunkSourceText: bounded chunks with overlap, deterministic", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} of source code here`).join("\n");
  const a = chunkSourceText(text);
  const b = chunkSourceText(text);
  assert.deepEqual(a, b); // deterministic
  assert.ok(a.length > 1);
  for (const c of a) assert.ok(c.length <= SOURCE_CHUNK_TARGET + 5);
  assert.deepEqual(chunkSourceText(""), []);
  assert.deepEqual(chunkSourceText(null), []);
});

test("snapshotChunks: one entry per (file, chunk) in file order", () => {
  const s = /** @type {any} */ (
    validateSnapshot({ v: 1, digest: "", files: [
      { p: "a.js", s: 5, t: "short" },
      { p: "b.js", s: 5, t: "also short" },
    ] })
  );
  const chunks = snapshotChunks(s);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].p, "a.js");
  assert.equal(chunks[0].ci, 0);
  assert.equal(chunks[0].text, "short");
});

test("int8 codec: quantize round-trips through b64 and cosine tracks the float cosine", () => {
  // two similar vectors and one different; check int8 cosine preserves ranking
  const mk = (f) => Float32Array.from({ length: 64 }, (_, i) => f(i));
  const q = mk((i) => Math.sin(i * 0.3));
  const near = mk((i) => Math.sin(i * 0.3) + 0.01 * Math.cos(i));
  const far = mk((i) => Math.cos(i * 1.7));
  const qi = quantizeInt8(q), ni = quantizeInt8(near), fi = quantizeInt8(far);
  // b64 round-trip is exact
  assert.deepEqual(Array.from(b64ToInt8(int8ToB64(qi))), Array.from(qi));
  // int8 cosine ranks 'near' above 'far', same as float would
  const sNear = cosineF32Int8(q, ni);
  const sFar = cosineF32Int8(q, fi);
  assert.ok(sNear > sFar, `near ${sNear} should beat far ${sFar}`);
  // self-similarity is ~1
  assert.ok(cosineF32Int8(q, qi) > 0.999);
});

test("validateRagIndex: accepts the built shape, rejects junk", () => {
  const good = { v: 1, model: "e5", dims: 4, target: 1400, overlap: 200,
    vectors: [int8ToB64(quantizeInt8(Float32Array.of(1, 2, 3, 4)))], map: [{ p: "a.js", ci: 0 }] };
  assert.ok(validateRagIndex(good));
  assert.equal(validateRagIndex(null), null);
  assert.equal(validateRagIndex({ v: 2, vectors: [], map: [] }), null);
  assert.equal(validateRagIndex({ v: 1, vectors: ["x"], map: [] }), null); // length mismatch
  assert.equal(validateRagIndex({ v: 1, vectors: ["x"], map: [{ p: "a", ci: "0" }] }), null);
});

test("retrieveSourceChunks: returns the highest-cosine chunks with current text", () => {
  const s = /** @type {any} */ (
    validateSnapshot({ v: 1, digest: "", files: [
      { p: "pipe.js", s: 5, t: "alpha" },
      { p: "chat.js", s: 5, t: "bravo" },
    ] })
  );
  const chunks = snapshotChunks(s); // [{pipe,0,alpha},{chat,0,bravo}]
  // Build an index whose vectors make the query prefer chat.js.
  const vPipe = quantizeInt8(Float32Array.of(1, 0, 0));
  const vChat = quantizeInt8(Float32Array.of(0, 1, 0));
  const index = /** @type {any} */ (validateRagIndex({
    v: 1, model: "e5", dims: 3, target: SOURCE_CHUNK_TARGET, overlap: 200,
    vectors: [int8ToB64(vPipe), int8ToB64(vChat)],
    map: [{ p: "pipe.js", ci: 0 }, { p: "chat.js", ci: 0 }],
  }));
  const top = retrieveSourceChunks(index, s, Float32Array.of(0, 1, 0), 1);
  assert.equal(top.length, 1);
  assert.equal(top[0].p, "chat.js");
  assert.equal(top[0].text, "bravo"); // resolved from the CURRENT snapshot
  assert.ok(top[0].score > 0.9);
  assert.equal(chunks.length, 2);
});

test("retrieveSourceChunks: skips a (p,ci) that no longer resolves after source shrank", () => {
  const s = /** @type {any} */ (validateSnapshot({ v: 1, digest: "", files: [{ p: "a.js", s: 3, t: "one" }] }));
  const index = /** @type {any} */ (validateRagIndex({
    v: 1, model: "e5", dims: 3, target: SOURCE_CHUNK_TARGET, overlap: 200,
    vectors: [int8ToB64(quantizeInt8(Float32Array.of(1, 0, 0))), int8ToB64(quantizeInt8(Float32Array.of(0, 1, 0)))],
    map: [{ p: "a.js", ci: 0 }, { p: "a.js", ci: 5 }], // ci:5 no longer exists
  }));
  const top = retrieveSourceChunks(index, s, Float32Array.of(1, 0, 0), 5);
  assert.equal(top.length, 1); // the stale ci:5 is skipped, not returned as undefined
  assert.equal(top[0].text, "one");
});
