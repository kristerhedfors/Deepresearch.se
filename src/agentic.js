// @ts-check
// THE AGENTIC RESEARCH PHASE — the answer model runs its own research turn.
//
// One bounded loop, then one report. The model is handed the research brief
// (public/js/research-brief-core.js), a toolbox fixed before it runs
// (src/tool-sets.js over the agent's declared classes), and nothing else; it
// chooses which tools to call and in what order until it stops or a bound stops
// it. Then the loop ENDS and a separate streamed call writes the answer.
//
// ---- why GATHER-THEN-WRITE, and why it must not be "simplified" ------------
//
// The obvious shape is to let the loop's own final turn be the answer: the
// model already has everything, one fewer call, one fewer prompt. It is the
// wrong shape here, for four reasons that are all load-bearing:
//
//  1. **Nothing may stream until the report is the thing streaming.** A loop
//     turn can end in a tool call, a refusal, a truncation or an empty string,
//     and none of those is knowable before the bytes are out. Because this
//     module emits NO delta until the writer runs, a loop that throws is still
//     recoverable — the fall-through to the standard graph below is safe
//     precisely because the client has seen no answer text yet. Stream the loop
//     and that ladder is gone.
//  2. **The writer is the platform's writer.** runSynthesis owns the numbered
//     digest, the source-policy narrowing, the report tier, the citation audit,
//     the search ledger and the streamed max_tokens. A loop that wrote its own
//     answer would reproduce all of that badly or lose it silently — the same
//     argument src/pipeline-standard.js's header makes about retrieval.
//  3. **The loop is non-streaming and re-sends the whole conversation every
//     round.** Its rounds are cheap only while its max_tokens is small. Asking
//     the last round to also emit a 3,000-word report means every EARLIER round
//     is budgeted for one, on a request that pays per round.
//  4. **Validation needs a draft.** runValidation fact-checks a finished draft
//     against the registry and may replace it (`discard_text`). There is no
//     draft to check if the draft was the stream.
//
// So: the loop GATHERS, its text becomes notes, and the writer writes.
//
// ---- the fail-soft ladder, rebuilt explicitly ------------------------------
//
// Invariant 2 stops being structural the moment the phases stop being separate,
// so it is rebuilt here as an ordered ladder, each rung pinned in agentic.test.js:
//
//   one tool errors           → the error is a SENTENCE the model reads, counted
//   MAX_TOOL_ERRORS reached   → later calls are refused; the report is still written
//   the loop throws           → fall through to the standard graph (nothing streamed)
//   deadline / round cap      → the report is written from what was gathered
//   empty toolbox / no dialect→ the standard graph, before any model call
//   empty source registry     → runSynthesis's no-citations clause, unchanged
//
// ---- invariant 7 ------------------------------------------------------------
//
// This module is in src/extensions.test.js's CORE_MODULES, and the trap that
// puts it there is worth naming: a research tool NAME is a service name (the
// imagery tool matches the guard's `/street[_ ]?view/i` on its own). So nothing
// below writes a tool name down. Tools arrive as arrays from the registry, the
// python check is a set membership against one of those arrays, and headlines
// are built from whatever keys a call's arguments happen to have.

import { addUsage } from "./quota.js";
import { capBound } from "./agent-spec.js";
import { recordPhase } from "./budget.js";
import { RESEARCH_TOOL_CLASSES, toolsForRun } from "./tool-sets.js";
import { PYTHON_TOOLS, RESEARCH_TOOL_CONTEXT, RESEARCH_TOOL_EXTENSION } from "./research-tools.js";
import { researchBrief } from "./research-brief.js";
import { runResearchTool } from "./research-tools-run.js";
import {
  MAX_SPENDING_CALLS,
  admitToolCall,
  extensionSliceOn,
  newToolBudget,
} from "./tool-admission.js";
import { canDriveTools } from "./tool-run.js";
import { toolRun } from "./tool-run.js";
import { leadSourceIds, sourcePromptNotes } from "./search-sources.js";
import { toolResultLines } from "../public/js/introspect-core.js";
import { runStandardResearch } from "./pipeline-standard.js";
import { runSynthesis, runValidation, searchPolicyFor } from "./pipeline.js";

