#!/usr/bin/env node
// The pygram performance benchmark — pygram against STOCK MicroPython.
//
// WHY A CONTROL AT ALL. pygram is a MicroPython variant: a port patch, a frozen
// stdlib, insertion-ordered dicts, unicode-aware `\w`, CPython-exact float repr,
// and a pile of config switches. Timing pygram on its own answers "how long does
// this take", which is not a question anyone needs answered. Timing it against
// the same MicroPython commit built through the same toolchain WITHOUT our
// changes answers "what did our changes cost", which is the only question a
// benchmark can settle. Stock is that control:
//
//     bash scripts/pygram-build.sh --stock     → pygram/build/micropython-stock
//
// The apples-to-apples guarantees — same pinned commit, same musl-i386 libc,
// same -Os, same static link, same strip — are enforced in build_stock() in that
// script, and its comment block lists the five deltas the offline static build
// forces. Read it before trusting a number here.
//
// CPython3 is measured too and is LABELLED THROUGHOUT AS CONTEXT, NOT THE
// CONTROL. It is a different league and a different comparison: a different
// architecture (x86-64 here against pygram's i386), decades more optimisation,
// and — the point of the whole project — a cold-start cost in the sandbox that
// pygram exists to escape (docs/PYGRAM.md §1). pygram losing to CPython on warm
// CPU is expected and is not a finding. No verdict is ever computed against it.
//
// METHODOLOGY, which is the actual deliverable:
//
//   - WARM UP. The first run of a binary pays page-in and cache misses.
//     --warmup runs (default 3) are executed and thrown away before timing.
//   - REPEAT. --repeats (default 15) timed runs per (binary, case).
//   - REPORT MEDIAN AND MIN. Median resists a single scheduling hiccup; min is
//     the least noisy estimate of the true cost of a CPU-bound microbenchmark,
//     because noise on a shared machine is one-sided — it can only ever ADD
//     time. THE VERDICT RATIO USES THE FLOOR-SUBTRACTED MIN. The median ratio is
//     printed beside it, and when the two disagree materially that disagreement
//     is itself the finding: the case is noise-dominated and neither number
//     should be quoted.
//   - SUBTRACT THE STARTUP FLOOR. `-c 'pass'` is measured per binary and
//     subtracted from every other case, so a 3 ms workload is not reported as a
//     10 ms one because process spawn and interpreter init dominate it. Both
//     raw and floor-subtracted numbers are reported; the floor itself is
//     reported raw only, since subtracting it from itself is zero by
//     construction.
//   - AN UNRUNNABLE CASE IS DATA. Stock has no `re.findall`, no match `.start()`,
//     no `collections.Counter` — those live in pygram's frozen stdlib. That is
//     recorded as `unsupported` with the reason, and the run continues. It is
//     never an error and never aborts the battery.
//   - A TIME BUDGET, so nothing can hang the run. Once a (binary, case) has
//     --min-samples timings AND has spent more than --max-case-ms, it stops
//     early and reports the n it actually got. n is printed for every cell.
//
// Usage:
//   node scripts/pygram-bench.mjs                      # the full battery
//   node scripts/pygram-bench.mjs --repeats 25
//   node scripts/pygram-bench.mjs --case dict          # substring filter
//   node scripts/pygram-bench.mjs --list               # the case list, no timing
//   node scripts/pygram-bench.mjs --json               # machine-readable
//   node scripts/pygram-bench.mjs --markdown           # the ledger entry, printed
//   node scripts/pygram-bench.mjs --record             # ... and appended
//   node scripts/pygram-bench.mjs --note "after the X patch"
//
// Run it after any variant or patch change, any MicroPython pin bump, and any
// addition to pygram/lib. It is deliberately NOT in CI: a wall-clock benchmark
// on a shared runner measures the runner. docs/PYGRAM-BENCH-LEDGER.md §"How to
// read this" says what to do with the output.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findRealCPython, measure } from "./pygram-gate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

export const DEFAULTS = {
  repeats: 15,
  warmup: 3,
  minSamples: 3,
  maxCaseMs: 30_000,
  timeoutMs: 60_000,
};

export const LEDGER_PATH = join(REPO, "docs", "PYGRAM-BENCH-LEDGER.md");
// --record inserts here rather than at the end of the file, so the ledger stays
// newest-first like docs/RAG-EVAL-LEDGER.md while no existing byte is rewritten.
export const LEDGER_MARKER = "<!-- pygram-bench: newest entry is inserted directly below this line -->";

// ---------------------------------------------------------------------------
// The cases.
//
// Every case exists because it exercises something pygram CHANGED. A benchmark
// whose cases miss the diff measures MicroPython, not the variant, and would
// report a reassuring row of 1.00 ratios forever. The `why` field is not
// decoration — it is the justification for the case being in the battery, and a
// case that cannot fill it in does not belong here.
// ---------------------------------------------------------------------------

