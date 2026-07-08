import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  clampBudget,
  fitsDeadline,
  planResearch,
  recordPhase,
  wantsNotes,
  wantsFullContent,
  wantsClaimValidation,
  MIN_BUDGET_S,
  MAX_BUDGET_S,
  DEFAULT_BUDGET_S,
} from "./budget.js";

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

  test("a slow answer model with a fast JSON model plans MORE work than if the slow model did triage too", () => {
    // The JSON phases (triage/gap/validate) are estimated against jsonModel,
    // so a slow reasoning model as the answer model no longer makes the
    // planner over-reserve for triage a fast Mistral now handles.
    const slow = "test/slow-answer-model-" + Math.random();
    const fast = "test/fast-json-model-" + Math.random();
    // Prime EWMA: slow model's triage is very slow; the fast model's is quick.
    for (let i = 0; i < 20; i++) {
      recordPhase(slow, "triage", 90_000);
      recordPhase(fast, "triage", 4_000);
    }
    const mixed = planResearch(slow, 120, fast);
    const allSlow = planResearch(slow, 120); // jsonModel defaults to the slow model
    assert.ok(
      mixed.queries >= allSlow.queries,
      `mixed (${mixed.queries}) should plan at least as many angles as all-slow (${allSlow.queries})`,
    );
    // The mixed plan's triage estimate reflects the fast JSON model.
    assert.ok(mixed.estimates.triage <= 10_000);
    assert.ok(allSlow.estimates.triage >= 80_000);
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

describe("planResearch — estimates carry the budget-gated phases", () => {
  const MODEL = "test/estimates-model-" + Math.random();
  test("every plan's estimates include digest/fetch/claim so the deadline checks can budget them", () => {
    const plan = planResearch(MODEL, 300);
    for (const k of ["triage", "gap", "validate", "synth", "search", "digest", "fetch", "claim"]) {
      assert.equal(typeof plan.estimates[k], "number", `estimate ${k} present`);
    }
  });
  test("adding the new phases does not change the planned search/gap allocation", () => {
    // Regression guard: the digest/fetch/claim estimates must NOT be subtracted
    // from avail, so queries/gapIterations/maxSearches stay what they were.
    const plan = planResearch(MODEL, 300);
    assert.ok(plan.queries >= 1 && plan.maxSearches >= plan.queries);
    // A default-budget plan still validates and is unaffected.
    assert.equal(planResearch(MODEL, 60).validate, true);
  });
});

describe("budget-tier gates for the deep-research phases", () => {
  const plan = (s) => planResearch("test/gate-model-" + Math.random(), s);

  test("notes/full-content/claim-validation are ALL off at the 15-60s default tier", () => {
    for (const s of [15, 30, 60]) {
      assert.equal(wantsNotes(plan(s)), false, `notes off at ${s}s`);
      assert.equal(wantsFullContent(plan(s)), false, `full-content off at ${s}s`);
      assert.equal(wantsClaimValidation(plan(s)), false, `claim-validation off at ${s}s`);
    }
  });

  // DISABLED (2026-07): the deep-tier phases are gated off by the
  // DEEP_TIER_FEATURES_ENABLED flag in budget.js after a de-noised benchmark
  // found them net-negative (see the flag's comment). While off, every gate
  // returns false at every tier — so the mid/long tiers behave like the
  // default. The tier boundaries (120s / 240s) are preserved in the gate
  // bodies for the future intent-gated re-enable.
  test("deep-tier phases stay off even at the mid tier (>=120s) while disabled", () => {
    const p = plan(120);
    assert.equal(wantsNotes(p), false);
    assert.equal(wantsFullContent(p), false);
    assert.equal(wantsClaimValidation(p), false);
  });

  test("deep-tier phases stay off even at the long tier (>=240s) while disabled", () => {
    const p = plan(300);
    assert.equal(wantsNotes(p), false);
    assert.equal(wantsFullContent(p), false);
    assert.equal(wantsClaimValidation(p), false);
  });

  test("the gates tolerate a missing/garbage plan without throwing", () => {
    assert.equal(wantsNotes(null), false);
    assert.equal(wantsFullContent(undefined), false);
    assert.equal(wantsClaimValidation({}), false);
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
