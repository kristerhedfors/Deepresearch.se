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
  runOpenAiFetch,
  runOpenAiSearch,
} from "./literature-run.js";
import { CORPUS_FACTS } from "./literature-tools.js";
import { RERANK_CHARS_PER_TOKEN } from "./dense-rag.js";
import { fakeD1 } from "./test-helpers/d1.js";

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
 * What one leg of the cross-encoder reported against the live endpoint on
 * 2026-08-05, for the exact shape this tier sends (CANDIDATES=50 documents cut
 * to RERANK_DOC_CHARS=900): `usage.total_tokens`. The whole provider cost of the
 * literature family is this number × the number of legs × €0.10/1M
 * (docs/MCP-COST.md §1), so the stub reports it rather than a round number.
 */
const RERANK_TOKENS_PER_LEG = 10_198;

/** What the embedding stub reports for a call, whatever the batch size. */
const EMBED_TOKENS_PER_CALL = 10;

/**
 * Berget's RAW /v1/models entries for the two models this tier spends on.
 * Neither is in the chat catalog (`GET /api/models`) — `fetchCatalog` filters
 * that to streaming json_mode text models — which is exactly why the spend
 * cannot be priced with quota.js's bergetCost and goes through rawModelEntry
 * instead. The `unit` is the one Berget states, so eurPerTokenFromBerget's
 * normalization to EUR-per-token is exercised rather than bypassed.
 */
const RAW_CATALOG = [
  {
    id: "BAAI/bge-reranker-v2-m3",
    model_type: "reranker",
    pricing: { input: 0.1, output: 0, currency: "EUR", unit: "€ / M Token" },
  },
  {
    id: "intfloat/multilingual-e5-large",
    model_type: "embedding",
    pricing: { input: 0.03, output: 0, currency: "EUR", unit: "€ / M Token" },
  },
];
/** EUR per token, as eurPerTokenFromBerget normalizes the entries above. */
const RERANK_EUR_PER_TOKEN = 0.1 / 1e6;
const EMBED_EUR_PER_TOKEN = 0.03 / 1e6;

/**
 * Stub Berget's endpoints. Returns a call ledger so a test can assert that
 * six queries cost one embedding request.
 * @param {{ rerank?: "ok"|"http_error"|"throw", embed?: "ok"|"throw", rerankUsage?: number|null }} [opts]
 *   `rerankUsage: null` drops the `usage` block from the rerank response, which
 *   is the one case the tier has to estimate a token count instead of reading it.
 */
