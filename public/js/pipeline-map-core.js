// @ts-check
// The PIPELINE MAP — introspection mode's live diagram of the site's own
// request path, from the composer to the streamed answer, with the nodes the
// CURRENT chat actually passed through lit up and the nodes the agent LOOPS on
// counting their rounds (feedback #34, 2026-07-26: "have this under an
// expandable in left sidebar of introspection agent, exactly as this
// visualisation with nodes in the reply here").
//
// The graph is the same one an introspection answer draws in Mermaid when asked
// how a message is interpreted — declared here as DATA so the sidebar can light
// it live instead of the user re-asking for a fresh diagram each time. It is a
// map of SHIPPED control flow (src/index.js → src/chat.js → src/pipeline.js
// plus the client half in public/js/stream.js), so a pipeline change is a table
// edit here, not a new drawing.
//
// Pure-core convention (workflow-viz.js / space-core.js): the node table, the
// layout math, the SSE-event → node mapping and the SVG string builder are all
// I/O-free and Node-tested (pipeline-map-core.test.js). Every DOM touch lives
// in pipeline-map.js.
//
// Honesty rule for this table: a node exists only where the pipeline emits a
// signal the client can actually observe (a step/search/done status event, or
// the fact that the stream opened at all). Nothing here is inferred from the
// answer text, and nothing lights up on a guess — an unmapped event is ignored,
// the SSE protocol's forward-compatibility rule (see the sse-protocol skill).

/**
 * @typedef {Object} PipelineNode
 * @property {string} id     stable node id (also the SVG data-node value)
 * @property {string} label  the short name drawn on the node
 * @property {string} sub    the second line — what the step actually does
 * @property {string} group  browser | worker | pipeline | research | answer
 * @property {"step"|"decision"|"terminal"|"loop"} kind  drawing/semantics
 * @property {number} layer  vertical rank (top-down flow)
 * @property {number} lane   0 = the main spine, 1 = a branch/terminal column
 * @property {string} [note] extra tooltip detail
 */

/**
 * Node box geometry. Sized so two lanes fit the left drawer's real content box:
 * the panel is min(320px, 86vw), less its 1rem padding and the expandable's own
 * — 267px on a 320px drawer, MEASURED rather than derived (a fit test pins it).
 * Narrower phones scale the whole SVG down instead of scrolling sideways
 * (`.pipemap-svg { max-width: 100%; height: auto }`).
 */
export const NODE_W = 113;
export const NODE_H = 38;
const ROW_GAP = 14;
const LANE_GAP = 12;
const PAD = 10;

/**
 * The pipeline, top-down. `layer` is the vertical rank and `lane` the column,
 * declared rather than solved for: the flow has terminal branches (a 400, a
 * canned feedback reply, a mode executor) that a generic topological layout
 * would spread across the width the drawer does not have.
 * @type {PipelineNode[]}
 */
