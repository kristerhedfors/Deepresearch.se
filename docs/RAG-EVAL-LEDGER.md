# The hosted-RAG evaluation ledger

Append-only. One entry per measured experiment against a hosted retrieval
index, newest first. Every entry names the instrument, the gold set, the
decision rule and the verdict — including the experiments that **lost**, which
are the entries that stop the same idea being re-proposed a month later.

The instrument is `scripts/rag-eval.mjs`, the procedure is the
**rag-hillclimb** skill, and the corpora are `docs/ARXIV-RAG.md` (arXiv) and
`docs/PUBMED-RAG.md` (PubMed).

> **Rule for adding an entry.** A number reaches this file only if it came out
> of a saved run file, was decided by the paired test rather than by eye, and
> states the gold set it was measured on. A rate quoted without its paired
> p-value is not a result; at n=150 the independent binomial CI is ±6.7 points
> and calls almost every real effect noise.

---

## 2026-08-10 — longevity: two new needle sets, and pool churn turns out to measure the wrong thing

The largest PubMed fill since the corpus was built — **56,688 vectors**,
1,731,517 → 1,787,309 — plus a small arXiv leg of **625** (823,097 →
823,722), because the whole longevity literature on arXiv is 996 papers.
Read back at run time the PubMed index reported **1,788,205**; Vectorize is
eventually consistent and the extra ~900 is the tail of the same upsert, not a
second fill.

Two things were measured: what the new domain retrieves like (no before exists
— the papers were not in the index), and what the fill did to a domain it did
not target.

### The instrument

Two hand-written needle sets, committed, PAIRED shape (`{gold, en, sv}`, one
entry per paper, so no paper is double-weighted):

| set | needles | distinct papers | sampled from |
|---|---|---|---|
| `tests/needles/longevity-pubmed.json` | 66 | 66 | seeded random draw from the 56,688 harvested records, excluding the 176 papers the eval set cites |
| `tests/needles/longevity-arxiv.json` | 41 | 41 | seeded random draw from the 996-paper arXiv longevity set |

Every gold was checked with `get_by_ids` before the queries were written —
180/180 and 70/70 of the sampled candidates were present — and `run` printed
**no unanswerable-needle warning** for either set. Papers whose abstract the
index cannot hold were excluded up front by an abstract-length filter, which is
what keeps the ageing landmarks that carry no abstract at all (Hamilton 1966,
Harman 1956, Hayflick & Moorhead 1961, Oeppen & Vaupel 2002) out of a set where
they would have scored as permanent misses.

The Swedish arm is deliberately **vernacular** (åldrande, utslitna celler,
rundmask, jäst, bananfluga) rather than translated scientific Swedish — the
register the 2026-08-08 entry showed retrieval is worst at.

### Longevity, post-fill baseline

Runs `data/eval/pubmed-longevity-postfill.json` and
`data/eval/arxiv-longevity-postfill.json`, pool 50, floor 0.01, 4 workers.

| corpus | lang | n | inPool | r@1 | r@5 | r@10 | MRR | ms med | ms p95 |
|---|---|---|---|---|---|---|---|---|---|
| PubMed | EN | 66 | 77.3 | 66.7 | 72.7 | **75.8** | 69.8 | 1495 | 3230 |
| PubMed | SV | 66 | 60.6 | 48.5 | 60.6 | **60.6** | 52.4 | 1527 | 2735 |
| arXiv | EN | 41 | 90.2 | 87.8 | 90.2 | **90.2** | 89.0 | 1355 | 2629 |
| arXiv | SV | 41 | 70.7 | 68.3 | 70.7 | **70.7** | 68.9 | 1352 | 2041 |

Loss breakdown — the stage that is the ceiling:

| corpus | lang | in top10 | never retrieved | rerank demoted | floored out |
|---|---|---|---|---|---|
| PubMed | EN | 75.8 | **22.7** | 1.5 | 0 |
| PubMed | SV | 60.6 | **39.4** | 0 | 0 |
| arXiv | EN | 90.2 | **9.8** | 0 | 0 |
| arXiv | SV | 70.7 | **29.3** | 0 | 0 |

Essentially all loss is **dense**. Reranking costs 1.5 points once and nothing
elsewhere; the floor costs nothing in any arm. An idea aimed at the reranker or
the floor is bounded at about one point here before it is tried.

The 14.4-point PubMed/arXiv gap on English reproduces the 2026-08-09 (later)
finding exactly: longevity biology is a crowded neighbourhood inside PubMed
(56,688 papers matched the enumeration) and a nearly empty one inside arXiv
(996 papers, `senescence` in 81 abstracts archive-wide), and difficulty tracks
vocabulary distinctiveness within the corpus rather than subject matter.

### The Swedish register penalty is NOT corpus-specific — that open question closes

`parity`, paired EN vs SV on the same documents:

| corpus | stage | metric | paired | SV loses | SV wins | p |
|---|---|---|---|---|---|---|
| PubMed | dense | inPool | 66 | 15 | 4 | **0.01921** |
| PubMed | final | r@1 | 66 | 17 | 5 | **0.01690** |
| PubMed | final | r@10 | 66 | 15 | 5 | **0.04139** |
| arXiv | dense | inPool | 41 | 8 | 0 | **0.00781** |
| arXiv | final | r@1 | 41 | 8 | 0 | **0.00781** |
| arXiv | final | r@10 | 41 | 8 | 0 | **0.00781** |

The 2026-08-09 (later) entry left this open: vernacular Swedish beat English on
AI-security arXiv needles (89.5 vs 84.8, n=19), and the entry said not to read
that as a refutation because the paired arXiv EN/SV set to settle it did not
exist. It exists now. **arXiv vernacular Swedish loses 8 needles and wins 0,
p=0.0078** — a significant deficit on the corpus where the earlier arm
suggested there was none. The cognate-vocabulary reading of the AI-security
result (promptinjektion, autentisering, kryptering) survives; the
corpus-specific reading does not.

The deficit is **entirely at the dense stage** in both corpora — `inPool` is as
significant as r@10, and `rerank demoted` is 0 in three of the four arms. That
locates it in the embedding, not in the cross-encoder, which is a different
place than the 2026-08-08 entry's score-scale collapse and worth keeping
separate.

### The control arm: `adna-pubmed`, and the standing rule

