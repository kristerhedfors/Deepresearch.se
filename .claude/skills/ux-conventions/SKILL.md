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

## UX-2 — Animations are tier identity; privacy detail lives in Se/cure's ℹ privacy notice (rewritten 2026-07-16)

**Rule.** A step's WAITING SYMBOL is its **tier's own symbol**, on every
step: Se/cure wears the **pink umbrella** (→ the pink ✓), Se/rver the
**balloon** (→ the blue ✓). The animations are NOT a communication channel
about data exposure — no per-step channel badges, no per-step disclosure
finales (the 2026-07-15 per-task grammar was reverted the next day: "keep it
stringent and clean with the animations"). The privacy communication lives in
a readable **PRIVACY NOTICE** on Se/cure instead:

- The **privacy (i)** (`#privacybtn`) — an i-in-a-circle right after the
  Se/cure wordmark in the header (2026-07-16 owner directive, superseding the
  icon-row ℹ; the glyph was first an eye, swapped for the (i) by owner
  request 2026-07-17) — opens `#privacypop` at any time: what THIS session's CURRENT
  configuration sends where — model route (own key / local / borrowed proxy),
  web-search route (self / grant / off), recall embeddings, and the
  borrowed-allowance governance line — plus a follow-on link to the full
  documentation (`/cure/help/`). The popover anchors LEFT, under the brand
  that opens it; the (i)'s tap is excluded from the brand's intro-replay
  click.
- **Opening a shared secure workspace pops the notice automatically**, leading
  with what the workspace link carried — the privacy read-up for the specific
  workspace the user was handed, without them going looking.

**Why.** The owner's call: two tiers, two animations, each tied to its site —
stringent and clean. Honesty about data paths stays a first-class feature,
but as prose the user can actually read in one place, not as symbol grammar
they must decode per step.

**The mechanics:**

1. The notice text is PURE and Node-tested: `privacyNoticeLines(ctx)` in
   `public/js/drc-page-core.js` — paragraphs built from the session context
   (provider label, viaProxy, local, search route, embed provider,
   grantsConnected, workspaceName). An unknown search route reads as OFF —
   the notice never claims a send that may not happen.
2. `ctx` is gathered at OPEN time (`privacyCtx()`, `public/cure/drc.js`) from
   the same accessors the send path resolves (model pick, grant liveness,
   `directSearchActive`, `drcEmbedProvider`), so the notice always reflects
   the configuration as it stands.
3. Dismissal follows UX-1: any outside interaction closes the popover, the
   text inside stays selectable; the ℹ button itself toggles.
4. The standing one-liner beside the model picker (`providerVisibilityNote`)
   is unchanged — the notice is its long form.

**Canonical implementations:** `public/cure/drc.js` (`privacyCtx`,
`showPrivacyNotice`, the `unlockWorkspace` auto-pop), `public/cure/index.html`
(`#privacybtn` / `#privacypop`), `public/js/drc-page-core.js`
(`privacyNoticeLines`). Record: `docs/SYMBOL-LANGUAGE.md` §6.

---

## UX-3 — Mascot figures are first-visit-only pointers, never persistent; ambient animation stays low

**Rule.** When a tier has a mascot/figure (the ghost on Se/cure, the balloon
on Se/rver), it appears **once per browser** — for first-time visitors, chained
onto the first-visit intro animation's real play — delivers a few **pointers
on how the tier works** (a short speech-bubble script), then retires
(walks/climbs away) and **unmounts completely**. It is never mounted on a
routine boot; returning visitors get a clean page with no figure following
them around. Any tap dismisses it early (UX-1 — the bubbles hold no
interactive content). Separately, **ambient always-running animation is kept
at a LOW level**: background drifts slow enough to barely register, marker
events (the ghost-button glow/shimmer) rare (minutes apart, seconds long),
breathing loops slow. Functional motion — loading spinners, per-task finales —
is exempt: it communicates state.

**Why.** Owner directive (2026-07-15, F-16 round 4): "none of the sites should
have a persistent small figure following them around — we'd only need them for
first-time visitors to get some pointers on how things work following the
initial animation. Lower UX animation level." A figure that's always there
stops meaning anything and competes with the work; as a one-shot greeter it is
the tier's handshake.

**The mechanics that make it consistent:**

1. **Gate on the intro's real play**, not on a routine boot: /cure chains
   `startGhostStroll` + `showGhostSay` onto `maybePlayUmbrella`'s resolved
   `played`; /rver chains `showBalloonGreeter` (dynamic import) inside the
   landing intro's `onDone`. The intro itself is once-per-browser (seen-key
   set only after a real run), so the figure inherits that gate; `?anim=1`
   replays both.
