#!/usr/bin/env node
// The Mixture-of-Pythons benchmark.
//
// Four arms over the SAME corpus of real one-liners:
//
//   cpython   the system python3 — the baseline everything is measured against
//   pygram    the MicroPython-derived subset (docs/PYGRAM.md)
//   mopy      the Rust subset alone
//   mixture   `mopy run` — route, then execute on whichever engine fits
//
// The mixture arm is the product; the other three are its components, and are
// here so a claim about the mixture can be attributed.
//
// Four rules taken from the pygram bench (the pygram skill §2b), each of which
// is a way to get this wrong:
//
//   * **The verdict is the MIN of repeats, not the mean.** Noise on a shared
//     runner is one-sided — it can only add time — so the minimum is the least
//     biased estimate. The median is printed beside it and a row where the two
//     disagree by more than 25% is flagged and is NOT a finding.
//   * **Arms are interleaved per entry**, never run as blocks, so a machine
//     that gets busy halfway through penalises every arm equally.
//   * **A refusal is not a time.** An arm that exits 90 did not run the
//     program; counting its 1 ms would make a runtime look faster the less it
//     could do. Those entries are excluded from that arm's total and reported
//     as coverage instead.
//   * **Totals are compared on the SHARED subset** — the programs every arm
//     completed — because a total over different program sets is not a
//     comparison. The whole-corpus total is reported separately, and that is
//     the one that answers "what does a session actually cost".
//
// Usage:
//   node scripts/mopy-bench.mjs                     # the table
//   node scripts/mopy-bench.mjs --repeats 5
//   node scripts/mopy-bench.mjs --limit 100         # a quick look
//   node scripts/mopy-bench.mjs --startup           # just interpreter startup
//   node scripts/mopy-bench.mjs --json
//
// NOT in CI: a wall-clock benchmark on a shared runner measures the runner.
// CI keeps the deterministic half — conformance and routing safety.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus, referencePython } from "../tests/pygram/conformance.mjs";
import { repoDirtyList, reportRepoDamage } from "../tests/mopy/conformance.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const UNSUPPORTED_EXIT = 90;

/** The static musl build if it exists, else the glibc one — see
 *  scripts/mopy-build.sh for why the difference dominates every other variable
 *  this benchmark controls. */
function mopyBin() {
  if (process.env.MOPY_BIN) return process.env.MOPY_BIN;
  for (const t of ["x86_64-unknown-linux-musl", "i686-unknown-linux-musl"]) {
    const p = join(ROOT, `mopy/target/${t}/release/mopy`);
    if (existsSync(p)) return p;
  }
  return join(ROOT, "mopy/target/release/mopy");
}

function arms() {
  const mopy = mopyBin();
  const pygram = process.env.PYGRAM_BIN || join(ROOT, "pygram/build/pygram");
  const cpython = referencePython();
  return [
    { name: "cpython", bin: cpython, args: [] },
    { name: "pygram", bin: pygram, args: [] },
    { name: "mopy", bin: mopy, args: [] },
    { name: "mixture", bin: mopy, args: ["run"], env: { MOPY_PYGRAM: pygram, MOPY_CPYTHON: cpython } },
  ];
}

