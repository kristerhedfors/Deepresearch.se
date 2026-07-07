# Maps capabilities — user stories, trigger prompts, and hillclimb ledger

The app's mapping capability is built on **OpenStreetMap Nominatim** (no key,
Worker-mediated — see `CLAUDE.md` → "Reverse geocoding" and the maps section).
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

Nominatim exposes two primitives; this app drives both, from three sources:

| # | Capability | Nominatim call | Trigger source | Toggle |
|---|---|---|---|---|
| 1 | Reverse geocode a **photo's** GPS EXIF | `/reverse` | `body.imageLocations` (client EXIF) | independent (`src/geocode.js`) |
| 2 | Reverse geocode **coordinates typed in the message** | `/reverse` | text (`src/maps.js`) | independent |
| 3 | Forward geocode a **named place / address** | `/search` | text (`src/maps.js`) | gated by web-search |

**Privacy boundary** (the reason capability 3 is gated): reverse geocoding
resolves numbers the message already contains — a point on a map, revealing
nothing about intent — so it runs regardless of the web-search toggle, like
the photo geocoder. Forward geocoding sends a *place token derived from the
user's question* to a third party, so it sits behind the same web-search
toggle as Exa. Only the extracted token/coordinates ever cross the wire —
never the full question.

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
