// The lypning dashboard's pure core. What is pinned here is not arithmetic for
// its own sake — it is the two properties the page would be dishonest without:
//
//   1. a number that was not measured is never rendered as one (no zero-filling,
//      no borrowing the published table when the VM lacked an engine), and
//   2. the deterministic intent gate takes Swedish with the same breadth as
//      English (CLAUDE.md invariant 6 — this gate moves the chart, so it routes
//      behaviour and the rule applies).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ENGINES, PROBE_COMMAND, parseProbe, batterySteps, parseTiming, summarize,
  timingProgram, shellQuote, seriesPoints, movement, pluck, formatValue,
  matchSeries, wantsRun, answerLocally, statsContextBlock, SERIES_INTENT,
  WORKLOADS, STEP_BUDGET_MS, EXEC_CEILING_MS, chartScale,
} from "./lypning-core.js";

const HISTORY = JSON.parse(readFileSync(new URL("../lypning/history.json", import.meta.url), "utf8"));

// ---- the battery

test("a step's budget never reaches the VM's exec ceiling", () => {
  // Crossing the ceiling does not fail the command, it destroys the VM
  // (skills-disabled/sandbox-perf-eval). The margin is the whole reason the
  // battery is a list of small steps instead of one script.
  assert.ok(STEP_BUDGET_MS < EXEC_CEILING_MS, "step budget must leave the VM room");
  for (const s of batterySteps({ python3: true })) {
    assert.ok(s.budgetMs < EXEC_CEILING_MS, `${s.id} budget reaches the ceiling`);
  }
});

test("probing lists every engine and parses either answer", () => {
  for (const e of ENGINES) assert.ok(PROBE_COMMAND.includes(e.id), `${e.id} not probed`);
  const out = parseProbe("lypning yes\nlypning-mp no\npython3 yes\n");
  assert.deepEqual(out, { lypning: true, "lypning-mp": false, python3: true });
});

test("an absent engine gets no steps at all — its rows stay empty", () => {
  const steps = batterySteps({ python3: true, lypning: false, "lypning-mp": false });
  assert.ok(steps.length > 0);
  assert.ok(steps.every((s) => s.engine === "python3"), "a step was minted for an absent engine");
});

