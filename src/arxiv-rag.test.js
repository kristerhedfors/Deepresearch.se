// Unit tests for the hosted dense tier of the arXiv source (src/arxiv-rag.js).
//
// The numbers these tests encode came from querying the live index
// (2026-07-26) — see the module header's measurement table. What is pinned
// here is the logic: availability gating, item mapping, the rerank contract,
// and above all the RELEVANCE FLOOR, which is what stops a partial index from
// answering an off-topic question with confident nonsense.
import test from "node:test";
import assert from "node:assert/strict";

import { arxivRagAvailable, arxivRagItem, arxivRagSearch, arxivRerank, arxivRerankDoc } from "./arxiv-rag.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** A Vectorize match shaped like the ones scripts/arxiv-vectorize.mjs writes. */
const match = (id, t, extra = {}) => ({
  id,
  score: 0.85,
  metadata: {
    t,
    a: `Abstract of ${t}.`,
    au: "Ada Lovelace; Alan Turing; Grace Hopper; Barbara Liskov",
    c: "cs.AI",
    d: "2026-07-01",
    ...extra,
  },
});

/** A fake env with an index binding and a scripted rerank response. */
function fakeEnv({ matches = [], rerankScores = null, rerankStatus = 200 } = {}) {
  return {
    BERGET_API_TOKEN: "t",
    ARXIV_INDEX: { async query() { return { matches }; } },
    __rerank: { rerankScores, rerankStatus },
  };
}

// Routes by endpoint: the search path makes a real embeddings call before it
// ever reaches the reranker, so a single blanket response would fail the embed
// and mask whatever the test meant to check.
function stubFetch(env) {
  return async (url) => {
    if (String(url).includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }], usage: {} }), {
        status: 200,
      });
    }
    const { rerankScores, rerankStatus } = env.__rerank || {};
    if (rerankStatus && rerankStatus !== 200) return new Response("no", { status: rerankStatus });
    if (!rerankScores) return new Response("{}", { status: 200 });
    return new Response(
      JSON.stringify({ results: rerankScores.map((s, i) => ({ index: i, relevance_score: s })) }),
      { status: 200 },
    );
  };
}

test("arxivRagAvailable gates on the binding AND the embedder token", () => {
  assert.equal(arxivRagAvailable({ ARXIV_INDEX: {}, BERGET_API_TOKEN: "t" }), true);
  // Removing either switches the tier off rather than breaking anything.
  assert.equal(arxivRagAvailable({ BERGET_API_TOKEN: "t" }), false);
  assert.equal(arxivRagAvailable({ ARXIV_INDEX: {} }), false);
  assert.equal(arxivRagAvailable({}), false);
  assert.equal(arxivRagAvailable(null), false);
});

test("arxivRagItem mirrors the live tier's item shape", async (t) => {
  await t.test("maps metadata into a citable item", () => {
    const item = arxivRagItem(match("2606.30668", "Emergent Culture in Minimal LLM Systems"));
    assert.equal(item.url, "https://arxiv.org/abs/2606.30668");
    assert.equal(item.title, "Emergent Culture in Minimal LLM Systems");
    assert.equal(item.highlights[0], "Ada Lovelace, Alan Turing, Grace Hopper et al. · cs.AI · 2026-07-01 · arXiv:2606.30668");
    assert.ok(item.highlights[1].startsWith("Abstract of"));
  });

  await t.test("junk in → null out", () => {
    assert.equal(arxivRagItem(null), null);
    assert.equal(arxivRagItem({}), null);
    assert.equal(arxivRagItem({ id: "x" }), null);
    assert.equal(arxivRagItem({ id: "", metadata: { t: "T" } }), null);
    assert.equal(arxivRagItem({ id: "1", metadata: { t: "" } }), null);
  });

  await t.test("truncates a long abstract", () => {
    const item = arxivRagItem(match("1", "T", { a: "x".repeat(900) }));
    assert.ok(item.highlights[1].length < 500);
    assert.ok(item.highlights[1].endsWith("…"));
  });
});

test("arxivRerankDoc cuts to the served window", () => {
  const doc = arxivRerankDoc(match("1", "T", { a: "y".repeat(2000) }));
  // Berget serves bge-reranker-v2-m3 behind a 512-token window covering query
  // AND document, so an uncut abstract would fail the whole batch.
  assert.ok(doc.length <= 900, `doc was ${doc.length} chars`);
  assert.ok(doc.startsWith("T."));
  assert.equal(arxivRerankDoc(null), "");
});

