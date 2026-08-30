// @ts-check
// The MODE-THEME REGISTRY — the codified catalog of what makes each mode
// visually its own. The site speaks two TIERS (DeepResearch.Se/cure and
// DeepResearch.Se/rver — separate served apps) and, WITHIN the Se/rver app,
// seven chat MODES picked from the dropdown (Deep Science / Cyber /
// Introspection / Agent Studio / Orchestrator / Outrospection / Models —
// chat-mode.js). Each identity distinguishes itself the same way, along the
// SAME axes:
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
// spinner mounts, and the history drawer. Its CHAT_MODE_IDS is also what
// agent-spec-core.js validates an AgentSpec's `mode` against, and each mode's
// default agent must agree with the descriptor here on backdrop and
// depth-slider (pinned in public/js/agent-capability.test.js). It is ALSO the shape SDK mode
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
 * @property {"history"|"showcase"|"models"} panel  the side-panel flavour
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
 *                                   a mode that researches shows it (Deep
 *                                   Science reads the literature, Cyber sweeps
 *                                   hosts and open sources, Models surveys the
 *                                   landscape); Introspection (answers from
 *                                   source) and SDK (builds, no web research)
 *                                   don't need it, so the slider is hidden (CSS
 *                                   keys off the theme class,
 *                                   `:root.dev-mode`/`:root.sdk-mode`).
 * @property {string} symbol         the identity's symbol, in words
 * @property {string} blurb          one line: what the identity says
 */

/** The Se/rver-app chat modes, dropdown order. Mirrors chat-mode.js CHAT_MODES;
 * kept here too so the registry is self-describing. */
export const CHAT_MODE_IDS = ["science", "cyber", "introspection", "sdk", "orchestrator", "outrospection", "models", "lypning"];

/** The mode descriptors, keyed by id.
 *
 * There is NO general descriptor any more (owner directive, 2026-08-13). The
 * first entry used to be `normal` — labeled "Deep Research", the unthemed mode
 * with `rootClass: null` that every other descriptor was implicitly described
 * against ("where Normal folds to --check-blue"). It is gone with the general
 * agent, and Deep Science took both its dropdown seat and its role as the
 * fallback `modeTheme()` returns. The Se/rver TIER keeps the balloon-and-blue
 * identity that used to be Normal's — it is in TIER_THEMES below, where it now
 * carries it alone.
 * @type {Record<string, ModeTheme>} */
