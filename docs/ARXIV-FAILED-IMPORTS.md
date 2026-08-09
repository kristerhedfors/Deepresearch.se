# Failed arXiv imports — diagnosis and disposition

Measured 2026-08-09 on branch `claude/ai-security-consciousness-corpora`, against
the live `deepresearch-se-arxiv` index (798,872 vectors when this pass started,
823,097 when it ended) and `deepresearch-se-pubmed` (1,731,517).

The three input lists are **not error logs**. Each is the output of a hosted-index
membership check (`data/aisec/check-hosted.mjs` and its siblings): "of the ids I
enumerated or cited, these are the ones `get_by_ids` did not return, at this
minute". So "why did it fail" is really two questions — why was the id absent
when the snapshot was taken, and why is it still absent now — and for most of the
1,479 list entries the answer to the second is *it is not*.

| # | Failure category | Count | Verbatim example | Fixable? | The fix |
|---|---|---|---|---|---|
| 1 | **`id_list` request line inflated by `URLSearchParams`** — the `%2C` bug. Every id after the first costs 3 bytes of separator instead of 1, so a batch sized against arXiv's measured 4,094-byte request-line limit overshoots it and arXiv answers `400 Request Line is too large`. Nothing downstream distinguishes that from "arXiv does not hold these papers". | 1,218 (the whole `data/aicon/arxiv-missing.txt`) | `0704.0646` | **Fixable — already fixed** | `fetchIdList` in `scripts/arxiv-harvest.mjs` assembles the query string by hand with raw commas (commit `846fbdcb`). Confirmed in place and pinned by `scripts/arxiv-harvest.test.mjs` ("URLSearchParams is the trap the byte budget is measured against"). Re-measured here: batch 1 of this exact list is 373 ids = **3,897 bytes raw, 4,649 encoded** — 555 bytes over the limit. |
| 2 | **Stale membership snapshot** — the list was written, fed straight into a `--ids` fill, and never regenerated, so the file still names ids that have been in the index for hours. | 1,350 of the 1,358 distinct ids across all three files (140 cited + 1,210 of the aicon 1,218) | `cs/0006013` (in `data/aisec/cited-arxiv-missing.txt`, harvested 10:43:06, pushed the same minute, present ever since) | **Fixable — nothing to ingest** | Regenerate the file. `data/cited-arxiv-all.txt` (140) is exactly the union of `data/aisec/cited-arxiv-missing.txt` (121) and `data/aicon/cited-arxiv-missing.txt` (19); all 140 sit in `data/cited-ax/raw/ids-cited-arxiv-all.jsonl` with a 140-line checkpoint. |
| 3 | **Below the index's 200-character abstract floor, but a real abstract** — `corpusRows` in `scripts/arxiv-vectorize.mjs` skipped these silently. The harvest kept them; the fill dropped them. This is the *entire* residue of every named-id fill on this branch. | 61 distinct (6 in the aicon list, 21 across the AI-security fills, 34 more in the 24,248-id delta of category 9) | `1607.04311` — Carlini & Wagner, "Defensive distillation is not secure", 146-char abstract | **Fixable — ingested** | New `--min-abstract N` flag on `scripts/arxiv-vectorize.mjs` (default unchanged at 200, so no existing pipeline moves) plus an exported `indexableRow()` predicate, unit-tested in `scripts/arxiv-vectorize.test.mjs`. Re-ran the four named-id corpora at `--min-abstract 60`/`50`; the checkpoints made every already-pushed row a no-op. |
| 3b | **A stub that clears the lowered floor.** Length is a proxy for content, not a test of it, and one withdrawal notice is long enough to pass. | 1 | `0907.1413` — `This paper is withdrawn due to some errors, which are corrected in arXiv:0912.0071v4 [cs.LG].` (93 chars) | Ingested, knowingly | None. It is a factual record that points at its own replacement, so it is left in rather than special-cased. If withdrawal notices ever become a retrieval problem, the fix is a pattern test in `indexableRow()`, not a higher floor. |
| 4 | **Administrative stub — withdrawal / removal notice.** The whole abstract is arXiv's own notice; there is no research content to embed and retrieving one as evidence is worse than retrieving nothing. | 2 | `1311.4906` — abstract, verbatim and entire: `This paper has been withdrawn by the author(s)` (46 chars); also `cs/0511015`, `This article is taken out.` (26) | **Permanent** | None. Excluded at any floor worth setting. |
| 5 | **Novelty one-word abstract.** Real papers, but the abstract carries no retrievable signal — only the title does. | 2 | `1902.02322` — abstract, verbatim and entire: `No.` (3 chars); also `1602.00251`, `Not really.` (11) | **Permanent (policy)** | None. Kept out for the same reason as #4; both are within one edit of being admissible if the owner decides a title-only vector is worth having. |
| 6 | **Zero-length abstract** — unembeddable, the standing cross-corpus example. | 1 (PubMed, not arXiv) | `pmid:10970224` (cited by `tests/evalsets/dalen.json`) | **Permanent** | None. `parseArgs` now refuses `--min-abstract 0` so this class can never be admitted by accident. |
| 7 | **Malformed id poisoning a whole batch** (`incorrect_id_format_for_…`, which takes ~360 good ids down with it). | **0 occurrences** | — | n/a | Checked, not found: all four lists lint to 0 malformed, 0 duplicate and 0 needing normalisation under `canonicalId`. The peel-off-and-retry loop in `harvestIds` is in place if one ever appears. |
| 8 | **Withdrawn or never-existent id.** | **0 occurrences** | — | n/a | arXiv returned every id asked for: 1,218/1,218 and 140/140 on the two named lists, `0 rejected, 0 not returned, 0 unusable`. |
| 9 | **Interrupted harvest leaving a `.part`.** A 24,248-id AI-security delta was killed mid-run at 14:49 with 2,261 rows written. | 1 run | `data/aisec/ax3/raw/ids-arxiv-delta.jsonl.part` | **Fixable — re-run** | `harvestIds` truncates and renames on success, so the recovery is simply to re-run: it completed 24,248/24,248 in 69 `id_list` calls / 273.6 s. |

