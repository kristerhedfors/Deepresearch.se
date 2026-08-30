// Node tests for the pipeline map's pure core (pipeline-map-core.js): the node
// table's integrity, the layout geometry, the SSE-event → node mapping (including
// the loop counting that is the whole point of the feature), the SVG assembly,
// and XSS safety. The DOM side (pipeline-map.js) is guarded and no-ops without a
// document — asserted at the bottom.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  branchCondition,
  IMPLIED_UPSTREAM,
  impliedUpstream,
  CLIENT_NODES,
  NODE_H,
  NODE_W,
  PIPELINE_EDGES,
  PIPELINE_NODES,
  STREAM_OPEN_NODES,
  applyPipelineStatus,
  emptyPipelineRun,
  layoutPipelineMap,
  nodeGlyph,
  nodeState,
  nodesForStatus,
  notePipelineMoves,
  pipelineMapSvg,
  pipelineRunSummary,
} from "./pipeline-map-core.js";

// ---- the table -------------------------------------------------------------

test("every node id is unique", () => {
  const ids = PIPELINE_NODES.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every edge connects two declared nodes", () => {
  const ids = new Set(PIPELINE_NODES.map((n) => n.id));
  for (const e of PIPELINE_EDGES) {
    assert.ok(ids.has(e.from), `unknown edge source ${e.from}`);
    assert.ok(ids.has(e.to), `unknown edge target ${e.to}`);
  }
});

