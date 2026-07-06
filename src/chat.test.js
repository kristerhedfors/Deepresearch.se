import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { quotaBlockedResponse } from "./chat.js";

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