function stubBerget({ rerank = "ok", embed = "ok", rerankUsage = RERANK_TOKENS_PER_LEG, epmc = null, arxiv = null } = {}) {
  const calls = {
    embed: 0,
    rerank: 0,
    models: 0,
    embedInputs: [],
    rerankQueries: [],
    rerankDocChars: [],
    epmc: 0,
    arxiv: 0,
    epmcQueries: [],
    arxivQueries: [],
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);

    // The two LIVE author APIs. Only reachable when a call asks for an author,
    // which is itself worth asserting: a topical search must not touch them.
    if (href.includes("europepmc")) {
      calls.epmc++;
      calls.epmcQueries.push(decodeURIComponent(new URL(href).searchParams.get("query") || ""));
      if (epmc === "throw") throw new Error("europe pmc down");
      if (epmc === "http_error") return new Response("nope", { status: 503 });
      return jsonResponse({ resultList: { result: epmc || [] } });
    }
    if (href.includes("export.arxiv.org")) {
      calls.arxiv++;
      calls.arxivQueries.push(new URL(href).searchParams.get("search_query") || "");
      if (arxiv === "throw") throw new Error("arxiv down");
      return new Response(arxiv || "<feed></feed>", { status: 200 });
    }

    // The raw model catalog, which is how the reranker and the embedder get
    // priced. berget.js caches it for 5 minutes in a module-level variable, so
    // this may well be asked only once across the whole file.
    if (href.endsWith("/models")) {
      calls.models++;
      return jsonResponse({ data: RAW_CATALOG });
    }

    const body = init?.body ? JSON.parse(init.body) : {};
    if (href.endsWith("/embeddings")) {
      calls.embed++;
      calls.embedInputs.push(body.input);
      if (embed === "throw") throw new Error("embedder down");
      return jsonResponse({
        data: body.input.map((_, index) => ({ index, embedding: VEC() })),
        usage: { prompt_tokens: EMBED_TOKENS_PER_CALL },
        model: "intfloat/multilingual-e5-large",
      });
    }
    if (href.endsWith("/rerank")) {
      calls.rerank++;
      calls.rerankQueries.push(body.query);
      calls.rerankDocChars.push(body.documents.reduce((/** @type {number} */ n, d) => n + d.length, 0));
      if (rerank === "throw") throw new Error("reranker down");
      if (rerank === "http_error") return new Response("nope", { status: 503 });
      // Score descending in the order the documents arrived, so the fake's
      // ordering is predictable and the floor is exercised: the last document
      // always scores below RERANK_FLOOR (0.01).
      const n = body.documents.length;
      return jsonResponse({
        results: body.documents.map((_, index) => ({ index, relevance_score: index === n - 1 ? 0.001 : 1 - index * 0.1 })),
        // Berget reports the call's own token count, which is what the tier
        // bills on. Omitted when a test asks for the estimate path.
        ...(rerankUsage === null ? {} : { usage: { total_tokens: rerankUsage } }),
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

test("min_score is honoured BELOW the default floor, which is what rescues a non-English query", async () => {
  const berget = stubBerget();
  const rows = Array.from({ length: 5 }, (_, i) => arxivRow(`2401.${i}`, `Paper ${i}`));
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows }) };
  try {
    // The stub scores 1.0, 0.9, 0.8, 0.7, 0.001 — the last one is the shape of a
    // real Swedish hit: the reranker put it in the right place but scored it
    // 20x-2000x lower than the same question in English, so the 0.01 default
    // drops the correct paper. Clamping min_score UP made that unrecoverable.
    const payload = payloadOf(await runLiteratureSearch(env, log, { query: "q", corpus: "arxiv", min_score: 0.0005 }));
    assert.equal(payload.queries[0].results.length, 5, "a floor below the default must keep the low-scored row");
    assert.equal(payload.stats.relevance_floor, 0.0005, "the applied floor is echoed, so a lowered floor is visible");
    // The score travels with the record, so a caller that lowers the floor can
    // still see how weak the match is rather than trusting the order blindly.
    assert.equal(payload.queries[0].results.at(-1).score, 0.001);
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
  // Asserted against CORPUS_FACTS rather than a literal on purpose: a corpus
  // delta moves that number, and a hard-coded copy here would just have to be
  // edited alongside it — which is the drift, not a guard against it.
  assert.equal(arxiv.vectors_at_last_fill, CORPUS_FACTS.arxiv.vectors_at_fill);
});

// The committed facts are quoted on every miss and every describe, so a corpus
// that grew without them growing tells an agent a paper is out of window when
// it is sitting in the index. Nothing can check them against the LIVE index
// from a unit test — that is what `vectors_live` is for — but the two halves
// that must not disagree with each other can be pinned: the upper bound the
// arXiv window advertises, and the month the ingest actually reached.
test("the arXiv window's upper bound matches the recorded fill", () => {
  const { window: win, vectors_at_fill } = CORPUS_FACTS.arxiv;
  const bound = win.match(/months\s+(\d{4})[–-](\d{4})/);
  assert.ok(bound, `the arXiv window no longer states a month range: ${win}`);
  const [, from, to] = bound;
  assert.equal(from, "2310", "the corpus start is a fixed historical fact");
  assert.ok(Number(to) > Number(from), "the window's upper bound must be after its start");
  // Not a magic number: it is the figure `node scripts/arxiv-window.mjs`
  // measured off the live index, and the pair moves together or not at all.
  assert.equal(vectors_at_fill, 823097, "update BOTH the window and the fill after an ingest");
  // 2607, NOT the 2608 delta marker in docs/ARXIV-RAG.md §1 — and the gap is
  // the point rather than an oversight. The marker records how far the last
  // sweep REACHED; this window records how far the index is actually DENSE.
  // 2608 was cut mid-month and holds 4,168 papers against a ~25,000 norm, so
  // advertising it as covered would promise a month that is 16% there.
  assert.equal(to, "2607", "the window ends at the last FULLY swept month, not at the delta marker");
  // The band is not the whole index any more. Named-list fills reach back
  // thirty years, and a window sentence that mentions only the band is the
  // exact drift this pair of numbers exists to catch — so require the
  // out-of-band material to be stated too.
  assert.match(win, /OUTSIDE that band/, "the window must state the out-of-band material, not only the band");
  assert.match(win, /NOT proof/, "a pre-band miss must not be presented as proof of absence");
});

// ---------------------------------------------------------------------------
// search / fetch — the ChatGPT adapters (docs/MCP-CONNECTOR.md §2a)
// ---------------------------------------------------------------------------

test("search projects one angle over both corpora into ChatGPT's shape", async () => {
  const berget = stubBerget();
  // Three rows per corpus: the stub scores the LAST document below the floor,
  // so two of each survive.
  const arxiv = fakeIndex({
    rows: [arxivRow("2401.11111", "Dense retrieval"), arxivRow("2401.22222", "Reranking"), arxivRow("2401.33333", "Dropped")],
  });
  const pubmed = fakeIndex({
    rows: [pubmedRow("41610285", "A trial"), pubmedRow("41610286", "A cohort"), pubmedRow("41610287", "Dropped")],
  });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv, PUBMED_INDEX: pubmed };
  try {
    const result = await runOpenAiSearch(env, log, { query: "how does dense retrieval work" });
    assert.equal(result.isError, false);
    // The adapter is THIN: one angle, one embedding call, the same dense tier.
    assert.equal(berget.calls.embed, 1);
    assert.equal(arxiv.calls.query, 1);
    assert.equal(pubmed.calls.query, 1);

    // THE dual return — the payload as an object AND as the text of the
    // content array, byte-identical because it is one serialization.
    assert.equal(result.structured, true);
    assert.deepEqual(JSON.parse(result.text), result.payload);

    // ChatGPT's fixed shape: `results`, each row exactly id/title/url.
    assert.deepEqual(Object.keys(result.payload), ["results"]);
    assert.equal(result.payload.results.length, 4);
    for (const row of result.payload.results) assert.deepEqual(Object.keys(row).sort(), ["id", "title", "url"]);
    // Both corpora reached the caller, each with a prefixed id.
    const ids = result.payload.results.map((r) => r.id);
    assert.ok(ids.some((i) => i.startsWith("arxiv:")), "arXiv ids are prefixed");
    assert.ok(ids.some((i) => i.startsWith("pmid:")), "PMIDs are prefixed");
  } finally {
    berget.restore();
  }
});

test("an id from search round-trips into fetch", async () => {
  // The only property that makes the pair usable: whatever `search` handed out
  // must be readable by `fetch` without the client editing it. Pinned end to
  // end rather than by inspecting the id format, because the format is an
  // implementation detail and the round trip is the contract.
  const berget = stubBerget();
  const arxiv = fakeIndex({ rows: [arxivRow("2401.11111", "Dense retrieval"), arxivRow("2401.22222", "Below the floor")] });
  const pubmed = fakeIndex({ rows: [pubmedRow("41610285", "A trial"), pubmedRow("41610286", "Below the floor")] });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: arxiv, PUBMED_INDEX: pubmed };
  try {
    const found = (await runOpenAiSearch(env, log, { query: "q" })).payload.results;
    assert.equal(found.length, 2);
    for (const row of found) {
      const doc = await runOpenAiFetch(env, log, { id: row.id });
      assert.equal(doc.isError, false, `${row.id} resolves`);
      assert.equal(doc.payload.id, row.id, "and comes back under the same id");
      assert.equal(doc.payload.title, row.title);
      assert.equal(doc.payload.url, row.url);
      assert.ok(doc.payload.text.length > 0);
    }
  } finally {
    berget.restore();
  }
});

