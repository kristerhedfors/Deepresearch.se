// POST /api/chat — thin handler: validate the request, resolve the model,
// enforce the caller's research quota, build the per-request state (budget
// plan, counters, source registry), and stream the research pipeline
// (src/pipeline.js) as SSE. Ends every stream with a `done` stats event and
// `[DONE]`, then records the usage event for quota accounting.

import { listModels } from "./berget.js";
import { clampBudget, planResearch } from "./budget.js";
import { jsonResponse, sseResponse } from "./http.js";
import { runPipeline } from "./pipeline.js";
import {
  bergetCost,
  effectiveQuota,
  getConfig,
  getUsage,
  quotaExceeded,
  recordUsage,
  remainingSeconds,
} from "./quota.js";
import { resolveModel, validateMessages } from "./validation.js";

export async function handleChat(request, env, log, identity) {
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
  const config = await getConfig(env);
  // The admin can set a site default model; it only applies when valid & up.
  if (!body.model && config.default_model && catalog?.some((m) => m.id === config.default_model && m.up)) {
    body.model = config.default_model;
  }
  const resolved = resolveModel(body, catalog, env, log);
  if (resolved.error) return jsonResponse({ error: resolved.error }, resolved.status);
  const model = resolved.model;

  // ---- research quota (Claude Code-style: hours + cost per day/week/month)
  // The secrets admin is exempt from enforcement but still accounted.
  const usage = await getUsage(env, identity.id);
  const quota = identity.isSecretAdmin ? null : effectiveQuota(config, identity.user);
  if (quota) {
    const blocked = quotaExceeded(usage, quota);
    if (blocked) {
      log.info("chat.quota_blocked", {
        user_id: identity.id,
        period: blocked.period,
        kind: blocked.kind,
      });
      const what = blocked.kind === "cost" ? "cost budget" : "research-time budget";
      const periodName = { day: "daily", week: "weekly", month: "monthly" }[blocked.period];
      return jsonResponse(
        {
          error:
            `You've used your ${periodName} ${what} ` +
            `(${blocked.kind === "cost" ? "€" + blocked.limit.toFixed(2) : blocked.limit + " h"}). ` +
            `It resets ${new Date(blocked.reset_at).toISOString().replace(".000Z", "Z")}.`,
          quota: blocked,
        },
        429,
      );
    }
  }

  const conversation = body.messages;
  let budgetS = clampBudget(body.time_budget_s); // UI slider (src/budget.js)
  budgetS = Math.min(budgetS, config.max_time_budget_s);
  if (quota) {
    // One request can't blow through the hour cap: clamp to what's left.
    const left = remainingSeconds(usage, quota);
    if (Number.isFinite(left)) budgetS = Math.max(15, Math.min(budgetS, Math.ceil(left)));
  }
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
        // Usage accounting for quotas (fails soft; never breaks the stream).
        const entry = catalog?.find((m) => m.id === model);
        await recordUsage(env, log, {
          user_id: identity.id,
          model,
          prompt_tokens: state.totals.prompt_tokens,
          completion_tokens: state.totals.completion_tokens,
          searches: state.searchCount,
          berget_cost: bergetCost(entry, state.totals.prompt_tokens, state.totals.completion_tokens),
          exa_cost: state.searchCount * config.exa_cost_per_search_eur,
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
