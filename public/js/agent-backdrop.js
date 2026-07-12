// The AGENT ACTIVITY BACKDROP — the DOM half of the feature (pure model +
// preference logic live in agent-backdrop-core.js). NOT `// @ts-check`: this is
// browser glue (document/localStorage), guarded so importing it in Node — which
// happens transitively via sandbox.js ← drc-research.js, a Node-tested module —
// never touches a browser global at load time.
//
// Instead of popping the sandbox terminal open (which covered the screen and
// broke the prompt-first flow), the raw commands and output the agent runs
// drift faintly across the page's sky-blue background. The user stays in the
// composer and still sees what's happening. A settings slider tunes the
// transparency for every user (localStorage, so it works signed-out and on
// /cure too); 0 turns the layer off entirely.
//
// The single feed point is execInSandbox in sandbox.js, so BOTH tiers (DRS and
// DRC) and any agent that runs commands surface here automatically — no
// callback threading through stream.js / drc-research.js. Callers may pass a
// channel id per agent; when several are active the layer clips between them.

import {
  CHANNEL_CLIP_MS,
  activeLines,
  backdropEnabled,
  channelCount,
  clipToNextChannel,
  createBackdropModel,
  opacityCss,
  parseOpacityPref,
  pushCommand,
  pushResult,
} from "./agent-backdrop-core.js";

const STORE_KEY = "dr_agent_backdrop";

const model = createBackdropModel();
let layer = null; // the fixed background element
let pre = null; // the <pre> the active channel renders into
let clipTimer = 0; // round-robin between channels when >1 is active
let pref = null; // cached opacity percentage (lazy-read from localStorage)

// ---- preference persistence -------------------------------------------------

function readPref() {
  if (pref != null) return pref;
  let raw = null;
  try {
    if (typeof localStorage !== "undefined") raw = localStorage.getItem(STORE_KEY);
  } catch { /* private mode / disabled storage */ }
  pref = parseOpacityPref(raw);
  return pref;
}

function writePref(pct) {
  pref = pct;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORE_KEY, String(pct));
  } catch { /* ignore */ }
}

/** The current transparency setting (0..100). Read by the settings slider. */
export function backdropOpacityPct() {
  return readPref();
}

/** Whether the layer is enabled (non-zero) — read by the settings label. */
export function backdropOn() {
  return backdropEnabled(readPref());
}

/**
 * Set the transparency (0..100) from the settings slider, persist it, and apply
 * it live. 0 removes the layer from view.
 * @param {number} pct
 */
export function setBackdropOpacity(pct) {
  const v = parseOpacityPref(pct);
  writePref(v);
  applyOpacity();
}

// ---- DOM --------------------------------------------------------------------

function ensureLayer() {
  if (layer || typeof document === "undefined" || !document.body) return layer;
  layer = document.createElement("div");
  layer.id = "dr-agent-backdrop";
  layer.setAttribute("aria-hidden", "true");
  pre = document.createElement("pre");
  pre.className = "dr-agent-backdrop-text";
  layer.appendChild(pre);
  document.body.appendChild(layer);
  applyOpacity();
  return layer;
}

function applyOpacity() {
  if (!layer) return;
  const pct = readPref();
  if (!backdropEnabled(pct)) {
    layer.style.display = "none";
    return;
  }
  layer.style.display = "";
  layer.style.opacity = String(opacityCss(pct));
}

function render() {
  if (!pre) return;
  // Newest at the bottom, like a real terminal tail; the CSS clips the top so
  // the visible window is always the most recent work.
  pre.textContent = activeLines(model).join("\n");
}

// Start/stop the round-robin that clips between agents. Only runs when more
// than one channel is active AND the layer is visible.
function syncClipTimer() {
  const shouldRun = channelCount(model) > 1 && backdropOn() && typeof setInterval !== "undefined";
  if (shouldRun && !clipTimer) {
    clipTimer = setInterval(() => {
      clipToNextChannel(model);
      render();
    }, CHANNEL_CLIP_MS);
  } else if (!shouldRun && clipTimer) {
    clearInterval(clipTimer);
    clipTimer = 0;
  }
}

// A fresh command feeds its own channel and immediately focuses it (the model
// makes the newest-active channel win), so live work always shows even while
// the clip timer is mid-cycle between older channels.
function feed(fn, channel, payload) {
  try {
    if (!backdropOn()) return; // layer off — don't even build the DOM
    ensureLayer();
    fn(model, channel || "shell", payload);
    render();
    syncClipTimer();
  } catch { /* the backdrop is decoration — never break the caller */ }
}

/** Show a proposed command (`$ cmd`) on the given agent's channel. */
export function feedCommand(channel, command) {
  feed(pushCommand, channel, command);
}

/** Show a finished command's raw stdout/stderr on the given agent's channel. */
export function feedResult(channel, run) {
  feed(pushResult, channel, run);
}
