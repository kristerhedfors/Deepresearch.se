---
name: arxiv-rag
description: >-
  Load when working on the arXiv RAG search database — harvesting arXiv,
  building or rebuilding the vector index, searching it, or changing the
  retrieval pipeline (scripts/arxiv-*.mjs, public/js/arxiv-rag-core.js,
  docs/ARXIV-RAG.md). Also the go-to for building ANY large local corpus into
  a Berget-embedded RAG database: the OAI-PMH bulk-harvest pattern, the
  binary index pack (why not the committed-JSON artifact shape), the three
  hard Berget serving limits that break long builds (the embedder REJECTS
  over-512-token input rather than truncating, chars/token varies far more
  than a fixed budget can express, and bge-reranker-v2-m3 is served behind the
  same 512-token window covering query+document), and the evaluation
  discipline that keeps a RAG bake-off honest — above all that a small corpus
  saturates every variant to ~98% and measures nothing.
---

# The arXiv RAG search database

A retrieval database over a year of arXiv (~327k papers), embedded with
Berget `intfloat/multilingual-e5-large`, searched from the CLI. Full design,
measurements and operating manual: **`docs/ARXIV-RAG.md`**. This skill is the
working knowledge — what bites, and what not to re-derive.

## The pieces

| Path | Role |
|---|---|
| `public/js/arxiv-rag-core.js` | pure core: passages, tokenizer, BM25, RRF, `denseSearchPacked`, metrics, `recapForContext` |
| `scripts/arxiv-harvest.mjs` | OAI-PMH bulk harvest, month-sharded, resumable |
| `scripts/arxiv-corpus.mjs` | dedup, filter, deterministic hash sampling |
| `scripts/embed-providers.mjs` | the embedding-provider registry: Berget + HF on the SAME model, `auto`/`berget`/`hf`/`both`, failover and the straggler guard |
| `scripts/arxiv-berget.mjs` | the Berget-only surfaces (rerank, JSON chat) |
| `scripts/arxiv-index.mjs` | the binary index pack, resumable |
| `scripts/arxiv-search.mjs` | the four retrieval pipelines, plus `--deep` (the full-text stage) |
| `scripts/arxiv-fulltext.mjs` | tier 2: LaTeX → section chunks → one blob per paper, warmed on demand |
| `scripts/arxiv-fulltext-eval.mjs` | the two-stage-vs-flat measurement behind §9.8 |
| `scripts/arxiv-goldset.mjs`, `arxiv-topical-queries.json`, `arxiv-eval.mjs`, `arxiv-report.mjs` | the measured bake-off |

Built data lives under gitignored `data/`. Never commit it — the vectors alone
are 335 MB.

## arXiv feed facts you should not re-derive

- **Use OAI-PMH, not the Atom query API.** The query API caps a result set
  near 30k rows and pages 100 at a time. `https://oaipmh.arxiv.org/oai`
  `ListRecords&metadataPrefix=arXiv` streams 1000/page behind a resumption
  token with no cap. Roughly 460k records for a year of all-of-arXiv.
- **`from`/`until` filter on the DATESTAMP, not the submission date.** About a
  quarter of a one-year harvest is older papers that got a new version.
- **`<created>` is NOT the v1 submission date on this feed.** It tracks the
  harvest window. `1503.00694` reports `created=2026-07-17`. The only
  trustworthy submission month is the **arXiv id's `YYMM` prefix**.
- **Dedup by id is mandatory** — a paper updated in-window appears in every
  month shard that touched it.
- arXiv answers overload with `503` + `Retry-After`, not a hard rate limit.
  Concurrency 3 across month shards with a 1 s inter-page pause is polite and
  fast enough.

## Berget serving limits that break long builds

All three were found by breaking a run, not by reading a doc.

1. **The embedder rejects over-length input; it does not truncate.** Past 512
   tokens: `400 … maximum context length is 512 tokens`, and the whole batch
   dies. At batch 256 that is 256 papers of work lost to one odd abstract.
