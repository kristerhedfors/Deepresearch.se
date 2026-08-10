# Longevity / ageing biology — PubMed ingest

2026-08-09, branch `claude/longevity-corpus`. Index: `deepresearch-se-pubmed`.
The fourth research domain, beside ancient DNA, AI cybersecurity and AI
consciousness.

This is the **named-list** path (`scripts/pubmed-harvest.mjs --pmids`). It
covers no archive file, so it **does not move the delta marker** in
`docs/PUBMED-RAG.md` §7. Record it in §7 as a named-list fill instead.

---

## 1. The query set, and why it is the scope decision

`data/longevity/pubmed-query.txt` — generated from `data/longevity/arms.mjs`,
never hand-edited, so the committed query and the query that ran cannot drift.

Ageing is not a field the size of ancient DNA. The first draft used the obvious
pattern — hallmark mechanism vocabulary ANDed with a loose ageing anchor — and
enumerated **248,590** abstract-bearing records. For orientation: PubMed holds
**137,130** abstract-bearing records with an ageing word in the *title* alone.
So the query is not a retrieval detail here; it is the corpus definition, and it
was settled against counts rather than adjectives.

The corpus is defined as **papers whose subject is the biology, measurement or
demography of ageing and longevity** — not papers that merely study old people.
`"Aging"[MeSH]` is assigned to any study with old subjects, so in this query set
it can *qualify* a record and never *selects* one. Two kinds of arm:

* **standalone** (g1–g5, GEN, DEMO) — vocabulary that essentially cannot occur
  outside ageing biology;
* **anchored** (ORG, INTERV, CLIN) — vocabulary shared with other fields,
  admitted only when ageing is the announced subject: an ageing term in the
  TITLE, or an unmistakable core term anywhere.

### Per-arm counts (esearch, with abstract, before the union)

| arm | | records |
|---|---|---|
| g1 | geroscience proper (geroscience, senolytic, hallmarks of aging) | 6,952 |
| g2 | healthspan and lifespan extension | 14,532 |
| g3 | ageing clocks and biomarkers | 11,032 |
| g4 | human longevity, centenarians | 5,310 |
| g5 | senescence / immune-ageing biology (SASP, inflammaging) | 15,164 |
| GEN | human longevity genetics | 4,510 |
| ORG | model organisms and comparative biology | 12,638 |
| INTERV | geroscience interventions | 14,246 |
| CLIN | clinical translation and its failures | 6,770 |
| DEMO | demography and the population side | 4,209 |
| | union | 68,308 |
| | removed by the exclusion arm | 1,023 |
| | **final** | **67,291** |

### The scope tiers, all measured end to end

| tier | | records |
|---|---|---|
| A | geroscience core only (g1–g4) | 34,193 |
| A2 | A + senescence/immune-ageing biology | 46,698 |
| X3 | A + GEN + ORG + INTERV + DEMO, without g5 | 51,747 |
| X2 | A2 + GEN + ORG + INTERV + DEMO | 63,128 |
| **→** | **shipped: X2 + CLIN + the two validation fixes** | **67,291** |
| C | the full core vocabulary g1–g7 alone | 60,444 |
| D | full core + every arm except mechanisms | 82,582 |
| E | everything, including mechanism vocabulary | 101,699 |

The brief set the ancient-DNA fill (31,310) as the benchmark and ~60,000 as the
point to stop. **Tier A hits the benchmark exactly and is the wrong corpus**: it
silently drops model organisms, interventions and demography, each named in the
brief. The shipped tier is the widest one that still reads as a corpus rather
than as "everything with age in it". It overshoots the ceiling by **12%**, which
is stated here rather than hidden. Tiers D and E were measured and *not* run:
going there is a scale decision, not a query decision.

### What is deliberately excluded

Each block was written, counted, and left out. All are kept verbatim as
`excluded:` lines in the query file, so adding one back is a one-line change.

| block | records | |
|---|---|---|
| MECH | 41,726 | hallmark mechanism vocabulary (telomeres, proteostasis, mTOR, mitophagy, stem-cell exhaustion, cellular senescence) with ageing in the title. The biggest single block, and the first thing to add if the corpus may grow. |
| g6 | 8,618 | progeroid syndromes and premature ageing |
| g7 | 12,400 | the anti-ageing literature |
| DEMO_REPRO | 4,016 | reproductive and ovarian ageing |
| DEMO_LE | 5,468 | life expectancy / life tables |

### Precision leaks, measured — this is what the exclusion arm is for

