// The OAuth token families (src/oauth-store.js). The suite is written around
// the four things a signature alone cannot give us, because those are the ones
// that break silently:
//
//   1. SINGLE USE. A code redeems once. The second attempt fails even though
//      its signature is still perfect, and two SIMULTANEOUS redemptions
//      produce exactly one winner — the guarded DELETE, not SELECT-then-DELETE.
//   2. PKCE S256. A wrong verifier, a missing verifier and a `plain`-style
//      challenge all fail, and a wrong verifier BURNS the code (one guess per
//      code, never a brute-force loop).
//   3. ROTATION AND REUSE. The old jti dies in the call that mints its
//      successor, and a replayed token takes the whole family down with it.
//   4. FAMILY SEPARATION. Every family here shares the one SESSION_SECRET, so
//      a token of one must not verify as another — in both directions,
//      including the relabelled-prefix forgery that is the only test the
//      namespace itself has to pass. And an `oat1.` access token is never a
//      login: src/auth.js's identify() refuses it in every position.
//
// The D1 fake is the shared one (src/test-helpers/d1.js) with row rules that
// actually keep state, because "the row is the authority" is the property
// under test — a fake that answers every DELETE with changes=1 would pass
// every single-use test while the real thing let a code redeem twice.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_CODE_TTL_S,
  ACCESS_TOKEN_TTL_S,
  OAUTH_ACCESS_PREFIX,
  OAUTH_CODE_PREFIX,
  OAUTH_REFRESH_PREFIX,
  OAUTH_SCHEMA_SQL,
  REFRESH_TOKEN_TTL_S,
  mintAccessToken,
  mintAuthCode,
  mintRefreshToken,
  redeemAuthCode,
  rotateRefreshToken,
  s256Challenge,
  verifyAccessToken,
} from "./oauth-store.js";
import { splitStatements } from "./db.js";
import { fakeD1 } from "./test-helpers/d1.js";
import { identify } from "./auth.js";
import { mintMcpKey, verifyMcpKey } from "./mcp-key.js";
import { mintServerToken, verifyServerToken } from "./server-token.js";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";
import { mintGrantToken, verifyGrantToken } from "./proxy-grant.js";

const SECRET = "3f9a1c7e05b28d64ff1e9a3c7b5d0e28419c6f8a2d3b5e7091c4a6f8b2d4e6f8";

const CLIENT = "https://claude.ai/.well-known/oauth-client";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
// 43 characters from the RFC 7636 unreserved set.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

/**
 * A D1 fake that really stores rows, so single use and rotation mean what they
 * mean in production: the DELETE reports changes only when it removed
 * something, which is the whole mechanism.
 */
function oauthDb() {
  /** @type {Map<string, any>} */
  const codes = new Map();
  /** @type {Map<string, any>} */
  const refresh = new Map();
  const db = fakeD1();

  db.onQuery(/^INSERT INTO oauth_codes/, (b) => {
    codes.set(String(b[0]), {
      jti: b[0], user_id: b[1], client_id: b[2], redirect_uri: b[3],
      code_challenge: b[4], scope: b[5], created_at: b[6], expires_at: b[7],
    });
    return [];
  });
  db.onQuery(/^SELECT .* FROM oauth_codes WHERE jti/, (b) => codes.get(String(b[0])) || []);
  db.onQuery(/^DELETE FROM oauth_codes WHERE jti/, (b) => (codes.delete(String(b[0])) ? [{}] : []));
  db.onQuery(/^DELETE FROM oauth_codes WHERE expires_at/, (b) => expire(codes, Number(b[0])));

  db.onQuery(/^INSERT INTO oauth_refresh_tokens/, (b) => {
    refresh.set(String(b[0]), {
      jti: b[0], family_id: b[1], user_id: b[2], client_id: b[3],
      scope: b[4], created_at: b[5], expires_at: b[6],
    });
    return [];
  });
  db.onQuery(/^SELECT .* FROM oauth_refresh_tokens WHERE jti/, (b) => refresh.get(String(b[0])) || []);
  db.onQuery(/^DELETE FROM oauth_refresh_tokens WHERE jti/, (b) => (refresh.delete(String(b[0])) ? [{}] : []));
  db.onQuery(/^DELETE FROM oauth_refresh_tokens WHERE family_id/, (b) => {
    const gone = [];
    for (const [k, r] of refresh) if (String(r.family_id) === String(b[0])) { refresh.delete(k); gone.push({}); }
    return gone;
  });
  db.onQuery(/^DELETE FROM oauth_refresh_tokens WHERE expires_at/, (b) => expire(refresh, Number(b[0])));

  return Object.assign(db, { codes, refresh });
}

