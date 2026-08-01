// Unit tests for the hosted-RAG eval harness's pure logic. Anything that talks
// to Vectorize or Berget is verified live (the live-verify skill); what is
// testable here is the statistics and the rank bookkeeping, because those are
// exactly what silently produce a plausible-but-wrong table.
//
// The McNemar cases are pinned to the values docs/ARXIV-RAG.md §11 published
// after computing them BY HAND. That is the point of the pinning: the doc's
// verdicts and the tool's verdicts must be the same arithmetic, or one of them
// is quietly wrong and nobody can tell which.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ageProfile,
  expandMonths,
  langParity,
  lexicalOverlap,
  lossBreakdown,
  mcnemar,
  needleStats,
  pairedNeedle,
  pairedSign,
  rankOf,
  scoreProfile,
} from "./rag-eval-core.mjs";
import { expandPubmedMonths, arxivMonth, pubmedMonth, corpus } from "./rag-corpora.mjs";
import { CANDIDATES as SERVED_CANDIDATES, RERANK_FLOOR as SERVED_FLOOR } from "../src/dense-rag.js";
import { CANDIDATES, RERANK_FLOOR } from "./rag-corpora.mjs";

// ---- window arithmetic ------------------------------------------------------

test("expandMonths walks a YYMM range inclusively", () => {
  assert.deepEqual(expandMonths("2507-2510"), ["2507", "2508", "2509", "2510"]);
  assert.deepEqual(expandMonths("2601-2601"), ["2601"]);
});

test("expandMonths crosses the year boundary rather than comparing strings", () => {
  assert.deepEqual(expandMonths("2511-2602"), ["2511", "2512", "2601", "2602"]);
});

test("expandMonths accepts an explicit list", () => {
  assert.deepEqual(expandMonths("2507, 2601 ,2607"), ["2507", "2601", "2607"]);
});

test("expandPubmedMonths walks YYYY/MM and is NOT the arXiv parser", () => {
  assert.deepEqual(expandPubmedMonths("2025/11-2026/02"), ["2025/11", "2025/12", "2026/01", "2026/02"]);
  assert.deepEqual(expandPubmedMonths("2026/06"), ["2026/06"]);
  // A YYMM spec must not silently parse as a PubMed range — two spellings
  // through one parser is how a window becomes the wrong window.
  assert.deepEqual(expandPubmedMonths("2507-2607"), ["2507-2607"]);
});

// ---- the served constants cannot drift --------------------------------------

test("the harness replays the SERVED pool and floor, not a copy of them", () => {
  // scripts/arxiv-hosted.mjs hard-coded CANDIDATES = 20 with a comment saying
  // that was what production asked for. Production moved to 50 and the harness
  // went on measuring a pipeline nobody runs. These must be the same objects.
  assert.equal(CANDIDATES, SERVED_CANDIDATES);
  assert.equal(RERANK_FLOOR, SERVED_FLOOR);
});

test("every registered corpus round-trips its own id spelling", () => {
  for (const id of ["arxiv", "pubmed"]) {
    const c = corpus(id);
    const bare = id === "arxiv" ? "2601.12345" : "41610285";
    assert.equal(c.bareId(c.vectorId(bare)), bare, `${id} id round trip`);
    assert.ok(c.urlOf(c.vectorId(bare)).includes(bare), `${id} url carries the bare id`);
  }
});

test("an unknown corpus is refused by name rather than defaulted", () => {
  assert.throws(() => corpus("biorxiv"), /unknown corpus/);
});

// ---- dates ------------------------------------------------------------------

test("arxivMonth reads the submission month off the id, not a datestamp", () => {
  assert.equal(arxivMonth("2601.12345"), 202601);
  assert.equal(arxivMonth("2310.00001v3"), 202310);
  assert.equal(arxivMonth("hep-th/9901001"), 0); // old-style ids carry no YYMM
});

