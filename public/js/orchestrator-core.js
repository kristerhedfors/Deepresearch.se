// @ts-check
// Orchestrator — the pure core of the Orchestrator chat mode: running SUB-AGENTS
// in the background of one request and showing the workflow they perform. Same
// convention as sdk-core.js / agent-spec-core.js / bash-core.js: it lives under
// public/ because the browser can only import served modules while the Worker
// bundler imports from any repo path; src/orchestrator.js is the thin server
// façade. I/O-free and Node-tested (orchestrator-core.test.js).
//
// The mode upholds invariant 1 (deterministic orchestration, NO function
// calling): a JSON-mode PLAN phase on the fixed DEFAULT_MODEL turns the user's
// request into a small workflow — a validated DAG of sub-agent nodes — and the
// Worker executes it deterministically in parallel waves. No model ever decides
// control flow mid-run; the plan is data, the executor is code. Each sub-agent
// is one bounded, fail-soft sub-run (invariant 2: a failed node degrades to a
// note in the synthesis input, never a broken request).

// ---- the closed sub-agent vocabulary -----------------------------------------
//
// A sub-agent KIND names which bounded sub-run the executor performs for a
// node. The vocabulary is CLOSED (like the AgentSpec control types): the plan
// model may only use these kinds, so the executor and the workflow renderer
// know every shape. `custom` is the escape hatch — a persona + instructions
// node for task types the fixed kinds don't cover.

/** @typedef {"deep_research"|"introspection"|"swarm"|"custom"} AgentKind */

/**
 * Kind → what the executor runs and what the plan prompt / viz legend say.
 * `needsSource` marks kinds that only work when the introspection snapshot is
 * available; `needsSwarm` marks kinds that need the caller's browser to be able
 * to host on-device models. Either requirement unmet downgrades the node to
 * `custom` (fail-soft) rather than dropping it.
 */
export const AGENT_KINDS = {
  deep_research: {
    label: "Deep Research",
    desc: "researches its task with live web searches, then writes a sourced brief",
    needsSource: false,
    needsSwarm: false,
  },
  introspection: {
    label: "Introspection",
    desc: "answers its task from this site's own deployed source code and docs",
    needsSource: true,
    needsSwarm: false,
  },
  swarm: {
    label: "Local swarm",
    desc:
      "answers its task by SWARM REASONING: many tiny models run at once in the user's own browser, " +
      "each drafting an answer, reviewing a peer's, and converging on a consensus with a measured agreement score. " +
      "Best for judgement calls, brainstorming, weighing options and sanity checks — never for facts that need lookups, " +
      "and it runs entirely on the user's device (nothing about it is sent anywhere)",
    needsSource: false,
    needsSwarm: true,
  },
  custom: {
    label: "Custom",
    desc: "a fully customized specialist: a persona plus instructions, no external lookups",
    needsSource: false,
    needsSwarm: false,
  },
};

// ---- swarm bounds (the client-hosted kind) -----------------------------------
//
// The member count a plan may request. The real ceiling is the DEVICE's (see
// swarm-core.js planSwarmCapacity — members queue over a small worker pool), so
// this cap only keeps a runaway plan from asking for a hundred.
export const MAX_SWARM_MEMBERS = 12;
export const MAX_SWARM_ROUNDS = 3;
export const DEFAULT_SWARM_MEMBERS = 4;
export const DEFAULT_SWARM_ROUNDS = 2;

/** @type {AgentKind[]} */
export const AGENT_KIND_IDS = /** @type {AgentKind[]} */ (Object.keys(AGENT_KINDS));

/** Node lifecycle states the executor reports and the viz renders. */
export const NODE_STATES = ["pending", "running", "done", "failed", "skipped"];

// ---- bounds ------------------------------------------------------------------
//
// The workflow is deliberately SMALL: this is one chat request, not a job
// queue. Caps keep the plan phase honest and the wall-clock bounded.