test("arxivRerank", async (t) => {
  const realFetch = globalThis.fetch;
  t.afterEach(() => {
    globalThis.fetch = realFetch;
  });

  await t.test("reorders by score and reports that it scored", async () => {
    const env = fakeEnv({ rerankScores: [0.1, 0.9, 0.5] });
    globalThis.fetch = stubFetch(env);
    const ms = [match("a", "A"), match("b", "B"), match("c", "C")];
    const { ordered, scored } = await arxivRerank(env, log, "q", ms);
    assert.equal(scored, true);
    assert.deepEqual(ordered.map((m) => m.id), ["b", "c", "a"]);
    assert.equal(ordered[0].rerankScore, 0.9);
  });

  await t.test("a dead reranker degrades to the dense order, unscored", async () => {
    // docs/ARXIV-RAG.md: a silent fallback here once made an eval report
    // numbers for a pipeline that never ran, so `scored` must say so.
    for (const opts of [{ rerankStatus: 500 }, { rerankScores: [] }, {}]) {
      const env = fakeEnv(opts);
      globalThis.fetch = stubFetch(env);
      const ms = [match("a", "A"), match("b", "B")];
      const { ordered, scored } = await arxivRerank(env, log, "q", ms);
      assert.equal(scored, false, JSON.stringify(opts));
      assert.deepEqual(ordered.map((m) => m.id), ["a", "b"]);
    }
  });

  await t.test("a thrown fetch degrades too", async () => {
    const env = fakeEnv({});
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const { ordered, scored } = await arxivRerank(env, log, "q", [match("a", "A"), match("b", "B")]);
    assert.equal(scored, false);
    assert.equal(ordered.length, 2);
  });

  await t.test("a single candidate needs no rerank call", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error("should not be called");
    };
    const { ordered } = await arxivRerank(fakeEnv({}), log, "q", [match("a", "A")]);
    assert.equal(called, false);
    assert.equal(ordered.length, 1);
  });
});

test("arxivRagSearch", async (t) => {
  const realFetch = globalThis.fetch;
  t.afterEach(() => {
    globalThis.fetch = realFetch;
  });

  await t.test("returns null when the tier is unavailable (live API takes over)", async () => {
    assert.equal(await arxivRagSearch({}, log, "anything"), null);
  });

  await t.test("returns reranked items above the floor", async () => {
    const env = fakeEnv({ matches: [match("a", "A"), match("b", "B")], rerankScores: [0.02, 0.9] });
    globalThis.fetch = stubFetch(env);
    const items = await arxivRagSearch(env, log, "llm agents", { limit: 5 });
    assert.equal(items.length, 2);
    assert.equal(items[0].url, "https://arxiv.org/abs/b");
  });

  // THE case this floor exists for.
  await t.test("an off-topic question returns NOTHING rather than nearest neighbours", async () => {
    // Measured live: "best pizza recipe napoletana dough hydration" against an
    // all-science index scored 0.00002 at the top while the dense cosine was
    // still 0.79. Without a floor those papers would be cited as sources.
    const env = fakeEnv({
      matches: [match("a", "Cardiometabolic Risk Biomarkers"), match("b", "Dataset Distillation")],
      rerankScores: [0.00002, 0.00001],
    });
    globalThis.fetch = stubFetch(env);
    const items = await arxivRagSearch(env, log, "best pizza recipe napoletana dough hydration");
    assert.deepEqual(items, [], "off-topic matches cleared the floor");
  });

  await t.test("weak-but-real relevance survives the floor", async () => {
    // The 0.1 floor tried first rejected these; 0.01 keeps them.
    const env = fakeEnv({
      matches: [match("a", "Unconventional Superconductivity in Graphene"), match("b", "YPtBi Under Pressure")],
      rerankScores: [0.054, 0.025],
    });
    globalThis.fetch = stubFetch(env);
    const items = await arxivRagSearch(env, log, "graphene superconductivity critical temperature");
    assert.equal(items.length, 2);
  });

  await t.test("no floor is applied when the rerank did not score", async () => {
    // Dropping everything on the strength of absent scores would turn a
    // degraded result into no result.
    const env = fakeEnv({ matches: [match("a", "A"), match("b", "B")], rerankStatus: 500 });
    globalThis.fetch = stubFetch(env);
    const items = await arxivRagSearch(env, log, "llm agents");
    assert.equal(items.length, 2);
  });

  await t.test("an empty index reports zero rather than failing", async () => {
    const env = fakeEnv({ matches: [] });
    globalThis.fetch = stubFetch(env);
    assert.deepEqual(await arxivRagSearch(env, log, "llm agents"), []);
  });

  await t.test("a failing index lookup returns null, not an empty result", async () => {
    // null means "tier unavailable → use the live API"; [] would mean "the
    // index genuinely has nothing", which is a different and wrong claim.
    const env = {
      BERGET_API_TOKEN: "t",
      ARXIV_INDEX: {
        async query() {
          throw new Error("vectorize down");
        },
      },
    };
    globalThis.fetch = stubFetch({ __rerank: {} });
    assert.equal(await arxivRagSearch(env, log, "llm agents"), null);
  });

  await t.test("an empty query is not sent anywhere", async () => {
    let queried = false;
    const env = {
      BERGET_API_TOKEN: "t",
      ARXIV_INDEX: {
        async query() {
          queried = true;
          return { matches: [] };
        },
      },
    };
    assert.equal(await arxivRagSearch(env, log, "   "), null);
    assert.equal(queried, false);
  });
});
