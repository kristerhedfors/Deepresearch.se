// The features/priority review board's pure logic (src/features.js): catalog
// shape (it must stay a faithful mirror of FEATURES.md §3), the two orderings
// (the admin-priority BUILD order vs documented impact), review-patch/vote
// validation (shared with the security board via src/board.js), and the
// ?format=text rendering the feature loop reads.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FEATURE_ITEMS,
  REVIEW_CAPS,
  findFeatureItem,
  projectFeatureItem,
  orderFeatureItems,
  validateReviewPatch,
  validateVote,
  formatFeaturesText,
} from "./features.js";
import { validateBoardPatch, validateBoardVote } from "./board.js";

// ---- catalog shape ----------------------------------------------------------

test("catalog: unique F-ids, valid impacts/statuses, non-empty text", () => {
  const ids = new Set();
  for (const it of FEATURE_ITEMS) {
    assert.match(it.id, /^F-\d+$/, `id ${it.id}`);
    assert.ok(!ids.has(it.id), `duplicate id ${it.id}`);
    ids.add(it.id);
    assert.ok(["high", "medium", "low"].includes(it.impact), `${it.id} impact`);
    assert.ok(["open", "shipped", "dropped"].includes(it.status), `${it.id} status`);
    assert.ok(it.title.trim().length > 0, `${it.id} title`);
    assert.ok(it.summary.trim().length > 40, `${it.id} summary should be a real description`);
  }
});

test("catalog: F-1..F-N are present in register order", () => {
  const ids = FEATURE_ITEMS.map((i) => i.id);
  assert.deepEqual(
    ids,
    Array.from({ length: ids.length }, (_, n) => `F-${n + 1}`),
    "array order must equal the register's §3 order",
  );
  assert.ok(ids.includes("F-1"));
});

test("catalog: at least one open item (the loop needs work to do)", () => {
  assert.ok(FEATURE_ITEMS.some((i) => i.status === "open"), "some feature is planned");
});

test("findFeatureItem: hit and miss", () => {
  assert.equal(findFeatureItem("F-1")?.id, "F-1");
  assert.equal(findFeatureItem("F-999"), null);
  assert.equal(findFeatureItem("x"), null);
});

// ---- façade discipline (the board core is the one implementation) -----------

test("validators ARE the shared board core, not a copy", () => {
  assert.equal(validateReviewPatch, validateBoardPatch);
  assert.equal(validateVote, validateBoardVote);
});

// ---- projection -------------------------------------------------------------

test("projectFeatureItem: defaults without a review row, merged with one", () => {
  const item = FEATURE_ITEMS[0];
  const bare = projectFeatureItem(item, undefined, 0);
  assert.equal(bare.votes, 0);
  assert.equal(bare.score, null);
  assert.equal(bare.priority, null);
  assert.equal(bare.register_order, 0);
  assert.equal(bare.impact, item.impact);

  const merged = projectFeatureItem(
    item,
    { item_id: item.id, votes: 3, score: "~2 days", note: "n", priority: 2, updated_at: 5 },
    0,
  );
  assert.equal(merged.votes, 3);
  assert.equal(merged.score, "~2 days");
  assert.equal(merged.priority, 2);
  assert.equal(merged.reviewed_at, 5);
});

// ---- ordering ---------------------------------------------------------------

/** Minimal projected item for ordering tests. */
const proj = (id, over = {}) => ({
  id,
  impact: "medium",
  status: "open",
  votes: 0,
  priority: null,
  register_order: Number(id.slice(2)) - 1,
  ...over,
});

test("priority order: admin-prioritized items come first, ascending", () => {
  const items = [
    proj("F-1"),
    proj("F-2", { priority: 2 }),
    proj("F-3", { priority: 1 }),
    proj("F-4"),
  ];
  const ids = orderFeatureItems(items, "priority").map((i) => i.id);
  assert.deepEqual(ids.slice(0, 2), ["F-3", "F-2"], "explicit priority is the fixed build order");
});

