# Deep Science — Google Scholar and the peer-reviewed record

The **Deep Science** agent (`scholar` in `sdk/AGENTS.json`) answers only from
peer-reviewed publications. No web search runs. No preprint reaches an answer.

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

With no keys at all the agent still works: Europe PMC's peer-reviewed slice
needs none.

## 2. What counts as peer-reviewed

The filter admits a record when a backend says something that *entails* peer
review. It never admits one for lack of evidence to the contrary.

| Backend | Admitted when |
|---|---|
| OpenAlex | `type` ∈ {article, review}, primary location's source is a `journal`, not retracted, has an ISSN |
| Europe PMC | `source` ∈ {MED, PMC, AGR, CBA} — never `PPR`, which is bioRxiv/medRxiv — and a journal title is present |
| Semantic Scholar | `publicationTypes` names JournalArticle or Review, plus a journal name and a DOI |
| Crossref | `type` is `journal-article` and an ISSN is registered |
| **Google Scholar** | **never on its own** |

That last row is the load-bearing one. A Scholar result carries no peer-review
signal at all — Scholar indexes preprints, theses, slide decks, working papers
and predatory journals beside *Nature*, and its result JSON does not distinguish
them. So a Scholar hit is admitted only by being **merged** onto a record from
one of the four backends above, by DOI or normalized title. What it contributes
is its ranking and its citation count; the verdict always comes from a source
that publishes one.

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
| `capability.search.web: false` | `sdk/AGENTS.json` | `capSearch` composes by **narrowing in both directions**, so a request cannot re-enable the Exa leg |
| `state.forceAux = ["scholar"]` | `src/scholar-metrics.js` | the peer-reviewed source runs every turn, whatever the message says |
| `state.auxOnly = ["scholar"]` | same | **no other auxiliary source may run** — without it, arXiv would still fire on a physics question and hand the agent preprints |

`state.auxOnly` is new (2026-07-31) and generic: `pipeline.js` reads ids off the
state and names no source, so any future agent needing the same restriction gets
it for free. It is purely *narrowing* — it can only remove sources — which keeps
the safety argument for user-authorable specs intact.

The agent's control set has **no web-search toggle**. With `web: false` the
toggle could only ever be a no-op that implied otherwise.

## 5. Reaching the agent

**It is the `science` chat mode** (since 2026-07-31), labeled **Deep Science**
in the composer dropdown, wearing a parchment theme.

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
phase as `normal` and `models`, because a mode is a SELECTION over shipped
behaviour, not new behaviour. Deleting the row still removes the mode; deleting
the agent entry still removes the capability.

One thing it does NOT inherit: `science` is the first mode that does not carry
this site's own source. That rule used to be spelled "every mode except
`normal`", which was true only because all five non-normal modes happened to
want it; a peer-reviewed-literature agent has no more business with this repo
than plain Deep Research does. The carriers are now named outright in
`public/js/chat-mode-core.js` `SOURCE_CARRYING_MODES`, so the next domain mode
inherits nothing by accident.

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
