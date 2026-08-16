---
name: intro-baseline
description: >-
  Load BEFORE touching anything a first-time visitor sees — the landing page
  (public/welcome/index.html, served in place at /), its #wintro first-visit
  overlay, the ghost mascot and its bubble, the prepackaged "questions before
  you sign in" demo, the feature-focus card on the front door, the shared
  data-path diagrams, Se/cure's first run (the umbrella intro, the #ghostsay
  greeter, the #intro glass pane in public/cure/), Se/rver's first run (the
  balloon intro in public/js/app.js + balloon-intro.js), the /login and
  approval-gate copy, or the unauthenticated root branch in src/index.js. Also
  load when asked to "redesign the landing", "change the onboarding", "add a
  welcome/intro/first-visit screen", "improve the first impression", or when
  wiring any new interstitial a new visitor would meet. The landing page is an
  APPROVED BASELINE (owner directive, 2026-07-26) and the whole intro phase is
  tightly controlled: this skill is the load trigger that puts the contract in
  front of you before the edit.
---

# The intro baseline

**`docs/INTRO-BASELINE.md` is the specification. Read it before editing.** This
skill exists to make sure you do.

## The directive (2026-07-26)

The landing page as it stands at `600c7300` is **approved**. We are **not going
back** to an earlier front door — future work **builds on** this one. The whole
intro phase for new visitors is **tightly controlled**: no surface joins it, and
no surface changes, without the document and its tests changing in the same
commit.

Practically, that rules out three moves a session might otherwise reach for:

- **Rewriting the landing** because a fresh design seems better. The owner has
  already accepted this one.
- **Adding an interstitial** — a modal, a tour, a cookie-style banner, a second
  overlay — because it seemed helpful. Every extra thing between a visitor and
  the composer is a cost, and the sequence is already decided.
- **"Simplifying" a gate.** The seen-keys, the reduced-motion suppression, the
  watchdogs, and the seen-only-after-it-played discipline all exist because
  something broke. `docs/INTRO-BASELINE.md` §3 says which.

## What the intro is, in one screen

| Beat | Surface | Owned by |
|---|---|---|
| 1 | `GET /` serves the landing **in place** (never a redirect) | `src/index.js` |
| 2 | `#wintro` — name → tagline → does/doesn't → "Got it" | `public/welcome/index.html` |
| 3 | The ghost mascot walks to the ghost button; the background goes inert behind its bubble | same |
| 4 | The page: hero, video, feature-focus card, purpose, architecture-in-short, capabilities, MIT, ask demo, doors, sign-in CTA, footer | same |
| 5 | The prepackaged (non-LLM, badged) ask demo | `public/js/canned-faq.js` |
| 6 | Se/cure first run: umbrella intro → `#ghostsay` greeter → **composer** (the `#intro` pane does NOT auto-open) | `public/cure/` |
| 7 | Se/rver first run: balloon intro → balloon greeter | `public/js/app.js` |
| 8 | `/login` + the invite-only approval gate, stated on the landing before the click | `src/login.js` |

Full detail, including the copy blocks in order and the first-visit key table:
`docs/INTRO-BASELINE.md` §2–§3.

## The twelve rules (short form)

R1 additive only · R2 the root serves in place · R3 introduce before you
contrast · R4 the overlay is a doorway (≤6 bullets, ≤140 words) · R5
secure-first, full-URL wordmark · R6 decoration never blocks · R7 no language
model in the intro · R8 mascots are first-visit pointers (UX-3) · R9 every door
is public · R10 shared, not copied · R11 honest framing · R12 a broken part
removes itself.

Each rule's mechanism and its pinning test: `docs/INTRO-BASELINE.md` §4–§5.

## Working here

1. Read `docs/INTRO-BASELINE.md` §2 and find the surface you are touching.
2. Check the change against §4. A change that breaks a rule is an owner
   question (`AskUserQuestion`), not a judgement call.
3. Edit the code, the document, and the tests **in one commit**:
   - `src/intro-phase.test.js` — cross-surface rules (the mark, the doors, the
     state, fail-soft, no-LLM, framing, branding, the document's own accuracy).
   - `src/landing.test.js` — the landing's own structure.
4. Verify the replay paths by hand: `/?anim=1`, `/cure?anim=1`, `/cure?anim=rev`,
   `/rver?anim=1`, and a genuinely fresh browser profile. `?anim=1` forces
   through every suppression gate; that is the supported way to re-watch one.
5. `npm test`. Editing tracked text stales the committed docs corpus —
   regenerate with `npm run bundle:docs` and `npm run bundle:docs-rag`, never by
   hand.

## Traps

- **The five ask-demo ids are load-bearing.** `#askdemo`, `#askchips`,
  `#askmsgs`, `#askform`, `#askinput`: the inline module resolves each by id and
  throws on the first miss, killing the rest of that script silently. The
  repo-wide guard is `src/static-pages.test.js` — the same class of bug once
  left `/story/` on "Loading…" forever with every test green.
- **Marking an intro "seen" at the gate burns it.** Se/cure's key is
  `dr_umbrella_seen_v2` precisely because v1 was set before the play, so
  browsers that hit the stuck-canvas bug recorded an intro they never saw.
- **No head script in `public/cure/index.html`.** A guard that hid the chrome
  until the animation signalled done turned a stalled intro into a blank khaki
  screen. The chat UI paints first, always.
- **The diagrams and the timeline maths are shared files**
  (`public/architecture/path-*.svg`, `public/js/pulse-timeline-core.js`).
  Re-inlining or re-implementing either is the exact drift the split prevents.
- **`/cure`, `/cure/help/` and `/login` are pre-auth ROUTES, not allowlisted
  assets.** A new door needs its entry in `src/intro-phase.test.js`'s
  `PRE_AUTH_ROUTES` or it must pass `isPublicAsset`.

Related: `ui-notes` (UI facts), `ux-conventions` (UX-1 dismissal, UX-3 mascots,
UX-19 the intro sequence), `slash-spacing` (the `.sl` gap is measured, never
eyeballed), `docs/BRANDING.md`, `docs/PRIVACY-MODEL.md`.
