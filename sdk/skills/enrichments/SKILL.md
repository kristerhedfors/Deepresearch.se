---
name: enrichments
description: >-
  Load when building an agent pair's opt-in context-enrichment plane — the
  registry of pre-pipeline resolvers that turn something the latest message
  NAMES (a host/IP, a street address, a photo's GPS) into one labeled
  context block every phase can read: the enrichment contract
  (deterministic target extraction → bounded privacy-minimal lookup →
  capped summary → one labeled block → named step only when real → fail
  soft → counted), the registry seam that makes a new enrichment a
  one-file drop-in, per-user knob gating with secret-gated visibility, the
  worked integrations (reverse geocoding, host intelligence, maps with
  vision describe), and language-parity intent gates. Also load when an
  enrichment fires spuriously, never fires, or leaks more than its minimal
  payload.
---

# The enrichment registry

Enrichments resolve things the user's message *names* — not topics to
research — into live external data, appended to the conversation as labeled
context blocks BEFORE any model call, so triage, search, and synthesis all
see them. They are the pair's pattern for integrating intelligence feeds
without function calling: the orchestrator decides in code whether a lookup
runs, the request that leaves carries the minimum, and every branch
degrades to the conversation unchanged. The registry makes the next
integration a one-file drop-in instead of a five-file thread-through.

## Capability class & tier story

Class **S** (server-backed). Enrichments live in the one server component
because they are the wrong shape for the client tier on three axes at once:
they spend server-held secrets (per-call-billed or key-gated third-party
APIs), they want server-side mediation (consistent logging, rate awareness,
timeouts, policy in one place), and their per-user knobs rest on server
accounts. **There is deliberately no client half**: the pipeline treats
enrichments as optional by contract, so the client tier simply runs without
them — its counterpart capabilities arrive, if ever, either browser-direct
on the user's own keys (the web-search module's pattern) or through the
grant bridge (class B), never by putting the pair's server in the client
tier's data path. The pure halves of each enrichment (target extraction,
intent gates, block builders) are still written as import-free Node-tested
modules — that is what keeps them auditable, and what a future tier move
would lift out unchanged.

## Contracts

- **PA-1** — selection is deterministic: a pure predicate/extractor on the
  conversation decides whether a lookup runs; no model ever chooses a tool.
  There is no discovery problem — the orchestrator knows its integrations
  at build time.
- **PA-2** — fail soft in EVERY branch: no key, no target, a timeout, an
  upstream 404/error all degrade to the conversation unchanged (or an
  honest "no records" note so the model doesn't invent data) — never a
  blocked or delayed chat. The registry loop additionally contains a
  throwing runner.
- **PA-4** — minimal outbound per integration: only the extracted target
  (a coordinate pair, an IP/hostname, an address) crosses the wire — never
  the question, filename, or any account/session identity; API keys never
  appear in logs, context blocks, or citable links.
- **PA-5** — raw REST clients with bounded-subset summarization; every
  special case traces to a probe or a report.
- **PA-6** — every deterministic intent gate takes all supported languages
  at the same breadth (definite forms, synonyms, enumerated typo sets),
  with a parity unit test landing in the SAME change as the gate.
- **PA-10** — each integration is verified live (the bugs live at the
  provider boundary), and its routing is observable per exchange (the
  winning matcher logged and written into the interaction-log metadata).

## Build plan

1. **State the contract where the registry lives** (`src/enrichment.js`
   header) — every runner must satisfy it, verbatim:

   > deterministic target extraction (pure, unit-tested) → bounded,
   > privacy-minimal lookup with its own timeout → summarize to a capped
   > subset → append ONE labeled context block → emit a named activity
   > step only when something real happened → fail soft in every branch →
   > count into `state.<id>Count` for the completion log.

   "Named step only when real" means: when the message names nothing, an
   enrichment is fully invisible — no step, no event, no fetch; when it
   fires, the step LABEL names the external service so the user always
   sees which third party is being consulted.
2. **The registry** (`src/enrichment.js`): one entry per enrichment —
   `{id, enabled(state), run(ctx)}` where `ctx` bundles
   `{env, log, emit, step, stepDone, conversation, state}` — and one
   generic `runEnrichments(...)` the pipeline calls ONCE before any model
   call, iterating in declared order (order matters: each runner sees the
   conversation as left by the previous one), catching any throw so a
   buggy runner can never take down the chat. The pipeline never names an
   individual enrichment. The fuller declarative form (`settingsKey`,
   `secretName`, `detect` split from `run`) is the roadmap's stated
   target — adopt it in a fresh pair so gating and visibility derive from
   the entry instead of hand-wired lines.
3. **Per-user knob gating** (`src/settings.js` + the settings API): one
   settings key per enrichment in the per-user settings JSON, **default
   OFF** (only an explicit stored `true` enables — the user should choose
   deliberately before their message content triggers third-party
   lookups). The settings endpoint reports the EFFECTIVE state: off unless
   the enrichment's secret is set AND the caller has a real account row.
   Absent the secret, the feature is INVISIBLE — the UI hides the knob
   entirely (the invisible-without-key convention). The chat handler
   resolves each knob onto the request state; `enabled(state)` reads it.
4. **Worked shape 1 — reverse geocoding** (coordinates → place name): an
   attached photo's GPS EXIF is only a lat/lon pair — useless to a model
   or a search engine. Resolve it server-side against a keyless geocoder:
   only the coordinates cross the wire, with a deliberately generic,
   non-identifying User-Agent; neighborhood-level zoom (not house
   precision); ~4 s timeout; a `Resolved location(s)` block; a visible
   step naming the service. No knob needed (free, resolves metadata the
   photo itself carries, minimal payload) — but it stays server-side like
   everything else so it is logged and policy lives in one place.
5. **Worked shape 2 — host intelligence** (message names a host/IP):
   `extractTargets(text)` — pure, heavily de-noised: private/loopback/
   link-local/CGNAT/reserved IPs, out-of-range octets, filename lookalikes
   (`report.pdf`), and email-address domains all excluded; deduped and
   capped (≤4 IPs, ≤4 hostnames, ≤6 lookups). Lookup: batch DNS resolve,
   then one host query per unique IP, ~8 s timeout, summarized to a
   bounded subset (≤24 ports, ≤10 services, ≤15 CVEs) with a citable
   per-host URL. Zero hits → an honest "no records" note so the model
   doesn't invent infrastructure. Opt-in knob (sends the host to a third
   party), secret-gated visibility.
