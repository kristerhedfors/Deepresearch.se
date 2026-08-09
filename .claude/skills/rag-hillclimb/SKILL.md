---
name: rag-hillclimb
description: >-
  Load when MEASURING or IMPROVING a hosted dense-retrieval index — "evaluate
  the arXiv/PubMed RAG", "is retrieval any good", "did that change help",
  "validate the RAG pipeline", "find improvement potential in retrieval",
  "run the bake-off", "check Swedish parity on retrieval", "tune the relevance
  floor / the candidate pool" — or before changing anything in src/dense-rag.js,
  src/arxiv-rag.js, src/pubmed-rag.js or the scripts/rag-*.mjs harness. The
  repeatable hill-climbing loop over BOTH hosted corpora: the one instrument
  (scripts/rag-eval.mjs — sample/goldset/coverage/run/compare/judge/parity/probe),
  the five-step order that keeps a measurement honest, the paired McNemar that
  decides every verdict (an eyeballed rate difference at n=150 is noise), the
  loss-breakdown table that says WHICH stage to work on, and the append-only
  ledger docs/RAG-EVAL-LEDGER.md that stops a settled negative result being
  re-proposed. ALSO the place to start when retrieval is bad for ONE topic,
  field or researcher rather than across the board — check membership with
  get_by_ids first, because "the index cannot find it" and "the index does not
  have it" look identical from a query and only one of them is a retrieval
  problem. And when the complaint is about a LANGUAGE, ask which register:
  a generated gold set writes in the document's own scientific vocabulary and
  therefore cannot see a vernacular failure, which is why a third `svsci` arm
  exists beside `en` and `sv`. For BUILDING a corpus see **bulk-corpus-etl**;
  for the arXiv corpus's own facts see **arxiv-rag**; for re-running the PubMed
  ingest — including the `--pmids` mode that fills a coverage hole — see
  **pubmed-ingest**.
---

# Hill-climbing a hosted RAG pipeline

Two corpora are served by one pipeline — `src/dense-rag.js`, with
`src/arxiv-rag.js` and `src/pubmed-rag.js` as thin callers. One instrument
measures both: **`scripts/rag-eval.mjs`**, with `--corpus arxiv|pubmed`.

```bash
export NODE_USE_ENV_PROXY=1      # Node's fetch ignores HTTPS_PROXY without it
npm run rag:eval                 # usage
```

Results go in **`docs/RAG-EVAL-LEDGER.md`**, append-only, newest first. Read it
before proposing anything: it carries the standing negative results, and half
the value of this loop is not re-running an experiment that already lost.

## The order, and why it is an order

```
coverage → sample → goldset → run → compare / parity / judge
```

**1. `coverage` first, always.** A partial index produces confident recall
numbers. A run's own counters cannot detect the run's own gaps — an arXiv
harvest's totals agreed with themselves to 0.04% while 48.1% of a month was
missing. Only a second, independent system can.

```bash
node scripts/rag-eval.mjs coverage --corpus pubmed --months "2026/05,2026/06,2026/07" --n 400
```

