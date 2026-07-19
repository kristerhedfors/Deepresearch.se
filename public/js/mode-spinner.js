// @ts-check
// The MODE spinner dispatch — the one place turns.js and activity.js reach for
// a waiting symbol, so the Se/rver app's loading slots wear the CURRENT chat
// mode's animation instead of always the balloon. Research / Introspection mount
// the balloon (Se/rver's tier symbol); SDK mode mounts the PLANT (plant-
// spinner.js) — a seed that hits the ground, gets planted, and grows into a
// green ✓ on completion. Which one is decided by the mode registry
// (mode-theme.js spinnerKind) off the cached chat mode (chat-mode.js).
//
// Thin glue over the two mount factories, which share one contract
// (mountBalloonSpinner / mountPlantSpinner both return {stop, finish} and are
// entirely fail-soft), so callers change nothing but the import.

import { cachedChatMode } from "./chat-mode.js";
import { spinnerKind } from "./mode-theme.js";
import { mountBalloonSpinner } from "./balloon-spinner.js";
import { mountPlantSpinner } from "./plant-spinner.js";

/**
 * Mount the current mode's waiting spinner on a loading slot. Same signature
 * and return contract as the underlying mounts; fail-soft (a bad mode or a
 * throwing mount degrades to the balloon, and ultimately to the CSS spinner).
 * @param {HTMLElement} host  the `.spin` / `.typing-icon` element
 * @param {{ size?: number, style?: number, speed?: number }} [opts]
 * @returns {{ stop: () => void, finish: (onDone?: () => void) => void }}
 */
export function mountModeSpinner(host, opts = {}) {
  let kind = "balloon";
  try {
    kind = spinnerKind(cachedChatMode());
  } catch {
    /* registry/cache unavailable — balloon is the safe default */
  }
  return kind === "plant" ? mountPlantSpinner(host, opts) : mountBalloonSpinner(host, opts);
}
