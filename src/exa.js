// Exa web search — backs the model's `web_search` tool.
//
// REST call to POST https://api.exa.ai/search with the EXA_API_KEY secret in
// the x-api-key header. See CLAUDE.md ("Web search — Exa") for parameter
// rules and the canonical reference URL.

const EXA_URL = "https://api.exa.ai/search";
const NUM_RESULTS = 5;

// Runs a search and formats the results as a compact, LLM-friendly string
// (numbered title / URL / highlight excerpts). Errors are returned as strings
// so the model can explain the failure instead of the request 500ing.
export async function webSearch(env, log, query) {
  if (!env.EXA_API_KEY) {
    log.error("exa.misconfigured", { missing: "EXA_API_KEY" });
    return "Web search is unavailable: EXA_API_KEY is not configured.";
  }
  if (!query) {
    log.warn("exa.empty_query", {});
    return "No search query was provided.";
  }

  const startedAt = Date.now();
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
        type: "auto",
        numResults: NUM_RESULTS,
        contents: { highlights: true },
      }),
    });
  } catch (err) {
    log.error("exa.request_failed", {
      error: err?.message || String(err),
      duration_ms: Date.now() - startedAt,
    });
    return `Search request failed: ${err?.message || String(err)}`;
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    log.error("exa.error", {
      status: resp.status,
      duration_ms: Date.now() - startedAt,
      detail: detail.slice(0, 300),
    });
    return `Search error (${resp.status}): ${detail.slice(0, 300)}`;
  }

  const data = await resp.json().catch(() => ({}));
  const results = Array.isArray(data.results) ? data.results : [];
  log.info("exa.search", {
    duration_ms: Date.now() - startedAt,
    results: results.length,
    query_chars: query.length,
  });

  if (results.length === 0) return `No results found for: ${query}`;

  return results
    .map((r, i) => {
      const highlights = Array.isArray(r.highlights) ? r.highlights.join(" … ") : "";
      return `[${i + 1}] ${r.title || "(untitled)"}\n${r.url}\n${highlights}`.trim();
    })
    .join("\n\n");
}