Ancient DNA is the same corpus and a different neighbourhood. Re-ran the
committed set (156 queries over 150 distinct papers, 126 EN / 30 SV) and paired
it against `data/eval/pubmed-adna-questions.json` (1,694,272 vectors,
2026-08-09T09:17Z). Post-run:
`data/eval/pubmed-adna-control-postlongevity.json`.

**The interval spans three fills, not one:** +93,933 vectors = AI consciousness
(16,196) + AI security (20,907) + longevity (56,688 as pushed). No adna run
exists at the intermediate 1,731,517 state, so this is the closest baseline
available and the attribution below is what separates them.

| arm | metric | before | after | paired | lost | gained | p |
|---|---|---|---|---|---|---|---|
| EN | r@1 | 75.4 | 76.2 | 121 | 7 | 8 | **1.0000** |
| EN | r@10 | 88.9 | 90.5 | 121 | 5 | 7 | **0.7744** |
| SV | r@1 | 56.7 | 60.0 | 30 | 1 | 2 | **1.0000** |
| SV | r@10 | 70.0 | 73.3 | 30 | 1 | 2 | **1.0000** |

`inPool` EN 89.7 → 92.1, SV 76.7 → 83.3; MRR 80.0 → 81.1 and 60.8 → 65.0.
Latency median 1482 → 1567, p95 2634 → 2739, paired sign slower on 80 / faster
on 73, **p=0.6278**. Every metric moved slightly UP and nothing is significant.

### Pool churn was 49.4% — and it is not the pressure signal

The 2026-08-09 (latest) entry proposed measuring **pool churn and gold-rank
displacement instead of r@10** when an ingest is small relative to the corpus.
Applied here it produces a number that looks alarming and means almost nothing:

| | value |
|---|---|
| dense pool slots turned over | **3,852 / 7,800 = 49.4%** (EN 47.8%, SV 55.9%) |
| entrants from the longevity enumeration | 127 / 3,852 = **3.3%** |
| entrants from aicon / aisec | 13 (0.3%) / 13 (0.3%) |
| entrants from ANY of the three fills | 153 / 3,852 = **4.0%** |
| post-fill pool slots held by any of the three | 183 / 7,800 = **2.3%** |
| the three fills' share of the post-fill index | **5.25%** |
| gold dense rank worse / better / unchanged | **32 / 32 / 92**, exact binomial **p=1.00000** |

**A noise floor was measured rather than assumed.** The same 156 queries were
run a second time against the same index state
(`data/eval/pubmed-adna-control-repeat.json`, identical vector count, every
reported rate identical to the decimal): churn **3 / 7,800 = 0.04%**, rank
displacement **0 worse / 0 better / 156 unchanged**. So the search is
deterministic at a fixed index state and the 49.4% is real — but it is not
competition.

Half the candidate pool was replaced by **documents that were already in the
index before the fill**. Adding ~94k vectors perturbs the approximate-nearest-
neighbour graph globally, and the pool re-shuffles among old neighbours. The
new documents did not invade: they hold 2.3% of the post-fill pool slots
against a 5.25% share of the index, i.e. **below chance**, which is what a
fill landing in a different neighbourhood should look like.

> **Amendment.** Pool churn measures ANN-graph perturbation, which scales with
> how much was added *anywhere*, not with where it landed. It is not a measure
> of neighbourhood pressure and must not be quoted as one. The pressure signal
> is **entrant PROVENANCE** — what share of the new pool entrants come from the
> fill, against the fill's share of the index — together with gold dense-rank
> displacement. Read against chance, not against zero.
>
> This qualifies the 2026-08-09 (latest) entry's 9.6%-vs-3.1% churn contrast
> rather than overturning it: that entry's conclusion also rested on entrant
> provenance (99.1% of entrants pre-2310, the band the ingest filled) and on
> 6/0 rank displacement at p=0.03125, both of which are provenance-style
> evidence. The churn percentages beside them are not comparable across
> corpora or across ingest sizes, and this corpus shows why: a churn figure
> five times larger than the "target neighbourhood" arXiv figure came out of a
> fill that demonstrably went somewhere else.

**The standing rule survives, as a recall prediction and as a pressure
prediction.** A different-neighbourhood fill of 56,688 records — the largest
this corpus has had — produced no recall change (all four p ≥ 0.7744), no
gold-rank displacement (32/32, p=1.00000), and below-chance occupancy of the
ancient-DNA candidate pools. Nothing needs amending about neighbourhood; the
instrument for observing it does.

### Open

1. PubMed English `never retrieved` is 22.7% on this domain against 7.9% on
   ancient DNA, on the same corpus and the same day. Both sets are hand-written
   contribution paraphrases; the difference is neighbourhood density. That is
   the largest single loss bucket anywhere in this ledger and it is a dense-
   stage problem.
2. The Swedish dense deficit now reproduces on both corpora with vernacular
   queries and is absent from generated (near-translation) sets. A `svsci` arm
   on these two sets would separate register from language in the new domain
   the way `scripts/pubmed-palaeogenomics-goldset.json` does for ancient DNA;
   it is not built.
3. The adna control spans three fills. A run at the intermediate 1,731,517
   state would have cost minutes on 2026-08-09 and cannot be recovered now —
   **run the control BEFORE the next ingest, not only after it.**

---

## 2026-08-09 (latest) — the neighbourhood rule predicts POOL PRESSURE, not recall

The third arXiv ingest, and the first one deliberately shaped to make the
standing rule fail: **24,212 AI-security papers from the named-list backlog
fill (plus ~60 previously floor-dropped), landing directly in the AI-security
needles' own neighbourhood.** arXiv 798,774 → **823,097** vectors. 24,086 of
the additions are pre-2310, i.e. below the swept window.

The rule as the 2026-08-09 (later) entry left it — *competition degrades
retrieval when the added documents land in the SAME NEIGHBOURHOOD as the gold;
volume alone does not* — predicts a measurable degradation here. It did not
arrive, and the amendment is the entry.

### Instrument and pairing

`data/aisec/needles-arxiv.json`, the same 111 needles (92 EN / 19 SV) as both
prior arms, so only the distractor count varies. **0 of 111 needles
unanswerable** — the membership guard printed nothing.

