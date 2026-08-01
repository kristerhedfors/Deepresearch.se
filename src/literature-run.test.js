// Unit tests for src/literature-run.js — the env-touching half of the
// literature MCP tool family, driven against a FAKE Vectorize binding and a
// stubbed Berget endpoint.
//
// What is worth pinning here is not the happy path (src/literature-tools.test.js
// already covers the mapping and filtering) but the behaviour that only appears
// once real calls are involved:
//
//   * the BATCHING — six angles must cost ONE embedding call, and every
//     (angle × corpus) retrieval must overlap rather than run in sequence;
//   * the FAIL-SOFT contract — a dead corpus, a dead reranker or a missing
//     binding degrades the result and says so, and never throws at the caller;
//   * the honest MISS — an id that is not in the corpus comes back named, with
//     the coverage window that explains it.
//
// The fakes are deliberately literal about Vectorize's shapes (`{ matches: [] }`
// from query, `VectorizeVector[]` from getByIds) because the whole point of a
// fake here is to catch a wrong assumption about the binding's contract.

import test from "node:test";
import assert from "node:assert/strict";

import {
  mapPool,
  runLiteratureCorpora,
  runLiteratureFetch,
  runLiteratureSearch,
  runLiteratureSimilar,
  runLiteratureTool,
} from "./literature-run.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** A 1024-dim vector, the dimension both indexes are built at. */
const VEC = () => new Array(1024).fill(0.01);

/**
 * A fake Vectorize index that records how it was called.
 * @param {{ rows?: any[], fail?: boolean, delayMs?: number }} [opts]
 */
function fakeIndex({ rows = [], fail = false, delayMs = 0 } = {}) {
  const calls = { query: 0, getByIds: 0, describe: 0, inFlight: 0, maxInFlight: 0, topK: null, ids: [] };
  return {
    calls,
    async query(vector, opts) {
      calls.query++;
      calls.topK = opts?.topK;
      calls.inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      calls.inFlight--;
      if (fail) throw new Error("index down");
      assert.equal(vector.length, 1024, "queries the index with a full-width vector");
      return { matches: rows };
    },
    async getByIds(ids) {
      calls.getByIds++;
      calls.ids.push(...ids);
      if (fail) throw new Error("index down");
      return rows.filter((r) => ids.includes(r.id));
    },
    async describe() {
      calls.describe++;
      if (fail) throw new Error("index down");
      return { vectorCount: 772658, dimensions: 1024 };
    },
  };
}

/** One arXiv vector, in the shape the index actually stores. */
function arxivRow(id, title, extra = {}) {
  return {
    id,
    values: extra.values,
    metadata: {
      t: title,
      a: extra.abstract ?? `An abstract about ${title}.`,
      au: extra.authors ?? "Ada Lovelace; Alan Turing",
      c: extra.category ?? "cs.IR",
      d: extra.revised ?? "2026-05-02",
    },
  };
}

function pubmedRow(pmid, title, extra = {}) {
  return {
    id: `pmid:${pmid}`,
    values: extra.values,
    metadata: {
      t: title,
      a: extra.abstract ?? `BACKGROUND: ${title}.`,
      au: "Rosalind Franklin",
      j: extra.journal ?? "The Lancet",
      d: extra.date ?? "2026-03-14",
    },
  };
}

/**
 * Stub Berget's two endpoints. Returns a call ledger so a test can assert that
 * six queries cost one embedding request.
 * @param {{ rerank?: "ok"|"http_error"|"throw", embed?: "ok"|"throw" }} [opts]
 */
