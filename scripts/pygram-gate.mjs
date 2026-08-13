#!/usr/bin/env node
// The pygram build gate — enforces the acceptance table in docs/PYGRAM.md §2.
//
// pygram exists for exactly one reason: `python3 --version` costs 8573 ms cold
// in the in-browser CheerpX VM against 87 ms warm (docs/SANDBOX-PERFORMANCE.md
// §1), because the root filesystem is streamed block by block over a network
// and CPython touches an enormous amount of it. The cost is bytes and file
// opens, not CPU.
//
// So this script measures the three things that actually predict cold cost, on
// the built binary, before anything reaches a VM:
//
//   1. STATIC      — a dynamic binary means ld.so path search plus every .so
//                    streamed over the wire. Static means one file, ever.
//   2. SIZE        — stripped bytes, because every byte is a byte fetched.
//   3. FILE OPENS  — how many paths a trivial `-c 'pass'` touches. This is the
//                    proxy for cold blocks, and it is where CPython loses: a
//                    stdlib that lives as files on disk is a stdlib fetched
//                    over a WebSocket.
//
// None of these need a VM, and i386 binaries execute in the dev container, so
// this is a cheap gate that can run in CI on the real target artifact.
//
// Usage:
//   node scripts/pygram-gate.mjs ./pygram/pygram
//   node scripts/pygram-gate.mjs --compare $(command -v python3)   # the baseline
//   node scripts/pygram-gate.mjs ./pygram/pygram --json
//   node scripts/pygram-gate.mjs ./pygram/pygram --max-bytes 500000

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The budgets from docs/PYGRAM.md §2. These are targets that a build must meet,
// not observations — if a candidate cannot meet them the right response is to
// argue the number in the doc, not to quietly raise it here.
//
// maxBytes was 400 KB until the floor was actually measured
// (docs/PYGRAM-RESEARCH.md §2.2, §6): an empty `main` costs 635,744 B under
// glibc-static on i386 and 13,020 B under musl-static, and Berry — a complete
// dynamic-language VM with NEITHER `re` nor `json` — lands at 365,660 B. 400 KB
// was unreachable for anything that speaks Python. 700 KB is set against the
// measured 541,688 B prototype, leaving room for the frozen shims. The gate is
// only meaningful on a musl build; glibc would spend 91% of it on an empty
// program.
export const DEFAULT_BUDGET = {
  maxBytes: 700_000,
  maxOpens: 3,
  mustBeStatic: true,
};

/** `file(1)`'s verdict, reduced to the two facts we care about. */
export function classifyElf(fileOutput) {
  const out = String(fileOutput);
  return {
    isElf: /\bELF\b/.test(out),
    isStatic: /statically linked/.test(out),
    is32Bit: /ELF 32-bit/.test(out),
    stripped: /, stripped/.test(out),
    arch: (/ELF \d+-bit LSB [^,]*, ([^,]+)/.exec(out) || [, "unknown"])[1].trim(),
  };
}

/**
 * Pull the set of filesystem paths a run actually opened out of an strace log.
 *
 * We count SUCCESSFUL opens of distinct paths, which is the closest cheap proxy
 * for "distinct files whose blocks must be fetched". Failed opens (ENOENT) are
 * counted separately and reported, because they are not free either — a probe
 * for a file that does not exist still costs a directory lookup over the wire,
 * and CPython's import machinery does a great many of them.
 */
export function parseStraceOpens(log) {
  const opened = new Set();
  let failed = 0;
  let statLike = 0;
  // strace writes the pid two different ways: `[pid 123] call(…)` when it
  // attaches, and a bare `123  call(…)` under -f -o. Both must be stripped, or
  // the whole trace parses as zero opens — which reads as a spectacular pass.
  const PID = String.raw`(?:\[pid\s+\d+\]\s*|\d+\s+)?`;
  const OPEN = new RegExp(`^\\s*${PID}open(?:at)?\\((?:[^,]+,\\s*)?"([^"]*)"`);
  const STATLIKE = new RegExp(`^\\s*${PID}(?:newfstatat|statx?|lstat|access|readlink|faccessat2?)\\(`);
  for (const line of String(log).split("\n")) {
    const open = OPEN.exec(line);
    if (open) {
      if (/=\s*-1\b/.test(line)) failed++;
      else opened.add(open[1]);
      continue;
    }
    if (STATLIKE.test(line)) statLike++;
  }
  return { opened: [...opened].sort(), openCount: opened.size, failedOpens: failed, statLike };
}

