---
name: integrations
description: >-
  Load when integrating or modifying an external data source — Berget the
  primary LLM provider (src/berget.js), Anthropic and OpenAI the secondary
  LLM providers (src/anthropic.js, src/openai.js, dispatched via the
  src/providers.js registry), Exa web search (src/exa.js), OpenStreetMap
  Nominatim reverse geocoding (src/geocode.js), Shodan host intelligence
  (src/shodan.js), Google Maps / Street View (src/googlemaps.js), or
  Hugging Face Hub search (src/hf.js) — or adding a new enrichment in the
  same deterministic no-function-calling pattern.
---

# External providers & the enrichment pattern

## LLM provider — Berget.ai (primary)

**Berget.ai is the primary LLM provider** — the default model, the JSON
planning phases, and embeddings all run here. Berget exposes an
OpenAI-compatible API at `https://api.berget.ai/v1`. (Anthropic and
OpenAI are secondary, key-gated providers for answer models — see the
next two sections.)

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

## LLM provider — Anthropic (Claude), second provider

Added 2026-07-09 (`src/anthropic.js` + the provider registry
`src/providers.js`). Full playbook + contracts: the **add-llm-provider**
skill; per-model tuning and the first eval battery: the
**tune-provider-models** skill.

- **Auth:** the `ANTHROPIC_API_KEY` dashboard secret, sent as `x-api-key`
  with `anthropic-version: 2023-06-01`. Never in the repo. Absent, the
  feature is invisible: the claude-* models don't appear in `/api/models`
  and nothing routes to Anthropic.
- **Endpoint:** `POST https://api.anthropic.com/v1/messages` (raw fetch, no
  SDK — no build step / no runtime deps). `ANTHROPIC_URL` is the test-only
  mock override, mirroring `BERGET_URL`.
- **Models (static catalog, a product choice):** `claude-opus-4-8`,
  `claude-sonnet-5`, `claude-haiku-4-5` — all vision-capable, priced in
  the catalog as EUR-per-token (converted from USD at the fixed rate
  documented in anthropic.js) so quota cost accounting works unchanged.
- **Routing:** by model-id namespace — `claude-*` dispatches to Anthropic
  via the `SECONDARY_PROVIDERS` registry, everything unmatched to Berget
  (`src/providers.js`). The JSON planning phases ALWAYS stay on Berget's
  `DEFAULT_MODEL` (split model routing, CLAUDE.md invariant 3); Anthropic
  only serves synthesis/direct answers (and can be drafted as a
  vision-describe helper, since its models are `vision && up`).
- **Stream shape:** Anthropic SSE (message_start / content_block_delta /
  message_delta / message_stop) is adapted on the fly into OpenAI-style SSE
  (`openAiStreamFromAnthropic`), so `consumeChatStream`, the idle/total
  guards, the finish_reason dropped-connection check, STREAM_MAX_CHARS, and
  the pipeline's failover/retry machinery all apply to Claude streams
  unchanged. Stop reasons map end_turn→stop, max_tokens→length.
- **Thinking:** Sonnet 5 runs adaptive thinking when the param is omitted —
  explicitly disabled in the payload builder (hidden token spend inside
  max_tokens + a silent pre-answer pause vs the 60s idle guard). Opus 4.8 /
  Haiku 4.5 default to no thinking (param omitted). Revisit with a bench A/B.
- **Privacy note:** like Berget, Anthropic is an LLM provider — the
  conversation itself goes there when a Claude model is selected. This is
  the user's explicit model choice in the dropdown, not an enrichment.

## LLM provider — OpenAI (GPT), third provider

Added 2026-07-09, same day as Anthropic (`src/openai.js` + a
`SECONDARY_PROVIDERS` registry entry in `src/providers.js`). The
already-OpenAI-shaped worked example in the **add-llm-provider** skill;
tuning: **tune-provider-models**.

- **Auth:** the `OPENAI_API_KEY` dashboard secret, sent as
  `Authorization: Bearer`. Never in the repo. Absent, the feature is
  invisible: the gpt-* models don't appear in `/api/models` and nothing
  routes to OpenAI.
- **Endpoint:** `POST https://api.openai.com/v1/chat/completions` (raw
  fetch, no SDK). `OPENAI_URL` is the test-only mock override, mirroring
  `BERGET_URL`/`ANTHROPIC_URL`.
