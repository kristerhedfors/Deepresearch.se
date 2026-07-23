---
name: eval-harness
description: >-
  Load when building or running the platform's evaluation system — the
  model-matrix trace harness, the LLM-judged rubric bench, or the external
  gold-answer bench — when an answer-quality change wants to merge, when a
  per-model quirk needs a profile entry, or when a findings ledger must be
  appended. Covers measure-first as a contract (PA-10), append-only ledgers,
  fixed seed/judge/budget comparisons, the don't-deploy-mid-battery rule,
  QUERY_SETS discipline, contamination-aware dataset selection, the
  evidence-before-override rule, and the net-negative deep-tier cautionary
  tale.
---

# Eval harness — the three-legged stool that gates quality changes

"Seems better" is not evidence. This module builds the measurement system
that lets a platform's answer quality be CHANGED safely: a trace harness that
finds integration bugs, a scored rubric bench that says whether a pipeline
change made answers better, and an external gold-answer bench that says
whether the pipeline gets independently-verifiable answers right — each
with an append-only findings ledger so evaluation hillclimbs across rounds
instead of restarting. Its one output that matters: a NUMBER attached to
every quality-affecting merge.

## Capability class & tier story

**Class D** — development system (`deps: research-pipeline`). The harnesses
are plain Node scripts (no dependencies) run from a session against the
LIVE deployment's chat endpoint — they exercise the server tier's real
pipeline end to end, including the SSE transport. The client tier's
pipeline port shares the same phase logic (PA-7), so server-tier findings
about prompts/phases transfer; client-tier-specific behavior is covered by
its own Node-run flow tests against a mock provider, not by these live
batteries. Nothing in this module ships to users; its committed artifacts
are the ledgers and the fixed question sets.

## Contracts

- **PA-10 (carried — this module IS measure-first):** answer-quality
  changes land only behind a scored benchmark; findings ledgers are
  append-only; anything provider-touching is verified against the live
  deployment.
- **PA-5 (enforced):** every per-model override traces to a reproduced
  finding from these harnesses — a profile entry without a ledger citation
  is a guess and gets reverted.
- **PA-3 (measured):** the harnesses exercise and verify the split routing
  — the JSON phases stay on the fixed reliable model while the battery
  sweeps answer models, and per-use-case tuning is measured per use case.
- **PA-4 (carried):** the privacy posture applies to evals too — bench
  questions are SYNTHETIC, never seeded from real chat data, and external
  dataset rows are fetched at run time, never committed.

## Build plan

1. **Leg 1 — the model-matrix trace harness.** A dependency-free Node
   script that runs a fixed battery of research queries against every `up`
   model from the catalog endpoint, directly via the live SSE endpoint.
   NOT pass/fail — a data-collection sweep read by hand, built to find
   per-model integration behavior: silent stream deaths, leaked
   tool-call-shaped tokens (heuristic scan), JSON-phase failures, timing
   outliers. Output: one JSON per model×query (full SSE event sequence +
   final answer) plus a summary, in a timestamped, GITIGNORED results dir —
   raw model output has no lasting repo value; the ledger is the durable
   record. Support multi-turn queries that resend the ACTUAL streamed
   answer as the next request's assistant turn (exactly like the real
   client) so conversation-context handling is exercised, not simulated.
   Env overrides for query set, model subset, budget, concurrency.
2. **QUERY_SETS discipline.** Batteries run named, frozen query sets
   (`round1`, `round2`, …). A fresh sweep ADDS a new named set — never
   edits an old one — so past findings stay reproducible against the exact
   set that produced them.
3. **Leg 2 — the LLM-judged rubric bench.** A fixed set (~25–30) of
   **synthetic** questions spanning the failure taxonomy (multi-hop,
   recency-sensitive, contested/nuanced, unanswerable-by-design,
   source-diversity traps, numeric, comparison) in EVERY supported language
   (PA-6 applies to evals too). Per question: run the real pipeline live,
   reconstruct the numbered source registry from the trace; compute
   **free deterministic metrics** first (source diversity as domain
   concentration; citation coverage as distinct `[n]` markers + a Sources
   list) — regressions these catch cost zero judge tokens; then a strong
   judge model scores 1–5 scales (citation faithfulness against the actual
   registry, coverage vs the question's rubric, calibration — hedging on
   conflicts, admitting unanswerables) as strict JSON. Pure scoring
   helpers (diversity, coverage, aggregation) are unit-tested. The
   question file is append-only, like the ledgers.
4. **De-noising.** A single judge sample varies ±2+ per cell — never trust
   one. A denoise driver runs N samples per cell and reports mean ± SD;
   before/after deltas are quoted with the noise band or not at all.
5. **Leg 3 — the external gold-answer bench.** Grade the pipeline against
   question sets the project didn't write, with known gold answers —
   measuring whether research gets verifiable answers RIGHT. **Selection
   is contamination vetting:** compare each candidate dataset's
   publication/refresh dates against the catalog models' training cutoffs;
   prefer sets that are contamination-resistant by design (questions where
   naive search returns noise, refreshed answers that penalize memorized
   stale ones, training-filter canaries). Rows are fetched from the
   dataset host at RUN TIME — never committed. Fix the sampling seed, the
   judge, and the budget across any before/after; watch a `leaked_runs`
   counter (the pipeline citing the benchmark itself invalidates the row).
   Unit-test the harness's pure helpers.
6. **Append-only findings ledgers — one per leg.** Each battery ends with
   a dated section appended to the leg's ledger: what ran (set, models,
   seed, budget, judge), the numbers, the findings, the decisions, open
   issues. Read the ledger BEFORE a round (don't rediscover a known
   issue); never edit history. The ledgers, not the results dirs, are what
   the repo keeps.
