---
name: web-search
description: >-
  Load when building an agent pair's web-search plane — the default search
  provider client (bounded, cost-tiered, edge-cached), the pluggable
  self-hosted backend shared core consumed by BOTH tiers (server façade
  with config/env resolution; browser-direct on the client tier), the
  fallback-to-default rule, the numbered cross-search source registry (URL
  dedup, arrival-order citation numbering, per-origin diversity caps with
  per-owner overrides, overflow backfill, the bounded digest), or the
  auxiliary search-source registry seam for adding new citable sources.
  Also load when sources never show up in the UI, citations renumber, one
  domain dominates answers, or a self-hosted search service must drop in.
---

# The web-search plane

Everything between "the pipeline planned these queries" and "synthesis reads
a numbered source digest": the default hosted search client, the pluggable
backend seam that lets an operator or an expert user swap in their own
search service, and the source registry that turns raw results into stable,
diverse, citable `[n]` entries. Search is a *helper* — every branch here
degrades rather than errors, and only the short AI-derived query ever
crosses any wire.

## Capability class & tier story

Class **X** (shared substrate), realized as the canonical shared-core
arrangement:

- **The shared pure core** (backend adapters, response parsers, result
  shaping, dispatch) lives under the client tree, because the browser can
  only import served modules while the server bundler can import from any
  path — so both tiers reach ONE implementation.
- **Server tier**: a thin façade adds config+env resolution (the backend
  choice is an ADMIN, server-wide setting; auth token and URL override are
  server secrets, never in editable config) and the allowlist. The default
  hosted provider client, the edge result cache, and the source registry
  also live server-side, called from the pipeline. The service is called
  from the server, so no CORS is needed.
- **Client tier**: imports the core DIRECTLY and calls a self-hosted
  search service **browser-direct** — no query ever touches the pair's
  server, which is *stronger* than any bridged grant. The config (URL,
  optional key, result count) is a per-user expert setting resting inside
  the sealed client state; CORS on the service is the expert's declared
  responsibility. Send-path priority: browser-direct backend → bridged
  grant (a separate class-B module) → the offline harvest. All fail-soft.
- The hosted default (billed, server-keyed) has no client-tier half by
  design — the client tier reaches live search only through its own
  service or the grant bridge.

## Contracts

- **PA-1** — the orchestrator writes and fires every query
  deterministically; no model chooses a search backend or endpoint.
- **PA-2** — search is a helper phase: timeouts on every fetch, errors
  returned as content strings (never thrown), a misconfigured/unreachable
  backend returns null and the caller degrades (server: fallback to the
  default provider; client: offline harvest).
- **PA-4** — only the query string crosses the wire — never the
  conversation, filenames, or identity; and the module documents the
  default provider's retention reality honestly rather than implying
  privacy it doesn't have.
- **PA-5** — raw REST clients, no SDKs; parameter choices trace to the
  provider's current API reference and to probed behavior.
- **PA-7** — the backend adapters exist ONCE as a pure Node-tested core
  under the client tree; the server side is a façade whose surface IS the
  core (pinned by test).
- **PA-9 boundary** — this module never mints or meters anything; a
  client-tier session using the pair's server-paid search does so through
  the grant-bridge module's tokens, not through anything here.
- **PA-10** — a new backend or source lands through unit tests → a service
  smoke (curl the wire shape) → the admin live test-search → a live
  pipeline run → an optional bench A/B.

## Build plan

1. **The default provider client** (`src/<search>.js`): `webSearch(env,
   log, query, depth)` returning `{content, items, sources, resultCount,
   durationMs}` — `content` is the compact numbered digest string (errors
   come back as strings too, so the pipeline carries on), `items` feed the
   source registry, `sources` the UI panel. Bound the fetch (~15 s; a
   contents/full-text endpoint ~20 s) and cap extracted text per source.
   Take `depth` (`{numResults, type, costMultiplier}`) from the budget
   plan — the slider should buy per-search depth, not only search count —
   and scale cost accounting by the tier's multiplier so a costlier mode
   is never silently under-counted.
