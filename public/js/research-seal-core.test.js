// Unit tests for research-seal-core.js — DRCR/1's asymmetric result-sealing
// (the crowd-research primitive) and QR chunk framing. Real WebCrypto
// round-trips in Node (crypto.subtle is global in Node >= 20), no mocks: the
// point of this suite is that the ECDH → HKDF → AES-256-GCM sealed box
// actually opens with the matching private key and fails closed otherwise.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateProjectKeypair,
  exportProjectPublicKey,
  projectKid,
  sealResult,
  openResult,
  validateResultEnvelope,
  chunkResult,
  reassembleChunks,
  RESULT_KIND,
  RESULT_V,
} from "./research-seal-core.js";

const SAMPLE = {
  v: 1,
  kind: "drcr-result",
  campaign: "cmp_test",
  alias: "beta",
  answer: "Phone-inference runtimes matured in 2026: llama.cpp, MLC, and CheerpX-style WASM.",
  sources: [{ title: "Example", url: "https://example.com/a" }],
  producedAt: 1784930000000,
};

describe("project keypair + kid", () => {
  it("exports a raw uncompressed P-256 public key and a stable 8-hex kid", async () => {
    const kp = await generateProjectKeypair();
    const pub = await exportProjectPublicKey(kp.publicKey);
    assert.equal(typeof pub, "string");
    const kid = await projectKid(pub);
    assert.match(kid, /^[0-9a-f]{8}$/);
    // kid is deterministic over the same key
    assert.equal(kid, await projectKid(pub));
  });
});

describe("seal → open round-trip", () => {
  it("opens with the matching private key and reproduces the plaintext", async () => {
    const kp = await generateProjectKeypair();
    const pub = await exportProjectPublicKey(kp.publicKey);
    const env = await sealResult(SAMPLE, pub);

    assert.equal(env.kind, RESULT_KIND);
    assert.equal(env.v, RESULT_V);
    assert.equal(env.kid, await projectKid(pub));
    assert.ok(validateResultEnvelope(env));

    const opened = await openResult(env, kp.privateKey);
    assert.deepEqual(opened, SAMPLE);
  });

  it("survives JSON serialization of the envelope (the wire form)", async () => {
    const kp = await generateProjectKeypair();
    const pub = await exportProjectPublicKey(kp.publicKey);
    const env = JSON.parse(JSON.stringify(await sealResult(SAMPLE, pub)));
    const opened = await openResult(env, kp.privateKey);
    assert.deepEqual(opened, SAMPLE);
  });

  it("uses fresh ephemeral material per seal (two seals differ)", async () => {
    const kp = await generateProjectKeypair();
    const pub = await exportProjectPublicKey(kp.publicKey);
    const a = await sealResult(SAMPLE, pub);
    const b = await sealResult(SAMPLE, pub);
    assert.notEqual(a.epk, b.epk);
    assert.notEqual(a.ct, b.ct);
    // both still open to the same plaintext
    assert.deepEqual(await openResult(a, kp.privateKey), SAMPLE);
    assert.deepEqual(await openResult(b, kp.privateKey), SAMPLE);
  });
});

describe("fail-closed", () => {
  it("returns null for the wrong private key (a different campaign)", async () => {
    const org = await generateProjectKeypair();
    const other = await generateProjectKeypair();
    const pub = await exportProjectPublicKey(org.publicKey);
    const env = await sealResult(SAMPLE, pub);
    assert.equal(await openResult(env, other.privateKey), null);
  });

  it("returns null when the ciphertext is tampered", async () => {
    const kp = await generateProjectKeypair();
    const pub = await exportProjectPublicKey(kp.publicKey);
    const env = await sealResult(SAMPLE, pub);
    const flipped = env.ct.slice(0, -2) + (env.ct.endsWith("A") ? "B" : "A") + env.ct.slice(-1);
    assert.equal(await openResult({ ...env, ct: flipped }, kp.privateKey), null);
  });

  it("returns null for malformed / wrong-kind envelopes", async () => {
    const kp = await generateProjectKeypair();
    assert.equal(await openResult(null, kp.privateKey), null);
    assert.equal(await openResult({}, kp.privateKey), null);
    assert.equal(await openResult({ v: 1, kind: "nope" }, kp.privateKey), null);
    assert.equal(await openResult({ v: 1, kind: RESULT_KIND }, kp.privateKey), null);
  });

  it("rejects a bad recipient public key at seal time", async () => {
    await assert.rejects(() => sealResult(SAMPLE, "not-a-key"));
  });

  it("validateResultEnvelope gates shape without throwing", () => {
    assert.equal(validateResultEnvelope(null), false);
    assert.equal(validateResultEnvelope({ kind: RESULT_KIND, v: 1 }), false);
    assert.equal(
      validateResultEnvelope({ kind: RESULT_KIND, v: 1, kid: "x", epk: "a", iv: "b", ct: "c" }),
      true,
    );
  });
});

describe("QR chunk framing", () => {
  it("splits and reassembles a payload exactly", () => {
    const payload = "x".repeat(5000) + "END";
    const chunks = chunkResult(payload, 1000);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.startsWith("drcr1:")));
    assert.equal(reassembleChunks(chunks), payload);
  });

  it("reassembles out of order and with duplicates", () => {
    const payload = "abcdefghijklmnopqrstuvwxyz".repeat(100);
    const chunks = chunkResult(payload, 40);
    const shuffled = [...chunks].reverse();
    shuffled.push(chunks[0], chunks[2]); // duplicates
    assert.equal(reassembleChunks(shuffled), payload);
  });

  it("returns null while any frame is missing", () => {
    const chunks = chunkResult("y".repeat(300), 50);
    assert.equal(reassembleChunks(chunks.slice(0, -1)), null);
  });

  it("fails closed on foreign framing or mixed reels", () => {
    assert.equal(reassembleChunks(["not-a-chunk"]), null);
    assert.equal(reassembleChunks([]), null);
    // two different totals → mixed reels
    assert.equal(reassembleChunks(["drcr1:1/2:aa", "drcr1:1/3:bb"]), null);
  });

  it("round-trips a sealed envelope through the chunk reel", async () => {
    const kp = await generateProjectKeypair();
    const pub = await exportProjectPublicKey(kp.publicKey);
    const env = await sealResult(SAMPLE, pub);
    const wire = JSON.stringify(env);
    const reassembled = reassembleChunks(chunkResult(wire, 64));
    assert.equal(reassembled, wire);
    assert.deepEqual(await openResult(JSON.parse(reassembled), kp.privateKey), SAMPLE);
  });
});
