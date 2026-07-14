// @ts-check
// The AGENT ACTIVITY BACKDROP's pure core (the one testable half of the
// feature; the DOM glue is agent-backdrop.js). When the execution sandbox runs
// commands we deliberately DO NOT pop the terminal panel open any more — it
// covered the screen and broke the prompt-first flow. Instead the raw commands
// and their output drift faintly across the sky-blue page background, so the
// user keeps some visibility into what the agent is doing without ever leaving
// the composer.
//
// This module owns the model behind that layer, kept pure so it runs in Node's
// test runner with no DOM:
//
//   - a small ring-buffered, multi-CHANNEL transcript (one channel per agent,
//     so several concurrent agents each get their own raw view), plus the
//     round-robin that "clips back and forth" between them when more than one
//     is active, and
//   - the user's transparency preference parsing/clamping (a slider, 0 = the
//     layer is off, up to 100 = fully at its faint ceiling).
//
// Everything here is total: bad input degrades to a default or an empty list,
// never throws — the backdrop is decoration and must never break a request.

// How many lines each channel keeps. The layer only ever shows the tail, so
// this is both the render window and the memory cap.
export const MAX_LINES = 80;
// Hard cap on a single displayed line so one runaway command can't blow up the
// DOM (the raw output is decoration, not a pager).
export const MAX_LINE_CHARS = 400;
// Default transparency (percent). On but faint — visible texture, not a wall.
export const DEFAULT_OPACITY_PCT = 22;
// How long each channel stays on screen before the backdrop clips to the next
// one, when several agents are active at once (milliseconds). Exported so the
// DOM timer and the tests agree on one number.
export const CHANNEL_CLIP_MS = 4200;

/** @typedef {{ command: string, exitCode: number, stdout: string, stderr: string }} ShellRun */
/** @typedef {{ maxLines: number, channels: Record<string, string[]>, order: string[], active: string | null }} BackdropModel */

/**
 * Collapse a value to a single trimmed, length-capped display line.
 * @param {unknown} s
 */
export function clampLine(s) {
  const one = String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+$/g, "");
  return one.length > MAX_LINE_CHARS ? one.slice(0, MAX_LINE_CHARS - 1) + "…" : one;
}

/**
 * A fresh, empty backdrop model.
 * @param {{ maxLines?: number }} [opts]
 * @returns {BackdropModel}
 */
export function createBackdropModel(opts = {}) {
  const maxLines = Number.isFinite(Number(opts.maxLines)) && Number(opts.maxLines) > 0
    ? Math.trunc(Number(opts.maxLines))
    : MAX_LINES;
  return { maxLines, channels: Object.create(null), order: [], active: null };
}

/**
 * Register a channel if new (first one becomes active). Returns the channel id.
 * @param {BackdropModel} model
 * @param {string} channel
 */
export function ensureChannel(model, channel) {
  const id = String(channel || "shell") || "shell";
  if (!model.channels[id]) {
    model.channels[id] = [];
    model.order.push(id);
    if (model.active == null) model.active = id;
  }
  return id;
}

/**
 * Append one or more raw lines to a channel, focus it (a channel with fresh
 * output becomes the active one so the user sees the newest work), and cap the
 * ring. Returns the lines actually stored (clamped).
 * @param {BackdropModel} model
 * @param {string} channel
 * @param {string[]} lines
 */
export function pushLines(model, channel, lines) {
  const id = ensureChannel(model, channel);
  const buf = model.channels[id];
  const stored = [];
  for (const raw of Array.isArray(lines) ? lines : [lines]) {
    const line = clampLine(raw);
    buf.push(line);
    stored.push(line);
  }
  while (buf.length > model.maxLines) buf.shift();
  model.active = id; // newest activity wins the screen
  return stored;
}

/**
 * Push a proposed command as a prompt line (`$ cmd`).
 * @param {BackdropModel} model
 * @param {string} channel
 * @param {string} command
 */
export function pushCommand(model, channel, command) {
  return pushLines(model, channel, ["$ " + clampLine(command)]);
}

