#!/usr/bin/env node
//
// Time the WHOLE pygram corpus, on one binary or on two of them A/B.
//
//   node scripts/pygram-corpus-time.mjs pygram/build/pygram
//   node scripts/pygram-corpus-time.mjs A.bin B.bin --repeats 5
//   node scripts/pygram-corpus-time.mjs A.bin B.bin --json
//
// WHY THIS EXISTS, and why it is not scripts/pygram-bench.mjs.
//
// The bench harness answers "what did our variant cost against stock
// MicroPython", case by case, on workloads written to isolate a subsystem.
// This answers a different question: "did this change make the programs pygram
// is actually asked to run faster". Those are not the same measurement, and the
// project has already paid for confusing them — docs/PYGRAM.md §8a records a
// synthetic workload that said computed-goto was worth 48 ms per program when
// the real corpus said 0.14 ms. A microbenchmark loops 20,000 times; a corpus
// entry runs once and exits, so its cost is dominated by startup, parse and
// compile rather than by steady-state dispatch. Optimising against the first
// distribution and shipping to the second is how a speed pass produces numbers
// that nobody can feel.
//
// So: this is the acceptance instrument for a change made in the name of speed,
// and the bench is the diagnostic that says WHERE the time went.
//
// HOW IT MEASURES, and why each choice is load-bearing:
//
//   - MIN, not mean. Noise on a shared box is one-sided: scheduling, page
//     faults and neighbours can only ADD time. The minimum over repeats is the
//     least biased estimate of the true cost. Same rule as pygram-bench.mjs.
//   - INTERLEAVED A/B. Both binaries run the same entry back to back, inside
//     the same repeat, so a machine that gets busier halfway through penalises
//     both arms equally instead of whichever one ran second.
//   - A TEMP CWD PER ENTRY. Corpus programs write files (the harvested set
//     contains entries that rewrite scripts wholesale). Without this they
//     litter — or worse, mutate — the repository, and one entry's output
//     becomes the next entry's input. Same defence as the conformance runner.
//   - PYGRAM_CAPTURE=0 in the child environment. The capture shim logs every
//     python invocation, and a timing run that feeds 340 synthetic sightings
//     back into the corpus corrupts the frequency table that decides build
//     order (docs/PYGRAM.md §7a).
//   - UNSUPPORTED (exit 90) entries are TIMED, NOT SKIPPED. Exiting 90 costs
//     startup plus a parse, which is real time the agent waits for. But they
//     are counted separately, because a change that moves an entry between
//     supported and unsupported changes what is being timed, and that must be
//     visible rather than absorbed into the total.
//
// The output is deliberately a total plus the biggest movers. A per-entry
// table of 340 rows invites reading noise as signal; the total is the number a
// session should quote, and the movers are where to look next.

import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const CORPUS_FILES = [
  join(REPO, "tests/pygram/corpus.jsonl"),
  join(REPO, "tests/pygram/seed-corpus.jsonl"),
];

