// Direct tests for the corpus-agnostic dense tier's shared pieces.
//
// The retrieval half (denseSearch / denseRetrieve / rerankMatches) is exercised
// through both callers in src/arxiv-rag.test.js and src/pubmed-rag.test.js,
// which own the binding and fail-soft cases. What had no direct test at all is
// the presentation half — the author line and the abstract cut that BOTH tiers
// hand to the numbered source list. Those exist to be identical across corpora
// (a reader must not be able to tell which tier answered), and a difference
// there is invisible: no error, no failed request, just two source lists that
// quietly stopped matching.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ABSTRACT_CHARS,
  authorsLine,
  citationHighlights,
  denseSearch,
  newRetrievalSpend,
  titleAbstractDoc,
} from "./dense-rag.js";
import { arxivRagItem } from "./arxiv-rag.js";
import { pubmedRagItem } from "./pubmed-rag.js";

test("authorsLine shows three names and abbreviates the rest", () => {
  assert.equal(authorsLine("Ada Lovelace"), "Ada Lovelace");
  assert.equal(authorsLine("A One; B Two; C Three"), "A One, B Two, C Three");
  assert.equal(authorsLine("A One; B Two; C Three; D Four"), "A One, B Two, C Three et al.");
  // Four is the first count that earns "et al." — three names shown, one hidden.
  assert.equal(authorsLine("A; B; C; D; E"), "A, B, C et al.");
});

test("authorsLine yields an empty line rather than a stray separator", () => {
  assert.equal(authorsLine(""), "");
  assert.equal(authorsLine(null), "");
  assert.equal(authorsLine(undefined), "");
  // A trailing or doubled semicolon is common in stored metadata and must not
  // become an empty name, which would render as ", " in the middle of the line.
  assert.equal(authorsLine("A One;; B Two;"), "A One, B Two");
  assert.equal(authorsLine(";;;"), "");
});

test("citationHighlights carries the metadata line alone when there is no abstract", () => {
  assert.deepEqual(citationHighlights("A One · 2026-01-01", ""), ["A One · 2026-01-01"]);
  assert.deepEqual(citationHighlights("meta", null), ["meta"]);
  assert.deepEqual(citationHighlights("meta", "   "), ["meta"]);
});

test("citationHighlights cuts a long abstract and marks the cut", () => {
  const short = "a".repeat(MAX_ABSTRACT_CHARS);
  assert.deepEqual(citationHighlights("meta", short), ["meta", short]);

  const long = "b".repeat(MAX_ABSTRACT_CHARS + 50);
  const [, cut] = citationHighlights("meta", long);
  assert.ok(cut.endsWith("…"), "a cut abstract must say so");
  assert.equal(cut.length, MAX_ABSTRACT_CHARS + 1, "the ellipsis is the only character added");

  // The trailing whitespace is trimmed BEFORE the ellipsis, so a cut landing in
  // a gap does not render as "word …".
  const spaced = `${"c".repeat(MAX_ABSTRACT_CHARS - 1)}  tail`;
  assert.equal(citationHighlights("meta", spaced)[1], `${"c".repeat(MAX_ABSTRACT_CHARS - 1)}…`);
});

test("both hosted tiers cut an abstract at the same length", () => {
  const abstract = "d".repeat(MAX_ABSTRACT_CHARS + 200);
  const arxiv = arxivRagItem({ id: "2601.00001", metadata: { t: "T", a: abstract, au: "A One" } });
  const pubmed = pubmedRagItem({ id: "pmid:41610285", metadata: { t: "T", a: abstract, au: "A One" } });
  assert.ok(arxiv && pubmed);
  assert.equal(arxiv.highlights[1], pubmed.highlights[1]);
  assert.equal(arxiv.highlights[1].length, MAX_ABSTRACT_CHARS + 1);
});

test("both hosted tiers abbreviate an author list the same way", () => {
  const au = "A One; B Two; C Three; D Four";
  const arxiv = arxivRagItem({ id: "2601.00001", metadata: { t: "T", au } });
  const pubmed = pubmedRagItem({ id: "pmid:1", metadata: { t: "T", au } });
  assert.ok(arxiv && pubmed);
  assert.ok(arxiv.highlights[0].startsWith("A One, B Two, C Three et al. · "));
  assert.ok(pubmed.highlights[0].startsWith("A One, B Two, C Three et al. · "));
});

test("titleAbstractDoc joins only the halves that exist", () => {
  assert.equal(titleAbstractDoc({ metadata: { t: "Title", a: "Body" } }), "Title. Body");
  assert.equal(titleAbstractDoc({ metadata: { t: "Title" } }), "Title");
  assert.equal(titleAbstractDoc({ metadata: { a: "Body" } }), "Body");
  // A bare "." would be a document the cross-encoder still has to score.
  assert.equal(titleAbstractDoc({ metadata: {} }), "");
  assert.equal(titleAbstractDoc(null), "");
});

// ---------------------------------------------------------------------------
// The SPEND TALLY — denseSearch's optional `spend` accumulator.
//
// Every leg costs Berget money (the cross-encoder above all), and until this
// existed the /api/chat pipeline ran the tier without ever billing it. The
// tally is what carries the tokens out; src/billing.js prices it.
// ---------------------------------------------------------------------------

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

const denseMatch = (id) => ({ id, score: 0.9, metadata: { t: `Title ${id}`, a: `Abstract ${id}.` } });

/**
 * env + fetch stub for a working dense leg. Berget reports its own token
 * counts, which is what the tier bills on.
 * @param {{ embedTokens?: number, rerankTokens?: number }} [opts]
 */
