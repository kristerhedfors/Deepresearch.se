// @ts-check
// Free mode — the site's DEFAULT face: unauthenticated visitors get it at
// /, saved projects live at /my/project-<hash> (with /free as a legacy
// alias), and the old promotional landing is a first-visit glass pane on
// the page itself (the full landing stays at /welcome/). A no-account chat
// surface that runs ENTIRELY outside authentication AND outside this
// server's request path. The browser talks DIRECTLY (cross-origin) to LLM providers whose
// APIs allow it — OpenAI and Groq, the two CORS-capable providers in the
// client registry (public/js/free-providers.js) — using the user's own
// API keys, and runs the whole deep-research flow client-side
// (public/js/free-research.js: triage → knowledge harvest → gap check →
// synthesis → validation, deterministic, no function calling — the
// pipeline invariants, ported to the browser).
//
// What this Worker contributes to free mode is therefore exactly two
// things, and deliberately nothing more:
//
//   1. The static page (public/free/, routed in src/index.js BEFORE the
//      identity gate, including the /free/project-<hash> deep links).
//   2. ONE dumb ciphertext store: PUT/GET/DELETE /api/free/blob/:id —
//      the project state (conversations, settings, AND the user's
//      provider API keys) sealed CLIENT-side under a key derived from the
//      user's master secret (public/js/free-core.js). The server never
//      holds that key in any form, is never asked to decrypt anything,
//      and is not in the chat path at all — so "no message-content
//      logging" is not a policy here, it is a structural impossibility.
//
// Storage is capability-addressed, not user-namespaced (there is no
// user): the id is an unguessable 160-bit HKDF output of the secret, and
// knowing it is the read/write capability — the vault's model minus the
// account fence. Objects live under R2 `free/blob/{id}` and are excluded
// from every account wipe by construction (different prefix, no uid).

import { jsonResponse } from "./http.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

export const FREE_BLOB_MAX_BYTES = 25 * 1024 * 1024; // the sealed project state
export const FREE_BLOB_MIN_BYTES = 12 + 16 + 1; // IV + GCM tag + at least one byte

// Same shape as vault ids: long HKDF-derived Crockford/base64url strings.
/** @param {unknown} s */
export const freeIdOk = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(s);

/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);

// Router for /api/free/* — called from src/index.js BEFORE the identity
// gate (free mode has no accounts).
/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleFreeApi(request, env, url, log) {
  if (!env.STORAGE) {
    return jsonResponse({ error: "Free mode storage is not configured on this server." }, 503);
  }
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "free", "blob", id]
  const id = parts[3] ? decodeURIComponent(parts[3]) : null;
  if (parts[2] !== "blob" || !id || parts.length !== 4) return jsonResponse({ error: "Not found." }, 404);
  if (!freeIdOk(id)) return jsonResponse({ error: "Invalid id." }, 400);
  const key = `free/blob/${id}`;

  if (request.method === "GET") {
    const obj = await bucket(env).get(key);
    if (!obj) return jsonResponse({ error: "Not found." }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": "application/octet-stream",
        "x-free-updated": obj.customMetadata?.updatedAt || "",
      },
    });
  }
  if (request.method === "PUT") {
    const declared = Number(request.headers.get("content-length")) || 0;
    if (declared > FREE_BLOB_MAX_BYTES) return jsonResponse({ error: "Project too large." }, 413);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > FREE_BLOB_MAX_BYTES) return jsonResponse({ error: "Project too large." }, 413);
    if (bytes.byteLength < FREE_BLOB_MIN_BYTES) {
      return jsonResponse({ error: "Not a valid encrypted blob." }, 400);
    }
    const updatedAt = Date.now();
    await bucket(env).put(key, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { updatedAt: String(updatedAt) },
    });
    // Metadata only, and there is no content to log even in principle —
    // the body is client-side ciphertext.
    log.debug("free.blob_put", { size: bytes.byteLength });
    return jsonResponse({ ok: true, updatedAt });
  }
  if (request.method === "DELETE") {
    await bucket(env).delete(key);
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: "Not found." }, 404);
}
