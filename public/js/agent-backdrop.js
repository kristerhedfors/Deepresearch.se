// The AGENT ACTIVITY BACKDROP — the DOM half of the feature (pure model +
// preference logic live in agent-backdrop-core.js). NOT `// @ts-check`: this is
// browser glue (document/localStorage), guarded so importing it in Node — which
// happens transitively via sandbox.js ← drc-research.js, a Node-tested module —
// never touches a browser global at load time.
//
// Instead of popping the sandbox terminal open (which covered the screen and
// broke the prompt-first flow), the raw commands and output the agent runs
// drift faintly across the page's sky-blue background. The layer's transparency
// is FIXED at its fullest (the faint ceiling): the tuning slider — both the
// floating bar and the Settings-view mirror — was removed (2026-07-13
// directive), so there is one hardcoded value and no per-browser preference.
//
// The single feed point is execInSandbox in sandbox.js, so BOTH tiers (DRS and
// DRC) and any agent that runs commands surface here automatically. Callers may
// pass a channel id per agent; when several are active the layer clips between
// them.
//
// The backdrop ALSO mirrors the VM's RAW terminal stream (feedTerminal, fed from
// sandbox.js's console writer): the boot/login banner and shell prompt drift
// behind the chat the instant the VM prints anything, so "there are terminal
// characters in the background" is the visible proof the Linux system has
// started (2026-07-14 directive). ANSI escapes are stripped and the live,
// not-yet-terminated prompt line is shown as a tail.
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
  clampLine,
  clipToNextChannel,
  createBackdropModel,
  opacityCss,
  parallaxNudge,
  pushCommand,
  pushLines,
  pushResult,
  scrollStep,
  stripAnsi,
} from "./agent-backdrop-core.js";

// The single channel every sandbox surface shares: the VM's raw terminal stream
// (boot/login banner + prompt), the proposed commands, and their output all land
// here so the backdrop reads as ONE coherent terminal behind the chat.
const TERM_CHANNEL = "shell";

// The transparency slider was removed (2026-07-13 directive): the layer is
// always shown at its fullest (100 → the faint 0.55 CSS ceiling). One fixed
// value, no per-browser preference, no floating bar.
const OPACITY_PCT = 100;

const model = createBackdropModel();
let layer = null; // the fixed background layer (built lazily, only when on)
let view = null; // the clipped viewport window (sizes/positions the text)
let scroller = null; // the inner element we translate to scroll the log
let pre = null; // the <pre> the active channel renders into
let clipTimer = 0; // round-robin between channels when >1 is active

// The raw-terminal line assembler: the VM writes the console in arbitrary
// chunks, so we buffer the partial trailing line (the not-yet-newline-terminated
// shell prompt) here and show it as a live tail; complete lines are committed to
// the model. Cleared/flushed when a command starts (feedCommand) so the command
// appears BELOW the prompt, not above it.
let termBuf = "";

// Backdrop scroll state: bgOffset px scrolled back into the log (0 = pinned to
// the live tail), bgPinned tracks whether we're still following the newest.
let bgOffset = 0;
let bgPinned = true;
let scrollWired = false; // wheel/touch listeners attached once
let parallaxTimer = 0; // springs the conversation's opposite lean back to zero

// ---- fixed transparency ----

/** The current transparency (0..100) — hardcoded at the max. */
export function backdropOpacityPct() {
  return OPACITY_PCT;
}

/** Whether the layer is enabled — always, now the value is fixed non-zero. */
export function backdropOn() {
  return backdropEnabled(OPACITY_PCT);
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
  layer.style.display = "";
  layer.style.opacity = String(opacityCss(OPACITY_PCT));
}

function render() {
  if (!pre) return;
  // Newest at the bottom, like a real terminal tail; the CSS clips the top so
  // the visible window is always the most recent work. The unterminated raw-
  // terminal tail (the live shell prompt) is shown appended, so "characters are
  // drifting behind the chat" the instant the VM prints anything — the visible
  // proof Linux has booted.
  let lines = activeLines(model);
  if (model.active === TERM_CHANNEL && termBuf) lines = lines.concat([clampLine(termBuf)]);
  pre.textContent = lines.join("\n");
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

// ---- the feed (called from execInSandbox) -----------------------------------

// A command or its output arrived → the terminal is running: build/render the
// faint text at the fixed transparency.
function feed(fn, channel, payload) {
  try {
    ensureLayer();
    fn(model, channel || "shell", payload);
    render();
    syncClipTimer();
  } catch { /* the backdrop is decoration — never break the caller */ }
}

// Commit any pending raw-terminal tail (the live prompt) as a real line, so
// whatever comes next — a command, a result — is appended BELOW it in order.
function flushTermTail() {
  if (termBuf) {
    pushLines(model, TERM_CHANNEL, [termBuf]);
    termBuf = "";
  }
}

/**
 * Mirror a chunk of the VM's RAW terminal stream (boot/login banner, shell
 * prompt) onto the backdrop. ANSI escapes are stripped; complete lines are
 * committed and the trailing partial line is kept as a live tail. This is the
 * "Linux has started" signal — the moment the VM prints anything, characters
 * drift behind the chat. Fed from sandbox.js's console writer; fully fail-soft.
 * @param {unknown} text a decoded terminal chunk
 */
export function feedTerminal(text) {
  try {
    const clean = stripAnsi(text);
    if (!clean) return;
    ensureLayer();
    const parts = (termBuf + clean).split("\n");
    termBuf = parts.pop() || ""; // the unterminated remainder (the prompt)
    for (const line of parts) pushLines(model, TERM_CHANNEL, [line]);
    render();
    syncClipTimer();
  } catch { /* the backdrop is decoration — never break the caller */ }
}

/** Show a proposed command (`$ cmd`) on the given agent's channel. */
export function feedCommand(channel, command) {
  flushTermTail(); // land the command below the live prompt, not above it
  feed(pushCommand, channel, command);
}

/** Show a finished command's raw stdout/stderr on the given agent's channel. */
export function feedResult(channel, run) {
  feed(pushResult, channel, run);
}
