# The arXiv RAG search database

A retrieval database over **every arXiv paper submitted in the last year**,
built with Berget models end to end — `intfloat/multilingual-e5-large` for
embeddings, `BAAI/bge-reranker-v2-m3` for reranking, Mistral Small for the
planning-shaped calls. It exists to be the substrate for deep research on
scientific literature: the pipeline can ask a real corpus a real question
instead of paraphrasing a web search.

This document is the plan, the measurements, and the operating manual. Every
number below came out of `scripts/arxiv-eval.mjs`; where a pipeline was tried
and lost, it is written down as tried and lost rather than quietly dropped.

Status: **experimental, and no longer local-only.** The database is built and
evaluated from the CLI, and its abstract tier is **hosted in Vectorize**
(`deepresearch-se-arxiv`, the `ARXIV_INDEX` binding), served from the Worker by
`src/arxiv-rag.js` — the procedure and its cost are in
[Serving it from the Worker](#serving-it-from-the-worker-the-hosted-tier).
The full-text tier remains a decision memo (§9), not a whole-corpus build,
though its per-paper warm path now runs through a LaTeXML DOM extractor
(`scripts/arxiv-html.mjs`).

**The hosted tier was FILLED on 2026-07-27: 337,768 vectors**, covering 99.47%
of the 339,388 papers an independent enumeration lists for the window. The whole
build took one session — 39 s to enumerate, ~40 min to harvest, 124 min to embed
and upsert — and §10 records what it cost to learn. The provider-agnostic
lessons are the **bulk-corpus-etl** skill.

**arXiv IS searchable from `/api/chat` as of 2026-07-26 — through a different
door.** `src/arxiv.js` is a live-API search source in the pipeline's registry:
it queries arxiv.org directly, needs no hosted index and no key, and its hits
join the numbered source registry like any other. That closed the reported gap
(a research question about LLM swarm reasoning ran five web searches, cited a
bare `arxiv.org/pdf/…` URL with no title, and never asked arXiv). The two tiers
are complementary, not competing: the live API does keyword-AND retrieval over
current metadata, this database does dense retrieval plus a cross-encoder
rerank over a frozen year — measurably better recall. That registry entry was
the seam the RAG tier slotted into: `src/arxiv-rag.js` now serves the hosted
index when it is bound, and `src/arxiv.js` falls back to the live API whenever
it is absent, errors, or returns nothing above the relevance floor.

---

## 1. What got built

| | |
|---|---|
| Window | arXiv submission months **2507–2607** (harvest datestamps 2025-07-26 → 2026-07-26) |
| Harvested | **339,670** in-window papers, from 457,618 OAI records |
| Indexed | **326,814** papers (abstracts under 200 chars dropped) |
| Passages | 326,814 — one vector per paper |
| Vectors | 1024-d, int8-quantized, **335 MB** |
| Metadata | 506 MB `papers.jsonl` + a 1.3 MB uint32 offset index |
| Embedding cost | ~99M prompt tokens ≈ **€3** at Berget's €0.03/1M |
| Build time | ~36 min at a sustained ~40k prompt-tokens/s |
| Lexical index | BM25 over the same text, 722,292 terms |
| Best pipeline | dense → `bge-reranker-v2-m3`: **87% r@1 / 96% r@10** (EN), **81% / 90%** (SV) |

All of it lives under `data/` (gitignored). The code, the query sets and the
measurements are committed; the 840 MB of derived data is not.

### Coverage

Every arXiv archive, in proportion to what arXiv published: cs is the largest
single block (~47% of the sampled corpus), then math, cond-mat, astro-ph,
physics, quant-ph, eess, stat, and the smaller archives behind them.

---

## 2. Pipeline

```
harvest ─→ corpus ─→ passages ─→ embed ─→ int8 pack ─┐
(OAI-PMH)  (JSONL)   (strategy)   (e5)                ├─→ search
                                                      │
                              query ─→ embed ─────────┘─→ [BM25] ─→ [RRF] ─→ [rerank]
```

| Stage | Script | Notes |
|---|---|---|
| Harvest | `scripts/arxiv-harvest.mjs` | OAI-PMH, month-sharded, resumable |
| Corpus | `scripts/arxiv-corpus.mjs` | dedup, filter, deterministic sampling |
| Build | `scripts/arxiv-index.mjs` | passages → embeddings → binary pack |
| Search | `scripts/arxiv-search.mjs` | four retrieval pipelines; `dense_rerank` is the default, `--deep` adds the full-text stage |
| Full text | `scripts/arxiv-fulltext.mjs` | tier 2: HTML (then LaTeX) → section chunks → per-paper blob, warmed on demand |
| HTML sections | `scripts/arxiv-html.mjs` | the build-side LaTeXML extractor (cheerio over `ltx_*`): keeps `<math alttext>` as LaTeX, drops the bibliography, handles LaTeXML's nesting structurally, and `htmlTitleAbstract` supplies tier 1's title/abstract/authors from the same fetch. The core's regex `htmlSections` stays the Worker-native fallback |
| Enumeration | `scripts/arxiv-gcs.mjs` | ids from the PUBLIC `gs://arxiv-dataset/` mirror — no credentials, no rate limit: **339,388 papers in 39 s** vs ~15 h for OAI-PMH. Its metadata dump is stale (2020), so abstracts come from the HTML rendering instead |
| Gold set | `scripts/arxiv-goldset.mjs` | LLM-written needle queries, EN+SV |
| Bake-off | `scripts/arxiv-eval.mjs` | every variant, both query families |
| Pure core | `public/js/arxiv-rag-core.js` | passages, BM25, RRF, pooling, metrics |

The core is shared by the builder, the searcher and the evaluator, so the
pipeline that was measured is the pipeline that runs.

---

## 3. Harvesting

arXiv's Atom query API caps a result set near 30k rows and pages 100 at a
time. OAI-PMH has no such cap: `ListRecords` streams 1000 records per page
behind a resumption token. A year of all-of-arXiv is ~460k records, pulled in
13 month-shards.

**Rate, corrected 2026-07-27.** The harvester ran at concurrency 3 with a 1 s
inter-page pause — about **9× arXiv's published limit** of one request every
three seconds on a single connection, counted across the query API, OAI-PMH and
RSS together. The defaults are now compliant (`--concurrency 1 --pause 3000`).
Wall-clock at that rate is not a fixed number: the same harvest measured
~2.6 min/page while arXiv was throttling this IP (≈15 h for a year) and
completed the whole year in **~40 minutes** the following day. Plan it as an
unattended job and do not calibrate from a run taken during flow control.

Enumeration is a separate question from harvesting, and OAI-PMH is the wrong
tool for it: `scripts/arxiv-gcs.mjs` lists the same window from a public mirror
in **39 seconds**, which is what makes cross-validating the harvest cheap
enough to do every time (§10.2).

Three things about the feed cost real time to discover, and all are load-bearing:

- **`from`/`until` filter on the datestamp, not the submission date.** A
  one-year window also returns decade-old papers that got a v2 last week —
  about a quarter of what comes back.
- **`<created>` in the `arXiv` metadata prefix is not the v1 submission date
  on this feed.** Sampled records show it tracking the harvest window instead:
  `1503.00694` — a March 2015 paper — reports `created=2026-07-17`.

So the submission month is taken from the **arXiv ID's `YYMM` prefix**, which
is the only trustworthy source. Old-style ids (`cs/0503001`) carry no `YYMM`
and are pre-2007 anyway, so the same rule drops them.

- **The two axes must be reconciled at the boundary.** Filtering on datestamp
  while selecting on id-month means a window that starts mid-month silently
  under-covers that month: papers submitted earlier in it are in-window by id
  and never requested. This cost 48.1% of the oldest month and reported itself
  as a successful run — see §10.2. `planWindow` now snaps the start to the
  first of the month.

Records also arrive more than once — a paper updated inside the window appears
in every month shard that touched it — so dedup by id is mandatory rather
than defensive. It also means the harvester's own "kept" counter is **not** a
document count: one run kept 339,263 records that deduplicated to 327,742
papers.

---

## 4. What was measured

Two query families, because they answer different questions.

**Needle** — 140 LLM-written research questions, each with exactly one known
gold paper. Generated by having Mistral Small read an abstract and write the
question it answers. The failure mode that would void this is the model
echoing the title, so every query is scored for lexical overlap against its
paper's title and regenerated once when it overlaps too much. **Mean title
overlap of the shipped set: 0.30, with none above 0.5.** The set is generated
in English and Swedish for every query.

**Topical** — 14 hand-written research questions (`scripts/arxiv-topical-queries.json`),
EN+SV, where many papers are relevant and none is *the* answer. Candidates are
pooled across all variants and graded 0–3 by an LLM judge, then scored with
nDCG@10. This is the family that reflects how the database will actually be
used.

### 4.1 The first bake-off measured nothing

Run one used a 3,000-paper sample. Every dense variant landed at 97–98%
recall@1 and 99–100% recall@10 — the differences between them were inside the
noise. At 3k papers a paraphrased question about a specific abstract is simply
not a hard retrieval problem, and a benchmark where everything wins cannot
choose anything.

It is recorded here because it is the most common way a RAG evaluation lies to
its author, and because it did produce one finding that survived the rescale —
see the Swedish result below.

The design was split in response:

- **Experiment A — passage families** at 20k papers. Which text to embed is a
  question about relative ordering, and it de-saturates by 20k.
- **Experiment B — the retrieval stack** at the full **326,814 papers**.
  Dense vs lexical vs fusion vs rerank is a question about behaviour under
  real corpus pressure, so it runs against the production index.

<!-- RESULTS:A -->
### 4.2 Experiment A — which text to embed (20,000 papers)

| pipeline | EN r@1 | EN r@10 | EN MRR | SV r@1 | SV r@10 | SV MRR | ms/q |
|---|---|---|---|---|---|---|---|
| `dense_ta` | 92.1 | 97.9 | 94.2 | 80 | 93.6 | 84.7 | 76 |
| `dense_abs` | 90.7 | 98.6 | 94.2 | 81.4 | 96.4 | 86.7 | 76 |
| `dense_title` | 72.1 | 91.4 | 79.1 | 65 | 83.6 | 71.5 | 77 |
| `dense_ctx` | 92.1 | 97.9 | 94.6 | 80.7 | 92.9 | 85.2 | 77 |
| `dense_instruct` | 90.7 | 97.1 | 92.9 | 75.7 | 85 | 79.6 | 77 |
| `dense_chunked` | 86.4 | 97.1 | 90.1 | 76.4 | 90.7 | 80.7 | 213 |
| `dense_ta_f32` | 92.1 | 97.9 | 94.2 | 80 | 92.9 | 84.8 | 101 |

20,000 papers · 140 needle queries · 14 topical queries. r@k and MRR are percentages over the needle set; nDCG@10 is over the graded topical set. Binomial standard error on r@10 at n=140 is about ±4.2 points, so treat smaller gaps as ties.
<!-- /RESULTS:A -->

Five things fall out of that table.

**int8 quantization is free.** `dense_ta` and `dense_ta_f32` are the same
pipeline over the same vectors, quantized and not: identical on English
(92.1 / 97.9 / 94.2) and inside the noise on Swedish. Float32 is also *slower*
here — 101 ms/query against 76 — because four times the bytes is four times the
memory traffic in the scan. A 4x smaller index that is faster and ranks the
same is not a trade-off, so int8 is settled.

**The abstract carries the signal; the title alone does not.** Dropping to
titles costs 20 points of recall@1. Whatever else changes, the abstract goes in.

**Adding the title to the abstract is a wash in English and a small loss in
Swedish.** `dense_abs` beats `dense_ta` by 2.8 points of Swedish recall@10
(96.4 vs 93.6) and matches it in English. The gap is around the noise floor,
so it is a lead rather than a conclusion — but the direction is plausible:
titles are terse English noun phrases, and gluing one to an abstract pulls the
passage vector toward English lexical space in a way a Swedish query does not
match. `title_abstract` stays the built default because BM25 and the reranker
both want the title, and both read the same field. Worth a rematch if Swedish
retrieval ever becomes the priority.

**e5-large-instruct is a regression, and specifically a multilingual one.**
English is a point or two down — noise — but Swedish recall@10 drops 8.6
points, 80 → 75.7 on recall@1. The instruct variant is tuned for English
task-prefixed retrieval, and this corpus is queried in two languages. The plain
model wins.

**Chunking abstracts makes retrieval worse and three times slower.** Sliding
700/500-char windows with max-pooling costs 5.7 points of English recall@1 and
runs at 213 ms/query against 76. This is the expected shape once you look at
the corpus: the mean abstract is ~1,200 characters, so a window splits a single
coherent argument into fragments and then asks the pooler to pick one. Chunking
is a technique for documents longer than the embedder's window. An abstract
already fits.

`dense_ctx` — adding categories and author surnames — changes nothing here, but
the needle queries never ask about an author or a category, so this measures
that the extra tokens do no *harm*. Whether they help "that Bengio paper on
diffusion" is a question this query set cannot answer.

<!-- RESULTS:B -->
### 4.3 Experiment B — the retrieval stack at full scale

| pipeline | EN r@1 | EN r@10 | EN MRR | EN nDCG@10 | SV r@1 | SV r@10 | SV MRR | SV nDCG@10 | ms/q |
|---|---|---|---|---|---|---|---|---|---|
| `dense_ta` | 72.1 | 89.3 | 78.4 | 0.711 | 63.6 | 80.7 | 69.6 | 0.713 | 1287 |
| `bm25` | 81.4 | 92.1 | 85.8 | 0.589 | 6.4 | 13.6 | 9.1 | 0.057 | 388 |
| `hybrid` | 82.1 | 95 | 87.2 | 0.702 | 57.9 | 80 | 63.9 | 0.524 | 1581 |
| `dense_rerank` | 87.1 | 95.7 | 90.4 | 0.759 | 80.7 | 90 | 83.9 | 0.795 | 3318 |
| `hybrid_rerank` | 87.9 | 96.4 | 91 | 0.739 | 78.6 | 85 | 80.7 | 0.751 | 3214 |
| `hyde` | 58.6 | 82.9 | 67.8 | 0.708 | 56.4 | 78.6 | 63.2 | 0.741 | 1187 |

326,814 papers · 140 needle queries · 14 topical queries. r@k and MRR are percentages over the needle set; nDCG@10 is over the graded topical set. Binomial standard error on r@10 at n=140 is about ±4.2 points, so treat smaller gaps as ties.
<!-- /RESULTS:B -->

#### Read the two query families against each other

On the needle set, BM25 appears to *beat* dense retrieval in English — 81.4
against 72.1 recall@1 — which is the opposite of what it did at 3k papers. Do
not believe it. Measuring how much of each query's vocabulary appears in the
document it was written from explains the whole effect:

| | overlap with the title | overlap with the **abstract body** |
|---|---|---|
| English queries | 0.30 | **0.68** |
| Swedish queries | 0.04 | **0.07** |

The gold-set guard checked queries against **titles**, which is where an LLM
plagiarises most visibly — but the model writes from the *abstract*, and it
keeps two-thirds of that vocabulary even while paraphrasing the title away.
So the English needle set hands BM25 a large lexical head start by
construction, and the Swedish side hands it nothing at all, because the query
language and the corpus language differ. BM25's 6.4% on Swedish is not a
Swedish-language weakness so much as the honest score for exact-term matching
across languages.

The hand-written topical queries have no such relationship to any document,
and they say something different:

**Reranking wins, and it is the only stage that helps both languages.**
`dense_rerank` is best on every unbiased metric — nDCG@10 of 0.759 English and
**0.795 Swedish**, against 0.711 / 0.713 for plain dense. On the needle set it
adds 15 points of English recall@1 and 17 of Swedish. A cross-encoder that
reads the query and the abstract together recovers exactly what a single
embedding comparison loses, and it does so regardless of the query's language.
It costs about 2 seconds per query.

**The lexical arm should not be in the default pipeline.** On the graded set
BM25 alone scores 0.589 English — well below plain dense — and fusing it in
makes things *worse* than not fusing it, in both languages: `hybrid` 0.702 vs
dense 0.711 English, 0.524 vs 0.713 Swedish; `hybrid_rerank` 0.739 / 0.751 vs
`dense_rerank` 0.759 / 0.795. Every apparent hybrid win lives in the needle
family, which is the family with the lexical bias baked in.

This retired a mechanism that looked worth building. The plan after seeing the
needle numbers was to weight the BM25 arm by how much of the query's vocabulary
the index actually contains, so English could have fusion and Swedish could
skip it. The graded results made it unnecessary: the lexical arm is not
something to include conditionally, it is something to leave out. `hybrid`
stays available behind `--pipeline` because exact-term lookups (an acronym, a
method name, an author) are a real use the topical set does not cover — but it
is not the default, and the reason is measured rather than assumed.

**HyDE actively hurts.** Having the model write a hypothetical abstract before
searching drops English recall@1 from 72.1 to 58.6 and leaves the topical
scores unchanged (0.708 vs 0.711). For finding a *specific* paper, the invented
abstract's details pull the query vector toward a paper that does not exist.
It also adds an LLM call per query. Nothing here pays for it.

**Recall degrades with corpus size, as it must.** Plain dense recall@1 falls
92.1 → 72.1 between 20k and 327k papers on the same queries. That is the number
to hold on to when reasoning about growth: reranking is what buys it back, and
it will matter more, not less, as the corpus grows.

### 4.4 What the database is actually good at

Putting both experiments together, the shipped answer is
**one int8 vector per paper over title + abstract, retrieved dense, reranked
with `bge-reranker-v2-m3`** — 87% recall@1 and 96% recall@10 against 327k
papers in English, 81% and 90% in Swedish, nDCG@10 near 0.8 in both.

Concretely, this means:

- **Asking for a specific paper you half-remember works**, in either language,
  and a Swedish question finds English papers — the reason for a multilingual
  embedder rather than an English one.
- **Topical survey questions return a usable first page.** nDCG@10 ≈ 0.78 means
  the top ten are mostly graded 2–3, not that they are perfect.
- **Exact-string lookups are the weak spot of the default.** An acronym or a
  method name is what `--pipeline hybrid` is for.
- **Anything needing the paper's body is out of scope.** The index holds
  titles and abstracts. A question whose answer lives in section 4 cannot be
  retrieved here — that would be a full-text corpus, a different build.

---

## 5. Provider constraints found the hard way

Three things about Berget's serving of these models are not in any doc and
each one broke a run:

**The embedder rejects over-length input, it does not truncate it.** Past 512
tokens the API answers `400 … maximum context length is 512 tokens` and the
whole batch dies. On a 326k-paper build a single unusual abstract would
otherwise take out 256 papers' worth of work.

**A fixed character budget cannot express that limit.** Measured over real
abstracts, chars/token runs from 4.67 down through a median of 4.26 to a p5 of
3.38 — and the tail on LaTeX-dense and non-Latin-script abstracts goes below
2.9. The original 1600-char budget produced 568-token inputs. The budget is now
1200 chars, and `recapForContext()` re-derives the true ratio from the token
count in the error and re-caps only the offending texts, retrying up to four
times.

**The reranker has the same 512-token window** — `bge-reranker-v2-m3` handles
8192 natively, but this deployment does not, and the window covers query and
document *together*. Feeding it 2000-char abstracts made every rerank call
fail, and because reranking fails soft, the variant silently degraded to its
candidate order and reported plausible numbers. Documents are now cut to 900
chars before reranking, so the cross-encoder judges on a title plus roughly the
first two-thirds of an abstract.

That third one is worth dwelling on: a fail-soft helper phase that is also
*silent* will happily report a measurement of something else. The rerank path
now logs every fallback.

### Switching embedding providers

Both `intfloat/multilingual-e5-large` backends serve the *same weights*, so
their vectors are interchangeable and an index may be built by either — or by
both in one run. That is measured, not assumed: re-embedding chunks of the
committed Berget-built index through Hugging Face and comparing against the
stored vectors gives **cosine 0.9999–1.0000**. A provider switch that changed
the vectors would silently corrupt any index built across both, so the
registry (`scripts/embed-providers.mjs`) is the one place either backend is
reached from.

```bash
EMBED_PROVIDER=auto   …   # default: Berget, failing over to HF mid-build
EMBED_PROVIDER=berget …
EMBED_PROVIDER=hf     …
EMBED_PROVIDER=both   …   # both at once, work-stealing
npm run arxiv:index -- --embed-provider hf         # or the per-command flag
npm run arxiv:search -- --embed-provider hf "…"
```

**Use `auto`.** It is the mode that earns its place: an empty Berget wallet
(`402 INSUFFICIENT_WALLET_BALANCE`) killed both an arXiv index build and a
docs-index regeneration on 2026-07-26, and under `auto` each would have
finished on Hugging Face instead.

**`both` does not speed this pair up.** Measured on real 1100-char passages:

| | passages/s |
|---|---|
| Berget alone | 180–270 (its own run-to-run variance is ±20%) |
| HF Inference alone | ~2 |

HF's share of a mixed job is about 1% — below Berget's own variance, so the
difference is not resolvable. Worse, a naive pool is *slower*: HF's batch
latency becomes a tail the fast provider waits on, which made a
12,000-passage run 8–16% slower than Berget alone. The pool therefore carries
a **straggler guard** — a non-primary provider only takes a batch when the
remaining work is at least `EMBED_TAIL_MARGIN` (default 10) times the batch's
expected duration, using each provider's *observed* rate rather than a static
guess. With the guard, `both` matches `berget` exactly and never loses. It
would pay off with a second backend within a few x of the first — a second
Berget key, or a self-hosted TEI — which is why the mode exists.

Reranking and JSON-mode chat stay Berget-only: HF Inference does not serve
`bge-reranker-v2-m3` on the sentence-similarity shape (400, measured).

### Throughput

| Batch × concurrency | Sustained |
|---|---|
| 256 × 8, short inputs | ~11.5k prompt-tokens/s |
| 256 × 8, real abstracts | **~46–47k prompt-tokens/s** |

The short-input probe measures request overhead, not the model — a caution
worth repeating, since the first capacity plan was built on it and was off by
4x. Raising concurrency past 8 did not go faster.

---

## 6. Operating it

```bash
# 1. Harvest the last year (resumable — rerun to continue; see the timing note)
npm run arxiv:harvest -- --months 12 --out data/arxiv

# 2. What did we get?
npm run arxiv:corpus

# 3. Build the index (~30 min for 326k papers, resumable)
npm run arxiv:index -- --out data/arxiv/index --strategy title_abstract --bm25

# 4. Search it
npm run arxiv:search -- "how can LLM applications provably protect user data"
npm run arxiv:search -- --top 10 "kvantfelkorrigering med ytkoder"      # Swedish works
npm run arxiv:search -- --pipeline dense "fast path, skips the reranker"
npm run arxiv:search -- --pipeline hybrid "MaskSQL"                      # exact-term lookup
npm run arxiv:search -- --deep "what batch size did they train with"     # + full-text stage
npm run arxiv:fulltext -- 2607.00042 2606.01131                          # pre-warm papers
npm run arxiv:fulltext -- --stats
```

**Timing, corrected 2026-07-26.** The "~25 min" harvest assumed
`--concurrency 3` with a 1 s inter-page pause — about **9x** arXiv's published
rate (the API Terms of Use ask for one request every three seconds on a single
connection, counted across OAI-PMH and the query API together). The defaults
are now terms-compliant, and at that rate one page of ~1300 records takes about
2.6 minutes end to end, so **a full year is roughly 15 hours**, not 25 minutes.
Plan it as an unattended background job rather than a step inside a session. It
resumes per month shard and the shards run newest-first, so an interrupted run
still leaves the most recent months complete — which is what most "latest
research" questions want anyway.

### Serving it from the Worker (the hosted tier)

The pack above is what the CLI bake-off searches. To make the corpus reachable
from `/api/chat` there is no 335 MB file to host anywhere — push the vectors to
Vectorize instead:

```bash
npx wrangler vectorize create deepresearch-se-arxiv --dimensions=1024 --metric=cosine
NODE_USE_ENV_PROXY=1 node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv
```

`scripts/arxiv-vectorize.mjs` embeds the harvested corpus and upserts it
**incrementally**, checkpointing after each batch, because the machine running
it is usually ephemeral: Vectorize is the durable store and a re-run skips
everything already pushed, so re-running after any interruption is always the
right move. `--limit N` pushes a slice first; `--dry-run` embeds without
uploading (and deliberately does not checkpoint, or the next real run would
skip rows it never uploaded).

`NODE_USE_ENV_PROXY=1` is required behind an agent proxy: Node's built-in fetch
ignores `HTTPS_PROXY` without it, and every embedding call then fails with a
503 "DNS resolution failure" that reads exactly like Berget being down.

Then declare the `ARXIV_INDEX` binding in `wrangler.toml` and `src/arxiv-rag.js`
serves dense retrieval, with `src/arxiv.js` falling back to the live arXiv API
whenever the index is absent, errors, or returns nothing above its relevance
floor. Cost at this corpus size is about **$3-4/month** (Vectorize bills
`(stored_vectors + monthly_queries) × dimensions`, so the index size is charged
once per month rather than per query) plus a one-time ~€3 of Berget embeddings.

**The served tier states its own time budget** (added 2026-07-27). It runs
inside a search wave, so its latency is the user's latency, and every leg is
bounded: embed 6 s, Vectorize query 6 s, rerank 6 s, whole call 12 s — the
rerank is skipped rather than started once the earlier legs have spent the
budget, keeping the dense order instead. That exists because of what it
replaced. `embedTexts` is shared with document indexing and defaults to a
**60 s** timeout, which is right for a user watching an upload progress bar
and catastrophic inside a wave: one slow embedding call held an arXiv search
for close to a minute (feedback #44, 2026-07-27). Nothing caught it, because
`arxiv.js`'s ladder budget is measured from *before* the dense tier runs — so
an overrunning dense tier silently consumed the live-API fallback's budget as
well. Any future call made from inside a wave should pass its own `timeoutMs`
rather than inherit an indexing default.

Rebuilding the evaluation:

```bash
npm run arxiv:goldset -- --corpus-file data/arxiv/eval-sample.jsonl --queries 140
npm run arxiv:eval -- --corpus-file data/arxiv/eval-sample-20k.jsonl --variants dense_ta,dense_abs,dense_title,dense_ctx,dense_instruct,dense_chunked,dense_ta_f32
npm run arxiv:eval -- --index data/arxiv/index --variants dense_ta,bm25,hybrid,dense_rerank,hybrid_rerank,hyde --judge
```

Everything is resumable and everything is deterministic given a seed. The
sampler is a hash of the arXiv id, so "the 20k sample" is the same 20k papers
on every machine — an evaluation that resampled between variants would be
measuring the sample rather than the pipeline.

### Index layout

```
data/arxiv/index/
  vectors.i8      N × 1024 raw int8, row-major; row i is passage i
  passages.json   model, dims, strategy + docIds[i] → arXiv id
  papers.jsonl    one paper per line, sorted by id
  papers.idx      uint32 byte offset per line
  bm25.json       the lexical index (only with --bm25)
```

This is deliberately **not** the committed-JSON-artifact shape the rest of the
repo uses for RAG indexes (`public/introspect/*-rag.json`). That convention is
built for small corpora a browser fetches whole; here, base64-in-JSON would add
a third again to 335 MB of vectors and force a full parse to answer one query.
The binary pack is read as a `Buffer` and viewed as an `Int8Array` with no copy
and no parse. `papers.idx` means a hit reads one line rather than half a
gigabyte of abstracts.

Search is a **brute-force scan** — no ANN index. At this corpus size one full
scan is a few hundred milliseconds in plain JS, and an approximate structure
would add a dependency, a build step and recall loss to solve a problem that
does not exist yet. Above roughly a million passages that stops being true.

---

## 7. What this is for

The point of the database is deep research over scientific literature, which
means the next step is a research source in the pipeline (the
**add-research-source** skill has the end-to-end shape: intent routing, the
triage-prompt layer, registry and diversity wiring, SSE visibility, the
validation ladder).

**That source now exists** (`src/arxiv.js`, 2026-07-26) — but it serves the
LIVE arXiv API, not this database, precisely because question 1 below is still
open. Everything the source built is reusable by this tier: the intent
predicate, the planner prompt note, the registry entry, the per-paper diversity
key and the item shape are all retrieval-agnostic, so promoting the RAG index
into it means replacing the fetch inside `arxivSearch` and nothing else. What
the live tier does NOT give is this database's measured recall: keyword-AND over
abstracts is a much blunter instrument than dense retrieval plus a
cross-encoder rerank, and it cannot answer a question whose phrasing shares no
vocabulary with the paper.

Three things have to be decided before this tier serves traffic, and the
measurements above decide two of them:

1. **Where the index lives.** 335 MB of vectors and 506 MB of metadata do not
   fit a Worker. Either Vectorize (which `src/rag.js` already speaks, at
   ~326k vectors) or an R2-backed shard read. Vectorize also removes the
   brute-force scan. **Answered in §9:** Vectorize for the abstract tier — at
   327k vectors it uses 3% of one index — and R2 blobs for the full-text tier,
   which needs no global ANN at all.
2. **Which pipeline serves it** — settled: dense retrieval plus a
   cross-encoder rerank, no lexical arm (§4.3). The rerank is one extra
   provider call of about 2 s, which fits the existing helper-phase budget and
   fails soft the same way.
3. **How freshness is maintained.** The harvester is incremental by
   construction: re-running with a narrow window and appending to the pack is a
   day's worth of new papers, not a rebuild.

There is also a capacity argument, established while wiring the live tier.
arXiv's API Terms of Use ask for **one request every three seconds, single
connection**, counted across the query API, OAI-PMH and RSS together — and
there is no paid tier to buy past it (bulk access is open, commercial projects
need no MOU and are only encouraged to sponsor; the one escalation path is to
ask support). The live tier therefore runs on a deliberately small request
budget. A hosted index removes arXiv from the request path entirely, which is
the only real answer if this source ever carries volume.

The privacy posture matters too, and it is favourable: unlike web search, this
corpus is **local**. A query against it never leaves the machine except as an
embedding call, and on the Se/cure tier that call can be browser-direct. A
research source that does not have to tell a third party what the user is
researching is exactly the kind of thing this project exists to demonstrate.

---

## 8. Files

| Path | What |
|---|---|
| `public/js/arxiv-rag-core.js` | pure core: passages, tokenizer, BM25, RRF, pooling, metrics, shard validation |
| `public/js/arxiv-rag-core.test.js` | unit tests for all of it |
| `scripts/arxiv-harvest.mjs` | OAI-PMH harvester |
| `scripts/arxiv-harvest.test.mjs` | unit tests for the harvest/sample/gold-set pure logic |
| `scripts/arxiv-corpus.mjs` | corpus loading, dedup, deterministic sampling |
| `scripts/arxiv-berget.mjs` | Berget client: embeddings, rerank, JSON chat, adaptive re-truncation |
| `scripts/arxiv-index.mjs` | the index builder |
| `scripts/arxiv-search.mjs` | the search CLI |
| `scripts/arxiv-goldset.mjs` | needle gold-set generation |
| `scripts/arxiv-topical-queries.json` | the hand-written EN/SV topical set |
| `scripts/arxiv-eval.mjs` | the bake-off |

---

## 9. The full-text build — decision memo

The abstract tier answers "which papers are relevant". It cannot answer
"what does section 4 say", and that is the question deep research on
scientific data actually needs. This section is the plan for the full-text
tier: what was measured, which options were rejected, and what to build.

Every number below comes from real papers pulled off arXiv, not from
estimates. The probes are `/tmp` scratch scripts, not committed; the
measurements they produced are.

### 9.1 What a paper actually yields

Measured over 138 papers sampled across the corpus (18 for extraction yield,
120 for chunk structure), fetched as LaTeX source from `export.arxiv.org/e-print`:

| | |
|---|---|
| Papers with usable LaTeX source | **78%** (the rest are PDF-only or oddly packaged) |
| Body text per paper | mean **49,788** chars, median 48,236 — **~40x the abstract** |
| Section-aware chunks per paper (1100 chars) | mean **52.3**, median 49, p90 85 |
| Chunks that carry a section heading | **98.6%** |
| Papers where `\section` parsing found nothing | 4 / 120 |
| Source tarball | mean 3.07 MB, median 0.85 MB |

Section structure survives extraction well, so chunks can carry their heading
as context rather than being blind windows.

### 9.2 What the whole-corpus build would cost

Projecting those measurements onto the 326,814-paper corpus:

| | |
|---|---|
| Papers with full text | ~255,000 |
| Full-text vectors | **13.3M** |
| Embedding tokens | **2.98B** |
| Embedding cost | **~€89** |
| Embedding time at 46k tok/s | **~18 h** |
| int8 vectors | 13.6 GB |
| Chunk text | 12.7 GB |
| Source download | **~1.2 TB** (arXiv's own figure: ~100 GB/month of `src`) |

Two of those numbers are structural rather than merely large:

**13.3M vectors exceeds Vectorize's 10,000,000-per-index limit.** A whole-corpus
flat full-text index cannot be one Vectorize index. It can be two — the account
limit is 50,000 indexes — but that means fanning every query out and merging.

**~1.2 TB of *source tarballs* has to come from arXiv's S3 requester-pays
bucket**, not from `export.arxiv.org`. (§9.9 revisits this: the tarball is the
wrong thing to fetch, and the real figure is ~7x smaller with no AWS at all.) arXiv groups `src` into ~500 MB tars keyed by month
(`src/arXiv_src_2507_001.tar` …) with a manifest, so a one-year slice is
directly selectable — but the downloader pays AWS egress, roughly $110 for
the year. Pulling 255,000 papers one at a time off the public endpoint would
be roughly 113 hours of sustained requests and is exactly the abuse the S3
bucket exists to prevent. Per-paper fetching is fine at research-run rates;
it is not fine as a bulk-build strategy.

### 9.3 Retrieval shape: two-stage, not flat

**Do not let full-text chunks compete with abstracts for discovery.** An
abstract is an author-written summary optimized for precisely the "is this
paper relevant" question; a chunk from someone's experimental setup is not.
In one flat ranking a tangential mid-paper chunk outranks the right paper's
abstract, and the corpus grows 40x, which is the direction that already hurts:
measured, dense recall@1 fell 92.1 → 72.1 going from 20k to 327k units (§4.3).
A flat 13.3M-chunk index is another 40x on top of that.

So:

```
stage 1  question → abstract index (327k) → top ~20 candidate PAPERS
stage 2  question → chunks of those papers only → top ~10 PASSAGES → rerank
```

Stage 1 is the pipeline already measured at 87% r@1 / 96% r@10. Stage 2 never
searches globally, which is what makes the hosting decision easy.

> **This was measured afterwards, and the argument above is partly wrong.**
> See §9.8: two-stage does not beat flat, and the reason is a hard ceiling in
> stage 1 that the reasoning above did not anticipate. The shape still ships,
> for the reasons §9.8 sets out, but with a scope the original argument
> did not state.

### 9.4 Where each tier lives

| Tier | Contents | Home | Why |
|---|---|---|---|
| 1 — discovery | 326,814 abstract vectors | **Vectorize** | needs global ANN; 327k is 3% of one index's cap, ~$0.17/mo of stored dimensions; `src/rag.js` already speaks it |
| 2 — depth | per-paper chunk vectors + text | **R2, keyed by paper id** | never searched globally, so no ANN and no 10M cap; ~101 KB per paper (52 KB int8 + 49 KB text) |

Stage 2 fetches the blobs for its ~20 candidate papers — about 2 MB — and
scans ~1,000 vectors in the Worker. That is nothing against a 5-minute CPU
budget. It also sidesteps the Vectorize per-index ceiling entirely: the
full-text tier can grow past 13.3M vectors without ever becoming an
architecture problem.

### 9.5 The three ways to fill tier 2

| | Coverage | Download | Embed | Vectors | Fits one Vectorize index? |
|---|---|---|---|---|---|
| **A. Eager, everything** | all 255k papers | ~1.2 TB / ~$110 | €89, 18 h | 13.3M | no (needs 2, or R2) |
| **B. Eager, `cs.*` slice** | ~120k papers | ~370 GB / ~$35 | €42, ~8 h | 6.3M | yes |
| **C. On demand, cached** | whatever gets read | ~3 MB per paper | €0.0004 per paper | grows with use | n/a |

**Recommendation: C, with B as an optional warm start.**

C costs about €0.004 and roughly 5 seconds for a ten-paper deep read, cached
after that; it needs no AWS account, no 1.2 TB of transfer, and no bulk
crawling. Cost is proportional to use rather than to the corpus, and the cache
warms exactly where the research actually goes. Under the two-stage shape it
is not a compromise: stage 2 only ever looks at candidate papers, so a paper
that has never been read has cost nothing by not being indexed.

B is worth adding only if instant depth in the site's own subject areas
matters more than the ~$35 and the 8 hours.

A buys very little that C does not, and costs 1.2 TB, an AWS account, and a
Vectorize sharding problem to buy it.

### 9.6 Decided, along the way

- **LaTeX source, not PDF.** 78% yield, section headings intact in 98.6% of
  chunks, math preserved, no column/ligature garbling. PDF extraction is the
  fallback for the remaining 22% and needs a extractor this container does not
  have. The ~300 GB Hugging Face LaTeX mirrors were rejected on size and on
  unverified coverage of the last year.
- **Section-aware chunks of ~1100 chars, heading prepended.** Measured, not
  assumed: `\section` parsing worked on 116 of 120 papers.
- **No full-text BM25.** The abstract-tier BM25 is already 401 MB of JSON for
  327k documents; at 40x the text it would be tens of gigabytes — to add a
  retrieval arm that §4.3 measured as *harmful* on unbiased queries.
- **Keep the reranker.** It is the one stage that reliably pays, and its
  50-document depth is exactly Vectorize's `topK` ceiling with metadata.

### 9.7 Blocked on

- **Berget wallet is empty** (`402 INSUFFICIENT_WALLET_BALANCE`, confirmed
  2026-07-26). No further embedding of any kind runs until it is topped up —
  including the §9.3 validation.
- For option A or B only: an AWS account for requester-pays S3, and a build
  host with the transfer budget and ~30 GB of disk.

### 9.8 The full-text tier, measured — and where §9.3 was wrong

§9.3 argued that a flat full-text index would be *worse* than two-stage for
discovery, because mid-paper chunks would crowd out abstracts. That argument
was never tested. It is now (`scripts/arxiv-fulltext-eval.mjs`), and it does
not survive: 60 LLM-written **body-level** questions — drawn from real chunks,
skipping introduction/related-work/conclusion sections so the answer genuinely
is not in the abstract — over 120 warmed papers and 7,194 body chunks.

| pipeline | chunk r@1 | r@5 | r@10 | MRR | stage-1 ceiling |
|---|---|---|---|---|---|
| flat (all chunks compete) | 63.3 | 86.7 | 90.0 | 73.9 | — |
| two-stage, top-6 papers | 45.0 | 65.0 | 66.7 | 53.2 | 70% |
| two-stage, top-12 | 48.3 | 70.0 | 71.7 | 57.4 | 78.3% |
| two-stage, top-24 | 56.7 | 76.7 | 80.0 | 65.7 | 90% |
| two-stage, top-48 | 60.0 | 83.3 | 86.7 | 70.7 | 96.7% |
| two-stage, top-96 | 63.3 | 86.7 | 90.0 | 73.9 | 100% |

Two-stage converges on flat exactly as its candidate list grows, and **the
entire gap is the stage-1 ceiling** — the share of questions whose paper the
abstract stage surfaced at all. Within the candidate set, stage 2 is close to
perfect; nothing is lost to chunks competing with each other. §9.3's stated
mechanism was simply not the operative one.

#### The number that actually matters

Those ceilings come from a 120-paper experiment, where the gold paper is one of
120. Run the same questions against the **real 326,814-paper index**:

| candidates | body question surfaces its own paper |
|---|---|
| top-6 | **28.3%** |
| top-12 | **30.0%** |
| top-24 | **36.7%** |
| top-48 | **38.3%** |
| top-96 | **40.0%** |

**Two-stage caps at roughly 40% for cold body-level questions at real corpus
scale, however good stage 2 is.** An abstract does not say what batch size the
experiments used, so no amount of candidate widening finds the paper from that
question — the curve is nearly flat from 24 onward. This is a property of
abstracts, not a tuning problem.

#### What that changes

**It does not retire the on-demand tier — it scopes it.** The two flows are
different, and only one of them is capped:

- **"Go deeper on these papers"** — the actual deep-research flow. Papers are
  found by a *topical* question, which the abstract tier is good at (nDCG@10
  0.759 EN / 0.795 SV, §4.3); the body search then runs inside that set and is
  near-perfect. This works today, costs ~€0.0004 and ~5 s per uncached paper,
  and is what `--deep` ships.
- **"Find me the paper that used batch size 128"** — a cold body-level lookup
  across the whole corpus. This is the ~40% case, and no amount of on-demand
  warming fixes it. It needs the eager flat build: 13.3M vectors, ~1.2 TB of
  source, ~18 h, ~€89, and two Vectorize indexes (§9.2).

So the recommendation holds with its scope stated: **ship on demand, know it
answers the first question and not the second.** The eager build stays the
upgrade path, and §9.2 still has its price.

`--deep` defaults to **24 candidate papers**: the real-index ceiling is 30% at
12, 36.7% at 24 and only 38.3% at 48, so doubling past 24 doubles the
cold-cache warming cost for under two points.

#### Reproducing it

```bash
node scripts/arxiv-fulltext-eval.mjs --papers 120 --questions 60 --index data/arxiv/index
```

Warms 120 papers, generates body questions from their chunks, and prints both
the in-experiment ceiling and the real-index one. Roughly €0.15 and ~6 minutes.

### 9.9 It is Cloudflare-native after all — the 1.2 TB was the wrong number

§9.2 priced the whole-corpus build at ~1.2 TB of transfer out of arXiv's
requester-pays S3 bucket, and called an AWS account a prerequisite. That was
wrong, and the reason is worth stating plainly: it assumed the only way to get
a paper's body is its **LaTeX source tarball**. It is not. arXiv has published
a LaTeXML **HTML rendering** of every submission since late 2023 — which covers
this entire corpus — at `arxiv.org/html/<id>`, with no credentials.

Measured over 30 papers spread across the corpus, HTML against the shipped
LaTeX path:

| | HTML | LaTeX source |
|---|---|---|
| Coverage | 87% | 93% |
| **Either one** | **100%** | |
| Body text per paper | **49,902 chars** | 44,558 |
| Sections per paper | **26.0** | 20.9 |
| Transfer per paper | **0.43 MB** | 3.07 MB |

They fail on *different* papers — four were LaTeX-only, two HTML-only, none
missed both — so trying HTML then falling back to LaTeX covers everything, and
the on-demand tier now does exactly that. It also lifts the tier's own
coverage from the 78% §9.1 measured to effectively 100%.

#### What that does to the whole-corpus build

| | §9.2 said | actually |
|---|---|---|
| Transfer | ~1.2 TB from S3 | **~140 GB** from `arxiv.org`, no credentials |
| AWS account | required | **not needed** |
| Unpacking | gzip + tar per paper | none — `fetch` and string work |
| Stored | 26 GB | ~30 GB (HTML yields more text) |
| Embedding | ~18 h, ~€89 | unchanged |

And nothing in it needs a machine outside Cloudflare:

| Stage | Runs on | Binding |
|---|---|---|
| Fetch `arxiv.org/html/<id>` | Worker `fetch` | — |
| Strip + section-chunk | `htmlSections` / `chunkSections`, pure JS | — |
| Embed | Berget, as `/api/embed` already does | existing secret |
| Store text + vectors | R2 | **`STORAGE`, already bound** |
| Global ANN, if wanted | Vectorize | **`RAG_INDEX`, already bound** |

The 5-minute CPU limit is already configured (`wrangler.toml [limits]`), and a
0.43 MB string is nothing against a Worker's 128 MB.

#### The one real ceiling, and it is not structural

A flat full-text index over the corpus is ~14.7M vectors against Vectorize's
**10M per index**. §9.2 called that structural; it is not. The account limit is
50,000 indexes, so the honest description is "two indexes and a merge step",
at ~$7.50/month of stored dimensions. Worth knowing, not worth being blocked by.

#### The minimal-additions plan

Given that, the smallest thing that gets a whole-corpus full-text tier is:

1. **One `[triggers] crons` block** in `wrangler.toml` — the only new
   configuration. No new resource.
2. A cron handler that walks the corpus, fetches HTML, chunks, embeds and
   writes R2 blobs, keeping its cursor in R2. Everything it calls already
   exists in `public/js/arxiv-rag-core.js`.
3. Optionally a second Vectorize index, and only if cold body-level search
   across the whole corpus is wanted — the two-stage path (§9.8) needs no ANN
   for tier 2 at all.

Two ways to fill it, and the second is nicer:

- **Backfill**: ~327k papers at a polite 1–2 requests/second is a few days of
  cron ticks. Steady and unattended, but it is still a bulk crawl of a public
  endpoint, so it deserves a note to arXiv first.
- **Accrue forward**: arXiv publishes ~1,000 papers/day. A cron that ingests
  each day's new submissions is ~1,000 requests/day — unambiguously ordinary
  use — and after a year the tier is complete, with the on-demand path (already
  shipped) covering anything older that someone actually asks for. No bulk
  crawl, no backfill, no decision to make.

**Recommendation: accrue forward, and let on demand cover the tail.** It needs
one cron block, no new bindings, no AWS, and no conversation with arXiv.

---

## 10. The hosted build — what actually happened (2026-07-26/27)

§1 records the first CLI build. This section records filling the **hosted**
tier, because most of it was learned by getting it wrong first. The
provider-agnostic version of these lessons is the **bulk-corpus-etl** skill;
this is the arXiv-specific log.

### 10.1 The numbers

| | |
|---|---|
| Enumerated (GCS listing) | **339,388** papers, 13 shards, **39 seconds** |
| Harvested (OAI-PMH) | **350,682** records kept → **339,161 unique** |
| Indexed | **337,768** vectors (1,393 below the 200-char abstract floor) |
| Coverage vs enumeration | **99.47%** |
| Harvest time | ~40 min |
| Embed + upsert time | **123.7 min** at ~23 vectors/s |
| Cost | ~€3 of Berget embeddings + ~$3-4/month Vectorize |

### 10.2 Two enumerations, because one cannot check itself

The harvest reported `339,263 in-window papers kept` and exited 0. Diffing its
ids against the GCS listing month by month found **48.1% of the oldest month
missing** (11,432 of 23,780) while every other month sat at ~0.1%.

The cause was a boundary between two notions of "in window": the fetch window
filtered on **datestamp** from `today − 12 months` (a mid-month date), while the
keep filter admitted a whole **id-month**. Papers submitted earlier in that
month were in-window by id and never requested — so nothing errored and the
run's own totals were self-consistent.

Fixed by snapping the window start to the first of the month
(`planWindow`, regression-tested). Re-harvesting that shard took it from 3,495
to 14,914 papers and lifted overlap from 96.52% to **99.88%**.

Two corollaries worth keeping:

- **"Kept" is not "unique".** The same run's 339,263 kept were 327,742 unique —
  a paper revised in-window appears in every shard it touched.
- **Compare by subgroup.** The totals looked like agreement to 0.04%. Only the
  per-month breakdown exposed the hole.

### 10.3 The channels, and which is for what

- **`gs://arxiv-dataset/` is public — no credentials at all.** Plain HTTPS
  against the JSON API; no gsutil, no service account, no Kaggle token, no
  requester-pays. It gives **enumeration** (and PDFs), 1000 objects per page.
- **Its metadata dump is stale.** `metadata-v5/arxiv-metadata-oai.json` is
  4.5 GB last updated **2020-08-19** while the PDF tree is current. Freshness is
  a property of the path, not the bucket — building abstracts from it would have
  produced a six-year-old index that looked fine.
- **Abstracts come from OAI-PMH**, the sanctioned bulk metadata channel:
  ~354 requests for 339k abstracts versus 339,388 per-paper fetches. arXiv asks
  bulk users off the per-document endpoints, and the request math agrees.
- **`arxiv.org/html/<id>` is for on-demand full text** — and it carries title,
  abstract and body together (`htmlTitleAbstract`), which makes it the fallback
  when OAI has not covered a paper. The one field it lacks is the primary
  **category**.
- **`s3://arxiv/` is the requester-pays bucket**: 9.2 TB of tarballs, ~$110 for a
  year's egress or near-free processed in us-east-1. Only needed for full text at
  whole-corpus scale.

### 10.4 Rate limits are a design input

arXiv's terms ask for **one request every three seconds on a single connection**,
counted across the query API, OAI-PMH and RSS together, and there is **no paid
tier** — bulk access is open, commercial projects need no MOU, and the only
escalation is asking support. Two defects came out of reading it:

- the harvester defaulted to ~9× that rate (concurrency 3, 1 s pause);
- the live search source could issue 9 requests per user turn (3 searches × 3
  ladder rungs), now capped at 4 and pinned by a test.

And **flow control is not failure**. A flat 20 s retry × 8 attempts killed a
working harvest 29 pages into a shard; 503/429 on a bulk sweep means "slow down"
and can persist for many minutes. It now has a generous ceiling with progressive
backoff, while genuine errors keep a short one.

Throughput is not a constant either: the same harvest measured ~2.6 min/page
during a throttle (≈15 h for a year) and ~40 min for the whole year the next
day. Do not design around a number taken while blocked — and note that ~30
exploratory requests over ~40 minutes earned a multi-hour block.

### 10.5 Building from a machine that dies

The container is ephemeral and `data/` is gitignored, so `scripts/arxiv-vectorize.mjs`
embeds and upserts **incrementally**, checkpointing after each batch: Vectorize
is the durable store and a re-run skips what is already pushed. This was
exercised for real — a transient `Please check your internet connection` from
wrangler killed the run at batch 346 of a 123-minute build, and the next round
resumed from the checkpoint, re-embedded nothing, and finished.

Two bugs found in that checkpoint, both invisible because dedup kept the
*result* correct:

- rewriting a JSON array of every id after each batch is O(corpus) per batch;
- the "already migrated" marker still parsed, so the migration branch
  re-appended the whole id set every run (33,632 ids → 369,952 lines).

### 10.6 The relevance floor, and why not cosine

Dense retrieval always returns its nearest neighbours, so a partial index
answers off-topic questions with confident nonsense. `src/arxiv-rag.js` applies
a floor on the **cross-encoder score**, measured across three corpus sizes:

| query | 512 papers | 26,624 | 337,768 |
|---|---|---|---|
| "how do multiple LLM agents collaborate…" | cos 0.8517 / rr 0.166 | 0.7890 / 0.830 | 0.8040 / **0.965** |
| "critical temperature of graphene superconductivity" | 0.8503 / 0.054 | 0.7703 / 0.365 | 0.8025 / 0.974 |
| "best pizza recipe napoletana dough hydration" | 0.7925 / 0.00002 | 0.7112 / 0.00005 | 0.7268 / **0.0002** |

As the corpus grew and matches got dramatically better, the **cosine went down**
while the rerank score rose ~6×. A cosine threshold would have been tuned to
noise and drifted with every upsert. The floor is 0.01 — 0.1 was tried and kept
only 1 of 20 candidates on a genuinely on-topic query — and it is applied only
when the reranker actually scored, since a fallback order carries no comparable
numbers.

### 10.7 What is still unverified

- ~~**The doc's 87% recall@1 does not describe the hosted path.**~~ **Measured
  on 2026-07-29 — see §11.** It does not, and the gap was bigger than the pool
  difference alone: 78.7% recall@1 and 81.3% recall@10 in English through the
  served path. The stated cause was also wrong. Vectorize no longer caps `topK`
  at 20 with `returnMetadata: "all"`; the cap is 50, so the pool was needlessly
  shallow rather than unavoidably so. `src/rag.js` still assumes 20 and is worth
  the same check.
- **The bench gate has not run** against a deployment carrying this source.
- **~20 rows have no primary category** — the ones imported via the GCS+HTML
  path before the OAI harvest completed.

---

## 11. Widening the window to late 2023 — measured before and after

The corpus was a rolling 13 months (submission months 2507–2607). This section
records extending it back to **2310**, and the before/after evaluation that
judged whether the extra material cost retrieval quality.

Two questions had to be answered separately, because they have different
answers:

1. **Does a bigger corpus make the existing papers harder to find?** §4.3 says
   it should — plain dense recall@1 fell 92.1 → 72.1 going from 20k to 327k
   units. Measured with a needle set drawn from papers that are in **both**
   indexes, so the only thing that changes is the number of distractors.
2. **Is the new material actually retrievable?** A widened window that indexes
   440k papers nobody can surface is not a widened window.

### 11.1 Why late 2023, and not five years

`arxiv.org/html/<id>` — arXiv's LaTeXML rendering — has only existed since late
2023. It is what makes the full-text tier cheap and Worker-native (§9.9: 0.43 MB
per paper, no gzip, no tar, no credentials), and papers older than it fall back
to the 3.07 MB source tarball, which needs gzip+tar and cannot run inside a
Worker. Stopping at 2310 keeps the whole corpus inside the tier that already
works, rather than buying abstract coverage the depth tier cannot follow.

Nothing else in the stack objected. `--months` already validated to 120,
`planWindow` already shards by month and snaps to the 1st, Vectorize's 10M
per-index limit is 13× away, and the embedding bill for the addition was ~€3.

### 11.2 The instrument

`scripts/arxiv-hosted-eval.mjs` — a harness for the **hosted** path, because
`scripts/arxiv-eval.mjs` measures the local binary pack and the two are not the
same pipeline. It replays `src/arxiv-rag.js` over the Vectorize REST API: the
same `query: ` prefix, the same topK, the same cross-encoder over
`title. abstract` cut to 900 chars, the same 0.01 floor applied only when the
reranker actually scored.

Three decisions in it are load-bearing:

- **The needle papers are sampled uniformly from the GCS enumeration and then
  hydrated through `get_by_ids`.** Sampling by *querying* the index would have
  selected papers that retrieve well and inflated every number in this section.
- **Topical grades are pooled across runs and graded once.** Grading each run
  separately would give the same paper different labels depending on which
  index returned it, and the delta would measure the judge.
- **The served time budget is deliberately not enforced.** Under it a slow leg
  silently drops the rerank, and an eval that did that would average two
  pipelines together — the failure §5 warns about. Latency is measured instead.

Two caveats bound what the numbers mean. The queries are written from the
index's stored 900-char abstract copies rather than full abstracts, which
slightly flatters the pipeline in absolute terms but is identical on both sides
of the comparison. And the English needle queries carry 0.63 lexical overlap
with their paper's abstract against 0.05 for Swedish (reproducing §4.3's 0.68 /
0.07), so EN and SV absolute numbers are not comparable to each other — only
each language to itself.
