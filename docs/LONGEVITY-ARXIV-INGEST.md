# Longevity / ageing biology — the arXiv leg

2026-08-09, branch `claude/longevity-corpus`. Index: `deepresearch-se-arxiv`.
This is the **leaf-set** channel (`scripts/arxiv-oai-sets.mjs --sets`) plus a
**named-list** channel (`scripts/arxiv-harvest.mjs --ids`) derived from an Atom
search sweep. Neither covers a submission month, so **the §1 delta marker in
`docs/ARXIV-RAG.md` must not move.**

Headline: **996 papers** are the longevity/ageing corpus on arXiv, **625 of
them were absent** from the index and were filled. `vectorCount` **823,097 →
823,722 (+625, exact)**.

---

## 1. Be honest about the size first

Ageing biology is a PubMed field. The arXiv slice is small, and the number is
not an artefact of a strict filter — it is what arXiv holds:

| probe | arXiv-wide `totalResults` |
|---|---|
| `abs:senescence` | **81** |
| `abs:"epigenetic clock"` | **5** |
| `abs:healthspan` | 9 |
| `abs:"hallmarks of aging"` | 5 |
| `abs:geroscience` | **0** |
| `abs:senolytic` | **0** |
| `abs:"caloric restriction"` | 2 |
| `abs:longevity` | 794 |
| `abs:lifespan` | 1,194 |

The search index was checked for reliability before those counts were trusted:
the twelve harvested leaf sets contain **63** unique records whose text carries
the `senescen` stem, against the API's **81** arXiv-wide. The two agree, so the
API is not silently dropping the vocabulary — the field really is this size
here. For comparison, the AI-security leg of the same programme enumerated
84,909 ids and the AI-consciousness leg 1,218.

What arXiv does hold is the quantitative slice, and the composition of the 625
newly indexed papers shows it directly:

| primary category | added | what it is |
|---|---|---|
| q-bio.PE | 116 | evolutionary theory of ageing, Penna-model simulations |
| stat.AP | 71 | mortality modelling, Lee-Carter and successors, old-age deceleration |
| q-bio.NC | 30 | brain/cognitive ageing |
| q-bio.QM | 28 | quantitative methods, ageing clocks |
| eess.IV + cs.CV + cs.LG | 74 | brain-age estimation from MRI — the ageing-clock ML slice |
| cond-mat.stat-mech | 25 | ageing simulations that were filed as physics |
| stat.ME | 25 | mortality/frailty models |
| physics.soc-ph + physics.bio-ph | 32 | demography of mortality, biological scaling |
| q-bio.MN / TO / CB / SC / GN / BM / OT, q-fin.RM, econ.* | rest | networks of ageing, tissue ageing, longevity risk |

By submission year (5-year buckets), the added set is **not** a recent corpus:
1995–1999 **8**, 2000–2004 **48**, 2005–2009 **50**, 2010–2014 **83**,
2015–2019 **195**, 2020–2024 **239**, 2025+ **2**. That shape is the whole
reason the fill was worth running: 623 of the 625 absent papers sit **below**
the 2310 band the routine window harvest covers.

## 2. Channel choice

Two channels, chosen for what each can and cannot reach.

**Leaf sets — breadth.** All ten `q-bio` leaves plus `stat:stat:AP` and
`q-fin:q-fin:RM`. Filing on arXiv, not vocabulary, is what makes a paper
findable in bulk, and this field's home archives are small enough to take
whole: 89,370 records is a rounding error next to `cs.CR`'s 50,798 for one
category. `q-bio.NC` was included despite being mostly neuroscience because
cognitive- and brain-ageing live there; `q-fin.RM` because longevity risk and
mortality forecasting are the actuarial half of the demography slice.

```
node scripts/arxiv-oai-sets.mjs --sets q-bio:q-bio:PE,q-bio:q-bio:QM,q-bio:q-bio:TO,\
q-bio:q-bio:MN,q-bio:q-bio:CB,q-bio:q-bio:SC,q-bio:q-bio:GN,q-bio:q-bio:BM,\
q-bio:q-bio:OT,q-bio:q-bio:NC,stat:stat:AP,q-fin:q-fin:RM --out data/longevity/sets
```

