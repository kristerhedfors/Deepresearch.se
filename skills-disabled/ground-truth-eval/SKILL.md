---
name: ground-truth-eval
description: >-
  Load when measuring whether deep-research answers are RIGHT rather than
  whether they read well — running tests/dr-eval.mjs, rebuilding
  tests/evalsets/ with scripts/dr-evalset.mjs, adding a benchmark, doing a
  before/after A/B on a pipeline change, or reading tests/DR-EVAL-FINDINGS.md.
  Covers the three gold-answer sets (FRAMES, SimpleQA, BrowseComp) and why sets
  rejected as contaminated are usable behind a no-search CONTROL ARM; the loss
  breakdown that says whether retrieval or synthesis lost an answer; the
  A/B DEPLOY DANCE this account forces (workers.dev is off, so there is no
  preview URL, and a branch push ships to production); and the four measurement
  traps already paid for — a leak detector calibrated for another question set,
  a source-list parser that only knows one layout, a metric whose MEANING moves
  under the change being measured, and grading a set without measuring how much
  of it the model already knew. Companion to model-eval (per-model quirks),
  the rubric bench (blind quality) and rag-hillclimb (retrieval only).
---

# The ground-truth battery — is the answer right?

## What it is for, and what it is not

`tests/eval-bench.mjs` judges answers **blind**: a judge model scores 1–5 on
citation, coverage and calibration. That measures whether an answer *reads*
well. It cannot say whether it is *right*, because no right answer is written
down — which is why `EVAL-BENCH-FINDINGS.md` records a ~0.6 drop it can detect
and cannot attribute.

`tests/dr-eval.mjs` grades against **published gold answers**, over
`POST /mcp` (what an external caller experiences). Use it when the question is
"did this change make answers more correct", and the rubric bench when the
question is "did this change make answers better written".

## The three sets

Built by `scripts/dr-evalset.mjs` into `tests/evalsets/*.json`, seeded so a
rebuild picks the same questions — resample and you are measuring the sample.

| set | n sampled | what it is for |
|---|---|---|
| FRAMES | 60 / 824 | multi-hop, and it NAMES the Wikipedia pages each question was built from — the only one that can separate a retrieval loss from a synthesis loss |
| SimpleQA | 60 / 4326 | single-fact; the hallucination-vs-abstention probe |
| BrowseComp | 30 / 1266 | deliberately hard to find; the ceiling, and it has headroom for years |

**BrowseComp rows stay XOR-obfuscated in the committed file** and are
decrypted at load. The obfuscation exists so the answers do not reach a
training corpus; committing them in clear would be the leak it guards against.
If you add a set that ships obfuscated, keep it that way.

## Contamination: measure it, don't assume it

These three were rejected here on 2026-07-08 as contaminated, correctly on the
evidence then available — they predate every training cutoff in the catalogue.
The control arm is what makes them usable:

```bash
node tests/dr-eval.mjs --set frames --label base                 # search on
node tests/dr-eval.mjs --set frames --arm nosearch --label control
node tests/dr-eval.mjs --uplift data/dr-eval/frames-{base,control}.json
```

Measured 2026-08-05: FRAMES 35.0% closed-book → 61.7% with the pipeline
(+26.7 points, p=0.0015). SimpleQA **6.7%** closed-book → 88.3%.

Two lessons worth keeping:

- **Publication date is not contamination.** FRAMES turned out substantially
  memorised and SimpleQA barely at all, and only the control arm could tell
  them apart. Reasoning from dates was the responsible thing to do without one;
  it is not once you have one.
- **`--uplift` also reports questions retrieval talked the model OUT of** — 4
  on FRAMES. That is a real cost of searching and it had never been visible.

**Caveat:** `web_search: false` gates the Exa leg only. Auxiliary sources
(arXiv, Europe PMC, Scholar, the hosted corpora) run regardless
(`searchPolicyFor`). On FRAMES the control arm averages 0.2 sources per answer,
so the number holds; on a set whose questions reach the academic sources it
does not, and the uplift would understate the pipeline.

## The loss breakdown is the point

A score says something is wrong. The breakdown says **which stage**:

| label | meaning |
|---|---|
| `no_sources` | search returned nothing usable |
| `retrieval_miss` | sources cited, none of the gold ones — the answer was never in the pile |
| `synthesis_miss` | a gold page WAS retrieved and the answer is still wrong |
| `abstained` | declined to answer; NOT scored as fabrication |
| `unknown` | the set publishes no gold sources, so no attribution is possible |

First run: **14 synthesis misses to 1 retrieval miss** on FRAMES. That pointed
straight at `sourceDigest` silently dropping ~9 of 32 retrieved sources before
synthesis ever saw them — a defect found independently by reading the code the
same day. Work the stage the breakdown names, not the one you assume.

## The A/B deploy dance (this account has no preview URL)

The obvious plan — upload a preview version and point the eval at it — **does
not work here**. The worker's `workers.dev` subdomain is `enabled: false`, so
`wrangler versions upload` reports `has_preview: false` and the
`<version>-<worker>.<subdomain>.workers.dev` host 404s. And per the **deploy**
skill (measured 2026-07-30) a push to ANY branch ships to production, so
"just push the branch" is not a private option either.

The procedure that works:

```bash
# 1. baseline against production, and DO NOT push or deploy while it runs
node tests/dr-eval.mjs --set frames,simpleqa --label base

# 2. note the rollback target, then deploy the candidate
npx wrangler deployments list          # record the current 100% version id
npx wrangler versions upload           # prints the new Worker Version ID
npx wrangler versions deploy <new-id>@100% --yes

# 3. VERIFY the change is live with a probe that could only pass on new code.
#    "It answered fine" is not verification. Allow for propagation — the first
#    request after a deploy can still hit the old version.

# 4. after arm, same seed / budget / judge / workers
node tests/dr-eval.mjs --set frames,simpleqa --label after
node tests/dr-eval.mjs --compare data/dr-eval/frames-{base,after}.json

# rollback is one command
npx wrangler versions deploy <old-id>@100% --yes
```

Verdicts are **paired exact McNemar** (imported from
`scripts/rag-eval-core.mjs`). At n=60 the independent binomial interval is ±12
points and calls almost every real effect noise.

## Four traps already paid for

1. **A leak detector calibrated for another question set does not transfer.**
   Reusing `hf-bench-lib.mjs`'s `detectBenchmarkLeak` reported 9 of 30
   BrowseComp runs contaminated; 24 of the 27 flagged URLs were ordinary arXiv
   papers. Its host list includes `arxiv.org`, right for HuggingFace-hosted ML
   datasets and wrong here, where arXiv is a registered research source.
   `benchmarkLeaks` in `dr-eval-core.mjs` keeps the hosts these sets live on.
2. **The source list is the answer model's own formatting.** A parser that
   knows one layout reports zero sources for an answer that cited a dozen —
   markdown-link URLs (`— [https://…](https://…)`) did exactly that, and it
   looked precisely like a retrieval regression mid-arm. `parseCitations` is
   deliberately loose: find the `[n]`, find the first URL on the line, take it.
3. **A metric whose MEANING moves under the change being measured is not a
   metric.** Fixing the duplicated source list changed `sources/answer` from
   "sources retrieved" (the appended registry) to "sources cited" (the model's
   own list) — 23 to 10, with retrieval unchanged. Accuracy was unaffected and
   carried the verdict. Say which metrics are comparable across a change.
4. **Re-derive, don't re-run.** Run files keep each answer's full text, so
   `--rescore` recomputes every citation-derived metric with today's parser.
   A parser fix would otherwise silently retire every baseline. Grades are
   never touched — those cost judge calls and re-running them would change the
   thing being compared.

## Discipline

- Ledger `tests/DR-EVAL-FINDINGS.md`, append-only, newest section per run.
  A rate without its paired p-value is not a result.
- Hold everything but one variable: same seed, budget, judge model, workers.
  Latency is only comparable at equal `--workers`.
- The server caps one account at **5 concurrent spending tool calls and admins
  are not exempt** (`INFLIGHT_CAP`). `--workers` is clamped to 4; the refusal
  arrives as `isError` inside a 200, not a 429, and is retried with backoff.
  A quota refusal is never retried.
- Break-glass is quota-exempt, so a battery has no spend ceiling. 150 questions
  at a 120 s budget cost roughly €5–8 and about 20 minutes at 4 workers.
- The judge runs directly on Berget (`BERGET_API_KEY`), off the site's own
  quota and out of `chat_logs`.