/** @typedef {import('./pipeline.js').PipelineCtx} PipelineCtx */

/** The engine's id, as it appears in the request state and the chat log. */
export const AGENTIC_PIPELINE_ID = "agentic/1";

/** Rounds the loop runs before it is made to answer from what it has. Matches
 * src/tool-run.js's DEFAULT_MAX_ROUNDS; named here because an agent narrows it
 * through `capBound(cap, "maxRounds", …)` and a reader should not have to open
 * two files to learn the ceiling it is narrowing. */
export const MAX_RESEARCH_TOOL_ROUNDS = 8;
/** Tool calls one answer may make, across every tool and every round. The round
 * cap alone does not bound this: a model may issue a whole batch per round, and
 * eight rounds of six calls is a request nobody budgeted for. */
export const MAX_RESEARCH_TOOL_CALLS = 16;
/** Consecutive-or-not tool ERRORS after which the loop stops spending. Four
 * because a model that has been told four times that something failed is not
 * recovering — it is looping — and every further round costs a full
 * conversation re-send for nothing. */
export const MAX_TOOL_ERRORS = 4;
/** How much of one tool result reaches the writer's notes block. The registry
 * already carries everything a search returned; this is for the tools that add
 * no sources, so it is sized for a finding, not for a document. */
export const MAX_NOTE_CHARS = 1500;
/** The whole notes block's ceiling. It rides in the synthesis user message
 * beside the numbered digest, and the digest is what the answer must cite. */
export const MAX_NOTES_BLOCK_CHARS = 12_000;

/**
 * Is the agentic engine the platform's OWN default?
 *
 * `true` — the model-driven path is the MAIN path (owner instruction,
 * 2026-08-29). It is the platform's choice, not its only one: a request may
 * still ask for the standard graph (`research_engine`), an agent may still
 * declare it (`capability.routing.strategy`), and `/mcp` pins it, because a
 * model-chosen call order makes the [n] numbering non-reproducible and the
 * ground-truth battery and the published frozen replays both depend on that
 * reproducibility.
 *
 * What makes a default this strong safe is that it is not a floor. engineFor
 * below falls back to the standard graph for any model that cannot drive tools
 * and for any run whose resolved toolbox is empty, and those two checks are
 * what keep every model in the catalog working — invariant 1's requirement,
 * met by a FALLBACK rather than by a ban. The measurement is still owed: the
 * ground-truth battery run paired against the standard graph, with the loss
 * breakdown saying whether synthesis_miss fell without retrieval_miss rising
 * (docs/DR-EVAL-FINDINGS.md, the ground-truth-eval skill). If it says the
 * standard graph wins, that is a finding and this constant is where it lands.
 */
export const AGENTIC_BY_DEFAULT = true;

/** The engines a request or a spec may name. Mirrors agent-spec-core.js's
 * RESEARCH_STRATEGIES minus `auto`, which is a declaration to NOT choose. */
export const RESEARCH_ENGINES = ["agentic", "standard"];

/**
 * One request-or-spec engine name, or `null` for "did not choose".
 *
 * A closed vocabulary with unknown values IGNORED rather than refused: this
 * arrives from an untrusted request body, and a caller that sends a typo should
 * get the platform's choice, not a 400 on a field that is an optimisation.
 * @param {unknown} value
 * @returns {"agentic" | "standard" | null}
 */
export function normalizeResearchEngine(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /** @type {any} */ (RESEARCH_ENGINES.includes(v) ? v : null);
}

