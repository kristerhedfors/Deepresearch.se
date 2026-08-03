# Space animations — the playable wireframe archive at /space/

A public showcase surface (2026-07-24): an archive of playable 3D
animations, each answering one common space question, shown as a
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
| Shared pure core | `public/js/space-core.js` | The scene registry, the `spaceIntent` / `spaceIntentMatch` EN+SV matcher, zoom math (`zoomToDistance` / `distanceToZoom`), `formatKm`, all mesh builders, `validateSpaceFeedback`. Node-tested (`space-core.test.js`), no imports, served publicly (the page imports it — the /cure public-module-graph rule applies). |
| Embeddable renderer | `public/js/space-embed.js` | The playable canvas itself — stage, HUD, pointer interaction, the per-kind scene runners, a shared play loop with IntersectionObserver gating — behind one call: `mountSpaceScene(host, sceneId, {lang, caption, moreLink})`. Injects its own `sp-` scoped CSS, so any host page can mount a scene. Served publicly (the /space page statically imports it; both chats dynamic-import it). |
| The page | `public/space/index.html` + `public/space/space.js` | Markup/styling + the gallery chrome: cards mounting scenes via the embed renderer, chips, ask-box, language toggle, feedback POST. |
| Chat embeds | `public/js/turns.js` `mountDemoEmbed` (Se/rver) · `public/cure/drc.js` `mountDrcSpaceEmbed` (Se/cure) | A chat question that matches a scene mounts the animation across the response area, above the streamed answer — see "The chat embed" below. |
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

The ten shipped scenes: sun-vs-planets (compare), earth-moon,
solar-system, iss-orbit, satellites (orbits), rocket-launch (launch —
gravity turn + stage separation, over a visibly curved Earth),
starship-launch (launch — hot-staging and a tower catch; see below),
moon-surface (surface — terrain,
astronaut, lander, Earth in the sky), saturn-rings (rings — particles at
Kepler speeds), nearest-star (travel — the Solar System shrinking toward
Proxima, with a light pulse crawling the 4.25 ly).

Both launch scenes share the one `launch` runner, and everything specific to
Starship hangs off its `config` — `craft: "starship"`, `tower`, `catchT`,
`catchCamKm`. A launch scene with none of those keys renders exactly as
rocket-launch always did. Add the next launch variant the same way; do not
fork the runner.

`SPACE_MATCHERS` is the deterministic question gate: first match wins, and
per invariant 6 every scene has Swedish patterns with the same breadth as
the English ones — definite forms, synonyms, and `[åa]`-class tolerance
for diacritic-dropped typing ("hur langt bort ar manen" matches). The
parity unit test walks EN and SV phrasings for every scene and also fails
if a new scene ships without parity coverage. Since feedback #18 the sets
also carry chat-style visual asks — "show a moonshot from space between
earth and moon", "show a rocket launching into space", "visa jorden och
månen" — with a guard keeping the bare "moonshot" metaphor out (it needs a
space word alongside). `spaceIntentMatch` returns `{ id, lang }` so a
mount can pick its caption language from which pattern set fired.

Feedback #50 (2026-07-29) added the DEMO phrasings to `rocket-launch`. A demo
session typed "Space launch demo", matched nothing — the set had `rocket
launch` but not `space launch` — and got a web-research pass that invented a
launch dataset in the sandbox instead of the animation that answers it. The
new patterns are `space launch`, `orbital launch`, and `launch
demo|animation|simulation|sequence` when a space word sits beside it (a
product launch demo is not this scene), with `rymduppskjutning`,
`raketanimation` and the `uppskjutning`+demo forms as the Swedish parity set.

Feedback #53 (2026-07-30) added the `starship-launch` scene. The same session
that liked the rocket animation typed "Now launch a starship", matched nothing
at all, and got a web-research pass that opened by apologising for being unable
to launch rockets — one turn after the site had animated exactly that. Two
things were missing: a gate (there was no Starship subject anywhere) and a
scene, because Starship is not the generic rocket. Nothing is discarded, and
the booster comes home. The matcher is registered AHEAD of `rocket-launch` so
the specific subject wins when a question names both, and its two broad
patterns carry the sci-fi guard as a LEADING lookahead over the whole message:
"the starship Enterprise launches" puts the disqualifying word before the
trigger, where a trailing lookahead would never see it.

