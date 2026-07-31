# The PubMed RAG search database

PubMed built into a hosted vector index the way arXiv was
([`docs/ARXIV-RAG.md`](ARXIV-RAG.md)) — same embedder, same reranker, same
Vectorize shape, same failure discipline — and added as a **second corpus
beside arXiv, not a replacement for it**.

arXiv is preprints in physics, maths, CS and quantitative biology. A trial
protocol, a pathogen genome, an assay, an epidemiological cohort: none of those
land there. PubMed is the other half of the research surface — **40,951,138
citations, of which 29,307,789 carry an abstract** (measured 2026-07-31 through
E-utilities). Until now the pipeline reached that literature only through Europe
PMC's live keyword-AND API. This tier gives it dense retrieval with a
cross-encoder rerank — the configuration that, measured through the deployed
path on arXiv, reaches 78.7% recall@1 / 85.3% recall@10 in English.

Status: **the ingestion path is built, measured and tested; the index is not yet
created.** Everything below §1–§4 is measured on this machine on 2026-07-31.
§5 is the cost model and the amounts recommendation, which is the decision this
document exists to support. §7 is what is deliberately still open.

---

## 1. The channels, and which is for what

| | |
|---|---|
| Bulk corpus | `https://ftp.ncbi.nlm.nih.gov/pubmed/` — the 2026 **baseline** (`pubmed26n0001…n1334`, 1,334 files, 51.8 GB gzipped, released 2026-01-29) plus **daily update files** carrying on from the last baseline number (`n1335…n1557`, 223 files, 12.4 GB by 2026-07-30) |
| Enumeration | NCBI **E-utilities** `esearch` over an Entrez-date window — a count from the live index, derived from a different system than the file dumps |
| Live fallback | **Europe PMC** (`src/europepmc.js`), already shipped: current to the hour, keyword AND, no key |

The archive is the ingestion channel and E-utilities is the cross-check, not the
other way round. NCBI's own usage guidelines cap an unkeyed client at three
requests per second and say that a data-mining project should "download a local
copy of the database" from the FTP site instead. 40.9 M citations at 3 req/s is
not a plan; the whole baseline is about 1,334 requests.

**Measured throughput of the archive channel: 30,000 records parsed per file in
7–18 s wall clock, sustaining ~1,800 kept records/s** including download. A
1.5 M-record harvest is therefore roughly **15 minutes**, not the 15 hours the
equivalent arXiv OAI-PMH harvest takes. The bulk file channel is the single
biggest reason PubMed is cheaper to ingest than arXiv was.

### 1.1 Terms

Downloading from the NLM FTP servers accepts NLM's terms. Two of them bind
anything built on this data and are worth stating where the build is described:
acknowledge NLM as the source, and either keep the copy current **or** say
clearly that it does not reflect the most current data available from NLM. A
frozen slice is explicitly allowed — it just has to say so. The PubMed wordmark
and logo may not be used.

---

## 2. The two axes, and why the window is defined the way it is

The arXiv build lost **48.1% of one month**, and later **26.5% of a historical
band**, to the same mistake twice: it filtered on one date axis and selected on
another, and both times exited 0 with self-consistent counters. PubMed has the
same pair, so they are named before anything else:

| axis | what it is | monotone? |
|---|---|---|
| **fetch** | the archive file number, which tracks PMID, which tracks the date NLM **loaded** the citation | yes |
| **selection** | the **publication** date on the record | **no** |

Measured, by reading each file's own PMIDs:

| file | own PMIDs | dominant publication year |
|---|---|---|
| `n0100` | 1.94 M – 2.0 M | 1990s |
| `n0700` | 21.75 M – 21.78 M | 2011 |
| `n1200` | 32.76 M – 37.55 M | 2023 |
| `n1334` | 41.605 M – 41.610 M | 2026 |

So **descending file order is "latest first" with no date arithmetic at all**,
and an interrupted harvest still leaves the most recent literature complete.

The corpus is therefore defined as a **PMID / load-order window** — "everything
NLM has loaded since file n*N*" — which is exactly reproducible and is what the
file order gives for free. `--min-year` exists as a *trim*, and
`windowNote()` prints on every run that it trims rather than defines:

```
window = archive files n1335…n1557 (a PMID/load-order window, newest first)
--min-year 2024 TRIMS this window, it does not define one: a citation published
2024 but loaded before file n1335 is not in any file this run fetches
```

A publication-year window served by a PMID-ordered fetch is the arXiv bug
reproduced on a new corpus. Defining the window on the axis the fetch actually
uses is the fix.

