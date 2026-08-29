// @ts-check
// The STANDARD compact deep-research pipeline — the four-node topology, as an
// OPTION beside the bespoke five-phase flow in src/pipeline.js.
//
//   generate_queries → web_research → reflect → finalize
//                          ↑______________|
//                            the one loop edge
//
// This is the shape shipped in gemini-fullstack-langgraph-quickstart and
// reproduced by open-deep-research and local-deep-researcher: the most-copied
// compact deep-research graph in public code. It exists here so the platform
// can be run — and MEASURED — on the standard topology rather than only on the
// one this project grew, and so a reader who knows the standard graph can find
// it, node for node, in a file they can hold in their head.
//
// What it is NOT: a second retrieval engine, and not a second writer. Nodes 2
// and 4 are pipeline.js's own functions, called unchanged. Every per-source
// cap, the cross-wave dedup, the deterministic absorption order that fixes
// citation numbering, the source-policy narrowing, the search_start /
// search_done cards, the streamed answer, the citation audit and the
// validation pass all come from there. Those were never "the five-phase
// pipeline" — they are the platform — and a topology option that forked them
// would be a topology option that quietly regressed them.
//
// So this module is four nodes and one loop edge, and nothing else:
//
//   1. generateQueries — ONE JSON call. Angles, a rationale shown to the user,
//      and a `direct` boolean that stands in for triage's direct branch. No
//      clarify branch: this graph has nowhere to put one (see queryPlanPrompt).
//   2. the initial wave — runNamedUrlReads then runSearches, from pipeline.js.
//   3. reflect — ONE JSON call per round, at most STANDARD_MAX_REFLECT_ROUNDS.
//      It emits an artefact the gap check never did: a STATED knowledge gap,
//      in words, that the trail shows and the answer must carry as an explicit
//      limitation. The gap check's verdict was a saturation boolean, so a run
//      that stopped short left no record of what it had failed to find.
//   4. finalize — runSynthesis (streamed) then runValidation, from pipeline.js.
//
// Invariant 1 holds throughout: every node is a plain JSON-mode or streamed
// call, so this runs on Berget's whole catalog, tool use or not.
//
// Invariant 2 holds throughout: a node whose JSON is unusable degrades to a
// lesser run (model-free seeded angles, an unreflected wave, an unrevised
// draft) and never errors the request. The strongest statement of that is
// pinned by the test: a JSON model that returns null on EVERY call still
// produces an answer.

import { fitsDeadline } from "./budget.js";
import { previousUserText } from "./conversation.js";
import { extractNamedUrls } from "./named-urls.js";
import { knowledgeGapsSection } from "./pipeline-inputs.js";
import { phasePrompt } from "./prompt-sets.js";
import { arrayOf, boolean, object, string } from "./schema.js";
import { sourceDigest } from "./sources.js";
import { hardenJson, seedFromConversation } from "./triage.js";
import {
  jsonPhase,
  runDirectReply,
  runNamedUrlReads,
  runSearches,
  runSynthesis,
  runValidation,
} from "./pipeline.js";

/** @typedef {import('./pipeline.js').PipelineCtx} PipelineCtx */

/** The engine's id, as it appears in the request state and the chat log. */
export const STANDARD_PIPELINE_ID = "standard/1";

/**
 * The ceiling on the loop edge. Two is the shipped quickstart's own bound and
 * the point past which reflection stops paying here: the sources a third round
 * adds are the ones the per-domain cap was already dropping, while its JSON
 * call and its wave come straight off the synthesis budget. The planner may
 * ask for fewer (reflectRoundsFor); it can never ask for more.
 */
export const STANDARD_MAX_REFLECT_ROUNDS = 2;

/**
 * Node 1's declared shape. Every field optional: a plan missing `queries`
 * falls to the model-free seed, and a plan missing `direct` is a research
 * plan, which is the safe reading — an unnecessary search wastes time, a
 * skipped one produces an ungrounded answer.
 */
export const QUERY_PLAN_SCHEMA = object(
  {
    queries: arrayOf(string({ allowEmpty: false })),
    rationale: string({ coerce: true }),
    direct: boolean(),
  },
  /** @type {any} */ ({ optional: ["queries", "rationale", "direct"] }),
);

/**
 * Node 3's declared shape. `sufficient` optional and absent-means-false for
 * the same asymmetry: an extra round costs time, a skipped one costs coverage.
 * The loop's real bounds are the round ceiling, the search cap and the
 * deadline, so a model that never says "sufficient" cannot spin.
 */
