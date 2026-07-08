// Pure helpers for the Hugging Face short-answer research benchmark
// (hf-bench.mjs runner). Everything here is deterministic string/array logic
// with no fetches, so it's unit-tested in hf-bench-lib.test.js (node --test),
// the same split bench-score.mjs has from eval-bench.mjs.
//
// WHY THESE DATASETS (vetted 2026-07-08 — see tests/HF-BENCH-FINDINGS.md for
// the full vetting table): the models under test have training cutoffs
// between late-2024 and mid-2025, so the famous research-QA sets (GAIA,
// HotpotQA, FRAMES, WebWalkerQA, HLE…) are HIGH contamination risk — their
// question/answer pairs sat plaintext on the crawlable web well before those
// cutoffs. The two sets adapted here were selected specifically to dodge
// that:
//   - vtllms/sealqa (seal_hard): built so that memorization FAILS (questions
//     chosen to make naive search return conflicting/noisy results; frontier
//     models score ~0 closed-book on seal_0), answers refreshed by the
//     maintainers (mid-2026 updates), Apache-2.0, plaintext gold answers +
//     supporting URLs.
//   - google/deepsearchqa: published 2025-12-17 — months AFTER every cutoff
//     in scope — 900 multi-hop causal-chain questions across 17 categories,
//     Apache-2.0, plaintext short answers (single or set).
// Both are pure text questions answerable from the LIVE public web, i.e. the
// exact skill this pipeline exists to exercise — unlike frozen-corpus sets
// (BrowseComp-Plus, FutureSearch DRB, DeepResearchGym), whose ground truth
// is only correct against their snapshot, not against live Exa results.

// Per-dataset adapters. `mapRow` normalizes one datasets-server row into
// {question, gold, answerType, meta}; rows it returns null for are skipped
// (defensive against schema drift in the upstream dataset).
export const HF_DATASETS = {
  sealqa: {
    dataset: "vtllms/sealqa",
    config: "seal_hard", // HF_CONFIG=seal_0 for the harder 111-question core
    split: "test",
    mapRow(row) {
      if (!row || typeof row.question !== "string" || !row.question.trim()) return null;
      const gold = row.answer == null ? "" : String(row.answer).trim();
      if (!gold) return null;
      return {
        question: row.question.trim(),
        gold,
        answerType: "single",
        meta: {
          freshness: row.freshness ?? null,
          effective_year: row.effective_year ?? null,
          gold_urls: Array.isArray(row.urls) ? row.urls.slice(0, 8) : [],
        },
      };
    },
  },
  deepsearchqa: {
    dataset: "google/deepsearchqa",
    config: "deepsearchqa",
    split: "eval",
    mapRow(row) {
      if (!row || typeof row.problem !== "string" || !row.problem.trim()) return null;
      const gold = row.answer == null ? "" : String(row.answer).trim();
      if (!gold) return null;
      const answerType = /set/i.test(String(row.answer_type || "")) ? "set" : "single";
      return {
        question: row.problem.trim(),
        gold,
        answerType,
        meta: { category: row.problem_category ?? null },
      };
    },
  },
};

// Deterministic PRNG (mulberry32) so a fixed HF_SEED always samples the same
// question subset — before/after comparisons on a pipeline change are only
// meaningful on the identical subset.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Picks `n` distinct indices out of `total` via a seeded Fisher-Yates
// partial shuffle — stable for a given (total, n, seed).
export function sampleIndices(total, n, seed) {
  const idx = Array.from({ length: total }, (_, i) => i);
  const rand = mulberry32(seed);
  const count = Math.min(n, total);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rand() * (total - i));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, count).sort((a, b) => a - b);
}

// The answer-equivalence judge prompt (search-off, strict JSON). Unlike the
// synthetic bench's rubric judge, this grades against a KNOWN gold answer:
// - single: the report must assert the gold answer (allowing formatting/
//   unit/wording differences — a research report phrases things, it doesn't
//   echo strings).
// - set: every gold element must be present; partial credit is the fraction
//   found; asserting extra wrong elements as definitive answers costs
//   correctness.
export function buildAnswerJudgePrompt({ question, gold, answerType, answer }) {
  const setRules =
    answerType === "set"
      ? 'The gold answer is a SET of elements. "correct" is true only if the report asserts EVERY element of the gold set (order and phrasing may differ) without asserting additional wrong elements as part of the definitive answer. "partial" is the fraction of gold elements the report asserts (0 to 1).\n'
      : '"correct" is true only if the report clearly asserts the gold answer as its conclusion (different wording, units, or number formatting are fine — the FACT must match; a report that hedges between the gold answer and a contradicting one is not correct). "partial" is 1 when correct, else 0, or 0.5 when the gold answer appears but only as one hedged possibility among others.\n';
  return (
    "You grade a research report against a known gold answer. Respond ONLY with a JSON object " +
    '{"correct":true|false,"partial":0..1,"reason":"one sentence"} and nothing else.\n' +
    setRules +
    "Do not reward the report for mentioning the gold answer merely as a candidate it then rejects.\n\n" +
    `Question:\n${question}\n\nGold answer:\n${gold}\n\nResearch report to grade:\n${answer}`
  );
}

// Lenient strict-JSON verdict parse (same tolerance as eval-bench's
// extractJson: fences and stray prose around the object are stripped).
export function parseJudgeVerdict(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed?.correct !== "boolean") return null;
  let partial = Number(parsed.partial);
  if (!Number.isFinite(partial)) partial = parsed.correct ? 1 : 0;
  partial = Math.max(0, Math.min(1, partial));
  return { correct: parsed.correct, partial, reason: String(parsed.reason || "").slice(0, 400) };
}

// Benchmark-leak detector: a live-web pipeline can "answer" a benchmark
// question by finding the benchmark itself (its HF dataset page, paper, or
// eval-harness repo) instead of researching the underlying facts. Any cited
// source from these origins means the run's score is tainted — counted and
// surfaced per run, never silently.
const LEAK_DOMAINS = ["huggingface.co", "arxiv.org", "paperswithcode.com", "github.com", "kaggle.com"];
export function detectBenchmarkLeak(sources, extraDomains = []) {
  const domains = [...LEAK_DOMAINS, ...extraDomains];
  const leaks = [];
  for (const s of sources || []) {
    let host;
    try {
      host = new URL(s.url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (domains.some((d) => host === d || host.endsWith(`.${d}`))) leaks.push(s.url);
  }
  return leaks;
}

// Aggregates per-question judge verdicts into the summary block: strict
// accuracy, mean partial credit, and how many runs failed to produce a
// gradable answer at all (those count as wrong — a research assistant that
// errors on a question did not answer it).
export function aggregateHfScores(rows) {
  const graded = rows.filter((r) => r && r.verdict);
  const failed = rows.filter((r) => r && !r.verdict);
  const correct = graded.filter((r) => r.verdict.correct).length;
  const partialSum = graded.reduce((s, r) => s + (r.verdict.partial ?? 0), 0);
  const leaked = rows.filter((r) => r && (r.leak_urls?.length || 0) > 0).length;
  const total = graded.length + failed.length;
  return {
    total,
    graded: graded.length,
    failed: failed.length,
    correct,
    accuracy: total ? correct / total : 0,
    mean_partial: total ? partialSum / total : 0,
    leaked_runs: leaked,
  };
}
