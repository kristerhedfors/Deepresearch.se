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
// opt-in pre-pipeline context enrichments (Shodan, Google Maps) in
// enrichment.js, the JSON-phase schemas + triage normalization/fallback
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
  wantsNotes,
} from "./budget.js";
import {
  formatConversation,
  imagePartsOf,
  lastUserMessage,
  previousUserText,
  textOf,
  withAppendedText,
  withImageNudge,
} from "./conversation.js";
import { runEnrichments } from "./enrichment.js";
import { fetchContents, webSearch } from "./exa.js";
import { SEARCH_SOURCES } from "./search-sources.js";
import { getModelProfile } from "./model-profiles.js";
import { addUsage } from "./quota.js";
import { addSources, backfillOverflowSources, sourceDigest } from "./sources.js";
import { extractNotes, mergeNotes, notesEntities } from "./notes.js";
import {
  collectConflicts,
  conflictsSection,
  extractClaims,
  notesSection,
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
  normalizeTriage,
} from "./triage.js";
import {
  claimExtractionPrompt,
  claimVerifyPrompt,
  directPrompt,
  feedbackReplyPrompt,
  gapPrompt,
  notesPrompt,
  quizPrompt,
  revisePrompt,
  sdkBuildPrompt,
  sdkBuildToolPrompt,
  sweBuildPrompt,
  sweBuildToolPrompt,
  searchOffPrompt,
  sourceAgentPrompt,
  sourceAnswerPrompt,
  sourceToolAgentPrompt,
  synthPrompt,
  triagePrompt,
  validatePrompt,
} from "./prompts.js";
import { anthropicConfigured, anthropicToolRun, isAnthropicModel } from "./anthropic.js";
import { INTROSPECTION_TOOLS, runIntrospectionTool } from "./introspect-tools.js";
import {
  BUILD_TOOLS,
  BUILD_TOOL_NAMES,
  SDK_TOOLS,
  SDK_TOOL_NAMES,
  buildFilesSummary,
  buildSdkContextBlock,
  buildSweContextBlock,
  manifestFromSnapshot,
  parseFileBlocks,
  runSdkTool,
  sdkToolStepHeadline,
  snapshotFileCheck,
  stageBuildFile,
} from "./sdk-tools.js";
import { publishBuild, replyLinksTo } from "./build-pub.js";
import { feedbackIntent } from "./feedback.js";
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
 * @typedef {import('./types.js').RequestState & {
 *   plan: BudgetPlan,
 *   quizzes?: boolean,
 *   quiz?: object,
 *   complexity?: string | null,
 *   subquestions?: string[],
 *   conflicts?: string[],
 *   notes?: object[],
 *   notesCursor?: number,
 *   fetchedUrls?: Set<string>,
 *   aux?: Record<string, AuxSourceState>,
 *   failoverModel?: string,
 *   feedbackCapture?: boolean,
 *   feedback?: { comment: string, question: string | null, answer_excerpt: string | null, model: string },
 * }} PipelineState
 */

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
 *   lastUser: string,
 *   convText: string,
 *   cleanLastUser: string,
 *   cleanConvText: string,
 *   imageParts: import('./types.js').ContentPart[],
 *   emitDelta: (text: string) => void,
 *   step: (id: string, label: string) => void,
 *   stepDone: (id: string, label: string, details?: string[]) => void,
 * }} PipelineCtx
 */

