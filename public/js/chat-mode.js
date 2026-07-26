// @ts-check
// The chat MODE dropdown's state + theming — Normal / Introspection / SDK
// (owner directive, 2026-07-18: introspection and SDK as explicit modes
// alongside Normal, picked in a dropdown; the titanium-white composer pane
// marks introspection, GREEN marks the SDK "lovable experience" mode).
// Normal is labeled **Deep Research** in the UI (owner directive, 2026-07-23);
// the mode id stays `normal` — same convention as SDK mode staying `sdk`
// while labeled "Agent Studio".
//
// THE MODE IS THE UNIT (2026-07-26). Every request names its mode —
// `chat_mode: "<mode>"` — and the theme, the answer phase and whether the site's
// own source is in context are all derived from that one value. The table of
// modes and the wire resolution live in the shared pure core
// chat-mode-core.js, so this module is only the BROWSER half: which theme class
// the root carries and where the pick is cached.
//
//   normal        → plain deep research. No theme class.
//   introspection → answers from this site's own deployed source. Theme: the
//                   `dev-mode` root class (dev-mode.js's titanium pane).
//   sdk           → the DistillSDK build flow — distill this site (above all the
//                   Se/cure tier) into a new flavour published at a live URL.
//                   Theme: the `sdk-mode` root class (the green pane).
//   orchestrator  → the sub-agent workflow flow (src/orchestrator.js): a planned
//                   team of sub-agents runs in the background and the workflow is
//                   shown live. Theme: `orch-mode` (the violet pane).
//   outrospection → the outward feed (src/outrospect.js) — introspection's mirror
//                   image, answering from what everyone ELSE shipped. Theme:
//                   `outro-mode` (the newsprint pane).
//   models        → the MODEL-LIFECYCLE agent (src/models-agent.js): Hub search
//                   forced every turn, and a message about models answered
//                   against the live cross-provider catalog, priced and annotated
//                   with what has been verified. Theme: `models-mode` (amber).
//
// There used to be a per-account `developer_mode` knob underneath all of this,
// and the dropdown wrote it on every change ("on" for any non-Normal mode). That
// made the same choice live in three places — the D1 knob, the `dr_dev_mode`
// cache and the mode key here — which had to be reconciled on every page load.
// Now the SERVER stores the mode (settings_json.chat_mode) and this key is
// simply its first-paint CACHE: the cached value paints immediately, the
// server's value replaces it when /api/settings resolves, and there is no
// downgrade rule to get wrong.
//
// Like dev-mode.js this module has an inline first-paint twin in index.html
// (<script data-devtheme>) — if the class logic here changes, update that
// script AND recompute its CSP hash (THEME_BOOT_HASH in
// src/security-headers.js).
//
// Import-safe in Node (unit-tested without a DOM): every document /
// localStorage access is guarded and fails soft.

import { CHAT_MODES, DEFAULT_CHAT_MODE, normalizeChatMode } from "./chat-mode-core.js";
import { DEV_MODE_CLASS } from "./dev-mode.js";
import { barTint } from "./mode-theme.js";
import { nudgeTint } from "./bar-tint.js";

export { CHAT_MODES, DEFAULT_CHAT_MODE, normalizeChatMode };

/** The localStorage key caching the picked chat mode for first paint. */
export const CHAT_MODE_KEY = "dr_chat_mode";
/** The root class carrying the green SDK-mode pane tint. */
export const SDK_MODE_CLASS = "sdk-mode";
/** The root class carrying the violet Orchestrator-mode pane tint. */
export const ORCH_MODE_CLASS = "orch-mode";
/** The root class carrying the newsprint Outrospection-mode pane tint. */
export const OUTRO_MODE_CLASS = "outro-mode";
/** The root class carrying the amber Models-mode pane tint. */
export const MODELS_MODE_CLASS = "models-mode";
/**
 * The mode to paint/send with right now, synchronously — the cached answer used
 * at first paint, before /api/settings resolves. "normal" when nothing is
 * cached or storage is unavailable (the safe default: the ordinary composer
 * pane and plain deep research).
 * @returns {string}
 */
export function cachedChatMode() {
  try {
    const stored = globalThis.localStorage?.getItem(CHAT_MODE_KEY);
    if (stored) return normalizeChatMode(stored);
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_CHAT_MODE;
}

/**
 * Cache the picked mode ("normal" is stored too — an explicit Normal pick must
 * survive reloads rather than reading as "nothing chosen"). Fail-soft.
 * @param {string} mode
 * @returns {string} the stored (normalized) mode
 */
export function storeChatMode(mode) {
  const m = normalizeChatMode(mode);
  try {
    globalThis.localStorage?.setItem(CHAT_MODE_KEY, m);
  } catch {
    /* storage unavailable — the theme still applies for this page */
  }
  return m;
}

/**
 * Apply a mode's theme: exactly one of the `dev-mode` / `sdk-mode` root classes
 * (or none, for normal). Persists unless {persist:false} (the boot-time cached
 * apply is READING the cache, not deciding).
 * @param {string} mode
 * @param {{ persist?: boolean }} [opts]
 * @returns {string} the applied (normalized) mode
 */
export function applyChatModeTheme(mode, opts) {
  const m = normalizeChatMode(mode);
  if (!opts || opts.persist !== false) storeChatMode(m);
  try {
    const root = globalThis.document?.documentElement;
    root?.classList?.toggle(DEV_MODE_CLASS, m === "introspection");
    root?.classList?.toggle(SDK_MODE_CLASS, m === "sdk");
    root?.classList?.toggle(ORCH_MODE_CLASS, m === "orchestrator");
    root?.classList?.toggle(OUTRO_MODE_CLASS, m === "outrospection");
    root?.classList?.toggle(MODELS_MODE_CLASS, m === "models");
  } catch {
    /* no DOM (tests) — persistence above is the durable part */
  }
  // Repaint the iOS status-bar tint to the new mode's field color, so switching
  // modes moves the chrome above the app too (each mode is a full theme). A
  // single direct set is NOT enough here: iPhone left the strip behind the
  // status icons on the previous mode's blue across a switch (feedback #20,
  // 2026-07-24) — the same swallowing the 2026-07-10/17 navigation fixes hit —
  // so the switch gets bar-tint.js's layered changed-then-target nudge too.
  // The getter re-reads the stored mode so a rapid second switch's lagged
  // timers repaint the CURRENT pick, never a stale one (a non-persisted apply
  // paints its own mode — boot passes the cached value, so they agree).
  // Guarded separately so a DOM-less test never loses the class toggles above.
  try {
    const persisted = !opts || opts.persist !== false;
    nudgeTint(() => barTint(persisted ? cachedChatMode() : m));
  } catch {
    /* no DOM / no meta — bar-tint.js's boot wiring still re-asserts */
  }
  return m;
}

/**
 * Adopt the server's mode once /api/settings resolves. The account's stored
 * `chat_mode` is the authority — it follows the account across devices, and the
 * server has already forced it to "normal" if the modes are unavailable — so
 * this is a plain cache write plus a repaint, with no downgrade rule to get
 * wrong. (It replaced `reconcileChatMode`, which existed only to referee
 * between the local mode pick and the separate developer_mode knob.)
 *
 * A server payload that does not carry `chat_mode` at all — an older or partial
 * response — leaves the cached pick alone rather than resetting it to normal.
 * @param {{ chat_mode?: string } | null | undefined} serverSettings
 * @returns {string} the effective mode (applied + cached)
 */
export function adoptServerChatMode(serverSettings) {
  const named = normalizeChatMode(serverSettings?.chat_mode, "");
  return applyChatModeTheme(named || cachedChatMode());
}
