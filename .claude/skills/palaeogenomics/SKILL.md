---
name: palaeogenomics
description: >
  Load when working on the PALAEOGENOMICS agent — the ancient-DNA research
  agent and the two data legs it runs on — or on anything it is built from:
  src/europepmc.js (the life-science literature search source: PubMed / PMC /
  bioRxiv, its AND-semantics query ladder and its DOI-prefix diversity key),
  public/js/aadr-core.js (the ancient-sample query core: the bilingual query
  parser, the geo/date/haplogroup/coverage engine, the rendered block),
  src/aadr.js (the Worker façade + the enrichment), scripts/aadr-build.mjs and
  public/aadr/samples.tsv.json (the committed corpus artifact), the
  `palaeogenomics` entry in sdk/AGENTS.json, or container/palaeo/Dockerfile.
  ALSO load when asked to "add a filter to the sample query", "rebuild the
  ancient-DNA corpus", "why did the sample query return nothing", "make it
  search the genetics literature", "add ADMIXTOOLS / qpAdm / ANGSD", or when
  debugging why a place name, a date window or a haplogroup did not parse.
  ALSO the reference for the JS `\b` Swedish-boundary trap, which was found
  here and affects every bilingual regex gate in the repo (invariant 6).
  For adding a search source in general see **add-research-source**; for the
  agent-spec mechanics see **sdk-mode** and docs/AGENT-PLATFORM.md.
---

# The Palaeogenomics agent

The ancient-DNA agent. Reference documentation is
[`docs/PALAEOGENOMICS.md`](../../../docs/PALAEOGENOMICS.md); this skill is the
working guidance — the traps, the runbooks, and the decisions not to re-argue.

## The shape, in one paragraph

It is **not a new mode and not a new executor.** Its answer phase is the
ordinary `research` one, it is bound to no chat mode, and no row in the
registry's `defaults` table addresses it: a request reaches it by id
(`agent: "palaeogenomics"`). What it adds is one search source
(`src/europepmc.js`, one entry in `src/search-sources.js`) and one pre-pipeline
enrichment (`src/aadr.js`, one entry in `src/enrichment.js`
`CORE_ENRICHMENTS`). Deleting the entry from `sdk/AGENTS.json` removes the whole
capability.

**The enrichment is gated on the agent spec, not on a knob.** `capHasContext(
state.capability, "ancient-samples")` is the whole gate — the first enrichment
switched on by a declared context block rather than by a mode flag or a
setting. If you are adding another domain agent, this is the seam to copy: the
platform cost is one registry entry, one `CONTEXT_BLOCKS` member, one `GATE_IDS`
member and one enrichment row.

**It became the general rule on 2026-08-13.** The owner directive that made the
roster specific moved `capability.context` from declared to EXECUTED, and this
agent's seam is what the rest was built on. Two things follow for this agent
specifically. Its literature leg is now declared too — `literature-pubmed`, on
the spec — and the search-source registry enforces it (`requiresContext` →
`sourceAllowed`). And that declaration is the one explicit PRESERVATION in the
division of the corpora: Deep Science owns arXiv and PubMed outright, and
palaeogenomics keeps the life-science leg because Europe PMC is its only
literature source and the field does not publish on arXiv. It does NOT get
`literature-arxiv`, which is asserted by name in
`src/literature-exclusivity.test.js` along with the evalsets that depend on the
sharing (`tests/evalsets/palaeogenomics.json`, `tests/needles/*-pubmed.json`).

## The rule that governs every edit here: the two legs stay apart

- *"How does ancient DNA degrade over time?"* → **literature**. Europe PMC
  answers it with papers. `ancientSampleIntent` must stay silent.
- *"How many individuals in the corpus carry Y-haplogroup R1b?"* → **corpus**.
  The sample query answers it exactly, with no search wave needed.

A message that straddles both gets a worse answer than either leg alone,
because the corpus block and the citations end up arguing about different
things. `ancientSampleIntent` is therefore about SAMPLES and POPULATIONS, not
about ancient DNA in general — resist widening it toward "anything aDNA."

