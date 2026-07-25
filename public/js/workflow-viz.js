// @ts-check
// The Orchestrator WORKFLOW view — the visualization of a sub-agent team
// working a request: one node per sub-agent, dependency edges between them,
// the waves as columns, and each node's live status (pending → running →
// done/failed). Fed by the `workflow` SSE event (the plan graph, once) and
// `agent_update` events (per-node lifecycle) — src/orchestrator.js emits,
// stream.js dispatches here.
//
// Pure-core convention (space-core.js / agent-spec-core.js): the layout math
// and the SVG string builder are I/O-free and Node-tested
// (workflow-viz.test.js); only renderWorkflow at the bottom touches the DOM.
// Like the map/quiz embeds, the rendered view is inserted into the TURN BODY
// (it persists beside the answer, not in the collapsing activity trace) and is
// recorded in the conversation-embeds registry (kind "workflow") so a reopened
// conversation shows the finished workflow again.

import { AGENT_KINDS } from "./orchestrator-core.js";

// ---- layout (pure) -----------------------------------------------------------

export const NODE_W = 156;
export const NODE_H = 46;
/**
 * A swarm node is taller: below its name and kind line it carries one dot per
 * on-device member plus the round/agreement readout, so the graph shows the
 * swarm THINKING (members lighting up, rounds advancing) rather than a single
 * box that sits at "running" for a minute.
 */
export const SWARM_NODE_H = 68;
const COL_GAP = 64;
const ROW_GAP = 16;
const PAD = 12;

/** The box height for one node — swarm nodes carry a member strip. @param {string} kind */
export function nodeHeight(kind) {
  return kind === "swarm" ? SWARM_NODE_H : NODE_H;
}

/**
 * Position a workflow's nodes: one COLUMN per wave, nodes stacked within it,
 * vertically centered per column; edges connect a dependency's right edge to
 * the dependent's left edge. Node heights vary by kind (nodeHeight), so a
 * column's stack is measured rather than multiplied. Pure and deterministic.
 * @param {{ agents: Array<{id:string,kind:string,name:string,task?:string,deps?:string[],swarmSize?:number}>, waves: string[][] }} wf
 * @returns {{ width: number, height: number,
 *   nodes: Array<{id:string,kind:string,name:string,task:string,x:number,y:number,h:number,swarmSize:number}>,
 *   edges: Array<{from:string,to:string,x1:number,y1:number,x2:number,y2:number}> }}
 */
export function layoutWorkflow(wf) {
  const waves = Array.isArray(wf?.waves) && wf.waves.length
    ? wf.waves
    : [(wf?.agents || []).map((a) => a.id)];
  const byId = new Map((wf?.agents || []).map((a) => [a.id, a]));
  const colHeight = (/** @type {string[]} */ wave) =>
    wave.reduce((sum, id) => sum + nodeHeight(byId.get(id)?.kind || ""), 0) + Math.max(0, wave.length - 1) * ROW_GAP;
  const tallest = Math.max(NODE_H, ...waves.map(colHeight));
  const height = PAD * 2 + tallest;
  const width = PAD * 2 + waves.length * NODE_W + (waves.length - 1) * COL_GAP;
  /** @type {Map<string, {x:number,y:number,h:number}>} */
  const pos = new Map();
  /** @type {Array<{id:string,kind:string,name:string,task:string,x:number,y:number,h:number,swarmSize:number}>} */
  const nodes = [];
  waves.forEach((wave, col) => {
    let y = PAD + (tallest - colHeight(wave)) / 2;
    wave.forEach((id) => {
      const a = byId.get(id);
      if (!a) return;
      const x = PAD + col * (NODE_W + COL_GAP);
      const h = nodeHeight(a.kind);
      pos.set(id, { x, y, h });
      nodes.push({
        id,
        kind: a.kind,
        name: a.name || id,
        task: a.task || "",
        x,
        y,
        h,
        swarmSize: a.kind === "swarm" ? Math.max(1, Math.min(12, Number(a.swarmSize) || 4)) : 0,
      });
      y += h + ROW_GAP;
    });
  });
  const edges = [];
  for (const a of wf?.agents || []) {
    for (const d of a.deps || []) {
      const from = pos.get(d);
      const to = pos.get(a.id);
      if (!from || !to) continue;
      edges.push({
        from: d,
        to: a.id,
        x1: from.x + NODE_W,
        y1: from.y + from.h / 2,
        x2: to.x,
        y2: to.y + to.h / 2,
      });
    }
  }
  return { width, height, nodes, edges };
}

// ---- SVG (pure string assembly, XSS-safe) ------------------------------------

