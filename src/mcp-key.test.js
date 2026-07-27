// The MCP key's security-critical half (src/mcp-key.js): mint→verify
// round-trip, wire shape, expiry, tamper rejection, fail-closed behaviour with
// no secret — plus the two structural claims the module's scope note makes and
// this suite pins:
//
//   1. AN MCP KEY IS NOT A LOGIN. src/auth.js's identify() must reject one in
//      every position a caller could put it (Bearer, Basic, cookie), so /admin
//      and every data-bearing /api/* route stay out of reach by construction.
//   2. IT IS UNFORGEABLE ACROSS FAMILIES. Every signed-token family here
//      shares the single SESSION_SECRET, so a token from one must never verify
//      in another — in either direction.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MCP_KEY_PREFIX,
  bearerToken,
  keyHint,
  looksLikeMcpKey,
  mintMcpKey,
  newJti,
  verifyMcpKey,
} from "./mcp-key.js";
import { mintServerToken, verifyServerToken } from "./server-token.js";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";
import { mintGrantToken, verifyGrantToken } from "./proxy-grant.js";
import { identify } from "./auth.js";

const SECRET = "b1c0f2e7d4a3968512bb7fd0e4c9a1783c6d5e2f0a9b8c7d6e5f4a3b2c1d0e9f";
const env = { SESSION_SECRET: SECRET };

test("mint → verify round-trip preserves the claims", async () => {
  const { token, jti, exp } = await mintMcpKey(env, 42);
  const claims = await verifyMcpKey(env, token);
  assert.ok(claims);
  assert.equal(claims.v, 1);
  assert.equal(claims.sub, "42");
  assert.equal(claims.jti, jti);
  assert.equal(claims.exp, exp);
  assert.ok(claims.exp > claims.iat);
});

test("the wire format is mck1.<payload>.<hex sig> — one dot-free payload segment", async () => {
  const { token } = await mintMcpKey(env, 7);
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], MCP_KEY_PREFIX);
  assert.match(parts[1], /^[A-Za-z0-9_-]+$/);
  assert.match(parts[2], /^[0-9a-f]{64}$/);
  assert.ok(looksLikeMcpKey(token));
});

test("two mints for the same account are different keys (fresh jti each time)", async () => {
  const a = await mintMcpKey(env, 42);
  const b = await mintMcpKey(env, 42);
  assert.notEqual(a.jti, b.jti);
  assert.notEqual(a.token, b.token);
  // Both verify as TOKENS — it is the account's stored jti (checked in
  // src/mcp-api.js) that decides which one is still live. That split is what
  // makes rotation instant without a schema.
  assert.ok(await verifyMcpKey(env, a.token));
  assert.ok(await verifyMcpKey(env, b.token));
});

test("newJti is unguessable and unique", () => {
  const seen = new Set(Array.from({ length: 200 }, () => newJti()));
  assert.equal(seen.size, 200);
  for (const jti of seen) assert.ok(jti.length >= 20);
});

test("an expired key is rejected", async () => {
  const { token } = await mintMcpKey(env, 1, { ttlS: 60 });
  assert.ok(await verifyMcpKey(env, token));
  assert.equal(await verifyMcpKey(env, token, Date.now() + 61_000), null);
});

test("tampering with the payload is rejected", async () => {
  const { token } = await mintMcpKey(env, 1);
  const [prefix, payload, sig] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims.sub = "999"; // act as someone else
  const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
  assert.equal(await verifyMcpKey(env, `${prefix}.${forged}.${sig}`), null);
});

test("a wrong prefix, wrong signature or malformed shape is rejected", async () => {
  const { token } = await mintMcpKey(env, 1);
  const [, payload, sig] = token.split(".");
  const bad = [
    `mck2.${payload}.${sig}`,
    `${MCP_KEY_PREFIX}.${payload}.${"0".repeat(64)}`,
    `${MCP_KEY_PREFIX}.${payload}`,
    `${MCP_KEY_PREFIX}..${sig}`,
    "",
    null,
    undefined,
    "not-a-token",
  ];
  for (const t of bad) assert.equal(await verifyMcpKey(env, t), null, `should reject ${t}`);
});

test("a key minted under one secret does not verify under another", async () => {
  const { token } = await mintMcpKey(env, 1);
  assert.equal(await verifyMcpKey({ SESSION_SECRET: "a-different-secret" }, token), null);
});

test("fail closed: no SESSION_SECRET means no verification", async () => {
  const { token } = await mintMcpKey(env, 1);
  assert.equal(await verifyMcpKey({}, token), null);
  await assert.rejects(() => mintMcpKey({}, 1));
});

test("bearerToken reads only an Authorization: Bearer header", () => {
  const req = (headers) => new Request("https://mcp.deepresearch.se/mcp", { method: "POST", headers });
  assert.equal(bearerToken(req({ authorization: "Bearer mck1.abc.def" })), "mck1.abc.def");
  assert.equal(bearerToken(req({ authorization: "bearer mck1.abc.def" })), "mck1.abc.def");
  assert.equal(bearerToken(req({ authorization: "Basic dXNlcjpwYXNz" })), null);
  assert.equal(bearerToken(req({})), null);
  assert.equal(bearerToken(req({ authorization: "Bearer   " })), null);
});

test("keyHint is a short non-secret tail", async () => {
  const { token, hint } = await mintMcpKey(env, 1);
  assert.equal(hint.length, 6);
  assert.equal(keyHint(token), token.slice(-6));
  assert.ok(!token.startsWith(hint));
});

// ---------------------------------------------------------------------------
// Structural claim 1: an MCP key is NEVER a login (src/mcp-key.js scope note).
// ---------------------------------------------------------------------------

test("identify() rejects an MCP key in every position — it can never be a login", async () => {
  const { token } = await mintMcpKey(env, 42);
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

// ---------------------------------------------------------------------------
// Structural claim 2: cross-family unforgeability under the one shared key.
// ---------------------------------------------------------------------------

test("no other token family's token verifies as an MCP key", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const foreign = [
    await mintServerToken(env, { sub: "42", jti: "j", perms: ["web"], iat: nowS, exp: nowS + 3600 }),
    await mintWebSearchToken(env, { uid: "42", jti: "j", exp: nowS + 3600 }),
    await mintGrantToken(env, { uid: "42", jti: "j", svc: "web", exp: nowS + 3600 }),
  ];
  for (const token of foreign) assert.equal(await verifyMcpKey(env, token), null);
});

test("an MCP key does not verify in any other token family", async () => {
  const { token } = await mintMcpKey(env, 42);
  assert.equal(await verifyServerToken(env, token), null);
  assert.equal(await verifyWebSearchToken(env, token), null);
  assert.equal(await verifyGrantToken(env, token), null);
});
