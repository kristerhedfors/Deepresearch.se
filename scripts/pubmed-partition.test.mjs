import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, partOf } from "./pubmed-partition.mjs";

test("partOf is deterministic, so a resumed loader sees the same work list", () => {
  // The whole point of hashing rather than round-robin: part membership must
  // not depend on read order, or a re-partition would move citations between
  // parts and every part's checkpoint would be describing the wrong set.
  for (const pmid of ["41610285", "75", "42530985"]) {
    assert.equal(partOf(pmid, 8), partOf(pmid, 8));
  }
  assert.equal(partOf("41610285", 8), partOf(41610285, 8), "number and string ids must agree");
});

test("partOf stays inside the requested range", () => {
  for (let i = 0; i < 500; i++) {
    const p = partOf(`4${i}${i * 7}`, 8);
    assert.ok(Number.isInteger(p) && p >= 0 && p < 8, `part ${p} out of range`);
  }
  assert.equal(partOf("1", 1), 0);
});

test("partOf spreads PMIDs evenly enough to balance the loaders", () => {
  // Consecutive PMIDs are the realistic input — the archive is PMID-ordered —
  // and a hash that clustered them would leave one loader doing all the work.
  const counts = new Array(8).fill(0);
  for (let pmid = 41_600_000; pmid < 41_610_000; pmid++) counts[partOf(String(pmid), 8)]++;
  const expected = 10_000 / 8;
  for (const [i, n] of counts.entries()) {
    assert.ok(Math.abs(n - expected) < expected * 0.15, `part ${i} got ${n}, expected ~${expected}`);
  }
});

test("parseArgs defaults to the corpus the harvester writes", () => {
  const args = parseArgs([]);
  assert.equal(args.corpus, "data/pubmed/raw");
  assert.equal(args.out, "data/pubmed/parts");
  assert.equal(args.parts, 8);
});

test("parseArgs rejects a parts count that cannot produce a usable fill", () => {
  assert.equal(parseArgs(["--parts", "4"]).parts, 4);
  assert.equal(parseArgs(["--parts=16"]).parts, 16);
  for (const bad of ["0", "-1", "2.5", "65", "many"]) {
    assert.throws(() => parseArgs(["--parts", bad]), /--parts must be an integer/);
  }
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
});

test("DELETE_BATCH keeps a prune call's argv within what a shell will accept", async () => {
  // The withdrawn set is thousands of ids (4,503 in the window ingested on
  // 2026-07-31), and one argv that long is rejected before Vectorize sees it.
  const { DELETE_BATCH } = await import("./vectorize-upsert.mjs");
  assert.ok(Number.isInteger(DELETE_BATCH) && DELETE_BATCH > 0);
  // `pmid:` + 8 digits + a separator is ~14 bytes; 500 of them is ~7 KB, which
  // is comfortably inside every platform's limit with room for the rest.
  assert.ok(DELETE_BATCH * 16 < 32_000, "a delete batch must stay far under ARG_MAX");
});
