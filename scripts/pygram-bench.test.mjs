// Unit tests for the pygram benchmark harness (scripts/pygram-bench.mjs) — the
// pure parts only: the statistics, the ratio arithmetic, the classifier that
// decides whether a binary "cannot run this case" or "went wrong", the table
// renderers, and the append-only ledger insertion.
//
// NOTHING HERE ASSERTS A WALL-CLOCK TIMING, and that is deliberate. A test that
// says "the 10,000-key dict case takes under 800 ms" is a flake generator on a
// shared runner, and the benchmark's own methodology (report min and median,
// warn when they disagree) exists precisely because those numbers are not
// stable enough to assert on. The timings are a measurement to be read, not a
// gate to be passed; `npm test` checks the machinery that turns them into a
// number, and docs/PYGRAM-BENCH-LEDGER.md holds the numbers.
//
// Two of these tests pin bugs the harness actually had while it was being
// written, and both would have produced a plausible-looking wrong table rather
// than a crash:
//
//   - Stock MicroPython writes uncaught tracebacks to STDOUT (pygram's port
//     patch moved them to stderr). A classifier reading only stderr reported
//     every one of stock's missing features as a bare `exit 1` with no reason,
//     turning "unsupported — this is coverage" into "ERROR".
//   - The floor must be subtracted like for like: the min floor off the min,
//     the median floor off the median. Mixing them attributes the floor's own
//     noise to the workload.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CASES,
  LEDGER_MARKER,
  buildRow,
  classifyRun,
  floorSubtract,
  fmtMs,
  fmtRatio,
  insertLedgerEntry,
  isDisagreement,
  median,
  ratio,
  renderMarkdownTable,
  renderTextTable,
  rowCells,
  summarize,
  tableHeaders,
} from "./pygram-bench.mjs";

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test("median takes the middle value, and averages the two middles at even n", () => {
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  // Order must not matter — the samples arrive in run order, not sorted.
  assert.equal(median([9, 1, 8, 2, 7]), 7);
  assert.equal(median([1, 2, 7, 8, 9]), 7);
});

test("median does not mutate the caller's sample", () => {
  const xs = [3, 1, 2];
  median(xs);
  assert.deepEqual(xs, [3, 1, 2]);
});

test("median is null for an empty or absent sample rather than NaN", () => {
  assert.equal(median([]), null);
  assert.equal(median(null), null);
  assert.equal(median(undefined), null);
});

test("summarize reports n, min, median, max and mean", () => {
  const s = summarize([10, 12, 11, 40]);
  assert.equal(s.n, 4);
  assert.equal(s.min, 10);
  assert.equal(s.max, 40);
  assert.equal(s.median, 11.5);
  assert.equal(s.mean, 73 / 4);
});

test("summarize's spread exposes a one-sided outlier that the min hides", () => {
  // This is the whole reason min is the verdict statistic: noise on a shared
  // machine can only ADD time, so a single 40 ms sample among 10 ms ones moves
  // the mean and the max and leaves the min alone. spread is what makes that
  // visible instead of silently reassuring.
  const clean = summarize([10, 10.1, 10.2]);
  const dirty = summarize([10, 10.1, 40]);
  assert.equal(clean.min, dirty.min);
  assert.ok(dirty.spread > clean.spread * 10);
});

test("summarize of an empty sample is all nulls with n=0", () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.min, null);
  assert.equal(s.median, null);
  assert.equal(s.mean, null);
});

test("ratio divides, and refuses rather than returning Infinity or NaN", () => {
  assert.equal(ratio(10, 5), 2);
  assert.equal(ratio(5, 10), 0.5);
  // A zero denominator is the floor-subtraction case: a workload that costs
  // nothing above startup. Infinity in a table reads as a catastrophic
  // regression; null reads as "no comparison available", which is the truth.
  assert.equal(ratio(1, 0), null);
  assert.equal(ratio(0, 1), 0);
  assert.equal(ratio(null, 5), null);
  assert.equal(ratio(5, null), null);
  assert.equal(ratio(undefined, undefined), null);
  assert.equal(ratio(NaN, 5), null);
});

test("floorSubtract clamps at zero and propagates a missing floor as null", () => {
  assert.equal(floorSubtract(10, 3), 7);
  // Below the floor is noise, not a negative cost.
  assert.equal(floorSubtract(2, 3), 0);
  assert.equal(floorSubtract(null, 3), null);
  assert.equal(floorSubtract(10, null), null);
});

