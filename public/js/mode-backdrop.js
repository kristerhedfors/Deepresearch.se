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
//                (graph-backdrop.js), Orchestrator mode's background.
//
// Since 2026-07-26 this does NOT mount the graph itself: a graph mode has BOTH
// backgrounds available, and the header terminal icon owns the choice between
// every combination of them (the five-state cycle in agent-backdrop-core.js).
// So the dispatch REGISTERS the graph's mount/unmount pair with the backdrop
// switch (setGraphLayer) and lets the current view state decide what is on
// screen; a non-graph mode registers null, which tears the canvas down.
//
// The direction of the dependency is load-bearing: agent-backdrop.js is in the
// public asset allowlist (the /cure module graph imports it) and
// graph-backdrop.js is not, so the switch can never import the graph — this
// module, which only the Se/rver app loads, hands it over instead.
//
// NOT `// @ts-check`-hostile but browser glue: fail-soft, cheap to call
// repeatedly (mount is idempotent, unmount a no-op when absent). Callers:
// app.js (boot, settings reconcile, the #modesel change handler) and
// account-views.js (the Settings-panel mode pick).

import { cachedChatMode } from "./chat-mode.js";
import { backdropKind } from "./mode-theme.js";
import { setGraphLayer } from "./agent-backdrop.js";
import { mountGraphBackdrop, unmountGraphBackdrop } from "./graph-backdrop.js";

// One stable pair, so repeated calls in a graph mode register the SAME object
// and setGraphLayer can tell "still the same graph" from "a different one".
const GRAPH_CONTROLS = { show: mountGraphBackdrop, hide: unmountGraphBackdrop };

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
    setGraphLayer(kind === "graph" ? GRAPH_CONTROLS : null);
  } catch {
    /* no DOM/canvas — the chat works without a backdrop */
  }
}
