// POST /api/chat — thin handler: validate the request, resolve the model,
// build the per-request state (budget plan, counters, source registry), and
// stream the research pipeline (src/pipeline.js) as SSE. Ends every stream
// with a `done` stats event and `[DONE]`.

import { listModels } from "./berget.js";
import { clampBudget, planResearch } from "./budget.js";
import { jsonResponse, sseResponse } from "./http.js";
import { runPipeline } from "./pipeline.js";
import { resolveModel, validateMessages } from "./validation.js";

export async function handleChat(request, env, log) {
  if (!env.BERGET_API_TOKEN) {
    log.error("chat.misconfigured", { missing: "BERGET_API_TOKEN" });
    return jsonResponse(
      { error: "Server not configured: BERGET_API_TOKEN secret is missing." },
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const invalid = validateMessages(body?.messages);
  if (invalid) {
    log.warn("chat.invalid_request", { reason: invalid });
    return jsonResponse({ error: invalid }, 400);
  }

  // Model resolution needs the catalog; if it's unreachable we degrade to
  // the default model rather than blocking chat.
  let catalog = null;
  try {
    catalog = await listModels(env);
  } catch (err) {
    log.warn("chat.model_catalog_unavailable", { error: err?.message || String(err) });
  }
  const resolved = resolveModel(body, catalog, env, log);
  if (resolved.error) return jsonResponse({ error: resolved.error }, resolved.status);
  const model = resolved.model;

  const conversation = body.messages;
  const budgetS = clampBudget(body.time_budget_s); // UI slider (src/budget.js)
  const webSearchEnabled = body.web_search !== false; // knob: default on

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const emit = (obj) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const state = newRequestState(model, webSearchEnabled, budgetS);

      try {
        await runPipeline(env, log, emit, conversation, model, state);
      } catch (err) {
        log.error("chat.stream_failed", { error: err?.message || String(err) });
        emit({ error: "Worker error: " + (err?.message || String(err)) });
      } finally {
        const duration_ms = Date.now() - state.startedAt;
        log.info("chat.complete", {
          model,
          rounds: state.iterations,
          searches: state.searchCount,
          sources: state.sources.length,
          duration_ms,
        });
        emit({
          status: {
            type: "done",
            model,
            rounds: state.iterations,
            searches: state.searchCount,
            duration_ms,
            prompt_tokens: state.totals.prompt_tokens,
            completion_tokens: state.totals.completion_tokens,
            co2_grams: state.totals.co2_grams,
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return sseResponse(stream);
}

// Mutable per-request state threaded through the pipeline.
function newRequestState(model, webSearch, budgetS) {
  return {
    startedAt: Date.now(),
    model,
    webSearch,
    plan: planResearch(model, budgetS),
    searchCount: 0,
    iterations: 1, // search waves (initial + gap rounds that ran)
    ranQueries: new Set(),
    sources: [], // numbered registry, deduped by URL
    byUrl: new Map(),
    totals: { prompt_tokens: 0, completion_tokens: 0, co2_grams: 0 },
  };
}
