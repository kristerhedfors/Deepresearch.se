// Node tests for the workflow view's pure core (workflow-viz.js): layout
// geometry, SVG assembly, statuses, and XSS safety. The DOM mount is guarded
// and returns null in Node — asserted too.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NODE_SEARCH_ROWS, NODE_H, NODE_W, SWARM_NODE_H, inspectorHtml, inspectorModel, layoutWorkflow,
  mergeSearch, nodeActivity, nodeHeight, nodeRenderState, renderWorkflow, statusGlyph, swarmRenderState, workflowSvg,
} from "./workflow-viz.js";
import { MAX_PROMPT_PREVIEW } from "./orchestrator-core.js";

const wf = {
  title: "Compare runtimes",
  agents: [
    { id: "a", kind: "web_research", name: "Workers researcher", task: "Research A.", deps: [] },
    { id: "b", kind: "web_research", name: "Deno researcher", task: "Research B.", deps: [] },
    { id: "c", kind: "custom", name: "Critic", task: "Compare.", deps: ["a", "b"] },
  ],
  waves: [["a", "b"], ["c"]],
};

test("layoutWorkflow places waves as columns and nodes as rows", () => {
  const l = layoutWorkflow(wf);
  assert.equal(l.nodes.length, 3);
  const [a, b, c] = ["a", "b", "c"].map((id) => l.nodes.find((n) => n.id === id));
  assert.equal(a.x, b.x, "same wave → same column");
  assert.ok(c.x > a.x, "later wave → further right");
  assert.ok(b.y > a.y, "stacked within the wave");
  assert.equal(l.edges.length, 2);
  const edge = l.edges.find((e) => e.from === "a");
  assert.equal(edge.x1, a.x + NODE_W);
  assert.equal(edge.x2, c.x);
});

test("layoutWorkflow tolerates a missing waves list", () => {
  const l = layoutWorkflow({ agents: wf.agents });
  assert.equal(l.nodes.length, 3); // single column fallback
});

test("workflowSvg renders every node with kind label and status class", () => {
  const svg = workflowSvg(wf, { a: { status: "done", duration_ms: 1234 }, b: { status: "running" } });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('data-agent="a"'));
  assert.ok(svg.includes("wf-done"));
  assert.ok(svg.includes("wf-running"));
  assert.ok(svg.includes("wf-pending"), "no status → pending");
  assert.ok(svg.includes("Web research"));
  assert.ok(svg.includes("1.2s"));
  assert.ok(svg.includes("Compare runtimes"));
});

test("workflowSvg shows a failed node's note and is XSS-safe", () => {
  const evil = {
    agents: [{ id: "x", kind: "custom", name: '<img onerror=alert(1)>', task: '"quoted"</svg>', deps: [] }],
    waves: [["x"]],
  };
  const svg = workflowSvg(evil, { x: { status: "failed", note: "timed out after 150s" } });
  assert.ok(!svg.includes("<img"));
  assert.ok(!svg.includes('"quoted"</svg>'));
  assert.ok(svg.includes("wf-failed"));
  assert.ok(svg.includes("timed out"));
});

// ---- the local-swarm node (many on-device models in one box) -----------------

const swarmWf = {
  agents: [
    { id: "sw", kind: "swarm", name: "Local swarm", task: "Weigh the options.", swarmSize: 5, deps: [] },
    { id: "critic", kind: "custom", name: "Critic", task: "Combine.", deps: ["sw"] },
  ],
  waves: [["sw"], ["critic"]],
};

test("a swarm node is taller and the layout measures columns instead of multiplying", () => {
  assert.equal(nodeHeight("swarm"), SWARM_NODE_H);
  assert.equal(nodeHeight("custom"), NODE_H);
  const l = layoutWorkflow(swarmWf);
  const sw = l.nodes.find((n) => n.id === "sw");
  const critic = l.nodes.find((n) => n.id === "critic");
  assert.equal(sw.h, SWARM_NODE_H);
  assert.equal(critic.h, NODE_H);
  assert.equal(sw.swarmSize, 5);
  assert.ok(l.height >= SWARM_NODE_H, "the tall node fits");
  // Edges leave and arrive at each node's OWN mid-height.
  assert.equal(l.edges[0].y1, sw.y + SWARM_NODE_H / 2);
  assert.equal(l.edges[0].y2, critic.y + NODE_H / 2);
  // Mixed heights stack without overlapping.
  const stacked = layoutWorkflow({
    agents: [swarmWf.agents[0], { id: "c2", kind: "custom", name: "C", deps: [] }],
    waves: [["sw", "c2"]],
  });
  const [a, b] = ["sw", "c2"].map((id) => stacked.nodes.find((n) => n.id === id));
  assert.ok(b.y >= a.y + a.h, "the second node clears the tall one");
});

