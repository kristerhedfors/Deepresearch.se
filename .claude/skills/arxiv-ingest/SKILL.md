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
  run's own counters. ALSO the CATEGORY mode (§6b, `arxiv-oai-sets.mjs`) —
  "index everything arXiv has on cryptography and security", harvesting a whole
  leaf category set at a measured 138 rec/s, and the two OAI request shapes
  that do not answer at all. For the measurements and design see docs/ARXIV-RAG.md;
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

| | full rebuild | delta | named list |
|---|---|---|---|
| when | the index is empty, the passage/metadata shape changed, or the covered band is being widened | routine catch-up | "index exactly these papers" — a bibliography, a survey's references, a curated corpus |
| covers | 2310 → current month (34+ months) | the months since the last ingest | nothing but the ids given, any year back to the 1990s |
| volume | ~772 k papers | ~25–30 k new submissions per month | whatever the list holds |
| wall clock | many hours — the harvest alone is rate-limited to 1 connection / 3 s | ~10 min per month of catch-up | ~3 s per ~360 ids |
| embeddings | ~€6 | cents | cents |
| moves the §1 marker? | yes | yes | **no — §6a** |

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
# DELTA: exactly the months from the marker to now — see §4 for why one more
#        "just to be safe" is pure cost.
# FULL:  --months 34 and no --keep-months.
node scripts/arxiv-harvest.mjs --months 1 --keep-months 2607-2608 --out data/arxiv-delta

# --- what did we get? ----------------------------------------------------
# --dir, and the harvest ROOT. Not --corpus, and not raw/.
node scripts/arxiv-corpus.mjs --dir data/arxiv-delta

# --- fill ----------------------------------------------------------------
# --corpus, and raw/. The two scripts disagree about both the flag name and
# the directory level, so a copy-paste between them fails — arxiv-corpus reads
# the root, arxiv-vectorize reads raw/. Pointing the loader at the root used to
# print "done — 0 vectors" and exit 0; it now throws, but only because this
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
- **Size `--months` so the window starts at the keep band's first month —
  exactly, not earlier.** `planWindow` snaps the window start to the first of
  its oldest month, so `--months N` on any day of the month covers N-1 whole
  months plus the current one. For a keep band of `2607-2608` in August,
  `--months 1` is the right answer.

**A window month before the keep band cannot contribute anything, and that is
structural, not probabilistic.** A paper's OAI datestamp is never earlier than
its submission, so no 2607 paper has a June datestamp. Measured 2026-08-05:
`--months 2` added a 2026-06 shard that read 39,000 records and kept **zero**
before it was stopped, at three seconds a page against a rate budget shared
with everything else this project asks of arXiv. "One extra month to be safe"
is not caution here — it buys nothing and costs the scarcest resource in the
pipeline.

The margin that *does* matter runs the other way: the keep band must start at
the last INDEXED month, not the month after it, because that month was itself
harvested mid-month and its tail is missing.

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

## 6a. The named-list mode (`--ids`)

A list of arXiv ids is not a window, and the datestamp harvest cannot serve one
without sweeping every month the ids fall in. `--ids` fetches exactly the named
papers through the Atom query API's `id_list` — the sibling of PubMed's
`--pmids`, and the same reconciliation discipline:

```bash
node scripts/arxiv-harvest.mjs --ids data/my-ids.txt --out data/arxiv-ids
node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv \
  --corpus data/arxiv-ids/raw --work data/arxiv-ids/vectorize
```

Read the reconciliation line before the fill, not after it. Every requested id
lands in one of four buckets — kept, unusable, rejected by arXiv, never
returned — and the ids arXiv did not return go to
`data/arxiv-ids/state/ids-<list>-missing.txt`. `NODE_USE_ENV_PROXY=1` is
required for both legs behind the agent proxy.

**Do NOT move the §1 delta marker after one of these.** A named list covers no
month, so the marker would claim coverage nobody harvested — and the next delta
would start above a month that was never swept. Same for `CORPUS_FACTS.arxiv`:
the `window` string is about the datestamp harvest. `vectors_at_fill` does move
if the list was large enough to matter, and that is a judgement call, not a
rule.

**When a named list comes up short, check the abstract floor before anything
else.** Measured over four fills on 2026-08-09 — 1,218 AI-consciousness ids and
28,227 AI-security ids — that was the cause of *every* residual miss, without
exception: the harvest returned 100% of what it asked for, and the fill dropped
the rows whose abstract is under 200 characters. Roughly nine in ten of those
are real one- or two-sentence abstracts (Carlini and Wagner's `1607.04311` is
146 characters); the rest are administrative stubs whose whole abstract is
`This paper has been withdrawn by the author(s)`. Re-run the fill with
`--min-abstract 50` and the checkpoint makes every already-pushed row a no-op.
Keep the default on a bulk window harvest.

And check the list is still stale before working it: these lists are membership
snapshots, not error logs, and the usual reason an id is in one is that nobody
regenerated the file after the fill that resolved it. One `getByIdsBatched` read
answers it. Vectorize is eventually consistent, so never conclude a fill failed
from a read taken seconds after the upsert.

