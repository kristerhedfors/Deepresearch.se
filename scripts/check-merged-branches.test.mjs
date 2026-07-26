// The ledger parser had two silent blind spots, both found on 2026-07-26 while
// merging the open-PR queue: it required the sha cell to be BARE and the
// verdict cell to be UNBOLDED, but §1 — the confirmed-verdict section the
// guard's own precedence rule names as the one that wins — writes both in
// backticks and bold. So §1 parsed to nothing and the guard silently watched
// only §2/§3: 68 branches instead of 86.
//
// Nothing failed. The guard printed "✓ No one has pushed to a merged branch"
// while two branches in §1 had in fact been built on. A guard that reports
// clean because it read none of the rows is worse than no guard, so the parse
// itself is pinned here.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLedger } from "./check-merged-branches.mjs";

const LEDGER = join(import.meta.dirname, "..", "docs", "MERGED-BRANCHES.md");

test("parseLedger reads a §1 row: backticked sha, bolded verdict", () => {
  const rows = parseLedger(
    "| `claude/some-branch` | `d4fb32d5` | **Merged** | landed via PR #277. |\n",
  );
  assert.deepEqual(rows, [{ branch: "claude/some-branch", sha: "d4fb32d5", verdict: "Merged" }]);
});

test("parseLedger reads a §2/§3 row: bare sha, plain verdict", () => {
  const rows = parseLedger("| `claude/other-branch` | 9084844 | Superseded? | heuristic. |\n");
  assert.deepEqual(rows, [
    { branch: "claude/other-branch", sha: "9084844", verdict: "Superseded?" },
  ]);
});

test("the FIRST row for a branch wins, so a §1 verdict beats the §3 guess", () => {
  const rows = parseLedger(
    "| `claude/dup` | `aaaaaaa` | **Merged** | §1, confirmed. |\n" +
      "| `claude/dup` | bbbbbbb | Superseded? | §3, a guess. |\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sha, "aaaaaaa");
  assert.equal(rows[0].verdict, "Merged");
});

test("the real ledger's §1 rows are visible to the guard", () => {
  // The regression itself: assert against the committed ledger, so a future
  // formatting change to §1 that the parser cannot read fails here rather than
  // quietly shrinking what the guard watches.
  const rows = parseLedger(readFileSync(LEDGER, "utf8"));
  const byBranch = new Map(rows.map((r) => [r.branch, r]));

  // §1 carried 19 Merged rows when this was written and only grows. The bar is
  // set well below that: the failure being guarded against is the count
  // collapsing toward zero, which is what the unreadable-§1 bug did.
  const merged = rows.filter((r) => /^merged/i.test(r.verdict));
  assert.ok(
    merged.length >= 15,
    `only ${merged.length} rows parsed with a Merged verdict — §1 is probably unreadable again`,
  );

  // A row known to live in §1 with both the backticked sha and the bold verdict.
  const known = byBranch.get("claude/parallel-subagent-feedback-oqpv0t");
  assert.ok(known, "the PR #277 row (§1) did not parse");
  assert.equal(known.verdict, "Merged");
  assert.match(known.sha, /^[0-9a-f]{7,40}$/);
});
