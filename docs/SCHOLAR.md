# Deep Science — Google Scholar and the peer-reviewed record

The **Deep Science** agent (`scholar` in `sdk/AGENTS.json`) answers from the
peer-reviewed literature, checked against the open record. The peer-reviewed
leg **leads** every turn and is absorbed first, so the reviewed record takes the
first numbered sources; the web leg runs behind it, and only when the reader's
web-search knob is on (§4a — added 2026-08-14, before which no web search ran at
all). On an ordinary turn no preprint reaches an answer; the one exception,
added 2026-08-13, is a reader who names the preprint record outright, and
everything it returns is labelled a preprint (§4). Retracted papers are the
mirror case, added the same day as the web leg: dropped on sight by default,
admitted and labelled `RETRACTED` when the question is about retraction (§4b).

**It is the default agent** (owner directive, 2026-08-13). The general
`research` agent and its `normal` mode were retired, and `science` took the
terminal-fallback slot in both the mode resolver and the agent resolver — so a
request that names no mode is answered by this one. It is also the **exclusive
owner of arXiv and PubMed** across the platform (§4).

Modules: `src/scholar.js` (the search source), `src/scholar-metrics.js` (the
enrichment), `src/scholar-venues.js` (the metrics table),
`scripts/scholar-venues.mjs` (the harvest).

## 1. Google Scholar has no API

There is no Google Scholar API. There never has been one, Scholar is not a
Google Cloud product, and the Maps and OAuth credentials this deployment already
holds buy nothing here.

What Scholar does publish is a `robots.txt`, and it splits the service in two:

```
User-agent: *
Disallow: /scholar                            ← the search results
Disallow: /citations?
Allow:    /citations?user=                    ← author profiles
Allow:    /citations?view_op=top_venues       ← publication metrics
Allow:    /citations?view_op=list_classic_articles
```

Read 2026-07-31. The split decides the design.

### The search index is off limits

`/scholar` is disallowed, and Google enforces it. A plain request from this
container returns `403 Forbidden` — the robot page. The only thing that gets
past it is forging a browser `User-Agent`, which is precisely the thing
`robots.txt` asked us not to do. Cloudflare's egress addresses are shared and
already rate-limited by Google, so a scraper here would also be a scraper that
stops working within days.

**We do not scrape it.** If a future change proposes "just a small parser" for
`/scholar`, that is the change the header comment in `src/scholar.js` exists to
prevent.

### The profile and metrics pages are used, fully

Both allowed surfaces are integrated:

| Surface | Where | When it runs | Outbound request |
|---|---|---|---|
| Author profile — name, affiliation, verified email domain, h-index, i10-index, total citations, the 20 most-cited works with their own counts | `src/scholar-metrics.js` `fetchProfile` | only when the message carries a profile link or an explicit Scholar id | one GET to `citations?user=<id>` |
| Publication metrics — 4,652 venues with h5-index and h5-median across Scholar's eight subject categories and their subcategories | `src/scholar-venues.js` reading `public/scholar/venues.json` | venue questions, and every citation's provenance line | **none** — build artifact |

`citations?view_op=search_authors` is *not* in the allow list, so there is no
permitted way to look an author up by name, and the code does not try. The
profile leg fires only when the message already carries the link — which is how
someone actually asks.

The venue table is harvested offline (`node scripts/scholar-venues.mjs --deep`,
~15 min at one page per 2.5 s) and committed. That is not only a caching
decision: a live lookup would tell Google, for every research question anyone
asks here, which journals the answer is about. The privacy rule (invariant 4) is
that outbound requests carry the minimum, and the minimum here is zero.

### The search leg

Three honest routes, and the agent runs whichever are configured:

1. **A licensed Google Scholar search API** — SerpApi's `google_scholar` engine
   runs the query under its own contract. This is the only supported route to
   Scholar's actual ranking. Gated on `SERPAPI_KEY`; off when unset.
2. **The open corpus Scholar indexes** — OpenAlex and Europe PMC cover
   substantially the same literature and publish something Scholar does not:
   machine-readable venue type, work type and retraction status.
3. **Crossref** — authoritative for "is this DOI a journal article", useless for
   discovery (§3).