/** Measure one binary. Returns a plain record; never throws. */
export function measure(bin, { probe = ["-c", "pass"] } = {}) {
  const rec = { bin, exists: existsSync(bin) };
  if (!rec.exists) return rec;

  rec.bytes = statSync(bin).size;
  const fileOut = spawnSync("file", ["-L", bin], { encoding: "utf8" });
  rec.file = (fileOut.stdout || "").trim();
  Object.assign(rec, classifyElf(rec.file));

  // Does it even run the probe? A gate that passes a binary that cannot execute
  // `-c 'pass'` is measuring a paperweight.
  const run = spawnSync(bin, probe, { encoding: "utf8", timeout: 20_000 });
  rec.probeExit = run.status;
  rec.probeOk = run.status === 0;
  rec.probeStderr = (run.stderr || "").trim().slice(0, 300);

  // File-open count via strace. Optional: if strace is missing or blocked
  // (containers often restrict ptrace) the gate reports "unmeasured" rather
  // than failing — an unmeasurable check must not become a false red.
  const straceAvailable = spawnSync("sh", ["-c", "command -v strace"], { encoding: "utf8" }).status === 0;
  if (!straceAvailable) {
    rec.opens = null;
    rec.opensNote = "strace not available";
    return rec;
  }
  const dir = mkdtempSync(join(tmpdir(), "pygram-gate-"));
  const logPath = join(dir, "trace.txt");
  const traced = spawnSync("strace", ["-f", "-e", "trace=file", "-o", logPath, bin, ...probe], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (traced.error || !existsSync(logPath)) {
    rec.opens = null;
    rec.opensNote = `strace failed: ${traced.error ? traced.error.message : "no log"}`;
    return rec;
  }
  Object.assign(rec, parseStraceOpens(readFileSync(logPath, "utf8")));
  rec.opens = rec.openCount;
  return rec;
}

/** Apply the budget. Returns {pass, checks[]} — one row per gate. */
export function evaluate(rec, budget = DEFAULT_BUDGET) {
  const checks = [];
  const add = (name, ok, got, want) => checks.push({ name, ok, got, want });

  add("binary exists", !!rec.exists, rec.exists ? "yes" : "no", "yes");
  if (!rec.exists) return { pass: false, checks };

  add("runs -c 'pass'", !!rec.probeOk, rec.probeOk ? "exit 0" : `exit ${rec.probeExit}`, "exit 0");
  if (budget.mustBeStatic) {
    add("statically linked", !!rec.isStatic, rec.isStatic ? "static" : "dynamic", "static");
  }
  add("size", rec.bytes <= budget.maxBytes, `${rec.bytes} B`, `<= ${budget.maxBytes} B`);

  if (rec.opens === null) {
    // Unmeasured is not a failure, but it must be visible — silently dropping
    // the check would let the one metric that predicts cold cost go unwatched.
    checks.push({ name: "file opens", ok: true, got: `unmeasured (${rec.opensNote})`, want: `<= ${budget.maxOpens}`, skipped: true });
  } else {
    add("file opens", rec.opens <= budget.maxOpens, `${rec.opens}`, `<= ${budget.maxOpens}`);
  }

  return { pass: checks.every((c) => c.ok), checks };
}

/**
 * The projected cold cost in the VM, from the measured shape.
 *
 * This is an ESTIMATE and is labelled as one everywhere it is printed. It exists
 * so a build change can be judged in seconds instead of waiting for a Playwright
 * run against production. The anchor is the one real measurement we have:
 * CPython at 8573 ms cold. The real number is whatever
 * tests/e2e/sandbox-perf.spec.js says, and that is what docs/PYGRAM.md §2
 * accepts on — never this.
 */
export function projectColdMs(rec, anchor = { bytes: null, opens: null, ms: 8573 }) {
  if (!rec.exists || rec.opens === null || !anchor.opens) return null;
  // Cold cost tracks bytes fetched and round-trips taken. Neither alone
  // explains it, so scale on both and take the larger — the pessimistic read.
  const byteShare = anchor.bytes ? rec.bytes / anchor.bytes : 0;
  const openShare = rec.opens / anchor.opens;
  return Math.round(anchor.ms * Math.max(byteShare, openShare));
}

/**
 * Find a REAL CPython ELF to use as the baseline.
 *
 * `command -v python3` is not good enough, and this bit us for real: the
 * capture harness (scripts/pygram-capture/) installs a `python3` SHIM early on
 * PATH, so the first hit is an 8,971-byte shell script. Measuring that as "the
 * baseline" produced a comparison against a wrapper — 30 file opens, and a
 * projected cold cost of 330 seconds — which is worse than no baseline, because
 * it looks like a number.
 *
 * So: walk every `python3` on PATH, follow symlinks, and take the first one
 * `file` calls an ELF. Honours PYTHON_BIN when set.
 */
export function findRealCPython(pathEnv = process.env.PATH || "", override = process.env.PYTHON_BIN) {
  const candidates = [];
  if (override) candidates.push(override);
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    for (const name of ["python3", "python"]) candidates.push(join(dir, name));
  }
  for (const cand of candidates) {
    if (!existsSync(cand)) continue;
    // Follow the symlink chain — /usr/bin/python3 is usually a link, and
    // measuring a 40-byte symlink as the interpreter is a nonsense reading.
    const real = spawnSync("readlink", ["-f", cand], { encoding: "utf8" }).stdout.trim() || cand;
    if (!existsSync(real)) continue;
    const out = spawnSync("file", ["-L", real], { encoding: "utf8" }).stdout || "";
    if (classifyElf(out).isElf) return real;
  }
  return null;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function report(rec, budget) {
  const { pass, checks } = evaluate(rec, budget);
  console.log(`\n${rec.bin}`);
  if (rec.file) console.log(`  ${rec.file.replace(/^[^:]*:\s*/, "")}`);
  console.log("");
  for (const c of checks) {
    const mark = c.skipped ? "–" : c.ok ? "✓" : "✗";
    console.log(`  ${mark} ${pad(c.name, 20)} ${pad(c.got, 26)} want ${c.want}`);
  }
  if (rec.opens !== null && rec.opens !== undefined) {
    console.log(`\n  ${rec.openCount} distinct files opened, ${rec.failedOpens} failed probes, ${rec.statLike} stat/access calls`);
  }
  return pass;
}

function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const compare = args.includes("--compare");
  const maxIdx = args.indexOf("--max-bytes");
  const budget = { ...DEFAULT_BUDGET };
  if (maxIdx >= 0) budget.maxBytes = Number(args[maxIdx + 1]);

  const bins = args.filter((a) => !a.startsWith("--") && (maxIdx < 0 || a !== args[maxIdx + 1]));
  if (!bins.length) {
    console.error("usage: node scripts/pygram-gate.mjs <binary> [--compare] [--json] [--max-bytes N]");
    console.error("       --compare also measures the system python3 as the baseline");
    process.exit(2);
  }

  const records = bins.map((b) => measure(b));
  if (compare) {
    const py = findRealCPython();
    if (py) records.push(measure(py));
    else console.error("warning: no real CPython binary found on PATH — skipping the baseline");
  }

  if (wantJson) {
    console.log(JSON.stringify({ budget, records: records.map((r) => ({ ...r, ...evaluate(r, budget) })) }, null, 2));
    process.exit(records.slice(0, bins.length).every((r) => evaluate(r, budget).pass) ? 0 : 1);
  }

  let allPass = true;
  for (let i = 0; i < records.length; i++) {
    const isBaseline = i >= bins.length;
    if (isBaseline) console.log("\n--- baseline (not gated) ---");
    const pass = report(records[i], budget);
    if (!isBaseline) allPass = allPass && pass;
  }

  // The comparison is the headline: how much smaller is the cold footprint than
  // the thing we are replacing.
  const baseline = records[bins.length];
  if (baseline && baseline.exists && records[0].exists && baseline.opens && records[0].opens !== null) {
    const projected = projectColdMs(records[0], { bytes: baseline.bytes, opens: baseline.opens, ms: 8573 });
    const ratio = (a, b) => (b === 0 ? "no opens at all" : `${(a / b).toFixed(1)}x fewer`);
    console.log(`\n  opens: ${records[0].opens} vs ${baseline.opens} (${ratio(baseline.opens, records[0].opens)})`);
    console.log(`  bytes: ${records[0].bytes} vs ${baseline.bytes} (${(baseline.bytes / records[0].bytes).toFixed(1)}x smaller)`);
    if (projected !== null) {
      console.log(`\n  ESTIMATED cold cost in the VM: ~${projected} ms against CPython's measured 8573 ms.`);
      console.log("  This is a projection from shape, not a measurement. docs/PYGRAM.md §2");
      console.log("  accepts on tests/e2e/sandbox-perf.spec.js against a real VM, never on this.");
    }
  }

  console.log("");
  process.exit(allPass ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
