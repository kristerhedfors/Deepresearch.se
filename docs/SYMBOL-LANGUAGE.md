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
  own way (2026-07-12): on the blue tier a once-a-minute glow + shimmer sweep
  on the ghost button (which is the DOOR to /cure); on Se/cure the ghost
  character's contours glow and breathe while it floats (`ghost-contour`,
  `drc.css`). The ghost HOLDS the umbrellas: anonymity carrying shelter.
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
that follows you around as the tier's guide, exactly the role the ghost plays
on the secure side. And a standing animation rule: **it swishes by clouds in
ALL of its transitions.**

The refined language, as shipped:

- **The balloon** (logotype gold-and-blue gores — the umbrellas' geometric
  sibling, powered and rising) hovers among small clouds in the corner of the
  app above the composer: the ghost's Se/rver counterpart, always with you.
- **Per completed task** (the pipeline's `done` event): the burner flares
  gold, the balloon climbs a notch (capped so it stays in its corner), a
  pennant unfurls under the basket — and clouds streak DOWNWARD past it (the
  relative motion of the climb).
- **All other transitions** — appearing at boot, resetting for a new chat
  (the pennant tail belongs to the conversation) — clouds swish PAST it
  sideways. Every move the guide makes goes through clouds.

Implementation (umbrella conventions): `public/js/balloon.js` — a PURE core
(envelope profile, hover/climb/pennant/flare params, deterministic
swish-cloud crossings; Node-tested in `public/js/balloon.test.js`) under a
browser-only DOM layer (one small fixed canvas, `pointer-events:none`,
`aria-hidden`, fail-soft everywhere, static under `prefers-reduced-motion`,
paused while the tab is hidden). Wired in `app.js` (`initBalloonGuide` at
boot, `balloonReset` on new chat) and `stream.js` (`balloonTaskDone` on the
`done` SSE event). Candidates B–D stay recorded in `proposals.html` for the
record; the "THE PICK" section there previews the guide as shipped.

Residual (F-16 stays 🟡 PARTIAL): live verification on real devices (iOS PWA
especially), and any grown-up guide duties (a tap-to-explain bubble like the
ghost's, per the ux-conventions registry) if the owner wants them.
