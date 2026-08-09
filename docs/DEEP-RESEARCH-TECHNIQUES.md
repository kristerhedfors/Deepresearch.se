# Deep research techniques — what the evidence supports

An evidence review of how deep-research systems reach high-quality research
conclusions, and what of it this pipeline should adopt. Written 2026-08-03 from
the outrospection feed's `deep-research` lens plus the primary sources it
points at, read directly rather than summarised from headlines.

Every claim below carries its source. Techniques are graded:

- **measured** — a controlled ablation or a benchmark with numbers
- **suggestive** — reported, but confounded, single-system, or vendor-run
- **speculative** — mechanism plausible, no measurement found
- **disproven** — tested and failed, or failed replication

Grades describe *the literature*, not this codebase. A measured technique can
still lose here; §6 records the cases where our own measurements already
disagree, and those win.

---

## 1. The finding that reframes everything else

**Scaffold choice moves accuracy about as much as fine-tuning does.** A
controlled comparison of ReAct vs planner-executor vs planner-actor-rater
across five models found scaffold choice alone moving GAIA accuracy by **up to
28 percentage points within a single model**, with stronger models *more*
scaffold-sensitive, not less ([arXiv:2606.08529](https://arxiv.org/abs/2606.08529)).

Set that against the RL-trained search agents whose headline numbers dominate
the field. Search-R1 reports +41% over RAG baselines but only ~+24% against the
strongest non-RL baseline ([arXiv:2503.09516](https://arxiv.org/abs/2503.09516)).
DeepResearcher reports +28.9 points over prompt engineering but **+7.2 over
RAG-based RL** ([arXiv:2504.03160](https://arxiv.org/abs/2504.03160)).
WebSailor-V2's **SFT-only checkpoint already beats many fully RL-trained open
agents** (24.4 BrowseComp-EN; final RL 35.3,
[arXiv:2509.13305](https://arxiv.org/abs/2509.13305)).

The reproducible part is the scaffold. For a project that cannot fine-tune and
runs every phase as a deterministic JSON-mode or streamed call, this is not a
consolation prize — it is the main lever, and it is fully available to us.

## 2. Context: the single biggest architectural idea

**IterResearch / periodic workspace reconstruction.** Deep research is
reformulated as an MDP whose state at round *t* is only three things: the
question, an **evolving report**, and the immediately preceding action with its
result ([arXiv:2511.07327](https://arxiv.org/abs/2511.07327), building on
[arXiv:2509.13309](https://arxiv.org/abs/2509.13309v1)). Each round the model
emits one structured object — think, rewritten report, next action — and
everything else is destroyed at the round boundary. Context is O(1) in rounds
instead of O(t).

Two documented failure modes it fixes: **cognitive workspace suffocation** (the
window fills with raw retrieved data, so reasoning space shrinks as depth
grows) and **irreversible noise contamination** (an early bad retrieval cannot
be revised and biases the whole run).

Three properties make this unusually portable here:

1. It is measured **as a pure prompting strategy on untrained frontier
   models**: +19.2pp on DeepSeek-V3.1 and +12.7pp on o3, BrowseComp
   ([arXiv:2511.07327](https://arxiv.org/abs/2511.07327)). This is exactly the
   training-free case we are in.
2. The "action" need not be a tool call. It can be a JSON-emitted search query
   that our own code executes — **invariant 1 holds unchanged**.
3. The report is regenerated inside the same structured output, so it costs no
   extra summariser call.

Honest limit: the headline SOTA figures (72.8 GAIA, 51.7 BrowseComp) come from
a 30B model given both rejection-sampling SFT and RL. Holding training data
constant, the paradigm alone contributes ≈+3.4pp HLE and +7.2pp BrowseComp.
Plan for the smaller number; treat the frontier-model prompting result as the
optimistic case.

**This also resolves an apparent contradiction in the literature.** Caesar
measures monotonic gains from more exploration (250 → 1000 iterations, 21.84 →
24.92, [arXiv:2604.20855](https://arxiv.org/html/2604.20855v3)), while a
citation audit measures Fact-Check accuracy *collapsing* from **79% → 17%** as
tool calls go 2 → 150 ([arXiv:2605.06635](https://arxiv.org/html/2605.06635v1)).
Both are right. Exploration breadth and synthesis context are **different
budgets**. Reconstruction is what lets the first grow while the second stays
bounded. Any change that grows exploration without compressing what reaches
synthesis buys the first curve and pays the second.

## 3. Research over the scientific literature

This is where the strongest human-comparison results live, and where our hosted
arXiv and PubMed indexes make us unusually well-placed. Current sizes and
coverage: `CORPORA.md`, or the published `/corpora/` page it describes — both
generated off the live indexes, because a count written into prose here would
be wrong by the next fill.

**PaperQA2's RCS is the largest single measured lever**
([arXiv:2409.13740](https://arxiv.org/abs/2409.13740)). After dense retrieval,
an LLM summarises **each retrieved chunk against the question** and assigns it a
**relevance score 1–10**; chunks are re-ranked by that score and only the top
5–15 *summaries* reach the answer. Removing RCS collapses accuracy (p<0.001) —
a larger effect than parser quality, top-k, or citation traversal. Results on
LitQA2 (248 expert questions whose answers sit in the paper *body*):

| | Precision | Accuracy |
|---|---|---|
| PaperQA2 | **85.2 ± 1.1%** | 66.0 ± 1.2% |
| PhD/postdoc humans | 64.3 ± 15.2% | 63.1 ± 16.0% |

Superhuman **precision** (p=0.0029); accuracy merely matches humans (p=0.63).
The precision is bought with a **21.9% refusal rate** — the abstention is part
of the result, not a footnote. Caveats worth carrying: MCQ format, n=248, built
by the same lab. Cost is real: **$1–3 per query**.

One ablation is a direct warning: RCS run by a weak summariser (GPT-3.5,
Llama-70B) *decreased* accuracy. There is a comprehension threshold below which
this technique inverts.

**OpenScholar** reaches comparable ends far more cheaply — ~**$0.003/query** vs
PaperQA2's $0.3–2.3 ([arXiv:2411.14199](https://arxiv.org/abs/2411.14199),
published in *Nature*, Feb 2026). Its ablations separate the levers cleanly:

- **Reranking dominates attribution**: removing it costs citation F1 −19.7 (8B)
  / −16.6 (GPT-4o), while correctness moves only −1.7 / −5.3.
- **Self-feedback is model-dependent**: −2.6 correctness on GPT-4o, ≈0 on the
  8B (citation F1 actually improves without it). Do not assume it helps.
- Attribution verification: −2.0/−2.1 correctness when removed.

**Citation traversal helps finding and can hurt answering.** PaperQA2 measured
DOI recall loss when removed (p=0.022) but a non-significant accuracy *decrease*
when present (p=0.069). Use it to widen the candidate pool, not to admit papers
into the answer context.

**Contradictions.** PaperQA2's ContraCrow detects 2.34 ± 1.99 contradictions per
biology paper, ~70% human-validated, AUC 0.842 (precision 88% at threshold ≥8).
But human–ContraCrow agreement is 60.4% against 75.5% human–human (p=0.015). By
contrast, citation-intent labels are weaker than advertised: an independent
audit of scite-style supporting/contrasting classification measured F-scores of
**0.0–0.58**, with the classes collapsing into "mentioning"
([audit](https://journals.indianapolis.iu.edu/index.php/hypothesis/article/download/26528/25101/54274)).
Detect contradictions from the text; do not buy them as metadata.

**Retractions are an open goal.** A JMIR 2026 content analysis of nine research
tools found the best (ChatGPT 5) fully correct on 8/15 retracted articles, while
**SciSpace, ScienceOS and Consensus produced zero fully correct response sets**;
retracted articles appeared in topic overviews with no warning at >40% error
rates ([PMC13134821](https://pmc.ncbi.nlm.nih.gov/articles/PMC13134821/)).
Nobody solves this. A retraction flag costs **zero LLM calls** — one metadata
lookup.

**The prevalence trap, which matters at our scale.** LLM screening on a
balanced n=800 set reached sensitivity 1.000 / precision 0.927, beating humans.
On the realistic imbalanced set (n=119,695) **precision collapsed to
0.004–0.096** against Cochrane reviewers' 0.235
([JAMIA 2025](https://academic.oup.com/jamia/article/32/5/893/8090299)). Any
screening or filtering we add must be evaluated at real corpus prevalence, not
on a balanced sample.

**Genuinely frontier results.** Two systems produced findings validated outside
the model: FutureHouse's Robin identified ripasudil for dry AMD with wet-lab
confirmation in 2.5 months
([announcement](https://www.futurehouse.org/research-announcements/demonstrating-end-to-end-scientific-discovery-with-robin-a-multi-agent-system));
Google's Co-Scientist (*Nature*, May 2026,
[PubMed 42156544](https://pubmed.ncbi.nlm.nih.gov/42156544/)) matched an
unpublished experimental result on cf-PICI phage-tail hijacking and produced
liver-fibrosis targets confirmed in human hepatic organoids. Both use
generate → critique → tournament → refine. Both have small N and no blinding.
This is the honest frontier: real, thin, and not yet a method you can copy with
confidence.

## 4. Verification

**Self-critique without evidence in context is disproven**, not merely weak.
Huang et al. (ICLR 2024, [arXiv:2310.01798](https://arxiv.org/abs/2310.01798))
find LLMs cannot judge the correctness of their own prior responses without
external feedback, and self-correction does not improve or actively degrades
results. Kamoi et al. (TACL 2024,
[arXiv:2406.01297](https://arxiv.org/abs/2406.01297)) audited the literature and
found no prior work demonstrating successful self-correction from prompted-LLM
feedback outside unusually suited tasks — the positive results came from unfair
evaluations. Adversarial re-asking is worse than neutral: "are you sure?" flips
correct answers ([arXiv:2311.08596](https://arxiv.org/pdf/2311.08596)).

What works is **entailment against the passage the claim already cites** — ALCE
([arXiv:2305.14627](https://arxiv.org/abs/2305.14627)), κ=0.698 with humans, and
better evidence selection alone moved ASQA citation recall 73.6 → 84.8 with no
change to the generator. Cost: no extra retrieval. **Chain-of-Verification**
([arXiv:2309.11495](https://arxiv.org/abs/2309.11495)) raises FActScore 55.9 →
71.4, but its gain comes from answering verification questions *in isolation*
(decorrelated from the draft), not from critique.

Baseline for scale: an audit of 14 deep-research agents found **23–61% of
citations lack factual support**; the best, Claude Opus 4.5, reached 76.8%
supported ([arXiv:2605.06635](https://arxiv.org/html/2605.06635v1)).

Two things to *not* build: verbalized per-claim confidence percentages, which
are systematically overconfident and cluster at 80–100%
([Xiong et al., ICLR 2024](https://github.com/MiaoXiong2320/llm-uncertainty)),
and LLM-generated GRADE certainty ratings, for which no measured support exists
([2026 review](https://www.sciencedirect.com/science/article/pii/S089543562600096X)).
The transferable part of evidence-based medicine is the free *metadata* layer —
study design, preprint vs peer-reviewed, venue — which we already hold.

## 5. Test-time compute

**Worth paying for:**

- **Parallel research trajectories synthesised at the report level**, n=3–8.
  BrowseComp-en 37.3 → 51.7, HLE 28.8 → 36.7 at n=8, flattening past 8
  ([arXiv:2509.13309](https://arxiv.org/html/2509.13309v1)). The gain tracks how
  bad single-pass accuracy is: GAIA moved only +2.9pp. Synthesise over the
  *reports*, never the trajectories.
- **Short per-wave contexts.** Context rot is measured across 18 models, with a
  200K model degrading by ~50K and a 20–30pp lost-in-the-middle penalty
  ([Chroma](https://research.trychroma.com/context-rot)); multi-turn work shows
  a 47-point early-to-late decay
  ([arXiv:2601.16649](https://arxiv.org/html/2601.16649)).
- **Heterogeneous models across parallel branches** — the one intervention that
  reliably rescues multi-agent setups
  ([arXiv:2502.08788](https://arxiv.org/abs/2502.08788)).

**Not worth paying for:**

- **Classic self-consistency / best-of-n on one question**: +0.4% for ~20×
  tokens on HotpotQA, +1.6% for ~15× on MATH-500, *declining* past 15 samples
  ([arXiv:2511.00751](https://arxiv.org/html/2511.00751)).
- **Multi-agent debate rounds**: at matched ~14.7K-token budgets competitive
  debate collapses to 24.89 F2 against 74–84 single-agent, and consensus debate
  lands below simple voting
  ([arXiv:2510.20963](https://arxiv.org/html/2510.20963v2)).
- **Fan-out on dependency-heavy questions** — Anthropic's own stated failure
  mode, at their reported ~15× token multiplier.
- **Max-effort reasoning as a default**: 2.3× cost for +3.6% relative on Deep
  Research Bench
  ([futuresearch.ai](https://futuresearch.ai/docs/case-studies/deep-research-bench-pareto-analysis/)).

**One overclaim to name.** Anthropic reports a multi-agent system beating
single-agent Opus 4 by 90.2% at ~15× tokens, on an internal eval with no
compute-matched baseline — while also reporting that **token usage alone
explains 80% of performance variance** on BrowseComp
([engineering post](https://www.anthropic.com/engineering/multi-agent-research-system)).
By their own decomposition, most of that gap is plausibly compute, not
architecture.

## 6. Where our own measurements overrule the literature

`docs/RAG-EVAL-LEDGER.md` holds paired-McNemar results on our own corpora.
These are stronger evidence *for us* than any external benchmark, and several
externally-recommended techniques are already settled negatives here:

| Externally recommended | Our verdict | Evidence |
|---|---|---|
| BM25 + dense hybrid with RRF (+1.8 EM externally, [2606.21553](https://arxiv.org/html/2606.21553)) | **rejected** — worse in both languages | ledger §4 |
| HyDE query expansion | **rejected** — EN r@1 72.1 → 58.6, plus an LLM call | ledger §4 |
| Retrieve a deeper candidate pool (50 → 100) | **rejected** — no measurable gain, 2–3× latency | ledger §4 |
| Raise the relevance floor to reject adjacent domains | **rejected** — empties genuine Swedish queries first | ledger, 2026-08-01 |
| Plain LLM query rewriting | not tested here; **measured null on SciFact (+0.3%, p=0.47) and harmful on FiQA (−9.0%)** externally ([2603.13301](https://arxiv.org/html/2603.13301)) | — |
| MMR / diversity-first selection | not tested here; externally **reduces answer relevancy** ([2604.12138](https://arxiv.org/html/2604.12138)) | — |

Do not re-propose these without new evidence.

The ledger also points at the one place retrieval work still pays: **essentially
all loss is the dense stage failing to put the document in the pool at all**
(never retrieved: 16.0% EN / 22.7% SV on arXiv). Reranking and the floor
together cannot buy back more than ~3 points. That makes **contextual
embeddings at ingest** — a 50–100-token context blurb prepended to each chunk
before embedding, reported at −35% failed retrievals alone and −49% with
contextual BM25 ([Anthropic](https://www.anthropic.com/engineering/contextual-retrieval))
— the only retrieval technique in this whole review that attacks our measured
bottleneck and is not already settled. It is vendor-run and unreplicated, and
the 512-token Berget embedding window means chunks must shrink to make room. It
is still the best retrieval bet available.

## 7. Gap analysis against the current pipeline

Facts from `src/pipeline.js`, `src/budget.js`, `src/sources.js`, `src/prompts.js`.

| Technique | Evidence | Status here |
|---|---|---|
| Iterative gap-driven re-search | measured | **present** — `runGapChecks`, up to `plan.gapIterations` rounds |
| Query decomposition | measured (small) | **present** but used as answer skeleton, *not* as retrieval queries |
| Reranking before synthesis | measured (citation F1 −19.7 without) | **present for arXiv/PubMed**, absent for web sources |
| Relevance floor / abstention | measured | **present** (`RERANK_FLOOR`), corpus paths only |
| Per-chunk summarization + relevance score (RCS) | **measured, largest single lever** | **code exists, disabled** (`maybeDigest`, `DEEP_TIER_FEATURES_ENABLED = false`) |
| Claim-level entailment vs cited source | measured | **code exists, disabled** (`runClaimValidation`) |
| Full text rather than snippets | measured (faithfulness 0.446 → 0.581, 400 → 1500 chars/source) | **absent** — only Exa highlights (3/source) reach synthesis; corpus paths are abstract-only |
| Workspace reconstruction / report-as-state | measured, training-free | **absent** |
| Parallel trajectories + report-level synthesis | measured | **absent in the research flow** (orchestrator mode has the machinery) |
| Strategy-gap feedback rather than content-gap | measured (+15.4 vs +2.4) | **absent** — `gapPrompt` asks what is missing from the text |
| Section-scoped revision | measured (full rewrite loses 46–73% of citations) | **absent — and actively inverted**: validation emits a whole `revised_answer` |
| Contradiction detection | suggestive | **shallow** — `gap.conflicts` strings, no cross-source claim alignment |
| Retraction / preprint flags | measured gap in every competitor | **absent** |
| Every collected source reaching synthesis (no arrival-order starvation) | local defect, feedback #61 | **present** since 2026-08-05 — the digest budget is shared per source and both source caps widen together |
| Absence claims checked against the retrieved list, and against what was searched | local defect, feedback #61 | **present** since 2026-08-05 — `searchLedgerSection` (over the queries actually issued, after a first cut that listed the planned ones) + `synthPrompt`'s absence clause |
| Evidence grading from metadata | speculative | **absent** |

### The disabled-features question

Three of the highest-value techniques already exist in our code and are off,
behind `DEEP_TIER_FEATURES_ENABLED = false` (`src/budget.js:417`), because a
de-noised bench measured them as a **regression**: batch overall 2.65 → 2.43,
with no real multi-hop gain. That verdict stands and must not be waved away.

But the bench note itself records *why*: **"multi-hop needs sub-question
decomposition, not more source material."** The disabled notes digest **added**
material on top of the existing digest. RCS as measured does the opposite — it
**scores, ranks, and replaces**, so the answer sees *fewer* and better-selected
passages. The external evidence agrees with our bench on the mechanism that
failed: adding context degrades faithfulness (79% → 17% at 150 tool calls), and
adding 20 irrelevant documents collapsed one model from 66% → 26%
([arXiv:2606.04127](https://arxiv.org/html/2606.04127)).

So this is not "re-enable the deep tier". It is a different mechanism that our
own bench arguably never tested. Any retry must be an A/B where **RCS replaces
the raw digest** rather than supplementing it, judged on faithfulness and
specificity rather than overall score alone.

### Three defects, and two things that only look like defects

**The first defect, still open: validation emits a whole `revised_answer`.**
`src/prompts.js:621` asks for "the complete corrected answer";
`src/pipeline.js:1939` discards the draft and re-emits it.
Full-rewrite revision is measured to retain only
**27–54% of citations** ([arXiv:2606.09748](https://arxiv.org/html/2606.09748)),
which makes our repair path the documented failure mode: the phase that exists
to protect attribution is the phase most likely to destroy it. Section-scoped
patching is a pure JSON-mode change and does not touch invariant 1.

**The second defect, fixed 2026-08-05: digest starvation.** The digest is
a character budget filled in arrival order, and `src/pipeline.js`'s aux capacity
reserve used to widen `plan.maxSources` without widening `plan.digestCap` —
admitting more sources without paying for their prose, which does not add them
to what synthesis reads but pushes the highest-numbered ones out of an unchanged
window. Those are the sources the later gap rounds were run to find. Measured in
production (feedback #61, `chat_logs` #1656): thirteen ~1,300-char literature
blocks arrived first, consumed an 18,000-char window, and the report was written
from roughly the first 15 of 35 sources — while a university page, two press
features and an interview sat unread at `[17]` through `[26]`. Both caps now
move together, and the budget is shared per source rather than raced for
(`docs/ARCHITECTURE.md` §4.3d). The class generalises past this one reserve:
wherever a budget is filled first-come, widening one cap and not its partner
degrades silently, in the one direction nothing measures.

That fix then had to be bounded. Pairing the caps left the reserve free to grow
without limit — four aux sources reserving eight slots each take a 24,000-char
digest to 65,600 — and a synthesis context overflow is not failover-eligible,
so the overrun does not cost a few tail sources, it costs the whole answer.
`DIGEST_CAP_CEILING` (36,000) is where it stops. The pattern repeats the one
above with the sign flipped: a cap raised in the safe direction and a cap raised
in the fatal one look identical in the code.

**The third, fixed the same day: absence written as a property of the world.**
The same report marked eleven claims `self-reported only` or `unverifiable` and
stated that no independent press coverage, no university page and no
third-party source existed — four of which it had already collected. An absence
claim is a claim about the numbered list, and nothing checked it against that
list. The answer also had no way to know which angles had been searched, and
sixteen had run. Synthesis is now handed the search ledger, and `synthPrompt`
requires an absence claim to be checked against the numbered sources and to
name the angles that came back empty. **Deliberately not more retrieval:** §6's
de-noised bench found extra pre-synthesis material net-negative (2.65 → 2.43,
by context dilution) and the ground-truth battery puts the loss at 14:1
synthesis-over-retrieval, so the fix costs no search, no model call and no new
source.

The ledger's own first cut then committed the error it was built to stop. It
read `state.ranQueries` — the angles the planner writes before a wave picks its
legs — and told the model "this is the whole search, not a sample". With the web
knob off, or an aux source leading and standing the web leg down, those angles
were never issued, so the block asked the answer to report which of them came
back empty when nothing had been asked. It also cut silently at 24 while the
planner allows 34 searches. Corrected the same day: a separate
`state.issuedQueries` recorded at the two real dispatch points, a cap of 40, and
"showing N of M issued" in place of the exhaustiveness claim
(`docs/ARCHITECTURE.md` §4.3e). The general rule is worth keeping: **a prompt
block that asserts a property of the evidence has to be able to satisfy the
assertion** — the same claim in an answer is what feedback #61 reported.
**Se/cure** had it right and **Se/rver** did not; the client-side ledger is
built from completed harvest entries, so the correct implementation was already
in the repo, in the other tier.

**Not a defect: `verifyClaim` returning `supported` when the check fails**
(`src/pipeline.js:2028`). The comment states the intent — a failed check must
never *fabricate* an "unsupported" verdict — and in effect the claim is simply
never added to `issues` (line 1979), so it is unflagged rather than
asserted-good. The real cost is narrower than it first appears: "verified
supported" and "not checked" are the same value, so the moment we compute a
faithfulness *metric* from these verdicts it will be inflated by every failed
check. Worth a distinct third state before it feeds a rubric (§9), not before.

**Not a defect: `gapIterations` reaching 8.** The external evidence does say two
steps capture ~95% of the agentic-retrieval gain and step 3+ is indistinguishable
from step 5 (±0.0 EM, [arXiv:2606.21553](https://arxiv.org/html/2606.21553)).
But `src/budget.js:198-205` records the ceiling as a deliberate response to a
reported "gave up too early", and it is a *striving* ceiling: time, the
coverage-complete judgment, and the saturation shortcut all bind before the
round count does, and `applyComplexityToPlan` clamps simple questions anyway.
An external multi-hop-QA benchmark is not evidence about our users' questions.
The honest action is to **measure** whether rounds past the second contribute
sources that survive into citations — not to lower the ceiling on the strength
of someone else's benchmark.

## 8. Ranked backlog

Ordered by measured evidence ÷ cost, respecting §6.

1. **Section-scoped revision instead of whole-answer rewrite.** measured; ~0
   extra cost. Fixes the one live defect. Ranked on an external paper alone —
   the revise RATE here was not merely unmeasured but unrecoverable, since the
   rewrite replaces the draft before anything is persisted. As of 2026-08-05 it
   is recorded (`chat.validate_verdict`, with draft/revised char counts as a
   churn proxy), so this can be ranked on our own evidence before it is built.
2. **Retraction + preprint flags at retrieval time.** measured competitor gap;
   zero LLM calls.
3. **Strategy-gap prompt in the gap check** (what research strategy was missed:
   breadth vs depth) rather than what is missing from the text. measured, +15.4
   vs +2.4; zero extra calls — a prompt change.
4. ~~**Instrument the gap loop**~~ — HALF DONE 2026-08-05. Each round now logs
   `chat.gap_round` with `gained` / `admitted` / `capped` / `sources`, so what a
   round contributes is visible. The other half — whether those sources survive
   into citations — needs a round stamp on each registry entry and is still
   open. The same change fixed a defect the instrumentation exposed: the loop's
   saturation exit read `sources.length`, which the domain cap holds flat, so a
   wave whose every find was capped read as exhaustion and the run stopped
   researching while it was still finding new pages.
5. **Split "verified supported" from "not checked"** in `verifyClaim` before any
   faithfulness metric is computed from it. Zero cost; prevents a silently
   inflated number later.
6. **Raise per-source excerpt length toward ~1500 chars** — measured
   (faithfulness +0.13); modest token cost. After the fix below it has to be
   argued as a change to the per-source SHARE rather than to a per-source
   constant, since a longer excerpt is a larger claim on a shared budget.
   ~~The second half, *stop silently dropping sources past
   `digestCap`*~~ — DONE (2026-08-05), in two steps. First the digest stopped
   at an oversized block; it was made to skip it and state how many it omitted,
   measured at ~9 of 32 sources invisible to synthesis, validation and the gap
   check at the common tier. That fixed one source hiding the rest, not the
   case where the SUM starves the tail, which feedback #61 then hit in
   production: thirteen verbose literature blocks each fit on their own and
   together consumed the whole window. So the budget is now shared — a max-min
   fair share per source, with an over-share block's excerpt clipped instead of
   the source disappearing — and the aux capacity reserve widens `digestCap`
   alongside `maxSources`, up to `DIGEST_CAP_CEILING` (36,000 chars) — the
   other bound this item now has to be argued inside. The ground-truth battery
   independently read 14 synthesis misses to 1 retrieval miss on FRAMES the same
   day the first half landed, which is the same finding from the other end.
7. **RCS as a replacement digest, behind an A/B.** measured, largest single
   lever, but contradicts a local bench — so it ships as an experiment with a
   pre-registered metric, not as a default.
8. **Contextual embeddings at ingest for arXiv/PubMed.** the only retrieval
   idea that targets our measured bottleneck; offline cost, zero query-time
   cost; unreplicated.
9. **IterResearch round loop with report-as-state.** the largest architectural
   idea, training-free and invariant-1-compatible; also the largest change.
10. **Parallel trajectories for hard queries only**, gated on a triage
    difficulty score, synthesising over reports.

Deliberately excluded: multi-agent debate, self-consistency, HyDE, BM25 fusion,
MMR, LLM listwise reranking, verbalized confidence, LLM-generated GRADE
ratings. Each is either a settled negative here or measured as not worth its
cost.

## 9. An internal rubric

If we adopt a quality rubric, the benchmarks converge on scoring **binary per
criterion** — ResearchRubrics reports 0.72–0.76 macro-F1 human agreement for
binary grading against 0.53–0.57 for ternary partial credit
([arXiv:2511.07685](https://arxiv.org/abs/2511.07685)). Partial credit adds
noise, not signal.

Six dimensions, each borrowed from a benchmark that measured it:

1. **Explicit requirement compliance** — ResearchRubrics
2. **Implicit requirement compliance** — ResearchRubrics; 45–50% of all failures
   live here, and it is exactly what our gap-check phase should move
3. **Coverage** and 4. **Specificity**, scored *separately* — MiroEval, where
   specificity trails coverage by 10–14 points universally
   ([arXiv:2603.28407](https://arxiv.org/html/2603.28407))
5. **Cited-claim faithfulness**, judged against fetched source text rather than
   the snippet, logging citation count so the volume/precision trade stays
   visible (Gemini 111 citations at 81% vs Perplexity 31 at 90%)
6. **Process traceability** — process score correlates with outcome at r=0.88,
   and we already emit the SSE trace

Pin one judge model and one prompt version in the ledger: the *same* agent
outputs score 3%–18% unsupported depending on which verifier judges them, with
negative-specific agreement of only 0.27–0.30
([arXiv:2607.20527](https://arxiv.org/html/2607.20527)). Only within-judge
deltas are meaningful.

## 10. What this says about the instrument

The `deep-research` lens had accumulated eighteen items — agent leaderboards,
comparison tables, benchmark releases — and **not one** about research over the
peer-reviewed literature. PaperQA2 and OpenScholar, the two systems with
published human-expert comparisons and the ones most relevant to the arXiv and
PubMed indexes this project hosts, had never appeared.

That was the instrument, not the world. Every lens held exactly three queries
against a three-query per-refresh cap, so `refreshQueries`' offset rotation was
a permutation of one fixed set and each lens could only ever see what its
original three phrasings surfaced. The live feed shows it plainly: all eighteen
`deep-research` items share one `first_seen` date, 2026-07-26. The lens caught
what those three queries could reach on its first pass, and every refresh since
has re-issued them for nothing.

Both are now fixed: a `research-corpus` lens, wider query sets on all eight
lenses so the rotation genuinely rotates, and a test that fails if any lens
lets its aperture close again. See `docs/OUTROSPECTION.md`.

The general lesson is worth keeping. A feed that never surprises you is not
evidence that nothing is happening — check the aperture before believing the
absence.
