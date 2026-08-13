#!/usr/bin/env node
// @ts-check
// Measure unit-test coverage, and RATCHET it.
//
// `docs/TESTING-GAP-ANALYSIS.md` (2026-07-24) inferred the untested surface
// from the import graph — which modules a test file happens to `import` — and
// said so: "Nothing measures line coverage. `node --test
// --experimental-test-coverage` is built in, needs no dependency, and would
// turn the whole of section B from an inference off import graphs into a
// number." This script is that number, plus the thing a number is for.
//
// Two jobs:
//
//   npm run coverage         measure and print; `--json` for the raw record
//   npm run coverage:check   measure and FAIL if it went backwards
//
// The ratchet is the point. A coverage percentage nobody compares against
// anything is a vanity metric; a coverage percentage that cannot go down
// without a red build is a floor you climb off. `docs/coverage-baseline.json`
// holds the floor, `--save` raises it.
//
// Three headline metrics, because they answer different questions:
//
//   lines / branches / functions   the usual, over src/ + public/js/ only
//   unloaded modules               modules NO test file causes to be imported.
//                                  Node reports 0% for a file it loaded and
//                                  nothing for a file it never saw, and the
//                                  difference matters: an unloaded module is
//                                  not "poorly tested", it is untested, and it
//                                  is invisible in the headline percentage.
//
// Deliberately NOT a coverage threshold per module. A blanket "every file
// ≥80%" target is met by writing tests against whatever is easiest to reach,
// which is rarely what is worth testing. The ratchet asks only that the number
// not fall, and `--list` says where the cheapest climb is.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "docs/coverage-baseline.json");

/** Directories whose modules count toward the measured surface. */
const MEASURED = ["src", "public/js"];