/** One timed invocation. Returns milliseconds and what the process did. */
export function timeOne(arm, program, argvTail, stdin, cwd) {
  const env = { ...process.env, PYGRAM_CAPTURE: "0", ...(arm.env || {}) };
  delete env.PYGRAM_LOG;
  const t0 = process.hrtime.bigint();
  const r = spawnSync(arm.bin, [...arm.args, "-c", program, ...argvTail], {
    input: stdin ?? "",
    encoding: "utf8",
    timeout: 15_000,
    cwd,
    env,
    maxBuffer: 64 << 20,
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const code = r.status ?? 1;
  return {
    ms,
    code,
    stdout: r.stdout ?? "",
    refused: code === UNSUPPORTED_EXIT,
    failed: r.error != null,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function fmt(n, w = 8, d = 2) {
  return (n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(d)).padStart(w);
}

function startup(available, repeats) {
  console.log(`\nstartup — \`-c 'pass'\`, min of ${repeats}\n`);
  console.log("arm         min ms   median   vs cpython");
  const base = {};
  for (const a of available) {
    const times = [];
    for (let i = 0; i < repeats; i++) times.push(timeOne(a, "pass", [], "", ROOT).ms);
    const mn = Math.min(...times);
    base[a.name] = mn;
    const rel = base.cpython ? mn / base.cpython : null;
    console.log(`${a.name.padEnd(10)}${fmt(mn)} ${fmt(median(times))}   ${rel ? `${rel.toFixed(3)}x` : ""}`);
  }
  return base;
}

async function main() {
  const argv = process.argv.slice(2);
  const num = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) || dflt : dflt;
  };
  const repeats = num("--repeats", 3);
  const limit = num("--limit", 0);
  const asJson = argv.includes("--json");
  const startupOnly = argv.includes("--startup");

  const available = arms().filter((a) => {
    if (a.name === "cpython") return true;
    if (existsSync(a.bin)) return true;
    console.error(`note: ${a.name} not built at ${a.bin} — skipping that arm`);
    return false;
  });

  const startupMs = startup(available, Math.max(repeats, 5));
  if (startupOnly) return;

  // The corpus is harvested from a real agent session, so it is full of
  // programs that edit this repository. Every entry runs in its own temp cwd,
  // but that only contains RELATIVE paths — so the run is bracketed and
  // anything it wrote into the repo is reported and restored. See
  // tests/mopy/conformance.mjs::repoDirtyList.
  const dirtyBefore = repoDirtyList(ROOT);

  let entries = loadCorpus();
  if (limit) entries = entries.slice(0, limit);

  // Per-arm, per-entry best time and outcome.
  const best = Object.fromEntries(available.map((a) => [a.name, new Map()]));
  const outcome = Object.fromEntries(available.map((a) => [a.name, new Map()]));

  for (const entry of entries) {
    for (let rep = 0; rep < repeats; rep++) {
      // Interleave the arms WITHIN each repeat, so a machine that gets busy
      // partway through loads every arm the same way.
      for (const a of available) {
        const cwd = mkdtempSync(join(tmpdir(), "mopy-bench-"));
        try {
          const r = timeOne(a, entry.program, entry.argv_tail || [], entry.stdin, cwd);
          const prev = best[a.name].get(entry.id);
          if (prev === undefined || r.ms < prev) best[a.name].set(entry.id, r.ms);
          outcome[a.name].set(entry.id, r.refused ? "refused" : r.failed ? "failed" : "ran");
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      }
    }
  }

  // The shared subset: entries every arm actually executed.
  const shared = entries
    .map((e) => e.id)
    .filter((id) => available.every((a) => outcome[a.name].get(id) === "ran"));

  const rows = available.map((a) => {
    const ranIds = entries.map((e) => e.id).filter((id) => outcome[a.name].get(id) === "ran");
    const all = ranIds.map((id) => best[a.name].get(id));
    const sh = shared.map((id) => best[a.name].get(id));
    return {
      name: a.name,
      ran: ranIds.length,
      refused: entries.length - ranIds.length,
      sharedTotal: sh.reduce((x, y) => x + y, 0),
      sharedMedian: sh.length ? median(sh) : null,
      wholeTotal: entries
        .map((e) => e.id)
        .reduce((acc, id) => acc + (best[a.name].get(id) ?? 0), 0),
      allMedian: all.length ? median(all) : null,
    };
  });

  reportRepoDamage(dirtyBefore, ROOT);

  if (asJson) {
    console.log(JSON.stringify({ entries: entries.length, shared: shared.length, repeats, startupMs, rows }, null, 2));
    return;
  }

  const cp = rows.find((r) => r.name === "cpython");
  console.log(`\ncorpus — ${entries.length} programs, min of ${repeats}, arms interleaved per entry`);
  console.log(`shared subset (every arm executed it): ${shared.length} programs\n`);
  console.log("arm         ran  refused   shared total    median   vs cpython");
  for (const r of rows) {
    const rel = cp && cp.sharedTotal ? r.sharedTotal / cp.sharedTotal : null;
    console.log(
      `${r.name.padEnd(10)}${String(r.ran).padStart(4)}${String(r.refused).padStart(9)}` +
        `${fmt(r.sharedTotal, 15, 1)} ms${fmt(r.sharedMedian, 9)}    ${rel ? `${rel.toFixed(3)}x` : ""}`,
    );
  }

  console.log(`\nwhole corpus — what a session of ${entries.length} one-liners actually costs`);
  console.log("(a refusal still costs its spawn, so this counts every entry for every arm)\n");
  console.log("arm            total     vs cpython");
  for (const r of rows) {
    const rel = cp && cp.wholeTotal ? r.wholeTotal / cp.wholeTotal : null;
    const note = r.refused ? `   (${r.refused} refused — the mixture is the only arm that answers them all)` : "";
    console.log(`${r.name.padEnd(10)}${fmt(r.wholeTotal, 10, 1)} ms      ${rel ? `${rel.toFixed(3)}x` : ""}${note}`);
  }

  const mix = rows.find((r) => r.name === "mixture");
  if (mix && cp) {
    const saved = cp.wholeTotal - mix.wholeTotal;
    console.log(
      `\nmixture vs cpython over the whole corpus: ${saved >= 0 ? "saves" : "costs"} ` +
        `${Math.abs(saved).toFixed(1)} ms across ${entries.length} programs ` +
        `(${((100 * saved) / cp.wholeTotal).toFixed(1)}%), with ${mix.refused} unanswered.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
