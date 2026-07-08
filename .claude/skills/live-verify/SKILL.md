---
name: live-verify
description: >-
  Load when verifying behavior against the live site, reading Workers Logs or
  running `wrangler tail`, using x-request-id / (ref …) to correlate errors,
  debugging disconnects / stream drops / answer recovery / heartbeat / stall
  watchdog machinery, or anything that only reproduces in production and not in
  `wrangler dev`.
---

# Logging & observability

- Structured JSON logs, one object per line: `{time, level, event,
  request_id, ...}`. Levels `debug|info|warn|error` via the `LOG_LEVEL` var
  (default `info`).
- Event names: `request.complete` / `request.failed`, `auth.denied`,
  `chat.round`, `chat.complete` (carries `client_gone` and `user_id`),
  `chat.client_disconnected` (client aborted the SSE stream — backgrounded
  PWA or dropped network, NOT a server failure), `chat.stream_failed`,
  `chat.client_error` (the CLIENT's own view of a died stream, reported
  via `navigator.sendBeacon` to `/api/client-error`: browser error string,
  `was_hidden`, chars received, and `chat_request_id` for correlating with
  the server-side trace), `exa.search`, `exa.error`.
- **SSE keepalive**: `/api/chat` emits a `: keepalive` comment line every
  15 s so idle-connection timeouts can't kill the stream during quiet
  phases (triage/gap/validation emit nothing for tens of seconds).
  Disconnect detection is the stream's `cancel()` hook + enqueue
  failures — note neither fires in `wrangler dev` local (client aborts
  don't propagate there), so verify via production Workers Logs.
- **Answer recovery (`src/answers.js`)**: on client disconnect the
  pipeline does NOT abort — it finishes (the spend is mostly committed
  by then) and parks the final answer + stats in the D1 `answers` table
  keyed by request id. Every request writes a metadata-only `running`
  marker at stream start and the full answer at completion; the client
  acks intact deliveries with `DELETE /api/chat/answer?id=…` (content
  normally lives server-side for seconds) and polls
  `GET /api/chat/answer?id=…` after a died stream to re-render the
  completed answer. Rows expire after 15 min (`ANSWER_TTL_MS`,
  lazy-purged on every read/write) — the privacy notice discloses this
  explicitly; it is a recovery buffer, not storage. A recovered payload is
  only the final text + stats, so it does NOT replay the `step_done` events
  for whatever phase was mid-flight when the stream dropped — those steps
  would otherwise spin forever beside a finished answer (a reported "is it
  still processing?" bug). `activity.js`'s `collapseActivity` therefore
  calls `settlePendingSteps` on every run-end path, stopping any leftover
  spinner and marking the step with a muted (not green ✓) settled mark.
- **Heartbeat / dead-run detection (the "stuck on recovering…" fix)**:
  the poller must distinguish a server still legitimately researching a
  long budget from one whose isolate DIED mid-run (a rare event now that
  the account is on Workers Paid with a 5-min CPU ceiling — see the plan
  note in the pipeline-architecture skill's round-4 section — but still
  possible: a runtime eviction, a
  waitUntil that outlives its budget, an unhandled crash). Both look
  identical as a bare `running` marker, so before this the client polled a
  static "recovering…" step for the whole `budget+120s` deadline (up to 12
  min at a 600s budget) for an answer that might never come. Now `chat.js`
  heartbeats the row every 15s (piggybacked on the keepalive tick but
  BEFORE its `disconnect.gone` early-return, so it keeps firing after the
  client leaves — exactly when the poller needs it); `heartbeatAnswer`
  bumps `ts` only for `running` rows. `GET /api/chat/answer` runs
  `projectAnswer(row, now)` (pure, unit-tested): a `running` row whose `ts`
  is older than `RUNNING_STALE_MS` (50s ≈ 3 missed beats) returns
  `{status:"lost"}` — the isolate died, its heartbeat stopped. The
  client's `recoverAnswer` now returns `{data, reason}`
  (done/lost/gone/empty/timeout/aborted): on `lost` it stops within
  ~50-65s (not 12 min) with an honest "interrupted on the server — try
  again, lower the budget if it recurs" message. `recoverAnswer` polls
  SILENTLY by default (`startLabel` null): an in-session drop keeps showing
  exactly the research banners already on screen (plan ✓, search ✓, gap
  check spinning…) — the research genuinely continued server-side, so "the
  same view as before" is the honest one, with no "connection lost" overlay;
  the turn's own typing icon already signals in-progress. A banner (with a
  live "Still researching… (Ns)" counter, driven by its own 1-second ticker
  decoupled from the 4s poll so it ticks evenly) is shown ONLY for a boot
  RESUME (`resumePendingAnswer`), where the page reloaded and there are no
  existing banners to keep. (The SERVER-side D1 heartbeat stays at 15s — it
  only needs to beat often enough for the 50s stale window; a per-second D1
  write would be wasteful.)
  It makes an interrupted run fail fast and truthfully instead of hanging
  on an indefinite spinner.
- **Client stall watchdog (the "switched to another app" fix)**: server
  survival + the recovery poll only help if the client actually NOTICES
  its stream died. On iOS a backgrounded PWA is frozen and its socket
  torn down; on return the next `reader.read()` frequently HANGS forever
  with no error, so a plain try/catch never triggers recovery and the
  user is stuck on a spinner. `public/js/stream.js` stamps `lastByteAt`
  on every read (data, keepalive, or EOF) and runs a 5s-interval watchdog
  that aborts the stream once it's been silent past `STREAM_STALL_MS`
  (30s = 2× the 15s server keepalive plus margin — a healthy stream is
  never silent that long) via `isStreamStale()` (the pure predicate lives
  in `message-content.js`, unit-tested). A watchdog abort sets
  `staleAbort` so the catch routes to `handleNetworkFailure` (recovery),
  NOT `handleStopped` (which is only for the user's Stop button). The
  predicate ignores silence while `document.hidden` (a frozen tab's
  timers can't fire and elapsed hidden time isn't a real stall), and the
  `visibilitychange`→visible handler resets `lastByteAt` so a returning
  connection gets a fresh full window to resume before being judged dead.
  This makes a short app-switch a non-event (recovers automatically).
- **Disconnect survival**: the pipeline promise is registered with
  `ctx.waitUntil()` — without it the runtime kills the invocation the
  moment the client vanishes, silently dropping the `chat.complete` log
  AND the `usage_events` accounting row (observed in production: a trace
  that just stops mid-pipeline). With it, the finally block always runs.
- **Resume across a full app relaunch (`public/js/pending-answer.js`)**:
  the stall watchdog above only helps while the tab is still ALIVE. iOS
  can DISCARD a backgrounded PWA outright — a cold relaunch loses all
  in-memory state (the request id, the on-screen turn), so before this
  the server-finished answer expired unclaimed. Now, at stream start
  (`stream.js`'s `armPendingRecovery`, only once the response is
  confirmed live) the client persists the question to encrypted history
  and drops a **metadata-only** pointer in `localStorage`
  (`dr_pending_answer`: conv id, request id, settings, timestamp — NEVER
  message text, which stays in the encrypted IndexedDB record; incognito
  chats persist nothing, so no pointer is written for them). On the next
  boot `app.js` calls `resumePendingAnswer`, which — if the pointer is
  still fresh (`PENDING_TTL_MS` = 15 min, matching `ANSWER_TTL_MS`) and
  the record is still awaiting its answer — reopens that conversation and
  polls the parked answer back via the same `recoverAnswer` path. So a
  long research run genuinely survives the PWA being reclaimed: it
  finished on the server (`ctx.waitUntil`), and the next launch collects
  it. `localStorage` (not sessionStorage/in-memory) precisely because it
  must survive the discard+relaunch; single-slot (one in-flight answer at
  a time). Because the question is now persisted at stream start rather
  than only on completion, the "nothing arrived at all" failure paths go
  through `abandonUnanswered`, which reconciles the stored record
  (re-persist the reverted history for a follow-up, delete the
  just-created record for a lone first message) instead of a bare
  in-memory `history.pop()`. `parsePending`'s shape/freshness validation
  is unit-tested; the localStorage/boot wiring is verified live. The one
  remaining un-recoverable case: a discard that outlasts the 15-min
  window (the parked answer is purged by then) — the honest limit, since
  iOS offers web pages no way to keep a stream itself alive in the
  background (no service-worker longevity, no Background Fetch on iOS).
- Stream errors shown in the UI carry a short `(ref xxxxxxxx)` — the
  first 8 chars of the request id, quotable straight into a log search.
- `BERGET_URL` env override exists solely so local tests can point the
  Berget client at a mock; production uses the default.
- **Privacy:** never log secrets or chat message content. User-provided text
  (e.g. search queries) is logged at `debug` level only; `info`+ logs carry
  counts, durations, statuses, and token usage.
- Every response carries an `x-request-id` header — use it to find the
  matching log entries.
- `[observability] enabled = true` in `wrangler.toml` persists logs to
  Workers Logs (dashboard: Worker → Logs). Live tail: `npx wrangler tail`.
- On `/api/chat`, `request.complete` fires when the SSE headers are returned;
  `chat.complete` (rounds, searches, duration) marks the end of the stream.
