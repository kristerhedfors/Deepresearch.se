// The pool token's security-critical half (src/pool-token.js): mint→verify
// round-trip, the pt1 wire shape, claim validation (jti/pool/sub required),
// expiry, tamper rejection, fail-closed no-secret behavior, the cross-family
// forgery matrix against every other family sharing SESSION_SECRET (wsk1 /
// prg1 / prx1 / the Se/rver JWT), and the admin boundary (a pool token is
// never a login).
import test from "node:test";
import assert from "node:assert/strict";
import { POOL_TOKEN_PREFIX, mintPoolToken, verifyPoolToken } from "./pool-token.js";
import { mintServerToken, verifyServerToken } from "./server-token.js";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";
import { mintGrantToken, mintProxyToken, verifyGrantToken, verifyProxyToken } from "./proxy-grant.js";
import { identify } from "./auth.js";

const SECRET = "3f8ab5da9aab9d62f8a311109ded0a2d4e838e1c1c7c65fef7b784c9623ee113";
const env = { SESSION_SECRET: SECRET };
const nowS = Math.floor(Date.now() / 1000);
const claims = () => ({ jti: "jti-1", pool: "42", sub: "42", iat: nowS, exp: nowS + 3600 });

const b64urlJson = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

test("mint → verify round-trip preserves the claims", async () => {
  const token = await mintPoolToken(env, claims());
  const v = await verifyPoolToken(env, token);
  assert.ok(v);
  assert.equal(v.jti, "jti-1");
  assert.equal(v.pool, "42");
  assert.equal(v.sub, "42");
  assert.equal(v.exp, nowS + 3600);
});

test("the wire format is pt1.<payload>.<sig> and the payload is inspectable base64url JSON", async () => {
  const token = await mintPoolToken(env, claims());
  assert.ok(token.startsWith(POOL_TOKEN_PREFIX));
  const parts = token.split(".");
  // pt1 . payload . sig  → four dot-split parts (the prefix keeps its dot)
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "pt1");
  const payload = JSON.parse(b64urlJson(parts[1]));
  assert.equal(payload.pool, "42");
  assert.equal(payload.jti, "jti-1");
});

test("expired tokens are rejected (injectable clock)", async () => {
  const token = await mintPoolToken(env, claims());
  assert.ok(await verifyPoolToken(env, token, (nowS + 3599) * 1000));
  assert.equal(await verifyPoolToken(env, token, (nowS + 3600) * 1000), null);
});

test("tampered payload or signature is rejected", async () => {
  const token = await mintPoolToken(env, claims());
  const rest = token.slice(POOL_TOKEN_PREFIX.length);
  const [p, s] = rest.split(".");
  // Payload swap: claim a different pool under the old signature.
  const forged = Buffer.from(JSON.stringify({ jti: "jti-1", pool: "victim", sub: "42", iat: nowS, exp: nowS + 3600 }))
    .toString("base64url");
  assert.equal(await verifyPoolToken(env, `${POOL_TOKEN_PREFIX}${forged}.${s}`), null);
  // Signature bit-flip.
  const flipped = s.slice(0, -1) + (s.endsWith("a") ? "b" : "a");
  assert.equal(await verifyPoolToken(env, `${POOL_TOKEN_PREFIX}${p}.${flipped}`), null);
  // Wrong secret.
  assert.equal(await verifyPoolToken({ SESSION_SECRET: "other-secret" }, token), null);
});

test("claim validation: missing jti/pool/sub or non-numeric exp all rejected", async () => {
  const mk = async (payload) => {
    const { createHmac } = await import("node:crypto");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", SECRET).update("pool." + p).digest("hex");
    return `${POOL_TOKEN_PREFIX}${p}.${sig}`;
  };
  const base = { jti: "j", pool: "42", sub: "42", iat: nowS, exp: nowS + 60 };
  assert.ok(await verifyPoolToken(env, await mk(base)));
  assert.equal(await verifyPoolToken(env, await mk({ ...base, jti: "" })), null);
  assert.equal(await verifyPoolToken(env, await mk({ ...base, pool: "" })), null);
  assert.equal(await verifyPoolToken(env, await mk({ ...base, sub: "" })), null);
  assert.equal(await verifyPoolToken(env, await mk({ ...base, exp: "soon" })), null);
});

test("fails closed without SESSION_SECRET: mint throws, verify returns null", async () => {
  await assert.rejects(() => mintPoolToken({}, claims()));
  const token = await mintPoolToken(env, claims());
  assert.equal(await verifyPoolToken({}, token), null);
});

test("garbage and non-string inputs are rejected", async () => {
  for (const bad of [null, undefined, 42, "", "pt1.", "pt1.abc", "a.b.c", "not-a-token", "wsk1.x.y"]) {
    assert.equal(await verifyPoolToken(env, bad), null);
  }
});

// ---- cross-family forgery matrix ----------------------------------------------------
// Every token family signs with the SAME SESSION_SECRET; none may verify in
// another's verifier.

test("pool tokens never verify as another family, and vice versa", async () => {
  const pool = await mintPoolToken(env, claims());
  const wsk = await mintWebSearchToken(env, { jti: "j", uid: "42", quota: 5, iat: nowS, exp: nowS + 3600 });
  const prg = await mintGrantToken(env, { jti: "j", uid: "42", svc: "web", quota: 5, iat: nowS, exp: nowS + 3600 });
  const prx = await mintProxyToken(env, { jti: "j", uid: "42", svc: "api", quota: 5, iat: nowS, exp: nowS + 3600 });
  const jwt = await mintServerToken(env, { sub: "42", jti: "j", perms: ["api"], iat: nowS, exp: nowS + 3600 });

  // A pool token verifies in NO other family's verifier.
  assert.equal(await verifyWebSearchToken(env, pool), null);
  assert.equal(await verifyGrantToken(env, pool), null);
  assert.equal(await verifyProxyToken(env, pool), null);
  assert.equal(await verifyServerToken(env, pool), null);

  // No other family's token verifies as a pool token.
  for (const foreign of [wsk, prg, prx, jwt]) {
    assert.equal(await verifyPoolToken(env, foreign), null);
  }
});

// ---- the admin boundary --------------------------------------------------------------
// A pool token is never a login: identify() (src/auth.js) — the site's single
// identity gate — can never be satisfied by one, so /admin and every
// /api/admin/* route are out of reach with a pool token by construction.

test("a pool token is NOT a login: identify() rejects it in cookie and Authorization positions", async () => {
  const authedEnv = { SESSION_SECRET: SECRET, BASIC_AUTH_USER: "op", BASIC_AUTH_PASS: "hunter2-hunter2" };
  const pool = await mintPoolToken(authedEnv, claims());
  for (const headers of [
    { cookie: `dr_session=${pool}` },
    { cookie: `dr_session=u.${pool}` },
    { authorization: `Bearer ${pool}` },
    { authorization: `Basic ${Buffer.from(`op:${pool}`).toString("base64")}` },
  ]) {
    const req = new Request("https://x/api/admin/pool", { headers });
    assert.equal(await identify(req, authedEnv), null);
  }
});
