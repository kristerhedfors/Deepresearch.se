// Direct tests for the corpus-agnostic dense tier's shared pieces.
//
// The retrieval half (denseSearch / denseRetrieve / rerankMatches) is exercised
// through both callers in src/arxiv-rag.test.js and src/pubmed-rag.test.js,
// which own the binding and fail-soft cases. What had no direct test at all is
// the presentation half — the author line and the abstract cut that BOTH tiers
// hand to the numbered source list. Those exist to be identical across corpora
// (a reader must not be able to tell which tier answered), and a difference
// there is invisible: no error, no failed request, just two source lists that
// quietly stopped matching.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ABSTRACT_CHARS,
  authorsLine,
  citationHighlights,
  titleAbstractDoc,
} from "./dense-rag.js";
import { arxivRagItem } from "./arxiv-rag.js";
import { pubmedRagItem } from "./pubmed-rag.js";

test("authorsLine shows three names and abbreviates the rest", () => {
  assert.equal(authorsLine("Ada Lovelace"), "Ada Lovelace");
  assert.equal(authorsLine("A One; B Two; C Three"), "A One, B Two, C Three");
  assert.equal(authorsLine("A One; B Two; C Three; D Four"), "A One, B Two, C Three et al.");
  // Four is the first count that earns "et al." — three names shown, one hidden.
  assert.equal(authorsLine("A; B; C; D; E"), "A, B, C et al.");
});

test("authorsLine yields an empty line rather than a stray separator", () => {
  assert.equal(authorsLine(""), "");
  assert.equal(authorsLine(null), "");
  assert.equal(authorsLine(undefined), "");
  // A trailing or doubled semicolon is common in stored metadata and must not
  // become an empty name, which would render as ", " in the middle of the line.
  assert.equal(authorsLine("A One;; B Two;"), "A One, B Two");
  assert.equal(authorsLine(";;;"), "");
});

test("citationHighlights carries the metadata line alone when there is no abstract", () => {
  assert.deepEqual(citationHighlights("A One · 2026-01-01", ""), ["A One · 2026-01-01"]);
  assert.deepEqual(citationHighlights("meta", null), ["meta"]);
  assert.deepEqual(citationHighlights("meta", "   "), ["meta"]);
});

test("citationHighlights cuts a long abstract and marks the cut", () => {
  const short = "a".repeat(MAX_ABSTRACT_CHARS);
  assert.deepEqual(citationHighlights("meta", short), ["meta", short]);

  const long = "b".repeat(MAX_ABSTRACT_CHARS + 50);
  const [, cut] = citationHighlights("meta", long);
  assert.ok(cut.endsWith("…"), "a cut abstract must say so");
  assert.equal(cut.length, MAX_ABSTRACT_CHARS + 1, "the ellipsis is the only character added");

  // The trailing whitespace is trimmed BEFORE the ellipsis, so a cut landing in
  // a gap does not render as "word …".
  const spaced = `${"c".repeat(MAX_ABSTRACT_CHARS - 1)}  tail`;
  assert.equal(citationHighlights("meta", spaced)[1], `${"c".repeat(MAX_ABSTRACT_CHARS - 1)}…`);
});

test("both hosted tiers cut an abstract at the same length", () => {
  const abstract = "d".repeat(MAX_ABSTRACT_CHARS + 200);
  const arxiv = arxivRagItem({ id: "2601.00001", metadata: { t: "T", a: abstract, au: "A One" } });
  const pubmed = pubmedRagItem({ id: "pmid:41610285", metadata: { t: "T", a: abstract, au: "A One" } });
  assert.ok(arxiv && pubmed);
  assert.equal(arxiv.highlights[1], pubmed.highlights[1]);
  assert.equal(arxiv.highlights[1].length, MAX_ABSTRACT_CHARS + 1);
});

test("both hosted tiers abbreviate an author list the same way", () => {
  const au = "A One; B Two; C Three; D Four";
  const arxiv = arxivRagItem({ id: "2601.00001", metadata: { t: "T", au } });
  const pubmed = pubmedRagItem({ id: "pmid:1", metadata: { t: "T", au } });
  assert.ok(arxiv && pubmed);
  assert.ok(arxiv.highlights[0].startsWith("A One, B Two, C Three et al. · "));
  assert.ok(pubmed.highlights[0].startsWith("A One, B Two, C Three et al. · "));
});

test("titleAbstractDoc joins only the halves that exist", () => {
  assert.equal(titleAbstractDoc({ metadata: { t: "Title", a: "Body" } }), "Title. Body");
  assert.equal(titleAbstractDoc({ metadata: { t: "Title" } }), "Title");
  assert.equal(titleAbstractDoc({ metadata: { a: "Body" } }), "Body");
  // A bare "." would be a document the cross-encoder still has to score.
  assert.equal(titleAbstractDoc({ metadata: {} }), "");
  assert.equal(titleAbstractDoc(null), "");
});
