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

### Round C addendum — staleness blend + phrasing-driven API plan (probe-verified)

Two follow-on user asks, verified by live probes rather than a full
battery (retrieval-plumbing changes; the next scheduled battery covers
them):
1. **"No stale stuff unless really relevant"**: every ladder attempt now
   fetches a popular slice (sort=downloads — the canonical exception) AND
   a fresh slice (sort=lastModified, ≥20-download junk floor), merged and
   deduped (`mergeSlices`); recency phrasing ("latest/newest") makes the
   fresh slice LEAD. `expand[]` params surface updated-dates on every
   item's citation highlight.
2. **"Leverage the full API from search phrasing"** (`hfQueryPlan`):
   curated phrase→pipeline_tag/task_categories maps, English+Swedish
   language-word→ISO maps, and sort intent (trending→trendingScore, most
   liked→likes). Consumed words leave the term list, so "latest Swedish
   speech recognition models" becomes a PURE filtered browse — live probe:
   the hub now returns pyannote/whisperkit/whisper-large-v3-turbo (the
   real 7-8M-download sv-ASR ecosystem) where name-matching returned
   12-download hobby repos; papers found the National Library's Swedish
   speech-corpus paper. Filtered attempts carry kind-scoped dedup keys.
   Dataset language tags proved UNRELIABLE (?language=sv → github-code) —
   language filter is models-only, evidence noted in code.

## 2026-07-15 — Report-comprehensiveness tiers (slider → output depth): instrumentation + protocol

**Change under test:** branch `claude/slider-comprehensiveness-scaling-wcwyde`
— the time slider now scales the OUTPUT's structure/comprehensiveness, not
just research depth (`src/budget.js reportTierFor`: brief <60s / standard
<180s / extended <420s / full ≥420s; `prompts.js REPORT_TIER_STRUCTURE`
per-tier synthesis guidance; synthesis/validation token caps and
source-digest scaled at the top tiers). The `standard` tier is pinned
byte-identical to the pre-tier prompt by unit test, so the 60s default needs
no re-baselining.

**New instrumentation (this round):** `bench-score.mjs reportStructure` — a
free, deterministic report-shape metric (body words before the Sources
list, h1/h2/h3 counts, table data rows, bullets, hasTitle / hasBoldLead /
hasLimitations as 0/1 rates), carried per-run in `metrics.structure` and
aggregated per model + overall in `_summary.json` (`structure` block) and
the score table (`words`/`h2`/`limits` columns). Deliberately NOT folded
into the judge overall: structure is what the tier bought, the judge's 1-5
dims are quality — conflating them would let sheer length inflate quality.

**Incident — the first baseline attempt found a LIVE regression instead
(battery aborted after 4 runs, results discarded):** every break-glass
request returned a 5-question QUIZ built from the site's own source
(chat_logs #360: `introspection:1`, zero queries, quiz explanations citing
tsconfig comments). Two stacked causes, both structural for the bench
identity: (1) developer mode is ALWAYS ON for the break-glass admin by
design (`settings.js developerModeEnabled` — no settings row to flip; the
PUT is refused: "Settings need a signed-in account"), so the introspection
enrichment injects on every request; (2) `pipeline.js`'s quiz gate ran
`quizIntent(ctx.lastUser)` — the ENRICHMENT-APPENDED text. The injected
CLAUDE.md orientation contains literal "quiz me…" prose, so the gate fired
on 100% of dev-mode requests (reproduced locally against an excerpt-bearing
string). The same bug class was already fixed for `externalSourceIntent`
(the cleanLastUser split); the quiz gate had been missed. Even with the
quiz gate fixed, `externalSourceIntent` matches none of the bench questions
(probed locally), so ALL break-glass bench traffic routes introspection-
first — the rubric bench has been structurally unrunnable since
introspection mode shipped.

**Fixes shipped with this branch (each with regression pins):**
1. Quiz gate reads `ctx.cleanLastUser` (both the primary gate and the
   triage-backup question count) — source-pinned in `pipeline.test.js`.
2. OFF-ONLY `/api/chat` body override `developer_mode: false` (the
   incognito pattern: decline a held capability, never acquire one) so the
   break-glass bench identity can skip the introspection enrichment;
   `eval-bench.mjs` and `model-eval.mjs` now always send it.

