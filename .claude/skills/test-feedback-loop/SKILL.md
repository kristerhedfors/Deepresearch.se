---
name: test-feedback-loop
description: >-
  Load when RUNNING the standing test-feedback loop — "run the test loop",
  "process the verdicts", "feed new test cases into the pipeline", "what did
  the owner's testing turn up" — the loop that sits ON TOP of the try-it queue
  (testable-interaction-points): sweep decided verdicts, MINE EVERY NOTE
  (passes included — a 👍 note can carry a full bug report), ack by archiving,
  route each finding to the right fix channel (feature-maintenance PR comment /
  direct fix with regression test / features board), mint the NEXT batch of
  test points from the standing sources, and re-queue fixed points for
  re-test. Companion to testable-interaction-points (the queue mechanics),
  feature-maintenance (regression routing), and feedback-loop (the direct-fix
  discipline).
---

# Test-feedback loop — producing test cases, consuming verdicts, orchestrating fixes

## What this is

The try-it queue (see **testable-interaction-points**) gives a fix a linkable
place to be tried and a 👍/👎/❓ verdict. This skill is the LOOP around it: the
standing process where Claude Code **feeds new test cases in** at one end and
**consumes verdicts into orchestrated fixes** at the other. One session runs
it (the "test loop" session — this can be the same session as the
watcher/merger); the owner just opens the queue on their phone and taps
verdicts.

```
   MINT ────────────► QUEUE (open) ────► owner tests ────► VERDICT (passed|failed|untestable)
    ▲                     ▲                                    │
    │                     │ --reply answers the ❓ thread      ▼ sweep (--verdicts)
 sources:                 │ AND re-opens            MINE THE NOTE (always)
 · MAINTENANCE-OWNERS     │                                    │
   "owes"                 │                 ┌──────────────────┼─────────────────┐
 · merged fix PRs         │                 ▼                  ▼                 ▼
 · feedback queue fixes   │            clean pass        bug / regression   ❓ untestable /
 · chatlogs regressions   │                 │                  │            needs clarification
 · features board         │            ARCHIVE (= ack)    ROUTE THE FIX          │
   SHIPPED flips          │                                    │            ANSWER on the
                          └────────────────────────────────────┼─────────── point's thread
                                                               │            (fix target/actions
                                              ┌────────────────┼──────────┐ too if the scene
                                              ▼                ▼          ▼ was broken)
                                    owned subsystem?    no owner: fix   idea/preference:
                                    feature-maintenance directly        features board
                                    PR comment wakes    (bugreport-     (FEATURES.md §3)
                                    the author-worker   bugfix + test)
                                              └───────────┬────────────┘
                                                          ▼
                                            fix merges → declare a NEW point
                                            (or --set status:open to re-test)
```

## One tick of the loop

0. **Serve the git channel** (the worker-side plumbing — see
   **request-testing**): `scripts/test-requests --mint` mints every pending
   point a merged PR shipped in `docs/test-requests/<branch>.json` and stamps
   the queue ids back (commit the stamps); `scripts/test-requests --sync`
   stamps new verdicts into the files, re-opens a passed point that still
   owes `runs` confirmations, and prints one `COMMENT #<pr> …` line per new
   verdict — post each on that PR verbatim
   (`mcp__github__add_issue_comment`; resolve a null `pr` from the file's
   `branch` via `mcp__github__list_pull_requests` and stamp it). That comment
   wakes the subscribed author-worker — it IS the verdict delivery. Move a
   fully-`done` file to `docs/test-requests/archive/` and commit.
1. **Sweep**: `scripts/testpoints --verdicts` — every decided-but-unconsumed
   point (`passed` + `failed` + `untestable`; `archived` = already consumed,
   never reappears). Points minted from a request file get their verdict
   routed by step 0's sync; this sweep still mines their notes for anything
   the loop itself should act on (routing table below).