The camera needed a cut. Staged naively it followed the Ship throughout, so the
tower catch, the beat the scene exists for, played out a thousand kilometres
off-frame. `isCatchView`/`boosterReturnState` move the view and the dolly onto
the returning booster for the descent and back afterwards, the way a launch
broadcast does. Ground structures also take a size cap (`R * 0.015`): held at
constant SCREEN size like the craft, the tower became a 1,000 km spike off
Earth's limb once the orbit reveal pulled the camera out to 21,840 km.

### The separation frame (feedback #58, second report)

The same session came back with *"separation seems to drop the front part, the
starship rather than the stage below"* — and it was reading the animation
correctly. The runner flies ONE trajectory point and that point is the STACK's
base, so when the drawn mesh switched from the full stack to the Ship alone,
the Ship was re-anchored from 0.57 of the stack up down to the base: it fell
more than half its own length in one frame, straight through the booster drawn
at that same point. `upperStageBaseFrac` and `craftBaseOffset` are the fix —
the seam the stack is built at, applied as an offset along the vehicle's axis
once the lower stage is gone. Both launch scenes had it; nothing about the
trajectories was ever wrong (the Ship's altitude leads the booster's from the
separation instant onward), only where the vehicle was drawn.

Looking at that frame turned up a second defect in the same beat. The booster's
boostback flip was applied with `tilt` — `rotX`, which turns ACROSS the flight
plane — so a booster that should have parted along the stack's 77°-over
attitude stood bolt upright at separation and only leaned toward the camera
thereafter. `drawMesh` grew a `roll` option (`rotZ`, the plane the scenes
actually fly in) and `boosterRollAngle` owns the attitude: the stack's own
angle at k=0, past engines-first for the burn, upright from `BOOSTER_UPRIGHT_K`
so it has descent left to fall rather than snapping vertical at the catch.

The same frame also had the exhaust plume drawn straight down the SCREEN, so
it pointed off into space the moment the craft pitched over; it trails along
the vehicle's axis now, from whichever stage is burning.

Two workers fixed the drop independently within minutes of each other, on the
same feedback thread: `claude/space-launch-feedback-euzzwg` (merged as PR #344,
which also fixed the plume) and `claude/starship-stage-feedback-6jqm1p` (which
also fixed the attitude). They agreed on the diagnosis and differed only in
where the offset lived — stored on the mount state as a constant, or derived in
the core from the mesh. Reconciled to the core function, because that is the
version a unit test can check against the stack's own vertices, keeping both
extra fixes. Worth knowing for the next time this happens: git merged the two
offsets TEXTUALLY, which applied the lift twice and looked plausible in the
diff. Two independently correct fixes to one line of geometry do not compose.

Method note: the fix and the defect it exposed were both found by freezing the
loop (`st.playing = false; st.u = …`) and screenshotting either side of
`stageT` on a deliberately oversized canvas — the craft draws at a constant
SCREEN fraction, so a bigger canvas is the only way to zoom in on it. The unit
tests derive the offset from the stack mesh's own vertices rather than a copy
of the constant, so the drawn position and the drawn shape cannot drift apart.

## The chat embed (feedback #18)

Both tiers' chats run the same gate on every outgoing question — since
feedback #49 through the capability-demo registry `public/js/demo-core.js`,
which delegates all space subject matching straight back to `SPACE_MATCHERS`
(one space matcher, no drift) and adds two things around it: page surfaces,
which mount as a link card rather than a canvas, and `priorText` — a bare
"show me visually" inherits the subject of the turn
before it, which is how feedback #50's real sequence ("Space launch demo" →
"Show me visually") reaches the launch scene. On a match,
the scene mounts full-width at the top of the response area — the playable
canvas with HUD and corner notes, the scene's curated bilingual `reply` as
a caption, and a link to the `/space/` archive — while the research answer
streams below it. The animation adds to the answer; it never replaces it.

