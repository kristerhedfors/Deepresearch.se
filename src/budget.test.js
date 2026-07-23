// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers budget.js: clampBudget, planResearch's tier scaling (incl. the
// split json-model estimates), the deep-tier gates, fitsDeadline's grace
// math, and applyComplexityToPlan's scale-down-only rule.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyComplexityToPlan,
  clampBudget,
  fitsDeadline,
  planResearch,
  recordPhase,
  reportTierFor,
  wantsNotes,
  wantsFullContent,
  wantsClaimValidation,
  wantsSubqFanout,
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

  test("deep budgets strive toward the target — the round/search ceiling scales past the old cap", () => {
    // Feedback (chat_logs #521): an 8-minute budget wrapped a rich question in
    // ~60-90s because the gap loop hit a hard 4-round / 20-search ceiling far
    // under the time available. The deep tiers now let the time deadline and
    // the gap check's completeness judgment bind instead of an arbitrary cap.
    const M = "test/deep-tier-" + Math.random();
    const full = planResearch(M, 480);
    assert.ok(full.gapIterations >= 6, `8-min plan gap rounds ${full.gapIterations} should exceed the old cap of 4`);
    assert.ok(full.maxSearches >= 30, `8-min plan maxSearches ${full.maxSearches} should exceed the old cap of 20`);
    // Strictly monotonic through the deep tiers (240s → 300s → 480s): a longer
    // budget always buys the CAPACITY for more rounds and searches.
    const ext = planResearch(M, 300);
    const long = planResearch(M, 240);
    assert.ok(full.gapIterations > ext.gapIterations, "480s buys more rounds than 300s");
    assert.ok(ext.gapIterations > long.gapIterations, "300s buys more rounds than 240s");
    assert.ok(full.maxSearches > ext.maxSearches, "480s buys more searches than 300s");
  });

  test("the default (60s) tier's depth is unchanged by the deep-tier scaling", () => {
    // The deep-tier ceiling raise and the honest per-round costing must leave
    // the standard/default plan byte-identical (eval baselines depend on it).
    const plan = planResearch("test/default-depth-" + Math.random(), 60);
    assert.equal(plan.gapIterations, 2);
    assert.equal(plan.maxSearches, 10);
    assert.equal(plan.followups, 3);
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

describe("report-comprehensiveness tiers — the slider buys output depth too", () => {
  const MODEL = "test/report-tier-model-" + Math.random();

  test("reportTierFor boundaries: brief <60s, standard <180s, extended <420s, full ≥420s", () => {
    assert.equal(reportTierFor(15), "brief");
    assert.equal(reportTierFor(59), "brief");
    assert.equal(reportTierFor(60), "standard");
    assert.equal(reportTierFor(179), "standard");
    assert.equal(reportTierFor(180), "extended");
    assert.equal(reportTierFor(419), "extended");
    assert.equal(reportTierFor(420), "full");
    assert.equal(reportTierFor(MAX_BUDGET_S), "full");
  });

  test("the plan carries the tier and its token caps", () => {
    const std = planResearch(MODEL, DEFAULT_BUDGET_S);
    assert.equal(std.reportTier, "standard");
    // The default budget keeps the long-standing pre-tier caps, so its
    // behavior is byte-identical on the wire.
    assert.equal(std.synthMaxTokens, 4096);
    assert.equal(std.validateMaxTokens, 3000);

    const full = planResearch(MODEL, MAX_BUDGET_S);
    assert.equal(full.reportTier, "full");
    assert.equal(full.synthMaxTokens, 8192);
    assert.equal(full.validateMaxTokens, 9000);

    const ext = planResearch(MODEL, 240);
    assert.equal(ext.reportTier, "extended");
    assert.ok(ext.synthMaxTokens > 4096 && ext.synthMaxTokens < full.synthMaxTokens);
  });

  test("the full tier grows the source registry and digest so the depth can come from material", () => {
    const full = planResearch(MODEL, MAX_BUDGET_S);
    assert.ok(full.maxSources >= 28);
    assert.ok(full.digestCap >= 24_000);
    // Lower tiers keep their existing caps.
    assert.ok(planResearch(MODEL, DEFAULT_BUDGET_S).maxSources <= 24);
  });

  test("even the floor plan carries the tier fields", () => {
    const plan = planResearch(MODEL, MIN_BUDGET_S);
    assert.equal(plan.reportTier, "brief");
    assert.equal(plan.synthMaxTokens, 4096);
    assert.equal(plan.validateMaxTokens, 3000);
  });

  test("179s vs 180s: identical research plan, different report tier — the bench A/B seam", () => {
    // The rubric bench's tier A/B (tests/EVAL-BENCH-FINDINGS.md, 2026-07-15)
    // compares EVAL_BUDGET_S=179 vs 180 on the same deploy: the one budget
    // pair that crosses a report-tier boundary while every research-depth
    // knob stays identical, so any judge/structure delta isolates the
    // report-tier prompt change. This pin is what makes that protocol valid
    // — if a future depth boundary lands between 179 and 180, this fails and
    // the protocol must pick a new seam.
    const a = planResearch(MODEL, 179);
    const b = planResearch(MODEL, 180);
    for (const k of ["queries", "gapIterations", "followups", "validate", "maxSearches", "maxSources", "digestCap"]) {
      assert.deepEqual(b[k], a[k], `research knob ${k} identical across the seam`);
    }
    assert.deepEqual(a.searchDepth, b.searchDepth);
    assert.equal(a.reportTier, "standard");
    assert.equal(b.reportTier, "extended");
    assert.ok(b.synthMaxTokens > a.synthMaxTokens);
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

  // Sub-question fan-out is gated by its OWN flag (SUBQ_FANOUT_ENABLED in
  // budget.js — separate from the net-negative deep-tier features: this one
  // is unmeasured, not disproven). While off it returns false at every tier;
  // the ≥240s boundary is preserved in the gate body for the bench-gated
  // enable (tests/bench-gate.mjs is the required evidence — see the flag's
  // comment for the paired Cloudflare Workflows condition).
  test("sub-question fan-out stays off at every tier while its flag is disabled", () => {
    for (const s of [15, 60, 120, 240, 300, 600]) {
      assert.equal(wantsSubqFanout(plan(s)), false, `fan-out off at ${s}s`);
    }
    assert.equal(wantsSubqFanout(null), false);
    assert.equal(wantsSubqFanout({}), false);
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

describe("applyComplexityToPlan — complexity-scaled effort", () => {
  const MODEL = "test/no-history-model-complexity";

  test("'simple' caps gap rounds at 1 and searches at one wave + one follow-up round", () => {
    const plan = planResearch(MODEL, 300);
    assert.ok(plan.gapIterations > 1, "premise: a 300s plan buys >1 gap rounds");
    const out = applyComplexityToPlan(plan, "simple");
    assert.equal(out, plan); // mutates and returns the same plan object
    assert.equal(plan.gapIterations, 1);
    assert.equal(plan.maxSearches, plan.queries + plan.followups);
  });

  test("only ever scales DOWN — a floor plan is not raised", () => {
    const plan = planResearch(MODEL, 15);
    const before = { ...plan };
    applyComplexityToPlan(plan, "simple");
    assert.ok(plan.gapIterations <= before.gapIterations);
    assert.ok(plan.maxSearches <= before.maxSearches);
  });

  test("'simple' also caps the report tier at standard (2026-07-15 seam-battery evidence)", () => {
    // The paired 179/180s A/B: structured-report tiers helped broad kinds
    // but went 0 wins / 7 losses on focused-lookup kinds — a simple question
    // must keep the focused answer shape even when the slider bought more.
    const ext = applyComplexityToPlan(planResearch(MODEL, 300), "simple");
    assert.equal(ext.reportTier, "standard");
    assert.equal(ext.synthMaxTokens, 4096);
    assert.equal(ext.validateMaxTokens, 3000);
    const full = applyComplexityToPlan(planResearch(MODEL, 600), "simple");
    assert.equal(full.reportTier, "standard");
    assert.equal(full.synthMaxTokens, 4096);
    // Never scales UP: brief stays brief, standard stays standard.
    assert.equal(applyComplexityToPlan(planResearch(MODEL, 15), "simple").reportTier, "brief");
    assert.equal(applyComplexityToPlan(planResearch(MODEL, 60), "simple").reportTier, "standard");
  });

  test("non-simple complexities leave the plan untouched (budget stays the ceiling)", () => {
    for (const complexity of ["multihop", "comparison", "survey"]) {
      const plan = planResearch(MODEL, 300);
      const before = JSON.stringify(plan);
      applyComplexityToPlan(plan, complexity);
      assert.equal(JSON.stringify(plan), before, complexity);
    }
  });

  test("absent/unknown complexity (schema miss, older model output) is a no-op", () => {
    for (const complexity of [null, undefined, "extreme", 42]) {
      const plan = planResearch(MODEL, 300);
      const before = JSON.stringify(plan);
      applyComplexityToPlan(plan, complexity);
      assert.equal(JSON.stringify(plan), before, String(complexity));
    }
  });

  test("a missing plan is tolerated", () => {
    assert.equal(applyComplexityToPlan(null, "simple"), null);
  });
});
