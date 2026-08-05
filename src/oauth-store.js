// @ts-check
// THE THREE OAUTH TOKEN FAMILIES — the credentials the connector authorization
// server issues (docs/MCP-CONNECTOR.md, F-20), and the two D1 records that
// govern what a signature cannot.
//
// WHY THREE FAMILIES AND NOT ONE. An OAuth 2.1 code flow issues three
// different things with three different threat models, and collapsing them is
// how authorization servers get broken:
//
//   1. `oac1.` AUTHORIZATION CODE — travels in a URL query string, so it is
//      the one credential that lands in browser history, a Referer header and
//      somebody's proxy log. It therefore lives 60 seconds, carries NOTHING in
//      its payload but its own id (no user, no scope, no client — those are in
//      the D1 row), and is SINGLE USE.
//   2. `oat1.` ACCESS TOKEN — presented on every MCP call, so it is the one on
//      the hot path. Signed only: no D1 row, no lookup, one HMAC verify. It is
//      short-lived because that short life IS its revocation story (see below).
//   3. `ort1.` REFRESH TOKEN — long-lived and held by a PUBLIC client (no
//      client secret exists; CIMD registration means there is no client table
//      either), so it is rotated on every use and its reuse is treated as
//      evidence of theft.
//
// TOKEN FIXED, THE RECORD GOVERNS — the same split src/websearch-key.js +
// websearch_grants and src/mcp-key.js + the account's stored jti already use.
// A signature is a statement about the past; it cannot say "and this has not
// been spent yet". So codes and refresh tokens are SIGNED (authenticity,
// cheaply, before any database work) AND ROWED (single use, revocation), and
// the row is the authority on both. Access tokens are signed only, which is
// what keeps `/mcp` free of a per-call database read; the price is that
// revoking one means waiting out ACCESS_TOKEN_TTL_S — revocation lands by
// refusing the REFRESH, which is a database operation.
//
// FAIL CLOSED, NOT FAIL SOFT. Invariant 2's degrade-rather-than-error rule is
// about helper phases and enrichments. This is the authorization boundary: a
// D1 error here means we cannot prove a code is unspent, and a credential we
// cannot prove is unspent must be refused. Every D1 failure below therefore
// ends as `invalid_grant` (redeem/rotate) or a throw (mint), never as a
// permissive default.
//
// AN ACCESS TOKEN IS NOT A LOGIN. Same structural claim src/mcp-key.js makes,
// pinned by the same kind of test: src/auth.js's identify() reads a `Basic `
// header and the `dr_session` cookie, and an `oat1.` bearer is neither, in any
// position. /admin and every data-bearing /api/* route are out of reach by
// construction, not by a check somebody has to remember to write. The families
// are mutually unforgeable under the single SESSION_SECRET because each passes
// its OWN namespace into the shared tag (src/token-crypto.js's fence): a token
// re-labelled with another family's wire prefix fails that family's verify.
//
// Near-leaf module: the shared crypto primitives plus src/db.js (which imports
// nothing) and the pure metadata leaf — no handler graph, so src/mcp.js and
// the OAuth endpoints stay unit-testable without the pipeline.

import { getDb } from "./db.js";
import { DEFAULT_SCOPE } from "./oauth-metadata.js";
import { b64url, safeEqual, sealedToken, verifiedClaims } from "./token-crypto.js";

/** @typedef {import('./types.js').Env} Env */

/** Wire prefix of an authorization code. */
export const OAUTH_CODE_PREFIX = "oac1";
/** Wire prefix of an access token. */
export const OAUTH_ACCESS_PREFIX = "oat1";
/** Wire prefix of a refresh token. */
export const OAUTH_REFRESH_PREFIX = "ort1";

// One HMAC namespace per family — the thing that keeps them mutually
// unforgeable under the one SESSION_SECRET. Distinct from every family already
// in the codebase (`websearch.`, `proxygrant.`, `proxytoken.`, `pool.`,
// `mcpkey.`) and from each other.
const CODE_NS = "oauthcode.";
const ACCESS_NS = "oauthaccess.";
const REFRESH_NS = "oauthrefresh.";

/**
 * 60 seconds. RFC 6749 §4.1.2 puts the maximum at ten minutes and says a
 * lifetime of one minute is RECOMMENDED; a code is redeemed by a machine
 * milliseconds after the redirect, so nothing legitimate needs longer, and the
 * window is exactly how long a code sitting in browser history stays useful.
 */