2. **The edge result cache** (`src/edge-cache.js` + keying in the client):
   fail-soft get/put over the platform's cross-request cache. Key =
   normalized query (trimmed, lowercased, whitespace-collapsed — the SAME
   normalization as the in-request dedup) + depth tier + **backend id**
   (so a backend switch never serves another backend's cached results).
   TTL ~10 min: absorbs a follow-up turn re-issuing an identical query
   (a separate request the in-request dedup can't see) without staling
   "latest"-type queries. Cache only good, non-empty results; count cache
   hits separately and don't bill them, but let them still satisfy the
   logical search cap.
3. **Concurrent waves**: the pipeline fires each round's queries via
   `Promise.all`, cap applied while building the batch (never a mid-loop
   break), results matched back by index so citation numbering stays
   deterministic regardless of completion order. Note the SSE consequence:
   several `search_start` events may arrive before any `search_done` —
   the client must track pending searches in a Map keyed by
   `source + "|" + query`, not a "last started" slot.
4. **The shared backend core** (`public/js/websearch-backends-core.js`
   pattern): pure adapters per self-hosted shape — a metasearch JSON API
   (`GET {base}/search?q=…&format=json`) and a default-provider-compatible
   wire (`POST {base}/search`, key header, `{results:[{title,url,
   highlights}]}`) — each a pure `parse<Name>Results(data, limit)` plus a
   fail-soft `async <name>Search(cfg, log, query, limit) → items|null`,
   dispatched by `runBackendSearch`. One shared timeout constant (~15 s),
   one per-source text cap (~1200 chars), and result assembly that is
   byte-identical to the default client's shape so synthesis reads every
   backend the same way.
5. **The server façade** (`src/websearch-backends.js`):
   `resolveSearchBackend(env, searchCfg)` — the stored config block
   (`{backend, base_url, results, fallback}`) resolved with the env
   secrets (`SEARCH_BACKEND_URL` overrides the stored URL;
   `SEARCH_BACKEND_KEY` is the auth token — secrets, never in
   admin-editable config) and clamped against the allowlist (the default
   id + the core's self-hosted shapes). Route `webSearch()` through it:
   default id → unchanged behavior; a self-hosted selection runs the core
   and **falls back to the default provider on any failure** when the
   fallback flag is on and the default's key exists. Log
   `backend_hit`/`backend_error`/`backend_fallback` events, and give the
   admin panel a live test-search endpoint.
6. **The client-tier wiring**: a "web search service" section in the
   client settings (URL + optional key + results), persisted INSIDE the
   sealed state via one shared config normalizer; the send path calls the
   core's dispatch directly from the browser. Spell out the CORS
   requirement in the settings UI. Keep full-text/contents fetch
   default-provider-only until a self-hosted `/contents` exists — it
   degrades to empty, fail-soft.
7. **The numbered source registry** (`src/sources.js`): pure data logic —
   `addSources(state, items)` dedupes by URL (`byUrl` Map), numbers
   entries in ARRIVAL order (so `[n]` stays stable between synthesis and
   validation), caps at `plan.maxSources`, keeps ≤3 highlights per source,
   and enforces a hard per-origin diversity cap (~3; hostname with `www.`
   stripped). Over-cap sources go to an overflow list, not the floor:
   `backfillOverflowSources(state)`, called once before synthesis, tops
   the registry back up when the cap left it short — diversity that
   doesn't exist can't be enforced, and a niche topic must not be starved.
   `sourceDigest(sources, capChars)` renders the bounded numbered block
   the gap/synthesis/validation prompts consume.
8. **Per-owner diversity override**: a platform host serving millions of
   independently-authored repos must not be capped as one origin — let a
   source declare `diversityHost` + `diversityKeyOf(url)` (key per owner
   namespace) and have the registry consult `platformDiversityKey(host,
   url)` generically. The cap's real job (no single AUTHOR dominating)
   still holds.
9. **The auxiliary search-source registry** (`src/search-sources.js`) —
   the parallel-work seam: one declarative entry per source — `id` (state
   bucket + log prefix), `intent` (pure predicate on the latest user
   message; false → fully invisible, no step/event/fetch), `search`
   (timeout-bounded fail-soft client), `service` (the display name every
   result card must carry), optional `pickQuery`, `dedupKey` (cross-wave
   dedup), `maxPerRequest`, `promptNote` (ONE planner-vocabulary sentence
   spliced into the triage AND gap prompts via `sourcePromptNotes()`),
   `diversityHost`/`diversityKeyOf`. The generic orchestrator
   (`runAuxSearches` in the pipeline) owns wave timing after the default
   batch, caps, cross-wave dedup, `search_start`/`search_done` emission
   with `source`+`service`, fail-soft, and `state.aux[id]` buckets — the
   pipeline, prompts, and registry never name an individual source. Pin
   the entry contract with a test so a mis-shaped entry fails CI instead
   of silently never firing.
10. **Validate**: registry/diversity unit tests; mocked-fetch dispatch
    tests per adapter; curl the service's wire shape; the admin live
    test-search; one live pipeline run watching the activity panel cite
    the backend's sources; fallback-to-default verified by breaking the
    backend URL.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Default provider client, depth tiers, cache keying, /contents | `src/exa.js` |
| Depth/cost tiers on the plan (`searchDepthFor`, `costMultiplier`) | `src/budget.js` |
| Fail-soft edge cache helpers | `src/edge-cache.js` |
| Shared backend pure core (SearXNG + Exa-compatible adapters) | `public/js/websearch-backends-core.js` |
| Server façade: config/env resolution + allowlist | `src/websearch-backends.js`, `src/config.js` (`search` block) |
| Client-tier browser-direct config + send-path priority | `public/cure/drc.js` (`drcDirectWebSearch`), `public/js/drc-page-core.js` (`normalizeSearchBackend`) |
| Numbered registry, diversity cap, overflow backfill, digest | `src/sources.js` |
| Auxiliary source registry + entry contract pin | `src/search-sources.js`, `src/search-sources.test.js` |
| The worked auxiliary source (intent, term ladder, slices, per-owner key) | `src/hf.js` |
| Generic aux orchestration + concurrent waves | `runAuxSearches` / `runSearches` in `src/pipeline.js` |
| Self-hosted service recipes + CORS notes | `.claude/skills/local-web-search` |
| Integration procedure + validation ladder | `.claude/skills/add-research-source` |

## Acceptance checklist

- [ ] Unit: registry — `hostnameOf`, URL dedup, arrival-order numbering,
      the per-origin cap, per-owner override, overflow backfill, digest
      bounding.
- [ ] Unit: cache key normalization (query/type/count/backend id all in
      the key); cached hits flagged and not billed.
- [ ] Unit: each backend adapter's parser (junk → null, never a throw) and
      the dispatch over a mocked fetch; the server façade's env/config
      resolution + allowlist clamping; the façade-surface-is-the-core pin.
- [ ] Unit: the aux-source entry contract (every entry's shape pinned);
      intent predicates both directions with documented false-positive
      tradeoffs; item mappers; `sourcePromptNotes` composition.
- [ ] Service smoke: curl the self-hosted service's wire shape directly.
- [ ] Live: admin test-search reports backend/resultCount/sources; one
      pipeline run cites the backend's sources in the activity panel;
      `backend_hit` in the logs.
- [ ] Live: fallback verified — break the backend, watch
      `backend_fallback` and a default-provider result.
- [ ] Aux sources flow through `search_done` with `source`+`service` and
      appear in the reconstructed registry (debug export + eval harness).

## Pitfalls

- **Probe the API empirically BEFORE writing the client.** The reference's
  hub client was redesigned twice on unprobed assumptions: `?search=` was
  a NAME-substring matcher (verbose research queries return NOTHING), so
  it needed noise-word stripping + a bounded token-drop attempt ladder.
  Planned queries are written for a web engine; keyword APIs need
  adaptation. Date what you established; expect upstream drift.
- **Routing is not only code.** With the intent predicate accepting a bare
  abbreviation, triage still killed the request by asking what the
  abbreviation meant — one phase before search could fire. A source that
  introduces vocabulary must teach the PROMPTS too (the entry's
  `promptNote`), with structural tests quoting the production failure.
- **Sources invisible without named search events.** The first aux
  integration emitted generic steps: its sources were cited `[n]` in
  answers but invisible to the source panel, the debug export, and both
  eval harnesses — all of which reconstruct the registry from
  `search_done` events; the eval judge fact-checked against a registry
  missing them. And carry `service` on every event: users couldn't tell a
  hub card from a web card when identity was only a query-text prefix.
- **Relevance ranking fights diversity.** A thorough 19-search deep run on
  a company's own product still cited that company's site for most
  sources — whoever publishes most about themselves wins relevance. The
  hard per-origin cap is the backstop; the prompt-level rules (mandatory
  independent-source query, dominance-as-gap, say-so-plainly in
  synthesis) are belt to its suspenders. Keep both.
- **The /contents surcharge is real money**: the default provider prices
  full-text fetch and deep search above standard search (published per-1k
  pricing: search $7, deep $12 as of 2026) — thread `costMultiplier`
  through usage recording or the spend is silently under-counted. Deep
  mode is untested at scale; reserve it for the top tier.
- **Retention honesty**: the reference's default provider is NOT
  zero-data-retention on the standard plan. Only short AI-derived queries
  ever reach it — but a query still reveals the topic; the documented
  mitigation is the two-step semi-private workflow (generic question with
  search on, real question with search off), surfaced in user docs. A
  self-hosted backend removes the third party entirely — the mission's
  code side.
- **Self-hosted services under burst load**: waves fire several queries
  per second concurrently — public metasearch instances rate-limit hard
  (run your own; mind its limiter), the metasearch JSON format is OFF by
  default and must be enabled, and an uncapped browser-based crawler will
  OOM (pool the browser, block heavy assets, timeout everything).
- **CORS is the client tier's admission bar here too**: a browser-direct
  service must answer preflight and set `Access-Control-Allow-Origin`; the
  server-called path needs none. Same rule as the provider registry.
- **Cache staleness vs "latest" queries**: TTL is a tradeoff — long enough
  to absorb same-session follow-ups, short enough that recency questions
  aren't served stale results. The reference settled on 10 min; leave
  errors and empty results uncached so retries can still find something.