**89,370 records kept of 89,370 seen in 402.4 s** — 222 rec/s at the compliant
`--pause 3000` default, zero 503s, abstracts on every record. Faster than the
138 rec/s recorded in `docs/ARXIV-RAG.md` §3.2 because q-bio pages are shorter
than cs.CR's.

**A named list — the scattered remainder.** An ageing-clock paper filed in
`cs.LG`, a population-ageing paper in `econ.GN`, a Penna-model paper in
`cond-mat.stat-mech`. Harvesting those archives whole is the wrong trade:
`cs.LG` alone is 280,329 records for a yield in the dozens. 59 Atom queries over
the field's vocabulary pooled **4,426 unique records in 543 s**; abstracts come
back inside the search response, so the filter ran there and only the keeps
were re-fetched through the canonical `--ids` harvester.

The named list is **derived, not recalled**. Writing landmark arXiv ids from
memory would be guessing, and §3.1's trap is unforgiving: one malformed id
makes arXiv reject the whole ~360-id batch and takes the good ids with it.
Every id in the list came from a query that returned it, and the list was
linted against the canonical id grammar before the request.

**cond-mat.stat-mech was considered as a thirteenth set and rejected on
evidence**, not taste. The Penna-model and ageing-simulation literature filed
there is real, but `abs:senescence` is 81 arXiv-wide and the twelve sets
already held 63 of them, so a ~90k-record harvest was projected to add single
digits over what the term sweep reaches. It added 25 through the sweep instead.

## 3. What the filter kept and dropped

`data/longevity/arxiv-filter.mjs`. Three tiers — HARD terms keep alone, SOFT
terms need an independent ageing/mortality signal, DEMOG terms need real
demographic machinery — plus a physics veto, an epidemiology veto and a
category gate.

```
records read: 89,370      unique ids: 79,730      kept: 631 (0.79%)
```

| shard | records | kept |
|---|---|---|
| q-bio.PE | 13,151 | 175 |
| stat.AP | 23,939 | 192 |
| q-bio.QM | 13,442 | 95 |
| q-bio.NC | 12,353 | 73 |
| q-bio.TO | 2,635 | 37 |
| q-fin.RM | 3,015 | 33 |
| q-bio.CB | 2,471 | 29 |
| q-bio.MN | 4,201 | 28 |
| q-bio.GN | 3,904 | 24 |
| q-bio.OT | 1,615 | 23 |
| q-bio.SC | 1,818 | 15 |
| q-bio.BM | 6,826 | 8 |

Keep tier: hard 521, soft 101, demog 9.
Drop reason: no-signal 77,801, physics-sense 799, soft-no-context 421,
epidemic-sense 48, ageing-society-boilerplate 28, non-bio-sense 2.

**Five vocabulary traps, every one of them measured against this pool rather
than guessed, and every one failing OPEN — they admit, they do not exclude.**

1. **"aging"/"ageing" on arXiv is physics.** `ti:aging` returns 7,535 items and
   the bulk are glassy and structural physical ageing, ageing in stochastic
   processes, ageing network nodes, stellar and detector ageing. The bare word
   is never a keep; only a biological or demographic compound is. 799 records
   were vetoed on this.
2. **"an ageing population" is the motivational first sentence of any paper
   that wants a reason to exist.** As a HARD term it kept **155 of 619**
   cross-category records, and the sample was fall detection, ambient-sensor
   activity classification, elder-care robots, an assistive-technology workshop
   report, a bone-scaffold materials paper — and a Chandra point-source
   catalogue of M31, where the ageing population is X-ray binaries. It now
   counts only beside fertility, mortality, life tables, dependency ratios,
   pensions or population projections. This single change removed 157 records
   from the sweep and 28 from the leaf sets.
3. **"Gompertz" is a growth curve at least as often as a mortality law** —
   tumour growth, bacterial growth, fitted COVID-19 epidemic curves
   (`2008.04989`, `1605.06309` "Verhulst, Gompertz and Bertalanffy models").
   Only `Gompertz law` / `Gompertz-Makeham` / `Gompertzian mortality` are
   unambiguous.
4. **"life expectancy" is routinely clinical** — a prostate-cancer patient's
   prognosis (`0902.1477`), an HIV cohort on ART (`1304.3720`).
