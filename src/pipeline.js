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
// co, iterated by runAuxSearches below) in search-sources.js, and the
// opt-in pre-pipeline context enrichments (Shodan, Google Maps) in
// enrichment.js.

import { classifyChatError, raiseAlert } from "./alerts.js";
import { consumeChatStream } from "./berget.js";
import { chatCompletion, completeJson, providerName } from "./providers.js";
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
  withImageNudge,
} from "./conversation.js";
import { runEnrichments } from "./enrichment.js";
import { fetchContents, webSearch } from "./exa.js";
import { SEARCH_SOURCES } from "./search-sources.js";
import { getModelProfile } from "./model-profiles.js";
import { addUsage } from "./quota.js";
import { addSources, backfillOverflowSources, sourceDigest } from "./sources.js";
import { extractNotes, mergeNotes, notesDigest, notesEntities } from "./notes.js";
import { arrayOf, boolean, object, oneOf, string, stringEnum, validate } from "./schema.js";
import {
  claimExtractionPrompt,
  claimVerifyPrompt,
  directPrompt,
  gapPrompt,
  notesPrompt,
  quizPrompt,
  revisePrompt,
  searchOffPrompt,
  synthPrompt,
  triagePrompt,
  validatePrompt,
} from "./prompts.js";
import { DEFAULT_QUIZ_QUESTIONS, normalizeQuiz, quizIntent, quizQuestionCount } from "./quiz.js";

// ---- shared shapes -------------------------------------------------------

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
 *   lastUser: string,
 *   convText: string,
 *   imageParts: import('./types.js').ContentPart[],
 *   emitDelta: (text: string) => void,
 *   step: (id: string, label: string) => void,
 *   stepDone: (id: string, label: string, details?: string[]) => void,
 * }} PipelineCtx
 */

/**
 * normalizeTriage's hardened verdict: exactly one of the three actions,
 * with the optional decomposition/quiz fields riding on research/direct.
 * @typedef {{ action: "direct", quiz?: boolean }
 *   | { action: "clarify", question: string, quiz?: boolean }
 *   | ResearchDecision} TriageDecision
 */
/**
 * @typedef {{
 *   action: "research",
 *   queries: string[],
 *   complexity?: string,
 *   subquestions?: string[],
 *   quiz?: boolean,
 * }} ResearchDecision
 */

// ---- JSON-phase schemas --------------------------------------------------

// Declared shapes for the three JSON planning phases — a hardening layer over
// the raw model JSON (src/schema.js), applied BEHIND the existing fail-soft
// fallbacks (normalizeTriage etc. stay the last-ditch net). On a clean match
// hardenJson() returns the normalized object; on ANY miss it returns the raw
// value untouched, so a malformed shape degrades exactly as it did before the
// schema existed (single search / accept draft) and never throws.
const TRIAGE_SCHEMA = oneOf([
  // `quiz` (optional on direct AND research): triage's fail-soft backup for
  // the deterministic quizIntent gate — the first production quiz request
  // arrived with a typo ("wuiz") the regexes missed; a model reads through
  // typos and paraphrases that no pattern list can enumerate. Never the
  // primary gate: quizIntent still decides when it matches, and a stray
  // false `quiz:true` on a non-request costs one fail-soft generation
  // attempt at worst (schema.js's object() strips unknown fields, so the
  // flag must be declared here to survive hardening).
  // The `optional` casts here and below: schema.js's `optional = []` default
  // makes tsc infer never[] for the option in unannotated schema.js.
  object({ action: stringEnum(["direct"]), quiz: boolean() }, /** @type {any} */ ({ optional: ["quiz"] })),
  object({ action: stringEnum(["clarify"]), question: string({ allowEmpty: false }) }),
  object(
    {
      action: stringEnum(["research"]),
      queries: arrayOf(string({ allowEmpty: false })),
      // Decomposition fields (prompts.js DECOMPOSITION_RULE) — both optional:
      // a model that omits them (or an unknown complexity value falling
      // through normalizeTriage's lenient extraction) degrades exactly to the
      // pre-decomposition flow.
      complexity: stringEnum(["simple", "multihop", "comparison", "survey"]),
      subquestions: arrayOf(string({ allowEmpty: false })),
      quiz: boolean(),
    },
    /** @type {any} */ ({ optional: ["queries", "complexity", "subquestions", "quiz"] }),
  ),
]);
const GAP_SCHEMA = object(
  {
    complete: boolean(),
    queries: arrayOf(string({ allowEmpty: false })),
    // Source disagreements the audit noticed (display + synthesis hint) —
    // optional, and independent of `complete`.
    conflicts: arrayOf(string({ coerce: true })),
  },
  /** @type {any} */ ({ optional: ["complete", "queries", "conflicts"] }),
);
const VALIDATE_SCHEMA = object(
  {
    verdict: stringEnum(["pass", "revise"]),
    // Display-only list; coerce leniently to match the pipeline's historical
    // `.map(String)` treatment of a stray non-string issue.
    issues: arrayOf(string({ coerce: true })),
    revised_answer: string(),
  },
  /** @type {any} */ ({ optional: ["issues", "revised_answer"] }),
);
// Claim-level validation (high tiers): per-claim verdict and the revision.
const CLAIM_VERIFY_SCHEMA = object(
  { verdict: stringEnum(["supported", "unsupported"]), issue: string({ coerce: true }) },
  /** @type {any} */ ({ optional: ["issue"] }),
);
const REVISE_SCHEMA = object({ revised_answer: string() });

