// The shared HMAC-token crypto primitives (src/token-crypto.js) — the one
// implementation behind auth.js's toHex/safeEqual and the websearch-key.js /
// proxy-grant.js token modules. The properties exercised here: the base64url
// codec round-trips arbitrary bytes without padding chars, toHex renders
// deterministically, safeEqual is exact and type-strict, `sign` is
// namespace-separated, deterministic, and fail-closed without SESSION_SECRET,
// `hmacRaw` is the one tag both renderings are built from, and the mint/verify
// pair `sealedToken` / `verifiedClaims` stops at the cryptography — it renders
// already-assembled claims into the wire shape and hands back an UNVALIDATED
// claims object, rejecting a tag from another namespace in both directions.
// (Each token family's own mint/verify stays covered by websearch-key.test.js
// and proxy-grant.test.js.)
import test from "node:test";
import assert from "node:assert/strict";
import { b64url, b64urlDecode, hmacRaw, toHex, safeEqual, sealedToken, sign, verifiedClaims } from "./token-crypto.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const env = { SESSION_SECRET: SECRET };

test("b64url round-trips arbitrary bytes", () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0]),
    new Uint8Array([255, 254, 253]),
    new Uint8Array(Array.from({ length: 256 }, (_, i) => i)),
    new TextEncoder().encode('{"jti":"abc","quota":25}'),
  ];
  for (const bytes of cases) {
    const enc = b64url(bytes);
    assert.deepEqual([...b64urlDecode(enc)], [...bytes]);
  }
});

test("b64url output is URL-safe (no +, /, or padding)", () => {
  // 0xfb,0xef,0xff encodes to "++//" territory in plain base64; 1-2 byte
  // inputs force padding in plain base64 — none of it may appear here.
  for (const bytes of [new Uint8Array([251, 239, 255]), new Uint8Array([1]), new Uint8Array([1, 2])]) {
    const enc = b64url(bytes);
    assert.doesNotMatch(enc, /[+/=]/);
  }
});

test("toHex renders bytes as lowercase zero-padded hex", () => {
  assert.equal(toHex(new Uint8Array([0, 1, 15, 16, 255]).buffer), "00010f10ff");
  assert.equal(toHex(new Uint8Array([]).buffer), "");
});

test("safeEqual: equal strings only, type- and length-strict", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual(123, 123), false); // non-strings never compare equal
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual(undefined, undefined), false);
});

test("sign is deterministic and namespace-separated", async () => {
  const a1 = await sign(env, "websearch.", "payload");
  const a2 = await sign(env, "websearch.", "payload");
  assert.equal(a1, a2);
  assert.match(a1, /^[0-9a-f]{64}$/); // hex HMAC-SHA-256
  // The namespace is part of the signed message: same payload, different
  // namespace → different tag. This is what keeps the token families
  // (session/state, wsk1, prg1/prx1) mutually unforgeable under one key.
  const b = await sign(env, "proxygrant.", "payload");
  assert.notEqual(a1, b);
  // And ns+message concatenation is not ambiguous with a shifted split.
  const c = await sign(env, "websearch", ".payload");
  assert.equal(a1, c); // documents the concatenation contract: ns is a plain prefix
});

test("sign without SESSION_SECRET throws (fail closed)", async () => {
  await assert.rejects(() => sign({}, "websearch.", "payload"), /SESSION_SECRET/);
});

test("hmacRaw is the tag both renderings are built from", async () => {
  const raw = await hmacRaw(env, "websearch." + "payload");
  assert.ok(raw instanceof ArrayBuffer);
  assert.equal(raw.byteLength, 32); // SHA-256
  // sign() IS this tag rendered hex — the property that lets src/server-token.js
  // share the primitive while rendering it base64url instead.
  assert.equal(toHex(raw), await sign(env, "websearch.", "payload"));
});

test("hmacRaw without SESSION_SECRET throws (fail closed)", async () => {
  await assert.rejects(() => hmacRaw({}, "anything"), /SESSION_SECRET/);
});