> **A caution the first pass got wrong.** A record's own PMID is the one
> directly under `<MedlineCitation>`. A naive `<PMID>` match also picks up every
> cited and commented-on PMID in `<CommentsCorrectionsList>` — which reported
> file `n1200` as spanning PMIDs 11 M–41.5 M when its own records span
> 32.8 M–37.6 M, and would have made the table above meaningless.

---

## 3. What is in the window — measured

From the first 44 update files (`n1501…n1557`, i.e. citations loaded roughly
2026-05 → 2026-07-30), 916,481 rows on disk:

```
UNIQUE citations    678,680   (237,801 repeats, 25.9%)
PMID range          7,714 … 42,530,985
with DOI            99.1%
with MeSH terms     74.5%

abstract chars      mean 1724 · p5 896 · median 1699 · p95 2682 · p99 3527 · max 15652
passage chars       mean 1172 (budget 1200)
TRUNCATED passages  608,494 of 678,680 (89.7%)

publication years   2026 516,771 · 2025 82,973 · 2024 49,825 · 2023 9,889 · 2022 4,141 · 2021 3,990
languages           eng 668,949 · chi 4,381 · spa 1,309 · ger 1,198 · fre 1,195 · rus 1,015
publication types   Journal Article 652,520 · Case Reports 10,167 · English Abstract 5,477
journals            Scientific reports 18,608 · PloS one 9,525 · Nature communications 6,485
```

Four of those numbers change how the build is planned.

### 3.1 "Records kept" is not "unique citations", and here the gap is 26%

arXiv's double-count was 3.4%. PubMed's is **25.9%**, because a daily update
file carries new, **revised** and deleted citations — a paper corrected twice
since the baseline appears in three shards. Vectorize bills per *unique* vector,
so a plan costed against the harvester's own "kept" counter would be a quarter
too expensive and a quarter too optimistic about coverage at the same time.

### 3.2 The update files are not "recent papers" — they are recent *edits*

