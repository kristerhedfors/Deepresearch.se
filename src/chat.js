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
import { adminDefaultModelValid, completeJson, DEFAULT_MODEL } from "./berget.js";
import { resolveJsonModel as resolveJsonPhaseModel } from "./model-routing.js";
import { denseSpend, exaCost, spendByModel, summarizeSpend } from "./billing.js";
import { newRetrievalSpend } from "./dense-rag.js";
// Re-exported so chat.test.js (and any importer) keeps getting it from here.
export { summarizeSpend } from "./billing.js";
import { listChatModels } from "./providers.js";
import { accountModels } from "./user-models.js";
import { clampBudget, planResearch } from "./budget.js";
import { augmentWithLocations } from "./geocode.js";
import { jsonResponse, sseResponse } from "./http.js";
import { runPipeline } from "./pipeline.js";
import { DEFAULT_CONFIG, getConfig } from "./config.js";
import {
  QUOTA_UNAVAILABLE_STATUS,
  effectiveQuota,
  getUsage,
  inflightLimitResponse,
  quotaBlockedResponse,
  quotaEnforced,
  quotaExceeded,
  quotaUnavailableResponse,
  recordModelUsage,
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
  resolveSwarmResults,
  sanitizeClientDiag,
  validateImageLocations,
  validateMessages,
} from "./validation.js";
import { extensionLogMeta, resolveExtensionState } from "./extensions.js";
import { bashLiteEnabled, chatModesAvailable, extensionEnabledMap, memoryEnabled, storedChatMode } from "./settings.js";
import { DEFAULT_CHAT_MODE, modeCarriesSource, resolveBodyChatMode, routingNeedsRegistry } from "./chat-modes.js";
import { lastUserMessage, lastUserText, textOf } from "./conversation.js";
import { buildSlugOk } from "./build-pub.js";
import { normalizeSwarmCapability } from "./orchestrator-api.js";
import { loadAgentRegistry } from "./agent-registry.js";
import { resolvePromptSet, resolveRequestAgent, resolveUntrustedAgent } from "./agent-spec.js";
import { buildFeedbackDebugContext, createOrThreadFeedbackEntry, feedbackPageTag } from "./feedback.js";
import { slashEffect } from "./slash.js";
import { recordUseCaseFeedback } from "./testpoints.js";
import { getDb } from "./db.js";
import { normalizeSearchSource } from "./websearch-backends.js";
import { runMemoryExtraction } from "./memory.js";

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
 * @property {string} [search_source] WHO runs this request's searches, set by the
 *   "Exa web search" knob in settings: "exa" (default) | "cloudflare" (this Worker
 *   searches for itself). Anything else — including absent — means the
 *   site-configured backend; an admin can pin that with search.allow_user_choice
 * @property {string} [chat_mode] WHICH MODE answers this request — one of
 *   chat-mode-core.js CHAT_MODES ("science" | "cyber" | "introspection" | "sdk"
 *   | "orchestrator" | "outrospection" | "models"). The single mode field, and
 *   the preferred one: it outranks the per-mode booleans below, an unknown value
 *   is ignored rather than failing the request, and a mode other than the
 *   default is honored only when the modes are available to the caller (a
 *   signed-in account or the break-glass operator). Absent → the account's
 *   stored pick, else the default, "science". The retired id "normal" — the
 *   general Deep Research turn, removed 2026-08-13 — still resolves, to
 *   "science" (chat-mode-core.js RETIRED_CHAT_MODES), so callers written against
 *   the old vocabulary keep working; what they get is a literature-first agent
 *   rather than an open-web one, because there is no longer a general agent to
 *   fall back to
 * @property {boolean} [developer_mode] OFF-ONLY override: `false` forces this
 *   request to the DEFAULT mode — no source enrichment, no picked mode —
 *   whatever `chat_mode`, the mode flags or the stored pick say. It never
 *   ENABLES anything (the incognito pattern). Retained as a documented promise
 *   to callers written before `chat_mode` existed; `true` does nothing
 * @property {boolean} [introspection_mode] Introspection mode: answer from this
 *   site's own deployed source (src/introspect.js + pipeline.js
 *   runSourceResearch). Equivalent to `chat_mode: "introspection"`. New in
 *   2026-07-26 — before that introspection had no flag and was inferred from
 *   the developer_mode knob, which is exactly the conflation that was removed
 * @property {boolean} [sdk_mode] SDK ("lovable") mode: route this request to the
 *   DistillSDK build flow (pipeline.js runSdkBuild) — distill this site (above
 *   all the Se/cure tier) into a new flavour published at a live URL.
 *   Equivalent to `chat_mode: "sdk"`
 * @property {string} [build_slug] the conversation's already-published build
 *   slug (from a previous reply's build event), so a build-mode iteration
 *   republishes the SAME /app/<slug>/ URL. Validated; ignored outside a build mode
 * @property {boolean} [orchestrator_mode] Orchestrator mode: route this request
 *   to the sub-agent workflow flow (src/orchestrator.js runOrchestration) — a
 *   JSON-planned team of sub-agents executed in parallel waves, then one merged
 *   answer. Equivalent to `chat_mode: "orchestrator"`
 * @property {any} [swarm] what the caller's BROWSER can host for the Orchestrator's
 *   `swarm` node kind ({modelId, modelLabel} — public/js/swarm-runtime.js
 *   detectSwarmCapability). Its presence is what allows a plan to use the kind
 * @property {any} [workflow] a sub-agent plan the client already fetched from
 *   /api/orchestrator/plan (so it could run the swarm nodes locally first).
 *   Re-normalized before use; ignored outside orchestrator mode
 * @property {any} [swarm_results] agent id → the brief that node's on-device swarm
 *   produced in the browser ({text, agreement, members, rounds, failed}).
 *   Clamped by resolveSwarmResults; ignored outside orchestrator mode
 * @property {boolean} [models_mode] Models mode: the model-lifecycle research
 *   agent (src/models-agent.js). Forces Hub search on for the turn and folds
 *   the live CROSS-PROVIDER catalog in — priced, and annotated with what has
 *   been verified — when the message is about choosing, pricing, evaluating or
 *   starting a model. Equivalent to `chat_mode: "models"`. Adds no executor: the
 *   answer phase stays the ordinary research one
 * @property {boolean} [outrospection_mode] Outrospection mode: route this request
 *   to the outward feed (src/outrospect.js runOutrospection) — introspection's
 *   mirror image, answering from what everyone ELSE shipped rather than from
 *   this site's own source. Equivalent to `chat_mode: "outrospection"`
 * @property {string} [agent] ADDRESS an agent from the registry (sdk/AGENTS.json)
 *   by id, instead of letting a mode flag pick the mode's default agent. This is
 *   what makes a registry entry reachable with no `defaults` row, no mode flag
 *   and no client code — the seam an agent builder needs. Subject to the SAME
 *   `capability.requires` gate as every other route: an unknown id, and an id
 *   whose requirements the caller's knobs don't grant, both fall through to the
 *   defaults table rather than erroring or escalating
 * @property {any} [agent_spec] an AgentSpec supplied INLINE with the request —
 *   a spec the caller wrote rather than one this repo committed (what Agent
 *   Studio hands back once it has built one). Most specific of the routes: it
 *   beats `agent` and every mode flag, and needs no registry load. UNTRUSTED —
 *   validated whole at the boundary (resolveUntrustedAgent), with the knobs it
 *   needs DERIVED from what it selects rather than from what it claims to
 *   require, so it can narrow its own run and never widen it. A refused spec is
 *   logged and the turn is answered by the agent it would otherwise have got
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
 *   quizzes: boolean,
 *   quiz: any,
 *   complexity: string | null,
 *   subquestions: any[],
 *   conflicts: any[],
 *   aux: Record<string, { count: number, ran: Set<string> }>,
 *   notes: any[],
 *   notesCursor: number,
 *   fetchedUrls: Set<string>,
 *   failoverModel?: string,
 *   shellTranscript?: Array<{ command: string, exitCode: number, stdout: string, stderr: string }>,
 *   sandboxEnabled?: boolean,
 *   answerPhase?: string | null,
 *   agentId?: string | null,
 *   promptSet?: string | null,
 *   capability?: import('./agent-spec.js').AgentCapability | null,
 *   sdkMode?: boolean,
 *   orchestratorMode?: boolean,
 *   orchestration?: { agents: number, waves: number, failed: number, searches: number, swarm?: { nodes: number, members: number, agreement: number, model: string } },
 *   swarm?: { modelId: string, modelLabel: string } | null,
 *   orchWorkflow?: any,
 *   swarmResults?: Record<string, { text: string, agreement: number, members: number, rounds: number, failed: number }>,
 *   outrospectionMode?: boolean,
 *   outrospection?: { lens: string | null, items: number, texts: number, quotes: number, live: boolean },
 *   modelsMode?: boolean,
 *   account?: { enabled: import("./user-models.js").AcceptedModel[], checks: Record<string, Record<string, any>> } | null,
 *   modelCards?: { shown: number, total: number, query: string, enabled: number, verified: number },
 *   buildSlug?: string | null,
 *   userId?: string,
 *   buildResult?: { slug: string, url: string, files: number, bytes: number },
 *   feedbackCapture?: boolean,
 *   helpCommand?: boolean,
 *   feedback?: { comment: string, question: string | null, answer_excerpt: string | null, model: string, images?: { name: string | null, data: string }[], useCase?: { id: number, tag: string } | null, scope?: import("../public/js/feedback-core.js").FeedbackScope },
 * }} ChatRequestState
 */

