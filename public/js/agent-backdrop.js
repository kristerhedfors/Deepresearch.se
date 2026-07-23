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
// THREE-MODE VIEW SWITCH: while the sandbox is running the page holds two stacked
// panes — the CONVERSATION and this TERMINAL backdrop. A header ICON (`#termbtn`
// in the upper-right, a terminal glyph) is the ONE control, and tapping it CYCLES
// three modes (2026-07-23 directive, extending the original two):
//   1. CONVO    — conversation in front, the terminal a faint backdrop behind it.
//   2. TERMINAL — the terminal in front at full strength (a real terminal field).
//   3. HIDDEN   — the terminal output is not shown at all; only the conversation.
// The front pane reads at full strength, the other recedes to a faint background,
// and a quick slide-in-from-the-right sells the swap (except into HIDDEN, which
// has nothing to slide in). The icon reflects the current mode with HARMONIZED
// highlights — one accent hue at descending intensity (full fill → tinted outline
// → dim neutral), see syncTermBtn + the CSS. The icon APPEARS the moment the VM
// prints anything — so beyond the characters drifting on the background, the
// icon's presence is the sign the Linux system is active (2026-07-14 directive:
// replaced the old tap-on-the-background switch — the icon is the only switcher).
//
// The terminal text NEVER sways side to side — the old ambient horizontal wave
// was removed (2026-07-14 directive). Its only motion is north-south, and only
// in the two scroll cases below.
//
// TERMINAL MODE has real terminal COLORING and DIRECT TYPING (2026-07-16
// directive). While the terminal pane is forward the page reads as a terminal —
// white/gray text on a black field (`body.term-fg` in the CSS; the faint blue/
// olive ink is only for the background-decoration state) — and there are TWO
// places to type: the regular chat composer (unchanged, it floats above the
// black field), and the terminal itself — tapping the terminal pane focuses a
// hidden input whose keystrokes are sent straight into the VM's console, so
// input lands at the live shell prompt (the terminal's own cursor; the shell's
// echo makes the typing visible). sandbox.js registers the console write path
// via setTerminalInputSink; named keys/Ctrl-chords map through the pure
// termKeySequence (core), printable text rides the input event (IME-safe).
//
// COPY/PASTE (2026-07-17 directive): while the terminal pane is forward its
// contents are real, selectable text — the CSS re-enables pointer events +
// user-select on the pane in term-fg mode — and the handlers here stand back
// from an active selection: a click that ends a select drag doesn't steal
// focus, a touch drag on selection handles isn't hijacked into paging, and
// Ctrl/Cmd+C with a selection is the browser's copy (without one it stays the
// ^C interrupt; Ctrl/Cmd+V always passes through, which IS the terminal paste
// since the pasted text rides the hidden input's input event into the VM) —
// the pure decision is clipboardPassthrough (core).
//
// SCROLLING is per-mode, always vertical. In CONVERSATION mode the conversation
// scrolls natively and the terminal (the background pane) KEEPS PACE with it: the
// backdrop offset tracks the conversation's scroll position proportionally
// (convoSyncOffset), so scrolling back through the messages walks the terminal
// back through its command history and the commands/output behind the chat line
// up with the prompts and research jobs on screen (2026-07-14 directive). It is
// directly scroll-linked, so it stays smooth. In TERMINAL mode a wheel/drag pages
// BACK through the command history and the conversation (now the background pane)
// leans along in synchronization — a faint up/down follow, weaker and shorter,
// just enough to keep the two panes feeling coherent. The newest command line
// sits ABOVE the composer (the CSS raises the viewport) so it's visible, not
// hidden behind the input.

import {
  CHANNEL_CLIP_MS,
  LAYER_CONVO,
  LAYER_TERMINAL,
  activeLines,
  backdropEnabled,
  channelCount,
  clampLine,
  clipboardPassthrough,
  clipToNextChannel,
  convoSyncOffset,
  createBackdropModel,
  ensureChannel,
  LAYER_HIDDEN,
  nextLayerMode,
  opacityCss,
  parallaxFollow,
  pushCommand,
  pushLines,
  pushResult,
  scrollStep,
  stripAnsi,
  termKeySequence,
} from "./agent-backdrop-core.js";

