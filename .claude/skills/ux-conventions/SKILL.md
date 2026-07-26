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

## UX-2 — Sandbox pane switch: one header icon cycles every visible combination of the agent backgrounds, and a tap is NEVER a no-op

**Rule.** While the execution sandbox is enabled the page holds **two stacked
panes** — the CONVERSATION (`#chat`) and the TERMINAL backdrop
(`#dr-agent-backdrop`). The **header terminal icon `#termbtn`** is the one
control, and tapping it **cycles three modes**: CONVO (conversation forward, the
terminal a faint backdrop) → TERMINAL (the terminal forward at full strength:
`body.term-fg` → chat `opacity:.16`, backdrop rises to `z:4` below the fixed
chrome at `z:5`, with a quick **slide-in-from-the-right**) → HIDDEN (the terminal
not shown at all, `body.term-hidden`) → CONVO. **Every tap changes the mode**,
including before the VM has printed a single byte. Once in a mode, **scrolling
the foreground pane makes the background pane lean along in the same direction,
weaker and shorter** (a gentle parallax that springs back).

**When a mode carries a SECOND agent background, the same icon owns it too, and
the cycle covers every combination the user can see** (2026-07-26 owner
directive). Orchestrator stands in front of the rotating wireframe workflow
graph (`#graphbackdrop`) as well as the terminal, so there the cycle is five
long: **BOTH** (terminal + graph, both faint) → **TERMINAL** (forward) →
**CONVO** (terminal faint, graph off) → **GRAPH** (graph alone) → **HIDDEN**
(neither) → BOTH. Terminal-forward needs no graph variant — its near-opaque
field covers the whole viewport, so a graph behind it would be a state nobody
can see.

**Why.** The old design popped a full terminal panel open, which covered the
screen and broke the prompt-first flow. Two peers you flip between keep both the
conversation and the raw agent activity one tap away without either ever taking
the whole screen. Once a mode has more than one background, the same argument
applies to each of them independently: a user who wants the workflow graph
without the shell chatter, or the shell without the graph, should not have to
leave the mode to get it — and one icon that walks the combinations beats a
second icon per layer.

**The mechanics that make it consistent (match all of these):**

1. **The header icon is the ONLY switcher.** The original tap-on-the-bare-
   background gesture was removed (2026-07-14): a page-wide invisible hit area is
   not a discoverable control, and it fought text selection. `#termbtn` lives in
   both tiers' headers under the same id, `hidden` until the sandbox is on.
2. **The icon's presence is a status signal.** It appears the moment the sandbox
   is enabled — at first paint from the cached knob, before the VM boots — so
   "the icon is there" means Linux is starting. It also appears whenever a mode
   registers a graph, since otherwise there would be no way to put that graph
   away. Its class reflects the TERMINAL half of the mode with one accent hue at
   descending intensity (`.on` → `.mode-bg` → `.mode-off`), so the icon reads the
   same whether or not a graph rides along; the `title` names the whole state and
   what the next tap does, which is what distinguishes `convo` from `both` and
   `hidden` from `graph`.
