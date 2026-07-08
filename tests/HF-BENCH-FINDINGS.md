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

## Round 0 — 2026-07-08 (harness smoke test)

See the dated entry appended by the first real run. The harness was built
alongside the triage-decomposition pipeline change (complexity
classification + sub-questions + dependent-hop gap rule + conflicts
surfacing); the intended first use is a before/after on that change once it
deploys: `HF_DATASET=deepsearchqa HF_SAMPLE=25 HF_SEED=1 EVAL_BUDGET_S=120`
against the pre-change deployment (baseline), then the same command against
the post-change deployment. DeepSearchQA is the primary A/B set (multi-hop
is what the change targets); SealQA `seal_hard` is the secondary
(freshness/conflicting-source calibration).