/**
 * Turn a finished ShellRun into raw display lines: its stdout then stderr, one
 * line each, with a trailing `[exit N]` marker when the command failed. Empty
 * trailing lines are dropped so the layer isn't padded with blanks.
 * @param {ShellRun} run
 * @returns {string[]}
 */
export function formatResultLines(run) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} text */
  const push = (text) => {
    const s = String(text == null ? "" : text);
    if (!s) return;
    for (const ln of s.split("\n")) out.push(clampLine(ln));
  };
  push(run && run.stdout);
  push(run && run.stderr);
  while (out.length && out[out.length - 1] === "") out.pop();
  const code = Number(run && run.exitCode);
  if (Number.isFinite(code) && code !== 0) out.push("[exit " + Math.trunc(code) + "]");
  return out;
}

/**
 * Push a finished command's raw output into its channel.
 * @param {BackdropModel} model
 * @param {string} channel
 * @param {ShellRun} run
 */
export function pushResult(model, channel, run) {
  return pushLines(model, channel, formatResultLines(run));
}

/**
 * The lines of a specific channel (a copy; [] when unknown).
 * @param {BackdropModel} model
 * @param {string} channel
 */
export function channelLines(model, channel) {
  const buf = model.channels[String(channel)];
  return Array.isArray(buf) ? buf.slice() : [];
}

/**
 * The lines of the currently-shown channel.
 * @param {BackdropModel} model
 */
export function activeLines(model) {
  return model.active == null ? [] : channelLines(model, model.active);
}

/**
 * How many channels (agents) the backdrop is tracking.
 * @param {BackdropModel} model
 */
export function channelCount(model) {
  return model.order.length;
}

/**
 * Advance the active channel to the next one in round-robin order — the "clip
 * back and forth between agents" step. A no-op (returns the same id) when zero
 * or one channel is present. Returns the newly-active id.
 * @param {BackdropModel} model
 */
export function clipToNextChannel(model) {
  if (model.order.length <= 1) return model.active;
  const i = model.active == null ? -1 : model.order.indexOf(model.active);
  model.active = model.order[(i + 1) % model.order.length];
  return model.active;
}

// ---- transparency preference ------------------------------------------------

/**
 * Clamp any value to an integer percentage in [0, 100].
 * @param {unknown} n
 */
export function clampOpacityPct(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_OPACITY_PCT;
  return Math.max(0, Math.min(100, v));
}

/**
 * Parse the stored preference (a bare number, a numeric string, or null/absent)
 * into a clamped percentage, falling back to the default when unset or garbage.
 * @param {unknown} raw
 * @returns {number} 0..100
 */
export function parseOpacityPref(raw) {
  if (raw == null || raw === "") return DEFAULT_OPACITY_PCT;
  const v = Number(raw);
  if (!Number.isFinite(v)) return DEFAULT_OPACITY_PCT;
  return clampOpacityPct(v);
}

/**
 * Whether a given percentage means the layer is shown at all.
 * @param {number} pct
 */
export function backdropEnabled(pct) {
  return clampOpacityPct(pct) > 0;
}

// The layer's CSS-opacity ceiling — deliberately below 1 so even "full" stays a
// backdrop the chat reads cleanly over. Nudged up from 0.55 → 0.72 (2026-07-14
// directive: "slightly more prominent, just slightly more visible than now" —
// the running-terminal characters are the signal that the Linux VM has actually
// started, so they should read a touch more clearly without becoming a wall).
export const OPACITY_CEILING = 0.72;

/**
 * Map the user's 0..100 slider to the layer's actual CSS opacity. The ceiling
 * (OPACITY_CEILING) is below 1 so even "full" stays a faint backdrop the chat
 * reads cleanly over — the value tunes within that band, it does not turn the
 * page into a terminal.
 * @param {number} pct
 * @returns {number} 0..OPACITY_CEILING
 */
export function opacityCss(pct) {
  return +(clampOpacityPct(pct) / 100 * OPACITY_CEILING).toFixed(3);
}

