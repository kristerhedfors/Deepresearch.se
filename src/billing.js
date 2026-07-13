// @ts-check
// Split-billing spend summarization for a completed research request — the
// shared math behind both request channels (/api/chat in src/chat.js and
// POST /mcp in src/mcp.js), which used to re-inline it verbatim. A request
// can run up to three models at three different catalog rates (the synthesis/
// direct answer on the user's model, the JSON planning phases on the fixed
// reliable jsonModel, and the Street View vision-describe helper on its own
// model), so tokens alone can't cap spend — each bucket is priced at its own
// rate. Pure (state + catalog/config in, totals/number out); a leaf module
// (only the pure cost primitives bergetCost/CONTENTS_COST_MULTIPLIER) so
// mcp.js can pull it into its dynamic-import block without dragging in the
// pipeline.

import { bergetCost } from "./quota.js";
import { CONTENTS_COST_MULTIPLIER } from "./budget.js";

/** @typedef {import('./types.js').RequestState} RequestState */
/** @typedef {import('./types.js').ModelCatalog} ModelCatalog */

/**
 * Sums the request's token totals and Berget cost across the up-to-three
 * models that ran: synthesis/direct on the user's model, the JSON planning
 * phases on jsonModel (Mistral), and the Street View vision-describe helper
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