When you change either gate, add the counter-example to the other module's
tests too. `src/aadr.test.js` pins "is silent on a LITERATURE question in the
same field" for exactly this reason.

## Working on the literature leg (src/europepmc.js)

Europe PMC's query grammar is the **inverse** of arXiv's on every point that
matters, and the ladder is built on measured counts, not on intuition:

| query | hits |
|---|---|
| `ancient DNA mammoth` | 719 |
| `"ancient DNA" mammoth` | 490 |
| `"ancient DNA" AND "mammoth"` | 490 |
| `"ancient DNA" OR "mammoth"` | 13,793 |
| `ABSTRACT:"ancient DNA" AND ABSTRACT:"mammoth"` | 57 |

So: the default operator is AND, quoted phrases work, and adding a term
NARROWS. The ladder climbs by dropping constraints. If you find yourself
writing a rung that adds a term, you have reached for the arXiv model — check
the table again.

Three things that will bite:

- **A rung is accepted on ENOUGH hits, not on any hit.** `sedimentary ancient
  DNA Beringia` matches exactly one abstract; stopping there answers a research
  question from a single paper. `MIN_RUNG_HITS` governs, and a thin rung's find
  is kept while the ladder continues.
- **`resultType=core` is load-bearing.** The lite default carries no abstract,
  no DOI, no citation count and no journal — the four things `toItem` needs.
- **The query must be English even when the question is Swedish.** Probed live:
  `mammutens arvsmassa` returns 0 down the whole ladder; the English equivalent
  returns hundreds. The intent gates are bilingual so a Swedish question REACHES
  the source; `europepmcPromptNote` is what makes arriving there worth
  anything. Do not "fix" the note by dropping the English instruction.

`europepmcDiversityKey` keys `doi.org` URLs on the registrant prefix (10.1038
Nature Portfolio, 10.1101 bioRxiv). Without it every publisher shares one
origin and `sources.js`'s per-origin cap starves the leg to one or two results.

### Verifying a change to this module

```bash
node --test src/europepmc.test.js
node -e "import('./src/europepmc.js').then(async m => {
  const log = { info: console.log, warn: console.warn };
  const r = await m.europepmcSearch({}, log, 'ancient DNA woolly mammoth permafrost');
  console.log(r.items.length, r.items[0]?.title);
})"
```

The live probe is the one that matters — the unit tests mock `fetch`, so they
cannot tell you that a query grammar change returns nothing.

## Working on the sample leg

### The corpus

`public/aadr/samples.tsv.json`: 20,927 published individuals (13,160 ancient,
7,767 present-day reference) from 212 studies, repackaged from the Allen
Ancient DNA Resource through the Poseidon public archives. Per-individual
metadata only — no genotypes.

Rebuild:

```bash
npm run bundle:aadr                 # fetch → build → write
node scripts/aadr-build.mjs --check # rebuild and diff, exit 1 on drift
```

The fetch is one un-paginated ~28 MB response and takes tens of seconds. It is
an occasional, offline, human act reviewed as a diff — not something a request
does. Two reasons: the upstream has no filter grammar to push a query into, and
keeping the corpus local means a structured sample query reaches **no third
party at all**, which is the property the whole design is built around.

The artifact is excluded from the introspection snapshot
(`scripts/bundle-source.mjs` `EXCLUDE`). It is generated data; bundling 2 MB of
tab-separated rows into the snapshot every session reads would be a regression
for a question about how the site works.

### Domain conventions you must not quietly drop

- **`Ignore_`.** AADR and Poseidon prefix the population label of individuals
  that must NOT enter an analysis — contaminated libraries, duplicates, failed
  captures. 383 in this corpus, indistinguishable from ordinary rows. Excluded
  by default, counted in the block, and including them takes an explicit ask.
  Counting them silently is the specific mistake the convention exists to
  prevent.
- **BP is 1950.** `BP_ZERO`. Converting against "now" shifts every Holocene
  date by half a century.
