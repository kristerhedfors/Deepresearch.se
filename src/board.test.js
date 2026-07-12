// The decision-board core (src/board.js): choice-state validation, the two
// orderings (admin work order vs documented rank), reviewState defaults, the
// D1 review-row helpers' SQL shape, and the façade contract — a board's
// re-exported pure surface must BE this core, not a mirror (the bash-agent
// precedent).

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOARD_CAPS,
  validateBoardPatch,
  validateBoardVote,
  orderBoardItems,
  reviewState,
  loadBoardReviews,
  getBoardReview,
  voteBoardRow,
  patchBoardRow,
} from "./board.js";
import * as security from "./security-risks.js";

// ---- façade contract --------------------------------------------------------

test("security board's pure surface IS the core (re-export, not a copy)", () => {
  assert.equal(security.REVIEW_CAPS, BOARD_CAPS);
  assert.equal(security.validateReviewPatch, validateBoardPatch);
  assert.equal(security.validateVote, validateBoardVote);
});

// ---- ordering ---------------------------------------------------------------

const it = (id, over = {}) => ({ id, status: "open", priority: null, votes: 0, rank: 1, ...over });
const rankOf = (i) => i.rank;

test("priority mode: explicit priority is the fixed order, ahead of votes/rank", () => {
  const items = [
    it("a", { votes: 99, rank: 0 }),
    it("b", { priority: 2 }),
    it("c", { priority: 1, rank: 9 }),
  ];
  assert.deepEqual(orderBoardItems(items, "priority", rankOf).map((i) => i.id), ["c", "b", "a"]);
});

test("priority mode: unprioritized ranked by votes desc, then rankOf asc", () => {
  const items = [it("a", { rank: 2 }), it("b", { votes: 3, rank: 2 }), it("c", { rank: 0 })];
  assert.deepEqual(orderBoardItems(items, "priority", rankOf).map((i) => i.id), ["b", "c", "a"]);
});

test("both modes: non-open items sink; ties keep input (catalog) order", () => {
  const items = [
    it("done", { status: "fixed", priority: 1 }),
    it("a"),
    it("b"), // tie with a on every key -> stable sort keeps a before b
  ];
  assert.deepEqual(orderBoardItems(items, "priority", rankOf).map((i) => i.id), ["a", "b", "done"]);
  assert.deepEqual(orderBoardItems(items, "rank", rankOf).map((i) => i.id), ["a", "b", "done"]);
});

test("rank mode ignores votes and priority; input array untouched", () => {
  const items = [it("a", { rank: 5 }), it("b", { votes: 9, priority: 1, rank: 7 })];
  const out = orderBoardItems(items, "rank", rankOf);
  assert.deepEqual(out.map((i) => i.id), ["a", "b"]);
  assert.notEqual(out, items);
  assert.equal(items[0].id, "a");
});

// ---- validation & projection --------------------------------------------------

test("validateBoardPatch: trims, caps, clears on null/empty, rejects bad priority", () => {
  const v = validateBoardPatch({ score: "  CVSS 9.8  ", note: "x".repeat(BOARD_CAPS.note + 5), priority: 7 });
  assert.equal(v.error, undefined);
  assert.equal(v.patch.score, "CVSS 9.8");
  assert.equal(v.patch.note.length, BOARD_CAPS.note);
  assert.equal(v.patch.priority, 7);
  assert.equal(validateBoardPatch({ priority: "" }).patch.priority, null);
  for (const bad of [{ priority: 0 }, { priority: 2.5 }, { priority: 1000 }, {}, null, "x"]) {
    assert.ok(validateBoardPatch(bad).error, JSON.stringify(bad));
  }
});

test("validateBoardVote: up/down only", () => {
  assert.equal(validateBoardVote({ dir: "up" }).delta, 1);
  assert.equal(validateBoardVote({ dir: "down" }).delta, -1);
  assert.ok(validateBoardVote({ dir: "left" }).error);
});

test("reviewState: defaults without a row, values with one", () => {
  assert.deepEqual(reviewState(undefined), { votes: 0, score: null, note: null, priority: null, reviewed_at: null });
  assert.deepEqual(
    reviewState({ item_id: "x", votes: 2, score: "s", note: "n", priority: 1, updated_at: 42 }),
    { votes: 2, score: "s", note: "n", priority: 1, reviewed_at: 42 },
  );
});

// ---- D1 helpers: SQL shape against a recording stub ---------------------------

function stubDb() {
  const calls = [];
  const db = {
    prepare(sql) {
      const call = { sql, binds: [] };
      calls.push(call);
      return {
        bind(...args) { call.binds = args; return this; },
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [{ item_id: "a", votes: 1, updated_at: 1 }] }),
      };
    },
  };
  return { db, calls };
}

test("loadBoardReviews/getBoardReview target the given table", async () => {
  const { db, calls } = stubDb();
  const map = await loadBoardReviews(db, "feature_reviews");
  assert.equal(map.get("a")?.votes, 1);
  await getBoardReview(db, "feature_reviews", "a");
  assert.match(calls[0].sql, /FROM feature_reviews/);
  assert.match(calls[1].sql, /FROM feature_reviews WHERE item_id = \?/);
  assert.deepEqual(calls[1].binds, ["a"]);
});

test("voteBoardRow: upsert increments votes", async () => {
  const { db, calls } = stubDb();
  await voteBoardRow(db, "t_reviews", "a", -1);
  assert.match(calls[0].sql, /INSERT INTO t_reviews/);
  assert.match(calls[0].sql, /ON CONFLICT\(item_id\) DO UPDATE SET votes = votes \+ \?/);
  assert.equal(calls[0].binds[0], "a");
  assert.equal(calls[0].binds[1], -1);
});

test("patchBoardRow: only present fields in the UPDATE arm; absent fields NULL on insert", async () => {
  const { db, calls } = stubDb();
  await patchBoardRow(db, "t_reviews", "a", { note: "hello" });
  const { sql, binds } = calls[0];
  assert.match(sql, /DO UPDATE SET updated_at = \?, note = \?/);
  assert.ok(!/DO UPDATE SET.*score/.test(sql), "untouched fields must not be clobbered");
  // VALUES(item_id, 0, score, note, priority, updated_at) then SET binds
  assert.equal(binds[0], "a");
  assert.equal(binds[1], null); // score -> NULL on fresh insert
  assert.equal(binds[2], "hello");
  assert.equal(binds[3], null); // priority -> NULL on fresh insert
  assert.equal(binds[5 + 1], "hello"); // the SET arm's note bind
});