> **Caveat found after this entry was written, and it qualifies the n.** The
> needle sets are now committed under `tests/needles/` (they lived only in
> gitignored `data/` before — open item 4 below), and pinning them turned up
> that three of them ask more than one question about the same paper. This set
> is **111 needles over 109 distinct papers**; the AI-consciousness control arm
> is worse, **33 needles over 27 papers**, with `2411.00986` asked three times,
> twice in nearly the same words. A paper asked twice counts twice in a recall
> rate, so the independent evidence is slightly thinner than each n suggests.
> Small enough here not to disturb a verdict that rests on 2 discordant pairs,
> and left UNCHANGED rather than deduped: editing a set breaks its pairing with
> the runs above it. The counts are pinned in `tests/needles.test.js` so the
> overstatement cannot grow silently, and the next generation of aicon-arxiv
> should drop the paraphrases — as a new set with a new baseline.

Paired against **`data/eval/arxiv-aisec-ax-c1.json`** (ran 14:01Z, 798,774
vectors). That is the most recent *pre-ingest* state of the three saved runs:
`-ax` is 786,094 and `-ax-after` is 794,854, both further back and separated
from this ingest by an extra arm each. Post-run:
`data/eval/arxiv-post-backlog-ingest.json`.

### The verdict: no significant recall change, for the third ingest running

| arm | metric | before | after | paired | lost | gained | p |
|---|---|---|---|---|---|---|---|
| EN | r@1 | 76.1 | 73.9 | 91 | 2 | 0 | **0.5000** |
| EN | r@10 | 84.8 | 82.6 | 91 | 2 | 0 | **0.5000** |
| SV | r@1 | 84.2 | 84.2 | 19 | 0 | 0 | 1.0000 |
| SV | r@10 | 89.5 | 89.5 | 19 | 0 | 0 | 1.0000 |

EN r@5 81.5 → 79.3, MRR 78.9 → 76.7. **The prediction failed.** A 2.2-point
r@10 drop resting on two discordant needles is exactly the effect size the
ledger's own rule says not to report as a result.

### Loss breakdown — the whole move is in the dense stage

| run | lang | in top10 | never retrieved | rerank demoted | floored out |
|---|---|---|---|---|---|
| aisec-ax-c1 | EN | 84.8 | 15.2 | 0 | 0 |
| post-backlog-ingest | EN | 82.6 | **17.4** | 0 | 0 |
| aisec-ax-c1 | SV | 89.5 | 10.5 | 0 | 0 |
| post-backlog-ingest | SV | 89.5 | 10.5 | 0 | 0 |

Both golds fell out of the **candidate pool**, not out of the reranking. Unlike
the ancient-DNA regression, `rerank demoted` stayed at 0 in both arms — so this
is not the same failure mode wearing the same name.

### Latency: NOT significant, and it went the other way

| run | median | p95 | embed | query | rerank |
|---|---|---|---|---|---|
| aisec-ax-c1 | 1495 | 2269 | 383 | 412 | 787 |
| post-backlog-ingest | 1384 | 2648 | 360 | 326 | 855 |

Paired sign: slower on 52, faster on 58, **p=0.6338**. The previous entry's
p=0.0346 latency cost **did not reproduce** on a larger ingest into the same
neighbourhood. Rerank time did rise (787 → 855) while query time fell
(412 → 326), so treat the one significant latency result as unreplicated rather
than as an established trend.

### What DID move, and it is measurable

Recall is a coarse instrument here. The candidate pool underneath it moved, and
that is visible in the saved runs:

| | aisec needles (target neighbourhood) | aicon needles (control) |
|---|---|---|
| paired needles | 111 | 33 |
| dense pool slots turned over | **531 / 5,550 = 9.6%** | 51 / 1,650 = 3.1% |
| of those entrants, pre-2310 | **99.1%** | 88.2% |
| gold's dense rank worse / better | **6 / 0** | 1 / 0 |

Gold dense-rank displacement, exact binomial over the 6 discordant needles:
**p=0.03125** (87 unchanged). The AI-consciousness control moved 3.1% of its
pool *despite* its baseline being 786,094 — i.e. spanning **three** ingests and
+37k vectors against the target arm's one and +24.3k. The added documents went
where they were aimed.

### The additions are pre-2310, and they hurt the pre-2310 golds

Splitting the same 111 needles by the age of their gold:

| gold age band | needles | pool churn | gold rank worse / better |
|---|---|---|---|
| pre-2310 (the band the ingest filled) | 56 | **13.0%** | **5 / 0** |
| in-window (2310 onward) | 55 | 6.0% | 1 / 0 |

Both r@10 losses are pre-2310 golds, and both were already at the pool's edge:
`2208.13164` at denseRank **42/50** and `1412.6572` at **39/50**, each pushed
out by a cohort of newly indexed pre-2310 papers. The 87 golds that did not
move had slack to spare.

### The amendment

The rule predicted degradation and the paired test found none, so the rule as
written about **recall** is wrong — the second prediction of this shape to fail,
and it is not rescued by pointing at the direction of two needles.

> **Amended.** Same-neighbourhood additions produce **pool pressure**, which is
> directly measurable and did appear here (9.6% vs 3.1% churn, gold rank 6/0
> worse, p=0.03125, concentrated in the age band the ingest filled). **Recall is
> a lagging, threshold indicator of that pressure**: it moves only for golds
> whose slack in the candidate pool is already gone. Neighbourhood predicts the
> pressure; the gold's existing rank predicts whether the pressure costs
> anything.

That reconciles all four ingests without special-casing any of them: ancient
DNA crossed the threshold (and only there did `rerank demoted` appear); the two
earlier arXiv arms and this one did not. It also makes the next prediction
cheap and falsifiable — **the needles at risk are the ones sitting near
denseRank 50 before the ingest, and they can be listed in advance.** Measure
pool churn and gold-rank displacement, not r@10, when the ingest is small
relative to the corpus.

Practical consequence for this corpus: the AI-security backlog fill cost
nothing readable in recall, and the remaining arms can proceed. Re-measure with
the same 111 needles.

---

## 2026-08-09 (later) — two more domains, and what makes a domain hard to retrieve

Same treatment as the ancient-DNA run, applied to **AI cybersecurity** and **AI
consciousness**, across BOTH corpora this time. The interesting result is not
either domain's number; it is that the four domain×corpus arms differ by 27
points of r@10 with the same pipeline, the same authors and the same
instructions — and the ordering is explainable.

### What was ingested

| | PubMed | arXiv |
|---|---|---|
| AI consciousness | 16,196 | 1,210 |
| AI cybersecurity | 20,907 | *enumeration in progress* |
| eval-set citations (both) | 142 | 140 |