export const PIPELINE_NODES = [
  // ---- this browser -------------------------------------------------------
  { id: "compose", label: "Composer", sub: "your message", group: "browser", kind: "step", layer: 0, lane: 0,
    note: "buildOutgoingUserContent weaves in attachments, project context and RAG excerpts." },
  { id: "payload", label: "Payload", sub: "model · depth", group: "browser", kind: "step", layer: 1, lane: 0,
    note: "buildChatPayload packs the conversation, the chosen model, the depth budget and every knob." },
  { id: "post", label: "Request sent", sub: "to /api/chat", group: "browser", kind: "step", layer: 2, lane: 0 },
  // ---- the Worker's front door -------------------------------------------
  { id: "route", label: "Route", sub: "the Worker", group: "worker", kind: "step", layer: 3, lane: 0 },
  { id: "checks", label: "Validate", sub: "shape · limits", group: "worker", kind: "step", layer: 4, lane: 0,
    note: "Roles, message count and per-message size are checked before anything else runs." },
  { id: "rejected", label: "Rejected", sub: "invalid request", group: "worker", kind: "terminal", layer: 4, lane: 1 },
  { id: "quota", label: "Quota + slot", sub: "per-account", group: "worker", kind: "step", layer: 5, lane: 0 },
  { id: "limited", label: "Quota hit", sub: "nothing runs", group: "worker", kind: "terminal", layer: 5, lane: 1 },
  { id: "stream", label: "Streaming", sub: "live events", group: "worker", kind: "step", layer: 6, lane: 0 },
  // ---- the pipeline ------------------------------------------------------
  { id: "feedback", label: "Feedback?", sub: "checked first", group: "pipeline", kind: "decision", layer: 7, lane: 0,
    note: "A message that opens with \"feedback\" (or /feedback) goes to the developers instead of being researched." },
  { id: "fbreply", label: "Canned reply", sub: "no model call", group: "pipeline", kind: "terminal", layer: 7, lane: 1 },
  { id: "enrich", label: "Enrichments", sub: "source · ext", group: "pipeline", kind: "step", layer: 8, lane: 0,
    note: "Optional context added before any model call — the site's own source in introspection, plus whichever integrations are enabled." },
  { id: "mode", label: "Own agent?", sub: "Studio · Orchestrator", group: "pipeline", kind: "decision", layer: 9, lane: 0 },
  { id: "executor", label: "Agent runs", sub: "its own executor", group: "pipeline", kind: "terminal", layer: 9, lane: 1 },
  { id: "source", label: "Source loop", sub: "introspection", group: "pipeline", kind: "loop", layer: 10, lane: 1,
    note: "Reads the deployed source file by file until the question is answered — this is the path an introspection question takes." },
  { id: "triage", label: "Triage", sub: "fixed JSON model", group: "pipeline", kind: "decision", layer: 11, lane: 0,
    note: "Always the same reliable planning model, never your chosen answer model." },
  { id: "direct", label: "Direct reply", sub: "no research", group: "answer", kind: "terminal", layer: 11, lane: 1 },
  { id: "clarify", label: "Clarify", sub: "asks you back", group: "answer", kind: "terminal", layer: 12, lane: 1 },
  // ---- research ----------------------------------------------------------
  { id: "search", label: "Search wave", sub: "web · sources", group: "research", kind: "loop", layer: 12, lane: 0 },
  { id: "digest", label: "Notes digest", sub: "budget-gated", group: "research", kind: "step", layer: 13, lane: 0 },
  { id: "fanout", label: "Subquestions", sub: "budget-gated", group: "research", kind: "step", layer: 14, lane: 0 },
  { id: "gap", label: "Gap checks", sub: "until covered", group: "research", kind: "loop", layer: 15, lane: 0,
    note: "Each round asks what is still missing and searches again — the loop that keeps lighting up." },
  { id: "contents", label: "Full pages", sub: "top sources", group: "research", kind: "step", layer: 16, lane: 0 },
  // ---- the two ENGINES the research phase routes between (2026-08-29) ------
  // src/pipeline.js runResearchPhase hands the turn to one of these; the nodes
  // above are the deterministic flow they replaced and stay drawn until it is
  // retired, so a run on either engine is legible on the same map. Both sit in
  // the branch column: they are alternatives to the spine, not steps along it.
  //
  // Two of the standard graph's four nodes get NO box of their own, and that is
  // this table's honesty rule rather than an omission. Its generate_queries
  // node emits the `plan` step id and is the same thing `Triage` already draws
  // — one JSON call on the fixed model that decides the angles — and its
  // finalize node IS runSynthesis followed by runValidation, which are the two
  // boxes below. A duplicate box for either would be a box no signal can ever
  // light, which reads as "this never happens" (pinned by the "every node can
  // be lit by some observable signal" test).
  { id: "loop", label: "Research loop", sub: "the model's own", group: "research", kind: "loop", layer: 13, lane: 1,
    note: "The answer model picks its own tools and their order, one step per call, until it stops or a bound stops it — then the report is written by the same synthesis step every other run uses." },
  { id: "reflect", label: "Reflect", sub: "states the gap", group: "research", kind: "loop", layer: 14, lane: 1,
    note: "The standard graph's loop edge: each round names what is still missing, in words, and searches again for it." },
  // ---- the answer --------------------------------------------------------
  { id: "synth", label: "Synthesis", sub: "streamed answer", group: "answer", kind: "step", layer: 17, lane: 0 },
  { id: "validate", label: "Validation", sub: "fact-check", group: "answer", kind: "step", layer: 18, lane: 0 },
  { id: "done", label: "Done", sub: "stats + end", group: "answer", kind: "step", layer: 19, lane: 0 },
];