The traps this mode has that §5 does not are all in `docs/ARXIV-RAG.md` §3.1,
and every one of them is silent — an unknown id is HTTP 200 with nothing in it,
one malformed id 400s the whole ~360-id batch, a missing `max_results`
truncates the answer to ten, and the `http://` host arXiv's own docs give
returns a 0-byte body through this environment's proxy. The script handles all
four; the reason to read them is that the same shapes turn up whenever anyone
writes another arXiv client.

---

## 6b. The category mode (`arxiv-oai-sets.mjs --sets`)

A third starting point, added 2026-08-09: harvest whole **categories** rather
than a month band or a list of ids.

```bash
export NODE_USE_ENV_PROXY=1
node scripts/arxiv-oai-sets.mjs --list-sets                        # what exists
node scripts/arxiv-oai-sets.mjs --sets cs:cs:CR,cs:cs:AI --out data/arxiv-sets
node scripts/arxiv-oai-sets.mjs --sets cs:cs:CR --from 2026-07-25  # a delta
node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv \
  --corpus data/arxiv-sets/raw --work data/arxiv-sets/vectorize
```

It writes the same JSONL as the datestamp harvester — it imports `parseRecord`
and `parsePage` from it — so `arxiv-corpus.mjs` and `arxiv-vectorize.mjs` read
it unchanged.

**Why this exists.** OAI-PMH was written off here as unreliable, and that
verdict covered too much ground. What is slow and throttle-prone is the
datestamp window; a `set=`-scoped sweep is a different query. Measured
2026-08-09: full `cs.CR`, all years, 41 pages, **50,798 records in 369 s at 138
rec/s with zero 503s and no sleep between requests**, abstracts on every record.
Cross-checked against an independent snapshot of the same category (50,560) to
within 0.47%. At the compliant `--pause 3000` default that is ~490 s; the six
AI-relevant leaves are ~2.5 h.

**Two shapes do not answer, and the script refuses both by name** — `set=cs`
(whole archive) returned nothing in 120 s, twice, and `from=<date>` with no set
returned nothing in 100 s. Only leaf sets work, where a leaf is what nothing
else extends: `cs:cs:CR` has three parts, `physics:gr-qc` has two. `--list-sets`
prints all 174 sets and marks the 155 leaves.

**Which mode to pick.** A category — "index everything arXiv has on
cryptography and security" — is this one. The band the hosted index covers is
still §2's month window: harvesting all of arXiv this way would mean 174 sets
and every cross-listed paper several times. A named bibliography is §6a.

**It does not move the §1 delta marker** either, for §6a's reason: a set harvest
covers categories, not submission months. Its `manifest.json` is stamped
`channel: "oai-sets"` and carries no month window, so nothing downstream can
mistake it for a band.

**The parquet snapshot was considered and rejected.** A community Hugging Face
mirror of arXiv metadata scans the whole corpus in ~5 minutes, faster than any
of this, and was measured complete to its cut date. Taking it would mean a new
dev dependency (**duckdb**, which `docs/DEPENDENCIES.md` §5/§8 requires arguing
one at a time) and a bot account's snapshot with no guaranteed refresh. Do not
re-open it without new evidence on those two points; the seven-channel
comparison is `data/aisec/enumeration-options.md`.

---

## 7. Record what you ingested

A delta is only repeatable if the next run can find its starting point, and
`data/` does not survive. **In the same change as the ingest**, update
`docs/ARXIV-RAG.md` §1 with:

- the last submission month ingested (the marker §1 greps for),
- the resulting `vectorCount` from `wrangler vectorize info`,
- the date.

An ingest that does not update that line has made the next delta guesswork.

**And then the SERVED copy, which is a different file and is the one users
meet.** `CORPUS_FACTS.arxiv` in `src/literature-tools.js` carries a `window`
string and a `vectors_at_fill` count that the MCP literature tools quote **on
every miss** — `literature_corpora` exists precisely so an agent can tell a
real miss from an out-of-window one. A delta that grows the index without
moving those two tells an agent that a paper it just indexed is outside the
window, which is worse than saying nothing: it is a confident wrong answer to
the exact question the field was added to answer.

Found on 2026-08-05, the first time this runbook was used: the delta reached
2608 and the served window still read `2310–2607`. Caught by calling
`literature_corpora` against production and reading its `coverage_window`
beside its `vectors_live` — which is the check, and takes one call.
`src/literature-run.test.js` now pins the window's upper bound against the
recorded fill so the two cannot drift apart silently again.

So the ingest is not done until all four move together:

1. `docs/ARXIV-RAG.md` §1 marker line (and §1's headline window, if it moved),
2. `CORPUS_FACTS.arxiv.window` and `.vectors_at_fill` in `src/literature-tools.js`,
3. the upper-bound assertion in `src/literature-run.test.js`,
4. `npm run bundle` / `bundle:docs`, since 1 and 2 stale the artifacts.