/** @param {Map<string, any>} table @param {number} cutoff */
function expire(table, cutoff) {
  const gone = [];
  for (const [k, r] of table) if (Number(r.expires_at) <= cutoff) { table.delete(k); gone.push({}); }
  return gone;
}

const envWith = (db) => ({ SESSION_SECRET: SECRET, DB: db });
const noDbEnv = { SESSION_SECRET: SECRET };

/** Mint a code for the standard client with a real S256 challenge. */
async function issueCode(env, over = {}) {
  return mintAuthCode(env, {
    userId: "42",
    clientId: CLIENT,
    redirectUri: REDIRECT,
    codeChallenge: await s256Challenge(VERIFIER),
    scope: "research offline_access",
    ...over,
  });
}

const redeemWith = (over = {}) => ({
  clientId: CLIENT,
  redirectUri: REDIRECT,
  codeVerifier: VERIFIER,
  ...over,
});

// ---------------------------------------------------------------------------
// PKCE — the transformation itself
// ---------------------------------------------------------------------------

test("s256Challenge matches the RFC 7636 Appendix B known answer", async () => {
  assert.equal(
    await s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  // base64url: no padding, no + or /.
  assert.match(await s256Challenge("x".repeat(43)), /^[A-Za-z0-9_-]{43}$/);
});

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

test("mint → redeem returns the account and scope recorded at authorization", async () => {
  const env = envWith(oauthDb());
  const { code, jti, exp } = await issueCode(env);
  assert.ok(jti);
  assert.equal(exp - Math.floor(Date.now() / 1000) <= AUTH_CODE_TTL_S, true);
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith()), {
    userId: "42",
    scope: "research offline_access",
  });
});

test("the wire format is oac1.<payload>.<hex sig>", async () => {
  const { code } = await issueCode(envWith(oauthDb()));
  const parts = code.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], OAUTH_CODE_PREFIX);
  assert.match(parts[1], /^[A-Za-z0-9_-]+$/);
  assert.match(parts[2], /^[0-9a-f]{64}$/);
});

test("the code discloses NOTHING but its own id — the user, scope and redirect stay in the row", async () => {
  // The user id is deliberately NOT the "42" the rest of this file uses. The
  // sweep below substring-searches the payload, which also carries two 10-digit
  // unix timestamps — and roughly a third of all seconds contain "42", so the
  // sentinel used to make this test fail on the clock rather than on a leak.
  // A sentinel that cannot occur by accident is the fix; weakening the sweep
  // would have been the wrong one, since a substring search over the whole
  // payload is exactly what catches a claim nobody thought to enumerate.
  const userId = "user-oac-sentinel";
  const { code, jti } = await issueCode(envWith(oauthDb()), { userId });
  const payload = Buffer.from(code.split(".")[1], "base64url").toString("utf8");
  const claims = JSON.parse(payload);
  assert.deepEqual(Object.keys(claims).sort(), ["exp", "iat", "jti", "v"]);
  assert.equal(claims.jti, jti);
  for (const secret of [userId, REDIRECT, CLIENT, "research"]) {
    assert.equal(payload.includes(secret), false, `a code in a URL must not carry ${secret}`);
  }
});

test("SINGLE USE: the second redemption fails though the signature is still perfect", async () => {
  const env = envWith(oauthDb());
  const { code } = await issueCode(env);
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith()), { userId: "42", scope: "research offline_access" });
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith()), { error: "invalid_grant" });
});

test("two simultaneous redemptions produce exactly one winner", async () => {
  const env = envWith(oauthDb());
  const { code } = await issueCode(env);
  const results = await Promise.all([
    redeemAuthCode(env, code, redeemWith()),
    redeemAuthCode(env, code, redeemWith()),
  ]);
  const winners = results.filter((r) => "userId" in r);
  const losers = results.filter((r) => "error" in r);
  assert.equal(winners.length, 1, "the guarded DELETE must decide, not a prior SELECT");
  assert.deepEqual(losers, [{ error: "invalid_grant" }]);
});

test("an expired code is refused", async () => {
  const env = envWith(oauthDb());
  const { code } = await issueCode(env);
  const late = Date.now() + (AUTH_CODE_TTL_S + 1) * 1000;
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith({ now: late })), { error: "invalid_grant" });
});