3. **A tap is NEVER a silent no-op** (see UX-18). The switch used to bail while
   the ring buffer was empty ("nothing to switch to"), which made every tap
   during the VM's 24-80 s cold boot do nothing on a control that was already on
   screen and styled as live — reported as "terminal button does not work"
   (feedback #38). Now the mode always cycles, the pane carries the boot progress
   while the VM comes up, and an entirely empty pane says so in words
   (`EMPTY_PANE_LINE`).
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
7. **A combined mode decomposes; the CSS never learns about it.** `terminalLayerOf`
   maps the five modes onto the same three terminal states, so `body.term-fg` /
   `body.term-hidden` and every gesture guard are unchanged; `graphShownIn` is the
   other half. Adding a third background means extending the cycle table, not
   touching the stylesheet.
8. **The extra layer arrives as a HOOK, never an import.** `mode-backdrop.js`
   hands the switch a `{show, hide}` pair (`setGraphLayer`). `agent-backdrop.js`
   is in the public asset allowlist because the Se/cure module graph imports it
   and `graph-backdrop.js` is not, so importing the graph there would 401 all of
   `/cure` — the recurring public-graph failure class. Keep the dependency
   pointing from the mode dispatch into the switch.
9. **A mode change keeps what the user chose.** `forGraphAvailability` re-homes
   the current mode into the cycle now in force: gaining a graph shows it (the
   mode's own background used to mount unconditionally) while leaving the
   terminal half alone, losing one drops the graph half.

**Canonical implementation:** `public/js/agent-backdrop.js`
(`wireTermBtn` / `setLayerMode` / `applyLayerState` / `setGraphLayer` /
`applyGraphLayer` / `syncTermBtn` / `revealTermBtn` / `slideInForeground` /
`scrollBackdrop` / `leanChat` and the `wireScroll` gesture wiring) over the pure
core `public/js/agent-backdrop-core.js` (`nextLayerMode`, `terminalLayerOf`,
`graphShownIn`, `forGraphAvailability`, `hasPaneContent`, `composePaneLines`,
`parallaxFollow`), with `public/js/mode-backdrop.js` registering the graph pair;
the `body.term-fg` /
`body.term-hidden` styling + pane transitions live in `public/css/app.css` and
are mirrored in `public/cure/drc.css`. Pure logic is Node-tested in
`agent-backdrop-core.test.js`; the DOM glue is browser-verified (mode cycle,
swap opacity/z-index, the empty-pane and booting states, both parallax
directions).

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
them around. **The Se/cure ghost is click-through** (owner directive
2026-07-20): a tap freezes its stroll and pages through the message queue one
tap at a time, and the tap *after* the last message dismisses it — so the user
can read at their own pace and then make it go away (`clickMessage` in
`ghostwalk.js`; its wrap stays `pointer-events:none` so only the small ghost
body + visible bubble intercept taps, the rest of the page stays reachable).
The balloon greeter keeps the plain any-tap-dismisses behaviour. Separately,
**ambient always-running animation is kept
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
3. **Dismiss on interaction** (UX-1): the balloon binds one `pointerdown`
   capture listener on `document` and its layers are `pointer-events:none`, so
   any tap dismisses it and still reaches the app. The ghost is the exception
   (2026-07-20): its body + visible bubble are `pointer-events:auto` and carry
   a `click` handler that pages the queue, dismissing only after the last
   message; the wrap around them stays `pointer-events:none`.
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

## UX-8 — Enter sends the message; Shift+Enter inserts a newline (guarded for IME + touch)

**When** the user presses **Enter** in the chat composer (`#input`), **then**
the message is sent (the form is submitted) — **except** `Shift+Enter` (and
`Ctrl`/`Cmd`/`Alt+Enter`), which insert a newline; an **IME composition**
Enter (`e.isComposing` or `keyCode === 229`), which commits a candidate and is
never a send; and a **touch-primary device** (coarse pointer — phones/tablets),
where Enter stays a newline and the ↑ send button is how you send. This is the
near-universal chat-composer convention (Claude, ChatGPT, Slack's default);
before 2026-07-23 Enter only ever inserted a newline and the arrow was the sole
way to send.

**Why.** A first-time keyboard user expects Enter to send and Shift+Enter to
add a line — anything else is surprising. The two guards prevent the two classic
mis-sends: an IME user committing a CJK candidate, and a phone user whose
on-screen Enter key means "newline". (Owner request 2026-07-23: "go with what
Claude uses… the most common convention.")

**The mechanics (match both tiers):**

1. **A `keydown` listener on the textarea**, not `keypress`, so modifier state
   and `isComposing` are reliable.
2. **Early-return on any modifier** (`shiftKey || ctrlKey || metaKey ||
   altKey`) and on the IME guard — those fall through to the textarea's own
   newline, no `preventDefault`.
3. **Touch check via `matchMedia("(pointer: coarse)")`**, wrapped in try/catch
   so a missing/throwing `matchMedia` assumes a physical keyboard (send).
4. **Only then** `preventDefault()` + `form.requestSubmit()` — routing through
   the existing submit handler so quota/attachments/streaming-stop all behave
   identically to an arrow tap.
5. **Discoverability**: the send button's `title` reads
   "Send (Enter — Shift+Enter for a new line)".

**Canonical implementations:** `public/js/app.js` (`enterShouldSend` + the
`input` keydown handler, Se/rver) and `public/cure/drc.js` (the `$("input")`
keydown handler, Se/cure — inlined, since /cure surfaces don't import from
`/js`); the `#send` `title` in `public/index.html` and `public/cure/index.html`.
Language-agnostic (a key event, no text routing), so no EN/SV parity applies.

---

## UX-9 — In developer mode, an inline-code repo path in an answer is a tap target that opens the file in a popover

**The rule.** When developer mode is on and a rendered answer names one of
this repo's files in inline code (`src/pipeline.js`, `agent-spec-core.js:34-45`
— with or without a `:line` range), tapping it opens SOURCE PEEK: a popover
showing that file from the committed source snapshot, syntax highlighted, a
`:line` range scrolled to and marked. Markdown files open RENDERED with a
"View source" toggle (a line-ranged markdown reference opens raw, so the cited
lines are visible). An ambiguous basename offers a picker; an unknown path
says so honestly. Backdrop tap, ✕, and Escape all close it (UX-1's dismissal
feel). Fenced code blocks and links are never rewritten — inline code only.

**Why.** Introspection is about ease of access to internals: answers cite
files constantly, and the reference itself should be the door — no retyping
the path into a sandbox or the composer (feedback #10, 2026-07-24).

**Canonical implementation:** `public/js/source-peek.js` (the popover +
`wireSourcePeek`; scoped `spk-` styles, titanium palette — introspection's
own look per the introspect-ui.js precedent) over the Node-tested pure core
`public/js/source-peek-core.js`; wired in `public/js/turns.js`
(`renderContent`) with the gate set in `app.js` (`modeCarriesSource` of the
picked mode), and in
`public/cure/drc.js` (`messageEl` + the live final render) gated on
`state.developerMode`. Language-agnostic (path shapes, no text routing), so
no EN/SV parity applies.

---

## UX-10 — A composer knob's "where does this come from?" answer rides hover (desktop) and long-press (touch); a completed long-press never activates the control

**The rule.** When a composer control has a setup story behind it (the web
knob: live search needs a search source), that story is a small popover card
anchored to the control, opened by HOVER INTENT on desktop (~300 ms enter
delay, ~250 ms leave grace so the pointer can travel into the card) and by
LONG-PRESS (~500 ms, the settings ⓘ hold duration) on touch. The card links
the setup page; the control's own tap/click behavior stays untouched — a
completed long-press swallows the click so the control does not also toggle
underneath, while a quick tap toggles exactly as before. Dismissal is UX-1
(any outside interaction). The control's native `title` tooltip is REMOVED
when the card exists — two overlapping tooltips read as a glitch.

**Why.** The knob is where a user wonders about web search; the answer (run
your own local browsing agent, one-line setup) belongs at that exact spot,
not buried in settings. Hover and long-press are the two "tell me more
without committing" gestures — both must exist because each platform only
has one of them (owner request, 2026-07-24).

**Amended 2026-07-25, REVERSED 2026-07-26 (owner directive) — the card
EXPLAINS; it does not decide.** For one day the web knob's card carried a
radio picker of WHO runs the searches (Exa or this site's own Cloudflare
Worker). That is now a **settings knob** — "Exa web search", on by default,
off meaning the Worker backend — in the Se/rver Settings view
(`account-settings.js`) and the Se/cure settings drawer (`#exarow`), over the
unchanged shared preference `public/js/search-source.js`. **The standing
rule: a composer knob answers ITS OWN question and nothing else** (the web
knob: is this question researched live — on or off), and a second, unrelated
decision belongs in settings even when it is topically adjacent. A card may
still link to where that decision is made; this one still links the
local-browsing-agent setup page. The reversal does not undo the dismiss trap
below: any card a user reads to the end has to survive the release, whether or
not it holds a control.

**The dismiss trap (found 2026-07-25, headless Chromium):** the release that
ENDS a long-press is itself a document click, and the control is not inside
the card — so a UX-1 dismiss handler written as
`if (!pop.hidden && !pop.contains(e.target)) hide()` opens the card at 500 ms
and closes it the instant the finger lifts. The dismiss check must therefore
exclude the control too (`&& !e.target.closest("#searchtoggle")`). The Se/cure
twin had this from the start; `public/js/app.js` did not, and the bug was
invisible for as long as the card was read-only prose — nobody misses a card
they never see. Once a card carries a CONTROL, the same bug makes it
unreachable. Both tiers are now
verified across the same five behaviours: opens on hold, survives the release,
a pick inside does not dismiss, an outside click does, and the contextmenu
path opens it.

**The event-path trap (verified against headless Chromium with touch):**
Chrome/Android takes over the touch at the long-press threshold and fires
`pointercancel` + `contextmenu` — a `setTimeout`-on-`pointerdown` timer gets
KILLED before it fires. So `contextmenu` (with `preventDefault`) must be
treated as the long-press signal alongside the timer; iOS never fires it
(`-webkit-touch-callout: none`) and rides the timer instead. A desktop
right-click lands in the same handler, which is harmless on a toggle.

**Canonical implementation:** the web knob (`#searchtoggle`) → `#knobpop` →
`/cure/local-search/`: `public/cure/index.html` (the card), `drc.css` (the
`#drspop` glass shape anchored right), `drc.js` (the wiring IIFE after the
`websearch` change handler). The Se/rver twin is `#searchpop` in
`public/index.html` + `public/js/app.js`. Hover binds only under
`matchMedia("(hover: hover) and (pointer: fine)")` — on touch, synthesized
mouseenter would fight the toggle. No text routing, so no EN/SV parity
applies.

---

## UX-11 — A document reader has two modes; in comment mode a marked passage gets a comment that reaches the code, not just the prose

**The rule.** Every documentation page carries a Word-style mode **dropdown**
(fixed, **bottom** right — see "Not the top-right corner" below): **Read
only** (the default, and exactly what the page was
before) and **Comment**. It is a dropdown, not a pair of buttons — it matches
the chat mode selector's shape and a native `<select>` is the one control that
is comfortable on a phone. In comment mode, selecting a passage opens a composer
anchored to that selection; the comment is stored with the document path, the
section heading, and the exact quoted text. Every comment on the open document
sits in a right-hand rail, its passage highlighted in the prose, and clicking a
card scrolls to and flashes the highlight. Each card shows the entry's STATUS
(what the agent did), the THREAD (what it said), and whether the quoted passage
still exists in the document — when it does not, the card says the text was
replaced rather than silently losing the comment. Comment
mode is administrative: the switch appears only for an admin identity.

**The rail is OPENED, never automatic (fixed 2026-07-26).** Overlay chrome that
covers the content is opened by the reader and closed by the reader — it does
not decide for itself that now is a good time to be there. For a rail over a
document:

- **Read-only mode never opens it**, however many comments the document
  carries. The passages are highlighted in the prose; the counter in the mode
  slot says how many there are; neither takes the page away from a reader who
  came to read.
- **The counter is the switch.** It is a button, it carries `aria-expanded`,
  and it looks pressed while the rail is up, because on a phone the rail may be
  the only thing the press visibly changed.
- **A ✕ in the rail's head closes it**, and closing is not leaving comment
  mode: you keep marking passages, and the next selection brings the rail back
  with the composer in it. The head does not scroll away with the list — a
  close control you have to scroll back up to reach is not a close control.
- **A highlighted passage is the way back in**, opening the rail on that
  comment's card. Otherwise closing the rail is a one-way door out of a thread
  whose only other trace is a highlight.
- **Where it must cover the prose, it covers as little as it can.** Below
  700px it is a sheet along the BOTTOM sized to its content (max `66vh`), not a
  340px pane down the side of a 390px screen, and the passage that opened it is
  scrolled clear of it. It is opaque: at `.97` the text underneath still read
  through as grey ghost lines.

Feedback #40 (2026-07-26) is what this rule costs when it is missing — an
iPhone reading `/help/`, in read-only mode, given a dark pane over the
documentation that nothing on screen would dismiss: "I must see the text when
choosing what to comment." The decision of when the rail shows is the pure
`railVisible` in `docs-comments-core.js` (composing wins, then an explicit
open/close, then the mode), Node-tested rather than left to the DOM.

**Every outcome is visible (amended 2026-07-25).** The mode slot always says
which state the reader is in — the switch for an admin, "Comment mode is for
administrators." for a signed-in non-admin, and a sign-in link when signed out.
The first cut returned silently on each of those paths, and since `/docs` is a
PUBLIC page the ordinary way to arrive is signed out: the reader then looked
exactly as though the feature had never shipped, and the owner reasonably asked
whether it was live at all. A gated feature must state that it is gated.
Unexpected failures (missing markup from stale cached HTML, a failed dynamic
import) say so in the slot AND reach the console — a `catch {}` that swallows
them makes "not for you" and "broken" indistinguishable.

**Why.** The point of commenting on a document here is not proofreading. This
project keeps documentation and implementation describing the same system, so a
comment on a documented claim is an instruction about the system — the loop
reconciles the passage and the code behind it in one change. So the reader is
where the instruction is given, and where the result comes back: status, reply
and staleness land in the margin, not only in the account panel (owner
directive, 2026-07-25).

**Not the top-right corner (fixed 2026-07-26).** The slot shipped at
`top: .5rem; right: .6rem` and collided with the host page's own header on
every documentation page and at every width — measured with a real viewport:
267×29px at 390, 366×13px at 820, 136×13px at 1280, where it covered `/help/`'s
"← Back to the app" outright. That is the cost of the layer's own promise (a
page needs no markup, no CSS and **no layout cooperation**): it cannot know
what the page already put in that corner, so it must not claim a corner pages
conventionally use for their title and back link. It lives at
`bottom: .6rem; right: .6rem` now — free on every page, and a mode switch that
stays reachable while scrolling belongs there anyway. Two things must move
together: `.dc-slot` in `public/js/docs-comments.js`, the inline style in
`showNote()` in `public/js/doc-comment-gate.js` (an inline style cannot carry a
media query, so it duplicates the position on purpose), and the `.dc-rail`
padding, which is generous on whichever end the slot floats over. The fallback
badge also needs enough background alpha to read as chrome — at `.14` wash with
`opacity: .75` the prose behind it showed through its own label.

**No second queue.** The comment is a `feedback` entry with the `doc` scope —
one pipeline for free-form human instructions, four scope tags on it
(`docs/DECISION-BOARD-LOOPS.md` §1a). Anchoring is by QUOTING the passage, not
by ids written into the Markdown: the doc pipelines rewrite these files, so an
id-bearing marker would not survive, and a quote that stops matching is the
"this text was replaced" signal the rail needs.

**It mounts on ANY documentation page (amended 2026-07-25).** The layer injects
its own dropdown, rail and styles as fixed-position chrome, so a page opts in
with one script tag and provides no markup, no CSS and no layout slot:

```html
<script type="module">
  import { mountCommentMode } from "/js/doc-comment-gate.js";
  mountCommentMode({ path: "public/help/index.html" });
</script>
```

The first cut wired itself into ONE page's CSS grid (`/docs/`, the repo-corpus
viewer), which made every other documentation page a porting job — and the page
the app actually links as "documentation" (`/help/`) went without it while the
feature looked shipped. Pick the surface the USER means, and make the mechanism
surface-independent so the question stops mattering.

**Canonical implementation:** `public/js/doc-comment-gate.js` (PUBLIC — the
one-line opt-in, the admin check, the visible fallback note) →
`public/js/docs-comments.js` (GATED — dropdown, selection composer, rail,
passage highlighting, injected `dc-` styles) over the Node-tested pure core
`public/js/docs-comments-core.js` (body grammar, quote anchoring, stale
detection, `railVisible`). Live on `/help/` and `/docs/`. Storage is `POST /api/feedback` with
feedback-core's `docPageTag`; the rail reads `GET /api/feedback?page=<tag>`.
Selection-driven, no text routing, so no EN/SV parity applies.

## UX-12 — A tier comparison is one question per row, both answers direct-labeled, stacked on a phone

**When** a surface compares Se/cure and Se/rver — the workspace chooser on
`/cure/help/` is the canonical case — **then** it renders as one row per
QUESTION the reader actually has ("who can read it", "who pays for the AI",
"if you lose the password"), with each tier's answer in its own cell carrying
the tier's NAME as a bold prefix, Se/cure first. On a phone the row stacks to
a single column; from 620px up it becomes label + two answers.

**Why.** A three-column table on a 390px screen either scrolls sideways or
shrinks to unreadable, and this is the most consequential choice a user makes
on this site — it has to read on the device most people arrive with. Naming
the tier inside every cell means the comparison survives being read one cell
at a time, which is exactly how it is read once stacked. (2026-07-25 owner
directive: *"a very clear comparison for end users … point by point, when and
why to use which"*.)

1. **Direct-label, never colour alone.** The 3px tier-coloured left border is
   decoration; the `<span class="who">Se/cure:</span>` prefix is the
   identification. Same rule as the tier badges elsewhere.
2. **Secure-first** in every row, per `docs/BRANDING.md`.
3. **Questions, not properties.** Row labels are what a user would ask, not
   the system's vocabulary ("Where your work lives", not "Persistence
   model").
4. **Pair the table with a decision.** A comparison alone doesn't decide
   anything: it is followed by "Use Se/cure when …" / "Use Se/rver when …"
   lists and one honest paragraph on what each costs.
5. **Slash spacing is measured, not eyeballed** — the bold `.who` prefix is a
   new `.sl` context. Both help pages' scoped `-.04em` was re-measured at
   weight 700 (`node scripts/slash-gap.mjs --weights 700 --margin -0.04`:
   every font row ok, worst side +0.043em vs the 0.03em floor).
6. **One copy of the comparison per audience** (owner directive, 2026-07-26).
   The paired tables belong to `/architecture/` (the design audience) and the
   point-by-point chooser to `/cure/help/` (the deciding audience). `/help/`
   is the signed-in app's OVERVIEW — it opens from the absolute starting
   point and links onward — so it carries no `.cmp` block at all. Do not
   "restore" one there; a third copy is what drifts.

**Canonical implementation:** the `.cmp` / `.cmp-row` / `.cmp-q` / `.cmp-a`
block in `public/cure/help/index.html` ("Se/cure or Se/rver: which
workspace?"). The written source it compresses is `docs/WORKSPACES.md` §2 —
update that section, this page, and `/architecture/`'s paired tables together.

---

## UX-13 — In a many-series chart the legend IS the picker: tap to choose a curve, hold to isolate one, and the choice is remembered

**The rule.** When a chart carries more subjects than can be read at once —
the Feature focus timeline's 25 — the series legend is not a caption beside a
control, it is THE control, and it has to work under a thumb:

1. **Tap = choose.** A chip toggles its own curve. Under
   `@media (pointer: coarse)` a chip is at least 44 px tall and carries
   `touch-action: manipulation`; a chip sized for a mouse is not a picker on a
   phone.
2. **Hold = isolate.** A ~500 ms press (or right-click / `contextmenu`) shows
   only that subject; holding again restores the exact set that was there
   before. The isolation is a temporary lens, so it never destroys the chosen
   set — but any deliberate pick afterwards ends it, because the user has now
   said what they want shown. Both signals must be wired (UX-10's event-path
   trap), and the release that ends a hold must not also fire the tap.
3. **The curve itself is a target too.** A 2 px line is not tappable, so every
   series gets a paired transparent hit path (~22 viewBox units) and the tap
   lands on the subject, not on empty plot. A press that MOVED is a pan and
   selects nothing — tap-versus-drag is decided by distance, never by timing
   alone.
4. **State is a mark, not a mood.** On/off is carried by a `✓`/`○` glyph plus
   `aria-pressed`, and an off chip keeps its subject's HUE as a hollow ring.
   Greying the swatch out makes the user decode the picker before they can
   use it. Opacity alone is never the signal.
5. **The picker holds still.** Chips are built ONCE and patched in place —
   counts, marks, `aria-pressed`. Rebuilding the legend from `innerHTML`
   inside the redraw path destroys the chip under the finger on every frame of
   a pan; the same mistake registers a fresh window-level listener per frame.
   Anything re-rendered per frame gets a build/sync split.
6. **The choice is remembered on the device** (`localStorage`, best-effort in
   a `try`), filtered against the current registry on load so a renamed or
   dropped subject can't restore an empty chart. A blocked store must still
   leave a working picker.
7. **Bulk actions next to the chips** — Top N / All / None / Invert — plus a
   live "N of M shown" readout that switches to "only <subject>" while
   isolated, so the state is always written down in words.

**Why.** The page is read on a phone, and its whole value is comparing a
handful of subjects out of many — which means choosing is the primary
interaction, not a refinement of it. Every previous affordance (a clickable
legend chip) was technically present and practically unreachable: 29 px tall,
undiscoverable, and re-rendered out from under the gesture (owner request,
2026-07-26: *"I want to be able to tap and choose which curves should be
active"*).

**Canonical implementation:** the `Curves` block in
`public/pulse/timeline.html` — `.legchip` / `.pickhead` / `.legtools` styles,
`buildLegend` + `wireChip` + `syncLegend` + `toggleCurve` / `setCurves` /
`toggleSolo` / `clearSolo`, the `.series-hit` paths in `renderChart`, and the
`dr.pulse.timeline.v1` preference record. Guarded by
`tests/e2e/pulse-timeline.spec.js` in the free `mocked` project. No text
routing, so no EN/SV parity applies.

---

## UX-14 — Flipping a settings knob adds ONE line to the drawer; the detail behind it opens only when the user asks

**The rule.** When a settings switch reveals more than a status sentence — a
list, a table, per-item rows — the reveal is a single **collapsed disclosure
line**, never the content itself. The line summarises what is behind it in the
user's terms ("Models — 1 of 3 on this device", "Downloading Bonsai 8B · 1-bit…
· 42%"), and it is **never opened by code**: the `<details>` ships without
`open`, no render path sets it, and re-entering the panel returns it collapsed.
Because the fold can hide a live process, the summary line carries that
process's state — a download in flight outranks the resting counts on it.

**Why.** The settings drawer is a list of switches the user scans. A knob that
expands into a section pushes every switch below it off the screen and buries
the one the user was actually heading for: *"Now the menu grows drastically when
knob is turned, we just want one line to appear to expand to show this info
instead"* (feedback #27, 2026-07-26). The information is not unwanted — its
uninvited size is.

**The mechanics (match all of these):**

1. **A native `<details>`**, so keyboard, screen readers, and the browser's own
   open/close semantics come for free. The custom `▸` marker replaces the
   default triangle (`list-style: none` + `summary::-webkit-details-marker`)
   and rotates on `[open]`; the rotation is dropped under
   `prefers-reduced-motion`.
2. **The knob toggles `details.hidden`, not `details.open`.** Off hides the
   whole disclosure and empties its body; on shows the summary line alone.
3. **The summary text is a PURE function** of the section's state, shared by
   both tiers so they can never phrase it differently, and Node-tested
   (including the degenerate inputs — no `"4 of 3"`, no `"140%"`).
4. **Re-render replaces the body, never the `<details>`**, so a user who
   expanded the section does not have it snap shut under them mid-download.
   The one place `open` is written is the way OUT — the knob going off resets
   it to `false`, so flipping the knob back on gives the fresh one-line reveal
   the rule promises rather than whatever the user left open last time.
5. **Live progress writes the summary too**, not only the row inside — a folded
   section is otherwise a download with no visible progress at all.

**Canonical implementation:** the on-device models section in both tiers —
`public/js/ondevice-drs.js` (`onDeviceSettingsMarkup` `#oddetails`, `setSummary`,
`renderRows`) and `public/cure/index.html` `#oddetails` + `public/cure/drc.js`
(`odSummary`, `renderOnDeviceRows`), over the pure
`onDeviceSummaryLine` in `public/js/ondevice-core.js`
(`ondevice-core.test.js`). Styling is `.settings-sub` in both
`public/css/app.css` and `public/cure/drc.css` (the two stylesheets never load
together). Composes with UX-4: the download consent still lives inside the
expanded rows, and folding the section never starts or continues anything.
Language-agnostic (a disclosure gesture, no text routing), so no EN/SV parity
applies.

---

## UX-15 — A slash typed first opens the command list; picking a command leaves the caret ready for its argument

**When** the user types **`/` as the first character** of the chat composer,
**then** the command list opens above the pane — one row per available command,
each showing the command, its argument hint and a one-line description. Typing
filters the list by prefix. **↑/↓** move the highlight (wrapping at both ends),
**Enter** or **Tab** picks the highlighted command, a **click/tap** picks a row,
**Escape** closes. Picking puts `/<command> ` in the composer with the caret
after the space — the list is now closed, so the next Enter **sends** (UX-8).
The list also closes the moment the text stops being a bare command token: an
argument is being typed, the prefix matches nothing, or the slash isn't at
position 0 ("what does /help do?" is a research question).

**Why.** This is the interaction every chat product with commands already has
(Slack, Discord, Claude Code), so it needs no explanation — but only if it
behaves identically, above all in never trapping Enter. The rule that makes it
safe is that **picking a command is not sending it**: there is exactly one state
where Enter doesn't send, it is visible on screen, and Escape or one more
keystroke leaves it. The commands are the same in every chat mode and on both
tiers because they belong to the platform, not to an agent (owner directive,
2026-07-26: *"those shall be available in every agent"*).

**The mechanics (match all of these):**

1. **One shared module, both tiers** — `public/js/slash-menu.js`, mounted by
   `public/js/app.js` (Se/rver) and `public/cure/drc.js` (Se/cure). Se/cure
   imports it from `/js/` like the other shared client modules, so a new command
   appears in both composers at once. Both paths are in `isPublicAsset`
   (`src/assets.js`) — the /cure module graph goes dark without that.
2. **All the deciding lives in the pure core** (`public/js/slash-core.js`):
   which rows, in which order, in which language, and where the highlight
   moves. The DOM module only draws and listens, so the behaviour is
   Node-tested without a DOM (`slash-core.test.js`).
3. **The keydown listener is on `document`, capture phase**, and stops
   propagation only for the keys an OPEN list consumes (↑ ↓ Enter Tab Escape).
   That is what makes it out-rank the composer's own Enter-sends handler
   regardless of module load order — a listener on the textarea itself would
   depend on registration order.
4. **Rows are `<button type="button">`** inside the form (never a submit) and
   are chosen on **`pointerdown`, not click**, so the textarea doesn't blur and
   close the list out from under the finger.
5. **Language follows the deterministic EN-default convention** (`detectLang`,
   canned-faq.js) applied to what is being typed and — while that is still just
   a slash — to the last thing the user wrote. Command NAMES are never
   translated; the label, argument hint and description always are (invariant 6).
6. **Dismissal is UX-1**: a pointerdown anywhere outside the list closes it.

**Canonical implementations:** `public/js/slash-menu.js` (the mount), the
`.slash-menu` / `.slash-item` block in `public/css/app.css` and its mirror in
`public/cure/drc.css`, and `public/js/slash-core.js` for the pure half. The
routing the commands trigger is `src/chat.js` (resolved before mode routing) and
`src/pipeline.js` (the feedback gate above the executor dispatch).

---

## UX-16 — A live diagram of a running process lights only what it observed, and a repeated step shows its rounds

**When** the UI draws a process the user's own request is moving through — a
pipeline, a plan, a workflow — **then** a node changes appearance only on a
signal that the step actually ran. Three states, no fourth: **idle** (not taken
this time), **active** (running now — it blinks), **passed** (this request went
through it, and it stays lit for the rest of the run). A step the process
re-enters counts its rounds on the node (`×3`) and re-blinks on each entry, so a
loop reads as a loop rather than as one box that sat "active" for a minute. A run
that ends without reaching the end stops blinking but keeps its path lit.

**Why.** A diagram of your own request is only worth anything if it is evidence.
The moment a node lights up on an assumption — "synthesis must be running by
now", "the POST obviously happened" — the picture becomes a decoration that
happens to be shaped like the truth, and the one case where the user needs it
(something went wrong, or a branch they didn't expect was taken) is exactly the
case it gets wrong. Introspection mode exists to answer questions about this site
honestly, so its own diagram must hold to the same standard. Feedback #34
(2026-07-26) asked for the pipeline diagram an answer had just drawn, as a live
panel: *"blinks and upcolors nodes which the current chat has passed through, or
keep lighting up the nodes where the agent loops."*

**The mechanics (match all of these):**

1. **A node exists only where a signal exists.** If a phase runs silently, either
   give it a real event or leave it off the diagram — never a node that can only
   ever be dark. (Making the notes digest emit its step was part of this change,
   for exactly that reason.)
2. **Branch on machine-readable fields, never on a label.** A decision that
   routes the request announces the branch it took as data (`route` on the
   finished step). Sniffing an English label couples the drawing to copy that
   gets reworded and breaks silently — and could not work in a second language.
3. **Nothing is inferred from the answer text.** Only events, plus what an event
   *proves* about the path behind it — a stream carrying anything at all proves
   the request was admitted, and a step proves the always-run gates before it
   were passed. Declare those implications as a table, resolve them
   transitively, and never let one count as a round of its own.
4. **One signal, one node.** A step that lights two nodes double-counts the
   rounds of whichever loop they share, and a "finished" event that re-counts its
   own start turns every ordinary step into two visits. Both were real bugs here.
5. **The graph is a declared table, not a drawing** — a pure module (nodes,
   edges, event→node map, layout, SVG string), so a pipeline change is a table
   edit and the whole thing is Node-tested without a DOM.
6. **State survives a closed panel.** The drawer is usually shut while a request
   runs; events keep accumulating and the map catches up on open. Rendering is
   skipped entirely while collapsed, so nobody pays for a panel they aren't
   looking at.
7. **It scrolls inside its own box** and keeps the newest node in view — never
   scrolling the page or the list it sits in (UX-1's blast-radius discipline).
8. **The blink is animation-only** and drops under `prefers-reduced-motion`; the
   colour change carries the state on its own.
9. **Measure the geometry against the real stylesheet.** A diagram in a fixed
   panel has a width budget, and SVG text neither wraps nor clips — it just
   overlaps. Render it in a headless browser and assert the box fits and no label
   collides with a glyph, an edge label, or a neighbouring node. The pass on this
   one caught four defects, including a checkmark drawn through a node's name.

**Canonical implementations:** `public/js/pipeline-map-core.js` (the pure half —
node table, `nodesForStatus`, the visit-counting run state, `pipelineMapSvg`;
`pipeline-map-core.test.js`) and `public/js/pipeline-map.js` (the drawer mount),
fed by `public/js/stream.js`'s SSE dispatch and gated to introspection mode from
`public/js/history-ui.js`. The `.pipemap` block in `public/css/app.css` owns the
three states. The server half is `src/pipeline.js`'s `route` field on the `plan`
step plus the `digest` step. The sibling implementation is the Orchestrator
workflow view (`public/js/workflow-viz.js`), which follows the same three-state
discipline over `agent_update` events.

---

## UX-17 — Review material sends with its identity tag; the tag reaches the record, never the machinery

**Rule.** When a surface exists so a human can **review a piece of the product**
— a use case from the try-it queue, a starter prompt from an evaluation batch —
the thing it composes into the chat opens with that item's **identity tag**
(`#UC-34`, `#XP-07`). The reviewer never types it and never has to describe
which item they meant: a `feedback …` note later in that same conversation is
tied back by the first message. Two halves make it safe:

- **The tag rides to the RECORD.** The conversation as stored, the chat-log row,
  and the feedback entry all carry it — the entry states it on its own line
  rather than trusting a transcript that gets trimmed from the front.
- **The tag never reaches the MACHINERY** *when the tagged message is the thing
  being reviewed*. A starter is a research question, so `#XP-07` is stripped
  before any model call: triage plans against the reviewer's actual question and
  the search queries carry no code the item never had.

The two shipped tags differ on that second half, and the difference is not an
oversight. `#UC-34` rides through unstripped, because for a use case the tag on
the message IS the signal — `parseUseCaseRef` reads it off the feedback text to
find the point's thread, and the feedback route makes no model call at all
(owner directive, 2026-07-24). Strip it and the feature loses its target. A new
tag should follow whichever half its message needs; do not "fix" `#UC-34` into
symmetry with `#XP-07`.

**Why.** Without the tag the report says "this sentence…" and someone has to
match prose back to a registry by hand (that is feedback #37, verbatim). With
the tag left *in* a message that gets researched, the tagged run is no longer
the run being reviewed — you would be evaluating `#XP-07 <question>`, which no
visitor ever sends. Both failure modes are silent, which is why the rule is
written down.

**The mechanics (match all of these):**

1. **Only the review surface tags.** The ordinary visitor strip does not. An
   identifier prefixed onto a stranger's first message is a byte on the wire
   that the local-only pick signal promises is not there, and a code they never
   asked about.
2. **The tag is display-only; the id stays an integer.** One function renders it
   (`useCaseTag`, `starterTag`), one parses it back, and they live in the shared
   pure core so the surface that writes it and the server that reads it cannot
   drift.
3. **Prepending is idempotent.** Composing twice does not double the tag; a
   *different* tag already in the text is left alone rather than rewritten,
   because losing it would hide the mistake.
4. **Grammars must not collide.** `#XP-07` requires its letters — a bare `#7`
   belongs to the use-case grammar and stays there.
5. **Stripping, where it applies, sweeps every user turn** — not just the
   newest: a reopened conversation replays its history into the prompt.
6. **Both tiers strip with the same code.** Se/cure's pipeline runs in the
   browser with no server in the path, so it imports the shared core rather than
   carrying a second copy of the rule.
7. **The number is append-only.** Reordering or reusing it silently re-points
   every report that cited it.

**Canonical implementations:** `public/js/starters-core.js` (`starterTag`,
`parseStarterRef`, `stripStarterRef`, `tagStarterText`, `starterRefOf`,
`withoutStarterTags`) with the chip in `public/js/starters.js` and the strip in
`src/pipeline.js` / `public/cure/drc.js`; the older sibling is
`public/js/testpoints-core.js` (`useCaseTag`, `parseUseCaseRef`,
`tagStarterPrompt`) with `src/chat.js` recording both onto the feedback entry.

---

## UX-18 — A control that is on screen always responds; a control with nothing to do is not shown

**Rule.** If an interactive control is **visible and styled as live**, tapping it
**must produce a visible change** — every time, in every state. A handler that
silently returns because the feature has no data yet is a bug, not a guard: from
the outside it is indistinguishable from a broken button, and that is exactly how
users report it. When a control genuinely has nothing to act on, pick one of two
honest outcomes:

- **Hide it** until it does (`hidden`, the way `#historybtn` / `#tryqueuebtn` /
  `#ghostbtn` come and go), or
- **Let it act anyway and show the empty state in words** — the panel opens and
  says what is missing, or reports the work in flight that will fill it.

Never the third thing: on screen, enabled-looking, and inert.

**Why.** The cost of a silent no-op is paid entirely by the user, who has no way
to tell "nothing to show yet" from "this is broken" and no reason to try again.
It is worst on surfaces with a long warm-up, where the inert window is the
*majority* of the control's visible life. Feedback #38 is the worked example: the
header terminal icon is revealed the instant the sandbox knob is on, because its
presence is the "Linux is starting" signal — but the click handler bailed on
`hasBackdropContent()`, so for the whole 24-80 s cold boot
(`docs/SANDBOX-PERFORMANCE.md`) the icon sat there doing nothing. The report came
back as *"terminal button does not work, I don't get to see what happens in
terminal."* The pane had nothing in it; the button was fine. The user could not
possibly know that.

**The mechanics (match all of these):**

1. **Decide at REVEAL time, not at click time.** Whatever condition governs
   whether the control is useful belongs in the code that shows/hides it. Once
   shown, the handler does not re-litigate it.
2. **A pending state is content.** Work in flight — booting, loading, syncing —
   is something to say, not a reason to stay silent. Route the progress you
   already compute for one surface into the other rather than leaving it blank
   (`sandbox.js`'s boot ticker now drives BOTH the chat activity label and the
   terminal pane's status line).
3. **An empty surface names itself.** The last-resort render is a sentence, not
   a void — a black rectangle reads as a crash. Keep the copy in the pure core
   next to the compose function so it cannot drift (`EMPTY_PANE_LINE`).
4. **The state is reversible and obvious.** The control's own appearance reflects
   the mode it just moved to, so a user who lands somewhere unexpected can get
   back without guessing (`syncTermBtn`'s `.on` / `.mode-bg` / `.mode-off`).
5. **Test the cold state.** The interesting case is the one before any data
   exists; pin it (`hasPaneContent` / `composePaneLines` with an empty model).

**Canonical implementation:** `public/js/agent-backdrop.js` (`wireTermBtn`'s
handler — no content gate; `setLayerMode`'s `ensureLayer()`+`render()`;
`feedStatus`) over `public/js/agent-backdrop-core.js` (`hasPaneContent`,
`composePaneLines`, `EMPTY_PANE_LINE`), fed by `public/js/sandbox.js`'s boot
ticker. Node-tested in `agent-backdrop-core.test.js` ("hasPaneContent counts a
live status line", "composePaneLines … never renders blank").
