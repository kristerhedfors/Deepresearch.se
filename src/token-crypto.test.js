// The shared HMAC-token crypto primitives (src/token-crypto.js) — the one
// implementation behind auth.js's toHex/safeEqual and the websearch-key.js /
// proxy-grant.js token modules. The properties exercised here: the base64url
// codec round-trips arbitrary bytes without padding chars, toHex renders
// deterministically, safeEqual is exact and type-strict, and `sign` is
// namespace-separated, deterministic, and fail-closed without SESSION_SECRET.
// (Each token family's own mint/verify stays covered by websearch-key.test.js
// and proxy-grant.test.js.)
import test from "node:test";
import assert from "node:assert/strict";
import { b64url, b64urlDecode, toHex, safeEqual, sign } from "./token-crypto.js";

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
