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
// TWO-LAYER VIEW SWITCH: while the sandbox is running the page holds two stacked
// panes — the CONVERSATION and this TERMINAL backdrop. A TAP on the bare page
// background (never on a message bubble, never on interactive chrome) swaps which
// pane is in front: the front pane reads at full strength, the other recedes to
// a faint background, and a quick slide-in-from-the-right sells the swap. The
// tap-vs-message discrimination is the load-bearing detail (a tap that lands on a
// user/assistant bubble or a control does its normal thing and never switches).
//
// SCROLLING is per-mode. In CONVERSATION mode the conversation scrolls natively
// and the terminal (the background pane) leans along in synchronization, weaker
// and shorter. In TERMINAL mode a wheel/drag pages BACK through the command
// history and the conversation (now the background pane) leans along the same
// way. The newest command line sits ABOVE the composer (the CSS raises the
// viewport) so it's visible, not hidden behind the input.

import {
  CHANNEL_CLIP_MS,
  LAYER_CONVO,
  LAYER_TERMINAL,
  activeLines,
  backdropEnabled,
  channelCount,
  clampLine,
  clipToNextChannel,
  createBackdropModel,
  isTapGesture,
  nextLayerMode,
  opacityCss,
  parallaxFollow,
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
let scrollWired = false; // wheel/touch/tap listeners attached once

// Which pane is in front. Only meaningful while the backdrop has content (a
// sandbox ran). Defaults to the conversation — we never auto-pop the terminal
// forward (that was the old screen-covering behavior we removed); the user taps
// the background to bring it up.
let layerMode = LAYER_CONVO;

// Composed transforms for the two panes. Each pane can carry BOTH a transient
// slide (the switch flourish) and a small parallax lean (during scroll); they
// share one transform, so we track the parts and write them together. The
// conversation (#chat) uses native scroll, so a static translate is safe; the
// backdrop's parallax rides its OWN wrapper (`.dr-agent-backdrop-text`), clear
// of the scroller/`<pre>` transforms that already page and wave.
let chatSlideX = 0, chatParY = 0, chatParTimer = 0;
let viewSlideX = 0, viewParY = 0, viewParTimer = 0;
let lastChatTop = 0; // remembers #chat.scrollTop to derive its scroll delta

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
  // Full strength when the terminal is the foreground pane; the faint ceiling
  // when it's the background (its normal, decorative state).
  layer.style.opacity = layerMode === LAYER_TERMINAL ? "1" : String(opacityCss(OPACITY_PCT));
}

// ---- the two-layer view switch ----------------------------------------------
// A tap on the bare page background swaps the foreground pane (see the header
// note). We keep the mode meaningful only while the sandbox has produced output.

/** Whether the sandbox has produced any output yet (→ a terminal worth showing). */
function hasBackdropContent() {
  return channelCount(model) > 0;
}

