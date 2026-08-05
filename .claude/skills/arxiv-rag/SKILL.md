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
  saturates every variant to ~98% and measures nothing. ALSO the go-to for
  EVALUATING a change to the corpus or the retrieval pipeline: measuring the
  SERVED path rather than the local pack (they are different pipelines, and
  the published recall figures described the wrong one), carryover gold sets
  sampled by id so the measurement cannot select for papers that retrieve
  well, paired McNemar rather than an independent binomial CI at n=150, and
  why needle and topical results disagree by construction when a corpus grows.
  The PROVIDER-AGNOSTIC
  half of that experience — enumeration cross-validation, checkpointing for
  ephemeral machines, rate-limit citizenship, Vectorize billing and traps, the
  relevance floor — now lives in the **bulk-corpus-etl** skill.
---

# The arXiv RAG search database

A retrieval database over arXiv since late 2023, embedded with Berget
`intfloat/multilingual-e5-large`. Full design, measurements and operating
manual: **`docs/ARXIV-RAG.md`**. This skill is the working knowledge — what
bites, and what not to re-derive.

> **Re-running the ingest is the `arxiv-ingest` skill.** Load that one for the
> procedure — bringing the hosted index up to date after a gap, or rebuilding
> the band from scratch. This skill is what the pipeline IS; that one is how to
> run it again.

> **The generalizable ETL discipline is the `bulk-corpus-etl` skill.** Load that
> one for anything that would apply to a different corpus: enumerating from two
> independent sources (and why one cannot detect its own gaps), "kept" vs unique
> counts, window-boundary bugs, flow control vs failure, incremental upsert as
> the checkpoint, Vectorize's billing model and serialization traps, and the
> relevance floor. This skill keeps only what is specific to arXiv.

**Status (2026-07-29): the abstract tier is BUILT, HOSTED and WIDENED.**
**772,658 vectors** over submission months **2310–2607** — 34 months, 2.3× the
original 13-month build — at **99.6%** per-month index coverage. It stops at
2310 because arXiv's LaTeXML HTML rendering, which is what makes the full-text
tier Worker-native, only exists from late 2023; older papers would need the
3 MB source tarball and gzip+tar, which a Worker cannot do.
`src/arxiv-rag.js` serves it and `src/arxiv.js` falls back to the live API.

**What the widening measured** (docs/ARXIV-RAG.md §11 — the first evaluation of
the SERVED path, not the local pack):

- **Needles: corpus pressure is real, and the pool answers it.** At the old
  pool of 20, 2.3× the corpus cost EN recall@1 78.7 → 72.0 (paired McNemar
  p=0.041). Raising the pool to 50 recovered it (p=0.039; on r@10 it gained 8
  queries and lost **zero**, p=0.008). Shipped-before vs shipped-now is
  statistically indistinguishable (p=0.58) while covering 2.3× the literature.
- **Topical questions got BETTER**: nDCG@10 EN 0.740 → 0.857, SV 0.750 → 0.816.
  The families disagree on purpose — a needle question wants one paper, so more
  literature is more distractors; a topical question wants a good first page,
  and more literature is more relevant work to fill it. Topical is the family
  that reflects real use.
- **The new material is as findable as the old** (new-band needles: EN r@10
  82.7 vs 82.0 carryover).
- **Latency did not move.** Reranking 50 documents costs the same as 20.
- **The recency assumption BROKE.** `src/arxiv.js` says a recency preference was
  a no-op "because every hit in a realistic slice is already inside that window".
  Now **64.9%** of a topical query's top 10 predates 2507 and the median result
  is a year older. Nothing ranks on recency, so the date in each source's
  metadata line is what the synthesis model weighs — which is why
  `arxivRagItem` derives the SUBMISSION month from the id rather than showing
  the stored `d` (last revision). Whether retrieval *should* prefer recent work
  is still unmeasured; the live tier's tried-and-lost date re-sort was keyword
  retrieval over 13 months and does not transfer.

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
| `scripts/arxiv-hosted.mjs` | the Vectorize REST client + a faithful replay of the SERVED path (`src/arxiv-rag.js`) |
| `scripts/arxiv-hosted-eval.mjs` | `sample` / `coverage` / `run` / `compare` / `judge` — the hosted index's own bake-off |
| `scripts/arxiv-crosscheck.mjs` | per-month diff of a harvest against a GCS enumeration |
| `scripts/arxiv-fulltext.mjs` | tier 2: LaTeX → section chunks → one blob per paper, warmed on demand |
| `scripts/arxiv-fulltext-eval.mjs` | the two-stage-vs-flat measurement behind §9.8 |
| `scripts/arxiv-goldset.mjs`, `arxiv-topical-queries.json`, `arxiv-eval.mjs`, `arxiv-report.mjs` | the measured bake-off |

