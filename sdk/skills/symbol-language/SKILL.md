---
name: symbol-language
description: >-
  Load when designing or extending a generated agent pair's VISUAL IDENTITY
  SYSTEM — per-tier palettes and symbol characters, first-visit intro
  animations, waiting symbols and completion marks, the per-task
  offline/online channel grammar with its disclosure notices, the wordmark
  slash-spacing discipline, or the numbered UX-conventions registry — or when
  wiring ANY new interactive surface (popover, speech bubble, explainer,
  gesture, dismissal) that must match the pair's established feel. The
  symbols are a design LANGUAGE, not decoration: each one states something
  true about where the user's data goes, so this module is the privacy
  mission rendered visible. Also load when a wordmark slash "touches the
  letters" or an animation feels too busy — the measurement tools and the
  low-animation directive live here.
---

# Symbol language — the pair's visual identity as a truth channel

Give the pair a visual identity SYSTEM: per-tier palettes, per-tier symbol
characters, one shared animation grammar, a wordmark discipline, and a
numbered registry of interaction conventions. The load-bearing idea: the
symbols are a second, wordless channel that tells the user something TRUE
about the tier they are standing in and the task they are watching — above
all, whether work left their device. Decoration that means nothing is cut;
decoration that answers "did this cross the network?" at a glance is the
privacy mission made tangible.

## Capability class & tier story

**Class X — shared substrate.** Every animated piece follows one craft
split: a PURE timeline/geometry core (Node-tested — phase marks, easing,
projection math, deterministic particle crossings, script/departure
contracts) under a browser-only DOM/canvas layer that is fail-soft
(decoration must never cost a chat), respects `prefers-reduced-motion`
(static or suppressed), is tap-to-skippable, and carries a watchdog so a
stuck animation can never wedge the page. Both tiers speak the same grammar
with their own vocabulary:

- **The client tier** owns the "sheltered" symbol (reference: the pink
  umbrella) — its intro, its waiting spinner, its completion mark — plus the
  secure-marker character (the ghost) rendered as a living figure.
- **The server tier** owns the "carried/reach" symbol (reference: the
  gold-and-blue balloon) — a sibling intro derived from the same logo
  transformation, its own spinner and completion mark — and renders the
  secure marker its own way (a rare glow on the button that is the DOOR to
  the client tier).
- **Both tiers** share the per-task channel grammar: the offline symbol on
  work that stays on-device, the online symbol on work that crosses the
  network — regardless of tier.

## Contracts

- **PA-4 made visible** — the channel grammar is the privacy split rendered:
  every online phase on the client tier completes into a tappable ℹ
  disclosure stating exactly what that task sent, to whom, on whose
  credential. Unknown phases classify as ONLINE — over-disclosing is the
  safe failure; a "local" badge on an online task is a small lie.
- **PA-2** — every DOM layer is fail-soft and `pointer-events:none` where it
  overlays the app; an animation error degrades to nothing, never to a
  broken chat.
- **PA-7** — timeline/geometry/script logic lives in pure Node-tested cores;
  sibling symbols share renderers and clocks by import so the tiers stay
  siblings by construction, not by imitation.
- **PA-10** — spacing and pacing are MEASURED, not eyeballed: the slash gap
  with a headless-browser ink meter, intro durations pinned by unit tests
  against the sibling's own constants, and everything user-visible confirmed
  on real devices.

## Build plan

1. **Name the pair and its wordplay FIRST** (see the pair-generator skill —
   it flows into everything here). Fix the display convention: full form
   CamelCase with the bold wordplay tail, short form the slashed tail alone,
   functional URLs lowercase, and the client tier ALWAYS named first when
   the two appear together. Internal code names never reach user copy.
