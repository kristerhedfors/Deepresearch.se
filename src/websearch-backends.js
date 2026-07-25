// @ts-check
// The pluggable web-search backend — SERVER FAÇADE.
//
// The actual adapters (SearXNG + Exa-compatible), the parsers, and the fail-soft
// dispatch live in ONE shared pure core: public/js/websearch-backends-core.js.
// It sits under public/ because the browser (Se/cure — public/cure/drc.js)
// imports it directly to call a self-hosted backend STRAIGHT from the browser,
// while the Worker's bundler can import from any repo path — so both tiers reach
// the same single source of truth (the bash-core.js / introspect-core.js
// arrangement). This module adds only what is SERVER-shaped: the config-vs-env
// backend RESOLUTION, the full config allowlist (which includes the built-in
// "exa"), and the one backend that can ONLY run server-side — "cloudflare"
// (src/websearch-cf.js), where the Worker itself is the search engine.
//
// Se/rver flow: the admin picks ONE backend for the whole server (src/config.js
// `search` block + the SEARCH_BACKEND_URL/SEARCH_BACKEND_KEY secrets), and
// src/exa.js's webSearch routes a non-"exa" selection here, falling back to Exa
// on failure. See the local-web-search skill for running your own service.
//
// On top of that server-wide selection sits the per-request USER choice: the
// web knob's long-press card (UX-10) lets a person pick who runs their
// searches — Exa (the default) or Cloudflare-originating. Only those two are
// user-selectable; a self-hosted backend stays an operator decision because it
// names an operator's own service. `search.allow_user_choice` (default true)
// lets an admin pin the site-wide backend and take the picker away.

import {
  SELF_HOSTED_BACKENDS,
  resultFromItems,
  runBackendSearch as coreRunBackendSearch,
} from "../public/js/websearch-backends-core.js";
import { cloudflareSearch, normalizeSerpProviders } from "./websearch-cf.js";

export {
  itemsDigest,
  resultFromItems,
  parseSearxngResults,
  parseExaCompatibleResults,
} from "../public/js/websearch-backends-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('../public/js/websearch-backends-core.js').SearchItem} SearchItem */

// The backend that runs INSIDE this Worker (src/websearch-cf.js). Server-only
// by construction: it fetches a SERP and result pages cross-origin, which a
// browser cannot do — so it is deliberately NOT in the core's shared list that
// Se/cure's browser-direct picker reads.
export const CLOUDFLARE_BACKEND = "cloudflare";

// The config allowlist: the built-in "exa", the Worker-native backend, plus the
// self-hosted shapes the core handles. config.js validates the admin's
// `search.backend` against this.
export const SEARCH_BACKENDS = ["exa", CLOUDFLARE_BACKEND, ...SELF_HOSTED_BACKENDS];

// The subset a USER may pick per request from the web knob's long-press card.
// Deliberately just the two that need no operator setup: Exa (the default, a
// hosted third party) and the Worker-native one (no third party at all). A
// self-hosted backend names the operator's own service and stays admin-only.
export const USER_SEARCH_SOURCES = ["exa", CLOUDFLARE_BACKEND];

/**
 * Coerces a request-supplied search source to a user-selectable id, or "" for
 * "no choice — use the site default". Anything unknown becomes "", so a
 * malformed body can never route a search somewhere unvalidated.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSearchSource(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return USER_SEARCH_SOURCES.includes(v) ? v : "";
}

/**
 * The effective backend selection, resolved from site config with an env
 * override and — when the site allows it — a per-request user choice. A
 * `SEARCH_BACKEND_URL` var/secret wins over the stored base URL (so a base URL
 * can be kept out of the admin-editable D1 config entirely), and
 * `SEARCH_BACKEND_KEY` is the auth secret (never stored in config).
 *
 * Precedence: an allowed user source > the admin's configured backend > Exa.
 * The user source only ever selects between the two USER_SEARCH_SOURCES, so it
 * can never point a search at an unvalidated target.
 * @param {Env} env
 * @param {{ backend?: string, base_url?: string, results?: number, fallback_exa?: boolean, cf_pages?: boolean, cf_serp?: string[], allow_user_choice?: boolean }} [searchCfg]
 * @param {string} [userSource] the request's `search_source` (already trusted-set
 *   or ""), ignored when the admin pinned the site-wide backend
 * @returns {{ backend: string, baseUrl: string, key: string, results: number, fallbackExa: boolean, pages: boolean, serp: string[] }}
 */
export function resolveSearchBackend(env, searchCfg = {}, userSource = "") {
  const configured = SEARCH_BACKENDS.includes(String(searchCfg.backend)) ? String(searchCfg.backend) : "exa";
  const picked = searchCfg.allow_user_choice === false ? "" : normalizeSearchSource(userSource);
  const backend = picked || configured;
  const envUrl = /** @type {any} */ (env)?.SEARCH_BACKEND_URL;
  const baseUrl = String((typeof envUrl === "string" && envUrl) || searchCfg.base_url || "")
    .trim()
    .replace(/\/+$/, "");
  const key = String(/** @type {any} */ (env)?.SEARCH_BACKEND_KEY || "").trim();
  const results = Number.isFinite(searchCfg.results) && Number(searchCfg.results) > 0
    ? Math.min(20, Math.max(1, Math.round(Number(searchCfg.results))))
    : 6;
  return {
    backend,
    baseUrl,
    key,
    results,
    fallbackExa: searchCfg.fallback_exa !== false,
    // Whether the Cloudflare backend also fetches result pages for real text
    // excerpts (vs. SERP snippets alone). On by default — snippet-only answers
    // noticeably thinner than Exa's highlights.
    pages: searchCfg.cf_pages !== false,
    // …and the ordered results-page sources it tries. Normalized here so a
    // stale or hand-edited config row can never leave it with nothing.
    serp: normalizeSerpProviders(searchCfg.cf_serp),
  };
}

/**
 * Runs the resolved NON-Exa backend server-side: the Worker-native
 * "cloudflare" one here, everything self-hosted via the shared core. Returns
 * null for "exa" (the caller uses the native Exa path) or on any failure. The
 * `env` arg is kept in the signature for call-site symmetry with the rest of
 * src/ even though neither leg needs more than the resolved config.
 * @param {Env} _env
 * @param {Logger} log
 * @param {{ backend: string, baseUrl: string, key: string, results: number, fallbackExa: boolean, pages?: boolean, serp?: string[] }} resolved
 * @param {string} query
 * @param {{ numResults?: number, type?: string }} depth
 * @returns {Promise<{ content: string, items: SearchItem[], sources: import('./types.js').SseSource[], resultCount: number } | null>}
 */
export async function runBackendSearch(_env, log, resolved, query, depth) {
  if (resolved.backend === CLOUDFLARE_BACKEND) {
    const limit = Number(depth?.numResults) > 0 ? Number(depth.numResults) : resolved.results;
    const items = await cloudflareSearch(log, query, limit, {
      pages: resolved.pages !== false,
      providers: resolved.serp,
    }).catch(() => null);
    return items ? resultFromItems(items) : null;
  }
  return coreRunBackendSearch(log, resolved, query, depth);
}
