// Exa web search — backs the model's `web_search` tool.
//
// REST call to POST https://api.exa.ai/search with the EXA_API_KEY secret in
// the x-api-key header. See CLAUDE.md ("Web search — Exa") for parameter
// rules and the canonical reference URL.

const EXA_URL = "https://api.exa.ai/search";

// Classifies an Exa failure into a stable kind the pipeline can react to,
// so a backend outage is never silently indistinguishable from a genuine
// "this query legitimately found nothing". The distinction matters a lot in
// practice: an account that has run out of Exa credits returns HTTP 402 for
// EVERY query, so a whole research run comes back with zero sources that
// look exactly like a niche topic nobody has written about — the pipeline
// then answers ungrounded and neither the user nor the admin learns the
// search provider was down. Exported (pure) for unit testing and reused by
// alerts.js's exaSearchAlert().
//   "no_credits" — 402 / NO_MORE_CREDITS: account is out of Exa credits
//   "auth"       — 401 / 403: bad or missing API key
//   "rate_limit" — 429: temporarily throttled (transient)
//   "http"       — any other non-2xx (transient/unknown)
//   "network"    — the fetch itself threw (DNS/TLS/timeout)
// Returns null for a normal 200 response (including a genuine empty result).
export function exaErrorKind(status, detail = "") {
  const text = String(detail || "");
  if (status === 402 || /NO_MORE_CREDITS|exceeded your credits/i.test(text)) return "no_credits";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (typeof status === "number" && status >= 400) return "http";
  return status === "network" ? "network" : null;
}

// Runs a search and returns:
//   content    — compact LLM-friendly string (numbered title/URL/highlights);
//                errors come back as strings too, so the pipeline can carry
//                on instead of the request 500ing
//   items      — [{title, url, highlights[]}] structured results for the
//                pipeline's cross-search source registry
//   sources    — [{title, url}] for the UI's expandable activity panel
//   errorKind  — null on a normal response (including a real empty result);
//                otherwise the exaErrorKind() bucket, so the pipeline can
//                alert on an outage and tell synthesis the search backend
//                failed rather than presenting "no sources" as fact
//   resultCount, durationMs — for UI counters and logs
//
// depth (src/budget.js's plan.searchDepth): { numResults, type } — scales
// with the time budget instead of a fixed 5-result "auto" search
// regardless of how much depth the user actually asked for.
export async function webSearch(env, log, query, depth = {}) {
  const numResults = depth.numResults || 5;
  const type = depth.type || "auto";
  const startedAt = Date.now();
  const failure = (content, errorKind = null) => ({
    content,
    items: [],
    sources: [],
    resultCount: 0,
    errorKind,
    durationMs: Date.now() - startedAt,
  });

  if (!env.EXA_API_KEY) {
    log.error("exa.misconfigured", { missing: "EXA_API_KEY" });
    return failure("Web search is unavailable: EXA_API_KEY is not configured.", "auth");
  }
  if (!query) {
    log.warn("exa.empty_query", {});
    return failure("No search query was provided.");
  }

  log.debug("exa.search_query", { query }); // user content: debug level only

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
    return failure(`Search request failed: ${err?.message || String(err)}`, "network");
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const kind = exaErrorKind(resp.status, detail);
    log.error("exa.error", {
      status: resp.status,
      kind,
      duration_ms: Date.now() - startedAt,
      detail: detail.slice(0, 300),
    });
    return failure(`Search error (${resp.status}): ${detail.slice(0, 300)}`, kind);
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
    // A genuine empty result from a healthy 200 response — NOT a backend
    // failure, so errorKind stays null and the pipeline treats it as "this
    // query really found nothing" rather than "search is down".
    return { ...failure(`No results found for: ${query}`), durationMs };
  }

  const content = results
    .map((r, i) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.join(" … ") : "";
      return `[${i + 1}] ${r.title || "(untitled)"}\n${r.url}\n${highlights}`.trim();
    })
    .join("\n\n");

  return {
    content,
    items: results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      highlights: Array.isArray(r.highlights) ? r.highlights : [],
    })),
    sources: results.map((r) => ({ title: r.title || r.url, url: r.url })),
    resultCount: results.length,
    errorKind: null,
    durationMs,
  };
}