PubMed 1,694,272 → 1,731,517. The arXiv side of AI security is a 21-arm
enumeration still running; the eval set does not depend on it, because every
paper the questions cite was ingested by name first.

### The measurement

180 questions per domain, used as needles (each item with exactly one gold
paper is a needle: the question is the query, that paper is the right answer).
These are QA questions, not purpose-built needles — several are deliberately
about a debate rather than one paper — so this is a harder instrument than the
hand-written sets.

| set | corpus | lang | n | r@1 | r@10 | never retrieved |
|---|---|---|---|---|---|---|
| aicon | arXiv | EN | 27 | 96.3 | **100** | 0 |
| aisec | arXiv | SV | 19 | 84.2 | **89.5** | 10.5 |
| aisec | arXiv | EN | 92 | 77.2 | **84.8** | 15.2 |
| aisec | PubMed | EN | 13 | 69.2 | **84.6** | 15.4 |
| aicon | PubMed | EN | 71 | 60.6 | **73.2** | 21.1 |
| aicon | PubMed | SV | 23 | 47.8 | **56.5** | 34.8 |

(The two smallest arms — aisec/PubMed SV n=3 and aicon/arXiv SV n=6 — are
reported in the run files but are too small to read.)

### The finding: difficulty tracks vocabulary distinctiveness, not subject matter

The same domain scores **100** on arXiv and **73.2** on PubMed. Same questions'
authors, same pipeline, same day. The difference is how distinctive the
domain's vocabulary is *within its corpus*:

- arXiv holds ~2,600 consciousness papers in 786k vectors. "Consciousness
  indicator properties" has essentially one candidate.
- PubMed holds ~18,000 in 1.73M, and the vocabulary — consciousness, awareness,
  attention, theory, integration — is shared with thousands of clinical and
  cognitive papers that are not about machine consciousness at all. Every query
  competes against near-neighbours.

That is the same mechanism as the 2026-08-09 (earlier) regression, seen from
the other side: there, adding 28.6k topical papers demoted the needles that
already lived in that neighbourhood. Here, a domain that arrives already
crowded starts demoted. **Retrieval difficulty is a property of the
neighbourhood, not of the question** — which means a recall number is only
comparable across domains if the corpus density is comparable too, and it
usually is not.

Ancient DNA sat at 88.9 EN on the same instrument, between the two.

### Swedish did not behave the way PubMed taught us to expect

On arXiv, vernacular Swedish **beat** English on AI security (89.5 vs 84.8,
n=19). The 2026-08-08 entry established a large vernacular-Swedish penalty on
PubMed and traced it to the cross-encoder's score scale collapsing on a
Swedish-query/English-document pair. That penalty is absent here, and on
PubMed consciousness it reappears (56.5 vs 73.2).

Two readings, and this measurement cannot separate them: AI-security Swedish is
heavily cognate (promptinjektion, autentisering, kryptering) where consciousness
Swedish is native Germanic (medvetande, upplevelse, uppmärksamhet) — which is
exactly the mechanism the 2026-08-08 entry proposed; or the arXiv arm is simply
too small at n=19. **Do not treat the arXiv Swedish result as a refutation of
the standing finding.** A paired arXiv EN/SV/SVSCI set is the experiment that
would settle it, and it does not exist yet.

### The prediction above was WRONG, and the correction is the useful part

This entry originally predicted that aisec/arXiv would score WORSE once the
field around its cited papers was ingested, by analogy with the ancient-DNA
regression. **19,548 AI-security arXiv papers were then ingested and it did
not happen.** Paired over the same 111 needles:

| arm | metric | lost | gained | p | verdict |
|---|---|---|---|---|---|
| EN | r@10 | 0 | 0 | 1.0000 | **identical** |
| EN | r@1 | 1 | 0 | 1.0000 | not significant |
| SV | r@1 / r@10 | 0 | 0 | 1.0000 | identical |

`inPool` unchanged at 84.8/89.5. Latency paired sign p=0.5692. Runs
`data/eval/arxiv-aisec-ax{,-after}.json`.

The two ingests differ in a way the original phrasing missed, and it is
visible in the net counts rather than the gross ones:

| | pushed | index before → after | genuinely NEW |
|---|---|---|---|
| ancient DNA → PubMed | 28,599 | 1,665,539 → 1,694,272 | **+28,733** |
| AI security → arXiv | 19,548 | 786,094 → 794,803 | **+8,709** |

Two-thirds of the arXiv push was an UPSERT over papers already indexed — the
recent AI-security work, which the arXiv window (October 2023 onward) already
held, and which is exactly what these questions are mostly about. What was
genuinely added was 8,709 OLDER papers, 2013–2023, which are not close
neighbours of a question about a 2024 jailbreak benchmark.

So the correct statement is narrower than the one first written:

> Competition degrades retrieval when the added documents land in the SAME
> NEIGHBOURHOOD as the gold. Corpus volume alone does not. The ancient-DNA
> ingest put 28.6k ancient-DNA papers around ancient-DNA needles; this one put
> 8.7k older papers around mostly-recent needles.

That also means the ancient-DNA regression is better read as a
neighbourhood-density effect than as a "bigger corpus is worse" effect, and a
future ingest can be predicted from where its documents land, not how many
there are. **A prediction that survives one case and fails the next is worth
more than the case that generated it** — this one cost an ingest to falsify and
should not have to be falsified again.

**Confirmed a second time, at 1.44x the volume.** The second arm added 8,662
more ids (28,227 enumerated, 28,204 indexed, arXiv 786,094 → 798,774). Paired
against the same pre-ingest baseline: EN r@10 **identical**, SV r@10
**identical**, EN r@1 one loss (p=1.0000). Two independent ingests into the
same neighbourhood, neither of which moved recall. The density rule stands and
the volume rule remains dead.

**Latency did move, and that is the first real cost seen.** Paired sign over
the same queries: slower on 66, faster on 43, **p=0.0346** — significant where
the earlier +8.7k ingest was not (p=0.5692). A 1.6% larger index is not doing
that on its own; the likelier reading is that the added documents sit close
enough to these queries to enter the candidate pool and be reranked, paying
cross-encoder time without changing the ordering. That is worth watching as the
remaining 19 arms land: **recall is unmoved but the work is not free**, and a
corpus can get more expensive to search before it gets worse to search.

### Open

