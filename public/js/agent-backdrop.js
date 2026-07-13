// The AGENT ACTIVITY BACKDROP — the DOM half of the feature (pure model +
// preference logic live in agent-backdrop-core.js). NOT `// @ts-check`: this is
// browser glue (document/localStorage), guarded so importing it in Node — which
// happens transitively via sandbox.js ← drc-research.js, a Node-tested module —
// never touches a browser global at load time.
//
// Instead of popping the sandbox terminal open (which covered the screen and
// broke the prompt-first flow), the raw commands and output the agent runs
// drift faintly across the page's sky-blue background, and a small TRANSPARENCY
// BAR appears while the terminal is running so the user tunes how visible that
// layer is, right there, live. The bar is shown only during activity and
// auto-hidden when the terminal goes quiet. When the layer is turned all the
// way off (0), the text layer is not built or rendered at all (optimized away)
// — only the tiny bar shows, so the user can bring it back.
//
// The Settings view (account-settings.js) also carries the SAME control — a
// slider grayed out until the execution sandbox is on — so the preference is
// discoverable when the terminal isn't running; both write the one per-browser
// value below (setBackdropOpacity), so they stay in lockstep.
//
// The single feed point is execInSandbox in sandbox.js, so BOTH tiers (DRS and
// DRC) and any agent that runs commands surface here automatically. Callers may
// pass a channel id per agent; when several are active the layer clips between
// them. The chosen transparency is remembered per browser (localStorage) so the
// bar comes back where the user left it.
//
// SCROLLING: the log is no longer a fixed tail. A wheel/drag over the empty page
// field pages BACK through the command history (the conversation bubbles keep
// their own native scroll — touching a bubble scrolls the convo, not the
// backdrop). While the backdrop scrolls, the conversation leans the opposite way
// ever so slightly and springs back — purely for feel; it never fights the
// user's own message scrolling. The newest command line sits ABOVE the composer
// (the CSS raises the viewport) so it's visible, not hidden behind the input.

import {
  CHANNEL_CLIP_MS,
  activeLines,
  backdropEnabled,
  channelCount,
  clipToNextChannel,
  createBackdropModel,
  opacityCss,
  parallaxNudge,
  parseOpacityPref,
  pushCommand,
  pushResult,
  scrollStep,
} from "./agent-backdrop-core.js";

const STORE_KEY = "dr_agent_backdrop";
// How long the transparency bar lingers after the last command before it
// auto-hides (the terminal has gone quiet). Kept alive while the user is
// touching it.
const BAR_HIDE_MS = 6000;

const model = createBackdropModel();
let layer = null; // the fixed background layer (built lazily, only when on)
let view = null; // the clipped viewport window (sizes/positions the text)
let scroller = null; // the inner element we translate to scroll the log
let pre = null; // the <pre> the active channel renders into
let bar = null; // the floating transparency slider (built lazily on first activity)
let barRange = null;
let barVal = null;
let clipTimer = 0; // round-robin between channels when >1 is active
let hideTimer = 0; // auto-hide the bar after inactivity
let interacting = false; // user is touching the bar — don't auto-hide
let pref = null; // cached opacity percentage (lazy-read from localStorage)

// Backdrop scroll state: bgOffset px scrolled back into the log (0 = pinned to
// the live tail), bgPinned tracks whether we're still following the newest.
let bgOffset = 0;
let bgPinned = true;
let scrollWired = false; // wheel/touch listeners attached once
let parallaxTimer = 0; // springs the conversation's opposite lean back to zero

// ---- preference persistence (one per-browser value; the floating bar AND the
//      Settings-view slider both read/write it) ----

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
  // viewport (clips + positions) → scroller (translated to scroll) → pre (text +
  // the drift animation). Splitting scroll from the animated <pre> keeps the two
  // transforms from fighting over one element.
  view = document.createElement("div");
  view.className = "dr-agent-backdrop-text";
  scroller = document.createElement("div");
  scroller.className = "dr-agent-backdrop-scroll";
  pre = document.createElement("pre");
  pre.className = "dr-agent-backdrop-pre";
  scroller.appendChild(pre);
  view.appendChild(scroller);
  layer.appendChild(view);
  document.body.appendChild(layer);
  applyOpacity();
  wireScroll();
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
  // Fresh output re-pins to the live tail unless the user has scrolled back to
  // read history; either way keep the offset inside the (now-changed) range.
  if (bgPinned) bgOffset = 0;
  applyBgScroll();
}

