// @ts-check
// The PIPELINE MAP's DOM side: the expandable in the left drawer that draws
// pipeline-map-core.js's graph and lights the nodes the current chat passes
// through (feedback #34, 2026-07-26).
//
// Shown in INTROSPECTION mode only — the mode whose whole subject is this
// site's own implementation. The gating follows the SDK showcase gallery's
// precedent in history-ui.js (one mode-owned block inside the shared drawer),
// and history-ui.js calls syncPipelineMap() from the same place it decides the
// drawer's flavour.
//
// The run state lives here, not in the drawer: the drawer is usually CLOSED
// while a chat runs, so stream.js keeps feeding events and the map renders
// whatever has accumulated the moment it is opened. Rendering is skipped
// entirely while the details element is collapsed (nothing to see, no work
// done), then caught up on expand — so a live chat costs nothing extra.
//
// Fail-soft throughout: every DOM lookup is guarded and returns quietly, so a
// page that never mounted the drawer (or a Node test importing this module)
// behaves as if the feature were off.

import {
  CLIENT_NODES,
  STREAM_OPEN_NODES,
  applyPipelineStatus,
  emptyPipelineRun,
  notePipelineMoves,
  pipelineMapSvg,
  pipelineRunSummary,
} from "./pipeline-map-core.js";

/** @typedef {import("./pipeline-map-core.js").PipelineRun} PipelineRun */

/** The run being drawn — one per send (reset by startPipelineRun). */
let run = emptyPipelineRun();
/** The `ticks` value already drawn, so an unchanged run never re-renders. */
let drawnTicks = -1;
/** True once the first event of this send arrived (the stream demonstrably opened). */
let streamSeen = false;

const MAP_ID = "pipelinemap";

/** @returns {HTMLDetailsElement|null} */
function mapEl() {
  try {
    return /** @type {HTMLDetailsElement|null} */ (document.getElementById(MAP_ID));
  } catch {
    return null; // no DOM (tests)
  }
}

/** The live run, for tests and for anything that wants to read the path taken. */
export function pipelineRun() {
  return run;
}

/**
 * A new send: clear the map and mark what this browser has already done by the
 * time the request leaves (composer → payload → POST). The server-side nodes
 * stay dark until an event proves they were reached.
 */
export function startPipelineRun() {
  run = emptyPipelineRun();
  streamSeen = false;
  notePipelineMoves(run, { enter: CLIENT_NODES, exit: CLIENT_NODES });
  render();
}

/**
 * One SSE status event from stream.js. The FIRST event of a send also settles
 * the front-door nodes: routing, validation and the quota gate all passed, or
 * there would be no stream carrying this event.
 * @param {{type?:string,id?:string,round?:number,route?:string}} status
 */
export function notePipelineStatus(status) {
  if (!streamSeen) {
    streamSeen = true;
    notePipelineMoves(run, { enter: STREAM_OPEN_NODES, exit: STREAM_OPEN_NODES });
  }
  applyPipelineStatus(run, status);
  render();
}

/**
 * The send ended without a `done` event (error, abort, dropped stream): stop
 * blinking. The path already taken stays lit — that is the useful part of a
 * failed run.
 */
export function endPipelineRun() {
  notePipelineMoves(run, { exit: Object.keys(run.active) });
  render();
}

/**
 * Show or hide the whole block for a mode, and draw it when it becomes visible.
 * Called by history-ui.js alongside the drawer's other per-mode flavouring.
 * @param {string} mode
 */
export function syncPipelineMap(mode) {
  const el = mapEl();
  if (!el) return;
  const on = mode === "introspection";
  el.hidden = !on;
  if (!on) {
    el.open = false;
    return;
  }
  drawnTicks = -1; // the drawer was re-flavoured; redraw from scratch
  render();
}

/** Draw the current run into the expandable, if it is visible and expanded. */
function render() {
  const el = mapEl();
  if (!el || el.hidden) return;
  const body = el.querySelector(".pipemap-body");
  const status = el.querySelector(".pipemap-status");
  if (!body) return;
  if (!el.open) {
    // Collapsed: keep the summary line honest (it shows through the marker's
    // own text) but skip the SVG entirely.
    if (status) status.textContent = pipelineRunSummary(run);
    return;
  }
  if (run.ticks === drawnTicks) return;
  drawnTicks = run.ticks;
  body.innerHTML = pipelineMapSvg(run);
  if (status) status.textContent = pipelineRunSummary(run);
  scrollToNewest(body);
}

/**
 * Keep the newest node in view inside the map's own scroll box — on a long
 * pipeline the live step is otherwise below the fold. Scrolls the CONTAINER
 * only (never the page), so opening the drawer mid-answer never moves the chat.
 * @param {Element} body
 */
function scrollToNewest(body) {
  if (!run.last) return;
  try {
    const node = body.querySelector(`[data-node="${run.last}"] rect`);
    if (!node) return;
    const y = Number(node.getAttribute("y")) || 0;
    const target = y - body.clientHeight / 2;
    body.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  } catch {
    /* no scrollTo (older browsers) / no layout — the map is still fully scrollable by hand */
  }
}

/**
 * Wire the expandable once at boot: draw on expand (the deferred render above),
 * and start visible in whatever mode the drawer is already flavoured for.
 * @param {{ getMode?: () => string }} [opts]
 */
export function initPipelineMap(opts = {}) {
  const el = mapEl();
  if (!el) return;
  el.addEventListener("toggle", () => {
    drawnTicks = -1;
    render();
  });
  if (opts.getMode) syncPipelineMap(opts.getMode());
}
