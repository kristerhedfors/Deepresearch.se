// @ts-check
// The search-source registry: every auxiliary deep-research source that
// runs ALONGSIDE Exa in the search waves plugs in HERE, and only here.
//
// WHY A REGISTRY: parallel sessions routinely work on different sources at
// the same time (observed 2026-07-08: an HF Hub session and a Street View
// session pushing to `main` within minutes of each other). Before this
// existed, one source's integration touched FOUR shared files —
// pipeline.js (imports + a bespoke maybeXxxSearch), prompts.js (planner
// vocabulary), sources.js (diversity keying), plus its own module — so two
// source-sessions were guaranteed to collide in the shared orchestrator.
// Now a source is: ONE self-contained module (src/<source>.js, no imports
// from other src/ modules) + ONE entry in this list + its own test file.
// pipeline.js, prompts.js, and sources.js iterate the registry and never
// name an individual source.
//
// The entry contract is the SearchSource typedef below (see the
// **add-research-source** skill for the full integration playbook — intent
// design, empirical API probing, the validation ladder). Everything a
// source contributes is DATA in its entry — the orchestration (wave
// timing, dedup, caps, SSE events, fail-soft) lives once in pipeline.js's
// runAuxSearches and is identical for every source.

import { hfDiversityKey, hfIntent, hfPickQuery, hfPromptNote, hfSearch, hfTermKey } from "./hf.js";

/**
 * One search result an auxiliary source returns, in the same shape Exa
 * items take so sources.js can register them unchanged.
 * @typedef {{ url: string, title: string, highlights?: string[] }} SearchSourceItem
 */

/**
 * What a source's `search` call resolves to. `usedKeys` lists the attempt
 * keys this call consumed (hit or miss), recorded by the orchestrator so a
 * later wave's ladder skips them instead of re-fetching identical results.
 * @typedef {{ items: SearchSourceItem[], durationMs: number, usedKeys?: string[] }} SearchSourceResult
 */

/**
 * The registry entry contract (pinned by search-sources.test.js).
 * @typedef {Object} SearchSource
 * @property {string} id
 *   Short slug; also the per-request state bucket name (state.aux[id]) and
 *   the log prefix ("<id>.search").
 * @property {(text: string) => boolean} intent
 *   Pure predicate on the LATEST USER MESSAGE deciding whether this source
 *   fires at all. Must be cheap and conservative; when false the source is
 *   fully invisible (no step, no event, no fetch).
 * @property {(env: import('./types.js').Env, log: import('./types.js').Logger, query: string, opts: { skipKeys?: Set<string> }) => Promise<SearchSourceResult>} search
 *   The timeout-bounded, fail-soft client call. `skipKeys` is the set of
 *   attempt keys earlier waves consumed (skip them — don't re-fetch the
 *   same results).
 * @property {string} service
 *   Human display name shown on the client's search cards and carried on
 *   the search events as `service` (e.g. "Hugging Face Hub" — the UI must
 *   always make clear WHICH provider a card came from; plain web cards say
 *   "Web search").
 * @property {(batch: string[]) => string} [pickQuery]
 *   Picks which of the wave's planned queries this source searches
 *   (default batch[0]). hf picks the most entity/identifier-bearing one —
 *   the web→hub insight flow (a gap query learned from web results, like a
 *   CVE id, is exactly what the hub can answer).
 * @property {(query: string) => string} [dedupKey]
 *   Normalizes a query for cross-wave dedup (defaults to lowercased
 *   trimmed query text).
 * @property {number} [maxPerRequest]
 *   Wave cap per request (default 3 — pipeline.js MAX_AUX_SEARCHES_DEFAULT).
 * @property {string} [promptNote]
 *   Planner-vocabulary sentence spliced into the triage AND gap prompts
 *   (site-specific abbreviations, "never clarify X", query-spelling
 *   guidance). Starts with a leading space; keep it ONE sentence.
 * @property {string} [diversityHost]
 *   With diversityKeyOf, an optional pair: when the source's results live
 *   on a PLATFORM domain hosting many independent authors, sources.js keys
 *   that host's URLs with diversityKeyOf instead of the hostname, so the
 *   per-origin cap doesn't starve platform results while still capping any
 *   single author/namespace.
 * @property {(url: string) => string} [diversityKeyOf]
 */

/** @type {SearchSource[]} */
export const SEARCH_SOURCES = [
  {
    id: "hf",
    intent: hfIntent,
    // Cast: hf.js is unannotated, so hfSearch's inferred item type carries a
    // pre-filter `| null` its own code removes before returning.
    search: /** @type {SearchSource['search']} */ (hfSearch),
    service: "Hugging Face Hub",
    pickQuery: hfPickQuery,
    dedupKey: hfTermKey,
    maxPerRequest: 3,
    promptNote: hfPromptNote,
    diversityHost: "huggingface.co",
    diversityKeyOf: hfDiversityKey,
  },
];

// The concatenated planner-vocabulary notes for the triage/gap prompts
// (prompts.js splices this next to its other standing rules). Empty string
// when no source declares one, so the prompts are byte-identical to a
// registry with no notes.
/** @returns {string} */
export function sourcePromptNotes() {
  return SEARCH_SOURCES.map((s) => s.promptNote || "").join("");
}

// Platform-aware diversity key override, consulted by sources.js's
// diversityKeyOf: returns the source-declared key for a URL on a declared
// platform host, or null when no source claims the host (→ hostname key).
/**
 * @param {string} host
 * @param {string} url
 * @returns {string | null}
 */
export function platformDiversityKey(host, url) {
  for (const s of SEARCH_SOURCES) {
    if (s.diversityHost && s.diversityHost === host && typeof s.diversityKeyOf === "function") {
      return s.diversityKeyOf(url);
    }
  }
  return null;
}
