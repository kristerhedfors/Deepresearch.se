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
