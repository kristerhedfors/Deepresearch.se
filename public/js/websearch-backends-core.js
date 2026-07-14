// @ts-check
// SHARED pure core for the pluggable web-search BACKENDS — the "bring your own
// search" seam, used by BOTH tiers:
//   - Se/rver (DRS): src/websearch-backends.js re-exports this as a façade;
//     the admin configures ONE backend for the whole server (src/config.js's
//     `search` block) and src/exa.js routes through it.
//   - Se/cure (DRC): public/cure/drc.js imports this directly and calls a
//     self-hosted backend STRAIGHT FROM THE BROWSER (server in no data path),
//     configured per-user inside the sealed project state.
//
// It lives under public/ (like bash-core.js / introspect-core.js) because the
// browser can only import modules the Worker serves, while the Worker's bundler
// can import from any repo path — so both tiers reach the SAME single source of
// truth. Two self-hosted shapes are handled:
//
//   "searxng"         — a SearXNG instance's JSON API
//                       (GET {base}/search?q=…&format=json).
//   "exa_compatible"  — any service speaking Exa's own wire
//                       (POST {base}/search, x-api-key, {results:[{title,url,
//                       highlights}]}). The local-web-search skill ships a
//                       Playwright service that does exactly this.
//
// Everything is FAIL-SOFT (the pipeline's helper-phase contract): a
// misconfigured or unreachable backend returns null so the caller degrades
// (Se/rver falls back to Exa; Se/cure falls back to the offline harvest / the
// server grant). Only the query string ever crosses the wire.
//
// NOTE (Se/cure): a browser-direct call needs the self-hosted service to send
// CORS headers (Access-Control-Allow-Origin) — an expert responsibility the
// /cure settings UI spells out. Node and the Worker have no such restriction.

/** @typedef {{ title: string, url: string, highlights: string[] }} SearchItem */
/** @typedef {{ title: string, url: string }} Source */
/** @typedef {{ debug?: Function, info?: Function, warn?: Function, error?: Function }} Logger */

// Bound every backend fetch the same way the Exa/Berget calls are bounded — a
// hung self-hosted service must degrade to null, never hang the search wave.
export const BACKEND_TIMEOUT_MS = 15_000;
// Cap extracted text per source so a chatty backend can't blow the synthesis
// digest / memory — the same budget exa.js uses for /contents.
export const HIGHLIGHT_MAX_CHARS = 1200;
// The SELF-HOSTED backend shapes this core's adapters handle. The server's
// full config allowlist adds "exa" (the built-in) on top of these.
export const SELF_HOSTED_BACKENDS = ["searxng", "exa_compatible"];

/** @param {Logger} [log] @returns {Required<Logger>} a log that never throws */
function safeLog(log) {
  const noop = () => {};
  return { debug: log?.debug || noop, info: log?.info || noop, warn: log?.warn || noop, error: log?.error || noop };
}

/**
 * Builds the compact LLM-friendly numbered digest — byte-identical to the
 * shape exa.js emits, so synthesis reads every backend the same way.
 * @param {SearchItem[]} items
 * @returns {string}
 */
export function itemsDigest(items) {
  return items
    .map((r, i) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.join(" … ") : "";
      return `[${i + 1}] ${r.title || "(untitled)"}\n${r.url}\n${highlights}`.trim();
    })
    .join("\n\n");
}

/**
 * Assembles a full result object (content/items/sources/resultCount) from a
 * list of normalized items. Returns null for an empty list so callers can fall
 * through to their own fallback.
 * @param {SearchItem[]} items
 * @returns {{ content: string, items: SearchItem[], sources: Source[], resultCount: number } | null}
 */
export function resultFromItems(items) {
  const clean = (items || []).filter((r) => r && r.url);
  if (!clean.length) return null;
  return {
    content: itemsDigest(clean),
    items: clean,
    sources: clean.map((r) => ({ title: r.title || r.url, url: r.url })),
    resultCount: clean.length,
  };
}

/**
 * Parses a SearXNG `format=json` response into normalized items. SearXNG puts
 * the snippet in `content`; carried as a single highlight (clamped). Pure.
 * @param {any} data
 * @param {number} limit
 * @returns {SearchItem[]}
 */
