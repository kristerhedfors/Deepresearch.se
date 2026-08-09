// Unit tests for the arXiv arm enumerator. No network: every test drives the
// pure decision helpers against canned inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseArms,
  phraseCount,
  splitTop,
  splitArm,
  perEntryMs,
  pageFor,
  retunePage,
  shouldCapArm,
  shardDecision,
  halveRange,
  addDays,
  dateClause,
  totalOf,
  idsOf,
  lastPublished,
  isErrorFeed,
  isFeed,
  PAGING_WALL,
} from "./arxiv-enumerate.mjs";

// --- parseArms -------------------------------------------------------------

test("parseArms reads name, tier and the first non-comment line", () => {
  const arms = parseArms(`# a file header
# with commentary

## X1-short   [CORE]
cat:cs.CR AND (cat:cs.LG OR cat:cs.AI)

## P1-wide   [PERIPHERY]
# a comment between the header and the query
(all:"AI safety" OR all:"AI policy")
`);
  assert.deepEqual(arms, [
    { name: "X1-short", query: "cat:cs.CR AND (cat:cs.LG OR cat:cs.AI)", core: true },
    { name: "P1-wide", query: '(all:"AI safety" OR all:"AI policy")', core: false },
  ]);
});

test("parseArms ignores a header with no query after it", () => {
  assert.deepEqual(parseArms("## Z-empty  [CORE]\n"), []);
});

// --- splitTop --------------------------------------------------------------

test("splitTop splits only at paren depth 0", () => {
  assert.deepEqual(splitTop("(a OR b) AND (c OR d)", " AND "), ["(a OR b)", "(c OR d)"]);
  assert.deepEqual(splitTop("cat:cs.CR AND (x OR y)", " AND "), ["cat:cs.CR", "(x OR y)"]);
  // The nested " AND " must not split the outer group.
  assert.deepEqual(splitTop("((a AND b) OR c) AND d", " AND "), ["((a AND b) OR c)", "d"]);
});

test("splitTop ignores separators inside quotes", () => {
  assert.deepEqual(splitTop('all:"denial of service AND more" OR all:"x"', " AND "), [
    'all:"denial of service AND more" OR all:"x"',
  ]);
});

// --- phraseCount -----------------------------------------------------------

test("phraseCount counts quoted clauses, not query length", () => {
  assert.equal(phraseCount("cat:cs.CR AND (cat:cs.LG OR cat:cs.AI)"), 0);
  assert.equal(phraseCount('all:"machine learning"'), 1);
  assert.equal(phraseCount('cat:cs.CR AND (all:"a" OR all:"b" OR all:"c")'), 3);
});

// --- splitArm --------------------------------------------------------------

test("splitArm leaves a query that already fits alone", () => {
  const q = 'cat:cs.CR AND (all:"a" OR all:"b")';
  assert.deepEqual(splitArm(q, 4), [q]);
  // A category-only arm has no phrases at all and is never chunked.
  const x1 = "cat:cs.CR AND (cat:cs.LG OR cat:cs.AI OR cat:cs.CL)";
  assert.deepEqual(splitArm(x1, 4), [x1]);
});

test("splitArm chunks the widest phrase group and keeps the AND context", () => {
  const q = 'cat:cs.CR AND (all:"a" OR all:"b" OR all:"c" OR all:"d" OR all:"e")';
  assert.deepEqual(splitArm(q, 2), [
    'cat:cs.CR AND (all:"a" OR all:"b")',
    'cat:cs.CR AND (all:"c" OR all:"d")',
    'cat:cs.CR AND (all:"e")',
  ]);
});

test("splitArm chunks the WIDEST group, not the first", () => {
  const q = '(all:"p" OR all:"q") AND (all:"a" OR all:"b" OR all:"c" OR all:"d")';
  const subs = splitArm(q, 3);
  assert.deepEqual(subs, [
    '(all:"p" OR all:"q") AND (all:"a")',
    '(all:"p" OR all:"q") AND (all:"b")',
    '(all:"p" OR all:"q") AND (all:"c")',
    '(all:"p" OR all:"q") AND (all:"d")',
  ]);
});