2. **Per-tier palettes.** One small set of CSS variables per tier (the
   reference: khaki ground + pink/white canopies for the client tier; sky
   blue + ink + accent + the logotype's gold for the server tier), plus a
   per-tier completion-check color. Theme every symbol from the variables so
   a palette change is one edit.
3. **The wordmark slash discipline.** Wrap the wordmark slash in a span
   (`.sl`) pulled toward its neighbours with a negative margin so the
   wordplay reads as ONE word. The correct margin is FONT-DEPENDENT (bold
   ink is wider; families differ), so build the ink meter: a script that
   renders each run in headless Chromium and measures the true minimum ink
   distance by per-pixel-row edge scanning (bounding boxes are useless — a
   diagonal slash's box overlaps long before ink touches; and the span
   boundary breaks kerning, so the gap varies LINEARLY with the margin and
   the tool can solve for the recommendation directly). Codify a gap band
   (reference: floor 0.03em/side, target 0.06em, loose past 0.12em) and the
   decision rule: least tightening the worst-case font in the surface's
   real stack needs, rounded, resolved toward loose. Overrides are SCOPED
   next to the surface's own rule (e.g. `b .sl { … }`), never a change to
   the global default. Plain text (docs, commits, prompts) never tightens.
4. **The secure marker, rendered per-tier.** One character means "the
   secure tier exists" in BOTH tiers, each its own way: a living figure on
   the client tier; on the server tier a rare glow/shimmer on the control
   that navigates to the client tier. The marker doubles as the door.
5. **First-visit intros — the brand becomes the symbol.** Each tier gets a
   one-shot intro where the logotype transforms into the tier's symbol
   (reference: a logo vortex untwisting into wireframe umbrellas /
   balloons, color flooding back). Craft contract: pure timeline core with
   ordered, monotonic phase marks (unit-tested); tap-to-skip; a watchdog;
   reduced-motion suppression; a forced-replay URL param; an admin speed
   multiplier; the seen-key set only AFTER a real play. Make the two intros
   siblings with deliberate contrast (the reference pins the server tier's
   intro FASTER than the client tier's by a unit test against the sibling's
   own constants).
6. **Greeters: first-visit-only, never persistent.** If a tier has a
   mascot/figure, it appears ONCE per browser — chained onto the intro's
   real play, never a routine boot — speaks a few pointer lines about how
   the tier works (including that the marker is the door to the sibling
   tier), then retires and UNMOUNTS completely (timers, listeners, DOM all
   cleaned). Any tap dismisses early. This is a hard directive in the
   reference (no persistent figure following the user around); returning
   visitors get a clean page.
7. **Waiting symbols as boomeranged miniature intros.** Each tier's loading
   spinner replays its intro in miniature and turns back JUST before the
   color revival — the fully colored symbol is the beat RESERVED for
   completion. Completion then speed-runs into the colored symbol and folds
   it into the tier's checkmark. Reuse the intro's renderer and the sibling
   spinner's boomerang/tumble clocks by import.
8. **The per-task channel grammar.** Classify every pipeline phase/step as
   OFFLINE (runs entirely on-device — wears the sheltered symbol, in BOTH
   tiers: an in-browser sandbox step on the server tier still wears it) or
   ONLINE (crosses the network — wears the carried symbol, on the client
   tier too: browser-direct provider calls, granted search, embedding calls
   are honest exceptions to "nothing leaves"). Classification is a pure
   Node-tested function per tier; **unknown defaults to ONLINE**. Completion
   splits by tier: the server tier folds everything into its plain check
   (it already assumes cloud); the client tier folds a local step into its
   check but an ONLINE step into a tappable **ℹ notice** whose bubble
   states what that task sent, to whom, on whose credential — computed by a
   pure `disclosureText(phase, ctx)` from SEND-TIME context (provider
   label, borrowed-grant flag, search route, embed provider) captured where
   the send resolves them. The bubble follows the registry's dismissal rule.
9. **The low-animation directive.** Ambient always-running motion stays LOW:
   background drifts slow enough to barely register, marker events rare
   (minutes apart, seconds long), breathing loops slow. Functional motion —
   spinners, per-task finales — is exempt: it communicates state. When in
   doubt, slower and rarer; the reference lowered every ambient cycle on an
   explicit owner directive after shipping busier versions.
10. **The numbered UX-conventions registry.** Keep one registry file of
    codified interaction rules — precise "when X → then Y" statements no
    unit test catches, each with a one-line WHY and the `file:line` of its
    canonical implementations. Seed it with the dismissal rule (a transient
    speaker bubble dismisses on ANY outside interaction while interactive
    content inside stays clickable: outside-closer bound ONCE on a
    persistent element, containment + opener exclusion, one bubble at a
    time, `click` vs capture-phase `pointerdown` chosen by whether dismiss
    must beat the underlay), the channel-grammar rule (#8), and the
    greeter rule (#6). **ADD an entry whenever a new UX decision is made**
    — consult the registry BEFORE wiring any new interactive surface and
    copy the nearest canonical implementation instead of reinventing a
    slightly different feel.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| The whole language, decisions + grammar record | `docs/SYMBOL-LANGUAGE.md` |
| Client-tier intro (logo → umbrellas; pure core + DOM) | `public/cure/umbrella.js` (tested via `public/js/umbrella-intro.test.js`) |
| Server-tier intro (logo → balloons, 180° drop, faster-pinned) | `public/js/balloon-intro.js` (+ `.test.js`) |
| Greeters (balloon guide; strolling ghost) | `public/js/balloon.js` (+ `.test.js`), `public/cure/ghostwalk.js`, gates in `public/js/app.js` / `public/cure/drc.js` |
| Waiting symbols (boomerang + per-tier finale) | `public/js/balloon-spinner.js`, `public/js/umbrella-spinner.js` |
| Channel classification (pure) | `public/js/drc-page-core.js` (`phaseChannel`, `disclosureText`), `public/js/activity-core.js` (`stepIsLocal`) |
| ℹ disclosure notice UI | `public/cure/drc.js` (`addLeakNotice`, `sendCtx`), `public/cure/drc.css` (`.notice`, `.leak-note`) |
| Secure marker per tier | ghost button glow in `public/css/app.css`; `ghost-contour` in `public/cure/drc.css` |
| Slash ink meter + gap band + audit table | `scripts/slash-gap.mjs`, `.claude/skills/slash-spacing/SKILL.md` |
| Wordmark renderer for JS-built prose | `public/js/drc-page-core.js` (`wmHtml`) |
| UX registry (dismissal, channel badge, greeter rules) | `.claude/skills/ux-conventions/SKILL.md` |
| Ambient animation levels | `public/css/app.css` (`bg-drift`, ghost cycles), `public/cure/drc.css` |
| Naming/ordering convention | CLAUDE.md branding rule (CamelCase tail, secure-first) |

## Acceptance checklist

- [ ] Pure timeline/geometry cores green: phase-mark ordering and
      monotonicity, projection math, greeter script + bounded
      stay/departure, spinner boomerang turning back before the color beat.
- [ ] Channel classification unit-tested per tier; unknown phase asserts
      ONLINE; every online phase on the client tier has a disclosure text.
- [ ] Intros: tap-to-skip works, watchdog fires on a stalled frame,
      reduced-motion suppresses the auto-play, seen-key only after a real
      play, forced-replay param works.
- [ ] Greeter unmounts completely after departing; a returning visitor's
      page mounts no figure (verified live).
- [ ] Every surface rendering the wordmark slash has a MEASURED margin
      within the gap band for its real font stack (run the ink meter);
      bold contexts have scoped overrides.
- [ ] The UX registry lists every codified rule with canonical `file:line`
      references, and the newest UX decision in the change is registered.
- [ ] Animations never appear in an error path (grep the fail-soft wrapping
      around every DOM feed/mount).

## Pitfalls

- **Bold ink touches at the regular-weight margin.** The reference's global
  `-.12em` was eye-tuned for regular weight; dropped into bold it made the
  slash touch the letters on a real device (the 2026-07-16 report that
  created the measurement discipline). Never inherit a slash margin into a
  new font context blind — measure. Note the recommended margin can even be
  POSITIVE (one reference surface needed MORE space).
- **Bounding boxes lie about diagonal glyphs** — only a per-pixel-row ink
  scan measures what the eye sees; and container fonts are proxies for the
  user's real system fonts, so keep an on-device confirmation step for
  anything user-visible.
- **Persistent figures get cut.** The reference shipped an always-mounted
  companion and the owner re-scoped it to a first-visit greeter within
  days ("no site should have a persistent small figure following them
  around") and lowered every ambient cycle. Build greeters one-shot from
  the start; make ambient motion boringly rare.
- **A pink check on an online step is a lie.** The completion-mark split
  (local → tier check, online → ℹ disclosure on the client tier) is the
  grammar's honesty guarantee; default-unknown-to-online keeps a new phase
  from silently under-disclosing.
- **Disclosure text must come from send-time context.** Computing it at
  render time from current settings mis-describes a task whose settings
  changed mid-flight; capture provider/route/credential where the send
  resolves them.
- **Registry numbering drifts.** The reference registry accidentally holds
  two entries numbered UX-2 — when adding an entry, take the next FREE
  number and fix collisions on sight; a registry agents cite by number
  must be unambiguous.
- **Self-contained tier CSS means mirrored rules.** The client tier's
  stylesheet cannot import the authed app stylesheet, so shared visual
  rules exist in both files — touch the look, update BOTH, and bump any
  CSS↔JS version handshake the app uses.
- **Decoration in the exec/send path must be wrapped fail-soft** — the
  reference feeds its activity backdrop from the exec choke point with
  every feed wrapped, because a thrown decoration error would break the
  shell loop it decorates.
