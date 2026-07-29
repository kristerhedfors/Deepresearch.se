---
name: bulk-corpus-etl
description: >-
  Load when building a LARGE external corpus into a hosted, searchable vector
  index — "index all of PubMed / bioRxiv / a conference dump", "harvest X and
  make it searchable from the Worker", "build the full corpus", "why is the
  harvest slow / getting throttled / missing papers", or when running a
  multi-hour ETL from an ephemeral container. The provider-agnostic discipline
  distilled from taking arXiv from zero to 337,768 hosted vectors: why a single
  enumeration cannot detect its own gaps (a 48% hole in one month reported
  itself as success), why "records kept" is not "unique documents", the
  window-boundary bug class, rate-limit citizenship and how flow control
  differs from an error, checkpointing that survives an ephemeral machine, the
  Cloudflare Vectorize billing model and its serialization traps, and the
  relevance floor that stops a partial index answering off-topic questions with
  confident nonsense. For the arXiv-specific corpus see the **arxiv-rag** skill;
  for wiring a finished index into /api/chat see **add-research-source**.
---

# Building a large corpus into a hosted vector index

The reusable half of the arXiv build (2026-07-26/27): enumerate → cross-validate
→ fetch → embed → upsert → serve. Every number below was measured, and most of
the rules exist because something failed first.

The arXiv-specific instance lives in the **arxiv-rag** skill and
`docs/ARXIV-RAG.md`; this skill is the *procedure*, meant to transfer to any
corpus with a bulk feed.

## 0. The shape

```
enumerate ─┬─→ cross-validate ─→ fetch metadata ─→ embed ─→ upsert ─→ serve
           │        ↑                                         │
    second source ──┘                              durable store = checkpoint
```

Two things in that diagram are the whole lesson: enumeration is **two** sources,
not one, and the durable store — not local disk — is where progress lives.

## 1. Enumerate from TWO independent sources, always

**A single enumeration cannot detect its own holes.** This is the finding worth
carrying to every future corpus.

The arXiv harvest reported `339,263 in-window papers kept` and exited 0. It
looked like a clean success. Comparing its ids against a second, independent
listing, month by month:

| month | expected | missing | |
|---|---|---|---|
| 2508 … 2607 (12 months) | ~20-32k each | 21-56 | ~0.1% |
| **2507** | 23,780 | **11,432** | **48.1%** |

Half the oldest month was absent and *nothing errored*. No exception, no
warning, no anomalous count — the run's own totals were self-consistent because
the missing records were never requested in the first place.

So: find a second channel before trusting a corpus. It does not have to be a
full alternative feed — a cheap **listing** is enough, because all it must
answer is "what ids should exist". Candidates:

- an object-store mirror's file listing (arXiv: a public GCS bucket, 339,388
  ids in **39 seconds**);
- a sitemap or an OAI `ListIdentifiers` (ids only, far cheaper than records);
- a published id range or a DOI registry.

Then diff by SUBGROUP (month, category, shard), not just totals. Totals hid this
bug completely: 339,388 vs 339,263 looked like agreement to 0.04%. The per-month
breakdown is what exposed it.

## 2. "Records kept" is not "unique documents"

The same run's `339,263 kept` was **327,742 unique**. A document revised inside
the window appears in every shard that touched it, so any per-shard counter
double-counts by construction.

Report and reconcile on the **deduplicated set**. A pipeline that trusts its
kept-counter will believe it is complete while missing 3.4% of its corpus.

## 3. The window-boundary bug class

The 48% hole came from two different notions of "in window" that were never
reconciled:

- the fetch window filtered on **datestamp** (when a record was last touched),
  starting at `today − 12 months` = a mid-month date;
- the keep filter admitted a whole **id-month** (`YYMM`).

Documents submitted before that day-of-month were in-window by id and never
fetched. **Whenever a pipeline filters on one axis and selects on another,
check the boundary explicitly**, and assert the invariant in a test rather than
the symptom:

```js
// for several "today" values: the oldest shard must start on a boundary,
// and no admitted id-month may predate the window start
assert.ok(oldestShard.from.endsWith("-01"));
for (const m of idMonths) assert.ok(monthStart(m) >= plan.start);
```

