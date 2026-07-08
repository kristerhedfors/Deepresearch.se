// POST /api/chat — thin handler: validate the request, resolve the model,
// enforce the caller's research quota, build the per-request state (budget
// plan, counters, source registry), and stream the research pipeline
// (src/pipeline.js) as SSE. Ends every stream with a `done` stats event and
// `[DONE]`, then records the usage event for quota accounting.

import { classifyChatError, raiseAlert } from "./alerts.js";
import { heartbeatAnswer, markAnswerRunning, saveAnswer } from "./answers.js";
import { addUserMessage } from "./user-messages.js";
import { adminDefaultModelValid, DEFAULT_MODEL, listModels } from "./berget.js";
import { clampBudget, planResearch, CONTENTS_COST_MULTIPLIER } from "./budget.js";
import { augmentWithLocations } from "./geocode.js";
import { jsonResponse, sseResponse } from "./http.js";
import { runPipeline } from "./pipeline.js";
import { getConfig } from "./config.js";
import {
  bergetCost,
  effectiveQuota,
  getUsage,
  quotaExceeded,
  recordUsage,
} from "./quota.js";
import { resolveModel, validateImageLocations, validateMessages, validateStreetViewPov } from "./validation.js";
import { shodanEnabled, googleMapsEnabled } from "./settings.js";

