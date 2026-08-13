// @ts-check
// The MODE spinner dispatch — the one place turns.js and activity.js reach for
// a waiting symbol, so the Se/rver app's loading slots wear the CURRENT chat
// mode's animation instead of always the balloon. Most modes mount the tier's
// balloon RECOLOURED in their own palette (INTROSPECTION in titanium, so its
// waiting symbol belongs to the titanium theme like the field, the pane and
// TIN; ORCHESTRATOR in violet, OUTROSPECTION in newsprint, MODELS in amber,
// DEEP SCIENCE in gilt, CYBER in crimson); SDK mode mounts the PLANT
// (plant-spinner.js) — a sprout growing to the composer chip's 🌱 shape again
// and again, fast-forwarding into a seed-scattering flower and a green ✓ when
// the work completes. Which one is decided by the mode registry
// (mode-theme.js spinnerKind) off the cached chat mode (chat-mode.js).
//
// Thin glue over the two mount factories, which share one contract
// (mountBalloonSpinner / mountPlantSpinner both return {stop, finish} and are
// entirely fail-soft), so callers change nothing but the import.

import { DEFAULT_CHAT_MODE, cachedChatMode } from "./chat-mode.js";
import { spinnerKind } from "./mode-theme.js";
import { mountBalloonSpinner } from "./balloon-spinner.js";
import { mountPlantSpinner } from "./plant-spinner.js";

/** Introspection's balloon palette: brushed silver crown, steel alt, slate
 * border + logo wind-down, folding into a slate ✓. `check` MUST match app.css
 * --check-tin so the canvas fold hands off cleanly to the real .check span. */
export const TITANIUM_SPINNER = {
  palette: {
    col: "#dfe4e9",
    alt: "#aeb8c2",
    border: "#6b7480",
    fill: { a: "#cfd5db", b: "#9aa4b0" },
  },
  check: "#5f6b78",
};

/** Orchestrator's balloon palette: lavender crown, violet alt, deep-violet
 * border, folding into the violet ✓. `check` MUST match app.css
 * --check-violet (the introspection-recolour pattern). */
export const ORCH_SPINNER = {
  palette: {
    col: "#d9c9f5",
    alt: "#b39ae6",
    border: "#5d3aa6",
    fill: { a: "#c9b4f0", b: "#9a7ce0" },
  },
  check: "#6d3fc4",
};

/** Outrospection's balloon palette: newsprint crown, warm grey alt, masthead-red
 * border, folding into the red ✓. `check` MUST match app.css --check-red (the
 * introspection-recolour pattern). */
export const NEWSPRINT_SPINNER = {
  palette: {
    col: "#f0ebdd",
    alt: "#cfc6b0",
    border: "#8f1d14",
    fill: { a: "#e6dfcb", b: "#c2b69c" },
  },
  check: "#8f1d14",
};

/** The Models agent's balloon palette: warm cream crown, sand alt, an amber
 * border folding into the amber ✓. `check` MUST match app.css --check-amber
 * (the introspection-recolour pattern). */
export const MODELS_SPINNER = {
  palette: {
    col: "#ffe9a8",
    alt: "#e8c46a",
    border: "#b8860b",
    fill: { a: "#ffd21e", b: "#d99b1c" },
  },
  check: "#b8860b",
};

/** Deep Science's balloon palette: parchment crown, aged-paper alt, a gilt
 * border folding into the gold ✓. `check` MUST match app.css --check-gold (the
 * introspection-recolour pattern). */
export const SCIENCE_SPINNER = {
  palette: {
    col: "#f3e7c6",
    alt: "#d8c188",
    border: "#b08d3f",
    fill: { a: "#e8d9a8", b: "#c0a55f" },
  },
  check: "#b08d3f",
};

/** The Cyber agent's balloon palette: alarm-rose crown, a deeper rose alt, an
 * alert-crimson border folding into the crimson ✓. `check` MUST match app.css
 * --check-crimson AND mode-theme.js MODE_THEMES.cyber.check — three copies of
 * one value, because the canvas draws the fold and the CSS draws the ✓ that
 * replaces it, and a mismatch reads as the checkmark changing colour at the
 * handoff. It is its OWN property, not Outrospection's --check-red: those two
 * reds differ, and sharing one variable is how a recolour drifts unnoticed. */
export const CYBER_SPINNER = {
  palette: {
    col: "#ffb9c0",
    alt: "#e8737f",
    border: "#b32d3a",
    fill: { a: "#ff7a86", b: "#c94553" },
  },
  check: "#b32d3a",
};

/**
 * Mount the current mode's waiting spinner on a loading slot. Same signature
 * and return contract as the underlying mounts; fail-soft (a bad mode or a
 * throwing mount degrades to the balloon, and ultimately to the CSS spinner).
 * @param {HTMLElement} host  the `.spin` / `.typing-icon` element
 * @param {{ size?: number, style?: number, speed?: number }} [opts]
 * @returns {{ stop: () => void, finish: (onDone?: () => void) => void }}
 */
export function mountModeSpinner(host, opts = {}) {
  // The safe default is DEEP SCIENCE, the mode a request falls back to since
  // the general agent was retired (2026-08-13, chat-mode-core.js
  // DEFAULT_CHAT_MODE). It used to be "normal", which mattered less than it
  // looks: that value selected no recolour and left the tier's blue-and-gold
  // balloon, and a spinner is decoration either way. It matters now only in
  // that the fallback should name a mode that still exists.
  let mode = DEFAULT_CHAT_MODE;
  try {
    mode = cachedChatMode();
  } catch {
    /* cache unavailable — the default mode is the safe answer */
  }
  let kind = "balloon";
  try {
    kind = spinnerKind(mode);
  } catch {
    /* registry unavailable — balloon is the safe default */
  }
  if (kind === "plant") return mountPlantSpinner(host, opts);
  // Introspection wears the titanium balloon, Orchestrator the violet one,
  // Outrospection the newsprint one, Models the amber one, Deep Science the
  // gilt one and Cyber the crimson one; anything left over keeps the tier's
  // blue-and-gold (caller opts win if they ever pass a palette/check).
  const balloonOpts =
    mode === "introspection" ? { ...TITANIUM_SPINNER, ...opts }
    : mode === "orchestrator" ? { ...ORCH_SPINNER, ...opts }
    : mode === "outrospection" ? { ...NEWSPRINT_SPINNER, ...opts }
    : mode === "models" ? { ...MODELS_SPINNER, ...opts }
    : mode === "science" ? { ...SCIENCE_SPINNER, ...opts }
    : mode === "cyber" ? { ...CYBER_SPINNER, ...opts }
    : opts;
  return mountBalloonSpinner(host, balloonOpts);
}
