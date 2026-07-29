# Palaeogenomics

The ancient-DNA research agent, and the two data legs it runs on. Shipped
2026-07-29.

## 1. What it is

`palaeogenomics` is an agent in `sdk/AGENTS.json` — data, not code. It derives
from `research`, runs the ordinary deep-research pipeline, and is reached by id
on the `/api/chat` request (`agent: "palaeogenomics"`). It is bound to no chat
mode, has no settings knob and no request flag, and no row in the registry's
`defaults` table addresses it. Deleting its entry from `sdk/AGENTS.json` removes
the whole capability.

That reachability is the point. The domain is narrow; the platform is not. The
agent adds two source legs and one context block, and touches nothing that a
Deep Research turn, an Introspection turn or an Agent Studio build can see.

Se/rver tier only. Its context block is marked `serverOnly` in the capability
vocabulary, so `validateCapability` refuses it to a client-tier agent rather
than leaving it to convention.

## 2. Why ancient genetics needed its own agent

Two gaps, one per leg.

**The literature was invisible.** The pipeline's auxiliary search sources were
the Hugging Face Hub and arXiv. Palaeogenomics publishes in Nature, Cell,
Current Biology, PNAS and on bioRxiv — none of which are on arXiv. A question
about mammoth genomes reached the generic web leg and answered from press
coverage of papers rather than from the papers.

**The samples were being recalled rather than looked up.** Ask any model how
many published ancient individuals carry Y-haplogroup R1b, or which ones lie
near a given site in a given millennium, and it will produce sample ids that
look exactly right and do not exist. The information is public, structured and
small enough to ship; there was no reason to guess at it.

## 3. The literature leg — Europe PMC

`src/europepmc.js`, registered in `src/search-sources.js`. One free key-less
REST API over PubMed/MEDLINE, PubMed Central, and bioRxiv/medRxiv preprints:
one request reaches both the peer-reviewed record and the preprint frontier,
where the NCBI E-utilities need a separate round-trip per database.

### 3.1 The query grammar is the inverse of arXiv's

Measured live, 2026-07-29, same three concepts:

| query | hits |
|---|---|
| `ancient DNA mammoth` (bare terms) | 719 |
| `"ancient DNA" mammoth` | 490 |
| `"ancient DNA" AND "mammoth"` | 490 |
| `"ancient DNA" OR "mammoth"` | 13,793 |
| `ABSTRACT:"ancient DNA" AND ABSTRACT:"mammoth"` | 57 |

Three facts follow, and each one inverts a rule that holds for arXiv:

1. **The default operator is AND.** The quoted form and the explicit AND form
   return identical counts. On arXiv, unquoted spaces inside a field mean OR and
   adding a word widens the result set. Here adding a word narrows it, so the
   ladder climbs by **dropping** constraints, not by adding them.
2. **Quoted phrases work.** On arXiv, `all:"multi word phrase"` returns zero,
   always. Quoting costs 32% of the recall here and buys phrase precision.
3. **`ABSTRACT:`-restriction is too narrow to lead with** — an 88% cut, because
   a paper whose abstract never spells out one concept is still the paper you
   wanted. It is the first rung only for queries with enough concepts to survive
   it, and the ladder falls through.

The ladder therefore runs: abstract-restricted → quoted phrases over the whole
record → fewer concepts → unquoted terms. A rung is accepted only once the
search has produced enough distinct records; a rung that matched a single paper
does not end the wave, and its find is kept while the next rung runs. Probed
live, `sedimentary ancient DNA Beringia` matches one abstract and a literature.

Each search is two fetches — `sort=CITED desc` (the literature that settled the
question) and `sort=P_PDATE_D desc` (what has changed since) — interleaved and
de-duplicated. `resultType=core` is what carries the abstract, DOI, citation
count and journal; the lite default carries none of them.

### 3.2 Diversity keying

Hits are DOI URLs. Without a platform key every publisher on earth shares the
single origin `doi.org` and the pipeline's per-origin cap starves the leg to one
or two results. `europepmcDiversityKey` keys on the **registrant prefix**, which
is the publisher — 10.1038 Nature Portfolio, 10.1016 Elsevier, 10.1101 Cold
Spring Harbor/bioRxiv. Ten hits from Nature still get capped; a genuine spread
of publishers survives.

### 3.3 Bilingual intent, English queries

The intent gates take Swedish at the same breadth as English (invariant 6). The
QUERY does not: probed live, `mammutens arvsmassa` returns 0 down the whole
ladder while its English equivalent returns hundreds, because Europe PMC indexes
titles and abstracts as published and this literature publishes in English. The
prompt note therefore instructs the planner to phrase Europe PMC queries in
English even when the conversation is Swedish. The bilingual gate is what gets a
Swedish question to the source; translating the query is what makes arriving
there worth anything.

## 4. The sample leg — the ancient-sample corpus

`public/js/aadr-core.js` (pure), `src/aadr.js` (Worker façade),
`scripts/aadr-build.mjs` (the builder), `public/aadr/samples.tsv.json` (the
committed artifact).

### 4.1 What is in it

