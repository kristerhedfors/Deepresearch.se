// @ts-check
// The WORKFLOW GRAPH BACKDROP — Orchestrator mode's agent background: a
// hovering, slowly rotating wireframe DIRECTED GRAPH drifting faintly behind
// the chat, the orchestrator root at the top and every sub-agent below it,
// each node drawn as its kind's wireframe symbol in its kind's color (the
// balloon blue for Deep Research, TIN's titanium slate for Introspection,
// the violet diamond for custom specialists; the root is the violet baton
// star). This is the "graph" implementation of the mode-theme.js `backdrop`
// axis — the sibling of agent-backdrop.js's "terminal" (drifting shell
// output); mode-backdrop.js decides which one a mode stands in front of.
//
// Pure JS, no dependencies beyond the repo's own wireframe math: the 3D
// rotation + perspective projection come from space-core.js (rotY,
// projectPoint — the same helpers the /space scenes use). The scene build and
// per-frame geometry are I/O-free and Node-tested (graph-backdrop.test.js);
// only the mount at the bottom touches canvas/DOM, fail-soft throughout.
//
// Live data: stream.js feeds the actual team via setGraphWorkflow /
// updateGraphAgent when the `workflow` / `agent_update` SSE events arrive;
// with no run yet the backdrop shows the IDLE scene — the root conducting one
// ghost node per sub-agent kind, so the mode's background already tells the
// story before the first request.

import { rotY, projectPoint } from "./space-core.js";
import { AGENT_KINDS } from "./orchestrator-core.js";

// ---- the per-kind wireframe styles ------------------------------------------
//
// Colors follow the symbol language: Deep Research nodes wear the Se/rver
// balloon's blue, Introspection nodes TIN's titanium slate, custom nodes (and
// the orchestrator root) the mode's baton violet. Failed nodes go the same
// muted red the workflow view uses.

export const GRAPH_STYLES = {
  root: { color: "#6d3fc4", glyph: "baton" },
  deep_research: { color: "#0d4fa0", glyph: "balloon" },
  introspection: { color: "#5f6b78", glyph: "tin" },
  custom: { color: "#6d3fc4", glyph: "diamond" },
};
export const FAILED_COLOR = "#b3455c";

const ROT_SPEED = 0.12; // rad/s — the slow turn
const BOB_SPEED = 0.9; // rad/s — the hover
const BOB_AMP = 7; // scene units
const RING_R = 130; // wave ring radius
const LEVEL_DY = 95; // vertical distance between root and waves
export const ROOT_ID = "__root";

// ---- scene build (pure) ------------------------------------------------------

/** Small deterministic phase per id so nodes don't bob in lockstep. @param {string} id */
function phaseOf(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 100) / 100 * Math.PI * 2;
}

/**
 * Build the 3D scene for a workflow: the root above, each wave a ring of
 * nodes below it, directed edges root→wave-0 plus every dependency edge.
 * Pure and deterministic.
 * @param {{ title?: string, agents?: Array<{id:string,kind:string,name:string,deps?:string[]}>, waves?: string[][] } | null} wf
 * @returns {{ title: string, nodes: Array<{id:string,kind:string,name:string,pos:[number,number,number],phase:number}>, edges: Array<{from:string,to:string}> }}
 */
