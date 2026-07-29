// Unit tests for the hosted-index eval harness's pure logic. Anything that
// talks to Vectorize or Berget is verified live (the live-verify skill); what
// is testable here is the window arithmetic, the rank bookkeeping and the
// cross-encoder document cut, because those are what silently produce a
// plausible-but-wrong table.

import assert from "node:assert/strict";
import test from "node:test";
import { ageProfile, expandMonths, idYYMM, needleStats, rankOf } from "./arxiv-hosted-eval.mjs";
import { rerankDoc } from "./arxiv-hosted.mjs";
import { bareId } from "./arxiv-crosscheck.mjs";
import { RERANK_DOC_CHARS } from "./arxiv-berget.mjs";

test("expandMonths walks a YYMM range inclusively", () => {
  assert.deepEqual(expandMonths("2507-2510"), ["2507", "2508", "2509", "2510"]);
  assert.deepEqual(expandMonths("2601-2601"), ["2601"]);
});

test("expandMonths crosses the year boundary rather than comparing strings", () => {
  // 2512 → 2601 is the case a string range would treat as a gap.
  assert.deepEqual(expandMonths("2511-2602"), ["2511", "2512", "2601", "2602"]);
});

test("expandMonths spans the full widened window", () => {
  const months = expandMonths("2310-2607");
  assert.equal(months.length, 34);
  assert.equal(months[0], "2310");
  assert.equal(months.at(-1), "2607");
  assert.ok(months.includes("2401"));
});

test("expandMonths accepts an explicit list", () => {
  assert.deepEqual(expandMonths("2507, 2601 ,2607"), ["2507", "2601", "2607"]);
});

test("rankOf is 1-based and reports 0 for a miss", () => {
  assert.equal(rankOf(["a", "b", "c"], "a"), 1);
  assert.equal(rankOf(["a", "b", "c"], "c"), 3);
  assert.equal(rankOf(["a", "b", "c"], "z"), 0);
  assert.equal(rankOf([], "a"), 0);
});

test("rerankDoc cuts to the served window and mirrors the ' . ' join", () => {
  const doc = rerankDoc({ metadata: { t: "Title", a: "Abstract body" } });
  assert.equal(doc, "Title. Abstract body");
  const long = rerankDoc({ metadata: { t: "T", a: "x".repeat(5000) } });
  assert.equal(long.length, RERANK_DOC_CHARS);
});

test("rerankDoc does not emit a bare separator for an empty half", () => {
  // A lone "." would still be a document the cross-encoder has to score.
  assert.equal(rerankDoc({ metadata: { t: "", a: "Just an abstract" } }), "Just an abstract");
  assert.equal(rerankDoc({ metadata: { t: "Just a title", a: "" } }), "Just a title");
  assert.equal(rerankDoc({}), "");
});

test("needleStats separates the dense ceiling from the final rank", () => {
  const rows = [
    // in the pool and ranked first after reranking
    { kind: "needle", lang: "en", gold: "g1", denseRank: 3, finalRank: 1, kept: ["g1", "x"], ordered: ["g1", "x"], ms: { total: 100 } },
    // in the pool, but the reranker buried it past 10
    { kind: "needle", lang: "en", gold: "g2", denseRank: 5, finalRank: 0, kept: ["x", "y"], ordered: ["x", "y"], ms: { total: 100 } },
    // never retrieved at all — the ceiling, not a reranker failure
    { kind: "needle", lang: "en", gold: "g3", denseRank: 0, finalRank: 0, kept: ["x"], ordered: ["x"], ms: { total: 100 } },
    { kind: "needle", lang: "sv", gold: "g4", denseRank: 1, finalRank: 1, kept: ["g4"], ordered: ["g4"], ms: { total: 100 } },
  ];
  const en = needleStats(rows, "en");
  assert.equal(en.n, 3);
  assert.equal(en.inPool, 66.7); // two of three reached the cross-encoder
  assert.equal(en.r1, 33.3);
  assert.equal(en.r10, 33.3);
  assert.equal(needleStats(rows, "sv").n, 1);
});

test("needleStats attributes a floor drop separately from a ranking miss", () => {
  // The reranker kept the gold paper, the relevance floor then removed it.
  const rows = [
    { kind: "needle", lang: "en", gold: "g1", denseRank: 2, finalRank: 0, kept: ["x"], ordered: ["x", "g1"], ms: { total: 10 } },
  ];
  assert.equal(needleStats(rows, "en").floorLoss, 100);
  // Never in `ordered` either → a retrieval miss, not the floor's doing.
  const miss = [
    { kind: "needle", lang: "en", gold: "g1", denseRank: 0, finalRank: 0, kept: ["x"], ordered: ["x"], ms: { total: 10 } },
  ];
  assert.equal(needleStats(miss, "en").floorLoss, 0);
});

test("needleStats ignores errored rows rather than scoring them as misses", () => {
  const rows = [
    { kind: "needle", lang: "en", gold: "g1", denseRank: 1, finalRank: 1, kept: ["g1"], ordered: ["g1"], ms: { total: 10 } },
    { kind: "needle", lang: "en", gold: "g2", error: "boom", kept: [], ordered: [] },
  ];
  const s = needleStats(rows, "en");
  assert.equal(s.n, 1);
  assert.equal(s.r1, 100);
});

test("idYYMM reads the submission month from the id, not from metadata", () => {
  assert.equal(idYYMM("2507.01234"), 2507);
  assert.equal(idYYMM("2310.00001"), 2310);
  assert.equal(idYYMM("2601.12345"), 2601);
  // Old-style ids carry no YYMM and are pre-2007 — excluded, not guessed at.
  assert.equal(idYYMM("cs/0503001"), 0);
  assert.equal(idYYMM(""), 0);
});

test("ageProfile reports the pre-widening share of what was shown", () => {
  const rows = [
    { kind: "topical", kept: ["2310.00001", "2401.00002", "2507.00003", "2607.00004"] },
  ];
  const a = ageProfile(rows);
  assert.equal(a.n, 4);
  assert.equal(a.oldest, "2023-10");
  assert.equal(a.newest, "2026-07");
  // Two of four predate the original 13-month window.
  assert.equal(a.preWindowPct, 50);
});

test("ageProfile only counts what the run actually showed", () => {
  // `kept` is post-floor — the list a user sees. Candidates that the floor
  // dropped must not count toward the age mix.
  const rows = [
    { kind: "topical", kept: ["2607.00001"], ordered: ["2607.00001", "2310.99999"] },
    { kind: "topical", error: "boom", kept: [] },
  ];
  const a = ageProfile(rows);
  assert.equal(a.n, 1);
  assert.equal(a.preWindowPct, 0);
});

test("the ids a coverage check sends are normalised to the index's keys", () => {
  // Regression: `coverage --ids` fed raw enumeration lines (2507.23787v2) to
  // get_by_ids, which is keyed by the bare id, and reported 0% on every month
  // — indistinguishable from a lost corpus. The same normalisation was already
  // needed in arxiv-crosscheck, so it is now imported from one place.
  assert.equal(bareId("2311.18841v2"), "2311.18841");
  assert.equal(bareId("2311.18841"), "2311.18841");
});