test("a wrong PKCE verifier fails — and burns the code, so there is one guess and no more", async () => {
  const env = envWith(oauthDb());
  const { code } = await issueCode(env);
  const wrong = "a".repeat(43);
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith({ codeVerifier: wrong })), { error: "invalid_grant" });
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith()), { error: "invalid_grant" });
});

test("a missing or malformed verifier is invalid_request — and does NOT burn the code", async () => {
  const env = envWith(oauthDb());
  const { code } = await issueCode(env);
  for (const bad of [undefined, null, "", "short", "x".repeat(129), "has spaces in it".padEnd(50, "x")]) {
    assert.deepEqual(
      await redeemAuthCode(env, code, redeemWith({ codeVerifier: bad })),
      { error: "invalid_request" },
      `should refuse verifier ${JSON.stringify(bad)}`,
    );
  }
  // The caller's own malformed retry must not have cost its user the flow.
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith()), { userId: "42", scope: "research offline_access" });
});

test("a `plain` challenge can never be redeemed — S256 is the only transformation", async () => {
  const env = envWith(oauthDb());
  // A plain-method client sends the verifier itself as the challenge. It is
  // 43 base64url characters, so it passes the shape check at mint and then
  // fails forever, because no verifier hashes to itself.
  const { code } = await issueCode(env, { codeChallenge: VERIFIER });
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith()), { error: "invalid_grant" });
});

test("a challenge that is not an S256 digest is refused at mint — no PKCE-less code can exist", async () => {
  const env = envWith(oauthDb());
  for (const bad of [undefined, "", "too-short", "x".repeat(44), "has.dots~and~tildes.in.it.padded.out.to.43ch"]) {
    await assert.rejects(() => issueCode(env, { codeChallenge: bad }), `should refuse challenge ${bad}`);
  }
});

test("client_id and redirect_uri must match what was recorded at authorization", async () => {
  const env = envWith(oauthDb());
  const a = await issueCode(env);
  assert.deepEqual(
    await redeemAuthCode(env, a.code, redeemWith({ clientId: "https://evil.example/client" })),
    { error: "invalid_grant" },
  );
  const b = await issueCode(env);
  assert.deepEqual(
    await redeemAuthCode(env, b.code, redeemWith({ redirectUri: "https://evil.example/cb" })),
    { error: "invalid_grant" },
  );
  // A missing one is a malformed request, not a failed grant.
  const c = await issueCode(env);
  assert.deepEqual(await redeemAuthCode(env, c.code, redeemWith({ clientId: "" })), { error: "invalid_request" });
  assert.deepEqual(await redeemAuthCode(env, c.code, redeemWith({ redirectUri: undefined })), { error: "invalid_request" });
});

test("a forged or tampered code never reaches the database", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const { code } = await issueCode(env);
  const [prefix, payload, sig] = code.split(".");
  const otherJti = Buffer.from(JSON.stringify({ v: 1, jti: "stolen", iat: 0, exp: 9e9 })).toString("base64url");
  db.reset();
  const forgeries = [
    `${prefix}.${otherJti}.${sig}`,
    `${prefix}.${payload}.${"0".repeat(64)}`,
    `oac2.${payload}.${sig}`,
    `${prefix}.${payload}`,
    "not-a-code",
    "",
  ];
  for (const forged of forgeries) {
    assert.deepEqual(await redeemAuthCode(env, forged, redeemWith()), {
      error: forged === "" ? "invalid_request" : "invalid_grant",
    });
  }
  assert.equal(db.ran(/oauth_codes/), false, "signature first: a forgery must not be able to probe the table");
});

test("a code minted under one secret does not redeem under another", async () => {
  const db = oauthDb();
  const { code } = await issueCode(envWith(db));
  const other = { SESSION_SECRET: "a-different-secret", DB: db };
  assert.deepEqual(await redeemAuthCode(other, code, redeemWith()), { error: "invalid_grant" });
});

test("expired rows are swept opportunistically on the next mint", async () => {
  const db = oauthDb();
  const env = envWith(db);
  await issueCode(env);
  assert.equal(db.codes.size, 1);
  await issueCode(env, { now: Date.now() + (AUTH_CODE_TTL_S + 1) * 1000 });
  assert.equal(db.codes.size, 1, "the stale row is gone, the fresh one remains");
  assert.ok(db.ran(/DELETE FROM oauth_codes WHERE expires_at/));
});

