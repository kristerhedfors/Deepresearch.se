# What is ingested

The research corpora this site can search, what is genuinely in them, and —
more usefully — what is not.

Published at **[deepresearch.se/corpora/](https://deepresearch.se/corpora/)**,
which renders the same numbers from a dataset measured off the live indexes
rather than typed in. This file is the prose; that page is the current state.

> **Read this before concluding a paper is missing.** These corpora are shaped,
> not complete. A search that finds nothing may mean the paper is outside what
> was ingested — or that the query missed it. Those look identical from the
> outside, and §5 is about telling them apart.

---

## 1. The two indexes

| | arXiv | PubMed |
|---|---|---|
| index | `deepresearch-se-arxiv` | `deepresearch-se-pubmed` |
| holds | preprints across physics, mathematics, computer science, quantitative biology, statistics, economics, quantitative finance | biomedical and life-science literature — MEDLINE journals, plus bioRxiv and medRxiv |
| id form | `2401.12345` | `pmid:41787358` |
| stored per record | title, abstract (cut to 900 characters), authors, category, dates | title, abstract (cut to 900 characters), authors, journal, date |
| full text | none — abstracts only | none — abstracts only |

Both are dense-retrieval indexes: text is embedded with
`intfloat/multilingual-e5-large` (1024 dimensions) and searched by meaning
rather than keyword, then reranked with a cross-encoder. Neither holds full
text, so a question whose answer lives in a paper's methods section and never
in its abstract cannot be answered from these corpora at all.

---

## 2. arXiv — a dense band plus topic-shaped tails

The shape is two different things and it matters which one a query lands in.

**The swept band, 2310–2607** (October 2023 to July 2026) was harvested month
by month across *every subject arXiv carries*. Within it, coverage is
indiscriminate: a paper is there because it was submitted in that window, not
because anyone chose it.

**Everything below the band arrived by name.** Topic-targeted fills reach back
to 1991, so pre-2310 coverage is dense for a few subjects and near-absent for
everything else. There is no month before October 2023 in which this index
holds a representative sample of arXiv.

The practical consequence: a pre-2310 miss is weak evidence. It may be a paper
in a subject nobody filled, and rephrasing will not help; or it may be present
and simply not retrieved. §5 says how to check.

The current split — swept band, tail, and the pre-2007 ids that carry no month
in their id at all — is on the published page, measured at build time.

## 3. PubMed — a load-order window, not a date range

This is the part most often misread, so it is stated plainly: **the PubMed
corpus is not "the last N years of PubMed".**

It is everything NLM has *loaded or revised* since the 2026 baseline was cut on
2026-01-29 — a PMID / load-order window. Two things follow that surprise people:

- **Old papers are in it.** The daily update files carry recent *edits*, so a
  1998 paper revised in 2026 is present while its never-revised neighbour is
  not.
- **Recent papers can be missing.** A 2025 paper loaded before the baseline is
  in no file the harvest reads.

The window is defined on the load axis because that is the axis the fetch
actually uses. Defining it on publication date instead is a specific bug this
project has already paid for twice on the arXiv side — filtering on one date
axis while selecting on another, both times exiting cleanly with self-consistent
counters and a corpus missing half a month.

Of the harvest: 3,776,137 records read, 3,397,607 kept, **1,639,403 unique
citations** — the gap is 55.9% repeats, because the update files revise the same
citation many times. 99.3% carry a DOI, 66.7% carry MeSH terms, and **88% of
abstracts are longer than the embedder's window** and are stored truncated.
That last figure is a real retrieval limit, not a footnote: for most PubMed
records, the final third of the abstract is not what gets searched.

Measured 2026-07-31; the live vector count on the page includes the
domain fills below.

## 4. The domains filled deliberately

On top of the bulk sweeps, four subjects were filled by name — every paper
found for a topic, regardless of date — because the bulk windows alone left
them unusable. Each has a published evaluation set of questions whose answers
are verified present in the corpus.

| domain | corpora | questions | why it needed a named fill |
|---|---|---|---|
| Ancient DNA / palaeogenomics | PubMed | 180 | the field's foundational papers predate the load window |
| AI cybersecurity | arXiv + PubMed | 180 | its foundations are 2013–2018, below the arXiv band |
| AI consciousness | arXiv + PubMed | 180 | reaches into the 1990s |
| Palaeogenomics bibliography | PubMed | 56 | one research group's own output, spread across thirty years |

**Coverage of what those questions cite:** 260 cited arXiv ids across all sets,
0 unanswerable. 386 cited PMIDs, 1 unanswerable — `pmid:10970224`, whose record
carries a zero-length abstract and therefore cannot be embedded at all. One
question in 746.

That last case is worth understanding, because it is the only *permanent* kind
of miss. A paper with no abstract has nothing to embed; it is not retrievable
at any threshold, and no amount of re-ingesting changes that.

## 5. Telling "not in the corpus" from "not retrieved"

These are different problems with different fixes, and they are
indistinguishable from a search result alone.

**Check membership directly.** Both corpora accept an id lookup. If the id is
there, the corpus is fine and the problem is the query; if it is not, no
rephrasing will ever find it. This one check separates the two cases and costs
one call — it is the first thing to do, not the last.

**If it is present but not retrieved**, the usual causes, in the order worth
trying:

- The query paraphrases the paper's *title* rather than its contribution.
  Dense retrieval over abstracts rewards the second.
- The answer is in the part of the abstract that was truncated (88% of PubMed
  records are cut).
- The subject area is crowded, so the paper competes with thousands of
  near-neighbours. Retrieval difficulty is a property of the neighbourhood, not
  of the question: the same domain scores 100% recall@10 on arXiv and 73% on
  PubMed, purely because its vocabulary is distinctive in one corpus and
  ordinary in the other.
- The query is in vernacular Swedish. Cross-lingual *ordering* holds up, but the
  absolute similarity scores collapse by one to three orders of magnitude, so a
  correct match can fall below a relevance floor tuned on English. Lowering
  `min_score` explicitly is the workaround.

**If it is absent**, it can be ingested by name — both corpora have a
named-list path — but that is a corpus change, and it should be followed by a
retrieval measurement rather than assumed to have helped.

## 6. Honest limits

- **Abstracts only.** No full text, in either corpus.
- **Neither corpus is complete**, and neither is a random sample of its source.
  Any statistic computed *over* these corpora describes them, not the
  literature.
- **The bulk windows are frozen** between refreshes. The arXiv band's newest
  month is usually partial, since a delta is cut mid-month.
- **The domain fills are exhaustive for their topic and silent about
  everything else.** Ancient DNA is filled to the 1990s; an adjacent
  palaeontology question is served only by whatever the bulk window happens to
  hold.
- **Recall is measured, and it is not 100%.** Published figures per domain and
  language are in `RAG-EVAL-LEDGER.md`, decided by paired significance tests
  rather than by eye.

## 7. Keeping this page true

`scripts/build-corpora.mjs` regenerates the dataset from the live indexes:

```bash
node scripts/build-corpora.mjs                # full: ~200 s arXiv, ~7 min PubMed
node scripts/build-corpora.mjs --skip-shape   # live vector counts only, seconds
```

Every number is labelled by how it was obtained. **MEASURED** figures are read
from the index at build time and carry that timestamp. **RECORDED** figures
describe a fill that already happened — what a harvest read, what it dropped —
which cannot be re-derived from the index afterwards, and carry the date they
were measured on instead.

Run it after any fill. The reason it is a script rather than a hand-edited page
is that the equivalent claim inside the code went stale exactly once and did
real damage: `CORPUS_FACTS.arxiv.window` told agents that nothing before
October 2023 was in the index while 42,307 papers sat below that line, because
named-list fills had reached underneath the bound its maintainer was watching.
A public page maintained by hand would drift the same way, where users rather
than agents would read it.

## 8. Related

| | |
|---|---|
| `ARXIV-RAG.md` | how the arXiv corpus is built and served |
| `PUBMED-RAG.md` | the same for PubMed, including the cost model |
| `RAG-EVAL-LEDGER.md` | every retrieval measurement, append-only |
| `ARXIV-BACKLOG-INGEST.md` | the named-list backlog reconciliation |
| `ARXIV-FAILED-IMPORTS.md` | why an id fails to ingest, by category |
