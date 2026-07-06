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
// Status events emitted to the UI are documented in CLAUDE.md
// ("/api/chat SSE protocol"). Each phase below is its own function, all
// sharing one `ctx` object built once in runPipeline() — everything a
// phase needs to read (env, model, per-request state, the resolved
// model-profiles.js overrides, the conversation) plus the three UI-emit
// helpers (emitDelta/step/stepDone), so phase functions take just ctx
// plus whatever's specific to that call, instead of a long parameter list.

import { chatCompletion, completeJson, consumeChatStream } from "./berget.js";
import { fitsDeadline, recordPhase } from "./budget.js";
import {
  formatConversation,
  imagePartsOf,
  lastUserMessage,
  textOf,
  withImageNudge,
} from "./conversation.js";
import { webSearch } from "./exa.js";
import { getModelProfile } from "./model-profiles.js";
import {
  directPrompt,
  gapPrompt,
  searchOffPrompt,
  synthPrompt,
  triagePrompt,
  validatePrompt,
} from "./prompts.js";

export async function runPipeline(env, log, emit, conversation, model, state) {
  const profile = getModelProfile(model);
  const ctx = {
    env, log, emit, model, state, profile, conversation,
    reinforceJsonOnly: profile.jsonReinforcement,
    lastUser: textOf(lastUserMessage(conversation)?.content),
    convText: formatConversation(conversation),
    // Image parts of the latest user message ride along into synthesis so a
    // vision model can research with the image as context.
    imageParts: imagePartsOf(lastUserMessage(conversation)),
    emitDelta: (t) => emit({ choices: [{ delta: { content: t } }] }),
    step: (id, label) => emit({ status: { type: "step_start", id, label } }),
    stepDone: (id, label, details = []) =>
      emit({ status: { type: "step_done", id, label, details } }),
  };

  // Web search off: answer purely from Berget — no triage, no Exa.
  if (!state.webSearch) return runWithoutSearch(ctx);

  const decision = await runTriage(ctx);
  if (decision.action === "direct") return runDirectReply(ctx);
  if (decision.action === "clarify") return runClarify(ctx, decision.question);

  // ---- Phase 2: initial search wave -------------------------------------
  await runSearches(ctx, decision.queries, 1);
  // ---- Phase 3: gap-check iterations (budgeted) -------------------------
  await runGapChecks(ctx);
  // ---- Phase 4: synthesis (streamed draft) -------------------------------
  const draft = await runSynthesis(ctx);
  // ---- Phase 5: post-validation (budgeted) -------------------------------
  await runValidation(ctx, draft);
}

// ---- phases ------------------------------------------------------------

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
async function runTriage(ctx) {
  const { state, lastUser, convText, step, stepDone } = ctx;
  step("plan", "Analyzing request…");
  const triage = await phase(ctx, "triage", () =>
    runJsonPhase(
      ctx,
      "triage",
      "triage",
      [
        { role: "system", content: triagePrompt(Math.max(4, state.plan.queries), { reinforceJsonOnly: ctx.reinforceJsonOnly }) },
        { role: "user", content: `Conversation:\n${convText}\n\nLatest user message:\n${lastUser}` },
      ],
      500,
    ),
    "triage",
  );
  const decision = normalizeTriage(triage, lastUser);

  if (decision.action === "direct") {
    stepDone("plan", "Direct reply (no research needed)");
    return decision;
  }
  if (decision.action === "clarify") {
    stepDone("plan", "Need to narrow the scope first");
    return decision;
  }
  const queries = decision.queries.slice(0, state.plan.queries);
  stepDone(
    "plan",
    `Planned ${queries.length} search angle${queries.length === 1 ? "" : "s"} · target ${state.plan.budgetS}s`,
    queries,
  );
  return { ...decision, queries };
}

async function runDirectReply(ctx) {
  await streamCompletion(ctx, [
    { role: "system", content: directPrompt() },
    ...withImageNudge(ctx.conversation),
  ]);
}