test("every node is reachable from the composer", () => {
  const out = new Map();
  for (const e of PIPELINE_EDGES) out.set(e.from, [...(out.get(e.from) || []), e.to]);
  const seen = new Set(["compose"]);
  const queue = ["compose"];
  while (queue.length) {
    for (const next of out.get(queue.shift()) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  const orphans = PIPELINE_NODES.map((n) => n.id).filter((id) => !seen.has(id));
  assert.deepEqual(orphans, []);
});

test("the two seed sets name only declared nodes and don't overlap", () => {
  const ids = new Set(PIPELINE_NODES.map((n) => n.id));
  for (const id of [...CLIENT_NODES, ...STREAM_OPEN_NODES]) assert.ok(ids.has(id), id);
  for (const id of CLIENT_NODES) assert.ok(!STREAM_OPEN_NODES.includes(id), id);
});

test("the POST node is proven by the wire, not by starting a send", () => {
  // Introspection's private route and an on-device pick answer browser-direct
  // without calling /api/chat — claiming a POST there would be a lie in the one
  // mode built to be honest about the request path.
  assert.ok(!CLIENT_NODES.includes("post"));
  assert.ok(STREAM_OPEN_NODES.includes("post"));
});

// ---- layout ----------------------------------------------------------------

test("layoutPipelineMap ranks layers into rows and lanes into columns", () => {
  const l = layoutPipelineMap();
  assert.equal(l.nodes.length, PIPELINE_NODES.length);
  const compose = l.nodes.find((n) => n.id === "compose");
  const payload = l.nodes.find((n) => n.id === "payload");
  const fbreply = l.nodes.find((n) => n.id === "fbreply");
  const feedback = l.nodes.find((n) => n.id === "feedback");
  assert.equal(compose.x, payload.x, "same lane → same column");
  assert.ok(payload.y > compose.y, "a later layer sits lower");
  assert.equal(payload.y - compose.y, NODE_H + 14, "consecutive layers are one row apart");
  assert.ok(fbreply.x > feedback.x, "lane 1 sits right of the spine");
  assert.equal(fbreply.y, feedback.y, "same layer → same row");
});

test("layoutPipelineMap fits the drawer's real content box", () => {
  // MEASURED, not derived: a 320px drawer leaves 267px inside its padding and
  // the expandable's own (checked in a headless browser against app.css). The
  // map rendered 280px wide before this bound and scrolled sideways.
  const l = layoutPipelineMap();
  assert.ok(l.width <= 267, `map is ${l.width}px wide — wider than the drawer's content box`);
  assert.ok(l.height > l.width, "a top-down pipeline is taller than it is wide");
});

test("layoutPipelineMap drops edges whose endpoints are missing", () => {
  const l = layoutPipelineMap(
    [{ id: "a", label: "A", sub: "", group: "x", kind: "step", layer: 0, lane: 0 }],
    [{ from: "a", to: "ghost" }],
  );
  assert.equal(l.edges.length, 0);
});

test("a same-lane downward edge leaves the bottom and arrives at the top", () => {
  const l = layoutPipelineMap();
  const e = l.edges.find((x) => x.from === "compose" && x.to === "payload");
  const a = l.nodes.find((n) => n.id === "compose");
  assert.ok(e.straight);
  assert.equal(e.x1, a.x + NODE_W / 2);
  assert.equal(e.y1, a.y + NODE_H);
});

test("a same-lane loop edge leaves and arrives on the RIGHT, clear of the spine", () => {
  // Routed to the left edge it cut diagonally across three boxes.
  const l = layoutPipelineMap();
  const e = l.edges.find((x) => x.from === "reflect" && x.to === "search");
  const a = l.nodes.find((n) => n.id === "reflect");
  const b = l.nodes.find((n) => n.id === "search");
  assert.equal(e.loop, true);
  assert.equal(e.straight, false);
  assert.equal(e.x1, a.x + NODE_W);
  assert.equal(e.x2, b.x + NODE_W);
  assert.ok(e.y2 < e.y1, "it goes back up");
});

test("the terminal-to-done edges are declared but not drawn", () => {
  const ends = PIPELINE_EDGES.filter((e) => e.ends);
  assert.equal(ends.length, 4);
  for (const e of ends) assert.equal(e.to, "done");
  const svg = pipelineMapSvg();
  // Five near-parallel 12-row curves through the branch column cost more than
  // they add; the reachability and taken-path logic still reads the edges.
  const drawn = (svg.match(/<path class="pmedge/g) || []).length;
  assert.equal(drawn, PIPELINE_EDGES.length - ends.length);
});

test("a cross-lane edge leaves from the side so it never crosses a box", () => {
  const l = layoutPipelineMap();
  const e = l.edges.find((x) => x.from === "feedback" && x.to === "fbreply");
  const a = l.nodes.find((n) => n.id === "feedback");
  const b = l.nodes.find((n) => n.id === "fbreply");
  assert.equal(e.straight, false);
  assert.equal(e.x1, a.x + NODE_W, "leaves the right edge");
  assert.equal(e.x2, b.x, "arrives at the left edge");
});

// ---- event mapping ---------------------------------------------------------

test("nodesForStatus maps the pipeline's step ids", () => {
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "plan" }), { enter: ["plan"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "synth" }), { enter: ["synth"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "introspect" }), { enter: ["enrich"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "reflect2" }), { enter: ["reflect"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "tool_3" }), { enter: ["loop"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "agent_2" }), { enter: ["executor"], exit: [] });
  // A replayed run from before the gap cascade was deleted: its step ids name
  // a box that is not drawn any more, so they fall to the engine node rather
  // than to nothing (and never to a node the layout does not contain).
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "gap3" }), { enter: ["loop"], exit: [] });
});

test("an unknown EVENT TYPE is still ignored (forward compatibility)", () => {
  // The SSE vocabulary's rule, unchanged: an event this file has never heard of
  // changes nothing about the map.
  assert.deepEqual(nodesForStatus({ type: "future_event" }), { enter: [], exit: [] });
  assert.deepEqual(nodesForStatus({}), { enter: [], exit: [] });
  assert.deepEqual(nodesForStatus(null), { enter: [], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "step_start" }), { enter: [], exit: [] }, "a step with no id at all");
});

test("an unknown STEP ID lights the engine node instead of blanking the map", () => {
  // The rule that is deliberately NOT the same as the one above. Every step id
  // between the mode dispatch and synthesis belongs to whichever ENGINE ran,
  // and engines are pluggable now (src/pipeline.js runResearchPhase). Ignoring
  // an unrecognised one drew a map that went dark for a future engine's entire
  // research phase, which reads as "nothing happened".
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "some_future_phase" }), { enter: ["loop"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "step_done", id: "some_future_phase" }), { enter: [], exit: ["loop"] });
});

