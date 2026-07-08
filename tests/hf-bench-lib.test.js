// Unit tests for the pure helpers behind the HF short-answer benchmark
// (hf-bench-lib.mjs). Run: node --test tests/hf-bench-lib.test.js
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  HF_DATASETS,
  aggregateHfScores,
  buildAnswerJudgePrompt,
  detectBenchmarkLeak,
  mulberry32,
  parseJudgeVerdict,
  sampleIndices,
} from "./hf-bench-lib.mjs";

describe("sampleIndices", () => {
  test("is deterministic for a fixed (total, n, seed)", () => {
    assert.deepEqual(sampleIndices(254, 25, 1), sampleIndices(254, 25, 1));
  });

  test("different seeds sample different subsets", () => {
    assert.notDeepEqual(sampleIndices(254, 25, 1), sampleIndices(254, 25, 2));
  });

  test("returns n distinct in-range indices, sorted", () => {
    const idx = sampleIndices(100, 30, 7);
    assert.equal(idx.length, 30);
    assert.equal(new Set(idx).size, 30);
    assert.ok(idx.every((i) => i >= 0 && i < 100));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  });

  test("caps at the population size", () => {
    assert.equal(sampleIndices(10, 25, 1).length, 10);
  });

  test("mulberry32 streams are reproducible", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 5; i++) assert.equal(a(), b());
  });
});

describe("HF_DATASETS adapters", () => {
  test("sealqa maps question/answer and carries freshness metadata", () => {
    const q = HF_DATASETS.sealqa.mapRow({
      question: " Who won? ",
      answer: "Team A",
      freshness: "slow",
      effective_year: 2025,
      urls: ["https://a.example", "https://b.example"],
    });
    assert.equal(q.question, "Who won?");
    assert.equal(q.gold, "Team A");
    assert.equal(q.answerType, "single");
    assert.equal(q.meta.effective_year, 2025);
    assert.deepEqual(q.meta.gold_urls, ["https://a.example", "https://b.example"]);
  });

  test("sealqa rejects rows without a usable question or answer", () => {
    assert.equal(HF_DATASETS.sealqa.mapRow({ question: "", answer: "x" }), null);
    assert.equal(HF_DATASETS.sealqa.mapRow({ question: "q", answer: "" }), null);
    assert.equal(HF_DATASETS.sealqa.mapRow(null), null);
  });

  test("deepsearchqa maps problem/answer and detects set answers", () => {
    const single = HF_DATASETS.deepsearchqa.mapRow({
      problem: "What caused X?",
      answer: "Y",
      answer_type: "Single Answer",
      problem_category: "history",
    });
    assert.equal(single.answerType, "single");
    assert.equal(single.meta.category, "history");
    const set = HF_DATASETS.deepsearchqa.mapRow({
      problem: "List all Z",
      answer: "A; B; C",
      answer_type: "Set Answer",
    });
    assert.equal(set.answerType, "set");
  });
});

describe("buildAnswerJudgePrompt", () => {
  test("embeds question, gold, and answer, and demands strict JSON", () => {
    const p = buildAnswerJudgePrompt({ question: "Q?", gold: "G", answerType: "single", answer: "the report" });
    assert.match(p, /Q\?/);
    assert.match(p, /Gold answer:\nG/);
    assert.match(p, /the report/);
    assert.match(p, /"correct":true\|false/);
  });

  test("set answers get element-wise partial-credit rules", () => {
    const p = buildAnswerJudgePrompt({ question: "Q", gold: "A; B", answerType: "set", answer: "r" });
    assert.match(p, /SET of elements/);
    assert.match(p, /fraction of gold elements/);
  });

  test("single answers penalize hedging between gold and a contradiction", () => {
    const p = buildAnswerJudgePrompt({ question: "Q", gold: "G", answerType: "single", answer: "r" });
    assert.match(p, /hedges between the gold answer and a contradicting one/);
  });
});

describe("parseJudgeVerdict", () => {
  test("parses a clean verdict and clamps partial", () => {
    assert.deepEqual(parseJudgeVerdict('{"correct":true,"partial":2,"reason":"ok"}'), {
      correct: true,
      partial: 1,
      reason: "ok",
    });
  });

  test("tolerates fences and surrounding prose", () => {
    const v = parseJudgeVerdict('Sure!\n```json\n{"correct":false,"partial":0.5,"reason":"half"}\n```');
    assert.equal(v.correct, false);
    assert.equal(v.partial, 0.5);
  });

  test("defaults a missing partial from correct", () => {
    assert.equal(parseJudgeVerdict('{"correct":true}').partial, 1);
    assert.equal(parseJudgeVerdict('{"correct":false}').partial, 0);
  });

  test("rejects junk (no boolean correct, unparseable)", () => {
    assert.equal(parseJudgeVerdict('{"correct":"yes"}'), null);
    assert.equal(parseJudgeVerdict("no json here"), null);
    assert.equal(parseJudgeVerdict(null), null);
  });
});

describe("detectBenchmarkLeak", () => {
  test("flags benchmark-hosting domains including subdomains", () => {
    const leaks = detectBenchmarkLeak([
      { url: "https://huggingface.co/datasets/vtllms/sealqa" },
      { url: "https://arxiv.org/abs/2506.01062" },
      { url: "https://en.wikipedia.org/wiki/Thing" },
    ]);
    assert.deepEqual(leaks, [
      "https://huggingface.co/datasets/vtllms/sealqa",
      "https://arxiv.org/abs/2506.01062",
    ]);
  });

  test("empty/malformed sources produce no leaks", () => {
    assert.deepEqual(detectBenchmarkLeak([{ url: "not a url" }, null]), []);
    assert.deepEqual(detectBenchmarkLeak(undefined), []);
  });

  test("extra domains extend the list", () => {
    const leaks = detectBenchmarkLeak([{ url: "https://example.org/x" }], ["example.org"]);
    assert.equal(leaks.length, 1);
  });
});

describe("aggregateHfScores", () => {
  test("failed (ungraded) runs count as wrong, not excluded", () => {
    const s = aggregateHfScores([
      { verdict: { correct: true, partial: 1 } },
      { verdict: { correct: false, partial: 0.5 } },
      { verdict: null }, // research or judge failed
    ]);
    assert.equal(s.total, 3);
    assert.equal(s.graded, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.correct, 1);
    assert.ok(Math.abs(s.accuracy - 1 / 3) < 1e-9);
    assert.ok(Math.abs(s.mean_partial - 1.5 / 3) < 1e-9);
  });

  test("counts leak-tainted runs", () => {
    const s = aggregateHfScores([
      { verdict: { correct: true, partial: 1 }, leak_urls: ["https://huggingface.co/x"] },
      { verdict: { correct: true, partial: 1 }, leak_urls: [] },
    ]);
    assert.equal(s.leaked_runs, 1);
  });
});