1. The enumeration is 2 arms of 21 (28,227 ids), so the AI-security arXiv
   corpus is a substantial START, not the complete field. The rebuilt
   enumerator projects ~1,333 requests and ~3.7 h for the remaining arms,
   against ~4,318 requests and ~10.9 h for the old design — which in practice
   never finished at all.
2. **A cheaper channel exists and the repo's own verdict on it was wrong.**
   OAI-PMH was abandoned here for enumeration, but `ListSets` exposes 183 sets
   down to leaf categories (`cs:cs:CR`), which nothing in the code or docs
   recorded. Measured: full cs.CR, all years — 50,798 records, 41 pages, 369
   seconds, abstracts on every record, zero 503s with no sleep at all. The
   original incident is now explicable: `set=cs` (top-level) and a bare `from=`
   both hang past 100 s, while the same request scoped to a LEAF set is
   instant. Switching the enumerator to leaf sets is the obvious next move and
   needs no new dependency. Full evidence in `data/aisec/enumeration-options.md`.
2. Whether the Swedish register effect is corpus-specific or vocabulary-specific
   is now a sharper question than it was, with a cheap experiment attached.

---

## 2026-08-09 — the whole ancient-DNA literature, and what a topical corpus costs its own needles

**+28,599 vectors**, 1,665,539 → 1,694,272. The PubMed index now holds
**31,156 of the 31,310** abstract-bearing ancient-DNA citations PubMed has ever
carried, back to 1961. The 154 absent are exactly accounted for: 143 below the
200-character abstract floor and 11 `<PubmedBookArticle>` records with no
abstract element at all. Verified by id, not by the loader's counters.

The enumeration is `scripts/pubmed-adna-query.txt` (committed, reproduces the
list exactly). It is 4.9× the naive union of "ancient DNA"-style phrases,
because whole subfields never use them: ancient pathogens, ancient human
population genetics, and domestication genomics from archaeological material.

### The enumeration was validated against two independent positive sets

A query cannot detect its own gaps, so recall was measured against sets the
query had no hand in choosing: one palaeogenomics group's 169 papers plus 90 curated adjacent
landmarks (259), and — separately — the 187 papers four question authors
independently cited while writing an eval set. Raw recall 75.7% and 88.2%;
**~99% and ~97%** once modern conservation genomics of extant species is
excluded as out of scope. Both validation sets carry a substantial
conservation-genomics component, so the raw denominator actively pushes the
query toward a literature that is *not* the target corpus — which is why both
numbers are reported rather than the flattering one.

Precision on a random 30 is **53% ancient-DNA-adjacent, 27% core**. Recall was
chosen over precision deliberately, but only where the trade was measured:
every rejected expansion had its marginal records sampled. The leaks that
pruning removed are worth keeping written down, because each looks harmless:
`"a-DNA"[tiab]` tokenizes to the phrase "a DNA" (+49,664), bare `extinction`
is mostly **fear-extinction** neuroscience (+45,473), `graves` is **Graves'
disease** (+31,000), `fossil` is **fossil fuel**, `moa` is **mechanism of
action**, `quagga` is **quagga mussel**, `mumm*` is **aphid mummies**.
`Fossils`/`Paleontology`[MeSH] and `Pleistocene` were near-zero precision under
a permissive molecular gate; `Hominidae`[MeSH] subsumes *Homo sapiens* and is
23.7M records.

### The negative result: a topical corpus demotes its own needles

Same 57-needle gold set, same configuration, 56 pairs (one needle was replaced
— see below):

| arm | metric | lost | gained | p | verdict |
|---|---|---|---|---|---|
| EN | r@1 | 2 | 0 | 0.5000 | not significant |
| EN | r@10 | 2 | 0 | 0.5000 | not significant |
| SV | r@1 | 4 | 0 | 0.1250 | not significant |
| SV | r@10 | 3 | 0 | 0.2500 | not significant |
| SVSCI | r@1 | 4 | 1 | 0.3750 | not significant |
| SVSCI | r@10 | 2 | 0 | 0.5000 | not significant |

EN r@10 98.2 → 94.7, SV 63.2 → 57.9, SVSCI 93.0 → 89.5.

**No single test is significant, and reading that as "no effect" would be
wrong.** All six metrics moved the same way: **17 losses against 1 gain**
across the arms. The tests are not independent (r@1 and r@10 share needles;
the three arms share documents), so the pooled sign test's p≈0.0001 overstates
the case — but the direction is not in doubt, and the mechanism is
mechanistically expected rather than mysterious. `rerank demoted` appears in
the English arm for the first time (0 → 3.5%), which is the signature of new
documents outranking the gold rather than of the gold vanishing: `inPool` is
unchanged at 98.2% for EN.

We added ~28.6k documents into precisely the topical neighbourhood these
needles live in. Competition went up; a few golds lost their place. That is the
price of the corpus being complete, and it is the right trade here — but it
means **needle recall measured on a growing corpus is not comparable across
ingests unless the corpus is held fixed**, and a future entry that reports a
recall change should say which of the two moved.

Latency: median 1388 → 1435 ms, p95 2853 → 4716, paired sign p=0.0549.

### What the corpus bought

The measurement that matters for the reason the ingest happened. Before it,
**53 of the 187** papers the new eval set cites were in the index (28%); every
question about the other 134 was measuring absence. After, **187/187**.

Retrieval over those 180 questions used as needles — note they were written as
QA questions, several deliberately about a debate rather than one paper, so
this is a harder instrument than a purpose-built needle set:

| lang | n | inPool | r@1 | r@5 | r@10 | never retrieved | floored out |
|---|---|---|---|---|---|---|---|
| EN | 126 | 89.7 | 75.4 | 84.1 | **88.9** | 10.3 | 0.8 |
| SV (vernacular) | 30 | 76.7 | 56.7 | 66.7 | **70.0** | 23.3 | 6.7 |

The Swedish gap is the same one the 2026-08-08 entry characterised, unchanged
by a 19× larger topical corpus — as expected, since its cause is the
cross-encoder's score scale, not what the index contains.

### A committed gold set can name a document the index cannot hold

`pmid:10970224` — Cooper & Poinar, *Ancient DNA: do it right or not at all* —
was a needle in the committed set. PubMed carries **no abstract** for it, so it
can never be embedded, so the needle was unanswerable in every language arm and
scored as a permanent miss. It was one of the three `short_abstract` drops
reported at ingest time on 2026-08-08 and never connected to the gold set.

The direction of the error is worth stating: it **depressed** that entry's
figures. English r@10 was 98.2% over 57 needles and the single "never
retrieved" was this needle — so retrieval over answerable needles was 100%.