**Revised protocol — same-deploy seam A/B (replaces the planned temporal
before/after, which the incident made impossible: the pre-tier deploy
cannot run the bench at all under break-glass).** `planResearch(model, 179)`
and `planResearch(model, 180)` produce IDENTICAL research plans (queries,
gap rounds, followups, maxSearches/Sources, digestCap, searchDepth — pinned
in `budget.test.js` "the bench A/B seam") while crossing the standard →
extended report-tier boundary, so a paired battery at 179s vs 180s on the
SAME deploy isolates exactly the report-tier prompt change — no live-drift
confound between sides, interleavable, and the questions/judge stay fixed:

```bash
cd tests && BASE_URL=https://deepresearch.se \
  EVAL_MODELS='mistralai/Mistral-Small-3.2-24B-Instruct-2506' \
  EVAL_JUDGE_MODEL='mistralai/Mistral-Small-3.2-24B-Instruct-2506' \
  EVAL_BUDGET_S=179 EVAL_CONCURRENCY=2 node eval-bench.mjs   # side A: standard
# then identically with EVAL_BUDGET_S=180                    # side B: extended
# descriptive top-tier readout (no counterpart, research depth differs):
#   EVAL_BUDGET_S=450 — full tier structure numbers
```

**What "earned its merge" looks like:** at the 179/180 seam the structure
dims move decisively on side B (words up toward 800–1,500, h2 > 0 on most
runs, hasLimitations → ~1.0) while the judge dims (citation / coverage /
calibration) hold or improve — coverage may rise (more rubric points fit);
citation faithfulness and calibration must NOT drop (the padding-forbidden
rule exists precisely to protect them). Words up WITH a judge drop = the
tier bought length, not substance — that blocks the merge, not the bench.

**Scores (both sides run 2026-07-15, post-deploy of PR #81; 30/30 judged
each; PR #82 — front-end only, no pipeline change — merged one minute before
side A started, so both sides ran on identical pipeline code; no runs
errored):**

| dim | A: 179s (standard) | B: 180s (extended) | Δ |
|---|---|---|---|
| judge citation | 4.60 | 4.53 | −0.07 |
| judge coverage | 4.10 | 3.83 | −0.27 |
| judge calibration | 4.33 | 4.20 | −0.13 |
| judge overall | **4.34** | **4.19** | −0.15 |
| source diversity | 0.72 | 0.71 | ~0 |
| citation coverage | 1.00 | 0.93 | −0.07 |
| words (mean) | 369 | **655** | +78% |
| h2 sections (mean) | 0.07 | **5.30** | — |
| hasLimitations rate | 0.00 | **0.97** | — |

**Read:** the tier DELIVERED its structure (words +78%, ~5 `##` sections
per answer, limitations sections near-universal — none of which the
standard side produced). The judge-overall drop (−0.156 paired mean,
stdev 0.84, SE ≈ 0.15, median 0, wins 9 / ties 7 / losses 14) is inside
noise overall — but it is NOT randomly distributed: **focused-lookup kinds
(numeric, hf, recency) went 0 wins / 7 losses** (e.g. num_renewable_share
5→3, hf_gated_llama 5→3.67), while broad kinds netted positive
(mh_battery_supply_chain 3→5, div_tesla_fsd +1, cmp_ztna_vpn +1, contested
+0.33..+0.67). Structured reports help questions with breadth to organize
and dilute questions with one fact to state — the OUTPUT-side twin of the
deep-tier finding. One unexplained single-question outlier (cmp_nis2_sec
5→3, n=1) noted, not tuned against.

**Mechanical finding:** 4/30 extended answers ended mid-URL inside their
"Sources:" list with a CLEAN finish (no stream error, ~1.2–2.9k output
tokens — nowhere near the 4096/6144 caps): Mistral Small simply stops
early on long generations. That is what dropped citation coverage to 0.93
(the judge also penalized the two truncated-list answers). Pre-tier
answers (~600 output tokens) never entered this regime. WATCH item: if it
recurs across models/batteries, consider a model-profile or a
tier-vs-model interaction; single-battery, single-model evidence so far.

