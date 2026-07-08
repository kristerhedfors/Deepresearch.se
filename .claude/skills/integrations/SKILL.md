---
name: integrations
description: >-
  Load when integrating or modifying an external data source — Berget the LLM
  provider (src/berget.js), Exa web search (src/exa.js), OpenStreetMap Nominatim
  reverse geocoding (src/geocode.js), Shodan host intelligence (src/shodan.js),
  or Google Maps / Street View (src/googlemaps.js) — or adding a new enrichment
  in the same deterministic no-function-calling pattern.
---

# External providers & the enrichment pattern

## LLM provider — Berget.ai

**This project uses Berget.ai, NOT Anthropic.** Berget exposes an
OpenAI-compatible API at `https://api.berget.ai/v1`.

- **Auth:** the Worker reads the `BERGET_API_TOKEN` secret (already configured
  on the Worker in the Cloudflare dashboard) and sends it as
  `Authorization: Bearer <token>`. Never hardcode the token in the repo.
- **Model:** defaults to **Mistral Small**
  (`mistralai/Mistral-Small-3.2-24B-Instruct-2506`, alias `mistral-small`),
  overridable via the optional `BERGET_MODEL` env var. Other models available
  in Berget's repo can be found at `GET https://api.berget.ai/v1/models`.
- **Model dropdown:** the UI lets users pick a model. `GET /api/models`
  (Worker) proxies Berget's catalog filtered to text models that support
  streaming + JSON mode (the research pipeline's planning/validation calls
  require it), cached ~5 min per isolate (`src/berget.js`). Models Berget reports as down (e.g.
  `status.up: false`, lifecycle `maintenance`) are included with `up: false`
  and rendered greyed out/disabled — they become selectable automatically
  when Berget brings them back. The client sends `model` in the `POST
  /api/chat` body; the Worker validates it (400 on unknown or down models)
  and falls back to the default if the catalog is unreachable. Selection
  persists in `localStorage`.
- **API shape:** OpenAI-style `POST /v1/chat/completions` with
  `stream: true`; SSE deltas arrive as `choices[0].delta.content`, terminated
  by `data: [DONE]`.