export const MAX_AGENTS = 6;
export const MAX_WAVES = 3;
export const MAX_TASK_CHARS = 600;
export const MAX_RESULT_CHARS = 6000; // per-node result carried into synthesis
export const MAX_NODE_QUERIES = 2; // web searches ONE deep_research node may run
export const MAX_ORCH_SEARCHES = 6; // web searches the whole workflow may run
// How much of a node's REAL prompt rides to the client for the workflow
// inspector (the "look inside this node" popover). The assembled prompt can be
// tens of KB — upstream briefs plus a source digest — and this one is both a
// wire cost and PERSISTED state (it lands in the workflow embed's statuses map
// and is replayed with the conversation), so only the head travels: the
// persona, the task, the user request. That is the part that answers "what is
// this node working on"; the grounding below it is already visible as sources.
export const MAX_PROMPT_PREVIEW = 1500;

// ---- validation --------------------------------------------------------------

/**
 * Structural validation of one workflow plan. Returns problem strings — empty
 * means valid. Never throws (the schema.js convention): a bad plan is a
 * reported problem the caller degrades on, not an exception in the pipeline.
 * @param {any} plan
 * @returns {string[]}
 */
export function validateWorkflow(plan) {
  const problems = [];
  if (!plan || typeof plan !== "object") return ["plan is not an object"];
  if (!Array.isArray(plan.agents) || !plan.agents.length) return ["plan has no agents array"];
  if (plan.agents.length > MAX_AGENTS) problems.push(`too many agents (${plan.agents.length} > ${MAX_AGENTS})`);
  const ids = new Set();
  for (const a of plan.agents) {
    if (!a || typeof a !== "object") { problems.push("an agent is not an object"); continue; }
    const at = (/** @type {string} */ msg) => `${a.id || "(no id)"}: ${msg}`;
    if (!a.id || typeof a.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(a.id)) problems.push(at("id must be a lowercase slug"));
    if (ids.has(a.id)) problems.push(at("duplicate agent id"));
    ids.add(a.id);
    if (!AGENT_KIND_IDS.includes(a.kind)) problems.push(at(`unknown kind "${a.kind}"`));
    if (!a.task || typeof a.task !== "string") problems.push(at("task is required"));
    if (a.deps != null && !Array.isArray(a.deps)) problems.push(at("deps must be an array"));
    // A swarm node runs in the USER'S BROWSER before the server executes the
    // rest of the workflow (src/orchestrator.js), so it can never read another
    // node's result — it is a first-wave node by construction.
    if (a.kind === "swarm" && Array.isArray(a.deps) && a.deps.length) problems.push(at("a swarm agent cannot depend on other agents"));
    for (const d of Array.isArray(a.deps) ? a.deps : []) {
      if (typeof d !== "string") problems.push(at("deps must be agent ids"));
    }
  }
  // At most ONE swarm node: every swarm node spawns in-browser model
  // instances, so a plan with several is a memory multiplier, not a bigger
  // team (normalizeWorkflow downgrades the extras).
  const swarms = plan.agents.filter((/** @type {any} */ a) => a?.kind === "swarm").length;
  if (swarms > 1) problems.push(`at most one swarm agent per plan (${swarms})`);
  // Unknown deps and cycles are validated on the resolved graph:
  const waves = workflowWaves(plan);
  if (waves.unresolved.length) problems.push(`dependency cycle or unknown dep: ${waves.unresolved.join(", ")}`);
  if (waves.waves.length > MAX_WAVES) problems.push(`too many sequential waves (${waves.waves.length} > ${MAX_WAVES})`);
  return problems;
}

// ---- normalization -----------------------------------------------------------

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} dflt @returns {number} */
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** @param {unknown} s @returns {string} */
function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24);
}

