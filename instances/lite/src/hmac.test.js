// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sign, verify, safeEqual, toHex, b64urlFromBytes, bytesFromB64url } from "./hmac.js";

const env = { SESSION_SECRET: "test-secret-abc123" };

test("sign/verify round-trips", async () => {
  const tag = await sign(env, "state", "hello");
  assert.equal(await verify(env, "state", "hello", tag), true);
});

test("namespaces are non-forgeable across purposes", async () => {
  const stateTag = await sign(env, "state", "x");
  // The same message under a different namespace must NOT verify.
  assert.equal(await verify(env, "", "x", stateTag), false);
  assert.equal(await verify(env, "other", "x", stateTag), false);
});

test("fail closed with no secret", async () => {
  await assert.rejects(() => sign({}, "state", "x"));
  assert.equal(await verify({}, "state", "x", "deadbeef"), false);
});

test("cookie signature matches the parent's exact construction", async () => {
  // Parent: sig = hex(HMAC-SHA-256(SESSION_SECRET, "<uid>.<exp>")), ns="".
  const uid = "42";
  const exp = "1999999999";
  const ours = await sign(env, "", `${uid}.${exp}`);
  const reference = createHmac("sha256", env.SESSION_SECRET).update(`${uid}.${exp}`).digest("hex");
  assert.equal(ours, reference, "instance must produce byte-identical cookie tags to the parent site");
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(1, "1"), false);
});

test("base64url round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
  assert.deepEqual([...bytesFromB64url(b64urlFromBytes(bytes))], [...bytes]);
});

test("toHex pads", () => {
  assert.equal(toHex(new Uint8Array([0, 15, 255]).buffer), "000fff");
});
