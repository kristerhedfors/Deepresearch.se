// Unit tests for billing.js — the shared split-billing spend math both
// /api/chat (chat.js) and /mcp (mcp.js) call. summarizeSpend is also
// exercised via chat.js's re-export in chat.test.js; here we test the leaf
// module directly and cover exaCost (which had no test before the extraction).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarizeSpend, spendByModel, exaCost, denseSpend } from "./billing.js";
import { RERANK_MODEL, addRerankSpend, mergeRetrievalSpend, newRetrievalSpend } from "./dense-rag.js";
import { CONTENTS_COST_MULTIPLIER } from "./budget.js";

describe("summarizeSpend (via billing.js directly)", () => {
  const state = {
    model: "answer/model",
    jsonModel: "json/model",
    visionModel: "vision/model",
    totals: { prompt_tokens: 1000, completion_tokens: 500 },
    jsonTotals: { prompt_tokens: 200, completion_tokens: 100 },
    visionTotals: { prompt_tokens: 30, completion_tokens: 10 },
  };

  test("sums tokens across all three buckets and prices each at its own rate", () => {
    const catalog = [
      { id: "answer/model", price_in: 2, price_out: 4 },
      { id: "json/model", price_in: 0.1, price_out: 0.2 },
      { id: "vision/model", price_in: 1, price_out: 1 },
    ];
    const spend = summarizeSpend(state, catalog);
    assert.equal(spend.prompt_tokens, 1230);
    assert.equal(spend.completion_tokens, 610);
    // answer: 1000*2 + 500*4 = 4000; json: 200*0.1 + 100*0.2 = 40; vision: 30 + 10 = 40
    assert.equal(spend.berget_cost, 4080);
  });

  test("no catalog yields zero cost, never a throw", () => {
    assert.equal(summarizeSpend(state, null).berget_cost, 0);
  });
});

