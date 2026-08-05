// @ts-check
// Split-billing spend summarization for a completed research request — the
// shared math behind both request channels (/api/chat in src/chat.js and
// POST /mcp in src/mcp.js), which used to re-inline it verbatim. A request
// can run up to three models at three different catalog rates (the synthesis/
// direct answer on the user's model, the JSON planning phases on the fixed
// reliable jsonModel, and the vision-describe helper on its own
// model), so tokens alone can't cap spend — each bucket is priced at its own
// rate. Pure (state + catalog/config in, totals/number out) EXCEPT for the
// dense-retrieval half at the bottom, which has to reach Berget's raw catalog
// (see priceRetrievalSpend); a leaf module (the pure cost primitives
// bergetCost/CONTENTS_COST_MULTIPLIER plus berget.js's price normalizers and
// dense-rag.js's tally shape) so mcp.js can pull it into its dynamic-import
// block without dragging in the pipeline.

import { bergetCost } from "./quota.js";
import { CONTENTS_COST_MULTIPLIER } from "./budget.js";
import { embedModel, eurPerTokenFromBerget, rawModelEntry } from "./berget.js";
import { RERANK_MODEL } from "./dense-rag.js";

/** @typedef {import('./types.js').RequestState} RequestState */
/** @typedef {import('./types.js').ModelCatalog} ModelCatalog */

/**
 * Sums the request's token totals and Berget cost across the up-to-three
 * models that ran: synthesis/direct on the user's model, the JSON planning
 * phases on jsonModel (Mistral), and the vision-describe helper
 * on its own model — the split-billing design, each bucket priced at its own
 * catalog rate (tokens alone can't cap spend when models price differently).
 * Pure (state + catalog in, totals out).
 * @param {Pick<RequestState, "model" | "jsonModel" | "visionModel" | "totals" | "jsonTotals" | "visionTotals">} state
 * @param {ModelCatalog | null | undefined} catalog
 * @returns {{ prompt_tokens: number, completion_tokens: number, berget_cost: number }}
 */
export function summarizeSpend(state, catalog) {
  /** @type {Array<[string | null, import('./types.js').TokenTotals]>} */
  const buckets = [
    [state.model, state.totals],
    [state.jsonModel, state.jsonTotals],
    [state.visionModel, state.visionTotals],
  ];
  let prompt_tokens = 0;
  let completion_tokens = 0;
  let berget_cost = 0;
  for (const [modelId, totals] of buckets) {
    prompt_tokens += totals.prompt_tokens;
    completion_tokens += totals.completion_tokens;
    const entry = catalog?.find((m) => m.id === modelId);
    berget_cost += bergetCost(entry, totals.prompt_tokens, totals.completion_tokens);
  }
  return { prompt_tokens, completion_tokens, berget_cost };
}

/**
 * Per-model spend attribution for the request: one row per model bucket that
 * ran (answer / JSON planning / vision), each priced at its own catalog rate.
 * Where summarizeSpend COLLAPSES the three buckets into a single total (all the
 * quota-enforcement ledger needs — a cost cap doesn't care which model spent
 * it), this KEEPS them apart so a user's spend stays attributable to the model
 * that actually drove it: the answer model the user chose, the fixed JSON
 * planning model (Mistral), or the vision helper. Without this the
 * whole request's Berget cost is folded onto the single answer model, and you
 * can no longer tell an expensive answer model from a search-heavy run that
 * pounded the cheap JSON phases. Feeds the usage_model_events attribution
 * ledger (src/quota.js recordModelUsage) that getUsageByModelForUser reads.
 *
 * The `answer` bucket is ALWAYS emitted — even at zero tokens it carries the
 * request (a search-only reply spends no answer-model tokens but is still a
 * request that cost Exa money); the json/vision buckets only when they spent.
 * Pure (state + catalog in, rows out); never throws.
 * @param {Pick<RequestState, "model" | "jsonModel" | "visionModel" | "totals" | "jsonTotals" | "visionTotals">} state
 * @param {ModelCatalog | null | undefined} catalog
 * @returns {Array<{ role: "answer" | "json" | "vision", model: string | null, prompt_tokens: number, completion_tokens: number, berget_cost: number }>}
 */
