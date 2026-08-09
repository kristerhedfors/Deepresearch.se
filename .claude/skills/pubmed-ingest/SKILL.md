---
name: pubmed-ingest
description: >-
  Load when RE-RUNNING the PubMed ingest into the hosted Vectorize index
  `deepresearch-se-pubmed` — "refresh PubMed", "bring the PubMed index up to
  date", "catch up on the last month of PubMed", "rebuild the PubMed corpus
  from scratch", "the biomedical index is stale", or when scheduling that
  refresh. ALSO load it to index a NAMED LIST of citations — "index these
  PMIDs", "add this researcher's papers", "make sure this bibliography is
  searchable", "the corpus does not have X's work" — which is the `--pmids`
  mode. THREE runbooks in one skill because they are the same pipeline with a
  different starting point: a FULL rebuild (empty index, ~1.64 M citations,
  ~2.3 h of held turn, ~EUR 13.55), a DELTA (only the archive files added
  since the last run, minutes, cents), and a NAMED LIST (explicit PMIDs through
  E-utilities efetch, seconds — and it must never move the delta marker).
  Covers how to find the last-ingested file without a surviving checkpoint, why
  a delta needs no record of what is already in the index, the annual-baseline
  cutover that turns a delta back into a rebuild, the two ways efetch loses a
  citation silently, and the four traps that broke the first fill. For the
  measurements, cost model and constraints see docs/PUBMED-RAG.md; for the
  provider-agnostic discipline see the **bulk-corpus-etl** skill.
---

# Re-running the PubMed ingest

Two modes, one pipeline:

```
listing → plan (newest first) → download → parse → JSONL → dedup+partition → embed → Vectorize
```

**FULL** starts at the first file above the annual baseline. **DELTA** starts
at the file after the last one already ingested. Nothing else differs — same
scripts, same flags, same verification.

Before either, read `docs/PUBMED-RAG.md` §5 (what the corpus costs per month)
and §7 (what the first fill measured). This skill is the *procedure*; that
document is the *evidence*.

The sibling runbook for the other hosted corpus is **arxiv-ingest**. Same
shape, one structural difference worth knowing before you assume they
transfer: a PubMed delta starts at an archive FILE NUMBER, an arXiv delta at a
DATESTAMP WINDOW — so arXiv has a whole class of silent under-harvest that
cannot happen here.

---

## 0. Which mode you are in

| | full rebuild | delta | **named list** |
|---|---|---|---|
| when | the index is empty, the passage/metadata shape changed, or NLM cut a new annual baseline | routine catch-up | a bibliography, a reading list, one author's works — "index exactly these citations" |
| starts at | the first file above the baseline (`n1335` for the 2026 baseline) | the file after the last ingested | nowhere; it has no window |
| volume | ~1.64 M citations | ~30–60 k per week of updates | as many as you list |
| wall clock | ~2.3 h at ~200 vectors/s across 8 loaders | minutes | seconds |
| embeddings | ~€13.55 | cents | fractions of a cent |

**The annual baseline cutover is the one that catches people.** NLM cuts a new
baseline every December and renumbers from `pubmed<YY>n0001`. When that
happens the old file numbers are meaningless, the delta marker is stale, and
the only correct move is a FULL rebuild against the new baseline. Check the
year prefix in the listing before trusting a delta.

### The named-list mode (`--pmids`), and the one rule that makes it safe

`node scripts/pubmed-harvest.mjs --pmids <file> --out <dir>` fetches an explicit
PMID list through E-utilities `efetch` (200 ids per request) instead of
streaming archive files. Same parser, same filters, identical JSONL — so the
vectorize leg is unchanged. Full description: `docs/PUBMED-RAG.md` §4.2.

Reach for it when the load-order window is the reason something is missing
rather than a retrieval failure. The 2026-08-08 case: a named researcher's 169
PubMed-indexed papers, of which the corpus held **18**, because 89% of the work
predates the baseline and had not been revised since. Filling that from the
archive would mean downloading tens of gigabytes for a few hundred kilobytes.

> **A `--pmids` run is NOT a delta and must never move the delta marker in
> `docs/PUBMED-RAG.md` §7.** It adds citations from anywhere in PubMed's
> history, so it says nothing about how far up the archive the load-order sweep
> has reached. Moving the marker makes the next delta skip every file in
> between — a silent hole of exactly the kind §6's verification exists to catch.
> Record the run in §7 instead.

Two things that will bite, both reproduced:

- **`efetch` loses records silently.** A book PMID returns
  `<PubmedBookArticle>`, which the article parser does not match; a PMID PubMed
  does not hold is simply absent, HTTP 200, no `<ERROR>`. The harvester now
  reconciles every requested id into kept / filtered / book / never-returned and
  asserts they sum before renaming the shard — do not weaken that.