test("fetch returns the stored abstract, labelled as an abstract", async () => {
  const env = {
    BERGET_API_TOKEN: "t",
    PUBMED_INDEX: fakeIndex({ rows: [pubmedRow("41610285", "A trial", { abstract: "BACKGROUND: a finding." })] }),
  };
  const result = await runOpenAiFetch(env, log, { id: "pmid:41610285" });
  assert.equal(result.structured, true);
  assert.deepEqual(JSON.parse(result.text), result.payload);
  assert.deepEqual(Object.keys(result.payload).sort(), ["id", "metadata", "text", "title", "url"]);
  assert.equal(result.payload.text, "BACKGROUND: a finding.");
  // There is no full text in either index and no runtime path that could get
  // it, so the payload says what `text` is rather than letting a caller assume.
  assert.match(result.payload.metadata.text_is, /no full text/);

  // A bare id and a source URL are accepted too — a citation arrives in
  // whatever form the thing that cited it used.
  for (const id of ["41610285", "https://pubmed.ncbi.nlm.nih.gov/41610285/"]) {
    const alt = await runOpenAiFetch(env, log, { id });
    assert.equal(alt.payload.id, "pmid:41610285", `${id} normalizes to the canonical id`);
  }
});

test("a fetch miss keeps the shape and explains itself", async () => {
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [] }) };
  const result = await runOpenAiFetch(env, log, { id: "arxiv:1801.00001" });
  assert.equal(result.isError, true);
  // Still a document, not an error string: a client that asked for a document
  // and got something else reports a broken server rather than a missing paper.
  for (const key of ["id", "title", "text", "url"]) assert.ok(key in result.payload, `${key} present`);
  assert.equal(result.payload.url, "https://arxiv.org/abs/1801.00001");
  assert.match(result.payload.text, /2310/, "the coverage window explains the miss");

  const unreadable = await runOpenAiFetch(env, log, { id: "???" });
  assert.equal(unreadable.isError, true);
  assert.match(unreadable.payload.text, /pmid:/);
});