5. **"longevity"/"lifespan" are used for careers, firms, links, batteries and
   wave equations.** `extended lifespan` kept an LLM-serving cache paper, a DC
   microgrid controller, a 1-d damped wave equation and a lithium-ion battery
   separator before it was demoted.

Two structural rules came out of that audit and are worth reusing:

- **A category gate.** Outside the life-science and demography archives a SOFT
  term is almost always motivation rather than subject, so records filed
  elsewhere are held to the HARD tier alone (81 further drops). It costs the
  ageing-clock ML slice nothing, because that slice is carried by HARD terms —
  "brain age prediction", "epigenetic clock", "biological age".
- **An epidemiology veto.** An outbreak paper that mentions life expectancy or
  fits a Gompertz curve is epidemiology, not the biology or demography of
  ageing. Bare `mortality` had to leave the SOFT tier entirely: combined with
  "elderly" it admitted the whole COVID-19 age-specific-mortality literature.
  `demograph` left for the same reason — "demographic inference" is population
  genetics, the most common phrase in q-bio.PE.

Sequencing note: the leaf-set pool was re-filtered **in full** with the final
filter, so its numbers are final. The sweep's 4,426-record pool was screened
with an interim version that was strictly **looser**, and every record it
admitted was then re-judged by the final filter — 619 survived the first pass
and were not already leaf-set keeps, of which **365** survive the final one.
Nothing was lost by the ordering, because every subsequent edit tightened.

## 4. The delta and the four buckets

Membership was read with `get_by_ids` over the union of both channels, never by
querying the index — a query answers "can retrieval find it", which is a
different question.

| | ids |
|---|---|
| leaf-set keeps | 631 |
| named-list keeps (not already leaf-set keeps) | 365 |
| **union, unique** | **996** |
| already in the index | 371 |
| **absent — the true delta** | **625** |

Composition of the delta, which is the whole argument for running this fill:

| band | ids |
|---|---|
| old-style ids (pre-April 2007, `cond-mat/9503099` form) | 84 |
| submission months below the 2310 band | 623 (incl. the 84) |
| inside the 2310–2607 band | 2 |

The named-list harvest reconciled exactly:

```
node scripts/arxiv-harvest.mjs --ids data/longevity/sweep-keep-ids.txt --out data/longevity/sweep
365 kept of 365 requested (0 rejected by arXiv, 0 not returned, 0 unusable) in 2 id_list calls, 4.6 s
```

| bucket | ids |
|---|---|
| requested | 365 |
| **kept** | **365** |
| rejected by arXiv as malformed | 0 |
| genuinely absent (HTTP 200, never returned) | 0 |
| unusable entries | 0 |

## 5. The fill

```
NODE_USE_ENV_PROXY=1 WRANGLER_BIN=node_modules/.bin/wrangler \
node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv \
  --corpus data/longevity/fill/raw --work data/longevity/fill/vectorize --min-abstract 50
done — 625 vectors in deepresearch-se-arxiv (0.4 min)
```

**`--min-abstract 50` was used deliberately, and the reason is specific.**
Seven of the 625 rows have an abstract under the default 200-character floor,
and they are not stubs — they are the field's landmarks:

| id | chars | title |
|---|---|---|
| `cond-mat/9503099` | 165 | A Bit-String Model for Biological Aging — **the original Penna model, 1995** |
| `0706.3101` | 107 | The Penna Model of Biological Aging (review) |
| `cond-mat/0310038` | 144 | The Complexity of Biological Ageing (review) |
| `q-bio/0411019` | 193 | A simple derivation of the Gompertz law for human mortality |
| `q-bio/0402016` | 166 | Size of the stable population in the Penna bit-string model |
| `q-bio/0607015` | 175 | Sex and hermaphroditism in the Penna model |
| `1001.3038` | 96 | Mortality and Longevity Valuation — A Quantitative Approach |

At the default floor the founding paper of the arXiv ageing-simulation
literature would have been dropped silently. 50 admits all seven and still
excludes the withdrawal stubs `--min-abstract 0` exists to keep out; 0 is
refused by the script, correctly, because an empty abstract is a permanent miss
rather than a policy choice.

Nothing was dropped: **625 rows in, 625 vectors out.**

## 6. Verification

Not from the run's own counters.

**Membership re-read**, ~90 s after the upsert, over the full union:
**996/996 present, 0 absent.** `vectorCount` **823,097 → 823,722**, exactly
+625, with `processedUpToDatetime` advancing to `2026-08-09T22:16:45Z`.