export function buildGraphScene(wf) {
  if (!wf || !Array.isArray(wf.agents) || !wf.agents.length) return idleScene();
  const byId = new Map(wf.agents.map((a) => [a.id, a]));
  const waves = Array.isArray(wf.waves) && wf.waves.length ? wf.waves : [wf.agents.map((a) => a.id)];
  /** @type {Array<{id:string,kind:string,name:string,pos:[number,number,number],phase:number}>} */
  const nodes = [
    { id: ROOT_ID, kind: "root", name: wf.title || "Orchestrator", pos: [0, LEVEL_DY, 0], phase: phaseOf(ROOT_ID) },
  ];
  /** @type {Array<{from:string,to:string}>} */
  const edges = [];
  waves.forEach((wave, w) => {
    const n = wave.length || 1;
    wave.forEach((id, i) => {
      const a = byId.get(id);
      if (!a) return;
      // Even spread around the ring, offset per wave so stacked waves don't
      // line their nodes up into one visual column.
      const th = (Math.PI * 2 * i) / n + w * 0.7;
      const y = -w * LEVEL_DY * 0.75;
      nodes.push({
        id,
        kind: a.kind,
        name: a.name || id,
        pos: [RING_R * Math.cos(th), y, RING_R * Math.sin(th)],
        phase: phaseOf(id),
      });
      if (w === 0 && !(a.deps || []).length) edges.push({ from: ROOT_ID, to: id });
      for (const d of a.deps || []) if (byId.has(d)) edges.push({ from: d, to: id });
    });
  });
  return { title: wf.title || "", nodes, edges };
}

/**
 * The idle scene shown before any run: the orchestrator root conducting one
 * ghost node per sub-agent kind. @returns {ReturnType<typeof buildGraphScene>}
 */
export function idleScene() {
  const kinds = Object.keys(AGENT_KINDS);
  /** @type {Array<{id:string,kind:string,name:string,pos:[number,number,number],phase:number}>} */
  const nodes = [{ id: ROOT_ID, kind: "root", name: "Orchestrator", pos: [0, LEVEL_DY, 0], phase: phaseOf(ROOT_ID) }];
  /** @type {Array<{from:string,to:string}>} */
  const edges = [];
  kinds.forEach((k, i) => {
    const th = (Math.PI * 2 * i) / kinds.length;
    nodes.push({
      id: `idle-${k}`,
      kind: k,
      name: /** @type {any} */ (AGENT_KINDS)[k].label,
      pos: [RING_R * Math.cos(th), 0, RING_R * Math.sin(th)],
      phase: phaseOf(k),
    });
    edges.push({ from: ROOT_ID, to: `idle-${k}` });
  });
  return { title: "", nodes, edges };
}

// ---- per-frame geometry (pure) -----------------------------------------------

/**
 * Rotate, hover and project the scene for time `t` (seconds) onto a w×h
 * canvas. Returns nodes back-to-front (painter's order) with screen x/y and a
 * depth-scaled size, plus projected edges (each keeping the arrowhead spot at
 * 78% along the line). Pure — the draw loop below just strokes what this says.
 * @param {ReturnType<typeof buildGraphScene>} scene
 * @param {number} t
 * @param {{ w: number, h: number }} view
 */
export function graphFrame(scene, t, view) {
  const cam = { dist: 620, f: Math.min(view.w, view.h) * 0.85, cx: view.w / 2, cy: view.h * 0.44 };
  /** @type {Map<string, {x:number,y:number,s:number}>} */
  const proj = new Map();
  const nodes = [];
  for (const n of scene.nodes) {
    const rotated = rotY(n.pos, t * ROT_SPEED);
    const bobbed = /** @type {[number,number,number]} */ ([rotated[0], rotated[1] + BOB_AMP * Math.sin(t * BOB_SPEED + n.phase), rotated[2]]);
    const p = projectPoint(bobbed, cam);
    if (!p) continue;
    proj.set(n.id, p);
    nodes.push({ id: n.id, kind: n.kind, name: n.name, x: p.x, y: p.y, s: p.s });
  }
  nodes.sort((a, b) => a.s - b.s); // far (small scale) first
  const edges = [];
  for (const e of scene.edges) {
    const a = proj.get(e.from);
    const b = proj.get(e.to);
    if (!a || !b) continue;
    edges.push({
      from: e.from,
      to: e.to,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      ax: a.x + (b.x - a.x) * 0.78,
      ay: a.y + (b.y - a.y) * 0.78,
    });
  }
  return { nodes, edges };
}

