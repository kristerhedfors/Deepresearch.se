// @ts-check
// The deep-research pipeline. The Worker orchestrates every phase directly
// (no function calling), so the flow is deterministic and works on any
// JSON-mode model:
//
//   1. Triage (JSON): direct reply | one clarifying question | research plan
//      with multi-angle queries (count set by the time-budget planner).
//   2. Search wave: run the planned queries via Exa (deduped, capped).
//   3. Gap check (JSON, rounds set by the planner): audit coverage; run
//      follow-up queries for the most important gaps.
//   4. Synthesis: stream a source-grounded answer with [n] citations and a
//      Sources list, built ONLY from the numbered source registry.
//   5. Post-validation (JSON): fact-check the draft against the sources; on
//      "revise", tell the UI to discard the draft (discard_text) and emit
//      the corrected answer.
//
// Helper phases fail soft: if triage / gap check / validation error or
// return unparseable JSON, the pipeline degrades (single search, skip
// iteration, accept draft) rather than failing the request.
//
// Status events emitted to the UI are documented in src/types.d.ts
// (SseEvent) and the sse-protocol skill. Each phase below is its own
// function, all sharing one `ctx` object built once in runPipeline() —
// everything a phase needs to read (env, model, per-request state, the
// resolved model-profiles.js overrides, the conversation) plus the three
// UI-emit helpers (emitDelta/step/stepDone), so phase functions take just
// ctx plus whatever's specific to that call, instead of a long parameter
// list.
//
// This module owns the phase FLOW only. The pieces with lives of their
// own are split out: the source registry (dedup, domain-diversity cap,
// digest) in sources.js, the auxiliary search-source registry (HF Hub &
// co, iterated by runAuxSearches below) in search-sources.js, the
// opt-in pre-pipeline context enrichments in enrichment.js (whose
// third-party integrations are registered — and named — only in
// extensions.js), the JSON-phase schemas + triage normalization/fallback
// in triage.js, and the answer-streaming internals (retry loop, model
// failover, chunked emit) in answer-stream.js.

import { emitChunked, streamCompletion } from "./answer-stream.js";
import { buildShellTranscript } from "./bash-agent.js";
import { completeJson } from "./providers.js";
import {
  applyComplexityToPlan,
  fitsDeadline,
  recordPhase,
  wantsClaimValidation,
  wantsFullContent,
  wantsGapStrive,
  wantsNotes,
  wantsSubqFanout,
} from "./budget.js";
import {
  formatConversation,
  imagePartsOf,
  lastAssistantText,
  lastUserMessage,
  previousUserText,
  starterRefOf,
  textOf,
  withAppendedText,
  withImageNudge,
  withoutMethodBlocks,
  withoutStarterTags,
} from "./conversation.js";
import { runEnrichments } from "./enrichment.js";
import { focusQueriesOnSubject } from "./query-focus.js";
import { fetchContents, webSearch } from "./exa.js";
import { extractNamedUrls, readNamedUrls } from "./named-urls.js";
import { SEARCH_SOURCES, capabilityAllowsSource, leadSourceIds } from "./search-sources.js";
// Folds a source's reported dense-retrieval spend into the request's tally —
// the one thing the orchestrator does with it; pricing is billing.js's.
import { mergeRetrievalSpend } from "./dense-rag.js";
import { getModelProfile } from "./model-profiles.js";
import { addUsage } from "./quota.js";
import { citationAudit, citationNote } from "./citations.js";
import {
  addSources,
  backfillOverflowSources,
  digestShownCount,
  sourceDigest,
  sourceProgress,
} from "./sources.js";
import { extractNotes, mergeNotes, notesEntities } from "./notes.js";
import {
  auxReplyMessages,
  buildContinuationTurns,
  collectConflicts,
  conflictsSection,
  extractClaims,
  mergeFanoutQueries,
  notesSection,
  searchLedgerSection,
  sdkCutOffNote,
  sdkReplyTail,
  shellReplyMessages,
  subquestionsSection,
  takeSearchBatch,
} from "./pipeline-inputs.js";
import {
  CLAIM_VERIFY_SCHEMA,
  GAP_SCHEMA,
  REVISE_SCHEMA,
  TRIAGE_SCHEMA,
  VALIDATE_SCHEMA,
  hardenJson,
  looksLikeClarifyTurn,
  normalizeTriage,
} from "./triage.js";
import {
  claimExtractionPrompt,
  claimVerifyPrompt,
  gapPrompt,
  notesPrompt,
  quizPrompt,
  revisePrompt,
  triagePrompt,
  validatePrompt,
} from "./prompts.js";
import { phasePrompt } from "./prompt-sets.js";
import { capBound, capSearch } from "./agent-spec.js";
import { toolsForRun } from "./tool-sets.js";
import { runOrchestration } from "./orchestrator.js";
import { runOutrospection } from "./outrospect.js";
import { spaceIntent, sceneById } from "./space.js";
import { demoIntent } from "./demos.js";
import { anthropicConfigured, anthropicToolRun, isAnthropicModel } from "./anthropic.js";
import { runIntrospectionTool } from "./introspect-tools.js";
import {
  BUILD_TOOL_NAMES,
  SDK_TOOL_NAMES,
  buildFilesSummary,
  buildSdkContextBlock,
  buildSecureSourceDigest,
  findUnterminatedFileBlock,
  makeFileLineScanner,
  buildTargetFor,
  manifestFromSnapshot,
  mergeContinuation,
  parseFileBlocks,
  runSdkTool,
  sdkToolStepHeadline,
  snapshotFileCheck,
  stageBuildFile,
  stripFileBlocks,
} from "./sdk-tools.js";
import { publishBuild } from "./build-pub.js";
// The Agent SDK's definition core — Agent Studio's method when the ask is ONE
// agent (feedback #41). Read out of the SAME snapshot the build already loaded,
// so what the model designs against is by construction the deployed registry.
import { agentsFromSnapshot, buildAgentSdkDigest } from "../public/js/agent-spec-core.js";
import { feedbackRequested, feedbackComment, buildFeedbackContext, cannedFeedbackAck, feedbackImagesFromParts, feedbackScope } from "./feedback.js";
import { parseUseCaseRef } from "./testpoints.js";
import { loadSourceSnapshot } from "./introspect.js";
import { DEFAULT_QUIZ_QUESTIONS, normalizeQuiz, quizIntent, quizQuestionCount } from "./quiz.js";
import {
  MAX_FILES_PER_ROUND,
  MAX_SOURCE_READ_ROUNDS,
  backReferenceIntent,
  buildSourceResearchBlock,
  buildSourceSitemap,
  buildSourceStepMessage,
  externalSourceIntent,
  readSnapshotFiles,
  resolveReferencedPaths,
  runSourceReadLoop,
  toolResultLines,
  toolStepHeadline,
} from "../public/js/introspect-core.js";

// ---- shared shapes -------------------------------------------------------

/** @typedef {import('./pipeline-inputs.js').Claim} Claim */
/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./types.js').Conversation} Conversation */
/** @typedef {import('./types.js').ModelProfile} ModelProfile */
/** @typedef {import('./budget.js').BudgetPlan} BudgetPlan */

/**
 * Per-request bookkeeping for one auxiliary search source
 * (state.aux[sourceId]): searches run, attempt keys consumed across waves,
 * and whether the registry-capacity reserve was already granted.
 * @typedef {{ count: number, ran: Set<string>, reserved?: boolean }} AuxSourceState
 */

/**
 * The per-request state chat.js/mcp.js build (base shape documented as
 * import('./types.js').RequestState) plus the fields the pipeline itself
 * lays down as phases run. `plan` is re-declared against budget.js's own
 * typedef, whose `estimates` also carries the budget-gated phases.
 *
 * The three aux-search CONTROL fields an enrichment writes (`forceAux`,
 * `auxOnly`, `auxMaxPerRequest`) are declared on RequestState itself, so the
 * writers and these readers are checked against ONE declaration — they used to
 * be declared nowhere and reached through `any` casts on both sides. What
 * belongs here is only the latch the orchestrator lays down itself:
 * `auxLeadReleased`, set by runSearches when a leading source found nothing,
 * after which the request is an ordinary one.
 * @typedef {import('./types.js').RequestState & {
 *   plan: BudgetPlan,
 *   quizzes?: boolean,
 *   quiz?: object,
 *   complexity?: string | null,
 *   subquestions?: string[],
 *   decomposition?: string | null,
 *   conflicts?: string[],
 *   notes?: object[],
 *   notesCursor?: number,
 *   fetchedUrls?: Set<string>,
 *   aux?: Record<string, AuxSourceState>,
 *   auxLeadReleased?: boolean,
 *   citations?: { cited: number, dangling: number, unused: number },
 *   validation?: { verdict: string, issues: number, draft_chars: number, revised_chars: number },
 *   failoverModel?: string,
 *   feedbackCapture?: boolean,
 *   capability?: import('./agent-spec.js').AgentCapability | null,
 *   answerPhase?: string | null,
 *   agentId?: string | null,
 *   promptSet?: string | null,
 *   helpCommand?: boolean,
 *   outrospectionMode?: boolean,
 *   outrospection?: { lens: string | null, items: number, texts: number, quotes: number, live: boolean },
 *   feedback?: { comment: string, question: string | null, answer_excerpt: string | null, model: string, images?: { name: string | null, data: string }[], useCase?: { id: number, tag: string } | null, scope?: import("../public/js/feedback-core.js").FeedbackScope },
 * }} PipelineState
 */

/**
 * The demo surface the chat clients mount for this turn — the answer prompts'
 * `spaceScene` / `demoSurface` inputs, at most one of which is ever set. The
 * two clauses differ because the affordances do: a /space/ animation is playing
 * and can be rotated; a page surface is one tap away.
 *
 * English: these feed a prompt, not the UI (every mount captions itself in the
 * matched language). `prior` carries the turn before, so a bare "show me
 * visually" resolves the same way here as in the client. One shared core
 * (demo-core.js), so the matcher cannot drift.
 *
 * @param {string} text the latest user message
 * @param {string} [prior] the user message before it
 * @returns {{spaceScene: string, demoSurface: string}}
 */
function demoSurfaces(text, prior = "") {
  const none = { spaceScene: "", demoSurface: "" };
  const m = demoIntent(text, prior);
  if (m && m.kind === "space") {
    const scene = sceneById(m.sceneId);
    return { ...none, spaceScene: scene ? scene.title.en : "" };
  }
  if (m) return { ...none, demoSurface: m.title.en };
  return none;
}

/**
 * Writes one SSE event (a delta chunk, a status wrapper, or an error).
 * The vocabulary is documented as import('./types.js').SseEvent; typed
 * loosely here because the pipeline also emits registry-driven events
 * (quiz, provider-labeled searches) that ride on the same channel.
 * @typedef {(event: object) => void} EmitFn
 */

/**
 * The bundle runPipeline builds once and passes to every phase helper.
 * @typedef {{
 *   env: Env,
 *   log: Logger,
 *   emit: EmitFn,
 *   model: string,
 *   jsonModel: string,
 *   state: PipelineState,
 *   profile: ModelProfile,
 *   jsonProfile: ModelProfile,
 *   conversation: Conversation,
 *   reinforceJsonOnly: boolean,
 *   shellBlock: string,
 *   hasSource: boolean,
 *   spaceScene: string,
 *   demoSurface: string,
 *   lastUser: string,
 *   convText: string,
 *   cleanLastUser: string,
 *   gateLastUser: string,
 *   cleanConvText: string,
 *   planLastUser: string,
 *   planConvText: string,
 *   imageParts: import('./types.js').ContentPart[],
 *   emitDelta: (text: string) => void,
 *   step: (id: string, label: string) => void,
 *   stepDone: (id: string, label: string, details?: string[], extra?: Record<string, unknown>) => void,
 * }} PipelineCtx
 */

/**
 * The triage verdict shape (normalizeTriage's output) — declared alongside
 * the JSON-phase schemas and the normalization/fallback logic in triage.js.
 * @typedef {import('./triage.js').TriageDecision} TriageDecision
 */

// The EXECUTOR answer phases — the AgentSpec `capability.answerPhase` members
// that take over the whole answer instead of running the research flow. One row
// per shipped executor; the vocabulary is closed in agent-spec-core.js
// (ANSWER_PHASES) and validated there, so a spec can only ever name a key that
// exists here.
//
//   build    — the DistillSDK build flow: distil a flavour from this site
//              (above all the Se/cure tier) and publish it at /app/<slug>/.
//              No web search, no triage — the deliverable is a published app.
//   workflow — a JSON plan phase decomposes the request into a small team of
//              sub-agents the Worker runs in parallel waves, then one merge
//              streams the answer. The plan phase IS its triage.
//   feed     — the question is routed to a standing LENS by the deterministic
//              EN+SV gate and answered from the outward feed of what everyone
//              ELSE shipped. The retrieval IS its triage; no web search runs.
//
// The remaining phases (`research`, `source-research`, `direct`) are NOT here:
// they are decided per MESSAGE further down, by the hasSource +
// externalSourceIntent gate and by triage, not per request.
//
// Every one is gated in chat.js on the request's chat mode and is fully
// fail-soft inside — a dead plan degrades to a single-agent workflow, an empty
// feed answers honestly, a failed publish degrades to the answer text.
/** @type {Record<string, (ctx: PipelineCtx) => Promise<any>>} */
const ANSWER_PHASE_RUNNERS = {
  build: runSdkBuild,
  workflow: runOrchestration,
  feed: runOutrospection,
  // The plain model answer with no research phase at all. It was always in the
  // ANSWER_PHASES vocabulary and always the fallback the research flow takes
  // when nothing external applies; it becomes a DISPATCH target now that an
  // agent can be addressed by id, which is how a spec declaring
  // `answerPhase: "direct"` (the under-construction template) gets to mean it.
  direct: runWithoutSearch,
};

/**
 * The executor phase for a request. The registry-resolved `state.answerPhase`
 * wins; the per-mode booleans are the fail-soft fallback for a deployment whose
 * agent registry could not be read, and for the MCP channel, which builds its
 * state without either (and so always answers null → the research flow).
 * @param {any} state
 * @returns {string | null}
 */
function answerPhaseFor(state) {
  if (state.answerPhase && ANSWER_PHASE_RUNNERS[state.answerPhase]) return state.answerPhase;
  if (state.sdkMode) return "build";
  if (state.orchestratorMode) return "workflow";
  if (state.outrospectionMode) return "feed";
  return null;
}

/**
 * The SEARCH POLICY governing this request: the agent's declared ceiling ANDed
 * with what the caller asked for, narrowing in both directions.
 *
 * The subtlety is which capability may narrow at all. A capability's
 * `search` block describes the phase that capability DECLARES. The research
 * flow is reached two ways — an agent whose `answerPhase` is `research` or
 * `direct` (its declaration governs), and an introspection-mode turn that the
 * per-message `hasSource` + `externalSourceIntent` gate handed back to research
 * (its declaration describes the source-research phase it just left, and
 * introspection declares `web: false` precisely because that phase does not
 * search). Applying the second one here would silently kill web search for
 * every developer-mode turn — the gate routed the message here in order to
 * search. So a capability narrows only the phase it names.
 *
 * @param {PipelineState} state
 * @returns {{ web: boolean, auxSources: boolean, maxQueries: number|null }}
 */
export function searchPolicyFor(state) {
  const cap = /** @type {any} */ (state).capability;
  const governs = cap && (cap.answerPhase === "research" || cap.answerPhase === "direct");
  return capSearch(governs ? cap : null, { web: state.webSearch });
}

/**
 * May this request's answering agent consult this source at all?
 *
 * `searchPolicyFor` above narrows how MUCH searching happens; this narrows
 * WHICH sources exist for the turn. A registry entry may declare a
 * `requiresContext` — the id of a context block the answering agent must
 * declare in its capability — and a source that names one runs only for an
 * agent that declares it (owner directive, 2026-08-13: the roster became
 * specific, and the literature corpora are owned by the agents built on them,
 * Deep Science for all three legs and palaeogenomics for the life-science one).
 *
 * Generic by construction, like every other rule in this orchestrator: the
 * requirement is DATA on the entry and the fact that satisfies it is DATA on
 * the spec, so this reads two strings and never learns which source or which
 * agent it is deciding for. Adding or removing a source still touches no file
 * here (invariant: the registry is the seam).
 *
 * Fail-soft (invariant 2): a null capability keeps every source — see
 * capabilityAllowsSource's note in src/search-sources.js for why "no agent was
 * resolved" must not read as "an agent declared nothing", and why the MCP
 * literature door is deliberately outside the roster's reach.
 *
 * @param {PipelineState} state
 * @param {import('./search-sources.js').SearchSource} source
 * @returns {boolean}
 */
function sourceAllowed(state, source) {
  return capabilityAllowsSource(/** @type {any} */ (state).capability, source);
}

/**
 * Entry point (called by chat.js and mcp.js): runs the whole research
 * pipeline for one request, streaming everything through `emit`.
 * @param {Env} env
 * @param {Logger} log
 * @param {EmitFn} emit
 * @param {Conversation} conversation
 * @param {string} model The user's chosen answer/synthesis model.
 * @param {PipelineState} state
 */
