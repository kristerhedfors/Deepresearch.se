// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers source-digest.js DIRECTLY, at the module the pipeline's prompt
// budget actually depends on. The behavioural cases — the truncation marker,
// the clip-don't-drop rule, the verbose-early-sources regression from
// feedback #61 — stay in sources.test.js, which reaches them through the
// re-export and so pins that seam too. What is here is the max-min fairness
// PROPERTY of the share solver, which no test stated while it was a private
// function inside the registry module.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { digestShownCount, sourceDigest } from "./source-digest.js";
import { sourceDigest as viaRegistry } from "./sources.js";

const src = (n, tailChars) => ({
  n,
  title: `T${n}`,
  url: `https://ex.se/${n}`,
  highlights: [tailChars ? "h".repeat(tailChars) : ""].filter(Boolean),
});

describe("source-digest — the share solver is max-min fair", () => {
  test("a short source is never clipped to an equal split of the budget", () => {
    // Ten sources, one enormous. An equal 1/10 split would clip the nine
    // short ones to ~200 chars each; max-min fairness pays them what they
    // use and hands the slack to the monster. The regression this guards is
    // a solver that divides instead of water-fills.
    const sources = [src(1, 8000), ...Array.from({ length: 9 }, (_, i) => src(i + 2, 120))];
    const digest = sourceDigest(sources, 4000);
    for (let n = 2; n <= 10; n++) {
      assert.match(digest, new RegExp(`\\[${n}\\] T${n}\\n[^\\n]*\\n${"h".repeat(120)}`), `[${n}] kept its whole excerpt`);
    }
    assert.match(digest, /\[1\] T1/, "and the monster is still cited");
    assert.match(digest, /\[…\]/, "clipped rather than dropped");
    assert.ok(digest.length <= 4000);
  });

  test("the share chosen is the largest the budget can afford", () => {
    // Every source identical, so the fair share IS the per-source budget:
    // a solver that under-shoots leaves the window measurably unfilled.
    // (The builder reserves ~260 chars for a truncation marker it does not
    // end up needing here, so ~90% is the honest floor, not 100%.)
    const sources = Array.from({ length: 20 }, (_, i) => src(i + 1, 3000));
    const digest = sourceDigest(sources, 12_000);
    assert.equal(digestShownCount(sources, 12_000), 20, "all twenty stay citable");
    assert.ok(digest.length <= 12_000, "the cap is hard");
    assert.ok(digest.length > 12_000 * 0.9, `only filled ${digest.length}/12000 — the share under-shot`);
  });

  test("raising the cap never shows fewer sources or shortens the digest", () => {
    // Monotonicity is what an off-by-one in the binary search breaks, and it
    // breaks it at one cap in the middle of the range rather than everywhere.
    const sources = Array.from({ length: 25 }, (_, i) => src(i + 1, 200 + i * 300));
    let prevLen = -1;
    let prevShown = -1;
    for (let cap = 800; cap <= 30_000; cap += 137) {
      const shown = digestShownCount(sources, cap);
      const len = sourceDigest(sources, cap).length;
      assert.ok(len <= cap, `cap ${cap} exceeded (${len})`);
      assert.ok(shown >= prevShown, `cap ${cap} showed ${shown}, down from ${prevShown}`);
      if (shown === 25 && prevShown === 25) {
        assert.ok(len >= prevLen, `cap ${cap} produced a shorter digest (${len} < ${prevLen})`);
      }
      prevShown = shown;
      prevLen = len;
    }
  });
});

describe("source-digest — the registry re-export is the same function", () => {
  test("sources.js hands back this module's builder", () => {
    assert.equal(viaRegistry, sourceDigest);
  });
});
