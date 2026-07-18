// @ts-check
// POST /api/chat — thin handler: validate the request, resolve the model,
// enforce the caller's research quota, build the per-request state (budget
// plan, counters, source registry), and stream the research pipeline
// (src/pipeline.js) as SSE. Ends every stream with a `done` stats event and
// `[DONE]`, then records the usage event for quota accounting and (unless
// incognito) the full chat-log row.
//
// Handler flow: handleChat → resolveChatModels → enforceQuotaGate →
// resolveEnrichmentOptions → the SSE stream (runChatStream, an inner
// function because it shares the disconnect/keepalive lifecycle with the
// stream's cancel() callback).

import { classifyChatError, raiseAlert } from "./alerts.js";
import { heartbeatAnswer, markAnswerRunning, saveAnswer } from "./answers.js";
import { recordChatLog, shellLogSummary } from "./chatlog.js";
import { addUserMessage } from "./user-messages.js";
import { adminDefaultModelValid, DEFAULT_MODEL } from "./berget.js";
import { resolveJsonModel as resolveJsonPhaseModel } from "./model-routing.js";
import { exaCost, summarizeSpend } from "./billing.js";
// Re-exported so chat.test.js (and any importer) keeps getting it from here.
export { summarizeSpend } from "./billing.js";
import { listChatModels } from "./providers.js";
import { clampBudget, planResearch } from "./budget.js";
import { augmentWithLocations } from "./geocode.js";
import { jsonResponse, sseResponse } from "./http.js";
import { runPipeline } from "./pipeline.js";
import { getConfig } from "./config.js";
import {
  effectiveQuota,
  getUsage,
  inflightLimitResponse,
  quotaBlockedResponse,
  quotaExceeded,
  recordUsage,
  releaseInflight,
  reserveInflight,
} from "./quota.js";
// Re-exported so chat.test.js (and quiz-api/bash-api/rag historically) keeps
// getting it from here; the canonical home is now quota.js, next to the
// sibling inflightLimitResponse 429 builder.
export { quotaBlockedResponse } from "./quota.js";
import {
  resolveModel,
  resolveShellTranscript,
  sanitizeClientDiag,
  validateImageLocations,
  validateMapView,
  validateMessages,
  validateStreetViewPov,
} from "./validation.js";
import { bashLiteEnabled, developerModeEnabled, shodanEnabled, googleMapsEnabled } from "./settings.js";
import { buildSlugOk } from "./build-pub.js";
import { createFeedbackEntry } from "./feedback.js";
import { getDb } from "./db.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').ModelCatalog} ModelCatalog */
/** @typedef {import('./auth.js').Identity} Identity */
/** @typedef {import('./config.js').SiteConfig} SiteConfig */

/**
 * The parsed POST /api/chat body — untrusted client input; every field is
 * validated before use (src/validation.js).
 * @typedef {Object} ChatRequestBody
 * @property {import('./types.js').Conversation} messages
 * @property {string} [model] answer-model override (validated vs the catalog)
 * @property {boolean} [incognito] ghost toggle: suppresses the chat-log row
 * @property {number} [time_budget_s] UI slider value (clamped server-side)
 * @property {boolean} [web_search] knob, default on (only `false` disables)
 * @property {boolean} [developer_mode] OFF-ONLY override: `false` disables the introspection enrichment for this request (never enables it)
 * @property {boolean} [sdk_mode] SDK ("lovable") mode: route this request to the
 *   Agent-Pair-SDK build flow (pipeline.js runSdkBuild). Honored only when the
 *   caller's developer_mode knob grants introspection — the same capability
 *   gate; a client can't acquire the mode with the knob off
 * @property {boolean} [swe_mode] SWE ("software engineering") mode: route this
 *   request to the Se/cure-variant build flow (pipeline.js runSdkBuild with the
 *   swe flavor) — "prompt a new instance of Se/cure". Same capability gate and
 *   publish machinery as sdk_mode; sdk_mode wins if both arrive
 * @property {string} [build_slug] the conversation's already-published build
 *   slug (from a previous reply's build event), so a build-mode iteration
 *   republishes the SAME /app/<slug>/ URL. Validated; ignored outside a build mode
 * @property {any} [imageLocations] attached-photo GPS EXIF coords
 * @property {any} [street_view_pov] the user's current panorama view
 * @property {any} [map_view] the user's current interactive-map view
 * @property {any} [user_location] browser geolocation for "here" asks
 * @property {any} [shell_transcript] bash-lite sandbox runs gathered client-side
 *   before this request ({command,exitCode,stdout,stderr}[]); honored only when
 *   the caller's bash_lite_mcp knob is on, ignored otherwise
 * @property {any} [client_diag] client sandbox-readiness diagnostic
 *   ({coi,bl,sb,ran,css}) recorded to the chat log's meta
 */

