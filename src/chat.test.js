import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { imagesThatFit, quotaBlockedResponse } from "./chat.js";

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

describe("imagesThatFit", () => {
  const conv = [{ role: "user", content: "q" }]; // tiny baseline
  const img = (n) => ({ label: `i${n}`, dataUrl: "x".repeat(n) });

  test("keeps everything when the budget allows", () => {
    const images = [img(1000), img(1000)];
    assert.equal(imagesThatFit(conv, images).length, 2);
  });

  test("stops at the first image that would overflow, keeping order", () => {
    const images = [img(400), img(400), img(400)];
    // budget fits conv + two images (400+200 each) but not three
    const kept = imagesThatFit(conv, images, JSON.stringify(conv).length + 1300);
    assert.deepEqual(kept, images.slice(0, 2));
  });

  test("a conversation already at the cap keeps nothing", () => {
    const bigConv = [{ role: "user", content: "y".repeat(2000) }];
    assert.deepEqual(imagesThatFit(bigConv, [img(100)], 1000), []);
  });
});
