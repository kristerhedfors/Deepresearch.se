// The security-risk review board's pure logic (src/security-risks.js):
// catalog shape (it must stay a faithful mirror of SECURITY-RISKS.md §3),
// the two orderings (the admin-priority FIX order vs documented severity),
// review-patch/vote validation, and the ?format=text rendering the fix
// loop reads.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SECURITY_RISK_ITEMS,
  REVIEW_CAPS,
  findRiskItem,
  projectRiskItem,
  orderRiskItems,
  validateReviewPatch,
  validateVote,
  formatSecurityText,
} from "./security-risks.js";

// ---- catalog shape ----------------------------------------------------------

test("catalog: unique P-ids, valid severities/statuses, non-empty text", () => {
  const ids = new Set();
  for (const it of SECURITY_RISK_ITEMS) {
    assert.match(it.id, /^P-\d+$/, `id ${it.id}`);
    assert.ok(!ids.has(it.id), `duplicate id ${it.id}`);
    ids.add(it.id);
    assert.ok(["high", "medium", "low"].includes(it.severity), `${it.id} severity`);
    assert.ok(["open", "fixed", "accepted"].includes(it.status), `${it.id} status`);
    assert.ok(it.title.trim().length > 0, `${it.id} title`);
    assert.ok(it.summary.trim().length > 40, `${it.id} summary should be a real description`);
  }
});

test("catalog: the register's P-1..P-10 are present in register order", () => {
  const ids = SECURITY_RISK_ITEMS.map((i) => i.id);
  assert.deepEqual(
    ids,
    Array.from({ length: ids.length }, (_, n) => `P-${n + 1}`),
    "array order must equal the register's §3 order",
  );
  assert.ok(ids.includes("P-1") && ids.includes("P-10"));
});

test("findRiskItem: hit and miss", () => {
  assert.equal(findRiskItem("P-1")?.id, "P-1");
  assert.equal(findRiskItem("P-999"), null);
  assert.equal(findRiskItem("x"), null);
});

// ---- projection -------------------------------------------------------------

test("projectRiskItem: defaults without a review row, merged with one", () => {
  const item = SECURITY_RISK_ITEMS[0];
  const bare = projectRiskItem(item, undefined, 0);
  assert.equal(bare.votes, 0);
  assert.equal(bare.score, null);
  assert.equal(bare.priority, null);
  assert.equal(bare.register_order, 0);
  assert.equal(bare.recurring, true); // P-1 is the recurring key-caps duty

  const merged = projectRiskItem(
    item,
    { item_id: item.id, votes: 3, score: "CVSS 8.1", note: "n", priority: 2, updated_at: 5 },
    0,
  );
  assert.equal(merged.votes, 3);
  assert.equal(merged.score, "CVSS 8.1");
  assert.equal(merged.priority, 2);
  assert.equal(merged.reviewed_at, 5);
});

// ---- ordering ---------------------------------------------------------------

/** Minimal projected item for ordering tests. */
const proj = (id, over = {}) => ({
  id,
  severity: "medium",
  status: "open",
  votes: 0,
  priority: null,
  register_order: Number(id.slice(2)) - 1,
  ...over,
});

test("priority order: admin-prioritized items come first, ascending", () => {
  const items = [
    proj("P-1"),
    proj("P-2", { priority: 2 }),
    proj("P-3", { priority: 1 }),
    proj("P-4"),
  ];
  const ids = orderRiskItems(items, "priority").map((i) => i.id);
  assert.deepEqual(ids.slice(0, 2), ["P-3", "P-2"], "explicit priority is the fixed order");
});

test("priority order: unprioritized ranked by votes, then severity, then register order", () => {
  const items = [
    proj("P-1", { severity: "low" }),
    proj("P-2", { votes: 5, severity: "low" }),
    proj("P-3", { severity: "high" }),
    proj("P-4", { severity: "high" }),
  ];
  const ids = orderRiskItems(items, "priority").map((i) => i.id);
  assert.deepEqual(ids, ["P-2", "P-3", "P-4", "P-1"]);
});