test("isDisagreement fires only when min and median tell different stories", () => {
  assert.equal(isDisagreement(2.0, 2.1), false);
  assert.equal(isDisagreement(2.0, 3.0), true);
  assert.equal(isDisagreement(3.0, 2.0), true, "must be symmetric");
  assert.equal(isDisagreement(null, 2.0), false, "a missing side is not a disagreement");
  assert.equal(isDisagreement(2.0, null), false);
  assert.equal(isDisagreement(0, 0), false);
});

// ---------------------------------------------------------------------------
// classifyRun — the unsupported/error split
// ---------------------------------------------------------------------------

test("classifyRun: exit 0 is ok", () => {
  assert.deepEqual(classifyRun({ status: 0, stdout: "42\n", stderr: "" }), { status: "ok", reason: null });
});

test("classifyRun: pygram's exit-90 contract line is unsupported, with the kind and detail", () => {
  const r = classifyRun({ status: 90, stderr: "pygram: unsupported: module: subprocess\n" });
  assert.equal(r.status, "unsupported");
  assert.match(r.reason, /module: subprocess/);
});

test("classifyRun: a stock traceback on STDOUT is unsupported, not a bare error", () => {
  // The regression. Stock MicroPython writes uncaught tracebacks to stdout;
  // pygram's port patch sends them to stderr. Reading only stderr reported
  // stock's missing re.findall as `exit 1` with no reason, which is how a case
  // the control legitimately cannot run gets mislabelled as a harness failure.
  const stdout = [
    "Traceback (most recent call last):",
    '  File "<stdin>", line 1, in <module>',
    "AttributeError: module 're' has no attribute 'findall'",
    "",
  ].join("\n");
  const r = classifyRun({ status: 1, stdout, stderr: "" });
  assert.equal(r.status, "unsupported");
  assert.match(r.reason, /no attribute 'findall'/);
});

test("classifyRun: a traceback on stderr is unsupported too", () => {
  const r = classifyRun({ status: 1, stdout: "", stderr: "ImportError: can't import name Counter\n" });
  assert.equal(r.status, "unsupported");
  assert.match(r.reason, /Counter/);
});

test("classifyRun: stderr wins over stdout when both carry a failure", () => {
  const r = classifyRun({
    status: 1,
    stdout: "TypeError: from stdout\n",
    stderr: "ValueError: from stderr\n",
  });
  assert.match(r.reason, /from stderr/);
});

test("classifyRun: a non-zero exit with no Python failure in it is an ERROR", () => {
  // The other half of the split. If this were folded into `unsupported`, a
  // broken case program — or a binary that segfaults — would be quietly
  // recorded as coverage and never looked at.
  const r = classifyRun({ status: 139, stdout: "", stderr: "" });
  assert.equal(r.status, "error");
  assert.match(r.reason, /exit 139/);
});

test("classifyRun: timeouts and spawn failures are errors, never unsupported", () => {
  assert.equal(classifyRun({ status: null, timedOut: true }).status, "error");
  assert.equal(classifyRun({ status: null, spawnFailed: true, stderr: "ENOENT" }).status, "error");
});

test("classifyRun: exit 90 WITHOUT the contract line is not silently accepted", () => {
  // Exit 90 is pygram's contract. A 90 with no `pygram: unsupported:` line
  // means something else produced it, and calling that "unsupported" would
  // launder an unknown failure into coverage.
  const r = classifyRun({ status: 90, stdout: "", stderr: "" });
  assert.equal(r.status, "error");
});

// ---------------------------------------------------------------------------
// buildRow — floor subtraction and the ratio
// ---------------------------------------------------------------------------

const okCell = (min, med, n = 15) => ({ status: "ok", reason: null, n, requested: 15, min, median: med });
const FLOORS = { min: { pygram: 1, stock: 1 }, median: { pygram: 2, stock: 2 } };

test("buildRow subtracts the floor like for like — min off min, median off median", () => {
  const row = buildRow(
    { id: "c", group: "g", label: "c" },
    { pygram: okCell(11, 22), stock: okCell(6, 12) },
    FLOORS,
  );
  assert.equal(row.net.pygram.min, 10);
  assert.equal(row.net.pygram.median, 20);
  assert.equal(row.net.stock.min, 5);
  assert.equal(row.net.stock.median, 10);
  assert.equal(row.ratioMin, 2);
  assert.equal(row.ratioMedian, 2);
  assert.equal(row.noisy, false);
});