Built data lives under gitignored `data/`. Never commit it — the vectors alone
are 335 MB.

## arXiv feed facts you should not re-derive

**`--until` reproduces a past run; it does NOT slice history (2026-07-29).**
This is the single most expensive trap in the harvester. `planWindow` ties the
id-month keep-filter to the datestamp fetch window, which is correct only when
`until` is today: a paper submitted inside the window then necessarily has its
datestamp inside it too. Carving a historical band breaks that. OAI filters on
the **datestamp**, so a paper submitted 2025-06 and revised in 2026 is
in-window by id and is never REQUESTED.

Harvesting 2310–2506 as `--months 21 --until 2025-07-01` came back **73.5%
complete**, and the loss was graded — 2506 at 59.1%, 2411 at 79.9%, 2402 at
92.1% — because the band's most recent months have had the least time to stop
being revised. Nothing errored. Confirmed rather than inferred: all 14,254
harvested 2506-id papers had `updated <= 2025-07-01`, none past it, a hard cut
at the window edge.

The repair is a SECOND PASS over the datestamps after the band, keeping only
the band's id-months — which is what `--keep-months` exists for:

```bash
node scripts/arxiv-harvest.mjs --months 21 --until 2025-07-01 --out data/arxiv-new   # the band
node scripts/arxiv-harvest.mjs --months 13 --keep-months 2310-2506 --out data/arxiv-rev  # its later revisions
```

**Cross-check every harvest, per month, with `scripts/arxiv-crosscheck.mjs`.**
It diffs harvested ids against a GCS enumeration by month and warns under 95%.
Run it against real data before trusting it — the first run reported 0% on
every month because `arxiv-gcs.mjs --out` writes ids WITH the version suffix
(`2507.23787v2`) while harvested records use the bare id. Both sides normalise
now, but the lesson generalises: a verification tool that has never been run on
real data is not yet a verification tool.

**Enumerate from the GCS mirror, not from OAI-PMH (2026-07-26).** `gs://arxiv-dataset/`
— the bucket behind the Kaggle `Cornell-University/arxiv` dataset — is **publicly
readable with no credentials at all**: plain HTTPS against the JSON API, no
gsutil, no service account, no Kaggle token, and no requester-pays (that is the
separate `s3://arxiv/`, which does bill the downloader). `scripts/arxiv-gcs.mjs`
lists `arxiv/arxiv/pdf/<YYMM>/` and reads ids off the object names.

Measured: **339,388 unique papers across 13 shards in 39 seconds.** The OAI
harvest reported **339,670** for the same window (§1), so two entirely
independent enumerations agree to **0.08%** — which is the reason to trust
either. Against ~15 hours and a harvest that died 29 pages in under sustained
503 flow control, this is not a marginal improvement.

Two traps:

- **The mirror's metadata dump is STALE.** `metadata-v5/arxiv-metadata-oai.json`
  is 4.5 GB of titles and abstracts last updated **2020-08-19**. Only the PDF
  tree is kept current (2607 objects were dated 2026-07-12). The bucket looks
  like a complete metadata solution and is not.
- So abstracts come from **`arxiv.org/html/<id>`**, which carries title,
  abstract, authors AND body — `htmlTitleAbstract` in `scripts/arxiv-html.mjs`.
  One fetch per paper serves both tiers, and neither OAI-PMH nor the
  rate-limited query API is touched. Verified end to end: 6/6 papers yielded
  both tiers from one fetch, and 20/24 became indexed vectors (the shortfall is
  the documented ~87% HTML coverage — three 404s and one sub-200-char abstract).
  The one field the rendering does NOT carry is the primary **category**; the
  submission date is recoverable from the GCS object's own `updated` timestamp,
  the archive is not. Fill it from OAI or the abs page if a build needs facets.

- **Use OAI-PMH, not the Atom query API** *(for metadata harvesting; for
  ENUMERATION prefer GCS above).* The query API caps a result set
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
  fast enough. **That holds for OAI-PMH, not for the query API**: probing
  `export.arxiv.org/api/query` for the live search source (2026-07-26) earned
  plain `429 Too Many Requests` followed by timeouts. Treat a 429/503 there as
  "stop", never as "try the next query" — see the **integrations** skill's
  arXiv section.

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