**Verdict: the tier earns its keep WITH one refinement, shipped in the
same commit as these scores** — `applyComplexityToPlan` now also caps the
REPORT TIER at `standard` for triage-`simple` questions (the exact kinds
that lost), mirroring the research-depth cap it already applies and
keeping the padding-forbidden rule's promise. Citation faithfulness and
calibration held within noise, structure moved decisively, and the losing
cluster is addressed at the cause (simple questions no longer get report
scaffolding regardless of slider position). Follow-up worth a future
battery: re-run this same seam A/B post-refinement — the simple-kind
losses should disappear from side B while the broad-kind gains remain.


## 2026-07-23 — bench-gate baseline recorded (the P7 routine gate ships)

The rubric bench is now a ROUTINE gate: `tests/bench-gate.mjs`
(`npm run bench:gate`) runs the pinned de-noised battery and compares
against the committed `tests/bench-baseline.json`; `--record` re-records
it. Initial baseline recorded against deployed main (commit b2a5ab6):
Mistral Small 3.2 as answer and judge model, 240 s budget, the four
denoise diagnostic questions, 3 samples attempted → 2 complete battery
means (sample 2 scored 3/4 questions — its battery mean was dropped, its
per-question rows kept). **Battery overall 3.625±0.042** (per-question:
mh_semiconductor_export 2.833, rec_eu_ai_act_timeline 5.0,
div_openai_safety 3.111, con_coffee_health 4.0). The tiny SD is a 2-sample
artifact — the gate floors its noise bar at 0.15 absolute for exactly this
reason. Worth re-recording at SAMPLES=4+ when convenient. Discipline and
verdict semantics: docs/TESTING.md §"The bench gate"; the pre-push hook
now names the gate when outgoing commits touch pipeline-sensitive files.

## 2026-07-29 — the first gate run since 2026-07-23, clearing eleven owed changes

- bench-gate 2026-07-29 (commit 978ce70a vs baseline b2a5ab6): overall
  3.278±0.437 vs 3.625±0.042 (delta -0.347, bar ±0.43) → NEUTRAL. Pins:
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / judge
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / 240s /
  mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health.

Run at SAMPLES=3 (the default) against the live deployment, covering the
eleven pipeline-sensitive changes that had accumulated unmeasured since the
baseline: PRs #295, #298, #301, #305, #307, #319, #322, #324, #329, #331,
#335 — 106 pipeline-sensitive file changes in total. NEUTRAL is therefore a
statement about the stack, not about any one of them; a regression in one
offset by a gain in another would read the same. That is the cost of letting
the debt accumulate, and the argument for running the gate per queue rather
than per backlog.

**The delta is one cell, not a drift.** `mh_semiconductor_export` scored
1.333 / 3.333 / 1.667 across the three samples (77–88 sources each) for
2.111±0.875 — it alone accounts for the battery's spread, and it was already
the weakest question at 2.833 in the baseline entry above. The other three
cells sit at or above their previous values, `rec_eu_ai_act_timeline`
highest at 4.667±0.272.

**The baseline is the noisier side of this comparison, not the candidate.**
Its 0.042 SD over n=2 was already recorded above as a 2-sample artifact with
a standing recommendation to re-record at SAMPLES=4+. Deliberately NOT
re-recorded here: the discipline re-records on IMPROVED, and a NEUTRAL run
is not the moment to move the reference. The recommendation stands, and a
4+-sample re-record would also give `mh_semiconductor_export` enough samples
to say whether its swing is the question or the pipeline.

**Operational finding: the gate runs from a session container.** It needs
only `BASIC_AUTH_USER`/`BASIC_AUTH_PASS` (both present), defaults `BASE_URL`
to the live site, and imports nothing outside node built-ins, so
`tests/node_modules` being absent does not matter. Sessions had been
recording it as impossible to run pre-merge; what is impossible is running
the AFTER half before the change deploys, which is a different constraint.
Wall clock was about seven minutes for 3 samples × 4 questions.

## 2026-07-30 — REGRESSION verdict, and why it should not be acted on alone

- bench-gate 2026-07-30 (commit 4f248922 vs baseline b2a5ab6): overall
  2.667±0.25 vs 3.625±0.042 (delta -0.958, bar ±0.30) → **REGRESSION**. Pins:
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / judge
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / 240s /
  mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health.

Run immediately after PR #340 deployed. Exit code 2. Reported rather than
smoothed over — this is the first REGRESSION the gate has returned.