4. **This project's own hosted PubMed index** (`docs/PUBMED-RAG.md`) — a frozen
   slice of PubMed embedded into Vectorize and searched by *meaning*. It takes
   the prose question rather than the extracted keyword terms, and it sends no
   outbound request at all: the query is embedded and matched inside this
   account's own index. Gated on the `PUBMED_INDEX` binding; off when unbound.

With no keys at all the agent still works: Europe PMC's peer-reviewed slice
needs none.

**Added 2026-08-12, and worth saying why it was missing.** The Deep Science
agent narrows every request to this one source (`state.auxOnly`, set in
`src/scholar-metrics.js`), and the hosted corpora were wired only into the two
sources that narrowing excludes — `src/europepmc.js` for PubMed and
`src/arxiv.js` for arXiv. The site's own knowledge base was therefore
structurally unreachable from the agent whose whole subject it is. It surfaced
in a video review: capture CAP-20 asked, in Swedish, what the peer-reviewed
literature says about intermittent fasting and insulin sensitivity, got twelve
good on-topic peer-reviewed citations, and not one of them came from the hosted
corpus, because no code path existed to reach it (`chat_logs` #1703).

## 2. What counts as peer-reviewed

The filter admits a record when a backend says something that *entails* peer
review. It never admits one for lack of evidence to the contrary.

| Backend | Admitted when |
|---|---|
| OpenAlex | `type` ∈ {article, review}, primary location's source is a `journal`, not retracted, has an ISSN |
| Europe PMC | `source` ∈ {MED, PMC, AGR, CBA} — never `PPR`, which is bioRxiv/medRxiv — and a journal title is present |
| Semantic Scholar | `publicationTypes` names JournalArticle or Review, plus a journal name and a DOI |
| Crossref | `type` is `journal-article` and an ISSN is registered |
| Hosted PubMed | a journal title is present, that journal is not one of the preprint servers PubMed itself indexes, and the title does not announce a retraction |
| **Google Scholar** | **never on its own** |

That last row is the load-bearing one. A Scholar result carries no peer-review
signal at all — Scholar indexes preprints, theses, slide decks, working papers
and predatory journals beside *Nature*, and its result JSON does not distinguish
them. So a Scholar hit is admitted only by being **merged** onto a record from
one of the evidence-bearing backends above, by DOI or normalized title. What it
contributes is its ranking and its citation count; the verdict always comes from
a source that publishes one.

The hosted-PubMed row is the *weakest* of the evidence-bearing ones, and the
provenance line on every citation says which row it rests on. The reason is that
the index stores no publication-type field — `types` is parsed at harvest and
dropped before the vector metadata (`docs/PUBMED-RAG.md` §8) — so Europe PMC's
`MED`-not-`PPR` distinction has to be reconstructed from the journal name. Every
record in the index is a PubMed citation, i.e. Europe PMC's `MED` source; the
only PubMed records that are *not* the peer-reviewed record are the NIH Preprint
Pilot ones, and those name their server in the journal field. That exclusion is
not theoretical: bioRxiv is the second most common journal in the corpus, 18,880
records. Retraction is handled the same way — no flag is stored, so a title
written as a notice (`Retracted: …`, `Withdrawn: …`, `Expression of Concern: …`)
is rejected, with the trailing colon distinguishing a notice from a paper *about*
retraction.

The consequence is worth stating plainly rather than hiding:

> "Answered exclusively from Google Scholar" and "answered exclusively from
> peer-reviewed research" are **different requests**. Where they conflict, this
> agent obeys the second.

A second limit, which the answer prompt is expected to respect: a peer-reviewed
source is a *reviewed* source, not a correct one. Retractions are excluded and
h5-index is reported, but neither makes a finding true.

## 3. Measured behaviour

Everything below was established with `curl` on 2026-07-31 and is what the code
is shaped around. Re-probe before changing any of it.

### OpenAlex query grammar

Hit counts under `type:article|review, source.type:journal, is_retracted:false`:

| Query | Hits |
|---|---|
| `ancient DNA mammoth` | 2,256 |
| `"ancient DNA" mammoth` | 1,393 |
| `ancient DNA mammoth genome permafrost preservation` | 271 |
| `does vitamin D supplementation reduce respiratory infection risk` | 35,424 |

- **Adding terms narrows** — as with Europe PMC, unlike arXiv. The fallback
  ladder therefore climbs by *dropping* terms.
- **Do not quote phrases.** Quoting costs 38% of the recall *and* made the top
  hit worse: the specific mammoth paper was replaced by a generic "Genetic
  Analyses from Ancient DNA". This is the opposite of Europe PMC's advice. Two
  sibling APIs, opposite rules — neither is guessed at.
- **Natural-language questions work.** A full sentence returned the definitive
  BMJ meta-analysis at rank 1.

### OpenAlex rate limiting

OpenAlex meters a small free **daily budget** per caller:

```
HTTP 429 {"error":"Rate limit exceeded",
          "message":"Insufficient budget. This request costs $0.001
                     but you only have $0 remaining. Resets at midnight UTC.",
          "costUsd":0.001,"dailyRemainingUsd":0}
```

This container exhausted it in roughly 25 requests. On Cloudflare's shared
egress that budget is effectively always spent, so `OPENALEX_API_KEY` is what
makes the widest backend real in production. Unkeyed it still works when budget
allows, and its 429 is just another empty result.

### Crossref is a registry, not a search engine

Same query, `filter=type:journal-article`:

- Default relevance / `sort=score` → rank 1 is a 2025 paper with **zero**
  citations in an obscure venue; the seminal papers are nowhere.
- `sort=is-referenced-by-count` → rank 1 is **lme4**, a statistics package,
  because "effects" matched "Linear Mixed-Effects".

So Crossref only ever verifies a candidate another backend found. Its
`query.bibliographic` carries one more trap: asked for the exact title of the
Doench 2016 paper it returns a *Faculty Opinions recommendation of* that paper —
a `dataset` record with a near-identical title. Title verification therefore
requires a normalized-title **equality** check *and* a type check, or
"verification" swaps the paper for a review of the paper.

### Never sort a literature by citations

The first build fetched Europe PMC with `sort=CITED desc` and then ranked
everything on citation count. A live probe showed what that produces:

| Question | What it answered with |
|---|---|
| vitamin D supplementation acute respiratory infection | the 2015 American Thyroid Association guidelines; the PRISMA reporting statement (13,196 citations) |
| CRISPR off-target effects | DESeq2 (78,136 citations); limma (32,420) |

Every one of those is a real, heavily peer-reviewed paper. None of them is
about the question. Citation counts across a whole literature are dominated by
methods papers and reporting standards that everybody cites and nobody was
asking about — the same failure Crossref's `sort=is-referenced-by-count`
produces, and both times it took this shape.

Two changes, both needed:

1. **Retrieve by relevance.** Europe PMC's default sort *is* relevance; the
   `sort=` parameter was the bug. OpenAlex, Semantic Scholar and Scholar all
   default to relevance already.
2. **Rank by relevance first.** Every record carries the backend's own
   retrieval position (`rank`), and `rankRecords` weights it at 0.5 per
   position against a log-damped citation term worth at most ~2.4. Citations
   therefore decide between comparably relevant papers and nothing more.

After the fix, the same two questions lead with the BMJ meta-analysis
(Martineau 2017) and with Doench 2016 / Fu 2013 respectively.

### Europe PMC is biomed-strong and cross-domain-weak

`… AND (SRC:MED OR SRC:PMC) NOT SRC:PPR` gives a clean peer-reviewed slice, and
inside the life sciences it is excellent. Probed with `quantum error correction
surface code` it returns biomed-adjacent papers and preprints; with `minimum
wage employment effects` it returns public-health journals. That asymmetry is
why it is one backend and not the only one.

### SerpApi fails with HTTP 200

An unkeyed request answers `200` with `{"error": "Invalid API key…"}`. A status
check alone reads an auth failure as an empty result set, so the client checks
the body.

## 4. How the restriction is enforced

Three declarations, not a sentence in a prompt:

| Mechanism | Where | Effect |
|---|---|---|
| `capability.search.web: true` (was `false` until 2026-08-14) | `sdk/AGENTS.json` | the reader's knob decides whether the Exa leg runs; `capSearch` still composes by **narrowing in both directions**, so knob-off is final |
| `state.webAfterAux = true` | `src/scholar-metrics.js` | the web leg is **absorbed after** the literature, so the reviewed record is numbered first |
| `state.webSourceNote = WEB_SOURCE_NOTE` | same | every web source enters the digest stamped "NOT peer-reviewed" and told what it is for |
| `state.forceAux = ["scholar"]` | `src/scholar-metrics.js` | the peer-reviewed source runs every turn, whatever the message says |
| `state.auxOnly = ["scholar", …preprintSources(asked)]` | same | **no other auxiliary source may run** — without it, arXiv would still fire on a physics question and hand the agent preprints |

`state.auxOnly` is new (2026-07-31) and generic: `pipeline.js` reads ids off the
state and names no source, so any future agent needing the same restriction gets
it for free. It is purely *narrowing* — it can only remove sources — which keeps
the safety argument for user-authorable specs intact.

Until 2026-08-14 the agent's control set had **no web-search toggle**, because
with `web: false` a toggle could only ever be a no-op that implied otherwise.
That reasoning ran the other way once the declaration became `true`: see §4a.

### The corpora belong to this agent (2026-08-13)

The same directive that retired the general agent divided the scientific
corpora among the agents built on them, and Deep Science got all of them. Three
new context blocks say so, and `sdk/AGENTS.json` declares them on this spec:

| Block | Reaches | Also declared by |
|---|---|---|
| `literature-peer-reviewed` | the merged peer-reviewed leg (`src/scholar.js`) | nobody |
| `literature-arxiv` | the hosted arXiv index, falling back to the live arXiv API (`src/arxiv.js`) | nobody |
| `literature-pubmed` | the hosted PubMed index, falling back to Europe PMC (`src/europepmc.js`) | `palaeogenomics` |

The enforcement is the search-source registry's `requiresContext` field
(`src/search-sources.js`), read generically by `sourceAllowed` in
`src/pipeline.js`: a source naming a block runs only for an agent whose
capability declares it. Palaeogenomics keeping `literature-pubmed` is the one
explicit, justified preservation — Europe PMC is that agent's only literature
leg, and the ancient-DNA field publishes in journals and on bioRxiv, not on
arXiv. Handing a corpus to a different agent is now a one-line spec diff.

A **null** capability keeps every source, because it means *no agent was
resolved* rather than *an agent declared nothing*: that is a `POST /mcp` call
naming no agent (the channel resolves one only when `deep_research`'s `agent`
argument asks for it, `resolveMcpAgent`), and it is deliberate — the
ground-truth batteries (`tests/dr-eval.mjs`, `tests/needles/*`) reach both
corpora through that door.

### The one widening: name the preprint record and get it

Owning a corpus you can never consult is owning nothing, so `preprintSources`
(`src/scholar-metrics.js`) admits arXiv or Europe PMC to `auxOnly` when — and
only when — the message **names** the preprint record:

```
"any arxiv preprints on diffusion transformers"  → + arxiv
"vad säger förhandstrycken om …"                 → + arxiv
"search pubmed for statin adherence trials"      → + europepmc
```

The gates are the sources' own NAMED tiers (`arxivNamedIntent`,
`europepmcNamedIntent`), not their wide `intent` gates — those fire on any
research phrasing over a scientific topic, which is most of what this agent is
ever asked, and widening on them would turn "peer-reviewed only" into
"peer-reviewed plus whatever matched". Reusing the sources' own vocabulary also
keeps invariant 6 without a third bilingual word list.

