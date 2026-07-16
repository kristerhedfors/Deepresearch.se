// The Se/rver token's security-critical JWT half (src/server-token.js):
// mint→verify round-trip, the standard-JWT wire shape, the canonical-header
// pin (alg:none / alg-swap / re-serialization all rejected), claim
// validation incl. the CLOSED permission vocabulary, expiry, tamper
// rejection, fail-closed no-secret behavior — and the cross-family forgery
// matrix against the legacy token families (wsk1 / prg1 / prx1) that share
// the same SESSION_SECRET.
import test from "node:test";
import assert from "node:assert/strict";
import { SERVER_TOKEN_ISS, SERVER_TOKEN_SERVICES, mintServerToken, verifyServerToken } from "./server-token.js";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";
import { mintGrantToken, mintProxyToken, verifyGrantToken, verifyProxyToken } from "./proxy-grant.js";

const SECRET = "3f8ab5da9aab9d62f8a311109ded0a2d4e838e1c1c7c65fef7b784c9623ee113";
const env = { SESSION_SECRET: SECRET };
const nowS = Math.floor(Date.now() / 1000);
const claims = () => ({ sub: "42", jti: "jti-1", perms: ["web", "api"], iat: nowS, exp: nowS + 3600 });

const b64urlJson = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

test("mint → verify round-trip preserves the claims", async () => {
  const token = await mintServerToken(env, claims());
  const v = await verifyServerToken(env, token);
  assert.ok(v);
  assert.equal(v.iss, SERVER_TOKEN_ISS);
  assert.equal(v.sub, "42");
  assert.equal(v.jti, "jti-1");
  assert.deepEqual(v.perms, ["web", "api"]);
  assert.equal(v.exp, nowS + 3600);
});

test("the wire format is a standard three-segment JWT with the canonical HS256 header", async () => {
  const token = await mintServerToken(env, claims());
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(b64urlJson(parts[0]));
  assert.deepEqual(header, { alg: "HS256", typ: "JWT" });
  // The payload is plainly inspectable (transparency): standard base64url JSON.
  const payload = JSON.parse(b64urlJson(parts[1]));
  assert.equal(payload.iss, SERVER_TOKEN_ISS);
  assert.deepEqual(payload.perms, ["web", "api"]);
});

test("the permission vocabulary is CLOSED: unknown perms dropped at mint and verify; none left → rejected", async () => {
  // Mint drops the unknown value — no token ever leaves claiming it.
  const t1 = await mintServerToken(env, { ...claims(), perms: ["web", "projects"] });
  const v1 = await verifyServerToken(env, t1);
  assert.deepEqual(v1.perms, ["web"]);
  // A (hypothetically forged-with-the-key) token with only unknown perms
  // verifies to nothing.
  const t2 = await mintServerToken(env, { ...claims(), perms: ["chats", "projects"] });
  assert.equal(await verifyServerToken(env, t2), null);
  // The vocabulary itself names upstream services only.
  assert.deepEqual(SERVER_TOKEN_SERVICES, ["web", "api"]);
});

test("expired tokens are rejected (injectable clock)", async () => {
  const token = await mintServerToken(env, claims());
  assert.ok(await verifyServerToken(env, token, (nowS + 3599) * 1000));
  assert.equal(await verifyServerToken(env, token, (nowS + 3600) * 1000), null);
});

test("tampered payload or signature is rejected", async () => {
  const token = await mintServerToken(env, claims());
  const [h, p, s] = token.split(".");
  // Payload swap: claim a different jti under the old signature.
  const forged = Buffer.from(JSON.stringify({ iss: SERVER_TOKEN_ISS, sub: "42", jti: "other", perms: ["web"], iat: nowS, exp: nowS + 3600 }))
    .toString("base64url");
  assert.equal(await verifyServerToken(env, `${h}.${forged}.${s}`), null);
  // Signature bit-flip.
  const flipped = s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  assert.equal(await verifyServerToken(env, `${h}.${p}.${flipped}`), null);
  // Wrong secret.
  assert.equal(await verifyServerToken({ SESSION_SECRET: "other-secret" }, token), null);
});

