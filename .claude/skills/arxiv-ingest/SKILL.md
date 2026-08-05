---
name: arxiv-ingest
description: >-
  Load when RE-RUNNING the arXiv ingest into the hosted Vectorize index
  `deepresearch-se-arxiv` — "refresh arXiv", "bring the arXiv index up to
  date", "catch up on the last month of arXiv", "the arXiv index is stale",
  "rebuild the arXiv corpus", or when scheduling that refresh. The sibling of
  **pubmed-ingest**: same two runbooks (a FULL rebuild of the 34-month band and
  a DELTA of the months added since the last run), but arXiv's delta is defined
  by a DATESTAMP WINDOW rather than a file number, which makes `--until` and
  `--keep-months` the two flags that decide whether the run silently
  under-harvests. Covers finding the last-indexed month without a surviving
  checkpoint, why a delta needs no record of what is already indexed, why there
  is no prune leg, and how to verify against an enumeration that is not the
  run's own counters. For the measurements and design see docs/ARXIV-RAG.md;
  for retrieval quality see **rag-hillclimb**; for the corpus-agnostic
  discipline see **bulk-corpus-etl**.
---

# Re-running the arXiv ingest

Two modes, one pipeline:

```
OAI-PMH window → month shards → dedup → embed → Vectorize (deepresearch-se-arxiv)
```

**FULL** re-harvests the whole band the index is meant to cover (2310 → now).
**DELTA** harvests only the months added since the last run. Nothing else
differs — same scripts, same flags, same verification.

This skill is the *procedure*. `docs/ARXIV-RAG.md` is the *evidence*, the
**arxiv-rag** skill is the working knowledge of the retrieval pipeline, and
**rag-hillclimb** owns judging whether a change made retrieval better.

---

## 0. Which mode you are in

| | full rebuild | delta |
|---|---|---|
| when | the index is empty, the passage/metadata shape changed, or the covered band is being widened | routine catch-up |
| covers | 2310 → current month (34+ months) | the months since the last ingest |
| volume | ~772 k papers | ~25–30 k new submissions per month |
| wall clock | many hours — the harvest alone is rate-limited to 1 connection / 3 s | ~10 min per month of catch-up |
| embeddings | ~€6 | cents |

**The band starts at 2310 and that is deliberate, not a leftover.** arXiv's
LaTeXML HTML rendering — the thing that makes the full-text tier Worker-native
— only exists from late 2023. A "while we're here, let's go back five years"
rebuild buys papers the second tier can never read. Widening the band is a
decision with its own before/after measurement (`docs/ARXIV-RAG.md` §11), not
part of a refresh.

---

## 1. Find the last-indexed month (delta only)

The harvester checkpoints under `data/arxiv-*/state/`, but `data/` is
gitignored and the container is ephemeral, so **assume it is gone**. The
durable record is the marker line in `docs/ARXIV-RAG.md`:

```bash
grep -n 'last ingested submission month' docs/ARXIV-RAG.md
```

Then ask the index what it thinks, as a second opinion — `processedUpToDatetime`
is when the last mutation landed, which bounds how much can be missing:

```bash
node_modules/.bin/wrangler vectorize info deepresearch-se-arxiv
```

**When the two disagree, start LOWER.** Re-ingesting a month is safe (§3);
skipping one leaves a hole that nothing downstream will ever report.

---

## 2. Run it

```bash
export NODE_USE_ENV_PROXY=1                      # Node's fetch ignores HTTPS_PROXY without it
W=$PWD/node_modules/.bin/wrangler                # never bare npx — see §5

# --- harvest -------------------------------------------------------------
# --months sets the DATESTAMP window (always ending today — see §4).
# --keep-months sets which SUBMISSION months are written out.
# DELTA: a window that reaches back past the keep band's first day, keeping
#        only the months at or after the marker.
# FULL:  --months 34 and no --keep-months.
node scripts/arxiv-harvest.mjs --months 2 --keep-months 2607-2608 --out data/arxiv-delta

# --- what did we get? ----------------------------------------------------
node scripts/arxiv-corpus.mjs --corpus data/arxiv-delta/raw

# --- fill ----------------------------------------------------------------
# Point --corpus at raw/, NOT at the harvester's --out root: the root has no
# .jsonl shards in it, and the loader used to answer that with
# "done — 0 vectors" and exit 0. It now throws instead, but only because this
# happened.
WRANGLER_BIN=$W node scripts/arxiv-vectorize.mjs \
  --index deepresearch-se-arxiv \
  --corpus data/arxiv-delta/raw \
  --work data/arxiv-delta/vectorize
```

A delta of one or two months is small enough to run in a single loader. Split
it only for a full rebuild, and then by **partitioning shards across processes
with disjoint `--work` directories** — four loaders took the original fill from
~23/s to ~95/s. Do not parallelise by editing the script.

**There is no prune leg, and that is correct.** arXiv does not withdraw
papers the way PubMed's `<DeleteCitation>` does; a withdrawn paper gets a new
version whose abstract says so, which the upsert overwrites in place. Nothing
in this pipeline ever deletes a vector.

