---
name: testable-interaction-points
description: >-
  Load when declaring, running, or working on the "try-it queue" — testable
  interaction points: linkable places in the app to try a shipped fix, with
  a 👍/👎/❓ verdict (pass / fail / untestable–needs-clarification, the last
  opening a tester↔loop dialogue thread on the point). Load it the moment a
  fix or feature is ready to test ("queue this for testing", "add a test
  point", "what's in the test queue"), or when touching src/testpoints.js,
  public/js/testpoints.js, public/js/testpoints-core.js, scripts/testpoints,
  the /try/:id route, the test_points / test_point_messages D1 tables, or
  the #tryqueuebtn / #trybanner UI. Covers the deep-link ACTION GRAMMAR (the
  exact boundary of what "reachable" means), the producer→test→verdict loop,
  the clarification thread, the API surface, and where the boundary ends.
---

# Testable interaction points — the try-it queue

## What this is

When a fix ships, someone has to find the exact spot in the app to try it.
This turns that spot into a **declared, linkable thing**: a *test point* is a
labelled queue entry carrying

1. **WHERE** — a same-origin target path (`/rver`, `/admin`, `/pulse`, …) plus
   an ordered list of client **actions** that set the scene (open a panel,
   prefill the composer, flip a knob).
2. **WHAT WAS FIXED** — a plain-language summary shown while trying it.

The tester opens the point (from the queue, or the shareable `/try/<id>`
link), lands exactly there, reads what changed, and records one of THREE
verdicts: **👍 works / 👎 doesn't / ❓ can't test** (untestable — the deep
link + actions never landed them somewhere the fix could actually be tried,
or it's unclear what to do), with an optional note. Verdicts feed back to
the producer (Claude Code / the owner) so a 👎 becomes the next fix round.

An ❓ is a DIALOGUE, not a dead end: every verdict note is stored as a
message on the point's **clarification thread** (author `tester`), the loop
answers with its own message (author `agent`, `scripts/testpoints --reply`)
and re-opens the point, and the banner renders the whole thread — so an
unclear point is clarified back and forth *at the point itself* until a
real 👍/👎 lands.

The whole surface is **admin-only** — a deep link can prefill the composer or
open settings, so it is a developer/owner tool, not an end-user one. The
client fails soft for everyone else: the launcher and banner never render.

## The pieces

| Piece | Responsibility |
|---|---|
| `src/testpoints.js` | Pure core (validation, projection, `?format=text`, `deepLink`) + `handleAdminTestpoints` (CRUD + verdict + thread) + `handleTryRedirect` (the `/try/:id` resolver). D1 `test_points` + `test_point_messages` (the clarification thread). |
| `public/js/testpoints-core.js` | Client pure core: `parseTryId`/`stripTryParam`/`deepLink`, `partitionActions` (known vs unknown for THIS build), `nextOpenPoint`. Node-tested. |
| `public/js/testpoints.js` | The DRS client: the queue overlay, the try-it banner, and the ACTION EXECUTOR. Wired from `app.js` via `initTestpoints({ hooks })`. |
| `scripts/testpoints` | The producer/reader CLI over `/api/admin/testpoints` (break-glass Basic Auth). |
| `/try/:id` | Shareable deep link → 302 to `<target>?try=<id>` (routed in `index.js`, admin-gated, home-on-miss). |
| `#tryqueuebtn` / `#trybanner` | Header launcher (shown only when the queue probe succeeds) + the fixed bottom-sheet banner. |

## The loop

1. **Declare** a point the moment a fix is testable — `scripts/testpoints --add`
   or `POST /api/admin/testpoints`. Give it a crisp `label`, a `summary` that
   says *what changed* (not how), a `target`, and the `actions` that land the
   tester on the exact state. Add a `ref` (PR/commit/issue) so the verdict
   traces back.
2. **Test.** The owner opens the queue (header launcher) and taps a point,
   which opens its DETAIL view in place — the summary, any `note` steps, and
   the clarification thread — so the task is READ before going anywhere
   (2026-07-16: tapping used to navigate immediately, so a cross-page point
   threw the tester at the target without the explanation). An explicit
   "Go try it" then navigates; a shared `/try/<id>` link still lands
   directly. On `/rver` the banner repeats the summary at the scene (the
   actions have already set it); on a cross-page target the tester tries it
   by hand and records the verdict from the detail view afterwards. They
   click 👍/👎/❓ (+ optional note); the banner advances to the next open
   point — a cross-page NEXT point opens as its detail view, read-first,
   never a blind navigation.
3. **Read verdicts.** `scripts/testpoints --all` (or `--status failed`). A 👎
   with a note is a bug report against your own fix. Fix it, then re-open the
   point for re-test: `scripts/testpoints --set <id> '{"status":"open"}'`.
   An ❓ with a note is a QUESTION: answer it —
   `scripts/testpoints --reply <id> "…"` — which posts an `agent` message on
   the thread AND re-opens the point so the answer reaches the tester. If
   the ❓ exposed a broken scene (bad target, missing action), fix the
   point's `target`/`actions` in the same pass.
4. **Retire** a point that has served its purpose:
   `scripts/testpoints --set <id> '{"status":"archived"}'` or `--delete`.

Status lifecycle: `open` (on the queue) → `passed` | `failed` | `untestable`
(a recorded verdict) → re-open a `failed` one after the next fix, answer +
re-open an `untestable` one (`--reply` does both), or `archived` to retire.
Only `open` points are on the queue; the launcher badge counts them — an
`untestable` point sits with the loop, invisible to the tester, until the
loop's reply re-opens it.

The STANDING loop around this — sweeping verdicts (`--verdicts`), mining
notes (a 👍 note can carry a full bug report), archiving as the consumed-ack,
routing each finding to its fix channel, and minting the next batch of points
— is the **test-feedback-loop** skill. This skill owns the queue mechanics;
that one owns the process.

## Use-case tags — `#UC-<id>` and feedback-by-number (owner directive, 2026-07-19)

Every test point IS a **use case**: a starter prompt the owner runs to
evaluate one front of the app, then feeds back on. Each point has a stable
display tag, `#UC-<id>` (the id is the row id — `useCaseTag` in both cores,
carried on the projection as `.tag` and shown in the `?format=text` header).
Two things ride on it:

1. **The starter prompt carries its number.** When a point's `compose`
   action prefills the composer, the client prepends the tag
   (`tagStarterPrompt` — idempotent, never doubles) so the run opens with
   `#UC-34 <prompt>`. The queue rows, the detail view, and the try-it banner
   all show the tag too.
2. **Feedback references the number instead of the queue.** A chat message
   `feedback #UC-34 the map was cut off on mobile` is parsed by
   `parseUseCaseRef` (EN + SV, invariant 6 — it strips a leading
   feedback/återkoppling/synpunkt keyword, then reads `#UC-34` / `UC-34` /
   `UC 34` / `#34`). The pipeline's feedback case
   (`pipeline.js runFeedbackCapture`) confirms it with a deterministic step
   line and tells the ack model which use case it was; `chat.js` then calls
   `recordUseCaseFeedback(db, 34, comment)` — posting the note as a **tester
   message on point #34's thread** (re-opening a point that already carried a
   verdict, never an `archived` one) so the outcome lands "as if answered in
   the list of use cases" without reopening the queue. It is **admin-gated**
   (the test-point surface is owner-only) and fail-soft; the normal feedback
   entry is still written, tagged `page: "usecase #UC-34"` for double
   discovery. A `#UC-<id>` that matches no point degrades to a plain feedback
   entry — no error.

