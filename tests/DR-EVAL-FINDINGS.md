# Ground-truth deep-research battery — findings

The durable record for `tests/dr-eval.mjs`. Run files under `data/dr-eval/`
are gitignored and ephemeral; this file is what survives.

**Admission rule, borrowed verbatim from `docs/RAG-EVAL-LEDGER.md`:** a number
reaches this file only if it came out of a saved run file, was decided by the
paired test rather than by eye, and states the question set it was measured
on. A rate quoted without its paired p-value is not a result — at n=60 the
independent binomial 95% CI is about ±12 points, which calls almost every real
effect noise.

Append, never rewrite. New dated section per run.

## What this instrument is for

The rubric bench (`tests/eval-bench.mjs`) judges answers **blind**: a strong
model reads the answer and scores it 1–5 on citation, coverage and
calibration. That measures whether an answer reads well. It cannot measure
whether the answer is **right**, because no right answer is written down. The
cost of that gap is in `EVAL-BENCH-FINDINGS.md`: the battery has sat ~0.6
below its baseline since 2026-07-29 and the ledger cannot say why.

This battery grades against published gold answers, and — because FRAMES ships
the Wikipedia pages each question was built from — separates a **retrieval**
loss from a **synthesis** loss. A score says something is wrong; a loss
breakdown says which stage to work on.

`hf-bench.mjs` is the nearest sibling and stays: it grades against SealQA and
DeepSearchQA, both chosen for contamination resistance. The two are
complementary, not redundant — see the contamination note below.

## The sets, and the contamination objection

These three were **rejected here on 2026-07-08** as contaminated
(`HF-BENCH-FINDINGS.md`), and that reading was correct: FRAMES (Sep 2024),
SimpleQA (Nov 2024) and BrowseComp (Apr 2025) all predate the catalogue's
training cutoffs, and FRAMES and SimpleQA sat in plaintext on the crawlable
web.

They are used anyway, because of one thing the 2026-07 vetting did not have:
**a no-search control arm on the same questions**. Contamination stops being a
reason to discard a set once it is a quantity you measure. The pipeline's
contribution is the difference between the arms, and the questions the
closed-book arm got wrong are a clean research set.

FRAMES is the flagship for a second reason: it publishes the same control
(≈0.40 with no retrieval, ≈0.66 with multi-step search planning, ≈0.73 with
oracle retrieval), so both of our numbers have an external reference rather
than only each other.

BrowseComp rows stay **XOR-obfuscated in the committed set** and are decrypted
at load. The obfuscation exists so the answers do not reach a training corpus;
a public repo committing them in clear would be the leak it guards against.

## 2026-08-05 — first baseline

Production (`https://mcp.deepresearch.se`), `deep_research` over MCP,
`time_budget_s: 120`, site default answer model, judge
`mistralai/Mistral-Medium-3.5-128B`, 4 workers, seed 20260805.
Commit `7807b888`.

| set | n | accuracy | acc \| attempted | F | not attempted | gold-source recall | median latency |
|---|---|---|---|---|---|---|---|
| FRAMES | 60 | **61.7%** (37) | 71.2% | 66.1% | 8 | 47.4% | 30.5 s |
| SimpleQA | 60 | **88.3%** (53) | 91.4% | 89.8% | 2 | 56.0% | 19.0 s |
| BrowseComp | 30 | **6.7%** (2) | 10.5% | 8.2% | 11 | — | 36.2 s |

95% Wilson intervals: FRAMES 49.0–72.9%, SimpleQA 77.8–94.2%, BrowseComp
1.8–21.3%.

External references, for calibration only — different models, different
budgets, not a like-for-like comparison: FRAMES multi-step-search baseline
≈0.66; BrowseComp GPT-4o-with-browsing ≈1.9% at release, OpenAI Deep Research
51.5%. A 6.7% BrowseComp on a 24B-class planning model at a 120 s budget is
where this class of system sits, and the set has enough headroom to stay
useful for a long time.

### The headline: research uplift over parametric memory