2. **No fixed char budget expresses that.** Measured chars/token over real
   abstracts: max 4.67, median 4.26, p5 3.38, and a tail under 2.3 on
   LaTeX-dense and non-Latin-script text. The budget is `MAX_PASSAGE_CHARS =
   1200`, and `recapForContext()` handles the tail by re-deriving the ratio
   from the token count in the error. It must shrink **monotonically** (it
   forces ≥15% per retry) — the first version scaled by the reported ratio
   alone, and because that count belongs to the *densest* input rather than
   the *longest*, it crept a few characters per round and never converged.
3. **`bge-reranker-v2-m3` is served behind the same 512-token window**, and it
   covers query + document together — even though the model natively handles
   8192. Documents are cut to `RERANK_DOC_CHARS = 900`.

**Providers are switchable, and that is the fix for limit 4 below.**
`EMBED_PROVIDER=auto|berget|hf|both` (or `--embed-provider`) routes through
`scripts/embed-providers.mjs`. Both backends serve the same weights — verified
cosine 0.9999–1.0000 against the committed Berget-built index — so vectors are
interchangeable and a half-built index can be finished on the other backend.
**Use `auto`.** `both` does not help this pair: HF runs ~2 passages/s against
Berget's 180–270, so its share is ~1%, under Berget's own ±20% variance, and
an unguarded pool was 8–16% SLOWER because HF's batch latency becomes a tail.
The straggler guard (`EMBED_TAIL_MARGIN`, default 10, on *observed* rates)
makes `both` safe rather than useful; it would pay off only with a second
backend within a few x of the first.

4. **An empty wallet stops everything, and it will happen.** Berget answers
   `402 INSUFFICIENT_WALLET_BALANCE`; it killed an index build and a docs-index
   regeneration in one session. `auto` is the answer — but note the committed
   artifacts (`bundle:rag`, `bundle:docs-rag`, `bundle:owasp-rag`) all route
   through the registry now too, so a doc edit can always be re-bundled.

**Throughput:** ~46–47k prompt-tokens/s sustained at batch 256 × concurrency 8
on real abstracts. Do not capacity-plan from a short-text probe: with ~90-token
inputs the same settings measure ~11.5k tok/s, because that is measuring
request overhead, not the model. That mistake put the first plan off by 4x.

## Evaluation discipline

**A small corpus measures nothing.** The first bake-off ran on 3,000 papers and
every dense variant landed at 97–98% recall@1 — the variants were
indistinguishable. Needle retrieval over a few thousand documents is not a hard
problem. Split the question instead:

- passage/model families → relative ordering, fine at ~20k;
- the retrieval stack (dense / lexical / fusion / rerank) → run it against the
  **full index**, which costs only query embeddings once the index exists
  (`arxiv-eval.mjs --index <dir>`).

**Guard the synthetic gold set against title leakage.** LLM-written "find this
paper" queries will echo the title unless told not to, and then BM25 wins by
string match and the benchmark is meaningless. `arxiv-goldset.mjs` scores every
query's lexical overlap against its paper's title and regenerates once above
0.5; the shipped set's mean overlap is reported with the results.

**Freeze the corpus before generating queries.** The sampler is deterministic
*given a corpus*, but the corpus grows while a harvest runs. Materialize a
JSONL and pass `--corpus-file`. To widen a frozen sample later, build the
larger one as a **superset** so the existing gold set stays valid.

**Watch for fail-soft phases hiding a broken measurement.** Reranking degrades
to the candidate order on error, which is the right contract — but for a while
it did so silently, and the rerank variants reported plausible numbers for a
pipeline that never ran. Log every fallback, and read the log before the table.

**Measure both languages.** A multilingual embedder is only worth its name if
it is measured multilingually (invariant 6). This is where the sharpest finding
came from: see `docs/ARXIV-RAG.md` §4.3.

**Check what the synthetic queries overlap with — the ABSTRACT, not just the
title.** The leak guard here scored queries against titles, and the shipped set
looked clean at 0.30 mean overlap. But the LLM writes from the *abstract*, and
the English queries kept **0.68** of the abstract's vocabulary (Swedish: 0.07,
because the corpus is English). That silently handed BM25 a large head start
and made it look like the English winner. Always measure query-vs-body overlap
before believing a lexical retriever's score on a synthetic set, and keep a
hand-written graded set as the tiebreaker.