export const MODE_THEMES = {
  science: {
    id: "science",
    label: "Deep Science",
    rootClass: "sci-mode",
    tag: "deep science",
    // Parchment gold — the agent's own declared accent (sdk/AGENTS.json
    // `scholar.theme.--agent-accent`), so the mode a user picks and the agent
    // registry describe the same identity rather than two that merely look
    // alike. It reads as a reading room next to Models' workshop amber.
    accent: "#b08d3f",
    bar: "#e8d9a8", // aged-paper status bar over the warm dark field
    check: "#b08d3f",
    checkVar: "--check-gold",
    // The balloon recoloured in GOLD (mode-spinner.js SCIENCE_SPINNER) — the
    // introspection/orchestrator/outrospection/models recolour pattern; the
    // KIND stays "balloon", the palette lives in mode-spinner.js.
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    backdrop: "terminal",
    // The slider applies. It does real literature research, over a corpus
    // rather than the open web, and depth buys exactly what it buys everywhere
    // else: more searches, more sources. The modes that hide it hide it because
    // their answer does not come from a search at all — that is the distinction
    // the slider tracks, and it never was "is it the general mode".
    depthSlider: true,
    symbol: "the reading room",
    blurb: "read — only what survived peer review, and nothing that did not",
  },
  cyber: {
    id: "cyber",
    label: "Cyber",
    rootClass: "cyber-mode",
    tag: "cyber",
    // Alert crimson — the agent's own declared accent (sdk/AGENTS.json
    // `cyber.theme.--agent-accent`), so the mode a user picks and the agent
    // registry describe one identity rather than two that merely look alike.
    // It is deliberately NOT Outrospection's masthead red (#8f1d14): that one
    // is ink printed on paper, this one is a warning drawn on a dark screen,
    // and the two are never on the field at the same time.
    accent: "#b32d3a",
    bar: "#ff7a86", // alarm rose over the darkened operations field
    // The ✓ is the accent itself, so the crimson that marks the agent also
    // marks its finished steps. It cannot borrow --check-red, which
    // Outrospection already owns at a different value — two modes sharing one
    // custom property is how a recolour silently stops matching its spinner.
    check: "#b32d3a",
    checkVar: "--check-crimson",
    // The balloon recoloured in CRIMSON (mode-spinner.js CYBER_SPINNER) — the
    // introspection/orchestrator/outrospection/models/science recolour pattern;
    // the KIND stays "balloon", the palette lives in mode-spinner.js.
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    // The sandbox terminal-text layer, and this is the mode where it reads as
    // the room's own furniture rather than as a decoration: a security turn
    // that sweeps a host or walks a scene is exactly the work a terminal shows.
    backdrop: "terminal",
    // The slider applies. This agent researches for real — host intelligence,
    // street imagery, open-source records about an entity, the appsec
    // reference — and depth buys the same thing it buys anywhere else: more
    // queries answered before the synthesis runs.
    depthSlider: true,
    symbol: "the sweep",
    blurb: "swept — what is exposed, from the outside, before someone else looks",
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
  outrospection: {
    id: "outrospection",
    label: "Outrospection",
    rootClass: "outro-mode",
    tag: "outrospection",
    accent: "#8f1d14",
    bar: "#e5ddcb", // newsprint status bar over the paper field
    check: "#8f1d14",
    checkVar: "--check-red",
    // Outrospection wears the balloon recoloured in NEWSPRINT (mode-spinner.js
    // NEWSPRINT_SPINNER) — the introspection/orchestrator recolour pattern; the
    // KIND stays "balloon", the palette lives in mode-spinner.js.
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    backdrop: "terminal",
    depthSlider: false, // answers from the feed, not from web research — the slider doesn't apply
    symbol: "the front page",
    blurb: "looked outward — what everyone else shipped",
  },
  models: {
    id: "models",
    label: "Models",
    rootClass: "models-mode",
    tag: "models",
    // Amber — the workshop light. This is the mode where models are examined
    // before anyone relies on them, so it reads as a bench rather than as
    // another research field.
    accent: "#b8860b",
    bar: "#ffd21e", // amber status bar over the warm field
    check: "#b8860b",
    checkVar: "--check-amber",
    // The balloon recoloured in AMBER (mode-spinner.js MODELS_SPINNER) — the
    // introspection/orchestrator/outrospection recolour pattern; the KIND stays
    // "balloon", the palette lives in mode-spinner.js.
    spinner: "balloon",
    character: "balloon",
    // The one mode whose side panel is NOT chat history: it is the model
    // lifecycle board — every model this deployment can reach, its state, and
    // its verification checklist (public/js/models-panel.js).
    panel: "models",
    backdrop: "terminal",
    depthSlider: true, // it researches the landscape like any other subject — the slider applies
    symbol: "the bench",
    blurb: "examined — every model weighed, priced and checked before anyone leans on it",
  },
  lypning: {
    id: "lypning",
    label: "lypning",
    rootClass: "lypning-mode",
    tag: "lypning",
    // Green — the colour the dashboard already uses for MEASURED HERE, and the
    // whole point of this mode is which numbers are yours. It is the one mode
    // whose accent means something outside the theme.
    accent: "#1baf7a",
    bar: "#23b483",
    check: "#1baf7a",
    checkVar: "--check-green",
    spinner: "balloon",
    character: "balloon",
    panel: "history",
    backdrop: "terminal",
    // NO depth slider. Depth buys more searching, and this mode searches
    // nothing: it answers from a fixed dataset and from whatever the reader's
    // own VM measured. A slider here would promise a knob that does nothing.
    depthSlider: false,
    symbol: "the stopwatch",
    blurb: "measured — your machine's numbers and the project's own, never mistaken for each other",
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

// EVERY root class any mode declares, derived from the descriptors above rather
// than listed by hand. chat-mode.js clears this whole set and re-adds only the
// current mode's class, so adding a mode to MODE_THEMES is enough to make its
// theme switch correctly in both directions.
//
// Listing them by hand is exactly what broke (2026-08-02): Deep Science shipped
// with `rootClass: "sci-mode"` and the parse-time boot script in index.html
// applied it, but applyChatModeTheme's five hard-coded toggles never learned
// about it. So `sci-mode` could neither be turned ON by picking Deep Science nor
// turned OFF by picking anything else — a browser that had booted in Science
// carried the class into every other agent, and the header showed two mode tags
// while the palette and the composer pane came from two different themes.
/** Every root theme class in the registry, in descriptor order. @type {string[]} */
export const MODE_ROOT_CLASSES = /** @type {string[]} */ (
  Object.values(MODE_THEMES)
    .map((t) => t.rootClass)
    .filter((c) => typeof c === "string" && c.length > 0)
);

/**
 * The descriptor for a mode, falling back to DEEP SCIENCE for anything unknown.
 *
 * The fallback moved off `normal` when the general agent was retired
 * (2026-08-13). It is the same fallback the routing core uses
 * (chat-mode-core.js DEFAULT_CHAT_MODE), and the two must not drift: a request
 * answered by Deep Science while the page paints an unrelated theme is a mode
 * mismatch the user can see. The value that lands here is a retired or garbled
 * id — `normal` from a browser that has not reloaded, a share link written
 * before the change — and it now paints the reading room rather than an
 * unthemed sky-blue field that no longer belongs to any mode.
 * @param {unknown} mode
 * @returns {ModeTheme}
 */
export function modeTheme(mode) {
  const id = typeof mode === "string" ? mode : "";
  return MODE_THEMES[id] || MODE_THEMES.science;
}

/** The root class a mode carries on <html>, or null for the unthemed default.
 * @param {unknown} mode @returns {string|null} */
export function modeRootClass(mode) {
  return modeTheme(mode).rootClass;
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

/** The side-panel flavour for a mode. @param {unknown} mode @returns {"history"|"showcase"|"models"} */
export function panelFlavour(mode) {
  return modeTheme(mode).panel;
}

/** The agent-background flavour behind the chat for a mode — "terminal" (the
 * sandbox terminal-text layer) or "graph" (the rotating workflow graph). The
 * DOM dispatch lives in mode-backdrop.js. @param {unknown} mode @returns {"terminal"|"graph"} */
export function backdropKind(mode) {
  return modeTheme(mode).backdrop;
}