// ---- DOM mount (browser glue — guarded, fail-soft) ---------------------------

/** @type {{ canvas: HTMLCanvasElement, raf: number, listeners: Array<() => void> } | null} */
let mounted = null;
let scene = idleScene();
/** @type {Record<string, { status?: string }>} */
let statuses = {};

/**
 * Feed the backdrop the live workflow (stream.js, on the `workflow` SSE
 * event). Null resets to the idle scene. No-op cost when not mounted — the
 * scene is module state the next mount picks up.
 * @param {any} wf
 * @param {Record<string, { status?: string }>} [sts] the SAME statuses object the workflow embed keeps
 */
export function setGraphWorkflow(wf, sts) {
  scene = buildGraphScene(wf);
  statuses = sts || {};
  drawOnce();
}

/** One node's lifecycle change (stream.js, on `agent_update`). @param {string} id @param {{ status?: string }} s */
export function updateGraphAgent(id, s) {
  statuses[id] = { ...statuses[id], ...s };
  drawOnce();
}

/** Mount the backdrop canvas behind the chat. Idempotent; fail-soft. */
export function mountGraphBackdrop() {
  try {
    if (mounted || !globalThis.document) return;
    const canvas = document.createElement("canvas");
    canvas.id = "graphbackdrop";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);
    const listeners = [];
    const onResize = () => { size(canvas); drawOnce(); };
    window.addEventListener("resize", onResize);
    listeners.push(() => window.removeEventListener("resize", onResize));
    mounted = { canvas, raf: 0, listeners };
    size(canvas);
    const reduced = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      drawOnce(); // a static frame; updates redraw it
    } else {
      const loop = () => {
        if (!mounted) return;
        if (!document.hidden) draw(performance.now() / 1000);
        mounted.raf = requestAnimationFrame(loop);
      };
      mounted.raf = requestAnimationFrame(loop);
    }
  } catch {
    /* no canvas — the mode works without its backdrop */
  }
}

/** Remove the backdrop (mode switched away). */
export function unmountGraphBackdrop() {
  if (!mounted) return;
  cancelAnimationFrame(mounted.raf);
  for (const off of mounted.listeners) off();
  mounted.canvas.remove();
  mounted = null;
}

/** @param {HTMLCanvasElement} canvas */
function size(canvas) {
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
}

function drawOnce() {
  if (mounted) draw(performance.now() / 1000);
}

