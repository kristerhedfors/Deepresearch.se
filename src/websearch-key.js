// @ts-check
// Temporary web-search GRANT TOKENS — the signed capability that lets an
// otherwise server-less DeepResearch.Se/cure (DRC) session run a bounded
// number of web searches THROUGH this server's Exa key.
//
// The story: DRC is client-side by design — the server is in no data path
// (invariant 4). But live web search needs the server's EXA_API_KEY, which a
// browser must never hold. So a SIGNED-IN Se/rver user who crosses to
// Se/cure (the ghost button) can be handed a short-lived, quota-metered token
// minted for their account. The token authorizes the PUBLIC POST /api/websearch
// endpoint (src/websearch.js) to run a search on their behalf — and ONLY a
// search: a query string crosses the wire, never the conversation, filename, or
// account identity (invariant 4's minimal-outbound rule still holds).
//
// This module is the TOKEN half only: mint + verify. The quota METER lives in
// D1 (src/websearch.js, keyed by the token's `jti`) — a self-contained token
// can't decrement a counter across requests, so the token authenticates and the
// D1 row meters. Signed with SESSION_SECRET (the same sole HMAC key as the
// session cookie — see src/auth.js), under an independent `websearch.` message
// namespace so a grant token can never be confused with a session/state HMAC.
// Near-leaf module: imports only the shared crypto primitives leaf
// (src/token-crypto.js), so websearch.js and its tests share ONE
// implementation.

import { b64url, b64urlDecode, safeEqual, sign } from "./token-crypto.js";

const TOKEN_PREFIX = "wsk1"; // versioned wire prefix
const NS = "websearch."; // HMAC message namespace for grant tokens

/** @typedef {import('./types.js').Env} Env */
/**
 * The claims a grant token carries. All fields are set at mint time; the D1
 * row keyed by `jti` holds the mutable `used` counter.
 * @typedef {Object} GrantClaims
 * @property {string} jti unique grant id (also the D1 primary key)
 * @property {string} uid the granting user's id (accountability)
 * @property {number} quota total searches this grant authorizes
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds)
 */

/**
 * Mints a `wsk1.<payload>.<hmac>` grant token from the given claims.
 * @param {Env} env
 * @param {GrantClaims} claims
 * @returns {Promise<string>}
 */
export async function mintWebSearchToken(env, claims) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await sign(env, NS, payload);
  return `${TOKEN_PREFIX}.${payload}.${sig}`;
}

/**
 * Verifies a grant token and returns its claims, or null on any problem
 * (bad shape, bad signature, expired). Verification is signature-first, then
 * expiry — a forged token never reaches the D1 meter.
 * @param {Env} env
 * @param {string} token
 * @param {number} [nowMs] injectable clock for tests
 * @returns {Promise<GrantClaims | null>}
 */
export async function verifyWebSearchToken(env, token, nowMs = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, payload, sig] = parts;
  let expected;
  try {
    expected = await sign(env, NS, payload);
  } catch {
    return null; // no signing key configured
  }
  if (!safeEqual(sig, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object") return null;
  const { jti, uid, quota, iat, exp } = claims;
  if (
    typeof jti !== "string" ||
    !jti ||
    typeof uid !== "string" ||
    !uid ||
    !Number.isFinite(quota) ||
    !Number.isFinite(exp)
  ) {
    return null;
  }
  if (exp * 1000 <= nowMs) return null; // expired
  return { jti, uid, quota, iat: Number.isFinite(iat) ? iat : 0, exp };
}
