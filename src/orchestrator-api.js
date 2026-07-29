// @ts-check
// POST /api/orchestrator/plan — the sub-agent team, planned BEFORE the chat
// request. Orchestrator mode normally plans inside /api/chat (src/
// orchestrator.js phase 1); this endpoint exists for exactly one reason: the
// `swarm` sub-agent kind runs in the USER'S BROWSER (public/js/
// swarm-runtime.js — N tiny on-device models reasoning in parallel), and a
// single streamed chat request has no channel back to the browser mid-run. So
// the client asks for the plan here, runs any swarm nodes locally while the
// workflow graph fills in, and then sends the finished plan plus those briefs
// with the /api/chat request (chat.js `workflow` + `swarm_results`).
//
// Same shape as /api/bash/step, and for the same reason — it is the other
// client-orchestrated loop in this codebase: the reliable jsonModel decides,
// the browser executes, the server never trusts what comes back (chat.js
// re-normalizes the plan through the identical normalizeWorkflow gate).
//
// Invariant 1: ONE JSON-mode call, no function calling. Invariant 3: on the
// fixed DEFAULT_MODEL like every other planning phase — the plan must not
// change quality with the user's answer-model pick. Fail-soft throughout: any
// problem returns `{ plan: null }` with 200, and the client simply sends an
// ordinary orchestrator request that plans server-side without a swarm.

import { completeJson } from "./providers.js";
import { DEFAULT_MODEL } from "./berget.js";
import { enforceQuotaAndReserve } from "./endpoint-gate.js";
import { jsonResponse, readJsonBody } from "./http.js";
import { lastUserMessage, textOf } from "./conversation.js";
import { recordDefaultModelUsage, releaseInflight } from "./quota.js";
import { classifyFailure, recordSubsystemFailure } from "./server-errors.js";
import { chatModesAvailable } from "./settings.js";
import { validateMessages } from "./validation.js";
import { normalizeWorkflow, orchestratorPlanPrompt, workflowWaves } from "../public/js/orchestrator-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

const PLAN_MAX_TOKENS = 900;

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleOrchestratorPlan(request, env, log, identity) {
  if (!env.BERGET_API_TOKEN) {
    return jsonResponse({ error: "Server not configured: BERGET_API_TOKEN secret is missing." }, 500);
  }
  // The SAME capability gate as orchestrator mode in chat.js: the non-normal
  // chat modes must be available to this identity. A client without it gets a
  // clean null plan, not an error — it falls back to the ordinary request,
  // which the server will route by its own rules anyway.
  if (!chatModesAvailable(env, identity)) {
    return jsonResponse({ plan: null, reason: "capability" }, 403);
  }

  const { body, response } = await readJsonBody(request);
  if (response) return response;
  const invalid = validateMessages(body?.messages);
  if (invalid) return jsonResponse({ error: invalid }, 400);

  // What the caller's DEVICE can host. Only its presence and the model's label
  // reach the prompt — the plan model decides whether the request has work a
  // swarm suits, exactly as it decides everything else about the team.
  const swarm = normalizeSwarmCapability(body?.swarm);

  // The shared side-endpoint admission preamble (endpoint-gate.js): the same
  // quota gate /api/chat applies, then this request's concurrency slot.
  const gate = await enforceQuotaAndReserve(env, identity);
  if (gate.response) return gate.response;
  const reqId = gate.reqId;

  const startedAt = Date.now();
  try {
    const message = textOf(lastUserMessage(body.messages)?.content);
    const r = await completeJson(
      env,
      [{
        role: "user",
        content: orchestratorPlanPrompt({
          message,
          hasSource: body?.has_source === true,
          hasSwarm: !!swarm,
          swarmModel: swarm?.modelLabel || "",
        }),
      }],
      { model: DEFAULT_MODEL, maxTokens: PLAN_MAX_TOKENS },
    );
    await recordDefaultModelUsage(env, log, identity, r.usage, Date.now() - startedAt);
    const plan = normalizeWorkflow(r.value, { hasSource: body?.has_source === true, hasSwarm: !!swarm });
    if (!plan) {
      // Nothing salvageable: let the chat request plan again server-side
      // rather than shipping a degenerate team the user would watch run.
      log.info("orch.plan_empty", { user_id: identity.id, request_id: reqId });
      return jsonResponse({ plan: null, reason: "unusable", request_id: reqId });
    }
    const waves = workflowWaves(plan).waves;
    const swarmNodes = plan.agents.filter((a) => a.kind === "swarm").length;
    // The two-call flow's ONLY server-side breadcrumb: this line is what says
    // a run was planned at all. If the browser then dies running the swarm
    // nodes locally (the on-device model pool is the memory-hungriest thing
    // this product does), /api/chat never arrives and no chat_logs row is ever
    // written — an `orch.plan` with no matching `chat.complete` is the shape
    // of that crash. `request_id` is echoed to the client so the two calls can
    // be tied together once it forwards it.
    log.info("orch.plan", {
      user_id: identity.id,
      request_id: reqId,
      agents: plan.agents.length,
      waves: waves.length,
      swarm_nodes: swarmNodes,
      swarm_model: swarm?.modelId || "",
    });
    return jsonResponse({ plan, waves, request_id: reqId });
  } catch (err) {
    log.warn("orch.plan_failed", { user_id: identity.id, error: (/** @type {any} */ (err))?.message || String(err) });
    // Fail-soft answers the CLIENT ({plan:null} → it plans server-side
    // instead), but the failure still needs somewhere durable to live: this
    // endpoint writes no chat_logs row of its own, so before this the only
    // trace was one retention-bounded Workers Logs line.
    await recordSubsystemFailure(env, log, {
      subsystem: "orchestrator",
      op: "plan_api",
      failureClass: classifyFailure(err),
      detail: (/** @type {any} */ (err))?.message || String(err),
      requestId: reqId,
      context: { model: DEFAULT_MODEL },
    });
    return jsonResponse({ plan: null, reason: "error" });
  } finally {
    await releaseInflight(env, reqId);
  }
}

/**
 * The client's swarm descriptor, clamped. Nothing here is trusted for
 * anything but prompt shaping and the kind gate — the actual member count is
 * the DEVICE's call at run time (swarm-core.js planSwarmCapacity).
 * @param {any} raw
 * @returns {{ modelId: string, modelLabel: string } | null}
 */
export function normalizeSwarmCapability(raw) {
  if (!raw || typeof raw !== "object" || raw.available === false) return null;
  const modelId = typeof raw.modelId === "string" ? raw.modelId.slice(0, 60) : "";
  if (!modelId) return null;
  return { modelId, modelLabel: (typeof raw.modelLabel === "string" ? raw.modelLabel : modelId).slice(0, 60) };
}

