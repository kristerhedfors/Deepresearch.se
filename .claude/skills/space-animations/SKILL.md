---
name: space-animations
description: >-
  Load when working on the space-animations domain — the public playable
  wireframe-animation archive at /space/ (public/space/, the shared pure
  core public/js/space-core.js, the src/space.js façade, the space_feedback
  D1 queue) — adding or tuning a scene ("animation skill"), extending the
  EN+SV question matcher, changing the zoom/mesh/renderer behavior, or
  reading the gallery's feedback queue.
---

# Space animations — the /space/ archive

Full domain doc: `docs/SPACE-ANIMATIONS.md`. This skill is the working
checklist.

## The shape

- ONE shared pure core, `public/js/space-core.js` (the bash-core.js
  arrangement): scene registry `SPACE_SCENES`, matcher `SPACE_MATCHERS` +
  `spaceIntent`/`spaceIntentMatch` (the latter adds the matched language),
  log-zoom math, wireframe mesh builders, feedback validation. Node-tested
  in `public/js/space-core.test.js`. `src/space.js` re-exports it and adds
  the two endpoints.
- ONE embeddable renderer, `public/js/space-embed.js` (feedback #18): the
  playable canvas — stage + HUD + pointer interaction + the per-kind
  RUNNERS + the IntersectionObserver-gated play loop — behind
  `mountSpaceScene(host, sceneId, {lang, caption, moreLink})`, with
  self-injected `sp-` scoped CSS. The gallery mounts it per card; BOTH
  tiers' chats mount it across the response area when the outgoing
  question matches a scene (`turns.js mountSpaceEmbed` on Se/rver — live +
  stored renders, deterministic re-detection, no embeds-registry entry;
  `drc.js mountDrcSpaceEmbed` on Se/cure), answer streaming below.
- The page `public/space/` is PUBLIC (allowlisted in `src/assets.js` like
  /pulse/, including bare `/space`, the core module AND the embed module —
  the public-module-graph rule: forget the allowlist entry and the page
  dies with a 401'd import for signed-out visitors).
- `POST /api/space/feedback` is public and routed PRE-AUTH in
  `src/index.js` (next to /api/anim); rows carry scene + verdict + clamped
  comment, NO identity. Admin read: `GET /api/admin/space-feedback`
  (`?format=text` for loops), dispatched in `src/admin-api.js`.

## Load-bearing rules

1. **Only stars glow.** Additive light (drawGlow / the star field) is
   reserved for actual stars and the light pulse; bodies, craft, figures,
   terrain and rings stay unlit wireframe. Don't "improve" a scene with
   lighting.
2. **Real numbers.** Radii, orbit distances, periods and the zoom ranges
   are true values (`BODIES`, AU_KM, LIGHT_YEAR_KM). Enlarged-for-
   visibility craft are allowed but must keep true orbit altitudes and the
   corner scale-note must say so.
3. **EN+SV parity (invariant 6).** Every scene has Swedish matcher
   patterns with the same breadth as English, `[åa]`-classes for
   diacritic-dropped typing, and phrasings in the parity suite — the
   coverage test fails a scene that ships without them.
4. **Fail soft.** No D1 → feedback endpoints 503; the page (static assets)
   keeps working. Never let the feedback path break the gallery.

## Adding a scene (the short version)

Registry entry (bilingual, sound zoomKm) → matcher entry (EN+SV together;
include chat-style visual-ask phrasings — "show/visualize/animate …",
"visa/animera …" — so the chat embed fires too) → parity-suite phrasings
→ config for an existing `kind`, or a new runner in
`public/js/space-embed.js` RUNNERS + pure mesh builders in the core →
`npm test` → verify in a real browser (canvas bugs are invisible to unit
tests; a headless Playwright pass that scrolls each card and checks the
canvas painted non-blank catches most of it).

## Gotchas learned building it

- Keep number-grouping spaces in `formatKm` PLAIN spaces — a narrow
  no-break space (U+202F) sneaks in from copy-paste and breaks tests in
  ways invisible in a diff.
- Segments passing very near the camera project to multi-thousand-px
  streaks (worst on the moon-surface terrain); `drawMesh` culls any
  segment longer than 2600 px — keep that guard.
- The sun's glow radius must be capped (drawGlow clamps at 1600 px) or a
  close zoom builds a canvas-filling radial gradient every frame.
- Cards animate only while on screen (IntersectionObserver) — nine
  always-running canvases will melt a phone.