export async function handleChat(request, env, log, identity, ctx, requestId) {
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
  if (!body.model && adminDefaultModelValid(config, catalog)) {
    body.model = config.default_model;
  }
  const resolved = resolveModel(body, catalog, env, log);
  if (resolved.error) return jsonResponse({ error: resolved.error }, resolved.status);
  const model = resolved.model;
  // The JSON planning phases (triage / gap check / validation) always run on
  // a fixed, JSON-reliable model regardless of which model the user picked to
  // reason/answer — some capable answer models (notably reasoning models like
  // GLM) produce unreliable JSON, which was corrupting triage into echoing
  // the raw user message as the search query. Mistral Small is fast, cheap
  // and reliable at JSON mode. Falls back to the user's model only if Mistral
  // is explicitly down in the catalog (never route JSON to a model that isn't
  // up); when the catalog is unreachable we stay optimistic (fail-soft covers
  // a genuinely-down JSON model).
  const jsonModel = resolveJsonModel(catalog, model);

  // ---- research quota (Berget budget + Exa searches per 5h/day/week/month)
  // ADMINS ARE NEVER BLOCKED: their usage is recorded and their bars keep
  // counting (past 100%), but the 429 gate applies to regular users only.
  const usage = await getUsage(env, identity.id);
  const quota =
    identity.isSecretAdmin || identity.role === "admin"
      ? null
      : effectiveQuota(config, identity.user);
  if (quota) {
    const blocked = quotaExceeded(usage, quota);
    if (blocked) {
      log.info("chat.quota_blocked", {
        user_id: identity.id,
        period: blocked.period,
        kind: blocked.kind,
      });
      await addUserMessage(env, identity.id, "quota_exceeded", { period: blocked.period, kind: blocked.kind });
      return jsonResponse(quotaBlockedResponse(blocked), 429);
    }
  }

  const conversation = body.messages;
  let budgetS = clampBudget(body.time_budget_s); // UI slider (src/budget.js)
  budgetS = Math.min(budgetS, config.max_time_budget_s);
  const webSearchEnabled = body.web_search !== false; // knob: default on
  // Shodan host-intelligence enrichment is an opt-in per-user setting, not a
  // per-request body flag (src/settings.js) — gated here so the pipeline
  // only ever attempts it when both the knob is on and the key is present.
  const shodanOn = shodanEnabled(env, identity);
  // Google Maps enrichment (Places + Street View + Static Maps) is another
  // opt-in per-user knob (src/settings.js). Vision capability of the CHOSEN
  // answer model decides whether the fetched imagery is attached for the model
  // to describe (only vision models can receive it); the resolved photo GPS
  // coordinates give a precise location to look up when a photo is attached.
  const googleMapsOn = googleMapsEnabled(env, identity);
  const modelIsVision = !!catalog?.find((m) => m.id === model)?.vision;
  // A vision helper for DESCRIBING Street View imagery when the chosen answer
  // model can't see images (e.g. the default Mistral Small): the user's own
  // model when it's already vision, else the first up + vision-capable catalog
  // model, else null (no describe — the block then just points at the link).
  // This is why "describe this street view" works regardless of model choice.
  // Ranked failover list, not a single pick: the describe call was observed
  // (2026-07-08, describe_failed "The operation was aborted") timing out on
  // a loaded Mistral Medium while other vision models answered instantly —
  // a one-model helper goes blind exactly when the backend is busiest.
  const visionCandidates = catalog?.filter((m) => m.vision && m.up).map((m) => m.id) || [];
  const visionModels = (modelIsVision
    ? [model, ...visionCandidates.filter((id) => id !== model)]
    : visionCandidates
  ).slice(0, 3);
  const visionModel = visionModels[0] || null;
  const imageLocations = validateImageLocations(body.imageLocations);
  // The user's CURRENT view in the inline Street View panorama (they may have
  // panned/moved it) — lets a follow-up capture exactly what's on their
  // screen instead of the four generic cardinal frames.
  const streetViewPov = googleMapsOn ? validateStreetViewPov(body.street_view_pov) : null;

  // Client-disconnect detection: when the reader goes away (backgrounded
  // PWA, dropped network), the runtime calls cancel() — enqueue does NOT
  // reliably throw. The pipeline keeps running after a disconnect (emit
  // degrades to a no-op): the spend is already mostly committed by then,
  // and the finished answer is parked in the recovery cache
  // (src/answers.js) for the client to poll — instead of asking the user
  // to resend and pay again.
  const disconnect = { gone: false, state: null };

  const stream = new ReadableStream({
    cancel() {
      disconnect.gone = true;
      log.info("chat.client_disconnected", {
        user_id: identity.id,
        model,
        searches: disconnect.state?.searchCount ?? 0,
        duration_ms: disconnect.state ? Date.now() - disconnect.state.startedAt : 0,
      });
    },
    start(controller) {
      // The pipeline runs detached from the stream's lifecycle and is
      // registered with ctx.waitUntil: when the client disconnects, the
      // runtime would otherwise kill the invocation on the spot — losing
      // the chat.complete log AND the usage_events row (spend would go
      // unaccounted). waitUntil keeps the Worker alive through the finally
      // block; the disconnect.gone flag still aborts further Berget/Exa
      // spend at the next emit.
      const work = runChatStream(controller);
      ctx?.waitUntil(work);
    },
  });

  async function runChatStream(controller) {
    const encoder = new TextEncoder();
    const state = newRequestState(model, jsonModel, webSearchEnabled, budgetS, shodanOn, {
      googleMaps: googleMapsOn,
      vision: modelIsVision,
      visionModel,
      visionModels,
      imageLocations,
      streetViewPov,
    });
    disconnect.state = state;

    // Recovery marker (metadata only): lets the poller tell "still
    // researching" apart from "nothing will ever come".
    await markAnswerRunning(env, log, requestId, identity.id);

    // The JSON helper phases (triage/gap/validation) emit nothing for
    // tens of seconds; idle HTTP connections get dropped by proxies on
    // the way to the client. SSE comment lines (":" prefix) keep bytes
    // flowing — every SSE client ignores them. Started before geocoding
    // so even the pre-pipeline maps lookup is covered.
    const keepalive = setInterval(() => {
      // Heartbeat the recovery row FIRST, regardless of client presence: a
      // poller (or a relaunch) uses its freshness to tell a still-running
      // server from one the runtime killed. This must keep firing after a
      // disconnect — that's exactly when the poller needs it — so it runs
      // before the disconnect.gone early-return below. Fire-and-forget.
      heartbeatAnswer(env, log, requestId, identity.id);
      if (disconnect.gone) return;
      try {
        controller.enqueue(encoder.encode(": keepalive\n\n"));
      } catch {
        disconnect.gone = true;
      }
    }, 15_000);

    // Server-side mirror of the client's text accumulator (including the
    // discard_text reset), so the recovery cache holds exactly what a
    // connected client would have rendered.
    const answer = { text: "" };
    const emit = (obj) => {
      const chunk = obj.choices?.[0]?.delta?.content;
      if (chunk) answer.text += chunk;
      else if (obj.status?.type === "discard_text") answer.text = "";
      if (disconnect.gone) return; // client gone: finish anyway, park in the cache
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      } catch {
        disconnect.gone = true;
      }
    };

    try {
      // Reverse-geocode any attached photo's GPS EXIF (public/js/exif.js)
      // into a place name every phase below can actually use — independent
      // of the web_search toggle, since this is enriching the photo's own
      // metadata, not researching the user's topic. Emits its own visible
      // step (naming OpenStreetMap Nominatim) via the same emit as the
      // pipeline, so the user sees which service is being contacted.
      const conversationWithContext = await augmentWithLocations(
        env, log, emit, conversation, body.imageLocations,
      );
      await runPipeline(env, log, emit, conversationWithContext, model, state);
    } catch (err) {
      const errMessage = err?.message || String(err);
      log.error("chat.stream_failed", {
        user_id: identity.id,
        error: errMessage,
      });
      const alert = classifyChatError(errMessage);
      await raiseAlert(env, alert.type, alert.severity, alert.message, `model: ${model} — ${errMessage}`);
      emit({ error: "Worker error: " + errMessage });
    } finally {
      clearInterval(keepalive);
      const duration_ms = Date.now() - state.startedAt;
      // Searches served from the Exa result cache cost nothing, so they
      // don't consume the user's Exa search quota or add Exa cost — only the
      // live searches that actually hit Exa are billed.
      const billedSearches = Math.max(0, state.searchCount - (state.cachedSearchCount || 0));
      log.info("chat.complete", {
        user_id: identity.id,
        model,
        json_model: jsonModel,
        rounds: state.iterations,
        searches: state.searchCount,
        cached_searches: state.cachedSearchCount || 0,
        sources: state.sources.length,
        shodan_hosts: state.shodanCount,
        google_maps: state.mapsCount,
        duration_ms,
        client_gone: disconnect.gone,
      });
      // Usage accounting for quotas (fails soft; never breaks the stream).
      const { prompt_tokens, completion_tokens, berget_cost } = summarizeSpend(state, catalog);
      await recordUsage(env, log, {
        user_id: identity.id,
        model,
        prompt_tokens,
        completion_tokens,
        searches: billedSearches,
        berget_cost,
        // The admin-configured per-search price is priced for Exa's
        // standard tier; a request whose time budget bought a costlier
        // tier (src/budget.js's searchDepth, e.g. `type: "deep"`) gets its
        // recorded cost scaled by that tier's real price ratio, so a long
        // budget's genuinely higher Exa spend doesn't go under-counted
        // against the user's opaque budget bar or the admin's cost totals.
        // Live searches at their depth-tier price, PLUS the budget-gated
        // full-content fetch (Exa /contents) priced per URL at the cheaper
        // contents rate — so the top-tier full-read spend is counted too.
        exa_cost:
          billedSearches * config.exa_cost_per_search_eur * (state.plan.searchDepth?.costMultiplier || 1) +
          (state.fetchedUrls?.size || 0) * config.exa_cost_per_search_eur * CONTENTS_COST_MULTIPLIER,
        duration_ms,
      });
      const stats = {
        type: "done",
        model,
        rounds: state.iterations,
        searches: state.searchCount,
        duration_ms,
        prompt_tokens, // sum across the answer model and the JSON model
        completion_tokens,
      };
      emit({ status: stats });
      // Park the finished answer for recovery. The client DELETEs it the
      // moment the stream arrives intact, so content normally lives here
      // for seconds; a dropped client polls it back within the TTL.
      await saveAnswer(env, log, requestId, identity.id, answer.text, stats);
      try {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // client is gone; the stream is already torn down
      }
    }
  }

  return sseResponse(stream);
}