test("the engine step ids map onto their loop nodes", () => {
  // The model-driven engine's own step ids: `tool_<n>`, one pair per call
  // (src/agentic.js loopStepId) — numbered, never named, because a research
  // tool's NAME is a service's name (invariant 7).
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "loop" }), { enter: ["loop"], exit: [] });
  for (const id of ["tool_1", "tool_9", "tool_16"]) {
    assert.deepEqual(nodesForStatus({ type: "step_start", id }), { enter: ["loop"], exit: [] }, id);
  }
  // …and the standard graph's reflect rounds, which count like the gap rounds.
  assert.deepEqual(nodesForStatus({ type: "step_start", id: "reflect2" }), { enter: ["reflect"], exit: [] });
});

test("a self-edge is drawn as a loop on the node's own right side", () => {
  // Without the `self` case it fell through to the cross-lane routing, which
  // drew the curve from the middle of the box back to its own left edge —
  // straight through the label.
  const l = layoutPipelineMap();
  const e = l.edges.find((x) => x.from === "loop" && x.to === "loop");
  const n = l.nodes.find((x) => x.id === "loop");
  assert.ok(e, "the research loop declares its own loop edge");
  assert.equal(e.self, true);
  assert.equal(e.loop, true);
  assert.equal(e.straight, false);
  assert.equal(e.x1, n.x + NODE_W, "leaves the right edge");
  assert.equal(e.x2, n.x + NODE_W, "and arrives back on it");
  assert.ok(e.y2 > e.y1, "the two ends are apart, so the bow is visible");
});

test("a search event pair is exactly one wave, whatever round it belongs to", () => {
  // The gap node counts its own rounds off gap1…gapN. Lighting it from the
  // search events TOO counted every gap round twice.
  assert.deepEqual(nodesForStatus({ type: "search_start", round: 1 }), { enter: ["search"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "search_start", round: 3 }), { enter: ["search"], exit: [] });
  assert.deepEqual(nodesForStatus({ type: "search_done", round: 2 }), { enter: [], exit: ["search"] });
});

test("finishing a step leaves it without counting a second visit", () => {
  // A plain start/done pair used to read as two rounds ("Enrichments ×2" on a
  // run that enriched once).
  const run = emptyPipelineRun();
  applyPipelineStatus(run, { type: "step_start", id: "introspect" });
  applyPipelineStatus(run, { type: "step_done", id: "introspect" });
  assert.equal(run.visits.enrich, 1);
  assert.equal(nodeState(run, "enrich"), "passed");
});

test("a step_done with no matching start still lights its node", () => {
  const run = emptyPipelineRun();
  applyPipelineStatus(run, { type: "step_done", id: "validate" });
  assert.equal(nodeState(run, "validate"), "passed");
});

test("the plan step's route field decides the branch — no label sniffing", () => {
  // src/pipeline.js emits `route` on the finished `plan` step. English labels
  // could be reworded at any time; this contract can't drift silently.
  for (const [route, node] of [["feedback", "fbreply"], ["direct", "direct"], ["search_off", "direct"]]) {
    const moves = nodesForStatus({ type: "step_done", id: "plan", label: "anything at all", route });
    assert.deepEqual(moves, { enter: [node], exit: ["plan"] }, route);
  }
  // "research" has no terminal of its own — the search wave follows.
  assert.deepEqual(nodesForStatus({ type: "step_done", id: "plan", route: "research" }), {
    enter: [],
    exit: ["plan"],
  });
  // `clarify` went with the triage phase that emitted it. A replayed old run
  // carrying that route lights nothing, rather than a box that is not drawn.
  assert.deepEqual(nodesForStatus({ type: "step_done", id: "plan", route: "clarify" }), {
    enter: [],
    exit: ["plan"],
  });
});

// ---- implied upstream ------------------------------------------------------