function stubBerget({ rerank = "ok", embed = "ok" } = {}) {
  const calls = { embed: 0, rerank: 0, embedInputs: [], rerankQueries: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (href.endsWith("/embeddings")) {
      calls.embed++;
      calls.embedInputs.push(body.input);
      if (embed === "throw") throw new Error("embedder down");
      return jsonResponse({
        data: body.input.map((_, index) => ({ index, embedding: VEC() })),
        usage: { prompt_tokens: 10 },
      });
    }
    if (href.endsWith("/rerank")) {
      calls.rerank++;
      calls.rerankQueries.push(body.query);
      if (rerank === "throw") throw new Error("reranker down");
      if (rerank === "http_error") return new Response("nope", { status: 503 });
      // Score descending in the order the documents arrived, so the fake's
      // ordering is predictable and the floor is exercised: the last document
      // always scores below RERANK_FLOOR (0.01).
      const n = body.documents.length;
      return jsonResponse({
        results: body.documents.map((_, index) => ({ index, relevance_score: index === n - 1 ? 0.001 : 1 - index * 0.1 })),
      });
    }
    throw new Error(`unexpected fetch to ${href}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
}

/** Parse a tool result's JSON payload. */
function payloadOf(result) {
  return JSON.parse(result.text);
}

// ---------------------------------------------------------------------------
// mapPool
// ---------------------------------------------------------------------------

test("mapPool preserves order while bounding concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, i) => async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i;
  });
  const out = await mapPool(tasks, 5);
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // The bound is the point: a Worker holds only a handful of outbound
  // connections, and a queued fetch still counts down its own timeout.
  assert.ok(peak <= 5, `peak ${peak} within the pool`);
  assert.ok(peak > 1, "and it really did overlap");
  assert.deepEqual(await mapPool([], 5), []);
});

// ---------------------------------------------------------------------------
// literature_search
// ---------------------------------------------------------------------------

test("six angles cost ONE embedding call and overlap across both corpora", async () => {
  const berget = stubBerget();
  // Three rows per corpus: the stub scores the last document below the floor,
  // so two of each survive — which is also what makes the merged view non-trivial.
  const arxiv = fakeIndex({
    rows: [
      arxivRow("2401.11111", "Dense retrieval at scale"),
      arxivRow("2401.22222", "Reranking for retrieval"),
      arxivRow("2401.33333", "Something unrelated"),
    ],
    delayMs: 10,
  });
  const pubmed = fakeIndex({
    rows: [
      pubmedRow("41610285", "A trial of something"),
      pubmedRow("41610286", "A cohort study"),
      pubmedRow("41610287", "Unrelated case report"),
    ],
    delayMs: 10,
  });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv, PUBMED_INDEX: pubmed };
  try {
    const queries = ["angle one", "angle two", "angle three", "angle four", "angle five", "angle six"];
    const result = await runLiteratureSearch(env, log, { queries });
    assert.equal(result.isError, false);
    // THE headline property: one round trip to the embedder for all six.
    assert.equal(berget.calls.embed, 1);
    assert.equal(berget.calls.embedInputs[0].length, 6);
    // e5's asymmetric query prefix is applied.
    assert.ok(berget.calls.embedInputs[0][0].startsWith("query: "));
    // Twelve retrievals, each its own Vectorize query and cross-encoder pass.
    assert.equal(arxiv.calls.query, 6);
    assert.equal(pubmed.calls.query, 6);
    assert.equal(berget.calls.rerank, 12);
    // And they genuinely overlapped rather than running in sequence.
    assert.ok(arxiv.calls.maxInFlight > 1, "arXiv legs overlapped");

    const payload = payloadOf(result);
    assert.deepEqual(payload.corpora_searched, ["arxiv", "pubmed"]);
    assert.equal(payload.queries.length, 6);
    assert.equal(payload.stats.queries, 6);
    assert.equal(payload.stats.reranked, true);
    // Each angle saw both corpora.
    assert.deepEqual(
      [...new Set(payload.queries[0].results.map((r) => r.corpus))].sort(),
      ["arxiv", "pubmed"],
    );
    // A merged view is offered only when there is something to merge, and it
    // de-duplicates the same paper across all six angles into one row.
    assert.ok(payload.merged, "multi-angle calls get a merged ranking");
    assert.equal(payload.merged.count, 4);
    assert.deepEqual(payload.merged.results[0].found_by, [0, 1, 2, 3, 4, 5]);
  } finally {
    berget.restore();
  }
});

test("a single query takes the same path and skips the merged view", async () => {
  const berget = stubBerget();
  const arxiv = fakeIndex({ rows: [arxivRow("2401.11111", "One paper")] });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv };
  try {
    const payload = payloadOf(await runLiteratureSearch(env, log, { query: "one angle", corpus: "arxiv" }));
    assert.equal(berget.calls.embed, 1);
    assert.equal(payload.queries.length, 1);
    assert.equal(payload.merged, undefined, "nothing to merge across one angle");
    assert.equal(payload.queries[0].results[0].id, "2401.11111");
    assert.equal(payload.queries[0].results[0].url, "https://arxiv.org/abs/2401.11111");
    // The candidate pool is the tier's measured 50, not the caller's limit.
    assert.equal(arxiv.calls.topK, 50);
  } finally {
    berget.restore();
  }
});

test("the relevance floor drops the weak tail, and an empty result says what it means", async () => {
  const berget = stubBerget();
  // The stub scores the LAST document 0.001, below the 0.01 floor.
  const rows = [arxivRow("2401.1", "Kept"), arxivRow("2401.2", "Also kept"), arxivRow("2401.3", "Dropped")];
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows }) };
  try {
    const payload = payloadOf(await runLiteratureSearch(env, log, { query: "q", corpus: "arxiv" }));
    assert.deepEqual(payload.queries[0].results.map((r) => r.id), ["2401.1", "2401.2"]);
    assert.equal(payload.stats.relevance_floor, 0.01);

    // Nothing above the floor at all is a MEANINGFUL answer, not a failure —
    // and the caller is pointed at literature_corpora before it concludes the
    // literature is silent.
    const emptyEnv = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [] }) };
    const empty = payloadOf(await runLiteratureSearch(emptyEnv, log, { query: "q", corpus: "arxiv" }));
    assert.equal(empty.stats.records_returned, 0);
    assert.ok(empty.notes.some((n) => n.includes("literature_corpora")));
  } finally {
    berget.restore();
  }
});

test("a caller's min_score is pushed into retrieval, not applied to a truncated list", async () => {
  const berget = stubBerget();
  const rows = Array.from({ length: 5 }, (_, i) => arxivRow(`2401.${i}`, `Paper ${i}`));
  const arxiv = fakeIndex({ rows });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv };
  try {
    // The stub scores 1.0, 0.9, 0.8, 0.7, 0.001 — a 0.75 floor keeps four…
    const payload = payloadOf(await runLiteratureSearch(env, log, { query: "q", corpus: "arxiv", min_score: 0.75 }));
    assert.deepEqual(payload.queries[0].results.map((r) => r.id), ["2401.0", "2401.1", "2401.2"]);
    assert.equal(payload.stats.relevance_floor, 0.75);
    // …and the caller is told how min_score differs from the other filters.
    assert.ok(payload.notes.some((n) => n.includes("AFTER retrieval") && n.includes("REPLACES")));
  } finally {
    berget.restore();
  }
});

test("one corpus failing degrades the call instead of failing it", async () => {
  const berget = stubBerget();
  const env = {
    BERGET_API_TOKEN: "t",
    ARXIV_INDEX: fakeIndex({ rows: [arxivRow("2401.1", "Survivor")] }),
    PUBMED_INDEX: fakeIndex({ fail: true }),
  };
  try {
    const result = await runLiteratureSearch(env, log, { query: "q" });
    assert.equal(result.isError, false, "a half-answer is still an answer");
    const payload = payloadOf(result);
    assert.equal(payload.queries[0].results.length, 1);
    assert.deepEqual(payload.degraded.map((d) => d.corpus), ["pubmed"]);
  } finally {
    berget.restore();
  }
});

test("losing the cross-encoder keeps the dense order and says the floor did not apply", async () => {
  for (const mode of /** @type {const} */ (["http_error", "throw"])) {
    const berget = stubBerget({ rerank: mode });
    const rows = [arxivRow("2401.1", "A"), arxivRow("2401.2", "B"), arxivRow("2401.3", "C")];
    const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows }) };
    try {
      const payload = payloadOf(await runLiteratureSearch(env, log, { query: "q", corpus: "arxiv" }));
      assert.equal(payload.stats.reranked, false, `${mode} degrades rather than errors`);
      // Every row survives: a fallback order carries no comparable scores, so
      // dropping on absent scores would turn a degraded result into no result.
      assert.equal(payload.queries[0].results.length, 3);
      assert.equal("score" in payload.queries[0].results[0], false);
      assert.ok(payload.notes.some((n) => n.includes("cross-encoder")));
    } finally {
      berget.restore();
    }
  }
});

test("a dead embedder is a described tool error, never a thrown one", async () => {
  const berget = stubBerget({ embed: "throw" });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() };
  try {
    const result = await runLiteratureSearch(env, log, { query: "q" });
    assert.equal(result.isError, true);
    // An MCP transport error makes a client report a connection problem; a
    // described tool-level failure is something the calling model can act on.
    assert.ok(payloadOf(result).error.includes("embed"));
  } finally {
    berget.restore();
  }
});

test("no query, and no binding, both explain themselves", async () => {
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() };
  const empty = await runLiteratureSearch(env, log, {});
  assert.equal(empty.isError, true);
  assert.ok(payloadOf(empty).error.includes("queries"));

  // A deployment with no indexes is a fact about the deployment, and the
  // caller is pointed at the tool that still works.
  const bare = await runLiteratureSearch({ BERGET_API_TOKEN: "t" }, log, { query: "q" });
  assert.equal(bare.isError, true);
  assert.ok(payloadOf(bare).error.includes("deep_research"));

  // One corpus present, the other absent: search the one that is there and say
  // so about the other.
  const berget = stubBerget();
  try {
    const half = payloadOf(
      await runLiteratureSearch({ BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [arxivRow("2401.1", "A")] }) }, log, {
        query: "q",
      }),
    );
    assert.deepEqual(half.corpora_searched, ["arxiv"]);
    assert.ok(half.notes.some((n) => n.includes("'pubmed' was not searched")));
  } finally {
    berget.restore();
  }
});

test("filters and abstract modes reach the wire", async () => {
  const berget = stubBerget();
  const rows = [
    arxivRow("2401.1", "In window", { category: "cs.CL" }),
    arxivRow("1801.2", "Out of window", { category: "cs.CL" }),
    arxivRow("2402.3", "Wrong field", { category: "math.AG" }),
  ];
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows }) };
  try {
    const payload = payloadOf(
      await runLiteratureSearch(env, log, {
        query: "q",
        corpus: "arxiv",
        since: "2024",
        categories: ["cs"],
        abstract: "none",
      }),
    );
    assert.deepEqual(payload.queries[0].results.map((r) => r.id), ["2401.1"]);
    assert.equal("abstract" in payload.queries[0].results[0], false);
  } finally {
    berget.restore();
  }
});

test("limit bounds each angle and the response stays under the record cap", async () => {
  const berget = stubBerget();
  const rows = Array.from({ length: 40 }, (_, i) => arxivRow(`2401.${1000 + i}`, `Paper ${i}`));
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows }) };
  try {
    const payload = payloadOf(await runLiteratureSearch(env, log, { query: "q", corpus: "arxiv", limit: 3 }));
    assert.equal(payload.queries[0].results.length, 3);

    const wide = payloadOf(
      await runLiteratureSearch(env, log, {
        queries: ["a", "b", "c", "d", "e", "f"],
        corpus: "arxiv",
        limit: 25,
      }),
    );
    const total = wide.queries.reduce((n, g) => n + g.results.length, 0);
    assert.ok(total <= 60, `total ${total} within the response cap`);
  } finally {
    berget.restore();
  }
});

// ---------------------------------------------------------------------------
// literature_fetch
// ---------------------------------------------------------------------------

test("fetch resolves mixed ids in one call and names every miss", async () => {
  const arxiv = fakeIndex({ rows: [arxivRow("2401.11111", "Found paper")] });
  const pubmed = fakeIndex({ rows: [pubmedRow("41610285", "Found trial")] });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv, PUBMED_INDEX: pubmed };
  const result = await runLiteratureFetch(env, log, {
    ids: ["arxiv:2401.11111", "https://pubmed.ncbi.nlm.nih.gov/41610285/", "2405.99999", "not-an-id"],
  });
  assert.equal(result.isError, false);
  const payload = payloadOf(result);
  assert.deepEqual(payload.results.map((r) => r.id).sort(), ["2401.11111", "41610285"]);
  // A key read — no embedding, no cross-encoder, so no relevance question to
  // get wrong.
  assert.equal(arxiv.calls.getByIds, 1);
  assert.deepEqual(arxiv.calls.ids, ["2401.11111", "2405.99999"]);
  assert.deepEqual(pubmed.calls.ids, ["pmid:41610285"]);
  // The miss is named, with the window that explains it.
  assert.deepEqual(payload.not_found.map((m) => m.id), ["2405.99999"]);
  assert.ok(payload.not_found[0].window.includes("2310"));
  assert.deepEqual(payload.unreadable_ids, ["not-an-id"]);
});

test("a failed fetch is reported as retryable, not as absence", async () => {
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ fail: true }) };
  const payload = payloadOf(await runLiteratureFetch(env, log, { ids: ["2401.11111"] }));
  // "Not in the corpus" and "the lookup broke" are different facts and an agent
  // acts differently on them.
  assert.ok(payload.not_found[0].reason.includes("retry"));
  assert.deepEqual(payload.degraded.map((d) => d.corpus), ["arxiv"]);
});

test("fetch with nothing readable explains the accepted id forms", async () => {
  const result = await runLiteratureFetch({ BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() }, log, { ids: ["???"] });
  assert.equal(result.isError, true);
  assert.ok(payloadOf(result).error.includes("PMID"));
});

// ---------------------------------------------------------------------------
// literature_similar
// ---------------------------------------------------------------------------

test("similar searches from the seed's stored vector and excludes the seed", async () => {
  const berget = stubBerget();
  const seed = arxivRow("2401.11111", "Seed paper", { values: VEC() });
  const neighbour = arxivRow("2401.22222", "Neighbour paper");
  // A third row so the neighbour is not the one the stub scores below the floor.
  const arxiv = fakeIndex({ rows: [seed, neighbour, arxivRow("2401.33333", "Distant paper")] });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv };
  try {
    const payload = payloadOf(await runLiteratureSimilar(env, log, { id: "2401.11111", corpus: "arxiv" }));
    // The stored vector is used, so nothing has to be embedded.
    assert.equal(berget.calls.embed, 0);
    assert.ok(payload.notes.some((n) => n.includes("stored passage vector")));
    // A paper is its own nearest neighbour; returning it would waste a slot.
    assert.deepEqual(payload.results.map((r) => r.id), ["2401.22222"]);
    assert.equal(payload.seed.title, "Seed paper");
    // The cross-encoder judges neighbours against the seed's TITLE — a full
    // abstract as the query would push every pair past the served 512-token
    // window and the whole batch would be rejected.
    assert.equal(berget.calls.rerankQueries[0], "Seed paper");
  } finally {
    berget.restore();
  }
});

test("similar falls back to re-embedding when the index returns no vector", async () => {
  const berget = stubBerget();
  const seed = arxivRow("2401.11111", "Seed paper"); // no `values`
  const env = {
    BERGET_API_TOKEN: "t",
    ARXIV_INDEX: fakeIndex({ rows: [seed, arxivRow("2401.22222", "Neighbour"), arxivRow("2401.33333", "Distant")] }),
  };
  try {
    const payload = payloadOf(await runLiteratureSimilar(env, log, { id: "2401.11111", corpus: "arxiv" }));
    assert.equal(berget.calls.embed, 1, "the seed's text is embedded instead");
    assert.ok(payload.notes.some((n) => n.includes("re-embedded")));
    assert.deepEqual(payload.results.map((r) => r.id), ["2401.22222"]);
  } finally {
    berget.restore();
  }
});

test("similar on a paper outside the corpus says so and points at the window", async () => {
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [] }) };
  const result = await runLiteratureSimilar(env, log, { id: "1801.00001" });
  assert.equal(result.isError, true);
  const { error } = payloadOf(result);
  assert.ok(error.includes("2310"), "the coverage window is quoted");
  assert.ok(error.includes("literature_search"), "and a usable next step is offered");

  const bad = await runLiteratureSimilar(env, log, { id: "gibberish" });
  assert.equal(bad.isError, true);
  assert.ok(payloadOf(bad).error.includes("arXiv id"));
});

test("similar crosses the corpus divide when asked for both", async () => {
  const berget = stubBerget();
  const env = {
    BERGET_API_TOKEN: "t",
    ARXIV_INDEX: fakeIndex({ rows: [arxivRow("2401.11111", "Seed", { values: VEC() })] }),
    PUBMED_INDEX: fakeIndex({ rows: [pubmedRow("41610285", "Biomedical application")] }),
  };
  try {
    const payload = payloadOf(await runLiteratureSimilar(env, log, { id: "2401.11111", corpus: "both" }));
    assert.deepEqual(payload.corpora_searched, ["arxiv", "pubmed"]);
    assert.deepEqual(payload.results.map((r) => r.corpus), ["pubmed"]);
  } finally {
    berget.restore();
  }
});

// ---------------------------------------------------------------------------
// literature_corpora
// ---------------------------------------------------------------------------

test("corpora reports live counts, windows and the retrieval semantics", async () => {
  const arxiv = fakeIndex();
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv };
  const payload = payloadOf(await runLiteratureCorpora(env, log));
  assert.equal(payload.corpora.length, 2);
  const [a, p] = payload.corpora;
  assert.equal(a.corpus, "arxiv");
  assert.equal(a.available, true);
  assert.equal(a.vectors_live, 772658);
  assert.equal(arxiv.calls.describe, 1);
  // The absent binding is a described deployment fact, not an error.
  assert.equal(p.available, false);
  assert.ok(p.unavailable_reason.includes("PUBMED_INDEX"));
  // Both windows travel with the answer — they are what a `describe()` cannot
  // tell you and what decides how to read a miss.
  assert.ok(a.coverage_window.includes("2310"));
  assert.ok(p.coverage_window.includes("PMID"));
  assert.ok(payload.retrieval.full_text.includes("Abstracts only"));
  assert.equal(payload.limits.max_queries_per_call, 6);
});

test("a describe that fails still returns the committed facts", async () => {
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ fail: true }) };
  const payload = payloadOf(await runLiteratureCorpora(env, log));
  const arxiv = payload.corpora[0];
  assert.equal(arxiv.vectors_live, null);
  assert.ok(arxiv.describe_error);
  // The fallback figure is still there, so the answer is useful either way.
  assert.equal(arxiv.vectors_at_last_fill, 772658);
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

test("runLiteratureTool routes every name and refuses the unknown one", async () => {
  const berget = stubBerget();
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [arxivRow("2401.1", "A")] }) };
  try {
    for (const [name, args] of [
      ["literature_search", { query: "q" }],
      ["literature_fetch", { ids: ["2401.1"] }],
      ["literature_similar", { id: "2401.1" }],
      ["literature_corpora", {}],
    ]) {
      const result = await runLiteratureTool(env, log, /** @type {string} */ (name), args);
      assert.equal(typeof result.text, "string", `${name} returns text`);
      assert.deepEqual(Object.keys(JSON.parse(result.text)).length > 0, true);
    }
    const unknown = await runLiteratureTool(env, log, "literature_invent", {});
    assert.equal(unknown.isError, true);
  } finally {
    berget.restore();
  }
});
