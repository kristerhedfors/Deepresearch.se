// POST /api/chat — thin handler: validate the request, resolve the model,
// enforce the caller's research quota, build the per-request state (budget
// plan, counters, source registry), and stream the research pipeline
// (src/pipeline.js) as SSE. Ends every stream with a `done` stats event and
// `[DONE]`, then records the usage event for quota accounting.

import { classifyChatError, raiseAlert } from "./alerts.js";
import { markAnswerRunning, saveAnswer } from "./answers.js";
import { addUserMessage } from "./user-messages.js";
import { adminDefaultModelValid, listModels } from "./berget.js";
import { clampBudget, planResearch } from "./budget.js";
import { withAppendedImages } from "./conversation.js";
import { augmentWithLocations } from "./geocode.js";
import { jsonResponse, sseResponse } from "./http.js";
import { collectMapImagery, mapsAvailable, placesNearby } from "./maps.js";
import { runPipeline } from "./pipeline.js";
import { getConfig } from "./config.js";
import {
  bergetCost,
  effectiveQuota,
  getUsage,
  quotaExceeded,
  recordUsage,
} from "./quota.js";
import { resolveModel, validateImageLocations, validateMessages } from "./validation.js";
import { getModelProfile } from "./model-profiles.js";
import { getSettings, shodanEnabled } from "./settings.js";

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
  // Server-added Street View/map images (src/maps.js) are only fetched for
  // models that can actually see them; an unreachable catalog reads as
  // non-vision — skipping the spend is the safe degradation.
  const visionModel = !!catalog?.find((m) => m.id === model)?.vision;

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
    const state = newRequestState(model, webSearchEnabled, budgetS, shodanOn);
    disconnect.state = state;

    // Recovery marker (metadata only): lets the poller tell "still
    // researching" apart from "nothing will ever come".
    await markAnswerRunning(env, log, requestId, identity.id);

    // The JSON helper phases (triage/gap/validation) emit nothing for
    // tens of seconds; idle HTTP connections get dropped by proxies on
    // the way to the client. SSE comment lines (":" prefix) keep bytes
    // flowing — every SSE client ignores them.
    const keepalive = setInterval(() => {
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

    // Photo-location enrichment (independent of the web_search toggle —
    // this resolves metadata the photo itself carries, it doesn't research
    // the user's topic): reverse-geocoded place names + Street View link +
    // nearby establishments as a text block (src/geocode.js, with Google
    // Places upgrading the free Overpass data when that knob is on), and —
    // for vision models with the imagery knobs on — actual Street View
    // frames + an area map appended as labeled image parts (src/maps.js)
    // so synthesis can literally look at the surroundings. Every part
    // fails soft; the belt-and-suspenders catch means a bug here degrades
    // to "no location context", never a dead stream.
    let conversationWithContext = conversation;
    const photoLocations = validateImageLocations(body.imageLocations);
    if (photoLocations.length) {
      emit({ status: { type: "step_start", id: "location", label: "Resolving photo location…" } });
      const details = [];
      try {
        const settings = getSettings(identity);
        const maps = mapsAvailable(env);
        const placesFn =
          maps && settings.nearby_places ? (lat, lon) => placesNearby(env, log, lat, lon) : null;
        const enriched = await augmentWithLocations(env, log, conversation, body.imageLocations, { placesFn });
        conversationWithContext = enriched.conversation;
        details.push(...enriched.details);

        if (maps && visionModel && (settings.street_view || settings.map_context)) {
          const imagery = await collectMapImagery(env, log, photoLocations, {
            streetView: settings.street_view,
            mapImage: settings.map_context,
          });
          const kept = pickContextImages(
            conversationWithContext,
            imagery.images,
            getModelProfile(model).maxMessageImages,
          );
          conversationWithContext = withAppendedImages(conversationWithContext, kept);
          details.push(...imagery.notes);
          if (kept.length < imagery.images.length) {
            details.push(`${imagery.images.length - kept.length} image(s) skipped (model image/size limits)`);
          }
        }
      } catch (err) {
        log.warn("chat.location_context_failed", { error: err?.message || String(err) });
      }
      emit({ status: { type: "step_done", id: "location", label: "Photo location context", details } });
    }

    try {
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
      log.info("chat.complete", {
        user_id: identity.id,
        model,
        rounds: state.iterations,
        searches: state.searchCount,
        sources: state.sources.length,
        shodan_hosts: state.shodanCount,
        duration_ms,
        client_gone: disconnect.gone,
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
        // The admin-configured per-search price is priced for Exa's
        // standard tier; a request whose time budget bought a costlier
        // tier (src/budget.js's searchDepth, e.g. `type: "deep"`) gets its
        // recorded cost scaled by that tier's real price ratio, so a long
        // budget's genuinely higher Exa spend doesn't go under-counted
        // against the user's opaque budget bar or the admin's cost totals.
        exa_cost: state.searchCount * config.exa_cost_per_search_eur * (state.plan.searchDepth?.costMultiplier || 1),
        duration_ms,
      });
      const stats = {
        type: "done",
        model,
        rounds: state.iterations,
        searches: state.searchCount,
        duration_ms,
        prompt_tokens: state.totals.prompt_tokens,
        completion_tokens: state.totals.completion_tokens,
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

// Mutable per-request state threaded through the pipeline.
// Street View frames come first in collectMapImagery's order, so under a
// tight per-model image cap they'd squeeze the area map out entirely —
// but one map plus N-1 street-level views is better context than N views
// with no spatial anchor. When the map didn't make the cut and at least
// two slots were filled, the last kept frame yields its slot to the map
// (re-checked against the size budget, since the map's encoding may be
// larger than the frame it replaces). Exported for unit tests.
export function pickContextImages(conversation, images, maxImages) {
  let kept = imagesThatFit(conversation, images, maxImages);
  const map = images.find((im) => im.kind === "map");
  if (map && !kept.includes(map) && kept.length >= 2) {
    kept = imagesThatFit(conversation, [...kept.slice(0, -1), map], maxImages);
  }
  return kept;
}

// Two ceilings guard the server-added Street View/map images (src/maps.js):
// Berget rejects request bodies over ~1MB (the client's own caps keep the
// user's images under ~700K chars), and some models reject messages
// carrying more than N images (model-profiles.js maxMessageImages,
// live-bisected — Berget's Mistral Medium 400s at 3+). Images are kept in
// order until either budget runs out (Street View frames first, the area
// map last), counting the user's own images already in the message.
// Exported for unit tests.
const MAX_REQUEST_CHARS = 900_000;
export function imagesThatFit(conversation, images, maxImages, maxChars = MAX_REQUEST_CHARS) {
  let total = JSON.stringify(conversation).length;
  const last = conversation[conversation.length - 1];
  let count = Array.isArray(last?.content)
    ? last.content.filter((p) => p?.type === "image_url").length
    : 0;
  const kept = [];
  for (const im of images) {
    const size = im.dataUrl.length + 200; // part-envelope + label overhead
    if (total + size > maxChars || count >= maxImages) break;
    kept.push(im);
    total += size;
    count += 1;
  }
  return kept;
}

function newRequestState(model, webSearch, budgetS, shodan) {
  return {
    startedAt: Date.now(),
    model,
    webSearch,
    shodan, // opt-in Shodan host-intelligence enrichment (src/settings.js)
    shodanCount: 0, // hosts Shodan actually returned data for
    plan: planResearch(model, budgetS),
    searchCount: 0,
    iterations: 1, // search waves (initial + gap rounds that ran)
    ranQueries: new Set(),
    sources: [], // numbered registry, deduped by URL
    byUrl: new Map(),
    totals: { prompt_tokens: 0, completion_tokens: 0 },
  };
}