Everything the preprint leg returns is **labelled** in the context the model
reads: arXiv's item mapper leads its metadata line with "Preprint, not
peer-reviewed" (`src/arxiv.js` and `src/arxiv-rag.js`), and Europe PMC has
always annotated its PPR records the same way. So an answer cannot present a
preprint as reviewed work even when the reader asked for both. The default turn
is byte-identical to what it was before the widening existed.

## 4a. The web leg: second, and labelled (2026-08-14)

Reported as **feedback #69** (`chat_logs` #1747):

> deep science needs web search as well but should start with research sources
> and then validate with help from web search

The question behind it was *"What did the retracted papers on beta-amyloid and
Alzheimer's actually claim, and how much of the later literature was built on
them?"* It came back with eight on-topic but unrelated amyloid papers and an
admission, in the answer's own first line, that none of them mentioned a
retraction. Two separate mechanisms had to fail for that, and both are fixed
here: the web leg was off (this section) and the retracted record was
unreachable (§4b).

The point the report makes is that a retraction notice, a misconduct
investigation and a citation analysis are **reporting, not findings**. They live
in the open record by nature. An agent that can only read the reviewed record
cannot answer a question about that record's own failures — which is the one
question where refusing to look outside is least defensible.

**What changed.** `capability.search.web` is now `true`, so the reader's
web-search knob decides, as it does for every other agent. Two per-request
declarations then shape what the leg is *for*:

| Declaration | Read by | Effect |
|---|---|---|
| `state.webAfterAux = true` | `runSearches` (`src/pipeline.js`) | the web results are **absorbed after** the literature's |
| `state.webSourceNote` | `labelWebItems` (same) | each web source enters the digest with the caveat as its first highlight |

**Ordering is a property of absorption, not of dispatch.** Both legs are still
dispatched together — `startWebLeg` was split out of `runWebLeg` for exactly
this, mirroring `startAuxSearches` — because absorption is what fixes a source's
number, and buying the ordering with serial latency would re-open feedback #44
("the arXiv searches took close to a minute") to close #69. The reviewed record
therefore occupies `[1..n]` and the web follows it, at no cost in wall clock.

Both fields are read **generically**: `pipeline.js` sees a boolean and a string
on the state and never learns which agent set them, the same seam as `forceAux`
and `auxOnly`. Any future agent wanting a corroborating rather than a primary
web leg declares the same two fields.

The caveat itself (`WEB_SOURCE_NOTE`, `src/scholar-metrics.js`) names the jobs
the leg is here to do rather than only what it is not — retractions and
corrections, who reported what and when, funding and institutional context —
because "not peer-reviewed" alone reads as *discount this*, which is the wrong
instruction for the source that holds the answer. It also says what the leg may
**not** do: settle a scientific claim the reviewed literature has not settled,
and where the two disagree, report the disagreement rather than resolving it in
the web source's favour.