/**
 * The edges. `back` marks a loop edge (dashed, bowing out to the right of the
 * spine); `weak` marks a branch off the spine (dashed, low contrast) so the main
 * flow stays readable in a 320px drawer; `ends` marks the "…and that finishes the
 * answer" edge from a terminal to `done`.
 *
 * An `ends` edge is DECLARED but not DRAWN. Every terminal rejoins at `done`
 * twelve rows below, and five near-parallel curves spanning that distance cut
 * straight through the branch column — measurably worse than the information
 * they add, since a terminal is already drawn dashed and says so in its tooltip.
 * They stay in the table because they are true, and because the reachability and
 * taken-path logic reads them.
 * @type {Array<{from:string,to:string,label?:string,back?:boolean,weak?:boolean,ends?:boolean}>}
 */
export const PIPELINE_EDGES = [
  { from: "compose", to: "payload" },
  { from: "payload", to: "post" },
  { from: "post", to: "route" },
  { from: "route", to: "checks" },
  { from: "checks", to: "rejected", weak: true },
  { from: "checks", to: "quota" },
  { from: "quota", to: "limited", weak: true },
  { from: "quota", to: "stream" },
  { from: "stream", to: "feedback" },
  { from: "feedback", to: "fbreply", label: "yes", weak: true },
  { from: "feedback", to: "enrich", label: "no" },
  { from: "enrich", to: "mode" },
  { from: "mode", to: "executor", label: "agent", weak: true },
  { from: "mode", to: "source", label: "own source", weak: true },
  { from: "mode", to: "triage" },
  { from: "triage", to: "direct", label: "direct", weak: true },
  { from: "triage", to: "clarify", label: "clarify", weak: true },
  { from: "triage", to: "search", label: "research" },
  // The engine router. Both edges leave `triage` because both engines run in
  // its place — the loop instead of a plan, the reflect round instead of a gap
  // check — and both rejoin at the writer, which neither of them replaces.
  { from: "triage", to: "loop", label: "model-driven", weak: true },
  { from: "loop", to: "loop", back: true },
  { from: "loop", to: "synth", weak: true },
  { from: "search", to: "reflect", label: "reflect", weak: true },
  // No label: it is a CROSS-LANE edge, so a label would move to the target
  // node's tooltip (branchCondition) and read there as a second condition on
  // reaching the search wave, which it is not — it is the same wave, again. The
  // round count the node already draws (×N) is the honest version of it.
  { from: "reflect", to: "search", back: true },
  { from: "search", to: "digest" },
  { from: "digest", to: "fanout" },
  { from: "fanout", to: "gap" },
  { from: "gap", to: "search", back: true, label: "another wave" },
  { from: "gap", to: "contents" },
  { from: "contents", to: "synth" },
  { from: "synth", to: "validate" },
  { from: "validate", to: "done" },
  { from: "fbreply", to: "done", ends: true },
  { from: "executor", to: "done", ends: true },
  { from: "source", to: "done", ends: true },
  { from: "direct", to: "done", ends: true },
  { from: "clarify", to: "done", ends: true },
];

/** @type {Map<string, PipelineNode>} */
const NODE_BY_ID = new Map(PIPELINE_NODES.map((n) => [n.id, n]));

/**
 * IMPLIED UPSTREAM — the gates a node's own signal proves were already passed.
 *
 * Some steps run on every request and emit nothing of their own: the feedback
 * gate, the enrichment pass with an empty registry, the mode-executor dispatch.
 * Left to their own signals those nodes could NEVER light, which is worse than
 * leaving them out — a permanently dark box reads as "this never happens". They
 * are not guesses either: the pipeline reaches triage only by passing the
 * feedback gate, then the enrichments, then the dispatch, in that order
 * (`src/pipeline.js` runPipeline). Same class of inference as STREAM_OPEN_NODES —
 * what an observed event PROVES about the path behind it — and, like it, nothing
 * here is read out of an answer's text.
 *
 * Marked as reached, never counted as a round of their own; resolved
 * transitively, so each entry lists only its immediate gates.
 * @type {Record<string, string[]>}
 */
export const IMPLIED_UPSTREAM = {
  enrich: ["feedback"],
  fbreply: ["feedback"],
  mode: ["enrich"],
  executor: ["mode"],
  source: ["mode"],
  triage: ["mode"],
  direct: ["triage"],
  clarify: ["triage"],
  search: ["triage"],
  digest: ["search"],
  fanout: ["search"],
  gap: ["search"],
  contents: ["gap"],
  synth: ["search"],
  loop: ["mode"],
  reflect: ["search"],
};