**The narrow diagnosis points at PR #340 and the evidence contradicts it.**
`src/pipeline.js` and `src/prompts.js` are the only pipeline-sensitive files
changed since the NEUTRAL run earlier the same day, and both changes are
#340's. But #340's prompt additions are provably inert without an active
watch thread — `directPrompt() === directPrompt({ watchBuild: "" })` holds for
all three answer prompts, checked directly at merge — and none of the four
pinned questions (semiconductors, the EU AI Act, OpenAI safety, coffee) opens
one. So the mechanism by which #340 could move these four scores is not
visible, which is a reason to distrust the attribution rather than the
verdict.

**Three runs of this battery now disagree with each other more than the bar
they are judged against.** 3.625±0.042 (n=2, 07-23), 3.278±0.437 (n=3,
07-29), 2.667±0.25 (n=2, 07-30) — a spread of ~0.96 across runs whose code
differences are, for these questions, close to inert. Per-cell the pattern is
mixed rather than systemic: `div_openai_safety` went UP (2.667 → 3.0) while
`rec_eu_ai_act_timeline` fell 1.33 and `con_coffee_health` fell 1.44. A
uniform pipeline regression does not usually raise one cell.

The likelier candidates are the two this harness cannot hold still: the LIVE
environment (the bench drives real search and real provider load end to end,
and the web-search backend changed materially in PRs #330/#331 the day
before), and judge variance at n=2–3, which the gate's own header warns is
"±2+ per cell and never trustworthy alone".

**What this run does establish**, independent of the verdict: the battery at
SAMPLES=2–3 cannot resolve a change of this size. Its noise bar is computed
from the same two samples it is judging, so a run that happens to agree with
itself produces a tight bar and a confident verdict, which is exactly how the
07-23 baseline came to carry an SD of 0.042.

Recommended before anything is reverted: re-run at SAMPLES=5+ and, if the
regression reproduces, bisect by deploying #340's revert rather than reasoning
about it. Not re-recording the baseline either way — a REGRESSION run must
never become the reference.

## 2026-07-30 (SAMPLES=5) — the regression is REAL, PREDATES #340, and was masked by noise

- bench-gate 2026-07-30 (commit 6d894c35 vs baseline b2a5ab6): overall
  3.146±0.069 vs 3.625±0.042 (delta -0.479, bar ±0.15) → **REGRESSION**. Pins:
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / judge
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / 240s /
  mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health.
  4 of 5 samples complete (sample 4 scored 3/4 questions and was dropped from
  the battery means).

Run to discriminate the previous entry's n=2 REGRESSION. It does, and it
overturns the attribution in that entry rather than confirming it.

**The magnitude halved as samples rose** — delta -0.958 at n=2, -0.479 at
n=4 — and every cell came up (`con_coffee_health` 2.222 → 3.533,
`mh_semiconductor_export` 2.0 → 2.5). So the n=2 run was pessimistic, exactly
as its own entry suspected. What did NOT go away is the gap itself.

**#340 is not the cause, and the evidence is the 07-29 run.** That run scored
3.278±0.437 at commit `978ce70a` — *before* #340 existed — which is
statistically the same place as today's 3.146±0.069. Two independent runs on
either side of #340 land at ~3.15–3.28. The 07-29 run was recorded NEUTRAL
only because its own samples disagreed (SD 0.437), which inflated its bar to
±0.432 and swallowed a -0.347 delta. Tighten the sampling and the same code
reads REGRESSION.

So the finding is not "#340 regressed the pipeline". It is:

> The pipeline has been ~0.4–0.5 below the 2026-07-23 baseline for at least a
> day, across 100+ pipeline-sensitive changes, and the gate could not see it
> because a noisy run computes its own permission to pass.

**That is a defect in how the bar is derived**, not only a scoring drift: the
noise bar is computed from the candidate's own sample spread, so an unstable
run is judged leniently and a stable one strictly. A run that cannot reproduce
itself should not thereby earn a wider pass. Recorded here rather than changed
— altering the verdict rule is a judgement about what the gate is for, and
belongs to the owner.

**Do not revert #340 on this evidence.** The drift predates it. What the
numbers justify is: (1) keep the baseline as-is, since re-recording now would
enshrine the regressed level as the reference; (2) find the drift by running
the gate at SAMPLES=5 against a deployment of an OLDER commit, bisecting the
~100 changes rather than reasoning about them; (3) treat any future NEUTRAL
that rests on a large candidate SD as unproven.

