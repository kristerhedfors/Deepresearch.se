# Outrospection — the outward-looking feed

Introspection mode points the site at itself: ask how it works and it answers
from a committed snapshot of its own source. Outrospection is the other
direction. It is a running feed of what everyone **else** is building, filtered
through a small set of standing questions this project actually has, and it
lives at `/outrospect/`.

The name is borrowed from Roman Krznaric, who uses it for the practice of
learning about yourself by looking outward — at other people's lives, cultures,
and answers — rather than by more self-examination. The engineering version of
that idea is unglamorous and true: a project that only ever reads its own
source re-derives its own assumptions forever. Every architectural decision
here was made against a snapshot of what was possible when it was made, and
several of them are now wrong for reasons that have nothing to do with this
repo. You do not find those by grepping. You find them by reading what someone
else shipped last week.

So the feed is deliberately shaped like a tabloid front page rather than a
research report. Kicker, headline, one line, source. You skim it, and you stop
where something changes what this project should do.

## The seven lenses

The feed is not general technology news. Each lens is a standing strategic
question, and it exists because the answer would change something concrete
here. The registry lives in `public/js/outrospect-core.js`; each entry carries
its own literal search queries and its own English and Swedish routing terms.

| Lens | The standing question |
|---|---|
| `one-dependency` | Is there a library significant enough to break the zero-dependency rule for — and what would we build on top of it? |
| `browser-models` | Which models can actually run on the user's own device now? |
| `edge-rag` | What retrieval works without a vector database in someone else's cloud? |
| `llm-architecture` | How are other people structuring LLM applications? |
| `privacy-llm` | Who else is making privacy structural rather than a policy line? |
| `agent-standards` | Which interchange standards are becoming real? |
| `deep-research` | What are the other deep-research systems doing that we are not? |

Two of these are pointed straight at known sore spots. `one-dependency` exists
because invariant 5 says no runtime dependencies, and the honest reading of
that rule is "none have been worth it yet" — which is a claim with an expiry
date, not a principle. `browser-models` exists because Se/cure's entire thesis
is capability without a server, and the Bonsai phone-inference work
(`docs/BONSAI-27B-PHONE-INFERENCE.md`) is the standing record of that not
working well enough yet.

Adding a lens means adding an entry to `OUTROSPECT_LENSES` with its queries and
both term sets. The parity test in `public/js/outrospect-core.test.js` will
fail if the Swedish terms are thinner than the English ones (invariant 6).

## How the feed fills

Two halves, one merge.

**The offline half** is `scripts/outrospect-scan.mjs`, run as
`EXA_API_KEY=… npm run outrospect`. It fans every lens's queries out at Exa,
diffs the results against what `public/outrospect/feed.json` already held, and
writes the merged result back. The delta is the product: a scan that finds
forty results and reports three new has done its job, because the other
thirty-seven were already on the page and re-listing them would bury the three
things that changed. The artifact is committed, which is why the page works
with no database at all.

**The live half** is `POST /api/outrospect/refresh`. The view fires it shortly
after the first paint, and the server picks whichever lens has gone stalest
(`stalestLens`), runs that lens's queries, stores what neither the client nor
the database already had, and returns it. Visiting the page is what keeps the
page current — the feed heals its own thin spots by being read.

Both halves run the same code. The lens queries, the URL normalization, the
delta, and the merge all live in `public/js/outrospect-core.js`, which the
Worker imports through the `src/outrospect.js` façade, the browser imports
directly, and the scan script imports in Node. One implementation, three faces,
so a scan and a visit cannot disagree about what counts as new.

### What "new" means

An item's identity is its normalized URL: scheme forced to https, `www.` and
tracking parameters stripped, fragment dropped, trailing slash removed. That
normalization is the whole reason an article found twice does not flash as new
twice — the same piece arriving from a second lens, or two weeks later with a
`utm_source` attached, is one item.

`mergeFeed` keeps the **earliest** `first_seen` when it collapses duplicates,
so re-finding an article does not bump it back to the top. The `fresh` flag is
computed at read time against the reader's clock, never stored — a committed
`true` would go stale the moment it was written.