A few tenths of a percent is the steady state (the index's abstract floor is
stricter than the enumeration's filter). Several percent on a settled window is
a real hole, and everything downstream is void until it is explained.

**2. `sample` — by ID, from that same independent enumeration.** Never by
querying the index. Querying selects for documents that retrieve well and
inflates every number you then report. The enumerations are the GCS mirror for
arXiv and E-utilities for PubMed, and both are in `scripts/rag-corpora.mjs`.

**3. `goldset` — EN and SV, leak-guarded.** The generator writes the research
question each document answers, in both languages (invariant 6). It reports
overlap against the title *and* the abstract; the second is the one that
matters, because the model writes from the abstract and English queries keep
~0.5–0.6 of its vocabulary. Never believe a lexical retriever's score on a
synthetic set without that number beside it.

**4. `run` — the SERVED path, written to disk as evidence.** Per-query stage
ranks, cross-encoder scores and latencies. Every table is a view over that
file, so a comparison months later costs nothing and cannot drift.

**5. `compare` / `parity` / `judge` — decide with the paired test.**

## The decision rule: paired McNemar, never the eye

At n=150 the independent binomial 95% CI is about ±6.7 points. Almost every
real effect looks like noise inside it and almost every noise looks real. The
runs share their gold set, so the **discordant pairs** are the evidence:

```
compare  → paired McNemar on hit@k, per language, plus a paired sign test on latency
parity   → the same test with the two LANGUAGES as the arms (invariant 6)
judge    → pooled LLM grading → nDCG@10, plus a paired sign test
```

This was hand-computed for years and existed in no script; `mcnemar` in
`scripts/rag-eval-core.mjs` is unit-tested against the values
`docs/ARXIV-RAG.md` §11 published, so the doc's verdicts and the tool's are the
same arithmetic.

Two rules that come with it:

- **Hold everything but one variable, and use a CARRYOVER gold set** across a
  corpus change, so the only thing that differs is the distractor count.
- **Report the losing experiments.** A rejected idea in the ledger is worth as
  much as an accepted one.

## Read `inPool` and the loss breakdown BEFORE any recall number

`run` prints where the gold document was lost, and it is the table that says
what to work on:

| bucket | meaning | what fixes it |
|---|---|---|
| never retrieved | dense never put it in the pool | the embedding, the passage, the query |
| rerank demoted | in the pool, cross-encoder pushed it out | the reranker, the document cut |
| floored out | ranked, then dropped by `RERANK_FLOOR` | the floor |

Measured 2026-08-01 on both corpora, both languages: **essentially all loss is
"never retrieved"** (arXiv EN 16.0%, SV 22.7%; PubMed EN 8.0%, SV 11.3%), while
reranking costs ≤2.7% and the floor ≤0.7%. So the dense stage is the ceiling,
and an idea aimed at the reranker or the floor is bounded at about three points
before it is even tried.

A drop in r@10 with `inPool` flat is a reranking problem; a drop in both is a
retrieval problem. They have different fixes and the table tells them apart.

## Traps this harness has already paid for

**The replay must import the served constants, not copy them.**
`scripts/arxiv-hosted.mjs` hard-coded `CANDIDATES = 20` with a comment saying
that was what production asked for. Production moved to 50 and nothing failed —
the harness simply went on measuring a pipeline nobody runs. `rag-corpora.mjs`
imports the pool, floor and document cut from `src/dense-rag.js`, and a unit
test asserts they are equal.

**A verification tool that has never been run on real data is not yet a
verification tool.** `listShard` returns a **Map**, not an array; iterating it
directly yields `[id, version]` pairs that stringify to `"2603.12345,2"` and
match nothing. The first arXiv sample took 256 ids and found 0 of them in the
index. It was caught only because the sampler says out loud how many enumerated
ids were missing — make every "nothing to do" path loud.

**Do not spread option names onto a statistic's result.** `langParity` took a
`b` option for the second language and spread it over `mcnemar`'s `{b, c}`
counts, replacing the count with the string `"sv"`. The table then compared
strings and printed "Swedish ahead" for a significant deficit.

**Latency is only comparable at equal `--workers`.** Raising it shortens wall
clock and inflates every measured latency. A pool-100 run needs `--limit` or
more workers to finish in one session; if you raise the workers, raise them in
both arms.

**Swedish is measured WITH diacritics.** Stripping them costs orders of
magnitude of score and has manufactured a false invariant-6 bug report once
(`docs/PUBMED-RAG.md` §7.7).

**A generated gold set cannot detect a REGISTER problem, because it writes in
the document's own register.** `goldset` asks a model to write the question each
paper answers, from that paper's abstract — so its Swedish is a near-translation
of an English abstract, and inherits the abstract's Latin/Greek scientific
vocabulary. That made PubMed Swedish parity look fine (2026-08-01, r@1 p=0.701)
while vernacular Swedish was losing 35 points of r@10 (2026-08-08). Both
measurements are correct; they are measuring different questions.

The instrument is a **third language arm**. `run --langs` reads the gold set's
keys directly, so a needle can carry `en`, `sv` AND `svsci` — the same question
in vernacular and in scientific Swedish, about the SAME document, which is what
isolates register from topic. `scripts/pubmed-palaeogenomics-goldset.json` is the worked
example. If you are asked whether Swedish "works", ask which Swedish, and
measure both:

```bash
node scripts/rag-eval.mjs run --corpus pubmed --gold scripts/pubmed-palaeogenomics-goldset.json \
  --label x --langs en,sv,svsci
```

**When a gold set must survive re-ingests, pin it to NAMED documents.** Every
generated set is sampled from a load-order window, so it silently stops being
comparable the moment the corpus changes. A hand-written set keyed on chosen
PMIDs stays valid across ingests and can be committed — which is the only way a
before/after separated by a corpus change means anything.

**Distinguish "the index cannot retrieve it" from "the index does not have
it".** Ask `get_by_ids` before you conclude anything about recall. A named
researcher's corpus coverage was **18 of 169** and every retrieval number over
their work was measuring absence, not retrieval. Coverage-first is the rule for
a topic slice as much as for a month.

> Before the per-id check, know the SHAPE you are working against:
> `docs/CORPORA.md` and the page it generates, `/corpora/`
> (`node scripts/build-corpora.mjs`). Neither corpus is a uniform window any
> more — arXiv is a swept band 2310–2607 PLUS topic-shaped tails back to 1991,
> and PubMed is a load-order slice rather than a date range — so whether a
> gold's absence is surprising depends entirely on which region it falls in.
> Sampling needles without that in hand produces a set whose difficulty is an
> accident of the fill history.

**A committed gold set can name a document the index cannot HOLD.** A generated
set is sampled from the index, so its golds are present by construction. A
hand-written one keyed on chosen documents is not: a 2000 *Science* piece with
no abstract at all rode in a committed set for a week, scoring as a permanent
miss in every language arm and quietly costing English r@10 a point retrieval
had actually earned. `run` now checks membership before it measures and names
unanswerable needles out loud — read that warning before you read the table.

**Recall is not comparable across ingests, because the corpus is the other
variable.** Adding 28.6k ancient-DNA papers moved all six needle metrics down —
17 losses against 1 gain — with `inPool` unchanged and `rerank demoted`
appearing for the first time. Nothing retrieved worse; there were simply more
plausible documents in the same neighbourhood, and a few golds lost their
place. So a before/after that spans an ingest measures TWO changes at once. Say
which one you mean, and if you want to attribute a retrieval change to a
pipeline change, hold the corpus fixed.

**Six underpowered tests all pointing the same way is not "no effect".** Each
of those six was individually non-significant (p from 0.125 to 0.5 at n=56) and
reporting "no significant change" would have been true and misleading. The
tests are not independent — r@1 and r@10 share needles, the language arms share
documents — so pooling them overstates significance too. State the direction,
the counts, and the dependence, and let the reader see all three.

## The control set is half of `probe`

```bash
node scripts/rag-eval.mjs probe --corpus pubmed
```

Cheap enough to run after every deploy. Its point is not the topical scores but
the **controls**, and they come in two strengths:

- **nonsense** ("best pizza recipe napoletana dough") — must return nothing
  above the floor, or the caller never falls through to its live API. This
  works: three orders of magnitude below everything real.
- **adjacent domain** — a real, well-formed research question from the *other*
  corpus's subject matter. This is the one that finds things. An ML-systems
  question scored 0.129 EN / **0.422 SV** against PubMed and kept 18/29
  candidates.

**Do not respond to an adjacent-domain leak by raising the floor.** Genuine
Swedish topical queries bottom out *below* what the adjacent control scores
(PubMed 0.163 vs 0.422), so the distributions overlap and every floor that
rejects the leak empties real queries first. Adjacent domains are the upstream
INTENT GATE's job — which is where `src/pubmed-rag.js` deliberately puts them
("No new intent gate"). The ledger records this so the next person raises the
gate, not the constant.

## Adding a third corpus

Add a descriptor to `CORPORA` in `scripts/rag-corpora.mjs` — index name, id
spelling, URL, how to recover a date, and an `enumerate` that reaches a source
**independent of the index**. That last field is the one that carries the
method; everything else is bookkeeping. Then write its topical query set
(EN+SV, with controls including one adjacent-domain query) and the whole loop
works unchanged.

## Cost and wall clock, measured

Per corpus at 150 needles × 2 languages + 14 topical × 2 = 328 queries:

| step | cost |
|---|---|
| `sample` (160 docs) | seconds; zero index queries beyond `get_by_ids` |
| `goldset` (150 × EN+SV) | ~150 Berget JSON calls, a few minutes at 6 workers |
| `run` at pool 50 | ~5 min at 4 workers, median 1.4–1.6 s/query |
| `run` at pool 100 | ~3× longer — needs `--limit` to finish in one session |
| `compare` / `parity` | free, reads the saved run files |

Background processes are killed at TURN BOUNDARIES in an agent session, so a
run has to fit inside one held turn. `--limit` on the needle count is the knob
that makes it fit; the paired test drops unpaired documents automatically, so a
shorter run still compares correctly against a longer one.
