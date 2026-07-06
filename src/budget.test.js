import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { clampBudget, fitsDeadline, planResearch, MIN_BUDGET_S, MAX_BUDGET_S, DEFAULT_BUDGET_S } from "./budget.js";

describe("clampBudget", () => {
  test("clamps below the floor", () => {
    assert.equal(clampBudget(1), MIN_BUDGET_S);
  });
  test("clamps above the ceiling", () => {
    assert.equal(clampBudget(9999), MAX_BUDGET_S);
  });
  test("rounds fractional values", () => {
    assert.equal(clampBudget(60.6), 61);
  });
  test("falls back to the default for non-numeric input", () => {
    assert.equal(clampBudget("not a number"), DEFAULT_BUDGET_S);
    assert.equal(clampBudget(undefined), DEFAULT_BUDGET_S);
    assert.equal(clampBudget(NaN), DEFAULT_BUDGET_S);
  });
});

describe("planResearch — depth scales with budget tier", () => {
  // A model with no EWMA history and no model-profiles.js override falls
  // back to the global PRIORS_MS — deterministic across test runs.
  const MODEL = "test/unknown-model-" + Math.random();

  test("very short budget produces the floor plan", () => {
    const plan = planResearch(MODEL, 15);
    assert.equal(plan.maxSearches, 1);
    assert.equal(plan.searchDepth.numResults, 5);
    assert.equal(plan.searchDepth.type, "auto");
    assert.equal(plan.searchDepth.costMultiplier, 1);
  });

  test("default budget (60s) plans a moderate search depth", () => {
    const plan = planResearch(MODEL, 60);
    assert.equal(plan.searchDepth.numResults, 8);
    assert.equal(plan.searchDepth.type, "auto");
    assert.ok(plan.queries >= 1);
  });

  test("long budget (240-419s) requests Exa's own default result count", () => {
    const plan = planResearch(MODEL, 250);
    assert.equal(plan.searchDepth.numResults, 10);
    assert.equal(plan.searchDepth.type, "auto");
    assert.equal(plan.searchDepth.costMultiplier, 1);
  });

  test("the deepest tier (>=420s) switches to Exa's costlier deep mode", () => {
    const plan = planResearch(MODEL, 450);
    assert.equal(plan.searchDepth.numResults, 10);
    assert.equal(plan.searchDepth.type, "deep");
    assert.equal(plan.searchDepth.costMultiplier, 12 / 7);
  });

  test("larger budgets buy more angles, gap rounds, and a bigger source registry", () => {
    const short = planResearch(MODEL, 60);
    const long = planResearch(MODEL, 300);
    assert.ok(long.queries >= short.queries);
    assert.ok(long.gapIterations >= short.gapIterations);
    assert.ok(long.maxSearches >= short.maxSearches);
    assert.ok(long.maxSources >= short.maxSources);
    assert.ok(long.digestCap >= short.digestCap);
  });

  test("every plan carries a searchDepth even on the floor-plan early return", () => {
    // Regression check: searchDepth must be set before the `avail <= search`
    // early return, not only at the end of the function.
    const plan = planResearch(MODEL, MIN_BUDGET_S);
    assert.ok(plan.searchDepth);
    assert.equal(typeof plan.searchDepth.numResults, "number");
  });

  test("validation is reserved unless the budget can't afford it plus a minimal plan", () => {
    const plan = planResearch(MODEL, 60);
    assert.equal(plan.validate, true);
  });
});

describe("fitsDeadline", () => {
  test("true when comfortably within budget", () => {
    const startedAt = Date.now() - 1000; // 1s elapsed
    assert.equal(fitsDeadline(startedAt, 60_000, 5_000), true);
  });
  test("false when the upcoming work would blow the budget + grace", () => {
    const startedAt = Date.now() - 55_000; // 55s elapsed of a 60s budget
    assert.equal(fitsDeadline(startedAt, 60_000, 20_000), false);
  });
  test("the 15% grace is actually applied, not just the raw budget", () => {
    const budgetMs = 100_000;
    const startedAt = Date.now() - 100_000; // fully elapsed already
    // 100s elapsed + 12s upcoming = 112s, over the raw 100s budget but
    // under the 115s (budget * 1.15) grace ceiling.
    assert.equal(fitsDeadline(startedAt, budgetMs, 12_000), true);
    // 100s elapsed + 20s upcoming = 120s, over even the grace ceiling.
    assert.equal(fitsDeadline(startedAt, budgetMs, 20_000), false);
  });
});