/**
 * The transitive closure of IMPLIED_UPSTREAM for one node.
 * @param {string} id
 * @returns {string[]}
 */
export function impliedUpstream(id) {
  const out = [];
  const seen = new Set([id]);
  const queue = [...(IMPLIED_UPSTREAM[id] || [])];
  while (queue.length) {
    const next = /** @type {string} */ (queue.shift());
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(IMPLIED_UPSTREAM[next] || []));
  }
  return out;
}

/**
 * The nodes this browser has demonstrably done once a send starts. `post` is
 * deliberately NOT here: introspection's private route and an on-device model
 * answer browser-direct without ever calling /api/chat, and a map that claimed
 * otherwise would misreport the one thing this mode exists to show honestly.
 */
export const CLIENT_NODES = ["compose", "payload"];
/**
 * The nodes the FIRST event off the wire proves were passed: the request was
 * posted, routed, validated and admitted, or no stream would exist to carry it.
 */
export const STREAM_OPEN_NODES = ["post", "route", "checks", "quota", "stream"];

/**
 * Step id → node id. Ids matched by a PATTERN (a numbered loop round) are
 * handled in nodesForStatus; anything neither names falls back generically.
 *
 * The ENRICHMENT ids are listed one by one on purpose even though they all
 * reach the same node: `enrich` is where a run's pre-model context is added,
 * every entry of src/enrichment.js's registry emits its own descriptor id as a
 * step id, and the registry is open-ended by design (invariant 7 — adding an
 * integration touches no core file). Naming them keeps the fallback below a
 * genuine last resort rather than the enrichment pass's normal route.
 */
const STEP_NODES = {
  plan: "triage",
  introspect: "enrich",
  geocode: "enrich",
  shodan: "enrich",
  maps: "enrich",
  image_read: "enrich",
  owasp: "enrich",
  models: "enrich",
  aadr: "enrich",
  scholar: "enrich",
  scholar_profile: "enrich",
  person_research: "enrich",
  entity_research: "enrich",
  source: "source",
  bcont: "source",
  loop: "loop",
  digest: "digest",
  fanout: "fanout",
  contents: "contents",
  synth: "synth",
  failover: "synth",
  quiz: "synth",
  validate: "validate",
  outrospect: "executor",
};

/**
 * Step ids that are one ROUND of a loop node, as `<prefix><n>`.
 * @type {Array<[RegExp, string]>}
 */
const LOOP_STEP_PATTERNS = [
  [/^gap\d+$/, "gap"],
  [/^reflect\d+$/, "reflect"],
  // src/agentic.js loopStepId: `tool_<n>`, one pair per tool call. A NUMBER
  // rather than the tool's name, because a tool name is a service name here
  // (invariant 7) and the SSE vocabulary must not carry one.
  [/^tool_\d+$/, "loop"],
  [/^agent_/, "executor"],
];

/**
 * The node an unrecognised STEP id lights.
 *
 * The forward-compatibility rule (an unmapped event is ignored) still holds for
 * the event VOCABULARY — an event type this file does not know changes nothing.
 * A step id is different, and the difference is what this constant fixes: the
 * step ids between `mode` and `synth` all belong to whichever engine ran, and
 * engines are now pluggable. Ignoring an unknown one meant a future engine's
 * run drew a map that went dark for its entire research phase — which reads as
 * "nothing happened", the one thing a map built to be honest must not say.
 *
 * The research loop is the right generic home for it: it is the node whose
 * meaning is "the engine is working", it counts rounds, and it is where every
 * unmapped id actually comes from now that the enrichment ids above are named.
 */
const FALLBACK_STEP_NODE = "loop";

/**
 * Triage/route outcome (`route` on the `plan` step_done — src/pipeline.js) →
 * the node that outcome hands the answer to. Deterministic and language-free:
 * the alternative, sniffing the step's English label, would break the moment a
 * label is reworded.
 */
const ROUTE_NODES = {
  feedback: "fbreply",
  search_off: "direct",
  direct: "direct",
  clarify: "clarify",
};

