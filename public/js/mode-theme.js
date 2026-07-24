// @ts-check
// The MODE-THEME REGISTRY — the codified catalog of what makes each mode
// visually its own. The site now speaks four sibling identities: two TIERS
// (DeepResearch.Se/cure and DeepResearch.Se/rver — separate served apps) and,
// WITHIN the Se/rver app, three chat MODES picked from the dropdown (Deep
// Research / Introspection / SDK — chat-mode.js). Each identity distinguishes itself the
// same way, along the SAME axes:
//
//   • a root THEME CLASS (the composer-pane tint + tag)   — chat-mode.js / CSS
//   • a palette ACCENT + a completion ✓ COLOR              — public/css/app.css
//   • a waiting-symbol SPINNER (the intro→loop→grow→✓ animation)
//   • a theme CHARACTER (the ghost / TIN / balloon / plant greeter)
//   • a side-PANEL flavour (plain history vs the SDK build-idea library)
//   • an agent BACKDROP (what drifts on the field behind the chat while agents
//     work: the sandbox terminal text, or the rotating workflow graph)
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
 * @property {string|null} tag       the small wordmark tag ("agent studio", …)
 * @property {string} accent         the mode's accent color
 * @property {string} bar            the iOS status-bar tint (theme-color meta) —
 *                                   the mode's field color, so the chrome above
 *                                   the app matches --bg (chat-mode.js applies it)
 * @property {string} check          the completion ✓ color (canvas + CSS agree)
 * @property {string} checkVar       the app.css custom property holding `check`
 * @property {"balloon"|"plant"} spinner  the waiting-symbol animation
 * @property {"balloon"|"tin"|"plant"} character  the theme character/greeter
 * @property {"history"|"showcase"} panel  the side-panel flavour
 * @property {"terminal"|"graph"} backdrop  the AGENT BACKGROUND behind the chat
 *                                  — what drifts on the field while agents
 *                                  work. "terminal" is the sandbox
 *                                  terminal-text layer (agent-backdrop.js,
 *                                  event-driven: it appears when a VM prints);
 *                                  "graph" is the hovering, slowly rotating
 *                                  wireframe workflow graph
 *                                  (graph-backdrop.js, mounted by
 *                                  mode-backdrop.js). Two implementations of
 *                                  one axis — an agent declares WHICH
 *                                  background it works in front of.
 * @property {boolean} depthSlider   whether the composer's research depth/time
 *                                   slider (#budget) applies in this mode — an
 *                                   OPTIONAL theme feature (owner, 2026-07-19):
 *                                   Deep Research researches so it shows it;
 *                                   Introspection (answers from source) and SDK
 *                                   (builds, no web research) don't need it, so
 *                                   the slider is hidden (CSS keys off the theme
 *                                   class, `:root.dev-mode`/`:root.sdk-mode`).
 * @property {string} symbol         the identity's symbol, in words
 * @property {string} blurb          one line: what the identity says
 */

/** The Se/rver-app chat modes, dropdown order. Mirrors chat-mode.js CHAT_MODES;
 * kept here too so the registry is self-describing. */
export const CHAT_MODE_IDS = ["normal", "introspection", "sdk", "orchestrator"];

/** The mode descriptors, keyed by id.
 * @type {Record<string, ModeTheme>} */
export const MODE_THEMES = {
  normal: {
    id: "normal",
    label: "Deep Research",
    rootClass: null,
    tag: null,
    accent: "#0d4fa0",
    bar: "#6fc3fd",
    check: "#0d4fa0",
    checkVar: "--check-blue",
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    backdrop: "terminal",
    depthSlider: true,
    symbol: "the balloon",
    blurb: "carried — the server lifts the load",
  },
  introspection: {
    id: "introspection",
    label: "Introspection",
    rootClass: "dev-mode",
    tag: "introspection",
    accent: "#5a6b7a",
    bar: "#ccd2d8", // brushed-silver status bar over the titanium field
    // Introspection wears the balloon spinner recoloured in TITANIUM (mode-
    // spinner.js TITANIUM_SPINNER), so its ✓ is titanium slate — the canvas fold
    // and the swapped-in real ✓ must agree, so check/checkVar point at app.css
    // --check-tin. The spinner KIND stays "balloon" (a recolour, not a new
    // figure); the palette lives in mode-spinner.js.
    check: "#5f6b78",
    checkVar: "--check-tin",
    spinner: "balloon",
    character: "tin",
    panel: "history",
    backdrop: "terminal",
    depthSlider: false, // answers from source — the research depth slider doesn't apply
    symbol: "TIN, the titanium mascot",
    blurb: "shown its own source — the site read from the inside",
  },
  sdk: {
    id: "sdk",
    label: "Agent Studio",
    rootClass: "sdk-mode",
    tag: "agent studio",
    accent: "#1f8a4c",
    bar: "#66cc92", // spring-green status bar over the green field
    check: "#1f8a4c",
    checkVar: "--check-green",
    spinner: "plant",
    character: "plant",
    panel: "showcase",
    backdrop: "terminal",
    depthSlider: false, // builds a flavour, no web research — the slider doesn't apply
    symbol: "the plant",
    blurb: "grown — a new flavour distilled and planted live",
  },
  orchestrator: {
    id: "orchestrator",
    label: "Orchestrator",
    rootClass: "orch-mode",
    tag: "orchestrator",
    accent: "#6d3fc4",
    bar: "#c3aaf2", // lavender status bar over the violet field
    check: "#6d3fc4",
    checkVar: "--check-violet",
    // The orchestrator wears the balloon spinner recoloured in VIOLET
    // (mode-spinner.js ORCH_SPINNER — the introspection-recolour pattern);
    // the KIND stays "balloon", the palette lives in mode-spinner.js.
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    backdrop: "graph", // the hovering workflow graph IS this mode's background
    depthSlider: false, // the plan phase decides the team's shape — the slider doesn't apply
    symbol: "the baton",
    blurb: "conducted — a team of sub-agents working in concert",
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
    bar: "#c3b091", // /cure's khaki chrome tint
    check: "#e06c8c",
    checkVar: "--check-pink",
    spinner: "balloon", // n/a here — Se/cure mounts the umbrella spinner in its own app
    character: "tin", // n/a — the ghost is Se/cure's character (public/cure/ghostwalk.js)
    panel: "history",
    backdrop: "terminal",
    depthSlider: true, // Se/cure has its own research depth control in its own app
    symbol: "the umbrella + the ghost",
    blurb: "sheltered — nothing leaves the device",
  },
  server: {
    id: "server",
    label: "Se/rver",
    rootClass: null,
    tag: null,
    accent: "#0d4fa0",
    bar: "#6fc3fd", // the Se/rver app's sky-blue chrome tint
    check: "#0d4fa0",
    checkVar: "--check-blue",
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    backdrop: "terminal",
    depthSlider: true,
    symbol: "the balloon",
    blurb: "carried — memory, reach and lift on your behalf",
  },
};

/**
 * The descriptor for a mode, falling back to Deep Research for anything unknown.
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

/** The iOS status-bar tint (theme-color) for a mode — its field color, so the
 * chrome above the app matches --bg. @param {unknown} mode @returns {string} */
export function barTint(mode) {
  return modeTheme(mode).bar;
}

/** The theme character/greeter for a mode. @param {unknown} mode @returns {"balloon"|"tin"|"plant"} */
export function modeCharacter(mode) {
  return modeTheme(mode).character;
}

/** Whether the composer's research depth/time slider applies in a mode (an
 * optional theme feature — hidden in Introspection and SDK). The CSS keys off
 * the theme class; this selector is the codified declaration + the testable
 * source of truth. @param {unknown} mode @returns {boolean} */
export function showsDepthSlider(mode) {
  return modeTheme(mode).depthSlider !== false;
}

/** The side-panel flavour for a mode. @param {unknown} mode @returns {"history"|"showcase"} */
export function panelFlavour(mode) {
  return modeTheme(mode).panel;
}

/** The agent-background flavour behind the chat for a mode — "terminal" (the
 * sandbox terminal-text layer) or "graph" (the rotating workflow graph). The
 * DOM dispatch lives in mode-backdrop.js. @param {unknown} mode @returns {"terminal"|"graph"} */
export function backdropKind(mode) {
  return modeTheme(mode).backdrop;
}
