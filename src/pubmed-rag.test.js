// Unit tests for the hosted PubMed dense tier.
//
// The retrieval machinery itself (budgets, rerank fallback, relevance floor) is
// shared with arXiv and is pinned in src/arxiv-rag.test.js against
// src/dense-rag.js. What is tested here is what is PubMed-specific: the
// binding gate, the id convention, the citable item, and — the one that would
// silently change what users see — that a bound index takes precedence over
// the live Europe PMC API while an empty result still falls through to it.

import test from "node:test";
import assert from "node:assert/strict";

import { pubmedPmid, pubmedRagAvailable, pubmedRagItem, pubmedRagSearch, pubmedRerankDoc } from "./pubmed-rag.js";
import { europepmcSearch } from "./europepmc.js";

const log = { info() {}, warn() {}, error() {} };

const match = (pmid, title, extra = {}) => ({
  id: `pmid:${pmid}`,
  score: 0.8,
  metadata: { t: title, a: "We randomised 40 participants across two arms.", au: "Svensson A; Wu L", j: "Nature communications", d: "2026-02-07", ...extra },
});

/** @param {{ matches: any[] }} opts */
function fakeEnv({ matches }) {
  return {
    BERGET_API_TOKEN: "t",
    PUBMED_INDEX: { query: async () => ({ matches }) },
  };
}

/** Embeds, then reranks in the order given. */
function stubFetch(scores) {
  return async (url, init) => {
    if (String(url).includes("/embeddings")) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1024).fill(0.01) }] }), { status: 200 });
    }
    if (String(url).includes("/rerank")) {
      const body = JSON.parse(String(init?.body || "{}"));
      const results = body.documents.map((_, i) => ({ index: i, relevance_score: scores?.[i] ?? 0.9 }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };
}

test("pubmedRagAvailable is gated on BOTH the binding and the embedder key", () => {
  assert.equal(pubmedRagAvailable({ PUBMED_INDEX: {}, BERGET_API_TOKEN: "t" }), true);
  // No binding → the tier is simply off and Europe PMC serves, unchanged.
  assert.equal(pubmedRagAvailable({ BERGET_API_TOKEN: "t" }), false);
  // A binding with no embedder cannot build a query vector, so claiming
  // availability would mean failing every call instead of never being asked.
  assert.equal(pubmedRagAvailable({ PUBMED_INDEX: {} }), false);
  assert.equal(pubmedRagAvailable(undefined), false);
});

test("pubmedPmid strips the vector-id prefix and rejects anything else", () => {
  assert.equal(pubmedPmid("pmid:41610285"), "41610285");
  assert.equal(pubmedPmid(" pmid:1 "), "1");
  assert.equal(pubmedPmid("41610285"), "");
  assert.equal(pubmedPmid("doi:10.1/x"), "");
  assert.equal(pubmedPmid(""), "");
});

test("pubmedRagItem builds the same shape the live tier produces", () => {
  const item = pubmedRagItem(match("41610285", "Ancient DNA from a Neolithic site"));
  assert.equal(item.url, "https://pubmed.ncbi.nlm.nih.gov/41610285/");
  assert.equal(item.title, "Ancient DNA from a Neolithic site");
  assert.equal(item.highlights[0], "Svensson A, Wu L · Nature communications · 2026-02-07 · PMID:41610285");
  assert.equal(item.highlights[1], "We randomised 40 participants across two arms.");
});

test("pubmedRagItem marks a long author list and cuts a long abstract", () => {
  const many = { au: "A B; C D; E F; G H; I J", a: "x".repeat(900) };
  const item = pubmedRagItem(match("1", "T", many));
  assert.match(item.highlights[0], /^A B, C D, E F et al\. · /);
  assert.ok(item.highlights[1].endsWith("…"));
  assert.ok(item.highlights[1].length <= 421);
});

test("pubmedRagItem returns null rather than an untitled or unlinkable source", () => {
  assert.equal(pubmedRagItem({ id: "pmid:1" }), null);
  assert.equal(pubmedRagItem({ id: "pmid:1", metadata: { t: "" } }), null);
  // A vector whose id lost its prefix has no citable URL — dropping it beats
  // emitting a link to https://pubmed.ncbi.nlm.nih.gov//
  assert.equal(pubmedRagItem({ id: "41610285", metadata: { t: "T" } }), null);
});

test("pubmedRerankDoc joins title and abstract inside the served 512-token window", () => {
  assert.equal(pubmedRerankDoc(match("1", "Title")), "Title. We randomised 40 participants across two arms.");
  assert.equal(pubmedRerankDoc({ metadata: { t: "Title", a: "" } }), "Title");
  assert.equal(pubmedRerankDoc({ metadata: {} }), "");
  assert.equal(pubmedRerankDoc({ metadata: { t: "T", a: "x".repeat(2000) } }).length, 900);
});

test("pubmedRagSearch returns citable items from the index", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = stubFetch();
  const env = fakeEnv({ matches: [match("41610285", "A"), match("41610286", "B")] });
  const items = await pubmedRagSearch(env, log, "randomised trial of two arms");
  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://pubmed.ncbi.nlm.nih.gov/41610285/");
});

