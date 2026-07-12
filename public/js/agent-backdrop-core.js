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

/**
 * Map the user's 0..100 slider to the layer's actual CSS opacity. The ceiling
 * is deliberately below 1 (0.55) so even "full" stays a faint backdrop the
 * chat reads cleanly over — the slider tunes within the faint band, it does
 * not turn the page into a terminal.
 * @param {number} pct
 * @returns {number} 0..0.55
 */
export function opacityCss(pct) {
  return +(clampOpacityPct(pct) / 100 * 0.55).toFixed(3);
}