test("search keeps its shape when the retrieval underneath fails", async () => {
  const berget = stubBerget({ embed: "throw" });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() };
  try {
    const dead = await runOpenAiSearch(env, log, { query: "q" });
    assert.equal(dead.isError, true);
    // `results` is present and empty rather than replaced by an error string —
    // the failure is reported inside the shape the client is parsing.
    assert.deepEqual(dead.payload.results, []);
    assert.ok(dead.payload.error);
    assert.deepEqual(JSON.parse(dead.text), dead.payload);
  } finally {
    berget.restore();
  }

  const empty = await runOpenAiSearch({ BERGET_API_TOKEN: "t" }, log, {});
  assert.equal(empty.isError, true);
  assert.deepEqual(empty.payload.results, []);
  assert.match(empty.payload.error, /query/);
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
      ["literature_fetch", { ids: ["2401.11111"] }],
      ["literature_similar", { id: "2401.1" }],
      ["literature_corpora", {}],
      // The adapters ride the same dispatch, so src/mcp.js needs one dynamic
      // import and one branch rather than two of each.
      ["search", { query: "q" }],
      ["fetch", { id: "2401.11111" }],
    ]) {
      const result = await runLiteratureTool(env, log, /** @type {string} */ (name), args);
      assert.equal(typeof result.text, "string", `${name} returns text`);
      assert.deepEqual(Object.keys(JSON.parse(result.text)).length > 0, true);
      // Only the adapters ask for the dual return; the native tools stay
      // text-only, which is what every existing client reads them as.
      assert.equal(
        result.structured === true,
        name === "search" || name === "fetch",
        `${name} declares structured output only if it has an outputSchema`,
      );
    }
    const unknown = await runLiteratureTool(env, log, "literature_invent", {});
    assert.equal(unknown.isError, true);
  } finally {
    berget.restore();
  }
});

// ---------------------------------------------------------------------------
// The AUTHOR leg.
//
// The failure this exists for: an MCP client asked for a named
// palaeogeneticist's body of work and every tool answered as if the corpus were
// empty. It was not — his own group's papers came back, with his name cut out
// of the stored metadata. src/literature-authors.js has the full account; these
// pin the runner behaviour that must not regress.
// ---------------------------------------------------------------------------

/** One Europe PMC core record in the shape the live API returns. */
function epmcRecord(pmid, title, extra = {}) {
  return {
    pmid,
    doi: extra.doi ?? `10.1000/${pmid}`,
    title,
    authorList: { author: (extra.authors ?? ["Dehasque M", "Dalén L"]).map((fullName) => ({ fullName })) },
    firstPublicationDate: extra.date ?? "2025-09-24",
    journalInfo: { journal: { title: extra.journal ?? "Nature" } },
    abstractText: extra.abstract ?? `About ${title}.`,
    citedByCount: extra.cited ?? 42,
  };
}

/** An arXiv Atom feed with one entry. */
function arxivFeed(id, title, authors = ["Love Dalén"]) {
  return `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
    <id>https://arxiv.org/abs/${id}v1</id>
    <title>${title}</title>
    <summary>An abstract.</summary>
    <published>2024-12-09T10:00:00Z</published>
    ${authors.map((a) => `<author><name>${a}</name></author>`).join("")}
    <category term="q-bio.PE"/>
  </entry></feed>`;
}

test("an explicit `authors` argument runs the live author lookup and returns links", async () => {
  const berget = stubBerget({
    epmc: [epmcRecord("40994021", "Long-term mammoth hybridization")],
    arxiv: arxivFeed("2412.06521", "Ancient DNA from Lycoptera"),
  });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex(), PUBMED_INDEX: fakeIndex() };
  try {
    const result = await runLiteratureSearch(env, log, { authors: ["Love Dalén"] });
    const payload = payloadOf(result);
    assert.equal(result.isError, false);

    const group = payload.authors[0];
    assert.equal(group.name, "Love Dalén");
    assert.equal(group.count, 2, "both corpora contributed");
    // The links are the deliverable — the reported failure was their absence.
    assert.deepEqual(
      group.results.map((r) => r.url).sort(),
      ["https://arxiv.org/abs/2412.06521", "https://pubmed.ncbi.nlm.nih.gov/40994021/"],
    );
    // And the FULL author list, which the stored metadata truncates away.
    assert.deepEqual(
      group.results.find((r) => r.corpus === "pubmed").authors,
      ["Dehasque M", "Dalén L"],
    );
    assert.equal(payload.stats.author_records, 2);
  } finally {
    berget.restore();
  }
});

