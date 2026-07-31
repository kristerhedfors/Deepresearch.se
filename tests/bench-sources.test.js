// (no @ts-check: node:test / node:assert have no type declarations here.)
// The SOURCE-COVERAGE guard for the scored benchmark, plus the drift-attribution
// arithmetic (bench-drift-core.mjs).
//
// WHY A GUARD RATHER THAN A NOTE. A retrieval source that no benchmark question
// reaches cannot be measured: the gate reports NEUTRAL on it whatever it does to
// answers. That is not a hypothetical failure — on 2026-07-31 an audit found
// `europepmc` exercised by ZERO of 34 questions while PubMed was being ingested
// as a second hosted corpus (PR #352), and arXiv had arrived through the same
// blind spot: it landed between the 07-23 baseline and the first re-measurement,
// with nothing measuring it on the way in. Six runs then sat ~0.6 below baseline
// with no way to attribute the fall.
//
// So coverage is a build-time invariant now. Registering a source in
// SEARCH_SOURCES without a question that reaches it fails here, at the moment
// the source is added, instead of six weeks later in a drift nobody can explain.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { SEARCH_SOURCES, leadSourceIds } from "../src/search-sources.js";
import { BENCH_QUESTIONS } from "./bench-questions.mjs";
import {
  MOVE_THRESHOLD,
  formatDrift,
  perQuestionDrift,
  perSourceDrift,
  uncoveredSources,
} from "./bench-drift-core.mjs";

/** @param {string} text @returns {string[]} */
function sourcesFor(text) {
  return SEARCH_SOURCES.filter((s) => {
    try {
      return s.intent(text);
    } catch {
      return false;
    }
  }).map((s) => s.id);
}

describe("benchmark source coverage", () => {
  test("every registered search source is reached by at least one question", () => {
    const uncovered = uncoveredSources(
      SEARCH_SOURCES.map((s) => s.id),
      BENCH_QUESTIONS.map((q) => sourcesFor(q.question)),
    );
    assert.deepEqual(
      uncovered,
      [],
      `these sources are invisible to the benchmark: ${uncovered.join(", ")}. ` +
        "Add a question to tests/bench-questions.mjs that reaches each (append-only — new id, never edit an existing entry).",
    );
  });

  test("at least one question exercises each source's LEAD path where it has one", () => {
    // Leading stands the whole web leg down, so it is a different behaviour
    // from the source merely contributing — and the more dangerous one to ship
    // unmeasured. Only sources that declare a leadIntent are required here.
    const withLead = SEARCH_SOURCES.filter((s) => typeof s.leadIntent === "function").map((s) => s.id);
    const led = new Set();
    for (const q of BENCH_QUESTIONS) for (const id of leadSourceIds(q.question)) led.add(id);
    const missing = withLead.filter((id) => !led.has(id));
    assert.deepEqual(
      missing,
      [],
      `no question triggers the LEAD path for: ${missing.join(", ")}.`,
    );
  });

  test("the life-science leg is covered in both languages (invariant 6)", () => {
    // The intent gate is bilingual on purpose so a Swedish question reaches
    // Europe PMC; a bank that only ever tests it in English would let the
    // Swedish half rot unnoticed.
    const byLang = { en: 0, sv: 0 };
    for (const q of BENCH_QUESTIONS) {
      if (sourcesFor(q.question).includes("europepmc")) byLang[q.lang] = (byLang[q.lang] || 0) + 1;
    }
    assert.ok(byLang.en > 0, "no English question reaches europepmc");
    assert.ok(byLang.sv > 0, "no Swedish question reaches europepmc");
  });

  test("question ids stay unique — the bank is append-only", () => {
    const ids = BENCH_QUESTIONS.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate question id");
  });

  test("every question carries a rubric the judge can score against", () => {
    for (const q of BENCH_QUESTIONS) {
      assert.ok(Array.isArray(q.rubric) && q.rubric.length >= 2, `${q.id}: needs a rubric`);
      assert.ok(["en", "sv"].includes(q.lang), `${q.id}: lang must be en or sv`);
    }
  });
});