/**
 * Coerce a model-produced plan into a valid one — the never-give-up sibling of
 * validateWorkflow, used on the plan phase's JSON output. Slugifies ids, mints
 * missing ones, maps unknown kinds to `custom`, downgrades source-needing
 * kinds when no snapshot is available, truncates tasks, drops unknown deps,
 * caps the agent count, and breaks cycles by dropping the offending deps.
 * Returns null only when nothing salvageable remains (no agent with a task).
 * @param {any} raw
 * @param {{ hasSource?: boolean, hasSwarm?: boolean }} [opts]
 * @returns {{ title: string, agents: Array<{id:string,kind:AgentKind,name:string,task:string,persona:string,queries:string[],deps:string[],swarmSize?:number,rounds?:number}> } | null}
 */
export function normalizeWorkflow(raw, opts = {}) {
  const list = Array.isArray(raw?.agents) ? raw.agents : Array.isArray(raw) ? raw : [];
  /** @type {any[]} */
  const agents = [];
  const ids = new Set();
  for (const a of list) {
    if (agents.length >= MAX_AGENTS) break;
    if (!a || typeof a !== "object") continue;
    const task = typeof a.task === "string" ? a.task.trim().slice(0, MAX_TASK_CHARS) : "";
    if (!task) continue;
    let kind = AGENT_KIND_IDS.includes(a.kind) ? a.kind : "custom";
    if (AGENT_KINDS[/** @type {AgentKind} */ (kind)].needsSource && !opts.hasSource) kind = "custom";
    // No device to host the swarm (knob off, no cached weights, or an older
    // client that never announced the capability): the node still runs — as an
    // ordinary specialist on the answer model.
    if (AGENT_KINDS[/** @type {AgentKind} */ (kind)].needsSwarm && !opts.hasSwarm) kind = "custom";
    // AT MOST ONE swarm node per plan. The plan prompt says so, but a prompt is
    // not a bound: a model that returned three swarm nodes used to get three
    // sets of in-browser model instances, one after another, each paying its
    // own compile — the single most expensive thing this app allocates,
    // multiplied by a number no one checked (feedback #26: two Safari tab
    // crashes). The second and later swarm nodes run as ordinary specialists.
    if (kind === "swarm" && agents.some((/** @type {any} */ x) => x.kind === "swarm")) kind = "custom";
    let id = slugify(a.id || a.name);
    if (!id) id = `agent-${agents.length + 1}`;
    while (ids.has(id)) id += "x";
    ids.add(id);
    // Search queries are PLANNED up front (deep_research nodes only), so the
    // executor never needs a per-node model call to decide what to search —
    // the whole workflow stays one deterministic plan.
    const queries = kind === "deep_research" && Array.isArray(a.queries)
      ? a.queries
          .map((/** @type {any} */ q) => (typeof q === "string" ? q.trim().slice(0, 120) : ""))
          .filter(Boolean)
          .slice(0, MAX_NODE_QUERIES)
      : [];
    /** @type {any} */
    const node = {
      id,
      kind: /** @type {AgentKind} */ (kind),
      name: typeof a.name === "string" && a.name.trim() ? a.name.trim().slice(0, 60) : AGENT_KINDS[/** @type {AgentKind} */ (kind)].label,
      task,
      persona: typeof a.persona === "string" ? a.persona.trim().slice(0, MAX_TASK_CHARS) : "",
      queries,
      // Swarm nodes are first-wave by construction (validateWorkflow explains
      // why): the browser runs them before the request reaches the server, so
      // any dependency the plan invented is dropped here rather than silently
      // producing a node that reads an empty upstream.
      deps: kind === "swarm" || !Array.isArray(a.deps) ? [] : a.deps.map((/** @type {any} */ d) => slugify(d)).filter(Boolean),
    };
    if (kind === "swarm") {
      node.swarmSize = clampInt(a.swarmSize ?? a.members ?? a.size, 2, MAX_SWARM_MEMBERS, DEFAULT_SWARM_MEMBERS);
      node.rounds = clampInt(a.rounds, 1, MAX_SWARM_ROUNDS, DEFAULT_SWARM_ROUNDS);
    }
    agents.push(node);
  }
  if (!agents.length) return null;
  // Drop deps that don't name a kept agent, and self-deps.
  for (const a of agents) a.deps = [...new Set(a.deps)].filter((d) => d !== a.id && ids.has(d));
  // Break cycles: peel resolvable agents wave by wave; any remainder is cyclic —
  // clear those agents' deps so they run in the first wave instead of never.
  const { unresolved } = workflowWaves({ agents });
  for (const a of agents) if (unresolved.includes(a.id)) a.deps = [];
  const plan = { title: typeof raw?.title === "string" ? raw.title.trim().slice(0, 120) : "", agents };
  // Deep wave chains beyond MAX_WAVES flatten: agents past the cap lose deps.
  const waves = workflowWaves(plan).waves;
  if (waves.length > MAX_WAVES) {
    const allowed = new Set(waves.slice(0, MAX_WAVES - 1).flat());
    for (const a of plan.agents) {
      if (!allowed.has(a.id)) a.deps = a.deps.filter((/** @type {string} */ d) => allowed.has(d));
    }
  }
  return plan;
}

