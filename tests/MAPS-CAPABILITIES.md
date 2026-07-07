# Maps capabilities — user stories, trigger prompts, and hillclimb ledger

The app's mapping capability is built on the **Google Maps Platform** —
**Places API (New)** (forward + reverse geocoding), **Maps Static API** (map
images), and **Street View Static API** (street-level images), keyed by the
`GOOGLE_MAPS_API_KEY` Worker secret. OpenStreetMap Nominatim survives only as
the reverse-geocode fallback when that key is absent. See `CLAUDE.md` → "Maps
— Google Maps Platform".

This file is the durable record of the maps *user stories*, the prompts that
should trigger each capability, and the round-by-round improvements made so
that they actually do. It plays the same role for the maps feature that
`MODEL-EVAL-FINDINGS.md` plays for the model matrix: append a new dated
section per hillclimb round; don't rewrite history.

The triggering logic is deterministic (no function calling), so "does this
prompt trigger?" is a pure-function question answered by
`src/maps.test.js` — that battery IS the executable form of the stories
below. Run it with `node --test src/maps.test.js`.

## The capabilities

This app drives Places (forward + reverse) plus Static Maps and Street View
imagery, from three trigger sources:

| # | Capability | Google API | Trigger source | Toggle |
|---|---|---|---|---|
| 1 | Reverse geocode a **photo's** GPS EXIF (+ map + Street View) | Places Nearby (New) | `body.imageLocations` (client EXIF) | independent |
| 2 | Reverse geocode **coordinates typed in the message** (+ map + Street View) | Places Nearby (New) | text | independent |
| 3 | Forward geocode a **named place / address** (+ map + Street View) | Places Text Search (New) | text | gated by web-search |
| — | **Map image** for any resolved location | Maps Static API | every resolved location | — |
| — | **Street View image** where imagery exists | Street View Static (+ free metadata check) | every resolved location | — |

**Privacy boundary** (the reason capability 3 is gated): reverse geocoding
resolves numbers the message already contains — a point on a map, revealing
nothing about intent — so it runs regardless of the web-search toggle, like
the photo geocoder. Forward geocoding sends a *place token derived from the
user's question* to a third party, so it sits behind the same web-search
toggle as Exa. Only the extracted token/coordinates ever cross the wire —
never the full question. **The API key never reaches the browser**: map and
Street View tiles are served through the Worker's own key-free proxy
(`/api/maps/static`, `/api/maps/streetview`), which range-checks params and
injects the key server-side.

## User stories → trigger prompts

Capability 1 (photo EXIF) is covered by the existing e2e test
(`tests/e2e/live.spec.js`, "photo GPS EXIF gets reverse-geocoded"). Stories
2 and 3 are new and covered by `src/maps.test.js`.

**As a researcher, I want to know what's at a coordinate I paste**, so I can
turn a raw GPS fix into a place. → capability 2
- "What's at 59.3293, 18.0686?"
- "Reverse geocode 40.7128, -74.006 for me"
- "What's near 27.1751, 78.0421 (the Taj Mahal area)?"
- "GPS: 48.8566 N, 2.3522 E" · "latitude 40.71 longitude -74"

**As a researcher, I want the coordinates / canonical location of a place I
name**, so the model and Exa have something precise to work with. → capability 3
- "What are the coordinates of the Eiffel Tower?"
- "Where is the Great Barrier Reef?" · "Where is Mount Kilimanjaro located?"
- "What's the location of Machu Picchu?" · "Which country is Timbuktu in?"
- "Show me a map of Kyoto" · "How do I get to Shibuya Crossing?"

**As a researcher, I want distances/routes between two places**, so I can
reason about travel. → capability 3 (two places)
- "How far is it from Paris to Rome?" · "How far is Cairo from Alexandria?"
- "distance between Tokyo and Osaka" · "Plot a route from Oslo to Bergen"

**As a researcher, I want to look up a street address**, so I can anchor a
question to a specific building. → capability 3
- "What's near 1600 Pennsylvania Avenue, Washington?"
- "I want to visit 221B Baker Street, London"

**As a user asking ordinary questions, I do NOT want a spurious map lookup.**
→ must stay silent (no step, no network, no context block)
- "Explain the causes of World War I" · "What is 2 + 2?"
- "The meeting is from 3 to 5 pm" · "prices ranged from 10 to 50 dollars"
- "Where do I even begin with this codebase?" · "Where is the bug in this function?"
- "We shipped version 3.14, 2.71" · "The point estimate was 1.5, 2.5"

## Hillclimb rounds

### Round 1 — 2026-07-07 — build the text-driven capabilities

Baseline: only capability 1 (photo EXIF) existed. A user asking any location
question in *words* triggered no maps lookup at all. Added `src/maps.js`:
deterministic `extractCoordinates` / `extractPlaceQueries`, Nominatim
`/search`, orchestration + a visible `maps` activity step, wired into
`src/pipeline.js` after the Shodan phase. Initial battery: 50 cases.

