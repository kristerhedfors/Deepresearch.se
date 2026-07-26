// @ts-check
// Introspection mode's CLIENT presentation + persistence — the white-titanium cue.
//
// Introspection mode is remembered SERVER-SIDE per account (the account's
// `chat_mode` — src/settings.js), so the mode itself already follows the account
// across devices. But the server's answer only arrives after /api/settings
// resolves — one round-trip into the page load — and an installed PWA
// relaunches from a device-cached shell that may paint before that answer comes
// back. So the CUE needs a local, synchronous source of truth to apply at first
// paint, or a returning introspection-mode user would flash the ordinary
// composer pane on every cold relaunch before the white-titanium tint settles.
// That cache is the shared mode key (`dr_chat_mode`, chat-mode.js) — this module
// used to keep a SECOND boolean cache (`dr_dev_mode`) mirroring the retired
// developer_mode knob, which is one of the three copies the 2026-07-26 collapse
// removed.
//
// What is left here is the class toggle: `dev-mode` on the ROOT
// element. That single class drives introspection's COMPLETE titanium theme in
// CSS (owner directive, 2026-07-23): the whole palette is remapped under
// `:root.dev-mode` (public/css/app.css) — the brushed-silver field + drifting
// waves, slate accents, the rose-white composer pane, and the titanium ✓ — so
// the theme runs throughout, not just the input pane. The waiting spinner
// (mode-spinner.js) and the entry mascot (TIN, introspect-ui.js) complete it.
// The status-bar tint is driven per-mode from chat-mode.js. (The class name
// keeps the historical `dev` token — an internal identifier, not user-facing
// copy; the mode is named "Introspection" in the UI.)
//
// Boot order:
//   0. A tiny inline `<script data-devtheme>` in index.html's <head> adds the
//      class at PARSE TIME, before first paint, so the composer is tinted from
//      the first frame on a PWA relaunch. That inline copy is deliberately
//      minimal; chat-mode.js is the full logic.
//   1. At app.js module top, apply the CACHED mode again (a no-op if the inline
//      script already set the class).
//   2. When loadSettings() resolves, adopt the server's authoritative
//      `chat_mode` (a change on another device, or a browser that never had the
//      local cache) → applyChatModeTheme rewrites the class and the cache.
// The Chat mode dropdown (public/js/account-views.js wireModeKnob) writes the
// mode and applies the theme together, so the pane tint flips the moment the
// mode is picked.
//
// Import-safe in Node (the unit test runs without a DOM): every document access
// is guarded and fails soft.

/** The class toggled on documentElement to tint the composer pane. */
export const DEV_MODE_CLASS = "dev-mode";

/**
 * Apply (or clear) the white-titanium introspection cue. The class alone drives
 * the whole titanium theme (CSS `:root.dev-mode`); the status-bar tint is
 * applied separately, per-mode, from chat-mode.js — which is also what callers
 * should use (`applyChatModeTheme`) to change modes. This is the single-class
 * primitive it toggles, exported for the introspection-only call sites and the
 * unit test.
 * @param {boolean} on
 * @returns {boolean} the applied value
 */
export function applyDeveloperTheme(on) {
  try {
    const root = globalThis.document?.documentElement;
    root?.classList?.toggle(DEV_MODE_CLASS, !!on);
  } catch {
    /* no DOM (SSR/tests) — nothing else to do */
  }
  return !!on;
}
