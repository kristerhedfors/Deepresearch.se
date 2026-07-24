// Node tests for the workflow view's pure core (workflow-viz.js): layout
// geometry, SVG assembly, statuses, and XSS safety. The DOM mount is guarded
// and returns null in Node — asserted too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NODE_W, layoutWorkflow, renderWorkflow, statusGlyph, workflowSvg } from "./workflow-viz.js";

const wf = {
  title: "Compare runtimes",
  agents: [
    { id: "a", kind: "deep_research", name: "Workers researcher", task: "Research A.", deps: [] },
    { id: "b", kind: "deep_research", name: "Deno researcher", task: "Research B.", deps: [] },
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
  assert.ok(svg.includes("Deep Research"));
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