/**
 * The node(s) one SSE status event touches.
 * @param {{type?:string,id?:string,round?:number,route?:string}} status
 * @returns {{enter: string[], exit: string[]}}
 */
export function nodesForStatus(status) {
  const none = { enter: [], exit: [] };
  const type = status?.type;
  if (!type) return none;
  if (type === "search_start" || type === "search_done") {
    // A wave in round 2+ IS the gap loop searching again, so both the wave and
    // One wave per search event pair, whichever round it belongs to — the wave
    // count IS the loop. The gap node is deliberately NOT lit from here: it
    // counts its own rounds off the `gap1…gapN` step ids, and lighting it from
    // both sources counted every round twice.
    return type === "search_start" ? { enter: ["search"], exit: [] } : { enter: [], exit: ["search"] };
  }
  if (type === "workflow" || type === "agent_update" || type === "swarm_update") {
    return { enter: ["executor"], exit: [] };
  }
  if (type === "done") return { enter: ["done"], exit: ["done"] };
  if (type !== "step_start" && type !== "step_done") return none;
  const id = String(status.id || "");
  if (!id) return none;
  const node =
    /** @type {Record<string,string>} */ (STEP_NODES)[id] ||
    LOOP_STEP_PATTERNS.find(([re]) => re.test(id))?.[1] ||
    FALLBACK_STEP_NODE;
  if (type === "step_start") return { enter: [node], exit: [] };
  // Finishing only LEAVES the node — the matching step_start already counted the
  // visit, and counting it again turned every ordinary start/done pair into two
  // rounds ("Enrichments ×2" on a run that enriched once). A step_done with no
  // start still lights its node, because leaving marks it visited.
  const routed = /** @type {Record<string,string>} */ (ROUTE_NODES)[String(status.route || "")];
  return routed ? { enter: [routed], exit: [node] } : { enter: [], exit: [node] };
}

/**
 * A fresh (empty) run. `visits` counts entries per node — that count is what
 * makes a loop visible; `active` holds the nodes running right now.
 * @returns {{visits: Record<string, number>, active: Record<string, boolean>, last: string, ticks: number}}
 */
export function emptyPipelineRun() {
  return { visits: {}, active: {}, last: "", ticks: 0 };
}

/** @typedef {ReturnType<typeof emptyPipelineRun>} PipelineRun */

/**
 * Mark nodes entered / left. Entering bumps the visit count (so re-entering a
 * loop node reads as another round) and makes it the run's newest node — what
 * the view scrolls to. `ticks` changes on every mutation so a renderer can tell
 * "same run, new state" without diffing.
 * @param {PipelineRun} run
 * @param {{enter?: string[], exit?: string[]}} moves
 * @returns {PipelineRun} the same run, mutated
 */
export function notePipelineMoves(run, moves) {
  let changed = false;
  /** Mark a node reached without counting it as a round of its own. */
  const settle = (/** @type {string} */ id) => {
    if (!NODE_BY_ID.has(id) || run.visits[id]) return;
    run.visits[id] = 1;
    changed = true;
  };
  for (const id of moves?.enter || []) {
    if (!NODE_BY_ID.has(id)) continue;
    run.visits[id] = (run.visits[id] || 0) + 1;
    run.active[id] = true;
    run.last = id;
    changed = true;
    // The gates this step's own signal proves were passed (implied upstream).
    for (const up of impliedUpstream(id)) settle(up);
  }
  for (const id of moves?.exit || []) {
    if (!NODE_BY_ID.has(id)) continue;
    settle(id); // a step_done with no matching start still lights its node
    for (const up of impliedUpstream(id)) settle(up);
    if (run.active[id]) {
      delete run.active[id];
      changed = true;
    }
  }
  if (changed) run.ticks += 1;
  return run;
}

/**
 * Apply one SSE status event. `done` also closes anything still marked active —
 * a streamed answer (direct reply, source loop) has no closing step of its own.
 * @param {PipelineRun} run
 * @param {{type?:string,id?:string,round?:number,route?:string}} status
 * @returns {PipelineRun}
 */
export function applyPipelineStatus(run, status) {
  const moves = nodesForStatus(status);
  if (status?.type === "done") moves.exit = [...Object.keys(run.active), "done"];
  return notePipelineMoves(run, moves);
}

