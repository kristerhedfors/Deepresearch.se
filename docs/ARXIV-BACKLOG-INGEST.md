# AI-security arXiv backlog — ingest reconciliation

2026-08-09, branch `claude/ai-security-consciousness-corpora`. Index:
`deepresearch-se-arxiv`. This is the **named-list** path
(`scripts/arxiv-harvest.mjs --ids`), so it covers no submission month and
**does not move the delta marker** in `docs/ARXIV-RAG.md` §1.

---

## 1. What the delta actually was

`data/aisec/arxiv-ids.txt` holds **84,909** unique ids from the (now killed)
Atom enumeration. An id needs fetching only if the index does not already hold
it, and most of this list falls inside the band the routine arXiv fill already
covers (2310–2608), so the enumeration count is not the delta.

Membership was established by **paging the index's entire id set** —
`GET /vectorize/v2/indexes/deepresearch-se-arxiv/list?count=1000`, 799 pages,
135 s — rather than by a per-id read-back. It returned **798,845 unique ids**,
exactly equal to the `vectorCount` reported by `wrangler vectorize info`.

Eventual consistency was ruled out rather than assumed: all **28,204** ids in
the local checkpoints of the two earlier arms (`ax/vectorize/pushed.txt`,
`ax2/vectorize/pushed.txt`) appear in that listing — 0 missing — so the listing
is not lagging behind our own writes.

| | ids |
|---|---|
| enumerated (`arxiv-ids.txt`) | 84,909 |
| already in the index | 60,661 |
| **absent — the true delta** | **24,248** |

The delta was written to `data/aisec/arxiv-delta.txt`.

Composition — it is almost entirely material *below* the index's window, which
is why it was missing rather than because the band fill failed:

| band | ids |
|---|---|
| old-style ids (pre-April 2007, `cs/0603067` form) | 212 |
| submission months 2007-04 … 2023-09 (below the 2310 band) | 23,904 |
| inside the 2310–2608 band | 132 |

103 of those 132 are `2608` — submitted after the 2026-08-05 band delta.

## 2. Harvest — the four buckets

```
node scripts/arxiv-harvest.mjs --ids data/aisec/arxiv-delta.txt --out data/aisec/ax3
```

69 `id_list` calls, 273.6 s, at the published 1-request-per-3-s rate.

| bucket | ids |
|---|---|
| requested | 24,248 |
| **kept** | **24,248** |
| withheld by arXiv (rejected as malformed) | 0 |
| genuinely absent (HTTP 200, never returned) | 0 |
| unusable entries (returned, no parsable record) | 0 |

**24,248 + 0 + 0 + 0 = 24,248** — the buckets sum to the request, and
`harvestIds` asserts this itself before it renames the `.part` shard.
`data/aisec/ax3/state/ids-arxiv-delta-missing.txt` is empty, as the zero
absent-bucket implies.

Shard: `data/aisec/ax3/raw/ids-arxiv-delta.jsonl` (24,248 rows, 24,248 unique
ids).

**36 kept rows have an abstract under the 200-character index floor**, so
`arxiv-vectorize.mjs` skips them by design and they never reach the index.
Eligible rows: **24,212** (23,877 pre-2310, 209 old-style, 126 in-band).

## 3. Embed and upsert

```
NODE_USE_ENV_PROXY=1 WRANGLER_BIN=node_modules/.bin/wrangler \
node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv \
  --corpus data/aisec/ax3/raw --work data/aisec/ax3/vectorize
```

95 batches, **13.0 min**, ~31 vectors/s sustained. No batch failed, so nothing
had to be resumed.

| | |
|---|---|
| eligible corpus rows | 24,212 |
| **vectors upserted** | **24,212** |
| eligible rows left unpushed | 0 |

| | vectorCount |
|---|---|
| before | 798,845 |
| after (15:07:25Z mutation, read 15:09Z) | **823,097** |

+24,252 in total, of which **24,212 came from this leg**. The other +40 landed
in the same minutes from a concurrent process outside this run: 34 of the
sub-floor rows above were pushed into the same work directory at 15:07:22Z
(hence `ax3/vectorize/pushed.txt` carries 24,246 ids, not 24,212), plus 6
others. Every id in that checkpoint is genuinely in the index — see §4.

## 4. Verification

A deterministic 1-in-8 sample of `ax3/vectorize/pushed.txt` read back through
`getByIdsBatched`: **3,031 sampled, 3,031 present, 0 absent.**

## 5. Two things this run does NOT license

1. **The §1 delta marker in `docs/ARXIV-RAG.md` stays at `2608`.** A named
   list covers no month; moving the marker would claim coverage nobody swept.
2. **`CORPUS_FACTS.arxiv.window` in `src/literature-tools.js` is now
   understating the index.** It still says "Anything submitted before October
   2023 is NOT in this index — that is a window, not a retrieval failure," and
   the MCP literature tools quote it on every miss. After this leg the index
   holds 24,086 pre-2310 AI-security papers from this run (23,877 + 209), on
   top of the pre-2310 share of the 28,204 already pushed by the earlier arms.
   The window string is a capability claim, so it is flagged here rather than
   rewritten: the honest form is a full 2310–2608 band plus a curated
   pre-2310 AI-security subset.