/**
 * The full per-request pipeline state: the shared shape (src/types.d.ts
 * RequestState) plus the fields this channel adds in newRequestState and the
 * ones the pipeline writes back for the chat log.
 * @typedef {import('./types.js').RequestState & {
 *   mapView: any,
 *   userLocation: any,
 *   quizzes: boolean,
 *   quiz: any,
 *   complexity: string | null,
 *   subquestions: any[],
 *   conflicts: any[],
 *   aux: Record<string, { count: number, ran: Set<string> }>,
 *   notes: any[],
 *   notesCursor: number,
 *   fetchedUrls: Set<string>,
 *   mapsIntent?: string,
 *   failoverModel?: string,
 *   shellTranscript?: Array<{ command: string, exitCode: number, stdout: string, stderr: string }>,
 *   sandboxEnabled?: boolean,
 *   sdkMode?: boolean,
 *   sweMode?: boolean,
 *   buildSlug?: string | null,
 *   userId?: string,
 *   buildResult?: { slug: string, url: string, files: number, bytes: number },
 *   feedbackCapture?: boolean,
 *   feedback?: { comment: string, question: string | null, answer_excerpt: string | null, model: string },
 * }} ChatRequestState
 */

/**
 * The opt-in enrichment context resolved per request (see
 * resolveEnrichmentOptions).
 * @typedef {Object} EnrichmentOptions
 * @property {boolean} shodanOn
 * @property {boolean} googleMapsOn
 * @property {boolean} developerOn
 * @property {boolean} modelIsVision
 * @property {string | null} visionModel
 * @property {string[]} visionModels
 * @property {import('./types.js').ImageLocation[]} imageLocations
 * @property {import('./types.js').StreetViewPov | null} streetViewPov
 * @property {any} mapView
 * @property {any} userLocation
 */

/**
 * Streams one research request as SSE. Never rejects after the stream
 * starts: pipeline failures are emitted as `{error}` events and the finally
 * block still records usage, the chat log, and the recovery answer.
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext | undefined} ctx
 * @param {string} requestId
 * @returns {Promise<Response>}
 */