export function parseSearxngResults(data, limit) {
  const rows = Array.isArray(data?.results) ? data.results : [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const url = String(r?.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = String(r?.content || "").trim().slice(0, HIGHLIGHT_MAX_CHARS);
    out.push({ title: String(r?.title || url).trim() || url, url, highlights: snippet ? [snippet] : [] });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Parses an Exa-compatible `/search` response (results[].{title,url,highlights}
 * — or a `text`/`snippet`/`content` fallback). Pure.
 * @param {any} data
 * @param {number} limit
 * @returns {SearchItem[]}
 */
export function parseExaCompatibleResults(data, limit) {
  const rows = Array.isArray(data?.results) ? data.results : [];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const url = String(r?.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let highlights = Array.isArray(r?.highlights)
      ? r.highlights.map((/** @type {any} */ h) => String(h || "").slice(0, HIGHLIGHT_MAX_CHARS)).filter(Boolean)
      : [];
    if (!highlights.length) {
      const fallback = String(r?.text || r?.snippet || r?.content || "").trim().slice(0, HIGHLIGHT_MAX_CHARS);
      if (fallback) highlights = [fallback];
    }
    out.push({ title: String(r?.title || url).trim() || url, url, highlights });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Runs one search against a SearXNG instance's JSON API. Fail-soft: null on any
 * misconfiguration, timeout, non-2xx, or empty result.
 * @param {{ baseUrl: string, key: string }} cfg
 * @param {Logger} log
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<SearchItem[] | null>}
 */
async function searxngSearch(cfg, log, query, limit) {
  if (!cfg.baseUrl) return null;
  const u = new URL(cfg.baseUrl + "/search");
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");
  u.searchParams.set("safesearch", "0");
  /** @type {Record<string,string>} */
  const headers = { accept: "application/json" };
  if (cfg.key) headers.authorization = `Bearer ${cfg.key}`;
  let resp;
  try {
    resp = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) });
  } catch (err) {
    safeLog(log).warn("search.backend_request_failed", { backend: "searxng", error: String(/** @type {any} */ (err)?.message || err) });
    return null;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    safeLog(log).warn("search.backend_error", { backend: "searxng", status: resp.status, detail: detail.slice(0, 200) });
    return null;
  }
  const data = await resp.json().catch(() => null);
  if (!data) return null;
  const items = parseSearxngResults(data, limit);
  return items.length ? items : null;
}

/**
 * Runs one search against an Exa-compatible `/search` endpoint. Fail-soft.
 * @param {{ baseUrl: string, key: string }} cfg
 * @param {Logger} log
 * @param {string} query
 * @param {number} limit
 * @param {string} type
 * @returns {Promise<SearchItem[] | null>}
 */
async function exaCompatibleSearch(cfg, log, query, limit, type) {
  if (!cfg.baseUrl) return null;
  /** @type {Record<string,string>} */
  const headers = { "content-type": "application/json" };
  if (cfg.key) headers["x-api-key"] = cfg.key;
  let resp;
  try {
    resp = await fetch(cfg.baseUrl + "/search", {
      method: "POST",
      headers,
      body: JSON.stringify({ query, type, numResults: limit, contents: { highlights: true } }),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    });
  } catch (err) {
    safeLog(log).warn("search.backend_request_failed", { backend: "exa_compatible", error: String(/** @type {any} */ (err)?.message || err) });
    return null;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    safeLog(log).warn("search.backend_error", { backend: "exa_compatible", status: resp.status, detail: detail.slice(0, 200) });
    return null;
  }
  const data = await resp.json().catch(() => null);
  if (!data) return null;
  const items = parseExaCompatibleResults(data, limit);
  return items.length ? items : null;
}

/**
 * The dispatcher: runs a self-hosted backend and returns a result object (no
 * durationMs — the caller stamps that), or null when the backend isn't a
 * self-hosted shape, is misconfigured, or produced nothing. Never throws.
 * @param {Logger} log
 * @param {{ backend: string, baseUrl: string, key: string, results?: number }} resolved
 * @param {string} query
 * @param {{ numResults?: number, type?: string }} [depth]
 * @returns {Promise<{ content: string, items: SearchItem[], sources: Source[], resultCount: number } | null>}
 */
export async function runBackendSearch(log, resolved, query, depth = {}) {
  const limit = Number(depth?.numResults) > 0
    ? Math.round(Number(depth.numResults))
    : Number(resolved.results) > 0
      ? Math.round(Number(resolved.results))
      : 6;
  const type = depth?.type || "auto";
  const cfg = { baseUrl: resolved.baseUrl, key: resolved.key };
  let items = null;
  if (resolved.backend === "searxng") {
    items = await searxngSearch(cfg, log, query, limit).catch(() => null);
  } else if (resolved.backend === "exa_compatible") {
    items = await exaCompatibleSearch(cfg, log, query, limit, type).catch(() => null);
  } else {
    return null; // not a self-hosted shape (e.g. "exa" / "grant") — caller handles it.
  }
  if (!items) return null;
  return resultFromItems(items);
}
