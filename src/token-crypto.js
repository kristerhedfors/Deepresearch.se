// @ts-check
// The shared HMAC-token crypto PRIMITIVES — one implementation of the small
// pure helpers every signed-token module in this codebase had been carrying as
// its own byte-identical copy: base64url encode/decode, hex rendering, the
// constant-time compare, and the namespaced HMAC-SHA-256 tag.
//
// Consumers: src/auth.js (session cookie / OAuth state — toHex + safeEqual;
// its signing path keeps its own key caching), src/websearch-key.js (`wsk1`
// grant tokens, namespace `websearch.`), and src/proxy-grant.js (`prg1`/`prx1`
// two-tier tokens, namespaces `proxygrant.`/`proxytoken.`). Each token family
// keeps its OWN mint/verify — the claims they validate differ deliberately
// (proxy tokens carry a `svc` claim; websearch tokens don't) — and passes its
// namespace into `sign`, which is what keeps the families mutually
// unforgeable under the single SESSION_SECRET key.
//
// Leaf module: imports nothing (the types.js import is type-only), so neither
// consumer's handler graph is pulled into another's tests.

/** @typedef {import('./types.js').Env} Env */

/** @param {Uint8Array} bytes @returns {string} */
export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} str @returns {Uint8Array} */
export function b64urlDecode(str) {
  const norm = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {ArrayBuffer} buf @returns {string} */
export function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {Env} env
 * @param {string} ns the message namespace (e.g. `websearch.`, `proxygrant.`)
 * @param {string} message
 * @returns {Promise<string>} hex HMAC-SHA-256 tag over `<ns><message>`
 */
export async function sign(env, ns, message) {
  // Fail closed: no SESSION_SECRET → no signing key (mirrors src/auth.js's
  // signHmac). The entrypoint gates the whole site on the secret, so this is
  // belt-and-braces.
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(env.SESSION_SECRET)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ns + message));
  return toHex(sig);
}

/**
 * Constant-time-ish string compare (timing-leak resistant).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