- **Haplogroup prefixes match one way only.** Asking for R1b matches R1b1a1a2a
  (the sample was resolved further than the question). Asking for R1b1a1a2a
  does NOT match a sample called R1b — it was never resolved that far, and
  returning it is a fabricated result, not a near miss.
- **Dates compare as INTERVALS** where the corpus records one. A 5200–4800 BP
  sample answers a 5000 BP question. An individual with no date is *untested*
  against the window, not a miss, and the block reports how many.
- **`isLatest`.** The upstream serves 46,358 rows for 20,927 individuals —
  several package versions each. Dropping the filter triples the corpus with
  duplicates that all look real.

### The entity matcher, and the three bugs that shaped it

All three were invisible against a synthetic fixture and only appeared against
the real corpus. `public/js/aadr-core.test.js` runs half its cases against the
committed artifact for this reason — do not "simplify" that half away.

1. **Place strings are compound.** `Gotland, Västerbjers`; `Samara Oblast,
   Sergiyevsky District, Nizhnaya-Orlyanka Village`. Matching whole strings
   finds nothing, because nobody types the comma-joined form. The index is
   keyed on comma segments AND on the individual words of a compound segment,
   minus the administrative vocabulary (`PLACE_NOISE`: oblast, district,
   valley…).
2. **Substring matching is actively wrong.** `"y-haplogroup r1b".includes(
   "group")` is true, and `group` is a word inside real place strings — so
   "Y-haplogroup R1b" acquired a geographic filter for a place nobody named.
   Lookup is by word n-gram, longest first. Same class of bug on the population
   side: `dated` is a substring of the real label `…possmisdated`, so group
   matching is by SEGMENT equality, never substring.
3. **A single-word place key must be capitalized in the message.** Place
   strings contain ordinary words like `Above`, and `coverage above 1x`
   otherwise resolved "above" as a location — which suppressed the country
   filter and answered a Greenland question about nowhere. Place names are
   proper nouns in both languages, so the rule is one the languages already
   follow. Multi-word keys are exempt.

A token that names both a place and a population ("Samara" is an oblast and the
tail of `Russia_EBA_Yamnaya_Samara`) resolves as the **place** when the message
asked for proximity: ANDing both readings measured 3 hits where the geographic
reading alone measured 124.

### Upstream mojibake

The Poseidon server serves UTF-8 that was already double-encoded upstream —
Västerbjers arrives as `VÃ¤sterbjers`. Verified against the raw server bytes,
so it is not our decoding. `demojibake` in the build script repairs it, and only
when the repair is provably right (the Ã/Â signature is present AND the
re-decode yields no replacement character). Without it every Scandinavian and
Iberian site name is unsearchable in the language it belongs to. If you add a
column to the build, route it through `clean()` so it gets the same repair.

### Adding a filter to the query

Four edits, in this order:

1. the pattern + its parse in `parseSampleQuery` (both languages, see the `\b`
   trap below), pushing a human-readable line onto `query.notes`;
2. the predicate in `querySamples`;
3. tests in `public/js/aadr-core.test.js` — the synthetic fixture for the
   semantics, the committed artifact for anything the real data can contradict;
4. the counter in `src/aadr.js`'s `state.aadr`, if a `chat_logs` reader would
   need it to tell "the query was wrong" from "the corpus has nothing".

If the filter needs a new column, bump `layout` in both the build script and
`SAMPLES_LAYOUT` — the core refuses an unknown layout rather than reading
shifted fields — and rebuild the artifact.

## The `\b` trap (applies far beyond this agent)

JavaScript's `\b` is defined over `[A-Za-z0-9_]` only. `å ä ö` are not word
characters to it, so:

```js
/\böversikt/.test(" översikt")        // false — always
/(?<!\p{L})översikt/u.test(" översikt") // true
```

Every Swedish alternative that begins or ends with an accented letter is dead
inside a `\b(…)\b` group, and `\w*` as a Swedish suffix wildcard stops at the
first accented letter (`denisova\w*` cannot match "denisovamänniskan"). It
fails **silently**: the English half of the same gate keeps matching, so the
gate looks alive while the Swedish half of invariant 6 is inert, and an
English-only test suite passes.

