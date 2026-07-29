#!/usr/bin/env node
// The refactor survey's LINE-RUN scanner — the companion to
// scripts/dup-scan.mjs (see the **refactor-clarity** skill).
//
// dup-scan hashes FUNCTION BODIES. This hashes runs of consecutive
// significant LINES, wherever they sit, so it sees the class of duplication
// dup-scan structurally cannot:
//
//   - early-return preambles inside handlers (the seven-line try/catch around
//     request.json() that thirteen endpoints carried — pass 12)
//   - inline blocks (the six that became src/grant-http.js — pass 5)
//   - constant tables and import clusters
//
// WHY it exists as a tool. Pass 10 committed dup-scan for the same reason, and
// by pass 12 dup-scan returned only entries already in STANDING-DECLINES.md —
// a converged codebase — while all three of that pass's cuts came from an
// ad-hoc line scan. Both scans belong in the survey.
//
//   node scripts/line-scan.mjs              # runs of 6 significant lines
//   node scripts/line-scan.mjs --run 8      # only the long ones
//   node scripts/line-scan.mjs --json       # machine-readable
//
// Output is ADVISORY, exactly like dup-scan's: a hit is a survey candidate,
// never a verdict. The skill's five gates decide.
//
// It reports MORE noise than dup-scan by construction — two files importing
// the same six symbols is a real duplicate run and not a refactor. Read every
// hit; the ones worth acting on are usually the ones sitting under a comment
// that apologizes for the copy.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The same corpus dup-scan.mjs scans, for the same reasons: both tiers plus
// the SDK and the build scripts, no tests (duplicate arrange/assert blocks
// drown the signal), no vendored libs, no generated artifacts.
const INCLUDE = /^(src|public\/js|public\/cure|sdk|scripts)\/.*\.(js|mjs)$/;
const EXCLUDE = [/\.test\.(js|mjs)$/, /^public\/vendor\//, /^public\/introspect\//];

/**
 * The significant lines of a file, with their 1-based line numbers.
 *
 * Comments, blank lines and lines that are nothing but closing punctuation are
 * dropped: a run of `}` `)` `;` matches everywhere and carries no signal, and
 * two copies that drifted only in their comments are still a duplicate worth
 * seeing. Line-trailing `//` comments are stripped, which is imprecise inside
 * string literals containing `//` — acceptable in an advisory scan, and it can
 * only merge two lines that were already nearly identical.
 * @param {string} text
 * @returns {Array<{ s: string, line: number }>}
 */
export function significantLines(text) {
  /** @type {Array<{ s: string, line: number }>} */
  const out = [];
  String(text).split("\n").forEach((raw, i) => {
    const s = raw.replace(/\/\/.*$/, "").trim();
    if (!s) return;
    if (s.startsWith("*") || s.startsWith("/*") || s.startsWith("*/")) return;
    if (/^[})\];,]+$/.test(s)) return;
    out.push({ s, line: i + 1 });
  });
  return out;
}

/**
 * Group identical runs of `run` significant lines that appear in two or more
 * FILES. A run repeated within one file alone is not reported — that is a
 * within-module pattern, not the cross-file drift this survey is after (the
 * same rule dup-scan.mjs applies).
 *
 * Overlapping windows are collapsed: when a run of length N+1 is shared, its
 * two length-N windows are shared too, and reporting all of them buries the
 * finding. Only the FIRST window of a maximal shared stretch survives.
 * @param {Array<{ path: string, lines: Array<{ s: string, line: number }> }>} files
 * @param {number} [run]
 * @returns {Array<{ text: string[], sites: Array<{ path: string, line: number }> }>}
 */
export function groupLineRuns(files, run = 6) {
  /** @type {Map<string, { text: string[], sites: Array<{ path: string, line: number }> }>} */
  const index = new Map();
  for (const { path, lines } of files) {
    for (let i = 0; i + run <= lines.length; i++) {
      const win = lines.slice(i, i + run);
      const h = createHash("sha1").update(win.map((x) => x.s).join("\n")).digest("hex");
      if (!index.has(h)) index.set(h, { text: win.map((x) => x.s), sites: [] });
      /** @type {any} */ (index.get(h)).sites.push({ path, line: win[0].line });
    }
  }
  const shared = [...index.values()]
    .filter((g) => new Set(g.sites.map((s) => s.path)).size > 1)
    .sort((a, b) => a.sites[0].line - b.sites[0].line);

  // A window is a continuation when the SAME site set, each shifted back one
  // significant line, was already reported. Sites carry source line numbers,
  // not significant-line indices, so continuation is detected on the site set
  // of the previous window keyed by its own emitted position.
  /** @type {Set<string>} */
  const emitted = new Set();
  /** @type {typeof shared} */
  const keep = [];
  for (const g of shared) {
    const key = (/** @type {number} */ delta) =>
      g.sites.map((s) => `${s.path}:${s.line - delta}`).sort().join("|");
    if (emitted.has(key(1))) {
      emitted.add(key(0));
      continue;
    }
    emitted.add(key(0));
    keep.push(g);
  }
  return keep;
}

/** @returns {string[]} the tracked files this scan covers */
function trackedJs() {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((p) => INCLUDE.test(p) && !EXCLUDE.some((re) => re.test(p)));
}

function main(argv) {
  const run = Number(argv[argv.indexOf("--run") + 1]) || 6;
  const asJson = argv.includes("--json");
  const files = [];
  for (const path of trackedJs()) {
    try {
      files.push({ path, lines: significantLines(readFileSync(join(ROOT, path), "utf8")) });
    } catch {
      // Unreadable file: the scan is advisory, so skip it rather than failing
      // a survey over one file.
    }
  }
  const groups = groupLineRuns(files, run);
  if (asJson) {
    console.log(JSON.stringify({ scanned: files.length, run, groups }, null, 2));
    return;
  }
  console.log(`scanned ${files.length} files — ${groups.length} duplicated ${run}-line runs across files\n`);
  for (const g of groups) {
    console.log(`--- ${g.sites.map((s) => `${s.path}:${s.line}`).join("  ")}`);
    for (const t of g.text) console.log("    " + (t.length > 110 ? t.slice(0, 107) + "…" : t));
    console.log();
  }
}

if (process.argv[1] && process.argv[1].endsWith("line-scan.mjs")) main(process.argv.slice(2));