FRAMES, same 60 questions, `web_search: false`:

```
closed-book (search off)                     35.0%  (21/60)
with the pipeline                            61.7%  (37/60)
uplift                            +26.7 points, exact McNemar p = 0.00154
on the 39 questions it did NOT already know  51.3%  (20/39)
talked out of a known answer by retrieval        4
```

Both arms land close to the published FRAMES controls (0.40 / 0.66). The
pipeline is doing real research: it more than half-solves the questions the
model could not answer from memory, and the effect is far outside paired
noise.

The last line is the one to watch. **Four questions the model had right from
memory, retrieval talked it out of.** That is a genuine cost of searching, it
has never been visible before, and it is now a standing column.

### SimpleQA: the contamination assumption does not survive measurement

Same 60 questions, `web_search: false`:

```
closed-book (search off)                      6.7%  (4/60)
with the pipeline                            88.3%  (53/60)
uplift                            +81.7 points, exact McNemar p < 0.00001
on the 56 questions it did NOT already know  89.3%  (50/56)
talked out of a known answer by retrieval        1
```

SimpleQA was rejected here as contaminated, and on this catalogue it plainly
is not: the model answers **6.7%** of it from memory. That is the set doing
exactly what it was built to do — questions chosen to be hard to answer from
parametric memory and easy to verify — and it means the 88.3% is very nearly
all pipeline.

Worth stating plainly, because it cuts both ways: a set being *old* and
*public* is not the same as a set being *memorised*, and the only way to tell
is to run the control. The 2026-07 vetting reasoned from publication dates,
which was the responsible thing to do without a control arm; with one, FRAMES
turns out to be substantially memorised (35%) and SimpleQA barely at all.

**Caveat on the control arm.** `web_search: false` gates the Exa leg only —
the auxiliary sources (arXiv, Europe PMC, Scholar, the hosted dense corpora)
run regardless, by design (`searchPolicyFor`). For FRAMES this is negligible:
the control arm averaged 0.2 sources per answer. For BrowseComp, whose
questions reach the academic sources, the control is *not* closed-book and its
uplift number would understate the pipeline. The uplift figure above is
therefore quoted for FRAMES only.

### Loss breakdown — where the answers are lost

FRAMES, the 23 non-correct answers:

| stage | n | meaning |
|---|---|---|
| synthesis_miss | 14 | a gold page WAS retrieved and the answer is still wrong |
| abstained | 8 | declined to answer — not scored as fabrication |
| retrieval_miss | 1 | no gold page among the sources |
| no_sources | 0 | search returned nothing usable |

**Fourteen to one.** The loss is overwhelmingly in the reading, not the
finding. That is the single most actionable number in this file, and it is
what the 2026-08-05 pipeline commit was written against.

Read the labels honestly, though: `synthesis_miss` means **at least one** gold
page was retrieved, and the misses averaged 1–2 of 3–8 gold pages. So they are
better described as *incomplete chain retrieval plus a wrong resolution* than
as pure reading failures. A clean split would need a per-hop gold mapping
FRAMES does not publish.

What settles the direction is the next table — mean gold-source recall within
each outcome:

| outcome | n | mean gold-source recall |
|---|---|---|
| correct | 37 | **42.1%** |
| synthesis_miss | 14 | **50.2%** |
| retrieval_miss | 1 | 0.0% |
| abstained | 8 | 19.8% |

**The answers it got right retrieved FEWER of the gold pages than the ones it
got wrong.** Retrieval recall does not predict correctness on this set, which
means "retrieve more of the gold pages" is not the lever it looks like — and
it is the lever a recall number alone would have sent us to pull. The failure
is constraint satisfaction over material already in hand.

Two supporting readings. Accuracy by FRAMES reasoning type puts the weakest
bucket where that story predicts: **Multiple constraints 53% (21/40)**, against
Temporal 61%, Numerical 59%, Tabular 68%, Post-processing 70%. And the
abstentions sit at 19.8% gold recall — the pipeline declines to answer
precisely when it found little, which is the calibration behaviour you want and
is worth not breaking.

