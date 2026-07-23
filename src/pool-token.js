// @ts-check
// The POOL TOKEN — the capability that authorizes submitting LLM completion
// jobs to ONE shared-compute pool (docs/COMPUTE-SHARING.md). A sharer who lends
// their local model mints these; a consumer carries one and submits jobs the
// sharer's browser runs.
//
// This is a SEPARATE token family from the consolidated Se/rver JWT
// (src/server-token.js) — deliberately, for two reasons documented in the
// design:
//   1. A pool token BINDS A POOL (the `pool` claim names which pool it may
//      submit to). The Se/rver token's closed claim set has no such field.
//   2. It keeps the SERVER-TOKEN GUARANTEE pristine. That guarantee is worded
//      around SERVER-operated upstreams (Exa/Berget keys); a pool token routes
//      to a PEER-operated upstream — a different disclosure. Rather than dilute
//      that guarantee, pool tokens get their own family and their own guarantee.
//
// ══════════════════════════════════════════════════════════════════════════
// THE POOL-TOKEN GUARANTEE (the parallel to the server-token one):
// A pool token authorizes ONE thing — submitting LLM completion jobs to the ONE
// pool it names. It is NEVER a login (src/auth.js's identify() verifies session
// cookies by a different scheme and can never be satisfied by this token,
// pinned by test) and it NEVER unlocks any Se/rver data. What it exposes — and
// what makes it different from a Se/rver token — is stated plainly to the user
// at the point of use: the prompt a consumer submits is read by the pool
// owner's machine. That peer exposure is the feature, disclosed, not a leak.
// This module is verified ONLY by src/pool.js, whose endpoints touch nothing
// but the pool_* meter/queue tables and relay to the pool's own providers — a
// module-graph fact pinned by src/pool.test.js.
// ══════════════════════════════════════════════════════════════════════════
//
// Wire format mirrors the wsk1/prg1 families (src/token-crypto.js), NOT the JWT:
//   pt1.<b64url(claims)>.<hex HMAC-SHA-256 over "pool." + b64url(claims)>
// Signed under the one SESSION_SECRET with namespace `pool.`, so the tag never
// validates as another family's (the same mutual-unforgeability the other
// namespaced families rely on), and the hex signature never parses as a Se/rver
// JWT's base64url segment.
//
// Near-leaf module: imports only the shared crypto primitives leaf.

import { b64url, b64urlDecode, safeEqual, sign } from "./token-crypto.js";

/** @typedef {import('./types.js').Env} Env */

/** The namespace that separates this family from every other signed-token
 * family under the single SESSION_SECRET key. */
export const POOL_TOKEN_NS = "pool.";

/** The recognizable, greppable wire prefix. */
export const POOL_TOKEN_PREFIX = "pt1.";

/**
 * The claims a pool token carries. The mutable `used` counter lives in the D1
 * `pool_tokens` row keyed by `jti` — NOT in the token — so a minter can adjust,
 * pause, or revoke a live grant without re-issuing anything.
 * @typedef {Object} PoolTokenClaims
 * @property {string} jti unique grant id (the D1 row key + revocation handle)
 * @property {string} pool the pool id this token may submit to (== sharer account id)
 * @property {string} sub the minting user's id (accountability)
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds) — the whole grant's one duration
 */

/**
 * Mints a pool token from the given claims.
 * @param {Env} env
 * @param {{ jti: string, pool: string, sub: string, iat: number, exp: number }} claims
 * @returns {Promise<string>}
 */
export async function mintPoolToken(env, claims) {
  /** @type {PoolTokenClaims} */
  const full = {
    jti: String(claims.jti),
    pool: String(claims.pool),
    sub: String(claims.sub),
    iat: claims.iat,
    exp: claims.exp,
  };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(full)));
  const sig = await sign(env, POOL_TOKEN_NS, payload);
  return `${POOL_TOKEN_PREFIX}${payload}.${sig}`;
}

/**
 * Verifies a pool token and returns its claims, or null on ANY problem (bad
 * shape, bad prefix, bad signature, bad claims, expired). Signature first, then
 * claims/expiry — a forged token never reaches the D1 meter.
 * @param {Env} env
 * @param {string} token
 * @param {number} [nowMs] injectable clock for tests
 * @returns {Promise<PoolTokenClaims | null>}
 */
export async function verifyPoolToken(env, token, nowMs = Date.now()) {
  if (typeof token !== "string" || !token.startsWith(POOL_TOKEN_PREFIX)) return null;
  const rest = token.slice(POOL_TOKEN_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  const payload = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  if (!payload || !sig) return null;

  let expected;
  try {
    expected = await sign(env, POOL_TOKEN_NS, payload);
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
  const { jti, pool, sub, iat, exp } = claims;
  if (typeof jti !== "string" || !jti) return null;
  if (typeof pool !== "string" || !pool) return null;
  if (typeof sub !== "string" || !sub) return null;
  if (!Number.isFinite(exp)) return null;
  if (exp * 1000 <= nowMs) return null; // expired
  return { jti, pool, sub, iat: Number.isFinite(iat) ? iat : 0, exp };
}
