// @ts-check
// Exa web search — backs the model's `web_search` tool.
//
// REST call to POST https://api.exa.ai/search with the EXA_API_KEY secret in
// the x-api-key header. See CLAUDE.md ("Web search — Exa") for parameter
// rules and the canonical reference URL.

import { cacheGet, cachePut } from "./edge-cache.js";

const EXA_URL = "https://api.exa.ai/search";
const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
// Bounds the /contents fetch the same way the two Berget calls are bounded —
// an unbounded fetch has bitten this project before. Full-content fetch is
// budget-gated top-tier work, so a hung backend must degrade, never hang.
const CONTENTS_TIMEOUT_MS = 20_000;
// Cap the extracted text per source so a handful of long pages can't blow the
// synthesis digest / Worker memory. Generous enough to carry a real article.
const CONTENTS_MAX_CHARS = 6000;

// Cross-request search cache. A follow-up turn is a SEPARATE /api/chat
// request, so the in-request dedup (pipeline.js's state.ranQueries) can't
// stop it re-issuing a query an earlier turn already ran — the reported
// "exact same web search again". Caching the RESULTS keyed by the query
// makes that repeat a free, instant cache hit instead of a paid Exa call.
// Uses the Workers Cache API (caches.default): durable across requests in a
// colo, shared across isolates, TTL'd via Cache-Control, and needs no
// binding. Everything here is fail-soft — any cache error just falls
// through to a normal live search.
const CACHE_TTL_S = 600; // 10 min: long enough to absorb a follow-up
// re-issuing the same query within one research session, short enough that
// "latest"-type queries don't serve staled results across sessions.

// Stable cache key for a search. The query is normalized (trimmed,
// lowercased, whitespace collapsed) — the SAME normalization pipeline.js
// uses for its in-request dedup — so trivially-different spellings of the
// same search share one entry and the depth tier (type + numResults) is
// part of the key so a deeper re-run isn't served a shallower cached result.
// Exported for unit testing; the .internal host is a synthetic key namespace
// that never leaves the isolate.
/**
 * @param {string} query
 * @param {string} type Exa search mode ("auto" | "deep" | …)
 * @param {number} numResults
 * @returns {string} a synthetic `.internal` cache-key URL
 */
export function searchCacheKey(query, type, numResults) {
  const q = String(query || "").trim().toLowerCase().replace(/\s+/g, " ");
  const params = new URLSearchParams({ q, t: String(type), n: String(numResults) });
  return `https://exa-search-cache.internal/search?${params.toString()}`;
}

// Runs a search and returns:
//   content    — compact LLM-friendly string (numbered title/URL/highlights);
//                errors come back as strings too, so the pipeline can carry
//                on instead of the request 500ing
//   items      — [{title, url, highlights[]}] structured results for the
//                pipeline's cross-search source registry
//   sources    — [{title, url}] for the UI's expandable activity panel
//   resultCount, durationMs — for UI counters and logs
//
// depth (src/budget.js's plan.searchDepth): { numResults, type } — scales
// with the time budget instead of a fixed 5-result "auto" search
// regardless of how much depth the user actually asked for.
/**
 * One structured result carried to the pipeline's source registry.
 * @typedef {{ title: string, url: string, highlights: string[] }} SearchItem
 */
/**
 * The bundle webSearch resolves to (errors come back as `content` strings,
 * never thrown, so the pipeline can carry on).
 * @typedef {object} SearchResult
 * @property {string} content compact LLM-friendly numbered digest
 * @property {SearchItem[]} items structured results for the source registry
 * @property {import('./types.js').SseSource[]} sources title/url pairs for the UI
 * @property {number} resultCount
 * @property {number} durationMs
 * @property {boolean} [cached] true when served from the edge cache
 */
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {{ numResults?: number, type?: string }} [depth] the budget's search-depth tier
 * @returns {Promise<SearchResult>}
 */