This is also why the digest fix is the right first move rather than a search
widening: it puts more of what was *already retrieved* in front of the model.

### Citations and contamination

| set | dangling markers | leak-tainted runs |
|---|---|---|
| FRAMES | 6 across 2 answers | 1 / 60 |
| SimpleQA | 16 across 2 answers | 1 / 60 |
| BrowseComp | 0 | 2 / 30 |

A dangling marker is a `[n]` in the prose with no matching entry in the source
list — a citation the reader cannot follow, and indistinguishable from a
fabricated one. Concentrated in a few answers rather than spread thin, which
suggests a failure mode (one answer going wrong badly) rather than a rate.

The leak counts are **corrected**. Reusing `hf-bench-lib.mjs`'s
`detectBenchmarkLeak` reported 9 of 30 BrowseComp runs tainted; 24 of the 27
flagged URLs were ordinary arXiv papers. Its host list includes `arxiv.org`,
which is right for a battery drawn from HuggingFace-hosted ML datasets and
wrong here, where arXiv is a registered research source with a hosted corpus
behind it. `benchmarkLeaks` in `tests/dr-eval-core.mjs` keeps the hosts these
three sets actually live on. **A detector calibrated for one question set does
not transfer to another**, and reusing one without re-checking its assumptions
reports the pipeline working as the pipeline cheating.

## 2026-08-05 — A/B: the four pipeline defects

Baseline commit `7807b888` (production version `24657b13`) against candidate
`1bedab2c` (version `a510d3f1`), deployed at 100% and verified live with a
probe that could only pass on the new code. Same seed, budget, judge model and
worker count on both arms.

The candidate carries: the digest packing + truncation marker, the gap loop's
saturation signal counting domain-capped overflow, the duplicate source-list
fix, deterministic citation reconciliation fed to the fact-checker, and
temperature 0 on the JSON planning phases.

| set | before | after | gained | lost | exact McNemar p | verdict |
|---|---|---|---|---|---|---|
| FRAMES | 61.7% | **70.0%** | 8 | 3 | 0.227 | not significant |
| SimpleQA | 88.3% | **91.7%** | 4 | 2 | 0.688 | not significant |
| pooled | — | — | 12 | 5 | 0.143 | not significant |

**Both arms moved up and neither result is significant.** +8.3 and +3.4 points
look like a clear win and are not one: at n=60 per set, 12 gained against 5
lost is the kind of split chance produces about one time in seven. Recorded as
DIRECTIONALLY POSITIVE, UNPROVEN.

The changes ship anyway, and the reason is worth being explicit about: they
are bug fixes with independent evidence, not tuning chosen because a score
moved. Nine of thirty-two retrieved sources never reaching synthesis, a gap
loop that reads a domain-capped wave as exhaustion, and an MCP answer carrying
two contradictory source lists are defects whether or not 120 questions can
resolve their effect. What this battery says honestly is that it cannot yet
resolve an effect this size — which is a fact about the instrument's power,
and the reason to grow the sets before the next round rather than to keep
quoting a delta.

Supporting movements, none of them a verdict on their own: latency median fell
30.5 → 27.7 s (FRAMES) and 19.0 → 18.4 s; the FRAMES loss breakdown moved
`synthesis_miss` 14 → 9 while `retrieval_miss` went 1 → 3; SimpleQA lost its
`no_sources` case.

Source-derived metrics are **not comparable across this A/B** — the
duplicate-list fix changes what `sources/answer` counts, from sources
retrieved (the appended registry) to sources the model itself listed. Accuracy
carries the verdict.

### The finding that outranks the A/B: fabricated source lists

Counting answers that cite `[n]` markers while listing no sources at all:

| run | such answers | graded correct |
|---|---|---|
| SimpleQA before | 2 | 2 |
| SimpleQA after | 5 | 5 |
| FRAMES before | 1 | 1 |
| FRAMES after | 1 | 1 |