/** Minimal escape for text interpolated into the SVG. @param {unknown} s */
function esc(s) {
  /** @type {Record<string,string>} */
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s ?? "").replace(/[&<>"']/g, (c) => map[c]);
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** The status glyph shown in a node's corner. @param {string} status */
export function statusGlyph(status) {
  return status === "done" ? "✓" : status === "failed" ? "✕" : status === "running" ? "◐" : status === "skipped" ? "–" : "○";
}

/**
 * The member strip of a swarm node: one dot per on-device member (live status
 * classed, so app.css animates the running ones) plus the round/agreement
 * readout. Pure string assembly — `swarm` is the live state the swarm_update
 * events carry (swarm-core.js swarmUpdateEvent), absent before the first one.
 * @param {{x:number,y:number,h:number,swarmSize:number}} n
 * @param {{ round?: number, rounds?: number, agreement?: number, members?: string[], phase?: string }} [swarm]
 * @returns {string}
 */
export function swarmStrip(n, swarm) {
  const states = Array.isArray(swarm?.members) && swarm.members.length
    ? swarm.members
    : Array.from({ length: n.swarmSize }, () => "pending");
  const y = n.y + n.h - 16;
  const step = Math.min(12, Math.max(7, Math.floor((NODE_W - 74) / Math.max(1, states.length))));
  const parts = states.slice(0, 12).map((st, i) =>
    `<circle class="wfmember wm-${esc(String(st))}" cx="${n.x + 12 + i * step}" cy="${y}" r="3.5"/>`,
  );
  // The readout is the swarm's honest self-report: which round it is on and how
  // far the members have converged (swarm-core.js agreementScore).
  const round = Number(swarm?.round) || 0;
  const rounds = Number(swarm?.rounds) || 0;
  const agreement = Number(swarm?.agreement) || 0;
  const readout = round
    ? `R${round}${rounds ? `/${rounds}` : ""}${agreement ? ` · ${Math.round(agreement * 100)}%` : ""}`
    : `×${states.length}`;
  parts.push(`<text class="wfswarm" x="${n.x + NODE_W - 10}" y="${y + 4}" text-anchor="end">${esc(readout)}</text>`);
  return parts.join("");
}

/**
 * The whole workflow as an SVG string. `statuses` maps agent id →
 * { status, duration_ms?, note?, swarm? } (absent = pending). Classed, not
 * styled: app.css owns the colors (`.wfnode.wf-done` etc.) so the mode themes
 * apply.
 * @param {{ title?: string, agents: any[], waves: string[][] }} wf
 * @param {Record<string, { status?: string, duration_ms?: number, note?: string, swarm?: any }>} [statuses]
 * @returns {string}
 */
export function workflowSvg(wf, statuses = {}) {
  const { width, height, nodes, edges } = layoutWorkflow(wf);
  const parts = [
    `<svg class="workflow-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Sub-agent workflow${wf?.title ? `: ${esc(wf.title)}` : ""}">`,
  ];
  for (const e of edges) {
    const mx = (e.x1 + e.x2) / 2;
    parts.push(
      `<path class="wfedge" d="M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}" fill="none"/>`,
    );
  }
  for (const n of nodes) {
    const st = statuses[n.id]?.status || "pending";
    const kindLabel = /** @type {any} */ (AGENT_KINDS)[n.kind]?.label || n.kind;
    const secs = statuses[n.id]?.duration_ms;
    const sub = st === "failed" && statuses[n.id]?.note
      ? clip(String(statuses[n.id]?.note), 24)
      : `${kindLabel}${Number.isFinite(secs) ? ` · ${(Number(secs) / 1000).toFixed(1)}s` : ""}`;
    const isSwarm = n.kind === "swarm";
    parts.push(
      `<g class="wfnode wf-${esc(st)}${isSwarm ? " wf-swarm" : ""}" data-agent="${esc(n.id)}">` +
        `<title>${esc(n.name)} — ${esc(kindLabel)}${isSwarm ? ` (${n.swarmSize} in-browser members)` : ""}${n.task ? `\n${esc(n.task)}` : ""}</title>` +
        `<rect x="${n.x}" y="${n.y}" width="${NODE_W}" height="${n.h}" rx="9"/>` +
        `<text class="wfname" x="${n.x + 10}" y="${n.y + 19}">${esc(clip(n.name, 18))}</text>` +
        `<text class="wfkind" x="${n.x + 10}" y="${n.y + 35}">${esc(sub)}</text>` +
        `<text class="wfglyph" x="${n.x + NODE_W - 16}" y="${n.y + 19}">${statusGlyph(st)}</text>` +
        (isSwarm ? swarmStrip(n, statuses[n.id]?.swarm) : "") +
      `</g>`,
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

// ---- DOM glue ----------------------------------------------------------------

/**
 * Render (or re-render) the workflow view into a turn's body, above the stats
 * row like the map embeds. Returns an update handle stream.js keeps on the
 * turn: each `agent_update` mutates the shared `statuses` object (the same
 * object recorded in the embeds registry, so persistence sees every update)
 * and repaints. Fail-soft: no DOM → null.
 * @param {{ el?: HTMLElement, stats?: HTMLElement }} turn
 * @param {{ title?: string, agents: any[], waves: string[][] }} wf
 * @param {Record<string, { status?: string, duration_ms?: number, note?: string }>} statuses
 * @returns {{ update: (id: string, s: { status?: string, duration_ms?: number, note?: string }) => void } | null}
 */
export function renderWorkflow(turn, wf, statuses) {
  try {
    if (!turn?.el || !globalThis.document) return null;
    const wrap = document.createElement("div");
    wrap.className = "workflow-embed";
    const label = document.createElement("div");
    label.className = "workflow-label";
    label.textContent = wf?.title ? `Sub-agent workflow — ${wf.title}` : "Sub-agent workflow";
    const box = document.createElement("div");
    box.className = "workflow-box";
    box.innerHTML = workflowSvg(wf, statuses);
    wrap.appendChild(label);
    wrap.appendChild(box);
    turn.el.insertBefore(wrap, turn.stats || null);
    return {
      update(id, s) {
        statuses[id] = { ...statuses[id], ...s };
        box.innerHTML = workflowSvg(wf, statuses);
      },
    };
  } catch {
    return null; // the activity steps still narrate the run
  }
}