Cost note for whoever picks this up: SAMPLES=5 is ~12 minutes and four
questions of real Berget traffic, and it runs fine from a session container
(see the 2026-07-29 operational note above).

## 2026-07-30 (SAMPLES=5, third run of the day) — the drift is persistent, and the baseline level was once real

- bench-gate 2026-07-30 (commit 0027034e vs baseline b2a5ab6): overall
  2.867±0.319 vs 3.625±0.042 (delta -0.758, bar ±0.25) → **REGRESSION**. Pins:
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / judge
  mistralai/Mistral-Small-3.2-24B-Instruct-2506 / 240s /
  mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health.
  5 of 5 samples complete.

Run after PR #342 deployed. #342 is not the cause: its classifier is inert
(`SUBQ_FANOUT_ENABLED` is still `false`, verified at merge), and 2.867 sits
inside the run-to-run spread already observed on unchanged code.

**Four measurements of the current pipeline now exist**, and they agree that
it is below the baseline while disagreeing substantially with each other:

| date | commit | n | overall | verdict |
|---|---|---:|---|---|
| 07-23 | `b2a5ab6` | 2 | 3.625±0.042 | *(baseline)* |
| 07-29 | `978ce70a` | 3 | 3.278±0.437 | NEUTRAL |
| 07-30 | `4f248922` | 2 | 2.667±0.250 | REGRESSION |
| 07-30 | `6d894c35` | 4 | 3.146±0.069 | REGRESSION |
| 07-30 | `0027034e` | 5 | 2.867±0.319 | REGRESSION |

Mean of the four post-baseline runs ≈ **2.99**, range 2.667–3.278. Every one
is below 3.625; three of four exceed their own bar. **The drift is real and
persistent, and no single PR explains it** — it was already present at
`978ce70a`, before #340 and #342, and the intervening changes are mostly not
pipeline-sensitive at all.

**The baseline level was genuinely achieved once, so this is not merely a bad
reference.** The 07-23 entry above records per-question values (mh 2.833, rec
5.0, div 3.111, coffee 4.0 → 3.736), independently in the same band as the
3.625 baseline. Two separate historical measurements sat near 3.6–3.7; four
consecutive current ones sit near 3.0. That is a ~0.6–0.7 fall in answer
quality on this battery, not a measurement artifact.

**Run-to-run spread on unchanged code is ~0.6**, which is larger than most
single-PR effects this gate is meant to catch. Until that is reduced — more
samples, more questions, or a judge with less variance — the gate can detect
a drift of this size but cannot attribute it.

### What should happen next, in order

1. **Bisect by deployment.** Run SAMPLES=5 against deployments of older
   commits, halving the range from `b2a5ab6` to here. This is the only method
   that attributes the drift, and it is the one thing a session cannot do
   unilaterally: it means serving OLD CODE from production for ~12 minutes per
   probe. That is an owner decision, not a session's.
2. **Do not re-record the baseline** until the drift is explained. Re-recording
   now would make the regressed level the reference and permanently hide it.
3. **Do not revert #340 or #342.** Both were checked and neither is implicated.