const ASCII_TEXT = "the quick brown fox jumps over the lazy dog 12345 ".repeat(4);
const SWEDISH_TEXT = "räksmörgås på Öland åt vi 12345 därför att äpplen växer ".repeat(4);
const PIPE_STDIN = Array.from(
  { length: 2000 },
  (_, i) => `line ${i} the quick brown fox jumps over the lazy dog`,
).join("\n") + "\n";

/** A dict built by inserting n distinct string keys, then read back. */
const dictInsert = (n) => `d = {}
for i in range(${n}):
    d["k%d" % i] = i
print(len(d))`;

export const CASES = [
  {
    id: "startup-pass",
    group: "startup",
    label: "-c 'pass'",
    program: "pass",
    isFloor: true,
    rawOnly: true,
    why: "The startup floor itself: process spawn plus interpreter init, subtracted from every other case.",
  },
  {
    id: "startup-print",
    group: "startup",
    label: "-c 'print(1)'",
    program: "print(1)",
    // Floor-subtracting a case that IS essentially the floor leaves ~0 ms of
    // signal and a ratio of one noise sample over another. The startup group is
    // reported raw, and that is the whole point of measuring the floor: startup
    // is the thing every other row gets it taken off.
    rawOnly: true,
    why: "The floor plus one print. Reported raw, like the floor itself — there is nothing above the floor here to subtract.",
  },

  // The known regression. MicroPython's ordered map is a LINEAR ARRAY with a
  // linear scan, so making the Python-level dict insertion-ordered (which
  // CPython has guaranteed since 3.7, and which took MISMATCH to 0) turns dict
  // insertion quadratic. Four sizes, because one size cannot show a shape: the
  // ratio must GROW with n, and roughly 4x per doubling on pygram's own numbers.
  // If these rows do not show that, the harness is wrong before pygram is.
  ...[1000, 5000, 10_000, 20_000].map((n) => ({
    id: `dict-insert-${n / 1000}k`,
    group: "dict",
    label: `insert ${n.toLocaleString("en-US")} distinct keys`,
    program: dictInsert(n),
    why: "Insertion-ordered dict (mp_obj_new_dict is_ordered=1) against stock's open-addressing hash map. The quadratic is expected and must be visible.",
  })),
  {
    id: "dict-lookup-10k",
    group: "dict",
    label: "insert 10,000 then look up all 10,000",
    program: `d = {}
for i in range(10000):
    d["k%d" % i] = i
t = 0
for i in range(10000):
    t += d["k%d" % i]
print(t)`,
    why: "Lookup cost on an ordered map is a linear scan too. Subtract dict-insert-10k from this to read the lookup half on its own.",
  },

  // The `\w` patch (lib/re1.5/charclass.c): bytes >= 0x80 became word
  // constituents. The ASCII and non-ASCII arms are the same pattern over the
  // same amount of text, so the PAIR is the measurement — an absolute number on
  // either arm alone says nothing.
  {
    id: "re-search-ascii",
    group: "regex",
    label: String.raw`re.search(r"\w+\d") x2000, ASCII`,
    program: `import re
p = re.compile(r"\\w+\\d")
text = ${JSON.stringify(ASCII_TEXT)}
n = 0
for i in range(2000):
    if p.search(text):
        n += 1
print(n)`,
    why: "The patched \\w path on input where the patch changes nothing. pygram's `re` is a FROZEN PYTHON SHIM over the C engine (pygram/lib/re.py), so this also carries the shim's compile-and-wrap cost. The control arm for the next case.",
  },
  {
    id: "re-search-nonascii",
    group: "regex",
    label: String.raw`re.search(r"\w+\d") x2000, non-ASCII`,
    program: `import re
p = re.compile(r"\\w+\\d")
text = ${JSON.stringify(SWEDISH_TEXT)}
n = 0
for i in range(2000):
    if p.search(text):
        n += 1
print(n)`,
    why: "Same pattern over Swedish text. pygram treats bytes >= 0x80 as word constituents; stock does not, so it also scans DIFFERENT input — see the ledger's caveat before reading a ratio here as a cost.",
  },
  {
    id: "re-sub-ascii",
    group: "regex",
    label: String.raw`re.sub(r"\W+") x2000, ASCII`,
    program: `import re
text = ${JSON.stringify(ASCII_TEXT)}
n = 0
for i in range(2000):
    n += len(re.sub(r"\\W+", "-", text))
print(n)`,
    why: "The allocation-heavy regex arm. pygram's re.sub is PYTHON (pygram/lib/re.py _subn, which implements CPython's sub semantics); stock's is the C engine's. Read this row with re-sub-native, which measures the same work on the same C engine in both builds — the difference between the two rows IS the shim.",
  },
  {
    id: "re-sub-nonascii",
    group: "regex",
    label: String.raw`re.sub(r"\W+") x2000, non-ASCII`,
    program: `import re
text = ${JSON.stringify(SWEDISH_TEXT)}
n = 0
for i in range(2000):
    n += len(re.sub(r"\\W+", "-", text))
print(n)`,
    why: "The non-ASCII arm of re.sub. On stock every high byte is a separator, so it produces a very different string — a shape difference, not just a speed one.",
  },
  {
    id: "re-sub-native",
    group: "regex",
    label: String.raw`ure.sub(r"\W+") x2000, ASCII (native sub, no shim)`,
    // `ure` is the raw re1.5 engine, present under that name in BOTH builds. It
    // is what pygram's frozen `re` shim wraps. Going straight at it takes the
    // shim out of the measurement, which is the only way to tell "our regex is
    // slower" from "our regex module is a Python file".
    program: `import ure
text = ${JSON.stringify(ASCII_TEXT)}
n = 0
for i in range(2000):
    n += len(ure.sub(r"\\W+", "-", text))
print(n)`,
    why: "The DECOMPOSITION case. Same C engine on both sides, so this isolates the port patch's effect on the engine from the frozen shim's interpretation cost. If this is ~1.0x while re-sub-ascii is not, the gap is entirely the shim.",
  },
  {
    id: "re-findall-ascii",
    group: "regex",
    label: String.raw`re.findall(r"\w+") x2000, ASCII`,
    program: `import re
text = ${JSON.stringify(ASCII_TEXT)}
n = 0
for i in range(2000):
    n += len(re.findall(r"\\w+", text))
print(n)`,
    why: "findall is a FROZEN PYTHON shim in pygram (pygram/lib/re.py) and does not exist in stock at all. Expected to record stock as unsupported — that is the frozen stdlib showing up as coverage rather than as speed.",
  },
  {
    id: "re-findall-nonascii",
    group: "regex",
    label: String.raw`re.findall(r"\w+") x2000, non-ASCII`,
    program: `import re
text = ${JSON.stringify(SWEDISH_TEXT)}
n = 0
for i in range(2000):
    n += len(re.findall(r"\\w+", text))
print(n)`,
    why: "The non-ASCII arm of the frozen findall shim.",
  },

  // MICROPY_FLOAT_FORMAT_IMPL_EXACT: CPython's shortest-round-trip repr, which
  // is a Grisu-style loop rather than stock's APPROX printf. This is the case
  // most likely to have cost real time, and it has a control beside it.
  {
    id: "float-repr",
    group: "float",
    label: "str(float) x20,000",
    program: `n = 0
for i in range(20000):
    n += len(str(i * 0.1))
print(n)`,
    why: "MICROPY_FLOAT_FORMAT_IMPL_EXACT against stock's APPROX. 9.7 prints as 9.7 here and 9.699999999999999 there; this measures what that correctness costs.",
  },
  {
    id: "float-format",
    group: "float",
    label: '"%.3f" % x  x20,000',
    program: `n = 0
for i in range(20000):
    n += len("%.3f" % (i * 0.1))
print(n)`,
    why: "The CONTROL for float-repr: fixed-precision formatting takes the same code path in both builds. If this row moves too, the float-repr row is not measuring the repr change.",
  },

  {
    id: "str-methods",
    group: "str",
    label: "split/join/upper/replace x5,000, ASCII",
    program: `words = ${JSON.stringify(ASCII_TEXT)}.split()
n = 0
for i in range(5000):
    s = "-".join(words).upper().replace("-", " ")
    n += len(s.strip())
print(n)`,
    why: "Baseline str throughput. Neither build changes these; a difference here means something global moved (config, alignment, allocator) and every other row needs re-reading.",
  },
  {
    id: "str-nonascii",
    group: "str",
    label: "split/join/upper/replace x5,000, non-ASCII",
    program: `words = ${JSON.stringify(SWEDISH_TEXT)}.split()
n = 0
for i in range(5000):
    s = "-".join(words).upper().replace("-", " ")
    n += len(s.strip())
print(n)`,
    why: "The same over multi-byte text, where MICROPY_PY_BUILTINS_STR_UNICODE indexing is by character rather than by byte.",
  },
  {
    id: "str-repr-nonascii",
    group: "str",
    label: "repr(list of non-ASCII strings) x5,000",
    program: `items = ${JSON.stringify(SWEDISH_TEXT)}.split()
n = 0
for i in range(5000):
    n += len(repr(items))
print(n)`,
    why: "The objstrunicode patch: pygram prints å as å where stock escapes it to \\xe5. Different output length, so read this as a shape check rather than a clean timing.",
  },

  {
    id: "json-dumps",
    group: "json",
    label: "json.dumps(200 records) x200",
    program: `import json
data = [{"id": i, "name": "row-%d" % i, "tags": ["a", "b", "c"], "score": i * 1.5, "ok": True} for i in range(200)]
n = 0
for i in range(200):
    n += len(json.dumps(data))
print(n)`,
    why: "json is C in both, but every dict it walks is an ORDERED map in pygram — this is where the ordered-dict change reaches ordinary code.",
  },
  {
    id: "json-loads",
    group: "json",
    label: "json.loads(200 records) x200",
    program: `import json
data = [{"id": i, "name": "row-%d" % i, "tags": ["a", "b", "c"], "score": i * 1.5, "ok": True} for i in range(200)]
src = json.dumps(data)
n = 0
for i in range(200):
    n += len(json.loads(src))
print(n)`,
    why: "Parsing builds 200 small dicts per iteration, all of them ordered in pygram. The ordered-map cost at small n, which is where real one-liners live.",
  },

  {
    id: "sort-ints",
    group: "sort",
    label: "sorted(8,000 ints)",
    // 8,000 and not 20,000: BOTH builds raise MemoryError above about 9,000
    // here, from the same default heap. A case that fails identically on both
    // is not a comparison, and a benchmark that quietly reports two
    // MemoryErrors as a tie is worse than one that does not run the case.
    program: `x = 12345
xs = []
for i in range(8000):
    x = (x * 1103515245 + 12345) % 2147483648
    xs.append(x)
xs = sorted(xs)
print(xs[0], xs[-1], len(xs))`,
    why: "Pure VM throughput on a workload neither build touches — the second global control beside str-methods.",
  },
  {
    id: "sort-strings",
    group: "sort",
    label: "sorted(5,000 strings)",
    program: `x = 12345
xs = []
for i in range(5000):
    x = (x * 1103515245 + 12345) % 2147483648
    xs.append("k%d" % x)
xs = sorted(xs)
print(xs[0], xs[-1], len(xs))`,
    why: "String comparison throughput, which the unicode config touches.",
  },

  {
    id: "counter-most-common",
    group: "collections",
    label: "Counter(words).most_common(5) x500",
    program: `from collections import Counter
words = ${JSON.stringify(ASCII_TEXT)}.split() * 20
n = 0
for i in range(500):
    n += len(Counter(words).most_common(5))
print(n)`,
    why: "Counter is a FROZEN PYTHON module in pygram and absent from stock. Expected to record stock as unsupported, and to be slow here because it is interpreted Python over an ordered dict — the two variant changes compounding.",
  },

  // The corpus's largest cluster (docs/PYGRAM.md §7): stdin -> transform ->
  // stdout. These are the only cases shaped like something an agent actually
  // types, and they are the ones a regression would be felt in.
  {
    id: "pipe-wordcount",
    group: "pipeline",
    label: "stdin 2,000 lines -> word count -> stdout",
    program: `import sys
total = 0
for line in sys.stdin.read().split("\\n"):
    total += len(line.split())
print(total)`,
    stdin: PIPE_STDIN,
    why: "The realistic shape: read all of stdin, split, count, print one number.",
  },
  {
    id: "pipe-freq",
    group: "pipeline",
    label: "stdin 2,000 lines -> frequency dict -> top 5",
    program: `import sys
freq = {}
for line in sys.stdin.read().split("\\n"):
    for w in line.split():
        freq[w] = freq.get(w, 0) + 1
pairs = sorted(freq.items(), key=lambda kv: -kv[1])
for k, v in pairs[:5]:
    print(k, v)`,
    stdin: PIPE_STDIN,
    why: "A word-frequency one-liner — the exact pattern that meets the ordered-dict cost in the wild, with ~2,000 distinct keys.",
  },
  {
    id: "pipe-transform",
    group: "pipeline",
    label: "stdin 2,000 lines -> filter + upper -> stdout",
    program: `import sys
out = []
for line in sys.stdin.read().split("\\n"):
    if "fox" in line:
        out.append(line.upper())
print(len(out), len("\\n".join(out)))`,
    stdin: PIPE_STDIN,
    why: "Filter-and-transform, the other half of the pipeline cluster, and the one that returns bulk text across the VM boundary.",
  },
];