2. **A bounded script, then self-retirement**: the ghost strolls its planned
   legs and `retire()`s; the balloon speaks `GREETER_LINES` (LINE_MS each)
   then `depart()`s (`departProgress`, DEPART_MS) and `unmount()`s —
   timers, listeners, and DOM all cleaned up.
3. **Dismiss on any interaction** (UX-1): the balloon binds one
   `pointerdown` capture listener on `document`; the figure layers are
   `pointer-events:none` so the same tap still reaches the app.
4. **Reduced motion**: the automatic first-visit play is suppressed with the
   intro; the forced `?anim=1` path shows a static figure and skips the
   animated departure.

**Canonical implementations:** `public/js/balloon.js`
(`showBalloonGreeter` / `speak` / `depart` / `unmount`; pure
`GREETER_LINES` / `departProgress` Node-tested in `balloon.test.js`),
`public/js/app.js` (the landing-intro `onDone` chain),
`public/cure/ghostwalk.js` (`startGhostWalk` / `retire`) + `public/cure/drc.js`
(`startGhostStroll` gated on `played`, `showGhostSay` with
`dr_secure_intro_seen`). Ambient levels: `public/css/app.css` (`bg-drift 52s`,
`ghost-glow`/`ghost-shimmer` 180s cycles), `public/cure/drc.css`
(`ghost-contour 7.2s`), `public/welcome/index.html` (the landing's matching
ghost cycle). Record: `docs/SYMBOL-LANGUAGE.md` §5, FEATURES.md F-16 round 4.

## UX-4 — A consent dialog's dismissal is a NO; only an explicit, cost-labeled button is a YES

**When** a dialog asks the user to approve something with a real cost —
bandwidth (a multi-GB model download), storage, spend — **then** every
dismissal path (outside/backdrop tap, an explicit "Not now", Escape, the ×)
means NO and does nothing, and the ONE affirmative button carries the cost in
its own label ("Download 3.9 GB", never a bare "OK"). The exact figure is
computed live (the model repo's file listing) before the button enables —
a consent over a guessed number isn't consent.

This deliberately inverts UX-1's spirit for a different dialog KIND: an
EXPLAINER (drspop, setting-pops, speech bubbles) can dismiss casually because
dismissing it costs nothing; a CONSENT dialog must never let the casual-tap
habit trigger the costly action. The two kinds may look similar (glass card),
so the affirmative button's cost label is the tell.

1. **Backdrop + "Not now" both just hide** the dialog; no state changes.
2. **The YES button states the cost** and stays disabled until the real
   figure is known (the live listing resolved).
3. **The reversal lives next to the consent**: whatever was approved shows a
   one-tap undo (the model row's Delete with its size) in the same surface.

**Canonical implementation:** the on-device model download consent —
`public/cure/index.html` `#odconsent`, `public/cure/drc.js`
`odOpenConsent()` (live-size fetch → size-labeled `#odc-yes`, backdrop/
`#odc-no` dismissal) and `renderOnDeviceRows()` (the Delete reversal row).
Record: docs/BONSAI-27B-PHONE-INFERENCE.md §6.

## UX-5 — A discoverability hint shown only on the empty state must be re-shown when the empty state is bypassed

**When** a how-to hint lives on the chat's empty state (the fresh-chat
`EMPTY_TEXT`) but the user can reach the same surface with the empty state
already gone — **reopening a saved conversation from history renders turns and
clears the empty hint** — **then** re-surface the hint in that path too, as a
transient cue that is NOT persisted and disappears on the next turn. A hint the
returning user never sees is a feature they can't discover.

The concrete case: feedback is filed by starting a chat message with the word
"feedback" (src/feedback.js `feedbackIntent`; the entry then enters the fix
loop). The only on-screen instruction for that was `EMPTY_TEXT`, which never
shows once a reopened history chat has rendered its turns — so a user who
opened an old session specifically to comment on it had no cue. The fix appends
a quieter `.feedback-hint` line below the restored turns.

1. **Gated to an answered record** — `shouldShowFeedbackHint(messages)` shows
   it only when there's an assistant turn to comment on (empty/user-only:
   nothing).