// ---- scrolling the command log ----------------------------------------------
// The log can be scrolled BACK over the empty page field, while the
// conversation bubbles keep their own native scroll. Scrolling the backdrop
// also nudges the messages the opposite way, ever so slightly, for feel.

// How far the log can scroll back from the live tail (px). Measured from the
// live DOM so it tracks the current line count / viewport height.
function maxBgOffset() {
  if (!pre || !view) return 0;
  return Math.max(0, pre.scrollHeight - view.clientHeight);
}

function applyBgScroll() {
  if (!scroller) return;
  bgOffset = Math.min(bgOffset, maxBgOffset());
  // translateY down pushes the tail below the window and reveals older lines
  // fading in from the top.
  scroller.style.transform = "translateY(" + bgOffset + "px)";
}

// Conversation bubbles / interactive chrome — a wheel or drag over any of these
// scrolls the CONVERSATION (native), never the backdrop.
const CONVO_SEL =
  ".msg, .step, .activity, #jumpdown, header, #footer, #composer, " +
  ".history, #account, .account-card, .project-panel, #drspop, #intro, #drawer";

function onConvo(target) {
  return !!(target && target.closest && target.closest(CONVO_SEL));
}

// A tiny, springy opposite lean applied to the conversation while the backdrop
// scrolls — purely for feel, eased back to zero so it never displaces the gap
// the user is reading in (public/js/agent-backdrop-core.js parallaxNudge).
function nudgeConversation(deltaY) {
  const chat = typeof document !== "undefined" ? document.getElementById("chat") : null;
  if (!chat) return;
  chat.style.transform = "translateY(" + parallaxNudge(deltaY) + "px)";
  chat.style.transition = "transform .08s ease-out";
  if (parallaxTimer) clearTimeout(parallaxTimer);
  parallaxTimer = setTimeout(() => {
    chat.style.transition = "transform .5s ease-out";
    chat.style.transform = "translateY(0)";
  }, 110);
}

// Apply one scroll gesture to the backdrop; returns true if we took it over
// (so the caller can preventDefault). We only take over when there is history
// to reveal (or we're already scrolled back) — otherwise the page behaves
// normally over its empty field.
function scrollBackdrop(deltaY) {
  if (!backdropOn() || !scroller) return false;
  if (maxBgOffset() <= 0 && bgOffset <= 0) return false;
  const step = scrollStep(bgOffset, deltaY, pre.scrollHeight, view.clientHeight);
  bgOffset = step.offset;
  bgPinned = step.pinned;
  applyBgScroll();
  nudgeConversation(deltaY);
  return true;
}

let touchY = 0;
let touchActive = false;

function wireScroll() {
  if (scrollWired || typeof window === "undefined") return;
  scrollWired = true;
  window.addEventListener(
    "wheel",
    (e) => {
      try {
        if (onConvo(e.target)) return; // over a bubble → let the conversation scroll
        if (scrollBackdrop(e.deltaY)) e.preventDefault();
      } catch { /* decoration — never break the page */ }
    },
    { passive: false },
  );
  window.addEventListener(
    "touchstart",
    (e) => {
      touchActive = false;
      if (!backdropOn() || !e.touches || e.touches.length !== 1) return;
      if (onConvo(e.target)) return; // finger started on a bubble → its scroll wins
      touchY = e.touches[0].clientY;
      touchActive = true;
    },
    { passive: true },
  );
  window.addEventListener(
    "touchmove",
    (e) => {
      try {
        if (!touchActive || !e.touches || e.touches.length !== 1) return;
        const y = e.touches[0].clientY;
        const dy = touchY - y; // finger up → toward newest, matching wheel deltaY>0
        touchY = y;
        if (scrollBackdrop(dy)) e.preventDefault();
      } catch { /* decoration — never break the page */ }
    },
    { passive: false },
  );
  window.addEventListener("touchend", () => { touchActive = false; }, { passive: true });
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
