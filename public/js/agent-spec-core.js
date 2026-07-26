// @ts-check
// AgentSpec — the DeepResearch AGENTS SDK's declarative definition of ONE
// agent (a "flavour" of the Se/cure + Se/rver pair). The Agents SDK is the
// project's second SDK, distinct from the Platform SDK (DistillSDK, sdk/ —
// which builds a whole platform): it is tailored to Agent Studio and the
// integrated Linux environment, and this module is its pure core — what both
// tiers, the sdk/pair-cli.mjs CLI, and the Agent Studio mode use to load,
// validate, and resolve agent definitions. Same convention as sdk-core.js / bash-core.js /
// introspect-core.js: it lives under public/ because the browser can only
// import served modules while the Worker bundler imports from any repo path;
// src/agent-spec.js is the thin server façade and sdk/pair-cli.mjs re-exports
// these helpers.
//
// I/O-free and Node-tested (agent-spec-core.test.js). An "agent" is DEFINED by
// its chat-input-pane controls, its intro + loading animations, its colour
// theme, its seed example questions, the default quota a minted share-link
// token carries, and — since spec 0.2.0 — its CAPABILITY block: what it DOES.
// The seven agents this project ships are the reference specs in
// sdk/AGENTS.json; deriving a new agent is copying one, changing these fields,
// and validating.
//
// Those seven are NOT the chat-mode dropdown (chat-mode.js CHAT_MODES: normal /
// introspection / sdk / orchestrator / outrospection) and NOT the two tiers
// (Se/cure, Se/rver — an agent declares which one via `platform`), though FIVE
// of them are the default agent OF a mode, bound to it by the registry's
// `defaults` table. An agent PICKS a tier, a mode and an answer phase; it never
// adds one. docs/AGENT-PLATFORM.md §2.1 lays the three lists side by side.

// The Se/rver-app chat modes an agent's `mode` field may name. Imported from
// the mode-theme registry rather than restated here, so a spec can never drift
// from the dropdown the way `"agent-builder"` did against the real id `"sdk"`
// (the whole reason nothing caught that: nothing validated `mode`). mode-theme.js
// is pure and import-free, so this adds no weight to the Worker bundle.
import { CHAT_MODE_IDS, MODE_THEMES } from "./mode-theme.js";

export { CHAT_MODE_IDS, MODE_THEMES };

// ---- the closed control vocabulary -------------------------------------------
//
// A chat-input-pane control is one interactive affordance attached to the
// composer. The vocabulary is CLOSED (like the manifest's capability classes
// and the server token's permission set): a spec may only use these types, so a
// renderer on either tier — and the visual-proof test — knows every shape it
// must draw. Each entry declares the extra fields that type carries and their
// defaults, so resolveControls() can normalize a terse spec into a full one.

/** @typedef {"model-select"|"depth-slider"|"toggle"|"mode-select"|"attachments"|"prompt-input"|"send-button"} ControlType */

/**
 * The control registry: type → { required extra fields, defaults, whether it
 * drives a pipeline knob }. `drives` names the request field the control sets
 * (documentation + the proof test assert on it); null for pure-UI controls.
 */
export const CONTROL_REGISTRY = {
  "prompt-input": { drives: "message", defaults: { placeholder: "Ask anything…", multiline: true }, label: "Prompt" },
  "send-button": { drives: null, defaults: { label: "Send" }, label: "Send" },
  "model-select": { drives: "model", defaults: { providers: "all", allowLocal: false }, label: "Model" },
  "depth-slider": {
    drives: "depth",
    defaults: { min: 0, max: 3, default: 1, ticks: ["Quick", "Standard", "Deep", "Exhaustive"] },
    label: "Research depth",
  },
  "toggle": { drives: "flag", defaults: { default: false }, label: "Toggle" },
  "mode-select": { drives: "mode", defaults: { modes: ["normal"] }, label: "Mode" },
  "attachments": { drives: "attachments", defaults: { accept: "*/*", max: 5 }, label: "Attach" },
};

/** @type {ControlType[]} */
export const CONTROL_TYPES = /** @type {ControlType[]} */ (Object.keys(CONTROL_REGISTRY));

/** Platform types (DESIGN.md §3.1): a client-tier agent vs a server-tier agent. */
export const PLATFORM_TYPES = ["client", "server"];

/** Quota windows a minted share-link token can meter over (mirrors src/quota.js windows). */
export const QUOTA_WINDOWS = ["minute", "hour", "day", "month"];

/** The agent BACKGROUND kinds — what drifts on the field behind the agent's
 * chat while it works (the mode-theme.js `backdrop` axis, declared per agent):
 * "terminal" (the sandbox terminal-text layer, agent-backdrop.js), "graph"
 * (the rotating wireframe workflow graph, graph-backdrop.js), or "none". */
export const BACKDROP_KINDS = ["none", "terminal", "graph"];

// ---- the CAPABILITY vocabulary (spec 0.2.0) -----------------------------------
//
// The five default agents differ far more in what they DO than in how they
// look, and until 0.2.0 the AgentSpec could express only the looking. The
// capability block closes that gap — but it is a SELECTOR over behaviour the
// platform already implements, never a place to define new behaviour. Every
// value below is a member of a closed vocabulary that names existing code:
//
//   answerPhase → which function takes the answer phase (pipeline.js dispatch)
//   tools       → which already-shipped tool set the answer model may drive
//   context     → which already-shipped retrieval block is injected
//   search      → the search plane's knobs, not a new search plane
//   routing     → which model bucket a phase runs on (invariant 3)
//   gates       → which deterministic intent gate applies (invariant 6)
//   emits       → which SSE status events the run can produce
//   requires    → which server capability knob must be granted
//   team        → which agents a workflow node may be
//
// That constraint is what keeps invariant 1 intact: the dispatch stays CODE and
// the spec is DATA read before the run starts. A spec can select the
// owner-authorized tool exception; it cannot invent a new one, and it can never
// express control flow.
//
// `serverOnly: true` marks a member that structurally puts the SERVER in the
// data path. A `platform: "client"` spec may not select one — that is invariant
// 4 (the privacy split) expressed as a validation rule instead of as prose in a
// skill.

/** The PROMPT ROLES a phase can need filled. A role names the JOB a system
 * prompt does in a run, not the wording — the wording lives in src/prompts.js
 * (and orchestrator-core / outrospect-core for the two pure ones). */
export const PROMPT_ROLES = [
  "plan", // the phase's own JSON planning prompt (not the shared triage/gap/validate)
  "worker", // one bounded sub-run inside the phase (an orchestrated node)
  "answer", // the deterministic answer/synthesis prompt
  "answer-tools", // the variant for a model driving native tools
  "answer-direct", // the answer when triage decided no sources are needed
  "answer-search-off", // the answer when there is nothing external to consult
];

/** Which function takes the answer phase. One member per shipped answer path.
 * `promptRoles` is what the phase's code actually asks for — the basis of the
 * compatibility rule in validateCapability (a declared prompt set must fill
 * every role its phase needs). */