// ---- raw terminal text ------------------------------------------------------
// The backdrop also mirrors the VM's RAW terminal stream (the boot/login banner
// and shell prompt), so "there are characters drifting behind the chat" is the
// visible proof the Linux system has booted. That stream carries ANSI escape
// sequences (colored prompt, cursor moves) which must be stripped before the
// text lands in a <pre>, or the layer fills with garbage like `\x1b[0;32m`.

// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // CSI … final byte (colors, cursor)
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // OSC … BEL / ST (title sets)
// eslint-disable-next-line no-control-regex
const ANSI_MISC = /\x1b[=>NOc]|\x1b\([AB012]/g; // charset / keypad selects
// eslint-disable-next-line no-control-regex
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // controls except \t (\x09) \n (\x0a) \r (\x0d)

/**
 * Strip ANSI escape sequences and stray control bytes from a raw terminal
 * chunk, leaving printable text plus newlines/tabs/carriage-returns. Total —
 * never throws; non-string input degrades to "".
 * @param {unknown} s
 * @returns {string}
 */
export function stripAnsi(s) {
  return String(s == null ? "" : s)
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_MISC, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CTRL, "");
}

/**
 * Replace the last line of a channel with `line` (pushing it if the channel is
 * empty). Used to update the live, not-yet-terminated tail (the shell prompt)
 * in place as more bytes of the same line arrive, instead of appending a
 * duplicate. Returns the stored (clamped) line.
 * @param {BackdropModel} model
 * @param {string} channel
 * @param {string} line
 */
export function replaceLastLine(model, channel, line) {
  const id = ensureChannel(model, channel);
  const buf = model.channels[id];
  const clamped = clampLine(line);
  if (buf.length) buf[buf.length - 1] = clamped;
  else buf.push(clamped);
  model.active = id;
  return clamped;
}

// ---- scrolling the backdrop -------------------------------------------------
// The command log is no longer just a pinned tail: the user can scroll BACK into
// it (over the empty page field — the conversation bubbles keep their own
// scroll). These pure helpers own the offset math so the DOM glue
// (agent-backdrop.js) stays a thin wiring layer and the behavior is testable.

/** Coerce to a finite number, 0 on garbage. @param {unknown} x */
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

// How much the conversation leans OPPOSITE the backdrop as it scrolls, and the
// hard cap on that lean (px). "Ever so slightly, only for feel" — a small,
// springy nudge, never a persistent displacement (the DOM glue eases it back to
// zero so it can't drift the gap the user is reading in).
export const PARALLAX_FACTOR = 0.22;
export const PARALLAX_CAP_PX = 14;

/**
 * Clamp a backdrop scroll offset to the scrollable range. Offset 0 pins the
 * newest lines at the bottom (a live tail); the maximum reveals the oldest line
 * still buffered. Never negative, never past the top.
 * @param {unknown} offset
 * @param {unknown} contentHeight full height of the rendered text
 * @param {unknown} viewportHeight visible window height
 * @returns {number}
 */
export function clampScrollOffset(offset, contentHeight, viewportHeight) {
  const max = Math.max(0, num(contentHeight) - num(viewportHeight));
  return Math.max(0, Math.min(max, num(offset)));
}

/**
 * One wheel/drag step of the backdrop scroll. A positive delta (wheel down /
 * finger up) walks TOWARD the newest lines (offset → 0); a negative delta walks
 * back into history (offset grows, clamped to the buffered range).
 * @param {unknown} current current offset
 * @param {unknown} deltaY the gesture delta (wheel deltaY, or drag start−now)
 * @param {unknown} contentHeight
 * @param {unknown} viewportHeight
 * @returns {{ offset: number, pinned: boolean }} pinned = following the tail
 */
export function scrollStep(current, deltaY, contentHeight, viewportHeight) {
  const next = clampScrollOffset(num(current) - num(deltaY), contentHeight, viewportHeight);
  return { offset: next, pinned: next <= 0.5 };
}