/**
 * One node's drawing state: `active` (running now — the view blinks it),
 * `passed` (this chat went through it), `idle` (not taken this time).
 * @param {PipelineRun} run
 * @param {string} id
 * @returns {"active"|"passed"|"idle"}
 */
export function nodeState(run, id) {
  if (run?.active?.[id]) return "active";
  return run?.visits?.[id] ? "passed" : "idle";
}

// ---- layout (pure) ---------------------------------------------------------

/**
 * Place every node: one row per declared layer, one column per lane. Layers are
 * ranked (not multiplied by their number) so the table can leave gaps.
 * @param {PipelineNode[]} [nodes]
 * @param {typeof PIPELINE_EDGES} [edges]
 */
export function layoutPipelineMap(nodes = PIPELINE_NODES, edges = PIPELINE_EDGES) {
  const layers = [...new Set(nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const lanes = Math.max(1, ...nodes.map((n) => n.lane + 1));
  const rowOf = (/** @type {number} */ layer) => layers.indexOf(layer);
  const placed = nodes.map((n) => ({
    ...n,
    x: PAD + n.lane * (NODE_W + LANE_GAP),
    y: PAD + rowOf(n.layer) * (NODE_H + ROW_GAP),
  }));
  const byId = new Map(placed.map((n) => [n.id, n]));
  const width = PAD * 2 + lanes * NODE_W + (lanes - 1) * LANE_GAP;
  const height = PAD * 2 + layers.length * NODE_H + (layers.length - 1) * ROW_GAP;
  const routed = [];
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    // Four routings, so no edge ever crosses a box:
    //   straight — same lane, next row down: a plain drop, side to side.
    //   self     — a node that loops on ITSELF (the research loop's own edge):
    //              out of the right edge and straight back into it, a row's
    //              third of a bow. Without this case it fell through to the
    //              branch routing below, which drew it from the middle of the
    //              box back to its own left edge — a curve through the label.
    //   loop     — same lane, going back UP: leaves and arrives on the RIGHT
    //              edge and bows clear of the spine (routing it to the left edge
    //              sent the gap→search loop diagonally across three boxes).
    //   branch   — across lanes: leaves the near side, arrives at the near side.
    const self = a === b;
    const straight = !self && a.lane === b.lane && b.y > a.y;
    const loop = self || (a.lane === b.lane && b.y < a.y);
    routed.push({
      ...e,
      x1: straight ? a.x + NODE_W / 2 : loop ? a.x + NODE_W : a.x + (b.lane > a.lane ? NODE_W : NODE_W / 2),
      y1: straight ? a.y + NODE_H : self ? a.y + NODE_H / 3 : a.y + NODE_H / 2,
      x2: straight ? b.x + NODE_W / 2 : loop ? b.x + NODE_W : b.x + (b.lane < a.lane ? NODE_W : 0),
      y2: straight ? b.y : self ? b.y + (NODE_H * 2) / 3 : b.y + NODE_H / 2,
      straight,
      loop,
      self,
    });
  }
  return { width, height, nodes: placed, edges: routed };
}

// ---- SVG (pure string assembly, XSS-safe) ---------------------------------

/** @param {unknown} s */
function esc(s) {
  /** @type {Record<string,string>} */
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * The condition on the labelled cross-lane edge(s) into a node — the branch
 * label that has no room to be drawn beside a 12px lane gap, surfaced in the
 * node's tooltip so the declared label is never dead data.
 * @param {string} id
 * @param {typeof PIPELINE_EDGES} [edges]
 * @returns {string}
 */
export function branchCondition(id, edges = PIPELINE_EDGES) {
  return edges
    .filter((e) => e.to === id && e.label)
    .map((e) => e.label)
    .join(" / ");
}

/** The glyph in a node's corner. @param {"active"|"passed"|"idle"} state @param {string} kind */
export function nodeGlyph(state, kind) {
  if (state === "active") return kind === "loop" ? "↻" : "◐";
  if (state === "passed") return "✓";
  return kind === "decision" ? "?" : "○";
}

/**
 * The whole map as an SVG string. Classed, never inline-styled — app.css owns
 * the palette so the drawer's mode tint applies (and prefers-reduced-motion can
 * stop the blink).
 * @param {PipelineRun} [run]
 * @param {{ nodes?: PipelineNode[], edges?: typeof PIPELINE_EDGES }} [graph]
 * @returns {string}
 */
export function pipelineMapSvg(run = emptyPipelineRun(), graph = {}) {
  const { width, height, nodes, edges } = layoutPipelineMap(graph.nodes, graph.edges);
  const parts = [
    `<svg class="pipemap-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
      `role="img" aria-label="The request pipeline, with the steps this chat passed through marked">`,
  ];
  for (const e of edges) {
    if (e.ends) continue; // declared, deliberately not drawn (see PIPELINE_EDGES)
    const cls = `pmedge${e.back ? " pm-back" : ""}${e.weak ? " pm-weak" : ""}` +
      // An edge between two nodes this chat both visited is part of the taken
      // path, so it lights with them.
      (run?.visits?.[e.from] && run?.visits?.[e.to] ? " pm-taken" : "");
    const bow = e.loop ? 30 : 22;
    const d = e.straight
      ? `M ${e.x1} ${e.y1} L ${e.x2} ${e.y2}`
      : `M ${e.x1} ${e.y1} C ${e.x1 + bow} ${e.y1}, ${e.x2 + bow} ${e.y2}, ${e.x2} ${e.y2}`;
    parts.push(`<path class="${cls}" d="${d}" fill="none"/>`);
    // A label is drawn where there is empty space for it: on a STRAIGHT edge (the
    // row gap between two boxes) or on a LOOP edge (which bows out past the
    // spine, beside rows that have no branch beside them). A cross-lane label has
    // nowhere to sit — the lane gap is 12px — and landed on top of the very box
    // it pointed at; those read as "Reached when: …" in the target node's tooltip
    // instead (branchCondition).
    if (e.label && (e.straight || e.loop)) {
      const lx = e.straight ? e.x1 + 5 : Math.max(e.x1, e.x2) + 12;
      parts.push(
        `<text class="pmedgelabel" x="${lx}" y="${(e.y1 + e.y2) / 2 + 3}">${esc(e.label)}</text>`,
      );
    }
  }
  for (const n of nodes) {
    const st = nodeState(run, n.id);
    const visits = run?.visits?.[n.id] || 0;
    const when = branchCondition(n.id, graph.edges);
    const title = `${n.label} — ${n.sub}` +
      `${visits > 1 ? ` (${visits} rounds this chat)` : ""}` +
      `${when ? `\nReached when: ${when}` : ""}` +
      `${n.note ? `\n${n.note}` : ""}`;
    parts.push(
      `<g class="pmnode pm-${esc(st)} pm-kind-${esc(n.kind)} pm-group-${esc(n.group)}" data-node="${esc(n.id)}">` +
        `<title>${esc(title)}</title>` +
        `<rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${NODE_H}" rx="${n.kind === "decision" ? 14 : 8}"/>` +
        `<text class="pmlabel" x="${n.x + 9}" y="${n.y + 16}">${esc(clip(n.label, 13))}</text>` +
        `<text class="pmsub" x="${n.x + 9}" y="${n.y + 29}">${esc(clip(n.sub, 17))}</text>` +
        `<text class="pmglyph" x="${n.x + NODE_W - 8}" y="${n.y + 16}" text-anchor="end">${nodeGlyph(st, n.kind)}</text>` +
        (visits > 1
          ? `<text class="pmloop" x="${n.x + NODE_W - 8}" y="${n.y + 29}" text-anchor="end">×${visits}</text>`
          : "") +
      `</g>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

/**
 * The one-line readout under the map: how far this chat has got. Plain language
 * — it sits in a user-facing drawer, not a debug panel.
 * @param {PipelineRun} [run]
 * @returns {string}
 */
export function pipelineRunSummary(run) {
  const visited = Object.keys(run?.visits || {}).length;
  if (!visited) return "Nothing has run yet — send a message and the steps light up here.";
  const active = Object.keys(run?.active || {});
  const label = (/** @type {string} */ id) => PIPELINE_NODES.find((n) => n.id === id)?.label || id;
  const loops = Object.entries(run?.visits || {})
    .filter(([, n]) => Number(n) > 1)
    .map(([id, n]) => `${label(id)} ×${n}`);
  const head = active.length
    ? `Running: ${active.map(label).join(", ")}`
    : run?.visits?.done
      ? `Finished — ${visited} steps taken`
      : `Paused after ${label(run?.last || "")}`;
  return loops.length ? `${head} · looped: ${loops.join(", ")}` : head;
}