test("an unbound deployment returns null without touching the network", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("must not be called");
  };
  try {
    assert.equal(await pubmedRagSearch({ BERGET_API_TOKEN: "t" }, log, "x"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("candidates below the relevance floor are dropped, not shown", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  // The floor is what stops a partial corpus answering an off-domain question
  // with its nearest neighbour. This index holds a recent slice of PubMed, so
  // legitimate misses are common and must stay misses.
  globalThis.fetch = stubFetch([0.9, 0.0001]);
  const env = fakeEnv({ matches: [match("1", "A"), match("2", "B")] });
  const items = await pubmedRagSearch(env, log, "q");
  assert.deepEqual(items.map((i) => i.title), ["A"]);
});

test("nothing above the floor reports a miss, so the live API can answer", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = stubFetch([0.00001, 0.00002]);
  const env = fakeEnv({ matches: [match("1", "A"), match("2", "B")] });
  assert.deepEqual(await pubmedRagSearch(env, log, "q"), []);
});

test("europepmcSearch prefers the bound index and never calls Europe PMC", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let europepmcCalls = 0;
  const dense = stubFetch();
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("ebi.ac.uk")) {
      europepmcCalls++;
      return new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 });
    }
    return dense(url, init);
  };
  const env = fakeEnv({ matches: [match("41610285", "Ancient DNA from a Neolithic site")] });
  const res = await europepmcSearch(env, log, "what does ancient DNA say about Neolithic sites");
  assert.equal(europepmcCalls, 0);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].url, "https://pubmed.ncbi.nlm.nih.gov/41610285/");
  assert.deepEqual(res.usedKeys, []);
});

test("an index with nothing above the floor still falls through to Europe PMC", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  // The whole point of the fall-through: a question the recent slice cannot
  // answer must reach the live API rather than return nothing.
  let europepmcCalls = 0;
  const dense = stubFetch([0.00001, 0.00001]);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("ebi.ac.uk")) {
      europepmcCalls++;
      return new Response(
        JSON.stringify({
          resultList: {
            result: [{ id: "1", source: "MED", pmid: "1", title: "Live result", abstractText: "abs", firstPublicationDate: "2009-01-01" }],
          },
        }),
        { status: 200 },
      );
    }
    return dense(url, init);
  };
  const env = fakeEnv({ matches: [match("1", "A"), match("2", "B")] });
  const res = await europepmcSearch(env, log, "a 2009 cohort study of statin adherence");
  assert.ok(europepmcCalls > 0);
  assert.ok(res.usedKeys.length > 0);
});

test("a deployment with no PubMed binding behaves exactly as before", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let europepmcCalls = 0;
  globalThis.fetch = async () => {
    europepmcCalls++;
    return new Response(JSON.stringify({ resultList: { result: [] } }), { status: 200 });
  };
  const res = await europepmcSearch({}, log, "ancient DNA mammoth genome");
  assert.ok(europepmcCalls > 0);
  assert.equal(res.items.length, 0);
});