export const ANSWER_PHASES = {
  "research": {
    label: "Deep research",
    desc: "triage → search → gap → synthesis → validation (pipeline.js)",
    promptRoles: ["answer", "answer-direct", "answer-search-off"],
  },
  "source-research": {
    label: "Source research",
    desc: "read this platform's own source and answer from it (runSourceResearch)",
    promptRoles: ["plan", "answer", "answer-tools"],
  },
  "build": {
    label: "Build",
    desc: "distil a flavour, stage files, publish it live (runSdkBuild)",
    serverOnly: true,
    promptRoles: ["answer", "answer-tools"],
  },
  "workflow": {
    label: "Workflow",
    desc: "plan a sub-agent team and run it in waves (runOrchestration)",
    serverOnly: true,
    promptRoles: ["plan", "worker", "answer"],
  },
  "feed": {
    label: "Feed",
    desc: "answer from the standing outward feed (runOutrospection)",
    serverOnly: true,
    promptRoles: ["answer"],
  },
  "direct": {
    label: "Direct",
    desc: "answer from the model with no research phase (runWithoutSearch)",
    promptRoles: ["answer-search-off"],
  },
};

/** The PROMPT SETS — the last axis on which the default agents differ and the
 * spec was silent. A set is a named group of system prompts covering some of
 * the roles above; `src/prompt-sets.js` binds each (set, role) pair to the real
 * builder, and a test pins that binding against the code that calls it.
 *
 * Like every other capability axis this is a SELECTOR: a spec names a set that
 * exists, it does not author prompt text. What it buys is that prompt set and
 * answer phase become INDEPENDENT choices — an agent can run the research phase
 * in the source-research voice, which was not expressible before. */
export const PROMPT_SETS = {
  "research": { label: "Research", desc: "the deep-research synthesis voice: cited, hedged, report-tiered", roles: ["answer", "answer-direct", "answer-search-off"] },
  "source-research": { label: "Source research", desc: "answers about this platform from its own source, with the read loop's planner", roles: ["plan", "answer", "answer-tools"] },
  "build": { label: "Build", desc: "the Agent Studio build voice: ship the app this turn, state the privacy posture", roles: ["answer", "answer-tools"] },
  "workflow": { label: "Workflow", desc: "the sub-agent team: a plan prompt, one node's persona, and the merge", roles: ["plan", "worker", "answer"] },
  "feed": { label: "Feed", desc: "answers from the outward feed, never inventing an item", roles: ["answer"] },
};

/** The prompt set a phase uses when a spec names none. `direct` borrows the
 * research set, whose answer-search-off role is the prompt runWithoutSearch
 * has always used. */
export const DEFAULT_PROMPT_SET = {
  "research": "research",
  "source-research": "source-research",
  "build": "build",
  "workflow": "workflow",
  "feed": "feed",
  "direct": "research",
};

/** Tool CLASSES — a class names a shipped tool set, never an individual tool,
 * so a spec cannot assemble a novel toolbox. */
export const TOOL_CLASSES = {
  "source-read": { label: "Source read", desc: "grep_source / read_file / list_files over the source snapshot (INTROSPECTION_TOOLS)" },
  "sdk-plan": { label: "SDK plan", desc: "sdk_list_modules / sdk_show_module / sdk_plan / sdk_validate over the Platform SDK manifest (SDK_TOOLS)" },
  "build-publish": { label: "Build + publish", desc: "write_file / publish_app (BUILD_TOOLS)", serverOnly: true },
  "shell": { label: "Shell", desc: "the in-browser Linux sandbox's bash-lite loop (bash-core.js)" },
};

/** What a model WITHOUT native tool use does instead. A tool-bearing agent must
 * name one that is not "none" — invariant 1's requirement that every mode works
 * across the whole catalog, not only on tool-capable models. */
export const TOOL_FALLBACKS = ["read-loop", "file-blocks", "none"];

/** Retrieval blocks the platform can inject into a turn's context. */
export const CONTEXT_BLOCKS = {
  "source-snapshot": { label: "Source snapshot", desc: "the committed deployed-source artifact (introspect-core SNAPSHOT_PATH)" },
  "docs-corpus": { label: "Docs corpus", desc: "the committed documentation corpus + its dense index (help mode)" },
  "secure-digest": { label: "Se/cure digest", desc: "a bounded digest of the real Se/cure reference source (buildSecureSourceDigest)" },
  "shell-transcript": { label: "Shell transcript", desc: "what the in-browser sandbox actually ran, as ground truth" },
  "outward-feed": { label: "Outward feed", desc: "the stored lens feed of what everyone else shipped (src/outrospect.js)", serverOnly: true },
  "owasp": { label: "OWASP reference", desc: "the OWASP Top 10 block retrieved for a security-assessment ask" },
};

/** The model buckets a phase may run on. `json-default` is the fixed reliable
 * planning model; `user` is the model the user chose. Invariant 3 (split
 * routing) is enforced by making `planModel` a one-member vocabulary. */
export const PLAN_MODELS = ["json-default"];
export const ANSWER_MODELS = ["user", "json-default"];

/** Deterministic intent gates an agent may declare. Each names a shipped gate;
 * `langs` must carry EN and SV alike (invariant 6). */
export const GATE_IDS = {
  "external-source": { label: "External source", desc: "does the ask want outside material? — hands a source-research turn back to research (externalSourceIntent)" },
  "lens": { label: "Lens", desc: "which standing lens does this ask belong under? (outrospect-core lensMatch)" },
  "quiz": { label: "Quiz", desc: "is this an ask for a quiz? (src/quiz.js quizIntent)" },
  "feedback": { label: "Feedback", desc: "is this a report to the developers? (src/feedback.js feedbackIntent)" },
};

/** The mode-DISTINGUISHING SSE status events (docs: the sse-protocol skill).
 * `step` and `search` collapse the _start/_done pairs; the universal `done` and
 * `discard_text` events are not declared because every agent emits them. */
export const CAPABILITY_EVENTS = {
  "step": { label: "Activity step", desc: "step_start / step_done" },
  "search": { label: "Search", desc: "search_start / search_done" },
  "quiz": { label: "Quiz", desc: "the inline interactive quiz" },
  "workflow": { label: "Workflow", desc: "the planned sub-agent DAG", serverOnly: true },
  "agent_update": { label: "Agent update", desc: "one workflow node's lifecycle", serverOnly: true },
  // Client-emitted (the swarm runs in the user's browser — swarm-core.js
  // swarmUpdateEvent), so deliberately NOT serverOnly: a Se/cure-side agent
  // could emit it without a server in the path at all.
  "swarm_update": { label: "Swarm update", desc: "a local-swarm node's members, round and agreement" },
  "build": { label: "Build", desc: "the published app's slug + URL", serverOnly: true },
};

/** Server capability knobs a mode may require before it is honored. */
export const CAPABILITY_REQUIREMENTS = {
  "developer_mode": { label: "Developer mode", desc: "the introspection/agent-mode capability knob", serverOnly: true },
  "sandbox": { label: "Sandbox", desc: "the bash-lite in-browser Linux sandbox knob" },
};

/**
 * One resolved capability. Declared explicitly rather than inferred from
 * BASE_CAPABILITY, whose empty arrays and null `team` would otherwise infer as
 * `never[]`/`null` and make every consumer a type error.
 * @typedef {Object} AgentCapability
 * @property {string} answerPhase
 * @property {string|null} prompts
 * @property {string[]} tools
 * @property {string} toolFallback
 * @property {string[]} context
 * @property {{ web: boolean, auxSources: boolean, maxQueries: number|null }} search
 * @property {{ planModel: string, answerModel: string }} routing
 * @property {Array<{ id: string, langs?: string[] }>} gates
 * @property {Record<string, number>} bounds
 * @property {string[]} emits
 * @property {string[]} requires
 * @property {{ kinds?: string[], allowCustom?: boolean, maxAgents?: number, maxWaves?: number, maxQueriesPerAgent?: number }|null} team
 */

/** What an agent inherits when it declares no capability block at all: the
 * plain deep-research turn, which is what every pre-0.2.0 spec meant.
 * @type {AgentCapability} */
