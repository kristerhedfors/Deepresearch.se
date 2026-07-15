// Unit tests for timescale.js — the slider's pure position/seconds mapping
// and the report-tier readout. budgetTier must MIRROR the server's
// src/budget.js reportTierFor boundaries (the slider buys output depth too;
// the readout must name the same deliverable the server will produce). The
// boundaries are pinned as literals here — the same values budget.test.js
// pins for reportTierFor — rather than importing src/budget.js, which would
// drag the Workers-typed src/types.d.ts into the public (DOM-lib) typecheck
// program. Same mirror-in-both-suites discipline as the board catalogs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { BUDGET_MAX_S, BUDGET_MIN_S, budgetTier, fmtBudget, posToSeconds, secondsToPos } from "./timescale.js";

describe("posToSeconds / secondsToPos", () => {
  test("endpoints map to the budget range", () => {
    assert.equal(posToSeconds(0), BUDGET_MIN_S);
    assert.equal(posToSeconds(100), BUDGET_MAX_S);
  });
  test("round-trips within one step across the scale", () => {
    for (let p = 0; p <= 100; p += 10) {
      const s = posToSeconds(p);
      assert.ok(Math.abs(posToSeconds(secondsToPos(s)) - s) <= 30, `p=${p}`);
    }
  });
});

describe("fmtBudget", () => {
  test("formats seconds, whole minutes, and mixed", () => {
    assert.equal(fmtBudget(45), "45 s");
    assert.equal(fmtBudget(120), "2 m");
    assert.equal(fmtBudget(150), "2 m 30 s");
  });
});

describe("budgetTier — mirrors src/budget.js reportTierFor", () => {
  test("same tier id as the server at every boundary and in between", () => {
    // The server-side mapping, pinned: brief <60s, standard <180s,
    // extended <420s, full ≥420s (budget.test.js pins the same values).
    const serverTier = (s) => (s >= 420 ? "full" : s >= 180 ? "extended" : s >= 60 ? "standard" : "brief");
    for (const s of [15, 59, 60, 179, 180, 240, 419, 420, 600]) {
      assert.equal(budgetTier(s).id, serverTier(s), `at ${s}s`);
    }
  });
  test("each tier carries a compact label and a tooltip description", () => {
    for (const s of [15, 60, 180, 420]) {
      const t = budgetTier(s);
      assert.ok(t.label.length >= 4 && t.label.length <= 12, `label fits the readout at ${s}s`);
      assert.ok(t.desc.length > 20, `desc is a real sentence at ${s}s`);
    }
  });
  test("the top of the slider names the full report", () => {
    assert.equal(budgetTier(600).id, "full");
    assert.match(budgetTier(600).desc, /executive summary/);
  });
});
