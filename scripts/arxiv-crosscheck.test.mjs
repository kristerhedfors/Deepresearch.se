import assert from "node:assert/strict";
import test from "node:test";
import { bareId, diffByMonth, monthOf } from "./arxiv-crosscheck.mjs";

test("monthOf takes the month from the id prefix", () => {
  assert.equal(monthOf("2310.01234"), "2310");
  assert.equal(monthOf("2506.00001"), "2506");
  assert.equal(monthOf("cs/0503001"), "");
  assert.equal(monthOf(""), "");
});

const sets = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));

test("diffByMonth reports a per-month hole the totals would hide", () => {
  // The §10.2 shape: one month badly short, everything else complete, and the
  // OVERALL count close enough to look like agreement.
  const expected = sets({
    2310: ["2310.1", "2310.2", "2310.3", "2310.4"],
    2311: ["2311.1", "2311.2"],
  });
  const harvested = sets({
    2310: ["2310.1"],
    2311: ["2311.1", "2311.2"],
  });
  const rows = diffByMonth(harvested, expected);
  const oct = rows.find((r) => r.month === "2310");
  assert.equal(oct.missing, 3);
  assert.equal(oct.coverage, 25);
  const nov = rows.find((r) => r.month === "2311");
  assert.equal(nov.missing, 0);
  assert.equal(nov.coverage, 100);
});

test("diffByMonth counts ids, not records", () => {
  // A paper revised in-window appears in several shards; the harvest's own
  // "kept" counter double-counts it, a set does not.
  const rows = diffByMonth(sets({ 2401: ["2401.1", "2401.1", "2401.2"] }), sets({ 2401: ["2401.1", "2401.2"] }));
  assert.equal(rows[0].harvested, 2);
  assert.equal(rows[0].missing, 0);
});

test("diffByMonth surfaces ids the enumeration does not list", () => {
  // Normal in small numbers at the leading edge (the PDF mirror lags a new
  // submission); a large `extra` means the two sides disagree about the window.
  const rows = diffByMonth(sets({ 2607: ["2607.1", "2607.2"] }), sets({ 2607: ["2607.1"] }));
  assert.equal(rows[0].extra, 1);
  assert.equal(rows[0].coverage, 100);
});

test("diffByMonth reports a month present in only one side", () => {
  const rows = diffByMonth(sets({}), sets({ 2310: ["2310.1", "2310.2"] }));
  assert.equal(rows[0].harvested, 0);
  assert.equal(rows[0].missing, 2);
  assert.equal(rows[0].coverage, 0);
});

test("bareId strips the version suffix the mirror listing carries", () => {
  // gcs-*.txt lines look like "2507.23787v2"; harvested records and
  // listShard() keys look like "2507.23787". Comparing them unnormalised makes
  // the sets disjoint and reports total failure.
  assert.equal(bareId("2507.23787v2"), "2507.23787");
  assert.equal(bareId("2310.00001v12"), "2310.00001");
  assert.equal(bareId("2310.00001"), "2310.00001");
  assert.equal(bareId(" 2401.5v1 "), "2401.5");
  assert.equal(bareId(null), "");
});

test("diffByMonth matches across the two id spellings once normalised", () => {
  const rows = diffByMonth(
    new Map([["2311", new Set(["2311.1", "2311.2"].map(bareId))]]),
    new Map([["2311", new Set(["2311.1v2", "2311.2v1"].map(bareId))]]),
  );
  assert.equal(rows[0].missing, 0);
  assert.equal(rows[0].extra, 0);
  assert.equal(rows[0].coverage, 100);
});
