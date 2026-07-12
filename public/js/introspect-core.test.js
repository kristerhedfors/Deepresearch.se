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
  fileSummary,
  buildSourceSitemap,
  normalizeReadStep,
  resolveReadPaths,
  readSnapshotFiles,
  buildSourceResearchBlock,
  buildSourceStepMessage,
  runSourceReadLoop,
  backReferenceIntent,
  resolveReferencedPaths,
  MAX_FILES_PER_ROUND,
  MAX_READ_FILE_CHARS,
  MAX_READ_TOTAL_CHARS,
  MAX_SOURCE_READ_ROUNDS,
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
    "conduct a proper security assessment", // an AUDIT of the own code stays introspection (pipeline.js routes it to the source read loop)
    "security assessment",
    "assess the codebase",
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

// ---- the agentic source-read loop (the "read files as it wants" tool) --------

const SRC_SNAPSHOT = {
  v: 1,
  digest: "d",
  count: 4,
  bytes: 0,
  files: [
    { p: "src/auth.js", s: 30, t: "// @ts-check\n// Identity: session cookie + break-glass admin auth.\nexport function auth() {}" },
    { p: "src/index.js", s: 20, t: "// @ts-check\n// Entrypoint: request id, identity gate, routing.\nimport {} from './auth.js';" },
    { p: "css/app.css", s: 10, t: "/* The main app stylesheet: floating glass chrome and waves. */\n.x{}" },
    { p: "CLAUDE.md", s: 40, t: "# CLAUDE.md\n\nGuidance for Claude Code when working in this repository." },
  ],
};

test("fileSummary: extracts a one-liner from //, /* */, and markdown headers", () => {
  assert.match(fileSummary("src/auth.js", SRC_SNAPSHOT.files[0].t), /Identity: session cookie/);
  assert.match(fileSummary("css/app.css", SRC_SNAPSHOT.files[2].t), /main app stylesheet/);
  assert.match(fileSummary("CLAUDE.md", SRC_SNAPSHOT.files[3].t), /Guidance for Claude Code/);
  // @ts-check preamble is skipped, not returned as the summary.
  assert.doesNotMatch(fileSummary("src/auth.js", SRC_SNAPSHOT.files[0].t), /ts-check/);
  // No header → empty, never a crash.
  assert.equal(fileSummary("x.js", "const x = 1;"), "");
  assert.equal(fileSummary("x.js", ""), "");
});

test("buildSourceSitemap: one 'path — description' line per file, falls back to bare path", () => {
  const map = buildSourceSitemap(SRC_SNAPSHOT);
  const lines = map.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^src\/auth\.js — Identity/);
  assert.match(lines[3], /^CLAUDE\.md — Guidance/);
  // A file with no summary lists its path alone (no trailing dash).
  const bare = buildSourceSitemap({ files: [{ p: "data.json", s: 1, t: "{}" }] });
  assert.equal(bare, "data.json");
});

test("normalizeReadStep: tolerant parse; files continue the loop, empty means done", () => {
  assert.deepEqual(normalizeReadStep({ read: ["src/auth.js", " ", 42, "src/index.js"], reasoning: "  need auth  " }), {
    read: ["src/auth.js", "src/index.js"],
    done: false,
    reasoning: "need auth",
  });
  // No files → done, regardless of a done flag.
  assert.equal(normalizeReadStep({ done: true }).done, true);
  assert.equal(normalizeReadStep({}).done, true);
  assert.equal(normalizeReadStep(null).done, true);
  assert.equal(normalizeReadStep("junk").done, true);
  // Capped at MAX_FILES_PER_ROUND.
  const many = normalizeReadStep({ read: Array.from({ length: 20 }, (_, i) => `f${i}.js`) });
  assert.equal(many.read.length, MAX_FILES_PER_ROUND);
});