test("buildRow leaves a rawOnly case unsubtracted", () => {
  // The startup group: floor-subtracting a case that IS the floor leaves one
  // noise sample divided by another.
  const row = buildRow(
    { id: "startup-pass", group: "startup", label: "pass", isFloor: true, rawOnly: true },
    { pygram: okCell(1.1, 1.2), stock: okCell(1.0, 1.0) },
    FLOORS,
  );
  assert.equal(row.net.pygram.min, 1.1);
  assert.equal(row.net.stock.min, 1.0);
  assert.ok(Math.abs(row.ratioMin - 1.1) < 1e-9);
});

test("buildRow keeps an unsupported cell as a null with no ratio, and does not throw", () => {
  const row = buildRow(
    { id: "c", group: "g", label: "c" },
    {
      pygram: okCell(11, 22),
      stock: { status: "unsupported", reason: "AttributeError: no findall", n: 0, requested: 15 },
    },
    FLOORS,
  );
  assert.equal(row.net.stock.min, null);
  assert.equal(row.ratioMin, null, "an unsupported control cannot produce a ratio");
  assert.equal(row.ratioMedian, null);
  assert.equal(row.cells.stock.status, "unsupported");
});

test("buildRow marks a row noisy when the min and median ratios disagree", () => {
  const row = buildRow(
    { id: "c", group: "g", label: "c" },
    { pygram: okCell(11, 61), stock: okCell(6, 12) },
    FLOORS,
  );
  assert.equal(row.ratioMin, 2);
  assert.equal(row.ratioMedian, 5.9);
  assert.equal(row.noisy, true);
});

