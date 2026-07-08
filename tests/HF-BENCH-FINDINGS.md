# HF-bench findings ledger

Append-only record of every `tests/hf-bench.mjs` run — the third leg of the
eval stool, next to `MODEL-EVAL-FINDINGS.md` (raw SSE traces read by hand)
and `EVAL-BENCH-FINDINGS.md` (LLM-judged rubric scores on ~27 synthetic
questions). This one grades the pipeline against EXTERNAL question sets with
known gold answers, so it measures something neither sibling can: whether
the research pipeline actually gets independently-verifiable answers RIGHT,
on questions this project didn't write for itself.

## Why these datasets (contamination vetting, 2026-07-08)

The models under test (Berget catalog: Mistral Small 3.2-2506, GLM-4.7,
Kimi-K2.6, Mistral-Medium-3.5, gpt-oss-120b, Llama…) have training cutoffs
between late-2024 and mid-2025. A benchmark whose question/answer pairs sat
plaintext on the crawlable web before those cutoffs measures memory, not
research. A vetting sweep over the Hugging Face hub (via the datasets-server
API + each benchmark's paper) sorted the candidates:

**Selected:**
- **`vtllms/sealqa`** (config `seal_hard`, 254 q; `seal_0` is the harder
  111-q core) — created 2025-05 but contamination-resistant BY DESIGN:
  questions are chosen so naive search returns conflicting/noisy results and
  frontier models score ~0 on seal-0 without live search; the maintainers
  REFRESH answers (updates observed mid-2026), so a stale memorized answer
  is penalized rather than rewarded; plaintext gold answers + supporting
  URLs; Apache-2.0; carries a training-filter canary. Fields:
  `question`/`answer` (+`freshness`, `effective_year` tags, kept in our
  result records).
- **`google/deepsearchqa`** (config `deepsearchqa`, split `eval`, 900 q) —
  published 2025-12-17, months after every cutoff in scope, so effectively
  zero contamination. Multi-hop causal-chain web questions across 17
  categories — the exact `multihop` weakness the synthetic bench identified.
  Fields: `problem`/`answer`/`answer_type` (35% single, 65% set)/
  `problem_category`; Apache-2.0. Caveat: gold answers reflect the
  late-2025 web; expect a few % drift — spot-check disagreements before
  reading a low score as a pipeline failure.

**Rejected (and why):** GAIA / HotpotQA / FRAMES / WebWalkerQA / HLE
(famous + pre-cutoff plaintext = high contamination; several aren't
live-web tasks at all), BrowseComp (encrypted, but inverted-trivia style
and Apr-2025), BrowseComp-Plus & FutureSearch Deep Research Bench &
DeepResearchGym (frozen-corpus premise — ground truth is only correct
against their snapshot, wrong for a live-Exa pipeline), xbench-DeepSearch /
BrowseComp-ZH (Chinese-only), WideSearch (table-filling; scoring harness
too heavy), FinSearchComp (finance-only, large zh share),
`ScaleAI/researchrubrics` + `realliyifei/ResearchQA` (good rubric sets —
noted as future candidates for a rubric-mode extension, but they overlap
with what eval-bench.mjs already measures and need per-criterion judging).

## What a run does

Rows are fetched from the HF datasets-server AT RUN TIME (never committed —
SealQA's answers refresh upstream, a committed copy would rot), a fixed
`HF_SEED` samples a stable subset, each question runs through the real
pipeline via the live `/api/chat` SSE endpoint, and one search-off judge
call grades the answer against the gold (`correct` / `partial` / `reason`).
Deterministic extras per run: **benchmark-leak detection** (any cited
source on huggingface.co / arxiv.org / github.com etc. means the pipeline
found the benchmark instead of researching the facts — the run is counted
and flagged `leak-tainted`, never silently) and the SealQA freshness tags.
Failed runs count as WRONG in accuracy, not excluded.

```bash
cd tests
BASIC_AUTH_USER=… BASIC_AUTH_PASS=… npm run eval:hf
# HF_DATASET=sealqa|deepsearchqa  HF_CONFIG=seal_0  HF_SAMPLE=25  HF_SEED=1
# EVAL_MODELS=id1,id2  EVAL_JUDGE_MODEL=id  EVAL_BUDGET_S=120  EVAL_CONCURRENCY=2
```

Results land in `tests/hf-bench-results/<timestamp>-<dataset>/` (gitignored,
ephemeral). This ledger is the durable record.

## Discipline (same as the sibling ledgers)

- **Keep `HF_SEED`, sample size, budget, and judge model FIXED across a
  before/after comparison** — the accuracy delta on the identical subset is
  the signal; an absolute score is not a certified grade.
- **Don't deploy/push mid-battery** — a Cloudflare auto-deploy truncates
  in-flight streams and poisons results.
- **Append, don't rewrite.** New dated section per run.
- **Watch `leaked_runs`** — a nonzero count means scores are inflated by the
  pipeline finding the benchmark itself; investigate before comparing.
- **SealQA drift**: record `effective_year` distribution; the upstream set
  refreshes (pull fresh rows near a battery, don't cache across weeks).

## Round 0 — 2026-07-08 (baseline, pre-decomposition pipeline)

**Run config (hold fixed for the A/B):** `HF_SAMPLE=25 HF_SEED=1
EVAL_BUDGET_S=120 EVAL_CONCURRENCY=2`, answer AND judge model
`mistralai/Mistral-Small-3.2-24B-Instruct-2506`, against the live site
running `main@852dbe7` — i.e. BEFORE the triage-decomposition change
(complexity classification + sub-questions + dependent-hop gap rule +
conflict surfacing) deploys. That change is the reason this baseline
exists: it targets multi-hop, and DeepSearchQA is multi-hop by
construction.

**Results:**

| dataset | accuracy | partial-mean | failed | leak-tainted |
|---|---|---|---|---|
| `google/deepsearchqa` (eval, seed-1 25-subset) | **8.0%** (2/25) | 16.0% | 0 | 2 |
| `vtllms/sealqa` seal_hard (test, seed-1 25-subset) | **16.0%** (4/25) | 16.0% | 0 | 3 |

**Reading the numbers:** low absolute scores are EXPECTED and are the
point — both sets are built to defeat memorization and naive
single-wave search, and even purpose-built deep-research agents score
far below ceiling on them. 0 failed runs out of 50 means the pipeline
itself was stable throughout; every miss was a genuine research miss
(graded answer ≠ gold), not an error.

**Observed failure patterns (from reading the per-run records):**
- DeepSearchQA's misses cluster on *set answers requiring exhaustive
  enumeration from official statistics portals* (NCES, Statistics
  Canada, UK Hansard, data.nysed.gov): Exa highlights carry prose, not
  data tables, so the pipeline can name SOME set elements (the 0.25–0.5
  partials) but can't enumerate all — a retrieval-modality limit, not a
  planning one. The decomposition change may help the multi-hop chains
  but will not conjure table data out of search highlights; if the A/B
  shows partial-mean rising while strict accuracy stays flat, that's
  why.
- SealQA misses are dominated by "how many X currently…" counting
  questions where sources conflict or trail the present — the exact
  calibration trap the set is built around.
- The leak detector earned its keep immediately: 5/50 runs cited a
  github.com/HF mirror of the underlying data (e.g. a Maddison-Project
  R-package repo) — flagged, kept in the score, worth watching in
  comparisons.

**Next:** once the decomposition change (branch
`claude/deep-research-architecture-eval-h8p4nx`) is merged and deployed,
rerun BOTH rows with the identical config above and append the deltas
here. Expectation to test: multi-hop chains (DeepSearchQA) improve via
sub-question coverage audit + dependent-hop queries; SealQA calibration
improves via conflict surfacing; `simple`-complexity capping should not
affect these sets (few of their questions triage as simple).

## Round 1 — 2026-07-08 (A/B: triage decomposition deployed)

**Run config:** identical to round 0 (`HF_SAMPLE=25 HF_SEED=1
EVAL_BUDGET_S=120 EVAL_CONCURRENCY=2`, Mistral Small 3.2 answer+judge),
against `main@07651a0` — the triage-decomposition merge (complexity
classification, sub-questions, dependent-hop gap rule, conflict
surfacing, simple-complexity depth capping). Deploy verified live before
the battery via a plan-step probe (`· multihop` tag + `Sub-question:`
details present).

**Results (baseline → after):**

| dataset | strict accuracy | partial-mean | failed | leak-tainted |
|---|---|---|---|---|
| `google/deepsearchqa` | 8.0% → **12.0%** (2/25 → 3/25) | 16.0% → **22.7%** | 0 → 0 | 2 → 3 |
| `vtllms/sealqa` seal_hard | 16.0% → **20.0%** (4/25 → 5/25) | 16.0% → **20.0%** | 0 → 0 | 3 → 3 |

**Reading:** directionally positive on both sets and both metrics, and
stability held (0/50 failed runs both rounds). Honest sizing: at n=25 a
+4-point strict delta is ONE extra correct question — inside
single-sample noise on its own. The more trustworthy signal is
DeepSearchQA's partial-mean +6.7 points, which aggregates continuous
set-element credit across all 25 questions and matches the change's
mechanism (sub-question coverage audit + dependent-hop queries should
recover MORE elements of multi-hop set answers, exactly what partial
credit measures). Consistent with round 0's prediction that partials
would move more than strict accuracy (the strict misses remain dominated
by exhaustive-enumeration questions whose data lives in tables Exa
highlights don't carry).

**Decision:** the change stays merged — a consistent, mechanism-matching
improvement with no regression anywhere (and no stability cost). Not yet
"proven large": a de-noising pass (2-3 more seeds, or the denoise-driver
pattern applied here) would be the next evidence step if a stronger claim
is ever needed. Carried forward: (1) enumeration-from-tables misses are a
retrieval-modality gap — Exa highlights vs data tables — worth its own
investigation (e.g. targeted /contents fetch ONLY for enumeration-type
questions, intent-gated, cheap); (2) leak-tainted runs sit stable at
2-3/25 — acceptable, keep watching.