/**
 * Which engine runs this request's research phase.
 *
 * Resolution order, most specific first:
 *   1. what the REQUEST asked for (`research_engine`, already normalized onto
 *      the state by the channel that parsed it);
 *   2. what the ANSWERING AGENT declared (`capability.routing.strategy`);
 *   3. the platform's own choice (AGENTIC_BY_DEFAULT), narrowed by the two
 *      facts that decide whether this run CAN drive a loop at all: a model with
 *      a tool dialect, and a non-empty resolved toolbox;
 *   4. the standard graph.
 *
 * Steps 3 and 4 together are what keep every model in the catalog working. The
 * platform's default is the loop, and the answer for a model that cannot drive
 * one is the deterministic graph — not a refusal, and not a loop the model will
 * fail silently in. This is the amended invariant 1's `toolFallback` in the
 * routing layer: the fallback, never a ban, is what makes a tool-driven default
 * safe across a catalog nobody controls.
 *
 * A request outranking a spec is the same direction every other knob takes
 * here: a declaration narrows what an agent does by default, and the caller
 * still chooses. Neither can widen anything — an "agentic" answer ASKED for on
 * a model with no tool dialect, or with an empty toolbox, still lands on the
 * standard graph inside runAgenticResearch, which re-checks both before it
 * calls anything.
 *
 * @param {PipelineCtx} ctx
 * @returns {"agentic" | "standard"}
 */
export function engineFor(ctx) {
  const state = /** @type {any} */ (ctx.state) || {};
  const asked = normalizeResearchEngine(state.researchEngine);
  if (asked) return asked;
  const declared = normalizeResearchEngine(state.capability?.routing?.strategy);
  if (declared) return declared;
  if (!AGENTIC_BY_DEFAULT) return "standard";
  // `?.length` rather than `.length`: this runs on the request path and must
  // answer for any ctx it is handed, including one a channel built without
  // image parts. A router that throws costs the whole turn (invariant 2).
  if (!canDriveTools(ctx.env, ctx.model, { hasImages: (ctx.imageParts?.length || 0) > 0 })) return "standard";
  return researchToolsForRun(ctx).length ? "agentic" : "standard";
}

/**
 * The toolbox for this run: the classes the answering agent declared,
 * intersected with what this deployment can actually serve.
 *
 * `have` is the deployment's answer, one key per `needs` in
 * src/tool-sets.js's TOOL_BINDINGS. Two of them are the request's search policy
 * (an agent or a knob that switched the open web off must not be handed a web
 * tool it would only be refused at the call), and the extension keys are the
 * account's own consent knob — resolved here, generically, off the registry's
 * name → extension table, so this module learns no service's name.
 *
 * An agent that declares no research classes therefore gets an EMPTY toolbox,
 * and an empty toolbox means the standard graph. That is not an oversight: it
 * is how the engine ships off for every committed agent until each one is
 * flipped on its own evidence.
 *
 * @param {PipelineCtx} ctx
 * @returns {any[]}
 */
export function researchToolsForRun(ctx) {
  const state = /** @type {any} */ (ctx.state);
  const policy = searchPolicyFor(state);
  /** @type {Record<string, boolean>} */
  const have = { web: policy.web !== false, auxSources: policy.auxSources !== false };
  // One key per context block an extension tool declares, set from the account
  // knob that consents to that integration. Both tables are data; neither this
  // loop nor this file names an integration (invariant 7).
  for (const [tool, extension] of Object.entries(RESEARCH_TOOL_EXTENSION)) {
    const block = RESEARCH_TOOL_CONTEXT[tool];
    if (block) have[block] = have[block] || extensionSliceOn(state, extension);
  }
  return toolsForRun(state.capability, RESEARCH_TOOL_CLASSES, have);
}

/** The step id for the nth tool call of a run. `tool_<n>` rather than a name,
 * because the client's pipeline map matches the PREFIX and a name would put a
 * service into the SSE vocabulary.
 * @param {number} n */
export const loopStepId = (n) => `tool_${n}`;

/**
 * A human headline for one tool call, built from whatever the arguments
 * actually carry.
 *
 * Deliberately generic. The introspection loop's equivalent
 * (introspect-core.js toolStepHeadline) switches on tool names, which is
 * exactly what a core module may not do here — and the generic version has the
 * better property anyway: a tool added to the registry gets a legible headline
 * with no edit. Strings and string arrays are the only argument shapes worth
 * showing; numbers and booleans are settings, not subjects.
 *
 * @param {string} name
 * @param {any} args
 * @returns {string}
 */