---

## 3. Why a delta needs no record of what is already indexed

- **Upsert is keyed by id, and the id is the bare arXiv id without its version
  suffix** (`2507.23787`, not `2507.23787v2`). Re-pushing a paper overwrites
  it, which is exactly what a revised abstract should do.
- Nothing is deleted, so there is no set to diff against.

So a delta is idempotent and re-runnable, and the only cost of overlapping the
window is re-embedded tokens. That is why §1 says start lower when unsure.

**The one thing a delta does NOT do** is notice a paper whose id-month falls
outside the keep band and whose abstract was revised since the last run. That
is a deliberate trade: catching every revision back to 2310 means re-harvesting
the whole band. Revisions rarely change what an abstract is *about*, which is
what retrieval reads.

---

## 4. The `--until` trap, in delta form

`--until` reproduces a past run; it does **not** slice history. `planWindow`
ties the id-month keep filter to the datestamp fetch window, which is only
sound when `until` is today: a paper submitted inside the window then
necessarily has its datestamp inside it too. Carving a historical band breaks
that, because OAI filters on the **datestamp** — a paper submitted 2025-06 and
revised in 2026 is in-window by id and is never REQUESTED. Harvesting
2310–2506 that way came back **73.5% complete** and exited 0.

For a delta the rule reduces to two lines:

- **Never pass `--until` for a catch-up run.** The default (today) is what
  makes the keep filter correct.
- **Make the datestamp window reach back past the keep band's first day.** A
  paper submitted on the 3rd of the keep band's first month and never revised
  has its datestamp on the 3rd; a window that starts on the 20th will not
  request it. `--months 2 --keep-months <last>-<current>` on the 5th of the
  month gives a comfortable margin at a cost of a few thousand re-embedded
  abstracts.

If you *do* need to repair a historical band, the fix is a SECOND PASS over
the later datestamps keeping only the band's id-months — that is what
`--keep-months` exists for:

```bash
node scripts/arxiv-harvest.mjs --months 21 --until 2025-07-01 --out data/arxiv-new
node scripts/arxiv-harvest.mjs --months 13 --keep-months 2310-2506 --out data/arxiv-rev
```

---

## 5. The traps

1. **Rate limits are a design input, not an error.** arXiv's terms are one
   request every three seconds on a single connection, counted across the query
   API, OAI-PMH and RSS together. The defaults already comply
   (`--concurrency 1 --pause 3000`); raising them is a decision, not a
   speed-up. Sustained 503s are flow control, and the harvester backs off
   rather than failing — a slow shard is usually working.
2. **`npx` cannot be run in parallel.** Concurrent `npx wrangler` calls race on
   the shared npx cache and die with `ENOTEMPTY … rename node_modules/wrangler`.
   npx revalidates on every invocation, so warming the cache first does not
   help. Point `WRANGLER_BIN` at an installed binary (`npm install --no-save
   wrangler` puts one in `node_modules/.bin/`).
3. **Background processes are killed at TURN BOUNDARIES.** A fill only advances
   while a turn is held open. Everything is checkpointed so nothing is lost,
   but "start it and come back later" does not work from an agent session. A
   delta is short enough not to care; a full rebuild wants a machine that stays
   up.
4. **`--corpus` at the harvest root pushes nothing.** See §2.
5. **`vectorCount` is eventually consistent** — it lagged the upsert stream by
   ~6 k vectors / ~2 min during the original fill. It confirms a FINISHED
   build; it cannot confirm one in progress.

---

## 6. Verify — never with the run's own counters

A harvest cannot detect its own gaps. The original 2310–2506 run kept 339,263
papers, exited 0, and was missing 48.1% of its oldest month — while its TOTAL
agreed with an independent enumeration to 0.04%. Only the per-month diff
exposed it.

```bash
# an INDEPENDENT enumeration: the public GCS mirror, unthrottled, no credentials
node scripts/arxiv-gcs.mjs --months 2 --out data/eval/gcs-delta.txt

# per-month set diff of the harvest against it (sets of ids, not counts —
# "kept" is not "unique": a paper revised in-window appears in every shard it
# touched)
node scripts/arxiv-crosscheck.mjs --raw data/arxiv-delta/raw --ids data/eval/gcs-delta.txt
```

Then check what actually landed in the index, and probe the served path in
**both** languages (invariant 6) with a nonsense control:

```bash
node scripts/rag-eval.mjs coverage --corpus arxiv --months 2607-2608
node scripts/rag-eval.mjs probe    --corpus arxiv
```

The control must return nothing above the relevance floor. Expect the current
month to be incomplete — the mirror lists a paper once its PDF is built, and
the last days of the month are simply not there yet.

---

## 7. Record what you ingested

A delta is only repeatable if the next run can find its starting point, and
`data/` does not survive. **In the same change as the ingest**, update
`docs/ARXIV-RAG.md` §1 with:

- the last submission month ingested (the marker §1 greps for),
- the resulting `vectorCount` from `wrangler vectorize info`,
- the date.

An ingest that does not update that line has made the next delta guesswork.