- **Image input:** models with `capabilities.vision` (exposed as `vision` in
  `/api/models`) accept OpenAI-style multimodal content:
  `content: [{type:"text",text}, {type:"image_url",image_url:{url:"data:image/…"}}]`.
  The attach button stays tappable on non-vision models (dimmed, not
  disabled — tooltips don't exist on touch devices) and offers a one-tap
  switch to a vision-capable model; the Worker rejects
  images on non-vision models (400 listing vision-capable alternatives).
  **Berget rejects request bodies over ~1 MB** ("Request payload too large";
  measured 2026-07: 1.0M chars OK, 1.2M rejected), so the client downscales
  images before attaching (canvas → JPEG, max 1280px, quality ladder, ≤280K
  chars/image, ≤700K/message) and strips images from all but the latest
  message when resending history. Server caps in `src/validation.js`: 4
  images/message, 8/request, 300K chars/image, 750K total. Image parts of
  the latest user message are forwarded to the synthesis call so research
  can use them; image-only sends get an explicit analyze instruction; JSON
  helper phases are text-only and see an `[N image(s) attached]` marker.

## Web search — Exa

**Canonical reference:** https://docs.exa.ai/reference/search-api-guide-for-coding-agents
— the source of truth for search types, parameters, and response shape. Fetch it
if anything here looks stale, and report staleness back.

Searches are orchestrated by the Worker pipeline in `src/pipeline.js` (no
function calling): the triage/gap-check phases plan queries via JSON-mode
calls, the Worker runs them against Exa, and synthesis answers from the
accumulated numbered source registry.

**Retention reality — Exa is NOT zero-data-retention by default.** Exa
retains query data on the standard API plan; true ZDR is an
enterprise-only arrangement (https://exa.ai/blog/zdr-search-engine),
which this site does not have. The documented workaround is the
**two-step semi-private workflow** (user docs: `/help/` → "Sensitive
topics", hinted in the web-search popover — opened by press-and-holding
the spiderweb knob): (1) web search ON, ask a *generic*,
impersonal question on the subject so the pipeline pulls sources into
the conversation; (2) web search OFF, ask the real/specific questions —
the model answers from the in-context sources, nothing further reaches
Exa. Only AI-derived short queries ever go to Exa (never the
conversation), but a query still reveals the topic. Keep the help page,
popover, and privacy notice in sync if the search provider or plan
changes (an Exa ZDR enterprise plan would obsolete these warnings).

- **Auth:** the Worker reads the `EXA_API_KEY` secret and sends it as the
  `x-api-key` header. Never hardcode it. (Exa returns HTTP 402 without a key.)
- **Endpoint:** `POST https://api.exa.ai/search` (REST — the Worker is JS, so we
  do NOT use the `exa_py` Python SDK).
- **Request:** `{ query, type: "auto", numResults: 5, contents: { highlights: true } }`.
  `type: "auto"` balances relevance/speed; `highlights` returns token-efficient
  excerpts (preferred for LLM use over full `text`).
- **Response:** `data.results[]`, each with `title`, `url`, `highlights[]`.
- **Common mistakes:** `text`/`summary`/`highlights` must be nested under
  `contents` on `/search` (they're top-level only on `/contents`); `useAutoprompt`,
  `livecrawl`, `numSentences` are deprecated; use `includeDomains`/`excludeDomains`
  (not `includeUrls`). Search volume is capped by the time-budget plan
  (`plan.maxSearches` — `src/budget.js`).
- **Search depth also scales with the time budget** (`plan.searchDepth` —
  `src/budget.js`'s `searchDepthFor()`), not just search *count*. A round 6
  assessment found the slider previously only bought more separate
  searches while every individual call stayed a fixed 5-result `"auto"`
  search — below even Exa's own default of 10 — regardless of budget.
  Tiered the same way as the angle/round caps: `<60s` → 5 results/`auto`
  (unchanged floor behavior), `60-239s` → 8/`auto`, `240-419s` →
  10/`auto`, `≥420s` → 10/`"deep"` (Exa's own thorough-but-slower mode,
  reserved for the most generous budgets only — untested at scale, and
  ~1.7x Exa's per-search price). `src/exa.js`'s `webSearch()` takes this
  as a `depth` param instead of hardcoding `numResults`/`type`.
  **Cost accounting follows**: Exa's real pricing varies by tier (search
  $7/1k, deep $12/1k, deep-reasoning $15/1k as of 2026); the admin's
  configured `exa_cost_per_search_eur` is scaled by `plan.searchDepth
  .costMultiplier` (`src/chat.js`'s `recordUsage` call) so a request that
  used a costlier tier doesn't get silently under-counted against the
  user's opaque budget bar or the admin's totals.
- **Searches within one round run concurrently** (`Promise.all` in
  `src/pipeline.js`'s `runSearches`), not one fetch at a time — the same
  assessment found the previous sequential loop left several seconds of
  wall-clock on the table per round for independent queries. The query
  cap is applied before firing the batch (not as a mid-loop break) so it
  can't overrun `plan.maxSearches`, and results are processed back in
  original order so citation numbering stays deterministic regardless of
  fetch completion order. This changed the SSE contract subtly: several
  `search_start` events can now arrive before any `search_done` (not
  strictly paired) — `public/js/activity.js` tracks pending search steps
  in a `Map` keyed by query text instead of a single "last started" slot.
- **Identical searches are cached across requests** (`src/exa.js`'s
  `webSearch`, keyed by `searchCacheKey`). The in-request dedup
  (`state.ranQueries`) only stops repeats *within one* `/api/chat` call; a
  follow-up turn is a SEPARATE request, so before this a follow-up that
  re-issued an earlier query (e.g. triage's fallback re-searching the prior
  question — see "context-dependent follow-ups") hit Exa and billed the
  user again for the identical search. `webSearch` now checks the Workers
  Cache API (`caches.default` — durable across requests in a colo, shared
  across isolates, no binding needed) before calling Exa and stores each
  successful, non-empty result under a normalized key (query lowercased +
  whitespace-collapsed — matching the dedup normalization — plus the depth
  tier, so a deeper re-run isn't served a shallower cached result), TTL
  `CACHE_TTL_S` (10 min: absorbs a same-session follow-up without staling
  "latest"-type queries). Everything is fail-soft — any cache miss/error
  falls through to a live search. A cache hit returns `cached:true`;
  `runSearches` counts it into `state.cachedSearchCount` and `chat.js`
  subtracts those from the billed Exa searches (cost AND search-quota
  usage) since nothing was actually spent at Exa — a cached search still
  counts as a logical search for the `maxSearches` cap and the activity UI
  (the angle was covered), it just isn't charged. `search_done` carries a
  `cached` flag (forward-compatible; clients ignore unknown fields). Only
  good results are cached — errors and empty results are left uncached so a
  retry can still find something. Verify live via Workers Logs
  (`exa.cache_hit` / `exa.cache_write_failed`), the platform-integration
  convention this project uses.
- **Source diversity is enforced, not just requested.** A round 7
  assessment found that even a thorough, 19-search "deep" run on a
  company's own product still cited that company's own site for most of
  its sources — relevance-ranked search naturally surfaces whoever
  published the most about themselves, not whoever is most independent.
  Fixed on two levels, deliberately not either/or:
  - **Algorithmic backstop** (`src/pipeline.js`'s `addSources()`): a hard
    per-domain cap (3) on the source registry, the same relevance-vs-
    diversity tension classic search-result diversification techniques
    address (Carbonell & Goldstein's Maximal Marginal Relevance is the
    canonical one) — guaranteed regardless of whether a given model
    reliably follows the prompt-level asks below. Sources beyond the cap
    aren't dropped outright — they go to an overflow list `backfillOverflowSources()`
    draws from (before synthesis) if the capped registry ends up short of
    `plan.maxSources`, so a genuinely niche topic with few distinct
    domains isn't artificially starved enforcing diversity that doesn't
    exist.
  - **Prompt-level**: `triagePrompt` now makes an independent-source query
    mandatory (not "criticism — as applicable", which let a model decide
    a routine-sounding update wasn't "risky" enough to need one);
    `gapPrompt` treats single-domain dominance in the sources collected
    so far as an explicit coverage gap; `synthPrompt` requires the answer
    say so plainly when sources are still dominated by one origin despite
    all this, rather than presenting single-origin claims as
    independently established.

## Reverse geocoding — OpenStreetMap Nominatim

A photo's GPS EXIF is only decimal coordinates (`public/js/exif.js`
extracts them, unchanged, into the image metadata block) — of little use
on their own to either a model (which can only guess loosely from
training data) or Exa (which can't search on a lat/lon pair). `src/
geocode.js` resolves them into an actual place name server-side, giving
both something concrete to reason and search with.

- **Auth:** none — Nominatim's public API needs no key/secret.
- **Endpoint:** `GET https://nominatim.openstreetmap.org/reverse` —
  `format=jsonv2&lat=…&lon=…&zoom=14&addressdetails=0`. `zoom=14`
  targets neighborhood-level resolution (not house-number precision);
  `addressdetails=0` skips the structured breakdown since only
  `display_name` (one human-readable string) is used.
- **Request shape is deliberately minimal**: only the coordinates cross
  the wire — never the filename, the user's question, or any account/
  session identifier. The `User-Agent` is a generic, non-identifying
  string (`geocode-client/1.0` — no site name, no URL); Nominatim's
  usage policy requires *some* non-default value to filter unidentified
  bot traffic, but nothing more specific than that is needed or sent.
- **Server-side only, same as Berget/Exa** — not called from the
  browser. Keeps it Worker-mediated (logged, rate-limit-aware) instead
  of the client talking to a fourth third party directly, and lets
  `chat.js` decide policy (see below) instead of leaving it to client
  code.
- **Runs independent of the web-search toggle.** Unlike Exa (which
  researches the user's *topic*, gated behind the toggle for the privacy
  reasons in the section above), this resolves metadata the photo
  *itself* already carries — closer to parsing document text than to
  researching a question. `chat.js` calls `augmentWithLocations()` right
  after setting up the SSE `emit` (before the pipeline), appending a
  `Resolved location(s)` block to the conversation
  (`src/conversation.js`'s `withAppendedText()`) built from
  `public/js/exif.js`'s GPS output, forwarded separately from the message
  text as `body.imageLocations` (validated server-side by
  `validateImageLocations()` — capped at 4 entries, coordinates range-
  checked) rather than resolved client-side.
- **Emits a visible activity step that NAMES the service.** Like the
  Shodan enrichment, `augmentWithLocations` takes the `emit` and fires
  `step_start`/`step_done` (id `geocode`) whose label names *OpenStreetMap
  Nominatim* explicitly — so the user gets the same "which external source
  is being checked" visibility for the maps lookup that web search and
  Shodan already give. Stays SILENT (no step) when there's no photo
  location to resolve, so an ordinary question shows no spurious step.
- **Fails soft, same as every other helper phase**: a bad/missing
  coordinate, a Nominatim timeout (4s) or error, all degrade to "no
  resolved location" — the raw coordinates the client already included
  in the image metadata block are still there as a fallback, and the
  chat is never blocked or delayed meaningfully by this.

## Shodan host intelligence — the opt-in `shodan_mcp` knob (default OFF)

An opt-in per-user setting (surfaced in the account panel's **Settings**
sub-view as "Shodan host intelligence", disclosed as the "Shodan MCP" the
task asked for) that enriches a research question with live
infrastructure data from Shodan whenever the question names a host. Like
the reverse geocoder, it's wired the deterministic, no-function-calling
way this pipeline requires — NOT a live MCP transport (a Cloudflare
Worker can't hold a stdio MCP process), but the same *capability* Shodan's
MCP server exposes (host lookup, DNS resolve, ports/services/vulns),
delivered through Shodan's REST API and folded into the pipeline as
context every phase can use.

- **The knob** (`src/settings.js`): a second key alongside `server_history`
  in the same `users.settings_json` column. **Default OFF** (only an
  explicit stored `true` enables it — the mirror of `server_history`'s
  default-on/explicit-false) because enriching a query sends the host/IP
  to a third party, an opt-in a security-minded user should choose
  deliberately. `/api/settings` reports the EFFECTIVE state: it reads off
  unless the `SHODAN_API_KEY` secret is set AND the caller has a real D1
  user row (break-glass has none), via `featureAvailability()` (kept
  separate from `storageAvailability()` so that function's tested
  `{storage, rag}` shape stays stable). `shodanEnabled(env, identity)` is
  the gate `chat.js` consults.
- **`SHODAN_API_KEY`** is a dashboard secret, same as Berget/Exa — never
  in the repo. Absent, the feature is invisible: `/api/settings` reports
  it unavailable and the UI hides the knob (exactly like the storage
  bindings). No `wrangler.toml` binding is needed (it's a secret, not a
  resource binding).
- **Deterministic target extraction** (`src/shodan.js`'s `extractTargets`,
  pure + unit-tested): pulls publicly-routable IPv4s and plausible
  hostnames from the latest user message. De-noised — private/loopback/
  link-local/multicast/CGNAT/reserved IPs, out-of-range octets, file names
  that look like domains (`report.pdf`), and email-address domains are all
  excluded; deduped and capped (≤4 IPs, ≤4 hostnames, ≤6 unique IPs
  actually looked up).
- **Lookup** (`runShodanLookup`): batch-resolves hostnames via `/dns/resolve`
  (no query credits), then `/shodan/host/{ip}` per unique IP. The payload
  is summarized to a bounded subset (≤24 ports, ≤10 distinct services,
  ≤15 CVEs) — open ports, running services, org/ISP/ASN, OS, location,
  known CVEs, last-seen date. `vulns` arrives as either an array or a
  CVE-keyed object; both are handled. Each host carries its citable
  `https://www.shodan.io/host/{ip}` URL.
- **Pipeline wiring** (`src/pipeline.js`'s `runShodanEnrichment`): runs
  BEFORE any model call so triage/search/synthesis all see the data, and
  appends it as one labeled "Shodan host intelligence" context block to
  the conversation (`withAppendedText`, the SAME convention as the
  geocoder's resolved-location block and the client's metadata blocks —
  never blended into the user's text). Emits a visible activity step
  (`step`/`stepDone` with an expandable per-host details list) — but ONLY
  when the message actually names a host, so an ordinary question with the
  knob left on costs nothing and shows no spurious step. `state.shodanCount`
  (hosts found) rides into the `chat.complete` log.
- **Runs independent of the web-search toggle** — like the geocoder, this
  resolves data about a host the message *names*, not a topic to research,
  so it isn't gated behind the Exa privacy toggle. It has its own knob.
- **Fails soft in every branch**: no key, no targets, a bad host, a
  timeout (8s) or a 404 (host simply not in Shodan's DB) all degrade to
  the conversation unchanged (or an honest "no Shodan records" note so the
  model doesn't invent infrastructure) — never a blocked or delayed chat.
- **Minimal outbound request**: only the IP/hostname crosses the wire to
  Shodan — never the user's question, filename, or any account/session
  identifier. Server-side only (Worker-mediated, logged, timeout-bounded),
  the key never reaches the browser.

## Google Maps — the opt-in `google_maps` knob (default OFF)

An opt-in per-user setting (account panel's **Settings** sub-view, "Google
Maps & Street View") that enriches a research question with Google Maps
Platform data whenever the question names a street address, or an attached
photo carries GPS. It was added because the site kept (correctly) replying
that it "can't access Street View" even though a `GOOGLE_MAPS_API_KEY` was
configured — the key had no code behind it. Wired the same deterministic,
no-function-calling way as the reverse-geocoder and Shodan: the location is
extracted deterministically, three Maps Platform APIs (sharing the one key)
are called server-side, and the result is folded into the conversation as one
labeled `--- Google Maps ---` block every phase can reason and search with.
`src/googlemaps.js` is the client; `src/pipeline.js`'s `runGoogleMapsEnrichment`
wires it (before any model call, alongside the Shodan enrichment).

- **The knob** (`src/settings.js`): a third key alongside `server_history`
  and `shodan_mcp` in `users.settings_json`. **Default OFF** (only an explicit
  stored `true` enables it — the mirror of `shodan_mcp`) because a lookup
  sends the address/coordinates to a third party and the imagery fetches are
  billed. `/api/settings` reports the EFFECTIVE state via `featureAvailability`:
  off unless the `GOOGLE_MAPS_API_KEY` secret is set AND the caller has a real
  D1 user row. `googleMapsEnabled(env, identity)` is the gate `chat.js`
  consults. Absent the secret, the feature is invisible (the UI hides the knob),
  exactly like Shodan.
- **`GOOGLE_MAPS_API_KEY`** is a dashboard secret (never in the repo), used
  SERVER-side only. It needs these Google Cloud APIs enabled: **Places API**
  (`places.googleapis.com`), **Maps Static API**
  (`static-maps-backend.googleapis.com`) and **Street View Static API**
  (`street-view-image-backend.googleapis.com`).
- **`GOOGLE_MAPS_EMBED_KEY`** is an OPTIONAL dashboard secret for the inline
  interactive Street View iframe. It is intentionally exposed to the browser
  (via `/api/settings`), so it MUST be HTTP-referrer-restricted to the site.
  **It defaults to `GOOGLE_MAPS_API_KEY` when unset** (`googleMapsEmbedKey`) —
  fine as long as that key is itself referrer-locked to `*.deepresearch.se/*`
  (it is), which is the mitigation for browser exposure. Set a dedicated
  Embed-API-only key only if you want to narrow the browser-exposed key's
  scope. Either way the inline navigable embed then works; with neither key
  (no Maps configured at all) only the keyless link shows.
- **Deterministic location extraction** (`src/googlemaps.js`'s `extractPlace`,
  pure + unit-tested): parses a single geocodable street-address candidate out
  of the latest message (a "<words> <number>" span whose word before the number
  is a known Swedish street morpheme — …vägen/…gatan — or an exact English
  street word — Street/Road/Avenue). Leading filler is trimmed to Capitalized
  locality words, so "what's at Maskinistvägen 11" → "Maskinistvägen 11". A
  photo's validated GPS coordinates (`body.imageLocations`) take precedence over
  a parsed address (`pickLookup`).
- **Lookup** (`runGoogleMapsLookup`): Places Text Search canonicalises the
  address (display name, formatted address, primary type, rating, business
  status, precise coordinates); the coordinates then key the FREE Street View
  metadata check (coverage + capture date) and the billed imagery: **four
  Street View frames at the cardinal headings** (0/90/180/270°, a full look
  around the spot — façade/neighbours/across-the-street, not one fixed frame)
  plus a Static Map road image (all JPEG, 512px frames / 600×400 map). It
  returns the raw resolved data; the pipeline builds the block. The block
  carries keyless Google Maps / Street View links the user can open.
  `state.mapsCount` rides into the `chat.complete` log.
- **Vision-describe, never attach** (`pipeline.js`'s `describeStreetView`): the
  frames are NOT attached to the answer model — a report showed several frames
  on one message making the answer call fail with a Berget 400. Instead the
  frames (capped at `MAX_MAPS_IMAGES` = 4, the client's own per-message cap) are
  run through a vision *helper* model (`state.visionModel` — the user's model if
  it's vision, else the first `vision && up` catalog model; resolved in
  `chat.js`) which returns a short factual description injected into the block as
  TEXT. So the answer call is always image-free (can't fail from maps imagery),
  and "describe this Street View" works regardless of the answer model's own
  vision capability — including the DEFAULT non-vision Mistral Small. The
  helper's tokens go to `state.visionTotals`, billed at that model's own catalog
  rate (the same split-billing pattern as `jsonTotals`). Fully fail-soft: no
  vision model / a failed call → the block just points at the keyless link. The
  block ALSO always tells the model Maps is already enabled, so an
  empty-or-imageless result never makes it hand the user bogus "enable it in
  Settings" steps.
- **Inline interactive embed** (the `streetview_embed` SSE event): when Street
  View coverage exists AND a **`GOOGLE_MAPS_EMBED_KEY`** is configured, the
  pipeline emits the pano coordinates and the client renders a navigable Maps
  Embed API iframe beside the answer (`public/js/activity.js`'s
  `renderStreetViewEmbed`, styled in `app.css`). This key is SEPARATE from the
  server `GOOGLE_MAPS_API_KEY` and is deliberately **browser-exposed** —
  `googleMapsEmbedKey(env)` surfaces it in the `/api/settings` payload
  (`maps_embed_key`, only when the caller can use Maps), and the client holds
  it (`public/js/settings.js`'s `mapsEmbedKey()`). Because it's public it MUST
  be locked to the site's HTTP referrer and restricted to the **Maps Embed
  API** only in the Google Cloud console; the powerful server key never reaches
  the browser. Unset → no inline embed, just the keyless link. The embed is
  live-session only (a reloaded conversation keeps the answer + link, not the
  iframe — same as the step traces).
- **Runs independent of the web-search toggle** — like the geocoder and Shodan,
  it resolves a location the message *names*, not a topic to research.
- **Fails soft in every branch**: no key, no address/photo, a Places miss with
  no Street View coverage (a false-positive address), a timeout or API error
  all degrade to the conversation unchanged (no spurious step for an ordinary
  question — the step shows only once a real location is being checked).
- **Minimal outbound request**: only the address (or a photo's coordinates)
  crosses the wire to Google — never the user's whole question, filename, or any
  account/session identifier. Server-side only; the API key is used solely for
  the internal fetches and never appears in a log, a context block, or the
  citable links (those are Google's keyless Maps URLs).