6. **Worked shape 3 — maps/imagery** (message names an address/place, or
   references live imagery): the big one, and the module's masterclass in
   seam discipline. Split three ways: a pure TEXT module owning every
   intent gate and extractor (street-view asks incl. enumerated typo sets,
   relative moves, here-asks, nearby/relocation asks, locality
   corrections, journey asks) and `pickLookup` — an ORDERED registry of
   small named matchers, one per ask shape, where **the order is the
   spec**; an API-client module owning the REST calls, the edge-cached
   lookup orchestration (~10 min TTL), and pure labeled block builders in
   a separate leaf **where the API key never appears** (citable links are
   the provider's keyless URLs); and a runner module with one runner per
   resolved target shape, dispatched generically. Frames are never
   attached to the answer model: a **vision-describe helper** (any
   vision-capable catalog model, frame count capped by the helper's
   profiled per-request image limit) turns imagery into text inside the
   block, billed to its own split-billing bucket — so the answer call is
   always image-free and imagery questions work on non-vision answer
   models. Every block carries the honesty mandates: never fabricate
   image URLs, never hand out enable-in-settings steps when the feature
   is already on, degrade honestly when no coverage exists.
7. **Adding the NEXT enrichment** = one client module (`src/<x>.js`: pure
   extractors + bounded lookup + block builder) + one registry entry + one
   settings key + one secret + its test file. If it should instead produce
   *citable sources inside the search waves*, it's not an enrichment —
   use the web-search module's auxiliary source registry (query-only,
   free, gated behind the search toggle); if billed per call, mirror the
   search plane's cost accounting.
8. **Routing observability**: tag the winning matcher onto the resolved
   target, log it, and write it into the interaction-log row's metadata —
   so "how did routing go?" is answerable per exchange, including "none"
   for misses. Misrouted-live-message reports are this plane's main bug
   class; the verbatim message becomes the regression test.
9. **Validate**: unit-test every extractor/gate both directions (with
   documented false-positive tradeoffs) plus the language-parity suite;
   then live-probe each integration on the deployment (a probe per ask
   shape, plus the exact phrasing of any reported failure); confirm an
   ordinary question shows no spurious step and a knob-off user sees no
   lookup.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Registry + generic runner + the contract header | `src/enrichment.js` (`ENRICHMENTS`, `runEnrichments`) |
