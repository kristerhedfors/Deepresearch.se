# Symbol language — the two tiers

The site speaks in symbols as well as words. This document records the symbol
language that already exists for DeepResearch.**Se/cure**, and the OPEN design
task (FEATURES.md **F-16**) of giving DeepResearch.**Se/rver** a sibling
language of its own — with four animated candidate concepts awaiting the
owner's pick in `docs/symbol-language/proposals.html`.

## 1. Why a symbol language

The project's mission is privacy research made *tangible* — the proof is the
site itself. The symbols carry that: they are not decoration for its own sake
but a second, wordless channel that tells the user something TRUE about the
tier they are standing in. The craft rules are the umbrella intro's rules
(`public/cure/umbrella.js`): plain canvas, no dependencies, a pure Node-tested
core under a browser-only DOM layer, tap-to-skip, `prefers-reduced-motion`
respected, and fail-soft — decoration must never cost a chat.

## 2. The established Se/cure language (shipped)

DeepResearch.**Se/cure** — the client-side tier at `/cure` — speaks:

- **The ghost** — anonymity. The secure-tier marker in BOTH tiers, each its
  own way (2026-07-12): on the blue tier a glow + shimmer sweep on the ghost
  button (which is the DOOR to /cure) — once a minute originally, stretched
  to once per THREE minutes 2026-07-15 ("lower the UX animation level"); on
  Se/cure the ghost character's contours glow and breathe while it floats
  (`ghost-contour`, `drc.css`, slowed to a 7.2 s breath the same day). The
  ghost HOLDS the umbrellas: anonymity carrying shelter.
- **The pink umbrellas** — shelter. The client side of the site is the
  sheltered side; the umbrella is its own symbol. Victorian, decorated,
  each one different (white-and-pink palette, motifs, beaded fringe).
- **The intro animation** (`public/cure/umbrella.js`) — the logotype's
  Swedish-flag vortex untwists into umbrella canopies, is drawn down to a
  wireframe, then revives in the tier's own pink — the brand literally
  transforming into the tier's symbol.
- **The landing** — an umbrella lands for every completed task: another
  piece of work finished under shelter. Completion has a shape, not just a
  checkmark.

Palette: khaki ground (`#c3b091`), pink/white canopies, ink contours.

## 3. The task (F-16): a symbol language for Se/rver

DeepResearch.**Se/rver** — the signed-in tier at `/rver` — has no symbol
language yet. The brief (owner directive, 2026-07-15):

1. **Positive.** The symbols celebrate; completion should feel good.
2. **It should TELL us something.** Each symbol must encode something true
   about what the server tier actually gives you that Se/cure structurally
   cannot: **memory** (accounts, saved history, cloud storage), **stewardship**
   (the server works on your behalf, watches over your data), **reach** (live
   web search, the full provider catalog, enrichments), **lift** (server-side
   compute carrying the heavy pipeline).
3. **Tied into a similar animation.** The same grammar as Se/cure's:
   a first-visit INTRO derived from the logo vortex (the brand transforms
   into the tier's symbol), a PER-COMPLETED-TASK landing event (the
   umbrella-landing counterpart), an AMBIENT idle state, and ideally a
   MASCOT counterpart to the ghost.
4. **Same craft rules** as §1 (canvas, pure core + tests, skippable,
   reduced-motion, fail-soft), and the blue tier's palette: sky `#6fc3fd`,
   ink `#0a2e5c`, accent `#0d4fa0`, plus the logotype's gold `#f5c518` and
   flag-blue `#1a56b0`.

## 4. The four candidate concepts (animated demos)

All four are animated, with a working per-task event, in
`docs/symbol-language/proposals.html` — open it in a browser (or via the
review artifact) and press "✓ complete a task" on each. Summary:

| # | Concept | Symbol | Tells you | Per-task event | Mascot |
|---|---------|--------|-----------|----------------|--------|
| A | **The Lift** | Hot-air balloons (gored like the umbrellas — the geometric sibling) | The server carries the load; work lifts you higher | Burner flares gold; the balloon rises a notch and hangs out a pennant | The pilot/balloonist |
| B | **The Keeper** | A lighthouse over a harbor | Stewardship: always on, watching, guiding work safely home; lamps stay lit = it remembers | A little boat sails in and docks; a lamp lights on the pier and STAYS lit | The lighthouse keeper |
| C | **The Star Chart** | A growing constellation | Memory: every task a fixed point of knowledge; the session literally draws your research map, and the sky keeps it | A star ignites and connects by a golden line to the previous one | The astronomer / the night sky itself |
| D | **The Messengers** | Homing doves and a dovecote | Reach: the server flies out to the world on your behalf and brings the answer home; the archive fills | A dove flies in with a golden scroll and files it in a pigeonhole | The dove (the outbound counterpart of the indoor ghost) |

Semantic pairing with Se/cure (always named first): the umbrella says
*"sheltered — nothing leaves"*; each candidate says the opposite half
truthfully — *"carried"* (A), *"watched over"* (B), *"remembered"* (C),
*"fetched for you"* (D).

## 5. THE DECISION (owner, 2026-07-15): the balloon — refined into the guide

