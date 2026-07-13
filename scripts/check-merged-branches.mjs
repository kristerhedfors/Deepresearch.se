// Guard the "don't build on a merged branch" rule (see the merge-branches skill
// and docs/MERGED-BRANCHES.md).
//
//   node scripts/check-merged-branches.mjs
//
// The ledger (docs/MERGED-BRANCHES.md) records, for every branch already
// integrated into `main`, the tip SHA it was done at. A branch marked
// Merged / Superseded / Dropped is finished — nobody should push more commits
// to it. This script re-reads those recorded SHAs, fetches each branch's
// CURRENT remote tip, and flags any that have ADVANCED past what the ledger
// recorded: that means an agent kept working on a dead branch, which is the
// rule this whole mechanism exists to catch.
//
// Exit code: 0 = clean, 1 = at least one violation (so a hook/CI can gate on it).
// It never mutates anything — read-only over `git ls-remote`.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = process.env.MERGED_LEDGER || join(ROOT, "docs", "MERGED-BRANCHES.md");
const REMOTE = process.argv[2] || "origin";

// Verdicts that mean "this branch is DONE — no more commits".
const DONE = /^(merged|superseded|dropped)\b/i;

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

// Parse every markdown table row of the shape:
//   | `branch` | <sha> | ... | <verdict> | ... |
// keeping the FIRST occurrence of each branch (§1 confirmed verdicts win over
// the §3 heuristic inventory, since §1 is written first in the file).
function parseLedger(text) {
  const rows = new Map();
  const re = /^\|\s*`([^`]+)`\s*\|\s*([0-9a-f]{7,40})\s*\|(.*)\|\s*$/gim;
  let m;
  while ((m = re.exec(text))) {
    const branch = m[1].trim();
    if (rows.has(branch)) continue;
    const sha = m[2].trim();
    // The verdict is one of the remaining pipe-separated cells; find the first
    // that looks like a known verdict word.
    const cells = m[3].split("|").map((c) => c.trim());
    const verdict = cells.find((c) => /^(merged|superseded\??|dropped|review)/i.test(c)) || "";
    rows.set(branch, { branch, sha, verdict });
  }
  return [...rows.values()];
}

// One network call for ALL remote heads, so the guard stays cheap enough to run
// from a SessionStart hook (vs one ls-remote per branch).
function remoteHeads() {
  const map = new Map();
  let out = "";
  try {
    out = git(["ls-remote", "--heads", REMOTE]);
  } catch {
    return map; // fail-soft: no heads → everything reads as "deleted"/unknown
  }
  for (const line of out.split("\n")) {
    const [sha, ref] = line.split(/\s+/);
    if (ref && ref.startsWith("refs/heads/")) map.set(ref.slice("refs/heads/".length), sha);
  }
  return map;
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

function main() {
  let ledger;
  try {
    ledger = readFileSync(LEDGER, "utf8");
  } catch {
    console.error(`Ledger not found: ${LEDGER}`);
    process.exit(2);
  }

  // Fetch so merge-base has the objects (fail-soft: keep going on network errors).
  try {
    git(["fetch", "--quiet", REMOTE]);
  } catch {
    console.warn(`(warning) could not fetch ${REMOTE}; tips may be stale`);
  }

  const done = parseLedger(ledger).filter((r) => DONE.test(r.verdict));
  const heads = remoteHeads();
  const violations = [];
  let gone = 0;
  let ok = 0;

  for (const { branch, sha, verdict } of done) {
    const tip = heads.get(branch) || null;
    if (!tip) {
      gone++;
      continue;
    }
    if (tip.startsWith(sha)) {
      ok++;
      continue;
    }
    // Tip changed. A VIOLATION is when the recorded (done) SHA is an ancestor of
    // the new tip — i.e. someone added commits ON TOP of the finished work.
    // (If it's not an ancestor, the branch was rebuilt from a different base;
    // still worth surfacing, but as a weaker "changed" note.)
    const advanced = isAncestor(sha, tip);
    violations.push({ branch, recorded: sha, tip: tip.slice(0, 12), verdict, advanced });
  }

  console.log(`Checked ${done.length} done branches: ${ok} unchanged, ${gone} deleted, ${violations.length} moved.`);

  if (!violations.length) {
    console.log("✓ No one has pushed to a merged/superseded/dropped branch.");
    process.exit(0);
  }

  console.log("\n=================== NOTIFY OWNER (krister.hedfors@gmail.com) ===================");
  console.log("A branch marked DONE in docs/MERGED-BRANCHES.md has received new commits.");
  console.log("The rule (CLAUDE.md + merge-branches skill): merged branches are dead — do");
  console.log("not build on them. Someone broke it. Tell the owner which branch moved:\n");
  for (const v of violations) {
    const kind = v.advanced ? "NEW COMMITS ON TOP OF" : "REWRITTEN (not a descendant of)";
    console.log(`  • ${v.branch}`);
    console.log(`      verdict: ${v.verdict}   recorded ${v.recorded} → now ${v.tip}   [${kind} the recorded tip]`);
  }
  console.log("\nAction: surface this to the owner. Do NOT silently re-tag or keep building");
  console.log("on the branch — its work belongs in a FRESH branch off origin/main.");
  console.log("================================================================================");
  process.exit(1);
}

main();