/** @param {number} t seconds */
function draw(t) {
  if (!mounted) return;
  const ctx = mounted.canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = mounted.canvas.width / dpr;
  const h = mounted.canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const { nodes, edges } = graphFrame(scene, t, { w, h });

  // Edges first (behind the nodes), each directed: a line plus an arrowhead
  // near the target.
  ctx.lineWidth = 1;
  for (const e of edges) {
    ctx.strokeStyle = "rgba(60, 40, 110, 0.35)";
    ctx.beginPath();
    ctx.moveTo(e.x1, e.y1);
    ctx.lineTo(e.x2, e.y2);
    ctx.stroke();
    const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
    ctx.beginPath();
    ctx.moveTo(e.ax, e.ay);
    ctx.lineTo(e.ax - 7 * Math.cos(ang - 0.42), e.ay - 7 * Math.sin(ang - 0.42));
    ctx.moveTo(e.ax, e.ay);
    ctx.lineTo(e.ax - 7 * Math.cos(ang + 0.42), e.ay - 7 * Math.sin(ang + 0.42));
    ctx.stroke();
  }

  for (const n of nodes) {
    const style = /** @type {any} */ (GRAPH_STYLES)[n.kind] || GRAPH_STYLES.custom;
    const st = statuses[n.id]?.status || (n.id.startsWith("idle-") ? "idle" : "pending");
    const failed = st === "failed";
    const color = failed ? FAILED_COLOR : style.color;
    const r = 15 * n.s * 1.15;
    const alpha =
      st === "running" ? 0.55 + 0.35 * Math.abs(Math.sin(t * 2.4 + phaseOf(n.id)))
      : st === "done" || failed ? 0.85
      : st === "idle" ? 0.4
      : 0.45;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    drawGlyph(ctx, style.glyph, n.x, n.y, r);
    // Status mark beside the node: ✓ done, ✕ failed, pulsing ring while running.
    if (st === "done") mark(ctx, n.x + r + 4, n.y - r, r * 0.5, "check");
    else if (failed) mark(ctx, n.x + r + 4, n.y - r, r * 0.5, "cross");
    else if (st === "running") {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 5 + 2 * Math.sin(t * 2.4), 0, Math.PI * 2);
      ctx.globalAlpha = alpha * 0.5;
      ctx.stroke();
    }
    // Label
    ctx.globalAlpha = Math.min(alpha + 0.1, 0.7);
    ctx.fillStyle = color;
    ctx.font = `${Math.max(9, 10 * n.s)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(String(n.name).slice(0, 22), n.x, n.y + r + 13);
  }
  ctx.globalAlpha = 1;
}

/**
 * One wireframe glyph, stroke-only, centered at (x, y) with radius r.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} glyph
 * @param {number} x @param {number} y @param {number} r
 */
function drawGlyph(ctx, glyph, x, y, r) {
  ctx.beginPath();
  if (glyph === "balloon") {
    // The Se/rver balloon in miniature: envelope circle, two rigging lines, a basket.
    ctx.arc(x, y - r * 0.25, r * 0.75, 0, Math.PI * 2);
    ctx.moveTo(x - r * 0.4, y + r * 0.35);
    ctx.lineTo(x - r * 0.25, y + r * 0.75);
    ctx.moveTo(x + r * 0.4, y + r * 0.35);
    ctx.lineTo(x + r * 0.25, y + r * 0.75);
    ctx.rect(x - r * 0.3, y + r * 0.75, r * 0.6, r * 0.35);
  } else if (glyph === "tin") {
    // TIN in miniature: a rounded titanium head with two eyes and an antenna.
    // (roundRect is missing on older WebKit — the square head still reads.)
    if (typeof ctx.roundRect === "function") ctx.roundRect(x - r * 0.75, y - r * 0.6, r * 1.5, r * 1.3, r * 0.3);
    else ctx.rect(x - r * 0.75, y - r * 0.6, r * 1.5, r * 1.3);
    ctx.moveTo(x, y - r * 0.6);
    ctx.lineTo(x, y - r);
    ctx.moveTo(x - r * 0.28, y - r * 0.05);
    ctx.arc(x - r * 0.32, y - r * 0.05, r * 0.06, 0, Math.PI * 2);
    ctx.moveTo(x + r * 0.36, y - r * 0.05);
    ctx.arc(x + r * 0.32, y - r * 0.05, r * 0.06, 0, Math.PI * 2);
  } else if (glyph === "baton") {
    // The conductor's baton star: six rays from the center.
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * i) / 3 + Math.PI / 6;
      ctx.moveTo(x + r * 0.25 * Math.cos(a), y + r * 0.25 * Math.sin(a));
      ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.moveTo(x + r * 0.25, y);
    ctx.arc(x, y, r * 0.25, 0, Math.PI * 2);
  } else {
    // diamond — the custom specialist.
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.8, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r * 0.8, y);
    ctx.closePath();
  }
  ctx.stroke();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} r
 * @param {"check"|"cross"} kind
 */
function mark(ctx, x, y, r, kind) {
  ctx.beginPath();
  if (kind === "check") {
    ctx.moveTo(x - r, y);
    ctx.lineTo(x - r * 0.2, y + r * 0.7);
    ctx.lineTo(x + r, y - r * 0.6);
  } else {
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
  }
  ctx.stroke();
}
