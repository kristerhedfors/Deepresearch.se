// @ts-check
// The PROMPT-SET binding — the one place a capability block's `prompts` name
// becomes an actual system-prompt builder.
//
// The AgentSpec's closed `PROMPT_SETS` vocabulary (public/js/agent-spec-core.js)
// says which sets exist and which ROLES each fills; this module says which
// function fills them. The split is the same one the tool classes use: the pure
// core names a class, the Worker side owns the implementation, and neither can
// drift from the other without a test failing (prompt-sets.test.js pins every
// binding against the builder the phase actually calls).
//
// Why a binding at all, rather than each phase importing its own prompt: it
// makes prompt set and answer phase INDEPENDENT choices. Before this, an
// agent's voice was welded to its execution path — running the research phase
// in the source-research voice, or the build phase with a different set, was not
// expressible in a spec at any price. It is now, and it is still bounded: a set
// must fill every role its phase asks for (validateCapability).
//
// Nothing here changes what any shipped agent does. Every default agent
// declares the set its phase already used, which is asserted, so the resolved
// builder is byte-identical to the one the call site imported before.
//
// Since spec 0.3.0 this is ALSO where an agent's IDENTITY block reaches the
// run. `phasePrompt` is the one call every answer/plan system prompt already
// goes through, so binding the block here gives every agent — present and
// future — its own self-description without touching a single prompt builder,
// and without a per-mode special case. See `IDENTITY_ROLES` below for which
// roles carry it and why the planning roles do not.

import {
  directPrompt,
  orchAgentPrompt,
  orchSynthPrompt,
  sdkBuildPrompt,
  sdkBuildToolPrompt,
  searchOffPrompt,
  sourceAgentPrompt,
  sourceAnswerPrompt,
  sourceToolAgentPrompt,
  synthPrompt,
} from "./prompts.js";
import { orchestratorPlanPrompt } from "../public/js/orchestrator-core.js";
import { outrospectionAnswerPrompt } from "../public/js/outrospect-core.js";
import { DEFAULT_PROMPT_SET, PROMPT_SETS } from "./agent-spec.js";

/**
 * set id → role → the builder that fills it. The keys must match PROMPT_SETS
 * exactly (pinned in prompt-sets.test.js), so adding a role to the vocabulary
 * without binding it here fails the suite rather than failing a request.
 * @type {Record<string, Record<string, Function>>}
 */
export const PROMPT_BUILDERS = {
  "research": {
    "answer": synthPrompt,
    "answer-direct": directPrompt,
    "answer-search-off": searchOffPrompt,
  },
  "source-research": {
    "plan": sourceAgentPrompt,
    "answer": sourceAnswerPrompt,
    "answer-tools": sourceToolAgentPrompt,
  },
  "build": {
    "answer": sdkBuildPrompt,
    "answer-tools": sdkBuildToolPrompt,
  },
  "workflow": {
    "plan": orchestratorPlanPrompt,
    "worker": orchAgentPrompt,
    "answer": orchSynthPrompt,
  },
  "feed": {
    "answer": outrospectionAnswerPrompt,
  },
};

/**
 * The prompt set a REQUEST runs on: the agent's declared set (put on the state
 * by chat.js), else the default for the phase being executed. Falls back to the
 * research set for anything unrecognized, so a stale or hostile state value can
 * never leave a phase without a prompt (invariant 2).
 * @param {any} state the pipeline state
 * @param {string} phase the answer phase actually executing
 * @returns {string}
 */
export function promptSetFor(state, phase) {
  const declared = state?.promptSet;
  if (declared && PROMPT_BUILDERS[declared]) return declared;
  const fallback = /** @type {any} */ (DEFAULT_PROMPT_SET)[phase];
  return PROMPT_BUILDERS[fallback] ? fallback : "research";
}

/**
 * The system-prompt builder for one (set, role). Throws only on a programming
 * error — a role the set never declared — which the capability validation and
 * the binding test both make unreachable from data.
 * @param {string} set
 * @param {string} role
 * @returns {Function}
 */
export function promptBuilder(set, role) {
  const fn = PROMPT_BUILDERS[set]?.[role];
  if (!fn) throw new Error(`no prompt builder for set "${set}" role "${role}"`);
  return fn;
}

/**
 * The roles whose system prompt carries the agent's IDENTITY block (spec 0.3.0
 * — `agentIdentityPrompt`, resolved onto the state by src/chat.js). Only the
 * ANSWER roles: those are the prompts a model answers the user from, and "what
 * can you do" is a question about the answering agent.
 *
 * The JSON PLANNING roles are deliberately excluded. `plan` and `worker` feed
 * parsed output (a read-loop step, a workflow plan, one node's brief) — appending
 * a persona there would put prose in front of a parser for no gain, and the
 * planning phases are the ones invariant 3 pins to the fixed reliable model
 * precisely because their output has to be dependable.
 */
export const IDENTITY_ROLES = new Set(["answer", "answer-tools", "answer-direct", "answer-search-off"]);

/**
 * Wrap a prompt builder so its system prompt ends with the agent's identity
 * block. The wrapper keeps the builder's signature and its output as a literal
 * PREFIX — the shipped prompt is unchanged, the block is appended after it — so
 * a mode gains self-knowledge and nothing else.
 *
 * Fail-soft (invariant 2) all the way down: no identity, a blank one, or a
 * builder that returns something other than a string, and the original builder
 * comes back untouched. A missing or broken persona can never break a request.
 * @param {Function} builder
 * @param {unknown} identity
 * @returns {Function}
 */
export function withIdentity(builder, identity) {
  if (typeof identity !== "string" || !identity.trim()) return builder;
  return (/** @type {any[]} */ ...args) => {
    const base = builder(...args);
    return typeof base === "string" ? `${base}\n\n${identity}` : base;
  };
}

/**
 * The builder a running phase should use for a role — the call-site helper.
 * Resolves the request's set, then falls back to the phase's default set if the
 * request's set does not fill this role (which validation prevents for a
 * declared phase, but a request can execute a role its agent never declared —
 * e.g. the research phase's answer-direct on an agent whose set covers only
 * `answer`). Finally, for an ANSWER role, binds the resolved agent's identity
 * block onto the prompt — the ONE generic seam where every agent's system
 * prompt gains its self-description, instead of an edit in each builder.
 * Never throws.
 * @param {any} state
 * @param {string} phase
 * @param {string} role
 * @returns {Function}
 */
export function phasePrompt(state, phase, role) {
  const set = promptSetFor(state, phase);
  const direct = PROMPT_BUILDERS[set]?.[role];
  const fallbackSet = /** @type {any} */ (DEFAULT_PROMPT_SET)[phase] || "research";
  const builder = direct
    || promptBuilder(PROMPT_BUILDERS[fallbackSet]?.[role] ? fallbackSet : "research", role);
  return IDENTITY_ROLES.has(role) ? withIdentity(builder, state?.agentIdentity) : builder;
}

/** Every (set, role) pair this module binds — for the pinning test. */
export const BOUND_ROLES = Object.fromEntries(
  Object.entries(PROMPT_BUILDERS).map(([set, roles]) => [set, Object.keys(roles)]),
);

export { PROMPT_SETS };