- Se/rver: `public/js/turns.js` `mountDemoEmbed`, called on the live send
  (`stream.js`, skipped in Agent Studio) and on stored-conversation
  renders. The mount is DERIVED from the question by re-detection — no
  embeds-registry entry — so reloaded and pre-feature conversations get it
  too.
- Se/cure: `public/cure/drc.js` `mountDrcSpaceEmbed`, same rule on the live
  send and in `renderMessages`. The renderer is a same-origin static asset,
  so the server stays out of the data path.
- The renderer is dynamic-imported in both chats: conversations that never
  ask about space never load it.

### The answer model is told the animation is there (feedback #46)

The mount is client-side, so for a long time the model writing the reply had
no idea a scene was playing beside it. Asked to "show me a rocket launch to
space" it mounted the launch animation and then answered "I can't play videos
… or display media from the web" — reading that straight off its own
capabilities line.

`runPipeline` now re-runs the SAME gate over the SAME latest user message
(through `demoSurfaces`, and so through the same registry the clients mount
from) and puts the matched scene's title on the context as `ctx.spaceScene`. The three answer phases — `synthPrompt`, `directPrompt`,
`searchOffPrompt` — take it as an option, and `capabilitiesTail` swaps the
"does NOT … display media" sentence for a clause naming the scene on screen
and telling the model to write the explanation that goes with it. Empty
string is the default everywhere, so a question that matches no scene
produces a byte-identical prompt to before.

Because both sides call one shared core over one piece of text, the server's
belief about what is on screen cannot drift from what the client mounted.

## The launch scene's planet and camera (feedback #46)

The `launch` runner is the one scene drawn from close to a planet's surface,
and that makes it the one place the archive's usual shortcuts fall over. A
user who asked to be shown a rocket launch reported seeing no Earth at all:
the planet was a single thin arc with the starfield painting straight through
it, indistinguishable from the dashed orbit ring above it, and the camera sat
1400 km out where a 6371 km sphere barely curves.

Three pieces fix it, all pure and Node-tested in `space-core.test.js`:

- **`spherePatchGrid`** — a lat/long patch centred on the pad, in true sphere
  coordinates. The ground curving away to the horizon is what reads as a
  planet; a bare silhouette never will. `surfaceGridFor` (in the renderer)
  sizes the patch to the camera and caches it per octave, because one spacing
  cannot serve both ends of the flight: on the pad the horizon is ~900 km
  away and a coarse grid puts no line inside it, while from orbit a fine one
  is a solid smear.
- **`sphereSilhouette`** — the true horizon: the tangent circle R²/D from the
  centre towards the camera, radius R·√(1−R²/D²). The old flat 2D circle of
  radius R is only correct looking straight down the axis, so as soon as the
  view was rotated the ground grid crossed its own horizon. The same call
  draws the Kármán line at 100 km and the target-orbit ring, each labelled —
  and the labels are placed in priority order with a minimum gap, since
  zoomed out all three shells land within a few pixels of each other.
- **`facesCamera`** — back-face culling for the grid. Without it the far half
  of the patch draws over the near half and the ground reads as a tangle.

**`launchCamDistKm`** flies the camera instead of leaving it fixed: close
enough at the pad to see ground under the rocket, widening with altitude,
then pulling back after insertion until the closed orbit fits the frame —
"a launch from earth and then out to orbit", which is what the user expected
to see. It drives `st.camDist` directly and the HUD readout follows it. The
viewer always wins: touching zoom, pinch or wheel clears `st.autoZoom` for
good (`takeZoom`), and only the reset button restores it.

Two guards carry over from the rest of the renderer and are easy to lose when
editing this scene: hand-rolled polylines need the same >2600 px segment cull
`drawMesh` applies, and nothing here may use `drawGlow` — the ground, the
horizon and the shells are all unlit wireframe.

## The ascent profile (feedback #58)

The flight is two exponents on the same ascent fraction `x = u / insertT`:
altitude climbs as `x^LAUNCH_ALT_EXP`, ground track as `x^LAUNCH_TURN_EXP`.
The **gap between them is the gravity turn** — pitch from vertical is
`atan(k · x^(TURN − ALT))` — so tuning the turn means moving the gap, not
either exponent alone.