export const AUTH_CODE_TTL_S = 60;
/** One hour — short enough that "revoke by refusing the refresh" is honest. */
export const ACCESS_TOKEN_TTL_S = 3600;
/** 90 days. A connector the user still uses re-ups it on every refresh. */
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600;

/**
 * The schema for src/db.js. Two tables, both keyed by the token's `jti`, both
 * holding the claims the token deliberately does NOT carry.
 *
 * WHY THE ROW HOLDS THE CLAIMS. A code is handed to a client through a URL. If
 * its payload carried the user id, the scope and the redirect, every one of
 * those would be readable in a browser history entry by anyone with the
 * device — decoding a base64url segment is not an attack. Keeping them
 * server-side costs one indexed lookup on a path that runs once per
 * authorization, and it means a leaked code discloses nothing at all.
 *
 * `family_id` on the refresh table is the reuse-detection handle: every token
 * descended from one authorization shares it, so detecting a replay lets us
 * revoke the whole lineage in one statement (see rotateRefreshToken).
 */
export const OAUTH_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS oauth_codes (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_exp ON oauth_codes(expires_at);
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  jti TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_exp ON oauth_refresh_tokens(expires_at);`;

/**
 * @typedef {Object} AuthCodeClaims
 * @property {number} v format version (1)
 * @property {string} jti this code's id — the D1 primary key, and the ONLY
 *   thing the code discloses
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds)
 */

/**
 * @typedef {Object} AccessTokenClaims
 * @property {number} v format version (1)
 * @property {string} sub the acting account's user-row id, as a string
 * @property {string} scope space-delimited granted scopes
 * @property {string} jti this issue's id (makes two same-second mints distinct)
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds)
 */

/**
 * @typedef {Object} RefreshTokenClaims
 * @property {number} v format version (1)
 * @property {string} jti this issue's id — the D1 primary key
 * @property {string} fam the family this issue descends from; survives in the
 *   token so a replay whose row is already gone can still name what to revoke
 * @property {number} iat issued-at (epoch seconds)
 * @property {number} exp expiry (epoch seconds)
 */

/** A fresh, unguessable id: 16 random bytes, base64url — the shape every token family here uses. @returns {string} */
function newId() {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Normalize an injected clock to epoch MILLISECONDS.
 *
 * Every `now` option in this module is milliseconds (`Date.now()`), matching
 * src/mcp-key.js's `opts.now`. But the values that go INTO the rows and claims
 * are seconds, this module is being written against a contract three other
 * handlers code to at the same time, and a unit mix-up would not fail loudly —
 * it would silently issue a code that expires in 1970 or in the year 56000.
 * Anything below 1e11 cannot be a plausible current time in milliseconds (that
 * is 1973) and cannot be a plausible time in seconds beyond the year 5138, so
 * the split is unambiguous for every clock either agent will ever pass.
 * @param {number | undefined} now
 * @returns {number} epoch milliseconds
 */
function epochMs(now) {
  if (!Number.isFinite(now)) return Date.now();
  const n = Number(now);
  return n < 1e11 ? Math.round(n * 1000) : n;
}

/**
 * The inverse: parse the wire shape, check the tag under THIS family's
 * namespace, and check the two claims every family shares (version, expiry).
 * Null for every failure — a caller cannot tell a forged tag from an expired
 * token, on purpose.
 * @param {Env} env @param {string} ns @param {string} prefix
 * @param {string | null | undefined} token @param {number} nowMs
 * @returns {Promise<any | null>}
 */
async function unseal(env, ns, prefix, token, nowMs) {
  if (typeof token !== "string" || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [gotPrefix, payload, sig] = parts;
  if (gotPrefix !== prefix || !payload || !sig) return null;
  const claims = await verifiedClaims(env, ns, payload, sig);
  if (!claims) return null;
  if (claims.v !== 1) return null;
  if (typeof claims.jti !== "string" || !claims.jti) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= nowMs) return null;
  return claims;
}

/**
 * The database, or a throw. Every entry point here needs D1 to make a promise
 * it can keep, so "no binding" is a configuration error rather than a degraded
 * mode — unlike most of src/, where a missing DB turns a feature off. Nothing
 * is lost by being strict: without D1 there are no accounts to authorize for.
 * @param {Env} env
 * @returns {Promise<D1Database>}
 */
async function requireDb(env) {
  const db = await getDb(env);
  if (!db) throw new Error("D1 is not configured; OAuth cannot issue single-use credentials");
  return db;
}

/**
 * The PKCE S256 transformation: `base64url(sha256(ascii(verifier)))`
 * (RFC 7636 §4.2). Exported because the authorize/token handlers and their
 * tests need to produce a challenge, and a second copy of this three-line
 * function is exactly how a codebase ends up with one that pads its base64.
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function s256Challenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(verifier)));
  return b64url(new Uint8Array(digest));
}

/**
 * A syntactically valid `code_verifier` (RFC 7636 §4.1): 43–128 characters
 * from the unreserved set. Checked before hashing so a client that sends a
 * short or exotic verifier gets `invalid_request` — the honest answer — rather
 * than a hash comparison that was never going to match.
 * @param {unknown} v
 * @returns {boolean}
 */
function validVerifier(v) {
  return typeof v === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

/**
 * An S256 challenge is a SHA-256 digest in base64url: exactly 43 characters,
 * no padding, no other alphabet. Enforced at MINT so a `plain` challenge can
 * never reach a row — the redemption comparison would refuse it anyway (no
 * verifier hashes to itself), but refusing to store one means the failure
 * surfaces at the authorization request, where the client can still be told
 * what it did wrong.
 * @param {unknown} c
 * @returns {boolean}
 */
function validChallenge(c) {
  return typeof c === "string" && /^[A-Za-z0-9_-]{43}$/.test(c);
}

/** @param {number} nowMs @returns {number} epoch seconds */
const secs = (nowMs) => Math.floor(nowMs / 1000);

// The two sweep statements, spelled out rather than built from a table name:
// no interpolation into SQL at all, so nothing here needs an entry in
// src/sql-injection-guard.test.js's hand-audited allowlist.
const SWEEP_CODES = "DELETE FROM oauth_codes WHERE expires_at <= ?1";
const SWEEP_REFRESH = "DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?1";

/**
 * Delete rows whose expiry has passed. Opportunistic and deliberately
 * un-scheduled: mints are rare (once per authorization), both tables are
 * indexed on `expires_at`, and a cron for two small tables would be a moving
 * part to operate for no gain. A failure is swallowed — a sweep that did not
 * happen is a few stale rows, never a refused authorization.
 *
 * Note this can never create a false reuse signal in rotateRefreshToken: a row
 * only becomes sweepable once `expires_at` has passed, and by then the token
 * that names it is already refused by `unseal` on the same expiry.
 * @param {D1Database} db @param {string} sql one of the two constants above
 * @param {number} nowS
 * @returns {Promise<void>}
 */
async function sweep(db, sql, nowS) {
  await db
    .prepare(sql)
    .bind(nowS)
    .run()
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// 1. Authorization codes
// ---------------------------------------------------------------------------

/**
 * Mint a single-use authorization code for one approved authorization.
 *
 * Throws rather than returning an error object: every argument here comes from
 * a request the CALLER has already validated (an unallowed redirect, a missing
 * `code_challenge` and a non-S256 method are all `invalid_request` at the
 * authorize endpoint, before this is reached), so reaching this function with
 * a bad one is a programming error, and the fail-closed answer to a
 * programming error at an authorization boundary is to issue nothing.
 * @param {Env} env
 * @param {{ userId: string | number, clientId: string, redirectUri: string,
 *   codeChallenge: string, scope?: string, now?: number }} opts
 * @returns {Promise<{ code: string, jti: string, exp: number }>}
 */
export async function mintAuthCode(env, opts) {
  const userId = String(opts?.userId ?? "");
  const clientId = String(opts?.clientId ?? "");
  const redirectUri = String(opts?.redirectUri ?? "");
  if (!userId) throw new Error("mintAuthCode: userId is required");
  if (!clientId) throw new Error("mintAuthCode: clientId is required");
  if (!redirectUri) throw new Error("mintAuthCode: redirectUri is required");
  if (!validChallenge(opts?.codeChallenge)) {
    // PKCE is mandatory in OAuth 2.1 and this is where that is enforced: no
    // path through this module can produce a code without an S256 challenge.
    throw new Error("mintAuthCode: codeChallenge must be a base64url S256 challenge");
  }
  const scope = typeof opts?.scope === "string" && opts.scope.trim() ? opts.scope.trim() : DEFAULT_SCOPE;

  const nowMs = epochMs(opts?.now);
  const nowS = secs(nowMs);
  const exp = nowS + AUTH_CODE_TTL_S;
  const jti = newId();

  const db = await requireDb(env);
  await sweep(db, SWEEP_CODES, nowS);
  // The INSERT is not caught: if the record cannot be written, the code must
  // not exist, and the caller must see the failure rather than hand a client a
  // credential nothing can ever redeem.
  await db
    .prepare(
      "INSERT INTO oauth_codes (jti, user_id, client_id, redirect_uri, code_challenge, scope, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(jti, userId, clientId, redirectUri, String(opts.codeChallenge), scope, nowS, exp)
    .run();

  /** @type {AuthCodeClaims} */
  const claims = { v: 1, jti, iat: nowS, exp };
  return { code: await sealedToken(env, CODE_NS, OAUTH_CODE_PREFIX, claims), jti, exp };
}

/**
 * Redeem an authorization code, at most once, ever.
 *
 * THE ORDER IS THE SECURITY PROPERTY:
 *
 *   a. shape (`invalid_request`) — a caller that forgot a parameter has not
 *      spent anything, so its user can retry the flow;
 *   b. signature + expiry, no database touched — a forged code never reaches
 *      D1, so this endpoint cannot be used to probe the table;
 *   c. THE CLAIM: a guarded `DELETE ... WHERE jti = ?` whose `meta.changes`
 *      decides the winner. SELECT-then-DELETE would let two concurrent
 *      redemptions both read the row and both proceed; here the database
 *      decides, and the loser sees `changes = 0`. (The SELECT above it only
 *      fetches the claims — it grants nothing.)
 *   d. only THEN client, redirect and PKCE. Which means a WRONG VERIFIER BURNS
 *      THE CODE: whoever holds a stolen code gets exactly one guess at the
 *      verifier, not a brute-force loop, and RFC 6749 §4.1.2's "deny the
 *      request" for a code presented twice holds however the first attempt
 *      ended.
 *
 * @param {Env} env
 * @param {string} code the `oac1.…` string presented at the token endpoint
 * @param {{ clientId?: string, redirectUri?: string, codeVerifier?: string, now?: number }} opts
 * @returns {Promise<{ userId: string, scope: string } | { error: string }>}
 *   `error` is an RFC 6749 code: `invalid_request` for a malformed request,
 *   `invalid_grant` for a code that does not hold up.
 */
export async function redeemAuthCode(env, code, opts = {}) {
  if (typeof code !== "string" || !code) return { error: "invalid_request" };
  if (typeof opts.clientId !== "string" || !opts.clientId) return { error: "invalid_request" };
  if (typeof opts.redirectUri !== "string" || !opts.redirectUri) return { error: "invalid_request" };
  if (!validVerifier(opts.codeVerifier)) return { error: "invalid_request" };

  const nowMs = epochMs(opts.now);
  const claims = await unseal(env, CODE_NS, OAUTH_CODE_PREFIX, code, nowMs);
  if (!claims) return { error: "invalid_grant" };

  /** @type {D1Database} */
  let db;
  try {
    db = await requireDb(env);
  } catch {
    return { error: "invalid_grant" }; // fail closed: unprovable is unspendable
  }

  /** @type {Record<string, unknown> | null} */
  let row = null;
  try {
    row = await db
      .prepare(
        "SELECT user_id, client_id, redirect_uri, code_challenge, scope, expires_at FROM oauth_codes WHERE jti = ?1",
      )
      .bind(claims.jti)
      .first();
  } catch {
    return { error: "invalid_grant" };
  }
  if (!row) return { error: "invalid_grant" }; // already spent, revoked, or swept

  // The claim. Everything after this point is a check on a code that is
  // already dead whichever way the check goes.
  try {
    const claimed = await db.prepare("DELETE FROM oauth_codes WHERE jti = ?1").bind(claims.jti).run();
    if (Number(claimed?.meta?.changes || 0) < 1) return { error: "invalid_grant" };
  } catch {
    return { error: "invalid_grant" };
  }

  if (Number(row.expires_at || 0) * 1000 <= nowMs) return { error: "invalid_grant" };
  if (!safeEqual(String(row.client_id), opts.clientId)) return { error: "invalid_grant" };
  if (!safeEqual(String(row.redirect_uri), opts.redirectUri)) return { error: "invalid_grant" };

  const presented = await s256Challenge(String(opts.codeVerifier));
  if (!safeEqual(presented, String(row.code_challenge))) return { error: "invalid_grant" };

  return { userId: String(row.user_id), scope: String(row.scope || "") };
}

// ---------------------------------------------------------------------------
// 2. Access tokens
// ---------------------------------------------------------------------------

/**
 * Mint a bearer access token. Signed only — the one credential on this
 * surface with no database row, because it is the one presented on every
 * single MCP call and a per-call D1 read would be a permanent tax on the hot
 * path for a lookup that can only ever say "yes".
 * @param {Env} env
 * @param {{ userId: string | number, scope?: string, ttlS?: number, now?: number }} opts
 * @returns {Promise<{ token: string, exp: number }>}
 */
export async function mintAccessToken(env, opts) {
  const userId = String(opts?.userId ?? "");
  if (!userId) throw new Error("mintAccessToken: userId is required");
  const scope = typeof opts?.scope === "string" && opts.scope.trim() ? opts.scope.trim() : DEFAULT_SCOPE;
  const nowS = secs(epochMs(opts?.now));
  const ttl = Number.isFinite(opts?.ttlS) ? Math.max(60, Number(opts?.ttlS)) : ACCESS_TOKEN_TTL_S;
  /** @type {AccessTokenClaims} */
  const claims = { v: 1, sub: userId, scope, jti: newId(), iat: nowS, exp: nowS + ttl };
  return { token: await sealedToken(env, ACCESS_NS, OAUTH_ACCESS_PREFIX, claims), exp: claims.exp };
}

/**
 * Verify an access token: format, this family's signature, version, expiry.
 * Null for anything that does not verify.
 *
 * What this deliberately does NOT do is decide what the holder may reach. The
 * scope rides back out and the MCP surface narrows it further against the
 * ACCOUNT'S own exposure config (src/mcp-config.js), which the holder of a
 * token cannot edit — the same property that makes an MCP key safe.
 * @param {Env} env
 * @param {string | null | undefined} token
 * @param {number} [nowMs]
 * @returns {Promise<{ sub: string, scope: string, exp: number } | null>}
 */
export async function verifyAccessToken(env, token, nowMs = Date.now()) {
  const claims = await unseal(env, ACCESS_NS, OAUTH_ACCESS_PREFIX, token, epochMs(nowMs));
  if (!claims) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (typeof claims.scope !== "string") return null;
  return { sub: claims.sub, scope: claims.scope, exp: claims.exp };
}

// ---------------------------------------------------------------------------
// 3. Refresh tokens
// ---------------------------------------------------------------------------

/**
 * Mint a refresh token.
 *
 * `familyId` is INTERNAL: rotateRefreshToken passes the outgoing token's
 * family so a lineage keeps one identity across every rotation. A first mint
 * (the code exchange) omits it and starts a new family at its own jti.
 * @param {Env} env
 * @param {{ userId: string | number, clientId: string, scope?: string,
 *   familyId?: string, now?: number }} opts
 * @returns {Promise<{ token: string, jti: string }>}
 */
export async function mintRefreshToken(env, opts) {
  const userId = String(opts?.userId ?? "");
  const clientId = String(opts?.clientId ?? "");
  if (!userId) throw new Error("mintRefreshToken: userId is required");
  if (!clientId) throw new Error("mintRefreshToken: clientId is required");
  const scope = typeof opts?.scope === "string" && opts.scope.trim() ? opts.scope.trim() : DEFAULT_SCOPE;

  const nowMs = epochMs(opts?.now);
  const nowS = secs(nowMs);
  const exp = nowS + REFRESH_TOKEN_TTL_S;
  const jti = newId();
  const fam = typeof opts?.familyId === "string" && opts.familyId ? opts.familyId : jti;

  const db = await requireDb(env);
  // Only a NEW family sweeps: a rotation runs inside a token request a client
  // is waiting on, and it has already deleted the row it replaced.
  if (fam === jti) await sweep(db, SWEEP_REFRESH, nowS);
  await db
    .prepare(
      "INSERT INTO oauth_refresh_tokens (jti, family_id, user_id, client_id, scope, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(jti, fam, userId, clientId, scope, nowS, exp)
    .run();

  /** @type {RefreshTokenClaims} */
  const claims = { v: 1, jti, fam, iat: nowS, exp };
  return { token: await sealedToken(env, REFRESH_NS, OAUTH_REFRESH_PREFIX, claims), jti };
}

/**
 * Exchange a refresh token for its successor. Rotation is MANDATORY, and the
 * old jti dies in the same call that mints the new one.
 *
 * REUSE IS TREATED AS COMPROMISE (OAuth 2.1 §6.1 / RFC 6819 §5.2.2.3). The
 * client here is public: there is no secret, so a stolen refresh token is
 * indistinguishable from the real one on presentation. What IS distinguishable
 * is the *second* presentation of an already-rotated token — only one of the
 * two parties can hold the successor, so a replay means the lineage is in two
 * pairs of hands. When that happens this revokes THE WHOLE FAMILY, including
 * the successor the thief or the legitimate client is currently holding, and
 * the user re-authorizes. The alternative (refuse the replay, keep the family)
 * leaves whoever stole it holding a live credential in exactly the case where
 * we have positive evidence of theft.
 *
 * The cost is honest and worth stating: a client that loses the response to a
 * refresh and retries with the old token also lands here and gets logged out.
 * That is the trade the spec recommends, and re-authorizing an MCP connector
 * is a click.
 *
 * @param {Env} env
 * @param {string} token the `ort1.…` string presented at the token endpoint
 * @param {{ clientId?: string, now?: number }} opts
 * @returns {Promise<{ userId: string, scope: string, refresh: { token: string, jti: string } } | { error: string }>}
 */
export async function rotateRefreshToken(env, token, opts = {}) {
  if (typeof token !== "string" || !token) return { error: "invalid_request" };
  if (typeof opts.clientId !== "string" || !opts.clientId) return { error: "invalid_request" };

  const nowMs = epochMs(opts.now);
  const claims = await unseal(env, REFRESH_NS, OAUTH_REFRESH_PREFIX, token, nowMs);
  if (!claims) return { error: "invalid_grant" };
  const fam = typeof claims.fam === "string" && claims.fam ? claims.fam : claims.jti;

  /** @type {D1Database} */
  let db;
  try {
    db = await requireDb(env);
  } catch {
    return { error: "invalid_grant" };
  }

  /** @type {Record<string, unknown> | null} */
  let row = null;
  try {
    row = await db
      .prepare("SELECT family_id, user_id, client_id, scope, expires_at FROM oauth_refresh_tokens WHERE jti = ?1")
      .bind(claims.jti)
      .first();
  } catch {
    return { error: "invalid_grant" };
  }
  if (!row) {
    // Signature good, not expired, no row: this token was already rotated (or
    // the family was revoked). The signature proves it was really issued, so
    // this is the replay case, not noise.
    await revokeFamily(db, fam);
    return { error: "invalid_grant" };
  }

  if (Number(row.expires_at || 0) * 1000 <= nowMs) {
    await revokeFamily(db, String(row.family_id || fam));
    return { error: "invalid_grant" };
  }
  if (!safeEqual(String(row.client_id), opts.clientId)) {
    // A lineage presented by a different client is the same evidence a replay
    // is: the token reached somewhere it was never issued to.
    await revokeFamily(db, String(row.family_id || fam));
    return { error: "invalid_grant" };
  }

  // The claim, on the same guarded-DELETE principle the code path uses: two
  // concurrent rotations both read the row, exactly one deletes it. The loser
  // is a replay by every test we can apply, and is handled as one.
  try {
    const claimed = await db.prepare("DELETE FROM oauth_refresh_tokens WHERE jti = ?1").bind(claims.jti).run();
    if (Number(claimed?.meta?.changes || 0) < 1) {
      await revokeFamily(db, String(row.family_id || fam));
      return { error: "invalid_grant" };
    }
  } catch {
    return { error: "invalid_grant" };
  }

  const userId = String(row.user_id);
  const scope = String(row.scope || "");
  /** @type {{ token: string, jti: string }} */
  let refresh;
  try {
    refresh = await mintRefreshToken(env, {
      userId,
      clientId: opts.clientId,
      scope,
      familyId: String(row.family_id || fam),
      now: nowMs,
    });
  } catch {
    // The old row is already gone, so there is no state to unwind — the client
    // simply has no usable refresh token and re-authorizes. Better than
    // handing back a successor whose row was never written, which would fail
    // on its next use and be read as a replay.
    return { error: "invalid_grant" };
  }
  return { userId, scope, refresh };
}

/**
 * Kill every live token descended from one authorization. Swallows failures:
 * the caller is already refusing the request, and a revocation that could not
 * be written must not turn into a 500 that tells the presenter something.
 * @param {D1Database} db @param {string} familyId
 * @returns {Promise<void>}
 */
async function revokeFamily(db, familyId) {
  await db
    .prepare("DELETE FROM oauth_refresh_tokens WHERE family_id = ?1")
    .bind(String(familyId))
    .run()
    .catch(() => null);
}