describe("perQuestionDrift", () => {
  const base = { a: { overall: { mean: 3 } }, b: { overall: { mean: 4 } } };

  test("computes deltas and sorts the biggest faller first", () => {
    const rows = perQuestionDrift(base, { a: { overall: { mean: 1.5 } }, b: { overall: { mean: 4.25 } } });
    assert.deepEqual(rows.map((r) => r.qid), ["a", "b"]);
    assert.equal(rows[0].delta, -1.5);
    assert.equal(rows[1].delta, 0.25);
  });

  test("flags only questions that moved past the threshold", () => {
    const rows = perQuestionDrift(base, { a: { overall: { mean: 3 - MOVE_THRESHOLD } }, b: { overall: { mean: 4.1 } } });
    assert.equal(rows.find((r) => r.qid === "a").moved, true, "exactly at the threshold counts as moved");
    assert.equal(rows.find((r) => r.qid === "b").moved, false);
  });

  test("reports a question present on only one side instead of dropping it", () => {
    // A battery that gained or lost a question between measurements is a fact
    // about the comparison; omitting it makes a shrinking battery look stable.
    const rows = perQuestionDrift(base, { a: { overall: { mean: 3 } } });
    const b = rows.find((r) => r.qid === "b");
    assert.equal(b.delta, null);
    assert.equal(b.cand, null);
    assert.equal(rows[rows.length - 1].qid, "b", "null-delta rows sort last");
  });

  test("survives empty or malformed input", () => {
    assert.deepEqual(perQuestionDrift({}, {}), []);
    assert.deepEqual(perQuestionDrift(null, null), []);
    const rows = perQuestionDrift({ a: {} }, { a: { overall: { mean: "x" } } });
    assert.equal(rows[0].delta, null);
  });
});

describe("perSourceDrift", () => {
  const rows = [
    { qid: "sci1", delta: -1.2 },
    { qid: "sci2", delta: -0.8 },
    { qid: "web1", delta: 0.1 },
  ];
  const sourcesOf = (qid) => (qid.startsWith("sci") ? ["arxiv", "europepmc"] : []);

  test("buckets by source and sorts the worst-affected first", () => {
    const out = perSourceDrift(rows, sourcesOf);
    const arxiv = out.find((r) => r.source === "arxiv");
    assert.equal(arxiv.n, 2);
    assert.equal(arxiv.mean, -1);
    assert.equal(out[0].source, "arxiv", "most-negative first (ties broken by name)");
  });

  test("a question reaching several sources counts toward each — buckets overlap", () => {
    const out = perSourceDrift(rows, sourcesOf);
    assert.equal(out.find((r) => r.source === "europepmc").mean, -1);
    assert.equal(out.find((r) => r.source === "arxiv").mean, -1);
  });

  test("questions no source reaches form the '(none)' control bucket", () => {
    // The control is the point: if it moved like the source buckets, the drift
    // is not about retrieval at all.
    const none = perSourceDrift(rows, sourcesOf).find((r) => r.source === "(none)");
    assert.equal(none.n, 1);
    assert.equal(none.mean, 0.1);
    assert.deepEqual(none.qids, ["web1"]);
  });

  test("ignores rows with no delta", () => {
    assert.deepEqual(perSourceDrift([{ qid: "x", delta: null }], () => ["arxiv"]), []);
  });
});

describe("uncoveredSources", () => {
  test("names sources no question reaches", () => {
    assert.deepEqual(uncoveredSources(["a", "b", "c"], [["a"], ["a", "c"]]), ["b"]);
  });

  test("empty when everything is covered", () => {
    assert.deepEqual(uncoveredSources(["a"], [["a"]]), []);
  });

  test("tolerates missing input", () => {
    assert.deepEqual(uncoveredSources(["a"], null), ["a"]);
    assert.deepEqual(uncoveredSources(null, [["a"]]), []);
  });
});

describe("formatDrift", () => {
  test("renders both tables with the movers marked", () => {
    const qrows = perQuestionDrift({ a: { overall: { mean: 3 } } }, { a: { overall: { mean: 1 } } });
    const out = formatDrift(qrows, perSourceDrift(qrows, () => ["arxiv"]));
    assert.match(out, /per-question drift/);
    assert.match(out, /per-source drift/);
    assert.match(out, /moved/);
    assert.match(out, /arxiv/);
  });

  test("renders a missing-side row as n\/a rather than NaN", () => {
    const qrows = perQuestionDrift({ a: { overall: { mean: 3 } } }, {});
    assert.match(formatDrift(qrows, []), /n\/a/);
    assert.equal(/NaN/.test(formatDrift(qrows, [])), false);
  });
});