`useCaseTag`/`parseUseCaseRef` are defined in BOTH pure cores
(`src/testpoints.js`, `public/js/testpoints-core.js`) — mirror discipline,
unit-tested each side. Keep the two regexes in lockstep.

## The ACTION GRAMMAR — this IS the reachability boundary

An **action** is one step the landing page's client runs on arrival to set
the scene. This list is the boundary of what a point can reach
*automatically*. Anything outside it must be described in prose in the
`summary` and reached by hand. Unknown actions (a point authored against a
newer/older grammar) are **dropped, not rejected** — the point still opens,
minus the steps this build can't run, and the banner warns "N setup steps
this build can't run".

The grammar is defined in THREE places that must stay in lockstep — the
server validator `ACTION_TYPES`/`cleanAction` (`src/testpoints.js`), the
client executor `executeAction` (`public/js/testpoints.js`), and the client
`CLIENT_ACTION_TYPES` (`public/js/testpoints-core.js`). Add a new action to
all three (plus a unit test) in one change.

| Action | Fields | Effect on `/rver` |
|---|---|---|
| `note` | `text` | Extra inline guidance in the banner; no side effect. |
| `openAccount` | `view?` (`summary`\|`full`\|`messages`\|`settings`\|`feedback`\|`games`\|`docs`) | Opens the account panel to a view. |
| `openSettings` | `knob?` (`shodan_mcp`\|`google_maps`\|`bash_lite_mcp`\|`developer_mode`) | Opens Settings and pulse-highlights that knob's row. |
| `openProjects` | — | Opens the left drawer (chat history **and** the projects list). |
| `openHistory` | — | Opens the left drawer. |
| `newChat` | — | Starts a fresh chat. |
| `compose` | `text`, `send?` | Prefills the composer, prepending the point's `#UC-<id>` use-case tag; `send:true` submits it (spends quota — use sparingly). |
| `setSearch` | `on` (bool) | Flips the web-search knob. |
| `setBudget` | `seconds` (5–1800) | Sets the research time-target slider. |
| `selectModel` | `model` (id) | Picks a model in the dropdown. |
| `highlight` | `selector` (CSS) | Pulse-highlights + scrolls to any element. |