export function spendByModel(state, catalog) {
  /** @type {Array<["answer" | "json" | "vision", string | null, import('./types.js').TokenTotals]>} */
  const buckets = [
    ["answer", state.model, state.totals],
    ["json", state.jsonModel, state.jsonTotals],
    ["vision", state.visionModel, state.visionTotals],
  ];
  /** @type {Array<{ role: "answer" | "json" | "vision", model: string | null, prompt_tokens: number, completion_tokens: number, berget_cost: number }>} */
  const rows = [];
  for (const [role, modelId, totals] of buckets) {
    const prompt_tokens = totals?.prompt_tokens || 0;
    const completion_tokens = totals?.completion_tokens || 0;
    // Skip an unused helper bucket, but always keep the answer row (it carries
    // the request and its Exa/search cost even when it spent no LLM tokens).
    if (role !== "answer" && prompt_tokens + completion_tokens === 0) continue;
    const entry = catalog?.find((m) => m.id === modelId);
    rows.push({
      role,
      model: modelId ?? null,
      prompt_tokens,
      completion_tokens,
      berget_cost: bergetCost(entry, prompt_tokens, completion_tokens),
    });
  }
  return rows;
}

/**
 * The request's Exa cost. The admin-configured per-search price is priced
 * for Exa's standard tier; a request whose time budget bought a costlier
 * tier (src/budget.js's searchDepth, e.g. `type: "deep"`) gets its recorded
 * cost scaled by that tier's real price ratio, so a long budget's genuinely
 * higher Exa spend doesn't go under-counted against the user's opaque
 * budget bar or the admin's cost totals. Live searches at their depth-tier
 * price, PLUS the budget-gated full-content fetch (Exa /contents) priced
 * per URL at the cheaper contents rate — so the top-tier full-read spend is
 * counted too.
 * @param {Pick<RequestState, "plan"> & { fetchedUrls?: Set<string> }} state
 * @param {import('./config.js').SiteConfig} config
 * @param {number} billedSearches live (non-cached) searches
 * @returns {number} EUR
 */
export function exaCost(state, config, billedSearches) {
  return (
    billedSearches * config.exa_cost_per_search_eur * (state.plan.searchDepth?.costMultiplier || 1) +
    (state.fetchedUrls?.size || 0) * config.exa_cost_per_search_eur * CONTENTS_COST_MULTIPLIER
  );
}

// ---- the DENSE-RETRIEVAL bucket ---------------------------------------------
//
// The hosted arXiv and PubMed tiers (src/dense-rag.js, reached from the search
// wave through src/arxiv.js and src/europepmc.js) spend real Berget money on
// every leg: CANDIDATES (50) documents cut to RERANK_DOC_CHARS (900) through
// BAAI/bge-reranker-v2-m3 at €0.10/M — measured at usage.total_tokens = 10,198
// for one leg — plus the one multilingual-e5-large embedding call in front of
// it at €0.03/M. A request runs SEVERAL legs (multiple angles, two corpora,
// several search rounds), so the tally accumulates across the request and is
// priced once here.
//
// WHY A FOURTH BUCKET AND NOT A FOURTH ROW IN summarizeSpend. The three buckets
// above are (model id → catalog entry → bergetCost) and they are SYNCHRONOUS
// and PURE for a reason: the caller already holds the chat catalog. Neither the
// reranker nor the embedder is in that catalog — berget.js's fetchCatalog
// filters `list` to model_type "text" with streaming + json_mode, which is why
// GET /api/models does not show them — so bergetCost's lookup would price them
// at €0 forever. They ARE in Berget's raw /v1/models, so they are priced the way
// src/rag.js already prices an embedding call: rawModelEntry (the entry
// verbatim, or null when the catalog is unreachable) + eurPerTokenFromBerget
// (which normalizes whatever unit Berget states a price in to EUR PER TOKEN).
// That lookup is ASYNC, which is what keeps it out of summarizeSpend rather than
// any judgement about where the money belongs. No price is hard-coded: an
// invented one outlives the day Berget changes it.
//
// It is still ONE recordUsage row and ONE recordModelUsage call per request —
// the caller adds `berget_cost`/`prompt_tokens` into the totals summarizeSpend
// produced and appends `by_model` to spendByModel's rows. A second usage row per
// request would double the request count every quota and cost view reads.
//
// COUNT DIMENSION: deliberately NOT `searches`, matching what src/literature-run.js
// decided for the same spend on the /mcp side. That count's live limits (300 per
// 5 h … 12,000 per month) are calibrated to Exa searches at €0.005 each and
// `exa_cost` sits beside it as Exa's own money; folding a €0.001 dense leg into
// it would make one column mean two prices and would show searches that bought
// no Exa. The EUR dimension bites on its own.

