// @ts-check
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
//    A model can also carry its own prior overrides (src/model-profiles.js)
//    for cases where the global priors are evidenced to be badly wrong for
//    it — consulted only until that model's own EWMA has real data.
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

import { getModelProfile } from "./model-profiles.js";

/** @typedef {import('./types.js').SearchDepth} SearchDepth */
/** @typedef {import('./types.js').ReportTier} ReportTier */

/**
 * The static allocation planResearch returns. Same shape as
 * import('./types.js').BudgetPlan, except `estimates` also carries the
 * budget-gated phases (digest/fetch/claim — the PRIORS_MS keys), which the
 * five-phase PhaseName record there predates.
 * @typedef {Object} BudgetPlan
 * @property {number} budgetMs
 * @property {number} budgetS
 * @property {number} queries Initial search angles to run.
 * @property {number} gapIterations Gap-check rounds the budget affords.
 * @property {number} followups Follow-up queries per gap round.
 * @property {boolean} validate Whether the post-validation quality gate is reserved.
 * @property {number} maxSearches Hard cap on total searches across all rounds.
 * @property {number} maxSources Cap on the numbered source registry.
 * @property {number} digestCap Char cap on the synthesis digest.
 * @property {Record<string, number>} estimates Per-phase duration estimates (ms) the plan was built from.
 * @property {SearchDepth} searchDepth
 * @property {ReportTier} reportTier Output comprehensiveness tier the slider bought.
 * @property {number} synthMaxTokens max_tokens for the synthesis stream (scaled to the tier).
 * @property {number} validateMaxTokens max_tokens for validate/revise JSON calls (revised_answer must hold the whole report).
 */

/** @type {Record<string, number>} */
const PRIORS_MS = {
  triage: 6000,
  search: 1300,
  gap: 4500,
  synth: 16000,
  validate: 13000,
  // Budget-gated deep-research phases (only ever run at mid/high tiers — see
  // wantsNotes / wantsFullContent / wantsClaimValidation): the per-wave notes
  // digest, the top-source full-content fetch, and one claim-verification
  // call. Seeded as priors so a cold isolate can budget them before their EWMA
  // warms up; each is dropped first under deadline pressure (fitsDeadline).
  digest: 4000,
  fetch: 2500,
  claim: 3500,
};
const ALPHA = 0.3;
export const MIN_BUDGET_S = 15;
export const MAX_BUDGET_S = 600; // slider tops out at 10 minutes
export const DEFAULT_BUDGET_S = 60;

// ---- rolling per-model phase stats (mechanism 1) ---------------------------

/** @type {Map<string, Record<string, number>>} */
const stats = new Map(); // model -> { phase: ewma_ms }

/**
 * Feeds one completed phase's duration into the model's EWMA. Phases not in
 * PRIORS_MS and non-positive durations are ignored.
 * @param {string} model
 * @param {string} phase
 * @param {number} ms
 */
export function recordPhase(model, phase, ms) {
  if (!(phase in PRIORS_MS) || !(ms > 0)) return;
  const m = stats.get(model) || {};
  m[phase] = m[phase] == null ? ms : Math.round(ALPHA * ms + (1 - ALPHA) * m[phase]);
  stats.set(model, m);
}

/**
 * Per-phase duration estimates for a model: its own EWMA where warmed up,
 * else its model-profile prior override, else the global prior.
 * @param {string} model
 * @returns {Record<string, number>}
 */
export function phaseEstimates(model) {
  const m = stats.get(model) || {};
  const profilePriors = /** @type {Record<string, number> | null} */ (getModelProfile(model).priorsMs);
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of Object.keys(PRIORS_MS)) out[k] = m[k] ?? profilePriors?.[k] ?? PRIORS_MS[k];
  return out;
}

/**
 * @param {unknown} value The raw `time_budget_s` from the request body.
 * @returns {number} Whole seconds within [MIN_BUDGET_S, MAX_BUDGET_S].
 */