describe("spendByModel (per-model attribution)", () => {
  const catalog = [
    { id: "answer/model", price_in: 2, price_out: 4 },
    { id: "json/model", price_in: 0.1, price_out: 0.2 },
    { id: "vision/model", price_in: 1, price_out: 1 },
  ];

  test("keeps each model's spend apart instead of folding onto the answer model", () => {
    const state = {
      model: "answer/model",
      jsonModel: "json/model",
      visionModel: "vision/model",
      totals: { prompt_tokens: 1000, completion_tokens: 500 },
      jsonTotals: { prompt_tokens: 200, completion_tokens: 100 },
      visionTotals: { prompt_tokens: 30, completion_tokens: 10 },
    };
    const rows = spendByModel(state, catalog);
    assert.equal(rows.length, 3);
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r]));
    assert.equal(byRole.answer.model, "answer/model");
    assert.equal(byRole.answer.berget_cost, 1000 * 2 + 500 * 4); // 4000
    assert.equal(byRole.json.berget_cost, 200 * 0.1 + 100 * 0.2); // 40
    assert.equal(byRole.vision.berget_cost, 30 * 1 + 10 * 1); // 40
    // The per-model rows must reconcile with the collapsed enforcement total.
    const collapsed = summarizeSpend(state, catalog);
    assert.equal(
      rows.reduce((s, r) => s + r.berget_cost, 0),
      collapsed.berget_cost,
    );
  });

  test("emits only the answer row when the helper buckets never spent", () => {
    const state = {
      model: "answer/model",
      jsonModel: "json/model",
      visionModel: "vision/model",
      totals: { prompt_tokens: 100, completion_tokens: 50 },
      jsonTotals: { prompt_tokens: 0, completion_tokens: 0 },
      visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const rows = spendByModel(state, catalog);
    assert.deepEqual(
      rows.map((r) => r.role),
      ["answer"],
    );
  });

  test("always keeps the answer row even at zero tokens (a search-only reply is still a request)", () => {
    const state = {
      model: "answer/model",
      jsonModel: "json/model",
      visionModel: null,
      totals: { prompt_tokens: 0, completion_tokens: 0 },
      jsonTotals: { prompt_tokens: 10, completion_tokens: 5 },
      visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const rows = spendByModel(state, catalog);
    const roles = rows.map((r) => r.role);
    assert.ok(roles.includes("answer"));
    assert.ok(roles.includes("json"));
    const answer = rows.find((r) => r.role === "answer");
    assert.equal(answer.berget_cost, 0);
  });

  test("no catalog yields zero cost per row, never a throw", () => {
    const state = {
      model: "answer/model",
      jsonModel: "json/model",
      visionModel: "vision/model",
      totals: { prompt_tokens: 1000, completion_tokens: 500 },
      jsonTotals: { prompt_tokens: 0, completion_tokens: 0 },
      visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const rows = spendByModel(state, null);
    assert.equal(rows.every((r) => r.berget_cost === 0), true);
  });
});

describe("exaCost", () => {
  const config = { exa_cost_per_search_eur: 0.005 };

  test("standard-tier searches cost searches * per-search price (no depth multiplier)", () => {
    const state = { plan: { searchDepth: null } };
    assert.equal(exaCost(state, config, 4), 4 * 0.005);
  });

  test("a costlier depth tier scales the per-search price by its cost multiplier", () => {
    const state = { plan: { searchDepth: { costMultiplier: 3 } } };
    assert.equal(exaCost(state, config, 2), 2 * 0.005 * 3);
  });

  test("full-content fetches add the /contents surcharge at the cheaper contents rate", () => {
    const state = { plan: { searchDepth: null }, fetchedUrls: new Set(["a", "b", "c"]) };
    const expected = 2 * 0.005 + 3 * 0.005 * CONTENTS_COST_MULTIPLIER;
    assert.equal(exaCost(state, config, 2), expected);
  });

  test("no searchDepth and no fetchedUrls (the MCP / minimal-request shape) is fine — just the base cost", () => {
    const state = { plan: {} };
    assert.equal(exaCost(state, config, 5), 5 * 0.005);
  });
});

// ---------------------------------------------------------------------------
// denseSpend — the hosted-retrieval bucket
//
// The three buckets above are chat models priced from the chat catalog. This
// fourth one is not: the cross-encoder and the embedder are absent from
// `GET /api/models` (fetchCatalog filters to streaming json_mode text models),
// so they are priced from Berget's RAW /v1/models the way src/rag.js prices an
// embedding call. What is pinned here is that the money arrives, that several
// legs accumulate rather than overwrite, and that every failure direction is
// €0 rather than a throw or an invented price.
// ---------------------------------------------------------------------------

/** The reranker's measured tokens for one 50×900-char leg (docs/MCP-COST.md §1). */
const RERANK_TOKENS_PER_LEG = 10_198;

/** Berget's RAW catalog entries for the two models this tier spends on. */
const RAW_CATALOG = [
  {
    id: RERANK_MODEL,
    model_type: "reranker",
    pricing: { input: 0.1, output: 0, currency: "EUR", unit: "€ / M Token" },
  },
  {
    id: "intfloat/multilingual-e5-large",
    model_type: "embedding",
    pricing: { input: 0.03, output: 0, currency: "EUR", unit: "€ / M Token" },
  },
];
const RERANK_EUR_PER_TOKEN = 0.1 / 1e6;
const EMBED_EUR_PER_TOKEN = 0.03 / 1e6;

/**
 * A fetch stub for Berget's raw catalog.
 * @param {{ fail?: boolean }} [opts]
 */
function stubCatalog({ fail = false } = {}) {
  const calls = { models: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (/** @type {any} */ url) => {
    calls.models++;
    if (String(url).endsWith("/models")) {
      if (fail) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify({ data: RAW_CATALOG }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const denseLog = { info() {}, warn() {}, error() {}, debug() {} };
// berget.js caches the raw catalog in a module-level variable keyed on nothing
// but time, so each test gets its own BERGET_URL only for readability — the
// cache is shared. Tests therefore assert on VALUES, and the one assertion
// about a catalog request being skipped uses the path that returns before
// asking at all.
const denseEnv = () => ({ BERGET_API_TOKEN: "t", BERGET_URL: "https://berget-dense.test/v1" });

describe("denseSpend (the dense-retrieval bucket)", () => {
  // FIRST in the file, deliberately: berget.js caches the raw catalog in a
  // module-level variable for 5 minutes, and nothing resets it, so the only
  // moment a test can observe a COLD lookup is before any other test has
  // warmed it. Both failure directions are asserted here for that reason.
  test("a catalog failure records the TOKENS at €0 rather than throwing or guessing", async () => {
    const spend = newRetrievalSpend();
    addRerankSpend(spend, { rerankTokens: RERANK_TOKENS_PER_LEG, rerankEstimated: true });

    // (a) the catalog answers non-2xx
    const http = stubCatalog({ fail: true });
    try {
      const out = await denseSpend(denseEnv(), denseLog, { denseTotals: spend });
      assert.equal(out.prompt_tokens, RERANK_TOKENS_PER_LEG, "the tokens were still spent");
      assert.equal(out.berget_cost, 0, "no price is ever invented");
      // The attribution row still names the model and its tokens — what is lost
      // is the price, not the record that the work happened.
      assert.deepEqual(out.by_model.map((r) => [r.role, r.prompt_tokens, r.berget_cost]), [
        ["rerank", RERANK_TOKENS_PER_LEG, 0],
      ]);
    } finally {
      http.restore();
    }

    // (b) the request never lands at all. A 503 leaves the cache untouched, so
    // this second lookup is still cold.
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network gone");
    };
    try {
      const out = await denseSpend(denseEnv(), denseLog, { denseTotals: spend });
      assert.equal(out.prompt_tokens, RERANK_TOKENS_PER_LEG);
      assert.equal(out.berget_cost, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("prices the reranker and the embedder from Berget's RAW catalog", async () => {
    const stub = stubCatalog();
    try {
      const spend = newRetrievalSpend();
      spend.rerankTokens = RERANK_TOKENS_PER_LEG;
      spend.rerankCalls = 1;
      spend.embedTokens = 12;
      spend.embedModelId = "intfloat/multilingual-e5-large";
      const out = await denseSpend(denseEnv(), denseLog, { denseTotals: spend });
      assert.equal(out.prompt_tokens, RERANK_TOKENS_PER_LEG + 12);
      assert.equal(
        out.berget_cost,
        RERANK_TOKENS_PER_LEG * RERANK_EUR_PER_TOKEN + 12 * EMBED_EUR_PER_TOKEN,
      );
      assert.ok(out.berget_cost > 0, "the spend is real money, not zero");
      // One attribution row per retrieval model, never folded onto the answer.
      assert.deepEqual(out.by_model.map((r) => r.role), ["rerank", "embed"]);
      assert.equal(out.by_model[0].model, RERANK_MODEL);
      assert.equal(out.by_model[0].completion_tokens, 0, "a reranker emits a score, not tokens");
    } finally {
      stub.restore();
    }
  });

  test("several legs ACCUMULATE — a 12-leg request costs twelve legs, not one", async () => {
    const stub = stubCatalog();
    try {
      const spend = newRetrievalSpend();
      // Two corpora × six angles, the shape a multi-round wave produces.
      for (let i = 0; i < 12; i++) {
        addRerankSpend(spend, { rerankTokens: RERANK_TOKENS_PER_LEG, rerankEstimated: false });
      }
      assert.equal(spend.rerankCalls, 12);
      const out = await denseSpend(denseEnv(), denseLog, { denseTotals: spend });
      assert.equal(out.prompt_tokens, 12 * RERANK_TOKENS_PER_LEG);
      assert.equal(out.berget_cost, 12 * RERANK_TOKENS_PER_LEG * RERANK_EUR_PER_TOKEN);
    } finally {
      stub.restore();
    }
  });

  test("mergeRetrievalSpend folds a source's tally into the request's without overwriting", () => {
    const request = newRetrievalSpend();
    const arxivLeg = { embedTokens: 5, rerankTokens: 100, rerankCalls: 1, estimatedCalls: 0, embedModelId: "e5" };
    const pubmedLeg = { embedTokens: 7, rerankTokens: 200, rerankCalls: 1, estimatedCalls: 1, embedModelId: "e5" };
    mergeRetrievalSpend(request, arxivLeg);
    mergeRetrievalSpend(request, pubmedLeg);
    assert.deepEqual(request, {
      embedTokens: 12,
      rerankTokens: 300,
      rerankCalls: 2,
      estimatedCalls: 1,
      embedModelId: "e5",
    });
    // A source that reports nothing (every source but the two literature legs)
    // must leave the tally untouched rather than throw.
    mergeRetrievalSpend(request, undefined);
    assert.equal(request.rerankTokens, 300);
  });

  test("a request that ran NO dense retrieval records nothing and asks no catalog", async () => {
    const stub = stubCatalog();
    try {
      const out = await denseSpend(denseEnv(), denseLog, { denseTotals: newRetrievalSpend() });
      assert.deepEqual(out, { prompt_tokens: 0, berget_cost: 0, by_model: [] });
      assert.equal(stub.calls.models, 0, "no catalog request for a request that spent nothing");
      // A state with no bucket at all (an older caller) behaves identically.
      assert.deepEqual(await denseSpend(denseEnv(), denseLog, {}), {
        prompt_tokens: 0,
        berget_cost: 0,
        by_model: [],
      });
      assert.equal(stub.calls.models, 0);
    } finally {
      stub.restore();
    }
  });

  test("a model the catalog does not carry is recorded at €0, never at a guess", async () => {
    // The catalog is reachable and warm by now; what is missing is the ENTRY.
    // Same fail-soft direction, different cause — and the one that would bite
    // on the day Berget renames a retrieval model.
    const spend = newRetrievalSpend();
    spend.embedTokens = 40;
    spend.embedModelId = "some/model-berget-does-not-list";
    const out = await denseSpend(denseEnv(), denseLog, { denseTotals: spend });
    assert.equal(out.prompt_tokens, 40);
    assert.equal(out.berget_cost, 0);
  });
});
