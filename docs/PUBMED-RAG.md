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

Status: **built, measured, and FILLING.** The index `deepresearch-se-pubmed`
was created on 2026-07-31 and the `PUBMED_INDEX` binding is live. Every number
in §1–§4 was measured on this machine that day; §5 is the cost model and the
amounts recommendation this document exists to support; §7 is the fill and what
it measured; §8 is what is deliberately still open.

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

**Measured throughput of the archive channel: the complete set of 223 daily
update files — 3,776,137 records, 11.5 GB streamed — harvested in 34 minutes**,
sustaining ~1,700 kept records/s including download, at one connection with a
1 s pause between files. The equivalent arXiv OAI-PMH harvest is about 15 hours
for a year. The bulk file channel is the single biggest reason PubMed is cheaper
to ingest than arXiv was.

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

The whole daily-update set was harvested end to end: **all 223 files
`n1335…n1557`, i.e. everything NLM has loaded or revised since the 2026 baseline
was cut on 2026-01-29**. 3,776,137 records read, 3,397,607 kept (10.0% dropped),
34 minutes, 8.0 GB of JSONL.

```
UNIQUE citations    1,639,403   (2,074,518 repeats, 55.9%)
PMID range          75 … 42,530,985
with DOI            99.3%
with MeSH terms     66.7%

abstract chars      mean 1690 · p5 851 · median 1672 · p95 2629 · p99 3500 · max 38300
passage chars       mean 1168 (budget 1200)
TRUNCATED passages  1,443,072 of 1,639,403 (88.0%)

publication years   2026 874,152 · 2025 350,196 · 2024 212,052 · 2023 63,700 · 2021 26,507 · 2020 21,570
languages           eng 1,619,417 · chi 8,574 · spa 3,667 · ger 3,206 · fre 2,811 · por 2,366
publication types   Journal Article 1,554,006 · Case Reports 35,294 · English Abstract 10,576
journals            Scientific reports 34,297 · bioRxiv 18,880 · PloS one 15,352 · Nature communications 12,187
```

Four of those numbers change how the build is planned, and the first one
changed the recommendation in §5.

### 3.1 "Records kept" is not "unique citations", and here the gap is 56%

arXiv's double-count was 3.4%. PubMed's is **55.9%** — a daily update file
carries new, **revised** and deleted citations, so a paper corrected four times
since the baseline appears in five shards. Vectorize bills per *unique* vector,
so a plan costed against the harvester's own "kept" counter would be more than
twice too expensive.

**And the ratio grows with the window.** Measured on the same corpus at two
sizes: 44 files gave 25.9% repeats, the full 223 gave 55.9%. That is the shape
to expect — every extra day of updates is another chance for an already-seen
citation to be revised again — and it means the ratio measured on a pilot slice
does **not** extrapolate. Deduplicate and re-count at the size you intend to
build.

### 3.2 The update files are not "recent papers" — they are recent *edits*

The lowest PMID in that window is **75** — a citation from the 1970s, revised in
2026. The publication-year table shows the same thing at scale: six months of
*load* contains 874 k citations published in 2026, but also 350 k from 2025,
212 k from 2024, 64 k from 2023 and a long tail back through the 1970s.

That is a feature and a warning at once. The feature: a corrected old record
arrives with its correction, and six months of updates reaches three years of
literature. The warning: "the last six months of PubMed" is **not** what a
load-order window means, and any claim about publication coverage has to be read
off the year table rather than off the window definition.

### 3.3 88% of PubMed abstracts do not fit the embedder

This is the biggest single difference from arXiv and the one open technical
question. e5's window is 512 tokens ≈ 1,200 characters. PubMed's **median
abstract is 1,672 characters** — arXiv's is about 1,200 — so **88.0% of
passages are cut**, most of them losing roughly a third of their text. A
structured abstract cut at 1,200 chars typically keeps BACKGROUND and METHODS
and loses RESULTS and CONCLUSIONS, which is the half a reader wants.

