---
name: sse-recovery
description: >-
  Load when building the server tier's chat transport for an agent pair —
  the SSE event vocabulary (delta/status/done) and its forward-compatibility
  rule, keepalives, the pure client line-buffer parser, and the full
  answer-recovery machinery for dropped connections: the TTL'd server-side
  answer cache (ack-purged on intact delivery), the heartbeat + stale-run
  detection, the rolling-deadline client poller, the client stall watchdog,
  stop-mid-stream, and the metadata-only resume-across-relaunch marker that
  closes the mobile-PWA cold-relaunch gap. Also load when weighing this
  hand-built machinery against platform durable execution.
---

# SSE transport & answer recovery — surviving the real network

A research run takes tens of seconds to minutes, and the client holding its
stream is a phone: backgrounded, frozen, socket torn down, sometimes the
whole PWA discarded. This module builds the transport that makes that
survivable — a versionless SSE vocabulary the UI renders as live activity,
keepalives through the silent planning phases, and a recovery ladder with
one principle: the server FINISHES every run (the spend is mostly committed
by the time a client vanishes) and parks the answer briefly, so the client's
job is only to notice its stream died and collect the finished answer
instead of asking the user to re-send and re-spend. Every layer exists
because a production incident proved the previous layer insufficient; none
of it reproduces in local dev, so it is verified live by discipline.

## Capability class & tier story

Manifest class: **S — server-backed.** Layer 2; deps `research-pipeline`,
`baseplate-client`. The event VOCABULARY and the pure client pieces (the SSE
line parser, the activity renderer, the per-turn debug log) are shared
conventions both tiers speak — the client tier's browser-side pipeline emits
the same event shapes internally so one renderer serves both. The recovery
machinery itself (answer cache, heartbeat, poller, relaunch marker) is
honestly server-only: it exists because a run outlives its client, which can
only happen when the run lives on a server. The client tier needs none of it
— its runs die with their tab, and its state is already sealed locally.

## Contracts

- **PA-2 (carries, at the transport level)** — a dropped connection degrades
  to a recovered answer, a dead server run degrades to an honest "interrupted"
  message within a bounded wait, and a torn parser input degrades to skipped
  frames — never a hung spinner, never an errored chat that actually finished.
- **PA-4 (carries)** — the answer cache is a disclosed, TTL'd recovery
  BUFFER, not storage: rows are readable only by the asker, ack-purged the
  moment delivery succeeds, lazy-purged past a short TTL; the relaunch marker
  is metadata ONLY (ids, settings, timestamp — never message text), and
  incognito conversations write neither a log row nor a marker.
- **PA-5 (carries)** — this is the module where "no framework" costs the
  most and pays the most: the stream loop, parser, and recovery ladder are
  owned code, because the pair's entire bug history is integration behavior
  that frameworks hide (`docs/ARCHITECTURE-ROADMAP.md` §7), and the platform
  alternative (durable execution) is explicitly NOT adopted until a trigger
  arrives (§6 — see the build plan's last step).
- **PA-10 (carries, acutely)** — disconnect detection, heartbeats, and
  recovery only reproduce in production (client aborts don't propagate in
  local dev); every layer here was verified with live request ids and has a
  named incident behind it.

## Build plan

1. **Define the SSE vocabulary.** `Content-Type: text/event-stream`;
   OpenAI-style text deltas (`{"choices":[{"delta":{"content":…}}]}`) plus
   custom `status` events: `step_start`/`step_done` (id names the phase or
   external service; `details` renders as an expandable list),
   `search_start`/`search_done` (round, query, source/service, results,
   sources), embed events as the pair grows them, `discard_text` (clear the
   streamed draft; a corrected answer follows), `done` (the stats footer:
   model, rounds, searches, duration, token sums), `{"error":…}` rendered
   inside the bubble, and a terminating `data: [DONE]` sent ALWAYS, errors
   included. Every response carries an `x-request-id` header — it is the
   correlation key for logs AND the recovery cache key the client already
   holds when its stream dies.
2. **Write the forward-compatibility rule down, both directions.** Clients
   MUST ignore unknown status types and unknown fields (new events/fields
   ship server-first and old clients keep working); servers must NEVER
   repurpose an existing event name or change a field's meaning — additive
   evolution only. Older stored turns predate newer fields, so client
   renderers always carry fallbacks for absent fields.
3. **Write the pure client line-buffer parser** — one small stateful module:
   feed decoded chunks, carry the partial trailing line between reads, emit
   parsed JSON per `data:` line, ignore comment/keepalive/blank lines and
   `[DONE]`, and DROP malformed JSON rather than throw (a torn frame must
   never kill the render loop). Node-test it; it is the one transport piece
   with no DOM dependency.
4. **Emit keepalives and detect disconnects.** A `: keepalive` comment every
   ~15 s, because the planning phases legitimately emit nothing for tens of
   seconds and idle-connection timeouts would kill the stream. Disconnect
   detection is the stream's `cancel()` hook plus enqueue failures — and
   note in the code that NEITHER fires in local dev, so this is verified via
   production logs only.
5. **Make the run survive its client.** Register the pipeline promise with
   the platform's continue-after-disconnect mechanism (`ctx.waitUntil` on
   Workers) so a vanished client doesn't kill the run, the accounting row,
   or the completion log. Document the honest bound: the post-disconnect
   grace is platform-limited, so a long synthesis after an early disconnect
   may still die — the staleness path below reports that truthfully.