2. **Transient, never persisted** — appended after `renderStoredConversation`,
   removed by `clearEmpty()` (same lifecycle as the empty hint) the moment a
   new turn is added; it is never written to the history record.
3. **Quieter than a message** — smaller, muted, centered, so it reads as chrome
   not conversation.

**Canonical implementation:** `public/js/turns.js` (`FEEDBACK_HINT_TEXT`, pure
`shouldShowFeedbackHint` Node-tested in `turns.test.js`, `addFeedbackHint`
appended in `renderStoredConversation`; `clearEmpty` removes it),
`public/css/app.css` `.feedback-hint`. Server side of the same guarantee:
src/feedback.js `buildFeedbackContext` (the reopened chat's last Q&A is what the
feedback entry captures). Se/cure keeps no server feedback path (privacy
invariant 4) and gets no hint.

## UX-6 — A copy-to-clipboard button notifies briefly, then RETURNS to its original label

**When** a "Copy …" button succeeds, **then** it shows a short confirmation
("Copied ✓") and **reverts to its original label after ~1.5 s** — it never
stays in the copied state. On clipboard denial it shows the manual-copy hint
(selecting the text for the user where there is a field to select) and reverts
the same way (a touch longer, ~2.5 s).

**Why.** Users go back and forth over a surface (regenerate a password, edit,
re-copy): a checkmark that never clears reads as stale state and hides whether
a SECOND copy actually happened. The notification is the feedback; the resting
label is the affordance. (2026-07-20 owner directive, from the secure-workspace
result pane.)

1. **One revert timer per button** — a re-click resets the timer instead of
   stacking reverts (`btn._flashTimer` cleared before re-arm).
2. **The original label is captured once** (`btn._origLabel`) so nested
   flashes can't bake a transient text in as "original".
3. Failure text also reverts — a permanent "copy manually" is as stale as a
   permanent checkmark.

**Canonical implementation:** `flashButton` in `public/cure/drc.js` (used by
`#wk-copylink`, `#wk-copypass`, `#copysecret`); the earlier hand-rolled
`#odtracecopy` revert (same file, ~L1224) predates the helper and matches the
rule. New copy buttons reuse `flashButton` (or clone it into their module —
DRS surfaces don't import from /cure).

## UX-7 — A multi-decision composer walks ONE decision per step, each step a complete information card with a beginner recommendation

**When** a surface asks the user to make several consequential choices to
produce something (the secure-workspace share composer: keys? settings? chats?
allowances? password?), **then** it presents them as a WIZARD — one decision
per step, Back/Next, a "Step N of M" counter — where each step is a complete
information card: what the choice covers, what it means/risks in full
sentences, and a visually distinct **"For beginners:"** recommendation
(leaning toward the more complete choice that works out of the box for the
recipient). Steps that don't apply (no shareable allowances) are skipped, not
greyed. Choices persist across Back/Next and reopenings; the final step's
primary action replaces "Next". The result view offers a way back into the
wizard with everything intact.

**Why.** A flat checkbox list forces the user to already understand every
option before ticking any; one card at a time gives each choice the space to
be actually understood, and the recommendation gives a newcomer a default
they can trust. (2026-07-20 owner directive.)

**Canonical implementation:** `public/cure/index.html` `#wkshare` (the
`.wk-step` cards + `.wk-reco` callouts), `public/cure/drc.js`
(`WORKSPACE_STEPS` / `workspaceVisibleSteps` / `renderWorkspaceStep`,
result-mode flip in `createWorkspaceLink`), `public/cure/drc.css` (`.wk-step`,
`.wk-reco`). Distinct from UX-4 (a single costly consent): this rule is about
SEQUENCING several free choices, and composes with UX-4 if a step carries a
real cost.