test("splitArm is union-equivalent: every term survives exactly once", () => {
  const terms = Array.from({ length: 17 }, (_, i) => `all:"t${i}"`);
  const q = `cat:cs.CR AND (${terms.join(" OR ")})`;
  const subs = splitArm(q, 4);
  const seen = subs.flatMap((s) => s.match(/all:"t\d+"/g) ?? []);
  assert.deepEqual(seen.sort(), terms.slice().sort());
  assert.ok(subs.every((s) => s.startsWith("cat:cs.CR AND (")));
  assert.ok(subs.every((s) => phraseCount(s) <= 4));
});

test("splitArm never emits an empty chunk when the fixed groups already blow the budget", () => {
  // Two 3-phrase groups ride along in every sub-query, so the chunk budget is
  // pinned at one term rather than going to zero and looping forever.
  const q = '(all:"f1" OR all:"f2" OR all:"f3") AND (all:"a" OR all:"b" OR all:"c" OR all:"d")';
  const subs = splitArm(q, 2);
  assert.equal(subs.length, 4);
  assert.ok(subs.every((s) => phraseCount(s) === 4));
});

// --- the page-size / cost model -------------------------------------------

test("perEntryMs tracks the measured cost curve", () => {
  // Measured 2026-08-09 on export.arxiv.org: 1.5ms at 0 phrases, 4.1 at 1,
  // 20 at 8, 298.8 at 51. The model may be conservative but must never be
  // optimistic, or it hands a query a page that times out at 30s.
  const measured = [
    [0, 1.5],
    [1, 4.1],
    [2, 4.5],
    [4, 9.1],
    [8, 20.0],
    [16, 36.3],
  ];
  for (const [phrases, ms] of measured) {
    assert.ok(perEntryMs(phrases) >= ms * 0.9, `${phrases} phrases: ${perEntryMs(phrases)} < ${ms}`);
  }
  assert.ok(perEntryMs(51) > perEntryMs(16) * 4, "the cost curve must stay super-linear at the top");
});

test("pageFor keeps a request inside the budget and inside the API cap", () => {
  assert.equal(pageFor(0), 2000); // the API's own max_results ceiling
  assert.ok(pageFor(8) * perEntryMs(8) <= 12000);
  assert.ok(pageFor(51) * perEntryMs(51) <= 12000);
  // Monotone: more phrases can never earn a bigger page.
  for (let t = 1; t < 60; t++) assert.ok(pageFor(t) <= pageFor(t - 1));
  assert.ok(pageFor(51) >= 25, "never below the floor, however expensive the query");
});

test("retunePage halves on a slow response and grows on a fast one", () => {
  assert.equal(retunePage(1000, 25000), 500);
  assert.equal(retunePage(1000, 2000), 1500);
  assert.equal(retunePage(1000, 9000), 1000);
  assert.equal(retunePage(2000, 1000), 2000, "never past the API cap");
  assert.equal(retunePage(25, 25000), 25, "never below the floor");
});

// --- the marginal-yield cap -----------------------------------------------

test("shouldCapArm is off unless a floor is asked for", () => {
  assert.equal(shouldCapArm([0, 0, 0, 0], 0), false);
  assert.equal(shouldCapArm([0, 0, 0, 0], undefined), false);
});

test("shouldCapArm needs a sustained collapse, not one lean sub-query", () => {
  // C1's real per-sub-query yields. #3 dipped to 33/req and #7 then paid back
  // 127/req: capping on the dip alone would have thrown away 1,017 papers.
  const c1 = [151, 121, 181, 33, 44, 21, 53, 127];
  assert.equal(shouldCapArm(c1.slice(0, 4), 50), false, "one lean sub-query is not a collapse");
  assert.equal(shouldCapArm(c1.slice(0, 5), 50), false, "two is still not three");
  assert.equal(shouldCapArm(c1.slice(0, 6), 50), true, "33, 44, 21 in a row is");
  assert.equal(shouldCapArm(c1, 50), false, "and 127 ends the streak");
});

test("shouldCapArm will not fire before it has seen `streak` sub-queries", () => {
  assert.equal(shouldCapArm([1, 1], 50), false);
  assert.equal(shouldCapArm([1, 1, 1], 50), true);
});

// --- the shard decision (what used to cost a separate count probe) ---------

