// The secure-research-space bundle crypto (public/js/proxy-bundle.js): the
// seal→open round-trip, that a wrong/tampered key or ciphertext fails soft to
// null (never throws), and the shape validator. WebCrypto is a Node global, so
// this runs unmodified.
import test from "node:test";
import assert from "node:assert/strict";
import { b64urlDecode, b64urlEncode, openBundle, sealBundle, sha256hex, validateBundle } from "./proxy-bundle.js";

test("sealBundle → openBundle round-trips an object", async () => {
  const obj = { v: 1, bundleId: "abc", grants: [{ svc: "web", token: "prg1.x.y" }, { svc: "api", token: "prg1.a.b" }] };
  const { blob, key } = await sealBundle(obj);
  assert.equal(typeof blob, "string");
  assert.equal(typeof key, "string");
  const opened = await openBundle(blob, key);
  assert.deepEqual(opened, obj);
});

test("every seal uses fresh key material (two seals of the same object differ)", async () => {
  const obj = { grants: [{ svc: "web", token: "t" }] };
  const a = await sealBundle(obj);
  const b = await sealBundle(obj);
  assert.notEqual(a.blob, b.blob);
  assert.notEqual(a.key, b.key);
  // …and one bundle's key can't open the other's blob.
  assert.equal(await openBundle(a.blob, b.key), null);
});

test("openBundle returns null on a wrong key, tampered ciphertext, and garbage", async () => {
  const { blob, key } = await sealBundle({ grants: [{ svc: "api", token: "t" }] });
  // wrong key (valid length, different bytes)
  const otherKey = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  assert.equal(await openBundle(blob, otherKey), null);
  // tampered ciphertext (flip a byte in the middle)
  const bytes = b64urlDecode(blob);
  bytes[bytes.length - 1] ^= 0xff;
  assert.equal(await openBundle(b64urlEncode(bytes), key), null);
  // garbage inputs
  assert.equal(await openBundle("not-base64!!", key), null);
  assert.equal(await openBundle(blob, "short"), null);
  assert.equal(await openBundle("", ""), null);
});

test("validateBundle accepts a well-formed bundle and rejects malformed ones", () => {
  assert.equal(validateBundle({ v: 1, grants: [{ svc: "web", token: "t" }] }), true);
  assert.equal(validateBundle({ grants: [{ svc: "api", token: "t" }, { svc: "web", token: "u" }] }), true);
  assert.equal(validateBundle(null), false);
  assert.equal(validateBundle({}), false);
  assert.equal(validateBundle({ grants: [] }), false);
  assert.equal(validateBundle({ grants: [{ svc: "web" }] }), false); // no token
  assert.equal(validateBundle({ grants: [{ svc: "email", token: "t" }] }), false); // unknown service
  assert.equal(validateBundle({ grants: [{ svc: "web", token: "" }] }), false); // empty token
});

test("sha256hex: lowercase hex of SHA-256 (the kid-derivation primitive both seal cores share)", async () => {
  // Known vectors: SHA-256("") and SHA-256("abc").
  assert.equal(await sha256hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(
    await sha256hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
