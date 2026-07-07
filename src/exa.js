// Exa web search — backs the model's `web_search` tool.
//
// REST call to POST https://api.exa.ai/search with the EXA_API_KEY secret in
// the x-api-key header. See CLAUDE.md ("Web search — Exa") for parameter
// rules and the canonical reference URL.

const EXA_URL = "https://api.exa.ai/search";

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
export async function webSearch(env, log, query, depth = {}) {
  const numResults = depth.numResults || 5;
  const type = depth.type || "auto";
  const startedAt = Date.now();
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
  const cache = globalThis.caches?.default;
  const cacheKey = searchCacheKey(query, type, numResults);
  if (cache) {
    try {
      const hit = await cache.match(new Request(cacheKey));
      if (hit) {
        const payload = await hit.json();
        log.info("exa.cache_hit", {
          duration_ms: Date.now() - startedAt,
          results: payload.resultCount,
          query_chars: query.length,
          type,
        });
        return { ...payload, durationMs: Date.now() - startedAt, cached: true };
      }
    } catch (err) {
      log.warn("exa.cache_read_failed", { error: err?.message || String(err) });
    }
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
    log.error("exa.request_failed", {
      error: err?.message || String(err),
      duration_ms: Date.now() - startedAt,
    });
    return failure(`Search request failed: ${err?.message || String(err)}`);
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
  const results = Array.isArray(data.results) ? data.results : [];
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
  if (cache) {
    try {
      await cache.put(
        new Request(cacheKey),
        new Response(JSON.stringify(result), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${CACHE_TTL_S}`,
          },
        }),
      );
    } catch (err) {
      log.warn("exa.cache_write_failed", { error: err?.message || String(err) });
    }
  }

  return { ...result, durationMs, cached: false };
}
