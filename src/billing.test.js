// Unit tests for billing.js — the shared split-billing spend math both
// /api/chat (chat.js) and /mcp (mcp.js) call. summarizeSpend is also
// exercised via chat.js's re-export in chat.test.js; here we test the leaf
// module directly and cover exaCost (which had no test before the extraction).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarizeSpend, exaCost } from "./billing.js";
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