test("fail closed with no D1: minting throws, redeeming refuses", async () => {
  await assert.rejects(() => issueCode(noDbEnv));
  const { code } = await issueCode(envWith(oauthDb()));
  assert.deepEqual(await redeemAuthCode(noDbEnv, code, redeemWith()), { error: "invalid_grant" });
});

test("a D1 failure refuses the grant rather than throwing", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const { code } = await issueCode(env);
  db.failOn(/SELECT .* FROM oauth_codes/);
  assert.deepEqual(await redeemAuthCode(env, code, redeemWith()), { error: "invalid_grant" });
});

test("`now` is accepted in seconds or milliseconds — a unit mix-up cannot skew a TTL", async () => {
  const env = envWith(oauthDb());
  const ms = Date.now();
  const inMs = await issueCode(env, { now: ms });
  const inS = await issueCode(env, { now: Math.floor(ms / 1000) });
  assert.equal(inMs.exp, inS.exp);
});

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

test("access token: mint → verify round-trip, and no D1 anywhere on that path", async () => {
  const db = oauthDb();
  const env = envWith(db);
  db.reset();
  const { token, exp } = await mintAccessToken(env, { userId: 42, scope: "research" });
  assert.equal(token.split(".")[0], OAUTH_ACCESS_PREFIX);
  const claims = await verifyAccessToken(env, token);
  assert.deepEqual(claims, { sub: "42", scope: "research", exp });
  assert.equal(exp - Math.floor(Date.now() / 1000) <= ACCESS_TOKEN_TTL_S, true);
  assert.equal(db.calls.length, 0, "the hot path must not read or write the database");
  // It works with no DB binding at all — the strongest form of the same claim.
  const { token: t2 } = await mintAccessToken(noDbEnv, { userId: 7 });
  assert.equal((await verifyAccessToken(noDbEnv, t2))?.sub, "7");
});

test("two access tokens for one account are distinct issues", async () => {
  const a = await mintAccessToken(noDbEnv, { userId: 1 });
  const b = await mintAccessToken(noDbEnv, { userId: 1 });
  assert.notEqual(a.token, b.token);
});

test("an expired, tampered, re-signed or malformed access token is null", async () => {
  const { token } = await mintAccessToken(noDbEnv, { userId: 42, scope: "research", ttlS: 60 });
  assert.ok(await verifyAccessToken(noDbEnv, token));
  assert.equal(await verifyAccessToken(noDbEnv, token, Date.now() + 61_000), null);

  const [prefix, payload, sig] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.sub = "1"; // act as someone else
  const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
  for (const bad of [
    `${prefix}.${forged}.${sig}`,
    `${prefix}.${payload}.${"0".repeat(64)}`,
    `oat2.${payload}.${sig}`,
    `${prefix}.${payload}`,
    "",
    null,
    undefined,
  ]) {
    assert.equal(await verifyAccessToken(noDbEnv, bad), null, `should reject ${bad}`);
  }
  assert.equal(await verifyAccessToken({ SESSION_SECRET: "other" }, token), null);
  assert.equal(await verifyAccessToken({}, token), null, "no signing key means no verification");
});

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

test("refresh: mint → rotate hands back a new token and kills the old one in the same call", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const first = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research offline_access" });
  assert.equal(first.token.split(".")[0], OAUTH_REFRESH_PREFIX);
  assert.equal(db.refresh.size, 1);

  const out = await rotateRefreshToken(env, first.token, { clientId: CLIENT });
  assert.equal("error" in out, false);
  const ok = /** @type {any} */ (out);
  assert.equal(ok.userId, "42");
  assert.equal(ok.scope, "research offline_access");
  assert.notEqual(ok.refresh.jti, first.jti);
  assert.equal(db.refresh.size, 1, "exactly one live token per lineage, always");
  assert.equal(db.refresh.has(first.jti), false);
});

test("a lineage rotates as many times as it likes and keeps one family id", async () => {
  const db = oauthDb();
  const env = envWith(db);
  let cur = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });
  const family = db.refresh.get(cur.jti).family_id;
  for (let i = 0; i < 3; i++) {
    const out = /** @type {any} */ (await rotateRefreshToken(env, cur.token, { clientId: CLIENT }));
    assert.equal("error" in out, false, `rotation ${i} should succeed`);
    cur = out.refresh;
    assert.equal(db.refresh.get(cur.jti).family_id, family);
  }
});

