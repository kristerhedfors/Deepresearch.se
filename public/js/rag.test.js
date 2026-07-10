// Node tests for rag.js's pure core: chunking coverage/overlap properties, cosine top-k, the f32⇄b64 vector codec.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  b64ToF32,
  chunkText,
  cosineSim,
  f32ToB64,
  topKChunks,
} from "./rag.js";

test("chunkText returns nothing for empty input", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n  "), []);
  assert.deepEqual(chunkText(null), []);
});

test("chunkText keeps a short text as one chunk", () => {
  const chunks = chunkText("A short paragraph.");
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { seq: 0, text: "A short paragraph." });
});

test("chunkText covers the whole text with sequential seqs and bounded sizes", () => {
  const para = "The quick brown fox jumps over the lazy dog. ".repeat(8).trim();
  const text = Array.from({ length: 40 }, (_, i) => `Section ${i}. ${para}`).join("\n\n");
  const chunks = chunkText(text, { targetChars: 1000, overlapChars: 150 });
  assert.ok(chunks.length > 5);
  chunks.forEach((c, i) => {
    assert.equal(c.seq, i);
    assert.ok(c.text.length <= 1000, `chunk ${i} too large (${c.text.length})`);
    assert.ok(c.text.trim().length > 0);
  });
  // Every section header must appear in some chunk — nothing skipped.
  for (let i = 0; i < 40; i++) {
    assert.ok(chunks.some((c) => c.text.includes(`Section ${i}.`)), `Section ${i} missing`);
  }
});

test("chunkText overlaps consecutive chunks for boundary continuity", () => {
  const text = ("word ".repeat(600)).trim(); // no natural breaks
  const chunks = chunkText(text, { targetChars: 800, overlapChars: 200 });
  assert.ok(chunks.length >= 2);
  const tail = chunks[0].text.slice(-60);
  assert.ok(chunks[1].text.includes(tail.slice(0, 30)), "no overlap between chunk 0 and 1");
});

test("chunkText makes progress on pathological input (never loops)", () => {
  // overlap >= target would stall a naive implementation
  const chunks = chunkText("x".repeat(5000), { targetChars: 100, overlapChars: 100 });
  assert.ok(chunks.length > 0);
  assert.ok(chunks.length < 5000);
});

test("cosineSim basics", () => {
  assert.equal(cosineSim([1, 0], [1, 0]), 1);
  assert.equal(cosineSim([1, 0], [0, 1]), 0);
  assert.equal(cosineSim([1, 0], [-1, 0]), -1);
  assert.equal(cosineSim([0, 0], [1, 1]), 0); // zero vector → 0, not NaN
});

test("topKChunks ranks by similarity and caps at k", () => {
  const chunks = [
    { docId: "d", seq: 0, text: "orthogonal", vector: new Float32Array([0, 1]) },
    { docId: "d", seq: 1, text: "aligned", vector: new Float32Array([1, 0.01]) },
    { docId: "d", seq: 2, text: "opposite", vector: new Float32Array([-1, 0]) },
    { docId: "d", seq: 3, text: "close", vector: new Float32Array([0.9, 0.4]) },
  ];
  const top = topKChunks(chunks, new Float32Array([1, 0]), 2);
  assert.equal(top.length, 2);
  assert.equal(top[0].text, "aligned");
  assert.equal(top[1].text, "close");
  assert.ok(top[0].score > top[1].score);
  assert.equal(top[0].docId, "d");
});

test("client f32/b64 codec round-trips (must match the server's)", () => {
  const v = new Float32Array([0.25, -3.5, 1e-6, 42]);
  const back = b64ToF32(f32ToB64(v));
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i++) assert.equal(back[i], v[i]);
});