The owner picked **A, the balloons** ("we like the balloons very much, they
still hover among the clouds") and REFINED the concept: no fleet, no separate
intro spectacle — **the balloon itself is the symbol**, one little balloon
playing on the blue side exactly the role the ghost plays on the secure side.
And a standing animation rule: **it swishes by clouds in ALL of its
transitions.**

**Round 4 (owner, 2026-07-15) re-scoped the figures on BOTH tiers: no site
has a persistent figure following the user around.** A tier's character
appears ONCE — for first-time visitors, right after the first-visit intro
animation — delivers a few pointers on how the tier works, and retires. On
Se/cure that was already the shape (the strolling ghost + the `#ghostsay`
greeter both chain onto the intro's one real play); on Se/rver the balloon
guide was converted from an always-mounted companion into the matching
one-shot GREETER. The same directive lowered the ambient UX animation level
overall (slower background wave drift, a rarer ghost-button shimmer, a
slower ghost-contour breathe).

The language, as shipped:

- **The balloon** (logotype gold-and-blue gores — the umbrellas' geometric
  sibling, powered and rising) appears among small clouds in the corner
  above the composer ONCE, chained onto the first-visit landing intro
  (§5b): the ghost's Se/rver counterpart as a greeter, not a companion.
- **The pointers**: a small speech bubble (plain text, `GREETER_LINES`)
  says what this tier does (live-web research, the time slider) and that
  the ghost button is the door to Se/cure. Any tap dismisses (UX-1); the
  script ends on its own either way.
- **The departure**: the balloon climbs up out of its box through a
  downward cloud swish (`departProgress`) and unmounts — returning
  visitors get a clean page.
- **Per completed task while it is on screen** (the pipeline's `done`
  event): the burner flares gold, the balloon climbs a notch, a pennant
  unfurls — clouds streak DOWNWARD (the relative motion of the climb). A
  no-op on every later visit; the everyday waiting/completion duty lives
  in the spinners (§5b/§6). Every move it makes goes through clouds.

Implementation (umbrella conventions): `public/js/balloon.js` — a PURE core
(envelope profile, hover/climb/pennant/flare params, deterministic
swish-cloud crossings, the greeter script + departure math; Node-tested in
`public/js/balloon.test.js`) under a browser-only DOM layer (one small fixed
canvas, `pointer-events:none`, `aria-hidden`, fail-soft everywhere, static
under `prefers-reduced-motion`, paused while the tab is hidden). Wired in
`app.js` (`showBalloonGreeter`, dynamically imported inside the landing
intro's `onDone` — the exact gate /cure uses for its strolling ghost) and
`stream.js` (`balloonTaskDone` on the `done` SSE event, a no-op once the
greeter has departed). Candidates B–D stay recorded in `proposals.html` for
the record; the "THE PICK" section there previews the guide concept.

### 5b. The landing animation + the waiting symbol (owner, 2026-07-15, round 2)

Two more pieces, completing the grammar so Se/rver mirrors everything
Se/cure's umbrella language does:

- **The first-visit LANDING intro** (`public/js/balloon-intro.js`): the same
  opening as Se/cure's — the logo vortex untwists from the top view — but it
  turns into **wire balloons**, and the camera then drops a full **180°**
  (twice the umbrella's quarter-lap): down past the side view and
  UNDERNEATH, **twisting sideways** as it descends (the roll crests mid-drop
  and settles into a slightly tilted horizon), clouds swishing up past the
  view (the guide's transition vocabulary — every transition goes through
  clouds). Color floods back on the way down: **five balloons, the SAME
  shape in different sizes** (the owner's call — sizes vary, the shape does
  not), baskets and rigging hang in, and the view ENDS from below — envelopes
  overhead, burners glowing warm in the mouths. Deliberately **faster** than
  the umbrella intro (~4.1 s real vs ~5.9 s; pinned by a unit test against
  `umbrella.js`'s own constants). Gated in `app.js` exactly like /cure's:
  once per browser (marked seen only after a real play), suppressed by
  reduced-motion and `/try` deep links, `?anim=1` / `?anim=rev` force a
  replay, the admin `anim_speed` multiplier honored.
- **The WAITING SYMBOL** (`public/js/balloon-spinner.js`): the blue tier's
  loading indicators (the typing indicator and the research step spinners —
  `turns.js` / `activity.js`) now play the balloon intro in miniature with
  the umbrella spinner's exact contract and boomerang discipline: the loop
  turns back JUST before the color revival, so the **colored balloon is the
  beat reserved for "done"** — completion speed-runs into the fully colored
  blue-and-gold balloon and folds it into a **BLUE ✓** (`--check-blue`,
  `app.css`), where Se/cure's umbrella folds into the pink one. The umbrella
  spinner remains Se/cure's own (`cure/drc.js` still mounts it).

Both reuse one renderer (`drawBalloonFigure`, exported by the intro) and the
umbrella spinner's pure boomerang/tumble clocks, so the tiers' symbols stay
siblings by construction.

Residual (F-16 stays 🟡 PARTIAL): live verification on real devices (iOS PWA
especially — intro, spinner finale, and the first-visit greeter alike). The
"speech bubble like the ghost's" duty landed with round 4: the greeter's
pointer bubble (§5).

## 6. Per-tier symbols + the privacy notice (owner, 2026-07-16, round 5)

Round 3 (2026-07-15) briefly made the symbols **per-task channel badges** —
umbrella = offline work, balloon = online work, in both tiers, with each
online step on Se/cure completing into a per-step ℹ disclosure. **Round 5
reverted that** (owner directive: "keep it stringent and clean with the
animations"): the animation is no longer a communication channel about data
exposure. The symbols are **tier identity**, full stop:

- **Se/cure = the umbrella.** Every /cure research step wears the pink
  umbrella spinner while it works and folds into the **pink ✓** when it
  completes (`cure/drc.js` phaseStep/finishCurPhaseStep). The umbrella
  spinner's `check` color option was removed (always pink again).
- **Se/rver = the balloon.** Every /rver step — the typing indicator and all
  research/sandbox steps — wears the balloon spinner and folds into the
  **blue ✓** (`turns.js` / `activity.js`). The balloon spinner's
  `finale: "info"` option was removed (always the ✓).

**The privacy communication moved into an INFORMATION NOTICE instead** — the
detail the per-step bubbles used to carry, in one readable place on Se/cure:

- The **privacy (i)** (`#privacybtn`) — an i-in-a-circle sitting right
  after the **Se/cure** wordmark in the header (2026-07-16 owner directive,
  superseding its first placement as an ℹ in the icon row: the tier's privacy
  marker belongs ON the name; the glyph was first an eye, swapped for the
  (i) by owner request 2026-07-17) — opens the **privacy notice** popover
  (`#privacypop`) any time: paragraphs laying out what THIS session's
  CURRENT configuration sends where — the model route (own key browser-direct
  / local or on-device "nothing leaves" / the borrowed proxy "the one
  server-touching path"), the web-search route (self-hosted / grant-metered /
  off), recall's embedding call, and the governance line for borrowed
  allowances (metered, time-limited, revocable, an off switch in Settings) —
  closing with a follow-on link to the full documentation (`/cure/help/`).
- **A shared secure workspace pops it up automatically** on unlock, leading
  with what the workspace link carried and that it was applied entirely in
  this browser — the arriving user reads up on the privacy of the specific
  workspace they were handed without going looking for it.
- The text is pure and Node-tested (`privacyNoticeLines`,
  `drc-page-core.js`); dismissal follows UX-1 (any outside interaction).
  The rule is codified as **UX-2** in the ux-conventions skill.

The standing per-provider line beside the model picker
(`providerVisibilityNote`) is unchanged — the notice is its long form.

## 7. Per-MODE symbols inside the Se/rver app (owner, 2026-07-19)

§2–6 give each TIER its symbol (Se/cure the umbrella + ghost, Se/rver the
balloon). But the Se/rver app is not one experience — it holds three chat
MODES picked from the dropdown (Normal / Introspection / SDK — `chat-mode.js`),
and the brief now extends the language INWARD: each mode is distinct in its own
way, along the same axes the tiers use — a **color theme**, an **animation**
(its waiting-symbol spinner), and **optionally a character** — plus a **side
panel** flavour.

The axes are codified as data in the **mode-theme registry**
(`public/js/mode-theme.js`): one descriptor per mode carrying its root class,
accent + ✓ color, `spinner`, `character`, and `panel`. The registry is the
single source the wiring reads (the spinner dispatch `mode-spinner.js`, the
drawer flavour in `history-ui.js`), and it is the **shape SDK mode distills
into** — a generated flavour defines its own descriptor, so "the goal of the
SDK mode itself is to create new themes of this kind" has a concrete schema to
fill. Craft rules are §1's, unchanged (pure core + Node tests, reduced-motion,
fail-soft, decoration never costs a chat).

As shipped:

- **Normal** — the tier default: the **balloon** spinner → **blue ✓**
  (`--check-blue`), plain history drawer, the balloon greeter (§5).
- **Introspection** — the **titanium** pane + **TIN**, the titanium mascot
  (`introspect-ui.js`), and a titanium-tinted drawer. It keeps the balloon
  spinner (its distinctness is the pane + character), so its ✓ stays blue —
  the canvas ✓ and the swapped-in real ✓ must agree; a dedicated titanium
  spinner is a drop-in in the registry later.
- **SDK** — the **plant**. SDK mode grows a new flavour of the site, so its
  symbol GROWS: the plant spinner (`public/js/plant-spinner.js`) drops a seed
  that **hits the ground**, **gets planted**, and boomerangs a settled sprout
  while work is ongoing — turning back JUST before real growth (the
  umbrella/balloon discipline: the good beat is reserved for "done"). The
  completion finale **grows it out** — stem, leaves, a gold-green bloom — and
  folds it into a **GREEN ✓** (`--check-green`). It reuses the umbrella
  spinner's boomerang/finale clocks, so all three symbols stay siblings by
  construction. SDK's **character** is **SPROUT** (`public/js/sdk-plant.js`):
  the ghost/balloon/TIN counterpart, a one-shot greeter the first time a user
  enters SDK mode, drawn with the SAME shared renderer (`drawPlantFigure`) as
  the spinner so the character and the waiting symbol are one plant. The green
  pane + `sdk studio` tag + the build-idea library in a green-tinted drawer
  complete the identity.

Semantic pairing, extending §4's: the umbrella says *"sheltered"*, the balloon
*"carried"*, the plant *"grown"* — SDK's honest half: a new, useful thing
distilled from the site and planted, live, at its own link.
