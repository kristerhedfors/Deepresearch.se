// @ts-check
// The app kit's SERVER side: read the shipped kit out of this deploy's static
// assets and add it to a published Agent Studio build (feedback #66,
// 2026-08-10).
//
// WHY INJECT RATHER THAN ASK THE MODEL TO WRITE IT. A generated app that takes
// an API key needs a provider registry, a live /models fetch, the curation
// rules, the country-of-processing flags and two wire dialects. Asking the
// model to reproduce ~15 KB of that on every build burns output tokens, and the
// two ways an SDK build has broken before were both TRUNCATION (feedback #13,
// #30) — the failure mode a long verbatim file invites. So the model writes one
// script tag, and the file itself arrives from the deploy: it cannot be
// truncated, cannot be mis-copied, and cannot drift from the registry the site
// runs on (public/js/drc-providers.js, mirrored under the parity test).
//
// It is read through the ASSETS binding, the same way the introspection
// snapshot and RAG indexes are (src/introspect.js) — so what a build ships is
// by construction what this deploy serves, with no second copy to keep in step.
//
// Fail-soft, per invariant 2: an unreadable kit leaves the build to publish
// without it. A published app missing its picker is a worse app; a build that
// refuses to publish is a broken promise.

import { APP_KIT_ASSET_PATH, APP_KIT_PATH } from "./sdk-tools.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

// The kit is one small static file read once per isolate; a build turn that
// republishes several times should not re-fetch it. Keyed on the ASSETS
// BINDING rather than a bare module variable, for the reason
// src/agent-registry.js and src/scholar-venues.js are: a test (or a second
// environment) handing in a different binding must not be served the first
// one's bytes.
/** @type {WeakMap<object, Promise<string | null>>} */
const cache = new WeakMap();

/**
 * The kit's source, or null when it cannot be read. Never throws.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<string | null>}
 */
export function loadAppKit(env, log) {
  const assets = /** @type {any} */ (env)?.ASSETS;
  if (!assets?.fetch) return Promise.resolve(null);
  const hit = cache.get(assets);
  if (hit) return hit;
  const pending = (async () => {
    try {
      // The binding routes by path; the host is a placeholder.
      const res = await assets.fetch(new Request("https://assets.internal" + APP_KIT_ASSET_PATH));
      if (!res.ok) {
        log.warn("appkit.missing", { status: res.status });
        return null;
      }
      const text = await res.text();
      return text && text.includes("DRKit") ? text : null;
    } catch (/** @type {any} */ err) {
      log.warn("appkit.failed", { error: err?.message || String(err) });
      return null;
    }
  })();
  cache.set(assets, pending);
  return pending;
}

/**
 * Add the kit to a build's file list when the build references it. The kit's
 * path is RESERVED: a file the model wrote there is replaced, so an app always
 * runs the real kit rather than a hallucinated approximation of it.
 *
 * Returns the file list to publish — unchanged when the build wants no kit or
 * the kit could not be read.
 * @param {Env} env
 * @param {Logger} log
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Promise<Array<{ path: string, content: string }>>}
 */
export async function withAppKit(env, log, files) {
  const list = Array.isArray(files) ? files : [];
  const source = await loadAppKit(env, log);
  if (!source) return list;
  // FIRST in the list, so that a build already at the file cap loses one of
  // its own files rather than the kit every one of them depends on.
  return [{ path: APP_KIT_PATH, content: source }, ...list.filter((f) => f?.path !== APP_KIT_PATH)];
}
