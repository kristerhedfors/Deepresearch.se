# Google Maps Platform integration — capabilities, priorities, billing

Status snapshot (2026-07-07): the Google Cloud project has **Street View
Static API**, **Places API (New)** and **Maps Static API** enabled, keyed by
the `GOOGLE_MAPS_API_KEY` Worker secret. Everything in "Implemented" below
is live, per-user knob-gated (account panel → Settings, default ON), and
was verified against production. `src/maps.js` is the client;
`CLAUDE.md`'s "Photo-location enrichment" section is the architectural
reference. This file is the capability/billing ledger and the backlog.

## What a photo's GPS coordinates now buy (priority order, all implemented)

1. **Street View look-around** — the flagship. A free metadata call
   confirms coverage (and the panorama's capture date, shown in the UI
   step), then up to four 640x400 frames of that panorama (N/E/S/W) are
   fetched and attached to the message for vision models. Live result:
   models read storefront signage, name buildings, and describe layout
   ("black-and-white triangular pavement… KULTURHUSET banners") rather
   than guessing from training data.
   *Billing: $7/1k frames, Essentials SKU, 10k free/month — a photo
   question costs ≤4 frames.*
2. **Google Places nearby** — upgrades the free OpenStreetMap
   establishments list with ratings, review counts, open-now and
   permanently-closed status; OSM/Overpass remains the automatic
   fallback (knob off, no key, or Google failure).
   *Billing: **the field mask sets the SKU** — with rating/userRatingCount/
   currentOpeningHours included (as shipped) each call bills as Nearby
   Search **Enterprise** (~$40/1k, only 1k free/month); trimming those
   fields drops to Pro ($32/1k, 5k free). One call per photo location.
   Revisit the mask if volume ever approaches 1k photo-questions/month.*
3. **Area map** — one Maps Static road-map JPEG, marker per photo
   location, attached alongside the frames so the model has a spatial
   anchor (street names, what's around the corner). When a model's
   per-message image cap would squeeze it out, the last Street View
   frame yields its slot (`pickContextImages`).
   *Billing: $2/1k, Essentials SKU, 10k free/month.*

At this site's invite-only volume every tier rides inside Google's free
monthly caps — expected real cost ≈ €0. The binding constraint to watch
is the **Enterprise 1k/month cap** on the Places call.

## Hard-won constraints (encoded in code, don't rediscover)

- **Berget's Mistral Medium rejects >2 images per message** (400
  invalid_request; live-bisected 2026-07-07 — 2 images fine, 3 fail,
  while Kimi-K2.6 and gemma-4 take 4+). Encoded as `maxMessageImages`
  in `src/model-profiles.js`; `resolveModel` turns the failure mode into
  a clear client 400, `pickContextImages` keeps server-added imagery
  under the cap.
- Appended imagery is also bounded by Berget's ~1MB request ceiling
  (`imagesThatFit`), counting the user's own attachments first.
- Street View frames are only fetched after the FREE metadata endpoint
  confirms coverage — a photo in the wilderness costs zero paid calls.
- Only coordinates (plus the key) ever cross the wire to Google — never
  the photo, the question, filenames, or account identifiers.

## Deliberately not implemented (future candidates, in rough order)

1. **Multi-step street navigation** — "walk" along the street by
   re-fetching frames at stepped viewpoints (Static API supports it via
   repeated metadata+image calls along a bearing). Feasible with what's
   enabled today; costs ~4 frames per step and real latency, so it
   should be time-budget-gated like gap rounds. Build when a real use
   case shows up.
2. **Place Photos** — fetch an establishment's photo so a vision model
   can compare it against the user's picture ("is this that
   restaurant?"). Enterprise SKU, $7/1k, only 1k free/month.
3. **Maps Embed interactive panorama** — free with the key, but puts a
   Google iframe inside an auth-gated privacy-first app; the keyless
   Street View deep link already covers "let the user look around".
4. **Google Geocoding** — not wanted; Nominatim covers it keyless with
   a better privacy story.