test("resolveReadPaths: exact match, ./ prefix, unique basename, unknown → null", () => {
  const r = resolveReadPaths(SRC_SNAPSHOT, ["src/auth.js", "./src/index.js", "app.css", "nope.js", "AUTH.JS"]);
  assert.deepEqual(r.map((x) => x.path), ["src/auth.js", "src/index.js", "css/app.css", null, "src/auth.js"]);
  // An ambiguous basename (two files share it) resolves to null, not a guess.
  const ambiguous = {
    files: [{ p: "a/x.js", s: 1, t: "" }, { p: "b/x.js", s: 1, t: "" }],
  };
  assert.equal(resolveReadPaths(ambiguous, ["x.js"])[0].path, null);
});

test("readSnapshotFiles: dedupes already-read, clamps per-file and total budget", () => {
  const budget = { used: 0 };
  const already = new Set();
  const got = readSnapshotFiles(SRC_SNAPSHOT, ["src/auth.js", "src/index.js", "nope.js"], already, budget);
  assert.deepEqual(got.map((g) => g.p), ["src/auth.js", "src/index.js"]);
  assert.ok(budget.used > 0);
  // Second call with the same file skipped when marked already-read.
  for (const g of got) already.add(g.p);
  const again = readSnapshotFiles(SRC_SNAPSHOT, ["src/auth.js"], already, budget);
  assert.equal(again.length, 0);
});

test("readSnapshotFiles: truncates a file past MAX_READ_FILE_CHARS and stops at the total cap", () => {
  const big = "a".repeat(MAX_READ_FILE_CHARS + 5000);
  const snap = {
    files: [
      { p: "big1.js", s: big.length, t: big },
      { p: "big2.js", s: big.length, t: big },
      { p: "big3.js", s: big.length, t: big },
      { p: "big4.js", s: big.length, t: big },
      { p: "big5.js", s: big.length, t: big },
    ],
  };
  const budget = { used: 0 };
  const got = readSnapshotFiles(snap, ["big1.js", "big2.js", "big3.js", "big4.js", "big5.js"], new Set(), budget);
  assert.ok(got[0].truncated, "a file over the per-file cap is truncated");
  assert.ok(got[0].text.length <= MAX_READ_FILE_CHARS + 32);
  assert.ok(budget.used <= MAX_READ_TOTAL_CHARS);
  // The total cap stops us before all five huge files fit.
  assert.ok(got.length < 5, "the total budget stops before all five huge files are read");
});

