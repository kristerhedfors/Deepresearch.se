// @ts-check
// Introspection mode's CLIENT presentation + persistence — the white-titanium cue.
//
// Introspection mode (the `developer_mode` knob, src/settings.js) is remembered
// SERVER-SIDE per account, so the mode itself already follows the account
// across devices. But the server's answer only arrives after /api/settings
// resolves — one round-trip into the page load — and an installed PWA
// relaunches from a device-cached shell that may paint before that answer comes
// back. So the CUE needs a local, synchronous source of truth to apply at first
// paint, or a returning introspection-mode user would flash the ordinary
// composer pane on every cold relaunch before the white-titanium tint settles.
//
// This module is that local cache. It mirrors the server knob into
// localStorage (`dr_dev_mode`) and toggles a `dev-mode` class on the ROOT
// element. The cue is DELIBERATELY narrow: the sky-blue background and the
// whole palette are unchanged — only the composer input pane picks up a
// white-titanium glass tint (CSS `:root.dev-mode #composer` in public/css/app.css),
// so introspection is recognizable without re-skinning the app or the iOS
// status bar. (The class/key names keep the historical `dev` token — internal
// identifiers, not user-facing copy; the mode is named "Introspection" in the
// UI.)
//
// Boot order:
//   0. A tiny inline `<script data-devtheme>` in index.html's <head> adds the
//      class at PARSE TIME, before first paint, so the composer is tinted from
//      the first frame on a PWA relaunch. That inline copy is deliberately
//      minimal; this module is the full logic.
//   1. At app.js module top, apply the CACHED value again (a no-op if the
//      inline script already set the class).
//   2. When loadSettings() resolves, reconcile with the server's AUTHORITATIVE
//      developer_mode (a flip on another device, or an account that never had
//      the local cache) → applyDeveloperTheme rewrites the class and cache.
// The knob (public/js/account-views.js wireDeveloperKnob) also calls
// applyDeveloperTheme on toggle, so the pane tint flips the moment it's
// switched.
//
// Import-safe in Node (the unit test runs without a DOM): every document /
// localStorage access is guarded and fails soft to "off".

/** The localStorage key mirroring the server's developer_mode knob. */
export const DEV_MODE_KEY = "dr_dev_mode";
/** The class toggled on documentElement to tint the composer pane. */
export const DEV_MODE_CLASS = "dev-mode";

/**
 * The locally-cached developer-mode state — the synchronous answer used at
 * first paint before /api/settings resolves. False (the safe default: the
 * ordinary composer pane) when there is no cache or storage is unavailable.
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
 * Apply (or clear) the white-titanium introspection cue: toggle the root class and,
 * unless told otherwise, persist the value so the next load paints it
 * immediately. The boot-time cached apply passes { persist: false } — it is
 * READING the cache, not making a new decision. The class alone drives the
 * composer-pane tint (CSS); the background and iOS status bar are untouched.
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
  return !!on;
}