The tagline changed with the capability, since it advertised the old refusal
("No web search, no exceptions").

## 4b. Retractions: dropped by default, admitted when asked about

`peerReviewed` has always opened with `if (r.retracted) return { ok: false }`,
and for every ordinary research question that is right — a retracted paper cited
as current evidence is the worst single failure this agent can produce. The cost
was invisible until #69: it also makes the retracted record **structurally
unreachable**, so the one question that is *only* answerable from retracted work
is the one question the agent cannot touch.

The exception is the same narrow shape as the preprint widening above:

- `retractionIntent(text)` (`src/scholar.js`) — bilingual EN + SV, matching
  retraction, research misconduct, data fabrication, image duplication,
  expressions of concern, paper mills and PubPeer.
- It is read from the **reader's own message** (`asked`, threaded through the
  registry's `search` opts as `runOneAuxSearch` passes `ctx.gateLastUser`), not
  from the planner's query. Triage is free to paraphrase "which papers were
  retracted" into "amyloid oligomer hypothesis criticism", and the record the
  whole question is about would then vanish on a word choice the reader never
  made. Pre-enrichment for the reason `leadingSources` documents: prose this
  pipeline appended to the message must never trip a gate the user did not.
- A bare "withdrawn" / "tillbakadragen" is deliberately **not** a trigger. It is
  ordinary medical English and Swedish about drugs, trials and consent, and
  matching it would widen a large share of what this agent is asked. The
  retraction sense needs a word that carries it alone, or a noun beside it.
- The Swedish branch avoids `\b`, which does not close after `å/ä/ö` in JS
  regex — the boundary trap the **palaeogenomics** skill records.

Admission is not promotion. The record still has to carry positive evidence of
peer review, which is precisely what makes it the subject of the question, and
`toItem` leads its provenance line with:

```
RETRACTED — this paper has been withdrawn from the record; report what it
claimed and what became of it, never as standing evidence. Nature · 2006 ·
cited 2300× · peer-reviewed: journal with ISSN …
```

The citation count sits right there on purpose: it is half of what was asked,
and most of those citations predate the withdrawal.