// Builds the 429 payload for a blocked quota window: a plain-language
// message (period + reset time — budget amounts are EUR, admin-only
// information, never sent to users) and the public quota object the
// client renders.
export function quotaBlockedResponse(blocked) {
  const periodName = { h5: "5-hour", day: "daily", week: "weekly", month: "monthly" }[blocked.period];
  const verb = blocked.period === "h5" ? "frees up around" : "resets";
  const when = `${new Date(blocked.reset_at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const error =
    blocked.kind === "budget"
      ? `You've used your ${periodName} research budget. It ${verb} ${when}.`
      : `You've used your ${periodName} search budget ` +
        `(${blocked.limit.toLocaleString("en-US")} searches). It ${verb} ${when}.`;
  const publicQuota =
    blocked.kind === "budget"
      ? { period: blocked.period, kind: blocked.kind, reset_at: blocked.reset_at }
      : blocked;
  return { error, quota: publicQuota };
}

// Sums the request's token totals and Berget cost across the up-to-three
// models that ran: synthesis/direct on the user's model, the JSON planning
// phases on jsonModel (Mistral), and the Street View vision-describe helper
// on its own model — the split-billing design, each bucket priced at its own
// catalog rate (tokens alone can't cap spend when models price differently).
// Pure (state + catalog in, totals out), unit-tested in chat.test.js.
export function summarizeSpend(state, catalog) {
  const buckets = [
    [state.model, state.totals],
    [state.jsonModel, state.jsonTotals],
    [state.visionModel, state.visionTotals],
  ];
  let prompt_tokens = 0;
  let completion_tokens = 0;
  let berget_cost = 0;
  for (const [modelId, totals] of buckets) {
    prompt_tokens += totals.prompt_tokens;
    completion_tokens += totals.completion_tokens;
    const entry = catalog?.find((m) => m.id === modelId);
    berget_cost += bergetCost(entry, totals.prompt_tokens, totals.completion_tokens);
  }
  return { prompt_tokens, completion_tokens, berget_cost };
}