test("IMPLIED_UPSTREAM names only declared nodes and has no cycles", () => {
  const ids = new Set(PIPELINE_NODES.map((n) => n.id));
  for (const [id, ups] of Object.entries(IMPLIED_UPSTREAM)) {
    assert.ok(ids.has(id), id);
    for (const up of ups) assert.ok(ids.has(up), up);
    // impliedUpstream would loop forever on a cycle; it terminates, and a node
    // must never imply itself.
    assert.ok(!impliedUpstream(id).includes(id), `${id} implies itself`);
  }
});

test("impliedUpstream resolves transitively", () => {
  assert.deepEqual(impliedUpstream("plan").sort(), ["enrich", "feedback", "mode"]);
  assert.deepEqual(impliedUpstream("compose"), [], "the first node implies nothing");
});

test("the always-run gates light from a downstream step, so no node can only ever be dark", () => {
  // The feedback gate, the enrichment pass and the mode dispatch emit nothing of
  // their own on an ordinary request; a box that could never light would read as
  // "this never happens".
  const run = emptyPipelineRun();
  applyPipelineStatus(run, { type: "step_start", id: "plan" });
  for (const id of ["feedback", "enrich", "mode"]) {
    assert.equal(nodeState(run, id), "passed", id);
  }
  assert.equal(run.visits.feedback, 1, "implied, never counted as a round");
});

test("an implied gate is not counted again when the loop it gates repeats", () => {
  const run = emptyPipelineRun();
  for (let i = 0; i < 5; i++) applyPipelineStatus(run, { type: "step_start", id: "source" });
  assert.equal(run.visits.source, 5);
  assert.equal(run.visits.mode, 1);
  assert.equal(run.visits.feedback, 1);
});

test("every node can be lit by some observable signal", () => {
  // The honesty rule as a test: for each node, SOME event (or seed set, or
  // implication) reaches it. A node no signal can light does not belong here.
  const lit = new Set([...CLIENT_NODES, ...STREAM_OPEN_NODES]);
  const events = [
    { type: "step_start", id: "plan" },
    { type: "step_done", id: "plan", route: "feedback" },
    { type: "step_done", id: "plan", route: "direct" },
    { type: "step_start", id: "introspect" },
    { type: "step_start", id: "source" },
    { type: "step_start", id: "agent_1" },
    { type: "search_start", round: 1 },
    { type: "step_start", id: "tool_1" },
    { type: "step_start", id: "reflect1" },
    { type: "step_start", id: "synth" },
    { type: "step_start", id: "validate" },
    { type: "done" },
  ];
  for (const e of events) {
    const moves = nodesForStatus(e);
    for (const id of [...moves.enter, ...moves.exit]) {
      lit.add(id);
      for (const up of impliedUpstream(id)) lit.add(up);
    }
  }
  // The two error terminals are reachable only on a failed request, which never
  // opens a stream to report itself — they are drawn so the branch is visible,
  // and are the ONLY nodes with no live signal.
  const unlit = PIPELINE_NODES.map((n) => n.id).filter((id) => !lit.has(id));
  assert.deepEqual(unlit, ["rejected", "limited"]);
});

// ---- branch conditions -----------------------------------------------------

test("a cross-lane branch label survives as the target node's tooltip", () => {
  assert.equal(branchCondition("fbreply"), "yes");
  assert.equal(branchCondition("source"), "own source");
  assert.equal(branchCondition("compose"), "");
  const svg = pipelineMapSvg();
  assert.ok(svg.includes("Reached when: own source"));
});