test("REUSE IS COMPROMISE: replaying a rotated token revokes the whole family", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const first = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });
  const second = /** @type {any} */ (await rotateRefreshToken(env, first.token, { clientId: CLIENT })).refresh;

  assert.deepEqual(await rotateRefreshToken(env, first.token, { clientId: CLIENT }), { error: "invalid_grant" });
  assert.equal(db.refresh.size, 0, "the successor dies with the replay — the lineage is in two hands");
  assert.deepEqual(await rotateRefreshToken(env, second.token, { clientId: CLIENT }), { error: "invalid_grant" });
});

test("two simultaneous rotations: one winner, and the family is revoked as a replay", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const first = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });
  const results = await Promise.all([
    rotateRefreshToken(env, first.token, { clientId: CLIENT }),
    rotateRefreshToken(env, first.token, { clientId: CLIENT }),
  ]);
  assert.equal(results.filter((r) => !("error" in r)).length, 1);
  assert.deepEqual(results.filter((r) => "error" in r), [{ error: "invalid_grant" }]);
  assert.equal(db.refresh.size, 0, "indistinguishable from a replay, so handled as one");
});

test("a refresh token presented by a different client revokes the family", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const first = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });
  assert.deepEqual(
    await rotateRefreshToken(env, first.token, { clientId: "https://chatgpt.com/other" }),
    { error: "invalid_grant" },
  );
  assert.equal(db.refresh.size, 0);
  assert.deepEqual(await rotateRefreshToken(env, first.token, { clientId: CLIENT }), { error: "invalid_grant" });
});

test("an expired refresh token is refused", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const first = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });
  const late = Date.now() + (REFRESH_TOKEN_TTL_S + 1) * 1000;
  assert.deepEqual(await rotateRefreshToken(env, first.token, { clientId: CLIENT, now: late }), {
    error: "invalid_grant",
  });
});

test("a forged refresh token is refused without touching the database", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const first = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });
  const [prefix, payload, sig] = first.token.split(".");
  db.reset();
  const forged = Buffer.from(JSON.stringify({ v: 1, jti: "x", fam: "y", iat: 0, exp: 9e9 })).toString("base64url");
  for (const bad of [`${prefix}.${forged}.${sig}`, `${prefix}.${payload}.${"0".repeat(64)}`, `ort2.${payload}.${sig}`, "junk"]) {
    assert.deepEqual(await rotateRefreshToken(env, bad, { clientId: CLIENT }), { error: "invalid_grant" });
  }
  assert.equal(db.ran(/oauth_refresh_tokens/), false, "a forgery must not be able to revoke a real family");
  // …and the real lineage is untouched by all that noise.
  assert.equal("error" in (await rotateRefreshToken(env, first.token, { clientId: CLIENT })), false);
});

test("refresh: a missing client_id is invalid_request; no D1 and no throw without a database", async () => {
  const { token } = await mintRefreshToken(envWith(oauthDb()), { userId: "1", clientId: CLIENT });
  assert.deepEqual(await rotateRefreshToken(envWith(oauthDb()), token, {}), { error: "invalid_request" });
  assert.deepEqual(await rotateRefreshToken(noDbEnv, token, { clientId: CLIENT }), { error: "invalid_grant" });
  await assert.rejects(() => mintRefreshToken(noDbEnv, { userId: "1", clientId: CLIENT }));
});

test("a D1 failure during rotation refuses rather than throws", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const first = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });
  db.failOn(/SELECT .* FROM oauth_refresh_tokens/);
  assert.deepEqual(await rotateRefreshToken(env, first.token, { clientId: CLIENT }), { error: "invalid_grant" });
});

// ---------------------------------------------------------------------------
// The schema this exports
// ---------------------------------------------------------------------------

test("OAUTH_SCHEMA_SQL splits into statements db.js can prepare", () => {
  const statements = splitStatements(OAUTH_SCHEMA_SQL);
  assert.equal(statements.length, 6);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX) IF NOT EXISTS/);
  assert.ok(statements.some((s) => /oauth_codes \(/.test(s)));
  assert.ok(statements.some((s) => /oauth_refresh_tokens \(/.test(s)));
});

// ---------------------------------------------------------------------------
// Family separation, and the claim that an access token is never a login
// ---------------------------------------------------------------------------

