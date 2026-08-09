import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bucketByPmidBand, parseArgs } from "./build-corpora.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// An ABSOLUTE --out must land where the caller asked, not inside the checkout.
// join('/repo', '/tmp/x') is '/repo/tmp/x' — no error, no warning, and the next
// `git add -A` tracks the stray file. That happened here: a probe written to
// /tmp during development was committed and surfaced two steps later as a
// baffling CI failure about a stale source snapshot, on a commit whose working
// tree was clean. resolve() is the one-word fix, and this pins it.
test("an absolute --out path is honoured rather than reparented into the repo", () => {
  const src = readFileSync(join(ROOT, "scripts/build-corpora.mjs"), "utf8");
  assert.match(src, /resolve\(ROOT, opts\.out\)/, "the output path must go through resolve()");
  assert.doesNotMatch(src, /join\(ROOT, opts\.out\)/, "join() silently reparents an absolute path");
  // The behaviour the source guarantees, stated as arithmetic so the intent
  // survives a refactor that renames the variable.
  assert.equal(resolve(ROOT, "/tmp/probe.json"), "/tmp/probe.json");
  assert.equal(join(ROOT, "/tmp/probe.json"), join(ROOT, "tmp/probe.json"));
});

test("the sibling harvest script does not reparent absolute paths either", () => {
  // Same latent bug, three call sites, found while fixing the first.
  const src = readFileSync(join(ROOT, "scripts/arxiv-harvest.mjs"), "utf8");
  assert.doesNotMatch(src, /join\(ROOT, args\.(out|ids)\)/, "join() silently reparents an absolute path");
});

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