**The API filter had to move with the local one.** OpenAlex applies
`is_retracted:false` server-side, so relaxing only `peerReviewed` would have
left the record out of the response entirely, with nothing for the local
admission to admit. `openalexSearch` now takes the same flag and drops the
filter term when it is set — asserted in `src/scholar.test.js` against the
composed URL, because the two filters agreeing is the whole property.

## 5. Reaching the agent

**It is the `science` chat mode** (since 2026-07-31), labeled **Deep Science**
in the composer dropdown, wearing a parchment theme, and since 2026-08-13 the
**first entry in that dropdown and the mode a request falls back to**.

It did not start that way, and the correction is worth keeping. This document
originally argued that `scholar` should be bound to no chat mode — reached only
by an `agent: "scholar"` field on `/api/chat` or an agent share link — on the
grounds that a domain agent should cost the platform nothing: no mode, no flag,
no CSS. The argument was tidy and the consequence was that nobody could find
it. The owner reported it the day it shipped: *"I dont see the deep science
agent."*

Both routes that were supposed to substitute for a door fail an ordinary user.
The composer dropdown is built from `CHAT_MODES`, so an agent outside that list
appears nowhere; minting an agent share link is admin-only (`/api/admin/agent-link`
answers 403 otherwise); and `/agents/` itself 404s, so the preview page that
does exist is unreachable. **A capability with no door is not a capability.**

What it actually cost to give it one is the honest measure of the seam: a
`defaults` row in `sdk/AGENTS.json`, a theme descriptor, an `<option>`, and a
CSS block. **No new answer phase** — `science` resolves to the same `research`
phase as `models` and `cyber`, because a mode is a SELECTION over shipped
behaviour, not new behaviour. Deleting the row still removes the mode; deleting
the agent entry still removes the capability.

One thing it does NOT inherit: `science` was the first mode that does not carry
this site's own source. That rule used to be spelled "every mode except
`normal`", which was true only because all five non-normal modes happened to
want it; a peer-reviewed-literature agent has no more business with this repo
than a general research turn did. The carriers are named outright in
`public/js/chat-mode-core.js` `SOURCE_CARRYING_MODES`, so the next domain mode
inherits nothing by accident — and `cyber`, the second domain mode, is absent
for the same reason.

**Being the terminal fallback has one structural consequence.** `scholar` is the
only mode default declaring `requires: []`. A fallback must be reachable by any
caller: a requirement on the terminal row would fall through to *nothing*, and
nothing resolves to a null capability, which is the unrestricted platform
default. Every other mode default still requires `developer_mode`.

`palaeogenomics` is still bound to no chat mode and still reachable by id
alone — the same gap, unfixed, and now a known one.

## 6. Secrets

All three are optional; the agent works with none of them set.

| Secret | Buys |
|---|---|
| `OPENALEX_API_KEY` | the widest cross-domain backend, past the free daily budget |
| `SERPAPI_KEY` | Google Scholar's own ranking, via a licensed API |
| `SEMANTIC_SCHOLAR_API_KEY` | a second cross-domain backend (the Graph API 429s unkeyed) |

## 7. Refreshing the venue table

```bash
node scripts/scholar-venues.mjs --deep     # ~15 min, one page per 2.5 s
npm test                                   # the parser tests use their own fixture
```

Scholar recomputes the metrics once a year, so this is an annual job. The
artifact records its harvest date and the block quotes it, so an answer says how
old the number it cites is instead of implying it is current.

## 8. Watch list

- **Scholar's profile markup** is the fragile part. `parseProfile` returns
  `null` rather than guessing when the page is not a profile — a CAPTCHA
  interstitial and a consent page both return HTTP 200 — and the enrichment
  fails soft *and visibly* from there. If profiles stop parsing, the fixture in
  `src/scholar-metrics.test.js` is what to update, against a freshly saved page.
- **OpenAlex's pricing** is in motion; the 429 body above is dated. Re-read it
  before concluding the backend is broken.
- **Abbreviated venue names miss.** `venueKey` deliberately does not expand
  abbreviations — "N. Engl. J. Med." does not match "The New England Journal of
  Medicine" — because a wrong expansion attaches the wrong h5-index to a
  citation, which is worse than attaching none.
