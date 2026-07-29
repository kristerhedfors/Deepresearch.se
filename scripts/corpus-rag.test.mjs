// Unit tests for the shared small-corpus RAG index builder
// (scripts/corpus-rag.mjs). The embedding half needs a key and a network, so
// what is covered here is the PLANNING half — which had no test at all while it
// lived duplicated in scripts/bundle-docs-rag.mjs and bundle-owasp-rag.mjs, and
// which decides the (path, chunk index) identities the served retrieval
// re-derives. A change here that the retrieval side does not mirror is exactly
// the silent drift the shared module exists to prevent.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { EMBED_MODEL, fileHash, planCorpusChunks } from "./corpus-rag.mjs";
import { chunkSourceText } from "../public/js/introspect-core.js";

describe("planCorpusChunks", () => {
  test("emits one unit per (path, chunk index), numbered from zero per file", () => {
    const corpus = { files: [{ p: "docs/A.md", t: "alpha" }, { p: "docs/B.md", t: "beta" }] };
    const { toEmbed } = planCorpusChunks(corpus);
    assert.deepEqual(toEmbed.map((c) => [c.p, c.ci]), [["docs/A.md", 0], ["docs/B.md", 0]]);
  });

  test("chunk text is the SAME deterministic chunker retrieval re-runs", () => {
    const text = "para one.\n\n" + "lorem ipsum dolor sit amet. ".repeat(200);
    const { toEmbed } = planCorpusChunks({ files: [{ p: "docs/long.md", t: text }] });
    const expected = chunkSourceText(text);
    assert.equal(toEmbed.length, expected.length);
    assert.ok(expected.length > 1, "the fixture must actually span several chunks");
    // Truncation is a prefix cut for e5's 512-token window, so each unit is a
    // prefix of the chunk retrieval will resolve — never a different chunk.
    for (let i = 0; i < expected.length; i++) assert.ok(expected[i].startsWith(toEmbed[i].text));
  });

  test("hashes carry one entry per file, keyed by the same path as the units", () => {
    const corpus = { files: [{ p: "docs/A.md", t: "alpha" }, { p: "docs/B.md", t: "beta" }] };
    const { hashes } = planCorpusChunks(corpus);
    assert.deepEqual(Object.keys(hashes), ["docs/A.md", "docs/B.md"]);
    assert.equal(hashes["docs/A.md"], fileHash("alpha"));
    assert.notEqual(hashes["docs/A.md"], hashes["docs/B.md"]);
  });

  test("an empty corpus plans nothing rather than throwing", () => {
    assert.deepEqual(planCorpusChunks({ files: [] }), { toEmbed: [], hashes: {} });
  });

  test("fileHash is a stable 16-hex-char digest, and null-safe", () => {
    assert.match(fileHash("x"), /^[0-9a-f]{16}$/);
    assert.equal(fileHash("x"), fileHash("x"));
    assert.match(fileHash(undefined), /^[0-9a-f]{16}$/);
  });

  test("the embed model is pinned — it must match what the server embeds queries with", () => {
    assert.equal(EMBED_MODEL, "intfloat/multilingual-e5-large");
  });
});