test("a label is drawn only where there is room for it — never across a lane gap", () => {
  // Straight edges (the row gap) and the back edge (which bows out past the
  // spine) keep their labels; cross-lane labels would land on the box they point
  // at, so they move to the tooltip.
  const svg = pipelineMapSvg();
  const labels = [...svg.matchAll(/class="pmedgelabel"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(labels.sort(), ["no", "reflect", "research"]);
  for (const dropped of ["yes", "agent", "own source", "direct", "model-driven"]) {
    // "model-driven" is the engine router's cross-lane label; like every other
    // one it moves to the target node's tooltip. "reflect" is drawn, because
    // the standard graph's loop edge now runs down the spine rather than
    // across the lane gap.
    assert.ok(!labels.includes(dropped), `${dropped} must not be drawn`);
    assert.ok(svg.includes(`Reached when: ${dropped}`), `${dropped} must survive in a tooltip`);
  }
});

// ---- the run ---------------------------------------------------------------

test("a fresh run has nothing lit", () => {
  const run = emptyPipelineRun();
  for (const n of PIPELINE_NODES) assert.equal(nodeState(run, n.id), "idle");
  assert.match(pipelineRunSummary(run), /Nothing has run yet/);
});

test("entering makes a node active, leaving makes it passed and it stays lit", () => {
  const run = emptyPipelineRun();
  notePipelineMoves(run, { enter: ["plan"] });
  assert.equal(nodeState(run, "plan"), "active");
  notePipelineMoves(run, { exit: ["plan"] });
  assert.equal(nodeState(run, "plan"), "passed");
  notePipelineMoves(run, { enter: ["synth"] });
  assert.equal(nodeState(run, "plan"), "passed", "an earlier step stays lit");
});

test("notePipelineMoves ignores unknown ids and only ticks on a real change", () => {
  const run = emptyPipelineRun();
  notePipelineMoves(run, { enter: ["not_a_node"], exit: ["also_not_a_node"] });
  assert.deepEqual(run.visits, {});
  assert.equal(run.ticks, 0);
  notePipelineMoves(run, { enter: ["synth"] });
  const ticks = run.ticks;
  assert.ok(ticks > 0);
  notePipelineMoves(run, { enter: [] }); // nothing to do
  assert.equal(run.ticks, ticks);
});

test("a looping agent keeps re-lighting the same node and counts its rounds", () => {
  const run = emptyPipelineRun();
  for (const calls of [1, 2, 3]) {
    applyPipelineStatus(run, { type: "step_start", id: "source", label: `Investigating — ${calls} tool calls…` });
  }
  assert.equal(run.visits.source, 3);
  assert.equal(nodeState(run, "source"), "active");
  assert.match(pipelineRunSummary(run), /looped: Source loop ×3/);
});

test("the reflect loop counts its rounds, and each round's wave counts once", () => {
  const run = emptyPipelineRun();
  const wave = (round) => {
    applyPipelineStatus(run, { type: "search_start", round });
    applyPipelineStatus(run, { type: "search_done", round });
  };
  wave(1);
  for (const it of [1, 2]) {
    applyPipelineStatus(run, { type: "step_start", id: `reflect${it}` });
    wave(it + 1);
    applyPipelineStatus(run, { type: "step_done", id: `reflect${it}` });
  }
  assert.equal(run.visits.search, 3, "three waves ran");
  assert.equal(run.visits.reflect, 2, "two reflect rounds ordered them — not four");
});

test("done closes everything still running, so nothing blinks forever", () => {
  const run = emptyPipelineRun();
  applyPipelineStatus(run, { type: "step_start", id: "synth" });
  applyPipelineStatus(run, { type: "step_done", id: "plan", route: "direct" });
  assert.ok(Object.keys(run.active).length > 0);
  applyPipelineStatus(run, { type: "done", model: "x" });
  assert.deepEqual(run.active, {});
  assert.equal(nodeState(run, "done"), "passed");
  assert.match(pipelineRunSummary(run), /Finished/);
});

test("a whole introspection run lights the source path and never the research spine", () => {
  const run = emptyPipelineRun();
  notePipelineMoves(run, { enter: CLIENT_NODES, exit: CLIENT_NODES });
  notePipelineMoves(run, { enter: STREAM_OPEN_NODES, exit: STREAM_OPEN_NODES });
  applyPipelineStatus(run, { type: "step_start", id: "introspect" });
  applyPipelineStatus(run, { type: "step_done", id: "introspect", label: "Source snapshot loaded" });
  applyPipelineStatus(run, { type: "step_start", id: "source" });
  applyPipelineStatus(run, { type: "step_start", id: "source" });
  applyPipelineStatus(run, { type: "done" });
  for (const id of ["compose", "post", "stream", "enrich", "source", "done"]) {
    assert.equal(nodeState(run, id), "passed", id);
  }
  for (const id of ["plan", "search", "loop", "reflect", "synth", "validate", "fbreply"]) {
    assert.equal(nodeState(run, id), "idle", `${id} must stay dark — this run never took it`);
  }
});

test("the summary names the running step and reports an interrupted run honestly", () => {
  const run = emptyPipelineRun();
  applyPipelineStatus(run, { type: "step_start", id: "reflect1" });
  assert.match(pipelineRunSummary(run), /^Running: Reflect/);
  notePipelineMoves(run, { exit: ["reflect"] });
  assert.match(pipelineRunSummary(run), /^Paused after Reflect/);
});

// ---- SVG -------------------------------------------------------------------

test("pipelineMapSvg draws every node with its state class", () => {
  const run = emptyPipelineRun();
  notePipelineMoves(run, { enter: ["plan"], exit: ["plan"] });
  notePipelineMoves(run, { enter: ["search"] });
  const svg = pipelineMapSvg(run);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
  for (const n of PIPELINE_NODES) assert.ok(svg.includes(`data-node="${n.id}"`), n.id);
  assert.match(svg, /data-node="plan"[\s\S]{0,10}/);
  assert.ok(svg.includes("pm-passed"));
  assert.ok(svg.includes("pm-active"));
  assert.ok(svg.includes("pm-idle"));
});

test("pipelineMapSvg shows a loop count only past the first visit", () => {
  const run = emptyPipelineRun();
  notePipelineMoves(run, { enter: ["reflect"] });
  assert.ok(!pipelineMapSvg(run).includes("×2"));
  notePipelineMoves(run, { enter: ["reflect"] });
  const svg = pipelineMapSvg(run);
  assert.ok(svg.includes("×2"));
  assert.ok(svg.includes("2 rounds this chat"));
});

test("an edge between two visited nodes is drawn as part of the path taken", () => {
  const run = emptyPipelineRun();
  assert.ok(!pipelineMapSvg(run).includes("pm-taken"));
  notePipelineMoves(run, { enter: ["compose", "payload"], exit: ["compose", "payload"] });
  assert.ok(pipelineMapSvg(run).includes("pm-taken"));
});

test("nodeGlyph distinguishes a running loop from a running step", () => {
  assert.equal(nodeGlyph("active", "loop"), "↻");
  assert.equal(nodeGlyph("active", "step"), "◐");
  assert.equal(nodeGlyph("passed", "step"), "✓");
  assert.equal(nodeGlyph("idle", "decision"), "?");
  assert.equal(nodeGlyph("idle", "step"), "○");
});

test("pipelineMapSvg escapes text it is given", () => {
  const svg = pipelineMapSvg(emptyPipelineRun(), {
    nodes: [{ id: "x", label: '<img src=x onerror="1">', sub: "a & b", group: "g", kind: "step", layer: 0, lane: 0 }],
    edges: [],
  });
  assert.ok(!svg.includes("<img"));
  assert.ok(svg.includes("&lt;img"));
  assert.ok(svg.includes("a &amp; b"));
});

test("pipelineMapSvg renders with no run at all", () => {
  assert.ok(pipelineMapSvg().includes("data-node=\"compose\""));
});

// ---- the DOM side is import-safe -------------------------------------------

test("pipeline-map.js is a no-op without a document", async () => {
  const m = await import("./pipeline-map.js");
  m.initPipelineMap({ getMode: () => "introspection" });
  m.startPipelineRun();
  m.notePipelineStatus({ type: "step_start", id: "plan" });
  m.endPipelineRun();
  // The run state still tracks — only the drawing needs a DOM.
  assert.equal(nodeState(m.pipelineRun(), "compose"), "passed");
  assert.equal(nodeState(m.pipelineRun(), "plan"), "passed", "endPipelineRun closed it");
});