test("buildSourceResearchBlock: labels each file with its path; empty when nothing read", () => {
  assert.equal(buildSourceResearchBlock([]), "");
  assert.equal(buildSourceResearchBlock(null), "");
  const block = buildSourceResearchBlock([
    { p: "src/auth.js", text: "code A" },
    { p: "src/index.js", text: "code B", truncated: true },
  ]);
  assert.match(block, /ground\s+truth/i);
  assert.match(block, /# src\/auth\.js\ncode A/);
  assert.match(block, /# src\/index\.js \(truncated\)\ncode B/);
});

test("buildSourceStepMessage: carries sitemap round 1; prior reads round 2+", () => {
  const first = buildSourceStepMessage({ question: "assess security", context: "ctx", sitemap: "src/auth.js — auth" });
  assert.match(first, /Research question/);
  assert.match(first, /Sitemap/);
  assert.match(first, /READ FIRST/);
  const second = buildSourceStepMessage({ question: "q", context: "c", sitemap: "s", priorBlock: "already read files" });
  assert.match(second, /already read files/);
  assert.match(second, /NEXT files/);
});

test("runSourceReadLoop: multi-round navigation, dedup, and done terminates", async () => {
  // A fake model that reads index.js first, then follows its import to auth.js,
  // then declares done — exactly the "follow the code" behavior we want.
  const rounds = [{ read: ["src/index.js"] }, { read: ["src/auth.js", "src/index.js"] }, { done: true }];
  const seenPrior = [];
  const budget = { used: 0 };
  const reads = await runSourceReadLoop({
    step: async (priorReads, round) => {
      seenPrior.push(priorReads.map((r) => r.p));
      return rounds[round - 1];
    },
    read: async (paths, already) => readSnapshotFiles(SRC_SNAPSHOT, paths, already, budget),
  });
  // index.js read round 1, auth.js round 2 (index.js re-request deduped), done round 3.
  assert.deepEqual(reads.map((r) => r.p), ["src/index.js", "src/auth.js"]);
  // The step saw the growing transcript each round.
  assert.deepEqual(seenPrior[0], []);
  assert.deepEqual(seenPrior[1], ["src/index.js"]);
});

test("runSourceReadLoop: a throwing step ends the loop fail-soft with what was gathered", async () => {
  const budget = { used: 0 };
  let n = 0;
  const reads = await runSourceReadLoop({
    step: async () => {
      n++;
      if (n === 1) return { read: ["src/auth.js"] };
      throw new Error("model down");
    },
    read: async (paths, already) => readSnapshotFiles(SRC_SNAPSHOT, paths, already, budget),
  });
  assert.deepEqual(reads.map((r) => r.p), ["src/auth.js"]);
});

test("runSourceReadLoop: round 1 done (no files) yields an empty gather, never throws", async () => {
  const reads = await runSourceReadLoop({
    step: async () => ({ done: true }),
    read: async () => {
      throw new Error("should never be called");
    },
  });
  assert.deepEqual(reads, []);
});

// ---- back-reference resolution ("read those" / "do that") -------------------

test("backReferenceIntent: English demonstrative / continuation follow-ups", () => {
  for (const s of [
    "read those",
    "read those files",
    "Read them all",
    "open the rest",
    "go through the remaining ones",
    "do that",
    "go on",
    "keep going",
    "continue",
    "the rest",
    "read the ones you haven't yet",
  ]) {
    assert.equal(backReferenceIntent(s), true, s);
  }
});

test("backReferenceIntent: Swedish parity — same breadth as English", () => {
  for (const s of [
    "läs dem",
    "läs de där",
    "läs dessa",
    "läs resten",
    "gå igenom de återstående",
    "gör det",
    "kör dem",
    "fortsätt",
    "kör vidare",
    "gå vidare",
    "resten",
  ]) {
    assert.equal(backReferenceIntent(s), true, s);
  }
});

test("backReferenceIntent: ordinary new questions do NOT trip it", () => {
  for (const s of [
    "Security assessment",
    "Gimme architecture overview",
    "How does auth work?",
    "explain the pipeline",
    "Visa mig arkitekturen",
    // A long message that merely contains a continuation word is a real ask.
    "Please review the entire authentication subsystem and continue only if you find something concrete worth reporting in detail here.",
  ]) {
    assert.equal(backReferenceIntent(s), false, s);
  }
});

test("resolveReferencedPaths: pulls the paths the most recent prior turn named", () => {
  const s = snap();
  // Mirrors the live bug: the prior assistant turn listed unread files in prose.
  const priorMostRecentFirst = [
    "I have not re-read src/pipeline.js or public/js/stream.js in this pass.",
    "Earlier I covered CLAUDE.md.",
  ];
  assert.deepEqual(resolveReferencedPaths(priorMostRecentFirst, s), [
    "src/pipeline.js",
    "public/js/stream.js",
  ]);
});

test("resolveReferencedPaths: walks back to the first prior text that names paths; [] when none", () => {
  const s = snap();
  // Most-recent text names nothing → fall through to the one that does.
  assert.deepEqual(resolveReferencedPaths(["read those", "see wrangler.toml"], s), ["wrangler.toml"]);
  assert.deepEqual(resolveReferencedPaths(["nothing here", "still nothing"], s), []);
  assert.deepEqual(resolveReferencedPaths([], s), []);
});

test("resolveReferencedPaths: bounded by cap", () => {
  const s = snap();
  const all = "look at CLAUDE.md src/pipeline.js public/js/stream.js wrangler.toml";
  assert.equal(resolveReferencedPaths([all], s, 2).length, 2);
});

test("runSourceReadLoop: initial seed reads are counted as already-read and returned", async () => {
  const seed = [{ p: "src/pipeline.js", text: "// seeded", truncated: false }];
  let sawPrior = -1;
  const reads = await runSourceReadLoop({
    initial: seed,
    step: async (prior) => {
      sawPrior = prior.length; // round 1 must already see the seed
      return { done: true };
    },
    read: async () => {
      throw new Error("should not read when the planner is immediately done");
    },
  });
  assert.equal(sawPrior, 1); // planner saw the seed as prior context
  assert.deepEqual(reads.map((r) => r.p), ["src/pipeline.js"]); // seed grounds the answer
});

test("runSourceReadLoop: bounded to MAX_SOURCE_READ_ROUNDS even if the model never stops", async () => {
  let calls = 0;
  const snap = { files: Array.from({ length: 40 }, (_, i) => ({ p: `f${i}.js`, s: 1, t: `// file ${i}\nx` })) };
  const budget = { used: 0 };
  await runSourceReadLoop({
    step: async (_prior, round) => {
      calls++;
      return { read: [`f${round}.js`] }; // always asks for a new file, never done
    },
    read: async (paths, already) => readSnapshotFiles(snap, paths, already, budget),
  });
  assert.equal(calls, MAX_SOURCE_READ_ROUNDS);
});

// ---- integration: the loop over the REAL committed snapshot ------------------
// Proves the whole chain (sitemap → read request → resolve → gather) works
// against real data — the "Make a security assessment" scenario that motivated
// this: research the ACTUAL source, no web search, no unrelated third-party repos.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("runSourceReadLoop over the real source snapshot reads real files with real content", async (t) => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const snapPath = join(root, "public/introspect/source-snapshot.json");
  if (!existsSync(snapPath)) {
    t.skip("source-snapshot.json absent");
    return;
  }
  const snapshot = validateSnapshot(JSON.parse(readFileSync(snapPath, "utf8")));
  assert.ok(snapshot && snapshot.count > 100, "the real snapshot loads and has the full tree");

  // Sitemap: every file gets a line; core files carry a real description.
  const sitemap = buildSourceSitemap(snapshot);
  assert.equal(sitemap.split("\n").length, snapshot.count);
  assert.match(sitemap, /src\/auth\.js — [A-Za-z]/, "auth.js has an extracted description");
  assert.match(sitemap, /src\/index\.js — [A-Za-z]/, "index.js has an extracted description");

  // A fake "security-savvy" model that navigates the source across rounds.
  const budget = { used: 0 };
  const plan = [
    { read: ["src/index.js", "src/auth.js", "src/security-headers.js"], reasoning: "entry, auth, headers" },
    { read: ["src/storage.js", "src/vault.js"], reasoning: "privacy model" },
    { done: true },
  ];
  const reads = await runSourceReadLoop({
    step: async (_prior, round) => plan[round - 1],
    read: async (paths, already) => readSnapshotFiles(snapshot, paths, already, budget),
  });

  const paths = reads.map((r) => r.p);
  assert.ok(paths.includes("src/auth.js") && paths.includes("src/index.js"), "read the real requested files");
  assert.ok(budget.used > 0 && budget.used <= MAX_READ_TOTAL_CHARS, "respected the total budget");
  // The gathered text is the ACTUAL file content, not a doc summary.
  const auth = reads.find((r) => r.p === "src/auth.js");
  assert.match(auth.text, /export/, "auth.js content is real source code");

  // The synthesis block carries the real code, path-labeled.
  const block = buildSourceResearchBlock(reads);
  assert.match(block, /# src\/auth\.js/);
  assert.match(block, /ground truth/i);
});
