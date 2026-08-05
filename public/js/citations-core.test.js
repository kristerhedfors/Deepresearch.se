// Covers public/js/citations-core.js: the deterministic reconciliation of an
// answer's [n] markers against the numbered registry that produced it.
//
// Nothing in either tier did this before. markdown.js extracts [n] to build
// anchors and silently leaves an unknown bracket as plain text, so a citation
// pointing at a source that does not exist reached the reader unremarked —
// and indistinguishable, to them, from a fabricated one.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { citationAudit, citationNote, citationNumbers, splitSourcesTail } from "./citations-core.js";

const REGISTRY = [{ n: 1 }, { n: 2 }, { n: 3 }];

describe("splitSourcesTail", () => {
  test("splits the claim-making prose from the list that backs it", () => {
    const { body, tail } = splitSourcesTail("Claim [1].\n\nSources:\n[1] A — https://a.se");
    assert.equal(body.trim(), "Claim [1].");
    assert.match(tail, /^\nSources:/);
  });

  test("recognises the heading decorations models actually write, in both languages", () => {
    for (const h of ["Sources:", "### Sources:", "**Sources:**", "## Sources", "Källor:", "### Källor:"]) {
      const { tail } = splitSourcesTail(`Claim [1].\n\n${h}\n- [1] A — https://a.se`);
      assert.ok(tail.includes("[1] A"), `did not split on ${h}`);
    }
  });

  test("an answer that discusses sources mid-text still splits at the list", () => {
    const { body, tail } = splitSourcesTail(
      "We weighed the sources: two disagreed [1][2].\n\nSources:\n[1] A — u\n[2] B — u",
    );
    assert.ok(body.includes("two disagreed"), "the mid-text mention is not the split point");
    assert.ok(tail.includes("[2] B"));
  });

  test("no list at all leaves the whole text as body", () => {
    const { body, tail } = splitSourcesTail("Just prose [1].");
    assert.equal(body, "Just prose [1].");
    assert.equal(tail, "");
  });

  test("is total — null and undefined do not throw", () => {
    assert.deepEqual(splitSourcesTail(null), { body: "", tail: "" });
    assert.deepEqual(splitSourcesTail(undefined), { body: "", tail: "" });
  });
});

describe("citationNumbers", () => {
  test("collects distinct markers in ascending order", () => {
    assert.deepEqual(citationNumbers("a [3] b [1] c [3] d [12]"), [1, 3, 12]);
  });
  test("ignores brackets that are not plain numbers", () => {
    assert.deepEqual(citationNumbers("[citation needed] [källa behövs] [a1] []"), []);
  });
  test("returns an empty list for junk input rather than throwing", () => {
    assert.deepEqual(citationNumbers(null), []);
  });
});

describe("citationAudit", () => {
  const ANSWER = "Claim one [1]. Claim two [2].\n\nSources:\n[1] A — https://a.se\n[2] B — https://b.se";

  test("a clean answer has nothing dangling", () => {
    const a = citationAudit(ANSWER, REGISTRY);
    assert.deepEqual(a.cited, [1, 2]);
    assert.deepEqual(a.dangling, []);
  });

  test("names a marker that points at a source which does not exist", () => {
    const a = citationAudit("Claim [7].\n\nSources:\n[1] A — u", REGISTRY);
    assert.deepEqual(a.dangling, [7], "the reader cannot follow [7], and nor can anyone checking it");
  });

  test("counts retrieved-but-uncited sources without calling them an error", () => {
    // Not a defect: the diversity cap and the digest bound both mean some
    // sources legitimately go uncited. It is the retrieval-efficiency number.
    assert.deepEqual(citationAudit(ANSWER, REGISTRY).unused, [3]);
  });

  test("reads the printed list separately, so citing [7] without listing it is visible", () => {
    const a = citationAudit("Claim [1] and [7].\n\nSources:\n[1] A — u", REGISTRY);
    assert.deepEqual(a.cited, [1, 7]);
    assert.deepEqual(a.listed, [1]);
  });

  test("markers inside the source list are not counted as claims", () => {
    assert.deepEqual(citationAudit("No claims here.\n\nSources:\n[1] A — u\n[2] B — u", REGISTRY).cited, []);
  });

  test("an empty registry makes every citation dangling, and does not throw", () => {
    assert.deepEqual(citationAudit("Claim [1].", []).dangling, [1]);
    assert.deepEqual(citationAudit("Claim [1].", null).dangling, [1]);
    assert.deepEqual(citationAudit("", REGISTRY).cited, []);
  });
});

describe("citationNote", () => {
  test("is empty when there is nothing to say, so a clean prompt is unchanged", () => {
    assert.equal(citationNote({ dangling: [] }), "");
    assert.equal(citationNote(null), "");
  });

  test("names the offending numbers so the fact-checker is not asked to find them", () => {
    const note = citationNote({ dangling: [4, 9] });
    assert.match(note, /\[4\], \[9\]/);
    assert.match(note, /NOT in the numbered source list/);
    assert.ok(note.endsWith("\n\n"), "it is a prompt block, so it terminates cleanly");
  });

  test("agrees with itself in number", () => {
    assert.match(citationNote({ dangling: [4] }), /\[4\], which is NOT/);
    assert.match(citationNote({ dangling: [4, 5] }), /which are NOT/);
  });
});