export const REFLECT_SCHEMA = object(
  {
    sufficient: boolean(),
    knowledge_gap: string({ coerce: true }),
    follow_up_queries: arrayOf(string({ allowEmpty: false })),
  },
  /** @type {any} */ ({ optional: ["sufficient", "knowledge_gap", "follow_up_queries"] }),
);

/**
 * The default node dependencies: pipeline.js's own phase helpers, resolved on
 * each call rather than captured in a module-level object.
 *
 * Deliberate. This module imports pipeline.js, and the wiring that makes the
 * engine reachable will eventually have a caller import this module back —
 * function declarations survive that cycle, a module-level `const` bag built
 * from them may not, depending on which side the loader enters first. Building
 * the bag inside a call removes the question entirely, and costs one object
 * literal per request.
 * @returns {Record<string, Function>}
 */
function defaultDeps() {
  return { jsonPhase, runNamedUrlReads, runSearches, runDirectReply, runSynthesis, runValidation };
}

/**
 * How many reflect rounds this budget buys.
 *
 * ONE whenever the budget affords any follow-up work at all, none at the
 * floor, and two only when a planner says so explicitly. The five-phase flow's
 * `gapIterations` is a striving ceiling — it climbs to eight at the deepest
 * tiers — and reading it as a reflect count would turn the compact topology
 * into the cascade it is offered as an alternative to. `plan.reflectRounds` is
 * read first so a planner that grows the field governs without a change here.
 * @param {import('./budget.js').BudgetPlan & { reflectRounds?: number }} plan
 * @returns {number}
 */
export function reflectRoundsFor(plan) {
  const declared = Number(plan?.reflectRounds);
  const rounds = Number.isFinite(declared) ? declared : (plan?.gapIterations > 0 ? 1 : 0);
  return Math.max(0, Math.min(STANDARD_MAX_REFLECT_ROUNDS, Math.floor(rounds)));
}

/**
 * Hardens node 1's raw JSON into a usable plan, with the same model-free
 * fallback triage has.
 *
 * The fallback is not a nicety. This node writes the strings that go to a
 * search engine, and a planner failing on a follow-up turn ("undersök saken",
 * "tell me more") is exactly when a bare back-reference would otherwise be
 * sent verbatim — the reported bug seedFromConversation exists to prevent. It
 * is imported, never re-derived: one seeder, one set of rules, both languages.
 *
 * @param {any} raw Raw (or schema-hardened) query-plan JSON — may be anything.
 * @param {string} question The latest user message, as the planner saw it.
 * @param {{ priorUser?: string, maxQueries?: number }} [opts]
 * @returns {{ queries: string[], rationale: string, direct: boolean, seeded: boolean }}
 */
export function normalizeQueryPlan(raw, question, { priorUser = "", maxQueries = 0 } = {}) {
  const rationale = typeof raw?.rationale === "string" ? raw.rationale.trim().slice(0, 300) : "";
  const queries = [];
  const seen = new Set();
  for (const q of Array.isArray(raw?.queries) ? raw.queries : []) {
    if (typeof q !== "string") continue;
    const trimmed = q.trim();
    // Case-folded dedup: the planner returning "Acme AB revenue" twice in
    // different case would otherwise spend two of a handful of angles on one
    // search. runSearches dedups across waves; within a wave is this node's.
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    queries.push(trimmed);
  }
  const capped = maxQueries > 0 ? queries.slice(0, maxQueries) : queries;

  // An explicit `direct` is honoured even when angles came with it: the
  // planner deciding no source is needed outranks angles it wrote anyway.
  if (raw?.direct === true) return { queries: [], rationale, direct: true, seeded: false };
  if (capped.length) return { queries: capped, rationale, direct: false, seeded: false };

  // Nothing usable came back. Seed without a model.
  const seed = seedFromConversation(String(question || ""), String(priorUser || ""));
  if (seed.action === "research") {
    return { queries: seed.queries, rationale, direct: false, seeded: true };
  }
  return { queries: [], rationale, direct: true, seeded: true };
}

/**
 * Hardens node 3's raw JSON. Fields are read leniently so a schema miss
 * degrades the same way a schema hit with empty fields does.
 * @param {any} raw
 * @param {number} maxFollowups
 * @returns {{ sufficient: boolean, gap: string, queries: string[] }}
 */