async function runClarify(ctx, question) {
  emitChunked(ctx, question);
}

// Phase 3: audits source coverage and runs follow-up searches for the most
// important gaps, up to plan.gapIterations rounds or until the time budget
// won't allow another round.
async function runGapChecks(ctx) {
  const { log, state, reinforceJsonOnly, lastUser } = ctx;
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

    const gap = await phase(ctx, `gap_check_${it}`, () =>
      runJsonPhase(
        ctx,
        `gap_check_${it}`,
        "gap",
        [
          { role: "system", content: gapPrompt([...state.ranQueries], plan.followups, { reinforceJsonOnly }) },
          {
            role: "user",
            content: `Research question:\n${lastUser}\n\nSources collected so far:\n${sourceDigest(state.sources, plan.digestCap) || "(none)"}`,
          },
        ],
        400,
      ),
      "gap",
    );

    const followups = (!gap || gap.complete || !Array.isArray(gap.queries))
      ? []
      : gap.queries.filter((q) => typeof q === "string" && q.trim()).slice(0, plan.followups);

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
  }
}

// Phase 4: writes the source-grounded draft answer. Returns the full text.
async function runSynthesis(ctx) {
  const { state, lastUser, convText, imageParts } = ctx;
  const plan = state.plan;
  ctx.step("synth", "Writing report…");
  const digest = sourceDigest(state.sources, plan.digestCap);
  const synthText =
    `Question:\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
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
async function runValidation(ctx, draft) {
  const { log, state, profile, lastUser } = ctx;
  const plan = state.plan;
  const est = plan.estimates;

  if (profile.skipValidation) {
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
  const verdict = await phase(ctx, "validate", () =>
    runJsonPhase(
      ctx,
      "validate",
      "validate",
      [
        { role: "system", content: validatePrompt({ reinforceJsonOnly: ctx.reinforceJsonOnly }) },
        {
          role: "user",
          content: `Research question:\n${lastUser}\n\nNumbered sources:\n${digest || "(none)"}\n\nDraft answer:\n${draft}`,
        },
      ],
      3000,
    ),
    "validate",
  );

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

// ---- internals -------------------------------------------------------------

// Runs one JSON-mode phase call: the completeJson request, usage
// accounting, and the parse-mode/finish-reason diagnostic log — every JSON
// phase (triage, gap-check, validation) follows this exact shape, so it's
// one call site here instead of three near-identical blocks. `statKey`
// (budget.js's phase bucket: triage/gap/validate) resolves a per-model
// max_tokens override if model-profiles.js has one for this model;
// `diagLabel` is the specific label logged for this call (equal to
// statKey except gap-check, which logs "gap_check_N" per round).
async function runJsonPhase(ctx, diagLabel, statKey, messages, defaultMaxTokens) {
  const maxTokens = ctx.profile.maxTokensOverride?.[statKey] ?? defaultMaxTokens;
  const r = await completeJson(ctx.env, messages, { model: ctx.model, maxTokens });
  addUsage(ctx.state.totals, r.usage);
  ctx.log.info("chat.json_diag", { phase: diagLabel, model: ctx.model, ...r.diagnostics });
  return r.value;
}

// Runs a helper phase, logging duration; returns null on failure so the
// pipeline can degrade instead of breaking. When statKey is given the
// duration feeds the per-model rolling stats used by the budget planner.
async function phase(ctx, name, fn, statKey) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const duration_ms = Date.now() - startedAt;
    if (statKey) recordPhase(ctx.model, statKey, duration_ms);
    ctx.log.info("chat.phase", { phase: name, model: ctx.model, duration_ms, ok: result != null });
    return result;
  } catch (err) {
    ctx.log.warn("chat.phase_failed", {
      phase: name,
      model: ctx.model,
      duration_ms: Date.now() - startedAt,
      error: err?.message || String(err),
    });
    return null;
  }
}

function normalizeTriage(triage, lastUser) {
  if (triage?.action === "clarify" && typeof triage.question === "string" && triage.question.trim()) {
    return { action: "clarify", question: triage.question.trim() };
  }
  if (triage?.action === "research") {
    const queries = (Array.isArray(triage.queries) ? triage.queries : [])
      .filter((q) => typeof q === "string" && q.trim());
    if (queries.length > 0) return { action: "research", queries };
  }
  if (triage?.action === "direct") return { action: "direct" };
  // Triage failed: research with the raw question when it looks substantial,
  // otherwise answer directly.
  return lastUser.trim().length >= 12
    ? { action: "research", queries: [lastUser.trim().slice(0, 300)] }
    : { action: "direct" };
}

// Queries within one round are independent, so they run concurrently
// (Promise.all) instead of one fetch at a time — a round 6 assessment
// found the sequential loop was leaving several seconds of wall-clock on
// the table per round for no reason, time better spent on actual depth.
// Filtering against the query cap happens BEFORE firing anything (not as
// a mid-loop break) so a batch can't overrun plan.maxSearches; results
// are processed back in original order so source numbering (citations)
// stays deterministic regardless of which fetch happens to resolve first.
async function runSearches(ctx, queries, round) {
  const { env, log, emit, state } = ctx;
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
  if (!batch.length) return;
  state.searchCount += batch.length;

  for (const query of batch) emit({ status: { type: "search_start", round, query } });
  const results = await Promise.all(batch.map((query) => webSearch(env, log, query, state.plan.searchDepth)));
  for (let i = 0; i < batch.length; i++) {
    const query = batch[i];
    const result = results[i];
    recordPhase(ctx.model, "search", result.durationMs);
    emit({
      status: {
        type: "search_done",
        round,
        query,
        results: result.resultCount,
        duration_ms: result.durationMs,
        sources: result.sources,
      },
    });
    addSources(state, result.items);
  }
}

// Cross-search source registry: deduped by URL, numbered in arrival order so
// citations stay stable between synthesis and validation.
function addSources(state, items) {
  for (const item of items || []) {
    if (!item?.url || state.byUrl.has(item.url)) continue;
    if (state.sources.length >= state.plan.maxSources) return;
    const entry = {
      n: state.sources.length + 1,
      title: item.title || item.url,
      url: item.url,
      highlights: (item.highlights || []).slice(0, 3),
    };
    state.byUrl.set(item.url, entry);
    state.sources.push(entry);
  }
}

function sourceDigest(sources, capChars) {
  const blocks = [];
  let used = 0;
  for (const s of sources) {
    const block = `[${s.n}] ${s.title}\n${s.url}\n${s.highlights.join(" … ")}`.trim();
    if (used + block.length > capChars) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}

// Streams one chat completion to the client; returns the full text.
async function streamCompletion(ctx, messages) {
  const maxAttempts = ctx.profile.maxCompletionAttempts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const upstream = await chatCompletion(ctx.env, messages, { model: ctx.model });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      throw new Error(`Berget API error (${upstream.status}): ${detail.slice(0, 300)}`);
    }
    const { text, usage, finishReason } = await consumeChatStream(upstream.body, ctx.emitDelta);
    addUsage(ctx.state.totals, usage);
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
      throw new Error(`Berget stream ended without a finish_reason (${text.length} chars received) — likely a dropped connection`);
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
    ctx.log.warn("chat.empty_completion", { model: ctx.model, attempt, maxAttempts });
    if (attempt === maxAttempts) {
      throw new Error(`Berget returned an empty response ${maxAttempts} times in a row for this model`);
    }
  }
}

// Emits already-complete text as delta chunks (clarify questions, revised
// answers) so the client renders it through the same streaming path.
function emitChunked(ctx, text) {
  for (let i = 0; i < text.length; i += 80) {
    ctx.emitDelta(text.slice(i, i + 80));
  }
}

function addUsage(totals, usage) {
  if (!usage) return;
  totals.prompt_tokens += usage.prompt_tokens || 0;
  totals.completion_tokens += usage.completion_tokens || 0;
  totals.co2_grams += usage.co2_grams || 0;
}
