---
name: on-device-trace
description: >-
  Load when a bug only reproduces on a user's real device (especially the
  iOS PWA) and you cannot attach devtools — "works in every test, broken
  on the phone", invisible/flickering UI, gestures that die, data that
  "disappears". The remote-debugging method that cracked the 2026-07-08
  history-pane saga: a visible build stamp, self-explaining empty states,
  and a copyable on-device event trace, iterated over chat with the user
  as the probe.
---

# On-device trace debugging

How to debug a device-specific client bug when the only instrument you
have is the user pasting text back into the chat. Developed 2026-07-08
across ~10 live iterations on the history pane (invisible chat rows,
dead swipe gesture, phantom buttons) — reference implementation in
`public/js/history-ui.js` (the `[hN …]` stamp, `cssBit()`, `TRACE`,
`traceBox`; see git history h12–h15 for the evolution).

## Why normal verification fails here

- **Desktop engines don't reproduce iOS.** Linux WebKit (Playwright)
  rendered every one of the iOS paint bugs correctly. Green Playwright
  runs mean NOTHING for this bug class.
- **Synthetic events bypass native gesture arbitration.** Dispatched
  PointerEvents/TouchEvents exercise your handlers, not the browser's
  scroll-steal / touch-cancel behavior — the exact thing that breaks.
- **You can't even trust that the device runs your code.** Stale
  heuristic caches (pre-`no-cache` era) and PWA pages that survive in
  the background for hours mean "I deployed it" ≠ "they're running it".

## The method, in escalation order

1. **Build stamp, always visible.** A bracketed status line in the UI:
   `[h15 · 53 here + 6 in projects · cloud: 59 checked, 0 restored]`.
   Bump the marker EVERY deploy. First question answered for free:
   which build is the device actually running (no stamp = ancient
   build). Include data-level counts so a screenshot also answers "is
   the data there?".
