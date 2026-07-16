// Unit tests for the introspection enrichment (src/introspect.js) against a
// mocked ASSETS binding, plus the source-snapshot freshness check: the
// committed artifact (public/introspect/source-snapshot.json) must match the
// working tree, so a source change without `npm run bundle` fails the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSourceSnapshot, runIntrospectionEnrichment } from "./introspect.js";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

const SNAPSHOT = {
  v: 1,
  digest: "deadbeefcafe0123",
  count: 2,
  bytes: 0,
  files: [
    { p: "CLAUDE.md", s: 20, t: "# CLAUDE.md\norientation" },
    { p: "src/pipeline.js", s: 10, t: "// phases" },
  ],
};

const jsonRes = (payload, status = 200) =>
  new Response(payload === null ? "not found" : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

// An env whose ASSETS binding routes by path so the enrichment can load the
// snapshot AND (optionally) the rag index. `rag: null` → 404 there, so
// retrieval fails soft to the orientation-only block.
/** @param {{ snapshot?: any, snapshotStatus?: number, rag?: any, berget?: boolean, owaspCorpus?: any, owaspRag?: any, docsCorpus?: any, docsRag?: any }} [opts] */
function makeEnv({ snapshot = SNAPSHOT, snapshotStatus = 200, rag = null, berget = false, owaspCorpus = null, owaspRag = null, docsCorpus = null, docsRag = null } = {}) {
  return /** @type {any} */ ({
    BERGET_API_TOKEN: berget ? "k" : undefined,
    ASSETS: {
      fetch: async (/** @type {Request} */ req) => {
        const p = new URL(req.url).pathname;
        if (p.endsWith("owasp-corpus.json")) return owaspCorpus ? jsonRes(owaspCorpus) : jsonRes(null, 404);
        if (p.endsWith("owasp-rag.json")) return owaspRag ? jsonRes(owaspRag) : jsonRes(null, 404);
        if (p.endsWith("docs-corpus.json")) return docsCorpus ? jsonRes(docsCorpus) : jsonRes(null, 404);
        if (p.endsWith("docs-rag.json")) return docsRag ? jsonRes(docsRag) : jsonRes(null, 404);
        if (p.endsWith("source-rag.json")) return rag ? jsonRes(rag) : jsonRes(null, 404);
        return jsonRes(snapshot, snapshotStatus);
      },
    },
  });
}

// Back-compat shim for the loadSourceSnapshot test: any-payload single route.
/** @param {any} payload @param {number} [status] */
function envWith(payload, status = 200) {
  return /** @type {any} */ ({
    ASSETS: { fetch: async () => jsonRes(payload, status) },
  });
}

function steps() {
  /** @type {string[]} */
  const started = [];
  /** @type {string[]} */
  const done = [];
  /** @type {string[][]} */
  const details = [];
  return {
    started,
    done,
    details,
    step: (/** @type {string} */ id, /** @type {string} */ label) => started.push(label),
    stepDone: (/** @type {string} */ id, /** @type {string} */ label, /** @type {string[]} */ d = []) => {
      done.push(label);
      details.push(d);
    },
  };
}

const convo = (/** @type {string[]} */ ...texts) => texts.map((t) => ({ role: "user", content: t }));

test("loadSourceSnapshot: fetches + validates via the ASSETS binding", async () => {
  const snap = await loadSourceSnapshot(envWith(SNAPSHOT), noopLog);
  assert.ok(snap);
  assert.equal(snap.count, 2);
  // missing binding / 404 / junk all degrade to null, never a throw
  assert.equal(await loadSourceSnapshot(/** @type {any} */ ({}), noopLog), null);
  assert.equal(await loadSourceSnapshot(envWith(null, 404), noopLog), null);
  assert.equal(await loadSourceSnapshot(envWith({ nope: 1 }), noopLog), null);
});

test("runIntrospectionEnrichment: ALWAYS injects the source in dev mode — the 'Code examples from site' fix", async () => {
  // The reported bug: a plain code request that matches no intent regex must
  // STILL get the source injected (dev mode is the only gate now).
  for (const ask of ["Code examples from site", "what's the weather in Lund?", "how are you implemented?", "visa mig din källkod"]) {
    const s = steps();
    const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0, shellTranscript: [] });
    const out = await runIntrospectionEnrichment(makeEnv(), noopLog, s.step, s.stepDone, /** @type {any} */ (convo(ask)), state);
    const text = /** @type {any} */ (out[out.length - 1]).content;
    assert.match(text, /--- Introspection: deepresearch\.se source/, ask);
    assert.match(text, /Never say you have no access to the source or that this isn't a coding tool/, ask);
    assert.equal(state.introspectionCount, 1, ask);
    assert.equal(s.done.length, 1, ask);
    // The loaded snapshot is stashed so the pipeline's source-read loop can
    // READ files from it without a second ASSETS fetch.
    assert.ok(state.sourceSnapshot && state.sourceSnapshot.count === 2, ask);
  }
});

