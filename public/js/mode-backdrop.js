// The MODE-BACKDROP dispatch — the one place the app decides which AGENT
// BACKGROUND stands behind the chat, off the mode registry's `backdrop` axis
// (mode-theme.js backdropKind), exactly as mode-spinner.js dispatches the
// waiting symbol. Two implementations exist today:
//
//   "terminal" — the sandbox terminal-text layer (agent-backdrop.js). It is
//                EVENT-DRIVEN: it appears when a VM prints and needs no mount
//                here, so for terminal modes this dispatch only ensures the
//                graph layer is gone.
//   "graph"    — the hovering, slowly rotating wireframe workflow graph
//                (graph-backdrop.js), Orchestrator mode's background; mounted
//                and unmounted here as the mode changes.
//
// NOT `// @ts-check`-hostile but browser glue: fail-soft, cheap to call
// repeatedly (mount is idempotent, unmount a no-op when absent). Callers:
// app.js (boot, settings reconcile, the #modesel change handler) and
// account-views.js (the Settings-panel mode pick).

import { cachedChatMode } from "./chat-mode.js";
import { backdropKind } from "./mode-theme.js";
import { mountGraphBackdrop, unmountGraphBackdrop } from "./graph-backdrop.js";

/**
 * Make the backdrop match a mode (default: the cached current mode).
 * @param {string} [mode]
 */
export function applyModeBackdrop(mode) {
  let kind = "terminal";
  try {
    kind = backdropKind(mode ?? cachedChatMode());
  } catch {
    /* registry unavailable — terminal (no graph layer) is the safe default */
  }
  try {
    if (kind === "graph") mountGraphBackdrop();
    else unmountGraphBackdrop();
  } catch {
    /* no DOM/canvas — the chat works without a backdrop */
  }
}
