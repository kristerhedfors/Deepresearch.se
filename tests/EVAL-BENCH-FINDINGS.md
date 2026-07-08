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

## 2026-07-08 — Hugging Face Hub search integration (build → A → improve → B)

**What was tested:** the new HF Hub search-phase source (`src/hf.js` +
`maybeHfSearch` — Hub models/datasets/papers joining the registry when the
question explicitly targets Hugging Face), using four new kind-`hf` bench
questions (`hf_swedish_asr`, `hf_deep_research_datasets`, `hf_gated_llama`,
`hf_swedish_llms`). Config held fixed throughout: 120s budget, concurrency
2, Mistral Small 3.2 as both answer and judge model.

**Protocol and scores (judge overall, per question):**

| question | pre-integration | A (first build) | B (after fixes) |
|---|---|---|---|
| hf_deep_research_datasets | 4.000 | 5.000 | 3.667 |
| hf_swedish_asr | 4.333 | 5.000 | 5.000 |
| hf_gated_llama | 4.000 | 4.667 | 4.667 |
| hf_swedish_llms | 3.667 | 4.333 | 4.667 |
| **mean** | **4.00** | **4.75** | **4.50** |

**Fixes between A and B, each traced to A's traces + live probes:**
1. **Distinctive-term ladder** — the Hub's `?search=` endpoints are
   name-substring matchers; A's naive token-drop kept generic words and
   returned high-download junk ("speech recognition" → Russian
   emotion-recognition models). Verified live post-fix: "swedish" leads the
   fallback and returns KBLab's canonical 2.5M-download Swedish ASR model
   at rank 1.
2. **Search-intent qualifier stripping + cross-wave dedup** — gap-round
   queries carry Exa-oriented qualifiers ("independent reviews") that
   sabotaged name-matching AND caused repeat hub searches for zero new
   sources; both verified fixed by probe.
3. **search_done events instead of a generic step** — A's hub sources were
   cited [n] in answers but INVISIBLE to the client source panel, the debug
   JSON, and the registry the eval judge fact-checks against (all three
   reconstruct from search_done). B's traces confirm 8–25 hub-API items per
   run now sit in the reconstructed registry.

**Honest reading:** pre→A (+0.75) suggests the integration helps, and A→B
(−0.25) is flat within this benchmark's known single-sample noise (±2 per
cell — see the de-noise driver note above); the B fixes' verified value is
in RELEVANCE (junk eliminated — probe-verified, which the judge couldn't
see in A because A's junk went uncited), duplicate elimination, and source
-panel/eval integrity, not in a judge delta at n=4×1. The one B drop
(hf_deep_research_datasets coverage 5→3) reads as generation variance: the
judge note says rubric points were "briefly mentioned", and that question's
hub hits are name-matched "web-bench"-style datasets rather than the
canonical benchmarks — see carried-forward.

**Carried forward:**
1. Name-substring matching cannot surface canonical benchmark datasets for
   compound/hyphenated terms (sealqa, deepsearchqa never appear for the
   datasets question) — the papers/search endpoint partially compensates.
   If a future round shows this mattering on more questions, consider a
   dataset full-text search fallback or distinctive-bigram attempts.
2. De-noise (multi-sample) these 4 questions before trusting any
   per-question delta here as real.

## 2026-07-08 — Round C: hub↔web cross-pollination fixes

**Trigger:** a user-supplied production trace ("Search hf for the latest
and greatest on cybersecurity") showing (a) three hub searches returning
~95% identical results, (b) ZERO hub artifacts cited in the answer despite
the explicit "search hf" ask, (c) triage planning 1 query against 4
sub-questions.

**Fixes (same config as A/B; all probe-verified against the exact trace
query before the battery):**
1. Winning-attempt dedup (`usedKeys`/`skipKeys` through the registry
   contract) — probe: dup URLs per hub wave fell from ~11/11 to 1-2/11,
   papers kept contributing fresh items.
2. Most-specific-query picking (`pickQuery`, identifier terms weighted) +
   survey meta-words (trends/discussions/developments/…) into the noise
   list — the web→hub insight path (gap-learned CVE ids now reach the hub).
3. synthPrompt platform-inventory rule AND the decisive one: a registry
   CAPACITY race — wave-1 Exa results filled plan.maxSources before the
   hub search ran, so hub items sat in overflow, absent from the digest,
   uncitable. Aux sources now reserve up to one search's worth of registry
   slots on first contribution. Probe after: the answer opens with a
   "Latest Hugging Face Models for Cybersecurity" section citing artifact
   pages directly.
4. triagePrompt: queries must collectively cover the sub-questions —
   probes now plan 2-3 angles (was 1).

**Scores (A → B → C):** overall 4.75 → 4.50 → **4.667**; per question:
datasets 5.00→3.67→**4.33**, gated_llama 4.67→4.67→**5.00**, swedish_asr
5.00→5.00→**5.00**, swedish_llms 4.33→4.67→**4.33**. Calibration mean
**5.00**. Hub-API sources per reconstructed registry: 14–29 (the capacity
reserve working at scale).

**Notes:** (1) the non-LLM `diversity` metric dropped (0.41→0.29) — a
METRIC ARTIFACT, not a regression: it keys plain domains, so the newly
admitted hf.co artifact sources read as concentration even though the
registry keys them per owner; if hub-heavy questions become common, teach
bench-score's sourceDiversity the same per-owner keying. (2) Inventory-
rule adherence varies by answer model (Mistral Small follows it cleanly;
one Mistral-Medium probe leaned on web sources) — single-sample
observations; watch, don't tune yet.

**Carried forward:** consider `sort=trendingScore` (or lastModified) for
"latest/greatest" hub intents — sort=downloads surfaces popular-but-stale
repos; needs an empirical probe of the API's supported sort values first.
