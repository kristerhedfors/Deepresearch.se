# Space animations — the playable wireframe archive at /space/

A public showcase surface (2026-07-24): an archive of playable 3D
animations, each answering one common space question, presented as a
scrollable gallery of question→reply cards with a feedback button on every
card. The page is `/space/`, allowlisted like `/pulse/` — no account, no
identity, nothing user-specific.

The reason the domain exists is scale. Questions like "how far away is the
Moon?" or "how big is the Sun?" have answers no static picture can carry,
because the honest numbers span five orders of magnitude. So every scene
gets a LOG-SCALE zoom slider between a scene-specific minimum and maximum
camera distance — from 12 meters above the lunar regolith to 9.5 × 10¹³ km
(past Proxima Centauri) — and the sizes and orbit radii fed to the renderer
are the real ones. Where honesty would make a thing invisible (the ISS is
109 m long next to a 6,371 km planet), the craft is drawn enlarged and the
canvas says so in the corner note.

## The rendering rule

Only stars emit light. Background stars, the Sun, Proxima Centauri and the
traveling light pulse in the nearest-star scene get real additive glow
(canvas `lighter` compositing over radial gradients). Everything else —
planets, moons, rockets, satellites, the astronaut, the lander, the
terrain, Saturn's rings — renders as unlit 3D wireframe. That contrast is
the page's visual identity; keep it when adding scenes.

## Layout

| Piece | Where | What |
|---|---|---|
| Shared pure core | `public/js/space-core.js` | The scene registry, the `spaceIntent` EN+SV matcher, zoom math (`zoomToDistance` / `distanceToZoom`), `formatKm`, all mesh builders, `validateSpaceFeedback`. Node-tested (`space-core.test.js`), no imports, served publicly (the page imports it — the /cure public-module-graph rule applies). |
| The page | `public/space/index.html` + `public/space/space.js` | Markup/styling + the canvas renderer and gallery glue: per-kind scene runners, pointer interaction, HUD, language toggle, ask-box, feedback POST. |
| Server façade | `src/space.js` | Re-exports the core; owns `POST /api/space/feedback` (public) and `GET /api/admin/space-feedback` (admin, `?format=text`). |
| Storage | `src/db.js` `space_feedback` | One row per verdict: ts, scene, verdict, comment. Deliberately no identity column. |

## The scene registry — one "animation skill" per question

`SPACE_SCENES` in the core is the archive. Each entry carries:

- `id`, `kind` (which renderer runs it), `emoji`
- `title`, `question`, `reply` — each `{ en, sv }`, both languages required
  (`validateScene` fails the unit test otherwise)
- `zoomKm` — `{ min, max, start }` camera distances; the slider
  interpolates logarithmically between min and max
- `config` — kind-specific (bodies to compare, orbiter lists with real
  `orbitKm`/`periodDays`/`inclinationDeg`, ring extents, star distance…)

The nine shipped scenes: sun-vs-planets (compare), earth-moon,
solar-system, iss-orbit, satellites (orbits), rocket-launch (launch —
gravity turn + stage separation), moon-surface (surface — terrain,
astronaut, lander, Earth in the sky), saturn-rings (rings — particles at
Kepler speeds), nearest-star (travel — the Solar System shrinking toward
Proxima, with a light pulse crawling the 4.25 ly).

`SPACE_MATCHERS` is the deterministic question gate: first match wins, and
per invariant 6 every scene has Swedish patterns with the same breadth as
the English ones — definite forms, synonyms, and `[åa]`-class tolerance
for diacritic-dropped typing ("hur langt bort ar manen" matches). The
parity unit test walks EN and SV phrasings for every scene and also fails
if a new scene ships without parity coverage.

## Adding a scene

1. Add the registry entry (both languages, sound `zoomKm`) and its
   `SPACE_MATCHERS` entry — EN and SV patterns together, never
   English-first.
2. Add the EN+SV phrasings to the parity suite in
   `public/js/space-core.test.js` (the coverage test fails until you do).
3. If the scene fits an existing `kind`, `config` is all it needs. A new
   kind = a runner in `public/space/space.js`'s `RUNNERS` plus whatever
   mesh builders it needs in the core (pure, deterministic, tested).
4. `npm test`, then verify in a real browser — canvas code has failure
   modes unit tests can't see (the live-verify discipline).

## Feedback loop

Every card asks "Was this animation helpful?" — 👍/👎, an optional comment
(clamped at 500 chars), POSTed to `/api/space/feedback`. The page is
public, so the endpoint is too; the row carries scene id + verdict +
comment and nothing else. A localStorage marker keeps a browser from
double-submitting the same scene.

Operators read the queue at `GET /api/admin/space-feedback` — JSON with
per-scene tallies, or `?format=text` for agent loops:

    curl -s "https://deepresearch.se/api/admin/space-feedback?format=text" -H "Cookie: …"

Downvoted scenes are tuning targets: fix the scene, don't argue with the
tally. No D1 → the endpoints 503 while the animations (static assets) keep
playing.
