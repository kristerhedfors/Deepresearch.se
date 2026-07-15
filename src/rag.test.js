// Unit tests for server-side RAG's pure parts (src/rag.js): index-payload
// validation and the base64⇄Float32 codec — Vectorize/R2 paths live-verify.
import { test } from "node:test";
import assert from "node:assert/strict";

import { b64ToF32, f32ToB64, idOk, validateRagIndexPayload } from "./rag.js";

test("idOk accepts only safe key-path id segments (shared with storage.js)", () => {
  assert.equal(idOk("f47ac10b-58cc-4372-a567-0e02b2c3d479"), true);
  assert.equal(idOk("doc_1-A"), true);
  assert.equal(idOk(""), false); // empty
  assert.equal(idOk("a".repeat(81)), false); // over the 80-char cap
  assert.equal(idOk("../escape"), false); // path traversal characters
  assert.equal(idOk("has space"), false);
  assert.equal(idOk(42), false); // non-string
});

test("f32/b64 codec round-trips losslessly", () => {
  const v = new Float32Array([0, 1, -1, 0.5, 3.14159, -1e-7, 12345.678]);
  const back = b64ToF32(f32ToB64(v));
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i++) assert.equal(back[i], v[i]);
});

test("f32ToB64 handles vectors larger than the chunked btoa window", () => {
  const v = new Float32Array(40000).map((_, i) => i % 7);
  const back = b64ToF32(f32ToB64(v));
  assert.equal(back.length, v.length);
  assert.equal(back[39999], 39999 % 7);
});

function goodPayload() {
  const chunks = [
    { seq: 0, text: "first chunk" },
    { seq: 1, text: "second chunk" },
  ];
  const vectors = chunks.map((_, i) => f32ToB64(new Float32Array([i, i + 1, i + 2])));
  return { docId: "doc-1", name: "big.pdf", chunks, vectors };
}

test("validateRagIndexPayload accepts a well-formed payload", () => {
  const out = validateRagIndexPayload(goodPayload());
  assert.equal(out.error, undefined);
  assert.equal(out.docId, "doc-1");
  assert.equal(out.chunks.length, 2);
  assert.equal(out.dims, 3);
  assert.equal(out.vectors[1][0], 1);
});

test("validateRagIndexPayload rejects bad docIds", () => {
  assert.ok(validateRagIndexPayload({ ...goodPayload(), docId: "../escape" }).error);
  assert.ok(validateRagIndexPayload({ ...goodPayload(), docId: "" }).error);
  assert.ok(validateRagIndexPayload({ ...goodPayload(), docId: "a/b" }).error);
});

test("validateRagIndexPayload requires seq to equal the index", () => {
  const p = goodPayload();
  p.chunks[1].seq = 5; // wipe reconstructs vector ids from count alone
  assert.ok(validateRagIndexPayload(p).error);
});

test("validateRagIndexPayload requires vectors to match chunks 1:1", () => {
  const p = goodPayload();
  p.vectors.pop();
  assert.ok(validateRagIndexPayload(p).error);
});

test("validateRagIndexPayload rejects inconsistent dimensions", () => {
  const p = goodPayload();
  p.vectors[1] = f32ToB64(new Float32Array([1, 2])); // 2 dims vs 3
  assert.ok(validateRagIndexPayload(p).error);
});

test("validateRagIndexPayload rejects empty chunk text and garbage vectors", () => {
  const p1 = goodPayload();
  p1.chunks[0].text = "   ";
  assert.ok(validateRagIndexPayload(p1).error);
  const p2 = goodPayload();
  p2.vectors[0] = "&&& not base64 &&&";
  assert.ok(validateRagIndexPayload(p2).error);
});

test("validateRagIndexPayload caps the name length", () => {
  const out = validateRagIndexPayload({ ...goodPayload(), name: "x".repeat(500) });
  assert.equal(out.name.length, 200);
});
