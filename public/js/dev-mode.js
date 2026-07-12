// @ts-check
// Developer mode's CLIENT presentation + persistence — the titanium-gray theme.
//
// Developer mode (the introspection gate, src/settings.js `developer_mode`) is
// remembered SERVER-SIDE per account, so the mode itself already follows the
// account across devices. But the server's answer only arrives after
// /api/settings resolves — one round-trip into the page load — and an installed
// PWA relaunches from a device-cached shell that may paint before that answer
// comes back. So the THEME (titanium gray) needs a local, synchronous source of
// truth to apply at first paint, or a returning developer-mode user would flash
// the ordinary blue palette on every cold relaunch.
//
// This module is that local cache. It mirrors the server knob into
// localStorage (`dr_dev_mode`) and toggles a `dev-mode` class on the ROOT
// element (documentElement, not body — the html background reads the palette
// variables, so the class that overrides them must sit on the same element).
// CSS `:root.dev-mode { … }` (public/css/app.css) repaints the whole palette.
//
// Boot order:
//   0. A tiny inline `<script data-devtheme>` in index.html's <head> applies the
//      cached value at PARSE TIME, before first paint — the ONLY point early
//      enough that iOS honors the standalone status-bar tint for a PWA relaunch
//      (an in-place JS change after the bar settles is ignored; the khaki /cure
//      tint works for the same reason — it's set on a fresh page load). That
//      inline copy is deliberately minimal; this module is the full logic.
//   1. At app.js module top, apply the CACHED value again (class no-op if the
//      inline script already set it; also re-asserts the status-bar tint).
//   2. When loadSettings() resolves, reconcile with the server's AUTHORITATIVE
//      developer_mode (a flip on another device, or an account that never had
//      the local cache) → applyDeveloperTheme rewrites the class, cache, and tint.
// The developer knob (public/js/account-views.js wireDeveloperKnob) also calls
// applyDeveloperTheme on toggle, so the palette flips the moment it's switched.
//
// Import-safe in Node (the unit test runs without a DOM): every document /
// localStorage access is guarded and fails soft to "off".

/** The localStorage key mirroring the server's developer_mode knob. */
export const DEV_MODE_KEY = "dr_dev_mode";
/** The class toggled on documentElement to repaint the titanium palette. */
export const DEV_MODE_CLASS = "dev-mode";

// The iOS status-bar / theme-color tint. On an iPhone the strip behind the
// status bar is painted from the `theme-color` meta, NOT from CSS — so the
// palette swap alone leaves a blue bar above a titanium page (reported live).
// These are the two target tints: the titanium field (matches --bg in dev
// mode) and the original sky blue when dev mode is off.
const THEME_COLOR_DEV = "#8b9299";
const THEME_COLOR_DEFAULT = "#6fc3fd"; // must match the static meta in index.html

/**
 * Re-tint the iOS status bar to match the active theme. WebKit pins the bar
 * tint and ignores a plain content swap, so — exactly like cure/drc.js does
 * across the ghost-button navigation — we nudge the meta to a near value then
 * to the target across two animation frames, forcing a re-evaluation. Guarded
 * for Node (no document / no rAF): a missing meta or missing rAF degrades to a
 * direct set or a no-op.
 * @param {string} color
 */
function paintStatusBar(color) {
  try {
    const meta = globalThis.document?.querySelector?.('meta[name="theme-color"]');
    if (!meta) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === "function") {
      // A one-digit nudge off the target — enough to change the string so
      // WebKit re-reads it, invisible to the eye.
      const nudged = color.slice(0, -1) + (color.endsWith("e") ? "d" : "e");
      raf(() => {
        meta.setAttribute("content", nudged);
        raf(() => meta.setAttribute("content", color));
      });
    } else {
      meta.setAttribute("content", color);
    }
  } catch {
    /* no DOM — the class + cache are the durable parts */
  }
}

/**
 * The locally-cached developer-mode state — the synchronous answer used at
 * first paint before /api/settings resolves. False (the safe default: the
 * ordinary palette) when there is no cache or storage is unavailable.
 * @returns {boolean}
 */
export function cachedDeveloperMode() {
  try {
    return globalThis.localStorage?.getItem(DEV_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Mirror the developer-mode state into localStorage (removed when off, so the
 * default absence reads as off). Fail-soft — private-mode storage throwing
 * must never break the toggle.
 * @param {boolean} on
 * @returns {boolean} the stored value (echoed for chaining)
 */
export function storeDeveloperMode(on) {
  try {
    if (on) globalThis.localStorage?.setItem(DEV_MODE_KEY, "1");
    else globalThis.localStorage?.removeItem(DEV_MODE_KEY);
  } catch {
    /* storage unavailable — the theme still applies for this page */
  }
  return !!on;
}

/**
 * Apply (or clear) the titanium-gray theme: toggle the root class and, unless
 * told otherwise, persist the value so the next load paints it immediately.
 * The boot-time cached apply passes { persist: false } — it is READING the
 * cache, not making a new decision.
 * @param {boolean} on
 * @param {{ persist?: boolean }} [opts]
 * @returns {boolean} the applied value
 */
export function applyDeveloperTheme(on, opts) {
  if (!opts || opts.persist !== false) storeDeveloperMode(on);
  try {
    const root = globalThis.document?.documentElement;
    root?.classList?.toggle(DEV_MODE_CLASS, !!on);
  } catch {
    /* no DOM (SSR/tests) — persistence above is the durable part */
  }
  // Match the iOS status-bar tint to the palette (the blue-strip-above-titanium
  // fix). Runs on every path — boot cache-apply, server reconcile, knob toggle.
  paintStatusBar(on ? THEME_COLOR_DEV : THEME_COLOR_DEFAULT);
  return !!on;
}
