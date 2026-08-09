import { test } from "node:test";
import assert from "node:assert/strict";

import { bucketByMonth, parseArgs, sweptBand, sweptThreshold, windowSentence } from "./arxiv-window.mjs";

/** A run of fully-swept months, the shape a datestamp fill leaves behind. */
const swept = (from, to, per = 20_000) => {
  const out = [];
  let [y, m] = [Number(from.slice(0, 2)), Number(from.slice(2))];
  for (;;) {
    const key = String(y).padStart(2, "0") + String(m).padStart(2, "0");
    for (let i = 0; i < per; i++) out.push(`${key}.${String(i).padStart(5, "0")}`);
    if (key === to) return out;
    if (++m > 12) [y, m] = [y + 1, 1];
  }
};

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

// THE REGRESSION THIS FILE EXISTS FOR.
//
// The first version of sweptBand looked for the longest run of months holding
// ANY papers. Against the real index that returned 0704-2608 — every month
// since April 2007 holds at least one paper — describing an index whose 2007
// holds 83 papers and whose 2024 holds 242,630 as one uniform band. That is
// the more dangerous error of the two: it sends an agent digging through a
// decade the index barely covers.
test("a thin tail of topic-fill months is NOT part of the band", () => {
  const hist = bucketByMonth([
    // fourteen years of scattered topic fills, every month non-empty
    ...Array.from({ length: 14 * 12 }, (_, i) => {
      const y = 7 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      return `${String(y).padStart(2, "0")}${String(m).padStart(2, "0")}.00001`;
    }),
    ...swept("2310", "2405"),
  ]);
  const band = sweptBand(hist.months);
  assert.equal(band.from, "2310", "a month with one paper is not swept");
  assert.equal(band.to, "2405");
});

test("sweptThreshold is half a typical full month, not a hard-coded number", () => {
  const hist = bucketByMonth(swept("2401", "2412", 20_000));
  assert.equal(sweptThreshold(hist.months), 10_000);
});

test("sweptBand rolls the year over at December", () => {
  const hist = bucketByMonth(swept("2311", "2401"));
  const band = sweptBand(hist.months);
  assert.equal(band.from, "2311");
  assert.equal(band.to, "2401");
});

test("a gap splits the band, and the fatter side wins", () => {
  const hist = bucketByMonth([
    ...swept("2301", "2302"),
    // 2303 absent entirely
    ...swept("2304", "2308"),
  ]);
  const band = sweptBand(hist.months);
  assert.equal(band.from, "2304");
  assert.equal(band.to, "2308");
});

test("a partial trailing month is excluded rather than shrinking the band", () => {
  // The real index's newest month is mid-delta: 2608 held 4,168 against a
  // ~25,000 norm. It must not be reported as swept.
  const hist = bucketByMonth([
    ...swept("2310", "2607", 20_000),
    ...swept("2608", "2608", 4_168),
  ]);
  const band = sweptBand(hist.months);
  assert.equal(band.to, "2607");
});

test("sweptBand on an empty index is null rather than a throw", () => {
  assert.equal(sweptBand(new Map()), null);
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
  assert.match(s, /papers \(\d+\.\d%\)/);
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