export function clampBudget(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BUDGET_S;
  return Math.min(MAX_BUDGET_S, Math.max(MIN_BUDGET_S, Math.round(n)));
}

// ---- static allocation (mechanism 2) ---------------------------------------

// Large budgets buy proportionally MORE work, not just headroom: more
// initial angles (up to 6), more follow-ups per gap round (up to 5), more
// gap rounds (up to 4), a bigger search cap, and a larger source registry
// and digest for synthesis.
/**
 * @param {string} model The user's chosen answer/synthesis model.
 * @param {number} budgetS Clamped time budget in seconds.
 * @param {string} [jsonModel] The fixed model the JSON phases run on (defaults to `model`).
 * @returns {BudgetPlan}
 */
export function planResearch(model, budgetS, jsonModel = model) {
  // The JSON planning phases (triage/gap/validate) run on jsonModel (a fixed
  // reliable model — see pipeline.js), while synthesis runs on the user's
  // chosen `model`; search is Exa (model-independent, recorded under the user
  // model). Estimate each phase against the model that actually runs it so a
  // slow reasoning model as `model` doesn't make the planner over-reserve for
  // triage that a fast Mistral now handles.
  const u = phaseEstimates(model);
  const j = jsonModel === model ? u : phaseEstimates(jsonModel);
  // The digest and claim phases are JSON-mode calls on jsonModel; the
  // full-content fetch is an Exa call (model-independent, estimated off the
  // user model's history like search). These estimates only inform the
  // runtime deadline checks for the budget-gated phases — they do NOT reduce
  // the search/gap allocation below, so planned depth (and hence default
  // behavior) is unchanged at every tier.
  const t = {
    triage: j.triage,
    gap: j.gap,
    validate: j.validate,
    synth: u.synth,
    search: u.search,
    digest: j.digest,
    fetch: u.fetch,
    claim: j.claim,
  };
  const budgetMs = budgetS * 1000;
  const reportTier = reportTierFor(budgetS);
  const caps = REPORT_TIER_CAPS[reportTier];
  /** @type {BudgetPlan} */
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
    searchDepth: searchDepthFor(budgetS),
    reportTier,
    synthMaxTokens: caps.synthMaxTokens,
    validateMaxTokens: caps.validateMaxTokens,
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
  // The full-report tier feeds synthesis a larger source registry and digest
  // so the report's extra length can come from MORE SOURCE MATERIAL — the
  // synthesis prompt forbids padding, so without more input the model could
  // only stretch, not deepen.
  if (reportTier === "full") {
    plan.maxSources = Math.max(plan.maxSources, 28);
    plan.digestCap = Math.max(plan.digestCap, 24_000);
  }
  return plan;
}

// ---- report-comprehensiveness tiers -----------------------------------------
//
// The slider buys OUTPUT depth, not just research depth (2026-07-15 product
// directive): the delivered answer's structure and comprehensiveness must
// correlate with the time budget — from a compact annotated-search-results
// brief at the bottom, through the classic focused answer, up to a full
// frontier-assistant-grade research report (executive summary, thematic
// sections, tables, limitations) at the top. reportTierFor is the one mapping;
// prompts.js's synthPrompt turns the tier into per-tier structure/length
// guidance, and the caps below give the longer tiers the token headroom the
// bigger output needs (synthesis stream AND the validation revise path, whose
// revised_answer must hold the complete corrected report). Boundaries sit on
// the slider's existing tier vocabulary: <60s is below the default, 180s is
// mid-slider on the quadratic scale, 420s matches searchDepth's "deep" gate.
/**
 * @param {number} budgetS
 * @returns {ReportTier}
 */
export function reportTierFor(budgetS) {
  if (budgetS >= 420) return "full";
  if (budgetS >= 180) return "extended";
  if (budgetS >= 60) return "standard";
  return "brief";
}

