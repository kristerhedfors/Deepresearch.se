---
name: ux-conventions
description: >-
  Load when adding or changing any INTERACTION behavior in the client UI —
  popovers / speech bubbles / explainers and how they dismiss, what a click on
  overlay chrome does, which gesture opens a control, focus/return behavior —
  or when a UX decision has just been made that must stay consistent across the
  app and won't be caught by a unit test. This is the numbered REGISTRY of
  codified UX interaction rules ("when X happens, the UI does Y"), each pinned
  to its canonical implementation. Consult it BEFORE writing new interaction
  code so the new surface matches the established feel; ADD an entry whenever a
  new UX rule is decided. Companion to ui-notes (which covers UI facts/markup);
  this skill is specifically the behavioral "when-then" rules.
---

# UX conventions

This is the **registry of codified user-experience interaction rules** for the
client (`public/`). These are cross-cutting *behaviors* — "when the user does X,
the UI does Y" — that must feel the same everywhere and that no unit test
enforces, so they drift unless written down. `ui-notes` documents UI *facts*
(markup, rendering, attachments, the report); **this skill documents
interaction *behavior*.**

## How to use this skill

- **Before** wiring a new interactive surface (a popover, an overlay, a
  dismissable panel, a new gesture), find the matching convention below and copy
  its established behavior — don't reinvent a slightly-different feel.
- **When a new UX decision is made**, add a numbered entry: the RULE as a
  precise "when X → then Y", a one-line WHY, and the `file:line` of the
  canonical implementation(s). Keep it evidence-based — describe what the code
  actually does, and update the reference if the canonical implementation moves.
- Each rule has EN+SV parity only where it routes on text; pure interaction
  rules (dismissal, gestures) are language-agnostic.

---

## UX-1 — Speaker bubbles dismiss on any outside interaction; live content inside stays clickable

**Rule.** When a transient **speaker bubble / popover / explainer** is open, an
interaction (click or pointer-down) **anywhere** dismisses it and returns the
user to whatever was underneath — **except** an interaction that lands on
*interactive content inside the bubble*, or on the control that opened it, which
is handled normally and does **not** dismiss. A bubble that holds no interactive
content is therefore purely dismiss-on-click: click it, it closes, you're back
to what was under it.

