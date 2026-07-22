// @ts-check
// Web search — Exa (POST https://api.exa.ai/search). Dependency exception #2.
// Time-bounded and fail-soft: every failure returns an EMPTY result (errors ride
// back as an empty digest), so the pipeline carries on with a search-free answer
// rather than erroring the chat (PA-2).
//
// The outbound request carries ONLY the query (PA-4) — never the conversation,
// the user's identity, or any other context. The EXA_API_KEY is server-side.

const EXA_URL = "https://api.exa.ai/search";
const SEARCH_TIMEOUT_MS = 15_000;
const TEXT_CAP = 1200; // per-source highlight budget

/**
 * @typedef {{ title: string, url: string }} Source
 * @typedef {{ content: string, sources: Source[], resultCount: number, durationMs: number }} SearchResult
 */

/**
 * @param {any} env
 * @param {import('./log.js').Logger} log
 * @param {string} query
 * @param {{ numResults?: number }} [depth]
 * @returns {Promise<SearchResult>}
 */
export async function webSearch(env, log, query, depth = {}) {
  const started = Date.now();
  const numResults = depth.numResults || 5;
  const empty = () => ({ content: "", sources: [], resultCount: 0, durationMs: Date.now() - started });
  const q = String(query || "").trim().slice(0, 400);
  if (!q || !env.EXA_API_KEY) return empty();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(EXA_URL, {
      method: "POST",
      headers: { "x-api-key": String(env.EXA_API_KEY), "content-type": "application/json" },
      body: JSON.stringify({ query: q, numResults, contents: { highlights: true } }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      log.warn("exa.http", { status: resp.status, ms: Date.now() - started });
      return empty();
    }
    const data = await resp.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    log.info("exa.ok", { results: results.length, ms: Date.now() - started });
    return {
      content: formatDigest(results),
      sources: results.map((r) => ({ title: r.title || r.url, url: r.url })),
      resultCount: results.length,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    log.warn("exa.error", { ms: Date.now() - started });
    return empty();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The compact numbered digest synthesis reads. Pure, so it is unit-testable
 * without a live call.
 * @param {any[]} results
 * @returns {string}
 */
export function formatDigest(results) {
  return results
    .map((r, i) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.join(" … ").slice(0, TEXT_CAP) : "";
      return `[${i + 1}] ${r.title || "(untitled)"}\n${r.url}\n${highlights}`.trim();
    })
    .join("\n\n");
}