test("priority order: non-open items sink below open ones regardless of priority", () => {
  const items = [
    proj("P-1", { status: "fixed", priority: 1 }),
    proj("P-2"),
  ];
  const ids = orderRiskItems(items, "priority").map((i) => i.id);
  assert.deepEqual(ids, ["P-2", "P-1"]);
});

test("severity order: documented severity then register order; votes/priority ignored", () => {
  const items = [
    proj("P-1", { severity: "low", votes: 99, priority: 1 }),
    proj("P-2", { severity: "medium" }),
    proj("P-3", { severity: "high" }),
    proj("P-4", { severity: "medium" }),
  ];
  const ids = orderRiskItems(items, "severity").map((i) => i.id);
  assert.deepEqual(ids, ["P-3", "P-2", "P-4", "P-1"]);
});

test("orderRiskItems returns a new array (input untouched)", () => {
  const items = [proj("P-2"), proj("P-1")];
  const out = orderRiskItems(items, "severity");
  assert.notEqual(out, items);
  assert.equal(items[0].id, "P-2");
});

// ---- validation -------------------------------------------------------------

test("validateReviewPatch: accepts score/note/priority, trims and caps", () => {
  const v = validateReviewPatch({
    score: "  CVSS 6.5  ",
    note: "x".repeat(REVIEW_CAPS.note + 100),
    priority: 3,
  });
  assert.equal(v.error, undefined);
  assert.equal(v.patch.score, "CVSS 6.5");
  assert.equal(v.patch.note.length, REVIEW_CAPS.note);
  assert.equal(v.patch.priority, 3);
});

test("validateReviewPatch: null/empty clears; only present fields patched", () => {
  const v = validateReviewPatch({ priority: null, score: "" });
  assert.equal(v.error, undefined);
  assert.equal(v.patch.priority, null);
  assert.equal(v.patch.score, null);
  assert.ok(!("note" in v.patch));
});

test("validateReviewPatch: rejects bad priority and empty patches", () => {
  assert.ok(validateReviewPatch({ priority: 0 }).error);
  assert.ok(validateReviewPatch({ priority: 1.5 }).error);
  assert.ok(validateReviewPatch({ priority: 1000 }).error);
  assert.ok(validateReviewPatch({ priority: "abc" }).error);
  assert.ok(validateReviewPatch({}).error);
  assert.ok(validateReviewPatch(null).error);
  assert.ok(validateReviewPatch("x").error);
});

test("validateVote: up/down only", () => {
  assert.equal(validateVote({ dir: "up" }).delta, 1);
  assert.equal(validateVote({ dir: "down" }).delta, -1);
  assert.ok(validateVote({ dir: "sideways" }).error);
  assert.ok(validateVote(null).error);
});

// ---- text rendering (the fix loop's input) ----------------------------------

test("formatSecurityText: open items numbered in given order, notes shown, closed as tail", () => {
  const items = [
    { ...proj("P-3", { severity: "high", votes: 2, priority: 1 }), title: "T3", summary: "S3", score: "CVSS 7", note: "do first" },
    { ...proj("P-1"), title: "T1", summary: "S1", score: null, note: null },
    { ...proj("P-2", { status: "fixed" }), title: "T2", summary: "S2", score: null, note: null },
  ];
  const text = formatSecurityText(items);
  assert.match(text, /1\. P-3 \[high\] \(admin priority 1\) votes=2 score=CVSS 7 — T3/);
  assert.match(text, /ADMIN NOTE: do first/);
  assert.match(text, /2\. P-1 /);
  assert.match(text, /Closed\/accepted: P-2 \[fixed\]/);
  assert.ok(text.indexOf("P-3") < text.indexOf("P-1"), "renders in the order given");
});

test("formatSecurityText: all-open register renders every catalog item", () => {
  const projected = SECURITY_RISK_ITEMS.map((it, idx) => projectRiskItem(it, undefined, idx));
  const text = formatSecurityText(orderRiskItems(projected, "priority"));
  for (const it of SECURITY_RISK_ITEMS.filter((i) => i.status === "open")) {
    assert.ok(text.includes(it.id), `${it.id} missing from text output`);
  }
});