/**
 * The opt-in enrichment context resolved per request (see
 * resolveEnrichmentOptions). `ext` is the whole extension state bag, built
 * by the registry (src/extensions.js) — this handler never looks inside it.
 * @typedef {Object} EnrichmentOptions
 * @property {Record<string, any>} ext
 * @property {string} chatMode the mode this request runs in (chat-mode-core.js)
 * @property {boolean} modesAvailable whether non-normal modes are available to this identity
 * @property {boolean} sourceOn whether the mode carries this site's own source
 * @property {boolean} modelIsVision
 * @property {string | null} visionModel
 * @property {string[]} visionModels
 * @property {import('./types.js').ImageLocation[]} imageLocations
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

  const { catalog, config, configOk, resolved } = await resolveChatModels(env, log, body, identity);
  if ("error" in resolved) return jsonResponse({ error: resolved.error }, resolved.status);
  const model = resolved.model;
  const jsonModel = resolveJsonModel(catalog, model);

  const quotaBlocked = await enforceQuotaGate(env, log, config, identity, configOk);
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
  // …and WHO runs those searches, set by the "Exa web search" knob in settings:
  // "exa" (the default), "cloudflare" (this Worker searches for itself), or ""
  // for the site-wide backend. Coerced to the allowlist here so nothing past
  // this line can route a search at an unvalidated target; the admin can pin
  // the site-wide choice with search.allow_user_choice = false.
  const searchSource = normalizeSearchSource(body.search_source);
  const enrich = resolveEnrichmentOptions(body, env, identity, catalog, model);

  // ---- slash commands (platform baseline, before any mode routing) --------
  //
  // Owner directive, 2026-07-26 (feedback #26): `/feedback` and `/help` are
  // available in EVERY agent. So they are resolved HERE, above the mode
  // dispatch, from the message text itself — no new request field, nothing for
  // a client to forget to send, and nothing an agent can decline. The server
  // re-derives the command with the same registry the composer offered
  // (src/slash.js → public/js/slash-core.js), so a hand-rolled request behaves
  // exactly like one typed into the app.
  //
  // The MCP channel builds its own state and never reaches this handler, so a
  // tool call that happens to start with a slash keeps being researched.
  const slashCmd = slashEffect(textOf(lastUserMessage(body.messages)?.content));
  // `/help` answers from the DOCUMENTATION — the help layer that already ships
  // inside introspection (src/introspect.js retrieveHelpDocs +
  // introspect-core.js buildHelpDocsBlock). It is gated on the modes being
  // AVAILABLE (a real account or the break-glass operator) and NOT on the
  // request's mode: typing `/help` is a user asking for the help layer in so
  // many words, from whichever mode they are in. Nothing new is exposed — the
  // docs corpus and the source snapshot are committed public artifacts, served
  // unauthenticated already (src/assets.js).
  const helpCommand = slashCmd === "help" && chatModesAvailable(env, identity);
  // ---- mode routing -------------------------------------------------------
  //
  // Which agent answers this request is DATA: the ordered `defaults` table in
  // sdk/AGENTS.json maps each chat mode to the agent that is that mode, names
  // the request flag selecting it, and its array order IS the precedence
  // (sdk > orchestrator > outrospection). `resolveRequestAgent` walks it and
  // enforces each agent's declared `capability.requires` — so "a client can't
  // acquire a capability the knob doesn't grant" is one rule applied uniformly
  // instead of a condition repeated per mode.
  //
  // Two deliberate limits:
  //  · Only the three EXECUTOR phases (build / workflow / feed) are taken from
  //    the registry. Whether a knob-on request is introspection or plain
  //    research stays where it has always been decided — the pipeline's
  //    hasSource + externalSourceIntent gate — because that is a per-MESSAGE
  //    decision, not a per-request one.
  //  · The registry is only loaded when routing could differ from a plain Deep
  //    Research turn (routingNeedsRegistry). It ships inside the multi-megabyte
  //    source snapshot; parsing it for a request that can only resolve to
  //    `normal` would be a regression on the commonest path.
  //
  // Fail-soft (invariant 2): an unreadable registry falls back to the
  // hand-written cascade below, which this table reproduces exactly (pinned in
  // public/js/agent-capability.test.js).
  // `developer_mode` is the GRANT NAME the agent specs declare
  // (`capability.requires` — sdk/AGENTS.json, a published data format), and what
  // it means is availability: may this identity use the non-normal modes at all.
  // It is deliberately NOT "the request is in a non-normal mode" — that is the
  // resolved mode's job, and conflating the two is exactly what the retired
  // knob did.
  const granted = {
    developer_mode: enrich.modesAvailable,
    sandbox: bashLiteEnabled(env, identity),
  };
  // An agent supplied INLINE with the request — a spec the caller wrote rather
  // than one this repo committed, which is what Agent Studio hands back when it
  // has just built one. Most specific of the routes, so it wins over an
  // addressed id and over every mode flag, and it needs no registry load at all.
  //
  // It is UNTRUSTED, so it goes through the boundary rather than through
  // `resolveCapability` directly: every validation rule runs (including the
  // invariant rules), and the knobs it needs are DERIVED from what it selects
  // rather than read from what it claims to require — a spec that selects the
  // build tools and declares `requires: []` is refused exactly as if it had
  // been honest. Its bounds and search policy are then narrowing-only like any
  // other agent's, so a valid inline spec can make its own run smaller and can
  // never make it larger.
  //
  // Fail-soft on refusal (invariant 2): the request is still answered, by the
  // agent it would have resolved to with no spec at all. The reasons go to the
  // log, not to a 400 — a chat turn is not the place to fail a build.
  const inline = resolveUntrustedAgent(body.agent_spec, granted);
  if (body.agent_spec && !inline.agent) {
    log.warn("agent_spec.refused", { problems: inline.problems.slice(0, 5) });
  }
  const routed = inline.agent
    ? { mode: inline.agent.mode || DEFAULT_CHAT_MODE, agent: inline.agent, capability: inline.capability, addressed: true }
    : routingNeedsRegistry(body, enrich.chatMode)
      ? resolveRequestAgent(await loadAgentRegistry(env), body, granted, enrich.chatMode)
      : null;
  const routedPhase = /** @type {string | null} */ (routed?.capability?.answerPhase ?? null);
  const byRegistry = routedPhase !== null;
  // Each mode below is simply "the resolved mode IS this one" — the mode was
  // already decided once, in resolveEnrichmentOptions, from the request field /
  // legacy flag / stored pick, with availability applied. The old form combined
  // a per-mode flag with the capability knob and a mutual-exclusion chain at
  // every site; one resolved value makes all of that unnecessary, and makes the
  // precedence readable in ONE place (chat-mode-core.js MODE_REQUEST_FLAGS).
  //
  // A SLASH COMMAND outranks all three (owner directive, 2026-07-26). `/feedback`
  // is a report to the developers and `/help` is a documentation question; both
  // mean the same thing in every agent, so none of the executor phases may claim
  // the turn. Forced off HERE rather than in the pipeline because
  // `answerPhaseFor` falls back to these booleans when the registry is
  // unavailable — leaving them set would reopen the hole on exactly the
  // fail-soft path (this is the bug feedback #26 reported from the user's seat:
  // typing feedback in Orchestrator planned a sub-agent team over it).
  const modeIs = (/** @type {string} */ m) => !slashCmd && enrich.chatMode === m;
  // SDK ("lovable") mode: the DistillSDK build flow.
  const sdkOn = byRegistry ? !slashCmd && routedPhase === "build" : modeIs("sdk");
  const buildSlug = sdkOn && buildSlugOk(body.build_slug) ? /** @type {string} */ (body.build_slug) : null;
  // Orchestrator mode: the sub-agent workflow flow.
  const orchOn = byRegistry ? !slashCmd && routedPhase === "workflow" : modeIs("orchestrator");
  // Outrospection mode: answer from the outward feed instead of the web or our
  // own source.
  const outroOn = byRegistry ? !slashCmd && routedPhase === "feed" : modeIs("outrospection");
  // The plain model answer, with no research phase at all. Reachable only by
  // ADDRESSING an agent that declares it (`body.agent`) — no mode selects it,
  // because it is not a chat mode. Without this a spec could declare
  // `answerPhase: "direct"` and be quietly answered by the research flow.
  // Cleared by a slash command like every other executor phase: the turn is no
  // longer the agent's.
  const directOn = !slashCmd && byRegistry && routedPhase === "direct";
  // Models mode: the agent whose subject is the models themselves
  // (src/models-agent.js) — explore every provider's catalog, evaluate against
  // the established checks, enable for every other agent. Unlike the modes
  // above it introduces NO executor — its answer phase is the ordinary research
  // one — so a registry route can never name it, and it loses to any mode that
  // DOES replace the flow (`directOn` being the only one the resolved mode
  // cannot already exclude, since it comes from an addressed agent).
  const modelsOn = modeIs("models") && !directOn;
  // The answer phase the pipeline dispatches on, and the agent it came from —
  // null when the registry was unavailable or not consulted, in which case the
  // pipeline falls back to the mode booleans above.
  //
  // An agent's phase is authoritative only for the phases that HAVE an executor
  // (pipeline.js ANSWER_PHASE_RUNNERS). An agent declaring `research` or
  // `source-research` resolves to null here on purpose: which of those two a
  // knob-on turn runs is a per-MESSAGE decision the pipeline's hasSource +
  // externalSourceIntent gate owns, and a per-request declaration must not
  // pre-empt it. The agent still governs that turn through its prompt set and
  // its capability, both carried below.
  const answerPhase = sdkOn || orchOn || outroOn || directOn ? routedPhase : null;
  // The agent that answered, recorded for every routed request rather than only
  // the dispatched phases — an addressed research agent is still the agent that
  // answered, and the chat log should say so.
  const agentId = routed ? String(routed.agent?.id || "") : null;
  // The resolved agent's PROMPT SET (capability.prompts, else its phase's
  // default). Carried for every routed request — not only the executor phases —
  // because introspection and research choose their phase per message, and
  // whichever they choose should speak in the voice its agent declared.
  // …and NOT for a slash command, for the same reason its executor phase is
  // cleared: the turn is no longer that agent's. Carrying the set would answer
  // a `/help` typed in Orchestrator with the workflow set's planner and merge
  // prompts (or Agent Studio's build prompt), since phasePrompt prefers the
  // request's set over the phase's default whenever it fills the role.
  const promptSet = routed && !slashCmd ? resolvePromptSet(routed.agent) : null;
  // The agent's whole RESOLVED capability, carried for every routed request.
  // Until this landed only three of its fields ever reached a run (the phase,
  // the agent id, the prompt set) and the rest were pinned to constants by
  // tests — declared but never read. The pipeline now reads bounds, search
  // policy and tool classes off this, each NARROWING against the platform's own
  // limit (agent-spec-core capBound / capSearch), so a shipped agent's
  // declaration reproduces today's behaviour exactly and cannot exceed it.
  // Null whenever the registry was not consulted or could not be read, which
  // every reader treats as "use the constant" (invariant 2) — and null for a
  // slash command, on the same reasoning as the prompt set just above: a `/help`
  // turn should not inherit the bounds or the search ceiling of the agent whose
  // composer it happened to be typed into.
  const capability = routed && !slashCmd ? routed.capability ?? null : null;
  // The experimental bash-lite sandbox transcript: the browser ran an agentic
  // shell loop (public/js/bash-agent.js) before sending, and attached what it
  // ran + the real output. Honored only when this account's knob is on
  // (defense: a client can't smuggle a transcript in with the feature off);
  // folded into the answer as ground truth by the pipeline (ctx.shellBlock).
  const shellTranscript = bashLiteEnabled(env, identity) ? resolveShellTranscript(body.shell_transcript) : [];
  // The Orchestrator's client-hosted SWARM (public/js/swarm-runtime.js): this
  // browser can run tiny on-device models, so it asked /api/orchestrator/plan
  // for the team first, ran the `swarm` nodes locally, and attached the plan
  // plus their briefs here. Honored only in orchestrator mode (a client can't
  // smuggle a pre-made workflow into an ordinary request), and re-normalized
  // by the executor — the plan is model output that took a detour through the
  // browser, not a client instruction.
  const swarm = orchOn ? normalizeSwarmCapability(body.swarm) : null;
  const orchWorkflow = orchOn && body.workflow && typeof body.workflow === "object" ? body.workflow : null;
  const swarmResults = orchOn ? resolveSwarmResults(body.swarm_results) : {};

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
    const state = newRequestState(model, jsonModel, webSearchEnabled, budgetS, {
      searchSource,
      ext: enrich.ext,
      // The site's own source as context. Every non-normal mode carries it
      // (chat-mode-core.js modeCarriesSource states why); `/help` turns it on
      // for THIS request even in Normal — that is how the command reaches the
      // shipped help layer (docs corpus first, source as the deeper level) from
      // any mode. Everything else about the enrichment is unchanged.
      introspection: enrich.sourceOn || helpCommand,
      vision: enrich.modelIsVision,
      visionModel: enrich.visionModel,
      visionModels: enrich.visionModels,
      imageLocations: enrich.imageLocations,
      shellTranscript,
      sandboxEnabled: bashLiteEnabled(env, identity),
      sdkMode: sdkOn,
      orchestratorMode: orchOn,
      swarm,
      orchWorkflow,
      swarmResults,
      outrospectionMode: outroOn,
      modelsMode: modelsOn,
      // The account's lifecycle state — what it enabled and what it verified —
      // resolved ONCE here. The pipeline deliberately carries no identity (it
      // would ride into chat_logs), so the enrichment gets exactly the two maps
      // the catalog needs and nothing else.
      account: modelsOn ? accountModels(identity) : null,
      answerPhase,
      agentId,
      promptSet,
      capability,
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
    // …and the `/help` command's routing hint: the pipeline's source-research
    // gate honors it over externalSourceIntent, so an explicitly-asked help
    // question is answered from the documentation rather than handed back to
    // the web-search wave.
    state.helpCommand = helpCommand;

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
    // The RESEARCH TRAIL, captured off the same funnel every event already
    // goes through. Parked with the answer so a run whose stream dropped
    // comes back explorable rather than as bare prose — feedback #67 ("i
    // cannot explorre the research steps taken here in the response as i used
    // to"), filed on a 244-second run from a phone. Bounded: a long run emits
    // hundreds of events and this is a D1 column, not a log.
    /** @type {any[]} */
    const trail = [];
    const TRAIL_TYPES = new Set(["step_start", "step_done", "search_start", "search_done"]);
    const TRAIL_MAX = 400;

    /** @param {any} obj one SSE event object */
    const emit = (obj) => {
      const chunk = obj.choices?.[0]?.delta?.content;
      if (chunk) answer.text += chunk;
      else if (obj.status?.type === "discard_text") answer.text = "";
      if (obj.status && TRAIL_TYPES.has(obj.status.type) && trail.length < TRAIL_MAX) {
        trail.push(obj.status);
      }
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
        named_urls: state.namedUrlCount || 0,
        sources: state.sources.length,
        // Whatever the registered extensions contributed this request — the
        // keys are theirs, not this handler's (src/extensions.js logMeta).
        ...extensionLogMeta(state),
        introspection: state.introspectionCount,
        sdk: sdkOn,
        duration_ms,
        client_gone: disconnect.gone,
        incognito,
      });
      // Usage accounting for quotas (fails soft; never breaks the stream).
      const { prompt_tokens, completion_tokens, berget_cost } = summarizeSpend(state, catalog);
      const exa_cost = exaCost(state, config, billedSearches);
      // The search wave's hosted-index spend (src/billing.js): the reranker and
      // the embedder are Berget money like any other, they just are not chat
      // models, so they are priced from the raw catalog and added here rather
      // than inside summarizeSpend. Never throws, and a request that ran no
      // dense retrieval returns all zeroes and adds nothing — so a run without
      // it records exactly what it recorded before this existed.
      const dense = await denseSpend(env, log, state);
      await recordUsage(env, log, {
        user_id: identity.id,
        model,
        // The dense tokens ride the same row: its berget_cost includes them, and
        // a row whose cost exceeds what its tokens explain is a row nobody can
        // reconcile. `model` still names the answer model — one row per request
        // is what every quota and cost view counts, and the per-model split is
        // the by_model rows below.
        prompt_tokens: prompt_tokens + dense.prompt_tokens,
        completion_tokens,
        // Exa's own count, deliberately — a dense leg buys no Exa search
        // (src/billing.js, the COUNT DIMENSION note).
        searches: billedSearches,
        berget_cost: berget_cost + dense.berget_cost,
        exa_cost,
        duration_ms,
      });
      // Per-model attribution ledger (usage_model_events) — the "tell what a
      // user's budget went to" half. Separate + fail-soft; never disturbs the
      // enforcement row above. Pair with the row's exa_cost for search vs LLM.
      await recordModelUsage(env, log, {
        user_id: identity.id,
        request_id: requestId,
        // …plus one row per retrieval model that ran (rerank / embed), so the
        // "what did my budget go to" view can tell an expensive answer model
        // from a literature-heavy turn. Empty when no dense tier ran.
        by_model: [...spendByModel(state, catalog), ...dense.by_model],
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
            // Which search source the user picked ("" = the site default) — a
            // debugging answer to "why did this research read thin?" now that
            // more than one thing can run the searches. Undefined when unset,
            // so JSON.stringify drops it and an ordinary row is unchanged.
            search_source: searchSource || undefined,
            // The slash command this turn was, if any ("feedback" / "help") —
            // so a chatlogs scan can answer "is anyone using them, and did the
            // command actually take the turn away from the picked mode?".
            // Undefined (dropped from the row) for an ordinary message.
            slash: slashCmd || undefined,
            queries: [...state.ranQueries],
            sources: state.sources.map((s) => ({ n: s.n, title: s.title, url: s.url })),
            // How many of those sources the synthesis digest could actually
            // carry. The row above lists every source COLLECTED, which is not
            // the same number and was silently assumed to be — feedback #61
            // needed a source-list diff to establish that the answer had been
            // written from 15 of 35 while the reader was shown all 35 beneath
            // it. Undefined (and dropped) on a turn that never synthesized.
            digest_shown: /** @type {any} */ (state).digestShown,
            complexity: state.complexity,
            subquestions: state.subquestions,
            conflicts: state.conflicts,
            // The deterministic citation reconciliation and the phase-5
            // verdict (pipeline.js). Both are undefined on a turn that never
            // synthesized/validated, and JSON.stringify drops undefined keys —
            // so an ordinary row is byte-identical to before these existed,
            // the same convention `digest_shown` above relies on. Without
            // them, the dangling-citation rate and the revise rate are not
            // recoverable from anywhere: the revised answer replaces the draft
            // before the row is written.
            citations: /** @type {any} */ (state).citations,
            validation: /** @type {any} */ (state).validation,
            // The registered extensions' own meta (counters, routing traces).
            // Keys with an undefined value are dropped by JSON.stringify —
            // that is how an extension that never ran stays absent from the
            // row rather than logging a zero it can't vouch for.
            ...extensionLogMeta(state),
            // 1 when developer mode's introspection enrichment folded the
            // source snapshot into this exchange (src/introspect.js).
            introspection: state.introspectionCount,
            // SDK mode: `sdk` is 1 when this request ran the SDK build flow
            // (distill a flavour from this site); `build` is the published
            // result ({slug, url, files, bytes} — pipeline.js runSdkBuild),
            // dropped when nothing was published.
            sdk: sdkOn ? 1 : 0,
            build: /** @type {any} */ (state).buildResult,
            // Orchestrator mode: 1 when this request ran the sub-agent
            // workflow flow; `orchestration` is the run's shape
            // ({agents, waves, failed, searches} — orchestrator.js),
            // dropped (undefined) when the mode didn't run.
            orchestrator: orchOn ? 1 : 0,
            orchestration: /** @type {any} */ (state).orchestration,
            // Outrospection mode: 1 when this request answered from the
            // outward feed; `outrospection` is what it retrieved
            // ({lens, items, live} — outrospect.js), dropped (undefined) when
            // the mode didn't run. `items: 0` is the signal worth grepping —
            // the feed had nothing to answer from.
            outrospection_mode: outroOn ? 1 : 0,
            outrospection: /** @type {any} */ (state).outrospection,
            // Models mode: 1 when this request ran the model-lifecycle agent,
            // with `model_cards` ({shown, total, query, enabled, verified})
            // present only when the message was about models and the catalog
            // answered — grep `total: 0` for turns where every provider was
            // unreachable.
            models_mode: modelsOn ? 1 : 0,
            model_cards: /** @type {any} */ (state).modelCards,
            cached_searches: state.cachedSearchCount || 0,
            named_urls: state.namedUrlCount || 0,
            // The starter this conversation opened from, as its `#XP-07` tag
            // (pipeline.js reads it off the first message; the tag itself is
            // stripped before any model call). Present only for evaluation-mode
            // chips, which are the only surface that sends one — so a chatlogs
            // scan can tell a reviewed starter's run from ordinary traffic.
            starter: /** @type {any} */ (state).starterRef?.tag,
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
      // ACCOUNT MEMORY (src/memory.js): distil this finished turn into the
      // account's durable note graph. Runs LAST and entirely off the answer's
      // critical path — the reply has already streamed — and it is fail-soft
      // inside runMemoryExtraction, so a memory that fails to learn changes
      // nothing about what the user received (invariant 2). One JSON call on
      // the fixed jsonModel, no tools (invariants 1 and 3), and it is skipped
      // whole for an incognito turn: the ghost promise has to cover a record
      // that outlives the chat-log row it already covers.
      if (memoryEnabled(env, identity) && !incognito) {
        await runMemoryExtraction({
          env,
          log,
          identity,
          incognito,
          enabled: true,
          question: lastUserText(conversation),
          answer: answer.text,
          jsonPhase: ({ system, user, maxTokens }) =>
            completeJson(
              env,
              [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              { model: jsonModel, maxTokens },
            ),
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
        // A use-case reference ("feedback #UC-34 …", pipeline.js
        // runFeedbackCapture) tags the entry with its use case for discovery.
        const useCase = state.feedback.useCase || null;
        // SCOPE (pipeline.js runFeedbackCapture → feedback-core feedbackScope):
        // a feedback message that OPENED the conversation is generic developer
        // feedback — a suggestion or next-steps note — not a report about a
        // research session. Tagged on the entry so the queue reads it as such,
        // and the debugging context below skips the pointless one-turn
        // "transcript" (buildFeedbackDebugContext).
        const scope = state.feedback.scope === "standalone" ? "standalone" : "session";
        try {
          // A follow-up feedback message in a conversation that already holds
          // an earlier one THREADS onto that entry (feedback.js
          // createOrThreadFeedbackEntry) instead of opening a disconnected
          // report — the "connected to a previously existing feedback
          // message" behavior (entries #8/#9, 2026-07-24).
          const cap = await createOrThreadFeedbackEntry(await getDb(env), String(identity.id), {
            comment: state.feedback.comment,
            question: state.feedback.question,
            answer_excerpt: state.feedback.answer_excerpt,
            model,
            page: useCase ? `usecase ${useCase.tag}` : feedbackPageTag("chat", scope),
            // Screenshots from the chat message (pipeline.js
            // feedbackImagesFromParts) — without these the attached image was
            // silently lost (feedback #12).
            images: state.feedback.images || [],
            // The ENTIRE conversation + request metadata, verbatim (owner
            // directive, 2026-07-24) — complete debugging context on the
            // entry itself, present even for incognito conversations where
            // no chat_logs row exists.
            context: buildFeedbackDebugContext(conversation, {
              request_id: requestId,
              model,
              json_model: jsonModel,
              incognito,
              web_search: webSearchEnabled,
              sdk_mode: sdkOn,
              chat_mode: enrich.chatMode,
              use_case: useCase ? useCase.tag : undefined,
              // The starter prompt this conversation opened from (feedback
              // #37). Stated as its own line rather than left to be read out
              // of turn 1: a long conversation's transcript is trimmed from
              // the FRONT (feedback.js), which is exactly where the tag sits.
              starter: /** @type {any} */ (state).starterRef?.tag,
              client_diag: sanitizeClientDiag(body.client_diag) || undefined,
            }),
          }, conversation);
          if (cap) log.info("feedback.captured", { user_id: identity.id, feedback_id: cap.id, threaded: cap.threaded, request_id: requestId });
        } catch (err) {
          log.warn("feedback.capture_failed", {
            user_id: identity.id,
            error: /** @type {any} */ (err)?.message || String(err),
          });
        }
        // Use-case feedback ALSO lands on the referenced test point's thread —
        // "as if answered in the list of use cases" — so the owner never
        // reopens the try-it queue. Admin-only (the test-point surface is
        // owner-only) and fail-soft.
        if (useCase && (identity.isSecretAdmin || identity.role === "admin")) {
          try {
            const db = await getDb(env);
            const rec = db ? await recordUseCaseFeedback(db, useCase.id, state.feedback.comment) : null;
            log.info("feedback.usecase", {
              user_id: identity.id,
              use_case: useCase.id,
              recorded: !!(rec && rec.ok),
              reopened: rec && rec.ok ? rec.reopened : false,
            });
          } catch (err) {
            log.warn("feedback.usecase_failed", {
              user_id: identity.id,
              use_case: useCase.id,
              error: /** @type {any} */ (err)?.message || String(err),
            });
          }
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
      await saveAnswer(env, log, requestId, identity.id, answer.text, stats, trail);
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
 * @param {Identity} [identity] the signed-in account, so its per-account models
 *   (the accepted open-catalog ones) are valid answer models here too
 * @returns {Promise<{ catalog: ModelCatalog | null, config: SiteConfig,
 *   configOk: boolean, resolved: ReturnType<typeof resolveModel> }>}
 */
async function resolveChatModels(env, log, body, identity) {
  /** @type {ModelCatalog | null} */
  let catalog = null;
  try {
    catalog = await listChatModels(env, identity);
  } catch (err) {
    log.warn("chat.model_catalog_unavailable", { error: /** @type {any} */ (err)?.message || String(err) });
  }
  // getConfig reads D1 (and runs the lazy migration on the first call), so an
  // errored database throws HERE, before any gate — which used to escape the
  // handler and 500 the chat. The config has a defined "no database" fallback,
  // so the request can still be SHAPED against it (model choice, budget clamp);
  // what must NOT happen is the quota gate reading defaults as permission when
  // an admin may have lowered the real limits. So the failure travels with the
  // config as `configOk: false`, and enforceQuotaGate below turns it into a
  // clean refusal.
  /** @type {SiteConfig} */
  let config;
  let configOk = true;
  try {
    config = await getConfig(env);
  } catch (err) {
    log.warn("chat.config_unavailable", { error: /** @type {any} */ (err)?.message || String(err) });
    config = structuredClone(DEFAULT_CONFIG);
    configOk = false;
  }
  // The admin can set a site default model; it only applies when valid & up.
  if (!body.model && adminDefaultModelValid(config, catalog)) {
    body.model = config.default_model;
  }
  return { catalog, config, configOk, resolved: resolveModel(body, catalog, env, log) };
}

/**
 * The research-quota gate (Berget budget + Exa searches per 5h/day/week/
 * month windows). ADMINS ARE NEVER BLOCKED: their usage is recorded and
 * their bars keep counting (past 100%), but the 429 applies to regular
 * users only.
 *
 * FAILS CLOSED when the decision cannot be made — an errored D1 while reading
 * the site config or this user's usage windows answers 503, not a 500 and not
 * a silent pass. The reasoning (and why the concurrency reservation taken just
 * after this one deliberately fails the OTHER way) is written out above
 * QUOTA_UNAVAILABLE_STATUS in quota.js. A site with no database at all is
 * untouched: nothing throws there, so nothing is refused.
 * @param {Env} env
 * @param {Logger} log
 * @param {SiteConfig} config
 * @param {Identity} identity
 * @param {boolean} [configOk] false when `config` is the degraded fallback
 *   rather than this site's real settings (resolveChatModels)
 * @returns {Promise<Response | null>} the 429/503 response, or null to proceed
 */
async function enforceQuotaGate(env, log, config, identity, configOk = true) {
  // Admins first, so an exempt caller needs no usage read at all and cannot be
  // refused by one that fails (same early return /mcp's researchQuotaBlock has).
  if (identity.isSecretAdmin || identity.role === "admin") return null;
  if (!configOk) {
    log.warn("chat.quota_unverifiable", { user_id: identity.id, reason: "config" });
    return jsonResponse(quotaUnavailableResponse(), QUOTA_UNAVAILABLE_STATUS);
  }
  const quota = effectiveQuota(config, identity.user);
  // Nothing enforced anywhere → nothing to verify, so no usage read and no way
  // for an unreadable one to refuse a request no limit would have stopped.
  if (!quota || !quotaEnforced(quota)) return null;
  /** @type {import('./quota.js').Usage} */
  let usage;
  try {
    usage = await getUsage(env, identity.id, Date.now(), identity.user?.quota_reset_at);
  } catch (err) {
    log.warn("chat.quota_unverifiable", {
      user_id: identity.id,
      reason: "usage",
      error: /** @type {any} */ (err)?.message || String(err),
    });
    return jsonResponse(quotaUnavailableResponse(), QUOTA_UNAVAILABLE_STATUS);
  }
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
 * - EXTENSIONS (the registered third-party integrations — src/extensions.js)
 *   are per-user settings knobs, not request flags. This handler asks
 *   settings.js which of them are on for this identity and hands the body to
 *   the registry, which returns the whole `state.ext` bag: one namespaced
 *   slice per extension, each already holding whatever that extension needs
 *   to read off the body (its own validated fields — this module has no
 *   opinion on what those are, and does not know which extensions exist).
 * - Vision capability of the CHOSEN answer model decides whether fetched
 *   imagery is attached for the model to describe (only vision models can
 *   receive it). For a non-vision answer model, a RANKED list of vision
 *   helper models describes the imagery instead — a list, not a single pick,
 *   because the describe call was observed (2026-07-08, describe_failed "The
 *   operation was aborted") timing out on a loaded Mistral Medium while
 *   other vision models answered instantly; a one-model helper goes blind
 *   exactly when the backend is busiest. This is why "describe this street
 *   view" works regardless of model choice.
 * @param {ChatRequestBody} body
 * @param {Env} env
 * @param {Identity} identity
 * @param {ModelCatalog | null} catalog
 * @param {string} model the resolved answer model
 * @returns {EnrichmentOptions}
 */
function resolveEnrichmentOptions(body, env, identity, catalog, model) {
  // WHICH MODE this request runs in — one resolution, shared with both tiers
  // (chat-mode-core.js resolveBodyChatMode). It reads the explicit `chat_mode`
  // field, then the per-mode legacy flags, then the account's stored pick, and
  // it can never return a non-normal mode to an identity the modes are
  // unavailable to. `developer_mode: false` still forces normal — the off-only
  // override (the incognito pattern: a client may DECLINE a capability it
  // holds, never acquire one it doesn't) the eval harnesses depend on.
  //
  // Everything downstream is DERIVED from this one value: which answer phase
  // runs, whether the site's own source is injected, what the log records.
  const modesAvailable = chatModesAvailable(env, identity);
  const chatMode = resolveBodyChatMode(body, {
    available: modesAvailable,
    stored: storedChatMode(identity),
  });
  const modelIsVision = !!catalog?.find((m) => m.id === model)?.vision;
  const visionCandidates = catalog?.filter((m) => m.vision && m.up).map((m) => m.id) || [];
  const visionModels = (modelIsVision
    ? [model, ...visionCandidates.filter((id) => id !== model)]
    : visionCandidates
  ).slice(0, 3);
  return {
    ext: resolveExtensionState(body, extensionEnabledMap(env, identity)),
    chatMode,
    modesAvailable,
    sourceOn: modeCarriesSource(chatMode),
    modelIsVision,
    visionModels,
    visionModel: visionModels[0] || null,
    imageLocations: validateImageLocations(body.imageLocations),
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
 * @param {Partial<EnrichmentOptions> & { searchSource?: string, vision?: boolean, introspection?: boolean, sandboxEnabled?: boolean, sdkMode?: boolean, orchestratorMode?: boolean, swarm?: any, orchWorkflow?: any, swarmResults?: any, outrospectionMode?: boolean, modelsMode?: boolean, account?: any, answerPhase?: string | null, agentId?: string | null, promptSet?: string | null, capability?: any, buildSlug?: string | null, userId?: string, shellTranscript?: Array<{ command: string, exitCode: number, stdout: string, stderr: string }> }} [extras]
 * @returns {ChatRequestState}
 */
function newRequestState(model, jsonModel, webSearch, budgetS, extras = {}) {
  return {
    startedAt: Date.now(),
    model,
    jsonModel, // fixed model for the JSON planning phases (see resolveJsonModel)
    webSearch,
    // WHO runs this request's searches (websearch-backends.js
    // resolveSearchBackend): "" = the site's configured backend.
    searchSource: extras.searchSource || "",
    // The EXTENSION state bag: one namespaced slice per registered
    // third-party integration (src/extensions.js), already resolved from the
    // request body. Core reads nothing inside it — an extension's runner and
    // its logMeta hook are the only code that does, which is what keeps the
    // pipeline's state free of any individual service's vocabulary.
    ext: extras.ext || resolveExtensionState({}),
    // Developer mode's introspection enrichment (src/introspect.js): the gate
    // is the knob; whether the conversation actually engages the mode is the
    // enrichment's own (deterministic) decision.
    introspection: !!extras.introspection,
    introspectionCount: 0, // 1 when the source snapshot was folded in
    vision: !!extras.vision, // chosen answer model supports image input
    visionModel: extras.visionModel || null, // helper model to describe imagery for a non-vision answer model
    // Ranked describe-helper candidates (first = visionModel); the describe
    // fails over down this list when a model times out under load.
    visionModels: extras.visionModels || (extras.visionModel ? [extras.visionModel] : []),
    // Tokens for the vision-describe helper — its own model, so
    // billed at its own catalog rate (like jsonTotals), summed for the counters.
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    imageLocations: extras.imageLocations || [], // validated attached-photo GPS coords
    // The bash-lite sandbox transcript (resolveShellTranscript): commands the
    // browser ran client-side and their real output, folded into the answer
    // as ground truth (pipeline.js ctx.shellBlock). Empty unless the
    // experimental knob is on AND the client attached one.
    shellTranscript: extras.shellTranscript || [],
    // Whether the bash-lite sandbox knob is on for this account: with dev
    // mode also on, the client mounts the source tree at /src in the VM, so
    // the introspection block may point the model there (src/introspect.js).
    sandboxEnabled: !!extras.sandboxEnabled,
    // SDK ("lovable") mode — pipeline.js runSdkBuild: the DistillSDK build flow
    // that distills a flavour from this site (above all the Se/cure tier).
    // buildSlug is the conversation's already-published build (an iteration
    // keeps the /app/<slug>/ URL stable); userId is the publisher recorded as
    // the build's owner (slug-reuse authorization).
    sdkMode: !!extras.sdkMode,
    // Orchestrator mode — pipeline.js routes to orchestrator.js
    // runOrchestration: a JSON-planned sub-agent workflow replaces the
    // normal research flow for this request.
    orchestratorMode: !!extras.orchestratorMode,
    // The client-hosted SWARM (orchestrator mode only): `swarm` is what this
    // browser can run on-device (presence enables the `swarm` node kind),
    // `orchWorkflow` is the plan it already fetched from
    // /api/orchestrator/plan (re-normalized by the executor before use), and
    // `swarmResults` holds the briefs its on-device members produced. All
    // three absent = the ordinary server-planned orchestration.
    swarm: extras.swarm || null,
    orchWorkflow: extras.orchWorkflow || null,
    swarmResults: extras.swarmResults || {},
    // Outrospection mode — pipeline.js routes to outrospect.js
    // runOutrospection: the outward feed replaces both the web research and
    // the own-source retrieval for this request.
    outrospectionMode: !!extras.outrospectionMode,
    // Models mode — src/models-agent.js runModelsAgentEnrichment: hub search is
    // forced on for the turn, and a message about models gets the live
    // cross-provider catalog folded in, priced and annotated with what has been
    // verified. No executor: the answer phase stays `research`.
    modelsMode: !!extras.modelsMode,
    account: extras.account || null,
    // The registry-resolved answer phase and the agent it came from
    // (sdk/AGENTS.json `defaults` → capability.answerPhase). This is what
    // pipeline.js dispatches on; the three booleans above are its fail-soft
    // fallback for a deployment whose registry could not be read, and for the
    // MCP channel, which builds its state without any of them.
    answerPhase: extras.answerPhase || null,
    agentId: extras.agentId || null,
    // The prompt set every phase of this request speaks in (src/prompt-sets.js
    // phasePrompt). Null falls back to the executing phase's default set, which
    // is what every shipped agent declares anyway.
    promptSet: extras.promptSet || null,
    // The resolved capability of the agent answering this request, or null when
    // no registry was consulted (the MCP channel, which has no concept of an
    // agent, or an unreadable snapshot). Read through the
    // narrowing accessors in agent-spec-core.js — never destructured directly —
    // so every consumer keeps the platform constant as both its default and its
    // ceiling.
    capability: extras.capability || null,
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
    namedUrlCount: 0, // pages read directly because the message named their URL
    iterations: 1, // search waves (initial + gap rounds that ran)
    ranQueries: new Set(),
    // Queries actually DISPATCHED, as opposed to ranQueries' planned set. The
    // two diverge whenever a wave's web leg stands down (knob off, or an aux
    // source leading), and only this one may be shown to the answer model.
    issuedQueries: new Set(),
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
    // The hosted arXiv/PubMed retrieval tiers' provider spend (src/dense-rag.js),
    // accumulated across every leg the search wave runs. Not a chat model, so it
    // is priced from Berget's RAW catalog at the end of the request rather than
    // by summarizeSpend's catalog lookup — src/billing.js denseSpend.
    denseTotals: newRetrievalSpend(),
  };
}