export function toolCallHeadline(name, args) {
  const a = args && typeof args === "object" ? args : {};
  /** @type {string[]} */
  const parts = [];
  for (const value of Object.values(a)) {
    if (parts.length >= 2) break;
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
    else if (Array.isArray(value)) {
      const strings = value.filter((v) => typeof v === "string" && v.trim());
      if (strings.length) parts.push(strings.join(", "));
    }
  }
  const tail = parts.join("  ·  ").replace(/\s+/g, " ").slice(0, 120);
  return tail ? `${name}  ${tail}` : String(name || "tool");
}

/**
 * The loop's gathered material, as the block the writer receives.
 *
 * Results that ADDED SOURCES are left out on purpose: they are already in the
 * numbered registry runSynthesis renders, and repeating them would spend the
 * writer's context on a second, unnumbered copy of the thing it must cite by
 * number. What survives is the material that has no other way in — a corpus
 * row, a computed figure, a lookup — plus whatever the model wrote in its own
 * last turn, which is the closest thing this path has to a plan.
 *
 * @param {{ name: string, headline: string, text: string, sourcesAdded: number }[]} entries
 * @param {string} notes the loop's final assistant text (never emitted)
 * @returns {string}
 */
export function researchNotesSection(entries, notes) {
  /** @type {string[]} */
  const lines = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.sourcesAdded > 0) continue;
    const body = String(e.text || "").trim();
    if (!body) continue;
    lines.push(`${e.headline}\n${body.slice(0, MAX_NOTE_CHARS)}`);
  }
  const summary = String(notes || "").trim();
  if (!lines.length && !summary) return "";
  const block =
    (lines.length
      ? "Findings from tools that returned no citable source (a corpus row, a computed figure, a lookup). " +
        "These are YOUR OWN working notes, not numbered sources: state what they establish in your own words and do NOT give them an [n].\n" +
        lines.join("\n\n")
      : "") +
    (summary ? `${lines.length ? "\n\n" : ""}Your working conclusion at the end of the research:\n${summary}` : "");
  return `Research notes:\n${block.slice(0, MAX_NOTES_BLOCK_CHARS)}\n\n`;
}

/**
 * What the loop is asked. The ENRICHED conversation view (lastUser/convText),
 * the same one runSynthesis reads — every context block an enrichment appended
 * for this turn is in it, so a research turn that was given the site's own
 * source, an OWASP reference or a transcribed photo sees them without this
 * module knowing any of them exist.
 * @param {PipelineCtx} ctx
 * @returns {string}
 */
export function buildLoopInput(ctx) {
  return (
    `Question (latest user message):\n${ctx.lastUser}\n\n` +
    `Conversation context:\n${ctx.convText}\n\n` +
    (ctx.shellBlock ? `${ctx.shellBlock}\n\n` : "") +
    "Research this with your tools, then write the complete answer in the same reply."
  );
}

/** The real collaborators, resolved per call rather than captured in a
 * module-level object — this module and src/pipeline.js import each other, and
 * a bag built at module scope depends on which side the loader enters first.
 * @returns {Record<string, Function>} */
function defaultDeps() {
  return { toolRun, runResearchTool, runStandardResearch, runSynthesis, runValidation };
}

/**
 * Run the agentic research phase for one request.
 *
 * `deps` exists for the unit suite, which drives the loop with a fake provider
 * so the ladder above can be pinned without a socket. Production always takes
 * the default.
 *
 * @param {PipelineCtx} ctx
 * @param {Record<string, Function> | null} [deps]
 */