export async function webSearch(env, log, query, depth = {}) {
  const numResults = depth.numResults || 5;
  const type = depth.type || "auto";
  const startedAt = Date.now();
  /** @param {string} content */
  const failure = (content) => ({
    content,
    items: [],
    sources: [],
    resultCount: 0,
    durationMs: Date.now() - startedAt,
  });

  if (!env.EXA_API_KEY) {
    log.error("exa.misconfigured", { missing: "EXA_API_KEY" });
    return failure("Web search is unavailable: EXA_API_KEY is not configured.");
  }
  if (!query) {
    log.warn("exa.empty_query", {});
    return failure("No search query was provided.");
  }

  log.debug("exa.search_query", { query }); // user content: debug level only

  // Serve an identical earlier search from the edge cache if it's still
  // fresh — a repeated query (e.g. a follow-up turn) costs nothing and
  // returns instantly. Fail-soft: any cache miss/error falls through to a
  // live search below.
  const cacheKey = searchCacheKey(query, type, numResults);
  const cached = await cacheGet(log, "exa.cache", cacheKey);
  if (cached) {
    log.info("exa.cache_hit", {
      duration_ms: Date.now() - startedAt,
      results: cached.resultCount,
      query_chars: query.length,
      type,
    });
    return { ...cached, durationMs: Date.now() - startedAt, cached: true };
  }

  let resp;
  try {
    resp = await fetch(EXA_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.EXA_API_KEY,
      },
      body: JSON.stringify({
        query,
        type,
        numResults,
        contents: { highlights: true },
      }),
    });
  } catch (err) {
    const msg = /** @type {any} */ (err)?.message || String(err);
    log.error("exa.request_failed", { error: msg, duration_ms: Date.now() - startedAt });
    return failure(`Search request failed: ${msg}`);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    log.error("exa.error", {
      status: resp.status,
      duration_ms: Date.now() - startedAt,
      detail: detail.slice(0, 300),
    });
    return failure(`Search error (${resp.status}): ${detail.slice(0, 300)}`);
  }

  const data = await resp.json().catch(() => ({}));
  const results = /** @type {any[]} */ (Array.isArray(data.results) ? data.results : []);
  const durationMs = Date.now() - startedAt;
  log.info("exa.search", {
    duration_ms: durationMs,
    results: results.length,
    query_chars: query.length,
    type,
    num_results_requested: numResults,
  });

  if (results.length === 0) {
    return { ...failure(`No results found for: ${query}`), durationMs };
  }

  const content = results
    .map((r, i) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.join(" … ") : "";
      return `[${i + 1}] ${r.title || "(untitled)"}\n${r.url}\n${highlights}`.trim();
    })
    .join("\n\n");

  const result = {
    content,
    items: results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      highlights: Array.isArray(r.highlights) ? r.highlights : [],
    })),
    sources: results.map((r) => ({ title: r.title || r.url, url: r.url })),
    resultCount: results.length,
  };

  // Cache the successful, non-empty result so a later identical query is a
  // free hit. Only good results are cached (errors and empty results return
  // early above and are deliberately left uncached so a retry can find
  // something). Fail-soft: a cache write error never affects the response.
  await cachePut(log, "exa.cache", cacheKey, result, CACHE_TTL_S);

  return { ...result, durationMs, cached: false };
}

// Stable cache key for a full-content fetch: the sorted, normalized URL set.
/**
 * @param {string[]} urls
 * @returns {string} a synthetic `.internal` cache-key URL
 */
export function contentsCacheKey(urls) {
  const norm = [...new Set((urls || []).map((u) => String(u || "").trim()).filter(Boolean))].sort();
  const params = new URLSearchParams({ u: norm.join("|") });
  return `https://exa-contents-cache.internal/contents?${params.toString()}`;
}

// Fetches the full page text for a small set of top sources via Exa's
// /contents endpoint (same x-api-key auth as webSearch). Budget-gated top-tier
// enrichment: bounded, cache-friendly, and fully fail-soft — a missing key, a
// timeout, an error, or a bad response all degrade to an empty result rather
// than throwing, so the pipeline proceeds on the highlights it already has.
//
// Returns { results: [{ url, title, text }], durationMs, cached }.
/**
 * @param {import('./types.js').Env} env
 * @param {string[]} urls
 * @param {import('./types.js').Logger} log
 * @returns {Promise<{ results: Array<{ url: string, title: string, text: string }>, durationMs: number, cached: boolean }>}
 */
export async function fetchContents(env, urls, log) {
  const startedAt = Date.now();
  const empty = (cached = false) => ({ results: [], durationMs: Date.now() - startedAt, cached });
  const list = [...new Set((urls || []).map((u) => String(u || "").trim()).filter(Boolean))];
  if (!list.length) return empty();
  if (!env.EXA_API_KEY) {
    log.error("exa.contents_misconfigured", { missing: "EXA_API_KEY" });
    return empty();
  }

  const cacheKey = contentsCacheKey(list);
  const cached = await cacheGet(log, "exa.contents_cache", cacheKey);
  if (cached) {
    log.info("exa.contents_cache_hit", { duration_ms: Date.now() - startedAt, results: cached.results?.length || 0 });
    return { ...cached, durationMs: Date.now() - startedAt, cached: true };
  }

  let resp;
  try {
    resp = await fetch(EXA_CONTENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY },
      body: JSON.stringify({ urls: list, text: { maxCharacters: CONTENTS_MAX_CHARS } }),
      signal: AbortSignal.timeout(CONTENTS_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn("exa.contents_request_failed", { error: /** @type {any} */ (err)?.message || String(err), duration_ms: Date.now() - startedAt });
    return empty();
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    log.warn("exa.contents_error", { status: resp.status, detail: detail.slice(0, 200), duration_ms: Date.now() - startedAt });
    return empty();
  }

  const data = await resp.json().catch(() => ({}));
  const rows = /** @type {any[]} */ (Array.isArray(data.results) ? data.results : []);
  const results = rows
    .map((r) => ({
      url: r.url || "",
      title: r.title || r.url || "",
      text: typeof r.text === "string" ? r.text.slice(0, CONTENTS_MAX_CHARS) : "",
    }))
    .filter((r) => r.url && r.text);
  const durationMs = Date.now() - startedAt;
  log.info("exa.contents", { duration_ms: durationMs, requested: list.length, results: results.length });

  const result = { results };
  if (results.length) {
    await cachePut(log, "exa.contents_cache", cacheKey, result, CACHE_TTL_S);
  }
  return { ...result, durationMs, cached: false };
}