Findings that shaped the first cut:
- **Plain decimal pairs are ambiguous** ("version 3.14, 2.71"). Required a
  location cue in the message for the plain-pair notation; hemisphere and
  labeled notations are self-evident and need none.
- **"where is X" over-fires** on non-places ("where is my phone", "where is
  the bug"). Made the bare "where" cue *weak*: it only accepts a
  proper-noun-ish capture (a capital, a comma, or a leading street number).
  Strong cues ("coordinates of", "map of", "directions to", "distance
  from…to") accept any capture.
- **Distance phrasing** needs its own miner ("from A to B", "between A and
  B") gated on a distance/travel cue so "from Monday to Friday" never
  geocodes.

### Round 2 — 2026-07-07 — precision & recall tuning

Swept a wider realistic battery and fixed:
- **"how far is A from B"** (not "from A to B") wasn't mined — a very common
  phrasing. Added `IS_FROM_RE`, tried only after the "from A to B" / "between
  A and B" forms.
- **"the ratio settled at 1.5, 2.5"** false-fired via the weak `at <number>`
  cue. Split coord cues into STRONG (accept any precision) vs WEAK (require
  GPS-like ≥3-decimal precision). Real GPS carries precision; measurements
  don't.
- **Data-speak words** ("point", "spot", "place") removed from the coord cue
  — they fire on "the point estimate was 1.5, 2.5".
- **"what/which country is X in?"** phrasing added (weak, place-gated) — a
  natural geography question that named no cue word before.
- **Generic destinations** ("get to work", "directions home", "from my
  house") added to the non-place stoplist so they don't geocode to junk.

### Round 3 — 2026-07-07 — address edge cases

- **House numbers with a letter suffix or range** ("221B Baker Street",
  "45-47 Main Street") weren't matched (the pattern required a digit run
  followed by whitespace). Widened the number token to `\d{1,5}[a-z]?(-…)?`.

Battery now 63 cases, all green. The full-suite run (`npm test`) stays green.

### Round 4 — 2026-07-07 — migrate to the Google Maps Platform + add imagery

The deployment gained a Google Maps API key with **Places API (New)**, **Maps
Static API**, and **Street View Static API** enabled. Reworked the whole
capability onto Google (Nominatim kept only as the reverse-geocode fallback),
which upgrades the data AND — the big win — adds real map + Street View
imagery:

- **Forward geocoding** → Places Text Search (New): canonical `displayName`,
  `formattedAddress`, place `types`, Google `rating`, and a `googleMapsUri`,
  where Nominatim gave only a display string + OSM category.
- **Reverse geocoding** (photo EXIF + typed coords) → Places Nearby Search
  (New), distance-ranked in a 200 m circle. Falls back to Nominatim `/reverse`
  when the key is absent/fails, so nothing regresses without a key. Imagery is
  centered on the ORIGINAL coordinate, not the nearest POI.
- **Imagery** → for every resolved location, a Maps Static map image (red
  marker) and — only when the free Street View `metadata` check returns `OK`,
  so no grey "no imagery" tile — a Street View image. The **API key never
  reaches the browser**: tiles are served through the Worker's key-free proxy
  (`/api/maps/static`, `/api/maps/streetview`), which range-checks lat/lon,
  bounds zoom, fixes the size, and injects the key server-side. Delivered to
  the client via a new `map` SSE event; rendered under the answer, embedded in
  the PDF report, and captured in the "Copy research JSON" export.

The pure extractors (`extractCoordinates`/`extractPlaceQueries`) are
provider-agnostic and carried over unchanged — all 63 trigger cases stayed
green. New tests cover the proxy path builders (assert the browser-facing path
carries no `key=`), `handleMapsProxy` (no-key→404, bad-coords→400, valid→200
with the key injected only into the Google-facing URL, Google-error→502), and
`mapsAvailable`. Battery now 70 cases; `npm test` green (306).

**New user stories this round** (imagery):
- "Where was this photo taken?" (GPS photo) → place name **+ a map + Street
  View of the spot**, shown under the answer and in the PDF.
- "Show me a map of Kyoto" / "Street view of the Colosseum" → the map/Street
  View image is now the literal answer to the request, not just text.
- "What's at 59.3293, 18.0686?" → nearest Google place + a marked map + Street
  View of the exact point.

## Accepted limitations (deliberate precision/recall trade-offs)

- **Lowercase bare "where is …"** ("where is paris") does not fire — the
  weak-cue guard needs a capital/comma/address to avoid firing on generic
  nouns. Properly-capitalized names and any strong cue ("map of paris",
  "coordinates of paris") work lowercase. This is the honest trade-off; the
  research question still gets answered by Exa/the model, just without the
  precise OSM enrichment.
- **A strong cue naming two places** ("coordinates of Paris and London")
  returns the first ("Paris") — the "and" boundary prevents over-capture.
  Distance phrasings ("… Paris and London") get both via the pair miner.
- Every miss degrades softly: no maps enrichment, never a blocked chat.