**Why.** These bubbles are lightweight, non-modal asides (an info blurb, a
"this is a Se/rver feature" explainer, a mascot's hint, a settings detail). They
must never trap the user: the natural instinct — click away to get rid of it —
always works, while the one thing you might actually want to touch inside
(a link, a select, a form field, a dismiss ✕) still works. No modal backdrop, no
"you must press the X."

**The mechanics that make it consistent (match all of these):**

1. **The outside-closer** is bound to `document` (or a *persistent* ancestor),
   and hides the bubble when the event target is **not** inside it —
   `!pop.contains(e.target)` — plus **not** on the opener
   (`!e.target.closest(<opener-selector>)`), so the same click that opens
   doesn't immediately re-close.
2. **The opener swallows its own click** (`e.stopPropagation()` / `preventDefault`
   when a hold fired) so opening is not also an "outside" event, and a
   press-and-hold that opened the bubble does **not** also toggle the underlying
   control.
3. **One bubble at a time** — `closeAll()` before opening a new one.
4. **Bind the outside-closer ONCE** on a persistent element (guard with a flag
   like `_popCloserBound`), never per-render, or the handlers stack and a bubble
   needs N clicks to close.
5. **Interactive content inside stays live** because the closer's containment
   check excludes the whole bubble subtree — a `<select>`, link, input, or the
   ✕ inside receives its own event normally.
6. **Choose the event by whether dismiss should beat the underlay:** use
   **`click`** when closing after the underlying element reacts is fine
   (settings/search/DRS popovers); use **`pointerdown` in capture phase** when
   the bubble must get out of the way *before* the tapped element acts (the TIN
   mascot bubble).

**Canonical implementations** (copy the nearest one):

| Surface | File | Behavior |
|---|---|---|
| Settings info popovers (press-and-hold or ⓘ) | `public/js/account-views.js` `wireSettingPopovers` (~L188) | Excludes `.setting-pop` and `.setting-info`; closer bound once via `root._popCloserBound`; `closeAll()` on open; opener `stopPropagation`s. The reference implementation. |
| Web-search spiderweb popover | `public/js/app.js` (~L206) | `document` click closer, `!searchPop.contains(e.target)`; the press-and-hold opener guards `holdFired` so the hold doesn't also flip the toggle. |
| `#drspop` DRS-feature explainer (DRC/cure) | `public/cure/drc.js` (~L923) | Closer excludes `.contains(e.target)` **and** `e.target.closest("[data-feature]")` (the dimmed opener buttons). |
| TIN mascot speech bubble (introspection) | `public/js/introspect-ui.js` `onOutside` / `dismissMascot` (~L413) | `pointerdown` capture; excludes `bubbleEl` + `mascotEl`; else waves the mascot goodbye. The "dismiss before the underlay acts" variant. |

**When adding a new bubble:** reuse `wireSettingPopovers` if it's a settings-row
detail; otherwise clone the closest table row's shape — persistent single-bound
closer, containment + opener exclusion, `closeAll`. Don't add a modal backdrop
to a speaker bubble; the outside-interaction dismissal *is* the backdrop.

**Not part of this convention (yet):** an `Escape`-to-close keybinding — these
bubbles dismiss on outside interaction only; the modal-style drawers/panels are
a separate surface. If Escape support is ever added, codify it here as its own
rule so it lands everywhere at once rather than one bubble at a time.

---

## UX-2 — Sandbox two-layer switch: a background tap swaps the foreground pane; message taps never switch; the background pane leans along in synchronization

**Rule.** While the execution sandbox is running (the agent backdrop has produced
output), the page holds **two stacked panes** — the CONVERSATION (`#chat`) and
the TERMINAL backdrop (`#dr-agent-backdrop`). A **tap on the bare page
background** — not on a message bubble, not on interactive chrome — **swaps which
pane is in front**: the front pane reads at full strength, the other recedes to a
faint background (`body.term-fg` → chat `opacity:.16`, backdrop rises to `z:4`
below the fixed chrome at `z:5`), with a quick **slide-in-from-the-right** on the
pane that just came forward. A tap that lands on a **user/assistant message** (or
any control) does its normal thing and **never switches**. A **swipe/drag** is
not a tap and never switches. Once in a mode, **scrolling the foreground pane
makes the background pane lean along in the same direction, weaker and shorter**
(a gentle parallax that springs back).

**Why.** The old design popped a full terminal panel open, which covered the
screen and broke the prompt-first flow. Two peers you flip between keep both the
conversation and the raw agent activity one tap away without either ever taking
the whole screen. The message-vs-background discrimination is load-bearing: users
must be able to select/tap message text and controls without the layer flipping
out from under them, so ONLY the empty field toggles.

**The mechanics that make it consistent (match all of these):**

1. **Tap detection is `pointerdown`→`pointerup`** (covers mouse + touch), gated by
   `isTapGesture` (small travel on both axes, short duration) so a swipe or a
   press-and-hold text-selection is excluded (`agent-backdrop-core.js`).
2. **The switch fires only on the bare background.** Both the press AND the
   release target must pass `isSwitchTarget` — not inside `BLOCK_SEL` (`.msg`,
   `.step`, `.activity`, controls, chrome, panels) and no active text selection.
   `.msg` is in `BLOCK_SEL`: **tapping a message never switches.**
3. **Gated on sandbox output** (`hasBackdropContent()` → a channel exists). Before
   the sandbox runs there is nothing to switch to, so background taps are inert
   and the page behaves normally.
4. **Never auto-pop.** New sandbox output does NOT bring the terminal forward on
   its own (that was the removed screen-covering behavior); the default stays
   conversation-forward and the user chooses to flip.
5. **Per-mode scrolling.** CONVO mode: conversation scrolls natively, the backdrop
   (background) leans via the `#chat` scroll listener. TERMINAL mode: a wheel/drag
   pages the command history and the conversation (background) leans. The lean is
   `parallaxFollow` (same direction as the scroll, gentler factor, capped) applied
   to the *background* pane and sprung back — distinct from the older opposite
   `parallaxNudge`.
6. **Reduced motion** skips the slide flourish (`prefers-reduced-motion`), keeping
   the instant opacity swap.

**Canonical implementation:** `public/js/agent-backdrop.js`
(`setLayerMode` / `slideInForeground` / `isSwitchTarget` / `scrollBackdrop` /
`leanChat` / `leanBackdrop` and the `wireScroll` gesture wiring) over the pure
core `public/js/agent-backdrop-core.js` (`nextLayerMode`, `isTapGesture`,
`parallaxFollow`); the `body.term-fg` styling + pane transitions live in
`public/css/app.css` (the two-layer-view-switch block). Pure logic is
Node-tested in `agent-backdrop-core.test.js`; the DOM glue is browser-verified
(tap-vs-message, swap opacity/z-index, tap-vs-swipe, both parallax directions).

---

## UX-2 — Every task wears its channel's symbol; on Se/cure an online task completes into a readable ℹ notice, never a bare ✓

**Rule.** A research/task step's WAITING SYMBOL is its **channel**, not its
tier: the **umbrella** (Se/cure's symbol — sheltered) for work that runs
entirely on this device, the **balloon** (Se/rver's symbol — carried) for work
that crosses the network — in BOTH tiers. Completion then splits by tier:

- **Se/rver** completes everything to a plain **blue ✓** (the tier already
  assumes cloud) — including its local (umbrella-spinner) steps, which pass
  `check: "blue"`. The pink-umbrella spinner appearing on the blue tier IS the
  "this ran privately" signal; the checkmark stays the tier's.
- **Se/cure** completes a LOCAL step to the **pink ✓**, but an ONLINE step to
  a tappable **ℹ information notice** (the balloon spinner's `finale: "info"`),
  whose bubble says exactly WHAT that task sent, TO WHOM, on WHOSE credential
  (`disclosureText`, `drc-page-core.js`) — the user can read up on what every
  online instance is doing or leaking. The bubble follows UX-1 dismissal.

**Why.** The symbols are the site's honesty channel (the privacy mission made
visible): "did this leave my device?" must be answerable at a glance for every
step, and on the privacy tier every network crossing must be one tap away from
its full disclosure. A pink ✓ on an online step would be a small lie.

**The mechanics:**

1. Channel classification is PURE and Node-tested: `phaseChannel()` in
   `public/js/drc-page-core.js` (Se/cure phases), `stepIsLocal()` in
   `public/js/activity-core.js` (Se/rver step ids). **Unknown defaults to
   ONLINE** — over-disclosing is the safe failure; a local badge on an online
   task lies.
2. The disclosure text is pure too (`disclosureText(phase, ctx)`), computed
   from the SEND-TIME context (provider label, borrowed-proxy flag, search
   route, embed provider) captured where the send resolves those —
   `sendCtx` in `public/cure/drc.js`.
3. The ℹ is a real `<button.notice>` in the step summary (accent blue ring,
   matching the balloon spinner's canvas ℹ so the finale hands off
   seamlessly); its click `preventDefault + stopPropagation` so it never
   toggles the step's `<details>`.

**Canonical implementations:** `public/cure/drc.js` (`addLeakNotice`,
`finishCurPhaseStep`, `phaseStep`, `sendCtx`), `public/js/activity.js`
(`makeStepDom`'s spinner pick), `public/js/balloon-spinner.js`
(`finale: "info"`), `public/js/umbrella-spinner.js` (`check: "blue"`),
`public/cure/drc.css` (`.notice` / `.leak-note`). Grammar record:
`docs/SYMBOL-LANGUAGE.md` §6.