test("the three OAuth families do not verify as one another, prefix relabelling included", async () => {
  const db = oauthDb();
  const env = envWith(db);
  const { code } = await issueCode(env);
  const { token: access } = await mintAccessToken(env, { userId: "42", scope: "research" });
  const { token: refresh } = await mintRefreshToken(env, { userId: "42", clientId: CLIENT, scope: "research" });

  // As presented: the prefix alone stops each one.
  assert.equal(await verifyAccessToken(env, code), null);
  assert.equal(await verifyAccessToken(env, refresh), null);
  assert.deepEqual(await redeemAuthCode(env, access, redeemWith()), { error: "invalid_grant" });
  assert.deepEqual(await redeemAuthCode(env, refresh, redeemWith()), { error: "invalid_grant" });
  assert.deepEqual(await rotateRefreshToken(env, access, { clientId: CLIENT }), { error: "invalid_grant" });
  assert.deepEqual(await rotateRefreshToken(env, code, { clientId: CLIENT }), { error: "invalid_grant" });

  // Relabelled — the only test the NAMESPACE itself has to pass: same payload,
  // same tag, another family's prefix. It must fail on the tag.
  const relabel = (token, prefix) => `${prefix}.${token.split(".").slice(1).join(".")}`;
  assert.equal(await verifyAccessToken(env, relabel(code, OAUTH_ACCESS_PREFIX)), null);
  assert.equal(await verifyAccessToken(env, relabel(refresh, OAUTH_ACCESS_PREFIX)), null);
  assert.deepEqual(
    await rotateRefreshToken(env, relabel(access, OAUTH_REFRESH_PREFIX), { clientId: CLIENT }),
    { error: "invalid_grant" },
  );
  assert.deepEqual(
    await redeemAuthCode(env, relabel(access, OAUTH_CODE_PREFIX), redeemWith()),
    { error: "invalid_grant" },
  );
});

test("no other token family in the codebase verifies as an OAuth credential", async () => {
  const env = envWith(oauthDb());
  const nowS = Math.floor(Date.now() / 1000);
  const foreign = [
    (await mintMcpKey(env, 42)).token,
    await mintServerToken(env, { sub: "42", jti: "j", perms: ["web"], iat: nowS, exp: nowS + 3600 }),
    await mintWebSearchToken(env, { uid: "42", jti: "j", quota: 5, iat: nowS, exp: nowS + 3600 }),
    await mintGrantToken(env, { uid: "42", jti: "j", svc: "web", exp: nowS + 3600 }),
  ];
  for (const token of foreign) {
    assert.equal(await verifyAccessToken(env, token), null);
    assert.deepEqual(await redeemAuthCode(env, token, redeemWith()), { error: "invalid_grant" });
    assert.deepEqual(await rotateRefreshToken(env, token, { clientId: CLIENT }), { error: "invalid_grant" });
  }
});

test("an OAuth credential does not verify in any other token family", async () => {
  const env = envWith(oauthDb());
  const { code } = await issueCode(env);
  const { token: access } = await mintAccessToken(env, { userId: "42" });
  const { token: refresh } = await mintRefreshToken(env, { userId: "42", clientId: CLIENT });
  for (const token of [code, access, refresh]) {
    assert.equal(await verifyMcpKey(env, token), null);
    assert.equal(await verifyServerToken(env, token), null);
    assert.equal(await verifyWebSearchToken(env, token), null);
    assert.equal(await verifyGrantToken(env, token), null);
  }
});

test("identify() rejects an access token in every position — it can never be a login", async () => {
  const { token } = await mintAccessToken(noDbEnv, { userId: "42", scope: "research offline_access" });
  const authEnv = { SESSION_SECRET: SECRET, ADMIN_USER: "op", ADMIN_PASS: "pw" };
  const url = "https://deepresearch.se/api/admin/users";
  const attempts = [
    { authorization: `Bearer ${token}` },
    { authorization: `Basic ${Buffer.from(`${token}:`).toString("base64")}` },
    { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` },
    { cookie: `dr_session=${token}` },
    { cookie: `dr_session=u.42.9999999999.${token}` },
  ];
  for (const headers of attempts) {
    assert.equal(
      await identify(new Request(url, { headers }), authEnv),
      null,
      `identify() must not accept ${JSON.stringify(headers)}`,
    );
  }
});

test("a session cookie is not an access token either — the reverse direction", async () => {
  const env = envWith(oauthDb());
  // The session cookie's own wire shape, as src/auth.js writes it.
  const cookieish = "u.42.9999999999.deadbeef";
  assert.equal(await verifyAccessToken(env, cookieish), null);
  assert.deepEqual(await redeemAuthCode(env, cookieish, redeemWith()), { error: "invalid_grant" });
  assert.deepEqual(await rotateRefreshToken(env, cookieish, { clientId: CLIENT }), { error: "invalid_grant" });
});