export async function runPipeline(env, log, emit, conversation, model, state) {
  // A starter sent from an evaluation-mode chip opens with its `#XP-07` tag
  // (conversation.js, feedback #37). Read it once for the record — chat.js
  // puts it on the chat-log row and the feedback entry — then run the whole
  // pipeline on a copy without it, so triage, the search queries and the
  // answer see the starter's own words and nothing else. chat.js keeps the
  // untouched conversation, which is what carries the tag into the log.
  const starterRef = starterRefOf(conversation);
  if (starterRef) {
    /** @type {any} */ (state).starterRef = starterRef;
    conversation = withoutStarterTags(conversation);
  }
  const profile = getModelProfile(model);
  // The JSON planning phases (triage/gap/validate) run on a fixed reliable
  // model (state.jsonModel — Mistral Small, resolved in chat.js) rather than
  // the user's chosen answer model, so a reasoning model's flaky JSON can't
  // corrupt triage. Synthesis/direct replies still run on `model`. Each has
  // its own profile so the right JSON-reinforcement / max-tokens / validation
  // policy applies to the model that actually runs each phase.
  const jsonModel = state.jsonModel || model;
  const jsonProfile = getModelProfile(jsonModel);
  /** @type {PipelineCtx['step']} */
  const step = (id, label) => emit({ status: { type: "step_start", id, label } });
  /**
   * `extra` carries optional machine-readable fields alongside the human label
   * — today just `route`, the branch a finished step handed the answer to
   * (see ROUTE_NODES in public/js/pipeline-map-core.js). Clients that don't
   * know a field ignore it (the SSE forward-compatibility rule), and the
   * client that DOES read it never has to parse an English label.
   * @type {PipelineCtx['stepDone']}
   */
  const stepDone = (id, label, details = [], extra = undefined) =>
    emit({ status: { type: "step_done", id, label, details, ...(extra || {}) } });

  // Opt-in context enrichments (src/enrichment.js's registry — the site's
  // own source, plus whichever third-party extensions are registered and
  // enabled for this caller; this module names none of them and behaves
  // identically with an empty registry). They run BEFORE any model call —
  // and before the ctx build
  // below — so their labeled context blocks flow into every downstream
  // phase, triage included (ctx.lastUser / ctx.convText / ctx.imageParts
  // are all read from `convo`). Fully fail-soft — the conversation comes
  // back unchanged if there's nothing to look up or a service is down.
  // Feedback pipeline (feedback.js feedbackRequested): a message that opens
  // with "feedback" (EN+SV) or with the `/feedback` slash command is a report
  // to the developers, not research. Detect it
  // BEFORE the enrichments so a feedback note that happens to mention an IP or
  // address doesn't fire an enrichment lookup on the way in. Gated on
  // state.feedbackCapture — set only by the /api/chat channel (chat.js), so the
  // MCP channel keeps researching. The capture itself (entry + chat-log tag) is
  // done by chat.js from state.feedback; runFeedbackCapture below just answers.
  const feedbackReq =
    !!state.feedbackCapture &&
    feedbackRequested(textOf(lastUserMessage(conversation)?.content));
  const convo = feedbackReq
    ? conversation
    : await runEnrichments(env, log, emit, step, stepDone, conversation, state);

  const ctx = {
    env, log, emit, model, jsonModel, state, profile, jsonProfile, conversation: convo,
    reinforceJsonOnly: jsonProfile.jsonReinforcement,
    // The experimental bash-lite sandbox transcript (src/bash-agent.js): the
    // commands the BROWSER already ran and their real output, gathered
    // client-side before this request (chat.js `shell_transcript`). Empty
    // string when the sandbox didn't run — so every answer path's input is
    // byte-identical to a run without the feature. Fed into synthesis and the
    // direct/search-off replies as ground truth the assistant produced.
    shellBlock: buildShellTranscript(/** @type {any} */ (state).shellTranscript || []),
    // Developer mode (introspection): runEnrichments above appended the site's
    // own source to `convo` and set introspectionCount when it did, so the
    // answer prompts flip their capabilities line (hasSource) to use that
    // source instead of denying it — the "Code examples from site" fix.
    hasSource: !!(/** @type {any} */ (state).introspectionCount),
    // Both chat clients mount one of the site's own surfaces above the reply
    // when the outgoing question asks to be shown it (turns.js mountDemoEmbed,
    // drc.js mountDrcSpaceEmbed): a playable /space/ animation inline, or a card
    // into a page-only surface. The server re-runs the SAME deterministic gate
    // over the SAME messages so the answer prompts know what is displayed —
    // otherwise the capabilities line has the model apologising for being
    // unable to show anything while the animation plays beside it (feedback
    // #46), or researching the web for a capability this site ships (feedback
    // #49). No matcher drift is possible: one shared core.
    ...demoSurfaces(
      textOf(lastUserMessage(convo)?.content),
      previousUserText(convo),
    ),
    lastUser: textOf(lastUserMessage(convo)?.content),
    convText: formatConversation(convo),
    // The CLEAN question + context — from the PRE-enrichment conversation, so
    // the introspection excerpt block runEnrichments appended to `convo` is NOT
    // in them. The developer-mode read-loop PLANNER (runSourceResearch) reads
    // from these: with the block folded in, the planner sees the pre-loaded doc
    // excerpts as "already enough" and declines to read any real files, so the
    // answer degrades to a summary of those excerpts (the security-assessment
    // UX bug). Synthesis still uses the excerpt-bearing lastUser/convText above.
    cleanLastUser: textOf(lastUserMessage(conversation)?.content),
    // What a SOURCE-ROUTING gate reads: the clean message plus the words read
    // off the user's own attachment. The clean message alone is right for
    // gates that must ignore prose the pipeline appended to itself, but an
    // image transcription is not that — it is the user's question, in a form
    // textOf() flattens to "[1 image attached]". Without it, photographing a
    // paper's record page and asking "what is this about" routes on a message
    // with no subject in it. Bounded by image-read.js's own MAX_BLOCK_CHARS.
    gateLastUser: [
      textOf(lastUserMessage(conversation)?.content),
      /** @type {any} */ (state).imageReadText || "",
    ].filter(Boolean).join("\n"),
    cleanConvText: formatConversation(conversation),
    // What the QUERY-PLANNING phases read — triage, the gap check, the
    // sub-question fan-out: the enriched conversation MINUS the method blocks
    // (src/conversation.js withoutMethodBlocks). A third view, and it has to
    // be, because neither of the other two is right here. The clean pair drops
    // the DATA enrichments the planner legitimately writes queries from — the
    // transcription of the user's own photo above all. The enriched pair
    // carries method prose that is not a topic and must never become a search
    // string. Feedback #65: "Tiber style threat intel" planned against 945
    // words of appended TIBER-EU scaffold, so the first query went after the
    // report format and carried the block's own words with it.
    //
    // The fourth instance of a bug class this pipeline keeps paying for (quiz
    // gate, externalSourceIntent, the #61 source ladder, now query
    // generation), and the first outside a deterministic gate — which is why
    // pipeline.test.js's call-site guards were green through it.
    ...(() => {
      const planConvo = withoutMethodBlocks(convo, /** @type {any} */ (state).methodBlocks);
      return {
        planLastUser: textOf(lastUserMessage(planConvo)?.content),
        planConvText: formatConversation(planConvo),
      };
    })(),
    // Image parts of the latest user message ride along into synthesis so a
    // vision model can research with the image as context.
    imageParts: imagePartsOf(lastUserMessage(convo)),
    emitDelta: (/** @type {string} */ t) => emit({ choices: [{ delta: { content: t } }] }),
    step,
    stepDone,
  };

  // Inline quiz mode (src/quiz.js): a deterministic gate on the latest user
  // message ("quiz me on X…"). Gated on state.quizzes so only the /api/chat
  // channel gets the interactive event — the MCP channel builds its own
  // state without the flag and keeps getting a plain text answer. The quiz
  // replaces synthesis as the answer phase; material is the conversation
  // (attachments/project blocks ride inside it) plus, when triage chose
  // research, the search wave's source registry. Fully fail-soft: an
  // unusable quiz JSON falls through to the normal answer path below.
  // Tested against the CLEAN message (cleanLastUser), NOT the enrichment-
  // appended lastUser — the introspection block folded into lastUser carries
  // the CLAUDE.md orientation, whose prose contains literal "quiz me…"
  // examples, so with developer mode on EVERY request quiz-triggered and the
  // whole answer became a 5-question quiz (chat_logs #360, 2026-07-15; the
  // same bug class as externalSourceIntent's cleanLastUser fix below).
  // Feedback takes priority over every other case (research, quiz, SDK,
  // introspection, orchestration, the outward feed): the user is reporting to
  // the developers, so answer warmly and let chat.js record it — never route it
  // into research. This sits ABOVE the executor dispatch below on purpose —
  // that is what makes a slash command PLATFORM BASELINE rather than something
  // each agent has to opt into (owner directive, 2026-07-26).
  if (feedbackReq) return runFeedbackCapture(ctx);

  let quizReq = state.quizzes ? quizIntent(ctx.cleanLastUser) : null;

  // ---- executor answer phases (the registry dispatch) --------------------
  //
  // Three chat modes replace the whole research flow with an executor of their
  // own, and WHICH one is data: chat.js resolved the request against
  // sdk/AGENTS.json's `defaults` table and put the resolved
  // `capability.answerPhase` on the state. The table below is the one place a
  // phase name becomes code — the dispatch stays code and the selection stays
  // data, which is what keeps invariant 1 (no model decides control flow) true
  // of the routing as well as of the run.
  //
  // Adding a mode is therefore a registry edit plus, only if it needs a NEW
  // executor, one row here. An agent that reuses a shipped phase needs no code
  // at all (pinned by the "a sixth agent is data" test).
  const phase = answerPhaseFor(state);
  if (phase && ANSWER_PHASE_RUNNERS[phase]) {
    return ANSWER_PHASE_RUNNERS[phase](ctx);
  }

  // Web search (Exa) off is the knob's ONLY effect — NOT "no research". Depth
  // still governs how deep we go over whatever sources ARE available (owner
  // directive 2026-07-18): developer mode's own-source investigation and the
  // auxiliary search sources (HF Hub, …) run regardless of the knob, and
  // runSearches skips only the Exa leg. Fall through to the normal research
  // path whenever one of those applies. Only when NONE does is there nothing
  // external to consult — then answer from the model, with the slider's report
  // tier still scaling that answer (runWithoutSearch).
  // …and the answering agent's own declaration narrows the knob further
  // (searchPolicyFor). Every shipped agent that reaches here declares
  // `web: true`, so this is the knob alone today; a derived agent can ship
  // with search structurally off without depending on the user's toggle.
  const policy = searchPolicyFor(state);
  if (!policy.web) {
    if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
    // "Applicable" is a source's own intent OR the state's forceAux list — a
    // mode built AROUND a source (the Models agent) must not fall through
    // to a sourceless answer just because the message didn't name the hub. The
    // agent's `auxSources` declaration still outranks both: an agent that says
    // it uses no auxiliary sources uses none, forced or not.
    const forcedAux = Array.isArray(state.forceAux) ? state.forceAux : [];
    // cleanLastUser here too, and for the same reason as the two gates in
    // planAuxSource/leadingSources: whether a source APPLIES is a fact about
    // what the user asked, never about prose an enrichment appended to it.
    //
    // …and `sourceAllowed` first, because a source the answering agent may not
    // consult (registry `requiresContext`) is not applicable to ANYTHING here.
    // Without it a restricted source still drags the turn into the research
    // path — triage, a search wave, gap rounds — and planAuxSource then refuses
    // to plan it, so the turn pays the whole pipeline to reach the same answer
    // runWithoutSearch would have written straight away. That is the same class
    // of waste the auxOnly filter in leadingSources exists to stop, one layer
    // earlier (owner directive, 2026-08-13).
    if (!ctx.hasSource && !(policy.auxSources && SEARCH_SOURCES.some((s) => sourceAllowed(state, s) && (forcedAux.includes(s.id) || s.intent(ctx.gateLastUser))))) {
      return runWithoutSearch(ctx);
    }
  }

  // Developer mode, introspection-first: the site's OWN source is already in
  // context (runEnrichments set hasSource). Do REAL research in that source
  // instead of running the web/HF search wave, which on a pure "how is X
  // implemented / assess this project" ask only pulls in unrelated third-party
  // repos that share the "deep research" name. The wave is re-enabled the
  // moment the user asks for outside material — web search, cited sources,
  // current facts, or an external comparison (externalSourceIntent, EN+SV).
  // This keeps introspection pure without a protocol change: the server decides
  // from the knob + message. Tested against the CLEAN message (cleanLastUser),
  // not the excerpt-appended lastUser: the introspection block folded into
  // lastUser carries the CLAUDE.md orientation, whose prose trips
  // externalSourceIntent (e.g. a bare "vs") and would spuriously route every
  // dev-mode ask to the web-search wave / a triage direct reply instead of the
  // source read loop.
  //
  // The `/help` slash command (chat.js resolved it and turned the introspection
  // enrichment on for this request, whatever mode was picked) is the one case
  // that IGNORES externalSourceIntent: the user asked for the documentation in
  // so many words, so a help question phrased as a comparison ("/help how does
  // this compare to …") must not be handed back to the web-search wave.
  if (ctx.hasSource && (/** @type {any} */ (state).helpCommand === true || !externalSourceIntent(ctx.cleanLastUser))) {
    if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
    return runSourceResearch(ctx);
  }

  const decision = await runTriage(ctx);
  // Triage's fail-soft quiz backup: the deterministic gate missed (typo /
  // paraphrase — the first production request arrived as "Bygg en wuiz…")
  // but the triage model recognized a quiz request. The message still
  // decides the question count.
  if (state.quizzes && !quizReq && decision.quiz === true) {
    // cleanLastUser for the same reason as the primary gate above: the count
    // must come from the user's own words, not an enrichment block's prose.
    quizReq = { questions: quizQuestionCount(ctx.cleanLastUser) || DEFAULT_QUIZ_QUESTIONS };
  }
  // Clarify first, and it is deliberately NOT overridden below: it asks the
  // user a question rather than answering, so it cannot produce the failure
  // the direct branch does, and no page needs reading to serve it.
  if (decision.action === "clarify") return runClarify(ctx, decision.question);

  // ---- Phase 1.5: read the pages the user NAMED --------------------------
  // Before searching for sources, read the ones we were handed. See
  // runNamedUrlReads / src/named-urls.js — feedback #67 was a question whose
  // five pasted URLs the run then spent fifteen search angles failing to
  // rediscover.
  //
  // ABOVE the direct branch, because what it reads decides that branch.
  await runNamedUrlReads(ctx, extractNamedUrls(ctx.cleanLastUser));
  // Pages we actually READ override a `direct` decision. Pasting a link and
  // asking about it IS a research request over that page, and a direct reply
  // cannot serve it: the answer model has no browser, so triage routing this
  // turn to a direct completion produces the one answer that is both useless
  // and wrong — "I can't browse arbitrary URLs" — for a question whose whole
  // content is a URL we are perfectly able to read. Found by probing the
  // deployed site, not by a test: this phase used to sit BELOW the branch, so
  // it never ran on exactly the messages it was written for (verbatim probe,
  // chat_logs #1743 — `named_urls: 0`, no queries, no sources).
  //
  // Gated on what came BACK, not on what was linked: if nothing could be
  // read, the direct reply is still the better answer, and synthesis over an
  // empty source set would be a worse one.
  if (decision.action === "direct" && !state.namedUrlCount) {
    // Quiz from the material already in front of us (conversation, attached
    // documents, project materials) — triage decided no web sources needed.
    if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
    return runDirectReply(ctx);
  }

  // ---- Phase 2: initial search wave -------------------------------------
  // An overridden direct decision planned no angles, and that is the right
  // outcome rather than a hole to paper over: "what does this page say?" is
  // answered by the page, so the run goes straight to synthesis over what was
  // read instead of inventing keyword angles for a URL we already have.
  await runSearches(ctx, decision.action === "research" ? decision.queries : [], 1);
  // Quiz from web research: one search wave gathers the material, then the
  // quiz IS the answer — gap rounds, synthesis, and validation don't apply
  // (nothing streams that could be fact-checked; the quiz's own prompt pins
  // every question to the collected sources). On failure, fall through and
  // the searches feed the normal research answer instead.
  if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
  // ---- Phase 2.5: notes digest (budget-gated, mid/high tiers) ------------
  await maybeDigest(ctx);
  // ---- Phase 2.75: sub-question fan-out (flag-gated, long tiers) ---------
  await runSubquestionFanout(ctx);
  // ---- Phase 3: gap-check iterations (budgeted) -------------------------
  await runGapChecks(ctx);
  // ---- Phase 3.5: full-content fetch of top sources (budget-gated, ≥240s)
  await maybeFullContentDigest(ctx);
  // ---- Phase 4: synthesis (streamed draft) -------------------------------
  const draft = await runSynthesis(ctx);
  // ---- Phase 5: post-validation (budgeted; claim-level at high tiers) ----
  await runValidation(ctx, draft);
}

// ---- phases ------------------------------------------------------------

// The feedback case (routed at the top of runPipeline): the user's message is
// feedback for the developers. Stash the report on the state so chat.js can
// persist it as a feedback entry (the Claude Code work queue) AND tag the
// chat-log row, then emit a CANNED acknowledgment (feedback-core.js
// cannedFeedbackAck, EN+SV). NO model call anywhere in this case (owner
// directive, 2026-07-24): feedback is never run through an LLM — the exact
// text plus the whole conversation goes to the developers verbatim (chat.js
// buildFeedbackDebugContext), and a deterministic reply can't fail, can't
// paraphrase, and can't be prompt-injected.
/** @param {PipelineCtx} ctx */
async function runFeedbackCapture(ctx) {
  const { state } = ctx;
  ctx.step("plan", "Feedback…");
  // A use-case reference ("feedback #UC-34 …") ties this note to a try-it
  // point (testpoints.js) — the outcome is recorded straight onto that
  // point's thread (src/chat.js recordUseCaseFeedback) so it lands "as if
  // answered in the list of use cases". The step line confirms it
  // deterministically, independent of the model's acknowledgment.
  // The words the DEVELOPERS read. Identical to the message for the bare
  // keyword; for the `/feedback …` command the command token itself is stripped
  // (feedback-core feedbackComment), so the queue shows what the user wrote
  // rather than how they addressed it.
  const comment = feedbackComment(ctx.cleanLastUser);
  const useCase = parseUseCaseRef(ctx.cleanLastUser);
  // SCOPE (feedback-core feedbackScope): a "feedback …" message that OPENS a
  // conversation cannot be about that conversation — it is generic developer
  // feedback (a feature suggestion, next steps). The classification decides
  // the acknowledgment's wording, the entry's page tag (chat/standalone), and
  // whether a transcript is worth attaching at all (chat.js) — so a
  // suggestion never reaches the queue disguised as a session report.
  const scope = feedbackScope(ctx.conversation);
  ctx.stepDone(
    "plan",
    useCase
      ? `Recording your feedback on use case ${useCase.tag}`
      : scope === "standalone"
        ? "Sending your suggestion to the developers"
        : "Sending your feedback to the developers",
    [],
    { route: "feedback" },
  );
  // The message IS the comment; the prior turn (the question it followed and
  // the reply it comments on) rides along so the developer sees the context.
  // buildFeedbackContext derives it identically for a fresh chat and a REOPENED
  // HISTORICAL chat (the whole restored conversation is re-sent, so the prior
  // Q&A is the turn the feedback comments on) — src/feedback.js, regression-
  // locked in src/feedback.test.js.
  state.feedback = {
    ...buildFeedbackContext(ctx.conversation, {
      comment,
      model: ctx.model,
    }),
    // Screenshots attached to the feedback message itself — textOf flattened
    // them to "[N images attached]" and the bytes never reached the entry
    // (feedback #12, 2026-07-24). Chat.js forwards these into feedback_images.
    images: feedbackImagesFromParts(ctx.imageParts),
    useCase: useCase || null,
    scope,
  };
  emitChunked(
    ctx,
    cannedFeedbackAck(comment, { useCaseTag: useCase ? useCase.tag : null, scope }),
  );
}