/** Not product code: helpers that exist only to serve the suite. */
const EXCLUDE = [/^src\/test-helpers\//];

/**
 * The glob `npm test` runs, kept in sync with package.json's `test` script.
 *
 * The copy is forced — package.json cannot import a module, and deriving these
 * by splitting an npm script string means parsing it (a flag added to `test`
 * would arrive here as a glob). So it is PINNED instead: scripts/coverage.test.mjs
 * compares the two in both directions, because either drift is silent and both
 * corrupt the ratchet. A glob added to package.json but not here makes CI's
 * `coverage:check` measure a smaller suite than CI runs; one left here after
 * package.json drops it gives the baseline credit for tests nobody runs. Neither
 * fails a build — the number just quietly stops describing the suite.
 */
export const TEST_GLOBS = [
  "src/*.test.js",
  "public/js/*.test.js",
  "public/app-kit/*.test.js",
  "public/games/*/js/*.test.js",
  "sdk/*.test.mjs",
  "scripts/*.test.mjs",
  "scripts/*/*.test.mjs",
  "tests/*.test.js",
  "tests/pygram/*.test.mjs",
];

/**
 * Run the suite under coverage and return the raw TAP output.
 * Test files are excluded from the report — a suite measuring how well it
 * covers itself reports ~88% and means nothing.
 */
function runCoverage() {
  const args = [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-exclude=**/*.test.js",
    "--test-coverage-exclude=**/*.test.mjs",
    "--test-reporter=tap",
    ...TEST_GLOBS,
  ];
  try {
    return execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // A failing test still produces a usable coverage table; report it, but
    // make the failure impossible to miss.
    const out = /** @type {any} */ (err).stdout;
    if (typeof out === "string" && out.includes("end of coverage report")) {
      process.exitCode = 1;
      console.error("⚠ tests FAILED — coverage below is from a red suite\n");
      return out;
    }
    throw err;
  }
}

/**
 * Parse the `# file | line | branch | funcs | uncovered` table out of TAP.
 * @param {string} tap
 * @returns {Map<string, {line: number, branch: number, func: number}>} keyed by basename
 */
function parseCoverage(tap) {
  /** @type {Map<string, {line: number, branch: number, func: number}>} */
  const out = new Map();
  for (const raw of tap.split("\n")) {
    if (!raw.startsWith("# ")) continue;
    const m = raw.slice(2).match(/^\s*([\w.@-]+\.m?js)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (m) out.set(m[1], { line: +m[2], branch: +m[3], func: +m[4] });
  }
  return out;
}

/** Every measured product module, as repo-relative paths. */
function measuredModules() {
  /** @type {Array<{path: string, name: string, lines: number}>} */
  const out = [];
  for (const dir of MEASURED) {
    for (const name of readdirSync(join(ROOT, dir)).sort()) {
      if (!name.endsWith(".js") || name.endsWith(".test.js")) continue;
      const path = `${dir}/${name}`;
      if (EXCLUDE.some((re) => re.test(path))) continue;
      out.push({ path, name, lines: readFileSync(join(ROOT, path), "utf8").split("\n").length });
    }
  }
  return out;
}

/**
 * Build the coverage record: per-module numbers plus the aggregates the
 * ratchet compares.
 * @param {string} tap
 */
function buildReport(tap) {
  const cov = parseCoverage(tap);
  const modules = measuredModules();

  /** @type {Record<string, {lines: number, line: number|null, branch: number|null, func: number|null}>} */
  const byModule = {};
  let loadedLines = 0;
  let unloadedLines = 0;
  let weightedLine = 0;
  let weightedBranch = 0;
  let weightedFunc = 0;

  for (const m of modules) {
    const c = cov.get(m.name) || null;
    byModule[m.path] = {
      lines: m.lines,
      line: c ? c.line : null,
      branch: c ? c.branch : null,
      func: c ? c.func : null,
    };
    if (c) {
      loadedLines += m.lines;
      weightedLine += (c.line / 100) * m.lines;
      weightedBranch += (c.branch / 100) * m.lines;
      weightedFunc += (c.func / 100) * m.lines;
    } else {
      unloadedLines += m.lines;
    }
  }

  const totalLines = loadedLines + unloadedLines;
  // Aggregates are weighted by module size AND count an unloaded module as
  // zero — the honest denominator. Node's own "all files" line silently omits
  // files it never loaded, which is how 18 000 untested lines can sit behind
  // an 81% headline.
  const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;
  return {
    generated_by: "npm run coverage -- --save",
    modules: modules.length,
    unloaded_modules: modules.length - cov.size >= 0 ? Object.values(byModule).filter((v) => v.line === null).length : 0,
    total_lines: totalLines,
    unloaded_lines: unloadedLines,
    totals: {
      line: round((weightedLine / totalLines) * 100),
      branch: round((weightedBranch / totalLines) * 100),
      func: round((weightedFunc / totalLines) * 100),
      loaded_share: round((loadedLines / totalLines) * 100),
    },
    by_module: byModule,
  };
}

/** @param {any} report */
function printSummary(report) {
  const t = report.totals;
  console.log("Unit-test coverage over src/ + public/js/ (product code only)\n");
  console.log(`  lines      ${t.line.toFixed(2)}%`);
  console.log(`  branches   ${t.branch.toFixed(2)}%`);
  console.log(`  functions  ${t.func.toFixed(2)}%`);
  console.log(
    `\n  modules    ${report.modules} total, ${report.unloaded_modules} never loaded by any test`,
  );
  console.log(
    `  lines      ${report.total_lines} total, ${report.unloaded_lines} in never-loaded modules ` +
      `(${(100 - t.loaded_share).toFixed(1)}%)`,
  );
}

/** @param {any} report */
function printList(report) {
  /** @type {Array<[string, any]>} */
  const entries = Object.entries(report.by_module);
  const unloaded = entries.filter(([, v]) => v.line === null).sort((a, b) => b[1].lines - a[1].lines);
  console.log(`\nNever loaded by any test — ${unloaded.length} modules, biggest first:`);
  for (const [path, v] of unloaded.slice(0, 25)) console.log(`  ${String(v.lines).padStart(5)}  ${path}`);
  if (unloaded.length > 25) console.log(`  … and ${unloaded.length - 25} more`);

  const weak = entries
    .filter(([, v]) => v.line !== null && v.line < 60)
    .sort((a, b) => b[1].lines * (100 - b[1].line) - a[1].lines * (100 - a[1].line));
  console.log(`\nLoaded but under 60% line coverage — ${weak.length} modules, most uncovered lines first:`);
  for (const [path, v] of weak.slice(0, 25)) {
    console.log(`  ${String(v.lines).padStart(5)}  ${v.line.toFixed(1).padStart(5)}%  ${path}`);
  }
  if (weak.length > 25) console.log(`  … and ${weak.length - 25} more`);
}

/**
 * The ratchet. Fails when an aggregate falls below the baseline by more than
 * `TOLERANCE`, or when a module the baseline had covered stops being loaded.
 * @param {any} report
 */
function check(report) {
  if (!existsSync(BASELINE)) {
    console.error(`No baseline at ${BASELINE}. Create one with: npm run coverage -- --save`);
    return 1;
  }
  const base = JSON.parse(readFileSync(BASELINE, "utf8"));
  // Coverage moves a little with test scheduling; only a real drop should fail.
  const TOLERANCE = 0.5;
  /** @type {string[]} */
  const failures = [];

  for (const key of /** @type {const} */ (["line", "branch", "func"])) {
    const now = report.totals[key];
    const was = base.totals?.[key];
    if (typeof was !== "number") continue;
    if (now < was - TOLERANCE) {
      failures.push(`${key} coverage fell ${was.toFixed(2)}% → ${now.toFixed(2)}% (tolerance ${TOLERANCE}%)`);
    }
  }

  // A module regressing to "never loaded" is a category change, not a
  // percentage wobble — no tolerance for it.
  for (const [path, was] of Object.entries(base.by_module || {})) {
    const now = report.by_module[path];
    if (!now) continue; // module deleted or renamed — not this check's business
    if (/** @type {any} */ (was).line !== null && now.line === null) {
      failures.push(`${path} is no longer loaded by any test (was ${/** @type {any} */ (was).line}%)`);
    }
  }

  if (failures.length) {
    console.error("\n✗ coverage regressed:\n");
    for (const f of failures) console.error(`    ${f}`);
    console.error(`\n  Baseline: ${BASELINE}`);
    console.error("  Add tests, or — if the drop is intended — re-record with:");
    console.error("      npm run coverage -- --save\n");
    return 1;
  }

  const gained = report.totals.line - (base.totals?.line ?? 0);
  console.log(
    `\n✓ coverage holds at or above the baseline (line ${report.totals.line.toFixed(2)}%, ` +
      `${gained >= 0 ? "+" : ""}${gained.toFixed(2)}% vs baseline)`,
  );
  if (gained > 0.5) console.log("  Worth re-recording the floor: npm run coverage -- --save");
  return 0;
}

// ---- main -------------------------------------------------------------------

// Behind the same guard every other script in here uses, so TEST_GLOBS can be
// imported and pinned. Without it, `import`ing this module runs the entire
// suite under coverage — which is why the glob list had no test.
if (process.argv[1]?.endsWith("coverage.mjs")) {
  const argv = process.argv.slice(2);
  const report = buildReport(runCoverage());

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
    if (argv.includes("--list")) printList(report);
  }

  if (argv.includes("--save")) {
    writeFileSync(BASELINE, JSON.stringify(report, null, 2) + "\n");
    console.log(`\nBaseline written to ${BASELINE}`);
  }

  if (argv.includes("--check")) {
    process.exitCode = check(report) || process.exitCode || 0;
  }
}