// ---- wave resolution ---------------------------------------------------------

/**
 * Resolve a plan's dependency graph into parallel WAVES: wave N holds every
 * agent whose deps are all in earlier waves. Deterministic (input order kept
 * within a wave). Agents left over after no progress can be made (cycle or
 * unknown dep) are returned in `unresolved`.
 * @param {any} plan
 * @returns {{ waves: string[][], unresolved: string[] }}
 */
export function workflowWaves(plan) {
  const agents = Array.isArray(plan?.agents) ? plan.agents.filter((/** @type {any} */ a) => a && a.id) : [];
  const placed = new Set();
  const waves = [];
  let remaining = agents;
  while (remaining.length) {
    const wave = remaining.filter((/** @type {any} */ a) =>
      (Array.isArray(a.deps) ? a.deps : []).every((/** @type {any} */ d) => placed.has(d)));
    if (!wave.length) break; // cycle or dep on an unknown id — no progress possible
    for (const a of wave) placed.add(a.id);
    waves.push(wave.map((/** @type {any} */ a) => a.id));
    remaining = remaining.filter((/** @type {any} */ a) => !placed.has(a.id));
  }
  return { waves, unresolved: remaining.map((/** @type {any} */ a) => a.id) };
}

/** @param {any} plan @param {string} id @returns {any | null} */
export function findWorkflowAgent(plan, id) {
  return (plan?.agents || []).find((/** @type {any} */ a) => a && a.id === id) || null;
}

// ---- the plan-phase prompt (JSON mode, DEFAULT_MODEL — invariant 3) ----------

/**
 * The planning instruction the fixed JSON model gets. Answer-language parity
 * (invariant 6's spirit): names and tasks follow the user's language, so a
 * Swedish request gets Swedish sub-agent names in the workflow view.
 * @param {{ message: string, hasSource?: boolean, hasSwarm?: boolean, swarmModel?: string }} args
 * @returns {string}
 */