export const BASE_CAPABILITY = {
  answerPhase: "research",
  prompts: null, // null = the answer phase's default set (DEFAULT_PROMPT_SET)
  tools: [],
  toolFallback: "none",
  context: [],
  search: { web: true, auxSources: true, maxQueries: null },
  routing: { planModel: "json-default", answerModel: "user" },
  gates: [],
  bounds: {},
  emits: ["step"],
  requires: [],
  team: null,
};

/** The bound keys a capability may declare, each a non-negative number. */
export const BOUND_KEYS = ["maxRounds", "maxTokens", "timeoutMs"];

/**
 * The resolved capability for an agent: BASE_CAPABILITY overlaid with the
 * spec's declaration, sub-objects merged rather than replaced so a spec can
 * name one bound without restating the rest.
 * @param {any} a
 * @returns {AgentCapability}
 */
export function resolveCapability(a) {
  const c = (a && a.capability && typeof a.capability === "object") ? a.capability : {};
  return /** @type {AgentCapability} */ ({
    ...BASE_CAPABILITY,
    ...c,
    search: { ...BASE_CAPABILITY.search, ...(c.search && typeof c.search === "object" ? c.search : {}) },
    routing: { ...BASE_CAPABILITY.routing, ...(c.routing && typeof c.routing === "object" ? c.routing : {}) },
    bounds: { ...BASE_CAPABILITY.bounds, ...(c.bounds && typeof c.bounds === "object" ? c.bounds : {}) },
    tools: Array.isArray(c.tools) ? c.tools : BASE_CAPABILITY.tools,
    context: Array.isArray(c.context) ? c.context : BASE_CAPABILITY.context,
    gates: Array.isArray(c.gates) ? c.gates : BASE_CAPABILITY.gates,
    emits: Array.isArray(c.emits) ? c.emits : BASE_CAPABILITY.emits,
    requires: Array.isArray(c.requires) ? c.requires : BASE_CAPABILITY.requires,
    team: (c.team && typeof c.team === "object") ? c.team : null,
  });
}

// ---- reading a capability at run time ----------------------------------------
//
// Stage 2 shipped the capability block DECLARED: a test asserted each field
// equalled the constant that actually governed the run, which caught drift but
// meant a spec could not vary anything. These three accessors are what make a
// field EXECUTED — the pipeline reads the agent's declaration instead of the
// constant it used to import.
//
// Every one of them is NARROWING. The platform's own limit is passed in as both
// the default (a spec that declares nothing gets exactly today's behaviour) and
// the ceiling (a spec may ask its own run to do less, never more). That
// asymmetry is the whole safety argument for stage 7: once a spec can be
// authored by a user rather than committed to the repo, the worst a hostile
// declaration can do is make its own agent do less work. There is no value of
// any capability field that reaches further than the code already reaches.

/**
 * A declared bound, clamped to the platform limit for the phase that runs it.
 * `limit` is the constant the code enforces (MAX_SOURCE_TOOL_ROUNDS and
 * friends), so an absent, malformed or over-large declaration all resolve to
 * exactly today's value.
 * @param {AgentCapability | null | undefined} cap
 * @param {string} key one of BOUND_KEYS
 * @param {number} limit the platform's own ceiling for this bound
 * @returns {number}
 */
