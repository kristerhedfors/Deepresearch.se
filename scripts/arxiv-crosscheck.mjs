#!/usr/bin/env node
// Cross-validate a harvest against an independent enumeration, per month.
//
//   node scripts/arxiv-crosscheck.mjs --raw data/arxiv-new/raw --ids data/eval/gcs-2310-2506.txt
//
// WHY: a harvest cannot detect its own gaps. docs/ARXIV-RAG.md §10.2 records a
// run that kept 339,263 papers, exited 0, and was missing 48.1% of its oldest
// month — while its TOTAL agreed with the enumeration to 0.04%. Only the
// per-month diff exposed it. This is that diff, as a command, so it is cheap
// enough to run after every harvest instead of when something already looks
// wrong.
//
// It compares SETS of ids, not counts, because "kept" is not "unique": a paper
// revised inside the window appears in every month shard it touched.

import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} argv */
function arg(argv, flag, dflt) {
  const i = argv.indexOf(flag);
  return i < 0 ? dflt : argv[i + 1];
}

/**
 * An arXiv id without its version suffix.
 *
 * The two sides of this diff spell ids differently and neither is wrong:
 * `scripts/arxiv-gcs.mjs --out` writes `2507.23787v2` (the mirror lists one
 * object per VERSION, and the version is worth keeping), while `listShard()`'s
 * keys and every harvested record use the bare `2507.23787`. Comparing them
 * unnormalised makes the two sets disjoint, which this tool reports as 0%
 * coverage and `extra == harvested` — a false alarm that looks exactly like
 * total harvest failure.
 * @param {string} id
 */
export function bareId(id) {
  return String(id || "").trim().replace(/v\d+$/, "");
}

/**
 * Month of an arXiv id, or "" when it carries none.
 * @param {string} id
 */
export function monthOf(id) {
  const m = /^(\d{2})(\d{2})\./.exec(bareId(id));
  return m ? m[1] + m[2] : "";
}

/**
 * Per-month set difference between two id collections.
 * @param {Map<string, Set<string>>} harvested
 * @param {Map<string, Set<string>>} expected
 */
export function diffByMonth(harvested, expected) {
  const months = [...new Set([...harvested.keys(), ...expected.keys()])].sort();
  return months.map((m) => {
    const have = harvested.get(m) || new Set();
    const want = expected.get(m) || new Set();
    let missing = 0;
    for (const id of want) if (!have.has(id)) missing++;
    let extra = 0;
    for (const id of have) if (!want.has(id)) extra++;
    return {
      month: m,
      expected: want.size,
      harvested: have.size,
      missing,
      // Papers the harvest has that the mirror does not list: normal at the
      // leading edge (the PDF mirror lags a new submission), suspicious in bulk.
      extra,
      coverage: want.size ? Math.round(((want.size - missing) / want.size) * 1000) / 10 : 100,
    };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const rawDir = join(ROOT, arg(argv, "--raw", "data/arxiv-new/raw"));
  const idsFile = join(ROOT, arg(argv, "--ids", ""));
  if (!arg(argv, "--ids", "")) throw new Error("--ids <enumeration file> required");

  /** @type {Map<string, Set<string>>} */
  const expected = new Map();
  for (const line of (await readFile(idsFile, "utf8")).split("\n")) {
    const id = bareId(line);
    const m = monthOf(id);
    if (!m) continue;
    if (!expected.has(m)) expected.set(m, new Set());
    expected.get(m).add(id);
  }

  /** @type {Map<string, Set<string>>} */
  const harvested = new Map();
  const files = (await readdir(rawDir)).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(rawDir, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a torn last line from an interrupted harvest
      }
      const id = bareId(row?.id);
      const m = monthOf(id);
      if (!m) continue;
      if (!harvested.has(m)) harvested.set(m, new Set());
      harvested.get(m).add(id);
    }
  }

  const rows = diffByMonth(harvested, expected).filter((r) => expected.get(r.month)?.size);
  console.log("month   expected   harvested   missing   extra   coverage");
  for (const r of rows) {
    console.log(
      `${r.month}    ${String(r.expected).padStart(8)}   ${String(r.harvested).padStart(9)}   ` +
        `${String(r.missing).padStart(7)}   ${String(r.extra).padStart(5)}   ${r.coverage}%`,
    );
  }
  const expTotal = rows.reduce((a, r) => a + r.expected, 0);
  const missTotal = rows.reduce((a, r) => a + r.missing, 0);
  const worst = rows.reduce((a, r) => (r.coverage < a.coverage ? r : a), rows[0] || { month: "-", coverage: 100 });
  console.log(
    `\noverall ${Math.round(((expTotal - missTotal) / (expTotal || 1)) * 1000) / 10}% ` +
      `(${missTotal} of ${expTotal} missing) — worst month ${worst.month} at ${worst.coverage}%`,
  );
  // The totals agreeing is NOT the check; §10.2's hole was invisible in them.
  if (worst.coverage < 95) {
    console.log(`\nWARNING: ${worst.month} is below 95% — re-harvest that shard before trusting the build.`);
  }
}

if (process.argv[1]?.endsWith("arxiv-crosscheck.mjs")) {
  main().catch((err) => {
    console.error("arxiv-crosscheck failed:", err.message);
    process.exit(1);
  });
}
