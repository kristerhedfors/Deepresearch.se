// @ts-check
// The SECURE-RESEARCH-SPACE bundle crypto — the small shared pure core behind
// both the server mint (src/proxy.js seals the bundle) and the client open
// (public/cure/drc.js reads it). Kept under public/ so the browser can import
// it directly while the Worker bundler pulls the same file server-side (the
// same shared-core discipline as public/js/bash-core.js / introspect-core.js).
//
// What a bundle IS: a signed-in Se/rver user crossing to Se/cure (the ghost
// button) — or an admin minting a shareable link — hands the browser a SMALL
// SET of temporary, account-connected proxy GRANTS ("token-granting tokens",
// one per service: web search + LLM API). The set is packed into ONE JSON
// bundle, AES-256-GCM encrypted under a fresh random key, and delivered so the
// CIPHERTEXT rides in the URL query (`?rp=<blob>`, server-visible but useless)
// while the DECRYPTION KEY rides in the URL ANCHOR (`#rk=<key>`, never sent to
// any server, stripped from referrers). The client reads both from its own
// address bar, decrypts, and exchanges each grant token for a working proxy
// token (src/proxy.js). So a leaked server log / referrer carries an opaque
// blob it can never open.
//
// WebCrypto only (crypto.subtle + crypto.getRandomValues) — available in the
// Worker, the browser, and Node ≥18, so this module is import-safe and
// Node-testable unchanged. Fail-soft by contract: openBundle returns null on
// ANY problem (bad base64, wrong key, tampered ciphertext, malformed JSON).

const IV_BYTES = 12; // AES-GCM standard nonce length
const KEY_BYTES = 32; // AES-256

/** @param {Uint8Array} bytes @returns {string} URL-safe base64 (no padding) */
export function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} str @returns {Uint8Array} */
export function b64urlDecode(str) {
  const norm = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {Uint8Array} bytes @returns {Promise<string>} lowercase hex of SHA-256 */
export async function sha256hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Seal an arbitrary JSON-serializable object into an encrypted bundle. Returns
 * `{ blob, key }` — both URL-safe base64: `blob` is `iv || ciphertext` (goes in
 * the URL query), `key` is the raw AES key (goes in the URL anchor). A fresh
 * random key + iv every call, so two bundles never share key material.
 * @param {any} obj
 * @returns {Promise<{ blob: string, key: string }>}
 */
export async function sealBundle(obj) {
  const rawKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return { blob: b64urlEncode(packed), key: b64urlEncode(rawKey) };
}

/**
 * Open a bundle sealed by {@link sealBundle}. Returns the decoded object, or
 * null on any failure (never throws) — callers stay fail-soft.
 * @param {string} blob URL-safe base64 of `iv || ciphertext` (the `rp` param)
 * @param {string} keyB64 URL-safe base64 of the raw AES key (the `rk` anchor)
 * @returns {Promise<any | null>}
 */
export async function openBundle(blob, keyB64) {
  try {
    const packed = b64urlDecode(blob);
    if (packed.length <= IV_BYTES) return null;
    const rawKey = b64urlDecode(keyB64);
    if (rawKey.length !== KEY_BYTES) return null;
    const iv = packed.slice(0, IV_BYTES);
    const ct = packed.slice(IV_BYTES);
    // new Uint8Array(...) so the buffer type is a plain ArrayBuffer (the DOM
    // lib's importKey/decrypt want BufferSource, not a maybe-shared buffer).
    const key = await crypto.subtle.importKey("raw", new Uint8Array(rawKey), { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    const obj = JSON.parse(new TextDecoder().decode(new Uint8Array(plaintext)));
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/**
 * Validate the SHAPE of a decrypted bundle (defensive — the ciphertext is
 * authenticated by GCM, but a well-formed-but-wrong object should still be
 * rejected cleanly). A valid bundle is `{ v, grants: [{ svc, token }, …] }`
 * with at least one grant carrying a non-empty token for a known service.
 * @param {any} bundle
 * @returns {boolean}
 */
export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return false;
  if (!Array.isArray(bundle.grants) || !bundle.grants.length) return false;
  return bundle.grants.every(
    (/** @type {any} */ g) =>
      g &&
      typeof g === "object" &&
      (g.svc === "web" || g.svc === "api") &&
      typeof g.token === "string" &&
      g.token.length > 0,
  );
}