test("header malleability is rejected: alg none, alg swap, re-serialized header", async () => {
  const token = await mintServerToken(env, claims());
  const [, p, s] = token.split(".");
  for (const header of [
    { alg: "none", typ: "JWT" },
    { alg: "HS512", typ: "JWT" },
    { typ: "JWT", alg: "HS256" }, // same content, different serialization — still not canonical
  ]) {
    const h = Buffer.from(JSON.stringify(header)).toString("base64url");
    assert.equal(await verifyServerToken(env, `${h}.${p}.${s}`), null);
  }
  // An empty signature with alg none never passes either.
  const noneH = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  assert.equal(await verifyServerToken(env, `${noneH}.${p}.`), null);
});

test("claim validation: wrong iss, missing sub/jti, non-array perms all rejected", async () => {
  const mk = async (payload) => {
    const h = (await mintServerToken(env, claims())).split(".")[0];
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Sign properly (same secret) so only the CLAIMS are at test here.
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    return `${h}.${p}.${sig}`;
  };
  const base = { iss: SERVER_TOKEN_ISS, sub: "42", jti: "j", perms: ["web"], iat: nowS, exp: nowS + 60 };
  assert.ok(await verifyServerToken(env, await mk(base)));
  assert.equal(await verifyServerToken(env, await mk({ ...base, iss: "evil.example" })), null);
  assert.equal(await verifyServerToken(env, await mk({ ...base, sub: "" })), null);
  assert.equal(await verifyServerToken(env, await mk({ ...base, jti: 7 })), null);
  assert.equal(await verifyServerToken(env, await mk({ ...base, perms: "web" })), null);
  assert.equal(await verifyServerToken(env, await mk({ ...base, exp: "soon" })), null);
});

test("fails closed without SESSION_SECRET: mint throws, verify returns null", async () => {
  await assert.rejects(() => mintServerToken({}, claims()));
  const token = await mintServerToken(env, claims());
  assert.equal(await verifyServerToken({}, token), null);
});

test("garbage and non-string inputs are rejected", async () => {
  for (const bad of [null, undefined, 42, "", "a.b", "a.b.c.d", "not-a-token", "eyJ.eyJ.sig"]) {
    assert.equal(await verifyServerToken(env, bad), null);
  }
});

// ---- cross-family forgery matrix ----------------------------------------------------
// All token families sign with the SAME SESSION_SECRET; none may verify in
// another's verifier (the workspace-grants discipline, extended to the JWT).

test("legacy family tokens never verify as Se/rver tokens, and vice versa", async () => {
  const wsk = await mintWebSearchToken(env, { jti: "j", uid: "42", quota: 5, iat: nowS, exp: nowS + 3600 });
  const prg = await mintGrantToken(env, { jti: "j", uid: "42", svc: "web", quota: 5, iat: nowS, exp: nowS + 3600 });
  const prx = await mintProxyToken(env, { jti: "j", uid: "42", svc: "api", quota: 5, iat: nowS, exp: nowS + 3600 });
  const jwt = await mintServerToken(env, claims());

  for (const foreign of [wsk, prg, prx]) {
    assert.equal(await verifyServerToken(env, foreign), null);
  }
  assert.equal(await verifyWebSearchToken(env, jwt), null);
  assert.equal(await verifyGrantToken(env, jwt), null);
  assert.equal(await verifyProxyToken(env, jwt), null);

  // Prefix/segment swaps between families don't verify either.
  const [, p, s] = jwt.split(".");
  assert.equal(await verifyWebSearchToken(env, `wsk1.${p}.${s}`), null);
  const [, wp, ws] = wsk.split(".");
  const h = jwt.split(".")[0];
  assert.equal(await verifyServerToken(env, `${h}.${wp}.${ws}`), null);
});