The lowest PMID in that window is **7,714**: a 1990s citation revised in 2026.
The load-order window genuinely contains records of every age, which is a
feature (a corrected old record arrives with its correction) and a warning (the
window's *publication* spread has a long tail, so "the last six months of
PubMed" is not what a load-order window means).

### 3.3 90% of PubMed abstracts do not fit the embedder

This is the biggest single difference from arXiv and the one open technical
question. e5's window is 512 tokens ≈ 1,200 characters. PubMed's **median
abstract is 1,699 characters** — arXiv's is about 1,200 — so **89.7% of
passages are cut**, most of them losing roughly a third of their text. A
structured abstract cut at 1,200 chars typically keeps BACKGROUND and METHODS
and loses RESULTS and CONCLUSIONS, which is the half a reader wants.

Nothing here is broken: the budget is a hard limit (Berget answers 400 and drops
the whole batch past 512 tokens, it does not truncate), and the index works. But
arXiv's measured finding that chunking makes retrieval *worse* was established
on abstracts that **fit** — "chunking is a technique for documents longer than
the embedder's window; an abstract already fits." On this corpus that premise is
false. §7 records the experiment rather than guessing at it.

### 3.4 Token cost per record, measured not estimated

256 real passages through Berget's `intfloat/multilingual-e5-large`:

```
chars 291,274 · prompt_tokens 70,513 · 4.13 chars/token · 275.4 tokens/passage · 1024 dims
```

No over-length rejections at the 1,200-char budget, so the arXiv-tuned budget
transfers as-is. At Berget's €0.03 / 1 M tokens that is **€0.0083 per 1,000
citations**.

---

## 4. The pipeline

```
listing ─→ plan (newest first) ─→ download ─→ parse ─→ JSONL ─→ embed ─→ Vectorize
   │                                                              │
E-utilities cross-check ───────────────────────────────┘   Vectorize IS the checkpoint
```

| Stage | Script | Notes |
|---|---|---|
| Harvest | `scripts/pubmed-harvest.mjs` | newest file first, resumable, one archive file on disk at a time |
| Enumerate | `scripts/pubmed-enumerate.mjs` | the independent E-utilities count; `--verify` diffs it against the corpus |
| Report | `scripts/pubmed-corpus.mjs` | dedup, drop reasons, length distribution, year spread |
| Fill | `scripts/pubmed-vectorize.mjs` | incremental embed + upsert, checkpointed; `--prune` removes withdrawn citations |
| Pure core | `public/js/pubmed-core.js` | XML parse, filters, window planning, passage + metadata construction |
| Served tier | `src/pubmed-rag.js` | dense → rerank → relevance floor, behind Europe PMC's existing intent gate |
| Shared tier | `src/dense-rag.js` | the corpus-agnostic retrieval half, shared with `src/arxiv-rag.js` |
| Shared fill | `scripts/vectorize-upsert.mjs` | the corpus-agnostic checkpoint + upsert, shared with `scripts/arxiv-vectorize.mjs` |

```bash
# 1. Harvest, newest first (resumable — rerun to continue)
NODE_USE_ENV_PROXY=1 npm run pubmed:harvest -- --min-file 1335        # 6 months
NODE_USE_ENV_PROXY=1 npm run pubmed:harvest -- --max-records 1900000  # 12 months

# 2. What did we actually get?
npm run pubmed:corpus

# 3. Cross-check it against a channel that cannot share its bugs
npm run pubmed:enumerate -- --months 12 --verify
npm run pubmed:enumerate -- --ids --month 2026/06 --sample 2000

# 4. Fill the index (resumable — Vectorize is the checkpoint)
npx wrangler vectorize create deepresearch-se-pubmed --dimensions=1024 --metric=cosine
NODE_USE_ENV_PROXY=1 npm run pubmed:vectorize -- --index deepresearch-se-pubmed
```

Then uncomment the `PUBMED_INDEX` binding in `wrangler.toml`. Until it is
declared the tier reports itself unavailable and `src/europepmc.js` behaves
exactly as it did before — the binding is the on/off switch, and a *declared*
Vectorize index that does not exist fails every deploy, which is why it ships
commented out.

### 4.1 Two implementation notes worth keeping

**Parse from disk, not off the socket.** Parsing 30,000 records is ten-odd
seconds of blocking CPU; doing it inside the response stream's `data` handler
stalls the connection for that whole time, and it gets torn down mid-body.
Undici surfaces that as a bare `Error: terminated`, which reads like nothing at
all — it killed four consecutive runs after one to three files each, every time
exiting 1 with a one-word message. Downloading at full speed and parsing
afterwards costs one file's worth of disk and removes the failure mode.

**Never mirror the archive.** 51.8 GB baseline + 12.4 GB updates is roughly half
a terabyte uncompressed, against ~30 GB of writable disk in a session container.
One file is on disk at a time and is deleted once parsed; only the JSONL rests,
at ~700 bytes per kept record (about 1 GB per 1.5 M citations).

---

## 5. How much to import — the cost model and the recommendation

**The vector count is the recurring cost, and it dominates everything else.**
Vectorize bills *queried* dimensions as `(queries + stored_vectors) × dims`, so
the index size drives a monthly charge as soon as the index is queried at all,
independently of how much it is queried:

```
monthly = (queries + stored) × 1024 × ($0.01 / 1M)      queried dimensions
        + stored × 1024 × ($0.05 / 100M)                stored dimensions
        − 50M queried and 10M stored included on Workers Paid (per ACCOUNT)
```

At 10,000 queries/month and 1024 dimensions:

| stored vectors | ≈ months of load | Vectorize / month | Berget embeddings (one-time) | fill wall-clock |
|---|---|---|---|---|
| 772,658 *(arXiv today)* | — | ~$7.90 | — | — |
| 820,000 | 6 | ~$8.60 | €7 | ~2.5 h |
| **1,640,000** | **12** | **~$17.20** | **€14** | **~5 h** |
| 2,500,000 | 18 | ~$26.30 | €21 | ~7 h |
| 4,600,000 | 34 *(arXiv's window)* | ~$48.90 | €38 | ~13 h |
| 10,000,000 | ~73 | ~$107 | €83 | ~30 h *(the per-index ceiling)* |

Fill wall-clock assumes the arXiv build's measured ~95 vectors/s with the input
partitioned across parallel loaders (~23/s single-process). Embedding is €0.0083
per 1,000 citations at the measured 275.4 tokens each.

### 5.1 The hard limits

| limit | value | binding here? |
|---|---|---|
| Vectorize vectors per index | **10,000,000** | yes — all of PubMed-with-abstract (29.3 M) needs 3 indexes |
| Vectorize dimensions per vector | 1,536 | no, e5 gives 1,024 |
| Vectorize metadata per vector | 10 KiB | no, ours is ~1.5 KB |
| Vectorize `topK` with metadata | 50 | no, that is the rerank pool |
| e5 context | 512 tokens (**rejects**, does not truncate) | **yes** — §3.3 |
| Session disk | ~30 GB | yes for the archive, no for the JSONL |
| NCBI E-utilities | 3 req/s unkeyed, 10 with a key | no — it is only the cross-check |
| NCBI FTP | no published per-second ceiling; bulk is the sanctioned path | no |

### 5.2 The recommendation

**Land six months first, then run the ladder to twelve.**

- **First fill: six months of load order, ~820 k unique citations** — every
  daily update file since the 2026 baseline (`--min-file 1335`). It costs about
  what arXiv already costs (~$8.60/month), it is the slice this session's
  harvest covers, and it is the one that proves the tier end to end against
  real traffic before any money is committed to width.
- **Target: twelve months, ~1.64 M unique citations** (`--max-records 1900000`
  before dedup, or every archive file from about `n1250` up). Getting there is a
  resumed run, not a rebuild.

The reasoning, in order of weight:

1. **It is the "latest first" slice, and latest is what this corpus is for.**
   Measured through E-utilities on 2026-07-31, PubMed loads ~155 k citations a
   month and ~90% carry an abstract (2026/07: 154,542 loaded / 138,396 with
   abstracts; 2026/06: 158,720 / 142,526; 2026/05: 155,841 / 140,369). Twelve
   months is one natural unit of "current literature" and comes to ~1.86 M
   citations, ~1.64 M of which survive the harvest filters.
2. **Twelve months roughly triples the platform's hosted literature for about
   $17/month.** arXiv holds 772,658 vectors; this adds 1.64 M in the half of
   research arXiv never sees.
3. **Everything older already has a live tier.** Europe PMC answers a 2009
   cohort study today and will keep doing so — the relevance floor is what
   routes those questions to it. A partial index that fails honestly is worth
   far more than a complete one costing 3× as much.
4. **It stays inside one index with room to grow.** 1.64 M against a 10 M
   ceiling leaves the option of widening to arXiv's 34-month window later
   without an index-sharding design.

**Do not go past ~2.5 M without a separate decision.** Beyond that Vectorize
passes $26/month, the fill passes half a working day, and the marginal citations
are increasingly ones the live tier already handles well. Matching arXiv's
34-month window would cost ~$49/month — defensible, but it is a budget choice
and should be made as one.

---

## 6. How this is verified

The bulk-corpus-etl rule is that a run must never be verified with its own
counters — the arXiv harvest's totals agreed with themselves to 0.04% while
48.1% of a month was missing. So:

- `scripts/pubmed-enumerate.mjs` counts the same window through **E-utilities**,
  a different system from the file dumps, and `--ids --month YYYY/MM` does a
  set difference on real PMIDs rather than a total.
- The comparison is on the **EDAT** (load) axis, deliberately. A count on the
  publication axis would disagree with a *correct* harvest and send the next
  reader hunting a bug that is not there.
- Every "nothing to do" path is loud: an empty file plan says what to raise, an
  archive file that parses to zero records refuses to be recorded as done, and
  an empty corpus directory is an error rather than a `done — 0 vectors`.
- A shard is written to `.part` and renamed only after the whole file parsed, so
  an interrupted run can never be checkpointed as a complete one.

Unit tests: `public/js/pubmed-core.test.js` (20 tests — parsing, the own-PMID
trap, structured abstracts, free-text dates, streaming block boundaries, the
plan order, the window note) and `src/pubmed-rag.test.js` (13 tests — the
binding gate, the citable item, the relevance floor, and that a bound index
takes precedence over Europe PMC while an empty result still falls through
to it).

---

## 7. Open, and deliberately not guessed at

1. **Whether to chunk long abstracts.** 89.7% of passages lose their tail
   (§3.3), and the arXiv finding against chunking was measured on abstracts that
   fit. The experiment: build a 20 k-record sample two ways — single truncated
   passage vs. two overlapping passages max-pooled — and score both on a needle
   set generated from the **last third** of long abstracts, which is exactly the
   text the single-passage build throws away. Cost of the answer is a few euros;
   cost of guessing wrong is either half the recall or double the monthly bill.
2. **No retrieval numbers yet.** There is no PubMed gold set and no bake-off, so
   this document quotes arXiv's recall figures only to say what configuration
   was chosen and why. Nothing here claims a measured recall on PubMed, and
   nothing should until `pubmed:eval` exists.
3. **MeSH terms are harvested but unused.** 74.5% of records carry them and they
   are a controlled vocabulary — a natural lexical arm, or metadata filter, or
   query-expansion source. Not wired to anything yet.
4. **Withdrawn citations are handled at fill time, not continuously.** `--prune`
   removes any that were already pushed, but nothing re-runs it on a schedule; a
   long-lived index needs a refresh loop that pulls new update files, upserts the
   new PMIDs and prunes the deleted ones.
5. **The `$/month` figures follow Cloudflare's documented formula**, in which
   stored vectors appear inside the *queried*-dimension term. Check the first
   real invoice against the table in §5 before scaling past tier 1.