6. **Build the answer cache (a buffer, NOT storage).** At stream start write
   a metadata-only `running` row keyed by request id + user id. While the
   run lives, heartbeat the row's timestamp every keepalive tick — placed
   BEFORE any client-gone early-return, because the heartbeat matters most
   exactly when the client is gone. On completion overwrite with
   `done` + the final text + the stats footer. Mirror the answer text
   server-side through the SAME event stream the client would have seen
   (including `discard_text` resets) so the cache holds exactly what an
   intact delivery would have rendered. Retention: the client ACKs an
   intact delivery with a DELETE (content normally lives server-side for
   seconds); every read/write lazy-purges rows past a short TTL (~15 min);
   rows are readable only by the asking user. Disclose the buffer in the
   privacy notice.
7. **Project running/lost/done as a pure function.** A `running` row whose
   heartbeat is older than ~3 missed beats (50 s at a 15 s beat) means the
   isolate DIED — return `lost` so the poller stops waiting for an answer
   that will never come, instead of spinning out the full deadline.
   Unit-test the projection without a database.
8. **Build the client poller with a ROLLING deadline.** Poll immediately
   first (on a boot resume the answer is usually already parked), then
   every few seconds. The initial budget-derived deadline (budget + margin)
   bounds only the wait for a FIRST sign of life; every poll that confirms
   the run is STILL GOING extends the deadline by a rolling window, hard-
   capped at the server's answer TTL — a dead run can't string the client
   along because the heartbeat check returns `lost` within ~a minute.
   Return `{data, reason}` with the full honest vocabulary: done / lost /
   gone (repeated 404s — no recovery available) / empty / timeout /
   aborted (another conversation took the screen) / stopped. Make the poll
   sleep abort-aware and claim a fresh AbortController on every recovery
   path, so the Stop button ends the WAIT immediately while the server run
   finishes unobserved. Drive the "still researching (Ns)" label with its
   own 1-second ticker, decoupled from the poll interval.
9. **Settle dead spinners on every run-end path.** A recovered payload is
   final text + stats — it does NOT replay the step events that were
   mid-flight when the stream died, so any step still spinning must be
   settled with a muted (not success) mark, or a finished answer reads as
   stuck forever.
10. **Add the client stall watchdog.** Recovery only helps if the client
    NOTICES its stream died — on mobile a backgrounded tab's socket is torn
    down and the next read frequently hangs forever with no error. Stamp a
    last-byte timestamp on EVERY read (data, keepalive, EOF); a periodic
    watchdog aborts the stream once silence exceeds ~2× the keepalive
    interval plus margin. The staleness predicate ignores time spent with
    the document hidden (a frozen tab's timers can't fire; elapsed hidden
    time is not a stall), and returning to visible resets the clock so a
    resuming connection gets a full fresh window. A watchdog abort routes
    to the RECOVERY path, never the user-stop path.
11. **Implement stop-mid-stream.** The send button becomes a stop button
    while streaming (same element, never disabled); stopping aborts the
    request but KEEPS the partial text as conversation context with a
    visible stopped marker — not an error — so the composer is immediately
    ready for a follow-up. Distinct from "new chat", which discards.
12. **Close the cold-relaunch gap with a metadata-only marker.** Mobile
    OSes can discard a backgrounded PWA outright; a cold relaunch loses the
    in-memory request id, stranding a server-finished answer. At stream
    start (once the response is confirmed live), write a single-slot
    localStorage pointer: conversation id, request id, send-time settings,
    timestamp — NEVER message text (the question lives only in the
    encrypted local record), and NOTHING for incognito conversations. TTL
    matches the server cache (past it the answer is purged anyway; a stale
    pointer only 404s). On boot, a fresh pointer whose conversation still
    awaits its answer reopens it and runs the same poller. Unit-test the
    pure parse/validate; the storage wiring is verified live. localStorage
    deliberately — it must survive the discard; session/in-memory state
    does not.
13. **Write the platform verdict down.** All of this is exactly what
    platform durable execution (Cloudflare Workflows and kin) was built to
    remove — and the reference's standing decision is NOT ADOPTED: the
    hand-built machinery works, is battle-tested, and its failure modes
    are known. Record the trigger conditions that would flip the verdict
    (budgets beyond ~10 minutes, pipeline fan-out, scheduled/background
    research, or the recovery code demanding another major investment) and
    the migration shape when one arrives: move the orchestration shell,
    keep every phase function intact.

## Reference implementation map

