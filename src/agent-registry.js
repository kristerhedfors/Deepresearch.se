// @ts-check
// The agent registry, loaded once per isolate — the seam that lets a chat
// request route by DATA (sdk/AGENTS.json `defaults`) instead of by a
// hand-written flag cascade.
//
// The registry ships inside the committed source snapshot, so what this loads
// is by construction the exact agent definition THIS deploy runs — the same
// artifact introspection reads, fetched back through the ASSETS binding.
//
// Two properties matter more than the loading itself:
//
//  1. **Fail-soft (invariant 2).** Every failure path returns null. A caller
//     that gets null keeps its own built-in behaviour; nothing about a chat
//     request depends on the registry being readable.
//  2. **Never on the hot path for free.** The snapshot is several megabytes,
//     so parsing it per request would be a real regression for the plain
//     Deep Research turn that gains nothing from it. The result is cached in
//     module scope for the isolate's lifetime, and callers are expected to ask
//     only when routing could actually differ (see `routingNeedsRegistry`).

import { agentsFromSnapshot } from "./agent-spec.js";
import { SNAPSHOT_PATH } from "../public/js/introspect-core.js";

/** @typedef {import('./types.js').Env} Env */

// The cache is keyed on the ASSETS BINDING, not held in a bare module variable.
// A Worker isolate has exactly one binding, so this still means "load once per
// isolate" — but it also means a caller with a different binding (or none) can
// never be served another env's registry, which a bare module variable would do
// and which no production code path would ever reveal.
/** @type {WeakMap<object, any>} */
const cache = new WeakMap();

/**
 * The agent registry (sdk/AGENTS.json) out of the committed source snapshot.
 * Null — never a throw — when the binding or the artifact is unavailable.
 * Successful loads are cached for the isolate; a failure is not, so a
 * transient asset error retries on the next request instead of poisoning the
 * isolate for its whole life.
 * @param {Env} env
 * @returns {Promise<any | null>}
 */
export async function loadAgentRegistry(env) {
  const assets = /** @type {any} */ (env)?.ASSETS;
  if (!assets?.fetch) return null;
  if (cache.has(assets)) return cache.get(assets);
  try {
    const res = await assets.fetch(new Request("https://assets.internal" + SNAPSHOT_PATH));
    if (!res.ok) return null;
    const reg = agentsFromSnapshot(await res.json());
    if (reg) cache.set(assets, reg);
    return reg;
  } catch {
    return null;
  }
}

// `routingNeedsRegistry` used to live here, deciding from the raw body whether
// the snapshot load could change the outcome. It now takes the ALREADY-RESOLVED
// chat mode and lives with the rest of the mode table in
// public/js/chat-mode-core.js (re-exported by src/chat-modes.js) — the mode
// flags it used to sniff are resolved into that one value before routing starts,
// so listing them here would have been a second, drift-prone copy of the table.
