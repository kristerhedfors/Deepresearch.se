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
// ("/api/chat SSE protocol").

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
import {
  directPrompt,
  gapPrompt,
  searchOffPrompt,
  synthPrompt,
  triagePrompt,
  validatePrompt,
} from "./prompts.js";

export async function runPipeline(env, log, emit, conversation, model, state) {
  const lastUser = textOf(lastUserMessage(conversation)?.content);
  // Image parts of the latest user message ride along into synthesis so a
  // vision model can research with the image as context.
  const imageParts = imagePartsOf(lastUserMessage(conversation));
  const convText = formatConversation(conversation);
  const emitDelta = (t) => emit({ choices: [{ delta: { content: t } }] });
  const step = (id, label) => emit({ status: { type: "step_start", id, label } });
  const stepDone = (id, label, details = []) =>
    emit({ status: { type: "step_done", id, label, details } });

  // Web search off: answer purely from Berget — no triage, no Exa.
  if (!state.webSearch) {
    step("plan", "Web search off");
    stepDone("plan", "Web search off — answering from model knowledge");
    await streamCompletion(
      env,
      [{ role: "system", content: searchOffPrompt() }, ...withImageNudge(conversation)],
      model,
      emitDelta,
      state,
    );
    return;
  }

  // ---- Phase 1: triage ------------------------------------------------
  step("plan", "Analyzing request…");
  const triage = await phase(log, "triage", () =>
    completeJson(
      env,
      [
        { role: "system", content: triagePrompt(Math.max(4, state.plan.queries)) },
        { role: "user", content: `Conversation:\n${convText}\n\nLatest user message:\n${lastUser}` },
      ],
      { model, maxTokens: 500 },
    ).then((r) => {
      addUsage(state.totals, r.usage);
      return r.value;
    }),
    { model, statKey: "triage" },
  );

  const decision = normalizeTriage(triage, lastUser);

  if (decision.action === "direct") {
    stepDone("plan", "Direct reply (no research needed)");
    await streamCompletion(
      env,
      [{ role: "system", content: directPrompt() }, ...withImageNudge(conversation)],
      model,
      emitDelta,
      state,
    );
    return;
  }

  if (decision.action === "clarify") {
    stepDone("plan", "Need to narrow the scope first");
    emitChunked(emitDelta, decision.question);
    return;
  }

  // The time-budget plan (src/budget.js) decides how many angles, gap
  // rounds, and whether validation fits; deadline checks refine at runtime.
  const plan = state.plan;
  const est = plan.estimates;
  const queries = decision.queries.slice(0, plan.queries);
  stepDone(
    "plan",
    `Planned ${queries.length} search angle${queries.length === 1 ? "" : "s"} · target ${plan.budgetS}s`,
    queries,
  );

  // ---- Phase 2: initial search wave -------------------------------------
  await runSearches(env, log, emit, state, queries, 1);

  // ---- Phase 3: gap-check iterations (budgeted) --------------------------
  for (let it = 1; it <= plan.gapIterations; it++) {
    if (state.searchCount >= plan.maxSearches) break;
    // Skip further digging if this round plus the remaining mandatory
    // phases would blow the time target.
    const upcoming =
      est.gap + 2 * est.search + est.synth + (plan.validate ? est.validate : 0);
    if (!fitsDeadline(state.startedAt, plan.budgetMs, upcoming)) {
      log.info("chat.budget_cut", { cut: "gap_iteration", round: it });
      break;
    }
    const stepId = `gap${it}`;
    step(stepId, `Checking coverage (round ${it})…`);

    const gap = await phase(log, `gap_check_${it}`, () =>
      completeJson(
        env,
        [
          { role: "system", content: gapPrompt([...state.ranQueries], plan.followups) },
          {
            role: "user",
            content: `Research question:\n${lastUser}\n\nSources collected so far:\n${sourceDigest(state.sources, plan.digestCap) || "(none)"}`,
          },
        ],
        { model, maxTokens: 400 },
      ).then((r) => {
        addUsage(state.totals, r.usage);
        return r.value;
      }),
      { model, statKey: "gap" },
    );

    const followups = (!gap || gap.complete || !Array.isArray(gap.queries))
      ? []
      : gap.queries.filter((q) => typeof q === "string" && q.trim()).slice(0, plan.followups);

    if (followups.length === 0) {
      stepDone(stepId, "Coverage sufficient");
      break;
    }
    stepDone(
      stepId,
      `Digging deeper: ${followups.length} follow-up search${followups.length === 1 ? "" : "es"}`,
      followups,
    );
    state.iterations++;
    await runSearches(env, log, emit, state, followups, state.iterations);
  }

  // ---- Phase 4: synthesis (streamed draft) -------------------------------
  step("synth", "Writing report…");
  const digest = sourceDigest(state.sources, plan.digestCap);
  const synthText =
    `Question:\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
    `Numbered sources:\n${digest || "(none — searches returned nothing usable)"}\n\nWrite the answer now.`;
  const synthStartedAt = Date.now();
  const draft = await streamCompletion(
    env,
    [
      { role: "system", content: synthPrompt() },
      {
        role: "user",
        content: imageParts.length
          ? [{ type: "text", text: synthText }, ...imageParts]
          : synthText,
      },
    ],
    model,
    emitDelta,
    state,
  );
  recordPhase(model, "synth", Date.now() - synthStartedAt);
  stepDone("synth", "Report drafted");

  // ---- Phase 5: post-validation (budgeted) -------------------------------
  const validateNow =
    plan.validate && fitsDeadline(state.startedAt, plan.budgetMs, est.validate);
  if (!validateNow) {
    log.info("chat.budget_cut", { cut: "validation", planned: plan.validate });
    step("validate", "Validation");
    stepDone("validate", `Validation skipped to meet the ${plan.budgetS}s time target`);
    return;
  }
  step("validate", "Validating claims against sources…");
  const verdict = await phase(log, "validate", () =>
    completeJson(
      env,
      [
        { role: "system", content: validatePrompt() },
        {
          role: "user",
          content: `Research question:\n${lastUser}\n\nNumbered sources:\n${digest || "(none)"}\n\nDraft answer:\n${draft}`,
        },
      ],
      { model, maxTokens: 3000 },
    ).then((r) => {
      addUsage(state.totals, r.usage);
      return r.value;
    }),
    { model, statKey: "validate" },
  );

  if (verdict?.verdict === "revise" && typeof verdict.revised_answer === "string" && verdict.revised_answer.trim()) {
    const issues = (Array.isArray(verdict.issues) ? verdict.issues : []).map(String).slice(0, 10);
    stepDone(
      "validate",
      `Fixed ${issues.length || "some"} issue${issues.length === 1 ? "" : "s"} found in fact-check`,
      issues,
    );
    emit({ status: { type: "discard_text" } });
    emitChunked(emitDelta, verdict.revised_answer.trim());
  } else if (verdict?.verdict === "pass") {
    stepDone("validate", "All claims verified against sources");
  } else {
    stepDone("validate", "Validation inconclusive — draft kept as-is");
  }
}

// ---- internals -------------------------------------------------------------

// Runs a helper phase, logging duration; returns null on failure so the
// pipeline can degrade instead of breaking. When opts.statKey is given the
// duration feeds the per-model rolling stats used by the budget planner.
async function phase(log, name, fn, opts = {}) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    const duration_ms = Date.now() - startedAt;
    if (opts.statKey && opts.model) recordPhase(opts.model, opts.statKey, duration_ms);
    log.info("chat.phase", { phase: name, duration_ms, ok: result != null });
    return result;
  } catch (err) {
    log.warn("chat.phase_failed", {
      phase: name,
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

async function runSearches(env, log, emit, state, queries, round) {
  for (const raw of queries) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (state.ranQueries.has(key)) continue;
    if (state.searchCount >= state.plan.maxSearches) break;
    state.ranQueries.add(key);
    state.searchCount++;

    emit({ status: { type: "search_start", round, query } });
    const result = await webSearch(env, log, query);
    recordPhase(state.model, "search", result.durationMs);
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
async function streamCompletion(env, messages, model, emitDelta, state) {
  const upstream = await chatCompletion(env, messages, { model });
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    throw new Error(`Berget API error (${upstream.status}): ${detail.slice(0, 300)}`);
  }
  const { text, usage } = await consumeChatStream(upstream.body, emitDelta);
  addUsage(state.totals, usage);
  return text;
}

// Emits already-complete text as delta chunks (clarify questions, revised
// answers) so the client renders it through the same streaming path.
function emitChunked(emitDelta, text) {
  for (let i = 0; i < text.length; i += 80) {
    emitDelta(text.slice(i, i + 80));
  }
}

function addUsage(totals, usage) {
  if (!usage) return;
  totals.prompt_tokens += usage.prompt_tokens || 0;
  totals.completion_tokens += usage.completion_tokens || 0;
  totals.co2_grams += usage.co2_grams || 0;
}