test("buildRow tolerates a missing floor (the floor case itself failed)", () => {
  const row = buildRow(
    { id: "c", group: "g", label: "c" },
    { pygram: okCell(11, 22), stock: okCell(6, 12) },
    { min: {}, median: {} },
  );
  assert.equal(row.net.pygram.min, null);
  assert.equal(row.ratioMin, null);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("fmtMs switches to seconds above 1000 ms and keeps small values legible", () => {
  assert.equal(fmtMs(null), "–");
  assert.equal(fmtMs(0.5), "0.500");
  assert.equal(fmtMs(2.5), "2.50");
  assert.equal(fmtMs(25), "25.0");
  assert.equal(fmtMs(2500), "2.50 s");
});

test("fmtRatio prints two decimals and an x, and a dash for nothing", () => {
  assert.equal(fmtRatio(2), "2.00x");
  assert.equal(fmtRatio(0.815), "0.81x");
  assert.equal(fmtRatio(null), "–");
});

test("renderTextTable aligns every column to its widest cell", () => {
  const out = renderTextTable(["case", "a"], [["short", "1"], ["a much longer case", "22"]]);
  const lines = out.split("\n");
  assert.equal(lines.length, 4, "header, rule, two rows");
  // Every line is padded to the same column start, so the rule is exactly as
  // wide as the header.
  assert.equal(lines[1].length, lines[0].length);
  assert.match(lines[2], /^short {14}/);
});

test("renderMarkdownTable escapes pipes so a regex case label cannot break the table", () => {
  const out = renderMarkdownTable(["case"], [[String.raw`re.split(r"a|b")`]]);
  assert.match(out, /a\\\|b/);
  assert.equal(out.split("\n").length, 3);
});

test("rowCells shows the ratio columns and marks a short sample with its n", () => {
  const row = buildRow(
    { id: "c", group: "g", label: "big case" },
    { pygram: { ...okCell(101, 102), n: 4 }, stock: okCell(11, 12) },
    FLOORS,
  );
  const cells = rowCells(row, ["pygram", "stock"]);
  assert.equal(cells[0], "big case");
  assert.match(cells[1], /\(n=4\)/, "a case cut short by the time budget must say so");
  assert.equal(cells[3], "10.00x");
});

test("rowCells prints the word unsupported rather than a number for a cell that did not run", () => {
  const row = buildRow(
    { id: "c", group: "g", label: "c" },
    { pygram: okCell(11, 12), stock: { status: "unsupported", reason: "x", n: 0, requested: 15 } },
    FLOORS,
  );
  const cells = rowCells(row, ["pygram", "stock"]);
  assert.equal(cells[2], "unsupported");
  assert.equal(cells[3], "–");
});

test("tableHeaders names both ratio columns so nobody has to guess the direction", () => {
  const h = tableHeaders(["pygram", "stock"], { pygram: "pygram", stock: "stock" });
  assert.deepEqual(h, ["case", "pygram", "stock", "py/stock min", "py/stock med"]);
});

// ---------------------------------------------------------------------------
// The append-only ledger
// ---------------------------------------------------------------------------

const LEDGER = `# Ledger\n\nPreamble.\n\n${LEDGER_MARKER}\n\n## 2026-01-01 — an older run\n\nbody\n`;

test("insertLedgerEntry puts the new entry directly after the marker, newest first", () => {
  const out = insertLedgerEntry(LEDGER, "## 2026-08-14 — a new run\n\nnew body");
  const markerAt = out.indexOf(LEDGER_MARKER);
  const newAt = out.indexOf("## 2026-08-14");
  const oldAt = out.indexOf("## 2026-01-01");
  assert.ok(markerAt < newAt, "the entry goes below the marker");
  assert.ok(newAt < oldAt, "and above every older entry");
});

test("insertLedgerEntry preserves every existing entry byte for byte", () => {
  // Append-only is the property that makes a settled negative result stay
  // settled. A writer that reformats the file on the way past is not
  // append-only, however faithful it looks.
  const out = insertLedgerEntry(LEDGER, "## 2026-08-14 — a new run\n\nnew body");
  assert.ok(out.includes("## 2026-01-01 — an older run\n\nbody\n"));
  assert.ok(out.includes("# Ledger\n\nPreamble.\n"));
});

test("insertLedgerEntry throws when the marker is gone instead of guessing a position", () => {
  assert.throws(() => insertLedgerEntry("# Ledger\n\nno marker here\n", "## entry"), /marker not found/);
});

test("insertLedgerEntry separates entries with a horizontal rule", () => {
  const out = insertLedgerEntry(LEDGER, "## 2026-08-14 — a new run");
  const between = out.slice(out.indexOf("## 2026-08-14"), out.indexOf("## 2026-01-01"));
  assert.match(between, /\n---\n/);
});

// ---------------------------------------------------------------------------
// The case list itself
// ---------------------------------------------------------------------------

test("every case has a unique id and a stated reason for existing", () => {
  const ids = new Set();
  for (const c of CASES) {
    assert.ok(c.id, "a case needs an id");
    assert.equal(ids.has(c.id), false, `duplicate case id: ${c.id}`);
    ids.add(c.id);
    assert.ok(c.program, `${c.id} has no program`);
    assert.ok(c.group, `${c.id} has no group`);
    // The `why` is the case's justification against the variant's diff. A
    // benchmark whose cases do not exercise our changes reports a comforting
    // row of 1.00 ratios forever, so an unjustified case is not allowed in.
    assert.ok(c.why && c.why.length > 30, `${c.id} does not say why it is in the battery`);
  }
});

test("there is exactly one startup floor case, and it is the first", () => {
  const floors = CASES.filter((c) => c.isFloor);
  assert.equal(floors.length, 1);
  assert.equal(CASES[0].id, floors[0].id, "the floor must be measured before anything is subtracted from it");
  assert.equal(floors[0].program, "pass");
});

test("the dict battery spans four sizes, so the quadratic has a shape and not a point", () => {
  const dict = CASES.filter((c) => c.group === "dict" && c.id.startsWith("dict-insert-"));
  assert.deepEqual(
    dict.map((c) => c.id),
    ["dict-insert-1k", "dict-insert-5k", "dict-insert-10k", "dict-insert-20k"],
  );
  // Above roughly 40,000 keys the ordered map's quadratic meets the default
  // heap and raises MemoryError (pygram/README.md). The battery must stay
  // under that: a case that dies identically on both builds is not a comparison.
  for (const c of dict) assert.ok(!/40k|50k/.test(c.id));
});

test("both arms exist for every case that measures the unicode regex patch", () => {
  // Invariant 6 in spirit: the \\w patch is about non-ASCII input, and an
  // absolute timing on Swedish text alone says nothing without its ASCII pair.
  for (const stem of ["re-search", "re-sub", "re-findall"]) {
    assert.ok(CASES.some((c) => c.id === `${stem}-ascii`), `${stem}-ascii missing`);
    assert.ok(CASES.some((c) => c.id === `${stem}-nonascii`), `${stem}-nonascii missing`);
  }
});

test("the battery carries controls for the workloads neither build changed", () => {
  // Without these a global shift — a config change, an allocator change, a
  // different alignment — reads as a per-feature regression on every row.
  for (const id of ["float-format", "str-methods", "sort-ints", "re-sub-native"]) {
    assert.ok(CASES.some((c) => c.id === id), `control case ${id} missing`);
  }
});

test("the stdin pipeline cases actually supply stdin", () => {
  const pipes = CASES.filter((c) => c.group === "pipeline");
  assert.ok(pipes.length >= 3);
  for (const c of pipes) {
    assert.equal(typeof c.stdin, "string");
    assert.ok(c.stdin.split("\n").length > 100, `${c.id} needs enough input to time`);
  }
});
