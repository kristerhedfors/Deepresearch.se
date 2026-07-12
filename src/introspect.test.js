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
/** @param {{ snapshot?: any, snapshotStatus?: number, rag?: any, berget?: boolean }} [opts] */
function makeEnv({ snapshot = SNAPSHOT, snapshotStatus = 200, rag = null, berget = false } = {}) {
  return /** @type {any} */ ({
    BERGET_API_TOKEN: berget ? "k" : undefined,
    ASSETS: {
      fetch: async (/** @type {Request} */ req) => {
        const p = new URL(req.url).pathname;
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
  return {
    started,
    done,
    step: (/** @type {string} */ id, /** @type {string} */ label) => started.push(label),
    stepDone: (/** @type {string} */ id, /** @type {string} */ label) => done.push(label),
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