| | records | |
|---|---|---|
| `"age-related"[ti]` family | 51,471 | the house style of organ-specific clinical work; **15,647** carry age-related macular degeneration in the title alone. Excluded from the strict title anchor. |
| `"anti-aging"` + cosmetic/skin/wrinkle | 4,186 | dermatology and skincare |
| `"accelerated aging"[tiab]` | 6,031 | largely device shelf-life testing; dropped from the core |
| leaf senescence, fruit ripening | | plant biology |
| wine/cheese/meat aging, thermal aging, asphalt, age hardening | | the materials and food senses of "aging" |
| facial / vaginal / skin rejuvenation | | cosmetic surgery |
| aging in place, aging workforce, nursing home, pension | | health services and policy |

Every exclusion clause is guarded by an inner NOT over an ageing-biology signal
set — the same shape `scripts/pubmed-adna-query.txt` uses — so a record that
leaks in on one of these terms but also speaks ageing biology is kept. The arm
removed 1,023 records: small, because the arms are already tight.

MeSH is carried throughout, not as decoration: `Cellular Senescence`,
`Longevity`, `Aging, Premature`, `Progeria`, `Telomere`, `Telomere Shortening`,
`Sirtuins`, `Caloric Restriction`, `Sirolimus`, `Metformin`, `Resveratrol`,
`Parabiosis`, `Klotho Proteins`, `Caenorhabditis elegans`, `Drosophila`,
`Mole Rats`, and `Macular Degeneration` in the exclusion arm.

---

## 2. Enumeration

`node data/longevity/enumerate.mjs` — E-utilities `esearch`, POST, `tool=` and
`email=` on every request, 350 ms pacing (inside the unkeyed 3/s ceiling),
progressive backoff on 429/5xx.

Sharded by **publication year**, not paged through the history server: esearch
refuses `retstart` past ~10k, and the AI-security leg found the history server
answering "Search Backend failed" on queries this long.

| | |
|---|---|
| unpartitioned esearch total | 67,291 |
| year-slice sum | 74,538 |
| **unique PMIDs** | **67,291** |
| wall clock | 2.1 min |

The 7,247 gap between the slice sum and the total is not a defect: a PubMed
`[dp]` can span two calendar years (`2025 Dec-2026 Jan`), so a record is counted
in both slices and deduplicated once. Two records fell outside the 1945–2027
loop entirely and were recovered by an explicit `NOT ("1945"[dp] : "2027"[dp])`
query — the kind of residue a year-partition cannot see about itself.

| decade | records |
|---|---|
| 1950s–1970s | 245 |
| 1980s | 1,017 |
| 1990s | 2,585 |
| 2000s | 8,464 |
| 2010s | 23,630 |
| 2020s | 38,597 |

### Cross-check against channels the query did not choose

A query cannot detect its own gaps, and the year-sum check above is the same
esearch talking to itself. Two independent channels:

**Europe PMC** — a different index over the same literature. Its PMID set for a
narrow topic is a positive set this query had no hand in choosing.

| probe | covered |
|---|---|
| geroscience | 522 / 522 — 100.0% |
| senolytic | 999 / 1,000 — 99.9% |
| inflammaging | 997 / 1,000 — 99.7% |
| epigenetic clock | 597 / 597 — 100.0% |
| centenarian | 1,000 / 1,000 — 100.0% |
| naked mole-rat | 539 / 547 — 98.5% |
| caloric restriction + lifespan | 629 / 707 — 89.0% |
| mortality plateau | 24 / 24 — 100.0% |

**Author bibliographies** — eight leading ageing researchers, selected by name.
Reported raw *and* scope-adjusted, because a geroscientist also publishes
off-topic and a raw denominator would push the query toward the wrong
literature. The on-topic criterion is NLM's own MeSH indexing (`Aging`,
`Longevity`, `Cellular Senescence`, `Aging, Premature`) — assigned by NLM, not
by this query.

| author | raw | scope-adjusted |
|---|---|---|
| Horvath S (epigenetic clocks) | 283/1,030 — 27.5% | 207/244 — **84.8%** |
| Campisi J (senescence) | 149/360 — 41.4% | 127/213 — **59.6%** |
| Kaeberlein M (geroscience) | 195/248 — 78.6% | 123/139 — **88.5%** |
| Partridge L (Drosophila) | 176/459 — 38.3% | 150/178 — **84.3%** |
| Kenyon C (*C. elegans*) | 54/740 — 7.3% | 51/65 — **78.5%** |
| de Magalhães JP (comparative) | 84/166 — 50.6% | 73/113 — **64.6%** |
| Vaupel JW (demography) | 81/197 — 41.1% | 67/124 — **54.0%** |
| Barzilai N (centenarians/TAME) | 159/328 — 48.5% | 123/152 — **80.9%** |

Read the raw column with care: "Kenyon C" matches several authors, so 7.3% is a
property of the name, not of the corpus.