test("priority order: unprioritized ranked by votes, then impact, then register order", () => {
  const items = [
    proj("F-1", { impact: "low" }),
    proj("F-2", { votes: 5, impact: "low" }),
    proj("F-3", { impact: "high" }),
    proj("F-4", { impact: "high" }),
  ];
  const ids = orderFeatureItems(items, "priority").map((i) => i.id);
  assert.deepEqual(ids, ["F-2", "F-3", "F-4", "F-1"]);
});

test("priority order: shipped/dropped items sink below open ones regardless of priority", () => {
  const items = [
    proj("F-1", { status: "shipped", priority: 1 }),
    proj("F-2"),
    proj("F-3", { status: "dropped", priority: 2 }),
  ];
  const ids = orderFeatureItems(items, "priority").map((i) => i.id);
  assert.deepEqual(ids, ["F-2", "F-1", "F-3"]);
});

test("impact order: documented impact then register order; votes/priority ignored", () => {
  const items = [
    proj("F-1", { impact: "low", votes: 99, priority: 1 }),
    proj("F-2", { impact: "medium" }),
    proj("F-3", { impact: "high" }),
    proj("F-4", { impact: "medium" }),
  ];
  const ids = orderFeatureItems(items, "impact").map((i) => i.id);
  assert.deepEqual(ids, ["F-3", "F-2", "F-4", "F-1"]);
});

test("orderFeatureItems returns a new array (input untouched)", () => {
  const items = [proj("F-2"), proj("F-1")];
  const out = orderFeatureItems(items, "impact");
  assert.notEqual(out, items);
  assert.equal(items[0].id, "F-2");
});

// ---- validation (delegated to the board core) -------------------------------

test("validateReviewPatch: accepts score(effort)/note/priority, trims and caps", () => {
  const v = validateReviewPatch({
    score: "  ~3 days  ",
    note: "x".repeat(REVIEW_CAPS.note + 100),
    priority: 3,
  });
  assert.equal(v.error, undefined);
  assert.equal(v.patch.score, "~3 days");
  assert.equal(v.patch.note.length, REVIEW_CAPS.note);
  assert.equal(v.patch.priority, 3);
});

test("validateVote: up/down only", () => {
  assert.equal(validateVote({ dir: "up" }).delta, 1);
  assert.equal(validateVote({ dir: "down" }).delta, -1);
  assert.ok(validateVote({ dir: "sideways" }).error);
});

// ---- text rendering (the build loop's input) --------------------------------

test("formatFeaturesText: open items numbered in given order, effort/notes shown, closed as tail", () => {
  const items = [
    { ...proj("F-3", { impact: "high", votes: 2, priority: 1 }), title: "T3", summary: "S3", score: "~2 days", note: "do first" },
    { ...proj("F-1"), title: "T1", summary: "S1", score: null, note: null },
    { ...proj("F-2", { status: "shipped" }), title: "T2", summary: "S2", score: null, note: null },
  ];
  const text = formatFeaturesText(items);
  assert.match(text, /1\. F-3 \[high\] \(admin priority 1\) votes=2 effort=~2 days — T3/);
  assert.match(text, /ADMIN NOTE: do first/);
  assert.match(text, /2\. F-1 /);
  assert.match(text, /Shipped\/dropped: F-2 \[shipped\]/);
  assert.ok(text.indexOf("F-3") < text.indexOf("F-1"), "renders in the order given");
});

test("formatFeaturesText: all-open register renders every open catalog item", () => {
  const projected = FEATURE_ITEMS.map((it, idx) => projectFeatureItem(it, undefined, idx));
  const text = formatFeaturesText(orderFeatureItems(projected, "priority"));
  for (const it of FEATURE_ITEMS.filter((i) => i.status === "open")) {
    assert.ok(text.includes(it.id), `${it.id} missing from text output`);
  }
});