- **Records below the 200-char abstract floor are dropped, and that is
  correct.** Replies, corrections and policy letters go; 11 of 151 and 3 of 87
  in the first run. They are not retrievable text and the rest of the corpus
  obeys the same rule. Watch for the knock-on: if one of those PMIDs is also a
  needle in a gold set, that needle is now unanswerable and will read as a
  retrieval failure forever. Re-check gold sets after any ingest.

### A named list can be a whole FIELD, not just a bibliography

The 2026-08-09 run took the same path to 31,310 PMIDs — every abstract-bearing
ancient-DNA citation in PubMed, back to 1961 — and nothing about the mechanics
changed. Two things that only show up at that size:

- **Chunk the fill; it resumes.** 28.6k rows is ~17 minutes at ~29 vectors/s,
  longer than an agent's command timeout. `--limit N` plus the checkpoint in
  `--work` makes that a non-issue: re-running continues where it stopped, and
  `--limit` counts rows PUSHED this run, not rows read. Three runs at 6k/12k/11k
  finished it. Do NOT background it — the ingest skill's own trap list records
  background processes dying at turn boundaries.
- **Validate the enumeration against sets the query did not choose.** A query
  cannot detect its own gaps. Use two independent positive sets and report raw
  AND scope-adjusted recall separately; if a validation set is partly off-target
  (a palaeogeneticist's bibliography also contains modern conservation
  genomics), the raw denominator will push the query toward the wrong
  literature. Commit the query string — a corpus nobody can reproduce cannot be
  extended or audited.

The precision leaks worth knowing before designing one of these, all measured:
`extinction[tiab]` is mostly **fear-extinction** neuroscience (+45,473),
`graves` is **Graves' disease** (+31,000), `moa` is **mechanism of action**,
`fossil` is **fossil fuel**, `quagga` is **quagga mussel**, `mumm*` is **aphid
mummies**, and `"a-DNA"[tiab]` tokenizes to the phrase "a DNA" (+49,664).
`Fossils`/`Paleontology`[MeSH] are near-zero precision under a permissive
molecular gate, and `Hominidae`[MeSH] subsumes *Homo sapiens* — 23.7M records.

---

## 1. Find the last-ingested file (delta only)

The harvester's `data/pubmed/state/done.json` records every file it fetched —
but `data/` is gitignored and the container is ephemeral, so **assume it is
gone**. The durable record is the one line in `docs/PUBMED-RAG.md` §7 naming
the window that was ingested, and the `PUBMED_INGEST` marker below it.

```bash
grep -n 'last ingested archive file' docs/PUBMED-RAG.md
```

If that line is missing or you do not trust it, do NOT guess — a delta that
starts too high leaves a silent hole, and one that starts too low costs
embeddings but is harmless. **When in doubt, start lower.** Re-ingesting a file
is safe (§3 explains why); skipping one is not.

Then list what exists now:

```bash
curl -s https://ftp.ncbi.nlm.nih.gov/pubmed/updatefiles/ | grep -o 'pubmed[0-9]*n[0-9]*\.xml\.gz' | sort -u | tail -3
```

---

## 2. Run it

Both modes, differing only in `--min-file` and `--parts`:

```bash
W=$(command -v wrangler || echo npx)     # see §5 — npx cannot be used in parallel
export NODE_USE_ENV_PROXY=1              # Node's fetch ignores HTTPS_PROXY without it

# --- harvest -------------------------------------------------------------
# FULL:  --min-file 1335        (the first file above the 2026 baseline)
# DELTA: --min-file <last + 1>  into a SEPARATE --out, so the partition step
#        below splits only the new records
node scripts/pubmed-harvest.mjs --min-file 1558 --out data/pubmed-delta

# --- what did we get? ----------------------------------------------------
node scripts/pubmed-corpus.mjs --out data/pubmed-delta

# --- dedup once, then split ---------------------------------------------
# FULL: --parts 8. DELTA: --parts 2 — eight loaders over a few thousand rows
# each spend more time starting than working.
node scripts/pubmed-partition.mjs \
  --corpus data/pubmed-delta/raw --out data/pubmed-delta/parts --parts 2

# --- fill, one loader per part, in parallel ------------------------------
for p in 00 01; do
  WRANGLER_BIN=$W node scripts/pubmed-vectorize.mjs \
    --index deepresearch-se-pubmed \
    --corpus data/pubmed-delta/parts/$p \
    --work data/pubmed-delta/vectorize/$p \
    --state data/pubmed-delta/state/done.json &
done; wait

# --- remove what the archive withdrew ------------------------------------
WRANGLER_BIN=$W node scripts/pubmed-vectorize.mjs --index deepresearch-se-pubmed \
  --corpus data/pubmed-delta/parts/00 --work data/pubmed-delta/vectorize/00 \
  --state data/pubmed-delta/state/done.json --prune --limit 0
```

