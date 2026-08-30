// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers budget.js: clampBudget, planResearch's tier scaling (incl. the split
// json-model estimates) and fitsDeadline's grace math.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  clampBudget,
  fitsDeadline,
  planResearch,
  recordPhase,
  reportTierFor,
  MIN_BUDGET_S,
  MAX_BUDGET_S,
  DEFAULT_BUDGET_S, gatherDeadlineAt, GATHER_FLOOR } from "./budget.js";

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

describe("planResearch — the estimate keys the arithmetic reads", () => {
  const MODEL = "test/estimates-model-" + Math.random();
  // The trap PRIORS_MS's own comment names, from the other side: planResearch
  // subtracts t.triage and costs a round at t.gap, and phaseEstimates only
  // yields keys PRIORS_MS declares. Drop a row and every one of those terms
  // becomes NaN — no throw, no log, a plan of NaNs. This is the test that
  // fails when a key is removed with its phase.
  test("every key planResearch's arithmetic reads is a number", () => {
    const plan = planResearch(MODEL, 300);
    for (const k of ["triage", "gap", "validate", "synth", "search"]) {
      assert.equal(typeof plan.estimates[k], "number", `estimate ${k} present`);
    }
    for (const k of ["queries", "gapIterations", "followups", "maxSearches", "maxSources"]) {
      assert.ok(Number.isFinite(plan[k]), `${k} is a real number, not NaN`);
    }
  });
  test("the standard engine's two node keys are carried, not just recorded", () => {
    // recordPhase warms `queries` and `reflect` on every research turn. If the
    // estimate bag drops them, those measurements are written every request
    // and read by nothing, and the reflect loop budgets its rounds off the
    // deleted gap phase's prior forever.
    const plan = planResearch(MODEL, 300);
    assert.equal(typeof plan.estimates.queries, "number");
    assert.equal(typeof plan.estimates.reflect, "number");
  });
  test("a default-budget plan still validates", () => {
    assert.equal(planResearch(MODEL, 60).validate, true);
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

test("the gather deadline never starves the loop (feedback #71)", () => {
  // budget_s 15 — the brief tier — with COLD priors: the writer's estimated
  // share (29 s) exceeds the whole budget, and before the floor the reserve
  // swallowed everything: deadline == startedAt, the loop "stopped by the
  // deadline" with zero tool calls, and the user saw "No search results were
  // available" with web search ON (chat_logs #1763). A reserve that can turn
  // the engine off is not a reserve.
  const plan15 = planResearch("claude-opus-5", 15, "mistralai/Mistral-Small-3.2-24B-Instruct-2506");
  const dl = gatherDeadlineAt({ startedAt: 1_000 }, plan15);
  assert.ok(dl - 1_000 >= plan15.budgetMs * GATHER_FLOOR, "the brief tier must keep a real gathering slice");

  // The other route to the same failure: a big model's synth EWMA warmed past
  // any budget by a few long reports.
  for (let i = 0; i < 6; i++) recordPhase("claude-opus-5", "synth", 70_000);
  for (let i = 0; i < 6; i++) recordPhase("claude-opus-5", "validate", 12_000);
  const plan60 = planResearch("claude-opus-5", 60, "mistralai/Mistral-Small-3.2-24B-Instruct-2506");
  const dl60 = gatherDeadlineAt({ startedAt: 1_000 }, plan60);
  assert.ok(dl60 - 1_000 >= plan60.budgetMs * GATHER_FLOOR, "a warmed writer EWMA must not turn the engine off");

  // And when the writer fits comfortably, the reserve still works as designed.
  const roomy = gatherDeadlineAt({ startedAt: 0 }, { budgetMs: 120_000, estimates: { synth: 16_000, validate: 9_000 } });
  assert.ok(roomy > 120_000 * GATHER_FLOOR, "an honest reserve keeps more than the floor");
  assert.ok(roomy < 120_000 * 1.15, "…but still reserves the writer");

  // No start / no budget = no bound, never a throw.
  assert.equal(gatherDeadlineAt(null, null), 0);
  assert.equal(gatherDeadlineAt({ startedAt: 5 }, { budgetMs: 0 }), 0);
});