export function orchestratorPlanPrompt(args) {
  const kinds = AGENT_KIND_IDS
    .filter((k) => (!AGENT_KINDS[k].needsSource || args.hasSource) && (!AGENT_KINDS[k].needsSwarm || args.hasSwarm))
    .map((k) => `- "${k}": ${AGENT_KINDS[k].desc}`)
    .join("\n");
  const swarmRule = args.hasSwarm
    ? `\n- A "swarm" agent also gets "swarmSize" (${DEFAULT_SWARM_MEMBERS}-${MAX_SWARM_MEMBERS} members — more members for open-ended judgement calls, fewer for narrow ones) and "rounds" (1-${MAX_SWARM_ROUNDS}). It runs on ${args.swarmModel || "a tiny on-device model"} in the user's browser, so it is CHEAP and PRIVATE but weak on facts: give it reasoning, opinion-weighing, option-ranking or brainstorming tasks, never lookups. It runs before the other agents and CANNOT have "deps" (other agents may depend on IT). At most one swarm agent per plan.`
    : "";
  return [
    "You are the ORCHESTRATOR planner. Decompose the user's request into a small team of sub-agents that work in parallel where possible.",
    `Available sub-agent kinds:\n${kinds}`,
    `Rules:
- 2 to ${MAX_AGENTS} agents; prefer the fewest that genuinely divide the work.
- Each agent gets ONE focused task (max ~2 sentences). A "custom" agent also gets a one-line persona.
- "deps" lists agent ids whose results the agent needs; agents without deps run concurrently. At most ${MAX_WAVES} sequential stages; a final reviewer/critic depending on the others is often worth one stage.
- A "deep_research" agent also gets "queries": up to ${MAX_NODE_QUERIES} web-search queries covering its task.${swarmRule}
- GROUND COMPARISONS: when the request compares candidates against, or judges something relative to, a REFERENCE OBJECT (a named product, project, company — above all this site, deepresearch.se, itself), the plan MUST include a first-wave grounding agent whose sole task is to establish what that object actually is and does, and every comparing/judging agent must list it in "deps". When the reference object is this site and the "introspection" kind is available, the grounding agent MUST be kind "introspection" — it reads the site's real source instead of guessing.
- Write names, tasks and queries in the user's language (svara på svenska om användaren skriver svenska).`,
    `Return ONLY JSON: {"title": "...", "agents": [{"id": "slug", "kind": "...", "name": "...", "task": "...", "persona": "...", "queries": ["..."]${args.hasSwarm ? ', "swarmSize": 4, "rounds": 2' : ""}, "deps": ["..."]}]}`,
    `User request:\n${args.message}`,
  ].join("\n\n");
}

// ---- sub-agent prompts -------------------------------------------------------

/**
 * The instruction a single sub-agent runs with: its persona (custom kinds),
 * its task, and the results of the agents it depends on. Pure string assembly;
 * the executor supplies kind-specific context (search results, source blocks)
 * around it.
 * @param {{ name: string, kind: AgentKind, task: string, persona?: string }} agent
 * @param {Array<{ id: string, name: string, text: string }>} upstream results of dep agents
 * @param {{ userRequest?: string }} [opts] the original ask, so specialists keep the real goal in view
 * @returns {string}
 */
export function agentTaskPrompt(agent, upstream = [], opts = {}) {
  const parts = [
    `You are "${agent.name}", one sub-agent in an orchestrated team.${agent.persona ? ` Persona: ${agent.persona}` : ""}`,
    `Your task: ${agent.task}`,
  ];
  if (opts.userRequest) parts.push(`The team is answering this user request:\n${String(opts.userRequest).slice(0, 2000)}`);
  if (upstream.length) {
    parts.push(`Results from the sub-agents you depend on:\n${upstream
      .map((u) => `### ${u.name} (${u.id})\n${clampResult(u.text)}`)
      .join("\n\n")}`);
  }
  parts.push("Write a focused brief that answers your task alone — concise, factual, in the user's language. Another phase merges the team's briefs; do not address the user or summarize teammates' work beyond your task.");
  return parts.join("\n\n");
}

/** Clamp one node result for prompt assembly. @param {unknown} text @returns {string} */
export function clampResult(text) {
  const s = String(text ?? "");
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + "\n[…truncated]" : s;
}

/**
 * The synthesis input block: every node's outcome, in wave order, ready to sit
 * in front of the final streamed answer. Failed nodes appear as honest notes
 * (fail-soft: the synthesis knows what's missing rather than silently thin).
 * @param {any} plan
 * @param {Record<string, { status: string, text?: string, note?: string }>} results by agent id
 * @returns {string}
 */
export function mergeAgentResults(plan, results) {
  const { waves } = workflowWaves(plan);
  const lines = [];
  for (const wave of waves) {
    for (const id of wave) {
      const a = findWorkflowAgent(plan, id);
      const r = results[id];
      if (!a) continue;
      if (r && r.status === "done" && r.text) {
        lines.push(`### ${a.name} (${AGENT_KINDS[/** @type {AgentKind} */ (a.kind)]?.label || a.kind})\nTask: ${a.task}\n\n${clampResult(r.text)}`);
      } else {
        lines.push(`### ${a.name} — ${r?.status || "skipped"}${r?.note ? ` (${r.note})` : ""}\nTask: ${a.task}\n(No result — account for this gap honestly.)`);
      }
    }
  }
  return lines.join("\n\n");
}