// Which model runs the JSON planning phases (triage/gap/validate): the fixed
// reliable DEFAULT_MODEL (Mistral Small) unless it's explicitly down in the
// catalog, in which case fall back to the user's model rather than route JSON
// to a model that isn't up. Catalog unreachable → optimistic (fail-soft).
export function resolveJsonModel(catalog, userModel) {
  if (userModel === DEFAULT_MODEL) return DEFAULT_MODEL; // already the reliable JSON model
  if (!Array.isArray(catalog)) return DEFAULT_MODEL;
  const entry = catalog.find((m) => m.id === DEFAULT_MODEL);
  if (!entry) return userModel; // this deployment doesn't offer it — don't route to a missing model
  return entry.up === false ? userModel : DEFAULT_MODEL;
}

// Mutable per-request state threaded through the pipeline.
function newRequestState(model, jsonModel, webSearch, budgetS, shodan, extras = {}) {
  return {
    startedAt: Date.now(),
    model,
    jsonModel, // fixed model for the JSON planning phases (see resolveJsonModel)
    webSearch,
    shodan, // opt-in Shodan host-intelligence enrichment (src/settings.js)
    shodanCount: 0, // hosts Shodan actually returned data for
    googleMaps: !!extras.googleMaps, // opt-in Google Maps enrichment (src/settings.js)
    mapsCount: 0, // 1 when Google Maps data was found & folded in
    vision: !!extras.vision, // chosen answer model supports image input
    visionModel: extras.visionModel || null, // helper model to describe Street View for a non-vision answer model
    // Ranked describe-helper candidates (first = visionModel); the describe
    // fails over down this list when a model times out under load.
    visionModels: extras.visionModels || (extras.visionModel ? [extras.visionModel] : []),
    // Tokens for the Street View vision-describe helper — its own model, so
    // billed at its own catalog rate (like jsonTotals), summed for the counters.
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    imageLocations: extras.imageLocations || [], // validated attached-photo GPS coords
    // The user's current panorama view (validated), for the follow-up
    // capture-what-they-see Street View path (src/enrichment.js).
    streetViewPov: extras.streetViewPov || null,

    plan: planResearch(model, budgetS, jsonModel),
    // Triage decomposition (pipeline.js runTriage): the classified question
    // complexity (caps research depth for "simple" — budget.js
    // applyComplexityToPlan), its sub-questions (the gap check audits
    // coverage against each; synthesis must address each), and the source
    // disagreements gap rounds reported (synthesis addresses them explicitly).
    complexity: null,
    subquestions: [],
    conflicts: [],
    // Per-source auxiliary search state (pipeline.js runAuxSearches over
    // src/search-sources.js): state.aux[<source id>] = {count, ran:Set} —
    // sources never add top-level fields here.
    aux: {},
    searchCount: 0,
    cachedSearchCount: 0, // searches served from the Exa result cache (not billed)
    iterations: 1, // search waves (initial + gap rounds that ran)
    ranQueries: new Set(),
    sources: [], // numbered registry, deduped by URL
    byUrl: new Map(),
    // Budget-gated notes digest (src/pipeline.js maybeDigest, mid/high tiers):
    // structured research notes distilled from each search wave, plus a cursor
    // marking how far into the source registry has been digested. Empty at the
    // default budget (the digest phase never runs there).
    notes: [],
    notesCursor: 0,
    fetchedUrls: new Set(), // top-source URLs already full-content fetched (>=240s tier)
    // Synthesis/direct token usage (the user's model) and JSON-phase token
    // usage (jsonModel) are tracked separately so each is billed at its own
    // model's price — the JSON phases on cheap Mistral shouldn't be charged at
    // a premium answer model's rate.
    totals: { prompt_tokens: 0, completion_tokens: 0 },
    jsonTotals: { prompt_tokens: 0, completion_tokens: 0 },
  };
}