// A corpus entry is one program plus how it is invoked. Both files carry the
// same shape for the fields that matter here; seed entries name their stdin
// `stdin` and harvested ones sample it as `stdin_sample`.
export function loadCorpus(files = CORPUS_FILES) {
  const out = [];
  const seen = new Set();
  for (const f of files) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line);
      if (typeof raw.program !== "string" || !raw.program) continue;
      const id = raw.id || `anon-${out.length}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        program: raw.program,
        argv_tail: Array.isArray(raw.argv_tail) ? raw.argv_tail : [],
        stdin:
          typeof raw.stdin === "string"
            ? raw.stdin
            : typeof raw.stdin_sample === "string"
              ? raw.stdin_sample
              : "",
      });
    }
  }
  return out;
}

// One execution. Returns elapsed milliseconds and the exit status, or null when
// the child could not be spawned at all — a spawn failure is not a timing.
export function runEntry(bin, entry, cwd, timeoutMs = 10_000) {
  const t0 = process.hrtime.bigint();
  const res = spawnSync(bin, ["-c", entry.program, ...entry.argv_tail], {
    input: entry.stdin,
    cwd,
    timeout: timeoutMs,
    // Output is captured and discarded: a corpus program's stdout is not the
    // measurement, and letting it inherit would interleave 340 programs'
    // output with the progress line.
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYGRAM_CAPTURE: "0" },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.error && res.error.code === "ENOENT") return null;
  return { ms, status: res.status, timedOut: res.error?.code === "ETIMEDOUT" };
}

// The mins, one arm at a time, with the arms interleaved per entry per repeat.
export function timeCorpus(bins, corpus, repeats, onProgress) {
  const best = bins.map(() => new Map());
  const status = bins.map(() => new Map());
  for (let r = 0; r < repeats; r++) {
    for (const entry of corpus) {
      for (let b = 0; b < bins.length; b++) {
        const dir = mkdtempSync(join(tmpdir(), "pygram-corpus-"));
        try {
          const got = runEntry(bins[b], entry, dir);
          if (!got) continue;
          const prev = best[b].get(entry.id);
          if (prev === undefined || got.ms < prev) best[b].set(entry.id, got.ms);
          status[b].set(entry.id, got.timedOut ? "timeout" : got.status);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      onProgress?.(r, entry);
    }
  }
  return { best, status };
}

function summarise(best, status, corpus) {
  let total = 0;
  let unsupported = 0;
  let failed = 0;
  let timeouts = 0;
  for (const e of corpus) {
    const ms = best.get(e.id);
    if (ms === undefined) continue;
    total += ms;
    const st = status.get(e.id);
    if (st === "timeout") timeouts++;
    else if (st === 90) unsupported++;
    else if (st !== 0) failed++;
  }
  return { total, unsupported, failed, timeouts, timed: best.size };
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const repeatsIdx = args.indexOf("--repeats");
  const repeats = repeatsIdx >= 0 ? Number(args[repeatsIdx + 1]) : 3;
  const topIdx = args.indexOf("--top");
  const top = topIdx >= 0 ? Number(args[topIdx + 1]) : 12;
  const bins = args.filter((a, i) => {
    if (a.startsWith("--")) return false;
    if (repeatsIdx >= 0 && i === repeatsIdx + 1) return false;
    if (topIdx >= 0 && i === topIdx + 1) return false;
    return true;
  });

  if (bins.length < 1 || bins.length > 2) {
    console.error(
      "usage: pygram-corpus-time.mjs <binA> [binB] [--repeats N] [--top N] [--json]",
    );
    process.exitCode = 2;
    return;
  }
  // Resolve to absolute: every entry runs in its own temp cwd, so a relative
  // binary path would resolve against that directory and vanish. This exact
  // trap is recorded in the pygram skill §5.
  const abs = bins.map((b) => resolve(b));
  for (const b of abs) {
    if (!existsSync(b)) {
      console.error(`no such binary: ${b}`);
      process.exitCode = 2;
      return;
    }
  }

  const corpus = loadCorpus();
  if (!asJson) {
    console.log(
      `\n${corpus.length} corpus programs x ${repeats} repeats x ${abs.length} binar${abs.length === 1 ? "y" : "ies"}\n`,
    );
  }

  let done = 0;
  const totalRuns = corpus.length * repeats;
  const { best, status } = timeCorpus(abs, corpus, repeats, () => {
    done++;
    if (!asJson && done % 50 === 0) {
      process.stderr.write(`  ${done}/${totalRuns}\r`);
    }
  });
  if (!asJson) process.stderr.write("            \r");

  const sums = abs.map((_, i) => summarise(best[i], status[i], corpus));

  if (asJson) {
    const payload = {
      corpus: corpus.length,
      repeats,
      binaries: abs.map((b, i) => ({ path: b, ...sums[i] })),
      entries: corpus.map((e) => ({
        id: e.id,
        ms: abs.map((_, i) => best[i].get(e.id) ?? null),
        status: abs.map((_, i) => status[i].get(e.id) ?? null),
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  for (let i = 0; i < abs.length; i++) {
    const s = sums[i];
    console.log(`  ${String.fromCharCode(65 + i)}  ${abs[i]}`);
    console.log(
      `     total ${fmt(s.total)} over ${s.timed} programs` +
        `   (${s.unsupported} exit-90, ${s.failed} nonzero, ${s.timeouts} timeout)`,
    );
  }

  if (abs.length === 2) {
    const [a, b] = sums;
    const ratio = b.total / a.total;
    console.log(
      `\n  B/A ${ratio.toFixed(3)}x   ${ratio < 1 ? "B is faster" : ratio > 1 ? "B is SLOWER" : "no change"}` +
        `   (${fmt(b.total - a.total)} on the total)`,
    );
    // A change worth shipping moves the total. Per-entry deltas are noisy at
    // the millisecond scale a one-liner lives at, so they are shown only as a
    // pointer to where to look, never as the verdict.
    const movers = corpus
      .map((e) => {
        const x = best[0].get(e.id);
        const y = best[1].get(e.id);
        if (x === undefined || y === undefined) return null;
        return { id: e.id, a: x, b: y, d: y - x };
      })
      .filter(Boolean)
      .sort((p, q) => Math.abs(q.d) - Math.abs(p.d))
      .slice(0, top);
    if (movers.length) {
      console.log(`\n  biggest movers (pointer, not verdict)`);
      for (const m of movers) {
        console.log(
          `    ${m.id.padEnd(28)} ${m.a.toFixed(1).padStart(8)} -> ${m.b.toFixed(1).padStart(8)} ms  ${m.d > 0 ? "+" : ""}${m.d.toFixed(1)}`,
        );
      }
    }
    // Status changes are the thing that silently invalidates the comparison:
    // an entry that started exiting 90 got cheaper by losing a capability.
    const flips = corpus.filter((e) => {
      const x = status[0].get(e.id);
      const y = status[1].get(e.id);
      return x !== undefined && y !== undefined && x !== y;
    });
    if (flips.length) {
      console.log(
        `\n  !! ${flips.length} entr${flips.length === 1 ? "y" : "ies"} changed EXIT STATUS between the two binaries — the`,
      );
      console.log(
        `     comparison is not like for like. Run the conformance battery.`,
      );
      for (const e of flips.slice(0, 10)) {
        console.log(
          `       ${e.id.padEnd(28)} ${status[0].get(e.id)} -> ${status[1].get(e.id)}`,
        );
      }
    }
  }
  console.log("");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