export async function handleChat(request, env, log, identity, ctx, requestId) {
  if (!env.BERGET_API_TOKEN) {
    log.error("chat.misconfigured", { missing: "BERGET_API_TOKEN" });
    return jsonResponse(
      { error: "Server not configured: BERGET_API_TOKEN secret is missing." },
      500,
    );
  }

  /** @type {ChatRequestBody} */
  let body;
  try {
    body = /** @type {ChatRequestBody} */ (await request.json());
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const invalid = validateMessages(body?.messages);
  if (invalid) {
    log.warn("chat.invalid_request", { reason: invalid });
    return jsonResponse({ error: invalid }, 400);
  }

  const { catalog, config, resolved } = await resolveChatModels(env, log, body);
  if ("error" in resolved) return jsonResponse({ error: resolved.error }, resolved.status);
  const model = resolved.model;
  const jsonModel = resolveJsonModel(catalog, model);

  const quotaBlocked = await enforceQuotaGate(env, log, config, identity);
  if (quotaBlocked) return quotaBlocked;

  // Per-user concurrency reservation (M-1/M-2): bounds how many expensive
  // requests one user can have in flight, so a burst near the quota can't all
  // pass the check-then-act gate above and overspend. Reserved AFTER the quota
  // gate; the slot is released in runChatStream's finally (below), which the
  // waitUntil keeps alive to run on EVERY exit — success, error, or client
  // disconnect. Fail-soft: reserveInflight returns ok on any D1 trouble.
  const reserved = await reserveInflight(env, identity.id, requestId);
  if (!reserved.ok) {
    log.info("chat.rate_limited", { user_id: identity.id, active: reserved.active, limit: reserved.limit });
    return jsonResponse(inflightLimitResponse(reserved), 429);
  }

  const conversation = body.messages;
  // The ghost (incognito) toggle, forwarded by the client: an incognito
  // conversation is never written to the server-side chat log (chatlog.js)
  // — the anonymous-chat escape hatch from the otherwise-default full
  // question/answer logging. Metadata-only Workers Logs still fire.
  const incognito = body.incognito === true;
  let budgetS = clampBudget(body.time_budget_s); // UI slider (src/budget.js)
  budgetS = Math.min(budgetS, config.max_time_budget_s);
  const webSearchEnabled = body.web_search !== false; // knob: default on
  const enrich = resolveEnrichmentOptions(body, env, identity, catalog, model);
  // SDK ("lovable") mode: the request asks for the Agent-Pair-SDK build flow.
  // Gated on the SAME capability the introspection enrichment uses — the
  // developer_mode knob (enrich.developerOn) — so a client can't acquire the
  // mode the knob doesn't grant; the mode dropdown flips the knob first.
  const sdkOn = body.sdk_mode === true && enrich.developerOn;
  // SWE ("software engineering") mode: the request asks for the Se/cure-variant
  // build flow — "prompt a new instance of Se/cure". Same capability gate + same
  // publish machinery as SDK mode; SDK wins if both flags somehow arrive.
  const sweOn = !sdkOn && body.swe_mode === true && enrich.developerOn;
  const buildSlug = (sdkOn || sweOn) && buildSlugOk(body.build_slug) ? /** @type {string} */ (body.build_slug) : null;
  // The experimental bash-lite sandbox transcript: the browser ran an agentic
  // shell loop (public/js/bash-agent.js) before sending, and attached what it
  // ran + the real output. Honored only when this account's knob is on
  // (defense: a client can't smuggle a transcript in with the feature off);
  // folded into the answer as ground truth by the pipeline (ctx.shellBlock).
  const shellTranscript = bashLiteEnabled(env, identity) ? resolveShellTranscript(body.shell_transcript) : [];

  // Stale-client auto-heal. A knob-on account whose request carries NO
  // client_diag (public/js/stream.js has attached it since the sandbox fixes)
  // is running a pre-fix cached bundle — the sandbox can't work no matter what
  // because the client code predates it, and a plain reload keeps serving the
  // cached assets. Answer this request normally, but tell the browser to drop
  // its HTTP cache (and, in Chromium, its back-forward cache) so the NEXT load
  // fetches the fixed code. Scoped to "cache" only — never "cookies"/"storage"
  // — so the encrypted local history is untouched; self-limiting, since once
  // the fresh bundle loads it sends client_diag and this stops firing.
  const staleSandboxClient = bashLiteEnabled(env, identity) && body.client_diag === undefined;
  /** @type {Record<string, string>} */
  const responseHeaders = staleSandboxClient ? { "clear-site-data": '"cache"' } : {};
  // Full request-level visibility: the exact client_diag the browser sent (or
  // null when absent = a pre-fix bundle), plus the effective server knob. Lets
  // a live `wrangler tail` show precisely why the sandbox did or didn't engage.
  log.info("chat.client_diag", {
    user_id: identity.id,
    request_id: requestId,
    diag: body.client_diag ?? null,
    knob_on: bashLiteEnabled(env, identity),
    shell_transcript_len: shellTranscript.length,
  });

  // Client-disconnect detection: when the reader goes away (backgrounded
  // PWA, dropped network), the runtime calls cancel() — enqueue does NOT
  // reliably throw. The pipeline keeps running after a disconnect (emit
  // degrades to a no-op): the spend is already mostly committed by then,
  // and the finished answer is parked in the recovery cache
  // (src/answers.js) for the client to poll — instead of asking the user
  // to resend and pay again.
  /** @type {{ gone: boolean, state: ChatRequestState | null }} */
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

  /** @param {ReadableStreamDefaultController} controller */
  async function runChatStream(controller) {
    const encoder = new TextEncoder();
    const state = newRequestState(model, jsonModel, webSearchEnabled, budgetS, enrich.shodanOn, {
      googleMaps: enrich.googleMapsOn,
      introspection: enrich.developerOn,
      vision: enrich.modelIsVision,
      visionModel: enrich.visionModel,
      visionModels: enrich.visionModels,
      imageLocations: enrich.imageLocations,
      streetViewPov: enrich.streetViewPov,
      mapView: enrich.mapView,
      userLocation: enrich.userLocation,
      shellTranscript,
      sandboxEnabled: bashLiteEnabled(env, identity),
      sdkMode: sdkOn,
      sweMode: sweOn,
      buildSlug,
      userId: String(identity.id),
    });
    disconnect.state = state;
    // This channel captures feedback: a message that opens with the word
    // "feedback" (feedback.js feedbackIntent) is routed to the feedback case
    // (pipeline.js runFeedbackCapture) and recorded below instead of being
    // researched. Gated on a real signed-in user row — feedback is per-user and
    // needs someone to attribute the entry to and route the developers' reply
    // back to; break-glass sessions (no row) keep researching.
    state.feedbackCapture = !!identity.user;

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
    // Errors for the chat log (chatlog.js): a thrown stream failure, or the
    // last fail-soft `{error}` event the pipeline emitted instead of throwing.
    /** @type {string | null} */
    let streamError = null;
    /** @type {string | null} */
    let emittedError = null;
    // `any` (not the SseEvent union) so the callback stays assignable to the
    // wider emit signatures pipeline.js/geocode.js declare; the wire
    // vocabulary is documented as SseEvent in src/types.d.ts.
    /** @param {any} obj one SSE event object */
    const emit = (obj) => {
      const chunk = obj.choices?.[0]?.delta?.content;
      if (chunk) answer.text += chunk;
      else if (obj.status?.type === "discard_text") answer.text = "";
      if (obj.error) emittedError = String(obj.error);
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
      const errMessage = /** @type {any} */ (err)?.message || String(err);
      streamError = errMessage;
      log.error("chat.stream_failed", {
        user_id: identity.id,
        error: errMessage,
      });
      const alert = classifyChatError(errMessage);
      await raiseAlert(env, alert.type, alert.severity, alert.message, `model: ${model} — ${errMessage}`);
      emit({ error: "Worker error: " + errMessage });
    } finally {
      clearInterval(keepalive);
      // Free the concurrency slot reserved in handleChat. This finally runs on
      // EVERY exit path — normal completion, a thrown pipeline error (caught
      // above), and client disconnect (ctx.waitUntil keeps the Worker alive
      // through here) — so a slot is never leaked. Fail-soft, so it also
      // can't disturb the accounting/logging that follows.
      await releaseInflight(env, requestId);
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
        introspection: state.introspectionCount,
        sdk: sdkOn,
        swe: sweOn,
        duration_ms,
        client_gone: disconnect.gone,
        incognito,
      });
      // Usage accounting for quotas (fails soft; never breaks the stream).
      const { prompt_tokens, completion_tokens, berget_cost } = summarizeSpend(state, catalog);
      const exa_cost = exaCost(state, config, billedSearches);
      await recordUsage(env, log, {
        user_id: identity.id,
        model,
        prompt_tokens,
        completion_tokens,
        searches: billedSearches,
        berget_cost,
        exa_cost,
        duration_ms,
      });
      // Full-visibility interaction log (src/chatlog.js): the complete
      // question, answer, conversation, research metadata, and any error —
      // skipped entirely for incognito (ghost) conversations. Fails soft.
      if (!incognito) {
        await recordChatLog(env, log, {
          request_id: requestId,
          user_id: identity.id,
          channel: "chat",
          model,
          json_model: jsonModel,
          conversation,
          answer: answer.text,
          status: streamError || emittedError ? "error" : disconnect.gone ? "disconnected" : "ok",
          error: streamError || emittedError,
          web_search: webSearchEnabled,
          budget_s: budgetS,
          rounds: state.iterations,
          searches: state.searchCount,
          sources: state.sources.length,
          prompt_tokens,
          completion_tokens,
          duration_ms,
          client_gone: disconnect.gone,
          meta: {
            queries: [...state.ranQueries],
            sources: state.sources.map((s) => ({ n: s.n, title: s.title, url: s.url })),
            complexity: state.complexity,
            subquestions: state.subquestions,
            conflicts: state.conflicts,
            shodan_hosts: state.shodanCount,
            google_maps: state.mapsCount,
            // 1 when developer mode's introspection enrichment folded the
            // source snapshot into this exchange (src/introspect.js).
            introspection: state.introspectionCount,
            // Build modes: `sdk` is 1 when this request ran the SDK build flow,
            // `swe` is 1 for the Se/cure-variant build flow; `build` is the
            // published result ({slug, url, files, bytes} — pipeline.js
            // runSdkBuild), dropped when nothing was published.
            sdk: sdkOn ? 1 : 0,
            swe: sweOn ? 1 : 0,
            build: /** @type {any} */ (state).buildResult,
            // Which maps intent matcher decided (or "none") — the routing
            // trace scripts/chatlogs surfaces (undefined when the knob is
            // off and the enrichment never ran).
            maps_intent: state.mapsIntent,
            cached_searches: state.cachedSearchCount || 0,
            // Present only when the chosen model was unavailable and the
            // answer was written by the reliable fallback (pipeline.js's
            // streamCompletion failover) — JSON.stringify drops undefined.
            failover_model: state.failoverModel,
            // The full delivered quiz (pipeline.js runQuizGeneration), when
            // this request became one — the streamed `answer` above is only
            // its intro, so the log would otherwise hide what was asked.
            quiz: state.quiz || undefined,
            // The bash-lite agent's shell tool calls (state.shellTranscript):
            // the exact commands the browser's agentic loop ran, their exit
            // codes, and their clamped output — full "tool call" visibility.
            // Undefined (key dropped) when nothing ran; client_diag.ran still
            // carries the count. See chatlog.js shellLogSummary.
            shell: shellLogSummary(state.shellTranscript),
            berget_cost,
            exa_cost,
            // Diagnostic: the client's sandbox-readiness (public/js/stream.js
            // client_diag) — crossOriginIsolated (coi), the knob (bl), whether
            // the sandbox can run (sb), how many commands ran (ran), and the
            // CSS build stamp. Lets a not-running sandbox be diagnosed from the
            // log without device access.
            client_diag: sanitizeClientDiag(body.client_diag),
            // 1 when this message was FEEDBACK for the developers (pipeline.js
            // runFeedbackCapture) — the chat-log half of the double discovery
            // path (the structured entry is created just below). Lets a
            // chatlogs scan find feedback even when the entry write failed.
            feedback: state.feedback ? 1 : 0,
          },
        });
      }
      // Feedback pipeline (pipeline.js runFeedbackCapture): the message was a
      // report to the developers. Persist it as a feedback entry — the Claude
      // Code work queue (scripts/feedback + the feedback-loop skill) — alongside
      // the meta.feedback chat-log tag above. Recorded even in incognito:
      // opening a message with "feedback" is explicit intent to reach the
      // developers (the reply says so). Fail-soft — a capture must never disturb
      // the finished answer or the accounting above.
      if (state.feedback && identity.user) {
        try {
          const id = await createFeedbackEntry(await getDb(env), String(identity.id), {
            comment: state.feedback.comment,
            question: state.feedback.question,
            answer_excerpt: state.feedback.answer_excerpt,
            model,
            page: "chat",
          });
          if (id) log.info("feedback.captured", { user_id: identity.id, feedback_id: id, request_id: requestId });
        } catch (err) {
          log.warn("feedback.capture_failed", {
            user_id: identity.id,
            error: /** @type {any} */ (err)?.message || String(err),
          });
        }
      }
      /** @type {import('./types.js').StatusDone} */
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

  return sseResponse(stream, responseHeaders);
}

// ---- pre-stream setup helpers ----------------------------------------------

/**
 * Fetches the model catalog (degrading to null rather than blocking chat),
 * applies the admin's site default model when valid & up, and resolves the
 * request's answer model.
 * @param {Env} env
 * @param {Logger} log
 * @param {ChatRequestBody} body mutated: body.model may receive the site default
 * @returns {Promise<{ catalog: ModelCatalog | null, config: SiteConfig,
 *   resolved: ReturnType<typeof resolveModel> }>}
 */
async function resolveChatModels(env, log, body) {
  /** @type {ModelCatalog | null} */
  let catalog = null;
  try {
    catalog = await listChatModels(env);
  } catch (err) {
    log.warn("chat.model_catalog_unavailable", { error: /** @type {any} */ (err)?.message || String(err) });
  }
  const config = await getConfig(env);
  // The admin can set a site default model; it only applies when valid & up.
  if (!body.model && adminDefaultModelValid(config, catalog)) {
    body.model = config.default_model;
  }
  return { catalog, config, resolved: resolveModel(body, catalog, env, log) };
}

/**
 * The research-quota gate (Berget budget + Exa searches per 5h/day/week/
 * month windows). ADMINS ARE NEVER BLOCKED: their usage is recorded and
 * their bars keep counting (past 100%), but the 429 applies to regular
 * users only.
 * @param {Env} env
 * @param {Logger} log
 * @param {SiteConfig} config
 * @param {Identity} identity
 * @returns {Promise<Response | null>} the 429 response, or null to proceed
 */
async function enforceQuotaGate(env, log, config, identity) {
  const usage = await getUsage(env, identity.id);
  const quota =
    identity.isSecretAdmin || identity.role === "admin"
      ? null
      : effectiveQuota(config, identity.user);
  if (!quota) return null;
  const blocked = quotaExceeded(usage, quota);
  if (!blocked) return null;
  log.info("chat.quota_blocked", {
    user_id: identity.id,
    period: blocked.period,
    kind: blocked.kind,
  });
  // Cast: addUserMessage's option defaults are null, so its inferred option
  // type is null-only; the real accepted values are these enums.
  await addUserMessage(env, identity.id, "quota_exceeded", /** @type {any} */ ({ period: blocked.period, kind: blocked.kind }));
  return jsonResponse(quotaBlockedResponse(blocked), 429);
}

/**
 * Resolves the opt-in enrichment context for one request:
 *
 * - Shodan host intelligence and Google Maps (Places + Street View + Static
 *   Maps) are per-user settings knobs (src/settings.js), not request flags —
 *   gated here so the pipeline only ever attempts them when both the knob is
 *   on and the key is present.
 * - Vision capability of the CHOSEN answer model decides whether fetched
 *   imagery is attached for the model to describe (only vision models can
 *   receive it). For a non-vision answer model, a RANKED list of vision
 *   helper models describes Street View instead — a list, not a single pick,
 *   because the describe call was observed (2026-07-08, describe_failed "The
 *   operation was aborted") timing out on a loaded Mistral Medium while
 *   other vision models answered instantly; a one-model helper goes blind
 *   exactly when the backend is busiest. This is why "describe this street
 *   view" works regardless of model choice.
 * - The client's view/location fields (all validated, all maps-knob-gated):
 *   street_view_pov = the user's CURRENT inline-panorama view (they may have
 *   panned/moved it), so a follow-up captures exactly what's on screen
 *   instead of four generic cardinal frames; map_view = the same idea for
 *   the interactive map (the no-coverage stand-in); user_location = browser
 *   geolocation, sent ONLY for explicit "street view here" asks with no live
 *   view on screen (same shape as a map view — zoom is ignored — so the same
 *   validator applies).
 * @param {ChatRequestBody} body
 * @param {Env} env
 * @param {Identity} identity
 * @param {ModelCatalog | null} catalog
 * @param {string} model the resolved answer model
 * @returns {EnrichmentOptions}
 */
function resolveEnrichmentOptions(body, env, identity, catalog, model) {
  const shodanOn = shodanEnabled(env, identity);
  const googleMapsOn = googleMapsEnabled(env, identity);
  // OFF-ONLY request override (the incognito pattern — a client may DECLINE
  // a capability it holds, never acquire one it doesn't): `developer_mode:
  // false` in the body skips the introspection enrichment for THIS request,
  // so an account with the knob on — including the break-glass admin, for
  // whom developer mode is ALWAYS on by definition (settings.js) and who has
  // no settings row to flip — can still get a normal web-research answer.
  // The eval harnesses (tests/eval-bench.mjs, tests/model-eval.mjs) depend on
  // this: without it every break-glass bench request routes introspection-
  // first and measures source reading instead of the research pipeline.
  const developerOn = body.developer_mode === false ? false : developerModeEnabled(env, identity);
  const modelIsVision = !!catalog?.find((m) => m.id === model)?.vision;
  const visionCandidates = catalog?.filter((m) => m.vision && m.up).map((m) => m.id) || [];
  const visionModels = (modelIsVision
    ? [model, ...visionCandidates.filter((id) => id !== model)]
    : visionCandidates
  ).slice(0, 3);
  return {
    shodanOn,
    googleMapsOn,
    developerOn,
    modelIsVision,
    visionModels,
    visionModel: visionModels[0] || null,
    imageLocations: validateImageLocations(body.imageLocations),
    streetViewPov: googleMapsOn ? validateStreetViewPov(body.street_view_pov) : null,
    mapView: googleMapsOn ? validateMapView(body.map_view) : null,
    userLocation: googleMapsOn ? validateMapView(body.user_location) : null,
  };
}

// ---- exported pure helpers (unit-tested in chat.test.js) --------------------

/**
 * Which model runs the JSON planning phases (triage/gap/validate): the fixed
 * reliable DEFAULT_MODEL (Mistral Small), bound into the shared decision in
 * model-routing.js (also used by src/mcp.js). Rationale for the split: some
 * capable answer models (notably reasoning models like GLM) produce unreliable
 * JSON, which was corrupting triage into echoing the raw user message as the
 * search query; Mistral Small is fast, cheap and reliable at JSON mode.
 * @param {ModelCatalog | null | undefined} catalog
 * @param {string} userModel the resolved answer model
 * @returns {string}
 */
export function resolveJsonModel(catalog, userModel) {
  return resolveJsonPhaseModel(catalog, userModel, DEFAULT_MODEL);
}

// ---- per-request state -------------------------------------------------------

/**
 * Mutable per-request state threaded through the pipeline.
 * @param {string} model
 * @param {string} jsonModel
 * @param {boolean} webSearch
 * @param {number} budgetS
 * @param {boolean} shodan
 * @param {Partial<EnrichmentOptions> & { googleMaps?: boolean, vision?: boolean, introspection?: boolean, sandboxEnabled?: boolean, sdkMode?: boolean, sweMode?: boolean, buildSlug?: string | null, userId?: string, shellTranscript?: Array<{ command: string, exitCode: number, stdout: string, stderr: string }> }} [extras]
 * @returns {ChatRequestState}
 */
function newRequestState(model, jsonModel, webSearch, budgetS, shodan, extras = {}) {
  return {
    startedAt: Date.now(),
    model,
    jsonModel, // fixed model for the JSON planning phases (see resolveJsonModel)
    webSearch,
    shodan, // opt-in Shodan host-intelligence enrichment (src/settings.js)
    shodanCount: 0, // hosts Shodan actually returned data for
    // Developer mode's introspection enrichment (src/introspect.js): the gate
    // is the knob; whether the conversation actually engages the mode is the
    // enrichment's own (deterministic) decision.
    introspection: !!extras.introspection,
    introspectionCount: 0, // 1 when the source snapshot was folded in
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
    // The user's current interactive-map view (validated), for the follow-up
    // capture-what-they-see map path (src/enrichment.js).
    mapView: extras.mapView || null,
    // The device's reported location (validated) — the anchor for explicit
    // "street view here" asks when no live view is on screen.
    userLocation: extras.userLocation || null,
    // The bash-lite sandbox transcript (resolveShellTranscript): commands the
    // browser ran client-side and their real output, folded into the answer
    // as ground truth (pipeline.js ctx.shellBlock). Empty unless the
    // experimental knob is on AND the client attached one.
    shellTranscript: extras.shellTranscript || [],
    // Whether the bash-lite sandbox knob is on for this account: with dev
    // mode also on, the client mounts the source tree at /src in the VM, so
    // the introspection block may point the model there (src/introspect.js).
    sandboxEnabled: !!extras.sandboxEnabled,
    // SDK ("lovable") mode — pipeline.js runSdkBuild: the Agent-Pair-SDK
    // build flow. buildSlug is the conversation's already-published build (an
    // iteration keeps the /app/<slug>/ URL stable); userId is the publisher
    // recorded as the build's owner (slug-reuse authorization).
    sdkMode: !!extras.sdkMode,
    // SWE mode — pipeline.js runSdkBuild with the swe flavor: the
    // Se/cure-variant build flow. Shares buildSlug/userId with SDK mode.
    sweMode: !!extras.sweMode,
    buildSlug: extras.buildSlug || null,
    userId: extras.userId || "",
    // This channel renders the interactive inline-quiz event (src/quiz.js;
    // pipeline.js runQuizGeneration). The MCP channel builds its own state
    // without this flag, so MCP callers keep getting plain text answers.
    quizzes: true,
    quiz: null, // the delivered quiz (normalized), when this request became one

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
