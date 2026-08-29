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

import { researchBrief } from "./research-brief.js";
import {
  directPrompt,
  orchAgentPrompt,
  orchSynthPrompt,
  queryPlanPrompt,
  reflectPrompt,
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
    // The standard topology's two JSON nodes (src/pipeline-standard.js). The
    // five-phase flow fills neither — its triage and gap prompts are shared
    // across every agent and are not selectable — so binding them here is what
    // lets an agent be voiced through either engine without a second set.
    "plan": queryPlanPrompt,
    "reflect": reflectPrompt,
    "answer": synthPrompt,
    "answer-direct": directPrompt,
    "answer-search-off": searchOffPrompt,
    // The tool-driven research path (invariant 1's authorized exception,
    // extended to research 2026-08-29). ONE builder fills both roles because
    // there is only one instruction: `answer-tools` is the system prompt the
    // tool loop runs on, and `brief` is the same text addressed as an artifact
    // — the standard topology hands it to a node, the loop hands it to a model,
    // and a second copy for either would be the drift this whole module exists
    // to make impossible.
    "brief": researchBrief,
    "answer-tools": researchBrief,
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
 * The builder a running phase should use for a role — the call-site helper.
 * Resolves the request's set, then falls back to the phase's default set if the
 * request's set does not fill this role (which validation prevents for a
 * declared phase, but a request can execute a role its agent never declared —
 * e.g. the research phase's answer-direct on an agent whose set covers only
 * `answer`). Never throws.
 * @param {any} state
 * @param {string} phase
 * @param {string} role
 * @returns {Function}
 */
export function phasePrompt(state, phase, role) {
  const set = promptSetFor(state, phase);
  const direct = PROMPT_BUILDERS[set]?.[role];
  if (direct) return direct;
  const fallbackSet = /** @type {any} */ (DEFAULT_PROMPT_SET)[phase] || "research";
  return promptBuilder(PROMPT_BUILDERS[fallbackSet]?.[role] ? fallbackSet : "research", role);
}

/** Every (set, role) pair this module binds — for the pinning test. */
export const BOUND_ROLES = Object.fromEntries(
  Object.entries(PROMPT_BUILDERS).map(([set, roles]) => [set, Object.keys(roles)]),
);

export { PROMPT_SETS };