test("`authors` alone is a complete request — no query needed", async () => {
  // Before this, a call with no `queries` was refused outright, which rejected
  // exactly the shape the hosted index cannot serve.
  const berget = stubBerget({ epmc: [epmcRecord("1", "A paper")] });
  const env = { BERGET_API_TOKEN: "t", PUBMED_INDEX: fakeIndex() };
  try {
    const result = await runLiteratureSearch(env, log, { authors: ["Love Dalén"], corpus: "pubmed" });
    assert.equal(result.isError, false);
    assert.equal(payloadOf(result).authors[0].count, 1);
    // No angles means no embedding call at all.
    assert.equal(berget.calls.embed, 0);
  } finally {
    berget.restore();
  }
});

test("an authorship QUESTION is detected when no `authors` argument is passed", async () => {
  const berget = stubBerget({ epmc: [epmcRecord("1", "A paper")] });
  const env = { BERGET_API_TOKEN: "t", PUBMED_INDEX: fakeIndex({ rows: [pubmedRow("9", "Something else")] }) };
  try {
    const result = await runLiteratureSearch(env, log, { query: "papers by Love Dalén", corpus: "pubmed" });
    const payload = payloadOf(result);
    assert.equal(payload.stats.authors_looked_up[0], "Love Dalén");
    assert.ok(
      payload.notes.some((n) => n.includes("read out of the query text")),
      "and the response says the name was inferred rather than given",
    );
  } finally {
    berget.restore();
  }
});

test("a topical search never touches the live author APIs", async () => {
  const berget = stubBerget();
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [arxivRow("2401.1", "A")] }) };
  try {
    await runLiteratureSearch(env, log, { query: "mammoth population genomics", corpus: "arxiv" });
    assert.equal(berget.calls.epmc, 0);
    assert.equal(berget.calls.arxiv, 0);
  } finally {
    berget.restore();
  }
});

test("query terms are ANDed onto the author query — the disambiguation lever", async () => {
  const berget = stubBerget({ epmc: [], arxiv: "" });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex(), PUBMED_INDEX: fakeIndex() };
  try {
    await runLiteratureSearch(env, log, { authors: ["Love Dalén"], queries: ["mammoth genomics"] });
    const q = berget.calls.epmcQueries[0];
    assert.ok(q.includes('AUTH:"Love Dalén"'), q);
    assert.ok(q.includes('AUTH:"Dalén L"'), "and the indexed Surname-Initial form");
    assert.ok(q.includes("mammoth"), "narrowed by the topic");
    assert.ok(berget.calls.arxivQueries[0].includes('au:"Love Dalén"'));
  } finally {
    berget.restore();
  }
});

test("both sort orders are fetched, so 'body of work' means most-cited not just newest", async () => {
  const berget = stubBerget({ epmc: [epmcRecord("1", "A paper")] });
  const env = { BERGET_API_TOKEN: "t", PUBMED_INDEX: fakeIndex() };
  try {
    await runLiteratureSearch(env, log, { authors: ["Love Dalén"], corpus: "pubmed" });
    assert.equal(berget.calls.epmc, 2, "one CITED pass and one date pass");
  } finally {
    berget.restore();
  }
});

test("a dead author API degrades the call instead of failing it", async () => {
  const berget = stubBerget({ epmc: "throw", arxiv: "throw" });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [arxivRow("2401.1", "A")] }) };
  try {
    const result = await runLiteratureSearch(env, log, {
      queries: ["mammoth genomics"],
      authors: ["Love Dalén"],
      corpus: "arxiv",
    });
    assert.equal(result.isError, false, "the dense half still answered");
    const payload = payloadOf(result);
    assert.ok(payload.queries[0].count > 0, "and returned its records");
    assert.ok(payload.notes.some((n) => n.includes("No papers were found")));
  } finally {
    berget.restore();
  }
});

test("a dead embedder still returns the author records, and says the rest is missing", async () => {
  const berget = stubBerget({ embed: "throw", epmc: [epmcRecord("1", "A paper")] });
  const env = { BERGET_API_TOKEN: "t", PUBMED_INDEX: fakeIndex() };
  try {
    const result = await runLiteratureSearch(env, log, {
      queries: ["mammoth genomics"],
      authors: ["Love Dalén"],
      corpus: "pubmed",
    });
    assert.equal(result.isError, false);
    const payload = payloadOf(result);
    assert.equal(payload.authors[0].count, 1);
    assert.ok(payload.notes.some((n) => n.includes("semantic half of this call could not run")));
  } finally {
    berget.restore();
  }
});

