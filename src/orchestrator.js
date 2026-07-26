// @ts-check
// Orchestrator mode — the chat mode that runs SUB-AGENTS in the background of
// one request and streams the workflow they perform. The pure logic (plan
// schema, validation, wave resolution, prompts for the plan phase and node
// tasks, the workflow/agent_update SSE shapes) lives in the shared core
// public/js/orchestrator-core.js (the sdk-core/agent-spec-core convention);
// this module is the Worker executor: it runs the JSON plan phase, executes
// the nodes wave by wave, and streams the final merge.
//
// Invariants upheld:
//  1. Deterministic orchestration, NO function calling: the plan phase is one
//     JSON-mode call on the fixed jsonModel (invariant 3 — like triage); the
//     resulting workflow is DATA executed by this code. No model decides
//     control flow mid-run, so the mode works on any catalog model.
//  2. Fail-soft everywhere: a failed/timed-out node becomes an honest gap note
//     in the merge input; an unusable plan degrades to a single-agent
//     workflow; only the final merge streaming can fail the chat (like any
//     synthesis).
//  3. Split routing/billing: plan on jsonModel (jsonTotals), every node and
//     the merge on the user's chosen model (totals) via streamCompletion —
//     which also brings the retry/failover machinery to each node for free.

import { streamCompletion } from "./answer-stream.js";
import { completeJson } from "./providers.js";
import { webSearch } from "./exa.js";
import { loggerRequestId } from "./log.js";
import { addUsage } from "./quota.js";
import { classifyFailure, recordSubsystemFailure } from "./server-errors.js";
import { addSources, sourceDigest } from "./sources.js";
import { retrieveSourceBlockFor } from "./introspect.js";
import { phasePrompt } from "./prompt-sets.js";
import {
  MAX_ORCH_SEARCHES,
  agentTaskPrompt,
  agentUpdateEvent,
  clampResult,
  findWorkflowAgent,
  mergeAgentResults,
  normalizeWorkflow,
  workflowEvent,
  workflowWaves,
} from "../public/js/orchestrator-core.js";

/** @typedef {import('./pipeline.js').PipelineCtx} PipelineCtx */

// Per-node bounds: a node is a helper, not the answer — it gets a tighter
// completion budget than synthesis and a hard wall-clock so one hung provider
// call can't eat the request (the same reasoning as berget.js's JSON-call
// timeout; Workers Paid means CPU is not the scarce resource, wall-clock is).
export const ORCH_NODE_MAX_TOKENS = 2048;
export const ORCH_NODE_TIMEOUT_MS = 150_000;
const ORCH_PLAN_MAX_TOKENS = 900;

// How many node failures are described in full in the chat_logs row. A run is
// capped at MAX_AGENTS (6) nodes, so this can only bind if the cap moves or a
// future retry loop re-fails the same node — bound it anyway rather than let a
// log field grow with the run (the `failed` COUNT stays exact regardless).
export const MAX_LOGGED_FAILURES = 12;

/**
 * The whole Orchestrator answer phase (routed from pipeline.js runPipeline
 * when state.orchestratorMode is set — before triage; the workflow replaces
 * the normal research flow).
 * @param {PipelineCtx} ctx
 */
