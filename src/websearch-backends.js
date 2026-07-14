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
// backend RESOLUTION and the full config allowlist (which includes the built-in
// "exa").
//
// Se/rver flow: the admin picks ONE backend for the whole server (src/config.js
// `search` block + the SEARCH_BACKEND_URL/SEARCH_BACKEND_KEY secrets), and
// src/exa.js's webSearch routes a non-"exa" selection here, falling back to Exa
// on failure. See the local-web-search skill for running your own service.

import {
  SELF_HOSTED_BACKENDS,
  runBackendSearch as coreRunBackendSearch,
} from "../public/js/websearch-backends-core.js";

export {
  itemsDigest,
  resultFromItems,
  parseSearxngResults,
  parseExaCompatibleResults,
} from "../public/js/websearch-backends-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('../public/js/websearch-backends-core.js').SearchItem} SearchItem */

// The config allowlist: the built-in "exa" plus the self-hosted shapes the core
// handles. config.js validates the admin's `search.backend` against this.
export const SEARCH_BACKENDS = ["exa", ...SELF_HOSTED_BACKENDS];

/**
 * The effective backend selection, resolved from site config with an env
 * override. A `SEARCH_BACKEND_URL` var/secret wins over the stored base URL (so
 * a base URL can be kept out of the admin-editable D1 config entirely), and
 * `SEARCH_BACKEND_KEY` is the auth secret (never stored in config).
 * @param {Env} env
 * @param {{ backend?: string, base_url?: string, results?: number, fallback_exa?: boolean }} [searchCfg]
 * @returns {{ backend: string, baseUrl: string, key: string, results: number, fallbackExa: boolean }}
 */
export function resolveSearchBackend(env, searchCfg = {}) {
  const backend = SEARCH_BACKENDS.includes(String(searchCfg.backend)) ? String(searchCfg.backend) : "exa";
  const envUrl = /** @type {any} */ (env)?.SEARCH_BACKEND_URL;
  const baseUrl = String((typeof envUrl === "string" && envUrl) || searchCfg.base_url || "")
    .trim()
    .replace(/\/+$/, "");
  const key = String(/** @type {any} */ (env)?.SEARCH_BACKEND_KEY || "").trim();
  const results = Number.isFinite(searchCfg.results) && Number(searchCfg.results) > 0
    ? Math.min(20, Math.max(1, Math.round(Number(searchCfg.results))))
    : 6;
  return { backend, baseUrl, key, results, fallbackExa: searchCfg.fallback_exa !== false };
}

/**
 * Runs the configured SELF-HOSTED backend (server-side), delegating to the
 * shared core. Returns null for "exa" (the caller uses the native Exa path) or
 * on any failure. The `env` arg is kept in the signature for call-site symmetry
 * with the rest of src/ even though the core needs only the resolved config.
 * @param {Env} _env
 * @param {Logger} log
 * @param {{ backend: string, baseUrl: string, key: string, results: number, fallbackExa: boolean }} resolved
 * @param {string} query
 * @param {{ numResults?: number, type?: string }} depth
 * @returns {Promise<{ content: string, items: SearchItem[], sources: import('./types.js').SseSource[], resultCount: number } | null>}
 */
export async function runBackendSearch(_env, log, resolved, query, depth) {
  return coreRunBackendSearch(log, resolved, query, depth);
}
