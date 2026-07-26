// @ts-check
// The TOOL-CLASS binding — the one place a capability block's `tools` names
// become actual tool definitions handed to a model.
//
// Sibling of src/prompt-sets.js, and deliberately the same shape. The AgentSpec's
// closed `TOOL_CLASSES` vocabulary (public/js/agent-spec-core.js) says which
// classes exist; this module says which definitions each one binds to, and
// tool-sets.test.js pins the binding against the arrays the phases used to
// import directly.
//
// Three properties are load-bearing:
//
//  1. **A class names a SET, never an individual tool.** A spec selects
//     "source-read", not "grep_source" — so no spec can assemble a novel
//     toolbox out of parts, which is what keeps the owner-authorized invariant-1
//     exception bounded to the shapes it was authorized for.
//  2. **Registry order, not spec order.** The resolved list is built by walking
//     TOOL_BINDINGS, so two specs naming the same classes in different orders
//     get byte-identical tool lists. A spec cannot reorder what a model sees.
//  3. **Availability is the deployment's call, not the spec's.** A class can
//     declare what it `needs` (the source snapshot, today); a class whose need
//     is unmet is dropped rather than erroring, which is how a spec that asks
//     for source reads still runs on a deployment whose snapshot won't load
//     (invariant 2).

import { INTROSPECTION_TOOLS } from "./introspect-tools.js";
import { BUILD_TOOLS, SDK_TOOLS } from "../public/js/sdk-core.js";
import { TOOL_CLASSES, capHasTool } from "./agent-spec.js";

/** @typedef {import('./agent-spec.js').AgentCapability} AgentCapability */

/**
 * tool class → the definitions it binds to, plus what the deployment must have
 * for the class to be usable. Keys must match TOOL_CLASSES exactly (pinned in
 * tool-sets.test.js), so adding a class to the vocabulary without binding it
 * here fails the suite rather than silently handing a model nothing.
 * @type {Record<string, { tools: any[], needs?: string }>}
 */
export const TOOL_BINDINGS = {
  // The snapshot readers. Useless without a snapshot to read, hence `needs`.
  "source-read": { tools: INTROSPECTION_TOOLS, needs: "snapshot" },
  // The DistillSDK manifest planners (sdk_list_modules / sdk_show_module / …).
  "sdk-plan": { tools: SDK_TOOLS },
  // Staging and shipping a build (write_file / publish_app).
  "build-publish": { tools: BUILD_TOOLS },
  // The in-browser sandbox's bash-lite loop runs in the PAGE, not the Worker —
  // the model never receives a Worker-side definition for it, so an empty list
  // is the correct binding rather than a missing one. Declaring the class still
  // means something: it is what a spec says to describe an agent that uses the
  // shell, and what validation checks the `sandbox` requirement against.
  "shell": { tools: [] },
};

/**
 * The tool definitions for a run: the classes the answering agent declared,
 * resolved through TOOL_BINDINGS and filtered by what this deployment can serve.
 *
 * `fallback` is the class list the phase used before capabilities existed, and
 * is used only when NO capability was resolved (an unreadable registry, the MCP
 * channel) — so today's behaviour is what a null capability produces. A
 * capability that resolves to an empty `tools` is honoured as empty: an agent
 * declaring no tools gets none, which is the point of being able to declare it.
 *
 * @param {AgentCapability | null | undefined} cap
 * @param {string[]} fallback classes the phase uses when no capability resolved
 * @param {Record<string, boolean>} [have] what the deployment can serve (e.g. `{ snapshot: true }`)
 * @returns {any[]}
 */
export function toolsForRun(cap, fallback, have = {}) {
  const declared = cap ? (Array.isArray(cap.tools) ? cap.tools : []) : fallback;
  const wanted = new Set(declared);
  /** @type {any[]} */
  const out = [];
  for (const [cls, binding] of Object.entries(TOOL_BINDINGS)) {
    if (!wanted.has(cls)) continue;
    if (binding.needs && have[binding.needs] !== true) continue;
    out.push(...binding.tools);
  }
  return out;
}

/** Every class this module binds — for the pinning test. */
export const BOUND_CLASSES = Object.keys(TOOL_BINDINGS);

export { TOOL_CLASSES, capHasTool };