test("pubmedMonth reads the stored date and refuses to guess", () => {
  assert.equal(pubmedMonth("pmid:1", { d: "2026-06-14" }), 202606);
  assert.equal(pubmedMonth("pmid:1", { d: "" }), 0);
  assert.equal(pubmedMonth("pmid:1", undefined), 0);
});

// ---- rank bookkeeping -------------------------------------------------------

test("rankOf is 1-based and reports 0 for a miss", () => {
  assert.equal(rankOf(["a", "b", "c"], "a"), 1);
  assert.equal(rankOf(["a", "b", "c"], "c"), 3);
  assert.equal(rankOf(["a", "b", "c"], "z"), 0);
  assert.equal(rankOf([], "a"), 0);
});

// ---- McNemar ----------------------------------------------------------------

test("mcnemar reproduces the hand-computed verdicts published in ARXIV-RAG.md §11", () => {
  // "corpus 338k → 773k, pool held at 20: EN r@1 lost 15 / gained 5 — p=0.041"
  assert.equal(mcnemar(15, 5).p.toFixed(3), "0.041");
  // "pool 20 → 50: EN r@10 gained 8, lost 0 — p=0.008"
  assert.equal(mcnemar(0, 8).p.toFixed(3), "0.008");
});

test("mcnemar counts only discordant pairs", () => {
  // No disagreement at all is not evidence of a difference.
  assert.deepEqual(mcnemar(0, 0), { b: 0, c: 0, n: 0, p: 1 });
  // A symmetric split is the least significant possible result.
  assert.equal(mcnemar(5, 5).p, 1);
});

test("mcnemar is symmetric in direction and monotone in imbalance", () => {
  assert.equal(mcnemar(12, 3).p, mcnemar(3, 12).p);
  assert.ok(mcnemar(20, 0).p < mcnemar(10, 0).p);
  assert.ok(mcnemar(10, 8).p > mcnemar(10, 2).p);
});

test("mcnemar stays finite where a factorial implementation would overflow", () => {
  const t = mcnemar(400, 350);
  assert.ok(Number.isFinite(t.p) && t.p > 0 && t.p <= 1, `p was ${t.p}`);
});

// ---- paired helpers ---------------------------------------------------------

const needle = (gold, lang, finalRank, denseRank = finalRank || 30, ordered = []) => ({
  kind: "needle",
  gold,
  lang,
  finalRank,
  denseRank,
  ordered,
  kept: [],
  ms: { total: 1000 },
  scores: [],
});

test("pairedNeedle pairs on the query and ignores documents only one run saw", () => {
  const before = [needle("a", "en", 1), needle("b", "en", 0), needle("c", "en", 5)];
  const after = [needle("a", "en", 0), needle("b", "en", 1), needle("z", "en", 1)];
  const t = pairedNeedle(before, after, 10);
  assert.equal(t.nPaired, 2, "c and z are unpaired and must not be counted");
  assert.equal(t.b, 1); // a was lost
  assert.equal(t.c, 1); // b was gained
});

test("pairedNeedle respects k", () => {
  const before = [needle("a", "en", 5)];
  const after = [needle("a", "en", 5)];
  assert.equal(pairedNeedle(before, after, 10).n, 0);
  // At k=1 neither run hits, so the pair is still concordant.
  assert.equal(pairedNeedle(before, after, 1).n, 0);
});

test("pairedSign drops ties rather than counting them as agreement", () => {
  const t = pairedSign([1, 2, 3, 4], [1, 3, 2, 4]);
  assert.equal(t.n, 2, "two ties dropped");
  assert.equal(t.b, 1);
  assert.equal(t.c, 1);
});

test("langParity returns the discordant COUNTS, not the language names", () => {
  // Regression: the language options were spread onto mcnemar's result as
  // `a`/`b`, replacing the count `b` with the string "sv". The table then
  // compared strings and reported a Swedish deficit as "Swedish ahead".
  const rows = [
    needle("d1", "en", 1), needle("d1", "sv", 0),
    needle("d2", "en", 1), needle("d2", "sv", 0),
    needle("d3", "en", 0), needle("d3", "sv", 1),
  ];
  const t = langParity(rows, { k: 10 });
  assert.equal(typeof t.b, "number");
  assert.equal(typeof t.c, "number");
  assert.equal(t.b, 2, "Swedish lost two documents English found");
  assert.equal(t.c, 1);
  assert.equal(t.langA, "en");
  assert.equal(t.langB, "sv");
  assert.equal(t.nPaired, 3);
});

