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
//  2. **Cheap enough to be on every path.** It used to be neither: the registry
//     lived only inside the multi-megabyte snapshot, and the cost was avoided by
//     asking for it only when routing could actually differ — which, while there
//     was a general "Deep Research" agent, meant almost never. That agent is gone
//     (2026-08-13), every mode is a domain, and a domain is enforced by the
//     resolved capability, so `routingNeedsRegistry` now says yes to everything.
//     The load is therefore two things: a small dedicated artifact
//     (AGENTS_REGISTRY_PATH, written by the same bundler from the same
//     sdk/AGENTS.json), and a per-isolate cache. The snapshot remains the
//     FALLBACK, so a deploy carrying an older bundle — one written before the
//     small artifact existed — still resolves agents rather than silently
//     routing everything to a null capability.

import { agentsFromSnapshot } from "./agent-spec.js";
import { AGENTS_REGISTRY_PATH, SNAPSHOT_PATH } from "../public/js/introspect-core.js";

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
  const reg = (await readRegistryArtifact(assets)) || (await readRegistryFromSnapshot(assets));
  if (reg) cache.set(assets, reg);
  return reg;
}

/**
 * The small dedicated artifact — the whole registry and nothing else. It is a
 * byte copy of sdk/AGENTS.json, so it is already in the shape `resolveRequestAgent`
 * wants and needs no extraction step.
 * @param {any} assets
 * @returns {Promise<any | null>}
 */
async function readRegistryArtifact(assets) {
  try {
    const res = await assets.fetch(new Request("https://assets.internal" + AGENTS_REGISTRY_PATH));
    if (!res.ok) return null;
    const reg = await res.json();
    // Shape-check rather than trust: a 200 carrying the SPA's index.html would
    // otherwise be parsed as an empty registry and cached for the isolate's
    // whole life, which is worse than falling through to the snapshot.
    return Array.isArray(reg?.agents) && reg.agents.length ? reg : null;
  } catch {
    return null;
  }
}

/**
 * The fallback: pull sdk/AGENTS.json back out of the committed source snapshot,
 * which is how this worked before the dedicated artifact existed. Kept so a
 * deploy whose bundle predates the artifact still routes by capability.
 * @param {any} assets
 * @returns {Promise<any | null>}
 */
async function readRegistryFromSnapshot(assets) {
  try {
    const res = await assets.fetch(new Request("https://assets.internal" + SNAPSHOT_PATH));
    if (!res.ok) return null;
    return agentsFromSnapshot(await res.json());
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
