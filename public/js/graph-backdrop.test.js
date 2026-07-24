// Node tests for the graph backdrop's pure core (graph-backdrop.js): scene
// build (root + wave rings + directed edges), the idle scene, and the
// per-frame rotation/projection geometry. The DOM mount is guarded — the
// module (and its feed functions) must be import-safe and callable in Node.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_STYLES,
  ROOT_ID,
  buildGraphScene,
  graphFrame,
  idleScene,
  mountGraphBackdrop,
  setGraphWorkflow,
  updateGraphAgent,
} from "./graph-backdrop.js";
import { AGENT_KIND_IDS } from "./orchestrator-core.js";

const wf = {
  title: "Compare runtimes",
  agents: [
    { id: "a", kind: "deep_research", name: "A", deps: [] },
    { id: "b", kind: "introspection", name: "B", deps: [] },
    { id: "c", kind: "custom", name: "C", deps: ["a", "b"] },
  ],
  waves: [["a", "b"], ["c"]],
};

test("buildGraphScene: root above, waves as rings below, directed edges", () => {
  const s = buildGraphScene(wf);
  const root = s.nodes.find((n) => n.id === ROOT_ID);
  assert.ok(root && root.kind === "root");
  assert.equal(s.nodes.length, 4);
  const a = s.nodes.find((n) => n.id === "a");
  const c = s.nodes.find((n) => n.id === "c");
  assert.ok(root.pos[1] > a.pos[1], "root sits above wave 0");
  assert.ok(a.pos[1] > c.pos[1], "later waves sit lower");
  // Dep-less wave-0 nodes hang off the root; dependents hang off their deps.
  assert.ok(s.edges.some((e) => e.from === ROOT_ID && e.to === "a"));
  assert.ok(s.edges.some((e) => e.from === ROOT_ID && e.to === "b"));
  assert.ok(s.edges.some((e) => e.from === "a" && e.to === "c"));
  assert.ok(s.edges.some((e) => e.from === "b" && e.to === "c"));
  assert.ok(!s.edges.some((e) => e.from === ROOT_ID && e.to === "c"), "dependent nodes don't double-wire to the root");
});

test("buildGraphScene falls back to the idle scene on an empty workflow", () => {
  const s = buildGraphScene(null);
  assert.equal(s.nodes.length, 1 + AGENT_KIND_IDS.length);
  for (const k of AGENT_KIND_IDS) {
    assert.ok(s.nodes.some((n) => n.kind === k), `idle ghost for ${k}`);
    assert.ok(s.edges.some((e) => e.from === ROOT_ID && e.to === `idle-${k}`));
  }
  assert.deepEqual(idleScene().nodes.map((n) => n.id), s.nodes.map((n) => n.id));
});

test("graphFrame projects every node, far-to-near, and rotates over time", () => {
  const scene = buildGraphScene(wf);
  const view = { w: 800, h: 600 };
  const f0 = graphFrame(scene, 0, view);
  assert.equal(f0.nodes.length, 4);
  assert.equal(f0.edges.length, 4);
  for (let i = 1; i < f0.nodes.length; i++) {
    assert.ok(f0.nodes[i - 1].s <= f0.nodes[i].s, "painter's order: far first");
  }
  for (const e of f0.edges) {
    // The arrowhead anchor sits between the endpoints, nearer the target.
    const d1 = Math.hypot(e.ax - e.x1, e.ay - e.y1);
    const d2 = Math.hypot(e.ax - e.x2, e.ay - e.y2);
    assert.ok(d2 < d1);
  }
  const f5 = graphFrame(scene, 5, view);
  const a0 = f0.nodes.find((n) => n.id === "a");
  const a5 = f5.nodes.find((n) => n.id === "a");
  assert.ok(Math.abs(a0.x - a5.x) > 1, "the ring turns");
  const r0 = f0.nodes.find((n) => n.id === ROOT_ID);
  const r5 = f5.nodes.find((n) => n.id === ROOT_ID);
  assert.ok(Math.abs(r0.y - r5.y) > 0.1, "the root hovers (bobs)");
});

test("styles cover the root and every agent kind", () => {
  assert.ok(GRAPH_STYLES.root.color && GRAPH_STYLES.root.glyph);
  for (const k of AGENT_KIND_IDS) {
    assert.ok(GRAPH_STYLES[k]?.color && GRAPH_STYLES[k]?.glyph, `style for ${k}`);
  }
});

test("module is import-safe in Node: mount and feeds are no-op without a DOM", () => {
  mountGraphBackdrop(); // no document → returns
  setGraphWorkflow(wf, {});
  updateGraphAgent("a", { status: "done" }); // mutates module state, draws nothing
});
