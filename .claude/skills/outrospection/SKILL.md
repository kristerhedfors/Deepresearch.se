---
name: outrospection
description: >-
  Load when working on OUTROSPECTION — the outward-looking feed at
  /outrospect/ that is introspection's mirror image: what everyone ELSE is
  building, through the seven-lens registry (the one big dependency,
  browser-runnable models, edge RAG, LLM app architecture, provable privacy,
  agent standards, other deep-research systems). Covers public/js/outrospect-core.js
  (the shared pure core — lenses, item identity, the DELTA, mergeFeed), the
  src/outrospect.js façade + its three endpoints, the view
  public/js/outrospect-view.js + public/outrospect/, the offline scan
  scripts/outrospect-scan.mjs (npm run outrospect) and the read CLI
  scripts/outrospect, the D1 outrospect_items/outrospect_runs tables, and the
  feedback STRATEGY lane (feedback-core's third scope) that files a note
  written on that page as an operative/strategic idea rather than a bug
  report. Also load when adding or retiring a LENS, tuning the per-lens
  cooldown / per-user cap, or when the feed shows nothing.
---

# Outrospection — the outward-looking feed

Full reference: **`docs/OUTROSPECTION.md`**. This skill is the working
guidance — what to do, in what order, and which mistakes have already been
made.

## The shape in one paragraph

Seven lenses, each a standing strategic question with its own literal Exa
queries. Two halves fill the feed: an offline scan
(`scripts/outrospect-scan.mjs`) that commits `public/outrospect/feed.json`, and
a live refresh (`POST /api/outrospect/refresh`) that the view fires on every
visit and that stores into D1. Both halves import the SAME pure core
(`public/js/outrospect-core.js`) — the Worker through the `src/outrospect.js`
façade, the browser directly, the script in Node. The delta is the product; the
merge decides what is new.

## Rules that are load-bearing

**Never fabricate a feed item.** The committed artifact ships empty and stays
empty until a real scan runs. Items are real search results or nothing at all —
a placeholder headline with a plausible URL is a fabricated record, and it
would be indistinguishable from a real one the moment it merged. If you are
working without an `EXA_API_KEY`, leave the artifact alone and let the live
half fill the page.

**One implementation, three faces.** Anything about what a lens is, what
counts as one item, or what counts as new belongs in
`public/js/outrospect-core.js` — never re-implemented in the façade, the view,
or the script. `src/outrospect.test.js` asserts the registry re-export is the
same object by identity; that test exists to catch a copy.

**The queries are committed, literal strings.** No model picks what to search
for. That is what makes the outbound traffic auditable in git (invariant 4's
"outbound requests carry the minimum" — a query, nothing else) and it keeps the
feed deterministic. Do not introduce a query-generation phase.

**Fail soft, always** (invariant 2). A dead search backend yields zero new
items and a 200, never a 500 — the refresh is fired during someone's page load.
`src/outrospect.test.js` pins this with an env that has no search key at all.

**Rows carry the article, never the reader.** `outrospect_items` has no user
column. `outrospect_runs` exists only for the rate limit and stores a query
COUNT, not query text. Do not add an identity column to either "for
debugging".

## Adding or changing a lens

1. Add the entry to `OUTROSPECT_LENSES` in `public/js/outrospect-core.js`:
   `id` (slug), `title`, `titleSv`, `question`, `questionSv`, `queries` (two or
   more literal search strings), `terms`, `termsSv`.
2. **Swedish is not optional** (invariant 6). `lensMatch` is a deterministic
   routing gate, so the Swedish term set must be as broad as the English one —
   definite forms and compounds included (`beroendet`, `beroendena`,
   `arkitekturen`, `vektordatabasen`). The parity test fails if `termsSv` is
   shorter than `terms`.
3. Add routing assertions to `public/js/outrospect-core.test.js` in the same
   change, in BOTH languages.
4. Nothing else needs touching — the view, the tally, the scan, and the
   stalest-lens picker all read the registry.

Retiring a lens: remove the entry, but note that existing D1 rows keep the old
id. `validateFeedItem` clamps an unknown lens to the first registry entry
rather than dropping the row, so a retired lens's items resurface under
another heading instead of vanishing. If that matters, delete the rows.

## The feed shows nothing

In order:

1. **Is the artifact empty?** It is, by default. That is expected on a fresh
   checkout, not a bug.
2. **Is there a search backend?** `POST /api/outrospect/refresh` returns
   `degraded: true` with an empty `fresh` when `webSearch` cannot run
   (no `EXA_API_KEY` and no self-hosted backend). The view says "the search
   backend did not answer".
3. **Is everything on cooldown?** A response with `cooled: true` means a lens
   was searched inside `LENS_COOLDOWN_MS` and the request deliberately cost
   nothing. Check `scripts/outrospect` — the run log shows exactly when each
   lens last ran.
4. **Is D1 configured?** Without it `GET /api/outrospect/feed` returns
   `live: false` and the page runs on the committed artifact alone; refresh
   returns 503. The page still renders.
5. **Did the searches return results that were all already known?** That is the
   normal steady state and the view says so — "nothing out there we did not
   already have". It is a different message from the cooled one on purpose,
   because a silent no-op reads as a broken button.

## Running the scan

```bash
EXA_API_KEY=… npm run outrospect                     # every lens
EXA_API_KEY=… node scripts/outrospect-scan.mjs --lens browser-models
EXA_API_KEY=… node scripts/outrospect-scan.mjs --dry # show the delta, write nothing
```

Commit `public/outrospect/feed.json` with the result. `--dry` first is worth it
when you have just changed a lens's queries — a query that returns nothing
usable shows up immediately as `0 usable` in the per-query line.

## The strategy lane

A note written on the outrospection page is direction, not a defect. It posts
to the ordinary `/api/feedback` queue with `page` = `strategyPageTag(lens)`
(e.g. `outrospect:browser-models/strategy`), which makes it the third feedback
SCOPE alongside `session` and `standalone`:

- `feedback-core.js` owns `STRATEGY_PAGE_SUFFIX`, `isStrategyPage`,
  `scopeOfPage`, `strategyPageTag`, and `FEEDBACK_ACKS_STRATEGY` (EN+SV, same
  length as the other sets).
- `src/feedback.js` exposes `strategy: true` on the projection and states the
  scope outright in the `?format=text` view the loop reads.
- The lens value reaches the server from a client, so `strategyPageTag`
  sanitizes it to `[a-z0-9-]` and clamps the length before it becomes a stored
  page tag. Keep that.

When working the feedback queue (the **feedback-loop** skill), a `strategy`
entry is NOT triaged as a defect — do not open with "reproduce the complaint".
It is an idea about where the project should go, and the right response is a
decision, recorded.

## Tests

```bash
node --test public/js/outrospect-core.test.js   # registry, EN/SV parity, delta, merge
node --test public/js/outrospect-view.test.js   # status lines, the three network calls
node --test src/outrospect.test.js              # validation, cooldown, storage, endpoints
node --test public/js/feedback-core.test.js     # the strategy lane
```

Two things learned writing them, both worth keeping:

- **Use a realistic epoch in fixtures.** `validateFeedItem` rejects a
  non-positive `first_seen`, so a synthetic `now` smaller than
  `FRESH_WINDOW_MS` makes `now - FRESH_WINDOW_MS - 1` negative and silently
  clamps to `now` — every item then reads as fresh and the test fails
  confusingly. Use something like `1_800_000_000_000`.
- **The hourly cap cannot be reached in a loop.** Repeated refreshes hit the
  per-lens cooldown first and cost nothing, so a tight loop never spends the
  cap. Testing it honestly means seeding `outrospect_runs` directly with runs
  whose cooldowns have already expired.

## Related

- **introspection** — the mirror image; the same "committed artifact plus
  shared pure core" shape, pointed inward.
- **feedback-loop** — where a strategy note lands and how the queue is worked.
- **integrations** / **add-research-source** — `webSearch` and the search
  backend this feature rides on.
- **local-web-search** — running your own search service; outrospection routes
  through the same backend seam, so a self-hosted backend keeps the lens
  queries off a third party.