7. **The evidence-before-override rule.** Per-model overrides (priors,
   JSON reinforcement, token caps, validation skips, retry budgets) live
   in one profiles module consulted at the few places that need them;
   models with no entry behave as if the module didn't exist. Every entry
   cites the reproduced finding (ledger section) that earned it. When a
   battery surfaces something new, decide FIRST whether it is
   model-specific (→ a profile entry) or universal (→ a prompt/pipeline/
   platform fix), and record the decision in the ledger — several of the
   reference's biggest fixes (hung-fetch timeouts, finish_reason handling,
   CPU ceilings) entered as "model quirks" and turned out universal.
8. **The merge gate.** A pipeline-quality change's PR quotes its
   before/after bench delta (fixed seed/judge/budget, de-noised). A
   baseline battery must exist in the ledger before the first such change
   — you cannot measure an improvement against nothing. Wire the rule into
   the dev workflow, not just prose.
9. **Don't deploy mid-battery.** A deploy (including a push that triggers
   git-connected auto-deploy) truncates in-flight streamed requests the
   battery depends on. Let batteries finish before pushing anything.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Model-matrix trace harness + QUERY_SETS | `tests/model-eval.mjs` (`npm run eval:models`) |
| Trace-harness ledger | `tests/MODEL-EVAL-FINDINGS.md` |
| Rubric bench (runner, fixed questions, free metrics + judge) | `tests/eval-bench.mjs`, `tests/bench-questions.mjs`, `tests/bench-score.mjs` (+ `bench-score.test.js`) |
| De-noise driver (multi-sample mean ± SD) | `tests/denoise-driver.mjs` |
| Rubric-bench ledger | `tests/EVAL-BENCH-FINDINGS.md` |
| External gold-answer bench (contamination-vetted sets, run-time fetch) | `tests/hf-bench.mjs` (+ `tests/hf-bench-lib.test.js`), sets `vtllms/sealqa`, `google/deepsearchqa` |
| Gold-bench ledger incl. the dataset vetting table | `tests/HF-BENCH-FINDINGS.md` |
| Evidence-driven per-model overrides | `src/model-profiles.js` (+ its test), `.claude/skills/model-eval/SKILL.md` |
| The net-negative gate (cautionary tale, in code) | `src/budget.js` `DEEP_TIER_FEATURES_ENABLED` + the comment block above it |
| Battery/deploy interaction | `.claude/skills/deploy/SKILL.md`, `.claude/skills/model-eval/SKILL.md` |

## Acceptance checklist

- [ ] A baseline battery of each leg runs against the live deployment and
      its results land as a dated section in the leg's ledger — BEFORE any
      pipeline-quality change merges.
- [ ] The rubric bench's pure scoring helpers and the gold bench's pure
      helpers are unit-tested in plain Node.
- [ ] Results dirs are gitignored; ledgers and question sets are committed;
      question sets and ledgers are append-only in practice (spot-check the
      git log).
- [ ] A before/after comparison holds seed, judge, budget, and question set
      fixed, and quotes mean ± SD from multi-sample runs.
- [ ] Every model-profile entry cites a ledger finding; deleting the
      citation-less ones changes no measured number.
- [ ] The external bench fetches rows at run time (nothing committed) and
      reports its leakage counter.
- [ ] The battery runner or its runbook states the no-deploy-mid-battery
      rule where the operator will see it.

## Pitfalls

- **The canonical cautionary tale — build, measure, gate OFF.** The
  reference built three plausible deep-research upgrades (per-wave notes
  digest, full-content fetch of top sources, claim-level validation),
  benchmarked them de-noised at 4 samples/cell, and found the batch
  **net-negative**: overall 2.65 (off) → 2.43 (on), with real regressions
  on focused recency/contested questions (distilled notes + full-page text
  DILUTED calibration) and no real multi-hop gain (1.67 → 1.89, inside the
  noise). All three were gated off behind one flag
  (`DEEP_TIER_FEATURES_ENABLED = false` in `src/budget.js`), code kept for
  an intent-gated rework, re-enable only on a measured gain. More context
  does not equal better answers; only the number knows.
- **A mid-battery deploy produced a batch of fake zero-answer results**
  (reference round 2) — traced to a `git push` mid-run truncating streams,
  not a real bug, after real analysis time was burned. Finish the battery
  first.
- **Single judge samples lie.** ±2+ variance per cell was observed; any
  delta quoted without a noise band from the de-noise driver is
  storytelling.
- **Editing an old query set silently invalidates its ledger sections** —
  past findings reproduce only against the exact set that produced them.
  New sweep, new named set.
- **Contamination measures memory, not research.** A benchmark whose Q/A
  pairs sat plaintext on the crawlable web before the catalog models'
  cutoffs (late-2024–mid-2025 in the reference) rewards recall; the
  vetting sweep and the `leaked_runs` counter exist because the pipeline
  citing the benchmark itself was actually observed.
- **Never seed bench questions from real chat data** — the reference's
  rubric set is explicitly synthetic (PA-4 applies to evals). A tempting
  shortcut, and a privacy violation the moment the question file is
  committed to a public repo.
- **Not every harness finding is model-specific.** The reference's
  timeout, finish_reason, and CPU-ceiling incidents all surfaced in
  per-model sweeps and were universal platform/pipeline bugs. Route the
  finding before writing the override.
- **The trace harness cannot say "better".** It finds integration bugs;
  only the scored legs justify a quality merge. Keep the jobs separate.
