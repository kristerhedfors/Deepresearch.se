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
// The research toolbox arrives as SETS, never as names. A tool NAME is a
// service name here (src/research-tools.js's header: `street_view_look` matches
// src/extensions.test.js's SERVICE_TOKENS on its own), so this module binds the
// arrays the registry exports and never writes one down.
import {
  CORPUS_TOOLS,
  EXTENSION_RESEARCH_TOOLS,
  LITERATURE_TOOLS,
  PYTHON_TOOLS,
  RESEARCH_TOOL_CONTEXT,
  SOURCE_SEARCH_TOOL,
  WEB_TOOLS,
} from "./research-tools.js";

/**
 * The extension tools that belong to one CONTEXT BLOCK, so a class binds one
 * integration's tools rather than every integration's.
 *
 * Keyed on the block id (`CONTEXT_BLOCKS`, agent-spec-core.js) rather than on
 * the src/extensions.js descriptor id, which is the whole point: a descriptor
 * id IS the service's name, and writing one here would put it in the binding
 * table for every reader of this file to copy. The block id is platform
 * vocabulary, the mapping is data on the registry, and adding an integration
 * that declares an existing block adds its tools to the right class with no
 * edit here.
 * @param {string} block
 */
const extensionToolsForBlock = (block) =>
  EXTENSION_RESEARCH_TOOLS.filter((t) => RESEARCH_TOOL_CONTEXT[t.name] === block);

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
  // ---- the research classes (2026-08-29) -----------------------------------
  //
  // `needs` is what makes a declaration honest on a deployment that cannot
  // serve it: an agent that declares web research on a deploy with no search
  // provider gets the class DROPPED rather than a tool that refuses every call,
  // and src/agentic.js reads an empty toolbox as "run the standard graph"
  // (invariant 2). The per-CALL checks are a different layer entirely and stay
  // in src/tool-admission.js — this one only decides what the model is shown.
  "web-research": { tools: WEB_TOOLS, needs: "web" },
  "source-search": { tools: [SOURCE_SEARCH_TOOL], needs: "auxSources" },
  "literature": { tools: LITERATURE_TOOLS, needs: "auxSources" },
  "ancient-samples-query": { tools: CORPUS_TOOLS },
  // `needs` is the block id itself: the caller resolves the account knob that
  // consents to this integration and reports it under that key, so this table
  // never learns which knob, which account field, or which service.
  "host-intel-tools": { tools: extensionToolsForBlock("host-intel"), needs: "host-intel" },
  "street-imagery-tools": { tools: extensionToolsForBlock("street-imagery"), needs: "street-imagery" },
  // `needs: "exec"` rather than a `requires` on the AGENT, and the distinction
  // is load-bearing rather than tidy. A `requires` gates whether a mode is
  // reachable at all; the terminal fallback in the defaults table is the one
  // row that may not carry one, because a requirement an identity cannot
  // satisfy makes the routing walk skip it and end at nothing. Putting the
  // sandbox knob on `python` therefore meant the DEFAULT agent could never
  // compute — which is not a policy anybody chose, it is a policy that fell out
  // of picking the wrong mechanism.
  //
  // `needs` is the right one: whether an execution environment is bound is a
  // property of the deployment and the request, exactly like `snapshot` and
  // `web` above, so the CLASS is dropped and the rest of the toolbox survives.
  // Nothing is widened by this — with no environment bound there is nothing to
  // run in, and src/research-tools-run.js's runPython already refuses in a
  // sentence rather than computing anything.
  "python": { tools: PYTHON_TOOLS, needs: "exec" },
};

/**
 * The research classes, in registry order — what a run resolves when NO
 * capability was resolved at all (the /mcp channel, an unreadable registry).
 *
 * It is deliberately the full set rather than a conservative subset: a null
 * capability is the same "no agent was resolved" case src/search-sources.js
 * opens the corpus door for, and the ground-truth batteries that measure this
 * engine address no agent. Every individual call is still admitted against the
 * account's knobs and the request's policy (src/tool-admission.js), so opening
 * the box here widens what is OFFERED and nothing about what is REACHED.
 * @type {string[]}
 */
export const RESEARCH_TOOL_CLASSES = [
  "web-research",
  "source-search",
  "literature",
  "ancient-samples-query",
  "host-intel-tools",
  "street-imagery-tools",
  "python",
];

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
