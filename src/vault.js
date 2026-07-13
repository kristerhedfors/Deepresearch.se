// @ts-check
// The secret-keyed project vault (R2 binding `STORAGE`, key family
// `vault/{uid}/{vaultId}`): stores one CLIENT-ENCRYPTED project archive per
// vault id — an opaque byte blob AES-256-GCM encrypted in the browser under
// a key derived from a user-held secret (public/js/vault.js) that the
// server NEVER sees, not even transiently. This is deliberately a stronger
// posture than the history-key model (src/history-key.js): there the server
// could re-derive the key from its own secret; here it holds nothing that
// could ever decrypt a vault object. The vault id itself is derived from
// the same secret (HKDF, separate info string), so knowing the secret is
// both the locator and the key — the server stores unlabeled ciphertext.
//
// This is the strictest storage tier — the one Se/rver copy a FULL server
// compromise still can't read. Se/rver already keeps an encrypted copy of a
// project in R2 (always, via src/storage.js) that the running server COULD
// decrypt by re-deriving the history key; the vault stores a copy under a
// secret the server never sees and cannot derive, so nothing readable — no
// project name, no file names, no text, no index — is ever recoverable
// server-side. It doubles as backup / cross-device transport. The endpoints
// are NOT gated on storage availability the way src/storage.js is beyond
// needing the R2 binding + a real account: each PUT is its own explicit,
// user-initiated act of consent. For the same reason the account-wide drain
// (DELETE /api/storage) deliberately does NOT touch vault objects — they
// were stored by explicit action, and wiping them would destroy the very
// backups the user made on purpose.
//
// Object lifecycle: the client keeps the current vault id inside the
// (encrypted) project record and re-stores by PUT-ting the new blob under
// the NEW secret's id and deleting the old id — so storing again rotates
// the secret and the previous secret stops working. A lost secret means an
// undecryptable orphan blob; the per-user object cap below bounds how much
// of those can accumulate.

import { jsonResponse } from "./http.js";
import { storageAvailability } from "./settings.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

// An archive carries a whole project — record, conversations, original file
// bytes (base64 inside the JSON before encryption) and the RAG index with
// vectors — so the cap is well above the convo/file caps in src/storage.js.
export const VAULT_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_VAULT_OBJECTS = 50; // per user — sanity backstop, not a product limit
// AES-GCM blob = 12-byte IV + ciphertext + 16-byte tag; anything shorter
// cannot be a valid archive.
export const VAULT_MIN_BYTES = 12 + 16 + 1;

// Vault ids are HKDF-derived by the client (32 Crockford-base32 chars) —
// long enough that a short/guessable path segment is rejected outright.
/** @param {unknown} s */
export const vaultIdOk = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(s);

/** @param {number | string} uid @param {string} id */
const vaultKey = (uid, id) => `vault/${uid}/${id}`;

/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);

// Router for /api/vault/:id — called from src/index.js once the identity is
// resolved. Objects are namespaced per user id: a vault blob is reachable
// only from the account that stored it (the secret alone is not enough
// from someone else's account — defense in depth on top of the unguessable
// id).
/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleVault(request, env, url, log, identity) {
  const available = storageAvailability(env, identity);
  if (!available.storage || !identity.user) {
    return jsonResponse({ error: "Cloud storage is not configured on this server." }, 503);
  }
  const uid = identity.user.id;
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "vault", id]
  const id = parts[2] ? decodeURIComponent(parts[2]) : null;
  if (!id || parts.length !== 3) return jsonResponse({ error: "Not found." }, 404);
  if (!vaultIdOk(id)) return jsonResponse({ error: "Invalid vault id." }, 400);

  if (request.method === "GET") return getVault(env, uid, id);
  if (request.method === "PUT") return putVault(request, env, log, identity, uid, id);
  if (request.method === "DELETE") {
    await bucket(env).delete(vaultKey(uid, id));
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: "Not found." }, 404);
}

/** @param {Env} env @param {number | string} uid @param {string} id */
async function getVault(env, uid, id) {
  const obj = await bucket(env).get(vaultKey(uid, id));
  if (!obj) return jsonResponse({ error: "Not found." }, 404);
  return new Response(obj.body, {
    headers: {
      // Ciphertext is all there is — there is no readable form to advertise.
      "content-type": "application/octet-stream",
      "x-vault-updated": obj.customMetadata?.updatedAt || "",
    },
  });
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {number | string} uid
 * @param {string} id
 */
async function putVault(request, env, log, identity, uid, id) {
  const declared = Number(request.headers.get("content-length")) || 0;
  if (declared > VAULT_MAX_BYTES) return jsonResponse({ error: "Archive too large." }, 413);
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > VAULT_MAX_BYTES) return jsonResponse({ error: "Archive too large." }, 413);
  if (bytes.byteLength < VAULT_MIN_BYTES) {
    return jsonResponse({ error: "Not a valid encrypted archive." }, 400);
  }
  const key = vaultKey(uid, id);
  if (!(await bucket(env).head(key))) {
    let count = 0;
    let cursor;
    do {
      const page = await bucket(env).list({ prefix: `vault/${uid}/`, cursor });
      count += page.objects.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (count >= MAX_VAULT_OBJECTS) {
      return jsonResponse({ error: "Vault limit reached — delete or overwrite an existing copy." }, 409);
    }
  }
  const updatedAt = Date.now();
  await bucket(env).put(key, bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: { updatedAt: String(updatedAt) },
  });
  log.debug("vault.put", { user_id: identity.id, size: bytes.byteLength });
  return jsonResponse({ ok: true, id, size: bytes.byteLength, updatedAt });
}
