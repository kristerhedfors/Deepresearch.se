// @ts-check
// The MODE spinner dispatch — the one place turns.js and activity.js reach for
// a waiting symbol, so the Se/rver app's loading slots wear the CURRENT chat
// mode's animation instead of always the balloon. Normal mounts the tier's
// blue-and-gold balloon; INTROSPECTION mounts the SAME balloon recoloured in
// TITANIUM (its waiting symbol belongs to the titanium theme like the field,
// the pane and TIN); SDK mode mounts the PLANT (plant-spinner.js) — a sprout
// growing to the composer chip's 🌱 shape again and again, fast-forwarding
// into a seed-scattering flower and a green ✓ when the work completes. Which one is decided
// by the mode registry (mode-theme.js spinnerKind) off the cached chat mode
// (chat-mode.js).
//
// Thin glue over the two mount factories, which share one contract
// (mountBalloonSpinner / mountPlantSpinner both return {stop, finish} and are
// entirely fail-soft), so callers change nothing but the import.

import { cachedChatMode } from "./chat-mode.js";
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

/**
 * Mount the current mode's waiting spinner on a loading slot. Same signature
 * and return contract as the underlying mounts; fail-soft (a bad mode or a
 * throwing mount degrades to the balloon, and ultimately to the CSS spinner).
 * @param {HTMLElement} host  the `.spin` / `.typing-icon` element
 * @param {{ size?: number, style?: number, speed?: number }} [opts]
 * @returns {{ stop: () => void, finish: (onDone?: () => void) => void }}
 */
export function mountModeSpinner(host, opts = {}) {
  let mode = "normal";
  try {
    mode = cachedChatMode();
  } catch {
    /* cache unavailable — normal is the safe default */
  }
  let kind = "balloon";
  try {
    kind = spinnerKind(mode);
  } catch {
    /* registry unavailable — balloon is the safe default */
  }
  if (kind === "plant") return mountPlantSpinner(host, opts);
  // Introspection wears the titanium balloon; every other balloon mode keeps the
  // tier's blue-and-gold (caller opts win if they ever pass a palette/check).
  const balloonOpts = mode === "introspection" ? { ...TITANIUM_SPINNER, ...opts } : opts;
  return mountBalloonSpinner(host, balloonOpts);
}