// ---------------------------------------------------------------------------
// Pure statistics. Everything below this line up to runCase() is unit-tested in
// scripts/pygram-bench.test.mjs; nothing here reads a clock.
// ---------------------------------------------------------------------------

/** Median of a sample. Even n averages the two middle values, as convention. */
export function median(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Summarize a sample of timings. Returns null-safe plain numbers. */
export function summarize(xs) {
  if (!Array.isArray(xs) || xs.length === 0) return { n: 0, min: null, median: null, max: null, mean: null, spread: null };
  const n = xs.length;
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  // spread is (max - min) / min: a plain, unitless read on how noisy the sample
  // was. It is the number that decides whether a small ratio is a finding or a
  // shrug, so it is carried all the way through to the table.
  return { n, min, median: median(xs), max, mean, spread: min > 0 ? (max - min) / min : null };
}

/** a/b, null when either side is missing or b is zero. Never throws. */
export function ratio(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

/**
 * Subtract the startup floor from a measurement.
 *
 * Clamped at zero: a workload cannot cost less than nothing, and a tiny case
 * whose timing dips below the floor sample is noise, not a negative cost.
 */
export function floorSubtract(ms, floorMs) {
  if (ms === null || ms === undefined || floorMs === null || floorMs === undefined) return null;
  return Math.max(0, ms - floorMs);
}

/**
 * Decide what one interpreter run MEANS.
 *
 * The distinction that matters: a binary that cannot run a case is DATA
 * (`unsupported`), and the battery keeps going. Only a spawn failure, a timeout,
 * or a non-zero exit with no recognizable Python failure in it is an `error`.
 * Collapsing the two would either abort the run on stock's missing re.findall or
 * silently swallow a broken case program.
 *
 * STDOUT IS SEARCHED TOO, and that is not sloppiness. **Stock MicroPython writes
 * uncaught tracebacks to STDOUT**; pygram's port patch moved them to stderr,
 * because a traceback on stdout means `python … | wc -l` counts the traceback
 * (docs/PYGRAM.md, and the pygram skill §5 records it as a paid-for trap). So
 * the control's failures arrive on a different stream from pygram's, and a
 * classifier that only reads stderr reports every stock gap as a bare `exit 1`
 * with no reason — which is how "unsupported" quietly becomes "error".
 */
const PY_EXCEPTION = /\b(?:[A-Z]\w*(?:Error|Exception|Interrupt))\b/;
const PYGRAM_UNSUPPORTED = /^pygram: unsupported: (\w+): (.+)$/m;

export function classifyRun({ status, stdout = "", stderr = "", timedOut = false, spawnFailed = false }) {
  if (spawnFailed) return { status: "error", reason: (stderr || "spawn failed").split("\n")[0].slice(0, 160) };
  if (timedOut) return { status: "error", reason: "timed out" };
  if (status === 0) return { status: "ok", reason: null };

  const contract = PYGRAM_UNSUPPORTED.exec(stderr || "");
  if (status === 90 && contract) {
    return { status: "unsupported", reason: `pygram contract: ${contract[1]}: ${contract[2]}` };
  }
  const lastLine = (text) => {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || "";
  };
  for (const stream of [stderr, stdout]) {
    const last = lastLine(stream);
    if (PY_EXCEPTION.test(last)) return { status: "unsupported", reason: last.slice(0, 160) };
  }
  const shown = lastLine(stderr) || lastLine(stdout);
  return { status: "error", reason: `exit ${status}${shown ? `: ${shown.slice(0, 120)}` : ""}` };
}

/**
 * Build the comparison row for one case from the per-binary cells.
 *
 * `floors` is `{min: {binId: ms}, median: {binId: ms}}` from the startup-floor
 * case. Each statistic is subtracted LIKE FOR LIKE — the min floor off the min,
 * the median floor off the median — because mixing them would attribute the
 * floor's own noise to the workload.
 *
 * `ratioMin` is the verdict (floor-subtracted min, pygram/stock); `ratioMedian`
 * sits beside it, and `noisy` is set when the two disagree by more than 25% of
 * the smaller — the harness's own statement that the row must not be quoted as
 * a finding.
 */
export function buildRow(caseDef, cells, floors = { min: {}, median: {} }) {
  const rawOnly = !!(caseDef.rawOnly || caseDef.isFloor);
  const net = (binId, key) => {
    const cell = cells[binId];
    if (!cell || cell.status !== "ok") return null;
    if (rawOnly) return cell[key];
    return floorSubtract(cell[key], floors[key]?.[binId] ?? null);
  };
  const row = {
    id: caseDef.id,
    group: caseDef.group,
    label: caseDef.label,
    isFloor: !!caseDef.isFloor,
    rawOnly,
    cells,
    net: {},
  };
  for (const binId of Object.keys(cells)) {
    row.net[binId] = { min: net(binId, "min"), median: net(binId, "median") };
  }
  row.ratioMin = ratio(row.net.pygram?.min, row.net.stock?.min);
  row.ratioMedian = ratio(row.net.pygram?.median, row.net.stock?.median);
  row.noisy = isDisagreement(row.ratioMin, row.ratioMedian);
  return row;
}

/** True when the min-based and median-based ratios tell different stories. */
export function isDisagreement(a, b, tolerance = 0.25) {
  if (a === null || b === null) return false;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo <= 0) return false;
  return (hi - lo) / lo > tolerance;
}

// ---------------------------------------------------------------------------
// Rendering. Pure: takes rows, returns strings.
// ---------------------------------------------------------------------------

export function fmtMs(v) {
  if (v === null || v === undefined) return "–";
  if (v >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (v >= 10) return `${v.toFixed(1)}`;
  if (v >= 1) return `${v.toFixed(2)}`;
  return `${v.toFixed(3)}`;
}

export function fmtRatio(v) {
  if (v === null || v === undefined) return "–";
  return `${v.toFixed(2)}x`;
}

/** Fixed-width text table. Columns are right-aligned except the first. */
export function renderTextTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? "").length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => (i === 0 ? String(c ?? "").padEnd(widths[i]) : String(c ?? "").padStart(widths[i])))
      .join("  ")
      .trimEnd();
  const out = [line(headers), widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of rows) out.push(line(r));
  return out.join("\n");
}