// synthMaxTokens: brief/standard keep the long-standing 4096 cap (the exact
// value every provider client documents as "the synthesis answer cap"), so
// the default budget stays byte-identical on the wire. extended/full raise it
// for the bigger report (8192 ≈ a 3,000-word report with tables and sources).
// validateMaxTokens: the single-pass validate and the claim-revise call must
// be able to return the WHOLE corrected answer as JSON — scaled with the
// report, since a 3000-token cap would truncate a full report's revision.
/** @type {Record<ReportTier, { synthMaxTokens: number, validateMaxTokens: number }>} */
const REPORT_TIER_CAPS = {
  brief: { synthMaxTokens: 4096, validateMaxTokens: 3000 },
  standard: { synthMaxTokens: 4096, validateMaxTokens: 3000 },
  extended: { synthMaxTokens: 6144, validateMaxTokens: 6000 },
  full: { synthMaxTokens: 8192, validateMaxTokens: 9000 },
};

// Complexity-scaled effort: after triage classifies the question (see
// prompts.js's DECOMPOSITION_RULE), a "simple" question gets its research
// depth capped BELOW what the time budget alone would buy. The project's own
// de-noised benchmark found that extra research machinery at high budgets was
// net-negative on focused questions — the failure mode is OVER-researching a
// simple question because time happens to be available, diluting the answer
// (the same lesson as Anthropic's published effort-scaling rules: simple
// fact-finding warrants a handful of calls, not a survey's worth). Only ever
// scales DOWN — the budget plan remains the ceiling for every complexity —
// and an absent/unknown complexity (schema miss, older model output) leaves
// the plan untouched, so the pre-decomposition behavior is the exact
// fallback. Mutates and returns `plan` (it's the per-request state's plan).
/**
 * @param {BudgetPlan | null | undefined} plan
 * @param {unknown} complexity Triage's classification — only "simple" acts.
 * @returns {BudgetPlan | null | undefined} The same `plan` object.
 */
export function applyComplexityToPlan(plan, complexity) {
  if (!plan || complexity !== "simple") return plan;
  plan.gapIterations = Math.min(plan.gapIterations, 1);
  // One initial wave plus at most one follow-up round's worth of searches.
  plan.maxSearches = Math.min(plan.maxSearches, plan.queries + plan.followups);
  // Output-side counterpart (2026-07-15 seam battery, EVAL-BENCH-FINDINGS):
  // a simple question gets at most the STANDARD report shape even when the
  // slider bought extended/full. The paired 179s/180s A/B showed the
  // structured-report tiers helping broad kinds (comparison, contested,
  // diversity-trap) but consistently hurting focused-lookup kinds (numeric,
  // recency, platform lookups: 0 wins / 7 losses) — stretching a one-fact
  // answer across report sections dilutes it, the same failure mode that
  // motivated the research-depth cap above. Only ever scales DOWN, and
  // brief stays brief.
  if (plan.reportTier === "extended" || plan.reportTier === "full") {
    plan.reportTier = "standard";
    plan.synthMaxTokens = REPORT_TIER_CAPS.standard.synthMaxTokens;
    plan.validateMaxTokens = REPORT_TIER_CAPS.standard.validateMaxTokens;
  }
  return plan;
}

// A round 6 assessment found the time-budget slider scaled how MANY
// searches ran, but never how deep any single one went: numResults was a
// hardcoded 5 (Exa's own default is 10) and `type` was always "auto",
// never Exa's "deep"/"deep-reasoning" modes — which exist specifically
// for the "spend more time, get a more thorough result" tradeoff a longer
// budget should unlock. Tiered the same way as the angle/round caps
// above. `costMultiplier` reflects Exa's real published pricing ratios
// (search $7/1k, deep $12/1k, deep-reasoning $15/1k as of 2026) relative
// to the admin-configured `exa_cost_per_search_eur`, which is assumed to
// price the standard tier — so usage accounting stays honest instead of
// under-counting real spend when a request uses a costlier tier.
// `type: "deep"` is reserved for the most generous budgets only: it's
// ~1.7x the cost of a standard search, latency is unproven at scale (not
// yet run through a real eval battery — see CLAUDE.md's model-eval
// section), and a short/default request has no business paying for it.
/**
 * @param {number} budgetS
 * @returns {SearchDepth}
 */
