// @ts-check
// The MODE-THEME REGISTRY — the codified catalog of what makes each mode
// visually its own. The site now speaks four sibling identities: two TIERS
// (DeepResearch.Se/cure and DeepResearch.Se/rver — separate served apps) and,
// WITHIN the Se/rver app, three chat MODES picked from the dropdown (Normal /
// Introspection / SDK — chat-mode.js). Each identity distinguishes itself the
// same way, along the SAME axes:
//
//   • a root THEME CLASS (the composer-pane tint + tag)   — chat-mode.js / CSS
//   • a palette ACCENT + a completion ✓ COLOR              — public/css/app.css
//   • a waiting-symbol SPINNER (the intro→loop→grow→✓ animation)
//   • a theme CHARACTER (the ghost / TIN / balloon / plant greeter)
//   • a side-PANEL flavour (plain history vs the SDK build-idea library)
//
// This module is the single place those choices are DECLARED as data, so a
// mode is described in one descriptor instead of scattered across CSS, the
// spinner mounts, and the history drawer. It is ALSO the shape SDK mode
// distills into: "the goal of the SDK mode itself is to create new themes of
// this kind" — a generated flavour defines its own MODE_THEME descriptor
// (color theme + spinner + character + panel), and the same axes light it up.
// docs/SYMBOL-LANGUAGE.md §7 is the prose companion.
//
// Pure and import-free — no DOM, no spinner modules — so it runs in Node's test
// runner (mode-theme.test.js) and a consumer can read a descriptor without
// pulling in canvas glue. The DOM dispatch lives in mode-spinner.js.

/**
 * @typedef {Object} ModeTheme
 * @property {string} id            the mode id (matches chat-mode.js CHAT_MODES)
 * @property {string} label         the human name shown in the dropdown
 * @property {string|null} rootClass the class toggled on <html> (null = none)
 * @property {string|null} tag       the small wordmark tag ("sdk studio", …)
 * @property {string} accent         the mode's accent color
 * @property {string} check          the completion ✓ color (canvas + CSS agree)
 * @property {string} checkVar       the app.css custom property holding `check`
 * @property {"balloon"|"plant"} spinner  the waiting-symbol animation
 * @property {"balloon"|"tin"|"plant"} character  the theme character/greeter
 * @property {"history"|"showcase"} panel  the side-panel flavour
 * @property {string} symbol         the identity's symbol, in words
 * @property {string} blurb          one line: what the identity says
 */

/** The Se/rver-app chat modes, dropdown order. Mirrors chat-mode.js CHAT_MODES;
 * kept here too so the registry is self-describing. */
export const CHAT_MODE_IDS = ["normal", "introspection", "sdk"];

/** The mode descriptors, keyed by id.
 * @type {Record<string, ModeTheme>} */
export const MODE_THEMES = {
  normal: {
    id: "normal",
    label: "Normal",
    rootClass: null,
    tag: null,
    accent: "#0d4fa0",
    check: "#0d4fa0",
    checkVar: "--check-blue",
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    symbol: "the balloon",
    blurb: "carried — the server lifts the load",
  },
  introspection: {
    id: "introspection",
    label: "Introspection",
    rootClass: "dev-mode",
    tag: "introspection",
    accent: "#5a6b7a",
    // Introspection keeps the Se/rver balloon spinner (its distinctness is the
    // titanium pane + the TIN mascot), so its ✓ stays the tier blue — the
    // canvas ✓ and the swapped-in real ✓ must not disagree. A dedicated
    // titanium spinner would be a drop-in here (set spinner + check together).
    check: "#0d4fa0",
    checkVar: "--check-blue",
    spinner: "balloon",
    character: "tin",
    panel: "history",
    symbol: "TIN, the titanium mascot",
    blurb: "shown its own source — the site read from the inside",
  },
  sdk: {
    id: "sdk",
    label: "SDK",
    rootClass: "sdk-mode",
    tag: "sdk studio",
    accent: "#1f8a4c",
    check: "#1f8a4c",
    checkVar: "--check-green",
    spinner: "plant",
    character: "plant",
    panel: "showcase",
    symbol: "the plant",
    blurb: "grown — a new flavour distilled and planted live",
  },
};

/** The two TIER identities, recorded for the catalog SDK mode reshapes into new
 * flavours. These are SEPARATE served apps (public/cure/* vs public/*), not
 * Se/rver-app modes — reference entries only, never selected here. Se/cure is
 * listed FIRST (the branding secure-first rule). @type {Record<string, ModeTheme>} */
export const TIER_THEMES = {
  secure: {
    id: "secure",
    label: "Se/cure",
    rootClass: null,
    tag: null,
    accent: "#7c6a24",
    check: "#e06c8c",
    checkVar: "--check-pink",
    spinner: "balloon", // n/a here — Se/cure mounts the umbrella spinner in its own app
    character: "tin", // n/a — the ghost is Se/cure's character (public/cure/ghostwalk.js)
    panel: "history",
    symbol: "the umbrella + the ghost",
    blurb: "sheltered — nothing leaves the device",
  },
  server: {
    id: "server",
    label: "Se/rver",
    rootClass: null,
    tag: null,
    accent: "#0d4fa0",
    check: "#0d4fa0",
    checkVar: "--check-blue",
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    symbol: "the balloon",
    blurb: "carried — memory, reach and lift on your behalf",
  },
};

/**
 * The descriptor for a mode, falling back to Normal for anything unknown.
 * @param {unknown} mode
 * @returns {ModeTheme}
 */
export function modeTheme(mode) {
  const id = typeof mode === "string" ? mode : "";
  return MODE_THEMES[id] || MODE_THEMES.normal;
}

/** The waiting-symbol spinner kind for a mode. @param {unknown} mode @returns {"balloon"|"plant"} */
export function spinnerKind(mode) {
  return modeTheme(mode).spinner;
}

/** The completion ✓ color for a mode. @param {unknown} mode @returns {string} */
export function checkColor(mode) {
  return modeTheme(mode).check;
}

/** The theme character/greeter for a mode. @param {unknown} mode @returns {"balloon"|"tin"|"plant"} */
export function modeCharacter(mode) {
  return modeTheme(mode).character;
}

/** The side-panel flavour for a mode. @param {unknown} mode @returns {"history"|"showcase"} */
export function panelFlavour(mode) {
  return modeTheme(mode).panel;
}
