// @ts-check
// Pluggable web-search BACKENDS — the "bring your own search" seam.
//
// The pipeline's web search defaults to Exa (src/exa.js), but the search
// provider is now a CONFIGURED CHOICE: an admin can point the site at their
// OWN self-hosted search service instead of (or as a fallback to) Exa. This
// is the code side of the project's mission — pushing a real research
// assistant toward provable privacy: a self-hosted backend means the search
// QUERIES never reach a third party's retention (Exa is not zero-data-
// retention on the standard plan — see the integrations skill / /help).
//
// Two self-hosted shapes are supported, both fed from the SAME `search`
// config block (src/config.js) + the `SEARCH_BACKEND_KEY` secret:
//
//   "searxng"         — a SearXNG instance's JSON API
//                       (GET {base}/search?q=…&format=json). No key needed
//                       for a private instance; SEARCH_BACKEND_KEY rides as a
//                       Bearer header if the instance is behind an auth proxy.
//   "exa_compatible"  — any service that speaks Exa's own wire
//                       (POST {base}/search, x-api-key, {results:[{title,url,
//                       highlights}]}). The .claude/skills/local-web-search
//                       playbook ships a Playwright-based service that does
//                       exactly this, so it drops straight in here.
//
// Everything is FAIL-SOFT, matching the pipeline's helper-phase contract
// (CLAUDE.md invariant 2): a misconfigured or unreachable backend returns
// null, and exa.js falls back to Exa (when `fallback_exa` and EXA_API_KEY
// allow) rather than erroring the request. Only the query string ever crosses
// the wire — never the conversation.

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./exa.js').SearchItem} SearchItem */
/** @typedef {import('./exa.js').SearchResult} SearchResult */

// Bound every backend fetch the same way the Exa/Berget calls are bounded — a
// hung self-hosted service must degrade to null, never hang the search wave.
const BACKEND_TIMEOUT_MS = 15_000;
// Cap extracted text per source so a chatty backend can't blow the synthesis
// digest / Worker memory — the same budget exa.js uses for /contents.
const HIGHLIGHT_MAX_CHARS = 1200;
// The set of backends the config accepts; anything else means "use Exa".
export const SEARCH_BACKENDS = ["exa", "searxng", "exa_compatible"];

/**
 * The effective backend selection, resolved from site config with an env
 * override. A `SEARCH_BACKEND_URL` var/secret wins over the stored base URL
 * (so a base URL can be kept out of the admin-editable D1 config entirely),
 * and `SEARCH_BACKEND_KEY` is the auth secret (never stored in config).
 * @param {Env} env
 * @param {{ backend?: string, base_url?: string, results?: number, fallback_exa?: boolean }} [searchCfg]
 * @returns {{ backend: string, baseUrl: string, key: string, results: number, fallbackExa: boolean }}
 */
export function resolveSearchBackend(env, searchCfg = {}) {
  const backend = SEARCH_BACKENDS.includes(String(searchCfg.backend))
    ? String(searchCfg.backend)
    : "exa";
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
 * Assembles a full SearchResult-shaped object (minus durationMs/cached, which
 * exa.js stamps) from a list of normalized items. Returns null for an empty
 * list so callers can fall through to Exa / an honest "no results".
 * @param {SearchItem[]} items
 * @returns {{ content: string, items: SearchItem[], sources: import('./types.js').SseSource[], resultCount: number } | null}
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
 * the snippet in `content`; we carry it as a single highlight (clamped).
 * Pure — exported for unit testing.
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
    out.push({
      title: String(r?.title || url).trim() || url,
      url,
      highlights: snippet ? [snippet] : [],
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Parses an Exa-compatible `/search` response (results[].{title,url,highlights}
 * — or a `text`/`snippet` fallback). Pure — exported for unit testing.
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
 * Runs one search against a SearXNG instance's JSON API. Fail-soft: returns
 * null on any misconfiguration, timeout, non-2xx, or empty result.
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
    log.warn("search.backend_request_failed", { backend: "searxng", error: String(/** @type {any} */ (err)?.message || err) });
    return null;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    log.warn("search.backend_error", { backend: "searxng", status: resp.status, detail: detail.slice(0, 200) });
    return null;
  }
  const data = await resp.json().catch(() => null);
  if (!data) return null;
  const items = parseSearxngResults(data, limit);
  return items.length ? items : null;
}

/**
 * Runs one search against an Exa-compatible `/search` endpoint (the shape the
 * local-web-search skill's Playwright service exposes). Fail-soft.
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
    log.warn("search.backend_request_failed", { backend: "exa_compatible", error: String(/** @type {any} */ (err)?.message || err) });
    return null;
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    log.warn("search.backend_error", { backend: "exa_compatible", status: resp.status, detail: detail.slice(0, 200) });
    return null;
  }
  const data = await resp.json().catch(() => null);
  if (!data) return null;
  const items = parseExaCompatibleResults(data, limit);
  return items.length ? items : null;
}

/**
 * The dispatcher: runs the configured self-hosted backend and returns a
 * SearchResult-shaped object (no durationMs/cached — the caller stamps those),
 * or null when the backend is "exa", misconfigured, or produced nothing. Never
 * throws — a null return tells exa.js to fall through to Exa.
 * @param {Env} env
 * @param {Logger} log
 * @param {{ backend: string, baseUrl: string, key: string, results: number, fallbackExa: boolean }} resolved
 * @param {string} query
 * @param {{ numResults?: number, type?: string }} depth
 * @returns {Promise<{ content: string, items: SearchItem[], sources: import('./types.js').SseSource[], resultCount: number } | null>}
 */
export async function runBackendSearch(env, log, resolved, query, depth) {
  const limit = Number(depth?.numResults) > 0 ? Math.round(Number(depth.numResults)) : resolved.results;
  const type = depth?.type || "auto";
  let items = null;
  if (resolved.backend === "searxng") {
    items = await searxngSearch(resolved, log, query, limit).catch(() => null);
  } else if (resolved.backend === "exa_compatible") {
    items = await exaCompatibleSearch(resolved, log, query, limit, type).catch(() => null);
  } else {
    return null; // "exa" (or unknown) — the caller uses the native Exa path.
  }
  if (!items) return null;
  return resultFromItems(items);
}