/** @typedef {import('./dense-rag.js').RetrievalSpend} RetrievalSpend */

/**
 * EUR for a dense-retrieval tally, per model. Fail-soft in every direction: an
 * unreachable catalog, an unpriced entry or a price in an unexpected unit all
 * degrade to €0 rather than to an error or an invented number.
 * @param {any} env
 * @param {RetrievalSpend} spend
 * @returns {Promise<{ berget_cost: number, by_model: Array<{ role: string, model: string, prompt_tokens: number, completion_tokens: number, berget_cost: number }> }>}
 */
export async function priceRetrievalSpend(env, spend) {
  const embedId = spend.embedModelId || embedModel(env);
  const [rerankEntry, embedEntry] = await Promise.all([
    spend.rerankTokens ? rawModelEntry(env, RERANK_MODEL) : Promise.resolve(null),
    spend.embedTokens ? rawModelEntry(env, embedId) : Promise.resolve(null),
  ]);
  // Both are input-only workloads: a reranker emits a score, not tokens, and the
  // embedder's output price is €0.
  const rerankCost = spend.rerankTokens * eurPerTokenFromBerget(rerankEntry?.pricing, "input");
  const embedCost = spend.embedTokens * eurPerTokenFromBerget(embedEntry?.pricing, "input");
  /** @type {Array<{ role: string, model: string, prompt_tokens: number, completion_tokens: number, berget_cost: number }>} */
  const by_model = [];
  if (spend.rerankTokens) {
    by_model.push({
      role: "rerank",
      model: RERANK_MODEL,
      prompt_tokens: spend.rerankTokens,
      completion_tokens: 0,
      berget_cost: rerankCost,
    });
  }
  if (spend.embedTokens) {
    by_model.push({
      role: "embed",
      model: embedId,
      prompt_tokens: spend.embedTokens,
      completion_tokens: 0,
      berget_cost: embedCost,
    });
  }
  return { berget_cost: rerankCost + embedCost, by_model };
}

/**
 * The request's dense-retrieval spend, ready to fold into the row
 * summarizeSpend/spendByModel produced. A request whose search wave never
 * touched a hosted index (no binding, no life-science/arXiv intent, search off)
 * returns all zeroes and NO by_model rows, so what it records is byte-identical
 * to what it recorded before this bucket existed — and it makes no catalog
 * request either.
 *
 * NEVER throws: this runs in the same accounting `finally` as the rest, and
 * invariant 2 is absolute — an unreachable Berget catalog must degrade the
 * accounting, not the answer that was already streamed.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {{ denseTotals?: RetrievalSpend | null }} state
 * @returns {Promise<{ prompt_tokens: number, berget_cost: number, by_model: Array<{ role: string, model: string, prompt_tokens: number, completion_tokens: number, berget_cost: number }> }>}
 */
export async function denseSpend(env, log, state) {
  const spend = state?.denseTotals;
  const tokens = (spend?.rerankTokens || 0) + (spend?.embedTokens || 0);
  if (!spend || !tokens) return { prompt_tokens: 0, berget_cost: 0, by_model: [] };
  try {
    const { berget_cost, by_model } = await priceRetrievalSpend(env, spend);
    log?.info?.("dense.spend", {
      rerank_tokens: spend.rerankTokens,
      embed_tokens: spend.embedTokens,
      rerank_calls: spend.rerankCalls,
      estimated_calls: spend.estimatedCalls,
      berget_cost,
    });
    return { prompt_tokens: tokens, berget_cost, by_model };
  } catch (/** @type {any} */ err) {
    log?.warn?.("dense.spend_price_failed", { error: err?.message || String(err) });
    // The tokens were still spent, so they are still recorded — at €0, which is
    // the honest fail-soft direction (never guess a price).
    return { prompt_tokens: tokens, berget_cost: 0, by_model: [] };
  }
}
