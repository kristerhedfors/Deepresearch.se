// Unit tests for chat.js's pure exports: summarizeSpend (split billing),
// resolveJsonModel (JSON-phase routing), quotaBlockedResponse (429 payload).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { quotaBlockedResponse, resolveJsonModel, summarizeSpend } from "./chat.js";
import { DEFAULT_MODEL } from "./berget.js";

describe("summarizeSpend", () => {
  const state = {
    model: "answer/model",
    jsonModel: "json/model",
    visionModel: "vision/model",
    totals: { prompt_tokens: 1000, completion_tokens: 500 },
    jsonTotals: { prompt_tokens: 200, completion_tokens: 100 },
    visionTotals: { prompt_tokens: 30, completion_tokens: 10 },
  };

  test("sums tokens across all three buckets", () => {
    const spend = summarizeSpend(state, []);
    assert.equal(spend.prompt_tokens, 1230);
    assert.equal(spend.completion_tokens, 610);
  });

  test("prices each bucket at its OWN model's catalog rate (the split-billing design)", () => {
    const catalog = [
      { id: "answer/model", price_in: 2, price_out: 4 },
      { id: "json/model", price_in: 0.1, price_out: 0.2 },
      { id: "vision/model", price_in: 1, price_out: 1 },
    ];
    const spend = summarizeSpend(state, catalog);
    // answer: 1000*2 + 500*4 = 4000; json: 200*0.1 + 100*0.2 = 40; vision: 30 + 10 = 40
    assert.equal(spend.berget_cost, 4080);
  });

  test("a model missing from the catalog contributes tokens but zero cost", () => {
    const catalog = [{ id: "answer/model", price_in: 1, price_out: 1 }];
    const spend = summarizeSpend(state, catalog);
    assert.equal(spend.berget_cost, 1500);
    assert.equal(spend.prompt_tokens, 1230);
  });

  test("no catalog at all yields zero cost, never a throw", () => {
    const spend = summarizeSpend(state, null);
    assert.equal(spend.berget_cost, 0);
  });

  test("a null visionModel (no vision helper ran) is fine — its bucket is just zeros", () => {
    const s = { ...state, visionModel: null, visionTotals: { prompt_tokens: 0, completion_tokens: 0 } };
    const spend = summarizeSpend(s, [{ id: "answer/model", price_in: 1, price_out: 1 }]);
    assert.equal(spend.prompt_tokens, 1200);
    assert.equal(spend.berget_cost, 1500);
  });
});

describe("resolveJsonModel", () => {
  test("routes JSON phases to the default (Mistral) model for any other answer model", () => {
    const catalog = [{ id: "zai-org/GLM-4.7-FP8", up: true }, { id: DEFAULT_MODEL, up: true }];
    assert.equal(resolveJsonModel(catalog, "zai-org/GLM-4.7-FP8"), DEFAULT_MODEL);
  });

  test("no-ops when the answer model already IS the default JSON model", () => {
    assert.equal(resolveJsonModel(null, DEFAULT_MODEL), DEFAULT_MODEL);
  });

  test("stays optimistic (default model) when the catalog is unavailable", () => {
    assert.equal(resolveJsonModel(null, "some/model"), DEFAULT_MODEL);
    assert.equal(resolveJsonModel(undefined, "some/model"), DEFAULT_MODEL);
  });

  test("falls back to the user's model when the default JSON model is down", () => {
    const catalog = [{ id: "some/model", up: true }, { id: DEFAULT_MODEL, up: false }];
    assert.equal(resolveJsonModel(catalog, "some/model"), "some/model");
  });

  test("falls back to the user's model when this deployment doesn't offer the default model", () => {
    const catalog = [{ id: "some/model", up: true }];
    assert.equal(resolveJsonModel(catalog, "some/model"), "some/model");
  });
});

describe("quotaBlockedResponse", () => {
  test("budget kind: message omits amounts, public quota carries no limit", () => {
    const blocked = { period: "day", kind: "budget", reset_at: Date.UTC(2026, 6, 9, 0, 0, 0) };
    const res = quotaBlockedResponse(blocked);
    assert.match(res.error, /daily research budget/);
    assert.doesNotMatch(res.error, /€|EUR/);
    assert.deepEqual(res.quota, { period: "day", kind: "budget", reset_at: blocked.reset_at });
  });

  test("searches kind: message includes the numeric limit, public quota is the blocked object as-is", () => {
    const blocked = { period: "month", kind: "searches", limit: 12000, reset_at: Date.UTC(2026, 7, 1, 0, 0, 0) };
    const res = quotaBlockedResponse(blocked);
    assert.match(res.error, /monthly search budget/);
    assert.match(res.error, /12,000 searches/);
    assert.equal(res.quota, blocked);
  });

  test("the rolling h5 window uses 'frees up' phrasing instead of 'resets'", () => {
    const blocked = { period: "h5", kind: "budget", reset_at: Date.now() };
    const res = quotaBlockedResponse(blocked);
    assert.match(res.error, /frees up/);
    assert.doesNotMatch(res.error, /\bresets\b/);
  });

  test("the message leads with a relative 'in about …' time and keeps the exact UTC", () => {
    const now = Date.UTC(2026, 6, 17, 12, 0, 0);
    const res = quotaBlockedResponse(
      { period: "day", kind: "budget", reset_at: now + 3 * 3600 * 1000 },
      now,
    );
    assert.match(res.error, /resets in about 3h \(2026-07-17 15:00 UTC\)\./);
  });

  test("every other period uses 'resets' phrasing", () => {
    for (const period of ["day", "week", "month"]) {
      const res = quotaBlockedResponse({ period, kind: "budget", reset_at: Date.now() });
      assert.match(res.error, /resets/);
    }
  });
});
