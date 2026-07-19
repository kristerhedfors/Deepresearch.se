// Unit tests for the admin API's per-user usage assembly. The D1 aggregation
// paths (getUsage / getUsageAllUsers) are live-verified; here we pin the
// WIRING that fixes the "Reset quota did nothing" report: a user the admin
// has reset must show FLOORED usage in the overview, not their raw pre-reset
// totals, while everyone else keeps the raw (cheap, single-scan) row.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { usageRowsForOverview } from "./admin-api.js";

// getUsage's nested per-window shape; a floored (post-reset) call returns all
// zeros because every window start is clamped up to the future reset floor.
const zeroWin = { tokens: 0, searches: 0, berget_cost: 0, exa_cost: 0, hours: 0, requests: 0 };
const ZERO_USAGE = { h5: zeroWin, day: zeroWin, week: zeroWin, month: zeroWin, h5_oldest: null };

describe("usageRowsForOverview (honors quota_reset_at)", () => {
  const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);
  const rawByUser = {
    "1": { user_id: "1", month_berget_cost: 9.9, month_searches: 500, month_tokens: 1_234_567 },
    "2": { user_id: "2", month_berget_cost: 0.2, month_searches: 3, month_tokens: 42 },
  };

  test("a reset user gets FLOORED usage (bars drop to zero) — the button visibly clears", async () => {
    const calls = [];
    const users = [
      { id: 1, email: "vidar@example.com", quota_reset_at: NOW + 7 * 86_400_000 },
      { id: 2, email: "other@example.com", quota_reset_at: null },
    ];
    const usageFor = async (userId, now, resetAt) => {
      calls.push({ userId, now, resetAt });
      return ZERO_USAGE;
    };
    const rows = await usageRowsForOverview(users, rawByUser, usageFor, NOW);

    // Only the reset user triggered a floored recompute.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].userId, 1);
    assert.equal(calls[0].resetAt, NOW + 7 * 86_400_000);

    const vidar = rows.find((r) => r.id === 1);
    assert.equal(vidar.usage.month_berget_cost, 0, "reset user's month cost shows zero");
    assert.equal(vidar.usage.month_searches, 0);
    assert.equal(vidar.usage.month_tokens, 0);

    // The non-reset user keeps the raw single-scan row untouched.
    const other = rows.find((r) => r.id === 2);
    assert.equal(other.usage, rawByUser["2"]);
    assert.equal(other.usage.month_tokens, 42);
  });

  test("no reset set → raw rows straight through, no getUsage calls", async () => {
    let called = 0;
    const users = [{ id: 1, quota_reset_at: 0 }, { id: 2, quota_reset_at: null }];
    const rows = await usageRowsForOverview(users, rawByUser, async () => { called++; return ZERO_USAGE; }, NOW);
    assert.equal(called, 0);
    assert.equal(rows[0].usage, rawByUser["1"]);
    assert.equal(rows[1].usage, rawByUser["2"]);
  });

  test("a user with no usage row at all resolves to null (not undefined)", async () => {
    const rows = await usageRowsForOverview([{ id: 9, quota_reset_at: null }], {}, async () => ZERO_USAGE, NOW);
    assert.equal(rows[0].usage, null);
  });
});