// ---- SSE event shapes --------------------------------------------------------
//
// The Orchestrator's additions to the /api/chat status vocabulary (sse-protocol
// skill; all forward-compatible — old clients ignore unknown types):
//   workflow     — the resolved plan, once, before execution
//   agent_update — one node's lifecycle change (running/done/failed/skipped)
// Built here so server and client agree on one shape and the test suite pins it.

/**
 * @param {any} plan
 * @returns {{ type: "workflow", title: string, agents: Array<{id:string,kind:string,name:string,task:string,persona?:string,queries?:string[],deps:string[],swarmSize?:number,rounds?:number}>, waves: string[][] }}
 */
export function workflowEvent(plan) {
  return {
    type: "workflow",
    title: plan?.title || "",
    agents: (plan?.agents || []).map((/** @type {any} */ a) => {
      const node = { id: a.id, kind: a.kind, name: a.name, task: a.task, deps: a.deps || [] };
      // The rest of what the plan decided for this node. It costs a few hundred
      // bytes and it is what the workflow INSPECTOR shows when the user opens a
      // node: the specialist's persona and the exact searches it will run. Both
      // are already clamped by normalizeWorkflow. Omitted when empty so a plain
      // deep_research team's event is unchanged.
      if (a.persona) /** @type {any} */ (node).persona = a.persona;
      if (a.queries?.length) /** @type {any} */ (node).queries = a.queries;
      // The swarm's shape rides in the plan event so the graph can draw the
      // member dots the moment the team appears — before the first member has
      // reported anything.
      if (a.kind === "swarm") {
        /** @type {any} */ (node).swarmSize = a.swarmSize || DEFAULT_SWARM_MEMBERS;
        /** @type {any} */ (node).rounds = a.rounds || DEFAULT_SWARM_ROUNDS;
      }
      return node;
    }),
    waves: workflowWaves(plan).waves,
  };
}

/**
 * @param {string} id
 * @param {string} status one of NODE_STATES
 * @param {{ note?: string, duration_ms?: number, chars?: number, prompt?: string }} [extra]
 * @returns {{ type: "agent_update", id: string, status: string, note?: string, duration_ms?: number, chars?: number, prompt?: string, prompt_chars?: number }}
 */
export function agentUpdateEvent(id, status, extra = {}) {
  const ev = { type: /** @type {"agent_update"} */ ("agent_update"), id, status: NODE_STATES.includes(status) ? status : "running" };
  if (extra.note) /** @type {any} */ (ev).note = String(extra.note).slice(0, 200);
  if (Number.isFinite(extra.duration_ms)) /** @type {any} */ (ev).duration_ms = extra.duration_ms;
  if (Number.isFinite(extra.chars)) /** @type {any} */ (ev).chars = extra.chars;
  // The node's real prompt, head-clamped, with the FULL length alongside so the
  // inspector can say honestly how much of it it is showing rather than
  // presenting a truncation as the whole instruction.
  if (extra.prompt) {
    const full = String(extra.prompt);
    /** @type {any} */ (ev).prompt = full.slice(0, MAX_PROMPT_PREVIEW);
    /** @type {any} */ (ev).prompt_chars = full.length;
  }
  return ev;
}