## What the arXiv id-list channel actually costs when it goes wrong

Every one of these failure modes is silent at the transport level — HTTP 200 with
ten entries, or a 400 that names one id, or a feed with `totalResults 0`. That is
why `harvestIds` reconciles every requested id into exactly one bucket (kept /
unusable / rejected / not returned) and asserts the buckets sum before renaming
the shard into place. Categories 1, 7 and 8 above are all detectable only because
that reconciliation exists; category 3 was not, because it happens one stage
later, in the fill. It is now reported by the harvester (`N kept row(s) have an
abstract under 200 chars`) and configurable in the fill.

## Disposition

| List | Entries | In the index before | In the index now | Still absent |
|---|---|---|---|---|
| `data/aicon/arxiv-missing.txt` | 1,218 | 1,210 | **1,216** | 2 (categories 4) |
| `data/aisec/cited-arxiv-missing.txt` | 121 | 121 | **121** | 0 |
| `data/cited-arxiv-all.txt` | 140 | 140 | **140** | 0 |
| AI-security below-floor residue (`ax` + `ax2`) | 23 | 0 | **21** | 2 (category 5) |
| Whole AI-consciousness enumeration `data/aicon/arxiv-ids.txt` | 2,586 | 2,578 | **2,584** | 2 (category 4) |
| AI-security delta `data/aisec/arxiv-delta.txt` (category 9) | 24,248 | 0 | **24,246** | 2 (category 5) |

Four permanent misses in total on the arXiv side — `1311.4906`, `cs/0511015`,
`1902.02322`, `1602.00251` — plus `pmid:10970224` on the PubMed side. Nothing
else in these lists is unfixable.

The arXiv index went from 798,872 vectors to **823,097** over this pass.

## Eval-needle answerability

Recomputed from `tests/evalsets/*.json` by extracting every `goldUrls` entry, not
from the stale `cited-*` files:

| Eval set | Questions | Cite arXiv | Distinct arXiv needles | Unanswerable (arXiv) | Distinct PubMed needles | Unanswerable (PubMed) |
|---|---|---|---|---|---|---|
| `aisec` | 180 | 163 | 207 | **0** | 19 | 0 |
| `aicon` | 180 | 53 | 53 | **0** | 137 | 0 |
| `adna` | 180 | 0 | 0 | — | 187 | 0 |
| `dalen` | 56 | 0 | 0 | — | 48 | **1** (`pmid:10970224`) |
| `browsecomp` | 30 | 0 | 0 | — | 0 | — |
| `frames` | 60 | 0 | 0 | — | 0 | — |
| `simpleqa` | 60 | 0 | 0 | — | 0 | — |
| **total** | **746** | **216** | **260** | **0** | **386** | **1** |

**One** eval question in the whole suite is unanswerable from the corpora, and it
is the known permanent zero-abstract case.

## Open, outside these three lists

The AI-security enumeration in `data/aisec/arxiv-ids.txt` grew to **84,909** ids
(the rebuilt enumerator, 14:37), of which **24,248** were absent from the index at
14:48. That delta is category 9 above, and it is now done: harvested 24,248/24,248
on the retry, filled 24,212 at the default floor and 34 more at `--min-abstract
50`, verified at **24,246/24,248** by `get_by_ids`. The two absent are the
category-5 novelty abstracts.

The enumeration itself is unfinished — `data/aisec/enum.log` ends inside
`S1-syscats-guarded#0` — so the enumerated-vs-indexed number will move again as
soon as it resumes.

> `data/` is gitignored (`.gitignore:244`), so this file does not reach a commit
> unless it is force-added or moved under `docs/`.