test("a dead embedder with NO author leg is still a hard error", async () => {
  // The prior contract, unchanged: nothing to return means an error the caller
  // can act on rather than an empty success.
  const berget = stubBerget({ embed: "throw" });
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex() };
  try {
    const result = await runLiteratureSearch(env, log, { query: "mammoth genomics", corpus: "arxiv" });
    assert.equal(result.isError, true);
  } finally {
    berget.restore();
  }
});

test("the author leg carries the caveats a caller needs to read it correctly", async () => {
  const berget = stubBerget({ epmc: [epmcRecord("1", "A paper")] });
  const env = { BERGET_API_TOKEN: "t", PUBMED_INDEX: fakeIndex() };
  try {
    const payload = payloadOf(await runLiteratureSearch(env, log, { authors: ["Love Dalén"], corpus: "pubmed" }));
    const notes = payload.notes.join(" ");
    assert.ok(notes.includes("LIVE"), "says these records did not come from the hosted index");
    assert.ok(notes.includes("truncated"), "and why the index could not have answered");
    assert.ok(notes.includes("not unique"), "and that a shared surname is not resolved");
  } finally {
    berget.restore();
  }
});

test("`search` explains an empty result instead of returning a bare []", async () => {
  // THE reported failure: `{"results":[]}` with nothing to explain it, which a
  // client model reads as "the corpus is empty" — so it stops searching.
  const berget = stubBerget();
  const env = { BERGET_API_TOKEN: "t", ARXIV_INDEX: fakeIndex({ rows: [] }) };
  try {
    const result = await runOpenAiSearch(env, log, { query: "nothing matches this" });
    const payload = payloadOf(result);
    assert.deepEqual(payload.results, [], "the required shape is preserved");
    assert.equal(result.isError, false, "an empty result is not an error");
    assert.ok(payload.note.includes("authors"), "and it names the tool that CAN answer authorship");
    assert.ok(payload.note.includes("literature_corpora"));
  } finally {
    berget.restore();
  }
});

test("`search` surfaces author records too, so a person query returns links", async () => {
  const berget = stubBerget({ epmc: [epmcRecord("40994021", "Mammoth hybridization")] });
  const env = { BERGET_API_TOKEN: "t", PUBMED_INDEX: fakeIndex({ rows: [] }) };
  try {
    const payload = payloadOf(await runOpenAiSearch(env, log, { query: "papers by Love Dalén" }));
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].url, "https://pubmed.ncbi.nlm.nih.gov/40994021/");
    // The id round-trips through `fetch`, which is the contract that makes a
    // search result actionable rather than decorative.
    assert.equal(payload.results[0].id, "pmid:40994021");
  } finally {
    berget.restore();
  }
});

// ---------------------------------------------------------------------------
// METERING — the spend that reaches the quota.
//
// These tools were GATED on the four-window research quota from the day they
// shipped and never INCREMENTED it, so they could not exhaust it: a key that
// only called literature_search was unmetered at €0.0021–€0.0124 a call
// (docs/MCP-COST.md §4b). What is pinned here is the whole of that fix — that a
// metered call records, that it records the PROVIDER'S OWN token counts rather
// than a guess, that the deliberately exempt tools still record nothing, and
// that no failure in any of it can reach the tool result (invariant 2).
// ---------------------------------------------------------------------------

const USAGE_INSERT = /INSERT INTO usage_events/;
const MODEL_INSERT = /INSERT INTO usage_model_events/;
const billing = { identity: { id: "u-42" }, requestId: "req-1" };

/** The bindings recordUsage writes, by name. */
function usageRow(db) {
  const [call] = db.callsMatching(USAGE_INSERT);
  if (!call) return null;
  const [user_id, ts, model, prompt_tokens, completion_tokens, searches, berget_cost, exa_cost, duration_ms] =
    call.bindings;
  return { user_id, ts, model, prompt_tokens, completion_tokens, searches, berget_cost, exa_cost, duration_ms };
}

/** The per-model attribution rows, by role. */
function modelRows(db) {
  return Object.fromEntries(
    db.callsMatching(MODEL_INSERT).map((c) => {
      const [request_id, user_id, ts, role, model, prompt_tokens, completion_tokens, berget_cost] = c.bindings;
      return [role, { request_id, user_id, ts, model, prompt_tokens, completion_tokens, berget_cost }];
    }),
  );
}

