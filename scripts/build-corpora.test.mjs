import { test } from "node:test";
import assert from "node:assert/strict";

import { bucketByPmidBand, parseArgs } from "./build-corpora.mjs";

test("parseArgs takes the flags it documents and rejects the rest", () => {
  assert.deepEqual(parseArgs([]), { skipShape: false, only: "", out: "public/corpora/data.json" });
  assert.equal(parseArgs(["--skip-shape"]).skipShape, true);
  assert.equal(parseArgs(["--only", "arxiv"]).only, "arxiv");
  assert.equal(parseArgs(["--only=pubmed"]).only, "pubmed");
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
});

test("--only is checked against the corpora that exist, not accepted blindly", () => {
  // A typo here would silently publish a dataset with one corpus missing,
  // which reads as "we do not have PubMed" rather than as a bad flag.
  assert.throws(() => parseArgs(["--only", "arxvi"]), /takes arxiv or pubmed/);
});

test("PMIDs bucket by million, which is the load-order axis the window is defined on", () => {
  const { bands, total, unparsed } = bucketByPmidBand(["pmid:41787358", "pmid:41000000", "pmid:75", "pmid:32973028"]);
  assert.equal(total, 4);
  assert.equal(unparsed, 0);
  assert.deepEqual([...bands.entries()].sort((a, b) => a[0] - b[0]), [
    [0, 1], // pmid:75 — PubMed's oldest ids are tiny
    [32, 1],
    [41, 2],
  ]);
});

test("a bare PMID is accepted alongside the prefixed form", () => {
  // The index keys on `pmid:NNNN`, but a list handed in by another tool often
  // is not prefixed; counting those as unparsed would understate the corpus.
  const { bands, unparsed } = bucketByPmidBand(["41787358", "pmid:41787358"]);
  assert.equal(unparsed, 0);
  assert.deepEqual([...bands.entries()], [[41, 2]]);
});

test("an unparsable id is counted, not silently dropped", () => {
  // Silently dropping would make the shape sum to less than the vector count
  // while still looking complete.
  const { bands, unparsed, total } = bucketByPmidBand(["pmid:41787358", "2401.12345", ""]);
  assert.equal(total, 3);
  assert.equal(unparsed, 2);
  assert.deepEqual([...bands.entries()], [[41, 1]]);
});