function reduceMotion() {
  try {
    return typeof window !== "undefined" && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { return false; }
}

function chatEl() {
  return typeof document !== "undefined" ? document.getElementById("chat") : null;
}

function applyChatTransform() {
  const c = chatEl();
  if (c) c.style.transform = "translate(" + chatSlideX + "px," + chatParY + "px)";
}
function applyViewTransform() {
  if (view) view.style.transform = "translate(" + viewSlideX + "px," + viewParY + "px)";
}

// A quick slide-in-from-the-right for the pane that just came forward. Disable
// the transition, place it 30px to the right, force a reflow, then transition
// back to 0 — the standard kick so it eases IN rather than animating out first.
function slideInForeground(terminal) {
  if (reduceMotion()) return;
  const isChat = !terminal;
  const el = terminal ? view : chatEl();
  if (!el) return;
  if (isChat) chatSlideX = 30; else viewSlideX = 30;
  el.style.transition = "none";
  if (isChat) applyChatTransform(); else applyViewTransform();
  // force reflow so the 30px start is committed before we transition to 0
  void el.offsetWidth;
  el.style.transition = "";
  if (isChat) chatSlideX = 0; else viewSlideX = 0;
  if (isChat) applyChatTransform(); else applyViewTransform();
}

// Reset any lingering parallax lean on BOTH panes (called on a mode switch so a
// half-sprung lean doesn't stick when the panes trade foreground/background).
function clearParallax() {
  chatParY = 0; viewParY = 0;
  if (chatParTimer) { clearTimeout(chatParTimer); chatParTimer = 0; }
  if (viewParTimer) { clearTimeout(viewParTimer); viewParTimer = 0; }
  applyChatTransform();
  applyViewTransform();
}

/** Switch the foreground pane, updating the class, opacity and slide flourish. */
function setLayerMode(mode) {
  const next = mode === LAYER_TERMINAL ? LAYER_TERMINAL : LAYER_CONVO;
  if (next === layerMode) return;
  layerMode = next;
  const terminal = layerMode === LAYER_TERMINAL;
  if (typeof document !== "undefined" && document.body) {
    document.body.classList.toggle("term-fg", terminal);
  }
  applyOpacity();
  clearParallax();
  slideInForeground(terminal);
}

// The BACKGROUND pane leans in the same direction as the foreground scroll, then
// springs back — "in synchronization … weaker and shorter". `signed` is the
// already-directed displacement (px of scroll intent); parallaxFollow scales +
// clamps it. The CSS transition on each pane smooths the lean and the return.
function leanChat(signed) {
  chatParY = parallaxFollow(signed);
  applyChatTransform();
  if (chatParTimer) clearTimeout(chatParTimer);
  chatParTimer = setTimeout(() => { chatParY = 0; applyChatTransform(); }, 150);
}
function leanBackdrop(signed) {
  viewParY = parallaxFollow(signed);
  applyViewTransform();
  if (viewParTimer) clearTimeout(viewParTimer);
  viewParTimer = setTimeout(() => { viewParY = 0; applyViewTransform(); }, 150);
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

// Genuine interactive chrome + message bubbles — a TAP on any of these does its
// own thing and must NEVER switch panes (the load-bearing distinction: tap a
// user/assistant message → no switch; tap the bare background → switch). Also
// the set a TERMINAL-mode swipe won't hijack, so real controls stay usable.
const BLOCK_SEL =
  ".msg, .step, .activity, button, a, input, textarea, select, label, [role=button], " +
  "#jumpdown, header, #footer, #composer, #searchpop, .setting-pop, .history, " +
  "#account, .account-card, .project-panel, #drspop, #intro, #drawer";

function onBlocked(target) {
  return !!(target && target.closest && target.closest(BLOCK_SEL));
}

// A tap counts as a pane switch only when it lands on the bare background: not on
// a message/control, and not while text is selected (a drag-select ends in a
// pointerup we must not treat as a tap).
function isSwitchTarget(target) {
  if (onBlocked(target)) return false;
  try {
    const sel = typeof window !== "undefined" && window.getSelection && window.getSelection();
    if (sel && String(sel).length) return false;
  } catch { /* ignore */ }
  return true;
}

// Apply one scroll gesture to the backdrop (TERMINAL mode only); returns true if
// we took it over so the caller can preventDefault. Only takes over when there
// is history to reveal. The conversation — now the background pane — leans along
// in synchronization.
function scrollBackdrop(deltaY) {
  if (!scroller) return false;
  if (maxBgOffset() <= 0 && bgOffset <= 0) return false;
  const step = scrollStep(bgOffset, deltaY, pre.scrollHeight, view.clientHeight);
  bgOffset = step.offset;
  bgPinned = step.pinned;
  applyBgScroll();
  leanChat(-deltaY); // background pane follows the same visual direction, weaker
  return true;
}

let touchY = 0;
let touchActive = false;
let downX = 0, downY = 0, downT = 0, downTarget = null, pointerDown = false;

function now() {
  try { return typeof performance !== "undefined" ? performance.now() : 0; }
  catch { return 0; }
}

function wireScroll() {
  if (scrollWired || typeof window === "undefined") return;
  scrollWired = true;

  // --- the tap-to-switch gesture (pointer events cover mouse + touch) ---
  window.addEventListener("pointerdown", (e) => {
    pointerDown = true;
    downX = e.clientX; downY = e.clientY; downT = now(); downTarget = e.target;
  }, { passive: true });
  window.addEventListener("pointerup", (e) => {
    try {
      if (!pointerDown) return;
      pointerDown = false;
      if (!hasBackdropContent()) return; // no sandbox output → nothing to switch to
      if (!isTapGesture(e.clientX - downX, e.clientY - downY, now() - downT)) return;
      // both the press and the release must be on the bare background — a drag
      // that started on a bubble and lifted on the gap isn't a background tap.
      if (!isSwitchTarget(e.target) || !isSwitchTarget(downTarget)) return;
      setLayerMode(nextLayerMode(layerMode));
    } catch { /* decoration — never break the page */ }
  }, { passive: true });

  // --- wheel: TERMINAL mode pages history; CONVO mode scrolls the convo (and
  //     leans the backdrop along, wired via the #chat scroll listener below) ---
  window.addEventListener(
    "wheel",
    (e) => {
      try {
        if (layerMode !== LAYER_TERMINAL || !hasBackdropContent()) return;
        if (onBlocked(e.target)) return; // over a real control → leave it alone
        if (scrollBackdrop(e.deltaY)) e.preventDefault();
      } catch { /* decoration — never break the page */ }
    },
    { passive: false },
  );
  window.addEventListener(
    "touchstart",
    (e) => {
      touchActive = false;
      if (layerMode !== LAYER_TERMINAL || !hasBackdropContent()) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (onBlocked(e.target)) return; // finger on a real control → leave it alone
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

  // --- CONVO mode: the terminal (background pane) leans along as the
  //     conversation scrolls natively, in synchronization but weaker/shorter ---
  const c = chatEl();
  if (c) {
    lastChatTop = c.scrollTop;
    c.addEventListener("scroll", () => {
      try {
        const top = c.scrollTop;
        const d = top - lastChatTop;
        lastChatTop = top;
        if (layerMode !== LAYER_CONVO || !hasBackdropContent()) return;
        leanBackdrop(-d); // content moved up (d>0) → backdrop drifts up too, less
      } catch { /* decoration — never break the page */ }
    }, { passive: true });
  }
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