### 3a. The same class at the OTHER end: a historical slice (2026-07-29)

Fixing the start boundary does not fix the end. Re-run the same two axes with
an end date **in the past** and the hole reappears, larger and graded:

- fetch window: **datestamp** in `[2023-10-01, 2025-07-01)`;
- keep filter: id-months `2310…2506`.

A document submitted 2025-06 and revised in 2026 has a 2026 datestamp. It is
in-window by id, and it is **never requested**. Result: 73.5% coverage, and the
loss rises monotonically toward the recent end of the band — 2506 at 59.1%,
2411 at 79.9%, 2402 at 92.1% — because recent documents have had the least time
to stop being revised. Nothing errored, and the run's own counters were
self-consistent.

Two rules fall out:

- **An "as of" parameter reproduces a past run; it does not slice history.**
  Tying the keep-filter to the fetch window is only sound when the window ends
  at *now*, which is the case the author had in mind.
- **Slicing a historical band needs a SECOND pass** over the mutation axis
  *after* the band, keeping only the band's selection axis. So the selection
  and fetch axes must be independently specifiable — build that seam in from
  the start (`--keep-months` here), because retrofitting it means re-harvesting.

The diagnostic that settles it costs nothing and needs no network: look at the
mutation timestamps you *did* collect. Every one of the 14,254 collected
2506 records had `updated <= 2025-07-01` with none past it — a hard cut at the
window edge is a boundary bug, not a sampling artefact.

## 4. Rate limits: read the terms, and know flow control from failure

- **Read the published limit before designing throughput.** arXiv's terms ask
  for one request every three seconds on a single connection, counted across
  *all* its APIs together. The harvester's defaults (concurrency 3, 1 s pause)
  were ~9× that, and the serving code could issue 9 requests per user turn.
  Both were compliance defects, not just impoliteness.
- **A 429/503 on a bulk sweep is not an error — it is "slow down".** It can
  persist for many minutes. A flat 20 s retry × 8 attempts killed a working
  harvest in under three minutes, 29 pages into a shard. Give flow control its
  own **generous** ceiling with progressive backoff (honouring `Retry-After`),
  and keep a **short** ceiling for genuine errors so a real 500 still fails
  fast. Two counters, not one.
- **Answering a throttle by immediately issuing a different query is what earns
  a longer block.** Abort the ladder; do not "try the next thing".
- **Probing costs you the API.** ~30 requests over ~40 minutes from one IP
  earned a block that lasted hours and alternated 429, 503 and timeouts; a
  single successful probe mid-block did not mean recovery. Batch an exploratory
  matrix into ONE scripted run, capture the results, and work from the capture.
- **Throughput is not a constant.** The same harvest measured ~2.6 min/page one
  day (≈15 h for a year) and ~1000 records/10 s the next (≈40 min). Do not
  design around a number taken during a throttle.

## 5. Bulk channels: check freshness per PATH, not per bucket

A public mirror can be simultaneously current and years stale:

- `arxiv/arxiv/pdf/<YYMM>/…` — objects dated **2026-07-12** (current)
- `metadata-v5/arxiv-metadata-oai.json` — 4.5 GB, last updated **2020-08-19**

Building abstracts from that dump would have produced a six-year-old index that
looked fine. **Verify the freshness of the exact path you intend to read.**

Also distinguish *free* from *requester-pays*: the same corpus had a free public
GCS mirror and a separate 9.2 TB S3 bucket that bills the downloader. And prefer
the channel with the right granularity — 339k abstracts is **~354 bulk-API
requests** versus **339,388 per-document fetches**. Per-document is for
on-demand reads, never for backfill, and publishers usually say so explicitly.

## 6. Assume the machine dies

Agent containers are ephemeral and the corpus is usually gitignored, so a build
that embeds everything and uploads at the end can lose hours of *paid* work to a
restart.

- **Upload incrementally; the remote store IS the checkpoint.** Each batch:
  embed → write → upsert → record. Re-running skips what is already pushed.
- **Record AFTER the write succeeds**, so a crash re-does at most one batch
  instead of silently skipping it.