### Before/after: how to judge a change to the CORPUS or the pipeline

Added 2026-07-29, from widening the window 13 → 34 months. A change of this
kind is judged on four axes, and they can disagree — reporting only one is how
a regression gets shipped as a win.

**1. Hold everything but one variable, and use a CARRYOVER gold set.** The
needles must be papers present in *both* indexes, so the only thing that
changed is the number of distractors. Sample them by id from the independent
enumeration (`arxiv-hosted-eval.mjs sample`), never by querying the index.

**2. Test paired, with McNemar — not an independent binomial CI.** At n=150 the
binomial 95% CI is about ±6.7 points, which calls almost every real effect
noise. The runs share their queries, so the discordant pairs are the evidence:

```js
// for each query: hit@k before vs after → count b (lost) and c (gained)
// two-sided exact binomial at p=0.5 over the b+c discordant pairs
```

Measured this way, effects that looked like noise separated cleanly:

| comparison | verdict |
|---|---|
| corpus 338k → 773k, pool held at 20 | EN r@1 lost 15 / gained 5 — **p=0.041**, real |
| pool 20 → 50, corpus held at 773k | EN r@10 gained 8, lost **0** — **p=0.008** |
| shipped-before → shipped-now | p=0.581 — indistinguishable |

**3. Needle and topical WILL disagree, and topical is the one that matters.**
Widening the corpus made needles worse and topical better:

| | EN needle r@1 | EN topical nDCG@10 |
|---|---|---|
| before | 78.7 | 0.740 |
| after (shipped) | 76.7 | 0.857 |

Not a contradiction. A needle question wants one specific paper, so more
literature is more distractors; a topical question wants a good first page, and
more literature is more genuinely relevant work to fill it. §4 already says
topical "reflects how the database will actually be used" — so a corpus change
that trades needle recall for topical nDCG is a win, and the reverse is not.

**4. Measure what changed about the RESULTS, not just the scores.** `compare`
prints an age profile (`ageProfile`, submission month from the id) because the
widening moved the median result from 2025-12 to 2025-01 and took the share of
results predating the old window from 0% to **64.9%**. No score would have
shown that, and it is what invalidated the "relevance is implicitly recent"
assumption in `src/arxiv.js`.

**Also: verify the corpus before believing any of it.** A 73.5%-complete index
produces confident numbers. Run `arxiv-crosscheck.mjs` (harvest vs enumeration,
per month) and `arxiv-hosted-eval.mjs coverage` (index vs enumeration, per
month) FIRST, and only then the retrieval evaluation.

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

### Served-tier latency: an inherited timeout, not a slow index

The pipeline that measures well offline still has to run inside a search wave,
where its latency is the user's. Reported 2026-07-27 (feedback #44): "the arXiv
searches took close to a minute."

Nothing in the retrieval was slow. `src/arxiv-rag.js` called `embedTexts`,
which is **shared with document indexing and defaults to a 60 s timeout** —
correct for a user watching an upload bar, catastrophic in a wave, where one
slow embedding call holds the whole search. Two things hid it:

- The dense tier had **no whole-call budget** at all; only the reranker was
  bounded.
- `src/arxiv.js`'s ladder budget is measured from *before* the dense tier runs,
  so an overrunning dense tier also silently consumed the live-API fallback's
  budget — the fallback broke out having made zero requests, and the log said
  `arxiv.ladder_budget` rather than anything about embeddings.

The rule to carry forward: **anything called from inside a search wave states
its own timeout rather than inheriting one from a batch/offline path**, and a
tier with several legs states a budget across all of them, not per leg. The
served tier is now embed 6 s + Vectorize query 6 s + rerank 6 s, whole call
12 s, with the rerank skipped (dense order kept) once the earlier legs have
spent it. Vectorize's `query` takes no `AbortSignal`, so its bound is a
`Promise.race` — the only bound available.

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

**Fetch arXiv's HTML rendering first, LaTeX source second.** `arxiv.org/html/<id>`
has existed since late 2023 and covers this whole corpus. Measured over 30
papers: HTML 87% coverage, LaTeX 93%, **either 100%** (they fail on different
papers), and HTML also yields more text (49,902 vs 44,558 chars/paper), finer
sections (26 vs 21) and **7x less transfer** (0.43 MB vs a 3.07 MB tarball).
It needs no gzip and no tar, so the whole ingestion path runs inside a
Cloudflare Worker with `fetch` and string work — which is what makes a
whole-corpus build Cloudflare-native (docs/ARXIV-RAG.md §9.9). An earlier
estimate of "~1.2 TB, needs an AWS account" was anchored on the tarball and was
simply wrong; the real figure is ~140 GB from arxiv.org with no credentials.