function normalizeReflection(raw, maxFollowups) {
  const gap = typeof raw?.knowledge_gap === "string" ? raw.knowledge_gap.trim().slice(0, 300) : "";
  const queries = (Array.isArray(raw?.follow_up_queries) ? raw.follow_up_queries : [])
    .filter((/** @type {any} */ q) => typeof q === "string" && q.trim())
    .map((/** @type {string} */ q) => q.trim())
    .slice(0, Math.max(1, maxFollowups));
  // No follow-up queries IS sufficiency, whatever the boolean says: there is
  // nothing left for the loop edge to carry, so treating it as "keep going"
  // would only buy another JSON call with the same empty result.
  return { sufficient: raw?.sufficient === true || queries.length === 0, gap, queries };
}

// ---- node 1: generate_queries ---------------------------------------------

/**
 * ONE JSON call on the fixed reliable JSON model (invariant 3), against the
 * PLANNING view of the conversation — planLastUser / planConvText, the view
 * with the method blocks removed. Same reason as triage's: this node writes
 * search strings, and an appended report-format block is the one thing that
 * can never be a search target (feedback #65).
 * @param {PipelineCtx} ctx
 * @param {Record<string, Function> | null} [deps]
 * @returns {Promise<{ queries: string[], rationale: string, direct: boolean, seeded: boolean }>}
 */
export async function generateQueries(ctx, deps = null) {
  const d = deps || defaultDeps();
  const { state, planLastUser: lastUser, planConvText: convText } = ctx;
  const maxQueries = Math.max(2, state.plan.queries);
  ctx.step("plan", "Planning searches…");

  const raw = await d.jsonPhase(ctx, {
    label: "query_plan",
    // The BUDGET key, and it must exist in budget.js PRIORS_MS or recordPhase
    // drops every measurement in silence and this node's estimate stays the
    // cold prior forever.
    statKey: "queries",
    recordStat: true,
    maxTokens: 500,
    messages: [
      {
        role: "system",
        // `capability` for the same reason triage passes it: the composed
        // source notes must describe only the corpora the ANSWERING agent may
        // consult, or the plan promises a leg that will never run.
        content: phasePrompt(state, "research", "plan")(maxQueries, {
          reinforceJsonOnly: ctx.reinforceJsonOnly,
          capability: /** @type {any} */ (state).capability || null,
        }),
      },
      { role: "user", content: `Conversation:\n${convText}\n\nLatest user message:\n${lastUser}` },
    ],
  });

  const plan = normalizeQueryPlan(hardenJson(QUERY_PLAN_SCHEMA, raw), lastUser, {
    priorUser: previousUserText(ctx.conversation),
    maxQueries,
  });
  ctx.log.info("chat.query_plan", {
    queries: plan.queries.length,
    direct: plan.direct,
    seeded: plan.seeded,
  });

  if (plan.direct) {
    ctx.stepDone("plan", "Direct reply (no sources needed)", [], { route: "direct" });
    return plan;
  }
  const n = plan.queries.length;
  ctx.stepDone(
    "plan",
    `Planned ${n} search angle${n === 1 ? "" : "s"} · target ${state.plan.budgetS}s`,
    // The rationale rides in the detail list, so a run can be judged on
    // whether its angles follow from the reason it gave for them.
    plan.rationale ? [plan.rationale, ...plan.queries] : [...plan.queries],
    { route: "research" },
  );
  return plan;
}

// ---- node 3: reflect ------------------------------------------------------

/**
 * ONE JSON call per round, on the same fixed JSON model. Returns the verdict,
 * the stated gap and the follow-up angles; fully fail-soft — unusable JSON
 * reads as "sufficient, nothing stated", which ends the loop and writes the
 * report from what is already collected.
 * @param {PipelineCtx} ctx
 * @param {number} [round]
 * @param {Record<string, Function> | null} [deps]
 * @returns {Promise<{ sufficient: boolean, gap: string, queries: string[] }>}
 */
export async function reflect(ctx, round = 1, deps = null) {
  const d = deps || defaultDeps();
  const { state, planLastUser: lastUser, planConvText: convText } = ctx;
  const plan = state.plan;
  const stepId = `reflect${round}`;
  ctx.step(stepId, `Reflecting on coverage (round ${round})…`);

  const raw = await d.jsonPhase(ctx, {
    label: `reflect_${round}`,
    statKey: "reflect", // budget.js PRIORS_MS — see generateQueries' note.
    recordStat: true,
    maxTokens: 500,
    messages: [
      {
        role: "system",
        content: phasePrompt(state, "research", "reflect")([...state.ranQueries], plan.followups, {
          subquestions: state.subquestions || [],
          reinforceJsonOnly: ctx.reinforceJsonOnly,
          capability: /** @type {any} */ (state).capability || null,
        }),
      },
      {
        role: "user",
        content:
          `Research question (latest user message):\n${lastUser}\n\nConversation context:\n${convText}\n\n` +
          `Sources collected so far:\n${sourceDigest(state.sources, plan.digestCap) || "(none)"}`,
      },
    ],
  });

  const r = normalizeReflection(hardenJson(REFLECT_SCHEMA, raw), plan.followups);
  if (r.sufficient) {
    ctx.stepDone(stepId, r.gap ? `Coverage sufficient — remaining gap: ${r.gap}` : "Coverage sufficient");
  } else {
    ctx.stepDone(
      stepId,
      `Gap: ${r.gap || "coverage incomplete"} — ${r.queries.length} follow-up search${r.queries.length === 1 ? "" : "es"}`,
      r.queries,
    );
  }
  return r;
}