test("cold start is measured once, and first", () => {
  const steps = batterySteps({ python3: true, lypning: true });
  const cold = steps.filter((s) => s.kind === "cold");
  assert.equal(cold.length, 2, "one cold step per present engine");
  assert.equal(steps.indexOf(cold[0]), 0, "cold must run before anything warms the engine");
  for (const s of cold) {
    assert.ok(!/while \[/.test(s.command), "a loop would measure the warm case and call it cold");
  }
});

test("timing takes the MIN of N, not the mean", () => {
  // Noise in a browser tab is one-sided, so the minimum is the least biased
  // estimate. A mean would report the reader's other tabs.
  const prog = timingProgram("python3 -c 'pass'", 15);
  assert.match(prog, /-lt 15/);
  assert.match(prog, /-lt "\$best"/, "must keep the smallest sample");
  assert.ok(!/awk|bc|\/ 15/.test(prog), "no averaging");
});

test("a program's own quotes survive the shell", () => {
  const q = shellQuote("print('a')");
  assert.equal(q, `'print('\\''a'\\'')'`);
  for (const w of WORKLOADS) {
    // Every shipped workload must round-trip: this is where a stray quote turns
    // a measurement into a syntax error that reads as a slow engine.
    assert.doesNotThrow(() => shellQuote(w.program));
  }
});

test("a failed or unparseable step is failed, never zero", () => {
  assert.deepEqual(parseTiming({ exitCode: 1, stdout: "", stderr: "boom" }), { ok: false, us: null, error: "boom" });
  assert.equal(parseTiming({ exitCode: 0, stdout: "hello\n", stderr: "" }).ok, false);
  assert.equal(parseTiming({ exitCode: 0, stdout: "not a number", stderr: "" }).us, null);
  assert.deepEqual(parseTiming({ exitCode: 0, stdout: "1234\n", stderr: "" }), { ok: true, us: 1234, error: "" });
  // A negative reading means the clock moved backwards mid-run; that is not a
  // fast interpreter.
  assert.equal(parseTiming({ exitCode: 0, stdout: "-5", stderr: "" }).ok, false);
});

test("rows are floor-subtracted, and a row without a floor says so", () => {
  const steps = batterySteps({ python3: true });
  /** @type {Record<string, any>} */
  const results = {};
  results["warm:python3:pass"] = { ok: true, us: 1000, error: "" };
  results["warm:python3:sum"] = { ok: true, us: 1600, error: "" };
  let sum = summarize(steps, results);
  const sumRow = sum.rows.find((r) => r.workload === "sum");
  assert.equal(sumRow.cells.python3.us, 600, "the floor was not subtracted");
  assert.equal(sumRow.cells.python3.floored, true);
  // Same reading with no floor measured: reported raw and flagged, not guessed.
  delete results["warm:python3:pass"];
  sum = summarize(steps, results);
  const raw = sum.rows.find((r) => r.workload === "sum");
  assert.equal(raw.cells.python3.us, 1600);
  assert.equal(raw.cells.python3.floored, false);
});

test("a missing side means no ratio — never a 1.0", () => {
  const steps = batterySteps({ python3: true, lypning: true });
  const results = { "warm:lypning:sum": { ok: true, us: 50, error: "" } };
  const sum = summarize(steps, results);
  const row = sum.rows.find((r) => r.workload === "sum");
  assert.equal(row.cells.lypning.ratio, null, "a ratio was invented without a CPython reading");
});

// ---- the history half

test("every declared series resolves against the committed history", () => {
  assert.ok(HISTORY.commits.length > 0, "history.json is empty — run `npm run lypning`");
  for (const s of HISTORY.series) {
    const pts = seriesPoints(HISTORY, s.key);
    assert.ok(pts.length > 0, `series ${s.key} has no points in the committed history`);
  }
});

test("a commit that published nothing is a GAP, not a zero", () => {
  const withoutPublished = HISTORY.commits.filter((/** @type {any} */ c) => !c.published);
  assert.ok(withoutPublished.length > 0, "fixture no longer exercises the gap case");
  const pts = seriesPoints(HISTORY, "published.mixtureRatio");
  assert.ok(pts.length < HISTORY.commits.length, "a commit with no table contributed a point");
  assert.ok(pts.every((p) => p.y > 0));
});

test("pluck reads only finite numbers", () => {
  assert.equal(pluck({ a: { b: 2 } }, "a.b"), 2);
  assert.equal(pluck({ a: { b: "2" } }, "a.b"), null);
  assert.equal(pluck({ a: null }, "a.b"), null);
  assert.equal(pluck({ a: { b: NaN } }, "a.b"), null);
});

test("`better` decides improvement — a falling cost ratio is progress", () => {
  const ratio = movement(HISTORY, "published.mixtureRatio");
  assert.ok(ratio.last.y < ratio.first.y, "fixture no longer shows the ratio falling");
  assert.equal(ratio.improved, true, "a falling cost ratio must read as an improvement");
  const corpus = movement(HISTORY, "tree.corpusEntries");
  assert.ok(corpus.last.y > corpus.first.y);
  assert.equal(corpus.improved, true, "a growing corpus must read as an improvement");
});

test("provenance rides on every series", () => {
  for (const s of HISTORY.series) assert.equal(typeof s.measuredHere, "boolean", `${s.key} has no provenance`);
  assert.equal(movement(HISTORY, "tree.corpusEntries").measuredHere, true);
  assert.equal(movement(HISTORY, "published.mixtureRatio").measuredHere, false);
});

// ---- the deterministic gate: EN + SV parity (invariant 6)

test("Swedish language parity: every intent row takes both languages", () => {
  for (const row of SERIES_INTENT) {
    assert.ok(row.en.length >= 3, `${row.key} is thin in English`);
    assert.ok(row.sv.length >= 3, `${row.key} has no Swedish breadth — invariant 6`);
    for (const phrase of row.sv) {
      assert.deepEqual(matchSeries(phrase).includes(row.key), true, `Swedish "${phrase}" does not route to ${row.key}`);
    }
    for (const phrase of row.en) {
      assert.deepEqual(matchSeries(phrase).includes(row.key), true, `English "${phrase}" does not route to ${row.key}`);
    }
  }
});

test("Swedish language parity: paired questions route identically", () => {
  const pairs = [
    ["how did the corpus grow?", "hur växte korpusen?"],
    ["what is the cost compared to cpython?", "vad är kostnaden jämfört med cpython?"],
    ["how big is the binary?", "hur stor är binären?"],
    ["how is the startup time?", "hur är starttiden?"],
    ["are there mismatches?", "finns det avvikelser?"],
    ["how much rust is there?", "hur mycket rust finns det?"],
  ];
  for (const [en, sv] of pairs) {
    const a = matchSeries(en), b = matchSeries(sv);
    assert.ok(a.length > 0, `English "${en}" routed nowhere`);
    assert.ok(b.length > 0, `Swedish "${sv}" routed nowhere`);
    assert.equal(a[0], b[0], `"${en}" and "${sv}" disagree: ${a[0]} vs ${b[0]}`);
  }
});

test("Swedish language parity: the run gate", () => {
  for (const s of ["run the battery", "re-run it", "measure it", "run again"]) {
    assert.equal(wantsRun(s), true, `English "${s}" did not ask for a run`);
  }
  for (const s of ["kör batteriet", "kör om", "mät nu", "kör igen", "gör en mätning"]) {
    assert.equal(wantsRun(s), true, `Swedish "${s}" did not ask for a run — invariant 6`);
  }
  assert.equal(wantsRun("how did the corpus grow?"), false);
  assert.equal(wantsRun("hur växte korpusen?"), false);
});

test("the Swedish definite form is matched, which an ASCII \\b would not do", () => {
  // JS `\b` is ASCII-only: /\bmått\b/ matches inside "måttet" between å and t.
  // These gates substring-match instead, so the definite forms are explicit —
  // the trap this asserts against is a future edit "tidying" them into \b.
  assert.ok(matchSeries("binären").includes("published.binaryLypningBytes"));
  assert.ok(matchSeries("korpusen").includes("tree.corpusEntries"));
  assert.ok(matchSeries("starttiden").includes("published.startupMixtureMs"));
});

// ---- the local responder

test("the responder never invents a number it does not hold", () => {
  const a = answerLocally("how did the corpus grow?", { history: HISTORY, live: null });
  assert.equal(a.handled, true);
  assert.deepEqual(a.focus, ["tree.corpusEntries"]);
  const last = movement(HISTORY, "tree.corpusEntries").last;
  assert.ok(a.text.includes(formatValue(last.y, "")), "the answer does not quote the value it charted");
  assert.match(a.text, /Counted out of the tree/, "a counted series must be labelled as counted");
});

test("a quoted series is labelled as somebody else's measurement", () => {
  const a = answerLocally("what is the ratio vs cpython?", { history: HISTORY, live: null });
  assert.match(a.text, /Quoted from the README/);
  assert.match(a.text, /not a measurement of yours/);
});

test("an unrecognised question is not handled, and says what it holds", () => {
  const a = answerLocally("what is the airspeed velocity of an unladen swallow?", { history: HISTORY, live: null });
  assert.equal(a.handled, false);
  assert.equal(a.run, false);
  assert.match(a.text, /corpus entries/);
});

test("asking to run sets run, in both languages", () => {
  assert.equal(answerLocally("run the battery", { history: HISTORY, live: null }).run, true);
  assert.equal(answerLocally("kör batteriet", { history: HISTORY, live: null }).run, true);
});

test("the agent's context block states its provenance and its absence", () => {
  const block = statsContextBlock(HISTORY, null);
  assert.match(block, /do not recall figures/);
  assert.match(block, /\[COUNTED\]/);
  assert.match(block, /\[QUOTED\]/);
  assert.match(block, /has not run the battery this session/, "an absent live run must be stated, not omitted");
  const withLive = statsContextBlock(HISTORY, {
    engines: ["python3"], cold: { python3: 8_573_000 },
    rows: [{ workload: "sum", label: "sum a range", cells: { python3: { us: 4200 } } }],
  });
  assert.match(withLive, /LIVE, measured in this reader's own browser Linux VM/);
  assert.match(withLive, /sum a range/);
});

test("formatValue distinguishes a missing value from a zero", () => {
  assert.equal(formatValue(null, "x"), "—");
  assert.equal(formatValue(0, "x"), "0.000x");
  assert.equal(formatValue(987336, "B"), "987,336 B");
  assert.equal(formatValue(950, "us"), "950 µs");
  assert.equal(formatValue(8_573_000, "us"), "8573.00 ms");
});

test("a counting series never gets an axis below zero", () => {
  // A chart labelled −167 corpus entries claims a quantity that cannot exist.
  // The padding is for flat series; it must not manufacture negative counts.
  const { lo, hi } = chartScale([0, 681, 1390]);
  assert.equal(lo, 0);
  assert.ok(hi > 1390);
  // A flat series still gets a band rather than collapsing to one row.
  const flat = chartScale([5, 5, 5]);
  assert.ok(flat.hi > flat.lo);
  assert.equal(flat.lo, 4.4);
  // A series that genuinely goes negative keeps padding in both directions.
  const signed = chartScale([-10, 10]);
  assert.ok(signed.lo < -10);
  // Nothing to draw is a band, not a crash.
  assert.deepEqual(chartScale([]), { lo: 0, hi: 1 });
  assert.deepEqual(chartScale([NaN, Infinity]), { lo: 0, hi: 1 });
});