Suspects worth checking first, on the grounds that they change what the
pipeline *retrieves* rather than what it says: the web-search backend rework
(PRs #330/#331, 2026-07-29 — throttle following, a relevance floor that drops
zero-match results, and a merged cascade), and the arXiv source becoming a
LEAD source that displaces the web leg for questions naming it (PR #324).
Both landed in the window where the drop appears, and both change the sources
synthesis reads.

---

## 2026-07-30, run 5 — and what the judge is actually worth

- bench-gate 2026-07-30 (commit be1930e4 vs baseline b2a5ab6): overall 3.083±0.068 vs 3.625±0.042 (delta -0.542, bar ±0.15) → REGRESSION. Pins: mistralai/Mistral-Small-3.2-24B-Instruct-2506 / judge mistralai/Mistral-Small-3.2-24B-Instruct-2506 / 240s / mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health.

Run after PR #344 (space launch) merged, which touches `pipeline.js` and
`triage.js`. Two of five samples dropped a question to a helper timeout, so the
battery mean rests on three complete samples.

Five candidate runs now exist: **3.278, 2.667, 3.146, 2.867, 3.083** — mean
**3.008**, against a baseline of 3.625. The previous entry called the cause
unattributed and named bisection as the only way forward. Before spending a
production rollback on that, two cheaper hypotheses were tested directly, and
one of them changes how every number above should be read.

### The judge was measured instead of assumed

`tests/rejudge-probe.mjs` replays an ARCHIVED answer — stored text, stored
sources, byte-identical to what the judge saw on the day — and asks the judge
to score it again. Nothing is deployed and no answer is regenerated, so the
only thing that can move is the scoring.

**Judge drift is ruled out, in both directions.** Re-judging the 07-29 run's
answers today: **+0.583** (if anything the judge is now *looser*). Re-judging
the same day's answers with the same day's judge: **-0.066**. Neither shape
explains a -0.6 fall, and the cross-day sign is the wrong way round for a
"stricter judge" story.

**What the probe did establish is that the baseline's dispersion is fiction.**
Scoring identical text five times gives, per question:

| question | five scores on IDENTICAL text | sd |
|---|---|---|
| `div_openai_safety` | 4.33, 3.00, 3.67, 3.00, 3.67 | 0.56 |
| `mh_semiconductor_export` | 1.67, 1.67, 1.00, 2.33, 1.67 | 0.47 |
| `rec_eu_ai_act_timeline` | 3.67, 5.00, 5.00, 5.00, 4.33 | 0.60 |

≈**0.54 per question on text that did not change**, so ≈**0.27** on a
four-question battery mean. The committed baseline records **sd 0.042 at n=2**
— six times below the noise floor the judge produces on identical input. Two
draws happened to land 0.084 apart, and that coincidence was frozen into
`bench-baseline.json` as the reference dispersion.

**So the gate's noise bar is roughly a third of what it should be.** `bar =
max(1.7 · se, 0.15)`; with the recorded sds the computed `se` is 0.05, so every
run since has been judged against the **0.15 floor**. Propagating the *measured*
judge noise instead gives se ≈ 0.25 and a bar of **≈±0.42** for a single
2-vs-3-sample comparison. Of the five deltas, `-0.347` sits inside that and was
never evidence of anything.

### The drop is still real — it just cannot be seen in one run

Widening the bar does not make this go away. Pooled across all five runs
(≈18 samples) the candidate mean is **3.008 ± 0.06**, and even granting the
baseline the measured sd (SE 0.19 at n=2) the gap is ≈**3σ**. A ~0.6 fall
happened. What changes is the confidence any *single* run can carry: at this
judge's variance, one run of 3 samples cannot resolve anything smaller than
±0.4, which is larger than most single-PR effects this gate exists to catch.

### Revised next steps

1. **Raise the noise-bar floor from 0.15 to ≈0.40, or raise `SAMPLES`.** The
   floor was set against a fluke sd rather than against measured judge noise.
   Leaving it means REGRESSION on runs that carry no signal — which is what
   four of the last five verdicts were, at the confidence actually available.
   This changes gate verdicts, so it is an owner call, not a session's.
2. **Bisect by deployment** still attributes the real -0.6, and still costs
   ~12 minutes of old code in production per probe. Unchanged: owner decision.
3. **Do not re-record the baseline.** Unchanged, and now doubly so — a
   re-record at n=2 would freeze another coincidence. Whenever it happens it
   needs n≥8 to estimate a sd this judge can support.
4. Suspects unchanged (#330/#331 web-search rework, #324 arXiv as lead source);
   the drop is fully present in the earliest post-baseline run (07-29,
   `978ce70a`) and flat across the ~13 merges since, so whatever caused it sits
   at or before that commit — or outside the repo entirely.

---

## 2026-07-31, run 6 — the bar was honest this time, and it still regressed

- bench-gate 2026-07-31 (commit 09024cac vs baseline b2a5ab6): overall 2.729±0.63 vs 3.625±0.042 (delta -0.896, bar ±0.54) → REGRESSION. Pins: mistralai/Mistral-Small-3.2-24B-Instruct-2506 / judge mistralai/Mistral-Small-3.2-24B-Instruct-2506 / 240s / mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health.

Owed for PR #350 (the Deep Science agent), which touches `pipeline.js` and
`search-sources.js`. One sample dropped a question to a helper timeout, so the
battery mean rests on four.

**This is the first run where the noise bar was not the 0.15 floor.** The
candidate's own spread (sd 0.63 at n=4) pushed `1.7 · se` to **0.538**, above
the floor, so the verdict came from measured dispersion rather than from the
baseline's frozen 0.042. The delta cleared it anyway. Read that as the previous
entry's correction working as intended, not as a contradiction of it: widening
the bar was always about what a single run can *claim*, never about making the
drop disappear.

Six candidate runs now: **3.278, 2.667, 3.146, 2.867, 3.083, 2.729** — mean
**2.962**, spread 0.61, against a baseline of 3.625. Flat across ~17 merges.

Note the candidate sd this run (0.63) sits **above** the 0.27 that judge noise
alone predicts for a four-question battery mean, which says the answers vary
run-to-run as well as the scoring does. `mh_semiconductor_export` continues to
be the floor at 1.583 and has never once approached its recorded baseline of
2.833.

Nothing here implicates #350: the agent adds a source and a mode, `science` was
not exercised by any battery question, and the drop was fully present on
2026-07-29 before the branch existed.

Next steps unchanged from run 5, in order: raise the floor or raise `SAMPLES`
(owner call, it changes verdicts); bisect by deployment to attribute the real
−0.6 (owner call, ~12 min of old code in production per probe); do not
re-record the baseline, and when it is re-recorded it needs n≥8.

---

## 2026-08-01, run 7 — NEUTRAL at last, and the attribution's first real output

- bench-gate 2026-08-01 (commit f6555f2d vs baseline b2a5ab6): overall 3.278±0.416 vs 3.625±0.042 (delta -0.347, bar ±0.41) → NEUTRAL. Pins: mistralai/Mistral-Small-3.2-24B-Instruct-2506 / judge mistralai/Mistral-Small-3.2-24B-Instruct-2506 / 240s / mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health.

The first non-REGRESSION verdict since the drift opened on 07-29, and the first
run with #354's per-question and per-source attribution printing.

**Read the verdict carefully: the answers did not improve.** 3.278 merely TIES
the best previous run, and seven candidate runs now read 3.278, 2.667, 3.146,
2.867, 3.083, 2.729, 3.278 — mean **3.007**, flat. What changed is the BAR: the
run's own spread (sd 0.416 at n=3) pushed `1.7 · se` to 0.411, just past the
delta. That is the judge-noise correction of run 5 arriving on schedule — when
a run's dispersion is honest rather than inherited from a fluke baseline, a
−0.35 delta stops being a finding. Six earlier runs were judged against the
0.15 floor and four of them would have read NEUTRAL under an honest bar.

### Per-question: the instrument works

```
con_coffee_health        4.00 → 3.11   -0.89  <-- moved
rec_eu_ai_act_timeline   5.00 → 4.13   -0.87  <-- moved
mh_semiconductor_export  2.83 → 2.47   -0.37
div_openai_safety        3.11 → 3.27   +0.16
```

Two questions carry essentially the whole battery delta and one moved UP. That
is exactly what six rounds of hand-reconstruction were producing, now emitted
by the tool — which is the point of #354.

### Per-source: printed, and NOT yet evidence — read the control

```
europepmc  n=1  -0.89
scholar    n=1  -0.89
(none)     n=2  -0.62      <-- the control
arxiv      n=2  -0.37
```

**The control moved as much as the source buckets**, and it sits between them.
If the drift had entered through a retrieval leg — the leading hypothesis after
#354's zero-coverage finding — questions touching NO source should have held
flat while the source buckets fell. They did not separate.

That is a genuine negative result and it deserves recording as one, but it is
NOT yet a refutation: the buckets are n=1 and n=2, they OVERLAP by construction
(a question reaching two sources appears in both), and at this judge's ~0.54
per-question noise a one-question bucket carries no information at all. The
honest statement is that **the first attribution run gives no support to the
source hypothesis and cannot yet rule it out.** It needs the next baseline,
recorded at n≥8 with the three appended `europepmc` questions in it, before the
per-source column means anything.

### Still recurring

Two of five samples dropped a question to a helper timeout, as in runs 5 and 6.
The battery mean rests on three complete samples again, which is half of why
the sd is 0.416. Worth fixing before the next baseline is recorded — a baseline
built from three-sample runs inherits this.