test("langParity can look at the dense stage alone", () => {
  // English retrieves both; Swedish retrieves neither into the pool.
  const rows = [
    needle("d1", "en", 3, 3), needle("d1", "sv", 0, 0),
    needle("d2", "en", 4, 4), needle("d2", "sv", 0, 0),
  ];
  assert.equal(langParity(rows, { stage: "dense" }).b, 2);
});

// ---- summary tables ---------------------------------------------------------

test("needleStats separates the pool ceiling from what the user got", () => {
  const rows = [
    needle("a", "en", 1, 1),
    needle("b", "en", 0, 0), // never retrieved
    needle("c", "en", 7, 4),
    needle("d", "en", 0, 9, ["d"]), // retrieved and ranked, then floored out
  ];
  const s = needleStats(rows, "en");
  assert.equal(s.n, 4);
  assert.equal(s.inPool, 75, "three of four were in the pool");
  assert.equal(s.r1, 25);
  assert.equal(s.r10, 50);
  assert.equal(s.floorLoss, 25, "d was ranked by the cross-encoder and dropped by the floor");
});

test("lossBreakdown puts every needle in exactly one bucket", () => {
  const rows = [
    needle("a", "en", 1, 1),
    needle("b", "en", 0, 0),
    needle("c", "en", 0, 9, ["c"]),
    needle("d", "en", 40, 4),
  ];
  const l = lossBreakdown(rows, "en");
  assert.equal(Math.round(l.top10 + l.notRetrieved + l.rerankDemoted + l.flooredOut), 100);
  assert.equal(l.notRetrieved, 25);
  assert.equal(l.flooredOut, 25);
  assert.equal(l.rerankDemoted, 25);
});

test("ageProfile uses the corpus's own date rule and skips undatable results", () => {
  const rows = [{ kind: "topical", kept: ["2601.1", "2310.2", "hep-th/9901001"] }];
  const a = ageProfile(rows, { monthOf: arxivMonth, preWindow: 202507 });
  assert.equal(a.n, 2, "the old-style id has no month and is skipped, not guessed");
  assert.equal(a.oldest, "2023-10");
  assert.equal(a.newest, "2026-01");
  // Only 2310 predates the original 2507-2607 window; 2601 is inside it.
  assert.equal(a.preWindowPct, 50);
});

test("scoreProfile reports what each candidate floor would empty", () => {
  const rows = [
    { kind: "topical", scored: true, scores: [0.9] },
    { kind: "topical", scored: true, scores: [0.03] },
    { kind: "topical", scored: true, scores: [0.005] },
  ];
  const sp = scoreProfile(rows, "topical");
  assert.equal(sp.n, 3);
  assert.equal(sp.zeroAt["0.01"], 1);
  assert.equal(sp.zeroAt["0.05"], 2);
});

test("scoreProfile ignores rows where the cross-encoder never scored", () => {
  // A fail-soft fallback carries no comparable numbers; averaging them in is
  // how a bake-off once reported scores for a pipeline that never ran.
  const rows = [{ kind: "topical", scored: false, scores: [] }];
  assert.equal(scoreProfile(rows, "topical"), null);
});

// ---- the leak guard ---------------------------------------------------------

test("lexicalOverlap measures the query's content words against a body", () => {
  const tok = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  assert.equal(lexicalOverlap("quantum error correction surface", "quantum error correction with surface codes", tok), 1);
  assert.equal(lexicalOverlap("completely different wording here", "quantum error correction", tok), 0);
  // Short words are ignored on both sides, so "the"/"of" cannot inflate it.
  assert.equal(lexicalOverlap("of the a", "quantum", tok), 0);
});
