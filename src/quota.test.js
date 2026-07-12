// Unit tests for quota window math, override merging, breach detection, and
// cost calculation (src/quota.js) — the D1 aggregation paths are live-verified.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  addUsage,
  windowStart,
  windowReset,
  effectiveQuota,
  quotaExceeded,
  bergetCost,
  overCap,
  inflightLimitResponse,
  reserveInflight,
  releaseInflight,
  INFLIGHT_CAP,
  INFLIGHT_TTL_MS,
  PERIODS,
} from "./quota.js";

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

// ---- in-flight concurrency reservation (M-1 / M-2) -------------------------

describe("overCap (pure concurrency decision)", () => {
  test("under the cap is not over", () => {
    assert.equal(overCap(0, 5), false);
    assert.equal(overCap(4, 5), false);
  });
  test("at exactly the cap IS over — the user already holds `cap` slots", () => {
    assert.equal(overCap(5, 5), true);
  });
  test("above the cap is over", () => {
    assert.equal(overCap(9, 5), true);
  });
  test("the exported cap is a small positive integer", () => {
    assert.ok(Number.isInteger(INFLIGHT_CAP) && INFLIGHT_CAP > 0);
    assert.ok(Number.isInteger(INFLIGHT_TTL_MS) && INFLIGHT_TTL_MS > 0);
  });
});

describe("inflightLimitResponse", () => {
  test("carries the limit + active count and a plain-language rate-limit message", () => {
    const r = inflightLimitResponse({ limit: 5, active: 5 });
    assert.deepEqual(r.rate_limit, { limit: 5, active: 5 });
    assert.equal(typeof r.error, "string");
    assert.ok(/limit/i.test(r.error));
    // No internal cost/budget figures leak into a rate-limit message.
    assert.ok(!/eur|budget|€/i.test(r.error));
  });
});

// A tiny in-memory D1 stand-in supporting only the reservation queries.
function mockD1() {
  /** @type {{ req_id: string, user_id: string, ts: number }[]} */
  const rows = [];
  const make = (sql) => {
    let args = [];
    return {
      bind(...a) {
        args = a;
        return this;
      },
      async run() {
        if (sql.startsWith("DELETE FROM inflight WHERE ts <")) {
          const cutoff = args[0];
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts < cutoff) rows.splice(i, 1);
        } else if (sql.startsWith("DELETE FROM inflight WHERE req_id")) {
          const id = String(args[0]);
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].req_id === id) rows.splice(i, 1);
        } else if (sql.startsWith("INSERT INTO inflight")) {
          rows.push({ req_id: String(args[0]), user_id: String(args[1]), ts: args[2] });
        }
        return { success: true };
      },
      async first() {
        if (sql.startsWith("SELECT COUNT(*) AS n FROM inflight WHERE user_id")) {
          const uid = String(args[0]);
          return { n: rows.filter((r) => r.user_id === uid).length };
        }
        return null;
      },
    };
  };
  return { _rows: rows, prepare: (sql) => make(sql), batch: async () => [] };
}

describe("reserveInflight / releaseInflight (fail-soft)", () => {
  test("no DB binding → allowed (degraded), never blocks", async () => {
    const r = await reserveInflight(/** @type {any} */ ({}), "u1", "req-1");
    assert.deepEqual(r, { ok: true, degraded: true });
  });

  test("releaseInflight with no DB is a silent no-op", async () => {
    await releaseInflight(/** @type {any} */ ({}), "req-1"); // must not throw
  });

  test("a D1 error fails OPEN (allowed), never a throw or a block", async () => {
    const env = /** @type {any} */ ({
      DB: {
        prepare() {
          throw new Error("d1 down");
        },
        batch() {
          throw new Error("d1 down");
        },
      },
    });
    const r = await reserveInflight(env, "u1", "req-x");
    assert.equal(r.ok, true);
    await releaseInflight(env, "req-x"); // swallows the error
  });

  test("bounds a user to the cap, then frees a slot on release", async () => {
    const env = /** @type {any} */ ({ DB: mockD1() });
    const now = 1_000_000;
    // Fill every slot.
    for (let i = 0; i < INFLIGHT_CAP; i++) {
      const r = await reserveInflight(env, "userA", `a-${i}`, now);
      assert.equal(r.ok, true, `reservation ${i} should be admitted`);
    }
    // The next one is refused WITHOUT inserting.
    const over = await reserveInflight(env, "userA", "a-over", now);
    assert.deepEqual(over, { ok: false, limit: INFLIGHT_CAP, active: INFLIGHT_CAP });
    // A different user is unaffected by userA's saturation.
    assert.equal((await reserveInflight(env, "userB", "b-0", now)).ok, true);
    // Releasing one of userA's slots lets the next request in.
    await releaseInflight(env, "a-0");
    assert.equal((await reserveInflight(env, "userA", "a-new", now)).ok, true);
  });

  test("stale reservations age out after the TTL so a crash can't hold a slot", async () => {
    const env = /** @type {any} */ ({ DB: mockD1() });
    const t0 = 1_000_000;
    for (let i = 0; i < INFLIGHT_CAP; i++) {
      await reserveInflight(env, "userC", `c-${i}`, t0);
    }
    assert.equal((await reserveInflight(env, "userC", "c-blocked", t0)).ok, false);
    // Well past the TTL: the old rows are swept, so admission resumes.
    const later = t0 + INFLIGHT_TTL_MS + 1;
    assert.equal((await reserveInflight(env, "userC", "c-later", later)).ok, true);
  });
});