A generated gold set cannot have this problem; it is sampled from the index. A
hand-written one keyed on chosen documents can, which is a failure mode that
arrived *with* committed gold sets. `rag-eval.mjs run` now verifies membership
before it measures anything and names unanswerable needles out loud. Replaced
with Renaud/Orlando 2019 (`pmid:30875054`), same subject, has an abstract.

### Open

1. **Precision was traded for recall and the bill has not been read.** 53%
   adjacent means roughly half the new records are off-target. Dropping the
   weakest arm of the query gives ~24k at ~+15pp precision for −17 validation
   papers. Nobody has measured whether that improves needle recall — it is the
   obvious next experiment, and this entry's regression is the reason to run it.
2. The Swedish register gap is untouched and its fix is still the untested
   monolingual-rerank change from 2026-08-08.

---

## 2026-08-08 — vernacular Swedish, and the floor that cannot move in either direction

Two results, one gold set. The first is a corpus result and the second is a
retrieval result, and they are in the same entry because the first is what made
the second measurable.

**Gold set.** `scripts/pubmed-palaeogenomics-goldset.json` — 57 hand-written
needles over one palaeogenomics group's published work (47) and the adjacent
literature by other groups (10). Committed, unlike every previous PubMed gold set, because it is
pinned to NAMED papers rather than to a sampled load-order window, so it stays
meaningful across re-ingests. That closes open item 4 of the 2026-08-01 entry
for PubMed. Membership of every `gold` was verified by `get_by_ids`, never by
querying the index. Authorship was verified mechanically against the Europe PMC author field —
surname AND given name, not surname alone — which matters: the bare surname
query returns 243 records of which only 216 belong to the intended author.

It carries **three** language arms, not two — `en`, `sv` and `svsci` — where
`sv` is vernacular Swedish (*fjällämmel*, *grottlejon*, *ullhårig noshörning*)
and `svsci` is the same question in scientific Swedish (*Lemmus lemmus*,
*populationsstruktur*, *paleogenomisk*). The two Swedish arms ask about the SAME
documents, so the difference between them isolates register from topic. That
pairing is the instrument; run it with `--langs en,sv,svsci`.

### Result 1 — the corpus held 18 of his 169 papers, and now holds 158

Measured by id against the Europe PMC bibliography, not by asking the index.
The load-order window is the reason: 89% of his work was published before the
2026 baseline and had not been revised since, so it was never in the fetch
window. The flagship *Nature* million-year-old mammoth DNA paper (PMID 33597750)
was absent, as were the 2015 Wrangel genomes, the 2014 polar bears and the 2020
prehistoric dogs.

An explicit-PMID ingest (`pubmed-harvest.mjs --pmids`, `docs/PUBMED-RAG.md`
§4.2) added **140** of his papers and **84** complementary ones, 224 vectors
total. The 11 of his that remain out are letters, replies and corrections that
fall below the corpus-wide 200-character abstract floor — the same rule the rest
of the corpus uses, so this is correct rather than a shortfall.

This is not a retrieval improvement and is not reported as one. It is the
difference between a question being answerable and not: English r@10 over his
career went from structurally unmeasurable to **98.2%**.

### Result 2 — the register effect, and why no floor value fixes it

Baseline over the 57 needles, pool 50, floor 0.01:

| lang | inPool | r@1 | r@5 | r@10 | MRR | floorLoss |
|---|---|---|---|---|---|---|
| EN | 98.2 | 87.7 | 96.5 | 98.2 | 91.0 | 0 |
| SV (vernacular) | 86.0 | 50.9 | 61.4 | 63.2 | 55.9 | **22.8** |
| SVSCI (scientific) | 93.0 | 80.7 | 91.2 | 93.0 | 85.7 | 0 |

Loss breakdown, SV: 14.0 never retrieved, 0 rerank demoted, **22.8 floored out**.
So the dominant loss is not the embedding and not the ordering — it is the
floor. The cross-encoder puts the right paper at reranked #1 and then its score
is thrown away: the same document scores 0.003–0.005 against a vernacular
Swedish query and 0.83–0.98 against the scientific Swedish one.

**This settles the hypothesis the 2026-08-01 entry recorded as untested.** That
entry found PubMed Swedish parity HOLDS (r@1 p=0.701) and guessed the mechanism
was that Swedish clinical terminology is Latin/Greek and near-identical to
English. The guess was right, and it is also why that measurement missed this:
its gold set was LLM-generated from each paper's own abstract, so its Swedish
was a near-translation of the document — cognate-rich by construction, which is
not what a researcher types. Parity holds on cognate vocabulary and fails on
native Germanic vocabulary. A Swedish speaker asking about *fjällämmeln* is in
the failing register.

**No scalar floor fixes it, and this extends the standing negative result.** The
2026-08-01 entry established the floor cannot be RAISED, because genuine Swedish
queries score below the adjacent-domain control. It cannot be LOWERED either:
vernacular-Swedish true positives (0.003–0.005) land inside the nonsense-control
band (pizza 0.0007–0.0078). Recovering the blackout needs F ≤ 3.5e-3; rejecting
the pizza query needs F ≥ 7.8e-3. **The default stays at 0.01.** Three
alternative gates were measured and all three overlap: absolute rerank score
(inverted 16×), dense cosine (0.7033 genuine vs 0.7634 off-domain), and a
scale-free top/p50 slate ratio (4.2 vs 131.0).

### What shipped: the floor became recoverable, not different

`effectiveFloor` (`src/literature-run.js`) clamped an explicit `min_score` UP to
`RERANK_FLOOR`, so a caller could raise the floor but a lower value was silently
discarded and the response honestly reported `relevance_floor: 0.01`. It now
honours an explicit `min_score` in both directions. No default moves.

Paired McNemar over the 57 needles, floor 0.01 → 0.001:

| arm | metric | lost | gained | p | verdict |
|---|---|---|---|---|---|
| EN | r@1 / r@10 | 0 | 0 | 1.0000 | identical |
| SV | r@1 | 0 | **8** | **0.0078** | **BETTER** |
| SV | r@10 | 0 | **9** | **0.0039** | **BETTER** |
| SVSCI | r@1 / r@10 | 0 | 0 | 1.0000 | identical |