// Runs a JSON-phase value through its declared schema. ok → the normalized
// object; miss → the raw value, so the caller's existing fallback path runs
// unchanged. validate() never throws, so this is always safe.
/**
 * @param {object} schema One of the schema declarations above.
 * @param {any} value Raw parsed model JSON (may be anything).
 * @returns {any}
 */
function hardenJson(schema, value) {
  const r = validate(schema, value);
  return r.ok ? r.value : value;
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
  const convo = await runEnrichments(env, log, emit, step, stepDone, conversation, state);

  const ctx = {
    env, log, emit, model, jsonModel, state, profile, jsonProfile, conversation: convo,
    reinforceJsonOnly: jsonProfile.jsonReinforcement,
    lastUser: textOf(lastUserMessage(convo)?.content),
    convText: formatConversation(convo),
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
  let quizReq = state.quizzes ? quizIntent(ctx.lastUser) : null;

  // Web search off: answer purely from Berget — no triage, no Exa.
  if (!state.webSearch) {
    if (quizReq && (await runQuizGeneration(ctx, quizReq))) return;
    return runWithoutSearch(ctx);
  }

  const decision = await runTriage(ctx);
  // Triage's fail-soft quiz backup: the deterministic gate missed (typo /
  // paraphrase — the first production request arrived as "Bygg en wuiz…")
  // but the triage model recognized a quiz request. The message still
  // decides the question count.
  if (state.quizzes && !quizReq && decision.quiz === true) {
    quizReq = { questions: quizQuestionCount(ctx.lastUser) || DEFAULT_QUIZ_QUESTIONS };
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

/** @param {PipelineCtx} ctx */
async function runWithoutSearch(ctx) {
  ctx.step("plan", "Web search off");
  ctx.stepDone("plan", "Web search off — answering from model knowledge");
  await streamCompletion(ctx, [
    { role: "system", content: searchOffPrompt() },
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
    { role: "system", content: directPrompt() },
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

// Distilled-notes preamble for the gap/synth inputs — only present when the
// budget-gated digest phase actually produced notes (never at default budget,
// so the input string is byte-identical there).
/**
 * @param {object[] | undefined} notes
 * @returns {string}
 */
function notesSection(notes) {
  const block = notesDigest(notes, 6000);
  return block ? `Distilled research notes so far:\n${block}\n\n` : "";
}

// Accumulates the gap check's reported source disagreements onto the request
// state (deduped, capped) so synthesis can be told to address them explicitly
// instead of silently picking a side. Pure state bookkeeping — exported for
// unit tests. Lenient by design: a missing/malformed conflicts field is
// simply no conflicts.
/**
 * @param {{ conflicts?: string[] }} state The request state (only `conflicts` is touched).
 * @param {any} gap Raw gap-check JSON.
 * @returns {string[]} The accumulated conflict list.
 */
export function collectConflicts(state, gap) {
  const list = Array.isArray(gap?.conflicts) ? gap.conflicts : [];
  state.conflicts ||= [];
  for (const raw of list) {
    const c = typeof raw === "string" ? raw.trim() : "";
    if (!c || state.conflicts.includes(c)) continue;
    state.conflicts.push(c);
    if (state.conflicts.length >= 6) break;
  }
  return state.conflicts;
}

// The sub-question and source-conflict preambles for the synthesis input —
// both empty (and thus absent, keeping the input byte-identical to the
// pre-decomposition pipeline) unless triage decomposed the question or a gap
// round reported disagreeing sources.
/**
 * @param {string[] | undefined} subquestions
 * @returns {string}
 */
function subquestionsSection(subquestions) {
  const list = Array.isArray(subquestions) ? subquestions.filter(Boolean) : [];
  if (!list.length) return "";
  return `Sub-questions the answer must address:\n${list.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n`;
}

/**
 * @param {string[] | undefined} conflicts
 * @returns {string}
 */
function conflictsSection(conflicts) {
  const list = Array.isArray(conflicts) ? conflicts.filter(Boolean) : [];
  if (!list.length) return "";
  return `Source conflicts detected during research (address each explicitly — cite both sides, never silently pick one):\n${list.map((c) => `- ${c}`).join("\n")}\n\n`;
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
    `Numbered sources:\n${digest || "(none — searches returned nothing usable)"}\n\nWrite the answer now.`;
  const synthStartedAt = Date.now();
  const draft = await streamCompletion(ctx, [
    { role: "system", content: synthPrompt() },
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
    maxTokens: 3000,
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
    maxTokens: 3000,
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

/** @typedef {{ claim: string, source_ids: number[] }} Claim */

// Pure, lenient parse of the claim-extraction JSON ({claims:[{claim,
// source_ids}]} or a bare array) — drops junk, caps at 12, never throws.
/**
 * @param {any} value Raw claim-extraction JSON.
 * @returns {Claim[]}
 */
function extractClaims(value) {
  const list = value && Array.isArray(value.claims) ? value.claims : Array.isArray(value) ? value : [];
  /** @type {Claim[]} */
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const claim = typeof c.claim === "string" ? c.claim.trim() : "";
    if (!claim) continue;
    const source_ids = (Array.isArray(c.source_ids) ? c.source_ids : [])
      .map((/** @type {any} */ n) => (typeof n === "number" ? Math.trunc(n) : Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : NaN))
      .filter((/** @type {number} */ n) => Number.isFinite(n) && n >= 1);
    out.push({ claim, source_ids });
    if (out.length >= 12) break;
  }
  return out;
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

/**
 * Hardens the raw triage JSON into a usable decision, with a model-free
 * fallback (see below) when the JSON is unusable.
 * @param {any} triage Raw triage JSON (may be anything).
 * @param {string} lastUser The latest user message's text.
 * @param {string} [priorUser] The previous user turn's text ("" when none).
 * @returns {TriageDecision}
 */
export function normalizeTriage(triage, lastUser, priorUser = "") {
  // The optional quiz flag (triage's fail-soft backup for quizIntent —
  // see TRIAGE_SCHEMA) rides along on direct/research decisions; lenient
  // strict-boolean extraction so it survives the raw (schema-miss) path.
  const quiz = triage?.quiz === true ? { quiz: true } : {};
  if (triage?.action === "clarify" && typeof triage.question === "string" && triage.question.trim()) {
    return { action: "clarify", question: triage.question.trim() };
  }
  if (triage?.action === "research") {
    const queries = (Array.isArray(triage.queries) ? triage.queries : [])
      .filter((/** @type {any} */ q) => typeof q === "string" && q.trim());
    if (queries.length > 0) {
      /** @type {ResearchDecision} */
      const out = { action: "research", queries, ...quiz };
      // Optional decomposition fields (prompts.js DECOMPOSITION_RULE) —
      // lenient extraction so they survive the raw (schema-miss) path too.
      // Only attached when usable: their absence is the pre-decomposition
      // behavior everywhere downstream.
      if (["simple", "multihop", "comparison", "survey"].includes(triage.complexity)) {
        out.complexity = triage.complexity;
      }
      const subs = (Array.isArray(triage.subquestions) ? triage.subquestions : [])
        .filter((/** @type {any} */ s) => typeof s === "string" && s.trim())
        .map((/** @type {string} */ s) => s.trim())
        .slice(0, 5);
      if (subs.length) out.subquestions = subs;
      return out;
    }
  }
  if (triage?.action === "direct") return { action: "direct", ...quiz };

  // Triage failed to produce usable JSON — decide a fallback WITHOUT a model.
  // A SHORT latest message in an ongoing conversation is almost always a
  // pure back-reference ("undersök saken", "det då?") with no searchable
  // content of its own, so seed the search from the prior question (the
  // established, self-contained topic) rather than the referential phrase.
  // A LONGER follow-up is deliberately left as-is: it carries its own
  // content words (e.g. "…hur det ser ut för sd" — the entity "sd" is right
  // there), which a fuzzy search can use, so replacing it with the prior
  // topic would only DROP that focus. The real fix for an ugly unresolved
  // query is triage itself producing a clean one (triagePrompt's
  // FOLLOWUP_RESOLUTION_RULE + per-model JSON reliability, model-profiles.js)
  // — this fallback only runs on the rare parse-failure path and just avoids
  // the worst case (a bare pronoun going to the web). A short message with no
  // prior context has nothing to resolve against, so answer directly.
  const cur = lastUser.trim();
  const prior = (priorUser || "").trim();
  const looksLikeFollowup = cur.length < 40 && cur.split(/\s+/).filter(Boolean).length <= 6;
  if (prior && looksLikeFollowup) {
    return { action: "research", queries: [prior.slice(0, 300)] };
  }
  return cur.length >= 12
    ? { action: "research", queries: [cur.slice(0, 300)] }
    : { action: "direct" };
}

// ---- search execution ----------------------------------------------------

// The round's runnable slice of the planned queries: trimmed, deduped
// against every query already run this request (state.ranQueries — marked
// as run here), and cut off at plan.maxSearches. Filtering happens BEFORE
// firing anything (not as a mid-loop break) so a batch can't overrun the
// cap.
/**
 * @param {PipelineState} state
 * @param {string[]} queries
 * @returns {string[]}
 */
function takeSearchBatch(state, queries) {
  const batch = [];
  for (const raw of queries) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (state.ranQueries.has(key)) continue;
    if (state.searchCount + batch.length >= state.plan.maxSearches) break;
    state.ranQueries.add(key);
    batch.push(query);
  }
  return batch;
}

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

// ---- answer streaming ------------------------------------------------------

// The answer stream's inter-chunk inactivity bound. A production report
// (2026-07-08, screenshot: "stuck after a few response tokens") exposed the
// remaining unguarded hang: the round-2 fix bounds time-to-FIRST-response
// only, so a Berget stream that goes silent MID-generation (socket open, no
// chunks, no EOF) hung the pipeline forever — and because /api/chat's 15s
// SSE keepalives kept flowing, the CLIENT's stall watchdog (which stamps
// lastByteAt on keepalives too) never fired either: a truly infinite
// spinner on both sides. 60s of inter-chunk silence is far beyond anything
// a healthy stream does (slow models pause single-digit seconds between
// tokens) and cheap insurance. The enrichment describe call has its own
// bound already (src/enrichment.js).
const STREAM_IDLE_TIMEOUT_MS = 60_000;

// Whether a failed connect attempt looks provider-side and transient (worth
// another attempt) rather than deterministic (our request is at fault — a
// 400/401/413 will fail identically on every retry). Exported for tests.
/**
 * @param {number} status HTTP status of the failed connect.
 * @returns {boolean}
 */
export function isTransientConnectStatus(status) {
  return status >= 500 || status === 429 || status === 408;
}

// Tags an error as eligible for the model failover in streamCompletion():
// set only where the failing model never delivered a byte the user still
// has on screen, so a different model's answer can't visibly diverge.
/**
 * @param {string} message
 * @returns {Error & { failover: true }}
 */
function failoverError(message) {
  const e = /** @type {Error & { failover: true }} */ (new Error(message));
  e.failover = true;
  return e;
}

// Streams one chat completion to the client; returns the full text.
//
// The user's chosen model gets its full retry budget first (streamOnModel).
// If it never delivered a visible byte — connect-phase exhaustion, an early
// stall whose fragment was discarded, clean-but-empty completions — the
// answer is retried ONCE on the pipeline's fixed reliable JSON model
// instead of erroring the chat. Observed live (2026-07-08, refs 6b753392 /
// 953b74e3): Berget's Mistral Medium refused to open a synthesis stream for
// 20+ minutes straight while Mistral Small answered the SAME requests'
// triage/gap calls in ~1-2s — retrying the dead model alone can't save
// that, but the reliable default was provably up the whole time. The
// failover is announced as a step so the user knows which model answered,
// its usage is billed to the jsonTotals bucket (that's the model that ran),
// and the provider issue still raises the admin alert an unrecovered
// failure would have — users stop hurting, admins keep seeing it.
/**
 * @param {PipelineCtx} ctx
 * @param {import('./conversation.js').Msg[]} messages
 * @returns {Promise<string>} The full streamed text.
 */
async function streamCompletion(ctx, messages) {
  try {
    return await streamOnModel(ctx, messages, ctx.model, ctx.profile, ctx.state.totals);
  } catch (/** @type {any} */ err) {
    const fallback = ctx.jsonModel;
    if (!err?.failover || !fallback || fallback === ctx.model) throw err;
    ctx.log.warn("chat.model_failover", { from: ctx.model, to: fallback, error: err?.message || String(err) });
    const alert = classifyChatError(err?.message);
    await raiseAlert(ctx.env, alert.type, alert.severity, alert.message,
      `model: ${ctx.model} — failed over to ${fallback} — ${err?.message}`);
    const name = (/** @type {string} */ id) => String(id).split("/").pop();
    ctx.step("failover", `${name(ctx.model)} isn't responding — switching to ${name(fallback)}…`);
    try {
      const text = await streamOnModel(ctx, messages, fallback, ctx.jsonProfile, ctx.state.jsonTotals);
      ctx.state.failoverModel = fallback;
      ctx.stepDone("failover", `Answered by ${name(fallback)} — ${name(ctx.model)} was unavailable`);
      return text;
    } catch (err2) {
      ctx.stepDone("failover", `${name(fallback)} couldn't answer either`);
      throw err2;
    }
  }
}

// One model's full attempt loop; usage lands in the caller's totals bucket
// (split billing — each bucket priced at its own model's catalog rate).
/**
 * @param {PipelineCtx} ctx
 * @param {import('./conversation.js').Msg[]} messages
 * @param {string} model
 * @param {ModelProfile} profile This model's profile (retry budget).
 * @param {import('./types.js').TokenTotals} totals Billing bucket for this model's usage.
 * @returns {Promise<string>}
 */
async function streamOnModel(ctx, messages, model, profile, totals) {
  const maxAttempts = profile.maxCompletionAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Connect-phase failures get the same retry budget as the stall/empty
    // cases below — they're the CHEAPEST kind to retry (nothing has streamed
    // yet, so a second attempt can't visibly diverge from text already on
    // screen). Observed live (2026-07-08, ref 6b753392): a loaded Mistral
    // Medium sat on the synthesis request past berget.js's 30s connect
    // timeout and the abort ("The operation was aborted") threw straight
    // out of the pipeline as a fatal chat error — a provider blip the user
    // paid for with a dead research run, all searches already done.
    let upstream;
    try {
      // Cast: conversation.js's helpers hand back its looser Msg shape; the
      // messages here are the well-formed arrays the phase builders wrote.
      upstream = await chatCompletion(ctx.env, /** @type {Conversation} */ (messages), { model });
    } catch (/** @type {any} */ err) {
      // fetch() itself rejected: the connect-timeout abort or a network
      // reset. Always transient by nature.
      ctx.log.warn("chat.connect_failed", { model, attempt, error: err?.message || String(err) });
      if (attempt < maxAttempts) continue;
      throw failoverError(err?.message || String(err));
    }
    if (!upstream.ok || !upstream.body) {
      const detail = (await upstream.text().catch(() => "")).slice(0, 300);
      const transient = !upstream.body || isTransientConnectStatus(upstream.status);
      ctx.log.warn("chat.connect_failed", { model, attempt, status: upstream.status, error: detail });
      if (transient && attempt < maxAttempts) continue;
      const message = `${providerName(model)} API error (${upstream.status}): ${detail}`;
      // A deterministic 4xx is OUR request's fault — the fallback model
      // would just fail the same way, so it isn't failover-eligible.
      throw transient ? failoverError(message) : new Error(message);
    }
    let streamed;
    let received = 0;
    try {
      streamed = await consumeChatStream(
        upstream.body,
        (/** @type {string} */ t) => {
          received += t.length;
          ctx.emitDelta(t);
        },
        { idleMs: STREAM_IDLE_TIMEOUT_MS },
      );
    } catch (/** @type {any} */ err) {
      // A hang caught by the idle guard right at the START of the answer
      // (the reported case: a handful of tokens, then silence) is worth one
      // cheap retry — the same transient-blip reasoning as the empty-
      // completion retry below, and the user has barely seen any text. A
      // hang deep into a long answer is NOT retried (regenerated text would
      // visibly diverge from what is already on screen) — it surfaces as an
      // honest error with a (ref …) instead of an infinite spinner. The
      // client is told to discard the few rendered tokens (discard_text —
      // the same event the validation revise path uses) so the retried
      // answer doesn't append after them.
      ctx.log.warn("chat.stream_stalled", { model, attempt, received, error: err?.message || String(err) });
      if (received < 400) {
        if (received) ctx.emit({ status: { type: "discard_text" } });
        if (attempt < maxAttempts) continue;
        // Early stall, fragment already discarded — safe to hand to the
        // failover model, nothing of this model's answer remains on screen.
        throw failoverError(err?.message || String(err));
      }
      throw err;
    }
    const { text, usage, finishReason } = streamed;
    addUsage(totals, usage);
    if (!finishReason) {
      // A round 3 model-eval battery found Berget's connection can drop
      // mid-stream for some models with no error frame at all — the reader
      // just sees a clean EOF, so nothing throws and the caller would
      // otherwise silently return truncated (sometimes empty) text as if it
      // were a complete, successful answer. A normal completion always sets
      // finish_reason on its last chunk (standard OpenAI Chat Completions
      // behavior); its absence is the tell. Throwing here routes this
      // through chat.js's existing error handling — the user sees an honest
      // error instead of a confusing blank/truncated answer, and it's
      // finally visible in logs (chat.stream_failed) instead of invisible.
      throw new Error(`${providerName(model)} stream ended without a finish_reason (${text.length} chars received) — likely a dropped connection`);
    }
    if (text) return text;
    // A round 4 model-eval battery found a distinct failure mode from the
    // one above: a stream that completes CLEANLY (finish_reason set,
    // pipeline reaches "done") but with zero content — no dropped
    // connection, no thrown error, just an empty answer silently delivered
    // to the user. Retrying is cheap insurance against what looks like a
    // transient backend blip rather than a per-query determinism issue
    // (the same query succeeds cleanly on some runs); only after
    // exhausting maxCompletionAttempts (model-profiles.js — 2 by default,
    // higher for models evidenced to need it) do we give up and surface it.
    ctx.log.warn("chat.empty_completion", { model, attempt, maxAttempts });
    if (attempt === maxAttempts) {
      // Nothing was ever shown (the completions were empty) — eligible for
      // the failover model rather than surfacing an error.
      throw failoverError(`${providerName(model)} returned an empty response ${maxAttempts} times in a row for this model`);
    }
  }
  // Unreachable when maxCompletionAttempts >= 1 (model-profiles.js
  // guarantees it): the final attempt always returns or throws above.
  throw failoverError(`${providerName(model)} completion made no attempts`);
}

// Emits already-complete text as delta chunks (clarify questions, revised
// answers) so the client renders it through the same streaming path.
/**
 * @param {PipelineCtx} ctx
 * @param {string} text
 */
function emitChunked(ctx, text) {
  for (let i = 0; i < text.length; i += 80) {
    ctx.emitDelta(text.slice(i, i + 80));
  }
}
