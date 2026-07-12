// The panel-SELECTION board's pure logic (src/panels.js): the catalog (one
// entry per admin panel; array order is the default view order + the vote
// tiebreak), the votes-driven FOCUS ordering (this board sets no explicit
// priority — it reshapes purely on ▲/▼), review-patch/vote validation (shared
// with the other boards via src/board.js), and the ?format=text rendering the
// attention loop reads.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PANEL_ITEMS,
  REVIEW_CAPS,
  ORDER_MODES,
  findPanelItem,
  projectPanelItem,
  orderPanelItems,
  validateReviewPatch,
  validateVote,
  formatPanelsText,
} from "./panels.js";
import { BOARD_CAPS, validateBoardPatch, validateBoardVote } from "./board.js";

// ---- catalog shape ----------------------------------------------------------

test("catalog: unique lowercase ids, non-empty title + real summary", () => {
  const ids = new Set();
  for (const it of PANEL_ITEMS) {
    assert.match(it.id, /^[a-z_]+$/, `id ${it.id} is a lowercase slug (matches data-panel)`);
    assert.ok(!ids.has(it.id), `duplicate id ${it.id}`);
    ids.add(it.id);
    assert.ok(it.title.trim().length > 0, `${it.id} title`);
    assert.ok(it.summary.trim().length > 40, `${it.id} summary should be a real description`);
  }
});

test("catalog: covers the admin surfaces the panel headers expose", () => {
  const ids = PANEL_ITEMS.map((i) => i.id);
  for (const expected of ["alerts", "usage", "models", "users", "security", "features", "config"]) {
    assert.ok(ids.includes(expected), `panel ${expected} present`);
  }
});

test("findPanelItem: hit and miss", () => {
  assert.equal(findPanelItem("users")?.id, "users");
  assert.equal(findPanelItem("nope"), null);
});

// ---- façade discipline (the board core is the one implementation) -----------

test("validators ARE the shared board core, not a copy", () => {
  assert.equal(validateReviewPatch, validateBoardPatch);
  assert.equal(validateVote, validateBoardVote);
  assert.equal(REVIEW_CAPS, BOARD_CAPS); // the caps object is re-exported, not copied
});

// ---- projection -------------------------------------------------------------

test("projectPanelItem: defaults without a review row, merged with one", () => {
  const item = PANEL_ITEMS[0];
  const bare = projectPanelItem(item, undefined, 0);
  assert.equal(bare.votes, 0);
  assert.equal(bare.note, null);
  assert.equal(bare.status, "open"); // panels are always live (open) — no closed notion
  assert.equal(bare.register_order, 0);

  const merged = projectPanelItem(
    item,
    { item_id: item.id, votes: 4, score: null, note: "focus here", priority: null, updated_at: 7 },
    3,
  );
  assert.equal(merged.votes, 4);
  assert.equal(merged.note, "focus here");
  assert.equal(merged.register_order, 3);
  assert.equal(merged.reviewed_at, 7);
});

// ---- ordering (votes-driven; NO explicit priority on this board) ------------

/** Minimal projected panel for ordering tests. */
const proj = (id, order, over = {}) => ({
  id,
  status: "open",
  votes: 0,
  priority: null,
  register_order: order,
  ...over,
});

test("focus order: highest net votes first, catalog order as tiebreak", () => {
  const items = [
    proj("a", 0, { votes: 1 }),
    proj("b", 1, { votes: 3 }),
    proj("c", 2, { votes: 1 }),
    proj("d", 3, { votes: -2 }),
  ];
  const ids = orderPanelItems(items, "focus").map((i) => i.id);
  // b (3) first; a & c tie at 1 → catalog order (a before c); d (-2) last.
  assert.deepEqual(ids, ["b", "a", "c", "d"]);
});

test("focus order: an unvoted board renders in the authored catalog order", () => {
  const items = PANEL_ITEMS.map((it, idx) => projectPanelItem(it, undefined, idx));
  const ids = orderPanelItems(items, "focus").map((i) => i.id);
  assert.deepEqual(ids, PANEL_ITEMS.map((i) => i.id));
});

test("default order: authored catalog order, votes ignored", () => {
  const items = [
    proj("a", 0, { votes: -5 }),
    proj("b", 1, { votes: 9 }),
    proj("c", 2, { votes: 1 }),
  ];
  const ids = orderPanelItems(items, "default").map((i) => i.id);
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("orderPanelItems returns a new array (input untouched)", () => {
  const items = [proj("b", 1), proj("a", 0)];
  const out = orderPanelItems(items, "default");
  assert.notEqual(out, items);
  assert.equal(items[0].id, "b");
});

test("ORDER_MODES are focus + default", () => {
  assert.deepEqual(ORDER_MODES, ["focus", "default"]);
});

// ---- validation (delegated to the board core) -------------------------------

test("validateReviewPatch: accepts a note, trims and caps", () => {
  const v = validateReviewPatch({ note: "  working accounts today  " });
  assert.equal(v.error, undefined);
  assert.equal(v.patch.note, "working accounts today");
});

test("validateVote: up/down only", () => {
  assert.equal(validateVote({ dir: "up" }).delta, 1);
  assert.equal(validateVote({ dir: "down" }).delta, -1);
  assert.ok(validateVote({ dir: "meh" }).error);
});

// ---- text rendering (the attention loop's input) ----------------------------

test("formatPanelsText: panels numbered in focus order, muted flag + notes", () => {
  const items = [
    { ...proj("users", 3, { votes: 2 }), title: "Users", summary: "accounts view", note: "focus here" },
    { ...proj("config", 6, { votes: 0 }), title: "Configuration", summary: "site config", note: null },
    { ...proj("models", 2, { votes: -3 }), title: "Usage by model", summary: "per-model cost", note: null },
  ];
  const text = formatPanelsText(items);
  assert.match(text, /ATTENTION loop/);
  assert.match(text, /1\. users votes=2 — Users/);
  assert.match(text, /ADMIN NOTE: focus here/);
  assert.match(text, /3\. models votes=-3 \(muted\) — Usage by model/);
  assert.ok(text.indexOf("users") < text.indexOf("config"), "renders in the order given");
});

test("formatPanelsText: renders every catalog panel from an unvoted board", () => {
  const projected = PANEL_ITEMS.map((it, idx) => projectPanelItem(it, undefined, idx));
  const text = formatPanelsText(orderPanelItems(projected, "focus"));
  for (const it of PANEL_ITEMS) {
    assert.ok(text.includes(it.id), `${it.id} missing from text output`);
  }
});
