import { test } from "node:test";
import assert from "node:assert/strict";

import { bucketByMonth, densestBand, parseArgs, windowSentence } from "./arxiv-window.mjs";

test("an arXiv id is bucketed by the month it carries", () => {
  const hist = bucketByMonth(["2401.12345", "2401.00001", "2402.99999"]);
  assert.equal(hist.total, 3);
  assert.equal(hist.old, 0);
  assert.deepEqual([...hist.months.entries()].sort(), [
    ["2401", 2],
    ["2402", 1],
  ]);
});

test("pre-2007 ids are counted, not dropped — they are real papers", () => {
  // Dropping them is how a window sentence ends up wrong one era further back
  // than the bug it was written to fix.
  const hist = bucketByMonth(["cs/0503001", "math.GT/0309136", "2401.12345"]);
  assert.equal(hist.total, 3);
  assert.equal(hist.old, 2);
  assert.deepEqual([...hist.months.entries()], [["2401", 1]]);
});

test("five-digit ids are bucketed like any other — they arrived in 2015", () => {
  const hist = bucketByMonth(["2501.12345", "1501.00001"]);
  assert.deepEqual([...hist.months.entries()].sort(), [
    ["1501", 1],
    ["2501", 1],
  ]);
});

test("densestBand finds the longest consecutive run, not merely the biggest month", () => {
  // 2401 alone is the fattest single month, but the band that describes the
  // index is the contiguous 2310-2312 run.
  const months = new Map([
    ["2310", 100],
    ["2311", 100],
    ["2312", 100],
    ["2401", 250],
    ["9901", 5],
  ]);
  // 2310-2401 is in fact consecutive; the break is before 9901.
  assert.deepEqual(densestBand(months), { from: "2310", to: "2401", count: 550 });
});

test("densestBand rolls the year over at December", () => {
  const months = new Map([
    ["2311", 10],
    ["2312", 10],
    ["2401", 10],
  ]);
  assert.deepEqual(densestBand(months), { from: "2311", to: "2401", count: 30 });
});

test("a gap splits the band", () => {
  const months = new Map([
    ["2301", 10],
    ["2302", 10],
    // 2303 missing
    ["2304", 5],
  ]);
  assert.deepEqual(densestBand(months), { from: "2301", to: "2302", count: 20 });
});

test("densestBand on an empty index is null rather than a throw", () => {
  assert.equal(densestBand(new Map()), null);
});

test("the sentence names the band AND the tail, so neither is mistaken for the other", () => {
  // The bug this whole script exists for: a sentence that mentions only the
  // band tells an agent tens of thousands of held papers are out of window.
  const hist = bucketByMonth([
    ...Array.from({ length: 80 }, (_, i) => `2310.${String(i).padStart(5, "0")}`),
    ...Array.from({ length: 20 }, (_, i) => `1505.${String(i).padStart(5, "0")}`),
  ]);
  const s = windowSentence(hist);
  assert.match(s, /2310/);
  assert.match(s, /20 papers \(20\.0%\)/);
  assert.match(s, /NOT proof/);
});

test("an empty index says so instead of inventing a band", () => {
  assert.match(windowSentence(bucketByMonth([])), /empty/);
});

test("parseArgs rejects an unknown flag rather than ignoring it", () => {
  assert.deepEqual(parseArgs([]), { index: "deepresearch-se-arxiv", json: "" });
  assert.deepEqual(parseArgs(["--index", "other", "--json", "o.json"]), { index: "other", json: "o.json" });
  assert.deepEqual(parseArgs(["--index=other"]).index, "other");
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
});
