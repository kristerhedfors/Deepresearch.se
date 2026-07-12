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