Both modules here use `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])` with the `u`
flag and `[\p{L}]*` as the suffix wildcard, with tests that fail if `\b`
returns. **Other bilingual gates in the repo have not been audited for this.**
If you touch one, check it: `grep -nP '\\b\([^)]*[åäöÅÄÖ]' src/*.js public/js/*.js`
is a decent first pass.

## The container variant

`container/palaeo/Dockerfile` carries the analysis the corpus query
deliberately refuses to fake: samtools/bcftools/tabix/bedtools/vcftools,
mapDamage (deamination authentication — the check that says whether a read is
ancient at all), PLINK 1.9 (which reads the `.bed/.bim/.fam` trio the Poseidon
packages ship), MAFFT / FastTree / IQ-TREE / RAxML, BLAST+/HMMER/EMBOSS,
Biopython and the scientific Python stack, R with `ape`.

**It is not deployed, and it is an either/or with the base image.**
`wrangler.toml` binds one image to the `ExecSandbox` class and there is no
per-request selection. Supporting both needs a second Durable Object class with
its own `[[containers]]` block and a backend id the DREE/1 layer can select —
a change to the execution seam, not a Dockerfile. See
`docs/EXECUTION-ENVIRONMENTS.md` and the **execution-sandbox** skill.

**ADMIXTOOLS (qpAdm, qpGraph, f3/f4) and ANGSD are not packaged for Debian.**
They are what an ancestry question actually wants, and they are deliberately
absent rather than silently missing: installing them means building from source
against a pinned upstream commit, with network at build time. So the image
supports data handling, damage authentication, alignment and phylogenetics, and
does NOT support population-genetic inference.

> Verifying a Debian package exists needs care. `packages.debian.org` answers
> **200 with an error PAGE** for a package that does not exist, so a
> status-code probe reports every name as present — including an invented
> control. Grep the body for the error marker.

## Standing declines — settled, do not re-argue

- **A geocoder for "near X".** Places resolve against the corpus's own
  dictionaries (the centroid of samples recorded there). That is what keeps a
  structured sample query free of any outbound request. The cost is bounded and
  stated: a place with no published samples cannot anchor a radius, and the
  block says exactly that rather than dropping the radius and returning a set
  that looks like an answer.
- **Registering the corpus as a search source.** A row is an individual, not a
  URL. Registering it would mean minting a plausible-looking link per row, and
  the point of answering from a table is that nothing is invented.
- **A live Poseidon call per turn.** 28 MB, no filter grammar, and it would
  leak the shape of every query to a third party.
- **Ancestry inference in the core.** It filters and counts. f-statistics,
  qpAdm and PCA belong in the sandbox against real genotype files, and the
  block says so in words so an answer cannot imply otherwise.
- **Making it a chat mode.** The domain is narrow and the platform is not.
  Reachable by id is the whole point.

## Where everything lives

| Piece | Where |
|---|---|
| Agent spec | `sdk/AGENTS.json` → `palaeogenomics` |
| Context block / gate vocabulary | `public/js/agent-spec-core.js` → `CONTEXT_BLOCKS["ancient-samples"]` and `CONTEXT_BLOCKS["literature-pubmed"]` (both serverOnly), `GATE_IDS["ancient-sample"]` |
| Corpus ownership guard | `src/literature-exclusivity.test.js` — pins `literature-pubmed` shared with Deep Science, and `literature-arxiv` withheld |
| Capability reader | `capHasContext` (façade `src/agent-spec.js`) |
| Enrichment registration | `src/enrichment.js` → `CORE_ENRICHMENTS` entry `aadr` |
| Search source registration | `src/search-sources.js` → entry `europepmc` |
| Starter prompts | `public/js/starters-data.js` → `queues.palaeogenomics` (xp 218–239) |
| Corpus artifact | `public/aadr/samples.tsv.json`, built by `scripts/aadr-build.mjs` |
| Container variant | `container/palaeo/Dockerfile` |
| Reference doc | `docs/PALAEOGENOMICS.md` |