/**
 * The conversation's opposite-direction parallax nudge for one backdrop scroll
 * step: a small displacement opposing the gesture, clamped to ±cap. Purely for
 * feel — the caller springs it back to zero.
 * @param {unknown} deltaY
 * @param {number} [factor]
 * @param {number} [cap]
 * @returns {number} px, in [-cap, cap]
 */
export function parallaxNudge(deltaY, factor = PARALLAX_FACTOR, cap = PARALLAX_CAP_PX) {
  const c = Math.abs(num(cap));
  const n = -num(deltaY) * num(factor);
  const r = Math.max(-c, Math.min(c, n));
  return r === 0 ? 0 : r; // normalize -0 → 0
}

// ---- the two-layer view switch ----------------------------------------------
// When the execution sandbox is running the page holds TWO stacked panes: the
// CONVERSATION and this TERMINAL backdrop. A tap on the bare page background
// (never on a message bubble, never on interactive chrome) swaps which pane is
// in front — the front one reads at full strength, the other recedes to a faint
// background. These are the pure pieces of that interaction: the mode toggle,
// the tap-vs-swipe discrimination, and the SAME-direction "follow" the
// BACKGROUND pane leans by while the foreground scrolls ("in synchronization …
// weaker and shorter" — the request). The DOM glue that reads targets, animates
// the slide, and wires the gestures lives in agent-backdrop.js.

/** The two foreground panes. */
export const LAYER_CONVO = "convo";
export const LAYER_TERMINAL = "terminal";

/**
 * Toggle the foreground pane. Anything that is not already the terminal flips TO
 * the terminal (so a first background tap always brings the terminal forward).
 * @param {unknown} mode
 * @returns {"convo"|"terminal"}
 */
export function nextLayerMode(mode) {
  return mode === LAYER_TERMINAL ? LAYER_CONVO : LAYER_TERMINAL;
}

// A press only counts as a "tap" (→ switch panes) when the pointer barely moved
// and lifted quickly; a longer drag is a scroll or a text selection and must
// NOT switch. Deliberately generous on distance (thumbs wobble) but tight on
// time so a slow press-and-hold to select text is excluded.
export const TAP_MOVE_TOL_PX = 10;
export const TAP_TIME_TOL_MS = 500;

/**
 * Whether a pointer gesture reads as a tap (vs a swipe / long press): the move
 * stayed within tolerance on BOTH axes and it lifted within the time window.
 * @param {unknown} dx horizontal travel
 * @param {unknown} dy vertical travel
 * @param {unknown} dt duration (ms)
 * @param {number} [moveTol]
 * @param {number} [timeTol]
 */
export function isTapGesture(dx, dy, dt, moveTol = TAP_MOVE_TOL_PX, timeTol = TAP_TIME_TOL_MS) {
  const mx = Math.abs(num(dx));
  const my = Math.abs(num(dy));
  const t = num(dt);
  return mx <= num(moveTol) && my <= num(moveTol) && t >= 0 && t <= num(timeTol);
}

// The BACKGROUND pane leans in the SAME direction as the foreground scroll, but
// weaker and shorter — the parallax the request describes as "in synchronization
// … weaker". Same clamped shape as parallaxNudge but NOT inverted (the caller
// passes an already-signed "how far the background should move" value) and a
// gentler factor.
export const FOLLOW_FACTOR = 0.14;
export const FOLLOW_CAP_PX = 10;

/**
 * The background pane's same-direction follow offset for one foreground scroll
 * step: the signed input scaled down and clamped to ±cap (sign preserved, so
 * the direction decision stays with the caller where the DOM context is known).
 * @param {unknown} delta signed background displacement request
 * @param {number} [factor]
 * @param {number} [cap]
 * @returns {number} px, in [-cap, cap]
 */
export function parallaxFollow(delta, factor = FOLLOW_FACTOR, cap = FOLLOW_CAP_PX) {
  const c = Math.abs(num(cap));
  const r = Math.max(-c, Math.min(c, num(delta) * num(factor)));
  return r === 0 ? 0 : r; // normalize -0 → 0
}