20,927 published individuals from 212 studies — 13,160 ancient and 7,767
present-day reference individuals — repackaged from the Allen Ancient DNA
Resource through the Poseidon public archives. Per individual: sample id,
population label, country, location, coordinates, date (start/median/stop in
BC/AD plus uncalibrated ¹⁴C where recorded), date type, mtDNA and Y haplogroup,
genetic sex, SNPs covered, coverage, package and publication key.

Metadata only. Genotypes stay upstream, where they are gigabytes and licensed
and where no research turn needs them.

### 4.2 Why an artifact and not a live API

The Poseidon server answers `/individuals` with every individual it hosts in one
un-paginated response — 28 MB with the columns this needs — and offers no filter
grammar on the wire: no bounding box, no date window, no haplogroup prefix. A
live tier would fetch the whole corpus per turn to answer one question.

It is also the privacy posture. With the corpus in the deploy, a structured
sample query reaches no third party at all: the question never leaves the
Worker, and Poseidon never learns that anyone asked. Rebuilding is an explicit,
occasional, offline act, reviewed as a diff:

```bash
node scripts/aadr-build.mjs           # fetch → build → write
node scripts/aadr-build.mjs --check   # rebuild and diff, exit 1 on drift
```

The artifact is excluded from the introspection source snapshot
(`scripts/bundle-source.mjs`): it is generated data, and bundling 2 MB of
tab-separated rows into the snapshot every session reads would be a regression
for a question about how the site works.

### 4.3 What the query understands

Parsed deterministically from the message, EN and SV alike:

- **Geography** — `within 200 km of X`, `near X`, `inom 20 mil från X`. Swedish
  `mil` is 10 km; reading `20 mil` as 20 km returns an empty set that looks like
  a finding.
- **Time** — `5000–4000 BP`, `between 3000 and 1000 BC`, `mellan 5000 och 4000
  f.Kr.`, `äldre än 3000 år`, `omkring 4000 f.Kr.`. BP converts against 1950,
  the radiocarbon convention; using "now" would shift every Holocene date by
  half a century. An unstated era means BP, which is how the field states a date.
- **Haplogroups** — `Y-haplogroup R1b`, `mtDNA haplogroup U5`, or an unqualified
  `haplogroup R1b`, which is matched against **either** tree because R is a
  valid label on both and guessing is worse than searching both.
- **Quality and demography** — a coverage floor, genetic sex, and whether
  present-day reference individuals are wanted (they are excluded by default;
  they are a third of the corpus and would otherwise dominate any undated query).

Matching rules that matter:

- A date is compared as an **interval** where the corpus records one — a
  5200–4800 BP sample answers a 5000 BP question — and as a point where only a
  median exists. An individual with no date at all is counted as *untested*
  against the window, not as a miss, and the block says how many.
- A haplogroup is a **one-way prefix** match. Asking for R1b matches R1b1a1a2a,
  because the sample was resolved further than the question. Asking for
  R1b1a1a2a does **not** match a sample called R1b: it was never resolved that
  far, and returning it is a fabricated result rather than a near miss.

### 4.4 The Ignore_ convention

AADR, and Poseidon after it, marks individuals that must not enter an analysis
by prefixing their population label with `Ignore_` — contaminated libraries,
duplicates, failed captures. There are 383 in this corpus and they look exactly
like ordinary rows. Counting them is not a rounding error; it is the specific
mistake the convention exists to prevent. They are excluded by default, the
count is reported in the block, and including them takes an explicit ask.

### 4.5 No geocoder

"Near Uppsala" is resolved against the corpus's **own** place and country
dictionaries — the centroid of the samples already recorded there. No Nominatim,
no Google, no outbound request. The cost is honest and bounded: a place with no
published samples cannot anchor a radius, and the block says exactly that rather
than dropping the radius and returning a set that looks like an answer.

Three matching bugs shaped this resolver, all of them found against the real
corpus and none of which a synthetic fixture would have caught:

- Place strings are compound (`Gotland, Västerbjers`; `Samara Oblast,
  Sergiyevsky District, Nizhnaya-Orlyanka Village`). Matching whole strings finds
  nothing — nobody types the comma-joined form — so the index is keyed on
  comma-separated segments and on the individual words of a compound segment,
  minus the administrative vocabulary (`oblast`, `district`, `valley`).
- Dictionary entries were originally tested as substrings of the message. The
  word `group` appears inside real place strings, and
  `"y-haplogroup r1b".includes("group")` is true, so "Y-haplogroup R1b" acquired
  a geographic filter for a place nobody named. Lookup is now by word n-gram,
  longest first.
- A single-word place key must be **capitalized** in the message. Place strings
  contain ordinary words like `Above`, and `coverage above 1x` otherwise
  resolved "above" as a location — which suppressed the country filter and
  answered a Greenland question about nowhere. Place names are proper nouns in
  both languages, so the rule is one the languages already follow.

A token that names both a place and a population label ("Samara" is an oblast
and the tail of `Russia_EBA_Yamnaya_Samara`) resolves as the **place** when the
message asked for proximity. ANDing both readings measured 3 hits where the
geographic reading alone measured 124.