| Contract formalization rationale | `docs/ARCHITECTURE-ROADMAP.md` §3 ("the Enrichment contract") |
| Knob gating + effective-state reporting | `src/settings.js` (`shodan_mcp`, `google_maps`; `featureAvailability`) |
| Reverse geocoding (coords only, generic UA, 4 s) | `src/geocode.js` (`reverseGeocode`, `augmentWithLocations`) |
| Host intelligence (extraction, caps, 8 s, honest no-records) | `src/shodan.js` (`extractTargets`, `runShodanLookup`) + `runShodanEnrichment` in `src/enrichment.js` |
| Maps pure text side: gates, extractors, ordered `LOOKUP_MATCHERS` | `src/googlemaps-text.js` |
| Maps API clients + edge-cached orchestration | `src/googlemaps.js`, `src/edge-cache.js` |
| Maps pure block builders (key never present, keyless links) | `src/googlemaps-blocks.js` |
| Maps runners, one per target shape + vision describe | `src/maps-enrichment.js` (`runGoogleMapsEnrichment`, `describeStreetView`) |
| Vision-helper image caps per model | `src/model-profiles.js` (`maxImages`) |
| Language-parity test suite | `src/googlemaps.test.js` ("Swedish language parity") |
| Routing observability into chat logs | `maps.intent` → `state.mapsIntent` → `chat_logs` meta (`src/chat.js`, `src/chatlog.js`) |
| A third registry consumer (introspection as an enrichment) | `src/introspect.js` entry in `ENRICHMENTS` |

## Acceptance checklist

- [ ] Unit: every extractor and intent gate, both directions — fires on
      the shapes it must, stays silent on prose lookalikes — with each
      documented false-positive tradeoff asserted.
- [ ] Unit: language parity — every gate's non-English forms (definite
      forms, synonyms, diacritic-less and typo variants) covered by a
      parity suite landing in the same change as the gate.
- [ ] Unit: block builders (labeled, capped, honesty mandates present) and
      the assertion that no secret/key string can appear in any pure
      module's output.
- [ ] Unit: the registry loop — a throwing runner is contained; a disabled
      knob skips the entry; entries run in declared order.
- [ ] Live probe per integration: one ask per shape on the deployment;
      the step names the external service; the block lands in the context;
      the completion log carries the count and the winning intent tag.
- [ ] Live negative probes: an ordinary question shows NO spurious step;
      a knob-off user triggers no fetch; a missing secret hides the knob.
- [ ] The chat never errors when an enrichment fails (kill the secret /
      point at a dead host and watch the request complete unchanged).

## Pitfalls

- **Don't wrap these in a tool protocol.** The reference explicitly
  evaluated rebuilding its integrations on MCP and refused: selection is
  deterministic (no discovery problem), a protocol hop adds latency and a
  second timeout regime to a pipeline that budgets seconds, and the
  privacy guarantees ("only the IP crosses", "only the coordinates,
  generic User-Agent") live in hand-shaped request code that generic tool
  plumbing works against. The registry IS the useful kernel of the tool
  idea without the transport.
- **Silence is a feature.** An enrichment that emits a step for an
  ordinary question trains users to ignore the activity panel; one that
  fetches without a target burns quota. The reference's rule — no target,
  no step, no event, no fetch — was violated by early builds and is now
  the contract's first clause.
- **The gates grow from live reports, in rounds.** Nearly every maps gate
  clause traces to a verbatim production message: typo sets ("Streer
  view", "Forwsrd 200m"), definite/diacritic-less forms, locality
  corrections re-running the lookup in the corrected city, follow-ups
  that reference imagery without naming anything (the walk-back), scene
  deictics and "what do you see". Fix at the layer the evidence points to
  (noise list / gate / matcher order) and add the failing phrasing as a
  test — never widen a gate speculatively.
- **Loose gates for cheap actions, strict gates for billed ones.** The
  reference's POV recapture over-fires deliberately (one cached frame,
  and the block's relevance line is conditional), while the full billed
  lookup walk-back keeps the strict gate. Price the gate to the action.
- **Never attach lookup imagery to the answer model.** Several frames on
  one message made answer calls 400 outright (and per-model image limits
  as low as 2 exist, probed live). The vision-describe helper — imagery
  → short factual text, capped by the helper's profiled `maxImages`,
  billed to its own bucket — makes the answer call image-free and the
  feature model-agnostic.
- **Ban fabricated resource URLs in the block.** Before the mandate, a
  model wanting to "show" imagery invented a keyed API URL with
  `key=YOUR_API_KEY` — a broken image in the reply and a
  secret-shaped string in the output. Blocks hand out keyless links only,
  and say so.
- **Honest emptiness beats silent absence**: zero hits must produce an
  explicit "no records / no coverage" note in the block — a silent miss
  makes the model invent infrastructure, views, or enable-in-settings
  instructions at a user whose knob is already on (all three observed).
- **Stateless follow-ups need deterministic memory.** Blocks are appended
  per request only, so "what color is the roof?" carries no address —
  the walk-back/pending-ask recovery (re-derive the last target from the
  conversation's own turns) is what keeps follow-ups working without any
  server-side session state.
- **Browser-exposed keys are a different class**: if an inline embed
  needs a client-side key, it must be a SEPARATE key, referrer-locked and
  API-restricted, surfaced through the settings payload — the powerful
  server key never reaches the browser. Expect the SDK-load-fine,
  reject-async failure mode and wire the provider's auth-failure hook to
  a graceful fallback (observed live before the right API was enabled).
