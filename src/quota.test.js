import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { addUsage, windowStart, windowReset, effectiveQuota, quotaExceeded, bergetCost, PERIODS } from "./quota.js";

describe("windowStart / windowReset", () => {
  // A Wednesday, well clear of month/week/day boundaries.
  const now = Date.UTC(2026, 6, 8, 15, 30, 0); // 2026-07-08 15:30 UTC

  test("day window starts at UTC midnight", () => {
    assert.equal(windowStart("day", now), Date.UTC(2026, 6, 8, 0, 0, 0));
  });
  test("week window starts on Monday", () => {
    // 2026-07-08 is a Wednesday; Monday of that week is 2026-07-06.
    assert.equal(windowStart("week", now), Date.UTC(2026, 6, 6, 0, 0, 0));
  });
  test("month window starts on the 1st", () => {
    assert.equal(windowStart("month", now), Date.UTC(2026, 6, 1, 0, 0, 0));
  });
  test("h5 window is a rolling 5 hours back from now", () => {
    assert.equal(windowStart("h5", now), now - 5 * 3600 * 1000);
  });

  test("day reset is the next UTC midnight", () => {
    assert.equal(windowReset("day", now), Date.UTC(2026, 6, 9, 0, 0, 0));
  });
  test("week reset is next Monday", () => {
    assert.equal(windowReset("week", now), Date.UTC(2026, 6, 13, 0, 0, 0));
  });
  test("month reset is the 1st of next month", () => {
    assert.equal(windowReset("month", now), Date.UTC(2026, 7, 1, 0, 0, 0));
  });
  test("h5 reset is 5 hours after the oldest event in the window", () => {
    const oldest = now - 3 * 3600 * 1000; // an event 3h ago
    assert.equal(windowReset("h5", now, oldest), oldest + 5 * 3600 * 1000);
  });
  test("h5 reset falls back to now + 5h when no oldest event is given", () => {
    assert.equal(windowReset("h5", now, null), now + 5 * 3600 * 1000);
  });

  test("week boundary wraps correctly across a month end (Monday in the next month)", () => {
    // 2026-08-31 is a Monday.
    const lateAug = Date.UTC(2026, 7, 31, 10, 0, 0);
    assert.equal(windowStart("week", lateAug), Date.UTC(2026, 7, 31, 0, 0, 0));
    assert.equal(windowReset("week", lateAug), Date.UTC(2026, 8, 7, 0, 0, 0));
  });
});

describe("effectiveQuota", () => {
  const config = {
    quotas: {
      h5: { budget_eur: 1, searches: 300 },
      day: { budget_eur: 2, searches: 1000 },
      week: { budget_eur: 4, searches: 4000 },
      month: { budget_eur: 8, searches: 12000 },
    },
  };

  test("no user override: returns the global defaults, deep-cloned", () => {
    const q = effectiveQuota(config, null);
    assert.deepEqual(q, config.quotas);
    q.day.budget_eur = 999;
    assert.equal(config.quotas.day.budget_eur, 2, "must not mutate the shared config object");
  });

  test("partial per-period override merges over defaults", () => {
    const user = { quota_json: JSON.stringify({ day: { searches: 50 } }) };
    const q = effectiveQuota(config, user);
    assert.equal(q.day.searches, 50);
    assert.equal(q.day.budget_eur, 2, "unset fields inherit the default");
    assert.equal(q.month.searches, 12000, "untouched periods are unaffected");
  });

  test("malformed quota_json degrades to the defaults rather than throwing", () => {
    const user = { quota_json: "{not valid json" };
    const q = effectiveQuota(config, user);
    assert.deepEqual(q, config.quotas);
  });

  test("negative override values are clamped to zero", () => {
    const user = { quota_json: JSON.stringify({ h5: { budget_eur: -5, searches: -10 } }) };
    const q = effectiveQuota(config, user);
    assert.equal(q.h5.budget_eur, 0);
    assert.equal(q.h5.searches, 0);
  });
});

describe("quotaExceeded", () => {
  const quota = {
    h5: { budget_eur: 1, searches: 300 },
    day: { budget_eur: 2, searches: 1000 },
    week: { budget_eur: 4, searches: 4000 },
    month: { budget_eur: 8, searches: 12000 },
  };
  const emptyUsage = () => Object.fromEntries(PERIODS.map((p) => [p, { berget_cost: 0, searches: 0 }]));

  test("null when comfortably within every window", () => {
    const usage = emptyUsage();
    usage.h5.berget_cost = 0.1;
    assert.equal(quotaExceeded(usage, quota), null);
  });

  test("budget kind fires when cost meets or exceeds the cap", () => {
    const usage = emptyUsage();
    usage.h5.berget_cost = 1; // exactly at the cap
    const blocked = quotaExceeded(usage, quota);
    assert.equal(blocked.period, "h5");
    assert.equal(blocked.kind, "budget");
  });

  test("searches kind fires when count meets or exceeds the cap", () => {
    const usage = emptyUsage();
    usage.day.searches = 1000;
    const blocked = quotaExceeded(usage, quota);
    assert.equal(blocked.period, "day");
    assert.equal(blocked.kind, "searches");
  });

  test("0 = uncapped — never blocks regardless of usage", () => {
    const uncapped = { ...quota, day: { budget_eur: 0, searches: 0 } };
    const usage = emptyUsage();
    usage.day.berget_cost = 999;
    usage.day.searches = 999_999;
    assert.equal(quotaExceeded(usage, uncapped), null);
  });

  test("checks periods in h5/day/week/month order — the first breach wins", () => {
    const usage = emptyUsage();
    usage.day.berget_cost = 2; // day breaches too, but h5 comes first in PERIODS
    usage.h5.berget_cost = 1;
    const blocked = quotaExceeded(usage, quota);
    assert.equal(blocked.period, "h5");
  });
});

describe("bergetCost", () => {
  test("0 when there's no catalog entry (unknown/unreachable model)", () => {
    assert.equal(bergetCost(null, 1000, 500), 0);
  });
  test("computes prompt + completion cost from the catalog's per-token prices", () => {
    const entry = { price_in: 0.000001, price_out: 0.000002 };
    assert.equal(bergetCost(entry, 1000, 500), 1000 * 0.000001 + 500 * 0.000002);
  });
  test("missing price fields default to 0 rather than NaN", () => {
    const entry = { price_in: 0.000001 };
    assert.equal(bergetCost(entry, 1000, 500), 0.001);
  });
});

describe("addUsage", () => {
  test("accumulates prompt and completion tokens into the totals bucket", () => {
    const totals = { prompt_tokens: 10, completion_tokens: 5 };
    addUsage(totals, { prompt_tokens: 100, completion_tokens: 50 });
    assert.deepEqual(totals, { prompt_tokens: 110, completion_tokens: 55 });
  });

  test("a missing usage report is a no-op, never a throw", () => {
    const totals = { prompt_tokens: 1, completion_tokens: 2 };
    addUsage(totals, null);
    addUsage(totals, undefined);
    assert.deepEqual(totals, { prompt_tokens: 1, completion_tokens: 2 });
  });

  test("missing fields in the usage report count as zero", () => {
    const totals = { prompt_tokens: 0, completion_tokens: 0 };
    addUsage(totals, { prompt_tokens: 7 });
    assert.deepEqual(totals, { prompt_tokens: 7, completion_tokens: 0 });
  });
});
