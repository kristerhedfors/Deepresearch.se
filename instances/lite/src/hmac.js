// @ts-check
// The shared HMAC-primitives leaf (identity-access step 1) — imports nothing.
//
// The NAMESPACED sign() over the one root secret (SESSION_SECRET) is what keeps
// session cookies and OAuth-state cookies mutually unforgeable under a single
// key. Fail closed: no secret configured => sign/verify throw / return false,
// never a keyless signature. This reproduces the parent site's construction
// EXACTLY (hex HMAC-SHA-256 over the same messages) so this instance validates
// the same `dr_session` cookies the parent mints.

/** @param {ArrayBuffer} buf @returns {string} lowercase hex */
export function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

/** @param {Uint8Array} bytes @returns {string} base64url (no padding) */
export function b64urlFromBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} s @returns {Uint8Array} */
export function bytesFromB64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Constant-time-ish string compare — avoids leaking match length via early
 * return. Both are treated as opaque tags of equal expected length.
 * @param {string} a @param {string} b @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @param {{ SESSION_SECRET?: string }} env
 * @returns {Promise<CryptoKey|null>} null when no secret is configured (fail closed)
 */
async function hmacKey(env) {
  if (!env.SESSION_SECRET) return null;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(env.SESSION_SECRET)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Namespaced HMAC over the root secret. The namespace prefixes the message so a
 * tag minted for one purpose (e.g. `state.…`) can never be replayed as another
 * (e.g. a session cookie). Pass ns="" to sign a bare message — this is how the
 * session cookie stays byte-compatible with the parent (`<uid>.<exp>`).
 * @param {{ SESSION_SECRET?: string }} env
 * @param {string} ns
 * @param {string} message
 * @returns {Promise<string>} lowercase hex tag
 */
export async function sign(env, ns, message) {
  const key = await hmacKey(env);
  if (!key) throw new Error("SESSION_SECRET is not configured");
  const msg = ns ? `${ns}.${message}` : message;
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return toHex(sig);
}

/**
 * @param {{ SESSION_SECRET?: string }} env
 * @param {string} ns
 * @param {string} message
 * @param {string} tag
 * @returns {Promise<boolean>} false when no secret is configured (fail closed)
 */
export async function verify(env, ns, message, tag) {
  if (!env.SESSION_SECRET) return false;
  const expected = await sign(env, ns, message);
  return safeEqual(expected, tag);
}
