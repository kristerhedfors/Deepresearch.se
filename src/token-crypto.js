// @ts-check
// The shared HMAC-token crypto PRIMITIVES — one implementation of the small
// pure helpers every signed-token module in this codebase had been carrying as
// its own byte-identical copy: base64url encode/decode, hex rendering, the
// constant-time compare, the namespaced HMAC-SHA-256 tag, and the tag-check +
// payload-decode step that opens every family's verify.
//
// Consumers: src/auth.js (session cookie / OAuth state — toHex + safeEqual;
// its signing path keeps its own key caching), src/websearch-key.js (`wsk1`
// grant tokens, namespace `websearch.`), src/proxy-grant.js (`prg1`/`prx1`
// two-tier tokens, namespaces `proxygrant.`/`proxytoken.`), src/pool-token.js
// (`pool1`), src/mcp-key.js (`mck1`), and src/server-token.js (the HS256 JWT,
// which shares the raw tag but renders it base64url).
//
// THE FENCE. Each token family keeps its OWN mint/verify. What is shared stops
// at the cryptography: `verifiedClaims` recomputes the tag, compares it in
// constant time and decodes the payload — and hands back. Every family still
// parses its own wire prefix, passes its OWN namespace in (which is what keeps
// the families mutually unforgeable under the single SESSION_SECRET key), and
// validates its OWN claims, which is where they differ deliberately: proxy
// tokens carry a `svc` claim, websearch tokens don't. Do not merge the claim
// validation, and do not grow `verifiedClaims` toward it.
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
 * The raw HMAC-SHA-256 tag over a message, under the site's single signing key.
 * Every family's tag is this; they differ only in what they put in the message
 * (a namespace, or a JWS signing input) and how they render the bytes out
 * (`sign` below renders hex, src/server-token.js's hs256 renders base64url).
 * @param {Env} env
 * @param {string} message the exact bytes signed
 * @returns {Promise<ArrayBuffer>}
 */
export async function hmacRaw(env, message) {
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
  return crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
}

/**
 * @param {Env} env
 * @param {string} ns the message namespace (e.g. `websearch.`, `proxygrant.`)
 * @param {string} message
 * @returns {Promise<string>} hex HMAC-SHA-256 tag over `<ns><message>`
 */
export async function sign(env, ns, message) {
  return toHex(await hmacRaw(env, ns + message));
}

/**
 * Verify a token's tag and decode its payload — the step every family in this
 * codebase performs identically before it looks at a single claim.
 *
 * WHAT IS SHARED, AND WHAT IS DELIBERATELY NOT. This checks the tag and hands
 * back a parsed object; each family still parses its own wire prefix, passes
 * its OWN namespace in, and validates its OWN claims afterwards. The namespace
 * is what keeps the families mutually unforgeable under the single
 * SESSION_SECRET key, and the claims are where they differ on purpose (proxy
 * tokens carry a `svc`; websearch tokens don't). Do not grow this function
 * toward claim validation — that is the fence in this module's header.
 *
 * Null on every failure, never a throw: an unconfigured signing key fails
 * closed exactly like a bad tag does.
 * @param {Env} env
 * @param {string} ns the family's message namespace
 * @param {string} payload the base64url payload segment (also the signed message)
 * @param {string} sig the presented hex tag
 * @returns {Promise<any | null>} the decoded claims object, or null
 */
export async function verifiedClaims(env, ns, payload, sig) {
  /** @type {string} */
  let expected;
  try {
    expected = await sign(env, ns, payload);
  } catch {
    return null; // no signing key configured
  }
  if (!safeEqual(sig, expected)) return null;
  /** @type {any} */
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  return claims;
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
