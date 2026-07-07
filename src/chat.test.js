import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { quotaBlockedResponse, resolveJsonModel } from "./chat.js";
import { DEFAULT_MODEL } from "./berget.js";

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

  test("the rolling h5 window uses 'frees up around' phrasing instead of 'resets'", () => {
    const blocked = { period: "h5", kind: "budget", reset_at: Date.now() };
    const res = quotaBlockedResponse(blocked);
    assert.match(res.error, /frees up around/);
  });

  test("every other period uses 'resets' phrasing", () => {
    for (const period of ["day", "week", "month"]) {
      const res = quotaBlockedResponse({ period, kind: "budget", reset_at: Date.now() });
      assert.match(res.error, /resets/);
    }
  });
});
