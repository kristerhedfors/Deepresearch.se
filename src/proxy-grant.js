// @ts-check
// The SECURE-RESEARCH-SPACE two-tier token half — the signed capabilities that
// let an otherwise server-less DeepResearch.Se/cure (DRC) session borrow the
// minting account's server-side keys for a bounded, time-limited window.
//
// The story (invariant 4's SECOND bounded exception — see CLAUDE.md): DRC is
// client-side by design, the server in no data path. The web-search grant
// (src/websearch-key.js) was the first narrow relaxation. This generalizes the
// idea into a "secure research space" a signed-in Se/rver user can hand to a
// Se/cure session on crossover: a bundle of account-connected proxy grants, one
// per SERVICE — `web` (Exa search through the server key) and `api` (LLM
// completions through the server's Berget key).
//
// TWO TIERS, deliberately (the owner's directive):
//   1. GRANT TOKEN ("token-granting token", prefix `prg1`): the redemption
//      ticket that travels INSIDE the encrypted bundle in the URL. Namespace
//      `proxygrant.`. Short-lived like the grant it names.
//   2. PROXY TOKEN (prefix `prx1`): what the client gets by EXCHANGING a grant
//      token (POST /api/proxy/exchange) and then uses to call the service.
//      Namespace `proxytoken.`. It never appears in a URL — kept in memory /
//      localStorage — so a leaked bundle URL alone carries only the exchange
//      ticket, not the working credential.
// Both reference the SAME `jti` (the D1 `proxy_grants` row that meters usage);
// a self-contained token can't decrement a counter across requests, so the
// token authenticates and the row meters — exactly the websearch pattern.
//
// Signed with SESSION_SECRET (the site's sole HMAC key — src/auth.js), each
// tier under its OWN message namespace so the three token families
// (session/state, websearch `wsk1`, and these) can never be confused.
// Near-leaf module: imports only the shared crypto primitives leaf
// (src/token-crypto.js), so src/proxy.js and the tests share ONE
// implementation.

import { b64url, b64urlDecode, safeEqual, sign } from "./token-crypto.js";

const GRANT_PREFIX = "prg1"; // the token-granting token (in the bundle)
const PROXY_PREFIX = "prx1"; // the working proxy token (post-exchange)
const GRANT_NS = "proxygrant."; // HMAC message namespace for grant tokens
const PROXY_NS = "proxytoken."; // HMAC message namespace for proxy tokens

/** @typedef {import('./types.js').Env} Env */
/**
 * The claims BOTH token tiers carry (they differ only by prefix + namespace).
 * The mutable `used` counter lives in the D1 row keyed by `jti`.
 * @typedef {Object} ProxyClaims
 * @property {string} jti unique grant id (also the D1 primary key)
 * @property {string} uid the granting user's id (accountability)
 * @property {"web"|"api"} svc which proxied service this authorizes
 * @property {number} quota total units this grant authorizes
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds)
 */

/**
 * Mint a token of a given tier from the given claims.
 * @param {Env} env
 * @param {string} prefix @param {string} ns
 * @param {ProxyClaims} claims
 * @returns {Promise<string>}
 */
async function mint(env, prefix, ns, claims) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = await sign(env, ns, payload);
  return `${prefix}.${payload}.${sig}`;
}

/**
 * Verify a token of a given tier; returns its claims or null on any problem
 * (bad shape, wrong tier, bad signature, expired). Signature-first, then
 * expiry — a forged token never reaches the D1 meter.
 * @param {Env} env
 * @param {string} prefix @param {string} ns
 * @param {string} token
 * @param {number} nowMs
 * @returns {Promise<ProxyClaims | null>}
 */
async function verify(env, prefix, ns, token, nowMs) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, payload, sig] = parts;
  let expected;
  try {
    expected = await sign(env, ns, payload);
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
  const { jti, uid, svc, quota, iat, exp } = claims;
  if (
    typeof jti !== "string" ||
    !jti ||
    typeof uid !== "string" ||
    !uid ||
    (svc !== "web" && svc !== "api") ||
    !Number.isFinite(quota) ||
    !Number.isFinite(exp)
  ) {
    return null;
  }
  if (exp * 1000 <= nowMs) return null; // expired
  return { jti, uid, svc, quota, iat: Number.isFinite(iat) ? iat : 0, exp };
}

/** Mint a `prg1.…` GRANT token (the bundle's token-granting token). */
export function mintGrantToken(/** @type {Env} */ env, /** @type {ProxyClaims} */ claims) {
  return mint(env, GRANT_PREFIX, GRANT_NS, claims);
}

/** Verify a `prg1.…` GRANT token. @returns {Promise<ProxyClaims|null>} */
export function verifyGrantToken(/** @type {Env} */ env, /** @type {string} */ token, nowMs = Date.now()) {
  return verify(env, GRANT_PREFIX, GRANT_NS, token, nowMs);
}

/** Mint a `prx1.…` PROXY token (the working, post-exchange credential). */
export function mintProxyToken(/** @type {Env} */ env, /** @type {ProxyClaims} */ claims) {
  return mint(env, PROXY_PREFIX, PROXY_NS, claims);
}

/** Verify a `prx1.…` PROXY token. @returns {Promise<ProxyClaims|null>} */
export function verifyProxyToken(/** @type {Env} */ env, /** @type {string} */ token, nowMs = Date.now()) {
  return verify(env, PROXY_PREFIX, PROXY_NS, token, nowMs);
}