2. **Mine every note, pass or fail.** The status is the tester's overall call;
   the NOTE is where the real signal lives. Evidence: point #3 (2026-07-15)
   was 👍 "works" but its note carried a verbatim instruction-following
   complaint plus the full research-debug JSON — a complete bug report inside
   a pass. A tick that only reads `--status failed` loses these.
3. **Route** each finding (table below). A note pasted as research-debug JSON
   (the client's "Copy research JSON") gives you the model, timings, steps,
   full answer, and errors — treat it exactly like a `chat_logs` row.
4. **Ack**: archive each consumed point
   (`scripts/testpoints --set <id> '{"status":"archived"}'`) — archiving IS
   the "processed" marker; there is no separate consumed flag. Keep a `failed`
   point in `failed` until its fix lands, then `--set '{"status":"open"}'` for
   re-test (or declare a fresh point if the fix changed what to look for).
   An `untestable` point is acked by ANSWERING it (`--reply` re-opens it) —
   never by archiving it unanswered.
5. **Mint** the next batch of test points (sources below).
6. **Report** to the owner: what the verdicts said, what was routed where,
   what's newly on the queue. A tick with no verdicts and nothing to mint is
   silent — don't spam.

## Routing table (step 3)

| Finding in a verdict/note | Route |
|---|---|
| ❓ `untestable` — the tester never reached the point, or asked a question | **Answer it yourself, this tick**: `scripts/testpoints --reply <id> "…"` posts the answer on the point's clarification thread AND re-opens it (the banner shows the dialogue on the tester's next visit). Handle EACH thread input on its subject — a question gets an answer, a broken scene gets the point's `target`/`actions` fixed in the same pass, a missing feature-of-the-grammar goes to the improvements backlog. The thread continues until a real 👍/👎 lands. Do NOT archive an unanswered ❓. |
| Regression or bug in a subsystem with a `docs/MAINTENANCE-OWNERS.md` row | **feature-maintenance**: comment on the owning PR (`mcp__github__add_issue_comment`) with the note's contents as the regression report — the author-worker wakes and fixes. Do NOT silently fix it yourself. |
| Bug with no maintenance owner | Fix it directly, **bugreport-bugfix** style: the verbatim complaint becomes the regression test; the fix lands as a focused PR. Worked example: point #3's Shodan-noise complaint → `SHODAN_RELEVANCE_NOTE` in `src/shodan.js` + `buildShodanBlock` tests. |
| Feature idea, UX preference, "it should also…" | **features board** (`FEATURES.md` §3 + the `src/features.js` catalog, same-commit mirror) so the owner prioritizes it — not an immediate fix. |
| Behavior observation worth a decision (e.g. #2: an introspection answer satisfied a sandbox question) | Surface it in the tick report with a recommendation; let the owner decide before any code moves. |
| Clean pass, empty note | Archive, nothing else. |

## Minting sources (step 5) — where new test cases come from

- **The standard batches** (`scripts/test-batch`, the **test-batches** skill)
  — the curated library of ready-made points per pipeline case. `--mint
  <case>` drops a whole case onto the queue; `--to-request <case> <branch>`
  seeds a worker's PR file. Reach for these before hand-writing points; extend
  a batch when a new failure mode earns standing coverage.
- **Worker test-request files** — the first-class channel: a worker ships
  `docs/test-requests/<branch>.json` inside its PR (the **request-testing**
  skill), and step 0 mints it at merge. Prefer nudging workers onto this
  channel over minting on their behalf: their file states the pass criteria
  and `runs`, and their PR gets the verdicts.
- **`docs/MAINTENANCE-OWNERS.md` "owes" items** — every "owes on-device
  confirmation" clause is a test point waiting to be declared (e.g. #52's
  attached-file-readable-from-the-VM and overlay-persistence confirmations).
  Declaring it hands the confirmation to the owner's phone instead of leaving
  it a dangling TODO.
- **Every merged fix PR** — per testable-interaction-points, one point per
  fix, declared the moment it's testable (= merged/deployed; declaring on the
  fix branch is fine — the point simply reproduces the bug until the merge).