/** Three rows per corpus — the fake scores the LAST one below the floor. */
function meteringEnv(db) {
  return {
    BERGET_API_TOKEN: "t",
    DB: db,
    ARXIV_INDEX: fakeIndex({
      rows: [
        arxivRow("2401.11111", "Kept"),
        arxivRow("2401.22222", "Also kept"),
        arxivRow("2401.33333", "Dropped"),
      ],
    }),
    PUBMED_INDEX: fakeIndex({
      rows: [pubmedRow("41610285", "Kept"), pubmedRow("41610286", "Also kept"), pubmedRow("41610287", "Dropped")],
    }),
  };
}

test("a literature_search records what it spent, priced from Berget's raw catalog", async () => {
  const berget = stubBerget();
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    const result = await runLiteratureTool(env, log, "literature_search", { query: "q" }, billing);
    assert.equal(result.isError, false);
    // One angle over both corpora: one embed, two cross-encoder legs — the
    // shape docs/MCP-COST.md prices at €0.0021.
    assert.equal(berget.calls.embed, 1);
    assert.equal(berget.calls.rerank, 2);

    const row = usageRow(db);
    assert.ok(row, "the enforcement row is written");
    assert.equal(row.user_id, "u-42");
    // The reranker is what the money went to, so it is what the enforcement
    // row names — the per-model split lives in the attribution ledger below.
    assert.equal(row.model, "BAAI/bge-reranker-v2-m3");
    assert.equal(row.prompt_tokens, 2 * RERANK_TOKENS_PER_LEG + EMBED_TOKENS_PER_CALL);
    assert.equal(row.completion_tokens, 0);

    // The EUR figure is the one quotaExceeded compares against budget_eur, so
    // it has to be in the same units as every other berget_cost: EUR, per
    // token, normalized from Berget's "€ / M Token".
    const expected =
      2 * RERANK_TOKENS_PER_LEG * RERANK_EUR_PER_TOKEN + EMBED_TOKENS_PER_CALL * EMBED_EUR_PER_TOKEN;
    assert.ok(Math.abs(row.berget_cost - expected) < 1e-12, `${row.berget_cost} ≈ ${expected}`);
    // …and it lands where the measurement said it would.
    assert.ok(row.berget_cost > 0.002 && row.berget_cost < 0.0021, "≈ €0.0021 for one angle over both corpora");

    // Exa's two columns stay Exa's: these are not searches and they cost no
    // Exa money, and a count calibrated to €0.005 searches must not absorb them.
    assert.equal(row.searches, 0);
    assert.equal(row.exa_cost, 0);
    assert.ok(row.duration_ms >= 0);

    // Attribution: one row per model that actually spent.
    const rows = modelRows(db);
    assert.deepEqual(Object.keys(rows).sort(), ["embed", "rerank"]);
    assert.equal(rows.rerank.model, "BAAI/bge-reranker-v2-m3");
    assert.equal(rows.rerank.prompt_tokens, 2 * RERANK_TOKENS_PER_LEG);
    assert.equal(rows.embed.model, "intfloat/multilingual-e5-large");
    assert.equal(rows.embed.prompt_tokens, EMBED_TOKENS_PER_CALL);
    assert.equal(rows.rerank.request_id, "req-1");
  } finally {
    berget.restore();
  }
});

test("the token count is the provider's own, not one inferred from the documents", async () => {
  // Requirement in order of preference: measured beats estimated. Berget's
  // /v1/rerank reports usage.total_tokens for the exact shape this tier sends,
  // and the fake's documents are far shorter than 900 chars — so a recorded
  // count that matched the documents' length would prove the report was ignored.
  const berget = stubBerget();
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    await runLiteratureTool(env, log, "literature_search", { query: "q", corpus: "arxiv" }, billing);
    const rows = modelRows(db);
    assert.equal(rows.rerank.prompt_tokens, RERANK_TOKENS_PER_LEG);
    const estimateWouldBe = Math.round(berget.calls.rerankDocChars[0] / RERANK_CHARS_PER_TOKEN);
    assert.notEqual(rows.rerank.prompt_tokens, estimateWouldBe);
  } finally {
    berget.restore();
  }
});

