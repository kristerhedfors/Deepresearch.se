// The AGENT ACTIVITY BACKDROP — the DOM half of the feature (pure model +
// preference logic live in agent-backdrop-core.js). NOT `// @ts-check`: this is
// browser glue (document/localStorage), guarded so importing it in Node — which
// happens transitively via sandbox.js ← drc-research.js, a Node-tested module —
// never touches a browser global at load time.
//
// Instead of popping the sandbox terminal open (which covered the screen and
// broke the prompt-first flow), the raw commands and output the agent runs
// drift faintly across the page's sky-blue background, and — THIS is the whole
// UX — a small TRANSPARENCY BAR appears while the terminal is running so the
// user tunes how visible that layer is, right there, live. There is NO settings
// entry: the bar IS the control, shown only during activity and auto-hidden
// when the terminal goes quiet. When the layer is turned all the way off (0),
// the text layer is not built or rendered at all (optimized away) — only the
// tiny bar shows, so the user can bring it back.
//
// The single feed point is execInSandbox in sandbox.js, so BOTH tiers (DRS and
// DRC) and any agent that runs commands surface here automatically. Callers may
// pass a channel id per agent; when several are active the layer clips between
// them. The chosen transparency is remembered per browser (localStorage) so the
// bar comes back where the user left it — but it is never a config screen.

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
// How long the transparency bar lingers after the last command before it
// auto-hides (the terminal has gone quiet). Kept alive while the user is
// touching it.
const BAR_HIDE_MS = 6000;

const model = createBackdropModel();
let layer = null; // the fixed background text element (built lazily, only when on)
let pre = null; // the <pre> the active channel renders into
let bar = null; // the floating transparency slider (built lazily on first activity)
let barRange = null;
let barVal = null;
let clipTimer = 0; // round-robin between channels when >1 is active
let hideTimer = 0; // auto-hide the bar after inactivity
let interacting = false; // user is touching the bar — don't auto-hide
let pref = null; // cached opacity percentage (lazy-read from localStorage)

// ---- preference persistence (remembered position, NOT a settings screen) ----

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

function valLabel(pct) {
  return pct <= 0 ? "Off" : pct + "%";
}

/** The current transparency (0..100) — remembered slider position. */
export function backdropOpacityPct() {
  return readPref();
}

/** Whether the layer is enabled (non-zero). */
export function backdropOn() {
  return backdropEnabled(readPref());
}

/**
 * Set the transparency (0..100), persist it, and apply it live. 0 removes the
 * text layer from view (and skips building it). Used by the bar's slider.
 * @param {number} pct
 */
export function setBackdropOpacity(pct) {
  const v = parseOpacityPref(pct);
  writePref(v);
  applyPref();
}

// ---- the background text layer ----------------------------------------------

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

// Apply the current preference to the world: build/show the text layer when on,
// hide it when off (0) — the "if not shown at all, just optimize that case".
function applyPref() {
  if (backdropOn()) {
    ensureLayer();
    render();
    applyOpacity();
    syncClipTimer();
  } else {
    applyOpacity(); // hides the layer if it exists; nothing built if it doesn't
    syncClipTimer();
  }
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

// ---- the floating transparency bar (the whole UX) ---------------------------

function ensureBar() {
  if (bar || typeof document === "undefined" || !document.body) return bar;
  bar = document.createElement("div");
  bar.id = "dr-backdrop-bar";
  bar.className = "dr-backdrop-bar";
  bar.hidden = true;

  const icon = document.createElement("span");
  icon.className = "dr-backdrop-bar-icon";
  icon.textContent = "◐";
  icon.title = "Sandbox terminal — background transparency";

  barRange = document.createElement("input");
  barRange.type = "range";
  barRange.min = "0";
  barRange.max = "100";
  barRange.step = "1";
  barRange.className = "dr-backdrop-range";
  barRange.setAttribute("aria-label", "Terminal backdrop transparency");
  barRange.value = String(readPref());

  barVal = document.createElement("span");
  barVal.className = "dr-backdrop-bar-val";
  barVal.textContent = valLabel(readPref());

  barRange.addEventListener("input", () => {
    const pct = Number(barRange.value) || 0;
    setBackdropOpacity(pct);
    if (barVal) barVal.textContent = valLabel(pct);
    interacting = true;
    keepBarAlive();
  });
  barRange.addEventListener("change", () => { interacting = false; scheduleHide(); });
  bar.addEventListener("pointerenter", () => { interacting = true; showBar(); });
  bar.addEventListener("pointerleave", () => { interacting = false; scheduleHide(); });

  bar.appendChild(icon);
  bar.appendChild(barRange);
  bar.appendChild(barVal);
  document.body.appendChild(bar);
  return bar;
}

function showBar() {
  ensureBar();
  if (!bar) return;
  if (barRange) barRange.value = String(readPref());
  if (barVal) barVal.textContent = valLabel(readPref());
  bar.hidden = false;
  keepBarAlive();
}

function keepBarAlive() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
  scheduleHide();
}

function scheduleHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
  if (interacting || typeof setTimeout === "undefined") return;
  hideTimer = setTimeout(() => {
    if (bar && !interacting) bar.hidden = true;
  }, BAR_HIDE_MS);
}

// ---- the feed (called from execInSandbox) -----------------------------------

// A command or its output arrived → the terminal is running: show the bar (the
// control), and — only when the layer isn't turned off — build/render the faint
// text. At 0 the bar still shows so the user can bring the layer back, but no
// text layer is built or updated (the optimized case).
function feed(fn, channel, payload) {
  try {
    showBar();
    if (!backdropOn()) return; // off — optimize: skip the text layer entirely
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