The two low scope-adjusted figures are **the documented exclusions showing
through, not unknown holes**: Campisi's senescence cell biology is largely MECH,
and Vaupel's work is largely DEMO_LE. Both blocks were measured and excluded on
purpose, and both are one edit from being added.

### Two gaps the cross-check DID find, and the fixes

Neither was visible by reading the query again; both came from Europe PMC.

* **Plurals in the title anchor.** *"…Unlimited Reproductive Lifespans in Naked
  Mole-Rat Queens"* did not match, because a PubMed `[ti]` term matches the
  token and `lifespan[ti]` is not `lifespans`. The anchor gained `lifespans`,
  `"life spans"`, `healthspans`, `"long-lived"`, `"short-lived"`.
* **The long-lived comparative models.** Anchoring the organism arm on ageing
  vocabulary covered only **28.3%** of the naked mole-rat literature: its
  cancer-resistance, hypoxia and genome-stability papers never say "ageing" —
  they are longevity papers by virtue of the *animal*. A standalone clause
  (naked mole-rat, blind mole rat, bowhead whale, Greenland shark, ocean quahog,
  *Turritopsis*, Brandt's bat) took that to **98.5%**. Its one exclusion is not
  biological: "Naked Mole-Rat Algorithm" is a published optimisation
  metaheuristic.

The two fixes added 1,757 records. The residual 89.0% on "caloric restriction +
lifespan" was sampled and is the scope working: the misses are metabolism,
fertility and bone-loss papers that mention both words.

---

## 3. The delta — what the index did not already hold

`node data/longevity/check-hosted.mjs`. Membership read **by id**
(`get_by_ids`, 20 per call), never by querying: a dense query always returns its
nearest neighbours however far away they are, so "is this document in the index"
is not a question a query can answer.

| | PMIDs |
|---|---|
| enumerated | 67,291 |
| already in the index | 10,376 (15.4%) |
| **absent — the true delta** | **56,915** |

Read in 12.5 min. Eventual consistency was ruled out rather than assumed: a
2,000-id sample of the *absent* set was re-read after a 20 s pause and **0**
turned out to be present. This run also wrote nothing before it read.

15.4% prior coverage is what the load-order window predicts — the index holds a
recent-edit slice of PubMed, not a subject slice, so a field's older literature
is systematically outside it.

---

## 4. Harvest — the four buckets

```
node scripts/pubmed-harvest.mjs --pmids data/longevity/pubmed-delta.txt \
  --out data/longevity/corpus
```

Run in 12 chunks of 5,000 (`data/longevity/run-harvest.sh`). A single
56,915-id run died at 1,600 ids with a bare `Error: terminated` from the efetch
stream, and `harvestPmids` writes one `.part` and renames at the end — so there
was no resume point. One shard per chunk turns that failure into "re-run the
chunk". Three chunks needed a second attempt; none needed a third.

| bucket | PMIDs |
|---|---|
| requested | 56,915 |
| **kept** | **56,688** |
| withheld — dropped by filters | 186 |
| book records (`<PubmedBookArticle>`) | 41 |
| genuinely absent (HTTP 200, never returned) | 0 |

**56,688 + 186 + 41 + 0 = 56,915** — the buckets sum to the request, and
`harvestPmids` asserts this itself before renaming each shard. Every
`*-missing.txt` is empty, as the zero absent-bucket implies.

All 186 filter drops are `short_abstract`: abstracts under the 200-character
index floor, skipped by design and counted here rather than discovered later.
That is 0.33% of the request, and it is the same rule the rest of the corpus
obeys. The 41 book records are GeneReviews-style entries with no abstract
element this corpus can embed.

Wall clock: 25.1 min including retries, 285 efetch calls at 200 ids each.

Composition of the harvested rows by decade — note how much of it is old
literature the load-order window could never have reached:

| decade | rows |
|---|---|
| pre-1970 | 20 |
| 1970s | 226 |
| 1980s | 1,008 |
| 1990s | 2,578 |
| 2000s | 7,891 |
| 2010s | 20,213 |
| 2020s | 24,753 |

---

## 5. Embed and upsert

```
NODE_USE_ENV_PROXY=1 WRANGLER_BIN=node_modules/.bin/wrangler \
node scripts/pubmed-vectorize.mjs --index deepresearch-se-pubmed \
  --corpus data/longevity/corpus/raw --work data/longevity/corpus/vectorize
```

Driven in bounded rounds by `data/longevity/run-fill.sh` (`--limit 6000`), which
exists because the interruptions are expected rather than exceptional: an agent
session kills background processes at turn boundaries and a ~57k fill is far
longer than one command timeout. The loader is checkpointed in `--work`, so
re-running re-embeds nothing.

| | |
|---|---|
| eligible corpus rows | 56,688 |
| **vectors upserted** | **56,688** |
| eligible rows left unpushed | 0 |
| batches | 227 |
| sustained rate | 26–30 vectors/s |
| wall clock | 34.2 min over 10 rounds |

| | vectorCount |
|---|---|
| before | 1,731,517 |
| after (read immediately) | **1,787,309** |

+55,792 against 56,688 pushed. The 896 shortfall is the known lag —
`vectorize info` reports `processedUpToMutation`, so it reads low right after a
fill and cannot be used to confirm one. Membership was confirmed the way that
does work: a 4,000-id sample of the checkpoint read back through `get_by_ids`
came back **4,000 present, 0 absent**.

---

## 6. Retrieval, through the SERVED path

Not the local pack — the deployed pipeline, which is a different pipeline and
the only one users get. Rerank floor 0.01.

| | kept | top rerank | top hit |
|---|---|---|---|
| EN senolytics clearing senescent cells | 50/50 | 0.9595 | Senolytic targets and new strategies for clearing senescent cells |
| EN epigenetic clock, age acceleration, mortality | 50/50 | 0.9980 | Epigenetic biomarkers of ageing are predictive of mortality risk… |
| EN rapamycin/mTOR extends lifespan in mice | 50/50 | 0.9976 | Rapamycin extends lifespan and delays tumorigenesis in p53+/− mice |
| EN naked mole-rat cancer resistance | 50/50 | 0.9956 | Cancer resistance, high molecular weight hyaluronic acid, and longevity |
| EN late-life mortality deceleration | 45/50 | 0.9678 | Errors as a primary cause of late-life mortality deceleration and plateaus |
| SV kalorirestriktion och livslängd hos möss | 49/50 | 0.8555 | Caloric restriction increases lifespan… in grey mouse lemur primates |
| SV epigenetiska klockor och biologisk ålder | 50/50 | 0.9888 | Epigenetic clock: A promising biomarker and practical tool in aging |
| SV cellulär senescens och inflammation | 50/50 | 0.9775 | Cellular Senescence and Inflammaging in the Skin Microenvironment |
| **control** "best pizza recipe napoletana dough" | **0/50** | 0.0078 | — |

Swedish was typed with its diacritics, deliberately: a probe written
`livslangd` instead of `livslängd` manufactures a language-parity defect that is
not there. The nonsense control sits two orders of magnitude below the floor and
keeps nothing, so the fall-through to Europe PMC is intact.

---

## 7. Timings and cost

| stage | wall clock |
|---|---|
| query design and tier measurement | ~35 min (≈120 esearch calls) |
| enumeration | 2.1 min |
| cross-validation (Europe PMC + authors) | ~5 min |
| index membership scan | 12.5 min |
| harvest | 25.1 min |
| embed + upsert | 34.2 min |
| verification + retrieval probe | ~4 min |
| **total** | **≈2 h** |

Embeddings for 56,688 passages at ~€8/million ≈ **€0.45** one-off. Storage is
the recurring number: ~$10/month per million 1024-d vectors, so this domain adds
about **$0.57/month** and the index as a whole is now ~1.79 M vectors.

---

## 8. Three things this run does NOT license

1. **The delta marker in `docs/PUBMED-RAG.md` §7 does not move.** A named list
   covers no archive file; moving the marker would make the next delta skip
   every file in between.
2. **`docs/CORPORA.md` and the public `/corpora/` page are now stale.** They are
   generated (`node scripts/build-corpora.mjs --only pubmed`) and nothing in the
   test suite fails when they are not regenerated — which is exactly how a
   corpus claim rots in public rather than in CI.
3. **Gold sets that predate this fill should be re-checked.** 56,688 new
   documents change what the relevance floor sees, and any needle that was
   unanswerable because it was absent may now be answerable.

## 9. If the corpus is allowed to grow

In priority order, each a one-line edit in `data/longevity/arms.mjs` followed by
re-running `emit-query.mjs → enumerate.mjs → check-hosted.mjs → harvest → fill`:

1. **MECH** (+41,726 enumerated) — the hallmark mechanism literature. This is
   the block whose absence shows in the Campisi figure above.
2. **g6 progeroid** (+8,618) and **g7 anti-ageing** (+12,400).
3. **DEMO_LE** (+5,468) — life expectancy and life tables; the block whose
   absence shows in the Vaupel figure.
4. **DEMO_REPRO** (+4,016) — reproductive and ovarian ageing.

Tier E — everything — is 101,699 enumerated. At the observed 15.4% prior
coverage that is roughly 86k to fetch and about $1/month more in storage.