function searchDepthFor(budgetS) {
  if (budgetS >= 420) return { numResults: 10, type: "deep", costMultiplier: 12 / 7 };
  if (budgetS >= 240) return { numResults: 10, type: "auto", costMultiplier: 1 };
  if (budgetS >= 60) return { numResults: 8, type: "auto", costMultiplier: 1 };
  return { numResults: 5, type: "auto", costMultiplier: 1 };
}

// Exa's /contents endpoint (the budget-gated full-content fetch) is billed
// well below a standard search (~$1/1k vs $7/1k as of 2026). The admin's
// per-search price is scaled by this ratio per URL fetched, so the top-tier
// full-content spend is counted rather than silently ignored — the same
// approach searchDepth.costMultiplier takes for deeper search tiers.
export const CONTENTS_COST_MULTIPLIER = 1 / 7;

// ---- runtime deadline checks (mechanism 3) ----------------------------------

// True if `upcomingMs` more work still fits within budget (+15% grace).
/**
 * @param {number} startedAt Request start (epoch ms).
 * @param {number} budgetMs
 * @param {number} upcomingMs
 * @returns {boolean}
 */
export function fitsDeadline(startedAt, budgetMs, upcomingMs) {
  return Date.now() - startedAt + upcomingMs <= budgetMs * 1.15;
}

// ---- budget-tier gates for the deep-research phases ------------------------
//
// These decide whether the NEW, optional pipeline phases run at all. They are
// deliberately tiered ABOVE the default budget so a 15-60s request runs
// byte-identically to before these phases existed — wantsNotes is off at the
// 60s default, and full-content / claim-level validation only unlock at the
// long tiers (mirroring searchDepth's own 240s boundary). Under runtime
// deadline pressure each phase additionally gates on fitsDeadline and is
// dropped before synthesis/validation.
//
// DISABLED (2026-07): a de-noised benchmark (4 samples/cell, tests/
// denoise-driver.mjs) found these three phases NET-NEGATIVE at the deep tier —
// batch overall 2.65 (off) → 2.43 (on), with real regressions on focused
// recency/contested questions (calibration bled as distilled notes + full-page
// text diluted the answer) and NO real gain on multi-hop (1.67 → 1.89, inside
// the noise). Multi-hop needs sub-question decomposition, not more source
// material. So the activation is flipped off via this one flag while the code
// is kept for a future INTENT-gated rework (run these only for genuinely broad/
// multi-hop questions, decided by triage — not by budget alone), to be
// re-enabled only once the benchmark shows a real gain. The schema hardening in
// pipeline.js is unaffected (harmless — it only normalizes JSON behind the
// existing fail-soft fallbacks). Re-enable by flipping this to true.
const DEEP_TIER_FEATURES_ENABLED = false;

// Per-wave notes digest: mid tier and up (never at the ≤60s default).
/**
 * @param {BudgetPlan | null | undefined} plan
 * @returns {boolean}
 */
export function wantsNotes(plan) {
  return DEEP_TIER_FEATURES_ENABLED && !!plan && plan.budgetS >= 120;
}

// Full-content fetch of the top sources: only the long tiers (≥240s), where
// there is budget to read whole pages, matching searchDepth's 240s boundary.
/**
 * @param {BudgetPlan | null | undefined} plan
 * @returns {boolean}
 */
export function wantsFullContent(plan) {
  return DEEP_TIER_FEATURES_ENABLED && !!plan && plan.budgetS >= 240;
}

// Claim-level (per-claim) validation instead of the single whole-draft pass:
// long tiers only. A tight budget still runs the cheap single-pass validate.
/**
 * @param {BudgetPlan | null | undefined} plan
 * @returns {boolean}
 */
export function wantsClaimValidation(plan) {
  return DEEP_TIER_FEATURES_ENABLED && !!plan && plan.budgetS >= 240;
}