2. **Make silent states explain themselves.** Every branch that can
   produce an empty/blank UI gets a distinct message (records that
   won't decrypt, sync failed with counts, settings never loaded,
   restore didn't persist). "Empty" and "broken" must not look alike.
3. **Version handshakes for split resources.** JS checks the CSS's
   `--css-version` custom property (and repairs with
   `fetch(url, {cache:"reload"})` + link swap) — catches devices wedged
   on a stale stylesheet with fresh modules, which no module-graph walk
   sees.
4. **The event trace.** In-memory ring buffer (~60 entries), ms-offset
   timestamps, terse codes, appended by `trace("…")` calls in every
   handler under suspicion:
   - delivered events with their FLAGS: `m3 -29 c=1p=1` (move #3,
     dx=-29, cancelable, defaultPrevented) — proves what the browser
     actually let you do;
   - `end` vs `CANCEL` with move counts — shows the browser killing
     the gesture;
   - state decisions (`park dx=-73`, `close dx=-42`);
   - **a delayed post-check** (`setTimeout` ~320ms) snapshotting the
     REAL resulting DOM (`post ml=-88px swiped=true strip=true`) — this
     catches *something else* resetting your work;
   - **competing actors**: list re-renders, close calls, and the
     mouse-compat events (`menter`/`mleave`) — the 14-second-late
     `mleave` in the trace was the smoking gun for the phantom-buttons
     bug.
5. **Display it so a phone user can actually copy it.** A
   `position:fixed` overlay centered on screen, `z-index` above
   everything, **entirely inline-styled** (broken/stale CSS must not be
   able to hide the instrument that debugs broken CSS), scrollable,
   `-webkit-user-select:all; user-select:all` so ONE TAP selects the
   whole dump. Toggle it from a stable element (the stamp line). Do NOT
   place it in-flow inside the suspect container — on the affected
   device the pane's own layout was collapsing cards over in-flow
   siblings, burying the first two placements.
6. **Iterate over chat.** User: swipe once → tap stamp → tap box →
   copy → paste. Each paste is a complete flight recording; read the
   event sequence before theorizing. Remove the trace (keep the stamp?
   ask) once the bug is confirmed fixed.

## iOS facts this method established (don't relearn them)

All in `app.css` comments + the **ui-notes** skill, short form:
rows inside a `backdrop-filter` panel stop painting if they permanently
contain an absolute (even invisible) overlay; transforms on such rows —
even transient — break painting too (slide with `margin-left`);
horizontal drags need TOUCH events + `preventDefault()` once claimed
(pointer events + `touch-action: pan-y` lose to native scroll steal);
DOM/style mutations mid-touch cancel the touch (pre-mutate at
`touchstart`, undo invisibly if it was a tap/scroll); `flex: 1;
min-height: 0` lists inside `overflow-y:auto` flex columns collapse and
paint children over siblings; taps fire mouse-compat events and the
emulated `:hover` sticks to the last-touched element for seconds — gate
ALL hover logic behind `matchMedia("(hover: hover)")`: JS handlers,
`:hover` checks in cleanup code, AND the CSS `:hover` rules themselves
(`@media (hover: hover)`) — the CSS rules alone produced stuck
highlights after the JS was already gated.

- **iOS keeps the previous page's `theme-color` bar tint across
  same-window navigation** (reported live 2026-07-10: pressing the app's
  ghost button → /cure showed the khaki page under a still-BLUE status
  bar). The DRC page's fix (public/cure/): `viewport-fit=cover` +
  `env(safe-area-inset-*)` padding so the page's own khaki paints the
  bar region, plus a boot-time nudge in drc.js that re-asserts the
  theme-color meta with a changed-then-target value across two
  animation frames to force WebKit to re-evaluate the tint. Iteration 2
  (same day): the first "still blue" retest was AGAINST A STALE DEPLOY —
  re-check what's actually live before theorizing (rule 1). Belt and
  braces added: the DRC brand line carries a build stamp + display mode
  ("d2 · pwa|browser"), and the app's ghost opens /cure in its OWN
  browsing context when running standalone (window.open) since a
  standalone webview's bar tint is pinned at launch. If a bar tint is
  ever wrong again, suspect the navigation ORIGIN page's meta and the
  standalone pinning, not the destination's meta. RECURRENCE 3
  (2026-07-17, iPhone Safari tab, d35): server → /cure via the ghost's
  plain `location.assign` left BOTH the status bar and the bottom
  toolbar blue — the single first-frame flip fires inside Safari's own
  post-navigation chrome transition and gets swallowed. Fix: the nudge
  became LAYERED in a shared pure module (`public/js/bar-tint.js`,
  Node-tested; wired at boot on BOTH tiers): first frame + `load` +
  every `pageshow` (bfcache restores rerun no module code!) +
  visibility-restore + 600/1600 ms lagged timers, each the same
  changed-then-target two-step. Verify on-device against build stamp
  d36+.

## Status of the instruments (post-incident)

The trace overlay itself was REMOVED once the device confirmed the fix
(h17, 2026-07-08) — reintroduce it from git history (`history-ui.js`
h12–h16) when the next device-only bug appears. The `[hN · …]` stamp
line, the empty-state explanations, and the CSS↔JS version handshake
were kept permanently: they cost one muted line and turn any user
screenshot into a build/data report. Bump the stamp (and the handshake
pair when CSS moves) on every change to the pane.

## Server-side companions

When the client trace isn't enough, correlate with what the server saw:
`wrangler tail --format json` (flaky through the sandbox proxy —
background it and parse the pretty-printed JSON stream as concatenated
objects, not lines), request logs (`request.complete` rows carry path +
status), R2/D1 inspection via the API token, and `scripts/chatlogs`.
On 2026-07-08 the tail proved all 58 records downloaded with 200s while
the pane showed nothing — instantly narrowing the bug to the client's
last inch.