test("shardDecision pages on while rows remain under the wall", () => {
  assert.equal(
    shardDecision({ total: 5000, start: 0, got: 1000, cursorDate: "20200101", lastDate: "20200301" }),
    "page",
  );
});

test("shardDecision stops when the response's own total is reached", () => {
  assert.equal(
    shardDecision({ total: 1342, start: 1000, got: 342, cursorDate: "20200101", lastDate: "20200301" }),
    "done",
  );
  assert.equal(shardDecision({ total: 30, start: 0, got: 30, cursorDate: "20200101", lastDate: "20200103" }), "done");
});

test("shardDecision advances the date cursor at the paging wall, it does not re-count", () => {
  const v = shardDecision({
    total: 15086,
    start: PAGING_WALL - 500,
    got: 1000,
    cursorDate: "20200101",
    lastDate: "20210715",
  });
  assert.equal(v, "advance");
});

test("shardDecision calls a stall a stall rather than yielding fewer ids quietly", () => {
  // The wall is reached but every row shares the cursor's own day.
  assert.equal(
    shardDecision({ total: 40000, start: PAGING_WALL, got: 100, cursorDate: "20200101", lastDate: "20200101" }),
    "stall",
  );
  // An empty page short of the total is also a stall, never a "done".
  assert.equal(shardDecision({ total: 5000, start: 10, got: 0, cursorDate: "20200101", lastDate: null }), "stall");
  assert.equal(shardDecision({ total: 10, start: 10, got: 0, cursorDate: "20200101", lastDate: null }), "done");
});

// --- date arithmetic -------------------------------------------------------

test("halveRange splits on real calendar days", () => {
  assert.deepEqual(halveRange("20200101", "20200103"), [
    ["20200101", "20200101"],
    ["20200102", "20200103"],
  ]);
  assert.deepEqual(halveRange("20200201", "20200301"), [
    ["20200201", "20200214"],
    ["20200215", "20200301"],
  ]);
  // A leap day is inside the range, so month lengths have to be honest.
  const [lo, hi] = halveRange("20200228", "20200302");
  assert.deepEqual(lo, ["20200228", "20200228"]);
  assert.deepEqual(hi, ["20200229", "20200302"]);
});

test("halveRange refuses to split a single day", () => {
  assert.equal(halveRange("20200101", "20200101"), null);
});

test("halveRange halves converge to single days", () => {
  let ranges = [["20200101", "20201231"]];
  for (let i = 0; i < 12 && ranges.length; i++) {
    const next = [];
    for (const [a, b] of ranges) {
      const h = halveRange(a, b);
      if (h) next.push(...h);
    }
    ranges = next;
  }
  assert.equal(ranges.length, 0, "every branch must bottom out at a single day");
});

test("addDays and dateClause build what the API wants", () => {
  assert.equal(addDays("20200301", -1), "20200229");
  assert.equal(addDays("20191231", 1), "20200101");
  assert.equal(dateClause("20200101", "20201231"), "submittedDate:[202001010000+TO+202012312359]");
});

// --- feed parsing ----------------------------------------------------------

const FEED = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>1342</opensearch:totalResults>
  <entry><id>http://arxiv.org/abs/2001.00001v2</id><published>2020-01-03T00:00:00Z</published></entry>
  <entry><id>https://arxiv.org/abs/cs/0501001v1</id><published>2020-01-09T00:00:00Z</published></entry>
</feed>`;

const ERROR_FEED = `<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry><id>https://arxiv.org/api/errors</id><title>Error</title></entry>
</feed>`;

test("feed parsing pulls the total, version-less ids and the cursor date", () => {
  assert.equal(totalOf(FEED), 1342);
  assert.deepEqual(idsOf(FEED), ["2001.00001", "cs/0501001"]);
  assert.equal(lastPublished(FEED), "20200109");
});

test("arXiv's 500 arrives as a well-formed feed and must not read as one result", () => {
  assert.equal(isErrorFeed(ERROR_FEED), true);
  assert.equal(isFeed(ERROR_FEED), false);
  assert.equal(isFeed(FEED), true);
  assert.equal(isFeed("<html>502 Bad Gateway</html>"), false);
  assert.equal(lastPublished(ERROR_FEED), null);
});
