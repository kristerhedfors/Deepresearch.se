// @ts-check
// The Se/rver TOKEN — the CONSOLIDATED grant credential: ONE ticket, ONE JWT.
//
// Where the earlier ticket families each carried one narrow capability
// (src/websearch-key.js's `wsk1` web-search grant; src/proxy-grant.js's
// `prg1`/`prx1` per-service pair), a Se/rver token bundles the whole grant
// into a single signed JWT: a PERMISSION SET (`perms`) naming which of the
// site's UPSTREAM APIs it may call, one expiry (`exp`) covering the whole
// grant, one `jti` keying the D1 rows that meter each permission's quota,
// and the minting account (`sub`) for accountability. The name is deliberate
// (owner directive, 2026-07-16): it is called a SERVER token so nobody ever
// forgets that using it sends data to a server somewhere — it is the
// credential for the server-touching path, never part of the pure
// client-side Se/cure posture.
//
// ══════════════════════════════════════════════════════════════════════════
// THE SERVER-TOKEN GUARANTEE (owner directive, 2026-07-16 — load-bearing):
// A Se/rver token grants access to the site's UPSTREAM APIs ONLY (web search
// through the server's Exa key, LLM completions through the server's Berget
// key). It NEVER grants access to any of Se/rver's OWN data: no project
// contents, no chat contents, no conversation history, no account data — an
// API call bearing a Se/rver token can never read anything Se/rver stores.
// Two structural enforcements keep this true:
//   1. The permission VOCABULARY is closed: `SERVER_TOKEN_SERVICES` names
//      upstream services only, and no value naming a data surface may ever
//      be added to it. verify() drops unknown permissions, so even a token
//      minted with a hypothetical future perm cannot authorize anything
//      this deploy doesn't explicitly serve.
//   2. The token is verified ONLY by the src/server-grants.js endpoints,
//      which touch nothing but the `server_tokens` meter table and the
//      upstream providers — a module-graph fact pinned by a unit test
//      (src/server-grants.test.js). A Se/rver token can never pass the
//      identity gate (src/auth.js verifies session cookies by a different
//      scheme entirely), so every data-bearing /api/* route is out of reach
//      by construction.
//   3. THE ADMIN INTERFACE IS OUT OF REACH THE SAME WAY (owner directive,
//      2026-07-16): a Se/rver token is NEVER a login. /admin and every
//      /api/admin/* route — including the token subsystem's own control
//      surface — sit behind the identity gate's proper sign-in (a session
//      identity with the admin role, or the break-glass Basic secrets);
//      src/auth.js's identify() cannot be satisfied by a JWT in any position
//      (cookie, Bearer, Basic), a fact pinned by a unit test
//      (src/server-token.test.js). Tokens are ADMINISTERED from the admin
//      interface; they never open it.
// ══════════════════════════════════════════════════════════════════════════
//
// Wire format: a STANDARD JWS/JWT (RFC 7519, HS256) — `header.payload.sig`,
// all three segments base64url — so the claims are inspectable with any JWT
// tool (transparency is part of the project's mission; there is nothing
// hidden in a Se/rver token). Signed with SESSION_SECRET, the site's sole
// HMAC key. Family separation from the other token families under that one
// key is structural, and pinned by tests:
//   - the other families sign `"<ns>" + <one dot-free base64url segment>`
//     (namespaces `websearch.` / `proxygrant.` / `proxytoken.` / the auth
//     cookie's own format); the JWT signing input is
//     `<canonical header>.<payload>` — it always starts with the pinned
//     header segment and contains a dot, which no other family's input can;
//   - the signature ENCODING differs (base64url here, hex everywhere else),
//     so no signature string from one family even parses in another;
//   - verify() constant-compares the header segment against the ONE
//     canonical minted header, so header malleability (alg swapping, `none`,
//     re-serialized JSON) is rejected before the signature is even checked.
//
// This module is the TOKEN half only: mint + verify, pure over Web Crypto.
// The quota METER lives in D1 (src/server-grants.js, rows keyed
// (jti, service)) — a self-contained token can't decrement a counter across
// requests, so the token authenticates and the rows meter. That split is
// what keeps a live grant ADMINISTRABLE (quota adjusts, pause, revoke act on
// the rows) while the token in circulation stays fixed.
// Near-leaf module: imports only the shared crypto primitives leaf
// (src/token-crypto.js).

