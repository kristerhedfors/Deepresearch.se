// Web-search grant token: HMAC-signed with SESSION_SECRET under an independent
// `websearch.` namespace. The properties exercised: a minted token round-trips
// its claims; a tampered payload/signature is rejected; rotating SESSION_SECRET
// invalidates it; an expired token verifies as null; a session-cookie-style
// HMAC can never be replayed as a grant token (namespace separation).
import test from "node:test";
import assert from "node:assert/strict";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const OTHER = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const env = { SESSION_SECRET: SECRET };

const now = 1_700_000_000_000; // fixed clock (ms)
const claims = () => ({ jti: "grant-abc", uid: "42", quota: 25, iat: now / 1000, exp: now / 1000 + 3600 });

test("mint → verify round-trips the claims", async () => {
  const token = await mintWebSearchToken(env, claims());
  const out = await verifyWebSearchToken(env, token, now);
  assert.equal(out?.jti, "grant-abc");
  assert.equal(out?.uid, "42");
  assert.equal(out?.quota, 25);
});

test("wrong SESSION_SECRET rejects", async () => {
  const token = await mintWebSearchToken(env, claims());
  assert.equal(await verifyWebSearchToken({ SESSION_SECRET: OTHER }, token, now), null);
});

test("no SESSION_SECRET → null (fail closed)", async () => {
  const token = await mintWebSearchToken(env, claims());
  assert.equal(await verifyWebSearchToken({}, token, now), null);
});

test("tampered signature rejected", async () => {
  const token = await mintWebSearchToken(env, claims());
  const tampered = token.slice(0, -4) + "0000";
  assert.equal(await verifyWebSearchToken(env, tampered, now), null);
});

test("tampered payload (raise quota) rejected", async () => {
  const token = await mintWebSearchToken(env, claims());
  const [prefix, payload, sig] = token.split(".");
  // Flip a character in the payload — the signature no longer matches.
  const forged = `${prefix}.${payload.slice(0, -2)}XY.${sig}`;
  assert.equal(await verifyWebSearchToken(env, forged, now), null);
});

test("expired token verifies as null", async () => {
  const token = await mintWebSearchToken(env, { ...claims(), exp: now / 1000 - 1 });
  assert.equal(await verifyWebSearchToken(env, token, now), null);
});

test("malformed tokens are rejected, never thrown", async () => {
  for (const bad of ["", "not-a-token", "wsk1.only-two", "wsk1..", "x.y.z", 123, null]) {
    assert.equal(await verifyWebSearchToken(env, /** @type {any} */ (bad), now), null);
  }
});

test("a value signed under a different namespace does not verify as a grant", async () => {
  // The namespace is baked into the signature (`websearch.<payload>`), so even a
  // correctly-SESSION_SECRET-signed blob from another subsystem can't be a grant.
  const token = await mintWebSearchToken(env, claims());
  const [, payload] = token.split(".");
  // Sign the SAME payload without the namespace prefix (what a naive HMAC would
  // produce) and splice it in — must fail.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const rawSig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.equal(await verifyWebSearchToken(env, `wsk1.${payload}.${rawSig}`, now), null);
});