test("a rerank response with no usage block falls back to a stated estimate", async () => {
  // The only case where a count is guessed. The ratio is derived from the one
  // live measurement (45,000 document chars → 10,198 tokens), so the fallback
  // is traceable rather than invented — and it must still bill something,
  // because the tokens were spent whether or not the response mentioned them.
  const berget = stubBerget({ rerankUsage: null });
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    await runLiteratureTool(env, log, "literature_search", { query: "q", corpus: "arxiv" }, billing);
    const rows = modelRows(db);
    assert.equal(rows.rerank.prompt_tokens, Math.round(berget.calls.rerankDocChars[0] / RERANK_CHARS_PER_TOKEN));
    assert.ok(rows.rerank.prompt_tokens > 0);
  } finally {
    berget.restore();
  }
});

test("`search` meters exactly like literature_search — the adapter is no way around it", async () => {
  const berget = stubBerget();
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    const result = await runLiteratureTool(env, log, "search", { query: "q" }, billing);
    assert.equal(result.isError, false);
    const row = usageRow(db);
    assert.ok(row, "the projection records its inner call's spend");
    assert.equal(row.prompt_tokens, 2 * RERANK_TOKENS_PER_LEG + EMBED_TOKENS_PER_CALL);
    // One row, not two: the adapter and the search underneath it are one call.
    assert.equal(db.callsMatching(USAGE_INSERT).length, 1);
  } finally {
    berget.restore();
  }
});

test("literature_similar records its retrieval too", async () => {
  const berget = stubBerget();
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    const result = await runLiteratureTool(env, log, "literature_similar", { id: "2401.11111", corpus: "arxiv" }, billing);
    assert.equal(result.isError, false);
    const row = usageRow(db);
    assert.ok(row);
    // The fake rows carry no stored vector, so this call also re-embeds the
    // seed's title and abstract — both legs are billed.
    assert.equal(row.prompt_tokens, RERANK_TOKENS_PER_LEG + EMBED_TOKENS_PER_CALL);
  } finally {
    berget.restore();
  }
});

test("the two exempt tools record nothing at all", async () => {
  // literature_fetch is a Vectorize key read and literature_corpora is
  // committed facts plus describe(): no embedder, no cross-encoder, no money.
  // They sit outside the quota GATE on purpose — an agent out of budget must
  // still be able to resolve an id it was handed — and the meter has to match
  // the gate, or the exemption becomes a hole in one direction or a lie in the
  // other. `fetch` is literature_fetch's projection and inherits it.
  const berget = stubBerget();
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    for (const [name, args] of [
      ["literature_fetch", { ids: ["2401.11111"] }],
      ["literature_corpora", {}],
      ["fetch", { id: "2401.11111" }],
    ]) {
      const result = await runLiteratureTool(env, log, /** @type {string} */ (name), args, billing);
      assert.equal(typeof result.text, "string", `${name} still answers`);
    }
    assert.equal(db.callsMatching(USAGE_INSERT).length, 0, "no enforcement row");
    assert.equal(db.callsMatching(MODEL_INSERT).length, 0, "no attribution row");
    assert.equal(berget.calls.rerank, 0, "and nothing was spent to record");
  } finally {
    berget.restore();
  }
});

test("a call that spends nothing writes no row — an argument error is not a request", async () => {
  const berget = stubBerget();
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    const result = await runLiteratureTool(env, log, "literature_search", {}, billing);
    assert.equal(result.isError, true, "no query and no author is refused");
    assert.equal(db.callsMatching(USAGE_INSERT).length, 0);
  } finally {
    berget.restore();
  }
});

test("recording is fail-soft: a dead ledger never touches the tool result", async () => {
  // Invariant 2 in its strictest form. The accounting runs in a `finally`, so a
  // D1 outage there would otherwise replace a perfectly good answer with an
  // accounting error the agent can do nothing about.
  const berget = stubBerget();
  const db = fakeD1().failOn(/INSERT INTO usage/, "D1_ERROR: ledger down");
  const env = meteringEnv(db);
  try {
    const result = await runLiteratureTool(env, log, "literature_search", { query: "q" }, billing);
    assert.equal(result.isError, false, "the answer survives a failed recording");
    assert.equal(payloadOf(result).queries[0].results.length, 4, "and is complete");
    // It tried, which is the difference between fail-soft and never-attempted.
    assert.ok(db.ran(USAGE_INSERT));
  } finally {
    berget.restore();
  }
});

test("no identity means nothing is charged, and the tool still answers", async () => {
  // The direct-call shape every other test in this file uses, pinned so it
  // stays a supported path rather than an accident: there is nobody to bill.
  const berget = stubBerget();
  const db = fakeD1();
  const env = meteringEnv(db);
  try {
    const result = await runLiteratureTool(env, log, "literature_search", { query: "q" });
    assert.equal(result.isError, false);
    assert.equal(db.callsMatching(USAGE_INSERT).length, 0);
  } finally {
    berget.restore();
  }
});
