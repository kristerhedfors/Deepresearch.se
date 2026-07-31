// Unit tests for the hosted dense tier of the arXiv source (src/arxiv-rag.js).
//
// The numbers these tests encode came from querying the live index
// (2026-07-26) — see the module header's measurement table. What is pinned
// here is the logic: availability gating, item mapping, the rerank contract,
// and above all the RELEVANCE FLOOR, which is what stops a partial index from
// answering an off-topic question with confident nonsense.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { arxivRagAvailable, arxivRagItem, arxivRagSearch, arxivRerank, arxivRerankDoc, arxivSubmitted } from "./arxiv-rag.js";

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
    // The date is the SUBMISSION month off the id (2606 → 2026-06), not the
    // stored `d`, which is the last revision — here 2026-07-01. This fixture
    // is itself the bug: a June paper was being shown as July.
    assert.equal(item.highlights[0], "Ada Lovelace, Alan Turing, Grace Hopper et al. · cs.AI · 2026-06 · arXiv:2606.30668");
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

  // feedback #44 (2026-07-27): "the arXiv searches took close to a minute".
  // This tier runs inside a search wave, so every leg of it must be bounded —
  // and the leg that actually bit was an inherited default, not a slow index.
  await t.test("the embedding call is bounded to THIS tier's budget, not the indexing default", async () => {
    // embedTexts defaults to 60 s because it is sized for document indexing.
    // Inside a search wave that is a minute of the user's time on one hung
    // request, which is exactly what was reported.
    let ms = null;
    const env = fakeEnv({ matches: [match("a", "A")] });
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/embeddings")) {
        // An AbortSignal's remaining budget is not readable, so this half only
        // confirms the call is signalled at all; the ceiling itself is pinned
        // below, where it is stated.
        ms = init?.signal ? "bounded" : null;
        return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    await arxivRagSearch(env, log, "llm agents");
    assert.equal(ms, "bounded");
    // The budget itself is stated in the shared tier (src/dense-rag.js, which
    // both hosted corpora go through), so a later edit that drops it back to
    // the inherited default fails here.
    const src = readFileSync(new URL("./dense-rag.js", import.meta.url), "utf8");
    assert.match(src, /export const EMBED_TIMEOUT_MS = \d{4};/);
    assert.match(src, /embedTexts\(env, \[QUERY_PREFIX \+ text\], \{ timeoutMs: EMBED_TIMEOUT_MS \}\)/);
  });

  await t.test("a hanging index lookup gives up instead of holding the wave", async () => {
    // Vectorize's query takes no abort signal, so the bound is a race.
    const src = readFileSync(new URL("./dense-rag.js", import.meta.url), "utf8");
    assert.match(src, /withTimeout\(\s*index\.query\(qvec, \{ topK: CANDIDATES, returnMetadata: "all" \}\),\s*QUERY_TIMEOUT_MS,/);
  });

  await t.test("the rerank is skipped rather than started when the call is already over budget", async () => {
    // Reranking is worth +15/+17 recall@1 points, but not another 6 s on a
    // call that has already spent its budget — the dense order is the
    // fail-soft result.
    const src = readFileSync(new URL("./dense-rag.js", import.meta.url), "utf8");
    assert.match(src, /spent > TOTAL_BUDGET_MS - RERANK_TIMEOUT_MS/);
    assert.match(src, /\$\{tag\}\.rerank_skipped/);
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

test("arxivSubmitted reads the submission month from the id", () => {
  // The id prefix is the only trustworthy submission date on this corpus:
  // arXiv's <created> tracks the harvest window and the stored `d` is the last
  // revision (docs/ARXIV-RAG.md §3).
  assert.equal(arxivSubmitted("2310.01234"), "2023-10");
  assert.equal(arxivSubmitted("2607.00001"), "2026-07");
  assert.equal(arxivSubmitted(" 2401.99999 "), "2024-01");
  // Old-style pre-2007 ids carry no YYMM — "" so the caller falls back rather
  // than inventing a date.
  assert.equal(arxivSubmitted("cs/0503001"), "");
  assert.equal(arxivSubmitted(""), "");
  assert.equal(arxivSubmitted(null), "");
});

test("arxivRagItem falls back to the stored date when the id carries none", () => {
  const item = arxivRagItem({ id: "cs/0503001", metadata: { t: "Old paper", c: "cs.AI", d: "2024-02-02" } });
  assert.ok(item.highlights[0].includes("2024-02-02"), item.highlights[0]);
});

test("arxivRagItem prefers the submission month over a later revision", () => {
  // The case the widened window makes real: a 2023 paper revised in 2026 must
  // not read as 2026 in the one field the synthesis model uses for freshness.
  const item = arxivRagItem({ id: "2310.00001", metadata: { t: "Older work", c: "cs.LG", d: "2026-07-20" } });
  assert.ok(item.highlights[0].includes("2023-10"), item.highlights[0]);
  assert.ok(!item.highlights[0].includes("2026"), item.highlights[0]);
});

test("the rerank pool stays at Vectorize's measured returnMetadata ceiling", () => {
  // Pinned because it is easy to "restore" to 20 on the strength of the old
  // comment (and of src/rag.js, which still assumes 20). Vectorize raised the
  // returnMetadata:"all" cap to 50; measured over 150 EN+SV needle queries
  // through this exact path, 20 → 50 bought +4.0 points of English recall@10
  // and +2.0 Swedish for no extra round trip and no extra rerank latency.
  // Anything above 50 is rejected by the API unless metadata is dropped.
  const src = readFileSync(new URL("./dense-rag.js", import.meta.url), "utf8");
  const m = /export const CANDIDATES = (\d+);/.exec(src);
  assert.ok(m, "CANDIDATES must be declared as a literal");
  assert.equal(Number(m[1]), 50);
});
