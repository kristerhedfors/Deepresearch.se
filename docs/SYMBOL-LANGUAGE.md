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

## 5. Selection and next steps

- The owner reviews the demos and picks one concept (or a combination — e.g.
  the Keeper's lamp as the persistent memory mark inside another concept's
  scene).
- Implementation then follows the umbrella conventions: a
  `public/js/…-intro.js` (or `public/rver/…`) module with a PURE timeline +
  geometry core (Node-tested like `umbrella-intro.test.js`), the DOM layer
  gated on first visit + `prefers-reduced-motion`, the admin `anim_speed`
  multiplier honored, and the per-task landing wired to the same completion
  signal the activity UI already has.
- FEATURES.md F-16 tracks the work; flip its status (and the
  `src/features.js` catalog mirror, same commit) when it ships.