// The single channel every sandbox surface shares: the VM's raw terminal stream
// (boot/login banner + prompt), the proposed commands, and their output all land
// here so the backdrop reads as ONE coherent terminal behind the chat.
const TERM_CHANNEL = "shell";

// The header switcher icon shared by both tiers (same id in index.html and
// cure/index.html): hidden until the VM prints, then it both toggles the view
// and, by its presence, signals the terminal is active.
const TERM_BTN_ID = "termbtn";

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
let termBtnWired = false; // the header switcher icon's click listener attached once
let termActive = false; // the VM has printed → the switcher icon is shown

// Which pane is in front. Only meaningful while the backdrop has content (a
// sandbox ran). Defaults to the conversation — we never auto-pop the terminal
// forward (that was the old screen-covering behavior we removed); the user taps
// the header terminal icon to bring it up.
let layerMode = LAYER_CONVO;

// Direct terminal typing (2026-07-16): the hidden input a tap on the terminal
// pane focuses, and the sink its keystrokes flow through into the VM's console
// (registered by sandbox.js — the same readData path the xterm panel uses, so
// input lands at the live shell prompt).
let termInput = null; // the hidden field that catches keystrokes
let termInputSink = null; // fn(str) → bytes into the VM console
let touchMoved = false; // a paging drag must never read as a focus tap

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
  // HIDDEN mode: the terminal output is not shown at all (2026-07-23 directive).
  // Drop the layer out entirely — the body.term-hidden CSS also hides it, this
  // is the belt-and-suspenders so it never paints even if the class is stale.
  if (layerMode === LAYER_HIDDEN) {
    layer.style.display = "none";
    return;
  }
  layer.style.display = "";
  // Full strength when the terminal is the foreground pane; the faint ceiling
  // when it's the background (its normal, decorative state).
  layer.style.opacity = layerMode === LAYER_TERMINAL ? "1" : String(opacityCss(OPACITY_PCT));
}

// ---- direct terminal typing ---------------------------------------------------
// The SECOND input point in terminal mode (the composer is the first): tapping
// the terminal pane focuses a hidden input, and everything typed there is sent
// into the VM's console — it lands at the live shell prompt, whose echo comes
// straight back through the raw terminal stream (feedTerminal), so the typing
// is visible at the terminal's own cursor. Named keys and Ctrl-chords map via
// the pure termKeySequence; printable text rides the input event so mobile
// IMEs/autocorrect work. Everything is fail-soft decoration-grade: no sink (VM
// not booted) → keystrokes are simply dropped.

/**
 * Register the function that carries typed input into the VM's console.
 * Called by sandbox.js once the CheerpX console is wired (and it stays valid
 * across exec swaps — the sink reads the live console handle each call).
 * @param {((s: string) => void) | null} fn
 */
export function setTerminalInputSink(fn) {
  termInputSink = typeof fn === "function" ? fn : null;
}

function sendToTerminal(str) {
  if (!termInputSink || !str) return;
  try { termInputSink(String(str)); } catch { /* input is best-effort */ }
}

// A non-collapsed selection anywhere on the page — the signal the user is
// COPYING terminal contents (2026-07-17 directive), so the gesture/keyboard
// handlers must stand back: no focus steal, no paging hijack, and Ctrl+C is
// the browser's copy, not the VM's interrupt.
function hasLiveSelection() {
  try {
    const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
    return !!sel && !sel.isCollapsed && String(sel).length > 0;
  } catch { return false; }
}