One HTML trap: LaTeXML **nests** subsections inside their parent `<section>`,
and a non-greedy `<section>…</section>` match ends at the CHILD's closing tag —
which swallows the child's prose into the parent AND loses the child. Split on
the opening tag instead (what `htmlSections` does), the same shape as
`latexSections`.

**Two extractors, on purpose (2026-07-26).** `scripts/arxiv-html.mjs`
(`htmlSectionsDom`, cheerio over LaTeXML's `ltx_*` classes) is what the
full-text warm path uses; `htmlSections` in the core stays regex-only so the
ingestion path remains runnable inside a Worker (§9.9) and is the fallback.
Adding cheerio breaks no invariant because **no `src/` module imports
`arxiv-rag-core.js`** — `scripts/` is its only consumer, so it is a
devDependency, not a Worker runtime dep. Measured over 9 real papers:

- **Mathematics survives.** LaTeXML puts the original LaTeX in
  `<math alttext="…">`; the regex core strips the element. Math was present in
  3 of 9 papers' output there vs **9 of 9** with the DOM. On a corpus where the
  answer is often the formula, this is the reason to bother.
- **+11% prose** (451,621 vs 406,703 chars) *while also discarding* 66,235 chars
  of bibliography, so genuine-prose gain is nearer +27%.
- **The bibliography leak was a real bug in shipped code** — a citation list
  indexed as prose yields chunks that can only match author surnames, and it was
  16% of the core's output. Now dropped in BOTH extractors.
- Cost ~100 ms/paper vs ~4 ms, irrelevant against ~5 s of embedding.

**There is no mature arXiv-HTML-specific parser to take off the shelf** — worth
knowing before someone goes looking. `ar5iv` *produces* this HTML (a LaTeXML
service), it does not parse it. The mature general options are Python:
Trafilatura drops mathematical formulas entirely (disqualifying), Docling brings
models and a heavy install. A battle-tested DOM library aimed at the `ltx_*`
contract is the real answer. When extending it, add to `UNIT_SELECTOR` rather
than special-casing: a first version selected only
section/subsection/subsubsection and silently dropped `.ltx_appendix`, which
read as a regression on papers carrying appendices.

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

**The pipeline seam is already built and occupied (2026-07-26).** `src/arxiv.js`
is a registered search source serving the LIVE arXiv API — keyword-AND over
abstracts, no hosted index, no key — added because arXiv was reachable by the
CLI and nowhere else, and a real research question about LLM swarm reasoning
ran web-only and cited a bare `arxiv.org/pdf/…` URL with no title. So do NOT
start a second source module for this tier. Everything around retrieval is
already retrieval-agnostic and reusable: the intent predicate, the planner
prompt note, the registry entry, the per-paper diversity key and the item
shape. Promoting THIS database into it means replacing the fetch inside
`arxivSearch` with a Vectorize query (plus the rerank call, which fits the
helper-phase budget and fails soft the same way) and changing nothing else.
Two things to carry over when you do:

- the live tier's measured query traps do not apply to dense retrieval, but its
  **noise stripping still might not** — a dense query wants the natural
  question, not four AND-ed terms. Keep `arxivTerms` for the lexical path and
  pass the raw query to the embedder.
- the live tier's ordering finding (**relevance only; local date re-sorting
  demoted the best papers and the softer bucketed variant was a no-op**) was
  measured on keyword retrieval. Re-measure before importing that conclusion
  into a reranked pipeline; do not assume it transfers.

## Measuring the HOSTED index (not the local pack)

> **Since 2026-08-01 the hosted harness is corpus-agnostic and the procedure
> has its own skill: rag-hillclimb.** `scripts/rag-eval.mjs` measures BOTH
> hosted indexes (arXiv and PubMed) with one instrument, imports the pool and
> floor from `src/dense-rag.js` so a replay can no longer drift from production,
> and implements the paired McNemar that decides every verdict here. Results
> live in the append-only `docs/RAG-EVAL-LEDGER.md`. The arXiv-shaped commands
> below still work; load **rag-hillclimb** for the loop itself, and note its
> two re-measurements of conclusions on this page: the POOL has stopped being
> the constraint at 50 (going to 100 gains nothing and triples latency), and
> the Swedish deficit is significant and lives entirely in the dense stage.