Present in **both** arms, so it predates this work. The shape is consistent:
searches return nothing usable, the registry is empty, and the answer arrives
carrying a full numbered source list whose every URL is the literal string
`URL` — `- [1] ROS-Aeroprogress T-101 Grach - Wikipedia — URL` — with
`[1]…[10]` cited throughout the prose.

**Every one was graded correct.** The model knew the answer, had nothing to
cite, and dressed it in citation furniture. An ungrounded answer that presents
as sourced is the single failure this product cannot have, and it was
invisible until something reconciled markers against the registry.

`synthPrompt`'s standing instruction — "using ONLY the numbered sources
provided" — does not cover the case where there are none. `runSynthesis` now
says it outright when the digest is empty: no sources, so no `[n]` markers and
no Sources list, and say plainly that the answer is not backed by retrieved
sources. Shipped **unmeasured** — it arrived after the A/B arms had run, and
re-running both to measure a path that fires on roughly 3% of questions was
not the best use of the remaining budget. It is a prompt guard on a code path
that today produces a fabrication, and the next battery will price it.

## Standing method notes

- **Hold everything but one variable.** Same seed, same budget, same judge
  model, same worker count across a before/after. Latency is only comparable
  at equal `--workers`.
- **Verdicts by paired exact McNemar** (`--compare`), never by comparing two
  accuracies. The runs share their question set; the discordant pairs are the
  evidence.
- **Never deploy or push to `main` mid-battery.** A branch push ships to
  production in this account (`deploy` skill, measured 2026-07-30), so an A/B
  arm must run against a `wrangler versions upload` preview URL, which takes
  0% of traffic.
- **The judge is a model, not ground truth.** Keep it fixed across a
  comparison so its bias cancels. A delta is the signal; an absolute score is
  not a certified grade.
- The objective pre-grade resolves the easy majority without a judge call and
  **never asserts a miss** — an unmatched answer goes to the judge rather than
  being scored wrong by a normaliser.

## Open

- **The 14:1 synthesis-to-retrieval ratio wants a second measurement** at a
  larger budget tier. If it holds at 240 s, per-source excerpt width is the
  next lever, and `docs/DEEP-RESEARCH-TECHNIQUES.md` backlog #6 has the
  external evidence (faithfulness 0.446 → 0.581 at 400 → 1500 chars).
- **Gold-source recall is 47.4%** — the pipeline cites fewer than half the
  pages FRAMES says the question was built from, while still answering 61.7%
  correctly. Worth understanding: either the answer is reachable from other
  pages (likely for the easier hops), or recall is a ceiling that would lift
  accuracy if raised.
- **URL-exact dedup** (`addSources` keys on the raw URL) is unfixed and known:
  `https://pubmed…/31178118/` and the same page without the trailing slash are
  two numbered sources today. Deliberately left for its own change — it is the
  one candidate whose fix can move results in an unintended direction.
- **A Swedish arm.** Invariant 6 is about routing gates, but a bilingual
  product with no bilingual accuracy measurement is measuring half of itself.
  BrowseComp-ZH is the template: author natively, do not translate.
- **The revise rate** is now recorded (`chat.validate_verdict`) but not yet
  read back. It is the number that decides whether the section-scoped-revision
  backlog item is worth its risk.
- **The instrument is underpowered.** 60 questions per set resolves nothing
  smaller than roughly a 12-point swing. The A/B above moved 12 questions and
  could not call it. Before the next round, grow FRAMES and SimpleQA to 150
  each — the sets have 824 and 4 326 rows, the seed makes the existing 60 a
  subset of any larger draw, and the cost is linear. That is the cheapest
  available improvement to every future verdict.
- **`classifyLoss` is coarse.** `synthesis_miss` fires when ANY gold page was
  retrieved, and on FRAMES those cases averaged 1–2 of 3–8. A per-hop split
  would need a mapping FRAMES does not publish; a middle option is a
  `partial_retrieval` band at, say, under half the gold pages. Changing it
  breaks comparability with everything above, so it wants to happen once,
  deliberately, with the old labels recomputable via `--rescore`.