| Concept | Reference file(s) |
|---|---|
| The event vocabulary, canonical worked reference | `.claude/skills/sse-protocol/SKILL.md`, `docs/ARCHITECTURE.md` §4.4 |
| SSE scaffold: keepalive, heartbeat tick, answer mirroring, waitUntil, x-request-id | `src/chat.js` |
| The answer cache + pure running/lost/done projection | `src/answers.js` (`projectAnswer`, `RUNNING_STALE_MS`, `ANSWER_TTL_MS`) |
| The pure client line-buffer parser | `public/js/sse.js` |
| The rolling-deadline poller + ack + reason vocabulary | `public/js/recovery.js` (`recoverAnswer`, `ackAnswer`) |
| The resume-across-relaunch marker | `public/js/pending-answer.js` (`parsePending`; wiring in `public/js/stream.js` `armPendingRecovery`/`resumePendingAnswer`) |
| Stall watchdog + stale predicate | `public/js/stream.js` (`STREAM_STALL_MS`), `public/js/message-content.js` (`isStreamStale`) |
| Settling dead spinners; per-turn debug log | `public/js/activity.js` (`settlePendingSteps`, `buildResearchDebugJson`) |
| Stop-mid-stream semantics | `public/js/stream.js` (`stopGeneration`), `.claude/skills/ui-notes/SKILL.md` (composer notes) |
| The incident-by-incident history of every layer | `.claude/skills/live-verify/SKILL.md` |
| The durable-execution verdict + trigger conditions | `docs/ARCHITECTURE-ROADMAP.md` §6 |
| Unit suites | `src/answers.test.js`, `public/js/sse.test.js`, `public/js/pending-answer.test.js` |

## Acceptance checklist

- [ ] Parser suite green: partial-line carry across reads, keepalive/
      `[DONE]` filtering, malformed-JSON tolerance.
- [ ] `projectAnswer` suite green: running vs lost vs done, the staleness
      boundary, malformed stats tolerated.
- [ ] Relaunch-marker suite green: shape validation, TTL freshness, and —
      pinned — no text field accepted and nothing written for incognito.
- [ ] The stats footer's token sums span every model bucket that ran
      (cross-checked against the billing module's totals).
- [ ] Forward-compat spot check: an unknown status type and an unknown
      field render as no-ops in the client (add a fake event in a mock).
- [ ] Live probe — disconnect/recover: kill a mid-answer stream (background
      the tab on a real device), confirm the run finishes server-side, the
      poller recovers the answer, and the ack purges the row.
- [ ] Live probe — dead run: confirm a killed run reports `lost` within
      ~a minute, not at the full deadline.
- [ ] Live probe — stop: Stop mid-stream keeps partial text and re-arms
      the composer; Stop mid-recovery-wait ends the wait immediately.
- [ ] The privacy notice discloses the answer buffer and its TTL.

## Pitfalls

- **None of this reproduces locally.** Client aborts don't propagate in
  local dev — `cancel()` never fires, disconnects look like nothing. Every
  layer here was proven and debugged via production logs and request ids;
  budget live-verification time for it, or ship it broken and not know.
- **Silent recovery is a trap.** The reference first polled silently for
  in-session drops ("keep the banners on screen — the honest view") — and a
  203 s run read as STUCK FOREVER because the surviving banner was one
  spinner whose step-done can never be replayed to a dead stream. Settle
  dead spinners and show a ticking recovery step instead.
- **A fixed deadline abandons finished work.** A 20 s-budget request
  legitimately took 251 s server-side, finished COMPLETE, parked its answer
  — and the fixed budget+120 s deadline had abandoned the poll at 140 s,
  stranding the user beside a finished answer. Hence the rolling extension
  on every confirmed-running poll, hard-capped at the TTL; the heartbeat's
  `lost` verdict is what keeps a dead run from exploiting the extension.
- **Keepalives can defeat BOTH watchdogs.** A stream going silent
  MID-generation (socket open, no chunks) kept being fed server keepalives
  — which also kept stamping the client watchdog's last-byte clock: an
  infinite spinner by construction. The stream consumer needs its own
  mid-generation idle guard (the provider-registry module's territory);
  don't assume the transport watchdog covers it.
- **Heartbeat placement matters.** The heartbeat must fire BEFORE the
  keepalive tick's client-gone early-return — it exists precisely for the
  window after the client leaves. Piggybacked on the same interval, easy
  to reorder into uselessness during a refactor.
- **Mirror `discard_text` into the cache.** The server-side answer mirror
  must apply the same draft-reset events a live client would, or a
  recovered answer replays a discarded draft glued to the corrected one.
- **Hidden tabs are not stalled tabs.** The stall predicate must ignore
  silence accumulated while the document was hidden and reset on return to
  visible — otherwise every app-switch triggers a spurious abort exactly
  when the connection might have resumed cleanly.
- **Watchdog aborts are not user stops.** Route them to recovery, never to
  the stop handler — conflating them turns an automatic recovery into a
  silent give-up with partial text.
- **The post-disconnect grace is bounded.** A disconnect survives only if
  the REMAINING pipeline work fits the platform's canceled-invocation
  grace; a long synthesis after an early disconnect dies un-parked, and
  the staleness path reporting "interrupted on the server" is the honest
  outcome, not a bug to fix.
- **Resist rebuilding this on a platform primitive prematurely.** The
  roadmap's standing verdict: the machinery is battle-tested and its
  failure modes are KNOWN, which is worth a lot; migrate only when a
  recorded trigger condition actually arrives.
