// @ts-check
// The chat MODE dropdown's state + theming — Normal / Introspection / SDK
// (owner directive, 2026-07-18: introspection and SDK as explicit modes
// alongside Normal, picked in a dropdown; the titanium-white composer pane
// marks introspection, GREEN marks the SDK "lovable experience" mode).
// Normal is labeled **Deep Research** in the UI (owner directive, 2026-07-23);
// the mode id stays `normal` — same convention as SDK mode staying `sdk`
// while labeled "Agent Studio".
//
// The mode is a per-BROWSER choice (localStorage `dr_chat_mode`) layered on
// top of the server's developer_mode capability knob:
//
//   normal        → the request carries `developer_mode: false` (the existing
//                   off-only override), so a knob-on account still gets plain
//                   web research. No theme class.
//   introspection → the classic developer-mode behavior (the knob must be on;
//                   picking the mode flips it via PUT /api/settings). Theme:
//                   the `dev-mode` root class (dev-mode.js's titanium pane).
//   sdk           → the request carries `sdk_mode: true` (chat.js), routing to
//                   the DistillSDK build flow — distill this site (above all
//                   the Se/cure tier) into a new flavour published at a live
//                   URL. Same knob gate. Theme: the `sdk-mode` root class (the
//                   green pane).
//   orchestrator  → the request carries `orchestrator_mode: true` (chat.js),
//                   routing to the sub-agent workflow flow (src/orchestrator.js)
//                   — a planned team of sub-agents runs in the background and
//                   the workflow is shown live. Same knob gate. Theme: the
//                   `orch-mode` root class (the violet pane).
//
// This module does NOT own the `dr_dev_mode` knob cache — that stays
// dev-mode.js's mirror of the server knob. It only decides which THEME class
// the root carries and which mode the next send declares. Like dev-mode.js it
// has an inline first-paint twin in index.html (<script data-devtheme>) —
// if the class logic here changes, update that script AND recompute its CSP
// hash (THEME_BOOT_HASH in src/security-headers.js).
//
// Import-safe in Node (unit-tested without a DOM): every document /
// localStorage access is guarded and fails soft.

import { DEV_MODE_CLASS, cachedDeveloperMode } from "./dev-mode.js";
import { barTint } from "./mode-theme.js";

/** The localStorage key holding the picked chat mode. */
export const CHAT_MODE_KEY = "dr_chat_mode";
/** The root class carrying the green SDK-mode pane tint. */
export const SDK_MODE_CLASS = "sdk-mode";
/** The root class carrying the violet Orchestrator-mode pane tint. */
export const ORCH_MODE_CLASS = "orch-mode";
/** The modes, dropdown order. */
export const CHAT_MODES = ["normal", "introspection", "sdk", "orchestrator"];

/**
 * Clamp any value to a known mode.
 * @param {unknown} v
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeChatMode(v, fallback = "normal") {
  return CHAT_MODES.includes(/** @type {string} */ (v)) ? /** @type {string} */ (v) : fallback;
}

/**
 * The mode to paint/send with right now, synchronously. An explicit stored
 * choice wins; with none stored, a cached developer-mode knob reads as
 * "introspection" (the pre-dropdown behavior — a returning introspection user
 * keeps their titanium pane), everyone else is "normal".
 * @returns {string}
 */
export function cachedChatMode() {
  try {
    const stored = globalThis.localStorage?.getItem(CHAT_MODE_KEY);
    if (stored) return normalizeChatMode(stored);
  } catch {
    /* storage unavailable */
  }
  return cachedDeveloperMode() ? "introspection" : "normal";
}

/**
 * Persist the picked mode ("normal" is stored too — an explicit Normal pick
 * on a knob-on account must survive reloads). Fail-soft.
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
  } catch {
    /* no DOM (tests) — persistence above is the durable part */
  }
  // Repaint the iOS status-bar tint to the new mode's field color, so switching
  // modes moves the chrome above the app too (each mode is a full theme). A
  // direct set suffices for a switch (the value actually changes, so WebKit
  // re-evaluates); bar-tint.js owns the layered re-asserts. Guarded separately
  // so a DOM-less test never loses the class toggles above.
  try {
    globalThis.document
      ?.querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", barTint(m));
  } catch {
    /* no DOM / no meta — bar-tint.js still re-asserts the current mode */
  }
  return m;
}

/**
 * Reconcile the mode with the server's authoritative developer_mode knob once
 * /api/settings resolves: a non-normal mode needs the capability, so a knob
 * turned off elsewhere downgrades the stored mode to normal; a knob-on
 * account with no stored choice keeps the legacy "introspection" default.
 * Returns the effective mode (already applied + persisted when it changed).
 * @param {boolean} devKnobOn
 * @returns {string}
 */
export function reconcileChatMode(devKnobOn) {
  const current = cachedChatMode();
  const effective = devKnobOn || current === "normal" ? current : "normal";
  applyChatModeTheme(effective);
  return effective;
}