Nothing here is broken: the budget is a hard limit (Berget answers 400 and drops
the whole batch past 512 tokens, it does not truncate), and the index works. But
arXiv's measured finding that chunking makes retrieval *worse* was established
on abstracts that **fit** — "chunking is a technique for documents longer than
the embedder's window; an abstract already fits." On this corpus that premise is
false. §8 records the experiment rather than guessing at it.

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
| Partition | `scripts/pubmed-partition.mjs` | dedup ONCE, then split by PMID hash into N disjoint parts so the fill can run in parallel |
| Fill | `scripts/pubmed-vectorize.mjs` | incremental embed + upsert, checkpointed; `--prune` removes withdrawn citations |
| Pure core | `public/js/pubmed-core.js` | XML parse, filters, window planning, passage + metadata construction |
| Served tier | `src/pubmed-rag.js` | dense → rerank → relevance floor, behind Europe PMC's existing intent gate |
| Shared tier | `src/dense-rag.js` | the corpus-agnostic retrieval half, shared with `src/arxiv-rag.js` |
| Shared fill | `scripts/vectorize-upsert.mjs` | the corpus-agnostic checkpoint + upsert, shared with `scripts/arxiv-vectorize.mjs` |

```bash
# 1. Harvest, newest first (resumable — rerun to continue).
#    --min-file 1335 is the recommended corpus: every daily update file above
#    the 2026 baseline. --max-records caps a smaller trial slice instead.
NODE_USE_ENV_PROXY=1 npm run pubmed:harvest -- --min-file 1335
NODE_USE_ENV_PROXY=1 npm run pubmed:harvest -- --max-records 500000

# 2. What did we actually get?
npm run pubmed:corpus

# 3. Cross-check it against a channel that cannot share its bugs
npm run pubmed:enumerate -- --months 12 --verify
npm run pubmed:enumerate -- --ids --month 2026/06 --sample 2000

# 4. Fill the index (resumable — Vectorize is the checkpoint)
npx wrangler vectorize create deepresearch-se-pubmed --dimensions=1024 --metric=cosine
node scripts/pubmed-partition.mjs --parts 8       # dedup once, then split
WRANGLER_BIN=$(command -v wrangler) NODE_USE_ENV_PROXY=1 \
  node scripts/pubmed-vectorize.mjs --index deepresearch-se-pubmed \
    --corpus data/pubmed/parts/00 --work data/pubmed/vectorize/00   # ×8, in parallel
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
at ~2.2 KB per kept record — **8.0 GB for the 3.4 M kept rows** of the
update-file set. Budget on kept ROWS, not on unique citations: the 56% that
deduplicate away are still written to disk first.

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

| stored vectors | what it is | Vectorize / month | Berget embeddings (one-time) | fill wall-clock |
|---|---|---|---|---|
| 772,658 | *arXiv today, for scale* | ~$7.90 | — | — |
| 500,000 | a capped slice, newest first | ~$5.35 | €4 | ~1.5 h |
| **1,639,403** | **every daily update file since the baseline — MEASURED, harvested** | **~$17.20** | **€13.55** | **~5 h** |
| 3,000,000 | + roughly 45 baseline files below `n1334` | ~$31.50 | €25 | ~9 h |
| 5,000,000 | + roughly 110 baseline files | ~$52.50 | €41 | ~15 h |
| 10,000,000 | the per-index ceiling — beyond this needs sharding | ~$105 | €83 | ~29 h |

The 1,639,403 row is not an estimate: that corpus is on disk. Embeddings are
€0.0083 per 1,000 citations at the measured 275.4 tokens each; fill wall-clock
assumes the arXiv build's measured ~95 vectors/s with the input partitioned
across parallel loaders (~23/s single-process).

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

**Import the daily update files and stop there: every archive file above
`n1334`, which is 1,639,403 unique citations for about $17/month.**

```bash
NODE_USE_ENV_PROXY=1 npm run pubmed:harvest -- --min-file 1335
```

That corpus is already harvested and cross-validated (§6). The reasoning, in
order of weight:

1. **It is a natural, exactly reproducible boundary rather than an arbitrary
   number.** "Everything NLM has loaded or revised since the 2026 baseline" is
   one flag, needs no date arithmetic, and re-running it next month simply
   extends it. A "last N months" window would need the two-axis reconciliation
   of §2 to mean anything.
2. **It is the latest-first slice, and it reaches further back than its name
   suggests.** Six months of *load* is 874 k citations published in 2026, but
   also 350 k from 2025, 212 k from 2024 and 64 k from 2023 — because a revised
   old record arrives with its revision. Roughly half the corpus predates the
   window, for free.
3. **It roughly triples the platform's hosted literature.** arXiv holds 772,658
   vectors; this adds 1.64 M in the half of research arXiv never sees, for
   about $17/month and a one-time €13.55.
4. **Everything older still has a live tier.** Europe PMC answers a 2009 cohort
   study today and will keep doing so — the relevance floor is what routes those
   questions to it. A partial index that fails honestly is worth far more than a
   complete one costing three times as much.
5. **It leaves room.** 1.64 M against a 10 M per-index ceiling means the corpus
   can be widened into the baseline later without an index-sharding design.

**If $17/month is too much to commit before the tier has proved itself**, fill
`--limit 500000` first (~$5.35/month). The loader is checkpointed, so raising
the limit later resumes rather than rebuilds, and nothing is embedded twice.

**Going deeper means baseline files, and it is a separate decision.** Each ~30 k
-record baseline file below `n1334` costs about $0.30/month to keep, so the
question "how much history do we want" has a straightforward price per file.
Past ~3 M the fill is most of a working day and the marginal citations are
increasingly ones the live tier already handles well.

---

## 6. How this is verified

The bulk-corpus-etl rule is that a run must never be verified with its own
counters — the arXiv harvest's totals agreed with themselves to 0.04% while
48.1% of a month was missing. So:

- `scripts/pubmed-enumerate.mjs` counts the same window through **E-utilities**,
  a different system from the file dumps, and `--ids --month YYYY/MM` does a
  set difference on real PMIDs rather than a total.

**The result for the harvested corpus**, 1,500–2,000 PMIDs sampled per month
from E-utilities and looked up in the JSONL:

| month | sampled | present | missing |
|---|---|---|---|
| 2026/07 | 1,500 | 1,476 | 24 (1.6%) |
| 2026/06 | 2,000 | 1,999 | **1 (0.1%)** |
| 2026/05 | 1,500 | 1,497 | 3 (0.2%) |
| 2026/03 | 1,500 | 1,497 | 3 (0.2%) |

2026/07 is the open month — the last update file was cut on 2026-07-30, so the
final days are simply not published yet. The others are the steady state, and
the residual is expected: the corpus floor is 200 characters while PubMed's
`hasabstract` means any abstract at all.

The rest of the discipline:

- The comparison is on the **EDAT** (load) axis, deliberately. A count on the
  publication axis would disagree with a *correct* harvest and send the next
  reader hunting a bug that is not there.
- Every "nothing to do" path is loud: an empty file plan says what to raise, an
  archive file that parses to zero records refuses to be recorded as done, and
  an empty corpus directory is an error rather than a `done — 0 vectors`.
- A shard is written to `.part` and renamed only after the whole file parsed, so
  an interrupted run can never be checkpointed as a complete one.

> **The verifier's first verdict was its own bug**, which is why the table above
> is quoted with its method rather than on its own. Run unfiltered it reported
> **4.6% missing** for 2026/06 — because it sampled *all* PMIDs while the corpus
> only holds those that cleared the abstract floor, so it was comparing two
> different populations and reporting the harvester's own filter as a coverage
> hole. `hasabstract` is now the default and `--all` is the opt-out, labelled as
> measuring the filter rather than coverage. A verifier that has never been
> exercised is an untested assertion.

Unit tests: `public/js/pubmed-core.test.js` (20 tests — parsing, the own-PMID
trap, structured abstracts, free-text dates, streaming block boundaries, the
plan order, the window note) and `src/pubmed-rag.test.js` (13 tests — the
binding gate, the citable item, the relevance floor, and that a bound index
takes precedence over Europe PMC while an empty result still falls through
to it).

---

## 7. The fill — what actually happened (2026-07-31)

The index was created and filled from the corpus already on disk. Numbers as
measured, not planned.

```
1,639,403 unique citations · 8 parallel loaders · ~82 vectors/s sustained
```

### 7.1 Dedup has to happen BEFORE the split, not inside each loader

Parallelising is done by partitioning the input, and the obvious partition —
hand each loader a slice of the shards — is wrong here and expensively so. A
citation revised since the baseline appears in every update file that touched
it, and each loader dedupes only what it can see, so the same PMID landing in
two partitions gets embedded twice. Vectorize would still be *correct* (a
repeated id overwrites), but embeddings are billed per call, and at 55.9%
repeats a shard-sliced 8-way fill would have spent most of an extra €13 for
nothing.

`scripts/pubmed-partition.mjs` therefore dedupes once — 3,713,921 rows →
1,639,403 citations in 547 s — and splits by a hash of the PMID. Hashing rather
than round-robin is what makes a re-partition safe: part membership does not
depend on read order, so a resumed loader finds the same work list its
checkpoint describes. The eight parts came out within 0.2% of each other
(204,694 – 205,122).

### 7.2 Eight concurrent `npx` calls kill each other

The first launch lost half its loaders on their first batch:

```
npm error ENOTEMPTY: directory not empty,
  rename '…/_npx/…/node_modules/wrangler' -> '…/node_modules/.wrangler-YxIlSDWy'