function denseFixture({ embedTokens = 9, rerankTokens = 10_198 } = {}) {
  const env = {
    BERGET_API_TOKEN: "t",
    BERGET_URL: "https://berget-spend.test/v1",
    INDEX: { async query() { return { matches: [denseMatch("a"), denseMatch("b")] }; } },
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (href.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          data: body.input.map((/** @type {any} */ _, /** @type {number} */ index) => ({
            index,
            embedding: new Array(1024).fill(0.01),
          })),
          usage: { prompt_tokens: embedTokens },
          model: "intfloat/multilingual-e5-large",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (href.endsWith("/rerank")) {
      return new Response(
        JSON.stringify({
          results: body.documents.map((/** @type {any} */ _, /** @type {number} */ index) => ({
            index,
            relevance_score: 0.9 - index * 0.1,
          })),
          usage: { total_tokens: rerankTokens },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch to ${href}`);
  };
  return {
    env,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** @param {any} env */
function searchOpts(env, spend) {
  return {
    index: env.INDEX,
    itemOf: arxivRagItem,
    docOf: titleAbstractDoc,
    tag: "test_rag",
    spend,
  };
}

test("denseSearch folds the leg's embedding and cross-encoder tokens into the tally", async () => {
  const fx = denseFixture();
  try {
    const spend = newRetrievalSpend();
    const items = await denseSearch(fx.env, quietLog, "a question", searchOpts(fx.env, spend));
    assert.ok(items && items.length, "the leg still returns its results");
    assert.equal(spend.rerankTokens, 10_198);
    assert.equal(spend.embedTokens, 9);
    assert.equal(spend.rerankCalls, 1);
    assert.equal(spend.estimatedCalls, 0, "the provider reported the count, so nothing was estimated");
    assert.equal(spend.embedModelId, "intfloat/multilingual-e5-large");
  } finally {
    fx.restore();
  }
});

test("several legs ACCUMULATE into one tally rather than overwriting it", async () => {
  // The shape a chat request produces: several angles, two corpora, more than
  // one search round — all folding into the request's single bucket.
  const fx = denseFixture();
  try {
    const spend = newRetrievalSpend();
    for (let i = 0; i < 3; i++) {
      await denseSearch(fx.env, quietLog, `angle ${i}`, searchOpts(fx.env, spend));
    }
    assert.equal(spend.rerankCalls, 3);
    assert.equal(spend.rerankTokens, 3 * 10_198);
    assert.equal(spend.embedTokens, 3 * 9);
  } finally {
    fx.restore();
  }
});

test("omitting the tally leaves denseSearch exactly as it was — results, no bookkeeping", async () => {
  const fx = denseFixture();
  try {
    const withTally = newRetrievalSpend();
    const a = await denseSearch(fx.env, quietLog, "a question", searchOpts(fx.env, withTally));
    const b = await denseSearch(fx.env, quietLog, "a question", {
      index: fx.env.INDEX,
      itemOf: arxivRagItem,
      docOf: titleAbstractDoc,
      tag: "test_rag",
    });
    assert.deepEqual(b, a, "the returned items do not depend on whether anyone is billing");
  } finally {
    fx.restore();
  }
});

test("a rerank response with no usage block is ESTIMATED rather than dropped", async () => {
  const original = globalThis.fetch;
  const env = {
    BERGET_API_TOKEN: "t",
    BERGET_URL: "https://berget-spend.test/v1",
    INDEX: { async query() { return { matches: [denseMatch("a"), denseMatch("b")] }; } },
  };
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (href.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          data: body.input.map((/** @type {any} */ _, /** @type {number} */ index) => ({
            index,
            embedding: new Array(1024).fill(0.01),
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        results: body.documents.map((/** @type {any} */ _, /** @type {number} */ index) => ({
          index,
          relevance_score: 0.5,
        })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const spend = newRetrievalSpend();
    await denseSearch(env, quietLog, "a question", searchOpts(env, spend));
    assert.ok(spend.rerankTokens > 0, "an unreported count is estimated, never billed as zero");
    assert.equal(spend.estimatedCalls, 1, "and the estimate says so");
    assert.equal(spend.embedTokens, 0, "an embedding call that reported no usage adds nothing");
  } finally {
    globalThis.fetch = original;
  }
});

test("a dead reranker costs nothing and still returns results — accounting never breaks a wave", async () => {
  const original = globalThis.fetch;
  const env = {
    BERGET_API_TOKEN: "t",
    BERGET_URL: "https://berget-spend.test/v1",
    INDEX: { async query() { return { matches: [denseMatch("a"), denseMatch("b")] }; } },
  };
  globalThis.fetch = async (/** @type {any} */ url, /** @type {any} */ init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    if (href.endsWith("/embeddings")) {
      return new Response(
        JSON.stringify({
          data: body.input.map((/** @type {any} */ _, /** @type {number} */ index) => ({
            index,
            embedding: new Array(1024).fill(0.01),
          })),
          usage: { prompt_tokens: 9 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("nope", { status: 503 });
  };
  try {
    const spend = newRetrievalSpend();
    const items = await denseSearch(env, quietLog, "a question", searchOpts(env, spend));
    assert.ok(items && items.length, "the dense order still answers");
    assert.equal(spend.rerankTokens, 0, "what is billed is what a response said");
    assert.equal(spend.embedTokens, 9, "the embedding still happened and is still billed");
  } finally {
    globalThis.fetch = original;
  }
});
