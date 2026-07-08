# Eval-bench findings ledger

Append-only record of every `tests/eval-bench.mjs` benchmark run. This is
the companion to `MODEL-EVAL-FINDINGS.md`, but for a different job:
`model-eval.mjs` collects raw SSE traces read by hand (great for finding
integration bugs, silent stream deaths, leaked tool-call tokens) — it
**cannot tell you whether a change made answers BETTER**. This benchmark
produces a NUMBER so a pipeline change can be shown to have earned its
merge instead of just "seeming" better.

## What it measures

For each of the ~27 fixed, **synthetic** questions in
`bench-questions.mjs` (graded across multi-hop, recency-sensitive,
contested/nuanced, unanswerable-by-design, source-diversity-trap, numeric,
comparison — in English **and** Swedish), the runner:

1. Runs the real research pipeline against the live `/api/chat` SSE
   endpoint (web search ON), capturing the answer and reconstructing the
   numbered source registry from the trace's `search_done` events.
2. Computes two **free, deterministic** metrics with no LLM
   (`bench-score.mjs`):
   - **source diversity** — domain concentration over the trace's sources
     (the round-7 "over-cites its own site" regression shows up as a low
     score here, no judge token spent).
   - **citation coverage** — distinct `[n]` markers and whether a
     "Sources:" list is present.
3. Asks a **strong judge model** (search-off, so no Exa spend) to score, on
   1-5 scales: **citation faithfulness** (does each `[n]` actually support
   its sentence, checked against the registry the answer cited from),
   **coverage** vs the question's rubric, and **calibration** (does it hedge
   where sources conflict / plainly admit when a question is
   unanswerable). Strict JSON verdict.

The pure helpers (`sourceDiversity`, `citationCoverage`, `aggregateScores`)
are unit-tested in `bench-score.test.js` (`node --test
tests/bench-score.test.js`).

## How to run

```bash
cd tests
BASIC_AUTH_USER=… BASIC_AUTH_PASS=… npm run eval:bench
# optional overrides (mirror model-eval):
#   EVAL_MODELS=id1,id2        answer models (default: all up)
#   EVAL_JUDGE_MODEL=id        judge model (default: first up model)
#   EVAL_BUDGET_S=90           per-question research budget
#   EVAL_CONCURRENCY=2         parallel questions
#   EVAL_QUESTION_IDS=a,b      subset of questions
#   EVAL_QUESTION_KINDS=x,y    subset by kind
```

Per-run JSON + a `_summary.json` (carrying `aggregateScores`) land in
`tests/eval-bench-results/<timestamp>/` — **gitignored and ephemeral**,
exactly like `model-eval-results/`. This ledger is the durable record: the
raw output has no lasting repo value, the score deltas recorded here do.

## Discipline (same as MODEL-EVAL-FINDINGS.md)

- **`bench-questions.mjs` is append-only.** Do NOT edit or delete an
  existing question once a baseline exists — past scores stop being
  comparable. Add a new question (fresh id) to cover a new case.
- **Don't deploy/push mid-battery.** A push to `main` triggers Cloudflare's
  auto-deploy, which can silently truncate in-flight streamed requests the
  battery relies on (the exact confusion that hit a `model-eval` round).
  Let the battery finish first.
- **Append, don't rewrite.** New dated section per run.
- **Judge is a model, not ground truth.** Keep the same judge model across
  a before/after comparison so its bias cancels. A score *delta* on the
  fixed set is the signal; an absolute score is not a certified grade.
- All questions are synthetic — never seed this set from real chat data
  (zero-retention promise).

## Round 0 — baseline (TODO: run)

Not yet run. First run should establish a baseline against the current
pipeline: record, per model, the judge means (citation / coverage /
calibration / overall) and the non-LLM source-diversity and
citation-coverage means from `_summary.json`, plus which questions failed
to produce a scorable answer at all. Note the judge model and budget used
so later comparisons hold them fixed.

Once a baseline exists, the workflow to prove a pipeline change earned its
merge: run the set before the change (baseline), make the change (a
prompt tweak, a diversity-cap adjustment, a budget re-tier, …), run the
same set with the same judge/budget after, and compare the aggregate
deltas — an improvement in citation faithfulness or source diversity with
no regression elsewhere is the evidence.