```

`npx` revalidates the package on every invocation, so eight loaders shelling out
concurrently race on the shared npx cache. Warming the cache first does not fix
it. `scripts/vectorize-upsert.mjs` now takes a `WRANGLER_BIN` env override that
points at an already-installed binary and skips the npx step; the default stays
`npx`, so a single-process fill needs no setup. With it, eight loaders ran with
zero upsert failures.

### 7.3 The served path, probed against the partial index

Retrieval was checked end to end — embed, Vectorize query, cross-encoder rerank,
relevance floor — while the fill was still running:

| query | top rerank | above the 0.01 floor |
|---|---|---|
| does metformin reduce cardiovascular mortality in type 2 diabetes | 0.991 | 10/10 |
| antibiotic resistance in *Klebsiella pneumoniae* | 0.990 | 10/10 |
| risk factors for preterm birth | 0.973 | 10/10 |
| CRISPR base editing for sickle cell disease | 0.418 | 7/10 |
| **best pizza recipe napoletana dough** | **0.00006** | **0/10** |

The nonsense control is the one that matters: four orders of magnitude below the
on-topic queries and nothing survives the floor, so `src/europepmc.js` falls
through to the live API instead of citing the index's nearest food-science
paper. That is the property the floor exists for, reproduced on a second corpus.

### 7.4 A Swedish measurement trap that nearly became a false bug report

The first Swedish probe looked alarming — two of five paired queries returned
**nothing** above the floor while their English twins scored 0.97+. It read like
an invariant-6 violation in the retrieval layer.

It was mostly the *test*. Those queries had been typed without diacritics
(`hjart-karldodlighet`, `fodsel`, `djupinlarning`) because of shell quoting.
Restoring them moved three of five from near-zero to healthy:

| query | EN top | SV top (no diacritics) | SV top (correct) |
|---|---|---|---|
| metformin, cardiovascular mortality | 0.991 | 0.271 | **0.941** |
| risk factors for preterm birth | 0.973 | 0.00095 | **0.501** |
| deep learning in mammography | 0.932 | 0.554 | **0.948** |
| antibiotic resistance in *Klebsiella* | 0.990 | — | **0.970** |
| gut microbiota and depression | 0.986 | 0.0036 | 0.0054 |

**Never measure Swedish retrieval without diacritics.** Stripping them costs
orders of magnitude, so a probe written that way understates Swedish support
badly enough to manufacture a defect that is not there. This is the retrieval
analogue of the `\b` Swedish-boundary trap that silently kills bilingual regex
gates (the **palaeogenomics** skill records that one).

What survives the correction is a single query — "tarmflorans roll vid
depression" — still at 0.0054 against its English pair's 0.986, and it collapses
the same way on the arXiv index (0.00109). One case out of six is a lead, not an
established defect, and the floor was **not** touched on the strength of it.
Deciding it needs a Swedish gold set, which §8 already says does not exist.

---

## 8. Open, and deliberately not guessed at

1. **Whether to chunk long abstracts.** 88.0% of passages lose their tail
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
3. **MeSH terms are harvested but unused.** 66.7% of records carry them and they
   are a controlled vocabulary — a natural lexical arm, or metadata filter, or
   query-expansion source. Not wired to anything yet.
4. **`src/scholar.js` does not use this tier.** The Deep Science agent added
   its own `europePmcPeerSearch` — a peer-reviewed-only slice that deliberately
   excludes preprints — and it goes straight to the Europe PMC REST API. Wiring
   the dense tier in behind it would need a peer-reviewed filter this index does
   not currently carry (the `types` field is harvested but not stored in the
   vector metadata), so it is a separate decision rather than an oversight.
5. **Withdrawn citations are handled at fill time, not continuously.** `--prune`
   removes any that were already pushed, but nothing re-runs it on a schedule; a
   long-lived index needs a refresh loop that pulls new update files, upserts the
   new PMIDs and prunes the deleted ones.
6. **The `$/month` figures follow Cloudflare's documented formula**, in which
   stored vectors appear inside the *queried*-dimension term. Check the first
   real invoice against the table in §5 before widening the corpus.