// verifiedClaims is the tag-check + payload-decode step every family's verify
// opens with. It stops at the cryptography: what it returns is an unvalidated
// claims object, and each family checks its own claims afterwards.
const payloadOf = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

// sealedToken is the mint-side mirror: it renders already-assembled claims into
// the `<prefix>.<payload>.<tag>` wire shape and nothing else.
test("sealedToken renders the three-segment wire shape verbatim", async () => {
  const claims = { jti: "a", svc: "web", exp: 42 };
  const token = await sealedToken(env, "proxytoken.", "prx1", claims);
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "prx1");
  assert.equal(parts[1], payloadOf(claims));
  assert.equal(parts[2], await sign(env, "proxytoken.", parts[1]));
});

test("sealedToken and verifiedClaims are inverses under the same namespace", async () => {
  const claims = { jti: "b", uid: "7", quota: 25 };
  const [, payload, sig] = (await sealedToken(env, "websearch.", "wsk1", claims)).split(".");
  assert.deepEqual(await verifiedClaims(env, "websearch.", payload, sig), claims);
});

// The namespace is what keeps the families mutually unforgeable under the one
// SESSION_SECRET, so passing it in has to survive the shared mint: identical
// claims sealed under two namespaces must not verify under each other's.
test("sealedToken keeps the families namespace-separated", async () => {
  const claims = { jti: "c", exp: 99 };
  const [, pWeb, sWeb] = (await sealedToken(env, "websearch.", "wsk1", claims)).split(".");
  const [, pProxy, sProxy] = (await sealedToken(env, "proxytoken.", "prx1", claims)).split(".");
  assert.equal(pWeb, pProxy); // same claims, same payload
  assert.notEqual(sWeb, sProxy); // different namespace, different tag
  assert.equal(await verifiedClaims(env, "proxytoken.", pWeb, sWeb), null);
  assert.equal(await verifiedClaims(env, "websearch.", pProxy, sProxy), null);
});

test("sealedToken fails closed with no signing key, rather than sealing unsigned", async () => {
  await assert.rejects(() => sealedToken({}, "pool.", "pt1", { jti: "d" }), /SESSION_SECRET/);
});

test("verifiedClaims returns the decoded claims for a well-signed payload", async () => {
  const payload = payloadOf({ jti: "a", svc: "web", exp: 42 });
  const sig = await sign(env, "proxytoken.", payload);
  assert.deepEqual(await verifiedClaims(env, "proxytoken.", payload, sig), { jti: "a", svc: "web", exp: 42 });
});

test("verifiedClaims rejects a tag from another namespace", async () => {
  const payload = payloadOf({ jti: "a" });
  const sig = await sign(env, "websearch.", payload);
  assert.equal(await verifiedClaims(env, "proxytoken.", payload, sig), null);
  assert.deepEqual(await verifiedClaims(env, "websearch.", payload, sig), { jti: "a" });
});

test("verifiedClaims rejects a tampered payload, a wrong tag, and junk", async () => {
  const payload = payloadOf({ jti: "a" });
  const sig = await sign(env, "pool.", payload);
  assert.equal(await verifiedClaims(env, "pool.", payloadOf({ jti: "b" }), sig), null);
  assert.equal(await verifiedClaims(env, "pool.", payload, "0".repeat(64)), null);
  assert.equal(await verifiedClaims(env, "pool.", payload, ""), null);
});

test("verifiedClaims returns null — never throws — on an undecodable payload", async () => {
  const notJson = b64url(new TextEncoder().encode("not json at all"));
  assert.equal(await verifiedClaims(env, "pool.", notJson, await sign(env, "pool.", notJson)), null);
  // A well-formed JSON payload that is not an OBJECT is rejected too: every
  // family's claim checks assume they were handed one.
  const scalar = payloadOf(7);
  assert.equal(await verifiedClaims(env, "pool.", scalar, await sign(env, "pool.", scalar)), null);
});

test("verifiedClaims fails closed with no signing key, rather than throwing", async () => {
  const payload = payloadOf({ jti: "a" });
  assert.equal(await verifiedClaims({}, "pool.", payload, "0".repeat(64)), null);
});