The first pair (1.7 and 2.3) left a gap of 0.6, which put the vehicle 45°
over by 2% of the ascent and 68° by 10%: a kink a few kilometres off the pad,
reported as *"starship turns to[o] early after launch to[o] a steep angle. It
should turn gradually."* At 1.4 and 3.2 the stack leaves the pad vertical,
leans ~15° at 8 km, ~43° at 21 km and ~77° at hot-staging.

What keeps the turn from drifting again:

- **One ground track.** `launchGroundAngle` is the only definition, read by
  the craft, its trail and `boosterReturnState`. The exponent used to be a
  literal `2.3` written out in both the renderer and the booster's return, so
  changing the turn in one place would have flown the booster home to a spot
  the Ship never left from.
- **The tests assert on degrees, not exponents.** Nothing draws with
  `launchPitchDeg`; the renderer orients the craft along its own velocity. But
  the pitch is what a viewer sees, so the pitch is what gets pinned.
- **Event times are read off the altitude.** `stageT` is set so hot-staging
  happens at the ~70 km the Starship scene's own reply claims, and a test
  reads that altitude back out of the profile.

Craft are drawn at a constant fraction of the camera distance, so they hold
one screen size the whole way up. At 0.045 that was ~18 px on a phone — a
smudge, which is what *"it doesn't look like starship plus booster"* is
describing. It is 0.1 now (~40 px), capped at 8% of the planet's radius so
the same rule cannot draw a 1,500 km rocket across Earth once the orbit
reveal pulls the camera out. The trajectory point is the craft's **base**:
centring the mesh on it sank half the stack under the pad at liftoff, which
only became visible once the craft was big enough to see.

At that size the silhouette does all the explaining, so the geometry has to be
both right and broadside:

- Both stages are **9 m across**. The booster's radius was written as the
  diameter fraction (9/71 rather than 4.5/71), so it drew twice the Ship's
  width and the stack stopped looking like one vehicle.
- The Ship's flaps and the booster's grid fins sit on **±x**, the plane the
  launch camera looks across and the craft pitches in. On ±z (and at 45°)
  they foreshortened into the barrel and the vehicle lost every feature that
  names it.
- The **hot-stage vent ring** stands proud of the booster's top, which draws
  the seam between the two stages on the full stack.
- The catch tower is set back along the ground by its own arm reach, so the
  tower and the stack do not draw through each other at liftoff — and the
  returning booster lands in the arms rather than inside the mast.
- **Separation lifts the upper stage** to the seam it sat at on the stack
  (`craftBaseOffset`) and the booster parts holding the stack's own attitude
  (`boosterRollAngle`) — "The separation frame" above has the whole story.
- The **exhaust** burns from `craftPos`, whichever stage that currently is, and
  trails along the vehicle's own axis rather than straight down the screen,
  which pointed off into space as soon as the craft was pitched over. It needs
  no staging logic of its own: the offset moves the craft, and the plume
  follows the craft.

## Pinch to zoom (feedback #58)

The pinch is read from **touch events**, not from a second pointer. iOS
Safari treats a second finger on the canvas as a page gesture: it fires
`gesturestart` and **cancels** the pointers, so a pointer-pair pinch never
runs there, and `touch-action: none` does not help: WebKit keeps pinch-zoom
available whatever the page asks. `touchmove` keeps firing throughout, and
`preventDefault()` on it is what stops the page zooming instead of the scene.
WebKit's `gesture*` events are handled too, as a backstop and to swallow the
page zoom; they stand down while `touchmove` is driving. The old pointer-pair
path is gone rather than kept beside them: on Android both families fire and
it would have doubled every pinch.

## Adding a scene

1. Add the registry entry (both languages, sound `zoomKm`) and its
   `SPACE_MATCHERS` entry — EN and SV patterns together, never
   English-first.
2. Add the EN+SV phrasings to the parity suite in
   `public/js/space-core.test.js` (the coverage test fails until you do).
3. If the scene fits an existing `kind`, `config` is all it needs. A new
   kind = a runner in `public/js/space-embed.js`'s `RUNNERS` plus whatever
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