**The served path, both languages, with a nonsense control** (invariant 6):

| query | top hits |
|---|---|
| EN "the Penna bit-string model of biological ageing" | `cond-mat/0007473`, `q-bio/0502027`, `cond-mat/0011524`, `cond-mat/0102176`, `cond-mat/0102378` |
| EN "why does the mortality rate decelerate at very old ages" | `1707.09433`, `q-bio/0402034`, `1905.05760`, `q-bio/0310035`, `2106.08386` |
| EN "deep learning brain age prediction from MRI" | `2308.12416`, `2511.22102`, `2008.12965`, `2002.09045`, `2102.04438` |
| SV "evolutionära teorier om varför organismer åldras" | `2401.16052` (Why evolution needs the old), `2501.13657`, `1503.07040`, `cond-mat/0004072`, `1110.2993` |
| SV "epigenetisk klocka för att uppskatta biologisk ålder" | `2605.10541`, `2511.07219`, `2509.14422`, `1811.06018`, `2501.02401` |
| CTRL "purple bicycle harmonica tessellation quarterly" | **0 above the relevance floor** |

**18 of those 25 hits were added by this fill**, 6 were in the keep set and
already indexed, 1 was pre-existing — so the retrieval improvement is
attributable rather than assumed.

## 7. Wall clock and cost

| leg | wall clock |
|---|---|
| leaf-set harvest (12 sets, 89,370 records) | 402 s |
| Atom sweep (59 queries, 4,426 records) | 543 s |
| named-list harvest (365 ids, 2 calls) | 5 s |
| membership reads (996 ids, twice) | ~20 s |
| **fill (625 vectors)** | **26 s** |
| window re-derivation (pages the whole index) | ~150 s |

Embeddings: 625 abstracts — cents. Filter tuning, not machine time, was the
work.

## 8. Not done here, and owned elsewhere

The §1 delta marker in `docs/ARXIV-RAG.md` **must not move** — both channels
cover categories and ids, not submission months. Everything else on the §7
post-fill checklist does move, and this session does not own `docs/`, `src/` or
`scripts/`. The derived sentence from `node scripts/arxiv-window.mjs`, run
after the fill and saved to `data/longevity/arxiv-window-after.json`:

> Submission months 2310-2607 (October 2023 to July 2026) are swept in bulk —
> 780,790 papers across every subject arXiv carries. A further 42,932 papers
> (5.2%) sit OUTSIDE that band, reaching back to 1991. Those arrived through
> topic-targeted fills, so pre-2310 coverage is dense for some subjects (AI
> security, AI consciousness, ancient DNA) and near-absent for others. A
> pre-2310 miss is therefore NOT proof the paper is out of window — retry with
> different terms before concluding it is absent.

Outstanding for whoever owns those files: `CORPUS_FACTS.arxiv.window` and
`.vectors_at_fill` in `src/literature-tools.js` (the topic list should now name
longevity as a fourth), the upper-bound assertion in
`src/literature-run.test.js` if it moved, `node scripts/build-corpora.mjs` for
the public `/corpora/` page, and `npm run bundle` / `bundle:docs`.

## 9. Files

| file | what |
|---|---|
| `data/longevity/arxiv-filter.mjs` | the three-tier topical filter, with every trap documented at its regex |
| `data/longevity/arxiv-sweep.mjs` | the 59-query cross-category Atom sweep |
| `data/longevity/arxiv-count.mjs` | the size probe behind §1 |
| `data/longevity/arxiv-member.mjs` | `get_by_ids` membership, split by band |
| `data/longevity/sets/` | leaf-set harvest (89,370 records, gitignored) |
| `data/longevity/sweep/` | named-list harvest (365 records, gitignored) |
| `data/longevity/fill/` | the 625-row fill corpus + its checkpoint (gitignored) |
| `data/longevity/all-keep-ids.txt` | the 996-id corpus definition |
| `data/longevity/absent-ids.txt` | the 625 that were filled |
| `data/longevity/arxiv-window-after.json` | the post-fill index profile |

`data/` is gitignored in full, this file included — the same status as
`data/aisec/ingest-reconciliation.md`. Committing it needs `git add -f`.