export function capBound(cap, key, limit) {
  const v = /** @type {any} */ (cap?.bounds)?.[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return limit;
  return Math.min(v, limit);
}

/**
 * The search policy for a run: the agent's declared ceiling ANDed with what the
 * request asked for. A knob that is off stays off whatever the spec says, and a
 * spec that declares `web: false` cannot be re-enabled by a request — the two
 * compose by narrowing in both directions.
 *
 * `maxQueries: null` means "no agent-imposed cap" on either side, so it yields
 * to whichever side names a number.
 * @param {AgentCapability | null | undefined} cap
 * @param {{ web?: boolean, auxSources?: boolean, maxQueries?: number|null }} requested
 * @returns {{ web: boolean, auxSources: boolean, maxQueries: number|null }}
 */
export function capSearch(cap, requested = {}) {
  const s = cap?.search || /** @type {any} */ ({});
  const caps = [s.maxQueries, requested.maxQueries].filter(
    (/** @type {any} */ n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
  );
  return {
    web: requested.web !== false && s.web !== false,
    auxSources: requested.auxSources !== false && s.auxSources !== false,
    maxQueries: caps.length ? Math.min(.../** @type {number[]} */ (caps)) : null,
  };
}

/**
 * Whether a capability selects a tool CLASS. A null capability selects none,
 * which is what a request that never consulted the registry means.
 * @param {AgentCapability | null | undefined} cap
 * @param {string} cls a key of TOOL_CLASSES
 * @returns {boolean}
 */
export function capHasTool(cap, cls) {
  return Array.isArray(cap?.tools) && /** @type {string[]} */ (cap?.tools).includes(cls);
}

/**
 * The prompt set an agent runs on: its declared `capability.prompts`, else the
 * default for its answer phase. Always a key of PROMPT_SETS for a valid spec.
 * @param {any} a
 * @returns {string}
 */
export function resolvePromptSet(a) {
  const cap = resolveCapability(a);
  if (cap.prompts && Object.prototype.hasOwnProperty.call(PROMPT_SETS, cap.prompts)) return cap.prompts;
  return /** @type {Record<string,string>} */ (DEFAULT_PROMPT_SET)[cap.answerPhase] || DEFAULT_PROMPT_SET.research;
}

/**
 * The prompt roles a phase needs that its resolved set does not fill. Empty for
 * a valid spec — this is the compatibility rule behind validateCapability, kept
 * separate so the failing case can be inspected directly.
 * @param {any} a
 * @returns {string[]}
 */
export function missingPromptRoles(a) {
  const phase = /** @type {any} */ (ANSWER_PHASES)[resolveCapability(a).answerPhase];
  if (!phase) return [];
  const filled = new Set(/** @type {any} */ (PROMPT_SETS)[resolvePromptSet(a)]?.roles || []);
  return (phase.promptRoles || []).filter((/** @type {string} */ r) => !filled.has(r));
}

/**
 * Every SERVER-ONLY member a capability selects, as `axis:member` strings. The
 * privacy split (invariant 4) is exactly "this list must be empty for a
 * client-tier agent" — computed here so the rule has one implementation and the
 * failing case can be inspected directly.
 * @param {any} a
 * @returns {string[]}
 */
export function serverOnlySelections(a) {
  const cap = resolveCapability(a);
  const hits = [];
  /** @param {string} axis @param {Record<string,any>} reg @param {unknown} member */
  const check = (axis, reg, member) => {
    const entry = typeof member === "string" ? reg[member] : null;
    if (entry && entry.serverOnly) hits.push(`${axis}:${member}`);
  };
  check("answerPhase", ANSWER_PHASES, cap.answerPhase);
  for (const t of cap.tools) check("tools", TOOL_CLASSES, t);
  for (const b of cap.context) check("context", CONTEXT_BLOCKS, b);
  for (const e of cap.emits) check("emits", CAPABILITY_EVENTS, e);
  for (const r of cap.requires) check("requires", CAPABILITY_REQUIREMENTS, r);
  // A sub-agent team is executed by the Worker, whatever its member kinds are.
  if (cap.team) hits.push("team:workflow");
  return hits;
}

/**
 * Structural validation of one capability block. Returns problem strings —
 * empty means valid. Never throws (the validateAgentSpec convention).
 * @param {any} a
 * @returns {string[]}
 */
export function validateCapability(a) {
  const problems = [];
  const at = (/** @type {string} */ msg) => `${a && a.id ? a.id : "(no id)"}: capability.${msg}`;
  if (a?.capability != null && typeof a.capability !== "object") return [at("must be an object")];
  const cap = resolveCapability(a);

  if (!Object.prototype.hasOwnProperty.call(ANSWER_PHASES, cap.answerPhase)) {
    problems.push(at(`answerPhase must be one of ${Object.keys(ANSWER_PHASES).join("/")}`));
  }
  // Prompts: a named set that exists, and one that fills every role the
  // declared answer phase asks for. Prompt set and phase are independent
  // choices, but not arbitrary ones — a phase that calls for a plan prompt
  // cannot run on a set that has none.
  if (cap.prompts != null) {
    if (!Object.prototype.hasOwnProperty.call(PROMPT_SETS, cap.prompts)) {
      problems.push(at(`prompts must be one of ${Object.keys(PROMPT_SETS).join("/")}`));
    } else {
      const missing = missingPromptRoles(a);
      if (missing.length) {
        problems.push(at(`prompt set "${cap.prompts}" does not fill the ${cap.answerPhase} phase's ${missing.join(", ")} role(s)`));
      }
    }
  }
  for (const t of cap.tools) {
    if (!Object.prototype.hasOwnProperty.call(TOOL_CLASSES, t)) problems.push(at(`unknown tool class "${t}"`));
  }
  if (!TOOL_FALLBACKS.includes(cap.toolFallback)) {
    problems.push(at(`toolFallback must be one of ${TOOL_FALLBACKS.join("/")}`));
  }
  // Invariant 1: a mode that uses tools must still work on a model without
  // native tool use, so it has to name the deterministic path it falls back to.
  if (cap.tools.length && cap.toolFallback === "none") {
    problems.push(at('declares tools but no toolFallback — every mode must work on models without native tool use'));
  }
  for (const b of cap.context) {
    if (!Object.prototype.hasOwnProperty.call(CONTEXT_BLOCKS, b)) problems.push(at(`unknown context block "${b}"`));
  }
  for (const e of cap.emits) {
    if (!Object.prototype.hasOwnProperty.call(CAPABILITY_EVENTS, e)) problems.push(at(`unknown emitted event "${e}"`));
  }
  for (const r of cap.requires) {
    if (!Object.prototype.hasOwnProperty.call(CAPABILITY_REQUIREMENTS, r)) problems.push(at(`unknown requirement "${r}"`));
  }

  // Invariant 3: the JSON planning phases stay on the fixed reliable model.
  if (!PLAN_MODELS.includes(cap.routing.planModel)) {
    problems.push(at(`routing.planModel must be "${PLAN_MODELS[0]}" — the planning phases never move off the fixed model (invariant 3)`));
  }
  if (!ANSWER_MODELS.includes(cap.routing.answerModel)) {
    problems.push(at(`routing.answerModel must be one of ${ANSWER_MODELS.join("/")}`));
  }

  // Search plane
  if (typeof cap.search.web !== "boolean") problems.push(at("search.web must be a boolean"));
  if (typeof cap.search.auxSources !== "boolean") problems.push(at("search.auxSources must be a boolean"));
  if (cap.search.maxQueries != null && !(Number.isInteger(cap.search.maxQueries) && cap.search.maxQueries >= 0)) {
    problems.push(at("search.maxQueries must be null or a non-negative integer"));
  }

  // Invariant 6: a declared deterministic gate routes Swedish and English alike.
  for (const g of cap.gates) {
    if (!g || typeof g !== "object") { problems.push(at("a gate is not an object")); continue; }
    if (!Object.prototype.hasOwnProperty.call(GATE_IDS, g.id)) { problems.push(at(`unknown gate "${g.id}"`)); continue; }
    const langs = Array.isArray(g.langs) ? g.langs : [];
    if (!langs.includes("en") || !langs.includes("sv")) {
      problems.push(at(`gate "${g.id}" must declare langs including "en" and "sv" (invariant 6 — language parity)`));
    }
  }

  // Bounds
  for (const [k, v] of Object.entries(cap.bounds)) {
    if (!BOUND_KEYS.includes(k)) problems.push(at(`unknown bound "${k}"`));
    else if (!(Number.isFinite(v) && /** @type {number} */ (v) >= 0)) problems.push(at(`bounds.${k} must be a non-negative number`));
  }

  // Team (sub-agent composition)
  if (cap.team) {
    if (!Array.isArray(cap.team.kinds) || !cap.team.kinds.length) {
      problems.push(at("team.kinds must be a non-empty array of agent ids"));
    }
    for (const k of ["maxAgents", "maxWaves", "maxQueriesPerAgent"]) {
      const v = /** @type {any} */ (cap.team)[k];
      if (v != null && !(Number.isInteger(v) && v > 0)) problems.push(at(`team.${k} must be a positive integer`));
    }
    if (cap.answerPhase !== "workflow") problems.push(at('team is only meaningful with answerPhase "workflow"'));
  }

  // Invariant 4 — the privacy split, as a rule rather than as prose: a
  // client-tier agent may not select anything that puts the server in the data
  // path. The platform type IS the boundary.
  if (a?.platform === "client") {
    for (const hit of serverOnlySelections(a)) {
      problems.push(at(`"${hit}" puts the server in the data path — a client-platform agent may not select it (invariant 4)`));
    }
  }
  return problems;
}

// ---- validation --------------------------------------------------------------

/**
 * Structural validation of one agent spec. Returns a list of problem strings —
 * empty means valid. Never throws: a bad field is a reported problem, so the
 * Agent Studio can surface exactly what to fix.
 * @param {any} a
 * @returns {string[]}
 */
export function validateAgentSpec(a) {
  const problems = [];
  const at = (/** @type {string} */ msg) => `${a && a.id ? a.id : "(no id)"}: ${msg}`;
  if (!a || typeof a !== "object") return ["spec is not an object"];
  if (!a.id || typeof a.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(a.id)) {
    problems.push(at("id must be a lowercase slug [a-z][a-z0-9-]*"));
  }
  if (!a.name || typeof a.name !== "string") problems.push(at("name is required"));
  if (!PLATFORM_TYPES.includes(a.platform)) problems.push(at(`platform must be one of ${PLATFORM_TYPES.join("/")}`));
  // The mode must name a real chat mode. Unvalidated until 0.2.0, which is how
  // `"agent-builder"` sat in the registry while the running app's id was `"sdk"`.
  if (a.mode != null && !CHAT_MODE_IDS.includes(a.mode)) {
    problems.push(at(`mode "${a.mode}" is not a chat mode (${CHAT_MODE_IDS.join("/")})`));
  }

  // Controls
  if (!Array.isArray(a.controls) || !a.controls.length) {
    problems.push(at("controls must be a non-empty array"));
  } else {
    const seen = new Set();
    for (const c of a.controls) {
      if (!c || typeof c !== "object") { problems.push(at("a control is not an object")); continue; }
      if (!CONTROL_TYPES.includes(c.type)) { problems.push(at(`unknown control type "${c.type}"`)); continue; }
      const key = c.id || c.type;
      if (seen.has(key)) problems.push(at(`duplicate control "${key}"`));
      seen.add(key);
      if (c.type === "toggle" && !c.id) problems.push(at('a "toggle" control needs an id (the flag it drives)'));
      if (c.type === "mode-select") {
        for (const m of Array.isArray(c.modes) ? c.modes : []) {
          if (!CHAT_MODE_IDS.includes(m)) problems.push(at(`mode-select offers "${m}", which is not a chat mode`));
        }
      }
      if (c.type === "depth-slider") {
        const min = c.min ?? CONTROL_REGISTRY["depth-slider"].defaults.min;
        const max = c.max ?? CONTROL_REGISTRY["depth-slider"].defaults.max;
        if (!(Number.isInteger(min) && Number.isInteger(max) && min < max)) {
          problems.push(at("depth-slider needs integer min < max"));
        }
      }
    }
    // Every agent must have a way to type and send a message.
    if (!a.controls.some((/** @type {any} */ c) => c && c.type === "prompt-input")) problems.push(at('controls must include a "prompt-input"'));
  }

  // Theme: a small set of CSS-custom-property values.
  if (a.theme && typeof a.theme !== "object") problems.push(at("theme must be an object of CSS custom properties"));

  // Animations
  for (const k of ["intro", "loading"]) {
    if (a[k] && typeof a[k] !== "object") problems.push(at(`${k} must be an object`));
    if (a[k] && a[k].kind && typeof a[k].kind !== "string") problems.push(at(`${k}.kind must be a string`));
  }

  // Backdrop (the agent background — closed vocabulary like the control types)
  if (a.backdrop != null) {
    if (typeof a.backdrop !== "object") problems.push(at("backdrop must be an object"));
    else if (a.backdrop.kind != null && !BACKDROP_KINDS.includes(a.backdrop.kind)) {
      problems.push(at(`backdrop.kind must be one of ${BACKDROP_KINDS.join("/")}`));
    }
  }

  // Examples
  if (a.examples && !Array.isArray(a.examples)) problems.push(at("examples must be an array of strings"));

  // Quota (share-link token defaults)
  const q = a.quota;
  if (q != null) {
    if (typeof q !== "object") problems.push(at("quota must be an object"));
    else {
      if (q.window != null && !QUOTA_WINDOWS.includes(q.window)) problems.push(at(`quota.window must be one of ${QUOTA_WINDOWS.join("/")}`));
      for (const k of ["requests", "credits"]) {
        if (q[k] != null && !(Number.isFinite(q[k]) && q[k] >= 0)) problems.push(at(`quota.${k} must be a non-negative number`));
      }
    }
  }

  // Capability (spec 0.2.0) — what the agent DOES, as a selection over shipped
  // behaviour. Absent means BASE_CAPABILITY: a plain deep-research turn.
  for (const p of validateCapability(a)) problems.push(p);
  return problems;
}

// ---- resolving a spec the repo did not commit --------------------------------
//
// Every spec above ships inside the source snapshot, so `npm test` is what
// stands between a bad declaration and production. A spec a USER authored has
// no such gate: validation has to move onto the request path, and it has to
// fail closed.
//
// Validation alone is not enough, because of one asymmetry that is easy to
// miss. `capability.requires` is SELF-DECLARED. A spec that selects the build
// tools and declares `requires: []` would, under the ordinary routing gate,
// sail straight through — the gate checks what the spec claims to need, not
// what it actually reaches for. So the requirement a selection carries has to
// be DERIVED from the selection, and the derived set is what gets checked.

/**
 * Selection → the capability knobs it actually needs, regardless of what the
 * spec declares. Only members that reach privileged machinery appear; a
 * selection absent here needs nothing (the shell TRANSCRIPT, for instance, is
 * context the client already attached and is gated where it is collected).
 *
 * Every shipped agent's declared `requires` is a superset of what this derives
 * for it, asserted in agent-capability.test.js — so the table is checked
 * against the real registry rather than being a parallel opinion of it.
 */
export const IMPLIED_REQUIREMENTS = {
  answerPhase: {
    "source-research": ["developer_mode"],
    "build": ["developer_mode"],
    "workflow": ["developer_mode"],
    "feed": ["developer_mode"],
  },
  tools: {
    "source-read": ["developer_mode"],
    "sdk-plan": ["developer_mode"],
    "build-publish": ["developer_mode"],
    "shell": ["sandbox"],
  },
  context: {
    "source-snapshot": ["developer_mode"],
    "docs-corpus": ["developer_mode"],
    "secure-digest": ["developer_mode"],
    "outward-feed": ["developer_mode"],
  },
};

/**
 * Every capability knob an agent needs: what it declares, PLUS what its
 * selections imply. Sorted and deduped so the result is comparable.
 * @param {any} a
 * @returns {string[]}
 */
export function requirementsFor(a) {
  const cap = resolveCapability(a);
  const need = new Set(cap.requires);
  for (const r of /** @type {any} */ (IMPLIED_REQUIREMENTS.answerPhase)[cap.answerPhase] || []) need.add(r);
  for (const t of cap.tools) for (const r of /** @type {any} */ (IMPLIED_REQUIREMENTS.tools)[t] || []) need.add(r);
  for (const b of cap.context) for (const r of /** @type {any} */ (IMPLIED_REQUIREMENTS.context)[b] || []) need.add(r);
  return [...need].sort();
}

/**
 * Resolve a spec that did NOT come from the committed registry — one a user
 * wrote through Agent Studio, or one read back from per-user storage.
 *
 * Fails closed in every direction: a spec that is not an object, that fails any
 * validation rule, or that reaches for a knob the caller has not been granted
 * yields a null agent and the reasons why. There is no partial success and no
 * "resolve what we can" path — a spec is either wholly servable or it is not
 * served, because a half-applied capability block is exactly the state no
 * reader downstream is written to expect.
 *
 * What makes this safe rather than merely careful is that it adds no new rules.
 * The closed vocabularies already reject anything that is not a member; the
 * invariant rules (1, 3, 4, 6) already run inside `validateAgentSpec`; the
 * narrowing accessors already make every field a ceiling rather than a request.
 * This function's whole job is to run them at the boundary and refuse.
 *
 * @param {any} spec an untrusted AgentSpec
 * @param {Record<string, boolean>} granted capability knob → granted?
 * @returns {{ agent: any, capability: AgentCapability | null, problems: string[] }}
 */
export function resolveUntrustedAgent(spec, granted = {}) {
  const deny = (/** @type {string[]} */ problems) => ({ agent: null, capability: null, problems });
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return deny(["spec is not an object"]);
  const problems = validateAgentSpec(spec);
  if (problems.length) return deny(problems);
  const missing = requirementsFor(spec).filter((r) => granted[r] !== true);
  if (missing.length) {
    return deny(missing.map((r) => `${spec.id}: requires "${r}", which this caller has not been granted`));
  }
  return { agent: spec, capability: resolveCapability(spec), problems: [] };
}

/**
 * Validate a whole registry object ({agents:[...]}). Checks each spec plus
 * cross-agent uniqueness of ids. Returns problem strings; empty means valid.
 * @param {any} reg
 * @returns {string[]}
 */
export function validateAgentRegistry(reg) {
  const problems = [];
  if (!reg || !Array.isArray(reg.agents)) return ["registry has no agents array"];
  const ids = new Set();
  for (const a of reg.agents) {
    for (const p of validateAgentSpec(a)) problems.push(p);
    if (a && a.id) {
      if (ids.has(a.id)) problems.push(`duplicate agent id: ${a.id}`);
      ids.add(a.id);
    }
  }
  // Cross-agent: a workflow's team may only name agents that exist.
  for (const a of reg.agents) {
    for (const k of resolveCapability(a).team?.kinds || []) {
      if (!ids.has(k)) problems.push(`${a?.id}: capability.team.kinds names unknown agent "${k}"`);
    }
  }
  // The defaults routing table: one entry per chat mode, naming a real agent.
  const rows = Array.isArray(reg.defaults) ? reg.defaults : null;
  if (rows) {
    const seen = new Set();
    for (const r of rows) {
      if (!r || typeof r !== "object") { problems.push("a defaults row is not an object"); continue; }
      if (!CHAT_MODE_IDS.includes(r.mode)) problems.push(`defaults: "${r.mode}" is not a chat mode`);
      if (seen.has(r.mode)) problems.push(`defaults: duplicate mode "${r.mode}"`);
      seen.add(r.mode);
      if (!ids.has(r.agent)) problems.push(`defaults: mode "${r.mode}" names unknown agent "${r.agent}"`);
      if (r.flag != null && typeof r.flag !== "string") problems.push(`defaults: mode "${r.mode}" flag must be a string or null`);
    }
    for (const m of CHAT_MODE_IDS) {
      if (!seen.has(m)) problems.push(`defaults: chat mode "${m}" has no default agent`);
    }
  }
  return problems;
}

// ---- request routing (the defaults table) ------------------------------------
//
// `reg.defaults` is an ORDERED table — array order IS precedence — mapping each
// Se/rver chat mode to the agent that IS that mode, and naming the /api/chat
// request flag that selects it. Resolving a request against it replaces the
// hand-written flag cascade in src/chat.js, so adding a sixth mode is a
// registry edit rather than an edit in every file that mentions a mode.

/**
 * The agent a request resolves to, in three passes.
 *
 *  1. **Addressed by id** — `body.agent` names a registry entry directly. This
 *     is what makes a registry agent reachable WITHOUT a `defaults` row, a mode
 *     flag, a `CHAT_MODE_IDS` entry, a mode-theme descriptor or any CSS: the
 *     difference between "a sixth MODE is data" (which the defaults table
 *     already gave us) and "a sixth AGENT is data", which is what a builder
 *     actually needs. The named agent's own `mode` is reported, so an agent
 *     that belongs to no chat mode still says which one it renders as.
 *  2. **Flagged rows**, in `defaults` order — the mode flags, precedence being
 *     array order (sdk > orchestrator > outrospection).
 *  3. **Derived rows** (null flag) — introspection when its knob is granted,
 *     else normal.
 *
 * Every pass applies the SAME requirement gate: an agent whose declared
 * `capability.requires` are not all granted is skipped, never served. So an
 * unknown id, a misspelt id and an id the caller may not have all behave
 * identically — the request falls through to the table it would have got
 * anyway. Addressing can narrow what answers a request; it can never reach a
 * capability the knobs withhold.
 *
 * Returns null when the registry is unusable, so the caller keeps its built-in
 * behaviour rather than failing the request (invariant 2).
 * @param {any} reg
 * @param {Record<string, any>} body the /api/chat request body
 * @param {Record<string, boolean>} granted capability knob → granted?
 * @returns {{ mode: string, agent: any, capability: typeof BASE_CAPABILITY, addressed: boolean } | null}
 */
export function resolveRequestAgent(reg, body, granted = {}) {
  const rows = Array.isArray(reg?.defaults) ? reg.defaults : null;
  if (!rows || !rows.length) return null;
  /** @param {any} agent @param {string} mode @param {boolean} addressed */
  const serve = (agent, mode, addressed) => {
    if (!agent) return null;
    const cap = resolveCapability(agent);
    for (const req of cap.requires) if (granted[req] !== true) return null;
    return { mode, agent, capability: cap, addressed };
  };
  /** @param {any} row */
  const usable = (row) => serve(findAgent(reg, row?.agent), row?.mode, false);

  const named = typeof body?.agent === "string" ? body.agent.trim() : "";
  if (named) {
    const agent = findAgent(reg, named);
    // `mode` falls back to normal for an agent bound to no chat mode — a
    // derived agent renders in the plain composer unless it says otherwise.
    const hit = serve(agent, agent?.mode || "normal", true);
    if (hit) return hit;
  }

  for (const row of rows) {
    if (!row?.flag) continue;
    if (body?.[row.flag] !== true) continue;
    const hit = usable(row);
    if (hit) return hit;
  }
  for (const row of rows) {
    if (row?.flag) continue;
    const hit = usable(row);
    if (hit) return hit;
  }
  return null;
}

/** The default agent for a chat mode, straight from the routing table.
 * @param {any} reg @param {string} mode @returns {any | null} */
export function defaultAgentForMode(reg, mode) {
  const row = (Array.isArray(reg?.defaults) ? reg.defaults : []).find((/** @type {any} */ r) => r?.mode === mode);
  return row ? findAgent(reg, row.agent) : null;
}

// ---- resolution --------------------------------------------------------------

/**
 * Normalize a terse control descriptor into a full one: fill the type's default
 * fields, resolve its label, and record which request field it `drives`. This
 * is what a renderer draws from and what the proof test asserts against.
 * @param {any} c
 * @returns {any}
 */
export function resolveControl(c) {
  const reg = /** @type {any} */ (CONTROL_REGISTRY)[c.type];
  if (!reg) return { ...c, unknown: true };
  const out = { ...reg.defaults, ...c };
  out.type = c.type;
  out.id = c.id || c.type;
  out.label = c.label || reg.label;
  out.drives = c.type === "toggle" ? c.id : reg.drives;
  return out;
}

/**
 * The full, ordered control set for an agent: resolved descriptors. Guarantees
 * a prompt-input and a send-button exist (appended if a spec omitted the
 * send-button — the one control every composer needs and rarely bothers to
 * name).
 * @param {any} a
 * @returns {any[]}
 */
export function resolveControls(a) {
  const list = Array.isArray(a?.controls) ? a.controls.map(resolveControl) : [];
  if (!list.some((/** @type {any} */ c) => c.type === "send-button")) list.push(resolveControl({ type: "send-button" }));
  return list;
}

/** The default theme custom properties an agent inherits when it declares none. */
export const BASE_THEME = {
  "--agent-accent": "#3b82f6",
  "--agent-accent-soft": "rgba(59,130,246,0.14)",
  "--agent-bg": "#0b0f17",
  "--agent-fg": "#e8edf4",
};

/**
 * The resolved theme: BASE_THEME overlaid with the spec's declared properties.
 * @param {any} a
 * @returns {Record<string,string>}
 */
export function resolveTheme(a) {
  return { ...BASE_THEME, ...(a && a.theme && typeof a.theme === "object" ? a.theme : {}) };
}

/**
 * The default share-link quota for an agent, filled from spec.quota with safe
 * fallbacks. A minted agent link is metered by exactly these numbers under a
 * freshly-issued token (PA-8/PA-9 — fail-safe, bounded, revocable).
 * @param {any} a
 * @returns {{ window: string, requests: number, credits: number|null, note: string }}
 */
export function resolveQuota(a) {
  const q = (a && a.quota && typeof a.quota === "object") ? a.quota : {};
  return {
    window: QUOTA_WINDOWS.includes(q.window) ? q.window : "day",
    requests: Number.isFinite(q.requests) && q.requests >= 0 ? q.requests : 50,
    credits: Number.isFinite(q.credits) && q.credits >= 0 ? q.credits : null,
    note: typeof q.note === "string" ? q.note : "",
  };
}

// ---- share-link mint contract (PA-8 / PA-9) ----------------------------------

/**
 * The upstream services an agent SHARE LINK needs, named in the Se/rver
 * token's CLOSED permission vocabulary (server-token.js `SERVER_TOKEN_SERVICES`
 * = `web`/`api`): `api` = one LLM completion through the server's key (any agent
 * that calls a model), `web` = one web search through the server's key (an agent
 * with a web-search toggle). Kept here as plain strings so this pure module has
 * no server-token import; the endpoint feeds them to `mintServerTokenGrant`.
 */
export const AGENT_LINK_SERVICES = { llm: "api", search: "web" };

/**
 * The token-mint request an agent SHARE LINK produces: the upstream
 * permissions the agent needs (derived from its controls) plus the quota the
 * minted token is metered by (from resolveQuota). This is the bounded,
 * disclosed, revocable, fail-safe contract of the pair's server-token bridge —
 * the token authorises upstream API access ONLY, never the Se/rver tier's own
 * data, never a login. Pure: the caller signs/persists it (server-grants.js);
 * this only computes what a link for THIS agent should grant, straight from the
 * spec, so a shared agent runs on exactly the credits you defined and not more.
 * @param {any} a
 * @returns {{ agent: string, platform: string, perms: string[], quota: ReturnType<typeof resolveQuota> }}
 */
export function agentLinkPlan(a) {
  const controls = resolveControls(a);
  const perms = new Set();
  for (const c of controls) {
    if (c.type === "model-select" || c.type === "prompt-input") perms.add(AGENT_LINK_SERVICES.llm); // "api"
    if (c.type === "toggle" && (c.id === "web_search" || c.id === "search")) perms.add(AGENT_LINK_SERVICES.search); // "web"
  }
  return {
    agent: a?.id || "",
    platform: a?.platform || "client",
    perms: [...perms],
    quota: resolveQuota(a),
  };
}

/** A quota window as a token TTL in hours (the Se/rver token carries ONE duration). @param {string} window */
export function windowHours(window) {
  switch (window) {
    case "minute": return 1 / 60;
    case "hour": return 1;
    case "month": return 24 * 30;
    case "day":
    default: return 24;
  }
}

/**
 * The exact arguments a share-link mint passes to `mintServerTokenGrant`
 * (src/server-grants.js): the upstream `services`, a per-service `quotas` map
 * (the spec's credits — else its request count — as the unit allowance), the
 * `ttlHours` from the quota window, and a human `label`. This is the one seam
 * between the pure AgentSpec and the existing server-token subsystem, so the
 * endpoint stays a thin adapter and the JWT/metering stay entirely by the book.
 * @param {any} a
 * @returns {{ services: string[], quotas: Record<string, number>, ttlHours: number, label: string }}
 */
export function agentTokenGrantParams(a) {
  const plan = agentLinkPlan(a);
  const units = plan.quota.credits != null ? plan.quota.credits : plan.quota.requests;
  /** @type {Record<string, number>} */
  const quotas = {};
  for (const svc of plan.perms) quotas[svc] = units;
  return {
    services: plan.perms,
    quotas,
    ttlHours: windowHours(plan.quota.window),
    label: (a && a.name) ? String(a.name) : (a && a.id) || "agent",
  };
}

// ---- example questions -------------------------------------------------------

/**
 * The example questions to show for an agent: its seed `examples`, de-duplicated
 * and bounded. `generatable` is true when the agent opted into on-demand
 * generation (the Agent Studio can then ask the model for more, seeded by these
 * and the agent's purpose). Pure: generation itself is a model call at the call
 * site — this only resolves the seed + the flag.
 * @param {any} a
 * @param {number} [max]
 * @returns {{ seed: string[], generatable: boolean }}
 */
export function resolveExamples(a, max = 6) {
  const seen = new Set();
  const seed = [];
  for (const e of Array.isArray(a?.examples) ? a.examples : []) {
    const s = typeof e === "string" ? e.trim() : "";
    if (s && !seen.has(s)) { seen.add(s); seed.push(s); }
    if (seed.length >= max) break;
  }
  return { seed, generatable: a?.generateExamples !== false };
}

/**
 * The prompt used to GENERATE fresh example questions for an agent (the Agent
 * Builder feeds this to the answer model). Pure string assembly; the caller
 * runs the model and parses one-question-per-line.
 * @param {any} a
 * @param {number} [n]
 * @returns {string}
 */
export function exampleGenPrompt(a, n = 4) {
  const purpose = a?.tagline || a?.description || a?.name || "a research assistant";
  const seed = resolveExamples(a).seed;
  return [
    `Write ${n} short, natural example questions a user might ask "${a?.name || a?.id}" — ${purpose}.`,
    seed.length ? `Match the style of these existing examples:\n${seed.map((s) => `- ${s}`).join("\n")}` : "",
    "Return ONE question per line, no numbering, no preamble.",
  ].filter(Boolean).join("\n\n");
}

// ---- snapshot loading (mirrors sdk-core.manifestFromSnapshot) ----------------

/** The registry's repo path — resolved out of the committed source snapshot. */
export const AGENTS_PATH = "sdk/AGENTS.json";

/**
 * Parse sdk/AGENTS.json out of a source snapshot ({files:[{p,t}]}). Null (never
 * a throw) when missing or unparsable — so the Agent Studio degrades to "no
 * agent templates in this deployment" rather than erroring.
 * @param {{ files?: Array<{p: string, t: string}> } | null | undefined} snapshot
 * @returns {any | null}
 */
export function agentsFromSnapshot(snapshot) {
  try {
    const f = (snapshot?.files || []).find((x) => x.p === AGENTS_PATH);
    if (!f || typeof f.t !== "string") return null;
    const reg = JSON.parse(f.t);
    return reg && Array.isArray(reg.agents) ? reg : null;
  } catch {
    return null;
  }
}

/** @param {any} reg @param {string} id @returns {any | null} */
export function findAgent(reg, id) {
  return (reg?.agents || []).find((/** @type {any} */ a) => a && a.id === id) || null;
}

// ---- rendering (plain text — terminal / VM / tool-result friendly) -----------

/** @param {any} reg @returns {string} */
export function renderAgentList(reg) {
  const lines = ["Agents (sdk/AGENTS.json) — DistillSDK flavours of the Se/cure + Se/rver pair:", ""];
  for (const a of reg?.agents || []) {
    const ctrls = (a.controls || []).map((/** @type {any} */ c) => c.id || c.type).join(", ");
    lines.push(`  ${a.id}  (${a.platform})  ${a.name}`);
    lines.push(`      ${a.tagline || ""}`);
    lines.push(`      controls: ${ctrls}`);
  }
  return lines.join("\n").trimEnd();
}

// ---- the composer model + markup (the "an agent IS its composer" renderer) ---
//
// composerModel() is the single resolved description of an agent's chat-input
// pane: its ordered controls, theme, animations and examples. Both the browser
// preview (public/js/agent-preview.js, which adds interactivity) and the
// Node-run visual proof (scripts/agent-proof.mjs) build from it, so what the
// proof asserts is exactly what a user sees — the spec defines the composer.

/** @param {any} a @returns {{ id:string, name:string, tagline:string, platform:string, mode:string, controls:any[], theme:Record<string,string>, intro:any, loading:any, backdrop:any, examples:{seed:string[],generatable:boolean}, quota:any, capability:any }} */
export function composerModel(a) {
  return {
    id: a?.id || "",
    name: a?.name || a?.id || "",
    tagline: a?.tagline || "",
    platform: a?.platform || "client",
    mode: a?.mode || "normal",
    controls: resolveControls(a),
    theme: resolveTheme(a),
    intro: a?.intro || { kind: "none" },
    loading: a?.loading || { kind: "none" },
    backdrop: a?.backdrop && BACKDROP_KINDS.includes(a.backdrop.kind) ? a.backdrop : { kind: "none" },
    examples: resolveExamples(a),
    quota: resolveQuota(a),
    capability: resolveCapability(a),
  };
}

/** Minimal HTML escape for text interpolated into the proof markup. @param {unknown} s */
function esc(s) {
  /** @type {Record<string,string>} */
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * The composer markup for ONE control, as an HTML string. Every element carries
 * `data-control` (the type) and, when it sets a request field, `data-drives`
 * (that field) — the attributes the visual proof and the browser wiring both
 * key off. Pure and XSS-safe.
 * @param {any} c a resolved control (from resolveControl)
 * @returns {string}
 */
export function controlMarkup(c) {
  const base = `data-control="${esc(c.type)}"${c.drives ? ` data-drives="${esc(c.drives)}"` : ""}`;
  switch (c.type) {
    case "prompt-input":
      return `<textarea class="ac-prompt" ${base} placeholder="${esc(c.placeholder)}" rows="2"></textarea>`;
    case "send-button":
      return `<button type="button" class="ac-send" ${base}>${esc(c.label)}</button>`;
    case "model-select":
      return `<label class="ac-ctl ac-model"><span>${esc(c.label)}</span><select ${base}><option>${esc(c.providers)} models…</option></select></label>`;
    case "depth-slider": {
      const ticks = (c.ticks || []).map((/** @type {any} */ t) => `<span>${esc(t)}</span>`).join("");
      return `<label class="ac-ctl ac-depth"><span>${esc(c.label)}</span><input type="range" ${base} min="${esc(c.min)}" max="${esc(c.max)}" value="${esc(c.default)}"><span class="ac-ticks">${ticks}</span></label>`;
    }
    case "toggle":
      return `<label class="ac-ctl ac-toggle"><input type="checkbox" ${base}${c.default ? " checked" : ""}><span>${esc(c.label)}</span></label>`;
    case "mode-select": {
      const opts = (c.modes || []).map((/** @type {any} */ m) => `<option>${esc(m)}</option>`).join("");
      return `<label class="ac-ctl ac-mode"><span>${esc(c.label)}</span><select ${base}>${opts}</select></label>`;
    }
    case "attachments":
      return `<button type="button" class="ac-ctl ac-attach" ${base} data-max="${esc(c.max)}">📎 ${esc(c.label)}</button>`;
    default:
      return `<span ${base}>${esc(c.label || c.type)}</span>`;
  }
}

/**
 * The full composer markup for an agent: a themed container whose child order IS
 * the spec's control order, with a toolbar (every non prompt/send control), the
 * prompt row, and an examples strip. Self-contained (inline theme vars); the
 * caller supplies surrounding CSS (public/agents/preview.html or the proof
 * gallery). Pure — no DOM, safe in Node.
 * @param {any} a
 * @returns {string}
 */
export function composerMarkup(a) {
  const m = composerModel(a);
  const styleVars = Object.entries(m.theme).map(([k, v]) => `${k}:${v}`).join(";");
  const toolbar = m.controls.filter((c) => c.type !== "prompt-input" && c.type !== "send-button").map(controlMarkup).join("\n      ");
  const prompt = m.controls.find((c) => c.type === "prompt-input");
  const send = m.controls.find((c) => c.type === "send-button");
  const examples = m.examples.seed.map((q) => `<button type="button" class="ac-example" data-example>${esc(q)}</button>`).join("\n      ");
  return `<div class="agent-composer" data-agent="${esc(m.id)}" data-platform="${esc(m.platform)}" data-mode="${esc(m.mode)}" data-intro="${esc(m.intro.kind || "none")}" data-loading="${esc(m.loading.kind || "none")}" data-backdrop="${esc(m.backdrop.kind || "none")}" style="${styleVars}">
  <div class="ac-head"><strong class="ac-name">${esc(m.name)}</strong><span class="ac-tag">${esc(m.tagline)}</span></div>
  ${examples ? `<div class="ac-examples">\n      ${examples}\n  </div>` : ""}
  <div class="ac-toolbar">\n      ${toolbar}\n  </div>
  <div class="ac-promptrow">
      ${prompt ? controlMarkup(prompt) : ""}
      ${send ? controlMarkup(send) : ""}
  </div>
</div>`;
}

/**
 * The visual-proof check for one agent: assert every DECLARED control renders
 * into the composer markup (its data-control present) — the spec-defines-the-
 * composer contract, machine-checked. Returns {ok, missing[], html}.
 * @param {any} a
 * @returns {{ ok: boolean, id: string, missing: string[], html: string }}
 */
export function proveComposer(a) {
  const html = composerMarkup(a);
  const missing = [];
  for (const c of resolveControls(a)) {
    // Each control must appear with its type; controls that drive a field must
    // also expose that field via data-drives.
    const typeOk = html.includes(`data-control="${c.type}"`);
    const drivesOk = !c.drives || html.includes(`data-drives="${c.drives}"`);
    if (!typeOk || !drivesOk) missing.push(c.id || c.type);
  }
  return { ok: missing.length === 0, id: a?.id || "", missing, html };
}

/** @param {any} reg @param {string} id @returns {string} */
export function renderAgentShow(reg, id) {
  const a = findAgent(reg, id);
  if (!a) return `unknown agent: ${id}`;
  const q = resolveQuota(a);
  const theme = resolveTheme(a);
  const ex = resolveExamples(a);
  const cap = resolveCapability(a);
  const lines = [
    `${a.id} — ${a.name}  (${a.platform}-tier)`,
    a.tagline ? `  ${a.tagline}` : "",
    `  derives-from: ${a.derivesFrom || "(baseplate)"}`,
    `  mode: ${a.mode || "normal"}`,
    "  controls:",
    ...resolveControls(a).map((c) => `    - ${c.id} (${c.type})${c.drives ? ` → drives \`${c.drives}\`` : ""}`),
    "  capability:",
    `    answer phase: ${cap.answerPhase}${cap.requires.length ? `   requires: ${cap.requires.join(", ")}` : ""}`,
    `    prompts: ${resolvePromptSet(a)}${cap.prompts ? "" : " (its phase's default)"}`,
    `    tools: ${cap.tools.length ? `${cap.tools.join(", ")} (fallback: ${cap.toolFallback})` : "(none)"}`,
    `    context: ${cap.context.length ? cap.context.join(", ") : "(none)"}`,
    `    search: web ${cap.search.web ? "on" : "off"}, aux sources ${cap.search.auxSources ? "on" : "off"}${cap.search.maxQueries != null ? `, max ${cap.search.maxQueries} queries` : ""}`,
    `    routing: plan on ${cap.routing.planModel}, answer on ${cap.routing.answerModel}`,
    cap.gates.length ? `    gates: ${cap.gates.map((/** @type {any} */ g) => `${g.id} [${(g.langs || []).join("+")}]`).join(", ")}` : "",
    Object.keys(cap.bounds).length ? `    bounds: ${Object.entries(cap.bounds).map(([k, v]) => `${k}=${v}`).join("  ")}` : "",
    `    emits: ${cap.emits.join(", ")}`,
    cap.team ? `    team: ${(cap.team.kinds || []).join(", ")}${cap.team.allowCustom ? " (+custom)" : ""} — max ${cap.team.maxAgents} agents in ${cap.team.maxWaves} waves` : "",
    `  intro: ${a.intro?.kind || "(none)"}   loading: ${a.loading?.kind || "(none)"}`,
    `  theme: ${Object.entries(theme).map(([k, v]) => `${k}=${v}`).join("  ")}`,
    `  quota (share link): ${q.requests} req / ${q.window}${q.credits != null ? `, ${q.credits} credits` : ""}`,
    ex.seed.length ? `  examples:\n${ex.seed.map((s) => `    · ${s}`).join("\n")}` : "  examples: (generatable)",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