- **Models (static catalog, a product choice):** the mainstream GPT
  lineup as of 2026-07 — `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
  (the three current flagship tiers) and `gpt-5.4-mini` (the compact
  model) — all vision-capable, EUR-priced in the catalog via berget.js's
  shared `eurPerTokenFromUsd` fixed-rate conversion.
- **Routing:** bare `gpt-*` ids dispatch to OpenAI. **Watch the
  lookalike:** Berget hosts `openai/gpt-oss-120b` — a vendor-PATH id
  that stays on Berget; the predicate matches the bare prefix only. The
  JSON planning phases ALWAYS stay on Berget's `DEFAULT_MODEL`
  (invariant 3); OpenAI only serves synthesis/direct answers (and can be
  drafted as a vision-describe helper).
- **Stream shape:** NO adapter — OpenAI's Chat Completions SSE is the
  native wire format `consumeChatStream` parses, so the raw Response
  passes through and all the shared guards apply unchanged. The wire
  PARAMS differ instead (`toOpenAiPayload`): `max_completion_tokens`
  (GPT-5-era models reject the legacy `max_tokens`), `stream_options:
  {include_usage: true}` (or no usage chunk arrives), `response_format:
  json_object` on the JSON path.
- **Reasoning:** every catalog GPT model is a reasoning model —
  `reasoning_effort` is pinned to `"none"` (hidden token spend inside
  max_completion_tokens + a silent pre-answer pause vs the budget
  planner and the 60s idle guard; the exact same tradeoff as Sonnet 5's
  adaptive thinking). Revisit with a bench A/B.
- **Privacy note:** like Berget/Anthropic, the conversation itself goes
  to OpenAI when a GPT model is selected — the user's explicit dropdown
  choice, not an enrichment.

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

- **The knob** (`src/settings.js`): a key in the `users.settings_json`
  column. **Default OFF** (only an
  explicit stored `true` enables it) because enriching a query sends the host/IP
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
`src/googlemaps.js` is the client (REST calls, edge-cached lookup
orchestration, block builders); the pure text analysis — address/place
extraction, the intent gates, `pickLookup` — lives in `src/googlemaps-text.js`;
`src/enrichment.js`'s `runGoogleMapsEnrichment` wires it (before any model
call, alongside the Shodan enrichment).

- **The knob** (`src/settings.js`): a key alongside
  `shodan_mcp` in `users.settings_json`. **Default OFF** (only an explicit
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
  interactive Street View. It is intentionally exposed to the browser
  (via `/api/settings`), so it MUST be HTTP-referrer-restricted to the site.
  **It defaults to `GOOGLE_MAPS_API_KEY` when unset** (`googleMapsEmbedKey`) —
  fine as long as that key is itself referrer-locked to `*.deepresearch.se/*`
  (it is), which is the mitigation for browser exposure. With neither key
  (no Maps configured at all) only the keyless link shows. **The browser key
  should additionally have the Maps JavaScript API enabled**
  (`maps-backend.googleapis.com` in the Cloud console): the inline view is a
  real `StreetViewPanorama` from the Maps JS SDK (needed to read where the
  user pans — see the POV capture below), billed as a Dynamic Street View
  load (~$14/1k vs the Embed iframe's free). If the key can't load the SDK
  (e.g. a dedicated key restricted to the Embed API only), the client falls
  back to the old Embed iframe automatically — still navigable, but the
  current-view capture is unavailable and follow-ups use the cardinal-frames
  walk-back instead. NOTE the SDK script can load fine and STILL be rejected
  asynchronously (ApiNotActivatedMapError etc.) — Google then paints a
  "Sorry! Something went wrong." panel INTO the container and calls the
  global `gm_authFailure` hook; `activity.js` hooks it, swaps every live
  panorama for the iframe, drops the dead POV, and routes future renders
  straight to the iframe (observed live 2026-07 before the JS API was
  enabled on the key).
- **Deterministic location extraction** (`src/googlemaps-text.js`'s `extractPlace`,
  pure + unit-tested): parses a single geocodable street-address candidate out
  of the latest message (a "<words> <number>" span whose word before the number
  is a known Swedish street morpheme — …vägen/…gatan — or an exact English
  street word — Street/Road/Avenue). Leading filler is trimmed to Capitalized
  locality words, so "what's at Maskinistvägen 11" → "Maskinistvägen 11". A
  trailing locality is kept in ALL its shapes — connector ("in järfälla"),
  Capitalized bare, and bare LOWERCASE ("streetview lidbecksgatan 10
  hallstahammar", reported 2026-07-08: dropping it resolved the wrong city's
  Lidbecksgatan and the model asked which city the user meant — one they had
  explicitly named). `displayQuery` prefers the FORMATTED address (with city)
  so a wrong-city hit is visible in the frames title and block. A
  photo's validated GPS coordinates (`body.imageLocations`) take precedence over
  a parsed address (`pickLookup`).
- **Named-place street-view asks resolve via Places free-text search**
  (`extractPlaceQuery` + `streetViewIntent`, pure + unit-tested). Reported
  verbatim 2026-07-08: "Street view of LEGO offices in Copenhagen" fired
  nothing (no street address to parse) and the model invented "enable
  Google Maps in Settings" instructions at a knob-ON user. An EXPLICIT
  street-view ask ("street view"/"gatuvy") with no parseable address now
  sends the remainder (leading filler trimmed, trailing lowercase clause
  cut) to Places as a free-text query — "LEGO offices in Copenhagen",
  "Turning Torso i Malmö" — outranking corrections/POV/walk-back like a
  new address does. An explicit ask that resolves to NOTHING appends
  `unresolvedMapsBlock()` (feature is ON, ask which place, never give
  enable instructions) so a silent miss can't produce bogus setup steps.
- **Fragment answers & typo-tolerant intent** (`matchAddressFragment`,
  typo-set `streetViewIntent`, pure + unit-tested). Reported verbatim
  2026-07-08: assistant research listed three Accenture offices; "Streer
  view" (typo) missed the exact-match intent regex, and the user's
  clarify-answer "Alstromer" (no diacritics, no suffix) matched nothing —
  endless re-clarify. Intent is now an enumerated misspelling set
  (streer/stret/steet/veiw/gatvy…), and a short fragment answering the
  model's own "which office?" is matched diacritics-insensitively against
  every address the CONVERSATION surfaced — assistant answers included
  (numbered addresses only there, for precision). Unique hit → lookup;
  ambiguous → the clarify continues honestly. A bare "street view" with
  exactly ONE assistant-surfaced address uses it outright.
- **Locality corrections re-run the lookup in the corrected city**
  (`extractLocalityFix` + `withLocalityFix`, pure + unit-tested). Reported
  verbatim 2026-07-08: "Street view lidbecksgatan 10" resolved the wrong
  city; "I meant in hallstahammar!" got only a clarify; a later "street
  view" walked back to the bare street and showed the wrong city AGAIN —
  no single message carried street + corrected city together. A strong
  correction cue (meant/instead/rather, menade/istället/snarare) or a bare
  "in X"/"i X" message extracts a locality fix; the fix outranks the POV
  (the on-screen panorama shows the wrong place by definition), merges
  onto the walked-back street (replacing any earlier comma-locality), and
  rides along later walk-backs so follow-ups stay in the corrected city.
- **Follow-up questions re-snap the current imagery** (`pickLookup`'s
  walk-back + `referencesStreetView`, both pure + unit-tested). The server is
  stateless and the Maps block is appended per-request only, so a follow-up
  turn ("what color is the roof?") used to carry no address → no enrichment →
  the model truthfully claimed it had no knowledge of any image (reported
  bug). Now, when the latest message names nothing but *references the
  imagery/place* (a deterministic EN+SV vocabulary gate: image/photo/roof/
  façade/color/floors/bilden/huset/taket/färg/våningar/"ser det ut"…),
  `pickLookup` walks back through earlier user turns for the most recent
  address and re-runs the full lookup on it (`followUp: true` rides along so
  the block says the CURRENT imagery was re-fetched and re-examined for this
  question). The gate keeps ordinary follow-ups ("summarize the sources")
  from re-billing Google; a false negative degrades to the old behavior.
- **The user's CURRENT panorama view is captured on follow-ups** (the POV
  path). The inline panorama is the Maps JS SDK's `StreetViewPanorama`, and
  the client tracks every pan/move/pano-jump (`activity.js`: pano id,
  lat/lng, heading, pitch, zoom→fov) and sends the latest view as
  `body.street_view_pov` with every following query (`stream.js`; reset on
  new chat / conversation switch). Server-side it's sanitized by
  `validateStreetViewPov` (heading wrapped, pitch/fov clamped, pano id
  pattern-checked) and, when a follow-up passes the same
  `referencesStreetView` gate, `pickLookup` prefers the POV over the
  address walk-back: `runStreetViewPovCapture` fetches ONE Street View
  Static frame at exactly that pano/heading/pitch/fov (metadata check for
  the capture date is free; the frame is cached like the address lookup),
  the vision helper answers the question about THAT frame, and
  `buildPovBlock` tells the model it is the user's currently visible view.
  The reply gets a FRESH interactive panorama, not the static capture: the
  POV path emits `streetview_embed` at the captured lat/lng/heading/pitch
  (2026-07-09 report: showing the stale frame froze the user at a view
  they'd navigated away from), so the new turn renders a continue-from-here
  panorama; the captured frame (`streetview_frames`, "your current view")
  is emitted only when no embed key exists and the client can't build a
  panorama. `buildPovBlock` also ALWAYS instructs the answer to include a
  markdown Map link at the CURRENT coordinates (same report: the user has
  moved, so links given for the original address no longer point at where
  they are). A NEW address in the message still beats the POV (it's a
  new location); no POV (iframe fallback) degrades to the walk-back.
  The POV path uses a LOOSE gate (`referencesStreetViewScene`), grown in
  four reported rounds: scene contents (people, vehicles, signs, shops —
  "Describe the person" missed the strict gate and the model asked "what
  person?"), then STRUCTURAL classes when noun vocabulary kept leaking
  (Workers Logs 2026-07-08 ~13:22Z: 4 of 5 panorama follow-ups fired
  nothing): bare deictics (that/this/it/det/den/där…), positional phrasing
  (left/behind/across/vänster/bakom…), and visual-act verbs
  (describe/read/zoom/beskriv/läs…), EN+SV — then asking the ASSISTANT what
  it sees (2026-07-09 verbatim: "What do you see" / "vad ser du" both got a
  no-image denial mid-panorama): the full phrasings ("what do you see",
  "vad ser du/ni", "vad kan du se") sit in the STRICT gate so they work
  even without a live POV, looser forms ("do you see…?", "ser du…?",
  "kan du se…?") in the scene gate — then temporal CONTINUATIONS
  (2026-07-09 verbatim: "And now" after panning fired nothing and the
  model invented a scene): now/again/nu/igen in the scene gate. Over-firing
  is deliberate and
  cheap (one cached frame); the POV block's instruction is CONDITIONAL
  ("if the question refers to something visible… otherwise answer normally
  and ignore this block") so an unrelated question isn't misdirected. The
  walk-back keeps the strict gate — it re-runs a full billed lookup. Both
  blocks also instruct the model to NEVER ask the user to disambiguate the
  resolved location or clarify who/what they mean in the current view.
  ONLY the latest panorama is live: rendering a new `streetview_embed`
  locks the previous one client-side (`activity.js` `lockActiveEmbed` —
  pointer events off, dimmed, "earlier view (locked)" label, POV recording
  stopped; `.streetview-embed.locked` in `app.css`), so the "current view"
  sent with follow-ups can only ever come from the one navigable panorama
  (2026-07-09 report: with several live panoramas, reasoning had to apply
  to the last view in sight only). The lock slot resets with the POV on
  new chat / conversation switch; a reloaded conversation re-locks all but
  its last embed naturally (embeds render in order).
- **The vision helper answers the user's question**, not just a generic
  describe: `describeStreetView` gets the latest question (bounded, appended
  client blocks stripped) and is instructed to answer it strictly from what
  is visible in the frames first, then describe — so a follow-up reasons
  about that particular image instead of replaying a canned description.
- **Cross-request lookup cache** (`runGoogleMapsLookup`, same pattern as
  `src/exa.js`'s search cache — both go through the shared fail-soft helpers
  in `src/edge-cache.js`): successful lookups — imagery data URLs
  included — are cached in `caches.default` for 10 min, keyed by the
  normalized target + whether imagery was fetched, so a follow-up exchange
  about the same place re-bills Google nothing. Fail-soft in every branch;
  null results stay uncached so a retry can still find something. Verify live
  via `googlemaps.cache_hit` / `cache_write_failed` log events.
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
- **The panorama search radius is 150m, not Google's 50m default**
  (`STREETVIEW_SEARCH_RADIUS_M`; reported 2026-07-09, "Street view
  basaltvägen 1 enköping", ref cac5c445): Places often returns a rooftop/
  parcel coordinate set back from the road, and the metadata check at
  Google's default 50m then returns ZERO_RESULTS — no imagery — while the
  street outside has coverage. Address lookups pass `radius=150` +
  `source=outdoor` (a business's indoor photosphere must not outrank the
  street); the frame fetches then pin the metadata's `pano_id`, and the
  embed + keyless Street View link center on the panorama's OWN
  `location` — the image API and the client's `StreetViewPanorama` search
  only 50m themselves, so centering them on the resolved address would
  re-miss the very pano the metadata found.
- **Genuinely no coverage degrades honestly, and fabricated image URLs are
  banned** (same report): with no panorama, the road map is still shown to
  the user (a `streetview_frames` event with an honest `title` — "Map — …
  (no Street View here)"; the client prefers `s.title` over its built
  "Street View — …" header), the vision-helper intro and the block label
  the description as a MAP (`describedMapOnly`/`mapShown` parts), and the
  block says plainly no Street View exists there. A no-coverage lookup
  ALSO gets an interactive map: the `map_embed` SSE event (emitted when no
  `streetview_embed` fires and the embed key exists — see the
  **sse-protocol** skill) renders a navigable Maps JS SDK map with a
  marker beside the answer, and the block instructs the answer to ALWAYS
  include the keyless Map link as a markdown link (requested 2026-07-09 —
  the first no-coverage answers carried no link).
- **Street View JUMPS — "street view here" and relative moves** (requested
  2026-07-09): deterministic phrase parsing pops a panorama at the user's
  current position or at a computed destination, no model in the loop.
  `googlemaps-text.js`: `streetViewHereIntent` (explicit street-view word +
  here-word — "street view here", "popup street view at my current
  location", "gatuvy här", "där jag är"), `extractRelativeMove` (distance
  regex + direction: facing-relative "along this road"/"ahead"/"framåt"
  words need no verb; bare compass moves — "100 m norrut" — need a move
  verb OR a ≤6-word message so prose like "the shop is 100 meters north of
  the station" never jumps; distances clamp 5–3000m, km supported; the
  move/direction words carry an enumerated TYPO set + diacritic-less
  Swedish — "Forwsrd 200m" reported verbatim 2026-07-09: it fired nothing
  one turn after a successful "Forward 100m" and the model asked for GPS
  mid-panorama — foward/forwsrd/ahed, framat/langre fram/soderut/vasterut,
  same convention as the street-view word), and
  `movePoint` (equirectangular destination math). `pickLookup` checks
  jumps between the address extract and the free-text place query (so "at
  my current location" is never sent to Places as a place name), anchored
  to the live panorama (position + heading — "along this road" uses the
  facing, "back" flips it), else the live map center (compass moves only),
  else `body.user_location` — the device's browser geolocation, which
  `stream.js` requests ONLY when the conversation matches the client-side
  `asksDeviceLocation` prefilter (`message-content.js`) and no live view
  exists, so the permission prompt fires for exactly these asks; validated
  server-side by `validateMapView`. **Here-asks span TURNS and include a
  plain "where am I"** (reported verbatim 2026-07-09: "Where am i now" →
  "Street view" → "My location" produced three denials — every gate wanted
  street-view word + here-word in ONE message): `whereAmIIntent` (EN typo
  set + SV parity — "var är jag", "vart är vi", "var befinner jag mig" —
  with an end-of-clause guard so "where are we going with this" never
  fires) and `hereFragmentAnswer` (a ≤4-word here-phrase — "My location",
  "här", "min plats" — answering an earlier street-view turn; the
  here-sibling of the address-fragment clarify answers) both count as
  here-asks in `pickLookup`'s jump gate, and the client prefilter therefore
  scans ALL user turns, not just the latest. `hereAskIntent(conversation)`
  is the exported conversation-level gate `enrichment.js` uses so a
  here-ask arriving with NO device location gets the "allow location
  access" unresolved note (never "which address?", never invented
  enable-in-Settings steps). **Anchor precedence: the live view wins;
  the device only comes back on an explicit physical-location ask**
  (requested 2026-07-09): once a panorama/map is live, moves and
  here-asks continue from IT — the device location is only the anchor
  again when the message says so (`physicalLocationAsk`: "my actual/real
  location", "where I actually am", "min faktiska plats", "där jag
  faktiskt är"), which flips pickLookup's anchor order AND makes the
  client request geolocation even while a live view exists
  (`asksPhysicalLocation`, consulted outside the no-live-view guard).
  `runJumpEnrichment` finds the nearest
  panorama (150m search), captures one frame facing the travel bearing
  (cached via the POV capture), vision-describes it, emits a fresh
  `streetview_embed` at the destination (locking superseded embeds), and
  appends `buildJumpBlock` (destination + links + Map-link mandate +
  never-fabricate) — which also carries a **Nominatim reverse-geocoded
  place name** (free, fail-soft, fetched in parallel with the pano
  search): the actual answer to "where am I?", not just coordinates. No
  panorama near the destination → an interactive `map_embed` of it plus an
  honest block — never an invented view.
- **NEARBY-place asks search Places, they don't stare at the frame**
  (reported verbatim 2026-07-09: mid-panorama, "Gas station near e18
  there" routed to the POV capture via the deictic "there", and the model
  could only say no gas station was visible in the current view). A
  place-TYPE word (PLACE_TYPE_RE — extended with the errand amenities:
  gas/petrol station, pharmacy, ATM, parking, hospital…, Swedish parity
  incl. "mack") plus a NEARBY word (near/nearest/i närheten/närmaste —
  "here"/"there" count ONLY because the type word is also required) is a
  SEARCH ask: `extractNearbyPlaceQuery` (googlemaps-text.js) builds the
  Places query (leading "is there a"/"finns det" filler and trailing
  deictics stripped), pickLookup returns a `nearby` target anchored at
  the live view (or device location — the client's `asksNearbyPlace`
  prefilter requests geolocation for fresh-chat nearby asks), checked
  BEFORE the here-ask and POV branches so "gas station here" searches
  rather than jumps. `runNearbyPlaceEnrichment` calls
  `placesNearbySearch` — Places API (New) searchText with a 5km
  `locationBias` circle (bias, not restriction), max 3 results, same
  minimal field mask — and shows the BEST hit like a jump destination
  (nearest panorama + described frame + fresh embed; map embed when no
  coverage). `buildNearbyPlacesBlock` lists the hits with computed
  distances (`distanceMeters`), keyless links, and the usual mandates
  (top-link markdown mandate, never invent a place on zero hits, no
  enable-steps, no fabricated URLs). Fail-soft in every branch; no
  anchor → ordinary pipeline (web search) handles the question.
  **Answer MODES (`nearbyAskMode`, user-refined semantics, same day)**:
  "instant" (teleport/jump verbs) DROPS at the destination — no route
  map, no start narrative, brief landed-here framing; "travel" (go/get/
  take-me/walk-to verbs) does the ACTUAL travel — start reverse-geocoded
  and narrated, photo waypoints along the way (start + a midpoint when
  >400m, each snapped to the nearest pano facing `bearingDeg` toward the
  destination), the waypoint route map (1 = user, 2 = destination —
  `routeMapImage`); "search" (no relocation verb) is informational —
  results + destination view + route map + the where-you-are opener.
  ALL modes carry the never-disclaim note ("NEVER say you cannot
  teleport… the views beside this reply are the relocation") — the model
  had answered a working teleport with "Note: I can't actually
  'teleport' you".
- **Relocation to a NAME + the pending-relocation memory (2026-07-09
  refactor)**: "Go to hemköp" (a relocation verb aimed at a brand/name —
  no place-TYPE word, no address) is `extractRelocationQuery` — the
  message must BEGIN with the verb phrase (so prose never fires), the
  remainder is ≤4 words with an idiom exclusion set ("go to sleep", "gå
  till jobbet") — and routes through the same nearby/Places machinery
  with its mode. And the conversation REMEMBERS an unfinished relocation:
  `pendingRelocation(users)` recovers the most recent relocation/nearby
  ask from the last ~6 user turns, so a short fragment answering the
  clarify ("Stäket" after "Go to hemköp" listed two stores) resolves as
  one combined Places search ("hemköp Stäket"), inheriting the pending
  mode — previously both fell into the web-research pipeline with more
  cannot-move-you disclaimers.
- **Openers, superlatives, go-there, and the ROUTE (2026-07-09, the
  "Legs go to coop" session)**: relocation asks take let's-openers incl.
  the adjacent-key typo ("Lets/Let's/Legs go to coop") and "ok"; a
  SUPERLATIVE + short NAME is a nearby search without a type word
  ("nearest coop", "närmaste willys" — typo forms included); library/
  bibliotek joined the place types; "Go there" (typo "Co there") RESUMES
  pendingRelocation as travel. Travel mode now goes STEP BY STEP over
  Street View: computeWalkingRoute requests the Routes API's
  `routes.polyline.encodedPolyline`, `decodePolyline` (pure, tested
  against Google's reference vector) turns it into the road path,
  `samplePolyline` places up to 4 photo waypoints along it (one per
  ~fifth of the trip, each snapped to the nearest pano facing the NEXT
  waypoint, consecutive same-pano samples collapsed), and
  `routeMapImage(points, pathPoints)` draws the REAL road path behind
  the numbered stops. The nearby block reports the walking
  distance/time. ROUTING IS OBSERVABLE: pickLookup tags the winning
  matcher on the target (non-enumerable `intent`), maps-enrichment logs
  `maps.intent` to Workers Logs and puts it in state.mapsIntent, and
  chat.js writes it into the chat_logs meta (`maps_intent`) — so
  scripts/chatlogs answers "how did routing go?" per exchange, including
  "none" for misses.
- **The maps subsystem's module seams (2026-07-09 refactor)**:
  `googlemaps-text.js` decides WHAT is being asked — `pickLookup` is now
  an ORDERED registry of small named matchers (LOOKUP_MATCHERS; the order
  is the spec, one matcher per ask shape) over one shared context, plus
  the pure conversation-state recovery (pendingRelocation,
  extractJourneyPoints). `googlemaps.js` talks to Google (REST clients,
  edge cache, pure block builders). `maps-enrichment.js` (split out of
  enrichment.js) orchestrates one resolved target into a reply — one
  runner per target shape, dispatched by `runGoogleMapsEnrichment`;
  enrichment.js keeps the registry + Shodan. Adding an ask shape = one
  extractor + one matcher + (usually) one runner branch.
- **"Jump"/"teleport" mean INSTANT relocation, and barriers can be
  crossed** (user's explicitly stated semantics, 2026-07-09, after "Get to
  the other side of the railway" — twice — drew a real-world safety
  lecture: "never cross the tracks directly", at a user navigating a
  PANORAMA). Two additions:
  - **Teleport-to-place**: relocation verbs (`TELEPORT_VERB_RE` jump/
    teleport/hoppa/teleportera + `TRAVEL_TO_RE` get/take me/ta mig …
    to/till/över) count as the nearby-word trigger, so "teleport to the
    gas station" / "ta mig till närmaste mack" resolves through the
    nearby-place Places search and relocates to the top hit — no
    pathfinding, exactly as asked. `TELEPORT_LEAD_RE` strips the verb
    phrase from the query (word-boundary lookaheads are load-bearing:
    the diacritic-less Swedish verb "ga" once ate the start of "Gas
    station…").
  - **Cross-barrier relocation** (`extractCrossBarrierAsk` → pickLookup's
    `crossBarrier` target → `runCrossBarrierEnrichment`): "the other side
    of the railway/river/road…" (EN + SV: "andra sidan järnvägen", "hoppa
    över spåret"; verb-less phrasings must be ≤8-word commands so prose
    about a river's far side never fires). The trick is that Street View
    covers ROADS: `runBarrierCrossing` probes FREE metadata along the
    travel bearing (concurrent ray of 40m steps to 640m, 30m tight
    radius; panorama heading first with ±45° fallbacks, else the four
    cardinals) for a coverage GAP followed by renewed coverage — the
    renewed pano IS the other side. The crossing is documented with a
    PHOTO SERIES (start → just before the barrier → the other side, one
    `streetview_frames` strip with labels), plus the usual destination
    treatment (reverse geocode, vision describe, fresh embed).
    `buildCrossBarrierBlock`'s load-bearing line tells the model this is
    VIRTUAL navigation — no real-world safety/route guidance. Fail-soft:
    no gap-then-coverage found → honest block + map embed, never an
    invented view.
- **The journey view — "show how we traveled"** (requested 2026-07-09,
  after the model answered it with a coordinate list and a "no verified
  route" disclaimer). The waypoints ARE recoverable deterministically:
  every Maps block MANDATES keyless coordinate links into the answers, so
  `extractJourneyPoints` (googlemaps-text.js) parses `query=`/`viewpoint=`
  links and embed-ref lines from the ASSISTANT turns (user-quoted coords
  never count), collapsing same-position duplicates (<20m), capped to the
  last 12 stops. `journeyAsk` is the gate (EN + SV: "show how we
  traveled", "visa rutten", "hur kom vi hit") — needs NO anchor, ≥2 stops.
  `runJourneyEnrichment` renders it three ways at once: a Static Maps
  ROUTE IMAGE (numbered markers + path, auto-fit — `routeMapImage`) shown
  as a frames strip; an interactive `map_embed` carrying the new optional
  `path` field (the client draws markers + polyline + fitBounds; older
  clients show a plain map — sse-protocol forward-compat); and
  `buildJourneyBlock` with per-leg + total straight-line distances
  (`distanceMeters`), Google **Routes API v2** walking distance/time
  (`computeWalkingRoute` — computeRoutes, WALK, minimal field mask; the
  API must be enabled on the server key, and a failure degrades to an
  honest straight-line-only block that forbids inventing a walking time),
  reverse-geocoded start/end names, and a mandated keyless
  `google.com/maps/dir/...` directions link through all stops. The block
  explicitly instructs the model to present it AS the journey — the
  visited positions are the conversation's own relocations, not
  unverifiable estimates.
- **The map view has full panorama parity on follow-ups** (same day,
  follow-up request): the client tracks the live map's center/zoom and
  sends it as `body.map_view` (validated by `validateMapView`); a
  map-referencing follow-up routes through `pickLookup`'s `mapView` branch
  (loose scene gate, right after the POV branch) to
  `runMapViewEnrichment` — one edge-cached Static Maps capture of exactly
  the on-screen area (`runMapViewCapture`), a map-flavored
  vision-describe, `buildMapViewBlock` (current-center Map-link mandate,
  conditional-relevance + never-fabricate lines), and a fresh
  continue-from-here `map_embed` at the current view. Only the latest
  embed (map OR panorama) is live — rendering either locks the superseded
  ones and clears the other kind's view slot, so `map_view` and
  `street_view_pov` never ride together. Every maps/POV block
  also carries `NO_FABRICATED_IMAGE_URLS`: before it, a model wanting to
  "show" imagery invented a `maps.googleapis.com/maps/api/streetview?…
  key=YOUR_API_KEY` markdown image — a broken image in the reply. Only the
  keyless links may be handed out.
- **Vision-describe, never attach** (`enrichment.js`'s `describeStreetView`): the
  frames are NOT attached to the answer model — a report showed several frames
  on one message making the answer call fail with a Berget 400. Instead the
  frames (capped at `MAX_MAPS_IMAGES` = 4, the client's own per-message cap,
  tightened further to the helper model's profiled per-request image limit —
  `model-profiles.js` `maxImages`; 2026-07-08 probe: Mistral Medium accepts at
  most 2 images per request, so its describe gets 2 cardinal frames instead of
  400ing blind on 4) are
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
- **The snapped frames are shown in the reply** (the `streetview_frames` SSE
  event): the direction-labeled frames the vision helper reasoned about are
  emitted to the client and rendered as a captioned thumbnail strip beside
  the answer (`activity.js`'s `renderStreetViewFrames`), so the user sees the
  SAME imagery the model saw — and the block tells the answer model the
  photos are displayed to the user, so it can refer to them directly. The
  client compacts this event before it enters the "Copy research JSON" log
  (`sanitizeResearchEvent` — count + directions, never the data URLs).
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

## Hugging Face Hub search — a search-phase source (no knob)

`src/hf.js` + `src/pipeline.js`'s `maybeHfSearch`: when the latest user
message targets Hugging Face (`hfIntent` — "hugging face" / "huggingface" /
hf.co / a bare "HF" word (requested 2026-07-08; the HF-radio false positive
is an accepted tradeoff — free, fail-soft, junk goes uncited); an org/name
path alone is NOT enough. WIDENED 2026-07-17 after a live miss ("Tell me
about the bonsai 1bit models" ran web-only though every primary source was
an hf.co model card): hub-IMPLIED vocabulary now fires too — standalone
ecosystem tokens (gguf/ggml/safetensors/llama.cpp/gptq/awq/exl2/mlx/bitnet)
alone, and quantization/open-weight phrasing ("1bit", "4-bit", "1-bitars",
quantized/kvantiserade, open weights/öppna vikter, (q)lora) only when
co-occurring with a model-artifact word (model(s)/llm(s)/modell(er/erna)/
språkmodell…/weights/vikter/checkpoint) so "climate models" and "64-bit
Windows" stay out; LoRa-the-IoT-protocol + a model word is the accepted
new false positive, same rationale as HF radio; EN+SV parity tested in
hf.test.js), each search wave also queries the HF Hub API and
the hits join the numbered source registry as ordinary citable sources.
Unlike Shodan/Maps there is NO settings knob: like Exa, only the AI-derived
search terms cross the wire (never the conversation or identity), the API is
free, and it's gated behind the web-search toggle by virtue of living inside
the search phase.

- **Auth:** `HUGGINGFACE_API_TOKEN` (Worker secret, confirmed present) rides
  as a Bearer header when set — OPTIONAL by design (public search works
  without it; the token buys rate-limit headroom and gated-repo visibility).
- **Query plan — phrasing drives the API's full capabilities**
  (`hfQueryPlan`/`hfBuildAttempts`, all curated + deterministic): task
  phrases → `pipeline_tag` (models) / `task_categories` (datasets, only
  where valid); language words (EN + SV forms) → `?language=<iso>` —
  MODELS ONLY (dataset language tags empirically unreliable:
  `?language=sv` returned github-code); sort intent (trending →
  `trendingScore`, most liked → `likes`, default `downloads`); recency
  phrasing ("latest/newest") makes the fresh slice lead. Every attempt
  fetches TWO slices (sort=downloads + sort=lastModified with a
  ≥20-download junk floor), merged via `mergeSlices`; `expand[]` params
  surface downloads/likes/lastModified on any sort (the plain list omits
  lastModified except when sorting by it). A fully-consumed query becomes
  a pure filtered browse — the strongest case (canonical multi-million-
  download repos instead of name-matched hobby repos).
- **Endpoint behavior (established empirically 2026-07-08 — re-verify if
  results look off):**
  - `GET /api/models?search=` and `/api/datasets?search=` are NAME-substring
    matches: verbose research queries return NOTHING ("swedish speech
    recognition" → 0 hits; "whisper swedish" → hits). Hence `hfTerms`
    (noise-word stripping) + `hfAttempts` (token-drop ladder: all terms →
    last two → single longest, retried until an attempt returns hits).
    List responses already carry downloads/likes/pipeline_tag/lastModified —
    no per-hit detail fetch needed. `sort=downloads` for determinism and the
    common "most used" intent.
  - `GET /api/papers/search?q=` IS verbose-friendly (full-text) — gets the
    raw planned query. Items nest as `{paper: {id, title, summary,
    publishedAt}}`.
  - `/api/quicksearch` exists but is also name-matching AND shallow
    (id + trendingWeight only) — rejected.
- **Pipeline wiring:** via the search-source REGISTRY
  (`src/search-sources.js` — see the **add-research-source** skill): one
  entry declaring intent/search/service/dedupKey/promptNote/diversity;
  the generic orchestrator (`pipeline.js` `runAuxSearches`) runs it AFTER
  each wave's Exa batch (source numbering stays deterministic) on the
  wave's first planned query, capped at 3 waves/request, deduped across
  waves by term key, emitting `search_start`/`search_done` with
  `source:"hf"` / `service:"Hugging Face Hub"` so the client card names
  the provider. Caps 4 models + 4 datasets + 3 papers per search.
  Fail-soft in every branch (a failed endpoint contributes zero items;
  failure degrades to the Exa-only registry). HF searches are free —
  never billed or counted against Exa search quota.
- **Diversity cap interaction** (`src/sources.js` `diversityKeyOf`): hf.co
  URLs are capped per OWNER namespace (`huggingface.co/<owner>`; papers
  share one `huggingface.co/papers` bucket), not per hostname — otherwise
  the 3-per-domain cap would throttle an HF-focused question to 3 hub
  sources total. The cap still stops any single org dominating.
- **Eval:** bench questions kind `hf` (`tests/bench-questions.mjs`,
  `hf_*` ids) exercise it; A/B history in `tests/EVAL-BENCH-FINDINGS.md`.