export async function runAgenticResearch(ctx, deps = null) {
  const d = deps || defaultDeps();
  const { env, log, model } = ctx;
  const state = /** @type {any} */ (ctx.state);
  const plan = state.plan;
  const cap = state.capability || null;

  // A model that cannot drive tools here, and a run whose agent declared no
  // research classes, are the same answer: the standard graph, decided before
  // any model call and before anything is emitted. This is `toolFallback:
  // "pipeline"` in the amended invariant 1 — the fallback, not the ban, is what
  // keeps every mode working across the whole catalog.
  if (!canDriveTools(env, model, { hasImages: (ctx.imageParts?.length || 0) > 0 })) {
    log.info("chat.agentic_fallback", { reason: "no_tool_dialect", model });
    return d.runStandardResearch(ctx);
  }
  const tools = researchToolsForRun(ctx);
  if (!tools.length) {
    log.info("chat.agentic_fallback", { reason: "empty_toolbox", agent: state.agentId || null });
    return d.runStandardResearch(ctx);
  }

  state.pipelineId = AGENTIC_PIPELINE_ID;
  const policy = searchPolicyFor(state);
  const budget = newToolBudget(plan);
  const maxRounds = capBound(cap, "maxRounds", MAX_RESEARCH_TOOL_ROUNDS);
  const maxTokens = capBound(cap, "maxTokens", 8192);

  /** @type {{ name: string, headline: string, text: string, sourcesAdded: number }[]} */
  const transcript = [];
  let calls = 0;
  let errors = 0;
  // The round a tool call belongs to. The loop reports a round only AFTER the
  // call it ran (onToolUse fires after execTool), so the first call of a new
  // round carries the previous round's number. That is cosmetic — `round` rides
  // on the search cards and the trail, and nothing routes on it — and the
  // alternative is a second round counter inside src/tool-run.js that every
  // dialect would have to keep true.
  let round = 1;

  /** @type {import('./research-tools-run.js').ResearchToolCtx} */
  const rctx = {
    state,
    plan,
    emit: ctx.emit,
    step: ctx.step,
    stepDone: ctx.stepDone,
    model,
    identity: state.identity || null,
    requestId: state.requestId || "",
    round,
    budget,
    asked: ctx.cleanLastUser,
  };

  ctx.step("loop", "Researching…");

  /** @param {string} name @param {any} args @returns {Promise<string>} */
  const execTool = async (name, args) => {
    // The two run-level stops, checked before admission so a spent run does not
    // also burn a dedup slot deciding it is spent. Both answer in a sentence:
    // the model reads it, stops asking, and writes.
    if (budget.stop) {
      return (
        "Tool use has stopped for this answer: too many calls failed in a row to keep spending on them. " +
        "Write the complete answer now from what you already gathered, and say plainly what you could not check."
      );
    }
    if (calls >= MAX_RESEARCH_TOOL_CALLS) {
      return (
        `This answer's tool allowance is used up (${MAX_RESEARCH_TOOL_CALLS} calls). No further tool will run. ` +
        "Write the complete answer from what you have, and name what is still open."
      );
    }
    const admission = admitToolCall(name, args, { state, env, identity: rctx.identity, budget, plan, policy, tools });
    if (!admission.ok) {
      log.info("chat.tool_refused", { tool: name, round });
      return admission.message;
    }

    calls++;
    const id = loopStepId(calls);
    const headline = toolCallHeadline(name, admission.args);
    ctx.step(id, headline);
    rctx.round = round;
    const startedAt = Date.now();
    /** @type {import('./research-tools-run.js').ResearchToolResult} */
    let result;
    try {
      result = await d.runResearchTool(env, log, name, admission.args, rctx);
    } catch (/** @type {any} */ err) {
      // The rung BELOW the runner's own catch, which already turns a failed
      // lookup into a sentence. This one is for the failure that gets past it —
      // a throw out of the catch, a dep the unit suite swapped in — and it is
      // not redundant with the loop's wire catching it, because the wire's
      // catch produces a string and nothing else. Two things have to happen:
      // the model reads a sentence, AND the error is COUNTED, so four broken
      // calls stop the run instead of costing it four whole conversation
      // re-sends on their way to the same failure.
      log.warn("chat.tool_threw", { tool: name, error: err?.message || String(err) });
      result = {
        text:
          `The ${name} tool failed and returned nothing. This is a fault on this server, not something ` +
          `your arguments caused. Use a different tool, or write the answer from what you already have and ` +
          `say what could not be checked.`,
        isError: true,
        found: false,
        sourcesAdded: 0,
      };
    }
    // budget.js PRIORS_MS carries a `tool` row for exactly this call; a key it
    // does not carry is dropped by recordPhase in silence, so its model would
    // never warm an EWMA and the planner would budget the loop off a cold prior
    // forever.
    recordPhase(model, "tool", Date.now() - startedAt);
    // The forward-compatible `extra` seam: a client that does not know `tool`
    // or `round` ignores them (the SSE forward-compatibility rule), and the one
    // that does never has to parse an English label.
    ctx.stepDone(id, headline, toolResultLines(result.text), { tool: name, round });
    if (result.isError) {
      errors++;
      if (errors >= MAX_TOOL_ERRORS) {
        log.warn("chat.tool_errors_exceeded", { errors, calls });
        budget.stop = true;
      }
    } else {
      transcript.push({ name, headline, text: result.text, sourcesAdded: result.sourcesAdded });
    }
    return result.text;
  };

  const brief = researchBrief({
    tier: plan.reportTier,
    tools,
    deadlineS: remainingSeconds(state),
    capability: cap,
    hasSource: !!ctx.hasSource,
    // Membership against the registry's own array, so the check survives a
    // renamed tool and this module still writes no tool name down.
    python: tools.some((t) => PYTHON_TOOLS.includes(t)),
    // The invariant-6 pair. The deterministic gates that used to route a
    // Swedish message to the right corpus do not run on this path, so the SAME
    // functions are run here and their verdict is folded into the brief as a
    // hint — one regex set, parity-tested where it lives, reaching the model
    // that is now doing the routing itself. `gateLastUser`, not `lastUser`:
    // src/pipeline.test.js pins that distinction for every other gate.
    leadHints: leadSourceIds(ctx.gateLastUser),
    sourceNotes: sourcePromptNotes(cap),
    maxRounds,
    maxCalls: MAX_SPENDING_CALLS,
  });

  const loopStartedAt = Date.now();
  /** @type {any} */
  let result;
  try {
    result = await d.toolRun(env, {
      model,
      system: brief,
      userContent: buildLoopInput(ctx),
      tools,
      execTool,
      maxRounds,
      maxTokens,
      onToolUse: (/** @type {any} */ info) => {
        if (typeof info?.round === "number" && info.round > round) round = info.round;
      },
    });
  } catch (/** @type {any} */ err) {
    // Nothing has streamed — that is what makes this rung of the ladder safe
    // rather than a second answer on top of half of one. The gathering the loop
    // DID do is not lost either: sources it absorbed are in the registry, and
    // the standard graph writes over the same registry.
    log.warn("chat.agentic_loop_failed", { error: err?.message || String(err), calls });
    ctx.stepDone("loop", "Research loop failed — falling back", [], { route: "research" });
    return d.runStandardResearch(ctx);
  }

  addUsage(state.totals, result.usage);
  const rounds = Math.max(1, result.rounds || 1);
  // Recorded per ROUND, not per loop: the planner's unit of forecasting is a
  // phase it can decide to skip, and a whole loop is not skippable — a round is.
  recordPhase(model, "round", Math.round((Date.now() - loopStartedAt) / rounds));
  state.iterations = rounds;
  log.info("chat.agentic_loop", {
    rounds,
    calls,
    errors,
    tool_calls: result.toolCalls || 0,
    sources: state.sources.length,
    stop_reason: result.stopReason || null,
  });
  ctx.stepDone(
    "loop",
    calls
      ? `Researched with ${calls} tool call${calls === 1 ? "" : "s"} over ${rounds} round${rounds === 1 ? "" : "s"}`
      : "Answered without calling a tool",
    [],
    { tool_calls: calls, rounds },
  );

  // THE LOOP'S TEXT IS NEVER EMITTED. It is the model's working conclusion, and
  // it becomes the notes block the writer reads — see the header.
  const draft = await d.runSynthesis(ctx, researchNotesSection(transcript, result.text));
  await d.runValidation(ctx, draft);
}

/**
 * Whole seconds of the request's time target still unspent, or 0 when there is
 * no target to report. The brief tells the model this so it does not start a
 * call whose result arrives after the answer was due.
 * @param {any} state
 * @returns {number}
 */
export function remainingSeconds(state) {
  const budgetMs = Number(state?.plan?.budgetMs);
  const startedAt = Number(state?.startedAt);
  if (!Number.isFinite(budgetMs) || !Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.round((startedAt + budgetMs - Date.now()) / 1000));
}