## Cost and rate limiting

Every refresh is real money at the search provider, and the page invites one on
every visit, so two limits sit in front of it:

- **A per-lens cooldown** (`LENS_COOLDOWN_MS`, 30 minutes) shared across all
  visitors. A lens searched minutes ago has nothing to gain from searching
  again, so a visit inside the window rides the previous visitor's results and
  is told so. This is the limit that actually does the work.
- **A per-user hourly cap** (`USER_RUNS_PER_HOUR`) as a backstop behind it.
  Because the cooldown bites first, holding the button down never reaches this
  cap — reaching it takes an hour of runs whose cooldowns have expired.

Both read off the D1 `outrospect_runs` table. A refresh that hits either one
returns 200 with an explanation rather than an error: `cooled` and `limited`
are outcomes the view states plainly, because a silent no-op reads as a broken
button.

## Privacy posture

The feed is an outbound-request feature, so invariant 4 applies directly.

- **What leaves the site** is a query and nothing else. The queries are the
  literal strings committed in the lens registry, so what this site asks the
  search provider is auditable in git. No conversation, no identity, and
  nothing the reader typed is ever sent — the note composer posts to the
  feedback queue, not to a search.
- **What is stored** is the article, never the reader. `outrospect_items` has
  no user column at all: who happened to be visiting when a headline was found
  is not part of the record.
- **The run log** exists only because the rate limit needs it. It records which
  lens was searched and a count of queries — not query text, and nothing about
  what the reader was looking at.

## The shortcut back

A note written while reading this feed is not a bug report. It is direction —
"this library should become our one dependency", "this architecture beats
ours", "drop this lens" — and it is filed as such.

The mechanism is the existing feedback queue with a third scope. Alongside
`session` (feedback about a research conversation) and `standalone` (a generic
note that opened a chat), `strategy` marks an operative or strategic idea, and
the page tag carries the lens it was written under:
`outrospect:browser-models/strategy`. `projectFeedback` exposes it as
`strategy: true`, and the `?format=text` view the development loop reads states
it outright:

```
SCOPE: strategy — an operative/strategic idea written from the outrospection
view (the page tag carries the lens it answers). Read it as DIRECTION for the
project, NOT as a defect report to reproduce.
```

That sentence is the point of the whole lane. The loop's first move on a
session report is "reproduce the complaint", and that is the wrong first move
on an idea about which library to build on next. The acknowledgment the user
gets is scope-matched too (`FEEDBACK_ACKS_STRATEGY`, English and Swedish), so a
strategic note is not answered with a promise about a conversation nobody had.

Unlike the other two scopes, `strategy` is never inferred from the
conversation — the outward view declares it, because the surface is what makes
the note strategic.

## Surfaces

| Where | What |
|---|---|
| `/outrospect/` | The view. Linked from the account panel's documentation list. |
| `GET /api/outrospect/feed` | The live stream. `?lens=` `?since=` `?limit=` `?format=text` |
| `POST /api/outrospect/refresh` | One lens, on the visitor's behalf. `{lens?, known?}` |
| `GET /api/admin/outrospect` | Feed plus run log, `?format=text` for the agent loop |
| `npm run outrospect` | The offline scan (`scripts/outrospect-scan.mjs`) |
| `scripts/outrospect` | The read CLI against the deployed site |

## Files

| Path | Role |
|---|---|
| `public/js/outrospect-core.js` | The pure core: lens registry, item identity, delta, merge, text render |
| `src/outrospect.js` | Worker façade + the three endpoints + D1 storage |
| `public/js/outrospect-view.js` | The page module: render, look, and the shortcut back |
| `public/outrospect/index.html` | The page |
| `public/outrospect/feed.json` | The committed artifact (empty until a scan runs) |
| `scripts/outrospect-scan.mjs` | The offline Exa scan and delta |
| `scripts/outrospect` | The admin read CLI |

The committed artifact ships **empty**, and that is deliberate: it holds real
search results or nothing at all, never placeholder headlines. Until a scan has
run against a real `EXA_API_KEY`, the page runs entirely on the live half and
fills itself from the first visit onward.