/** @param {PipelineCtx} ctx */
async function runWithoutSearch(ctx) {
  ctx.step("plan", "Web search off");
  ctx.stepDone("plan", "Web search off — answering from model knowledge", [], { route: "search_off" });
  // No external source applied, so this answers from the model — but the depth
  // slider still scales the answer's comprehensiveness via the report tier
  // (searchOffPrompt's sourceless depth ladder; default "standard" is the
  // long-standing byte-identical prompt).
  await streamCompletion(ctx, [
    { role: "system", content: phasePrompt(ctx.state, "direct", "answer-search-off")({ hasShell: !!ctx.shellBlock, hasSource: !!ctx.hasSource, reportTier: ctx.state.plan.reportTier, spaceScene: ctx.spaceScene, demoSurface: ctx.demoSurface, capability: ctx.state.capability }) },
    ...shellReplyMessages(ctx.shellBlock),
    ...withImageNudge(ctx.conversation),
  ]);
}

// Phase 1: decide direct reply | clarifying question | research plan, and
// Whether a METHOD enrichment appended anything on this turn — the first of the
// two conditions the query focus is gated on (feedback #65). Reads the same
// record the planning view is built from, so the two cannot drift apart.
/** @param {any} state @returns {boolean} */
function methodBlocksApplied(state) {
  return Array.isArray(state?.methodBlocks) && state.methodBlocks.length > 0;
}

// announce the decision via the "plan" step. For "research" the returned
// queries are already capped to the budget plan's angle count.
/**
 * @param {PipelineCtx} ctx
 * @returns {Promise<TriageDecision>}
 */
async function runTriage(ctx) {
  // planLastUser/planConvText, NOT lastUser/convText: this phase WRITES the
  // web-search queries, and an appended method block is the one thing that can
  // never be a search target (feedback #65 — see the ctx note).
  const { state, planLastUser: lastUser, planConvText: convText, step, stepDone } = ctx;
  step("plan", "Analyzing request…");
  const triage = await jsonPhase(ctx, {
    label: "triage",
    statKey: "triage",
    recordStat: true,
    maxTokens: 500,
    messages: [
      // `capability` reaches the prompt so its composed source notes cover the
      // sources this agent may actually consult (search-sources.js
      // sourcePromptNotes, capability-aware since 2026-08-13): a triage prompt
      // must not teach the planner the vocabulary of a corpus the answering
      // agent is not allowed to search, or the plan promises a leg that will
      // never run. Null (the MCP channel) composes every note, as before.
      { role: "system", content: triagePrompt(Math.max(4, state.plan.queries), { reinforceJsonOnly: ctx.reinforceJsonOnly, capability: /** @type {any} */ (state).capability || null }) },
      { role: "user", content: `Conversation:\n${convText}\n\nLatest user message:\n${lastUser}` },
    ],
  });
  const decision = normalizeTriage(
    hardenJson(TRIAGE_SCHEMA, triage),
    lastUser,
    previousUserText(ctx.conversation),
    {
      // Whether the turn being answered was itself a clarifying question — the
      // guard against asking twice in a row instead of searching (feedback #47).
      priorWasClarify: looksLikeClarifyTurn(lastAssistantText(ctx.conversation)),
      // Whether the client mounted a demo surface for this turn. Asking the
      // user to narrow what they meant is wrong once the thing they asked for
      // is already playing above the reply (feedback #58).
      demoMounted: !!(ctx.spaceScene || ctx.demoSurface),
    },
  );

  if (decision.action === "direct") {
    stepDone("plan", "Direct reply (no research needed)", [], { route: "direct" });
    return decision;
  }
  if (decision.action === "clarify") {
    stepDone("plan", "Need to narrow the scope first", [], { route: "clarify" });
    return decision;
  }
  // The deterministic half of the subject-vs-format split (feedback #65). The
  // prompt rule alone does not hold on the fixed JSON planner this phase runs
  // on (invariant 3), so the angles that came back about the report FORMAT are
  // dropped here. Disengages entirely when no method block applied or the
  // conversation resolves no subject — a question genuinely about a framework
  // still searches that framework. See public/js/query-focus-core.js.
  const focused = focusQueriesOnSubject(decision.queries, {
    cleanText: ctx.cleanConvText,
    methodApplied: methodBlocksApplied(state),
  });
  if (focused.dropped.length) {
    ctx.log.info("chat.query_focus", { dropped: focused.dropped.length, kept: focused.queries.length });
  }
  const queries = focused.queries.slice(0, state.plan.queries);
  // The sub-questions steer every later round, so a format sub-question
  // ("What is the TIBER-EU framework?") re-seeds the same angles the gap check
  // would otherwise chase all over again.
  decision.subquestions = focusQueriesOnSubject(decision.subquestions || [], {
    cleanText: ctx.cleanConvText,
    methodApplied: methodBlocksApplied(state),
  }).queries;
  // Thread the triage decomposition into the request state: the gap check
  // audits coverage against each sub-question and synthesis must address
  // them (see gapPrompt/synthPrompt); complexity caps research depth below
  // the time budget for simple questions (budget.js applyComplexityToPlan).
  state.complexity = decision.complexity || null;
  state.subquestions = decision.subquestions || [];
  // Task SHAPE, which decides whether splitting the work helps at all
  // (docs/AGENTIC-GRAPHS.md §5.2). Null when the model omitted it — the
  // fan-out gate then infers it from `complexity`, exactly as before.
  state.decomposition = decision.decomposition || null;
  applyComplexityToPlan(state.plan, state.complexity);
  const kindTag =
    state.complexity && state.complexity !== "simple" ? ` · ${state.complexity}` : "";
  stepDone(
    "plan",
    `Planned ${queries.length} search angle${queries.length === 1 ? "" : "s"}${kindTag} · target ${state.plan.budgetS}s`,
    [...queries, ...state.subquestions.map((s) => `Sub-question: ${s}`)],
    { route: "research" },
  );
  return { ...decision, queries };
}

// The quiz answer phase (see the quizReq gate in runPipeline). One JSON call
// on the reliable JSON model — like the planning phases, because a broken
// quiz JSON means no quiz at all, so JSON reliability outranks the user's
// answer-model choice — hardened by normalizeQuiz. On success: the intro
// streams as the assistant text (that's what history/chatlog/recovery hold),
// then ONE `quiz` status event carries the full question set — alternatives,
// the correct index, explanations — and the client (public/js/quiz.js) runs
// the whole interaction locally: sequential questions, multiple-choice plus
// a free-text field, immediate feedback, final score. Returns true when the
// quiz was delivered; false lets the caller fall through to the normal
// answer path (fail-soft — a quiz request never errors the chat).
/**
 * @param {PipelineCtx} ctx
 * @param {{ questions: number }} quizReq
 * @returns {Promise<boolean>}
 */