function onTermKeydown(e) {
  try {
    // Copy/paste chords belong to the browser: Ctrl/Cmd+C with a selection
    // copies it (without one it stays the ^C interrupt), Ctrl/Cmd+V pastes —
    // the pasted text lands in this hidden field and the input event below
    // forwards it into the VM, so the passthrough IS the terminal paste.
    if (clipboardPassthrough(
      e.key,
      { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey, shift: e.shiftKey },
      hasLiveSelection(),
    )) return;
    const seq = termKeySequence(e.key, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    if (seq == null) return; // printable text arrives via the input event
    e.preventDefault();
    sendToTerminal(seq);
  } catch { /* decoration — never break the page */ }
}

// Printable characters (incl. IME composition, autocorrect, paste) land in the
// hidden field; forward them and clear it so it never accumulates state. A bare
// newline (an IME "Enter" that never fired a keydown) becomes carriage return —
// what a terminal expects.
function onTermInput(e) {
  try {
    if (e && e.isComposing) return; // wait for compositionend
    if (!termInput || !termInput.value) return;
    sendToTerminal(termInput.value.replace(/\n/g, "\r"));
    termInput.value = "";
  } catch { /* decoration — never break the page */ }
}

function ensureTermInput() {
  if (termInput || typeof document === "undefined" || !document.body) return termInput;
  const el = document.createElement("textarea");
  el.className = "dr-term-input";
  el.setAttribute("aria-label", "Terminal input");
  el.setAttribute("autocapitalize", "off");
  el.setAttribute("autocomplete", "off");
  el.setAttribute("autocorrect", "off");
  el.setAttribute("spellcheck", "false");
  el.addEventListener("keydown", onTermKeydown);
  el.addEventListener("input", onTermInput);
  el.addEventListener("compositionend", onTermInput);
  document.body.appendChild(el);
  termInput = el;
  return el;
}

// Focus the hidden input (opens the keyboard on mobile). Typing belongs at the
// live prompt, so re-pin the log to its tail first — the echo must be visible.
function focusTerminalInput() {
  const el = ensureTermInput();
  if (!el) return;
  bgOffset = 0;
  bgPinned = true;
  applyBgScroll();
  try { el.focus({ preventScroll: true }); } catch { try { el.focus(); } catch { /* ignore */ } }
}

function blurTerminalInput() {
  try { if (termInput) termInput.blur(); } catch { /* ignore */ }
}

// ---- the two-layer view switch ----------------------------------------------
// The header terminal icon (#termbtn) swaps the foreground pane (see the header
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

// ---- the header switcher icon (#termbtn) ------------------------------------
// The ONE control that swaps panes (2026-07-14 directive). It lives in each
// tier's header markup with a shared id; here we only find it, wire its click,
// reveal it when the VM prints, and reflect which pane is forward. No glow — its
// presence + pressed state are the only signals.

function termBtn() {
  return typeof document !== "undefined" ? document.getElementById(TERM_BTN_ID) : null;
}

// Reflect the current mode on the icon with HARMONIZED highlights (2026-07-23
// directive) — one accent hue at descending intensity, so the icon itself tells
// you which of the three modes you're in:
//   terminal forward → full accent fill      (.on)
//   convo / faint backdrop → accent-tinted outline (.mode-bg)
//   hidden / not shown → dim neutral glass    (.mode-off)
function syncTermBtn() {
  const btn = termBtn();
  if (!btn) return;
  const terminal = layerMode === LAYER_TERMINAL;
  const hidden = layerMode === LAYER_HIDDEN;
  btn.classList.toggle("on", terminal);
  btn.classList.toggle("mode-bg", !terminal && !hidden);
  btn.classList.toggle("mode-off", hidden);
  try {
    // Only the forward pane is a true "pressed" toggle; the tri-state is spelled
    // out in the label so assistive tech announces the mode and the next tap.
    btn.setAttribute("aria-pressed", terminal ? "true" : "false");
    btn.setAttribute(
      "title",
      terminal
        ? "Terminal in front — tap to hide it"
        : hidden
          ? "Terminal hidden — tap to show it behind the chat"
          : "Terminal behind the chat — tap to bring it forward",
    );
  } catch { /* ignore */ }
}

// Show the switcher icon the moment the terminal is active (the VM printed), and
// wire its click ONCE. Presence = "Linux is running"; tapping = switch panes.
function revealTermBtn() {
  if (termActive) return;
  termActive = true;
  const btn = termBtn();
  if (!btn) return;
  try { btn.removeAttribute("hidden"); } catch { /* ignore */ }
  wireTermBtn();
  syncTermBtn();
}

/**
 * Reveal the header terminal icon immediately, before the VM has printed
 * anything — used at page load when the sandbox is ENABLED and booting in the
 * background, so the icon's presence is the "Linux is starting" signal the
 * moment the user lands on the page (2026-07-14 owner directive). Idempotent
 * and safe to call before any backdrop content exists; the pane switch is a
 * no-op until the VM prints (which happens within a moment of boot).
 */
export function showTerminalIcon() {
  try { revealTermBtn(); } catch { /* decoration — never break the caller */ }
}

/**
 * Hide the header terminal icon again — used to reconcile a stale local cache
 * when the server confirms the sandbox knob is OFF. No-op once the VM has
 * actually produced output (a genuinely active terminal is never hidden).
 */
export function hideTerminalIcon() {
  try {
    if (hasBackdropContent()) return; // a real terminal is running — keep it
    termActive = false;
    const btn = termBtn();
    if (btn) btn.setAttribute("hidden", "");
  } catch { /* decoration — never break the caller */ }
}

function wireTermBtn() {
  if (termBtnWired) return;
  const btn = termBtn();
  if (!btn) return;
  termBtnWired = true;
  btn.addEventListener("click", (e) => {
    try {
      e.preventDefault();
      if (!hasBackdropContent()) return; // nothing to switch to
      setLayerMode(nextLayerMode(layerMode));
    } catch { /* decoration — never break the page */ }
  });
}

/** Switch the view mode, updating the body classes, opacity, icon and flourish. */
function setLayerMode(mode) {
  const next = mode === LAYER_TERMINAL ? LAYER_TERMINAL
    : mode === LAYER_HIDDEN ? LAYER_HIDDEN
      : LAYER_CONVO;
  if (next === layerMode) return;
  layerMode = next;
  const terminal = layerMode === LAYER_TERMINAL;
  const hidden = layerMode === LAYER_HIDDEN;
  if (typeof document !== "undefined" && document.body) {
    // term-fg brings the terminal forward; term-hidden drops it out of view.
    // Both absent = the default faint-backdrop (convo) state.
    document.body.classList.toggle("term-fg", terminal);
    document.body.classList.toggle("term-hidden", hidden);
  }
  applyOpacity();
  syncTermBtn();
  clearParallax();
  // The slide-in flourish only makes sense when a pane actually comes forward
  // (convo or terminal); hiding the terminal has nothing to slide in.
  if (!hidden) slideInForeground(terminal);
  // Only terminal mode keeps the keyboard on the terminal input; convo and
  // hidden both hand the keyboard back to the page (the composer).
  if (!terminal) blurTerminalInput();
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

// In CONVERSATION mode the backdrop offset is a pure function of how far the
// conversation is scrolled (convoSyncOffset), so the terminal behind the chat
// keeps pace with the messages being read. Recompute it from the LIVE scroll
// position; returns true when it applied (convo mode with content), false in
// terminal mode where the wheel/touch handlers own the offset instead.
function recomputeConvoSync() {
  if (layerMode !== LAYER_CONVO || !hasBackdropContent()) return false;
  const c = chatEl();
  if (!c || !pre || !view) return false;
  const step = convoSyncOffset(
    c.scrollTop, c.scrollHeight, c.clientHeight,
    pre.scrollHeight, view.clientHeight,
  );
  bgOffset = step.offset;
  bgPinned = step.pinned;
  return true;
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
  // In convo mode, re-derive the offset from the conversation's current scroll
  // position (the content height just changed). In terminal mode, fresh output
  // re-pins to the live tail unless the user has scrolled back to read history;
  // either way keep the offset inside the (now-changed) range.
  if (!recomputeConvoSync()) {
    if (bgPinned) bgOffset = 0;
  }
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

// Genuine interactive controls + floating chrome + panels — a TERMINAL-mode
// swipe must never hijack these, so real controls stay usable while paging
// history. NB: the conversation's OWN content (.msg / .step / .activity) is
// deliberately NOT here: in terminal mode those bubbles are the RECEDED
// background pane, so a swipe across them must page the terminal — blocking on
// them let a gesture fall through to #chat's native scroll and "scroll my
// messages instead" (they cover most of the screen).
const BLOCK_SEL =
  "button, a, input, textarea, select, label, [role=button], " +
  "#jumpdown, header, #footer, #composer, #searchpop, .setting-pop, .history, " +
  "#account, .account-card, .project-panel, #drspop, #intro, #drawer";

function onBlocked(target) {
  return !!(target && target.closest && target.closest(BLOCK_SEL));
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

function wireScroll() {
  if (scrollWired || typeof window === "undefined") return;
  scrollWired = true;

  // Switching panes is done ONLY by the header terminal icon (wireTermBtn); the
  // listeners below are just the per-mode scroll/parallax feel.

  // --- wheel: TERMINAL mode pages history; CONVO mode scrolls the convo (and
  //     leans the backdrop along, wired via the #chat scroll listener below) ---
  window.addEventListener(
    "wheel",
    (e) => {
      try {
        if (layerMode !== LAYER_TERMINAL || !hasBackdropContent()) return;
        if (onBlocked(e.target)) return; // over a real control → leave it alone
        // The terminal is the foreground pane: capture the gesture so the
        // background conversation never scrolls, then page the log (a no-op if
        // there's no history yet — but the messages still stay put).
        e.preventDefault();
        scrollBackdrop(e.deltaY);
      } catch { /* decoration — never break the page */ }
    },
    { passive: false },
  );
  window.addEventListener(
    "touchstart",
    (e) => {
      touchActive = false;
      touchMoved = false;
      if (layerMode !== LAYER_TERMINAL || !hasBackdropContent()) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (onBlocked(e.target)) return; // finger on a real control → leave it alone
      if (hasLiveSelection()) return; // adjusting a text selection — don't page
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
        // A selection appeared mid-gesture (long-press) — hand the rest of the
        // drag to the browser so the selection handles stay draggable.
        if (hasLiveSelection()) { touchActive = false; return; }
        const y = e.touches[0].clientY;
        const dy = touchY - y; // finger up → toward newest, matching wheel deltaY>0
        touchY = y;
        if (dy) touchMoved = true; // a drag pages history — not a focus tap
        // touchActive is only set in terminal mode over non-control area, so
        // always capture here — the background conversation must not scroll.
        e.preventDefault();
        scrollBackdrop(dy);
      } catch { /* decoration — never break the page */ }
    },
    { passive: false },
  );
  window.addEventListener("touchend", () => { touchActive = false; }, { passive: true });

  // --- tap-to-type (TERMINAL mode): a tap on the terminal pane — not on a real
  //     control, not a paging drag — focuses the hidden input, so what the user
  //     types next lands at the live shell prompt. The composer (in BLOCK_SEL)
  //     is untouched: tapping it focuses the chat field as ever — the two input
  //     points of terminal mode. ---
  window.addEventListener("click", (e) => {
    try {
      if (layerMode !== LAYER_TERMINAL || !hasBackdropContent()) return;
      if (onBlocked(e.target)) return; // a real control keeps its own click
      if (touchMoved) { touchMoved = false; return; } // drag remnant, not a tap
      // The click that ENDS a select-to-copy drag must not steal the selection
      // by moving focus (and re-pinning the log) — leave it for Ctrl/Cmd+C.
      if (hasLiveSelection()) return;
      focusTerminalInput();
    } catch { /* decoration — never break the page */ }
  });

  // --- CONVO mode: the terminal (background pane) KEEPS PACE with the messages
  //     (2026-07-14 directive). As the conversation scrolls, the backdrop offset
  //     tracks it proportionally (convoSyncOffset): at the newest end it pins to
  //     its live tail; scrolling up toward older messages walks the terminal
  //     back through its command history so the commands/output behind the chat
  //     line up with the prompts and research jobs on screen. Purely vertical,
  //     and directly scroll-linked so it stays smooth. In terminal mode the
  //     wheel/touch handlers own the offset, so this defers to them. ---
  const c = chatEl();
  if (c) {
    lastChatTop = c.scrollTop;
    c.addEventListener("scroll", () => {
      try {
        lastChatTop = c.scrollTop;
        if (recomputeConvoSync()) applyBgScroll();
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
    if (hasBackdropContent()) revealTermBtn(); // terminal is active → show the icon
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
    // A prompt with no trailing newline is a live tail with no committed line
    // yet — ensure the channel so render() shows it (and it counts as content).
    if (termBuf) ensureChannel(model, TERM_CHANNEL);
    render();
    syncClipTimer();
    if (hasBackdropContent()) revealTermBtn(); // terminal is active → show the icon
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
