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
//
// The nodes are also INSPECTABLE (2026-07-26, feedback #35): tapping one opens
// a panel under the graph showing what that node is doing right now — its task,
// its persona, its searches as they land, and the prompt it is actually working
// on — updated live while the answer is still being generated. Tap it again to
// close, tap another to switch. The graph is the only place a sub-agent is
// visible at all, so this is where "what is that box doing" gets answered.

import { AGENT_KINDS, MAX_PROMPT_PREVIEW } from "./orchestrator-core.js";

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
 *
 * Every node is a BUTTON (focusable, `aria-expanded`): the inspector opens on
 * click or Enter/Space, and `opts.selected` marks the open one so a repaint
 * mid-run keeps the selection visible.
 * @param {{ title?: string, agents: any[], waves: string[][] }} wf
 * @param {Record<string, { status?: string, duration_ms?: number, note?: string, swarm?: any }>} [statuses]
 * @param {{ selected?: string }} [opts]
 * @returns {string}
 */
export function workflowSvg(wf, statuses = {}, opts = {}) {
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
    const open = opts.selected === n.id;
    parts.push(
      `<g class="wfnode wf-${esc(st)}${isSwarm ? " wf-swarm" : ""}${open ? " wf-selected" : ""}" data-agent="${esc(n.id)}"` +
        ` role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">` +
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

// ---- the node inspector (pure) -----------------------------------------------
//
// "Look inside this node." A workflow node is a whole sub-run — a task, a
// persona, planned searches, an upstream it reads and a downstream it feeds,
// and a prompt it is working on — and the box in the graph can hold none of
// that. The inspector is the same information as a VIEW MODEL (Node-tested)
// plus an escaped HTML string; renderWorkflow only mounts it.

/** How many search rows one node keeps. MAX_NODE_QUERIES is 2 today — this is
 * the bound on PERSISTED state, not a guess at the plan's appetite. */
export const MAX_NODE_SEARCH_ROWS = 8;

/** Node state → the word the inspector shows for it. */
export const STATUS_LABELS = {
  pending: "Waiting",
  running: "Running",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * The live one-liner: what this node is doing RIGHT NOW, in plain language.
 * Derived, never stored — the statuses map holds facts (status, searches,
 * prompt), this turns them into the sentence the panel leads with.
 * @param {{ kind?: string }} agent
 * @param {{ status?: string, note?: string, duration_ms?: number, chars?: number, prompt?: string, swarm?: any }} [st]
 * @param {Array<{ status?: string }>} [searches]
 * @returns {string}
 */
export function nodeActivity(agent, st = {}, searches = []) {
  const status = st.status || "pending";
  if (status === "pending") return "Waiting for its turn — an earlier stage has to finish first.";
  if (status === "skipped") return "Skipped.";
  if (status === "failed") return st.note ? `Failed — ${st.note}` : "Failed — the workflow continued without it.";
  if (status === "done") {
    const bits = [];
    if (Number(st.duration_ms)) bits.push(`${(Number(st.duration_ms) / 1000).toFixed(1)}s`);
    if (Number(st.chars)) bits.push(`${Number(st.chars)} characters`);
    return `Finished its brief${bits.length ? ` (${bits.join(", ")})` : ""}. It goes into the merged answer.`;
  }
  // Running: the phases a node passes through, newest evidence first.
  if (agent?.kind === "swarm") {
    const round = Number(st.swarm?.round) || 0;
    const rounds = Number(st.swarm?.rounds) || 0;
    const agreement = Number(st.swarm?.agreement) || 0;
    if (round) {
      return `Reasoning in your browser — round ${round}${rounds ? ` of ${rounds}` : ""}` +
        `${agreement ? `, ${Math.round(agreement * 100)}% agreement so far` : ""}.`;
    }
    return "Starting a swarm of small models in your browser.";
  }
  const open = searches.filter((s) => s?.status !== "done").length;
  if (open) return `Searching the web — ${open} quer${open === 1 ? "y" : "ies"} still running.`;
  if (st.prompt) return "Writing its brief from the prompt below.";
  if (agent?.kind === "web_research") return "Gathering sources for its task.";
  if (agent?.kind === "introspection") return "Retrieving the matching excerpts from this site's own source.";
  return "Working on its task.";
}

/**
 * Everything the panel shows for ONE node, assembled from the plan (what was
 * decided up front) and the statuses map (what has happened since). Returns
 * null for an id the plan doesn't contain — a stale selection closes rather
 * than renders an empty box.
 * @param {{ title?: string, agents?: any[], waves?: string[][] }} wf
 * @param {string} id
 * @param {Record<string, any>} [statuses]
 * @returns {null | {
 *   id: string, name: string, kind: string, kindLabel: string,
 *   status: string, statusLabel: string, glyph: string, activity: string,
 *   wave: number, waves: number, task: string, persona: string,
 *   queries: string[], deps: Array<{id:string,name:string}>, feeds: Array<{id:string,name:string}>,
 *   searches: Array<{q:string,status:string,results:number,ms:number}>,
 *   prompt: string, promptChars: number, promptTruncated: boolean,
 *   durationMs: number, chars: number, note: string, swarm: any,
 * }}
 */
export function inspectorModel(wf, id, statuses = {}) {
  const agents = Array.isArray(wf?.agents) ? wf.agents : [];
  const agent = agents.find((a) => a && a.id === id);
  if (!agent) return null;
  const nameOf = (/** @type {string} */ aid) => agents.find((a) => a && a.id === aid)?.name || aid;
  const waves = Array.isArray(wf?.waves) && wf.waves.length ? wf.waves : [agents.map((a) => a?.id)];
  const st = statuses?.[id] || {};
  const status = st.status || "pending";
  const searches = Array.isArray(st.searches) ? st.searches : [];
  const prompt = String(st.prompt || "");
  const promptChars = Number(st.prompt_chars) || prompt.length;
  return {
    id,
    name: agent.name || id,
    kind: agent.kind || "custom",
    kindLabel: /** @type {any} */ (AGENT_KINDS)[agent.kind]?.label || agent.kind || "Custom",
    status,
    statusLabel: /** @type {any} */ (STATUS_LABELS)[status] || status,
    glyph: statusGlyph(status),
    activity: nodeActivity(agent, st, searches),
    wave: waves.findIndex((w) => Array.isArray(w) && w.includes(id)) + 1,
    waves: waves.length,
    task: agent.task || "",
    persona: agent.persona || "",
    queries: Array.isArray(agent.queries) ? agent.queries : [],
    deps: (Array.isArray(agent.deps) ? agent.deps : []).map((/** @type {string} */ d) => ({ id: d, name: nameOf(d) })),
    feeds: agents
      .filter((a) => a && Array.isArray(a.deps) && a.deps.includes(id))
      .map((a) => ({ id: a.id, name: a.name || a.id })),
    searches,
    prompt,
    promptChars,
    promptTruncated: promptChars > prompt.length,
    durationMs: Number(st.duration_ms) || 0,
    chars: Number(st.chars) || 0,
    note: String(st.note || ""),
    swarm: st.swarm || null,
  };
}

/** One labelled row of the panel, omitted entirely when it has nothing to say.
 * @param {string} label @param {string} valueHtml @param {string} [cls] */
function row(label, valueHtml, cls = "") {
  if (!valueHtml) return "";
  return `<div class="wfi-row${cls ? ` ${cls}` : ""}"><div class="wfi-k">${esc(label)}</div><div class="wfi-v">${valueHtml}</div></div>`;
}

/**
 * The inspector panel as an escaped HTML string. Same discipline as
 * workflowSvg: every interpolation goes through esc, so a plan-model-authored
 * name or a search query can never be markup.
 * @param {ReturnType<typeof inspectorModel>} m
 * @returns {string}
 */
export function inspectorHtml(m) {
  if (!m) return "";
  const stage = m.wave > 0 && m.waves > 1 ? ` · stage ${m.wave} of ${m.waves}` : "";
  const queries = m.searches.length
    ? m.searches
        .map((s) => {
          const done = s.status === "done";
          const tail = done
            ? ` <span class="wfi-dim">${esc(String(Number(s.results) || 0))} result${Number(s.results) === 1 ? "" : "s"}` +
              `${Number(s.ms) ? ` · ${(Number(s.ms) / 1000).toFixed(1)}s` : ""}</span>`
            : ` <span class="wfi-dim">searching…</span>`;
          return `<li class="wfi-q ${done ? "wfi-q-done" : "wfi-q-running"}">${esc(clip(String(s.q || ""), 90))}${tail}</li>`;
        })
        .join("")
    : // Before the first search event lands, the PLAN's queries are what the
      // node is about to run — showing them is the difference between an empty
      // panel and one that says what is coming.
      m.queries.map((q) => `<li class="wfi-q wfi-q-planned">${esc(clip(String(q), 90))} <span class="wfi-dim">planned</span></li>`).join("");
  const link = (/** @type {{id:string,name:string}} */ n) =>
    `<button type="button" class="wfi-link" data-wf-goto="${esc(n.id)}">${esc(clip(n.name, 30))}</button>`;
  return [
    `<div class="wfi-head">`,
    `<span class="wfi-name">${esc(clip(m.name, 48))}</span>`,
    `<span class="wfi-meta">${esc(m.kindLabel)}${esc(stage)}</span>`,
    `<button type="button" class="wfi-close" data-wf-close aria-label="Close this node">✕</button>`,
    `</div>`,
    `<div class="wfi-state wf-${esc(m.status)}"><span class="wfi-glyph">${m.glyph}</span> <strong>${esc(m.statusLabel)}</strong> — ${esc(m.activity)}</div>`,
    row("Task", m.task ? `<p>${esc(m.task)}</p>` : ""),
    row("Persona", m.persona ? `<p>${esc(m.persona)}</p>` : ""),
    row("Web searches", queries ? `<ul class="wfi-queries">${queries}</ul>` : ""),
    row("Reads from", m.deps.length ? m.deps.map(link).join(" ") : ""),
    row("Feeds", m.feeds.length ? m.feeds.map(link).join(" ") : ""),
    row(
      "Prompt being worked on",
      m.prompt
        ? `<pre class="wfi-prompt">${esc(m.prompt)}</pre>` +
          (m.promptTruncated
            ? `<p class="wfi-dim">Showing the first ${MAX_PROMPT_PREVIEW} of ${m.promptChars} characters — the rest is the grounding (search results or source excerpts), listed among this answer's sources.</p>`
            : "")
        : m.status === "pending" || m.status === "running"
          ? `<p class="wfi-dim">Assembled once this node's grounding is in.</p>`
          : "",
    ),
  ].join("");
}

// ---- DOM glue ----------------------------------------------------------------

/**
 * Render (or re-render) the workflow view into a turn's body, above the stats
 * row like the map embeds. Returns an update handle stream.js keeps on the
 * turn: each `agent_update` mutates the shared `statuses` object (the same
 * object recorded in the embeds registry, so persistence sees every update)
 * and repaints. Fail-soft: no DOM → null.
 *
 * The nodes are clickable — the open one's inspector repaints on every update
 * too, which is what makes it a LIVE view rather than a snapshot taken when it
 * was opened.
 * @param {{ el?: HTMLElement, stats?: HTMLElement }} turn
 * @param {{ title?: string, agents: any[], waves: string[][] }} wf
 * @param {Record<string, { status?: string, duration_ms?: number, note?: string, chars?: number, prompt?: string, prompt_chars?: number, searches?: any[], swarm?: any }>} statuses
 * @returns {{
 *   update: (id: string, s: { status?: string, duration_ms?: number, note?: string, chars?: number, prompt?: string, prompt_chars?: number, swarm?: any }) => void,
 *   search: (id: string, ev: any) => void,
 *   open: (id: string) => void,
 *   close: () => void,
 * } | null}
 */
export function renderWorkflow(turn, wf, statuses) {
  try {
    if (!turn?.el || !globalThis.document) return null;
    // One workflow view per turn: a second render (a replay racing the live
    // plan, a re-adopted embed) must REPLACE the first, not stack another
    // SVG — and its update handle — under the same answer.
    for (const old of turn.el.querySelectorAll?.(".workflow-embed") || []) old.remove();
    const wrap = document.createElement("div");
    wrap.className = "workflow-embed";
    const label = document.createElement("div");
    label.className = "workflow-label";
    label.textContent = wf?.title ? `Sub-agent workflow — ${wf.title}` : "Sub-agent workflow";
    // Discoverability: the boxes look like a diagram, so say they are not.
    const hint = document.createElement("span");
    hint.className = "workflow-hint";
    hint.textContent = "tap a node to look inside";
    label.appendChild(hint);
    const box = document.createElement("div");
    box.className = "workflow-box";
    const panel = document.createElement("div");
    panel.className = "workflow-inspect";
    panel.hidden = true;
    let selected = "";
    let painted = workflowSvg(wf, statuses, { selected });
    let panelHtml = "";
    box.innerHTML = painted;
    wrap.appendChild(label);
    wrap.appendChild(box);
    wrap.appendChild(panel);
    turn.el.insertBefore(wrap, turn.stats || null);

    const paintPanel = () => {
      if (!selected) {
        if (panel.hidden) return;
        panel.hidden = true;
        panel.innerHTML = "";
        panelHtml = "";
        return;
      }
      const model = inspectorModel(wf, selected, statuses);
      if (!model) { selected = ""; paintPanel(); return; } // a stale id closes
      const next = inspectorHtml(model);
      if (next === panelHtml && !panel.hidden) return;
      panelHtml = next;
      panel.innerHTML = next;
      panel.hidden = false;
    };
    const paint = () => {
      const next = workflowSvg(wf, statuses, { selected });
      // A local swarm publishes on every member state change; most of those
      // repaint to the identical picture. Reparsing the SVG for each one is
      // pure churn on the device least able to afford it, so paint only when
      // the drawing actually changed. The PANEL is compared separately — it
      // shows fields (the prompt, search results) the boxes never draw, so it
      // has to repaint on updates the graph can ignore.
      if (next !== painted) {
        painted = next;
        box.innerHTML = next;
      }
      paintPanel();
    };
    const select = (/** @type {string} */ id) => {
      selected = selected === id ? "" : id; // tap the open one to close it
      paint();
    };

    box.addEventListener("click", (ev) => {
      const g = /** @type {Element | null} */ (ev.target)?.closest?.(".wfnode[data-agent]");
      const id = g?.getAttribute("data-agent");
      if (id) select(id);
    });
    // Keyboard parity: the nodes are role="button" tabindex="0", so they have
    // to answer Enter and Space like one.
    box.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      const g = /** @type {Element | null} */ (ev.target)?.closest?.(".wfnode[data-agent]");
      const id = g?.getAttribute("data-agent");
      if (!id) return;
      ev.preventDefault(); // Space would scroll the page
      select(id);
    });
    panel.addEventListener("click", (ev) => {
      const el = /** @type {Element | null} */ (ev.target)?.closest?.("[data-wf-close],[data-wf-goto]");
      if (!el) return;
      // "Reads from" / "Feeds" are the graph's edges as buttons: walking the
      // team is the point of opening a node in the first place.
      const goto = el.getAttribute("data-wf-goto");
      if (goto) { selected = goto; paint(); return; }
      selected = "";
      paint();
    });

    return {
      update(id, s) {
        statuses[id] = { ...statuses[id], ...nodeRenderState(s) };
        paint();
      },
      search(id, ev) {
        const cur = statuses[id] || {};
        statuses[id] = { ...cur, searches: mergeSearch(/** @type {any} */ (cur).searches, ev) };
        paint();
      },
      open(id) { selected = id; paint(); },
      close() { selected = ""; paint(); },
    };
  } catch {
    return null; // the activity steps still narrate the run
  }
}

/**
 * The fields of an `agent_update` the view actually keeps — the same bounding
 * discipline as swarmRenderState, and for the same reason: `statuses` is
 * PERSISTED with the turn, so an event gaining a field must not silently grow
 * every stored conversation. The prompt is clamped again here because the
 * event's own clamp is the server's promise, not this client's.
 * @param {any} s
 * @returns {Record<string, any>}
 */
export function nodeRenderState(s) {
  /** @type {Record<string, any>} */
  const out = {};
  if (s?.status) out.status = String(s.status);
  if (Number.isFinite(Number(s?.duration_ms))) out.duration_ms = Number(s.duration_ms);
  if (Number.isFinite(Number(s?.chars))) out.chars = Number(s.chars);
  if (s?.note) out.note = String(s.note).slice(0, 200);
  if (s?.prompt) {
    out.prompt = String(s.prompt).slice(0, MAX_PROMPT_PREVIEW);
    out.prompt_chars = Number(s.prompt_chars) || String(s.prompt).length;
  }
  if (s?.swarm) out.swarm = swarmRenderState(s.swarm);
  return out;
}

/**
 * Fold one search_start / search_done event into a node's search list, keyed by
 * query so the `done` row replaces its own `start` row instead of appending a
 * duplicate. Bounded (MAX_NODE_SEARCH_ROWS) — persisted state again.
 * @param {any[] | undefined} list
 * @param {{ type?: string, query?: string, results?: number, duration_ms?: number }} ev
 * @returns {Array<{q:string,status:string,results:number,ms:number}>}
 */
export function mergeSearch(list, ev) {
  const out = (Array.isArray(list) ? list : []).slice(0, MAX_NODE_SEARCH_ROWS);
  const q = String(ev?.query || "").slice(0, 160);
  if (!q) return out;
  const done = ev?.type === "search_done";
  const at = out.findIndex((s) => s?.q === q);
  const next = {
    q,
    status: done ? "done" : "running",
    results: done ? Number(ev?.results) || 0 : Number(out[at]?.results) || 0,
    ms: done ? Number(ev?.duration_ms) || 0 : Number(out[at]?.ms) || 0,
  };
  if (at >= 0) out[at] = next;
  else if (out.length < MAX_NODE_SEARCH_ROWS) out.push(next);
  return out;
}

/**
 * The swarm fields the strip actually draws — nothing else. `statuses` is the
 * object recorded in the conversation-embeds registry and PERSISTED with the
 * turn, so keeping whole swarm_update events (model label, type tag, and
 * whatever a future event adds) grows stored state for the life of a run for
 * no visible benefit.
 * @param {any} s
 */
export function swarmRenderState(s) {
  return {
    round: Number(s?.round) || 0,
    rounds: Number(s?.rounds) || 0,
    agreement: Number(s?.agreement) || 0,
    phase: String(s?.phase || "").slice(0, 40),
    members: (Array.isArray(s?.members) ? s.members : []).slice(0, 12).map((/** @type {any} */ m) => String(m).slice(0, 12)),
  };
}