export async function runOrchestration(ctx) {
  const { state, emit } = ctx;
  const anyState = /** @type {any} */ (state);
  const hasSource = !!anyState.sourceSnapshot;
  // The client's SWARM capability (chat.js `swarm`): this browser can host
  // on-device models, so the plan phase may use the `swarm` kind and the
  // pre-pass may already have run those nodes here.
  const swarm = anyState.swarm || null;
  const swarmResults = anyState.swarmResults || {};

  // ---- Phase 1: plan (JSON mode, fixed jsonModel) -------------------------
  //
  // TWO WAYS IN. Normally this phase plans the team. But a swarm node runs in
  // the USER'S BROWSER, and one streamed request has no channel back to it —
  // so when the client can host a swarm it asks /api/orchestrator/plan FIRST
  // (src/orchestrator-api.js, the same JSON call on the same model), runs the
  // swarm nodes locally, and sends the finished plan plus their briefs with
  // this request. The plan still arrives as untrusted JSON and goes through
  // the same normalizeWorkflow gate — the client chose nothing the plan model
  // could not have chosen on its own.
  const preplanned = anyState.orchWorkflow ? normalizeWorkflow(anyState.orchWorkflow, { hasSource, hasSwarm: !!swarm }) : null;
  ctx.step("plan", preplanned ? "Assembling the sub-agent team…" : "Planning the sub-agent team…");
  let raw = null;
  if (!preplanned) {
    try {
      const r = await completeJson(
        ctx.env,
        [{
          role: "user",
          content: phasePrompt(state, "workflow", "plan")({
            message: /** @type {any} */ (ctx).cleanLastUser || ctx.lastUser,
            hasSource,
            hasSwarm: !!swarm,
            swarmModel: swarm?.modelLabel || "",
          }),
        }],
        { model: ctx.jsonModel, maxTokens: ORCH_PLAN_MAX_TOKENS },
      );
      addUsage(state.jsonTotals, r.usage);
      ctx.log.info("chat.json_diag", { phase: "orch_plan", model: ctx.jsonModel, ...r.diagnostics });
      raw = r.value;
    } catch (/** @type {any} */ err) {
      ctx.log.warn("chat.phase_failed", { phase: "orch_plan", model: ctx.jsonModel, error: err?.message || String(err) });
      // Durable too: a plan phase that keeps failing silently degrades every
      // Orchestrator run to a one-agent fallback, which reads to the user as
      // "the mode does nothing" rather than as a bug.
      await recordSubsystemFailure(ctx.env, ctx.log, {
        subsystem: "orchestrator",
        op: "plan",
        failureClass: classifyFailure(err),
        detail: err?.message || String(err),
        requestId: loggerRequestId(ctx.log),
        context: { model: ctx.jsonModel },
      });
    }
  }
  let plan = preplanned || normalizeWorkflow(raw, { hasSource, hasSwarm: !!swarm });
  if (!plan) plan = fallbackPlan(ctx);
  /** @type {Array<{ id: string, kind: string, wave: number, class: string, ms: number, note: string }>} */
  const failures = [];
  const { waves } = workflowWaves(plan);
  emit({ status: /** @type {any} */ (workflowEvent(plan)) });
  ctx.stepDone(
    "plan",
    `Team of ${plan.agents.length} agent${plan.agents.length === 1 ? "" : "s"} in ${waves.length} stage${waves.length === 1 ? "" : "s"}`,
    plan.agents.map((a) => `${a.name} — ${a.task}`),
  );

  // ---- Phase 2: execute the workflow, wave by wave ------------------------
  /** @type {Record<string, { status: string, text?: string, note?: string }>} */
  const results = {};
  // Nodes the BROWSER already ran (swarm) enter as finished work — their
  // status is announced so a client that missed the local run (a reopened
  // conversation, a second tab replaying the stream) still sees the node done.
  let swarmNodes = 0;
  for (const agent of plan.agents) {
    if (agent.kind !== "swarm") continue;
    const done = swarmResults[agent.id];
    if (!done?.text) continue;
    swarmNodes++;
    results[agent.id] = { status: "done", text: clampResult(done.text) };
    emit({
      status: /** @type {any} */ (agentUpdateEvent(agent.id, "done", { chars: String(done.text).length })),
    });
    ctx.step(`agent_${agent.id}`, `${agent.name} ran in your browser`);
    ctx.stepDone(
      `agent_${agent.id}`,
      `${agent.name} — ${done.members || "?"} on-device members, ${Math.round((done.agreement || 0) * 100)}% agreement`,
    );
  }
  const searchBudget = { used: 0 };
  let failed = 0;
  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    // Nodes within a wave are independent by construction — run them
    // concurrently (the runSearches Promise.all reasoning: sequential
    // sub-agents would leave most of the wall-clock on the table).
    await Promise.all(
      wave.map(async (id) => {
        const agent = findWorkflowAgent(plan, id);
        if (!agent) return;
        if (results[id]) return; // already done in the browser (a swarm node)
        const stepId = `agent_${id}`;
        const startedAt = Date.now();
        // The node's cancellation token. `withTimeout` cannot stop the
        // underlying provider call (there is no cross-provider abort to
        // thread), but flipping this makes the ABANDONED node let go of its
        // buffered text and stop emitting into a stream that has already moved
        // on — the accumulate-forever half of a run's memory growth.
        const token = { cancelled: false };
        try {
          // Inside the guard on purpose: the announce calls are the only work
          // that used to sit OUTSIDE it, so a throw there (a client-side emit
          // sink that died, a malformed node) escaped every fail-soft path and
          // took the whole request down with it.
          emit({ status: /** @type {any} */ (agentUpdateEvent(id, "running")) });
          ctx.step(stepId, `${agent.name} working…`);
          const text = await withTimeout(
            runAgentNode(ctx, plan, agent, results, searchBudget, token),
            ORCH_NODE_TIMEOUT_MS,
            () => { token.cancelled = true; },
          );
          // Store CLAMPED. mergeAgentResults clamps again at prompt-assembly
          // time, but that is too late to bound what the run HOLDS: a
          // degenerate generation would sit in `results` for the rest of the
          // run (and then in the chat_logs meta) at full length.
          const kept = clampResult(text);
          results[id] = { status: "done", text: kept };
          emit({ status: /** @type {any} */ (agentUpdateEvent(id, "done", { duration_ms: Date.now() - startedAt, chars: kept.length })) });
          ctx.stepDone(stepId, `${agent.name} finished (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
        } catch (/** @type {any} */ err) {
          failed++;
          const ms = Date.now() - startedAt;
          const record = nodeFailureRecord(agent, w, err, ms, { timedOut: token.cancelled });
          pushFailure(failures, record);
          // The class rides in the SSE note (agentUpdateEvent's shape is fixed
          // in the shared core), so the workflow graph can say "timed out"
          // rather than just turning the node red.
          const note = `${record.class}: ${record.note}`.slice(0, 200);
          results[id] = { status: "failed", note };
          emit({ status: /** @type {any} */ (agentUpdateEvent(id, "failed", { note, duration_ms: ms })) });
          ctx.stepDone(stepId, `${agent.name} failed — continuing without it`);
          ctx.log.warn("chat.orch_node_failed", { agent: id, kind: agent.kind, class: record.class, duration_ms: ms, error: record.note });
          // …and DURABLY, in the fix queue. Invariant 2 says this failure must
          // not break the request; it does not say it should be invisible. A
          // Workers Logs line ages out and cannot be searched after the fact,
          // and if the run later dies before chat.js writes its row, this is
          // the only surviving evidence the node ever ran.
          await recordSubsystemFailure(ctx.env, ctx.log, {
            subsystem: "orchestrator",
            op: "node",
            failureClass: record.class,
            detail: record.note,
            requestId: loggerRequestId(ctx.log),
            // Closed-vocabulary context only — never the agent id/name, which
            // the plan model derived from the user's request.
            context: { kind: agent.kind, wave: `${w + 1}/${waves.length}`, ms },
          });
        }
      }),
    );
  }
  // Meta for the chat log (the chat-logs skill greps on this).
  anyState.orchestration = { agents: plan.agents.length, waves: waves.length, failed, searches: searchBudget.used };
  // Per-node failure detail, so `scripts/chatlogs --id N` answers "which
  // sub-agent died and how" instead of only "failed: 2". Dropped entirely on a
  // clean run (JSON.stringify drops undefined) — a zero-failure row stays
  // exactly as it was.
  if (failures.length) anyState.orchestration.failures = failures;
  if (swarm || swarmNodes) {
    // What the browser actually did — the only trace of a client-hosted swarm
    // the server can log (the reasoning itself never leaves the device).
    anyState.orchestration.swarm = {
      nodes: swarmNodes,
      members: Object.values(swarmResults).reduce((n, r) => n + (Number(/** @type {any} */ (r)?.members) || 0), 0),
      agreement: swarmNodes
        ? Math.round(
            (Object.values(swarmResults).reduce((n, r) => n + (Number(/** @type {any} */ (r)?.agreement) || 0), 0) / swarmNodes) * 100,
          ) / 100
        : 0,
      model: swarm?.modelId || "",
    };
  }

  // ---- Phase 3: merge (streamed on the user's model) ----------------------
  ctx.step("synth", "Merging the team's briefs…");
  const digest = sourceDigest(state.sources, state.plan.digestCap);
  const merged = mergeAgentResults(plan, results);
  const synthText = [
    `Conversation so far:\n${/** @type {any} */ (ctx).cleanConvText || ctx.convText}`,
    `Sub-agent briefs:\n\n${merged}`,
  ].join("\n\n");
  await streamCompletion(ctx, [
    { role: "system", content: phasePrompt(ctx.state, "workflow", "answer")({ title: plan.title, digest, hasShell: !!(/** @type {any} */ (ctx).shellBlock) }) },
    {
      role: "user",
      content: ctx.imageParts.length ? [{ type: "text", text: synthText }, ...ctx.imageParts] : synthText,
    },
  ]);
  ctx.stepDone(
    "synth",
    failed
      ? `Answer merged from ${plan.agents.length - failed} of ${plan.agents.length} agent briefs`
      : `Answer merged from ${plan.agents.length} agent brief${plan.agents.length === 1 ? "" : "s"}`,
  );
}

/**
 * One node failure, described well enough to fix it: WHICH node (id + kind),
 * WHERE in the run (wave, 1-based), WHAT KIND of failure, how long it burned,
 * and the upstream message clamped. Pure — the caller decides where it lands.
 * @param {{ id?: string, kind?: string }} agent
 * @param {number} waveIndex 0-based index into the resolved waves
 * @param {unknown} err
 * @param {number} ms
 * @param {{ timedOut?: boolean }} [opts]
 * @returns {{ id: string, kind: string, wave: number, class: string, ms: number, note: string }}
 */
export function nodeFailureRecord(agent, waveIndex, err, ms, opts = {}) {
  const message = String(/** @type {any} */ (err)?.message || err || "unknown failure");
  return {
    id: String(agent?.id || "?").slice(0, 60),
    kind: String(agent?.kind || "?").slice(0, 30),
    wave: waveIndex + 1,
    class: classifyFailure(err, opts),
    ms: Math.max(0, Math.round(ms) || 0),
    note: message.replace(/\s+/g, " ").trim().slice(0, 200),
  };
}

/**
 * Append a failure record under the log cap. Bounded on purpose: everything a
 * run accumulates and then hands to the chat log has to have a ceiling, or the
 * row grows with the failure count (D1's 2 MB ceiling is the hard wall, and
 * LOG_CAPS truncation would silently eat the tail).
 * @template {{ id: string }} T
 * @param {T[]} list
 * @param {T} record
 * @returns {T[]} the same list
 */
export function pushFailure(list, record) {
  if (list.length < MAX_LOGGED_FAILURES) list.push(record);
  return list;
}

/**
 * When the plan phase returns nothing usable, the workflow degrades to ONE
 * agent doing the whole task — the request still runs, still renders a
 * (single-node) workflow, and the mode's promise holds.
 * @param {PipelineCtx} ctx
 */
function fallbackPlan(ctx) {
  const task = (/** @type {any} */ (ctx).cleanLastUser || ctx.lastUser || "Answer the user's request.").slice(0, 600);
  const kind = ctx.state.webSearch ? "deep_research" : "custom";
  return {
    title: "",
    agents: [{ id: "researcher", kind: /** @type {any} */ (kind), name: "Researcher", task, persona: "", queries: [], deps: [] }],
  };
}

/**
 * Run ONE node: gather its kind-specific grounding (web searches for
 * deep_research, retrieved source excerpts for introspection, nothing for
 * custom), then one buffered completion on the user's chosen model. The
 * node's text NEVER streams into the chat — only the final merge does.
 * @param {PipelineCtx} ctx
 * @param {any} plan
 * @param {any} agent
 * @param {Record<string, { status: string, text?: string, note?: string }>} results
 * @param {{ used: number }} searchBudget
 * @param {{ cancelled: boolean }} [token] flipped when this node's deadline
 *   fired — the work keeps running (nothing to abort), but it stops HOLDING
 *   anything and stops emitting into a stream that moved on without it
 * @returns {Promise<string>}
 */
async function runAgentNode(ctx, plan, agent, results, searchBudget, token = { cancelled: false }) {
  const upstream = (agent.deps || [])
    .filter((/** @type {string} */ d) => results[d]?.status === "done" && results[d]?.text)
    .map((/** @type {string} */ d) => ({
      id: d,
      name: findWorkflowAgent(plan, d)?.name || d,
      text: /** @type {string} */ (results[d].text),
    }));

  let grounding = "";
  if (agent.kind === "deep_research") grounding = await runNodeSearches(ctx, agent, searchBudget);
  if (agent.kind === "swarm") {
    // A swarm node the browser did NOT deliver (the device dropped out, every
    // member failed, or the client never ran the pre-pass). It is still a
    // task that needs answering: run it here as an ordinary specialist and
    // say so, rather than handing the merge a hole. The reverse case — a
    // delivered swarm — never reaches this function.
    grounding =
      "Note: this task was meant to be answered by a swarm of small models in the user's browser, which did not deliver. " +
      "Answer it yourself, and keep the answer appropriately hedged.";
  }
  if (agent.kind === "introspection") {
    const block = await retrieveSourceBlockFor(ctx.env, ctx.log, agent.task, /** @type {any} */ (ctx.state).sourceSnapshot || null);
    grounding = block || "";
  }

  const userMsg =
    agentTaskPrompt(agent, upstream, { userRequest: /** @type {any} */ (ctx).cleanLastUser || ctx.lastUser }) +
    (grounding ? `\n\n${grounding}` : "");

  const sink = nodeTextSink(token);
  const buffered = /** @type {PipelineCtx} */ ({
    ...ctx,
    // Tighter completion budget than synthesis (the buffered-ctx override
    // pattern from runSdkBuildDeterministic); totals is shared by reference,
    // so billing lands in the normal bucket.
    state: { ...ctx.state, plan: { .../** @type {any} */ (ctx.state.plan), synthMaxTokens: ORCH_NODE_MAX_TOKENS } },
    emitDelta: (/** @type {string} */ t) => sink.push(t),
    emit: (/** @type {any} */ event) => {
      // streamCompletion's early-stall retry discards and restarts — nothing
      // was shown, so just reset the buffer; pass every other event through
      // (failover steps stay visible).
      if (event?.status?.type === "discard_text") { sink.discard(); return; }
      // A timed-out node has already been announced `failed`; anything it says
      // afterwards would contradict the workflow graph.
      if (token.cancelled) return;
      ctx.emit(event);
    },
  });
  const text = await streamCompletion(buffered, [
    { role: "system", content: phasePrompt(ctx.state, "workflow", "worker")() },
    { role: "user", content: userMsg },
  ]);
  return (text || sink.text() || "").trim();
}

/**
 * The buffer a node's tokens land in while it runs. A node's text NEVER
 * streams to the user (only the merge does), so it has to be held — and the
 * holding is where an abandoned node's memory grows: past its deadline the
 * wave loop has already moved on, but the provider keeps streaming into this
 * closure with nothing left to read it.
 *
 * Once the node's token is cancelled the sink drops what it has and refuses
 * everything after, so an abandoned node costs a constant, not a stream.
 * @param {{ cancelled: boolean }} token
 * @returns {{ push: (t: string) => void, discard: () => void, text: () => string }}
 */
export function nodeTextSink(token) {
  let buf = "";
  return {
    push(t) {
      if (token.cancelled) { buf = ""; return; }
      buf += String(t ?? "");
    },
    discard() { buf = ""; },
    text() { return token.cancelled ? "" : buf; },
  };
}

/**
 * The deep_research node's search leg: run the node's PLANNED queries (from
 * the plan phase — no per-node model call) through the same Exa path, events
 * and source registry as the main pipeline, under one workflow-wide budget.
 * Skipped entirely when the web-search knob is off (the knob's one meaning —
 * invariant: no Exa leg), leaving the node to answer from the model.
 * @param {PipelineCtx} ctx
 * @param {any} agent
 * @param {{ used: number }} searchBudget
 * @returns {Promise<string>} the node's numbered source digest block ("" when none)
 */
async function runNodeSearches(ctx, agent, searchBudget) {
  const { env, log, emit, state } = ctx;
  if (!state.webSearch) return "";
  /** @type {string[]} */
  const planned = agent.queries?.length ? agent.queries : [String(agent.task).slice(0, 120)];
  // Reserve synchronously — waves run nodes concurrently, but JS is
  // single-threaded between awaits, so this can't over-commit the budget.
  const take = Math.max(0, Math.min(planned.length, MAX_ORCH_SEARCHES - searchBudget.used));
  searchBudget.used += take;
  const queries = planned.slice(0, take);
  if (!queries.length) return "";

  state.searchCount += queries.length;
  for (const query of queries) emit({ status: { type: "search_start", round: 1, query, source: "web", service: "Web search" } });
  const settled = await Promise.all(queries.map((q) => webSearch(env, log, q, {})));
  /** @type {any[]} */
  const items = [];
  for (let i = 0; i < queries.length; i++) {
    const result = settled[i];
    if (result.cached) state.cachedSearchCount = (state.cachedSearchCount || 0) + 1;
    emit({
      status: {
        type: "search_done",
        round: 1,
        query: queries[i],
        source: "web",
        service: "Web search",
        results: result.resultCount,
        duration_ms: result.durationMs,
        sources: result.sources,
        cached: !!result.cached,
      },
    });
    addSources(state, result.items);
    items.push(...result.items);
  }
  // The node's grounding: exactly its own results, but with the GLOBAL source
  // numbers the registry assigned — so a [n] the node cites in its brief means
  // the same source in the final merged answer's list.
  const own = state.sources.filter((s) => items.some((it) => it.url === s.url));
  const digest = sourceDigest(own, 6000);
  return digest ? `Web search results for your task (cite as [n]):\n${digest}` : "";
}

/**
 * Bound one node's wall-clock. The underlying work keeps running past the
 * deadline (there's no cross-provider abort to thread), but its node is marked
 * failed and the workflow moves on — bounded latency beats a hung request.
 *
 * `onTimeout` fires exactly once, at the deadline, BEFORE the rejection
 * propagates: the caller uses it to flip the node's cancellation token so the
 * abandoned work releases its buffer instead of accumulating for the rest of
 * the run. The race is also what keeps the late rejection of `p` HANDLED — an
 * unhandled rejection in a Worker isolate is not a soft failure.
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {() => void} [onTimeout]
 * @returns {Promise<T>}
 */
export function withTimeout(p, ms, onTimeout) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { onTimeout?.(); } catch { /* a cancel hook must never mask the timeout */ }
        reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
      }, ms);
    }),
  ]);
}
