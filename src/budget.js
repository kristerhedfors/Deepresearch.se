// Time-budget planning for the research pipeline.
//
// The UI slider sends `time_budget_s`; this module decides how to spend it.
// The pipeline has five phase types with very different costs, so planning
// works from measured history:
//
// 1. ROLLING STATS — an EWMA (alpha 0.3) of each phase's duration is kept
//    per model (models differ several-fold in speed), seeded with priors
//    measured on production runs. Stats live per isolate; the priors keep
//    cold isolates sensible. Every completed phase feeds recordPhase().
//
// 2. STATIC ALLOCATION (planResearch) — before searching begins:
//      fixed  = triage + synthesis            (always paid)
//      avail  = budget - fixed
//      - floor: below one search's cost, run 1 query, nothing else
//      - post-validation is the quality gate: reserved first, unless the
//        budget can't hold it plus a minimal two-search plan
//      - ~60% of the remainder buys initial search angles (1..4)
//      - what's left buys gap-check iterations (each ~ check + 2 searches)
//
// 3. RUNTIME DEADLINE CHECKS (fitsDeadline) — estimates are estimates, so
//    between phases the pipeline re-checks: proceed only if the upcoming
//    work plus the remaining mandatory phases still fit in budget +15%
//    grace. Overruns cut optional work (extra gap rounds first, validation
//    last) instead of blowing the target.

const PRIORS_MS = {
  triage: 6000,
  search: 1300,
  gap: 4500,
  synth: 16000,
  validate: 13000,
};
const ALPHA = 0.3;
export const MIN_BUDGET_S = 15;
export const MAX_BUDGET_S = 600; // slider tops out at 10 minutes
export const DEFAULT_BUDGET_S = 60;

const stats = new Map(); // model -> { phase: ewma_ms }

export function recordPhase(model, phase, ms) {
  if (!(phase in PRIORS_MS) || !(ms > 0)) return;
  const m = stats.get(model) || {};
  m[phase] = m[phase] == null ? ms : Math.round(ALPHA * ms + (1 - ALPHA) * m[phase]);
  stats.set(model, m);
}

export function phaseEstimates(model) {
  const m = stats.get(model) || {};
  const out = {};
  for (const k of Object.keys(PRIORS_MS)) out[k] = m[k] ?? PRIORS_MS[k];
  return out;
}

export function clampBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BUDGET_S;
  return Math.min(MAX_BUDGET_S, Math.max(MIN_BUDGET_S, Math.round(n)));
}

// Large budgets buy proportionally MORE work, not just headroom: more
// initial angles (up to 6), more follow-ups per gap round (up to 5), more
// gap rounds (up to 4), a bigger search cap, and a larger source registry
// and digest for synthesis.
export function planResearch(model, budgetS) {
  const t = phaseEstimates(model);
  const budgetMs = budgetS * 1000;
  const plan = {
    budgetMs,
    budgetS,
    queries: 1,
    gapIterations: 0,
    followups: 3,
    validate: false,
    maxSearches: 8,
    maxSources: 18,
    digestCap: 14_000,
    estimates: t,
  };

  let avail = budgetMs - t.triage - t.synth;
  if (avail <= t.search) {
    plan.maxSearches = 1;
    return plan; // floor plan
  }

  if (avail >= t.validate + 2 * t.search) {
    plan.validate = true;
    avail -= t.validate;
  }

  // Depth scales with the budget tier.
  const queryCap = budgetS >= 240 ? 6 : 4;
  plan.followups = budgetS >= 420 ? 5 : budgetS >= 240 ? 4 : 3;
  const gapRoundCap = budgetS >= 300 ? 4 : budgetS >= 60 ? 3 : 2;

  plan.queries = Math.max(1, Math.min(queryCap, Math.floor((avail * 0.6) / t.search)));
  let rest = avail - plan.queries * t.search;

  const gapCost = t.gap + 2 * t.search;
  while (plan.gapIterations < gapRoundCap && rest >= gapCost) {
    plan.gapIterations++;
    rest -= gapCost;
  }

  plan.maxSearches = Math.min(20, plan.queries + plan.gapIterations * plan.followups);
  if (plan.maxSearches > 8) {
    plan.maxSources = 24;
    plan.digestCap = 18_000;
  }
  return plan;
}

// True if `upcomingMs` more work still fits within budget (+15% grace).
export function fitsDeadline(startedAt, budgetMs, upcomingMs) {
  return Date.now() - startedAt + upcomingMs <= budgetMs * 1.15;
}
