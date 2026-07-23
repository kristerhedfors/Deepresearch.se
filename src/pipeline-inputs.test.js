// Unit tests for pipeline-inputs.js — the pure input-block builders and output
// parsers extracted out of pipeline.js. (collectConflicts is covered in
// pipeline.test.js, which imports it from here.)
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  shellReplyMessages,
  notesSection,
  subquestionsSection,
  conflictsSection,
  extractClaims,
  mergeFanoutQueries,
  takeSearchBatch,
} from "./pipeline-inputs.js";

describe("shellReplyMessages", () => {
  test("empty block → no message (byte-identical to no-sandbox run)", () => {
    assert.deepEqual(shellReplyMessages(""), []);
  });

  test("wraps a transcript as a ground-truth system message", () => {
    const out = shellReplyMessages("$ ls\nfile.txt");
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "system");
    assert.match(out[0].content, /^\$ ls\nfile\.txt/);
    assert.match(out[0].content, /ground truth/);
  });
});

describe("notesSection", () => {
  test("empty when there are no notes", () => {
    assert.equal(notesSection(undefined), "");
    assert.equal(notesSection([]), "");
  });

  test("renders a labeled block when notes exist", () => {
    const out = notesSection([{ claim: "X is true", source_ids: [1] }]);
    assert.match(out, /Distilled research notes so far:/);
  });
});

describe("subquestionsSection", () => {
  test("empty (absent) with no decomposition", () => {
    assert.equal(subquestionsSection(undefined), "");
    assert.equal(subquestionsSection([]), "");
    assert.equal(subquestionsSection([""]), "");
  });

  test("numbers each sub-question", () => {
    const out = subquestionsSection(["What?", "Why?"]);
    assert.match(out, /1\. What\?/);
    assert.match(out, /2\. Why\?/);
  });
});

describe("conflictsSection", () => {
  test("empty (absent) with no conflicts", () => {
    assert.equal(conflictsSection(undefined), "");
    assert.equal(conflictsSection([]), "");
  });

  test("bullets each conflict with the address-both-sides instruction", () => {
    const out = conflictsSection(["A says 5, B says 7"]);
    assert.match(out, /address each explicitly/);
    assert.match(out, /- A says 5, B says 7/);
  });
});

describe("extractClaims", () => {
  test("accepts {claims:[…]} and a bare array; junk yields []", () => {
    assert.deepEqual(extractClaims(null), []);
    assert.deepEqual(extractClaims({}), []);
    assert.deepEqual(extractClaims("nope"), []);
    assert.deepEqual(
      extractClaims({ claims: [{ claim: "c", source_ids: [1, 2] }] }),
      [{ claim: "c", source_ids: [1, 2] }],
    );
    assert.deepEqual(extractClaims([{ claim: "c", source_ids: [] }]), [{ claim: "c", source_ids: [] }]);
  });

  test("drops empty claims and coerces / filters source ids to positive ints", () => {
    const out = extractClaims([
      { claim: "  ", source_ids: [1] },
      { claim: "keep", source_ids: [1, "3", 0, -2, 4.9, "x"] },
    ]);
    assert.deepEqual(out, [{ claim: "keep", source_ids: [1, 3, 4] }]);
  });

  test("caps at 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ claim: "c" + i, source_ids: [] }));
    assert.equal(extractClaims(many).length, 12);
  });
});

describe("takeSearchBatch", () => {
  const makeState = () => ({ ranQueries: new Set(), searchCount: 0, plan: { maxSearches: 3 } });

  test("trims, drops blanks, and marks queries as run", () => {
    const state = makeState();
    const batch = takeSearchBatch(state, ["  a ", "", "b"]);
    assert.deepEqual(batch, ["a", "b"]);
    assert.ok(state.ranQueries.has("a"));
    assert.ok(state.ranQueries.has("b"));
  });

  test("dedupes case-insensitively against already-run queries", () => {
    const state = makeState();
    state.ranQueries.add("a");
    assert.deepEqual(takeSearchBatch(state, ["A", "c"]), ["c"]);
  });

  test("never overruns plan.maxSearches (counting prior searches)", () => {
    const state = makeState();
    state.searchCount = 2; // one slot left
    assert.deepEqual(takeSearchBatch(state, ["a", "b", "c"]), ["a"]);
  });
});

describe("mergeFanoutQueries", () => {
  test("round-robin: every sub-question's first pick lands before any second pick", () => {
    const merged = mergeFanoutQueries([["a1", "a2"], ["b1", "b2"], ["c1"]], 10);
    assert.deepEqual(merged, ["a1", "b1", "c1", "a2", "b2"]);
  });

  test("the cap cuts the interleaved order, not the last list", () => {
    // With cap 3 a verbose first audit must not take the third slot from the
    // third sub-question — the round-robin order is the fairness rule.
    assert.deepEqual(mergeFanoutQueries([["a1", "a2", "a3"], ["b1"], ["c1"]], 3), ["a1", "b1", "c1"]);
  });

  test("dedupes case-insensitively across lists and trims", () => {
    const merged = mergeFanoutQueries([[" EU AI Act ", "x"], ["eu ai act", "y"]], 10);
    assert.deepEqual(merged, ["EU AI Act", "x", "y"]);
  });

  test("non-arrays, non-strings, and blanks contribute nothing", () => {
    const merged = mergeFanoutQueries([null, undefined, ["", "  ", 42, "real"], []], 10);
    assert.deepEqual(merged, ["real"]);
  });

  test("zero cap → empty wave", () => {
    assert.deepEqual(mergeFanoutQueries([["a"]], 0), []);
  });
});