- **Feedback-queue resolutions** (see **feedback-loop**) — when an entry is
  implemented, a point verifies it AND the message-back can include the
  `/try/<id>` link.
- **Chatlogs regression sweeps** — a failure signature match becomes a repro
  point with the verbatim logged message as the `compose` text.
- **Features board SHIPPED flips** — a shipped tier gets a verification point
  before its status is trusted.

## Authoring rules learned from round 1 (2026-07-15, points #1–#4)

These extend testable-interaction-points' "declaring points well":

- **No trigger words in `compose` text unless testing that gate.** A hostname
  or IP fires the Shodan enrichment, "quiz me" fires the quiz, street/map
  words fire Maps. Point #3's "SHA-256 of the text deepresearch.se" pulled a
  Shodan lookup into a sandbox test and polluted the answer. Hash "hello
  world", not the site's own domain.
- **The `summary` states the EXACT expected behavior**, so "it did the thing
  but also other things" is a recordable failure, not a shrug-and-pass. If
  side-chatter would be a failure, say so: "…and nothing else in the answer".
- **`ref` carries the PR number** (plus branch if useful) — the
  MAINTENANCE-OWNERS registry is PR-keyed, so a `ref` of `#52` routes a 👎 in
  one lookup. Round 1 used bare branch names, which needed a registry search.
- **Ask for the research-debug JSON in surprising cases.** The `note` field
  takes 4000 chars; the owner pasting "Copy research JSON" turned #2 and #3
  from thumb-verdicts into complete diagnoses. Say so in the summary when the
  point probes routing/pipeline behavior.
- **Knob state is part of the scene.** The action grammar can OPEN settings
  but not SET a knob — until a `setKnob` action exists, a point that needs
  Shodan/Maps/dev-mode OFF must say so in a `note` action. (A `setKnob`
  action across the three grammar sites is on the improvements list below.)

## Running it as a standing loop

- **On demand**: the owner says "run the test loop" → one tick.
- **Scheduled**: a Routine (hourly+ cron via `create_trigger`, or the desktop
  `/loop` skill) firing "run one test-feedback loop tick" into the loop
  session. Pair it with the watcher/merger's regression sweep — same tick,
  same session, the verdict sweep is just one more input channel.
- **The wake-up that needs no schedule**: a fix routed via PR comment comes
  back as a follow-up PR; the merger merges it; THIS loop re-opens or
  re-declares the point. The owner's next tap closes the circle.
- State lives in the queue itself (archived = consumed), so a tick is
  stateless and any session can run it — nothing breaks if the container
  recycles.
- **ONE driver at a time.** An owner-invoked tick AND a scheduled Routine
  both minting is a race: two uncoordinated drivers each read `minted_id:
  null` on the same request file (neither has committed its stamp yet) and
  both mint → duplicate queue points (observed 2026-07-15 after PR #71 merged
  — #14/#15 and orphan #16/#17). Pick ONE driver — either the owner runs
  ticks by prompt, or a single Routine fires them, not both. `--mint` is now
  idempotent (it ADOPTS an existing branch+label point instead of
  re-creating), which closes the common window, but don't rely on it as a
  substitute for a single driver: archive any orphan duplicates you find
  (the pair NOT recorded in a committed request file's `minted_id`) and
  reconcile.

## Improvements backlog (needs code — take to the features board, don't ad-hoc)

- `setKnob {knob, on}` action so a point can pin its settings scene
  (server `cleanAction` + client executor + `CLIENT_ACTION_TYPES`, one change,
  see the grammar-lockstep rule).
- A `?decided=1` (or multi-status) filter on `GET /api/admin/testpoints` so
  `--verdicts` is one call instead of three.
- A verdict NOTIFICATION (alert row or webhook → wakes the loop session) so
  consumption isn't poll-only.
- Banner coverage beyond `/rver` (at least `/admin`), so non-DRS points don't
  need the record-from-the-queue-afterwards detour.