test("a swarm node renders one dot per member plus the round/agreement readout", () => {
  // Before any update: the planned member count, no round yet.
  const planned = workflowSvg(swarmWf, {});
  assert.equal((planned.match(/class="wfmember/g) || []).length, 5);
  assert.ok(planned.includes(">×5<"));
  assert.ok(planned.includes("wf-swarm"));
  assert.ok(planned.includes("5 in-browser members"));

  // Live: the members' own states and the swarm's convergence so far.
  const live = workflowSvg(swarmWf, {
    sw: {
      status: "running",
      swarm: { round: 2, rounds: 3, agreement: 0.62, members: ["done", "running", "loading", "failed", "pending"], phase: "diverge" },
    },
  });
  assert.ok(live.includes("wm-done") && live.includes("wm-running") && live.includes("wm-loading") && live.includes("wm-failed"));
  assert.ok(live.includes(">R2/3 · 62%<"));
});

test("non-swarm nodes carry no member strip", () => {
  assert.ok(!workflowSvg(wf, {}).includes("wfmember"));
});

test("statusGlyph covers the lifecycle", () => {
  assert.equal(statusGlyph("done"), "✓");
  assert.equal(statusGlyph("failed"), "✕");
  assert.equal(statusGlyph("running"), "◐");
  assert.equal(statusGlyph("pending"), "○");
  assert.equal(statusGlyph("skipped"), "–");
});

test("renderWorkflow fails soft without a DOM", () => {
  assert.equal(renderWorkflow({ el: undefined }, wf, {}), null);
});

// ---- what the live view is allowed to RETAIN ---------------------------------

test("swarmRenderState keeps only what the strip draws", () => {
  const s = swarmRenderState({
    type: "swarm_update",
    id: "sw",
    round: 2,
    rounds: 3,
    agreement: 0.62,
    phase: "diverge",
    model: "Bonsai 1.7B · 1-bit",
    members: Array.from({ length: 40 }, () => "running"),
    extra: { anything: "a future event field" },
  });
  // `statuses` is persisted with the turn, so a swarm publishing on every
  // member state change must not grow what gets stored.
  assert.deepEqual(Object.keys(s).sort(), ["agreement", "members", "phase", "round", "rounds"]);
  assert.equal(s.members.length, 12, "capped at the drawable member count");
  assert.equal(s.round, 2);
  assert.equal(s.agreement, 0.62);
  const empty = swarmRenderState(null);
  assert.deepEqual(empty.members, []);
  assert.equal(empty.round, 0);
});

// ---- the node INSPECTOR (feedback #35: "a live view into that node") ---------

const inspectWf = {
  title: "Compare runtimes",
  agents: [
    { id: "a", kind: "web_research", name: "Workers researcher", task: "Research A.", queries: ["workers runtime", "workers limits"], deps: [] },
    { id: "b", kind: "swarm", name: "Local swarm", task: "Weigh it.", swarmSize: 4, deps: [] },
    { id: "c", kind: "custom", name: "Critic", task: "Compare.", persona: "A sceptical reviewer.", deps: ["a", "b"] },
  ],
  waves: [["a", "b"], ["c"]],
};

test("inspectorModel assembles the plan and the live state for one node", () => {
  const m = inspectorModel(inspectWf, "c", {
    c: { status: "running", prompt: "You are \"Critic\"…", prompt_chars: 9000 },
  });
  assert.equal(m.name, "Critic");
  assert.equal(m.kindLabel, "Custom");
  assert.equal(m.persona, "A sceptical reviewer.");
  assert.equal(m.wave, 2);
  assert.equal(m.waves, 2);
  assert.deepEqual(m.deps.map((d) => d.name), ["Workers researcher", "Local swarm"], "deps resolve to names");
  assert.deepEqual(m.feeds, [], "nothing depends on the last node");
  assert.equal(m.promptTruncated, true, "9000 chars, a 21-char preview");
  // …and the reverse edge, from the node the critic reads.
  const upstream = inspectorModel(inspectWf, "a", {});
  assert.deepEqual(upstream.feeds.map((f) => f.id), ["c"]);
  assert.equal(upstream.status, "pending", "no status yet → pending");
  assert.deepEqual(upstream.queries, ["workers runtime", "workers limits"]);
});

test("inspectorModel returns null for an id the plan doesn't have", () => {
  assert.equal(inspectorModel(inspectWf, "ghost", {}), null);
});

test("nodeActivity says what the node is doing at each stage", () => {
  const dr = { kind: "web_research" };
  assert.match(nodeActivity(dr, {}), /Waiting for its turn/);
  assert.match(nodeActivity(dr, { status: "running" }), /Gathering sources/);
  assert.match(
    nodeActivity(dr, { status: "running" }, [{ status: "done" }, { status: "running" }]),
    /1 query still running/,
  );
  assert.match(nodeActivity(dr, { status: "running", prompt: "…" }), /Writing its brief/);
  assert.match(nodeActivity(dr, { status: "done", duration_ms: 4200, chars: 1832 }), /4\.2s, 1832 characters/);
  assert.match(nodeActivity(dr, { status: "failed", note: "timeout: timed out after 150s" }), /timed out after 150s/);
  assert.match(nodeActivity({ kind: "introspection" }, { status: "running" }), /site's own source/);
  assert.match(
    nodeActivity({ kind: "swarm" }, { status: "running", swarm: { round: 2, rounds: 3, agreement: 0.62 } }),
    /round 2 of 3, 62% agreement/,
  );
});

test("inspectorHtml shows the live fields and is XSS-safe", () => {
  const html = inspectorHtml(inspectorModel(inspectWf, "a", {
    a: { status: "running", searches: [{ q: "workers runtime", status: "done", results: 8, ms: 1200 }, { q: "workers limits", status: "running" }] },
  }));
  assert.ok(html.includes("Workers researcher"));
  assert.ok(html.includes("Web research"));
  assert.ok(html.includes("8 results"));
  assert.ok(html.includes("searching…"), "the in-flight query is marked");
  assert.ok(html.includes('data-wf-goto="c"'), "the downstream node is reachable");
  assert.ok(html.includes("data-wf-close"));

  const evil = inspectorHtml(inspectorModel(
    { agents: [{ id: "x", kind: "custom", name: "<img onerror=alert(1)>", task: "</div><script>bad()</script>", deps: [] }], waves: [["x"]] },
    "x",
    { x: { status: "failed", note: "<b>boom</b>" } },
  ));
  assert.ok(!evil.includes("<img"));
  assert.ok(!evil.includes("<script>"));
  assert.ok(!evil.includes("<b>boom</b>"));
});

test("inspectorHtml shows PLANNED queries before any search has run", () => {
  const html = inspectorHtml(inspectorModel(inspectWf, "a", {}));
  assert.ok(html.includes("workers runtime"));
  assert.ok(html.includes("planned"));
  assert.ok(!html.includes("wfi-prompt"), "no prompt yet — nothing to show");
});

test("nodeRenderState keeps only the inspected fields and re-clamps the prompt", () => {
  const kept = nodeRenderState({
    type: "agent_update",
    id: "a",
    status: "running",
    duration_ms: 1200,
    chars: 50,
    note: "x".repeat(400),
    prompt: "p".repeat(MAX_PROMPT_PREVIEW + 500),
    prompt_chars: MAX_PROMPT_PREVIEW + 500,
    somethingFuture: "not stored",
  });
  assert.deepEqual(Object.keys(kept).sort(), ["chars", "duration_ms", "note", "prompt", "prompt_chars", "status"]);
  assert.equal(kept.note.length, 200);
  assert.equal(kept.prompt.length, MAX_PROMPT_PREVIEW);
  assert.equal(kept.prompt_chars, MAX_PROMPT_PREVIEW + 500, "the FULL length survives the clamp");
  // A swarm_update still normalizes through swarmRenderState.
  assert.deepEqual(Object.keys(nodeRenderState({ status: "running", swarm: { round: 1 } })), ["status", "swarm"]);
});

test("mergeSearch folds start→done by query and stays bounded", () => {
  let rows = mergeSearch(undefined, { type: "search_start", query: "q1" });
  rows = mergeSearch(rows, { type: "search_start", query: "q2" });
  assert.equal(rows.length, 2);
  rows = mergeSearch(rows, { type: "search_done", query: "q1", results: 8, duration_ms: 1200 });
  assert.equal(rows.length, 2, "done replaces its own start row");
  assert.deepEqual(rows[0], { q: "q1", status: "done", results: 8, ms: 1200 });
  assert.equal(rows[1].status, "running");
  // A query-less event changes nothing; the list never grows past its cap.
  assert.equal(mergeSearch(rows, { type: "search_start" }).length, 2);
  let many = [];
  for (let i = 0; i < MAX_NODE_SEARCH_ROWS + 5; i++) many = mergeSearch(many, { type: "search_start", query: `q${i}` });
  assert.equal(many.length, MAX_NODE_SEARCH_ROWS);
});

test("workflowSvg marks the open node and makes every node a button", () => {
  const svg = workflowSvg(inspectWf, {}, { selected: "c" });
  assert.ok(svg.includes('role="button"'));
  assert.ok(svg.includes('tabindex="0"'));
  assert.ok(svg.includes("wf-selected"));
  assert.ok(svg.includes('aria-expanded="true"'));
  assert.ok(svg.includes('aria-expanded="false"'), "the other nodes are closed");
  assert.ok(!workflowSvg(inspectWf, {}).includes("wf-selected"), "nothing selected by default");
});
