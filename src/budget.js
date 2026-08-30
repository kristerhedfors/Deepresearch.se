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
 * import('./types.js').BudgetPlan.
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
  // The STANDARD topology's phases (src/pipeline-standard.js) and the agentic
  // answer phase's loop. Every one of these is a key recordPhase() is actually
  // called with, and a key that is not in this table is DROPPED SILENTLY
  // (recordPhase's first line) — no log, no throw, no failing test. A runner
  // whose row is missing therefore records nothing forever, so its model never
  // warms an EWMA and the planner budgets it off the cold prior for as long as
  // the omission lasts. That is the whole reason these rows land in the same
  // commit as the phases that record them.
  //
  // `queries` and `reflect` are the standard pipeline's two JSON nodes, seeded
  // at the measured priors of the triage and gap phases they replaced: one
  // planning call and one coverage call, both on the same fixed JSON model.
  //
  // `triage` and `gap` stay in this table even though the phases named after
  // them are gone. `triage` is still recorded — the source-read loop budgets
  // its planning turn under that key — and BOTH are still read by
  // planResearch below, which costs a run's planning call and a round against
  // them; model-profiles.js's per-model overrides are keyed on those names
  // too, so dropping the rows would silently un-warm every slow model's plan.
  //
  // `round` and `tool` are the agentic answer phase's — one model round that
  // may call tools, and one tool execution.
  queries: 6000,
  reflect: 4500,
  round: 9000,
  tool: 1500,
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
  // The estimate bag handed to the request as plan.estimates. `queries` and
  // `reflect` ride along because the standard engine's runtime deadline check
  // reads them (src/pipeline-standard.js) — without the rows their warmed
  // EWMAs would be recorded every request and never read once.
  //
  // The arithmetic below still costs the planning call at t.triage and a round
  // at t.gap, and deliberately so: model-profiles.js's per-model priorsMs
  // overrides are keyed on those two names (GLM's 45 s planning call is the
  // case in point), so switching the arithmetic to the new keys would silently
  // drop every slow model's calibration. The two pairs are seeded from the
  // same numbers, so nothing moves until one of them warms.
  const t = {
    triage: j.triage,
    gap: j.gap,
    queries: j.queries,
    reflect: j.reflect,
    validate: j.validate,
    synth: u.synth,
    search: u.search,
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
  // Follow-up-round ceiling. The deep tiers (the user deliberately dialled a
  // long "reason for up to N minutes" budget) get a HIGH ceiling so the loop
  // keeps taking meaningful action toward that target — the binding
  // constraints become the time deadline and the engine's own coverage
  // verdict, NOT an artificially low round count that wraps a rich question in
  // ~60-90s and leaves most of an 8-minute budget unspent (the reported "gave
  // up too early"). It is a striving ceiling, never a floor.
  //
  // The engine reading it decides how much of it to want: the standard graph's
  // reflectRoundsFor takes it as a BOOLEAN (any headroom at all buys one
  // reflect round, two only when a planner asks), because the deleted gap
  // cascade this ceiling was sized for is exactly what a compact topology is
  // offered as an alternative to. Tiers below extended (<240s) are unchanged.
  const gapRoundCap =
    budgetS >= 420 ? 8 : budgetS >= 300 ? 6 : budgetS >= 240 ? 4 : budgetS >= 60 ? 3 : 2;

  plan.queries = Math.max(1, Math.min(queryCap, Math.floor((avail * 0.6) / t.search)));
  let rest = avail - plan.queries * t.search;

  // Cost a planned round at its REAL search cost (a full follow-up wave), not a
  // nominal two, so the round count the time budget can actually afford stays
  // honest under the raised ceilings above. (At the default 60s tier this still
  // resolves to the same round count as before — time, not the ceiling, binds.)
  const gapCost = t.gap + plan.followups * t.search;
  while (plan.gapIterations < gapRoundCap && rest >= gapCost) {
    plan.gapIterations++;
    rest -= gapCost;
  }

  // Total-search ceiling scales with the report tier so it can't become the
  // premature limiter that pins a deep budget at ~20 searches; standard/default
  // keeps the historical 20.
  const searchCeiling = reportTier === "full" ? 34 : reportTier === "extended" ? 26 : 20;
  plan.maxSearches = Math.min(searchCeiling, plan.queries + plan.gapIterations * plan.followups);
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

// The search provider's /contents endpoint is billed well below a standard
// search (~$1/1k vs $7/1k as of 2026). The admin's per-search price is scaled
// by this ratio per URL fetched, so page-extraction spend is counted rather
// than silently ignored — the same approach searchDepth.costMultiplier takes
// for deeper search tiers. Its one consumer is the research toolbox's
// read_pages (src/research-tools-run.js), which fills state.fetchedUrls.
export const CONTENTS_COST_MULTIPLIER = 1 / 7;

// ---- runtime deadline checks (mechanism 3) ----------------------------------

// True if `upcomingMs` more work still fits within budget (+15% grace).
/**
 * @param {number} startedAt Request start (epoch ms).
 * @param {number} budgetMs
 * @param {number} upcomingMs
 * @returns {boolean}
 */
/** The share of the budget the gather loop is GUARANTEED, whatever the writer
 * estimates. See gatherDeadlineAt. */
export const GATHER_FLOOR = 0.4;

/**
 * When the agentic engine must stop GATHERING: the request's deadline with the
 * writer's estimated share reserved out of it — but never less than
 * GATHER_FLOOR of the budget.
 *
 * The floor is the fix for a shipped incident, and the reasoning matters more
 * than the number. The writer reserve is built from ESTIMATES (priors, then
 * per-isolate EWMAs), and an estimate can exceed the whole budget two mundane
 * ways: the brief tier's 15 s budget is smaller than the COLD priors' writer
 * share (29 s) on every request, and a few long reports warm a big model's
 * synth EWMA past any budget. Without the floor the reserve then swallowed
 * everything, the deadline landed exactly at startedAt, and the loop was
 * "stopped by the deadline" with zero tool calls — the user saw "No search
 * results were available" with web search ON (feedback #71, chat_logs #1763,
 * budget_s 15). A reserve that can turn the engine off is not a reserve.
 *
 * The floor over-commits the wall clock when the writer estimate is honest —
 * accepted: fitsDeadline's 1.15 slack absorbs some, and a report that runs
 * long is a report, where a gather of nothing is a failure.
 *
 * 0 (no bound) when the state carries no start or the plan no budget — a
 * caller mid-refactor or a test, and an unbounded loop is still bounded by its
 * rounds.
 *
 * @param {{ startedAt?: number } | null | undefined} state
 * @param {{ budgetMs?: number, estimates?: Record<string, number> } | null | undefined} plan
 * @returns {number}
 */
export function gatherDeadlineAt(state, plan) {
  const startedAt = Number(state?.startedAt);
  const budgetMs = Number(plan?.budgetMs);
  if (!Number.isFinite(startedAt) || !Number.isFinite(budgetMs) || budgetMs <= 0) return 0;
  const writer = Number(plan?.estimates?.synth || 0) + Number(plan?.estimates?.validate || 0);
  const gather = Math.max(budgetMs * 1.15 - writer, budgetMs * GATHER_FLOOR);
  return startedAt + gather;
}

/**
 * Does an upcoming phase still fit inside the request's time budget, with the
 * planner's standing 15% slack?
 * @param {number} startedAt
 * @param {number} budgetMs
 * @param {number} upcomingMs
 * @returns {boolean}
 */
export function fitsDeadline(startedAt, budgetMs, upcomingMs) {
  return Date.now() - startedAt + upcomingMs <= budgetMs * 1.15;
}