`--state` must point at the delta's own `done.json`, or `--prune` reads an
empty withdrawn set and silently removes nothing.

---

## 3. Why a delta needs no record of what is already indexed

This is the property that makes the whole thing cheap, and it is worth
understanding before you go looking for a checkpoint that does not exist:

- **Upsert is keyed by id.** A vector id is `pmid:<PMID>`. Re-pushing a PMID
  overwrites it, which is exactly what a *revised* citation should do — the
  update file carries the corrected abstract, and the index should hold the
  correction.
- **Delete is a no-op for an id the index never held**, so `--prune` can
  submit every withdrawn PMID it knows about without checking first. (It used
  to filter against the local checkpoint, which meant a delta on a fresh
  container pruned nothing at all — fixed 2026-07-31.)

So a delta is idempotent and re-runnable. The only cost of over-lapping the
window is re-embedded tokens, which is why §1 says start lower when unsure.

**The one thing a delta does NOT do** is notice a citation that was already in
the index and has since been revised in a file you skipped. That is the same
hole as skipping the file outright, and it is why the delta marker matters.

---

## 4. Verify — never with the run's own counters

The rule the arXiv build paid for: a harvest cannot detect its own gaps. Its
totals agreed with themselves to 0.04% while 48.1% of a month was missing.

```bash
# Vectorize's own count. It lags a live fill (it tracks processedUpToMutation),
# so it confirms a FINISHED build and cannot confirm one in progress.
wrangler vectorize info deepresearch-se-pubmed

# An independent enumeration: real PMIDs from E-utilities, diffed against the
# corpus. hasabstract is on by default and must stay on — sampling ALL PMIDs
# compares two different populations and reports the abstract filter as a
# coverage hole (it read 4.6% missing that way; 0.1% compared like with like).
node scripts/pubmed-enumerate.mjs --ids --month 2026/08 --sample 1500
```

Expect ~0.1–0.2% missing on a settled month and more on the current one — the
last update file is cut mid-month, so the final days are simply not published.

Then probe the served path, in **both** languages (invariant 6), and include a
nonsense control — which since 2026-08-01 is one command, and the retrieval
quality behind it is the **rag-hillclimb** skill:

```bash
node scripts/rag-eval.mjs probe    --corpus pubmed          # incl. the controls
node scripts/rag-eval.mjs coverage --corpus pubmed --months "2026/06,2026/07"
```

The older hand-run form, for reference:

```bash
# on-topic EN, on-topic SV, and "best pizza recipe napoletana dough"
# The control must return NOTHING above the 0.01 rerank floor, or the
# fall-through to Europe PMC is broken.
```

---

## 5. The four traps that broke the first fill

Each of these cost real time on 2026-07-31 and each is now guarded, but the
guards only help if you use them.

1. **`npx` cannot be run in parallel.** Eight concurrent `npx wrangler` calls
   race on the shared npx cache and die with
   `ENOTEMPTY … rename node_modules/wrangler`. npx revalidates on every
   invocation, so warming the cache first does not help. Set `WRANGLER_BIN` to
   an installed binary.
2. **Background processes are killed at TURN BOUNDARIES** — not by memory, not
   by a timeout. A fill only advances while a turn is held open. Everything is
   checkpointed so nothing is lost, but "start it and come back later" does not
   work from an agent session. A delta is short enough not to care; a full
   rebuild wants a machine that stays up.
3. **`pkill -f` matches your own shell.** Killing loaders with a pattern that
   appears on the calling command line kills the caller (exit 144, twice). Put
   the stop/start logic in a *script file* so the pattern is never in the
   caller's argv.
4. **Duplicate loaders on one part double-embed.** Starting a second set
   without stopping the first is silent — the checkpoint dedups the *result*,
   so only the bill shows it. Check membership per part, not by total count:
   `ps -eo args | grep -o 'parts/[0-9][0-9]' | sort | uniq -c`.

---

## 6. Record what you ingested

A delta is only repeatable if the next run can find its starting point, and
`data/` does not survive. **In the same change as the ingest**, update
`docs/PUBMED-RAG.md` §7 with:

- the last archive file ingested (the marker §1 greps for),
- the resulting `vectorCount` from `wrangler vectorize info`,
- the date.

An ingest that does not update that line has made the next delta guesswork.