### 4.6 Upstream mojibake

The Poseidon server serves UTF-8 that was already double-encoded upstream:
Västerbjers arrives as `VÃ¤sterbjers`. Verified against the raw server bytes,
so it is not this pipeline's decoding. The build repairs it — re-read the
characters as Latin-1 bytes, decode as UTF-8, and only when the result contains
no replacement character. Without the repair every Scandinavian and Iberian site
name in the corpus is unsearchable in the language it belongs to.

## 5. How the two legs stay apart

The split is the editorial rule of the whole agent, and it is enforced by two
separate intent gates:

- *"How does ancient DNA degrade over time?"* is a **literature** question.
  Europe PMC answers it with papers. The sample gate stays silent.
- *"How many individuals in the corpus carry Y-haplogroup R1b?"* is a
  **structured** question. The corpus answers it exactly. It reaches the
  literature leg only if the message also asks something the literature holds.

`ancientSampleIntent` is deliberately about samples and populations rather than
about ancient DNA in general. A question that straddles both gets a worse answer
than either leg alone, because the corpus block and the citations end up
arguing about different things.

## 6. What it does not do

The corpus query **filters and counts**. It does not run f-statistics, qpAdm,
PCA or any ancestry inference, and the block it appends says so in words, so an
answer built on it cannot imply otherwise.

That refusal is deliberate, and the analysis it refuses is real work. It belongs
in the execution sandbox against real genotype files, which is what
`container/palaeo/Dockerfile` is for: a variant of the server-side execution
image carrying samtools/bcftools/tabix/bedtools/vcftools, mapDamage (deamination
authentication — the check that says whether a read is ancient at all), PLINK
1.9 (which reads the `.bed/.bim/.fam` trio the Poseidon packages ship), MAFFT /
FastTree / IQ-TREE / RAxML, BLAST+/HMMER/EMBOSS, Biopython and the scientific
Python stack, and R with `ape`.

Two absences in that image matter more than the contents: **ADMIXTOOLS** (qpAdm,
qpGraph, f3/f4) and **ANGSD** (genotype likelihoods for low-coverage data) are
not packaged for Debian. They are the tools an ancestry question actually wants,
and installing them means building from source against a pinned upstream — a
deliberate follow-up, not a silent addition. So the image supports data
handling, damage authentication, alignment and phylogenetics, and does not
support population-genetic inference.

The image is **not deployed**. `wrangler.toml` binds one image to the
`ExecSandbox` class and there is no per-request image selection, so the variant
is an either/or with the base image today; supporting both needs a second
Durable Object class and a backend id the DREE/1 layer can select, which is a
change to the execution seam rather than a Dockerfile. See
`docs/EXECUTION-ENVIRONMENTS.md`.

## 7. Wiring

| Piece | Where |
|---|---|
| Agent spec | `sdk/AGENTS.json` → `palaeogenomics` |
| Context block vocabulary | `public/js/agent-spec-core.js` → `CONTEXT_BLOCKS["ancient-samples"]` (serverOnly) |
| Gate vocabulary | `public/js/agent-spec-core.js` → `GATE_IDS["ancient-sample"]` |
| Capability reader | `capHasContext` (`public/js/agent-spec-core.js`, façade `src/agent-spec.js`) |
| Enrichment registration | `src/enrichment.js` → `CORE_ENRICHMENTS` entry `aadr` |
| Search source registration | `src/search-sources.js` → entry `europepmc` |
| Starter prompts | `public/js/starters-data.js` → `queues.palaeogenomics` |
| Corpus artifact | `public/aadr/samples.tsv.json` (built; excluded from the source snapshot) |
| Container variant | `container/palaeo/Dockerfile` (buildable, not deployed) |

The `aadr` enrichment is the first one gated on an agent's declared context
block rather than on a mode flag or a knob. That is the seam worth reusing: a
domain capability that costs the platform one registry entry, one vocabulary
member and nothing else.

## 8. Sources this does not yet reach

Named here so a later change knows what was considered and left out.

**ENA / NCBI E-utilities** — the raw sequencing archives, where every study's
reads are deposited. Worth adding as a source that resolves a paper or an
accession to its actual runs and samples. Not indexable: raw reads are
terabyte-scale, so a source would carry metadata only.

**Dating and palaeoecology** — XRONOS (radiocarbon aggregator with an API),
Neotoma (fossil pollen and vertebrate occurrences), PBDB. These supply the
environmental context a palaeogenomic claim sits in.

**Function and structure** — Ensembl VEP, UniProt, AlphaFold DB: the path from a
species-specific substitution to a structural claim.

**Ancient proteins** — PRIDE, for the enamel-proteome work that reaches further
back than DNA.

**Human aDNA governance** — not a source but a constraint. Human ancient DNA
touches descendant-community governance (the CARE principles) in a way
non-human palaeogenomics does not. The corpus already carries human individuals
and the agent answers questions about them; a future surface that publishes or
redistributes rows should treat that as a live question rather than a settled
one.