SV r@10 63.2 → 78.9, floorLoss 22.8 → 5.3. **Zero losses in any arm.** Latency
paired sign p=0.1401 — no cost. Runs:
`data/eval/pubmed-palaeo-final-{default,low}.json`.

The tool description and both empty-result notes changed in the same commit;
they told an agent to raise `min_score` and to call `literature_corpora`, and
neither hinted that a non-English query may need the floor lowered. A capability
nothing tells the caller about is not a capability.

### Open

1. **The real fix is untested and is not this one.** Making the rerank pair
   monolingual — translating the query to English for the rerank leg only
   (`src/dense-rag.js`, `rerankMatches`) — is the only axis the evidence points
   at, since the embedding is already aligned (`inPool` SV vs EN is a paired
   0/0) and the ordering is already right. It adds a call inside a search wave
   against `TOTAL_BUDGET_MS = 12_000`, so it must be A/B'd on latency as well as
   recall; the pool 50→100 entry is the precedent for a change killed on latency
   alone.
2. **`denseSearch` takes no floor parameter**, so `/api/chat` cannot lower it
   even now. There the miss degrades to the live Europe PMC ladder rather than
   to nothing, which is why only the MCP surface shows a blackout — but it also
   means the fix above is the only thing that would help the pipeline path.
3. **14% of SV needles are never retrieved at all**, which the floor cannot
   touch. That is the dense stage, and it is the same ceiling the 2026-08-01
   entry named for both corpora.

---

## 2026-08-01 — the first two-corpus baseline

The instrument was generalized from arXiv-only to corpus-agnostic in the same
change (`scripts/rag-corpora.mjs`, `rag-hosted.mjs`, `rag-eval.mjs`), so this is
the first time both hosted indexes have been measured with the same code on the
same day. It closes `docs/PUBMED-RAG.md` §8.2 — "no retrieval numbers yet …
nothing should [claim recall] until `pubmed:eval` exists".

**Gold sets.** 150 needles per corpus, EN+SV, sampled BY ID from each corpus's
independent enumeration (arXiv: the GCS mirror; PubMed: E-utilities) and
hydrated through `get_by_ids` — never by querying the index being measured.
arXiv needles from submission months 2601–2607, PubMed from EDAT 2026/05–07.
Leak guard: mean title overlap arXiv 0.27 / PubMed 0.32.

### Baseline, served configuration (pool 50, floor 0.01)

| | vectors | lang | inPool | r@1 | r@5 | r@10 | MRR | ms med | ms p95 |
|---|---|---|---|---|---|---|---|---|---|
| arXiv | 772,658 | EN | 84.0 | 76.7 | 82.7 | 83.3 | 79.5 | 1390 | 2535 |
| arXiv | 772,658 | SV | 77.3 | 67.3 | 75.3 | 76.7 | 71.2 | 1426 | 2533 |
| PubMed | 1,646,226 | EN | 92.0 | 72.0 | 86.0 | 88.7 | 78.1 | 1558 | 3029 |
| PubMed | 1,646,226 | SV | 88.7 | 74.0 | 85.3 | 87.3 | 79.1 | 1486 | 2652 |

**PubMed retrieves better than arXiv despite holding 2.1× the vectors.** That
is the opposite of the corpus-pressure result §11 measured on arXiv, and the
likely reason is the query family rather than the index: a biomedical abstract
states its finding in the vocabulary a researcher would search with, while an
arXiv abstract more often states a method. Not tested; recorded as a hypothesis,
not a conclusion.

### Where the gold document is lost (% of needles, pool 50)

| corpus | lang | in top 10 | never retrieved | rerank demoted | floored out |
|---|---|---|---|---|---|
| arXiv | EN | 83.3 | **16.0** | 0.7 | 0.0 |
| arXiv | SV | 76.7 | **22.7** | 0.7 | 0.0 |
| PubMed | EN | 88.7 | **8.0** | 2.7 | 0.7 |
| PubMed | SV | 87.3 | **11.3** | 0.7 | 0.7 |

**This is the table that says where the headroom is.** On both corpora, in both
languages, essentially all of the loss is the DENSE stage failing to put the
document in the pool at all. The cross-encoder demotes ≤2.7% and the relevance
floor costs ≤0.7%. Work on reranking or on the floor cannot buy back more than
about three points; work on the embedding or the passage can address sixteen.

---

## 2026-08-01 — pool 50 → 100: REJECTED, on both corpora

**Hypothesis.** `inPool` bounds everything, and Vectorize serves topK=100 with
`returnMetadata: "none"` plus a hydrating `get_by_ids` pass. Raising the pool
20 → 50 previously bought +4.0 points of EN r@10 for no extra round trip
(§11), so 50 → 100 might do the same again.

**Method.** Same gold sets, 90 paired needles per corpus (the pool-100 run is
slow enough that 150 does not finish in one session), 4 workers in both arms so
the latencies are comparable. Decided by paired McNemar.

| corpus | lang | metric | lost | gained | p | verdict |
|---|---|---|---|---|---|---|
| PubMed | EN | r@1 | 2 | 2 | 1.000 | not significant |
| PubMed | EN | r@10 | 0 | 4 | 0.125 | not significant |
| PubMed | SV | r@1 | 2 | 1 | 1.000 | not significant |
| PubMed | SV | r@10 | 2 | 1 | 1.000 | not significant |
| arXiv | EN | r@1 | 0 | 1 | 1.000 | not significant |
| arXiv | EN | r@10 | 1 | 1 | 1.000 | not significant |
| arXiv | SV | r@1 | 1 | 2 | 1.000 | not significant |
| arXiv | SV | r@10 | 0 | 2 | 0.500 | not significant |

**Cost, which is not ambiguous at all:**

| corpus | pool 50 median | pool 100 median | paired sign |
|---|---|---|---|
| PubMed | 1,492 ms | 4,456 ms | slower on 208/208, p<0.0001 |
| arXiv | 1,408 ms | 3,063 ms | slower on 204/208, p<0.0001 |

**Verdict: do not raise the pool past 50.** Nothing measurable is gained and
the served call roughly triples on PubMed — against `TOTAL_BUDGET_MS = 12_000`
inside a search wave, where this tier's latency is the user's, that is the
whole rerank budget spent for noise. The `inPool` figure barely moves either
(arXiv EN 84.0 → 84.4), which is the real reason: at 50 the pool has stopped
being the constraint. **The documented finding that "the POOL was the entire
constraint" was measured at pool 20 and no longer describes the served path.**

---

