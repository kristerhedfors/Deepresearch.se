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