import { b64url, b64urlDecode, safeEqual } from "./token-crypto.js";

/** @typedef {import('./types.js').Env} Env */

/**
 * The CLOSED permission vocabulary — upstream services ONLY (the guarantee
 * above). `web` = one web search through the server's Exa key (a query
 * string crosses the wire, nothing else); `api` = one LLM completion through
 * the server's Berget key (the one place a token-bearing call carries
 * conversation content UPSTREAM — it is still never stored or readable back).
 * No entry naming any Se/rver data surface may ever be added here.
 */
export const SERVER_TOKEN_SERVICES = ["web", "api"];

/** The one issuer value a Se/rver token may carry (the apex host, lowercase
 * per the branding rule: functional strings stay lowercase). */
export const SERVER_TOKEN_ISS = "deepresearch.se";

// The ONE canonical JOSE header this family ever mints — and the exact
// segment verify() requires, byte for byte. Computed once at module load.
const HEADER_B64 = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

/**
 * The claims a Se/rver token carries. The mutable per-service `used`
 * counters live in the D1 rows keyed by (`jti`, service) — deliberately NOT
 * in the token, so a minter can adjust or pause a live grant without
 * re-issuing anything (token fixed, rows metered).
 * @typedef {Object} ServerTokenClaims
 * @property {string} iss always `deepresearch.se`
 * @property {string} sub the minting user's id (accountability)
 * @property {string} jti unique grant id (the D1 rows' key)
 * @property {string[]} perms the permission set — SERVER_TOKEN_SERVICES members only
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds) — the whole grant's one duration
 */

/**
 * Raw HS256 over the JWS signing input, base64url-encoded (RFC 7515).
 * Fails closed without SESSION_SECRET, mirroring token-crypto.js's sign.
 * @param {Env} env @param {string} signingInput @returns {Promise<string>}
 */
async function hs256(env, signingInput) {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(env.SESSION_SECRET)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return b64url(new Uint8Array(sig));
}

/**
 * Mints a Se/rver token (a standard HS256 JWT) from the given claims.
 * Unknown permissions are dropped at mint too — a token can never leave this
 * function claiming anything outside the closed vocabulary.
 * @param {Env} env
 * @param {{ sub: string, jti: string, perms: string[], iat: number, exp: number }} claims
 * @returns {Promise<string>}
 */
export async function mintServerToken(env, claims) {
  const perms = (claims.perms || []).filter((p) => SERVER_TOKEN_SERVICES.includes(p));
  /** @type {ServerTokenClaims} */
  const full = { iss: SERVER_TOKEN_ISS, sub: claims.sub, jti: claims.jti, perms, iat: claims.iat, exp: claims.exp };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(full)));
  const sig = await hs256(env, `${HEADER_B64}.${payload}`);
  return `${HEADER_B64}.${payload}.${sig}`;
}

/**
 * Verifies a Se/rver token and returns its claims, or null on ANY problem
 * (bad shape, non-canonical header, bad signature, bad claims, expired).
 * Header-pin first, then signature, then claims/expiry — a forged or
 * alg-swapped token never reaches the D1 meter. Unknown perms are dropped;
 * a token with no known perm left is rejected outright.
 * @param {Env} env
 * @param {string} token
 * @param {number} [nowMs] injectable clock for tests
 * @returns {Promise<ServerTokenClaims | null>}
 */
export async function verifyServerToken(env, token, nowMs = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  // The header PIN: only the exact canonical minted header verifies. This
  // closes every header-malleability angle (alg:none, alg swaps, JSON
  // re-serialization) in one constant-time compare.
  if (!safeEqual(header, HEADER_B64)) return null;
  let expected;
  try {
    expected = await hs256(env, `${header}.${payload}`);
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
  const { iss, sub, jti, perms, iat, exp } = claims;
  if (iss !== SERVER_TOKEN_ISS) return null;
  if (typeof jti !== "string" || !jti || typeof sub !== "string" || !sub) return null;
  if (!Array.isArray(perms) || !Number.isFinite(exp)) return null;
  const known = perms.filter((p) => SERVER_TOKEN_SERVICES.includes(p));
  if (!known.length) return null;
  if (exp * 1000 <= nowMs) return null; // expired
  return { iss, sub, jti, perms: known, iat: Number.isFinite(iat) ? iat : 0, exp };
}