- **This is not theoretical.** A 123-minute run took a transient
  `Please check your internet connection` from the upload CLI at batch 346. The
  next round resumed from the checkpoint, re-embedded nothing, and finished.
  No intervention.
- **Keep the checkpoint append-only** — one id per line, appending only the
  batch. Rewriting a JSON array of every id after each batch is O(corpus) per
  batch: a 337k build would rewrite a ~4 MB file ~1,300 times.
- **The migration trap**: a "already migrated" marker that still *parses* will
  re-run a migration branch forever. Guard on there being work to do, not on the
  file being readable — that bug re-appended the full id set every run
  (33,632 ids → 369,952 lines over 11 rounds) and stayed invisible because
  dedup kept the *result* correct.

## 7. Cloudflare Vectorize specifics

- **Billing is `(stored_vectors + monthly_queries) × dimensions`** — the index
  size is charged **once per month**, not per query. 327k × 1024 dims is
  ~$0.16/mo storage + ~$3/mo at 10k queries; marginal cost per query ~$0.00001.
  Check the worked example in the docs rather than inferring from a summary:
  the per-query reading is off by orders of magnitude.
- **Re-probe the `topK` ceilings; they move.** `returnMetadata: "all"` capped
  `topK` at 20 when this was first written and caps it at **50** as of
  2026-07-29 — so a pipeline built against the old limit had been reranking a
  fifth of the candidates available to it, for free, until someone measured
  again. Probe rather than infer, and let the API's own rejection text tell you:

  | request | result |
  |---|---|
  | `topK=50  returnMetadata=all` | 200, 50 matches |
  | `topK=100 returnMetadata=all` | 400 "max top K is 50 … retry with returnMetadata=indexed" |
  | `topK=100 returnMetadata=none` | 200, 100 matches |
  | `topK=200 returnMetadata=none` | 400 "max top K is 100" |
  | `get_by_ids` with 100 ids | 400 "40007 too many ids in payload; max id count is 20" |

  Going deeper than the metadata ceiling means ids-only plus a hydrating
  `get_by_ids` pass — a second round trip. Measure whether the recall is worth
  it instead of assuming either way.
- **A deeper rerank pool may be nearly free in latency.** Cross-encoder cost at
  this scale is request overhead, not document count: 20 → 50 documents moved
  the median rerank leg 763 → 779 ms. Check before rejecting a bigger pool on
  latency grounds.
- **Vectors must be plain arrays.** Embedders return `Float32Array`, and
  `JSON.stringify` turns a typed array into an OBJECT (`{"0":0.1,…}`). The
  service rejects it with the unhelpful `failed to parse upsert vectors request
  in ndjson format: line Some(0) was not expected format [code: 40023]`.
  `Array.from()` is the fix — and assert the shape locally where the error
  message can be useful.
- **Metadata rides in query responses**, so keep keys short and store only what
  the caller renders. Cut long text to what a downstream reranker can actually
  read.
- **The vector count lags**: `vectorize info` reports `processedUpToMutation`,
  so a just-finished upsert reads low for a while. Not a failure — but it also
  means **`vectorCount` cannot verify a build is complete.** Measured drift
  during a fill: ~6k vectors / ~2 min behind the local checkpoint. Verify by
  sampling ids against an independent enumeration instead.
- **Parallelise a fill by partitioning the input, not by rewriting the loader.**
  N processes over disjoint shard directories, each with its own checkpoint
  file, took a fill from ~23/s to ~95/s with no change to the upsert code. Seed
  every partition's checkpoint from any earlier run so nothing is embedded
  twice. Time per batch split roughly embed 5.7 s / CLI spawn 2 s / upload 9 s,
  so the upload dominates and is byte-bound. **Do not shrink it by rounding the
  floats** — new vectors would then differ from old ones and confound any
  before/after measurement of the index.

## 8. Serving: dense retrieval fails DISHONESTLY

A keyword query that matches nothing returns nothing. **A vector query always
returns its nearest neighbours, however far away they are** — so a partial or
off-domain index answers with confident nonsense rather than a miss.

Fix with a **relevance floor**, and put it on the **cross-encoder rerank score,
not the cosine**. Measured across three corpus sizes:

| query | 512 papers | 26,624 | 337,768 |
|---|---|---|---|
| on-topic | cos 0.8517 / rr 0.166 | 0.7890 / 0.830 | 0.8040 / **0.965** |
| adjacent-domain | 0.8503 / 0.054 | 0.7703 / 0.365 | 0.8025 / 0.974 |
| nonsense ("pizza recipe") | 0.7925 / 0.00002 | 0.7112 / 0.00005 | 0.7268 / **0.0002** |

Read across the rows: as the corpus grew and matches got dramatically better,
the **cosine went DOWN** while the rerank score rose ~6×. Any cosine threshold
would have been tuned to noise and would drift with every upsert. The rerank
scores separate signal from nonsense by four orders of magnitude at *every*
size.

Two rules that fall out:

- Pick the floor from measurement, not feel. 0.1 was tried first and was too
  aggressive — it kept 1 of 20 candidates on a genuinely on-topic query. 0.01
  keeps weak-but-real relevance and still rejects nonsense by 500×.
- **Apply the floor only when the reranker actually ran.** If it failed and you
  fell back to dense order, the scores are missing; dropping everything on the
  strength of absent scores turns a degraded result into no result.

And always keep a fallback path for a floor-miss (a live API, a lexical search),
so "the index doesn't cover this" degrades instead of fabricating.

## 9. Environment traps

- **Node's built-in `fetch` ignores `HTTPS_PROXY`** unless `NODE_USE_ENV_PROXY=1`
  (Node ≥ 22.21). Behind an agent proxy every call otherwise fails with a 503
  whose body reads `DNS resolution failure` — which looks exactly like the
  upstream provider being down. `curl` works, which makes it more confusing, not
  less. Check this before debugging the provider.
- **A script in a scratch directory cannot resolve the repo's `node_modules`.**
  Run comparison/probe scripts from the repo root.
- **Watch the wallet.** Embedding providers answer an empty balance with a hard
  `402`; it has killed builds mid-run. Prefer a provider registry with failover.

## 10. The honest-reporting checklist

Before calling a corpus build done, state each of these — they are the ones that
were wrong at some point in this build:

- unique documents indexed, **not** records processed;
- coverage against the **independent** enumeration, broken down by subgroup;
- what the filters dropped and why (1,393 documents fell below a 200-char
  abstract floor here — expected, but it must be stated, not discovered later);
- which fields are MISSING on which subset (a GCS+HTML-sourced row has no
  primary category; the bulk-API rows do);
- any recall figure's provenance — a number measured with a 50-candidate rerank
  pool does not transfer to a 20-candidate one.
- **whether the numbers describe the SERVED path or a local one.** These are
  different pipelines and only one of them is what users get. Here the local
  pack's 87% recall@1 / 96% recall@10 was 78.7% / 81.3% through the deployed
  path — and the gap went unnoticed for days because nothing had ever run a
  query set against production.

## 11. The failure mode to design against

Across this whole build, almost nothing crashed. What went wrong was **work
that reported success while doing nothing, or less than asked**:

| symptom | reality |
|---|---|
| harvest exits 0, totals agree to 0.04% | 48.1% of one month missing |
| harvest exits 0, counters self-consistent | 26.5% of the band missing (§3a) |
| flag parsed and validated | never passed to the function that uses it |
| loader prints `done — 0 vectors` | pointed one directory above the shards |
| rerank "succeeds" every time | failing soft and silently; the eval measured a pipeline that never ran |
| verifier reports 0% coverage | comparing two incompatible id spellings |
| waiter never fires | its own command line matched the pattern it was grepping for |

The design rules that fall out:

- **Make every "nothing to do" path loud.** An empty input directory, a
  zero-length work list, a filter that matched nothing — these are almost
  always mistakes at this scale, and they must exit non-zero, not print `done`.
- **Never verify a run with its own counters.** Cross-validate against an
  independent source, broken down by subgroup; a pooled total hides exactly the
  holes worth finding.
- **Run a new verification tool against known-good data first.** A verifier
  that has never been exercised is an untested assertion, and its first real
  verdict is as likely to be its own bug as a finding.
- **Fail-soft must still be loud.** Degrading is correct; degrading silently
  turns a measurement into fiction.