/**
 * The triage verdict shape (normalizeTriage's output) — declared alongside
 * the JSON-phase schemas and the normalization/fallback logic in triage.js.
 * @typedef {import('./triage.js').TriageDecision} TriageDecision
 */

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
  /** @type {PipelineCtx['stepDone']} */
  const stepDone = (id, label, details = []) =>
    emit({ status: { type: "step_done", id, label, details } });

  // Opt-in context enrichments (src/enrichment.js's ENRICHMENTS registry:
  // Shodan, Google Maps — each gated by its per-user knob resolved in
  // chat.js). They run BEFORE any model call — and before the ctx build
  // below — so their labeled context blocks flow into every downstream
  // phase, triage included (ctx.lastUser / ctx.convText / ctx.imageParts
  // are all read from `convo`). Fully fail-soft — the conversation comes
  // back unchanged if there's nothing to look up or a service is down.
  // Feedback pipeline (feedback.js feedbackIntent): a message that opens with
  // "feedback" (EN+SV) is a report to the developers, not research. Detect it
  // BEFORE the enrichments so a feedback note that happens to mention an IP or
  // address doesn't fire a Shodan/Maps lookup on the way in. Gated on
  // state.feedbackCapture — set only by the /api/chat channel (chat.js), so the
  // MCP channel keeps researching. The capture itself (entry + chat-log tag) is
  // done by chat.js from state.feedback; runFeedbackCapture below just answers.
  const feedbackReq =
    !!state.feedbackCapture &&
    feedbackIntent(textOf(lastUserMessage(conversation)?.content));
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
    cleanConvText: formatConversation(conversation),
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
  // introspection): the user is reporting to the developers, so answer warmly
  // and let chat.js record it — never route it into research.
  if (feedbackReq) return runFeedbackCapture(ctx);

  let quizReq = state.quizzes ? quizIntent(ctx.cleanLastUser) : null;

  // Build modes — the green SDK ("lovable") mode and the khaki SWE ("prompt a
  // new instance of Se/cure") mode in the mode dropdown: the request asks for a
  // build flow, so it takes the whole answer phase (no web search, no triage —
  // the deliverable is a published app). Both are gated in chat.js on the
  // developer_mode capability and share the publish machinery; they differ only
  // in the flavor (prompts / context / tool set). Fully fail-soft inside.
  if (/** @type {any} */ (state).sdkMode) {
    return runSdkBuild(ctx, BUILD_FLAVORS.sdk);
  }
  if (/** @type {any} */ (state).sweMode) {
    return runSdkBuild(ctx, BUILD_FLAVORS.swe);
  }

  // Web search (Exa) off is the knob's ONLY effect — NOT "no research". Depth
  // still governs how deep we go over whatever sources ARE available (owner
  // directive 2026-07-18): developer mode's own-source investigation and the
  // auxiliary search sources (HF Hub, …) run regardless of the knob, and
  // runSearches skips only the Exa leg. Fall through to the normal research
  // path whenever one of those applies. Only when NONE does is there nothing
  // external to consult — then answer from the model, with the slider's report
  // tier still scaling that answer (runWithoutSearch).
  if (!state.webSearch) {
    if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
    if (!ctx.hasSource && !SEARCH_SOURCES.some((s) => s.intent(ctx.lastUser))) {
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
  if (ctx.hasSource && !externalSourceIntent(ctx.cleanLastUser)) {
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
  if (decision.action === "direct") {
    // Quiz from the material already in front of us (conversation, attached
    // documents, project materials) — triage decided no web sources needed.
    if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
    return runDirectReply(ctx);
  }
  if (decision.action === "clarify") return runClarify(ctx, decision.question);

  // ---- Phase 2: initial search wave -------------------------------------
  await runSearches(ctx, decision.queries, 1);
  // Quiz from web research: one search wave gathers the material, then the
  // quiz IS the answer — gap rounds, synthesis, and validation don't apply
  // (nothing streams that could be fact-checked; the quiz's own prompt pins
  // every question to the collected sources). On failure, fall through and
  // the searches feed the normal research answer instead.
  if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
  // ---- Phase 2.5: notes digest (budget-gated, mid/high tiers) ------------
  await maybeDigest(ctx);
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

// Fail-soft acknowledgment if the feedback reply model produced no text at all
// (rare). EN only — this is a degraded path; the model handles EN/SV itself on
// the normal path.
const FEEDBACK_ACK_FALLBACK =
  "Thank you — your feedback has been passed on to the developers, who read every submission. If a reply is needed, it will appear under Feedback in your account panel.";

// The feedback case (routed at the top of runPipeline): the user's message is
// feedback for the developers. Stash the report on the state so chat.js can
// persist it as a feedback entry (the Claude Code work queue) AND tag the
// chat-log row, then stream a short, warm acknowledgment. No search, no
// sources, no validation — the fix is the developers' job, off the site. The
// report is stashed BEFORE the model call so chat.js still records it even if
// the acknowledgment stream fails.
/** @param {PipelineCtx} ctx */
async function runFeedbackCapture(ctx) {
  const { state } = ctx;
  ctx.step("plan", "Feedback…");
  ctx.stepDone("plan", "Sending your feedback to the developers");
  // The message IS the comment; the prior turn (the question it followed and
  // the reply it comments on) rides along so the developer sees the context.
  const priorAssistant = [...ctx.conversation].reverse().find((m) => m.role === "assistant");
  state.feedback = {
    comment: ctx.cleanLastUser,
    question: previousUserText(ctx.conversation) || null,
    answer_excerpt: (textOf(priorAssistant?.content) || "").slice(0, 8000) || null,
    model: ctx.model,
  };
  const draft = await streamCompletion(ctx, [
    { role: "system", content: feedbackReplyPrompt() },
    ...withImageNudge(ctx.conversation),
  ]);
  if (!(draft || "").trim()) emitChunked(ctx, FEEDBACK_ACK_FALLBACK);
}

/** @param {PipelineCtx} ctx */
async function runWithoutSearch(ctx) {
  ctx.step("plan", "Web search off");
  ctx.stepDone("plan", "Web search off — answering from model knowledge");
  // No external source applied, so this answers from the model — but the depth
  // slider still scales the answer's comprehensiveness via the report tier
  // (searchOffPrompt's sourceless depth ladder; default "standard" is the
  // long-standing byte-identical prompt).
  await streamCompletion(ctx, [
    { role: "system", content: searchOffPrompt({ hasShell: !!ctx.shellBlock, hasSource: !!ctx.hasSource, reportTier: ctx.state.plan.reportTier }) },
    ...shellReplyMessages(ctx.shellBlock),
    ...withImageNudge(ctx.conversation),
  ]);
}

// Phase 1: decide direct reply | clarifying question | research plan, and
// announce the decision via the "plan" step. For "research" the returned
// queries are already capped to the budget plan's angle count.
/**
 * @param {PipelineCtx} ctx
 * @returns {Promise<TriageDecision>}
 */
async function runTriage(ctx) {
  const { state, lastUser, convText, step, stepDone } = ctx;
  step("plan", "Analyzing request…");
  const triage = await jsonPhase(ctx, {
    label: "triage",
    statKey: "triage",
    recordStat: true,
    maxTokens: 500,
    messages: [
      { role: "system", content: triagePrompt(Math.max(4, state.plan.queries), { reinforceJsonOnly: ctx.reinforceJsonOnly }) },
      { role: "user", content: `Conversation:\n${convText}\n\nLatest user message:\n${lastUser}` },
    ],
  });
  const decision = normalizeTriage(hardenJson(TRIAGE_SCHEMA, triage), lastUser, previousUserText(ctx.conversation));

  if (decision.action === "direct") {
    stepDone("plan", "Direct reply (no research needed)");
    return decision;
  }
  if (decision.action === "clarify") {
    stepDone("plan", "Need to narrow the scope first");
    return decision;
  }
  const queries = decision.queries.slice(0, state.plan.queries);
  // Thread the triage decomposition into the request state: the gap check
  // audits coverage against each sub-question and synthesis must address
  // them (see gapPrompt/synthPrompt); complexity caps research depth below
  // the time budget for simple questions (budget.js applyComplexityToPlan).
  state.complexity = decision.complexity || null;
  state.subquestions = decision.subquestions || [];
  applyComplexityToPlan(state.plan, state.complexity);
  const kindTag =
    state.complexity && state.complexity !== "simple" ? ` · ${state.complexity}` : "";
  stepDone(
    "plan",
    `Planned ${queries.length} search angle${queries.length === 1 ? "" : "s"}${kindTag} · target ${state.plan.budgetS}s`,
    [...queries, ...state.subquestions.map((s) => `Sub-question: ${s}`)],
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

/** @param {PipelineCtx} ctx */
async function runDirectReply(ctx) {
  await streamCompletion(ctx, [
    { role: "system", content: directPrompt({ hasShell: !!ctx.shellBlock, hasSource: !!ctx.hasSource }) },
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

const MAX_SOURCE_TOOL_ROUNDS = 6; // native tool rounds before we force an answer

// Native tool-use source research (owner-authorized invariant-1 exception): the
// ANSWER model itself drives grep_source/read_file/list_files against the
// deployed snapshot (src/introspect-tools.js), then writes the answer. Emits an
// activity step per tool call, bills the rounds to the answer model's bucket,
// and emits the final answer. Throws on a hard provider failure so the caller
// falls back to the deterministic read loop.
/** @param {PipelineCtx} ctx @param {any} snapshot */
async function runSourceResearchTools(ctx, snapshot) {
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
    `File index (repo paths — investigate with grep_source / read_file):\n${sitemap}\n\n` +
    "Investigate the ACTUAL source with the tools, then write the answer.";
  const startedAt = Date.now();
  const result = await anthropicToolRun(ctx.env, {
    model: ctx.model,
    system: sourceToolAgentPrompt(),
    userContent: userText,
    tools: INTROSPECTION_TOOLS,
    maxRounds: MAX_SOURCE_TOOL_ROUNDS,
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

// ---- Build modes (SDK "lovable" + SWE "new Se/cure"): design + build + publish
//
// The build modes' answer phase (routed at the top of runPipeline): the model
// builds a small self-contained web app and the pipeline publishes it at a
// live /app/<slug>/ URL (src/build-pub.js). ONE runner, keyed by BUILD_FLAVORS
// — the green SDK mode builds a generic app from the DistillSDK catalog;
// the khaki SWE mode builds a NEW INSTANCE of Se/cure from the deployed Se/cure
// source. Two execution paths, mirroring the introspection source research:
//
//   1. NATIVE TOOLS (the same owner-authorized invariant-1 exception, extended
//      to SDK mode 2026-07-18): a tool-capable answer model drives the flavor's
//      planning tools + the snapshot readers + write_file/publish_app itself.
//   2. DETERMINISTIC (every other catalog model): one streamed completion
//      that emits FILE blocks (bash-core's fenced-block philosophy — a text
//      convention, no function calling), parsed and published server-side.
//
// Both fully fail-soft: a missing manifest/snapshot degrades the context (the
// model still builds), a publish failure degrades to the answer text with an
// honest note, and a tool-path failure falls through to the deterministic one.

const MAX_SDK_TOOL_ROUNDS = 12; // staging many files takes more rounds than reading

/**
 * The two build flavors share the publish machinery and the tool/deterministic
 * split; they differ only in the prompts, the context block, the offered tool
 * set, and the step labels. SDK builds a generic app from the DistillSDK
 * catalog; SWE builds a new instance of Se/cure from the deployed Se/cure
 * source.
 * @typedef {object} BuildFlavor
 * @property {string} planStep     the "plan" step's in-progress label
 * @property {string} planDone     the "plan" step's done label
 * @property {string} building     the "source" step's in-progress label (tool path)
 * @property {() => string} toolPrompt   system prompt for the native-tool path
 * @property {() => string} detPrompt    system prompt for the deterministic path
 * @property {(manifest: any, opts: any) => string} context  the injected context block
 * @property {(snapshot: any) => any[]} tools  the tool set for the tool path
 * @property {string} toolClosing  the closing instruction on the tool-path user turn
 */

/** @type {Record<string, BuildFlavor>} */
const BUILD_FLAVORS = {
  sdk: {
    planStep: "SDK mode…",
    planDone: "SDK mode — designing and building with DistillSDK",
    building: "Building with DistillSDK…",
    toolPrompt: sdkBuildToolPrompt,
    detPrompt: sdkBuildPrompt,
    context: (manifest, opts) => buildSdkContextBlock(manifest, opts),
    tools: (snapshot) => [...(snapshot ? INTROSPECTION_TOOLS : []), ...SDK_TOOLS, ...BUILD_TOOLS],
    toolClosing: "Build it now: plan with the sdk_* tools, read the relevant skills, stage every file with write_file, publish_app once, then write the short reply.",
  },
  swe: {
    planStep: "SWE mode…",
    planDone: "SWE mode — building a new instance of Se/cure",
    building: "Building a Se/cure variant…",
    toolPrompt: sweBuildToolPrompt,
    detPrompt: sweBuildPrompt,
    context: (_manifest, opts) => buildSweContextBlock(opts),
    tools: (snapshot) => [...(snapshot ? INTROSPECTION_TOOLS : []), ...BUILD_TOOLS],
    toolClosing: "Build it now: read the relevant Se/cure reference files, stage every file with write_file, publish_app once, then write the short reply.",
  },
};

/** @param {PipelineCtx} ctx @returns {Promise<any>} */
async function sdkSnapshot(ctx) {
  // The introspection enrichment (dev mode is on — SDK mode is gated on it)
  // normally stashed the snapshot already; load it directly when it didn't
  // (e.g. a developer_mode:false override combined with sdk_mode).
  const stashed = /** @type {any} */ (ctx.state).sourceSnapshot;
  if (stashed && Array.isArray(stashed.files)) return stashed;
  return loadSourceSnapshot(ctx.env, ctx.log);
}

/** @param {PipelineCtx} ctx @param {BuildFlavor} flavor */
async function runSdkBuild(ctx, flavor = BUILD_FLAVORS.sdk) {
  const { state } = ctx;
  ctx.step("plan", flavor.planStep);
  ctx.stepDone("plan", flavor.planDone);
  const snapshot = await sdkSnapshot(ctx);
  const manifest = manifestFromSnapshot(snapshot);
  if (!manifest) ctx.log.warn("sdk.manifest_missing", {});

  const toolsOn = introspectionToolsAvailable(ctx);
  ctx.log.info("sdk.build_gate", {
    tools: toolsOn,
    model: ctx.model,
    manifest: !!manifest,
    snapshot_files: snapshot?.files?.length || 0,
    build_slug: /** @type {any} */ (state).buildSlug || null,
  });
  if (toolsOn) {
    try {
      return await runSdkBuildTools(ctx, snapshot, manifest, flavor);
    } catch (/** @type {any} */ err) {
      ctx.log.warn("sdk.tools_failed", { model: ctx.model, error: err?.message || String(err) });
      // fall through to the deterministic FILE-block path
    }
  }
  return runSdkBuildDeterministic(ctx, manifest, flavor);
}

/**
 * Publish the staged files (fail-soft): stashes the result on the state (the
 * chat log's meta.build), emits the `build` status event the client uses to
 * remember the slug, and returns the result or null.
 * @param {PipelineCtx} ctx
 * @param {Array<{ path: string, content: string }>} files
 * @param {string} title
 * @returns {Promise<{ slug: string, url: string, files: number, bytes: number } | null>}
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

/** @param {PipelineCtx} ctx @param {any} snapshot @param {any} manifest @param {BuildFlavor} flavor */
async function runSdkBuildTools(ctx, snapshot, manifest, flavor) {
  const readBudget = { used: 0 };
  /** @type {Map<string, string>} */
  const staged = new Map();
  /** @type {{ slug: string, url: string, files: number, bytes: number } | null} */
  let published = null;
  let calls = 0;
  const fileCheck = snapshotFileCheck(snapshot);
  const buildSlug = /** @type {any} */ (ctx.state).buildSlug;
  ctx.step("source", flavor.building);

  // The snapshot readers only make sense with a snapshot to read; the build
  // tools always ride. SDK adds the SDK planning tools; SWE reads the Se/cure
  // source directly. (flavor.tools decides.)
  const tools = flavor.tools(snapshot);
  /** @param {string} name @param {any} input @returns {Promise<string> | string} */
  const execTool = (name, input) => {
    if (SDK_TOOL_NAMES.has(name)) return runSdkTool(manifest, name, input, { fileCheck });
    if (name === "write_file") {
      const res = stageBuildFile(staged, input?.path, input?.content);
      return res.ok ? `Staged ${res.path} (${res.bytes} bytes). ${staged.size} file${staged.size === 1 ? "" : "s"} staged.` : res.error;
    }
    if (name === "publish_app") {
      const files = [...staged].map(([path, content]) => ({ path, content }));
      const title = String(input?.title || "").trim() || sdkBuildTitle(ctx);
      return publishSdkFiles(ctx, files, title).then((result) =>
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
    (ctx.shellBlock ? `${ctx.shellBlock}\n\n` : "") +
    flavor.context(manifest, { toolMode: true, buildUrl: buildSlug ? `/app/${buildSlug}/` : null }) +
    `\n\n${flavor.toolClosing}`;

  const startedAt = Date.now();
  const result = await anthropicToolRun(ctx.env, {
    model: ctx.model,
    system: flavor.toolPrompt(),
    userContent: userText,
    tools,
    maxRounds: MAX_SDK_TOOL_ROUNDS,
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

  // The model staged files but never published (round cap, or it forgot):
  // publish for it, fail-soft — the "describe it, get a link" promise should
  // not hinge on the model remembering the last call.
  if (staged.size && !published) published = /** @type {any} */ (ctx.state).buildResult || null;
  if (staged.size && !published) {
    published = await publishSdkFiles(
      ctx,
      [...staged].map(([path, content]) => ({ path, content })),
      sdkBuildTitle(ctx),
    );
  }

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
  if (!text) throw new Error("SDK tool run produced no answer");
  ctx.step("synth", "Writing report…");
  emitChunked(ctx, text);
  // Guarantee a CLICKABLE link lands in the reply. The model often writes the
  // URL as bold/bare prose (`**/app/slug/**`) rather than a markdown link, and
  // `marked` never autolinks a relative /app/ path — so append unless the reply
  // already carries a real markdown link to it (replyLinksTo, not a substring
  // check). This append rides the answer text, so it also survives a
  // dropped-stream recovery, where only the text is replayed (the `build`
  // status event is not).
  if (published && !replyLinksTo(text, published.url)) {
    emitChunked(ctx, `\n\n**Try it live:** [${published.url}](${published.url})`);
  }
  ctx.stepDone("synth", "Report drafted");
}

/** @param {PipelineCtx} ctx @param {any} manifest @param {BuildFlavor} flavor */
async function runSdkBuildDeterministic(ctx, manifest, flavor) {
  const buildSlug = /** @type {any} */ (ctx.state).buildSlug;
  // The FILE-block convention + catalog/reference ride the conversation (the
  // introspection-enrichment append pattern) so the streamed completion sees
  // them on any catalog model.
  const block = flavor.context(manifest, {
    toolMode: false,
    buildUrl: buildSlug ? `/app/${buildSlug}/` : null,
  });
  const convo = /** @type {Conversation} */ (withAppendedText(ctx.conversation, block));
  ctx.step("synth", "Building the app…");
  const draft = await streamCompletion(ctx, [
    { role: "system", content: flavor.detPrompt() },
    ...shellReplyMessages(ctx.shellBlock),
    ...withImageNudge(convo),
  ]);
  const files = parseFileBlocks(draft || "");
  if (!files.length) {
    ctx.stepDone("synth", "Replied without building files");
    return;
  }
  const published = await publishSdkFiles(ctx, files, sdkBuildTitle(ctx));
  ctx.stepDone(
    "synth",
    published ? `Built and published ${published.files} file${published.files === 1 ? "" : "s"} → ${published.url}` : "Build produced files but publishing was unavailable",
    buildFilesSummary(files),
  );
  if (published) {
    emitChunked(ctx, `\n\n**Try it live:** [${published.url}](${published.url})`);
  } else {
    emitChunked(ctx, "\n\n_(Publishing was unavailable this turn — no live URL yet.)_");
  }
}

/** @param {PipelineCtx} ctx */
async function runSourceResearch(ctx) {
  const { state } = ctx;
  const snapshot = /** @type {any} */ (state).sourceSnapshot;
  ctx.step("plan", "Analyzing request…");
  ctx.stepDone("plan", "Researching the site's own source — web search skipped");

  if (!snapshot || !Array.isArray(snapshot.files) || !snapshot.files.length) {
    // No readable snapshot — answer from the excerpts the enrichment already
    // injected (still hasSource), exactly the pre-read-loop behavior.
    return runDirectReply(ctx);
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
      return await runSourceResearchTools(ctx, snapshot);
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
          { role: "system", content: sourceAgentPrompt({ reinforceJsonOnly: ctx.reinforceJsonOnly }) },
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
    // the enrichment already injected — the pre-read-loop behavior.
    ctx.stepDone("source", "Answered from the retrieved excerpts");
    return runDirectReply(ctx);
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
    "Write the answer now, grounded in the project's ACTUAL source code above and in the conversation context. Cite file paths for every claim about the implementation, and verify against the code rather than the repo's own documentation.";
  ctx.step("synth", "Writing report…");
  const synthStartedAt = Date.now();
  await streamCompletion(ctx, [
    { role: "system", content: sourceAnswerPrompt() },
    {
      role: "user",
      content: ctx.imageParts.length ? [{ type: "text", text: synthText }, ...ctx.imageParts] : synthText,
    },
  ]);
  recordPhase(ctx.model, "synth", Date.now() - synthStartedAt);
  ctx.stepDone("synth", "Report drafted");
}

// Phase 3: audits source coverage and runs follow-up searches for the most
// important gaps, up to plan.gapIterations rounds or until the time budget
// won't allow another round.
/** @param {PipelineCtx} ctx */
async function runGapChecks(ctx) {
  const { log, state, reinforceJsonOnly, lastUser, convText } = ctx;
  const plan = state.plan;
  const est = plan.estimates;

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
    ctx.step(stepId, `Checking coverage (round ${it})…`);

    const gapRaw = await jsonPhase(ctx, {
      label: `gap_check_${it}`,
      statKey: "gap",
      recordStat: true,
      maxTokens: 400,
      messages: [
        { role: "system", content: gapPrompt([...state.ranQueries], plan.followups, { subquestions: state.subquestions || [], reinforceJsonOnly }) },
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
      : gap.queries.filter((/** @type {any} */ q) => typeof q === "string" && q.trim()).slice(0, plan.followups);

    if (followups.length === 0) {
      ctx.stepDone(stepId, "Coverage sufficient");
      break;
    }
    ctx.stepDone(
      stepId,
      `Digging deeper: ${followups.length} follow-up search${followups.length === 1 ? "" : "es"}`,
      followups,
    );
    state.iterations++;
    await runSearches(ctx, followups, state.iterations);
    await maybeDigest(ctx);
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
  const synthText =
    `Question:\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
    // Decomposition skeleton + reported source conflicts (both empty — and
    // absent — unless triage decomposed the question / a gap round flagged
    // disagreeing sources; see subquestionsSection/conflictsSection).
    subquestionsSection(state.subquestions) +
    conflictsSection(state.conflicts) +
    // Notes preamble is present only when the digest phase ran (mid/high
    // tiers); byte-identical to before at the default budget.
    notesSection(state.notes) +
    // The bash-lite sandbox transcript (empty and absent unless the
    // experimental sandbox ran client-side for this request).
    (ctx.shellBlock ? `${ctx.shellBlock}\n\n` : "") +
    `Numbered sources:\n${digest || "(none — searches returned nothing usable)"}\n\nWrite the answer now.`;
  const synthStartedAt = Date.now();
  const draft = await streamCompletion(ctx, [
    // reportTier scales the OUTPUT's structure/comprehensiveness with the
    // slider (brief → standard → extended → full) — see budget.js
    // reportTierFor and prompts.js REPORT_TIER_STRUCTURE.
    { role: "system", content: synthPrompt({ hasShell: !!ctx.shellBlock, hasSource: !!ctx.hasSource, reportTier: plan.reportTier }) },
    {
      role: "user",
      content: imageParts.length ? [{ type: "text", text: synthText }, ...imageParts] : synthText,
    },
  ]);
  recordPhase(ctx.model, "synth", Date.now() - synthStartedAt);
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
        content: `Research question:\n${lastUser}\n\nNumbered sources:\n${digest || "(none)"}\n\nDraft answer:\n${draft}`,
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
  } else if (verdict?.verdict === "pass") {
    ctx.stepDone("validate", "All claims verified against sources");
  } else {
    ctx.stepDone("validate", "Validation inconclusive — draft kept as-is");
  }
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
    const r = await completeJson(ctx.env, messages, { model: ctx.jsonModel, maxTokens: max });
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
 * @param {PipelineCtx} ctx
 * @param {string[]} queries
 * @param {number} round 1 for the initial wave, then one per gap round.
 */
async function runSearches(ctx, queries, round) {
  const { env, log, emit, state } = ctx;
  const batch = takeSearchBatch(state, queries);
  if (!batch.length) return;

  // The web-search knob gates EXA ONLY (owner directive 2026-07-18). The
  // auxiliary sources (HF Hub & co, runAuxSearches below) and the depth
  // budget that plans this wave are independent of it: with the knob off the
  // wave still runs the aux sources over the planned angles — depth governs
  // how deep the research goes over whatever sources ARE available. Only the
  // Exa leg (the query-to-a-third-party leg the knob is about) is skipped.
  if (state.webSearch) {
    state.searchCount += batch.length;
    // Every search event names its provider (`source` slug + `service` display
    // name): the client's cards must always make clear WHICH provider ran a
    // search — a user report showed hub and web searches rendering identically.
    for (const query of batch) emit({ status: { type: "search_start", round, query, source: "web", service: "Web search" } });
    const results = await Promise.all(batch.map((query) => webSearch(env, log, query, state.plan.searchDepth)));
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
      addSources(state, result.items);
    }
  }
  await runAuxSearches(ctx, batch, round);
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
/**
 * @param {PipelineCtx} ctx
 * @param {string[]} batch The wave's Exa queries (already deduped/capped).
 * @param {number} round
 */
async function runAuxSearches(ctx, batch, round) {
  for (const source of SEARCH_SOURCES) {
    await runAuxSearch(ctx, source, batch, round);
  }
}

/**
 * @param {PipelineCtx} ctx
 * @param {import('./search-sources.js').SearchSource} source
 * @param {string[]} batch
 * @param {number} round
 */
async function runAuxSearch(ctx, source, batch, round) {
  const { env, log, emit, state } = ctx;
  if (!batch.length || !source.intent(ctx.lastUser)) return;
  state.aux ||= {};
  const st = (state.aux[source.id] ||= { count: 0, ran: new Set() });
  if (st.count >= (source.maxPerRequest ?? MAX_AUX_SEARCHES_DEFAULT)) return;
  // The wave's most on-topic query for THIS source (pickQuery — e.g. hf
  // prefers the entity/identifier-bearing angle over the generic one, the
  // web→hub insight flow); batch[0] when the source doesn't care.
  const query = source.pickQuery ? source.pickQuery(batch) : batch[0];
  const key = source.dedupKey ? source.dedupKey(query) : query.toLowerCase().trim();
  if (st.ran.has(key)) return;
  // Snapshot BEFORE adding this key: `skipKeys` tells the source which
  // search attempts earlier waves already consumed (its ladder skips them —
  // no re-fetching identical result sets), while the fresh key itself must
  // stay searchable this call.
  const skipKeys = new Set(st.ran);
  st.ran.add(key);
  st.count++;

  // The provider identity rides as source/service (not baked into the query
  // text): the client renders the service name on the card, so hub and web
  // searches are visibly distinct.
  const shownQuery = key || query;
  emit({ status: { type: "search_start", round, query: shownQuery, source: source.id, service: source.service } });
  /** @type {import('./search-sources.js').SearchSourceItem[]} */
  let items = [];
  let durationMs = 0;
  try {
    const r = await source.search(env, log, query, { skipKeys });
    items = r.items;
    durationMs = r.durationMs;
    // Attempts the source consumed (hit or miss) — recorded so later waves
    // whose ladders would collapse to the same attempt skip it instead of
    // re-fetching the same repos (the three-identical-hub-searches trace).
    for (const k of r.usedKeys || []) st.ran.add(k);
  } catch (/** @type {any} */ err) {
    log.warn(`${source.id}.search_failed`, { error: err?.message || String(err) });
  }
  emit({
    status: {
      type: "search_done",
      round,
      query: shownQuery,
      source: source.id,
      service: source.service,
      results: items.length,
      duration_ms: durationMs,
      sources: items.map((i) => ({ title: i.title, url: i.url })),
    },
  });
  // Registry-capacity reserve (once per source): aux sources run AFTER the
  // wave's Exa batch, so at generous budgets the wave's web results can fill
  // plan.maxSources BEFORE the hub items arrive — a probe showed hub
  // artifacts landing in overflow and never reaching the digest, so the
  // synthesis could not cite them at all for a question that explicitly
  // asked about the platform. The first time a source actually contributes
  // items, widen the registry by up to one search's worth so its results
  // compete for real slots instead of leftovers.
  if (items.length && !st.reserved) {
    st.reserved = true;
    state.plan.maxSources += Math.min(items.length, 8);
  }
  addSources(state, items);
}