Notes on `cleanAction` (fail-soft is the rule): `compose`/`highlight`/
`selectModel`/`note` drop to null when their required field is missing;
`openAccount` falls back to `summary` on a bad view; `setBudget` clamps;
`setSearch.on` and `compose.send` are coerced to booleans; the action list is
capped at `TESTPOINT_CAPS.actions` (25).

## Where the boundary ENDS (say this, don't pretend otherwise)

- **The actions above are the whole automatic reach.** They cover routes,
  overlays/panels, the composer, the knobs, the slider, the model picker, and
  a generic element highlight. A state not expressible as one of these — a
  specific project's panel (needs an id), a mid-stream research view, a game's
  in-play board, an image-deck slide — is **navigate-then-do-by-hand**: target
  the page and describe the manual steps in `summary`. Prefer adding a new
  action type (in all three places) over piling instructions into prose when a
  state recurs.
- **The full try-it banner runs on the DRS app (`/rver`) only** — that is
  where `testpoints.js` is loaded and where the admin/owner is signed in. A
  point whose `target` is another served page (`/admin`, `/pulse`, `/cure`,
  `/help`, `/build`, `/story`, a game page) still **deep-links there** (you
  land exactly on it via `/try/<id>`), but the banner does not follow —
  which is exactly why the queue shows the DETAIL view first: the summary
  and steps are read on `/rver` BEFORE the "Go try it" navigation, and the
  detail view's own 👍/👎/❓ controls record the verdict from the queue
  afterwards (or `scripts/testpoints --result`). `/cure` (DRC) is
  deliberately server-less and public, so it is navigate-only by design —
  it cannot call the admin API.
- **`target` is hard-validated**: a same-origin path with one leading slash
  (query/hash allowed). Absolute URLs, `//host`, and non-slash strings are
  rejected outright — there is no safe fallback for a bad target, unlike the
  soft action drop.
- **`/try/<id>` on a miss goes home** (`/rver`), never dead-ends: not admin, no
  DB, or a deleted point all 302 to `/rver`. A stale shared link is harmless.

## API surface (all under the admin gate)

```
GET    /api/admin/testpoints            queue (open), newest first, threads included;
                                        ?status= ?open=1 ?q= ?limit= ?format=text
POST   /api/admin/testpoints            {label, summary, target, actions?, ref?}
GET    /api/admin/testpoints/:id        one point incl. its thread (the banner reads this)
PATCH  /api/admin/testpoints/:id        {label?,summary?,target?,actions?,ref?,status?}
POST   /api/admin/testpoints/:id/result {result:"pass"|"fail"|"untestable", note?}
                                        (a note also lands on the thread as a tester message)
POST   /api/admin/testpoints/:id/messages {body, author?:"agent"|"tester"} — the thread
DELETE /api/admin/testpoints/:id        (its thread goes with it)
GET    /try/:id                         302 → <target>?try=<id>  (admin-gated)
```

`POST`/`PATCH` echo `dropped_actions` when the grammar dropped any — surface
that to the producer so a typo'd action isn't silently lost.

## Declaring points well

- **Land on the exact state**, not near it. If the fix is a settings knob, use
  `{"type":"openSettings","knob":"…"}`, not just `target:"/rver"` + "open
  settings and find the row".
- **`summary` says what changed and what "working" looks like** — the tester
  should know what to check without reading the diff. Keep it to a sentence or
  two.
- **Avoid `compose` with `send:true`** unless the fix is specifically about the
  send/pipeline path — it spends quota on every open. Prefer prefill-only so
  the tester decides when to run it.
- **One point per fix.** A PR touching three things is three points, so each
  gets its own verdict.
- **Set `ref`** to the PR/commit so a 👎 note maps back to a change.

## Verification owed (live)

The pure logic is unit-tested (`src/testpoints.test.js`,
`public/js/testpoints-core.test.js`). Still verify live, per the repo's
live-verify convention, since D1 + the DOM executor are where real bugs hide:
declare a point against `/rver` with an `openSettings` action, open the queue
as admin, confirm the launcher badge counts it, tap it, confirm the banner
shows the summary and the knob row pulses, submit 👍, and confirm
`scripts/testpoints --status passed` shows the verdict. For the thread:
submit ❓ with a note, confirm the point leaves the queue
(`--status untestable` shows it, note on the THREAD lines), answer with
`--reply`, and confirm the point is open again with the dialogue rendered in
the banner. Confirm a non-admin session shows no launcher (the API 403s and
the client stays quiet).