test("runIntrospectionEnrichment: strong intent adds the full file index; a plain ask doesn't", async () => {
  const s1 = steps();
  const strong = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const a = await runIntrospectionEnrichment(makeEnv(), noopLog, s1.step, s1.stepDone, /** @type {any} */ (convo("show me your source code")), strong);
  assert.match(/** @type {any} */ (a[a.length - 1]).content, /Full file index/);

  const s2 = steps();
  const plain = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const b = await runIntrospectionEnrichment(makeEnv(), noopLog, s2.step, s2.stepDone, /** @type {any} */ (convo("code examples from site")), plain);
  const text = /** @type {any} */ (b[b.length - 1]).content;
  assert.doesNotMatch(text, /# Full file index/);
  assert.match(text, /name any file path/); // the lean pointer instead
});

test("runIntrospectionEnrichment: dense retrieval surfaces relevant chunks (mocked embed + rag index)", async () => {
  // A rag index whose only vector points at src/pipeline.js chunk 0, and a
  // mocked Berget embed returning a query vector aligned to it.
  const { int8ToB64, quantizeInt8 } = await import("../public/js/introspect-core.js");
  const rag = {
    v: 1, model: "e5", dims: 3, target: 1400, overlap: 200,
    vectors: [int8ToB64(quantizeInt8(Float32Array.of(0, 1, 0)))],
    map: [{ p: "src/pipeline.js", ci: 0 }],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ data: [{ embedding: [0, 1, 0] }], model: "e5" });
  try {
    const s = steps();
    const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
    const out = await runIntrospectionEnrichment(makeEnv({ rag, berget: true }), noopLog, s.step, s.stepDone, /** @type {any} */ (convo("how do the pipeline phases work")), state);
    const text = /** @type {any} */ (out[out.length - 1]).content;
    assert.match(text, /Source excerpts most relevant to this question/);
    assert.match(text, /## src\/pipeline\.js/);
    assert.match(text, /\/\/ phases/); // the chunk text, resolved from the snapshot
    assert.match(s.done[0], /relevant source excerpt/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("runIntrospectionEnrichment: a security-assessment ask injects the OWASP reference block + stashes it in state", async () => {
  // A one-doc OWASP corpus (snapshot-shaped) + a rag index pointing at its chunk
  // 0, and a mocked embed aligned to that vector — the same shape the real
  // artifacts have, so this exercises the whole security-assessment branch.
  const { int8ToB64, quantizeInt8, chunkSourceText } = await import("../public/js/introspect-core.js");
  const docText = "A Prompt Injection Vulnerability occurs when user prompts alter the LLM's behavior in unintended ways. ".repeat(3);
  const owaspCorpus = {
    v: 1, digest: "owaspdigest01", count: 1, bytes: docText.length,
    files: [{ p: "LLM01:2025 Prompt Injection", s: docText.length, t: docText }],
    sources: { "LLM01:2025 Prompt Injection": { cat: "LLM01", family: "llm", year: "2025", title: "Prompt Injection", url: "https://genai.owasp.org/llmrisk/llm01-prompt-injection/" } },
  };
  // chunk 0 must resolve (matches the corpus chunking) for retrieval to return it.
  assert.ok(chunkSourceText(docText).length >= 1);
  const owaspRag = {
    v: 1, model: "e5", dims: 3, target: 1400, overlap: 200,
    vectors: [int8ToB64(quantizeInt8(Float32Array.of(0, 1, 0)))],
    map: [{ p: "LLM01:2025 Prompt Injection", ci: 0 }],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ data: [{ embedding: [0, 1, 0] }], model: "e5" });
  try {
    const s = steps();
    const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
    const out = await runIntrospectionEnrichment(
      makeEnv({ berget: true, owaspCorpus, owaspRag }),
      noopLog, s.step, s.stepDone,
      /** @type {any} */ (convo("do a security assessment of this site")),
      state,
    );
    const text = /** @type {any} */ (out[out.length - 1]).content;
    // Both blocks land on the last user message.
    assert.match(text, /--- Introspection: deepresearch\.se source/);
    assert.match(text, /--- OWASP Top 10 reference/);
    assert.match(text, /LLM01:2025 Prompt Injection — https:\/\/genai\.owasp\.org/);
    assert.match(text, /Prompt Injection Vulnerability occurs/); // the quoted OWASP text
    assert.match(text, /CVSS/);
    // Stashed for the native-tool source-research path (uses clean text).
    assert.match(state.owaspBlock, /--- OWASP Top 10 reference/);
    assert.ok(s.details[0].some((d) => /OWASP Top 10 reference: LLM01/.test(d)), "OWASP categories shown in the step details");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("runIntrospectionEnrichment: a NON-security dev-mode ask injects NO OWASP block", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ data: [{ embedding: [0, 1, 0] }], model: "e5" });
  try {
    const s = steps();
    const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
    const out = await runIntrospectionEnrichment(
      makeEnv({ berget: true, owaspCorpus: { v: 1, count: 1, files: [{ p: "x", s: 1, t: "y" }], sources: {} }, owaspRag: { v: 1, model: "e5", dims: 3, target: 1400, overlap: 200, vectors: [], map: [] } }),
      noopLog, s.step, s.stepDone,
      /** @type {any} */ (convo("how do the pipeline phases work?")),
      state,
    );
    const text = /** @type {any} */ (out[out.length - 1]).content;
    assert.doesNotMatch(text, /OWASP Top 10 reference/);
    assert.equal(state.owaspBlock, undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("runIntrospectionEnrichment: the HELP layer injects the docs block + stashes it in state", async () => {
  // A one-doc docs corpus with the help metadata (title, resolved symbols,
  // repo link base) — the shape scripts/bundle-docs.mjs writes. Lexical
  // retrieval (no embed mocked here) must surface it, the block must quote it
  // verbatim (image line included) and list the symbol reference with a link.
  const docText =
    "## Saving a project\n\nUse the `saveProject` flow from the Project panel to save your work.\n" +
    "![The Project panel with the save form](/introspect/docs-img/docs/img/save.png)\n" +
    "*The save form in the drawer.*\n";
  const docsCorpus = {
    v: 1, digest: "docsdigest001", count: 1, bytes: docText.length,
    files: [{ p: "docs/GUIDE.md", s: docText.length, t: docText }],
    sources: { "docs/GUIDE.md": { title: "User Guide" } },
    symbols: { "docs/GUIDE.md": [{ sym: "saveProject", file: "public/js/projects.js", line: 42 }] },
    repo: "https://github.com/kristerhedfors/Deepresearch.se/blob/main/",
  };
  const s = steps();
  const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const out = await runIntrospectionEnrichment(
    makeEnv({ docsCorpus }),
    noopLog, s.step, s.stepDone,
    /** @type {any} */ (convo("how do I save a project?")),
    state,
  );
  const text = /** @type {any} */ (out[out.length - 1]).content;
  assert.match(text, /--- Site documentation \(help layer\) ---/);
  assert.match(text, /# docs\/GUIDE\.md — "User Guide" \(verbatim excerpt\)/);
  assert.match(text, /!\[The Project panel with the save form\]\(\/introspect\/docs-img\/docs\/img\/save\.png\)/);
  assert.match(text, /\*The save form in the drawer\.\*/); // the italic caption rides along verbatim
  assert.match(text, /`saveProject` — public\/js\/projects\.js:42 \(https:\/\/github\.com\/kristerhedfors\/Deepresearch\.se\/blob\/main\/public\/js\/projects\.js#L42\)/);
  // Stashed for the native-tool source-research path (reads the clean text).
  assert.match(state.helpBlock, /--- Site documentation \(help layer\) ---/);
  assert.ok(s.details[0].some((d) => /documentation \(help\): docs\/GUIDE\.md/.test(d)), "help docs shown in the step details");
});

test("runIntrospectionEnrichment: no docs corpus → no help block (fail-soft)", async () => {
  const s = steps();
  const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const out = await runIntrospectionEnrichment(makeEnv(), noopLog, s.step, s.stepDone, /** @type {any} */ (convo("how do I save a project?")), state);
  const text = /** @type {any} */ (out[out.length - 1]).content;
  assert.match(text, /--- Introspection: deepresearch\.se source/); // the source block still lands
  assert.doesNotMatch(text, /Site documentation \(help layer\)/);
  assert.equal(state.helpBlock, undefined);
});

test("runIntrospectionEnrichment: fail-soft when the snapshot is unavailable", async () => {
  const s = steps();
  const state = /** @type {any} */ ({ introspection: true, introspectionCount: 0 });
  const conversation = convo("how are you built?");
  const out = await runIntrospectionEnrichment(makeEnv({ snapshot: null, snapshotStatus: 404 }), noopLog, s.step, s.stepDone, /** @type {any} */ (conversation), state);
  assert.equal(out, conversation); // unchanged, no throw
  assert.match(s.done[0], /unavailable/);
  assert.equal(state.introspectionCount, 0);
});

// ---- the committed artifacts stay fresh -----------------------------------------

test("source snapshot artifact matches the working tree (npm run bundle)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Exits non-zero (throws here) when public/introspect/source-snapshot.json
  // is stale — regenerate with `npm run bundle` and commit it.
  execFileSync(process.execPath, [join(root, "scripts/bundle-source.mjs"), "--check"], {
    cwd: root,
    stdio: "pipe",
  });
});

test("source-rag index is consistent with the current snapshot (no stale chunk refs)", async (t) => {
  // The rag index can't be re-embedded in CI (no key), so we can't recompute
  // it — but we CAN enforce the correctness invariant: every indexed (p, ci)
  // must still resolve against the CURRENT snapshot's deterministic chunking.
  // A source edit that shifts chunk boundaries (or removes a file) trips this
  // → re-run `npm run bundle:rag` (with a Berget key or the break-glass creds)
  // and commit the regenerated index. Vectors may lag semantically until then;
  // the retrieved TEXT is always current (retrieval re-chunks the snapshot).
  //
  // The index is an OPTIONAL enhancement — the server fails soft to an
  // orientation-only block without it — so a missing artifact SKIPS (retrieval
  // is simply off) rather than failing the suite; a PRESENT one is enforced.
  const { existsSync } = await import("node:fs");
  const { validateSnapshot, validateRagIndex, chunkSourceText } = await import("../public/js/introspect-core.js");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ragPath = join(root, "public/introspect/source-rag.json");
  if (!existsSync(ragPath)) {
    t.skip("source-rag.json absent — dense retrieval off until `npm run bundle:rag` is committed");
    return;
  }
  const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
  const snapshot = validateSnapshot(read("public/introspect/source-snapshot.json"));
  assert.ok(snapshot, "snapshot must exist and validate");
  const index = validateRagIndex(read("public/introspect/source-rag.json"));
  assert.ok(index, "source-rag.json present but invalid — re-run `npm run bundle:rag`");

  const counts = new Map();
  for (const f of snapshot.files) counts.set(f.p, chunkSourceText(f.t).length);
  let stale = 0;
  for (const m of index.map) {
    const n = counts.get(m.p);
    if (n === undefined || m.ci >= n) stale++;
  }
  assert.equal(stale, 0, `${stale} rag chunk refs no longer resolve — re-run \`npm run bundle:rag\``);
  // Coverage sanity floor: the builder deliberately excludes test files, so we
  // don't assert a percentage of ALL files — just that a substantial slice of
  // the source is indexed (a badly-truncated or near-empty index trips this).
  const covered = new Set(index.map.map((m) => m.p));
  assert.ok(covered.size >= 80, `rag index covers only ${covered.size} files — re-run \`npm run bundle:rag\``);
});

test("owasp-rag index is consistent with the committed OWASP corpus (no stale chunk refs)", async (t) => {
  // Same freshness invariant as the source-rag check, for the OWASP reference
  // corpus/index (scripts/fetch-owasp.mjs → owasp-corpus.json, then
  // scripts/bundle-owasp-rag.mjs → owasp-rag.json). CI can't re-embed, so we
  // enforce that every indexed (p, ci) still resolves against the CURRENT
  // corpus's chunking; a corpus refresh that shifts chunk boundaries trips this
  // → re-run `npm run bundle:owasp-rag`. Optional artifact → SKIP when absent
  // (the OWASP block simply doesn't inject), enforced when present.
  const { existsSync } = await import("node:fs");
  const { validateSnapshot, validateRagIndex, chunkSourceText } = await import("../public/js/introspect-core.js");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ragPath = join(root, "public/introspect/owasp-rag.json");
  const corpusPath = join(root, "public/introspect/owasp-corpus.json");
  if (!existsSync(ragPath) || !existsSync(corpusPath)) {
    t.skip("OWASP corpus/index absent — run `npm run fetch:owasp` && `npm run bundle:owasp-rag`");
    return;
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const corpus = validateSnapshot(read(corpusPath));
  assert.ok(corpus, "owasp-corpus.json must exist and validate");
  // The 20 OWASP categories (LLM01..10 + A01..10) — a truncated corpus trips this.
  assert.equal(corpus.count, 20, `OWASP corpus has ${corpus.count} docs, expected 20 — re-run \`npm run fetch:owasp\``);
  const index = validateRagIndex(read(corpusPath.replace("owasp-corpus.json", "owasp-rag.json")));
  assert.ok(index, "owasp-rag.json present but invalid — re-run `npm run bundle:owasp-rag`");

  const counts = new Map();
  for (const f of corpus.files) counts.set(f.p, chunkSourceText(f.t).length);
  let stale = 0;
  for (const m of index.map) {
    const n = counts.get(m.p);
    if (n === undefined || m.ci >= n) stale++;
  }
  assert.equal(stale, 0, `${stale} owasp-rag chunk refs no longer resolve — re-run \`npm run bundle:owasp-rag\``);
  const covered = new Set(index.map.map((m) => m.p));
  assert.equal(covered.size, 20, `owasp-rag covers ${covered.size}/20 OWASP docs — re-run \`npm run bundle:owasp-rag\``);
});

test("docs corpus artifact matches the working tree (npm run bundle:docs)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  // Exits non-zero (throws here) when public/introspect/docs-corpus.json (or a
  // copied doc image under docs-img/) is stale — regenerate with
  // `npm run bundle:docs` and commit the result.
  execFileSync(process.execPath, [join(root, "scripts/bundle-docs.mjs"), "--check"], {
    cwd: root,
    stdio: "pipe",
  });
});

test("docs-rag index is consistent with the committed docs corpus (no stale chunk refs)", async (t) => {
  // Same freshness invariant as the source-rag / owasp-rag checks, for the HELP
  // documentation corpus/index (scripts/bundle-docs.mjs → docs-corpus.json,
  // then scripts/bundle-docs-rag.mjs → docs-rag.json). CI can't re-embed, so we
  // enforce that every indexed (p, ci) still resolves against the CURRENT
  // corpus's chunking; a docs edit that shifts chunk boundaries trips this →
  // re-run `npm run bundle:docs-rag`. Optional artifact → SKIP when absent
  // (help retrieval falls back to the lexical path), enforced when present.
  const { existsSync } = await import("node:fs");
  const { validateSnapshot, validateRagIndex, chunkSourceText } = await import("../public/js/introspect-core.js");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const ragPath = join(root, "public/introspect/docs-rag.json");
  const corpusPath = join(root, "public/introspect/docs-corpus.json");
  if (!existsSync(ragPath) || !existsSync(corpusPath)) {
    t.skip("docs corpus/index absent — run `npm run bundle:docs` && `npm run bundle:docs-rag`");
    return;
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const corpus = validateSnapshot(read(corpusPath));
  assert.ok(corpus, "docs-corpus.json must exist and validate");
  const index = validateRagIndex(read(ragPath));
  assert.ok(index, "docs-rag.json present but invalid — re-run `npm run bundle:docs-rag`");

  const counts = new Map();
  for (const f of corpus.files) counts.set(f.p, chunkSourceText(f.t).length);
  let stale = 0;
  for (const m of index.map) {
    const n = counts.get(m.p);
    if (n === undefined || m.ci >= n) stale++;
  }
  assert.equal(stale, 0, `${stale} docs-rag chunk refs no longer resolve — re-run \`npm run bundle:docs-rag\``);
  const covered = new Set(index.map.map((m) => m.p));
  assert.equal(
    covered.size,
    corpus.count,
    `docs-rag covers ${covered.size}/${corpus.count} docs — re-run \`npm run bundle:docs-rag\``,
  );
});
