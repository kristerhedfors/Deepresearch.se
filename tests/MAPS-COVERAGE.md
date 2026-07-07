# Maps integration — user stories, test batches, and findings

The durable record of what the location/maps enrichment must do, which
test covers each story, and what the 2026-07-07 end-to-end review against
the live site (break-glass credentials) found. Same append-only
convention as `MODEL-EVAL-FINDINGS.md`: add dated sections, don't rewrite
history.

## The integration surface (as deployed, observed 2026-07-07)

1. **Photo GPS → place name** (`geocode` step): EXIF GPS extracted
   client-side (`public/js/exif.js`), forwarded as `body.imageLocations`,
   reverse-geocoded server-side; a "Resolved location(s)" context block is
   appended to the conversation before the pipeline runs, so triage,
   search planning, and synthesis all see the actual place.
2. **Coordinates in message text → place name** (`maps` step): the same
   lookup, triggered by coordinates the user typed, no attachment needed.
   Runs independent of the web-search toggle (like Shodan: it resolves
   data the message itself carries, it doesn't research the topic).
3. **`map` SSE events**: each resolution emits figure descriptors
   (`kind: "map" | "streetview"`, a `/api/maps/...` URL, label, caption,
   lat/lon) that the client renders inline under the answer, embeds in
   the PDF report, and includes in the "Copy research JSON" debug export.
4. **Worker image proxies** `/api/maps/static` (PNG) and
   `/api/maps/streetview` (JPEG): auth-gated; the maps API key never
   reaches the browser; responses cached (`cache-control: private,
   max-age=86400`).

## User story ↔ test matrix

| # | Story | Batch | Test |
|---|-------|-------|------|
| 1 | Photo GPS rides to the server as raw coordinates, never resolved client-side, with a visible 📍 badge before send | mocked | `metadata.spec.js` "a JPEG's EXIF … reaches the payload and is flagged" |
| 2 | Malformed/oversized `imageLocations` are silently dropped, never a blocked chat | unit | `src/validation.test.js` `validateImageLocations` |
| 3 | Resolution appends a labeled context block, emits `geocode` start/done steps, fails soft in every branch, caps lookups | unit | `src/geocode.test.js` (all) |
| 4 | The geocode/maps step events project into the debug JSON | unit | `public/js/activity.test.js` |
| 5 | Map/Street View figures render captioned, deduped by URL, via `/api/maps/*` only | mocked | `maps.spec.js` "map SSE events render captioned figures…" |
| 6 | A failing tile removes its figure, never a broken image | mocked | `maps.spec.js` "a figure whose tile fails…" |
| 7 | No spurious figure strip on ordinary answers | mocked | `maps.spec.js` "ordinary answers without map events…" |
| 8 | Image proxies serve real PNG/JPEG to a session | mocked (api) | `maps.spec.js` "map image proxies serve real images…" |
| 9 | Image proxies are auth-gated; unknown subpaths 404 | mocked (api) | `maps.spec.js` "…auth-gated and 404 unknown subpaths" |
| 10 | Proxy rejects missing coordinates with a 4xx | mocked (api) | `maps.spec.js` `test.fixme` — **fails today, see finding E** |
| 11 | Photo GPS → resolved place name reaches the model; step names the service; figures render | live | `live.spec.js` "@live photo GPS EXIF gets reverse-geocoded…" |
| 12 | Typed coordinates trigger the maps lookup + figures | live | `live.spec.js` "@live coordinates in the message text…" |
| 13 | **Complex prompt**: the resolved place feeds the planned Exa queries (the "do we hit the correct APIs" story) | live | `live.spec.js` "@live complex prompt: the resolved photo location feeds the research queries" |

Run: `cd tests && npm run test:mocked` (stories 1, 5–10) and
`npm run test:live` (11–13); `npm test` at the repo root (2–4).

## 2026-07-07 — end-to-end review findings (break-glass, live site)

Raw probes: direct `curl` SSE captures of `/api/chat` with
`imageLocations` (Manhattan coords, web search on), typed Stockholm
coordinates (web search off), and a plain research prompt; plus direct
hits on `/api/maps/*`.

**What works, verified live:**
- Photo GPS → `geocode` step → resolved place → the **planned search
  queries actually used it** ("notable landmarks and museums within
  walking distance of The Stuntman, New York, NY 10007", "points of
  interest in the TriBeCa neighborhood…") — the pipeline inferred the
  neighborhood from the resolved address. Correct API order: maps lookup
  before triage, Exa for the research itself.
- Typed coordinates → `maps` step → correct answer ("…Florence School in
  Stockholm… 111 52 Stockholm") with map + Street View figures.
- `/api/maps/static` 200 `image/png`, `/api/maps/streetview` 200
  `image/jpeg`, both 401 signed-out; unknown subpath 404. Figures are
  Worker-proxied — no provider key client-side.
- Client dedupes duplicate figure URLs across `map` events.

**Findings (A is the one that matters):**

- **A — CRITICAL: the deployed maps integration is not in the repo.**
  `origin/main` (= this branch's base) still contains only the
  OpenStreetMap Nominatim geocoder; production serves a Google
  Maps-based version with `src/maps.js`, `/api/maps/*` proxies, `map`
  SSE events, and modified `stream.js`/`turns.js`/`activity.js`/
  `report.js`/help page (confirmed by diffing the served JS against the
  repo). The repo is git-connected to Cloudflare — **the next push to
  `main` auto-deploys and silently rolls the whole maps integration out
  of production.** Commit the maps changeset from wherever it was
  developed before pushing anything else to `main`. (CLAUDE.md's
  "Reverse geocoding — OpenStreetMap Nominatim" section is stale for the
  same reason.)
- **B — Exa search is down site-wide.** Every search in every probe
  returned 0 results in ~80 ms (fail-fast signature, not real searches),
  on maps prompts and plain research prompts alike; answers degrade to
  "no usable sources" + general knowledge, and post-validation discards
  drafts over it. Nothing surfaces in the admin notification center —
  `alerts.js` has no Exa alert type; `exa.error` only goes to Workers
  Logs. Two actions: fix the key/plan/wallet, and add an operational
  alert type for repeated Exa failures.
- **C — stale label**: the `maps` step_start says "Looking up location
  (OpenStreetMap)…" while step_done says "…via Google Maps".
- **D — double lookup for photo GPS**: an attached photo triggers BOTH
  the `geocode` step and the `maps` step for the same coordinates (the
  text extractor apparently re-finds the coordinates the geocode block
  appended) — two identical resolutions per request on the maps quota,
  two steps in the activity panel. Client-side URL dedupe hides the
  duplicate figures, not the duplicate spend.
- **E — no param validation on `/api/maps/static`**: a parameterless
  request returns 200 with a junk tile instead of a 4xx (burns provider
  quota on garbage). Encoded as a `test.fixme` in `maps.spec.js` —
  flip it to a real test when fixed.
- **F — POI-level place names**: reverse geocoding resolves to oddly
  specific POIs ("The Stuntman" for lower Manhattan, "Florence school"
  for central Stockholm). The full address that rides along rescues the
  research queries (finding "what works" above), but the step details
  and captions lead with the POI, and models parrot it ("Florence School
  is a primary school…"). Consider preferring neighborhood/locality
  granularity for the label.