`scripts/arxiv-eval.mjs` measures the binary pack. **That is a different
pipeline from the one users hit**, and quoting its numbers for production is
how §10.7 ended up flagged as unverified for two days. Use
`scripts/arxiv-hosted-eval.mjs`, which replays `src/arxiv-rag.js` over the
Vectorize REST API.

```bash
node scripts/arxiv-hosted-eval.mjs sample   --months 2507-2607 --n 600 --out data/eval/carryover.jsonl
node scripts/arxiv-goldset.mjs --corpus-file data/eval/carryover.jsonl --queries 150 --out data/eval/gold.json
node scripts/arxiv-hosted-eval.mjs run      --gold data/eval/gold.json --label before --pool 20
node scripts/arxiv-hosted-eval.mjs coverage --months 2310-2506 --ids data/eval/gcs-2310-2506.txt
node scripts/arxiv-hosted-eval.mjs compare  --runs data/eval/before.json,data/eval/after.json
node scripts/arxiv-hosted-eval.mjs judge    --runs data/eval/before.json,data/eval/after.json
```

**Sample gold papers by ID from an independent enumeration, never by querying
the index.** Querying selects papers that retrieve well and inflates every
number you then report. `sample` takes ids from the GCS listing and hydrates
them through `get_by_ids`, which also costs zero arXiv requests — usable while
a harvest owns the whole rate budget.

**Read `inPool` before anything else.** It is the share of gold papers dense
retrieval put in front of the cross-encoder at all, and everything right of it
is bounded by it. Measured at 337,768 vectors: EN inPool 82.0 / r@10 81.3 —
i.e. the reranker was finding nearly everything it was shown, and the POOL was
the entire constraint. That is the number that moves when a corpus grows.

### Vectorize limits, measured 2026-07-29

The old "topK caps at 20 with `returnMetadata: all`" is **no longer true**, and
`src/arxiv-rag.js` had been reranking a fifth of the available candidates
because of it (`src/rag.js` still assumes 20 and deserves the same check):

| request | result |
|---|---|
| `topK=50  returnMetadata=all` | 200, 50 matches |
| `topK=100 returnMetadata=all` | 400 "max top K is 50 … retry with returnMetadata=indexed" |
| `topK=100 returnMetadata=none` | 200, 100 matches |
| `topK=200 returnMetadata=none` | 400 "max top K is 100" |
| `get_by_ids` with 100 ids | 400 "40007 too many ids in payload; max id count is 20" |

Raising the pool 20 → 50 bought **+4.0 points of EN recall@10 and +2.0 SV** for
no extra round trip, and the cross-encoder leg did NOT get slower (median 763 →
779 ms) because its cost is request overhead, not document count. Going past 50
needs `returnMetadata: "none"` plus a hydrating `get_by_ids` pass at 20 ids per
call — measured no better, so it is deliberately not done.

**`vectorCount` is eventually consistent.** It lagged the upsert stream by ~6k
vectors / ~2 min during a fill. Never use it to decide a build is complete —
sample `get_by_ids` against an independent enumeration instead.

**Parallelise a fill by partitioning shards, not by editing the script.** Four
`arxiv-vectorize.mjs` processes over disjoint shard directories, each with its
own `--work` checkpoint, took the fill from ~23/s to ~95/s. Seed each group's
`pushed.txt` from any earlier run so nothing is embedded twice. Per batch the
time splits roughly embed 5.7 s / `npx wrangler` spawn 2 s / upload 9 s, so the
upload is the bottleneck and it is byte-bound — do NOT "optimise" it by
rounding the floats, which would make new vectors differ from old ones and
confound any before/after measurement.

## The failure mode this subsystem actually has

Not crashes — **work that reports success while doing nothing, or less than
asked.** Every incident recorded here is this shape:

- a harvest missing 48.1% of a month, exiting 0 (§10.2);
- a harvest missing 26.5% of a band, exiting 0 (`--until`, above);
- `--pause` parsed, validated, and never passed to `harvestShard`;
- `--corpus` pointed at the harvest root printing `done — 0 vectors`;
- a rerank failing soft and SILENTLY, so a whole bake-off reported numbers for
  a pipeline that never ran (§5);
- a cross-check comparing two incompatible id spellings and reporting 0%.

So: make every "nothing to do" path loud, cross-validate against an
independent source rather than the run's own counters, and run a new
verification tool against known-good data before believing its verdict.
