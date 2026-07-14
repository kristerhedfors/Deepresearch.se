// The secure-research-space two-tier token half (src/proxy-grant.js): the
// grant→proxy mint/verify round-trips, the namespace separation that keeps the
// two tiers (and websearch/session tokens) from being confused, and the
// SESSION_SECRET / expiry / tamper rejections. Pure crypto over WebCrypto (a
// Node global), so this runs unmodified.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mintGrantToken,
  mintProxyToken,
  verifyGrantToken,
  verifyProxyToken,
} from "./proxy-grant.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const env = { SESSION_SECRET: SECRET };
const now = Math.floor(Date.now() / 1000);
const claims = (over = {}) => ({ jti: "j1", uid: "42", svc: "api", quota: 40, iat: now, exp: now + 3600, ...over });

test("grant token round-trips its claims", async () => {
  const tok = await mintGrantToken(env, claims());
  assert.ok(tok.startsWith("prg1."));
  const out = await verifyGrantToken(env, tok);
  assert.deepEqual(out, claims());
});

test("proxy token round-trips its claims", async () => {
  const tok = await mintProxyToken(env, claims({ svc: "web", quota: 25 }));
  assert.ok(tok.startsWith("prx1."));
  const out = await verifyProxyToken(env, tok);
  assert.equal(out.svc, "web");
  assert.equal(out.quota, 25);
});

test("the two tiers cannot be confused (namespace separation)", async () => {
  const grant = await mintGrantToken(env, claims());
  const proxy = await mintProxyToken(env, claims());
  // A grant token never verifies as a proxy token, and vice versa — even though
  // the claims are identical, the prefix + HMAC namespace differ.
  assert.equal(await verifyProxyToken(env, grant), null);
  assert.equal(await verifyGrantToken(env, proxy), null);
});

test("a token signed with a different secret is rejected", async () => {
  const tok = await mintGrantToken(env, claims());
  assert.equal(await verifyGrantToken({ SESSION_SECRET: "other-secret" }, tok), null);
});

test("an expired token is rejected", async () => {
  const tok = await mintProxyToken(env, claims({ exp: now - 1 }));
  assert.equal(await verifyProxyToken(env, tok), null);
});

test("a tampered payload is rejected", async () => {
  const tok = await mintGrantToken(env, claims());
  const [p, payload, sig] = tok.split(".");
  // Re-encode a payload claiming a bigger quota, keep the old signature.
  const forged = Buffer.from(JSON.stringify(claims({ quota: 999999 }))).toString("base64url");
  assert.equal(await verifyGrantToken(env, `${p}.${forged}.${sig}`), null);
});

test("a bad shape / wrong service is rejected", async () => {
  assert.equal(await verifyGrantToken(env, "garbage"), null);
  assert.equal(await verifyGrantToken(env, "prg1.only-two"), null);
  const badSvc = await mintGrantToken(env, /** @type {any} */ (claims({ svc: "email" })));
  assert.equal(await verifyGrantToken(env, badSvc), null);
});

test("without SESSION_SECRET, verify fails closed", async () => {
  const tok = await mintGrantToken(env, claims());
  assert.equal(await verifyGrantToken({}, tok), null);
});
