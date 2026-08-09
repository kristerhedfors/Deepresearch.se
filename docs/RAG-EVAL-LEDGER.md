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

### Open

1. The 21-arm enumeration is 1 arm done of 21 (19,565 ids), so the AI-security
   arXiv corpus is a substantial START, not the complete field. The measurement
   above is therefore a control for the density hypothesis, not a final
   number for the domain. Finishing the arms will add mostly-recent papers,
   which is where the density effect WOULD be expected to bite — that is the
   experiment worth running next, and it now has a stated prediction to test.
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
query had no hand in choosing: Dalén's 169 papers plus 90 curated adjacent
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

**Gold set.** `scripts/pubmed-dalen-goldset.json` — 57 hand-written needles over
the published work of Love Dalén (47) and the adjacent literature by other
groups (10). Committed, unlike every previous PubMed gold set, because it is
pinned to NAMED papers rather than to a sampled load-order window, so it stays
meaningful across re-ingests. That closes open item 4 of the 2026-08-01 entry
for PubMed. Membership of every `gold` was verified by `get_by_ids`, never by
querying the index. Authorship was verified against the Europe PMC author field
(lastName Dalén AND firstName Love), which matters: `AUTH:"Dalen L"` returns 243
records of which only 216 are his.

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
`data/eval/pubmed-dalen-final-{default,low}.json`.

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
4. **A carryover gold set is not yet pinned for PubMed.** The arXiv discipline
   is to re-use the same needles across a corpus change so only the distractor
   count varies. The sets built here (`data/eval/*-gold.json`) are the first
   generation; `data/` is gitignored and ephemeral, so the next corpus change
   should regenerate them from the same seed (`rag-eval-v1`) and months, which
   the sampler makes deterministic.