/** GitHub-flavoured markdown table. */
export function renderMarkdownTable(headers, rows) {
  const esc = (c) => String(c ?? "").replace(/\|/g, "\\|");
  const out = [`| ${headers.map(esc).join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const r of rows) out.push(`| ${r.map(esc).join(" | ")} |`);
  return out.join("\n");
}

const CELL_STATE = { ok: "", unsupported: "unsupported", error: "ERROR" };

/** One row of the main table, as display cells. */
export function rowCells(row, binIds) {
  const cells = [row.label];
  for (const binId of binIds) {
    const c = row.cells[binId];
    if (!c || c.status !== "ok") {
      cells.push(c ? CELL_STATE[c.status] || c.status : "–");
      continue;
    }
    const n = c.n;
    const value = row.net[binId].min;
    cells.push(`${fmtMs(value)}${n && n < c.requested ? ` (n=${n})` : ""}${row.rawOnly ? " raw" : ""}`);
  }
  cells.push(fmtRatio(row.ratioMin));
  cells.push(`${fmtRatio(row.ratioMedian)}${row.noisy ? " !" : ""}`);
  return cells;
}

export function tableHeaders(binIds, labels = {}) {
  return ["case", ...binIds.map((b) => labels[b] || b), "py/stock min", "py/stock med"];
}

/**
 * The full report body, shared by the terminal output and the ledger entry.
 * `render` is either renderTextTable or renderMarkdownTable; `heading` wraps the
 * section titles, so the terminal gets plain lines and the ledger gets markdown
 * headings instead of stray paragraphs above each table.
 */
export function renderReport(run, render, { heading = (s) => s } = {}) {
  const { rows, binIds, binLabels, shapes, config, machine, identity } = run;
  const out = [];

  out.push(heading("Binaries"));
  out.push(
    render(
      ["binary", "bytes", "linkage", "opens on -c 'pass'", "failed probes", "stat/access", "sha256"],
      binIds.map((b) => {
        const s = shapes[b] || {};
        return [
          binLabels[b] || b,
          s.bytes ? s.bytes.toLocaleString("en-US") : "–",
          s.isStatic ? `static ${s.arch || ""}`.trim() : s.exists ? "dynamic" : "missing",
          s.opens === null || s.opens === undefined ? "unmeasured" : String(s.opens),
          s.failedOpens ?? "–",
          s.statLike ?? "–",
          (identity[b]?.sha256 || "").slice(0, 12),
        ];
      }),
    ),
  );
  out.push("");

  out.push(heading(`Floor-subtracted workload, min of n=${config.repeats} (ms unless marked s)`));
  const headers = tableHeaders(binIds, binLabels);
  let lastGroup = null;
  const bodyRows = [];
  for (const row of rows) {
    if (row.group !== lastGroup) {
      lastGroup = row.group;
      bodyRows.push([`**${row.group}**`, ...binIds.map(() => ""), "", ""]);
    }
    bodyRows.push(rowCells(row, binIds));
  }
  out.push(render(headers, bodyRows));
  out.push("");

  out.push(heading("Raw wall clock, median / min (ms unless marked s)"));
  out.push(
    render(
      ["case", ...binIds.flatMap((b) => [`${binLabels[b] || b} med`, `${binLabels[b] || b} min`])],
      rows.map((row) => [
        row.label,
        ...binIds.flatMap((b) => {
          const c = row.cells[b];
          if (!c || c.status !== "ok") return [CELL_STATE[c?.status] ?? "–", ""];
          return [fmtMs(c.median), fmtMs(c.min)];
        }),
      ]),
    ),
  );
  out.push("");

  const unsupported = rows.flatMap((row) =>
    binIds
      .filter((b) => row.cells[b] && row.cells[b].status !== "ok")
      .map((b) => [row.label, binLabels[b] || b, row.cells[b].status, row.cells[b].reason || ""]),
  );
  if (unsupported.length) {
    out.push(heading("Cases a binary could not run (data, not failures)"));
    out.push(render(["case", "binary", "verdict", "reason"], unsupported));
    out.push("");
  }

  const noisy = rows.filter((r) => r.noisy);
  if (noisy.length) {
    out.push(
      `Noise warning: ${noisy.length} case(s) where the min-based and median-based ratios disagree by more than 25% — ` +
        `${noisy.map((r) => r.id).join(", ")}. Do not quote these as findings.`,
    );
    out.push("");
  }

  out.push(
    `Machine: ${machine.cpu} x${machine.cores}, ${machine.memGb} GB, ${machine.kernel}, node ${machine.node}. ` +
      `Load average at start/end: ${machine.loadStart} / ${machine.loadEnd}.`,
  );
  out.push(
    `Config: repeats=${config.repeats} warmup=${config.warmup} max-case-ms=${config.maxCaseMs}. ` +
      `Verdict ratio uses the floor-subtracted MIN.`,
  );
  return out.join("\n");
}

/** The dated ledger entry. Pure — takes the finished run, returns markdown. */
export function renderLedgerEntry(run) {
  const { date, identity, note } = run;
  const out = [];
  out.push(`## ${date} — pygram vs stock MicroPython${note ? ` — ${note}` : ""}`);
  out.push("");
  out.push(
    `MicroPython pin **${identity.pin.tag}** (\`${identity.pin.commit.slice(0, 12)}\`), ` +
      `repo \`${identity.repo.sha.slice(0, 12)}\`${identity.repo.dirty ? " (working tree dirty)" : ""} ` +
      `on branch \`${identity.repo.branch}\`. ` +
      `Control built by \`bash scripts/pygram-build.sh --stock\`.`,
  );
  out.push("");
  out.push(renderReport(run, renderMarkdownTable, { heading: (s) => `### ${s}` }));
  out.push("");
  return out.join("\n");
}

/**
 * Insert an entry into the ledger, newest-first, without rewriting a byte of
 * what is already there. Throws when the marker is missing rather than
 * appending somewhere plausible — a ledger that silently reorders itself is not
 * append-only.
 */
export function insertLedgerEntry(existing, entry, marker = LEDGER_MARKER) {
  const idx = String(existing).indexOf(marker);
  if (idx < 0) {
    throw new Error(`ledger marker not found: ${marker}`);
  }
  const cut = idx + marker.length;
  const head = existing.slice(0, cut);
  const tail = existing.slice(cut);
  return `${head}\n\n${entry.trim()}\n\n---\n${tail.replace(/^\n+/, "\n")}`;
}

// ---------------------------------------------------------------------------
// Measurement. Everything below reads a clock and is deliberately NOT unit
// tested — a wall-clock assertion in `npm test` is a flaky test, not a check.
// ---------------------------------------------------------------------------

function runOnce(bin, caseDef, cwd, timeoutMs) {
  const started = process.hrtime.bigint();
  const res = spawnSync(bin, ["-c", caseDef.program, ...(caseDef.argv || [])], {
    input: caseDef.stdin ?? "",
    encoding: "utf8",
    timeout: timeoutMs,
    cwd,
    // A minimal, explicit environment. MICROPYPATH in particular must NOT leak
    // in: it would change stock's sys.path and therefore its startup floor.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C.UTF-8", PWD: cwd },
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  if (res.error && res.error.code === "ETIMEDOUT") return { ms, timedOut: true, stderr: "", status: null };
  if (res.error) return { ms, spawnFailed: true, stderr: String(res.error.message), status: null };
  return { ms, status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Warm up, then time. Returns one cell: {status, reason, n, min, median, ...}. */
function runCase(bin, caseDef, cwd, config) {
  // The support probe IS the first warmup run. If the binary cannot run the
  // case there is nothing to time and the reason is recorded instead.
  const probe = runOnce(bin, caseDef, cwd, config.timeoutMs);
  const verdict = classifyRun(probe);
  if (verdict.status !== "ok") {
    return { status: verdict.status, reason: verdict.reason, n: 0, requested: config.repeats, stdout: probe.stdout };
  }
  for (let i = 1; i < config.warmup; i++) runOnce(bin, caseDef, cwd, config.timeoutMs);

  const samples = [];
  const budgetStart = process.hrtime.bigint();
  for (let i = 0; i < config.repeats; i++) {
    const r = runOnce(bin, caseDef, cwd, config.timeoutMs);
    const v = classifyRun(r);
    if (v.status !== "ok") {
      // A case that ran in warmup and then failed is a real problem, not
      // coverage. Report it as an error with what we have.
      return { status: "error", reason: `became ${v.status} at repeat ${i + 1}: ${v.reason}`, n: samples.length, requested: config.repeats };
    }
    samples.push(r.ms);
    const spent = Number(process.hrtime.bigint() - budgetStart) / 1e6;
    if (samples.length >= config.minSamples && spent > config.maxCaseMs) break;
  }
  return { status: "ok", reason: null, requested: config.repeats, stdout: probe.stdout, ...summarize(samples) };
}

function sha256File(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

function gitOut(args, fallback = "") {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : fallback;
}

function readPin() {
  try {
    const src = readFileSync(join(REPO, "scripts", "pygram-build.sh"), "utf8");
    const tag = /^MPY_TAG="([^"]+)"/m.exec(src);
    const commit = /^MPY_COMMIT="([^"]+)"/m.exec(src);
    return { tag: tag ? tag[1] : "unknown", commit: commit ? commit[1] : "unknown" };
  } catch {
    return { tag: "unknown", commit: "unknown" };
  }
}

function loadAvg() {
  try {
    return readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/).slice(0, 3).join(" ");
  } catch {
    return "unknown";
  }
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
  };

  const config = {
    repeats: Number(opt("repeats", DEFAULTS.repeats)),
    warmup: Number(opt("warmup", DEFAULTS.warmup)),
    minSamples: Number(opt("min-samples", DEFAULTS.minSamples)),
    maxCaseMs: Number(opt("max-case-ms", DEFAULTS.maxCaseMs)),
    timeoutMs: Number(opt("timeout-ms", DEFAULTS.timeoutMs)),
  };

  const filter = opt("case", null);
  const selected = CASES.filter(
    (c) => c.isFloor || !filter || c.id.includes(filter) || c.group.includes(filter),
  );

  if (flag("list")) {
    for (const c of CASES) console.log(`${c.id.padEnd(24)} ${c.group.padEnd(12)} ${c.label}\n${" ".repeat(24)} why: ${c.why}`);
    return;
  }

  const pygramBin = resolve(opt("pygram", process.env.PYGRAM_BIN || join(REPO, "pygram", "build", "pygram")));
  const stockBin = resolve(opt("stock", process.env.PYGRAM_STOCK_BIN || join(REPO, "pygram", "build", "micropython-stock")));

  if (!existsSync(pygramBin)) {
    console.error(`pygram-bench: no pygram binary at ${pygramBin}\n  build it:  bash scripts/pygram-build.sh`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(stockBin)) {
    console.error(
      `pygram-bench: no stock control at ${stockBin}\n` +
        "  build it:  bash scripts/pygram-build.sh --stock\n" +
        "  The control is the point of this harness — pygram's own timings on their own\n" +
        "  measure nothing. Refusing to run without it.",
    );
    process.exitCode = 2;
    return;
  }

  // CPython, found with pygram-gate's PATH walk rather than `command -v`. That
  // walk exists because the capture harness installs an 8,971-byte `python3`
  // SHELL SHIM early on PATH; timing the shim would report CPython as far slower
  // than it is, and a wrong baseline is worse than none because it looks like a
  // number (the pygram skill, §5).
  let cpythonBin = flag("no-cpython") ? null : findRealCPython();
  if (cpythonBin && !existsSync(cpythonBin)) cpythonBin = null;

  const binIds = ["pygram", "stock", ...(cpythonBin ? ["cpython"] : [])];
  const bins = { pygram: pygramBin, stock: stockBin, cpython: cpythonBin };
  const binLabels = {
    pygram: "pygram",
    stock: "stock",
    cpython: "CPython3*",
  };

  const loadStart = loadAvg();
  const cwd = mkdtempSync(join(tmpdir(), "pygram-bench-"));

  console.error(`pygram-bench: ${selected.length} cases x ${config.repeats} repeats x ${binIds.length} binaries`);
  console.error(`  pygram  ${pygramBin}`);
  console.error(`  stock   ${stockBin}`);
  console.error(`  cpython ${cpythonBin || "(not found — context column omitted)"}`);

  const shapes = {};
  for (const id of binIds) shapes[id] = measure(bins[id]);

  // Measure every case first, then build the rows. The floor case has to be
  // known before any row can be floor-subtracted, and doing it in two passes is
  // what keeps that ordering from being an accident of the case list.
  const floors = { min: {}, median: {} };
  const measured = [];
  try {
    for (const caseDef of selected) {
      const cells = {};
      for (const id of binIds) {
        process.stderr.write(`  ${caseDef.id} / ${id}${" ".repeat(30)}\r`);
        cells[id] = runCase(bins[id], caseDef, cwd, config);
      }
      if (caseDef.isFloor) {
        for (const id of binIds) {
          floors.min[id] = cells[id].status === "ok" ? cells[id].min : null;
          floors.median[id] = cells[id].status === "ok" ? cells[id].median : null;
        }
      }
      measured.push({ caseDef, cells });
    }
  } finally {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.stderr.write(`${" ".repeat(60)}\r`);

  const rows = measured.map(({ caseDef, cells }) => buildRow(caseDef, cells, floors));

  const run = {
    date: new Date().toISOString().slice(0, 10),
    note: opt("note", ""),
    config,
    binIds,
    binLabels,
    rows,
    shapes,
    identity: {
      pin: readPin(),
      repo: {
        sha: gitOut(["rev-parse", "HEAD"], "unknown"),
        branch: gitOut(["rev-parse", "--abbrev-ref", "HEAD"], "unknown"),
        dirty: gitOut(["status", "--porcelain"], "") !== "",
      },
      pygram: { path: pygramBin, sha256: sha256File(pygramBin) },
      stock: { path: stockBin, sha256: sha256File(stockBin) },
      cpython: cpythonBin ? { path: cpythonBin, sha256: sha256File(cpythonBin) } : null,
    },
    machine: {
      cpu: (cpus()[0] || {}).model || "unknown",
      cores: cpus().length,
      memGb: Math.round(totalmem() / 1e9),
      kernel: (spawnSync("uname", ["-srm"], { encoding: "utf8" }).stdout || "").trim(),
      node: process.version,
      loadStart,
      loadEnd: loadAvg(),
    },
  };

  if (flag("json")) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  if (flag("markdown") || flag("record")) {
    const entry = renderLedgerEntry(run);
    if (flag("markdown")) console.log(entry);
    if (flag("record")) {
      const existing = readFileSync(LEDGER_PATH, "utf8");
      writeFileSync(LEDGER_PATH, insertLedgerEntry(existing, entry));
      console.error(`pygram-bench: appended a ${run.date} entry to docs/PYGRAM-BENCH-LEDGER.md`);
    }
    if (flag("markdown")) return;
  }

  console.log("");
  console.log(renderReport(run, renderTextTable));
  console.log("");
  console.log("* CPython3 is CONTEXT, not the control: different architecture, different league.");
  console.log("  No verdict is computed against it. The control is stock MicroPython.");
  console.log("  A trailing ! marks a row whose min and median ratios disagree — noise, not a finding.");
  console.log("");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