## The settled pipeline

Measured over all 326,814 papers, both query families, both languages:

**dense retrieval → `bge-reranker-v2-m3` on the top 50. No lexical arm.**
87% recall@1 / 96% recall@10 English, 81% / 90% Swedish, nDCG@10 0.759 / 0.795.

- **Reranking is the one stage that reliably pays** — +15 points of English
  recall@1 and +17 of Swedish over plain dense, and the only stage that helps
  both languages. ~2 s/query.
- **Fusing BM25 in makes it WORSE on hand-written queries**, in both languages
  (`hybrid_rerank` 0.739/0.751 vs `dense_rerank` 0.759/0.795). Every apparent
  hybrid win lives in the lexically-biased needle family. `hybrid` stays
  available for exact-term lookups; it is not the default.
- **HyDE hurts** — English recall@1 72.1 → 58.6, no topical gain, one extra LLM
  call. Do not re-propose it without new evidence.
- **Dense recall degrades with corpus size**: recall@1 92.1 at 20k → 72.1 at
  327k on the same queries. Reranking buys that back and will matter more as
  the corpus grows.

A mechanism that got retired by measurement: weighting the BM25 arm by the
query's vocabulary coverage of the index, so English could fuse and Swedish
could skip it. Unnecessary — the lexical arm is not something to include
conditionally, it is something to leave out.

## Rebuild recipes

```bash
npm run arxiv:harvest -- --months 12 --out data/arxiv --concurrency 3   # ~25 min
npm run arxiv:corpus                                                     # what did we get
npm run arxiv:index   -- --out data/arxiv/index --strategy title_abstract --bm25   # ~30 min
npm run arxiv:search  -- "your research question"
```

Everything is resumable: rerun the same command and it continues from its
checkpoint. The index writes `docIds` into `passages.json` only when the vector
file is complete, so a half-built pack refuses to be searched instead of
returning nonsense.

## The full-text tier, and its ceiling

Tier 2 holds ~52 body chunks per paper and is warmed ON DEMAND (~€0.0004 and
~5 s per paper). `--deep` runs it: the abstract tier picks 24 candidate papers,
their body chunks are searched and reranked.

**Know the ceiling before promising anything.** Measured over the real 326k
index, a cold body-level question ("what batch size did they use") surfaces its
own paper only **30% of the time in the abstract top-12 and 40% at top-96** —
abstracts do not contain that information, so widening the candidate list
barely helps and the curve is flat past 24. Two-stage is therefore excellent
for *"go deeper on these papers"* (topical discovery works: nDCG 0.759/0.795)
and capped at ~40% for *"find me the paper that did X in section 4"*. The
second use case needs the eager flat build — 13.3M vectors, ~1.2 TB, ~18 h.

Two LaTeX-assembly traps, both found by breaking a real paper:

- A submission is often a thin wrapper plus `\input` fragments. Concatenating
  the `.tex` files and then matching `\begin{document}` finds the WRAPPER's —
  three lines — and discards the paper: 2606.00096 has 100 KB of source and
  yielded 89 characters. Pick the richest real body, then append fragments that
  have no document of their own.
- When NO file declares a document, the promoted fragment must be removed from
  the fragment list, or the paper is emitted twice and every chunk duplicates.

## Extending it

Adding another corpus (PubMed, bioRxiv, a conference proceedings dump) should
reuse `arxiv-rag-core.js` and `arxiv-berget.mjs` wholesale — only the harvester
is source-specific. Keep the passage/query prefix seam in the core so the
builder and the searcher cannot drift.

Wiring this into `/api/chat` as a research source is the **add-research-source**
skill's job, and needs a hosting decision first: 335 MB of vectors does not fit
a Worker, so either Vectorize (which `src/rag.js` already speaks) or an
R2-backed shard read. `docs/ARXIV-RAG.md` §7 has the open questions.