## 2026-08-01 — Swedish parity: a REAL deficit on arXiv, parity on PubMed

The invariant-6 measurement, now a command (`rag-eval.mjs parity`). The two
languages ask about the SAME 150 gold documents, so this is paired.

| corpus | metric | SV loses | SV wins | p | verdict |
|---|---|---|---|---|---|
| arXiv | r@1 | 22 | 8 | **0.016** | **Swedish deficit** |
| arXiv | r@10 | 15 | 5 | **0.041** | **Swedish deficit** |
| arXiv | inPool | 15 | 5 | **0.041** | **Swedish deficit** |
| PubMed | r@1 | 12 | 15 | 0.701 | parity holds |
| PubMed | r@10 | 6 | 4 | 0.754 | parity holds |
| PubMed | inPool | 7 | 2 | 0.180 | parity holds |

Two things follow, and the second is the actionable one.

**The arXiv deficit is entirely a RETRIEVAL deficit.** The `inPool` row is
identical to the r@10 row — 15 lost, 5 gained, same p. Every Swedish document
that ends up missing was already missing before the cross-encoder saw the pool.
No amount of reranking work can close it; the fix has to be at the embedding or
query stage.

**Same embedder, same pipeline, two corpora, opposite verdicts.** Swedish
reaches statistical parity on biomedical text and does not on arXiv. A
plausible mechanism is vocabulary: Swedish clinical terminology is largely
Latin/Greek and near-identical to English (*karbapenemresistens*,
*immuncheckpointhämmare*), while Swedish CS/physics terminology diverges
(*ytkoder* for surface codes, *kvantfelkorrigering*). **Untested** — it is a
hypothesis to design an experiment against, not a finding.

---

## 2026-08-01 — the relevance floor CANNOT be tuned to reject adjacent domains

**What prompted it.** The probe's control set was extended past nonsense with a
HARD control: a real, well-formed research question from the *other* corpus's
subject matter. Against PubMed, "transformer attention head pruning for faster
inference on edge GPUs" scored **0.129 EN / 0.422 SV** and kept **18 / 29** of
50 candidates. The pure-nonsense controls behaved exactly as designed (pizza
0.0078 / 0.0007, train tickets 0.0003 / 0.0009, nothing kept).

**Why raising the floor is not the answer.** Genuine Swedish topical queries on
PubMed bottom out at a top score of **0.163**, with a 10th percentile of 0.314
— *below* the 0.422 the adjacent-domain control scored. On arXiv a genuine
Swedish query scores as low as **0.028**. The distributions overlap, so every
floor that rejects the adjacent query also empties real Swedish queries first.

**Verdict: leave `RERANK_FLOOR` at 0.01.** The floor's job is separating
off-domain from on-domain, and it does that (three orders of magnitude on the
nonsense controls). Separating *adjacent* domains is the upstream intent gate's
job — `src/europepmc.js` owns "is this a life-science question", which is
exactly where `src/pubmed-rag.js` says it belongs ("No new intent gate"). This
entry exists so the next person who sees the leak raises the gate, not the
floor.

Practical bound on the exposure: the dense tier only runs once that gate has
already fired, so an ML-systems question does not reach PubMed in normal
operation. The leak is a property of the floor, not a live defect.

---

## Standing negative results — do not re-propose without new evidence

Carried forward from `docs/ARXIV-RAG.md` so one list answers "has this been
tried".

| idea | measured | outcome |
|---|---|---|
| fuse a BM25 arm into the dense pipeline | §4 | worse in both languages on hand-written queries |
| HyDE query expansion | §4 | EN r@1 72.1 → 58.6, no topical gain, one extra LLM call |
| weight the BM25 arm by query-vocabulary coverage | §4 | unnecessary; the lexical arm is left out, not conditioned |
| local date re-sorting of results | `src/arxiv.js` | demoted the best papers; bucketed variant a no-op |
| pool 50 → 100 | this file, 2026-08-01 | no measurable gain, 2–3× latency |
| raise `RERANK_FLOOR` to reject adjacent domains | this file, 2026-08-01 | impossible without emptying genuine Swedish queries |

---

## Open, and worth an experiment

1. **The dense stage is the whole ceiling now** (16% / 22.7% never retrieved on
   arXiv). Every remaining idea should be aimed there rather than at the pool,
   the reranker or the floor.
2. **The arXiv Swedish deficit has a mechanism to test.** The cheapest probe:
   embed the English translation of each Swedish needle query and compare
   `inPool` against the Swedish original, paired. If translation closes the
   gap, the deficit is the embedder's cross-lingual alignment on technical CS
   vocabulary; if it does not, it is the query set. That measurement costs one
   run and no index change, and it must come before anyone proposes a
   translation step in the serving path — which would add an LLM call inside a
   search wave and is not obviously affordable at `TOTAL_BUDGET_MS`.
3. **Whether to chunk long PubMed abstracts** (`docs/PUBMED-RAG.md` §8.1) is
   still open and this ledger did NOT answer it. It cannot be answered from the
   hosted index alone: the stored metadata `a` is a 900-char cut, so the full
   abstract is not available to sample from, and needles written from the
   *last third* of a long abstract — the text the single-passage build discards
   — have to be generated from the harvested corpus on disk.
4. ~~**A carryover gold set is not yet pinned for PubMed.**~~ **Closed
   2026-08-09.** The six hand-written needle sets now live in `tests/needles/`
   and are guarded by `tests/needles.test.js`. They had lived only in gitignored
   `data/`, so each one died with the container that produced it — which
   quietly defeated the discipline they exist for: re-using the SAME needles
   across a corpus change is what makes only the distractor count vary, and a
   regenerated set changes the thing being measured. A paired test across two
   different needle sets is not a paired test.

   Committing them immediately paid for itself by surfacing two things nobody
   had noticed: **two incompatible file shapes are in circulation** (paired
   `{gold, en, sv}` versus per-row `{gold, id, en}` / `{gold, id, sv}`, where a
   repeated `gold` is correct and a missing `en` is a Swedish query, not a
   defect), and **three sets ask more than one question about the same paper**,
   so their reported n overstates the independent evidence. Both are pinned
   rather than fixed, for the reason in the caveat above: editing a set breaks
   its pairing with every run already in this ledger.

   Still open underneath it: the *sampled* PubMed sets (`data/eval/*-gold.json`)
   remain ephemeral and should be regenerated from seed `rag-eval-v1`, which the
   sampler makes deterministic.