// ---- the graph ------------------------------------------------------------

/**
 * Runs the whole four-node graph for one request. Same contract as
 * pipeline.js's research flow: everything streams through ctx.emit, and it
 * resolves when the answer (and any revision) has been written.
 *
 * `deps` exists for the unit suite, which drives the graph with fake nodes so
 * the loop edge, the deadline exit and the fail-soft degradation can be pinned
 * without a provider, a search index or a socket. Production always takes the
 * default — pipeline.js's real helpers.
 *
 * @param {PipelineCtx} ctx
 * @param {Record<string, Function> | null} [deps]
 */
export async function runStandardResearch(ctx, deps = null) {
  const d = deps || defaultDeps();
  const { log, state } = ctx;
  const plan = state.plan;
  /** @type {any} */ (state).pipelineId = STANDARD_PIPELINE_ID;
  /** @type {string[]} */
  const gaps = (/** @type {any} */ (state).knowledgeGaps ||= []);

  // Node 1.
  const queryPlan = await generateQueries(ctx, d);

  // Node 2, first half: read the pages the user NAMED, before any search.
  // Unchanged from the five-phase flow, and it runs ABOVE the direct branch
  // for the same reason it does there — what came back decides that branch.
  // Feedback #67: five pasted URLs the run then spent fifteen angles failing
  // to rediscover.
  await d.runNamedUrlReads(ctx, extractNamedUrls(ctx.cleanLastUser));

  // The direct branch. Gated on what was actually READ, not on what was
  // linked: pasting a link and asking about it IS research over that page, and
  // "I can't browse arbitrary URLs" is the one answer that is both useless and
  // wrong for a question we can serve.
  if (queryPlan.direct && !state.namedUrlCount) return d.runDirectReply(ctx);

  // Node 2, second half: the existing wave engine, untouched.
  await d.runSearches(ctx, queryPlan.queries, 1);

  // Node 3 and the ONE loop edge.
  const rounds = reflectRoundsFor(plan);
  const est = plan.estimates;
  for (let round = 1; round <= rounds; round++) {
    if (state.searchCount >= plan.maxSearches) break;
    // Estimates are estimates, so re-check before each round: proceed only if
    // this round plus the phases that MUST still run fit the target. `reflect`
    // and the gap check are the same call on the same model, so the gap prior
    // is the honest stand-in until a planner carries a `reflect` estimate of
    // its own (budget.js phaseEstimates already warms one under that key).
    const upcoming =
      (est.reflect ?? est.gap) +
      plan.followups * est.search +
      est.synth +
      (plan.validate ? est.validate : 0);
    if (!fitsDeadline(state.startedAt, plan.budgetMs, upcoming)) {
      log.info("chat.budget_cut", { cut: "reflect_round", round });
      break;
    }

    // The loop edge is OPTIONAL work; the report is not (invariant 2). The
    // node's own JSON failures are already soft — jsonPhase returns null and
    // normalizeReflection reads that as "sufficient, nothing stated" — so this
    // catches only the unexpected: a prompt builder or a dep that throws.
    // Losing the whole answer over a round we could simply not run would be
    // the worst trade in the graph.
    let r;
    try {
      r = await reflect(ctx, round, d);
    } catch (/** @type {any} */ err) {
      log.warn("chat.reflect_failed", { round, error: err?.message || String(err) });
      break;
    }
    // The stated gap is recorded whichever way the verdict went: a gap that
    // remains after a "sufficient" verdict is exactly the one the report has
    // to own, and it is the artefact the saturation boolean never produced.
    if (r.gap && !gaps.includes(r.gap)) gaps.push(r.gap);
    if (r.sufficient) break;

    state.iterations++;
    await d.runSearches(ctx, r.queries, round + 1);
  }

  // Node 4: the existing writer, then the existing validator.
  const draft = await d.runSynthesis(ctx, knowledgeGapsSection(gaps));
  await d.runValidation(ctx, draft);
}