async function runQuizGeneration(ctx, quizReq) {
  const { state, lastUser, convText } = ctx;
  ctx.step("quiz", "Writing quiz questions…");
  const digest = sourceDigest(state.sources, state.plan.digestCap);
  const raw = await jsonPhase(ctx, {
    label: "quiz",
    statKey: "quiz",
    maxTokens: 3000,
    messages: [
      { role: "system", content: quizPrompt(quizReq.questions, { reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      {
        role: "user",
        content:
          `Quiz request (latest user message):\n${lastUser}\n\nConversation and attached material:\n${convText}\n\n` +
          (digest ? `Numbered web sources gathered as quiz material:\n${digest}\n` : ""),
      },
    ],
  });
  const quiz = normalizeQuiz(raw, quizReq.questions);
  if (!quiz) {
    ctx.stepDone("quiz", "Couldn't build a quiz from this material — answering normally");
    return false;
  }
  // Metadata for the chat log / done stats; the full quiz for chatlog meta
  // (the agentic-debugging workflow reads what users were actually asked).
  state.quiz = quiz;
  ctx.stepDone(
    "quiz",
    `Quiz ready — ${quiz.questions.length} question${quiz.questions.length === 1 ? "" : "s"}`,
  );
  emitChunked(ctx, quiz.intro);
  ctx.emit({ status: { type: "quiz", quiz } });
  return true;
}

/**
 * @param {PipelineCtx} ctx
 * @param {string} [auxBlock] The numbered digest a forced auxiliary source
 *   produced for this turn, when the caller has one (runSourceResearch). ""
 *   for every other caller, which keeps their message array byte-identical.
 */
async function runDirectReply(ctx, auxBlock = "") {
  await streamCompletion(ctx, [
    // webSearchOn: this branch produced no sources, and without the knob's
    // actual value the model has been observed explaining that away by
    // inventing an off toggle (prompts.js SEARCH_ON_BUT_UNUSED_NOTE).
    // …unless a forced auxiliary source DID produce sources, in which case
    // there is nothing to explain away and citing them is the whole point.
    { role: "system", content: phasePrompt(ctx.state, "research", "answer-direct")({ hasShell: !!ctx.shellBlock, hasSource: !!ctx.hasSource, spaceScene: ctx.spaceScene, demoSurface: ctx.demoSurface, webSearchOn: ctx.state.webSearch !== false, externalSources: !!auxBlock, capability: ctx.state.capability }) },
    ...auxReplyMessages(auxBlock),
    ...shellReplyMessages(ctx.shellBlock),
    ...withImageNudge(ctx.conversation),
  ]);
}

/**
 * @param {PipelineCtx} ctx
 * @param {string} question
 */
async function runClarify(ctx, question) {
  emitChunked(ctx, question);
}

// Introspection-first research: the developer-mode answer path that does REAL
// research in the site's OWN source instead of a web search. The enrichment
// already injected retrieved excerpts + orientation and stashed the deployed
// source snapshot (state.sourceSnapshot); here the model drives an agentic READ
// loop over the SITEMAP — asking for the files it needs, round by round — so the
// answer is grounded in the actual implementation, not the repo's own docs
// (the "read files as it wants / don't trust documented issues" requirement).
// NO function calling (invariant 1): each read request is a JSON object on the
// reliable JSON model. Fully fail-soft — a missing snapshot or a failing loop
// degrades to a plain source-grounded reply from what's already in context.
// The native-tool source-research path is available when the ANSWER model
// supports real function calling. Today that's Claude (src/anthropic.js) with
// its key configured; other providers keep the deterministic read loop. Text
// only — an attached image falls back to the deterministic path (which threads
// imageParts into synthesis).
/** @param {PipelineCtx} ctx @returns {boolean} */
function introspectionToolsAvailable(ctx) {
  return isAnthropicModel(ctx.model) && anthropicConfigured(ctx.env) && !ctx.imageParts.length;
}

export const MAX_SOURCE_TOOL_ROUNDS = 6; // native tool rounds before we force an answer

// Native tool-use source research (owner-authorized invariant-1 exception): the
// ANSWER model itself drives grep_source/read_file/list_files against the
// deployed snapshot (src/introspect-tools.js), then writes the answer. Emits an
// activity step per tool call, bills the rounds to the answer model's bucket,
// and emits the final answer. Throws on a hard provider failure so the caller
// falls back to the deterministic read loop.
/** @param {PipelineCtx} ctx @param {any} snapshot */
async function runSourceResearchTools(ctx, snapshot, auxBlock = "") {
  const tools = toolsForRun(ctx.state.capability, ["source-read"], { snapshot: !!snapshot });
  // An agent whose declaration leaves this path with nothing to drive has no
  // business on it. Throwing hands the turn to the deterministic read loop, the
  // same fallback a provider failure takes — which is exactly what a spec
  // declaring `toolFallback: "read-loop"` asks for.
  if (!tools.length) throw new Error("no tool classes resolved for source research");
  const budget = { used: 0 };
  const sitemap = buildSourceSitemap(snapshot);
  let calls = 0;
  ctx.step("source", "Investigating the site's own source…");
  // The OWASP Top 10 reference block (retrieved for a security-assessment ask by
  // the introspection enrichment). This path reads the CLEAN pre-enrichment
  // conversation, so the block — appended to the DIRTY conversation — must be
  // injected explicitly here or the tool-driven answer would lose the OWASP
  // grounding the deterministic path gets for free.
  const owaspBlock = /** @type {any} */ (ctx.state).owaspBlock || "";
  // The HELP documentation block (retrieved by the introspection enrichment —
  // the docs-first layer of help mode) needs the same explicit injection for
  // the same clean-conversation reason.
  const helpBlock = /** @type {any} */ (ctx.state).helpBlock || "";
  const userText =
    `Question (latest user message):\n${ctx.cleanLastUser}\n\n` +
    `Conversation context:\n${ctx.cleanConvText}\n\n` +
    (ctx.shellBlock ? `${ctx.shellBlock}\n\n` : "") +
    (helpBlock ? `${helpBlock}\n\n` : "") +
    (owaspBlock ? `${owaspBlock}\n\n` : "") +
    // The forced auxiliary sources (runForcedAuxSearches) need the same
    // explicit injection as the two blocks above, for the same reason: this
    // path reads the CLEAN pre-enrichment conversation.
    (auxBlock ? `${auxBlock}\n\n` : "") +
    `File index (repo paths — investigate with grep_source / read_file):\n${sitemap}\n\n` +
    "Investigate the ACTUAL source with the tools, then write the answer." +
    (auxBlock ? " Use the external sources above for facts that live OUTSIDE this repository, citing them as [n]." : "");
  const startedAt = Date.now();
  const result = await anthropicToolRun(ctx.env, {
    model: ctx.model,
    system: phasePrompt(ctx.state, "source-research", "answer-tools")({ externalSources: !!auxBlock, capability: ctx.state.capability }),
    userContent: userText,
    // The snapshot readers, reached through the agent's declared tool CLASSES
    // (src/tool-sets.js) rather than imported. The shipped introspection spec
    // declares exactly ["source-read"], so this is INTROSPECTION_TOOLS for every
    // request today; a derived agent that declares no tools gets the
    // deterministic read loop instead (guarded above).
    tools,
    // The agent's declared round cap, clamped to the loop's own ceiling. The
    // shipped introspection spec declares exactly MAX_SOURCE_TOOL_ROUNDS, so
    // this is that constant for every request today; a derived agent may ask
    // for a shorter investigation, never a longer one.
    maxRounds: capBound(ctx.state.capability, "maxRounds", MAX_SOURCE_TOOL_ROUNDS),
    execTool: (name, input) => runIntrospectionTool(snapshot, name, input, budget),
    // Each tool call gets its OWN activity row: the tool + its arguments as the
    // headline, and the actual result (grep matches / file start / output) in
    // the expandable details — so the run is legible, not just a counter. The
    // "source" header ticks the running count in place (startGenericStep is
    // idempotent) and is finished below.
    onToolUse: ({ name, input, result: out }) => {
      calls++;
      const id = `srctool_${calls}`;
      const head = toolStepHeadline(name, input);
      ctx.step(id, head);
      ctx.stepDone(id, head, toolResultLines(out));
      ctx.step("source", `Investigating — ${calls} tool call${calls === 1 ? "" : "s"}…`);
    },
  });
  addUsage(ctx.state.totals, result.usage);
  recordPhase(ctx.model, "synth", Date.now() - startedAt);
  ctx.stepDone(
    "source",
    result.toolCalls
      ? `Investigated the source with ${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}`
      : "Answered from the source",
  );
  const text = (result.text || "").trim();
  if (!text) throw new Error("native tool run produced no answer");
  ctx.step("synth", "Writing report…");
  emitChunked(ctx, text);
  ctx.stepDone("synth", "Report drafted");
}

// ---- SDK mode ("lovable" distiller): design + build + publish
//
// SDK mode's answer phase (routed at the top of runPipeline): the user
// describes a FLAVOUR to distill from this site — above all the client-side
// Se/cure tier — the model builds it as a small self-contained web app, and
// the pipeline publishes it at a live /app/<slug>/ URL (src/build-pub.js).
// DistillSDK (sdk/) is the method: its module catalog + skills structure the
// build, and the deployed Se/cure source is the original studied and distilled.
// Two execution paths, mirroring the introspection source research:
//
//   1. NATIVE TOOLS (the same owner-authorized invariant-1 exception, extended
//      to SDK mode 2026-07-18): a tool-capable answer model drives the sdk_*
//      planning tools + the snapshot readers (over the Se/cure source) +
//      write_file/publish_app itself.
//   2. DETERMINISTIC (every other catalog model): one streamed completion
//      that emits FILE blocks (bash-core's fenced-block philosophy — a text
//      convention, no function calling), parsed and published server-side.
//
// Both fully fail-soft: a missing manifest/snapshot degrades the context (the
// model still builds), a publish failure degrades to the answer text with an
// honest note, and a tool-path failure falls through to the deterministic one.

export const MAX_SDK_TOOL_ROUNDS = 12; // staging many files takes more rounds than reading
export const SDK_BUILD_ROUND_MAX_TOKENS = 16_384; // one write_file must fit a whole real file
export const SDK_BUILD_ROUND_TIMEOUT_MS = 240_000; // non-streaming rounds; scaled to the token budget

// The SDK-mode tool CLASSES, as the Agent Studio spec declares them: the
// snapshot readers (read the real Se/cure source — only useful with a snapshot
// to read, which src/tool-sets.js knows), the sdk_* planning tools over the
// DistillSDK manifest, and the build tools (write_file / publish_app). This
// list is the fallback for a run that resolved no capability at all; a routed
// request uses the agent's own declaration, which for the shipped spec is
// exactly these three.
const SDK_BUILD_TOOL_CLASSES = ["source-read", "sdk-plan", "build-publish"];

/** @param {PipelineCtx} ctx @returns {Promise<any>} */
async function sdkSnapshot(ctx) {
  // The introspection enrichment (a source-carrying mode is on — SDK mode is one)
  // normally stashed the snapshot already; load it directly when it didn't
  // (e.g. an off-only developer_mode:false override alongside sdk_mode).
  const stashed = /** @type {any} */ (ctx.state).sourceSnapshot;
  if (stashed && Array.isArray(stashed.files)) return stashed;
  return loadSourceSnapshot(ctx.env, ctx.log);
}

/** @param {PipelineCtx} ctx */
async function runSdkBuild(ctx) {
  const { state } = ctx;
  ctx.step("plan", "Agent Studio…");
  // WHICH SDK is the method (feedback #41): one agent → the Agent SDK, a whole
  // platform → the Platform SDK. Classified deterministically from the user's
  // own words (sdk-core buildTargetFor, EN+SV), so the step the user watches
  // names the same SDK the model is briefed on — and neither says the internal
  // codename.
  const target = buildTargetFor(ctx.cleanLastUser);
  ctx.stepDone(
    "plan",
    target === "platform"
      ? "Agent Studio — building a platform with the Platform SDK"
      : "Agent Studio — building an agent with the Agent SDK",
  );
  const snapshot = await sdkSnapshot(ctx);
  const manifest = manifestFromSnapshot(snapshot);
  if (!manifest) ctx.log.warn("sdk.manifest_missing", {});
  // The Agent SDK's own material rides on an agent build (fail-soft: no
  // registry in the snapshot just means the digest is omitted).
  const agentBlock = target === "agent" ? buildAgentSdkDigest(agentsFromSnapshot(snapshot)) : "";
  // Deterministically gather the actual Se/cure reference source (a bounded
  // digest of the real files, straight from the snapshot) and put it in front
  // of the model on BOTH paths. Without this the deterministic fallback saw
  // only a list of paths — never enough to distill — and the tool path could
  // burn its rounds/time re-reading before it reached any real source.
  const secureDigest = buildSecureSourceDigest(snapshot);

  const toolsOn = introspectionToolsAvailable(ctx);
  ctx.log.info("sdk.build_gate", {
    tools: toolsOn,
    target,
    model: ctx.model,
    manifest: !!manifest,
    snapshot_files: snapshot?.files?.length || 0,
    digest_chars: secureDigest.length,
    build_slug: /** @type {any} */ (state).buildSlug || null,
  });
  if (toolsOn) {
    try {
      return await runSdkBuildTools(ctx, snapshot, manifest, secureDigest, { target, agentBlock });
    } catch (/** @type {any} */ err) {
      ctx.log.warn("sdk.tools_failed", { model: ctx.model, error: err?.message || String(err) });
      // fall through to the deterministic FILE-block path
    }
  }
  return runSdkBuildDeterministic(ctx, manifest, secureDigest, { target, agentBlock });
}

/**
 * Publish the staged files (fail-soft): stashes the result on the state (the
 * chat log's meta.build), emits the `build` status event the client uses to
 * remember the slug, and returns the result or null.
 * @param {PipelineCtx} ctx
 * @param {Array<{ path: string, content: string }>} files
 * @param {string} title
 * @returns {Promise<{ slug: string, url: string, files: number, bytes: number, paths: string[] } | null>}
 */
async function publishSdkFiles(ctx, files, title) {
  try {
    const result = await publishBuild(ctx.env, ctx.log, {
      slug: /** @type {any} */ (ctx.state).buildSlug || null,
      title,
      files,
      userId: /** @type {any} */ (ctx.state).userId || "",
    });
    if ("error" in result) {
      ctx.log.warn("sdk.publish_rejected", { error: result.error });
      return null;
    }
    /** @type {any} */ (ctx.state).buildResult = result;
    /** @type {any} */ (ctx.state).buildSlug = result.slug;
    ctx.emit({ status: { type: "build", slug: result.slug, url: result.url, files: result.files, title } });
    return result;
  } catch (/** @type {any} */ err) {
    ctx.log.warn("sdk.publish_failed", { error: err?.message || String(err) });
    return null;
  }
}

/** A short build title from the user's ask (the slug fragment source). */
/** @param {PipelineCtx} ctx @returns {string} */
const sdkBuildTitle = (ctx) => ctx.cleanLastUser.replace(/\s+/g, " ").trim().slice(0, 80) || "App";

// sdkReplyTail (+ SDK_ITERATION_QUESTION / endsWithQuestion) lives in
// pipeline-inputs.js — the feedback-#13 closing shape both build paths share.

/** @param {PipelineCtx} ctx @param {any} snapshot @param {any} manifest @param {string} secureDigest
 *  @param {{ target: "agent" | "platform", agentBlock: string }} sdk which SDK is the method */
async function runSdkBuildTools(ctx, snapshot, manifest, secureDigest, sdk) {
  const readBudget = { used: 0 };
  /** @type {Map<string, string>} */
  const staged = new Map();
  // The staged map as the publish/summary shape. Written three times over
  // three frames before, which is one edit away from a publish and a summary
  // describing different collections.
  const stagedFiles = () => [...staged].map(([path, content]) => ({ path, content }));
  let calls = 0;
  const fileCheck = snapshotFileCheck(snapshot);
  const buildSlug = /** @type {any} */ (ctx.state).buildSlug;
  ctx.step("source", sdk.target === "platform" ? "Building with the Platform SDK…" : "Building with the Agent SDK…");

  // The snapshot readers (read the real Se/cure source) only make sense with a
  // snapshot to read; the SDK planning tools + build tools always ride.
  const tools = toolsForRun(ctx.state.capability, SDK_BUILD_TOOL_CLASSES, { snapshot: !!snapshot });
  /** @param {string} name @param {any} input @returns {Promise<string> | string} */
  const execTool = (name, input) => {
    if (SDK_TOOL_NAMES.has(name)) return runSdkTool(manifest, name, input, { fileCheck });
    if (name === "write_file") {
      const res = stageBuildFile(staged, input?.path, input?.content);
      return res.ok ? `Staged ${res.path} (${res.bytes} bytes). ${staged.size} file${staged.size === 1 ? "" : "s"} staged.` : res.error;
    }
    if (name === "publish_app") {
      const title = String(input?.title || "").trim() || sdkBuildTitle(ctx);
      return publishSdkFiles(ctx, stagedFiles(), title).then((result) =>
        result
          ? `Published ${result.files} file${result.files === 1 ? "" : "s"} — the live URL is ${result.url} (include it in your reply as a link).`
          : "Publishing failed on the server — finish the reply and tell the user honestly that no live URL is available this turn.",
      );
    }
    return runIntrospectionTool(snapshot, name, input, readBudget);
  };

  const userText =
    `Request (latest user message):\n${ctx.cleanLastUser}\n\n` +
    `Conversation context:\n${ctx.cleanConvText}\n\n` +
    // The sandbox transcript rides with the sdkBuild framing (context only) —
    // without it the model treats sandbox-heredoc'd files as already shipped
    // and stages nothing (feedback #7, chat_logs #583).
    (ctx.shellBlock ? `${shellReplyMessages(ctx.shellBlock, { sdkBuild: true })[0].content}\n\n` : "") +
    buildSdkContextBlock(manifest, {
      toolMode: true,
      buildUrl: buildSlug ? `/app/${buildSlug}/` : null,
      secureDigest,
      target: sdk.target,
      agentBlock: sdk.agentBlock,
    }) +
    "\n\nBuild it now: the Se/cure source digest above is your starting material — read_file only for detail it omits, stage every file with write_file, publish_app once, then write the short reply.";

  const startedAt = Date.now();
  const result = await anthropicToolRun(ctx.env, {
    model: ctx.model,
    system: phasePrompt(ctx.state, "build", "answer-tools")({ target: sdk.target }),
    userContent: userText,
    tools,
    maxRounds: capBound(ctx.state.capability, "maxRounds", MAX_SDK_TOOL_ROUNDS),
    // A build round is not a JSON blip: one write_file call for a real-sized
    // index.html needs several thousand output tokens in a single round. At
    // the 4096-token default the tool_use truncated (stop_reason max_tokens,
    // no staged file, often no text either) and the 45s default timeout
    // couldn't hold the generation — every meaty build fell through to the
    // deterministic path, which then dumped raw FILE blocks into the chat
    // (feedback #13, chat_logs #599). Sized for the biggest single file a
    // build realistically stages, with a timeout to match the token budget.
    maxTokens: capBound(ctx.state.capability, "maxTokens", SDK_BUILD_ROUND_MAX_TOKENS),
    timeoutMs: capBound(ctx.state.capability, "timeoutMs", SDK_BUILD_ROUND_TIMEOUT_MS),
    execTool,
    onToolUse: ({ name, input, result: out }) => {
      calls++;
      const id = `sdktool_${calls}`;
      const head = SDK_TOOL_NAMES.has(name) || BUILD_TOOL_NAMES.has(name)
        ? sdkToolStepHeadline(name, input)
        : toolStepHeadline(name, input);
      ctx.step(id, head);
      ctx.stepDone(id, head, name === "write_file" ? [] : toolResultLines(out));
      ctx.step("source", `Building — ${calls} tool call${calls === 1 ? "" : "s"}, ${staged.size} file${staged.size === 1 ? "" : "s"} staged…`);
    },
  });
  addUsage(ctx.state.totals, result.usage);
  recordPhase(ctx.model, "synth", Date.now() - startedAt);

  // What the run actually shipped. The `publish_app` tool publishes through
  // publishSdkFiles, which stashes its result on the STATE (ctx.state.
  // buildResult) — so the state is the source of truth here, not a local the
  // tool arm never writes.
  //
  // Then: the model staged files but never published (round cap, or it
  // forgot). Publish for it, fail-soft — the "describe it, get a link"
  // promise should not hinge on the model remembering the last call.
  /** @type {{ slug: string, url: string, files: number, bytes: number, paths: string[] } | null} */
  let published = staged.size ? /** @type {any} */ (ctx.state).buildResult || null : null;
  if (staged.size && !published) published = await publishSdkFiles(ctx, stagedFiles(), sdkBuildTitle(ctx));

  ctx.stepDone(
    "source",
    published
      ? `Built and published ${published.files} file${published.files === 1 ? "" : "s"} → ${published.url}`
      : staged.size
        ? "Build staged but publishing was unavailable"
        : "Answered without building files",
    staged.size ? buildFilesSummary(staged) : [],
  );

  const text = (result.text || "").trim();
  if (!text && !published) {
    // Nothing shipped AND nothing written — only then is a rebuild on the
    // deterministic path (the runSdkBuild catch) the right recovery.
    throw new Error(`SDK tool run produced no answer (stop_reason ${result.stopReason || "unknown"})`);
  }
  if (!published && !staged.size && result.stopReason === "max_tokens") {
    // The run truncated before staging a single file: the prose it did write
    // promises an app that never shipped. Rebuild deterministically instead.
    throw new Error("SDK tool run truncated (max_tokens) before staging any file");
  }
  ctx.step("synth", "Writing report…");
  if (text) {
    emitChunked(ctx, text);
    // sdkReplyTail guarantees the requested closing shape (feedback #13):
    // a build summary, a CLICKABLE link (the model often writes the URL as
    // bold/bare prose, and `marked` never autolinks a relative /app/ path —
    // appended unless the reply already carries a real markdown link,
    // replyLinksTo, not a substring check), and the iteration question. The
    // tail rides the answer text, so it also survives a dropped-stream
    // recovery, where only the text is replayed (the `build` status event
    // is not).
    if (published) emitChunked(ctx, sdkReplyTail(text, published));
  } else if (published) {
    // Built and published, but the model never wrote the report (round cap,
    // or a truncated final call): compose it server-side rather than throw
    // the finished build away into a full deterministic rebuild.
    emitChunked(ctx, `Your app is built and live.${sdkReplyTail("", published)}`);
  }
  ctx.stepDone("synth", "Report drafted");
}

/** @param {PipelineCtx} ctx @param {any} manifest @param {string} secureDigest
 *  @param {{ target: "agent" | "platform", agentBlock: string }} [sdk] which SDK is the method */
async function runSdkBuildDeterministic(ctx, manifest, secureDigest, sdk = { target: "agent", agentBlock: "" }) {
  const buildSlug = /** @type {any} */ (ctx.state).buildSlug;
  // The FILE-block convention + catalog/Se/cure reference (incl. the source
  // digest) ride the conversation (the introspection-enrichment append pattern)
  // so the streamed completion sees them on any catalog model — this is the ONLY
  // real Se/cure source this path gets, since it has no read tools.
  const block = buildSdkContextBlock(manifest, {
    toolMode: false,
    buildUrl: buildSlug ? `/app/${buildSlug}/` : null,
    secureDigest,
    target: sdk.target,
    agentBlock: sdk.agentBlock,
  });
  const convo = /** @type {Conversation} */ (withAppendedText(ctx.conversation, block));
  ctx.step("synth", "Building the app…");

  // Feedback #13 (chat_logs #599): this path used to stream its raw draft —
  // FILE blocks included — straight into the chat, so the user watched a whole
  // index.html scroll by instead of a build. The draft is BUFFERED now (the
  // tool path's shape): live per-file progress steps while it streams, then
  // the reply the user reads is the draft's prose with the FILE blocks
  // stripped, closed by sdkReplyTail's build summary + link + question.
  let buf = "";
  let scanner = makeFileLineScanner();
  let fileCount = 0;
  /** @type {{ id: string, path: string } | null} */
  let openFileStep = null;
  const closeFileStep = () => {
    if (openFileStep) ctx.stepDone(openFileStep.id, `Wrote ${openFileStep.path}`);
    openFileStep = null;
  };
  const buffered = /** @type {PipelineCtx} */ ({
    ...ctx,
    // SDK mode skips the budget planner, so state.plan is unset and the
    // completion would fall back to the providers' 4096-token default — a
    // whole multi-file app draft truncates there (a ~14 KB bundle alone is
    // ~4k tokens, before any prose). Same budget as a tool-path round; the
    // totals object is shared by reference, so billing lands unchanged.
    state: {
      ...ctx.state,
      plan: {
        .../** @type {any} */ (ctx.state.plan),
        synthMaxTokens: capBound(ctx.state.capability, "maxTokens", SDK_BUILD_ROUND_MAX_TOKENS),
      },
    },
    emitDelta: (/** @type {string} */ t) => {
      buf += t;
      for (const path of scanner.feed(buf)) {
        closeFileStep();
        fileCount++;
        openFileStep = { id: `bfile_${fileCount}`, path };
        ctx.step(openFileStep.id, `Writing ${path}…`);
        ctx.step("synth", `Building the app — ${fileCount} file${fileCount === 1 ? "" : "s"} so far…`);
      }
    },
    emit: (/** @type {object} */ event) => {
      // streamCompletion's early-stall retry discards the shown fragment and
      // starts over — here nothing was shown, so swallow the discard and
      // reset the buffer/progress so attempt 2 scans from scratch.
      if (/** @type {any} */ (event)?.status?.type === "discard_text") {
        buf = "";
        scanner = makeFileLineScanner();
        closeFileStep();
        return;
      }
      ctx.emit(event);
    },
  });
  const baseMessages = [
    { role: "system", content: phasePrompt(ctx.state, "build", "answer")({ target: sdk.target }) },
    ...shellReplyMessages(ctx.shellBlock, { sdkBuild: true }),
    ...withImageNudge(convo),
  ];
  let draft = (await streamCompletion(buffered, baseMessages)) || "";
  closeFileStep();

  // Feedback #30 (chat_logs #650): a one-file app draft stopped dead at the
  // output ceiling, mid-attribute. Nothing closed the fence, so the parse found
  // ZERO files, the "no build here — plain reply" branch below showed the draft
  // unchanged, and the user watched a raw half-written index.html scroll by
  // with no app and no link. One bounded continuation finishes the file; it is
  // fail-soft like every helper phase (invariant 2) — a failure here leaves the
  // turn exactly as truncated as it already was.
  let cut = findUnterminatedFileBlock(draft);
  if (cut) {
    const cutPath = cut.path;
    ctx.step("bcont", `Output limit reached inside ${cutPath} — finishing it…`);
    try {
      buf = "";
      scanner = makeFileLineScanner();
      const continuation =
        (await streamCompletion(buffered, [...baseMessages, ...buildContinuationTurns(cut)])) || "";
      closeFileStep();
      draft = mergeContinuation(draft, continuation);
      cut = findUnterminatedFileBlock(draft);
      ctx.stepDone("bcont", cut ? `${cut.path} is still incomplete` : "Finished the cut-off file");
    } catch (/** @type {any} */ err) {
      ctx.log.warn("sdk.continue_failed", { error: err?.message || String(err) });
      ctx.stepDone("bcont", `Couldn't finish ${cutPath}`);
    }
  }

  const files = parseFileBlocks(draft);
  const prose = stripFileBlocks(draft);
  if (!files.length) {
    if (cut) {
      // A build that produced nothing complete. The half-written file is NOT
      // shown — that is feedback #30's whole complaint.
      if (prose) emitChunked(ctx, prose);
      emitChunked(ctx, sdkCutOffNote(cut.path, false));
      ctx.stepDone("synth", `Build cut off inside ${cut.path} — nothing published`);
      return;
    }
    // No build in the draft — a plain reply; show it unchanged.
    emitChunked(ctx, draft);
    ctx.stepDone("synth", "Replied without building files");
    return;
  }
  const published = await publishSdkFiles(ctx, files, sdkBuildTitle(ctx));
  ctx.stepDone(
    "synth",
    published ? `Built and published ${published.files} file${published.files === 1 ? "" : "s"} → ${published.url}` : "Build produced files but publishing was unavailable",
    buildFilesSummary(files),
  );
  if (prose) emitChunked(ctx, prose);
  emitChunked(ctx, sdkReplyTail(prose, published));
  // Complete files shipped, one didn't: say which, rather than leaving a build
  // that silently lacks a file the reply talks about.
  if (cut) emitChunked(ctx, sdkCutOffNote(cut.path, !!published));
}

/** @param {PipelineCtx} ctx */
// ---- forced auxiliary sources on the source-research path -------------------
//
// An agent built AROUND a search source declares it in `state.forceAux`, and
// the research path honours that on every wave (runAuxSearch). This path never
// reaches a wave — it answers from the site's own source — so the declaration
// used to be silently dropped whenever developer mode was on at the same time.
// The Models agent is exactly that combination, and it made the mode whose
// identity IS the model hub answer model questions without ever asking the hub
// (feedback #36: "none of these questions resulted in hugging face being
// searched, which is weird since this is the Models agent"; chat_logs #670 and
// #671 both recorded 0 searches / 0 sources).
//
// So the forced sources run here too, BEFORE the investigation: the items join
// the same registry the research path fills, and the returned block puts them
// in front of both answer paths. Generic by construction — ids come off the
// state and this function names none of them. Fail-soft like every helper
// phase (invariant 2): no forced source, no usable query, or a source that
// throws leaves the turn a plain source-research answer.

/**
 * The query batch for a forced aux search on a path that never ran triage.
 * The recent USER turns, newest first, so a source's own pickQuery can prefer
 * whichever carries the entities — a contentless follow-up ("verify this")
 * has no search terms of its own, but the turn it refers to does.
 * @param {PipelineCtx} ctx
 * @returns {string[]}
 */
function auxQueryBatch(ctx) {
  /** @type {string[]} */
  const out = [];
  const push = (/** @type {string} */ t) => {
    const s = String(t || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (s && !out.includes(s)) out.push(s);
  };
  // The CLEAN latest message: the enrichments append their context blocks to
  // that message only, and a hub search on the injected source excerpt would
  // be a search for this repo's own prose.
  push(ctx.cleanLastUser);
  for (let i = ctx.conversation.length - 2; i >= 0 && out.length < 3; i--) {
    const m = ctx.conversation[i];
    if (m?.role === "user") push(textOf(m.content)); // earlier turns carry no injected block
  }
  return out;
}

/**
 * Run the state's forced auxiliary sources once and return the labeled block
 * of what they found ("" when there is nothing to add).
 * @param {PipelineCtx} ctx
 * @returns {Promise<string>}
 */
async function runForcedAuxSearches(ctx) {
  const { state } = ctx;
  const forced = Array.isArray(state.forceAux) ? state.forceAux : [];
  // The agent's own declaration still outranks the force: an agent that says
  // it uses no auxiliary sources uses none (same rule as runAuxSearches).
  if (!forced.length || !searchPolicyFor(state).auxSources) return "";
  const batch = auxQueryBatch(ctx);
  if (!batch.length) return "";
  for (const source of SEARCH_SOURCES) {
    if (!forced.includes(source.id)) continue;
    // A forced source the answering agent may not consult (registry
    // `requiresContext`) is not run: `forceAux` is a per-request instruction an
    // enrichment writes, and the agent's own declaration outranks it — the same
    // ordering the `auxSources` check above applies. planAuxSource refuses it
    // too, so this is belt-and-braces; it is spelled out here because the
    // forced path is the one that reaches a source WITHOUT its intent gate, and
    // a reader of this loop should not have to go two calls deep to learn that
    // the roster still governs it (owner directive, 2026-08-13).
    if (!sourceAllowed(state, source)) continue;
    await runAuxSearch(ctx, source, batch, 1);
  }
  const digest = sourceDigest(state.sources, state.plan.digestCap);
  if (!digest) return "";
  return `External sources retrieved for this question (cite these as [n]; the file reads below are NOT numbered sources):\n${digest}`;
}

/** @param {PipelineCtx} ctx */
async function runSourceResearch(ctx) {
  const { state } = ctx;
  const snapshot = /** @type {any} */ (state).sourceSnapshot;
  ctx.step("plan", "Analyzing request…");
  ctx.stepDone("plan", "Researching the site's own source — web search skipped");

  // A mode built AROUND an auxiliary source keeps that source even here.
  // Runs BEFORE the snapshot check so every exit below — including the
  // no-snapshot direct reply — answers with it.
  const auxBlock = await runForcedAuxSearches(ctx);

  if (!snapshot || !Array.isArray(snapshot.files) || !snapshot.files.length) {
    // No readable snapshot — answer from the excerpts the enrichment already
    // injected (still hasSource), exactly the pre-read-loop behavior. With the
    // forced sources, per the comment above: the promise that "every exit
    // below answers with it" was prose only until the block was threaded here.
    return runDirectReply(ctx, auxBlock);
  }

  // Native tool-use path (owner-authorized invariant-1 exception, 2026-07-12):
  // when the ANSWER model supports real function calling (Claude), it drives the
  // investigation ITSELF with grep_source/read_file/list_files tool calls
  // (src/introspect-tools.js) instead of the deterministic Mistral read loop
  // below. Fail-soft — any failure falls through to the deterministic path, so
  // catalog models without tool use (and Claude when its API blips) still work.
  const toolsOn = introspectionToolsAvailable(ctx);
  ctx.log.info("introspect.tools_gate", {
    on: toolsOn,
    model: ctx.model,
    anthropic_model: isAnthropicModel(ctx.model),
    anthropic_configured: anthropicConfigured(ctx.env),
    images: ctx.imageParts.length,
  });
  if (toolsOn) {
    try {
      return await runSourceResearchTools(ctx, snapshot, auxBlock);
    } catch (/** @type {any} */ err) {
      ctx.log.warn("introspect.tools_failed", { model: ctx.model, error: err?.message || String(err) });
      // fall through to the deterministic read loop
    }
  }

  const sitemap = buildSourceSitemap(snapshot);
  const budget = { used: 0 };

  // Demonstrative back-reference ("read those" / "do that", EN+SV): the planner
  // can't infer a contentless "those", so resolve it here — pull the file paths
  // the most recent prior assistant turn named and pre-read them, seeding the
  // loop. Without this the loop reads nothing and the answer becomes a
  // hallucinated "I read them". Fail-soft: no gate match / no named paths → the
  // normal planner behavior (seedReads stays []).
  /** @type {Array<{ p: string, text: string, bytes?: number, truncated?: boolean }>} */
  let seedReads = [];
  if (backReferenceIntent(ctx.cleanLastUser)) {
    const priorAssistant = ctx.conversation
      .filter((m) => m.role === "assistant")
      .map((m) => textOf(m.content))
      .reverse(); // most recent first
    const seedPaths = resolveReferencedPaths(priorAssistant, snapshot, MAX_FILES_PER_ROUND);
    if (seedPaths.length) seedReads = readSnapshotFiles(snapshot, seedPaths, new Set(), budget);
  }

  ctx.step("source", "Reading the site's own source…");
  const reads = await runSourceReadLoop({
    maxRounds: MAX_SOURCE_READ_ROUNDS,
    initial: seedReads,
    // One agent turn: ask the reliable JSON model which files to read next.
    step: async (priorReads, round) =>
      jsonPhase(ctx, {
        label: `source_read_${round}`,
        statKey: "triage",
        maxTokens: 500,
        messages: [
          { role: "system", content: phasePrompt(ctx.state, "source-research", "plan")({ reinforceJsonOnly: ctx.reinforceJsonOnly }) },
          {
            role: "user",
            // CLEAN question/context (not the excerpt-appended lastUser/convText):
            // the planner must decide reads from the user's ACTUAL ask, not from
            // the pre-loaded excerpts — otherwise it reads nothing and the answer
            // becomes a summary of those excerpts.
            content: buildSourceStepMessage({
              question: ctx.cleanLastUser,
              context: ctx.cleanConvText,
              sitemap,
              priorBlock: buildSourceResearchBlock(priorReads),
            }),
          },
        ],
      }),
    // Resolve the requested paths out of the snapshot (fail-soft, budget-bounded).
    read: async (paths, alreadyRead) => readSnapshotFiles(snapshot, paths, alreadyRead, budget),
  });

  if (!reads.length) {
    // The model didn't need to read any files (e.g. a non-implementation
    // question asked while dev mode happens to be on). Answer from the excerpts
    // the enrichment already injected — the pre-read-loop behavior — plus any
    // forced auxiliary sources, which the user is ALREADY being shown in the
    // source panel and which this exit used to drop on the floor.
    ctx.stepDone("source", "Answered from the retrieved excerpts");
    return runDirectReply(ctx, auxBlock);
  }
  ctx.stepDone(
    "source",
    `Read ${reads.length} source file${reads.length === 1 ? "" : "s"} from the project`,
    [
      ...(seedReads.length
        ? [`resolved back-reference → ${seedReads.map((r) => r.p).join(", ")}`]
        : []),
      ...reads.map((r) => r.p).slice(0, 40),
    ],
  );

  // Synthesis: stream the answer on the user's chosen model, grounded in the
  // files gathered above plus the excerpts/orientation already in the
  // conversation. No web sources, so no numbered-source validation phase.
  const gathered = buildSourceResearchBlock(reads);
  const synthText =
    `Question:\n${ctx.lastUser}\n\nConversation context:\n${ctx.convText}\n\n` +
    (gathered ? `${gathered}\n\n` : "") +
    (auxBlock ? `${auxBlock}\n\n` : "") +
    "Write the answer now, grounded in the project's ACTUAL source code above and in the conversation context. Cite file paths for every claim about the implementation, and verify against the code rather than the repo's own documentation." +
    (auxBlock ? " Use the external sources for facts that live OUTSIDE this repository, citing them as [n]." : "");
  ctx.step("synth", "Writing report…");
  const synthStartedAt = Date.now();
  await streamCompletion(ctx, [
    { role: "system", content: phasePrompt(ctx.state, "source-research", "answer")({ externalSources: !!auxBlock, capability: ctx.state.capability }) },
    {
      role: "user",
      content: ctx.imageParts.length ? [{ type: "text", text: synthText }, ...ctx.imageParts] : synthText,
    },
  ]);
  recordPhase(ctx.model, "synth", Date.now() - synthStartedAt);
  ctx.stepDone("synth", "Report drafted");
}

// Phase 2.75 — sub-question fan-out (roadmap §5.5's full form; OFF behind
// budget.js's SUBQ_FANOUT_ENABLED pending bench-gate evidence). For
// comparison/survey questions at the long tiers, the sub-questions stand
// alone, so their coverage audits don't need the serial gap cascade: one
// bounded JSON audit per sub-question runs CONCURRENTLY (each auditing ONLY
// its own sub-question against the shared registry), then ONE merged
// follow-up wave. multihop is deliberately excluded — its sub-questions are
// dependency-ordered (hop 2's query needs a bridging fact surfaced by hop
// 1's sources), which is exactly what runGapChecks's serial rounds exist
// for; those still run after this phase and catch integration gaps. The
// wave stays deterministic: queries merge round-robin in sub-question order
// (mergeFanoutQueries), and runSearches processes results in query order,
// so source numbering is stable regardless of fetch completion order.
// Fail-soft like every helper phase: a failed audit contributes no queries,
// and no queries means the phase quietly did nothing.
const MAX_FANOUT_SUBQUESTIONS = 4;
const FANOUT_QUERIES_PER_SUBQUESTION = 2;

/**
 * May this request's sub-questions be audited CONCURRENTLY? Task shape decides,
 * not difficulty (docs/AGENTIC-GRAPHS.md §3): parallelising decomposable work
 * pays, and parallelising dependency-ordered work costs — so the wrong answer
 * here is expensive in both directions.
 *
 * Triage now answers it directly via `decomposition`, which is why this
 * function exists. When that field is absent (older model output, a schema
 * miss, or a lenient-extraction path that dropped it) it falls back to
 * inferring shape from `complexity` — the comparison/survey proxy the phase
 * used before the field existed, so behaviour degrades to exactly what it was.
 *
 * `multihop` is refused on BOTH paths regardless of what the classifier said:
 * hop 2's query needs a bridging fact from hop 1's sources, so a concurrent
 * audit of hop 2 is auditing a question that cannot be searched yet. That is
 * runGapChecks's serial rounds' job, and a classifier that says otherwise is
 * wrong rather than permissive.
 * @param {{complexity?: string | null, decomposition?: string | null}} state
 * @returns {boolean}
 */
export function subquestionsAreIndependent(state) {
  if (state.complexity === "multihop") return false;
  if (state.decomposition === "independent") return true;
  if (state.decomposition === "sequential") return false;
  return state.complexity === "comparison" || state.complexity === "survey";
}
/** @param {PipelineCtx} ctx */
async function runSubquestionFanout(ctx) {
  // The planning view — this phase writes follow-up queries (feedback #65).
  const { log, state, reinforceJsonOnly, planLastUser: lastUser, planConvText: convText } = ctx;
  const plan = state.plan;
  if (!wantsSubqFanout(plan)) return;
  if (!subquestionsAreIndependent(state)) return;
  const subqs = (state.subquestions || []).slice(0, MAX_FANOUT_SUBQUESTIONS);
  if (subqs.length < 2) return;
  if (state.searchCount >= plan.maxSearches) return;
  const est = plan.estimates;
  // Wall-clock cost of the whole fan-out is ONE audit + ONE wave (audits run
  // in parallel), so the deadline math matches a single gap round.
  const upcoming = est.gap + 2 * est.search + est.synth + (plan.validate ? est.validate : 0);
  if (!fitsDeadline(state.startedAt, plan.budgetMs, upcoming)) {
    log.info("chat.budget_cut", { cut: "subq_fanout" });
    return;
  }
  ctx.step("fanout", `Checking coverage per sub-question (${subqs.length} in parallel)…`);
  const audits = await Promise.all(
    subqs.map((sq) =>
      jsonPhase(ctx, {
        label: "subq_fanout",
        statKey: "gap",
        maxTokens: 300,
        messages: [
          {
            role: "system",
            content: gapPrompt([...state.ranQueries], FANOUT_QUERIES_PER_SUBQUESTION, {
              subquestions: [sq],
              reinforceJsonOnly,
              // Same reason as the triage call site: the follow-up queries are
              // written HERE, so the vocabulary this prompt teaches must be the
              // vocabulary of the sources this agent may consult.
              capability: /** @type {any} */ (state).capability || null,
            }),
          },
          {
            role: "user",
            content:
              `Research question (latest user message):\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
              `Audit coverage of THIS sub-question only:\n${sq}\n\n` +
              notesSection(state.notes) +
              `Sources collected so far:\n${sourceDigest(state.sources, plan.digestCap) || "(none)"}`,
          },
        ],
      }),
    ),
  );
  const queryLists = audits.map((raw) => {
    const gap = hardenJson(GAP_SCHEMA, raw);
    collectConflicts(state, gap);
    if (!gap || gap.complete || !Array.isArray(gap.queries)) return [];
    return gap.queries.slice(0, FANOUT_QUERIES_PER_SUBQUESTION);
  });
  const followups = mergeFanoutQueries(queryLists, Math.max(0, plan.maxSearches - state.searchCount));
  if (!followups.length) {
    ctx.stepDone("fanout", "Sub-question coverage sufficient");
    return;
  }
  ctx.stepDone(
    "fanout",
    `Digging deeper: ${followups.length} sub-question search${followups.length === 1 ? "" : "es"}`,
    followups,
  );
  state.iterations++;
  await runSearches(ctx, followups, state.iterations);
  await maybeDigest(ctx);
}

// Phase 3: audits source coverage and runs follow-up searches for the most
// important gaps, up to plan.gapIterations rounds or until the time budget
// won't allow another round.
/** @param {PipelineCtx} ctx */
async function runGapChecks(ctx) {
  // The planning view — this phase writes follow-up queries (feedback #65).
  const { log, state, reinforceJsonOnly, planLastUser: lastUser, planConvText: convText } = ctx;
  const plan = state.plan;
  const est = plan.estimates;

  // Gap-strive (budget.js wantsGapStrive, feedback #16): at a deep tier with
  // most of the budget unspent, a "coverage sufficient" verdict is challenged —
  // the NEXT round's gap prompt gets the wider-aperture strive block instead of
  // the loop stopping. Bounded by GAP_STRIVE_MAX, the round ceiling, the
  // deadline check below, and the no-new-sources saturation exit.
  let strive = false;
  let strives = 0;
  for (let it = 1; it <= plan.gapIterations; it++) {
    if (state.searchCount >= plan.maxSearches) break;
    // Skip further digging if this round plus the remaining mandatory
    // phases would blow the time target.
    const upcoming = est.gap + 2 * est.search + est.synth + (plan.validate ? est.validate : 0);
    if (!fitsDeadline(state.startedAt, plan.budgetMs, upcoming)) {
      log.info("chat.budget_cut", { cut: "gap_iteration", round: it });
      break;
    }
    const stepId = `gap${it}`;
    ctx.step(stepId, strive ? `Checking coverage (round ${it}, digging deeper)…` : `Checking coverage (round ${it})…`);

    const gapRaw = await jsonPhase(ctx, {
      label: `gap_check_${it}`,
      statKey: "gap",
      recordStat: true,
      maxTokens: 400,
      messages: [
        // `capability` for the same reason as the triage call site above — the
        // gap round is where the follow-up queries are written, so it is the
        // second place a planner could be taught a corpus it cannot reach.
        { role: "system", content: gapPrompt([...state.ranQueries], plan.followups, { subquestions: state.subquestions || [], reinforceJsonOnly, strive, capability: /** @type {any} */ (state).capability || null }) },
        {
          role: "user",
          // convText rides along so a bare follow-up ("what's the latest")
          // is audited against the original question's breadth, not just
          // the sub-topic the collected sources already cluster on.
          content:
            `Research question (latest user message):\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
            // Distilled notes ride along when the digest phase ran (mid/high
            // tiers only) so coverage is audited against claims, not just raw
            // highlights. Empty (and thus absent) at the default budget.
            notesSection(state.notes) +
            `Sources collected so far:\n${sourceDigest(state.sources, plan.digestCap) || "(none)"}`,
        },
      ],
    });
    const gap = hardenJson(GAP_SCHEMA, gapRaw);
    collectConflicts(state, gap);

    const followups = (!gap || gap.complete || !Array.isArray(gap.queries))
      ? []
      // Same focus as triage's (feedback #65): a later round must not go back
      // to searching the report standard the first round was steered off.
      : focusQueriesOnSubject(
          gap.queries.filter((/** @type {any} */ q) => typeof q === "string" && q.trim()),
          { cleanText: ctx.cleanConvText, methodApplied: methodBlocksApplied(state) },
        ).queries.slice(0, plan.followups);

    if (followups.length === 0) {
      // Deep budget, mostly unspent, first "sufficient" verdict(s): challenge
      // the judgment with the strive prompt on the next round instead of
      // settling (feedback #16). A strive round that ALSO comes back empty
      // falls through here with the push budget spent and ends the loop.
      if (wantsGapStrive(plan, Date.now() - state.startedAt, strives)) {
        strives++;
        strive = true;
        ctx.stepDone(stepId, "Coverage looks sufficient — deep budget, challenging that");
        log.info("chat.gap_strive", { round: it, strives });
        continue;
      }
      ctx.stepDone(stepId, "Coverage sufficient");
      break;
    }
    strive = false;
    ctx.stepDone(
      stepId,
      `Digging deeper: ${followups.length} follow-up search${followups.length === 1 ? "" : "es"}`,
      followups,
    );
    state.iterations++;
    const foundBefore = sourceProgress(state);
    const admittedBefore = state.sources.length;
    await runSearches(ctx, followups, state.iterations);
    await maybeDigest(ctx);
    // Meaningful-action guarantee: the raised deep-tier round ceiling is only
    // worth spending while each round still finds NEW ground. If a whole
    // follow-up wave surfaced nothing at all — every URL already known,
    // whether admitted or capped, or the registry full — we've reached "there
    // isn't more to explore" — stop rather than spin further rounds against
    // the same sources. Below the deep tiers the round cap is small enough
    // that this rarely fires; it's the safety valve that keeps the long
    // budgets honest.
    //
    // The signal is sourceProgress(), NOT sources.length. A wave whose finds
    // were all domain-capped leaves the registry unchanged while having found
    // genuinely new pages, and reading that as exhaustion stopped the research
    // early on exactly the questions that need it most: the ones whose answer
    // lives across many pages of one authoritative origin.
    const gained = sourceProgress(state) - foundBefore;
    log.info("chat.gap_round", {
      round: it,
      searches: state.searchCount,
      gained,
      admitted: state.sources.length - admittedBefore,
      capped: sourceProgress(state) - state.sources.length,
      sources: state.sources.length,
    });
    if (gained === 0) {
      log.info("chat.gap_saturated", { round: it, searches: state.searchCount });
      break;
    }
  }
}

// Phase 2.5 — notes digest. After a search wave, compress the NEW sources
// (those added since the last digest) into structured research notes so
// gap-check and synthesis reason over claims, not raw highlights. Runs on the
// cheap JSON model, ONLY at mid/high budget tiers (wantsNotes), and is dropped
// first under deadline pressure. Fully fail-soft: any failure advances the
// cursor and proceeds on the raw registry exactly as at the default budget.
/** @param {PipelineCtx} ctx */
async function maybeDigest(ctx) {
  const { state } = ctx;
  const plan = state.plan;
  if (!wantsNotes(plan)) return;
  state.notes ||= [];
  const start = state.notesCursor || 0;
  const fresh = state.sources.slice(start);
  if (!fresh.length) return;

  // Optional work: skip (dropped first) if this digest plus the remaining
  // mandatory phases would blow the deadline.
  const est = plan.estimates;
  const upcoming = (est.digest || 0) + est.synth + (plan.validate ? est.validate : 0);
  if (!fitsDeadline(state.startedAt, plan.budgetMs, upcoming)) {
    ctx.log.info("chat.budget_cut", { cut: "digest" });
    return;
  }
  // Advance the cursor up front so a failed digest doesn't retry the same
  // sources on the next wave (fail-soft: those sources just stay un-noted).
  state.notesCursor = state.sources.length;

  const freshDigest = sourceDigest(fresh, plan.digestCap);
  if (!freshDigest) return;
  // The one research phase that used to run silently, while `fanout` and
  // `contents` beside it both reported. That gap was invisible in the activity
  // trace and made introspection's pipeline map (public/js/pipeline-map.js)
  // draw a step that could never light, so the digest now announces itself the
  // same way every other phase does. Emitted only once the phase is definitely
  // running — every skip above returns before this point.
  ctx.step("digest", `Digesting ${fresh.length} new source${fresh.length === 1 ? "" : "s"} into notes…`);
  const priorEntities = notesEntities(state.notes).slice(0, 40);
  const result = await jsonPhase(ctx, {
    label: "digest",
    statKey: "digest",
    recordStat: true,
    maxTokens: 1500,
    messages: [
      { role: "system", content: notesPrompt(priorEntities, { reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      { role: "user", content: `New numbered sources:\n${freshDigest}` },
    ],
  });
  const incoming = extractNotes(result);
  if (incoming.length) state.notes = mergeNotes(state.notes, incoming);
  // Fail-soft like every other helper phase: an empty digest still closes its
  // step, so the trace never leaves a spinner running (invariant 2).
  ctx.stepDone(
    "digest",
    incoming.length
      ? `Noted ${incoming.length} claim${incoming.length === 1 ? "" : "s"} from the new sources`
      : "Nothing new worth noting from those sources",
  );
}

// Phase 3.5 — full-content fetch of the top sources (budget-gated, ≥240s
// tier). After the gap rounds, pull the FULL page text for the top few
// registry sources (Exa /contents) and digest each into notes — search
// highlights are short excerpts; a long budget can afford to read the whole
// page. Emits a visible step naming the fetch. Fully fail-soft: no key, a
// timeout, an error, or an empty result all degrade to the highlights already
// held. Dropped first under deadline pressure, before synthesis/validation.
/** @param {PipelineCtx} ctx */
async function maybeFullContentDigest(ctx) {
  const { env, log, state } = ctx;
  const plan = state.plan;
  if (!wantsFullContent(plan) || !state.sources.length) return;
  state.notes ||= [];
  const fetchedUrls = (state.fetchedUrls ||= new Set());

  const est = plan.estimates;
  const upcoming = (est.fetch || 0) + (est.digest || 0) + est.synth + (plan.validate ? est.validate : 0);
  if (!fitsDeadline(state.startedAt, plan.budgetMs, upcoming)) {
    log.info("chat.budget_cut", { cut: "full_content" });
    return;
  }

  // The top 2-4 registry sources we haven't already fetched.
  const urls = state.sources.slice(0, 4).map((s) => s.url).filter((u) => u && !fetchedUrls.has(u));
  if (!urls.length) return;

  ctx.step("contents", "Reading top sources in full…");
  let fetched = null;
  try {
    fetched = await fetchContents(env, urls, log);
  } catch (/** @type {any} */ err) {
    log.warn("chat.contents_failed", { error: err?.message || String(err) });
  }
  recordPhase(ctx.model, "fetch", fetched?.durationMs || 0);
  const results = fetched?.results || [];
  if (!results.length) {
    ctx.stepDone("contents", "Full text unavailable — using highlights");
    return;
  }
  for (const r of results) fetchedUrls.add(r.url);
  ctx.stepDone(
    "contents",
    `Read ${results.length} source${results.length === 1 ? "" : "s"} in full`,
    results.map((r) => r.title || r.url),
  );

  // Digest the full text into notes, mapping each URL back to its [n] number
  // so the notes' source_ids stay consistent with the registry.
  const blocks = results
    .map((r) => {
      const n = state.byUrl.get(r.url)?.n;
      const head = n ? `[${n}] ${r.title}` : r.title;
      return `${head}\n${r.url}\n${r.text}`;
    })
    .join("\n\n");
  const priorEntities = notesEntities(state.notes).slice(0, 40);
  const digestRes = await jsonPhase(ctx, {
    label: "content_digest",
    statKey: "digest",
    recordStat: true,
    maxTokens: 2000,
    messages: [
      { role: "system", content: notesPrompt(priorEntities, { reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      { role: "user", content: `Full text of the top sources (numbered as in the registry):\n${blocks}` },
    ],
  });
  const incoming = extractNotes(digestRes);
  if (incoming.length) state.notes = mergeNotes(state.notes, incoming);
}

// Phase 4: writes the source-grounded draft answer. Returns the full text.
/**
 * @param {PipelineCtx} ctx
 * @returns {Promise<string>}
 */
async function runSynthesis(ctx) {
  const { state, lastUser, convText, imageParts } = ctx;
  const plan = state.plan;
  backfillOverflowSources(state);
  ctx.step("synth", "Writing report…");
  const digest = sourceDigest(state.sources, plan.digestCap);
  // How many of the collected sources synthesis can actually READ. Nothing
  // recorded this before, which is why feedback #61 took a source-list diff to
  // diagnose: the answer was written from 15 sources, the reader was shown 35
  // underneath it, and no log said the two numbers differed. A shown count
  // below `sources` is now visible in chat_logs and correlates directly with
  // an answer that under-claims its own coverage.
  const shown = digestShownCount(state.sources, plan.digestCap);
  ctx.log.info("chat.digest_coverage", {
    shown,
    collected: state.sources.length,
    hidden: Math.max(0, state.sources.length - shown),
    cap: plan.digestCap,
  });
  /** @type {any} */ (state).digestShown = shown;
  const synthText =
    `Question:\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
    // Decomposition skeleton + reported source conflicts (both empty — and
    // absent — unless triage decomposed the question / a gap round flagged
    // disagreeing sources; see subquestionsSection/conflictsSection).
    subquestionsSection(state.subquestions) +
    conflictsSection(state.conflicts) +
    // What was actually searched, so "no source establishes this" can be told
    // apart from "we never looked" — and so an uncorroborated claim can name
    // the angles that came back empty (feedback #61; PERSON-RESEARCH.md §6).
    searchLedgerSection(/** @type {any} */ (state).issuedQueries) +
    // Notes preamble is present only when the digest phase ran (mid/high
    // tiers); byte-identical to before at the default budget.
    notesSection(state.notes) +
    // The bash-lite sandbox transcript (empty and absent unless the
    // experimental sandbox ran client-side for this request).
    (ctx.shellBlock ? `${ctx.shellBlock}\n\n` : "") +
    // The empty-registry case needs saying out loud. Measured on the
    // ground-truth battery (tests/DR-EVAL-FINDINGS.md, 2026-08-05): when the
    // searches came back with nothing, answers arrived carrying a full
    // numbered source list whose every URL was the literal string "URL", with
    // [1]…[10] cited throughout the prose. Every one of those was graded
    // CORRECT — the model knew the answer and dressed it in citation
    // furniture. An ungrounded answer that presents as sourced is the one
    // failure this product cannot have, and "use ONLY the numbered sources"
    // does not cover it when the list is empty.
    (digest
      ? `Numbered sources:\n${digest}`
      : "Numbered sources: NONE — the searches returned nothing usable.\n" +
        "There are no sources to cite, so do NOT write any [n] citation markers and do NOT write a Sources list. " +
        "Answer from general knowledge if you can, and say plainly that this answer is not backed by retrieved sources.") +
    `\n\nWrite the answer now.`;
  const synthStartedAt = Date.now();
  const draft = await streamCompletion(ctx, [
    // reportTier scales the OUTPUT's structure/comprehensiveness with the
    // slider (brief → standard → extended → full) — see budget.js
    // reportTierFor and prompts.js REPORT_TIER_STRUCTURE.
    { role: "system", content: phasePrompt(ctx.state, "research", "answer")({ hasShell: !!ctx.shellBlock, hasSource: !!ctx.hasSource, reportTier: plan.reportTier, spaceScene: ctx.spaceScene, demoSurface: ctx.demoSurface }) },
    {
      role: "user",
      content: imageParts.length ? [{ type: "text", text: synthText }, ...imageParts] : synthText,
    },
  ]);
  recordPhase(ctx.model, "synth", Date.now() - synthStartedAt);
  // Deterministic citation reconciliation — free, and the first time either
  // tier has checked that the answer's [n] markers name sources that exist.
  // Recorded, not enforced: a dangling marker is a finding for the validation
  // phase and the log, never a deterministic edit.
  const audit = citationAudit(draft, state.sources);
  ctx.log.info("chat.citation_audit", {
    cited: audit.cited.length,
    dangling: audit.dangling,
    unused: audit.unused.length,
    sources: state.sources.length,
  });
  state.citations = {
    cited: audit.cited.length,
    dangling: audit.dangling.length,
    unused: audit.unused.length,
  };
  ctx.stepDone("synth", "Report drafted");
  return draft;
}

// Phase 5: fact-checks the draft against sources. On "revise" the UI
// discards the draft and gets the corrected answer; on "pass" it stands;
// any other outcome (skipped by policy/budget, or this model's validate
// call failed to produce a usable verdict) keeps the draft as-is —
// deliberately fail-soft, never a fatal error.
/**
 * @param {PipelineCtx} ctx
 * @param {string} draft
 */
async function runValidation(ctx, draft) {
  const { log, state, jsonProfile } = ctx;
  const plan = state.plan;
  const est = plan.estimates;

  // Validation runs on the JSON model, so its skip policy comes from THAT
  // model's profile — a profile that skipped validation because its own JSON
  // was unreliable no longer applies once a reliable model does the check.
  if (jsonProfile.skipValidation) {
    log.info("chat.budget_cut", { cut: "validation_profile_skip" });
    ctx.step("validate", "Validation");
    ctx.stepDone("validate", "Validation skipped for this model");
    return;
  }
  const validateNow = plan.validate && fitsDeadline(state.startedAt, plan.budgetMs, est.validate);
  if (!validateNow) {
    log.info("chat.budget_cut", { cut: "validation", planned: plan.validate });
    ctx.step("validate", "Validation");
    ctx.stepDone("validate", `Validation skipped to meet the ${plan.budgetS}s time target`);
    return;
  }

  ctx.step("validate", "Validating claims against sources…");
  const digest = sourceDigest(state.sources, plan.digestCap);

  // High tiers (wantsClaimValidation): verify the draft claim-by-claim, each
  // against only the sources it cites, in parallel. Lower tiers keep the cheap
  // single whole-draft pass. The claim path falls back to the single pass if
  // it can't even extract claims. Both are fully fail-soft — any failure keeps
  // the draft unchanged (never a fabricated "unsupported").
  if (wantsClaimValidation(plan)) {
    const handled = await runClaimValidation(ctx, draft, digest);
    if (handled) return;
  }
  await runSinglePassValidation(ctx, draft, digest);
}

// The original single whole-draft fact-check: one JSON call that returns a
// pass/revise verdict. Kept as the tight-budget path AND the fallback when
// claim extraction can't produce claims. On "revise" the UI discards the draft
// and gets the corrected answer; any other outcome keeps the draft as-is.
/**
 * @param {PipelineCtx} ctx
 * @param {string} draft
 * @param {string} digest
 */
async function runSinglePassValidation(ctx, draft, digest) {
  const { lastUser } = ctx;
  const verdictRaw = await jsonPhase(ctx, {
    label: "validate",
    statKey: "validate",
    recordStat: true,
    // Scaled with the report tier: a "revise" verdict's revised_answer must
    // hold the COMPLETE corrected answer, so a full report needs more room.
    maxTokens: ctx.state.plan.validateMaxTokens || 3000,
    messages: [
      { role: "system", content: validatePrompt({ reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      {
        role: "user",
        content:
          `Research question:\n${lastUser}\n\nNumbered sources:\n${digest || "(none)"}\n\n` +
          // The deterministic half of check (2), already done exactly and for
          // free. The prompt asks a 24B model to scan every bracket in a
          // multi-kilobyte report while also doing three other checks; handing
          // it the offending numbers turns "find the problem" into "fix this
          // one". Empty string when the audit found nothing, so the prompt is
          // byte-identical to before on answers that are already clean.
          citationNote(citationAudit(draft, ctx.state.sources)) +
          `Draft answer:\n${draft}`,
      },
    ],
  });
  const verdict = hardenJson(VALIDATE_SCHEMA, verdictRaw);

  if (verdict?.verdict === "revise" && typeof verdict.revised_answer === "string" && verdict.revised_answer.trim()) {
    const issues = (Array.isArray(verdict.issues) ? verdict.issues : []).map(String).slice(0, 10);
    ctx.stepDone(
      "validate",
      `Fixed ${issues.length || "some"} issue${issues.length === 1 ? "" : "s"} found in fact-check`,
      issues,
    );
    ctx.emit({ status: { type: "discard_text" } });
    emitChunked(ctx, verdict.revised_answer.trim());
    recordValidation(ctx, "revise", issues.length, draft.length, verdict.revised_answer.trim().length);
  } else if (verdict?.verdict === "pass") {
    ctx.stepDone("validate", "All claims verified against sources");
    recordValidation(ctx, "pass", 0, draft.length, 0);
  } else if (verdict?.verdict === "revise") {
    // A "revise" verdict with no usable answer body used to fall into the
    // branch below and be reported as "inconclusive", throwing its issues
    // away. The draft is still the right thing to keep — but the fact-checker
    // did find something, and saying so is the difference between a phase that
    // was skipped and a phase that flagged problems it could not fix.
    const issues = (Array.isArray(verdict.issues) ? verdict.issues : []).map(String).slice(0, 10);
    ctx.stepDone("validate", "Fact-check flagged issues but the draft was kept as-is", issues);
    recordValidation(ctx, "revise_unusable", issues.length, draft.length, 0);
  } else {
    ctx.stepDone("validate", "Validation inconclusive — draft kept as-is");
    recordValidation(ctx, "unusable", 0, draft.length, 0);
  }
}

// The phase-5 outcome, recorded so the revise RATE becomes knowable. It never
// has been: the revised answer replaces the draft before anything is
// persisted, so `chat_logs` holds the rewrite with no trace that a rewrite
// happened, and no retrospective scan can recover it. Ranking the
// section-scoped-revision backlog item needs this number, and `draft_chars`
// vs `revised_chars` is a free proxy for how much a rewrite churns.
//
// Both halves matter and only one used to exist: the log line makes it visible
// LIVE, the state field makes it QUERYABLE afterwards — which is what the
// paragraph above is actually asking for. The field sat written-and-never-read
// until both chat-log rows picked it up (chat.js / mcp.js meta), so the revise
// rate was as unknowable as before.
/**
 * @param {PipelineCtx} ctx
 * @param {string} verdict
 * @param {number} issues
 * @param {number} draftChars
 * @param {number} revisedChars
 */
function recordValidation(ctx, verdict, issues, draftChars, revisedChars) {
  const row = { verdict, issues, draft_chars: draftChars, revised_chars: revisedChars };
  ctx.log.info("chat.validate_verdict", row);
  ctx.state.validation = row;
}

// Claim-level validation (high tiers): extract the draft's check-worthy claims
// (JSON), verify each against its cited sources (JSON, in parallel), and only
// revise if some are flagged. Returns true when it produced a verdict; false
// only when it couldn't extract claims (caller then runs the single pass).
// Fully fail-soft: a failed verify counts as SUPPORTED (never fabricates an
// issue), and a failed revision keeps the draft.
/**
 * @param {PipelineCtx} ctx
 * @param {string} draft
 * @param {string} digest
 * @returns {Promise<boolean>}
 */
async function runClaimValidation(ctx, draft, digest) {
  const { lastUser } = ctx;

  const extractRaw = await jsonPhase(ctx, {
    label: "claim_extract",
    statKey: "validate",
    // recordStat off: don't skew the `validate` EWMA with extract/revise
    // timings — the single-pass validate remains the canonical measurement.
    maxTokens: 2000,
    messages: [
      { role: "system", content: claimExtractionPrompt({ reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      { role: "user", content: `Numbered sources:\n${digest || "(none)"}\n\nDraft answer:\n${draft}` },
    ],
  });
  const claims = extractClaims(extractRaw);
  if (!claims.length) return false; // nothing to check claim-by-claim → fall back

  const verifications = await Promise.all(claims.map((c) => verifyClaim(ctx, c)));
  const issues = [];
  for (let i = 0; i < claims.length; i++) {
    if (verifications[i]?.verdict === "unsupported") {
      issues.push(verifications[i].issue || `Unsupported claim: ${claims[i].claim}`);
    }
  }

  if (!issues.length) {
    ctx.stepDone(
      "validate",
      `All ${claims.length} checked claim${claims.length === 1 ? "" : "s"} verified against sources`,
    );
    return true;
  }

  const issueList = issues.slice(0, 10);
  const reviseRaw = await jsonPhase(ctx, {
    label: "claim_revise",
    statKey: "validate",
    // Same tier scaling as the single-pass validate: the revised_answer must
    // hold the complete corrected report.
    maxTokens: ctx.state.plan.validateMaxTokens || 3000,
    messages: [
      { role: "system", content: revisePrompt({ reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      {
        role: "user",
        content:
          `Research question:\n${lastUser}\n\nNumbered sources:\n${digest || "(none)"}\n\n` +
          `Draft answer:\n${draft}\n\nFact-check issues to fix:\n${issueList.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
      },
    ],
  });
  const revised = hardenJson(REVISE_SCHEMA, reviseRaw);
  if (revised && typeof revised.revised_answer === "string" && revised.revised_answer.trim()) {
    ctx.stepDone(
      "validate",
      `Fixed ${issueList.length} issue${issueList.length === 1 ? "" : "s"} found in fact-check`,
      issueList,
    );
    ctx.emit({ status: { type: "discard_text" } });
    emitChunked(ctx, revised.revised_answer.trim());
    return true;
  }
  // Revision didn't produce a usable answer — keep the draft (fail-soft), but
  // surface the flagged issues so the run is honest about them.
  ctx.stepDone("validate", "Fact-check flagged issues but the draft was kept as-is", issueList);
  return true;
}

// Verifies one claim against ONLY the sources it cites (falls back to the full
// registry when it cites none). Fail-soft: an unparseable/missing verdict is
// treated as SUPPORTED, so a failed check never fabricates an "unsupported".
/**
 * @param {PipelineCtx} ctx
 * @param {Claim} claim
 * @returns {Promise<{ verdict: "supported" | "unsupported", issue?: string }>}
 */
async function verifyClaim(ctx, claim) {
  const { state } = ctx;
  const ids = Array.isArray(claim.source_ids) ? claim.source_ids : [];
  const cited = state.sources.filter((s) => ids.includes(s.n));
  const digest = sourceDigest(cited.length ? cited : state.sources, state.plan.digestCap);
  const raw = await jsonPhase(ctx, {
    label: "claim_verify",
    statKey: "claim",
    maxTokens: 400,
    messages: [
      { role: "system", content: claimVerifyPrompt({ reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      { role: "user", content: `Claim:\n${claim.claim}\n\nCited numbered sources:\n${digest || "(none)"}` },
    ],
  });
  const v = hardenJson(CLAIM_VERIFY_SCHEMA, raw);
  if (v?.verdict === "unsupported") {
    return { verdict: "unsupported", issue: typeof v.issue === "string" ? v.issue : "" };
  }
  return { verdict: "supported" };
}

// ---- internals -------------------------------------------------------------

// Runs one JSON planning phase end-to-end: the completeJson request on the
// fixed JSON model, usage accounting, the parse-mode/finish-reason diagnostic
// log, duration logging, and the fail-soft catch — every JSON phase (triage,
// gap check, digest, validation, the claim checks) follows this exact shape,
// so it's one helper instead of a near-identical block per call site.
// Returns the parsed value, or null on any failure so the pipeline can
// degrade instead of breaking. The phase's tokens go to state.jsonTotals so
// chat.js can bill them at the JSON model's rate.
//
// `label` is the specific label logged for this call (e.g. "gap_check_N" per
// round); `statKey` (budget.js's phase bucket: triage/gap/digest/validate/
// claim) resolves a per-model max_tokens override if model-profiles.js has
// one for the JSON model; `recordStat` additionally feeds the duration into
// the per-model rolling stats the budget planner uses — left off the claim
// extract/verify/revise calls so they don't skew the canonical `validate`
// (and other) EWMA measurements.
// The planning phases whose output is a SCHEMA rather than prose. Sampling
// entropy buys nothing when the answer is hardened against a schema anyway,
// and it costs plan stability: triage decides WHICH searches run, so its
// variance propagates into a different evidence base on every run. The bench
// ledger measures that cost — a candidate SD of 0.63 against the 0.27 that
// judge noise alone predicts, i.e. the answers vary run-to-run as much as the
// scoring does, which is what currently stops the gate attributing a real
// drift (tests/EVAL-BENCH-FINDINGS.md, 2026-07-31).
//
// `quiz` is deliberately NOT here. It runs through the same helper, but an
// identical quiz for identical sources is a worse quiz, not a more
// reproducible one.
const GREEDY_JSON_PHASES = new Set(["triage", "gap", "validate", "claim", "digest"]);

/**
 * @param {PipelineCtx} ctx
 * @param {{ label: string, statKey: string, messages: Conversation, maxTokens: number, recordStat?: boolean }} phase
 * @returns {Promise<any>} The parsed JSON value, or null on any failure.
 */
async function jsonPhase(ctx, { label, statKey, messages, maxTokens, recordStat = false }) {
  const startedAt = Date.now();
  try {
    const overrides = /** @type {Record<string, number> | null} */ (ctx.jsonProfile.maxTokensOverride);
    const max = overrides?.[statKey] ?? maxTokens;
    const r = await completeJson(ctx.env, messages, {
      model: ctx.jsonModel,
      maxTokens: max,
      ...(GREEDY_JSON_PHASES.has(statKey) ? { temperature: 0 } : {}),
    });
    addUsage(ctx.state.jsonTotals, r.usage);
    ctx.log.info("chat.json_diag", { phase: label, model: ctx.jsonModel, ...r.diagnostics });
    const duration_ms = Date.now() - startedAt;
    if (recordStat) recordPhase(ctx.jsonModel, statKey, duration_ms);
    ctx.log.info("chat.phase", { phase: label, model: ctx.jsonModel, duration_ms, ok: r.value != null });
    return r.value;
  } catch (/** @type {any} */ err) {
    ctx.log.warn("chat.phase_failed", {
      phase: label,
      model: ctx.jsonModel,
      duration_ms: Date.now() - startedAt,
      error: err?.message || String(err),
    });
    return null;
  }
}

// ---- search execution ----------------------------------------------------

// Queries within one round are independent, so they run concurrently
// (Promise.all) instead of one fetch at a time — a round 6 assessment
// found the sequential loop was leaving several seconds of wall-clock on
// the table per round for no reason, time better spent on actual depth.
// Results are processed back in original order so source numbering
// (citations) stays deterministic regardless of which fetch happens to
// resolve first.
/**
 * Phase 1.5 — direct web browsing of the URLs the latest user message named.
 *
 * A COMPLEMENT to the search index, never a replacement: it runs before the
 * first wave so the pages the user pointed at are numbered first and are in
 * front of every later phase (gap check, digest, synthesis, validation), and
 * the wave then runs exactly as it would have. Feedback #67 (chat_logs
 * #1729): five URLs were pasted with per-URL instructions, and the run
 * reported one of them "not retrieved by any of the angles run".
 *
 * Fail-soft in every branch (invariant 2) — a page that refuses, stalls or
 * returns something unreadable is one source fewer, never a broken chat.
 * @param {PipelineCtx} ctx
 * @param {string[]} urls the URLs the caller already extracted (it needs them
 *   before triage's branch, so they are not re-derived here)
 */
async function runNamedUrlReads(ctx, urls) {
  const { env, log, emit, state } = ctx;
  if (!urls?.length) return;

  // Rendered as a SEARCH card rather than a plain step, so the pages read
  // land in the research trail as the same expandable list of clickable
  // sources every other leg produces. The client pairs the two events on
  // `source|query`, so both must carry the identical pair — hence the label
  // is built once, from the count we have at the start.
  const label = `${urls.length} linked page${urls.length === 1 ? "" : "s"}`;
  const card = { round: 0, query: label, source: "named-urls", service: "Direct page read" };
  emit({ status: { type: "search_start", ...card } });

  let result = null;
  try {
    result = await readNamedUrls(env, log, urls);
  } catch (/** @type {any} */ err) {
    log.warn("chat.named_urls_failed", { error: err?.message || String(err) });
  }
  recordPhase(ctx.model, "fetch", result?.durationMs || 0);
  const items = result?.items || [];
  state.namedUrlCount = items.length;
  const finish = (/** @type {any[]} */ sources) =>
    emit({
      status: {
        type: "search_done",
        ...card,
        results: sources.length,
        duration_ms: result?.durationMs || 0,
        sources,
      },
    });
  if (!items.length) {
    // Nothing readable. The card still resolves — a leg that vanishes reads
    // as a leg that never ran, which is the visibility complaint in the same
    // feedback entry.
    finish([]);
    return;
  }
  // The registry and the digest are both capped, and these pages were asked
  // for BY NAME: widen both so a linked page cannot be pushed out by the
  // search results that follow it. Same reasoning (and the same feedback-#61
  // precedent) as the aux-source reserve in absorbAuxResult.
  widenPlanCapacity(state.plan, items.length);
  addSources(state, items);
  finish(items.map((i) => ({ title: i.title, url: i.url })));
}

/**
 * @param {PipelineCtx} ctx
 * @param {string[]} queries
 * @param {number} round 1 for the initial wave, then one per gap round.
 */
async function runSearches(ctx, queries, round) {
  const { log, state } = ctx;
  const policy = searchPolicyFor(state);
  const batch = takeSearchBatch(state, queries, policy.maxQueries ?? Infinity);
  if (!batch.length) return;

  // A source the user named as THE place to look LEADS this wave: the generic
  // web leg stands down and that source spends the wave's whole breadth. See
  // leadingSources for the rule and its fail-soft release.
  const lead = leadingSources(ctx);

  // The web-search knob gates EXA ONLY (owner directive 2026-07-18). The
  // auxiliary sources (HF Hub & co, startAuxSearches below) and the depth
  // budget that plans this wave are independent of it: with the knob off the
  // wave still runs the aux sources over the planned angles — depth governs
  // how deep the research goes over whatever sources ARE available. Only the
  // Exa leg (the query-to-a-third-party leg the knob is about) is skipped.
  const web = policy.web && !lead.length;

  // Planned and DISPATCHED before the Exa batch is awaited, so the two legs
  // overlap instead of queueing. They used to run strictly after it, which put
  // every aux source's latency straight onto the user's wall clock — one of
  // the three complaints in feedback #44 ("the arXiv searches took close to a
  // minute"). Results are still absorbed in a fixed order (web, then registry
  // order) so source numbering stays deterministic.
  //
  // …UNLESS this request declares `state.webAfterAux` (feedback #69), in which
  // case both legs are still DISPATCHED together — the latency lesson of #44
  // is not spent to buy the ordering — but the web leg is ABSORBED second, so
  // the registry numbers the auxiliary sources ahead of it. That is the whole
  // of the ordering: for an agent whose evidence is a corpus and whose web leg
  // only corroborates it, "the literature first, the web after" has to be true
  // of the numbered list the answer model reads, not merely of the order two
  // fetches were started in. Declared per request and read generically here —
  // core never learns which agent asked for it, the same seam as forceAux /
  // auxOnly.
  const webLast = state.webAfterAux === true;
  const auxWave = startAuxSearches(ctx, batch, round, lead);
  const webWave = web ? startWebLeg(ctx, batch, round) : null;
  if (webWave && !webLast) await webWave();
  const auxItems = await auxWave();
  if (webWave && webLast) await webWave();

  // Fail-soft on the lead itself (invariant 2): "only arXiv" must never become
  // "no sources at all". A leading source that contributed nothing releases
  // the lead — the web leg runs for this same batch, and later waves are
  // ordinary waves again.
  if (lead.length && !auxItems && policy.web) {
    state.auxLeadReleased = true;
    log.info("search.lead_released", { sources: lead, round });
    await runWebLeg(ctx, batch, round);
  }
}

/**
 * The Exa leg of one wave, dispatched and awaited in one go. The fail-soft
 * lead release is its only remaining caller — every ordinary wave goes through
 * startWebLeg so it can overlap the auxiliary sources.
 * @param {PipelineCtx} ctx
 * @param {string[]} batch
 * @param {number} round
 */
async function runWebLeg(ctx, batch, round) {
  await startWebLeg(ctx, batch, round)();
}

/**
 * Dispatch the Exa leg of one wave — every planned query, concurrently — and
 * return the awaiter that absorbs the results into the registry.
 *
 * Split in two for the same reason startAuxSearches is: the caller decides
 * WHEN the results land without deciding when the fetches start. Absorption is
 * what fixes a source's number, so an agent that wants its corpus numbered
 * ahead of the web (state.webAfterAux) can have that without either leg
 * waiting on the other.
 * @param {PipelineCtx} ctx
 * @param {string[]} batch
 * @param {number} round
 * @returns {() => Promise<void>}
 */
function startWebLeg(ctx, batch, round) {
  const { env, log, emit, state } = ctx;
  state.searchCount += batch.length;
  // ISSUED, not planned. `ranQueries` is written by takeSearchBatch before the
  // legs are chosen, so it also holds angles this wave never sent anywhere —
  // the web knob was off, or an aux source was leading and stood this leg
  // down. The search ledger handed to synthesis must be a record of what was
  // actually asked, or it invites the answer to attest to searches that never
  // happened. That is the same defect the ledger exists to prevent, so it is
  // not allowed to be the ledger's own bug.
  for (const query of batch) (state.issuedQueries ||= new Set()).add(query);
  // Every search event names its provider (`source` slug + `service` display
  // name): the client's cards must always make clear WHICH provider ran a
  // search — a user report showed hub and web searches rendering identically.
  for (const query of batch) emit({ status: { type: "search_start", round, query, source: "web", service: "Web search" } });
  // …and every search honours the source the user's "Exa web
  // search" setting selects (state.searchSource — "" = whatever the site is
  // configured to use).
  const running = Promise.all(
    batch.map((query) => webSearch(env, log, query, state.plan.searchDepth, { source: state.searchSource || "" })),
  );
  return async () => {
  const results = await running;
  for (let i = 0; i < batch.length; i++) {
    const query = batch[i];
    const result = results[i];
    recordPhase(ctx.model, "search", result.durationMs);
    // A cache hit (result.cached) cost nothing at Exa; count it so the user
    // isn't billed/quota-charged for a repeated search (chat.js subtracts
    // these when recording Exa cost and search usage). It still counts as a
    // logical search for the maxSearches cap and the activity UI — the angle
    // was still covered.
    if (result.cached) state.cachedSearchCount = (state.cachedSearchCount || 0) + 1;
    emit({
      status: {
        type: "search_done",
        round,
        query,
        source: "web",
        service: "Web search",
        results: result.resultCount,
        duration_ms: result.durationMs,
        sources: result.sources,
        cached: !!result.cached,
      },
    });
    addSources(state, labelWebItems(state, result.items));
  }
  };
}

/**
 * Stamp this request's web results with the standing caveat the request
 * declared for them (`state.webSourceNote`), as their FIRST highlight.
 *
 * The digest is what the answer model reads, so a caveat has to travel on the
 * source itself to be reliably applied to it — the same reasoning that puts
 * "Preprint, not peer-reviewed" at the head of every arXiv item rather than in
 * a prompt sentence about arXiv. An agent whose evidence is a peer-reviewed
 * corpus needs its web leg to arrive visibly labelled as the weaker thing it
 * is, or the numbered list flattens the distinction the agent exists to make.
 *
 * Generic: core reads a string off the state and never learns which agent set
 * it, or why. Most requests set nothing and the items pass through untouched.
 * @param {PipelineState} state
 * @param {import('./search-sources.js').SearchSourceItem[]} items
 * @returns {import('./search-sources.js').SearchSourceItem[]}
 */
export function labelWebItems(state, items) {
  const note = state.webSourceNote;
  if (typeof note !== "string" || !note.trim() || !Array.isArray(items)) return items || [];
  return items.map((item) => ({
    ...item,
    highlights: [note, ...(Array.isArray(item?.highlights) ? item.highlights : [])],
  }));
}

// Auxiliary search sources (src/search-sources.js) alongside a wave's Exa
// searches. Per source, per wave: fire only when the source's intent
// predicate matches the latest user message (an ordinary question costs
// nothing and shows no spurious activity), capped per request and deduped
// across waves by the source's normalized key (gap-round follow-ups often
// reduce to the same terms; a trace showed repeat hub searches returning
// zero new sources). Uses the wave's first planned query (the most on-topic
// angle; every planned query is self-contained per the triage rules), and
// runs AFTER the Exa batch is processed so source numbering stays
// deterministic.
//
// Emits ordinary search_start/search_done events (query labeled by the
// source) rather than a generic step: search_done is the event the client's
// source panel, buildResearchDebugJson, and the eval harnesses reconstruct
// the source registry from — a trace showed step-only results being
// invisible to all three (cited [n] in the answer but absent from every
// reconstructed registry, including the one the eval judge fact-checks
// against). Not counted into state.searchCount, so Exa billing/quota are
// untouched (aux sources are free; a future billed source must mirror
// Exa's cost accounting instead — see the add-research-source skill).
//
// Fully fail-soft: a source failure degrades to the Exa-only registry
// (search_done with 0 results). Platform-aware diversity keying in
// sources.js keeps the per-origin cap meaningful for admitted sources.
const MAX_AUX_SEARCHES_DEFAULT = 3;

// What one extra registry slot is worth in digest characters, used when an aux
// source's first contribution widens the registry (absorbAuxResult). Sized off
// the measured shape rather than guessed: a Europe PMC / Scholar block runs
// ~1,200-1,330 chars (title + url + provenance + authors capped at 180 by
// europepmc.js + abstract capped at 900), and a typical web block ~400-670. The
// larger figure is the right one to reserve — the sources that trigger the
// widening are the verbose ones.
const DIGEST_CHARS_PER_SOURCE = 1300;

// …and the ceiling that reserve may never push the digest past. Four aux
// sources reserving 8 slots each would otherwise add 41,600 chars on top of
// the full tier's 24,000 — roughly 18k tokens of digest. `DEFAULT_MODEL` is a
// 32k-context model and is selectable as an ANSWER model, and a synthesis
// context overflow is explicitly not failover-eligible (answer-stream.js): the
// turn returns "the conversation is too long" and no answer at all. Trading a
// few tail sources for a dead chat is a bad trade in both directions, so the
// reserve stops here. 36,000 leaves the full tier real room to grow (+50%)
// while keeping the digest near 9k tokens, well inside 32k alongside an 8,192
// token answer and the rest of the prompt.
const DIGEST_CAP_CEILING = 36_000;

/**
 * Widen the registry AND the digest by `n` sources' worth, clamped at the
 * ceiling.
 *
 * The two caps must move together or the reserve is a lie — see
 * DIGEST_CHARS_PER_SOURCE above for why (feedback #61: admitting more sources
 * without paying for their prose pushes the highest-numbered ones out of the
 * window unread). Both callers — the named-URL reads and the aux-source
 * reserve — wrote that pairing out by hand, which is one edit away from a
 * reserve that widens one cap and not the other.
 * @param {PipelineState['plan']} plan
 * @param {number} n
 */
function widenPlanCapacity(plan, n) {
  plan.maxSources += n;
  plan.digestCap = Math.min(plan.digestCap + n * DIGEST_CHARS_PER_SOURCE, DIGEST_CAP_CEILING);
}

/**
 * One planned aux search: which source runs which of the wave's angles, and
 * which attempt keys its own ladder should skip. Planning is separated from
 * running so the whole wave can be dispatched at once (and so the bookkeeping
 * — counts, cross-wave dedup — is committed in a deterministic order however
 * the fetches resolve).
 * @typedef {{ source: import('./search-sources.js').SearchSource, query: string, key: string, skipKeys: Set<string> }} AuxPlan
 */

/**
 * The sources LEADING this request: those the latest user message names as the
 * place to look (registry `leadIntent`). A leading source displaces the web
 * leg and spends the wave's whole breadth itself.
 *
 * Reported (feedback #44, 2026-07-27): "I explicitly asked for an arxiv search
 * but a lot of web search was done first for unknown reason — if asked for
 * arXiv explicitly, start there and do only arxiv unless called for
 * otherwise."
 *
 * Generic by construction, like the rest of the registry loop: the rule for
 * what counts as naming a source lives in that source's module, this reads
 * only ids. `auxLeadReleased` is the fail-soft latch runSearches sets when a
 * lead found nothing — after that the request is an ordinary one.
 * @param {PipelineCtx} ctx
 * @returns {string[]}
 */
function leadingSources(ctx) {
  const { state } = ctx;
  if (state.auxLeadReleased) return [];
  // An agent that declines the auxiliary sources cannot be led by one.
  if (!searchPolicyFor(state).auxSources) return [];
  // Read from the CLEAN, pre-enrichment message (see cleanLastUser's note, and
  // the quiz gate / externalSourceIntent above — the same bug class, a third
  // time). Leading stands the web leg down for the WHOLE request, so an
  // enrichment block that merely MENTIONS a source by name silently converts
  // an ordinary question into a source-led one. Reported as feedback #61
  // (chat_logs #1656, 2026-08-05): "Research this founder" plus a profile
  // screenshot. An enrichment appended its own ~700-word method block to the
  // user's message; that block's own prose names sources, a lead gate matched
  // one, and the web leg never ran — so a question about a person came back
  // led by a corpus that had nothing to say about them. The USER names the
  // source they want; prose this pipeline wrote to itself does not.
  const ids = leadSourceIds(ctx.gateLastUser);
  // …and a source the ANSWERING AGENT may not consult at all (the registry's
  // `requiresContext`, read by sourceAllowed) cannot lead it, for exactly the
  // reason the auxOnly filter below exists: leading stands the web leg down,
  // and a lead planAuxSource will then refuse to plan spends the wave on
  // nothing. This is the failure the roster split made reachable — after the
  // 2026-08-13 directive an agent that does not hold a corpus's context block
  // still MATCHED a message naming that corpus, led the turn on it, stood the
  // web leg down, and answered with no sources at all.
  const allowed = ids.filter((id) => {
    const source = SEARCH_SOURCES.find((s) => s.id === id);
    return !source || sourceAllowed(state, source);
  });
  // …and a source the request has narrowed away (state.auxOnly) cannot lead it
  // either, same reasoning one step further in: auxOnly is the per-request
  // narrowing an enrichment writes, `requiresContext` the standing one the
  // agent's own spec declares.
  const only = state.auxOnly;
  return Array.isArray(only) && only.length ? allowed.filter((id) => only.includes(id)) : allowed;
}

/**
 * Plan and DISPATCH this wave's auxiliary searches, returning the awaiter that
 * absorbs their results. Split in two so the caller can overlap them with the
 * Exa leg; call the returned function to finish the wave.
 * @param {PipelineCtx} ctx
 * @param {string[]} batch The wave's planned queries (already deduped/capped).
 * @param {number} round
 * @param {string[]} [lead] ids of the sources leading this request.
 * @returns {() => Promise<number>} resolves to the number of items contributed.
 */
function startAuxSearches(ctx, batch, round, lead = []) {
  // An agent may decline the auxiliary sources entirely (`search.auxSources:
  // false`) — the Se/cure spec does, because a client-tier agent has no
  // server-side source registry to reach. Every server-tier agent that gets
  // this far declares true, so the loop below is unchanged today.
  if (!searchPolicyFor(ctx.state).auxSources) return async () => 0;
  /** @type {AuxPlan[]} */
  const plans = [];
  for (const source of SEARCH_SOURCES) {
    plans.push(...planAuxSource(ctx, source, batch, lead.includes(source.id)));
  }
  return dispatchAuxPlans(ctx, plans, round);
}

/**
 * Fire a planned aux wave and hand back the awaiter that absorbs it.
 *
 * The dispatch half of every aux search, in one place: both entry points
 * (`startAuxSearches` over the whole registry, `runAuxSearch` over one source)
 * used to carry their own copy, including a byte-identical `search_start`
 * emit — so the provider-identity rule below was stated twice and could be
 * fixed in one of them.
 *
 * Absorption stays in PLAN ORDER however the fetches resolve, which is what
 * keeps source numbering deterministic across a wave.
 * @param {PipelineCtx} ctx
 * @param {AuxPlan[]} plans
 * @param {number} round
 * @returns {() => Promise<number>} awaiter resolving to the item count absorbed
 */
function dispatchAuxPlans(ctx, plans, round) {
  // The provider identity rides as source/service (not baked into the query
  // text): the client renders the service name on the card, so hub and web
  // searches are visibly distinct.
  for (const p of plans) {
    ctx.emit({ status: { type: "search_start", round, query: p.key || p.query, source: p.source.id, service: p.source.service } });
  }
  const running = plans.map((p) => runOneAuxSearch(ctx, p));
  return async () => {
    const results = await Promise.all(running);
    let items = 0;
    for (let i = 0; i < plans.length; i++) {
      absorbAuxResult(ctx, plans[i], results[i], round);
      items += results[i].items.length;
    }
    return items;
  };
}

/**
 * Which angles one source takes this wave, with its bookkeeping committed.
 * @param {PipelineCtx} ctx
 * @param {import('./search-sources.js').SearchSource} source
 * @param {string[]} batch
 * @param {boolean} leading
 * @returns {AuxPlan[]}
 */
function planAuxSource(ctx, source, batch, leading) {
  const { state } = ctx;
  // A source normally fires only when the message engages it. `state.forceAux`
  // is the one override: a mode whose whole identity IS a source (the agent
  // built around it) lists that source's id and it runs every turn. Generic by
  // construction — this reads ids off the state and never names one, exactly
  // like the rest of the registry loop.
  const forced = Array.isArray(state.forceAux)
    && state.forceAux.includes(source.id);
  // `state.auxOnly` is the mirror image and, unlike forceAux, purely
  // NARROWING: when present, only the listed source ids may run this request
  // at all — a source's own intent, and even a lead, cannot get it in.
  //
  // It exists because an agent can be defined by what it must NOT consult as
  // much as by what it must. The Deep Science agent's SCIENTIFIC evidence is
  // peer-reviewed publications; without this, arXiv would still fire on a
  // physics question and hand it preprints, which is precisely the thing that
  // agent promises not to do. Note that this narrows the AUXILIARY sources
  // only: since 2026-08-14 that agent also runs a web leg, behind the
  // literature and labelled as web reporting (state.webAfterAux /
  // webSourceNote), and auxOnly has nothing to say about it. Read generically
  // here — ids off the state, no source named — so it composes with any future
  // agent that needs the same restriction.
  const only = state.auxOnly;
  if (Array.isArray(only) && only.length && !only.includes(source.id)) return [];
  // …and the STANDING narrowing beside that per-request one: a source may
  // declare a `requiresContext` naming a context block the answering agent has
  // to hold (sourceAllowed above). Where auxOnly says "this turn consults only
  // these", this says "this corpus belongs to the agents built on it" — the
  // roster is specific and has no general member, so the literature legs answer
  // for Deep Science (all three) and the palaeogenomics agent (the life-science
  // one) and for nobody else (owner directive, 2026-08-13). Read generically —
  // one string off the entry, one list off the resolved capability, no source
  // named — and fail-soft: a request that resolved NO capability (the MCP
  // channel, an unreadable registry) keeps every source.
  if (!sourceAllowed(state, source)) return [];
  // Intent reads the CLEAN message too, for the reason spelled out in
  // leadingSources: enrichment blocks are prose this pipeline appended to the
  // user's own words, and a gate that matches them is answering a question
  // nobody asked. Feedback #61 is the worked example — a single topic word
  // inside an enrichment block's PRIVACY PROHIBITION ("never an inference of
  // ethnicity, health, religion…") satisfied a domain gate's subject test and
  // routed a person's career history to a corpus about something else. A gate
  // is a question about what the USER asked; keep it that way.
  if (!batch.length || (!forced && !leading && !source.intent(ctx.gateLastUser))) return [];
  state.aux ||= {};
  const st = (state.aux[source.id] ||= { count: 0, ran: new Set() });
  // How many searches this source gets THIS request. The source's own
  // maxPerRequest is the default; a LEADING source declares its own, higher
  // ceiling (leadMaxPerRequest — the web leg is standing down, so covering one
  // angle would leave the turn thinner than not leading at all); and
  // `state.auxMaxPerRequest` overrides both for a mode that leans on the
  // source harder than an incidental mention does (the Models agent —
  // feedback #36's "the Models pipeline should be even more inclined to search
  // hf for answers"). Read generically: ids come off the state, and the
  // cross-wave dedup below still stops repeat searches, so a raised cap buys
  // DISTINCT queries, never the same one twice.
  const override = state.auxMaxPerRequest?.[source.id];
  const declared = (leading ? source.leadMaxPerRequest ?? source.maxPerRequest : source.maxPerRequest);
  const cap = typeof override === "number" && override > 0 ? override : (declared ?? MAX_AUX_SEARCHES_DEFAULT);
  // A leading source takes as many of the wave's angles as its ceiling allows;
  // every other source takes one per wave, as before.
  const want = Math.max(0, leading ? cap - st.count : Math.min(1, cap - st.count));
  if (!want) return [];
  const keyOf = (/** @type {string} */ q) => (source.dedupKey ? source.dedupKey(q) : String(q).toLowerCase().trim());
  // Snapshot BEFORE this wave's keys are added: `skipKeys` tells the source
  // which search attempts earlier waves already consumed (its ladder skips
  // them — no re-fetching identical result sets), while the fresh keys
  // themselves must stay searchable this call.
  const before = new Set(st.ran);
  /** @type {{ source: import('./search-sources.js').SearchSource, query: string, key: string }[]} */
  const picks = [];
  // The wave's most on-topic angles for THIS source (pickQuery — arxiv scores
  // the planner's angles against what the user actually asked; hf prefers the
  // entity/identifier-bearing one, the web→hub insight flow); batch[0] when
  // the source doesn't care. Each pick is removed from the pool, so a leading
  // source's several searches are DISTINCT angles rather than the same one.
  let pool = batch.filter((q) => !st.ran.has(keyOf(q)));
  while (picks.length < want && pool.length) {
    const query = source.pickQuery ? source.pickQuery(pool, ctx.lastUser) : pool[0];
    const key = keyOf(query);
    pool = pool.filter((q) => keyOf(q) !== key);
    if (st.ran.has(key)) continue;
    st.ran.add(key);
    st.count++;
    picks.push({ source, query, key });
  }
  // A wave's picks run CONCURRENTLY, so each one's ladder must also skip its
  // siblings' keys — otherwise two of them can collapse onto the same rung and
  // fetch identical results. Built here rather than assigned in the loop above
  // and overwritten here, so `skipKeys` has exactly one writer: the sibling set
  // is not knowable until every pick is chosen.
  const picked = picks.map((p) => p.key);
  return picks.map((p) => ({ ...p, skipKeys: new Set([...before, ...picked.filter((k) => k !== p.key)]) }));
}

/**
 * Run one planned aux search. Fail-soft: a throwing source degrades to an
 * empty result, never an errored wave.
 * @param {PipelineCtx} ctx
 * @param {AuxPlan} plan
 * @returns {Promise<{ items: import('./search-sources.js').SearchSourceItem[], durationMs: number, usedKeys: string[] }>}
 */
async function runOneAuxSearch(ctx, plan) {
  const { env, log } = ctx;
  try {
    // `asked` is the CLEAN, pre-enrichment user message (gateLastUser), handed
    // to every source for the same reason pickQuery already gets it: a planned
    // angle is triage's paraphrase, and a source whose behaviour turns on what
    // the READER asked cannot read it off that paraphrase without inheriting
    // triage's word choices. Pre-enrichment for the reason leadingSources
    // documents at length — prose this pipeline appended to the message must
    // never be able to trip a gate the user did not trip themselves.
    const r = await plan.source.search(env, log, plan.query, { skipKeys: plan.skipKeys, asked: ctx.gateLastUser });
    // Provider spend the source reported (search-sources.js `spend`): the
    // hosted dense tiers cost Berget money per leg, and a request runs several
    // — multiple angles, two corpora, several gap rounds — so it ACCUMULATES
    // into the request's tally, which src/billing.js denseSpend prices once at
    // the end. Read generically off the result, like everything else in this
    // loop: the orchestrator never names a source. A source that reports none
    // (every source that has no hosted tier) leaves the tally untouched.
    mergeRetrievalSpend(ctx.state.denseTotals, r.spend);
    return { items: r.items || [], durationMs: r.durationMs || 0, usedKeys: r.usedKeys || [] };
  } catch (/** @type {any} */ err) {
    log.warn(`${plan.source.id}.search_failed`, { error: err?.message || String(err) });
    return { items: [], durationMs: 0, usedKeys: [] };
  }
}

/**
 * Absorb one finished aux search into the registry. Called in plan order, so
 * source numbering (citations) is deterministic however the fetches resolved.
 * @param {PipelineCtx} ctx
 * @param {AuxPlan} plan
 * @param {{ items: import('./search-sources.js').SearchSourceItem[], durationMs: number, usedKeys: string[] }} result
 * @param {number} round
 */
function absorbAuxResult(ctx, plan, result, round) {
  const { emit, state } = ctx;
  const st = /** @type {any} */ (state.aux)[plan.source.id];
  // Attempts the source consumed (hit or miss) — recorded so later waves
  // whose ladders would collapse to the same attempt skip it instead of
  // re-fetching the same repos (the three-identical-hub-searches trace).
  for (const k of result.usedKeys) st.ran.add(k);
  // An aux leg's query is an issued search too, and on a lead wave it may be
  // the ONLY thing issued — so the ledger would otherwise be empty on exactly
  // the requests where knowing what was asked matters most.
  (state.issuedQueries ||= new Set()).add(plan.key || plan.query);
  emit({
    status: {
      type: "search_done",
      round,
      query: plan.key || plan.query,
      source: plan.source.id,
      service: plan.source.service,
      results: result.items.length,
      duration_ms: result.durationMs,
      sources: result.items.map((i) => ({ title: i.title, url: i.url })),
    },
  });
  // Registry-capacity reserve (once per source): the wave's web results can
  // fill plan.maxSources BEFORE the aux items are absorbed — a probe showed
  // hub artifacts landing in overflow and never reaching the digest, so the
  // synthesis could not cite them at all for a question that explicitly
  // asked about the platform. The first time a source actually contributes
  // items, widen the registry by up to one search's worth so its results
  // compete for real slots instead of leftovers.
  if (result.items.length && !st.reserved) {
    st.reserved = true;
    // Widen the DIGEST in step, or the reserve is a lie. The digest is a
    // character budget filled in arrival order, so admitting more sources
    // without paying for their prose does not add them to what synthesis
    // reads — it pushes the same number of sources through a window that
    // did not move, and the ones that fall out are the highest-numbered,
    // i.e. exactly what the later gap rounds were run to find. Feedback #61
    // (chat_logs #1656): thirteen ~1,300-char paper blocks arrived first,
    // filled the window, and the answer reported that no independent press
    // coverage existed while Crunchbase News, First Round Review, a local
    // interview and the subject's own university page sat unread at [17]
    // through [26]. Absence of evidence is the one thing a research tool
    // must never invent, so the reserve now covers both caps.
    widenPlanCapacity(state.plan, Math.min(result.items.length, 8));
  }
  addSources(state, result.items);
}

/**
 * One source, one wave, awaited — the single-source entry point the
 * source-research path uses (it has no Exa leg to overlap with).
 * @param {PipelineCtx} ctx
 * @param {import('./search-sources.js').SearchSource} source
 * @param {string[]} batch
 * @param {number} round
 */
async function runAuxSearch(ctx, source, batch, round) {
  await dispatchAuxPlans(ctx, planAuxSource(ctx, source, batch, false), round)();
}

