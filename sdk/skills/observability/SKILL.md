---
name: observability
description: >-
  Load when building or extending the pair's observability plane — structured
  logging, request-id correlation, the full-visibility interaction log and its
  incognito opt-out, client error/telemetry beacons, typed operational alerts,
  the admin read APIs + CLI that make production debuggable by an agent
  session, or when a bug "only happens live" / "only happens on the phone" and
  you need the live-verify or on-device-trace disciplines. Covers the declared
  PA-4 exception the interaction log constitutes, truncation and
  image-scrubbing conventions, and the no-secrets-in-logs rule.
---

# Observability, interaction logs and live verification

An agent pair is maintained by agent sessions, and an agent session's only
eyes on production are what this module records: structured logs, a
full-visibility interaction log, client beacons, and typed alerts — all
reachable through admin read APIs designed to be READ by an agent, plus the
two field disciplines (live-verify, on-device-trace) for the bug classes no
recorder catches. The reference product's entire incident history was solved
through this plane; without it a pair is unfixable the moment it leaves
`localhost`.

## Capability class & tier story

**Class S** — observability lives in the one server component and observes
the SERVER tier only. The client tier is *structurally unobservable* by
design: the server is in no data path, so there is nothing server-side to
log (this is the client tier's privacy proof, not a gap — never "fix" it).
Client-tier debugging therefore uses the client-side instruments this skill
also covers: the visible build stamp, self-explaining empty states, the
copyable on-device event trace, and a "copy the full research debug JSON"
export the user pastes into a session. Bridged (class B) calls log only the
minimal payload that crossed (a query, a token id, a meter delta) — never
conversation content, per PA-4.

## Contracts

- **PA-4 (carried, with ONE declared exception):** the interaction log stores
  complete Q&A readable server-side — a deliberate, disclosed product
  decision — and its per-conversation incognito opt-out is an API promise
  that MUST keep suppressing the row forever; everything else logged at
  `info`+ is counts, durations, statuses, ids — never message content or
  secrets.
- **PA-2 (carried):** every observability write (log row, alert upsert,
  beacon handler) fails soft — a recording failure must never break the chat
  it records.
- **PA-5 (carried):** the logger, the log table, and the alerts store are
  hand-rolled leaves with zero dependencies; no APM vendor, no log library.
- **PA-10 (enforced):** this module is what makes "verify live" cheap —
  request-id correlation, retroactive log queries, and the interaction log
  are the instruments PA-10 assumes exist.

## Build plan

1. **The logger leaf** (`log.js` pattern). One factory returning
   `{debug, info, warn, error}`; each call emits ONE JSON object per line
   (`{time, level, event, ...base, ...fields}`) so the platform's log
   store and live tail index it natively. Threshold from a `LOG_LEVEL` var
   (default `info`), levels `debug < info < warn < error`. Codify the
   privacy rule in the module header: never log secrets or Authorization
   headers; user-provided text (search queries) at `debug` only; `info`+
   carries counts/durations/statuses. Stable event names
   (`request.complete`, `chat.complete`, `chat.stream_stalled`,
   `<provider>.error`, …) — an agent greps events, not prose.
2. **Request id, issued at the entrypoint, correlated end to end.** Mint one
   id per request in the worker entrypoint; bind it into the logger's base
   fields; return it as an `x-request-id` response header; store it on the
   interaction-log row; and surface its first 8 chars as `(ref xxxxxxxx)` in
   every user-facing error bubble. One string now links a user's screenshot,
   the log rows, and the logged exchange — the whole debugging chain.
3. **The full-visibility interaction log** (the declared PA-4 exception).
   One D1-style table row per completed exchange, written from a `finally`
   block (fail-soft) by every entry point (chat handler AND any
   machine-to-machine surface like MCP): the complete question, complete
   answer, the conversation as sent, research metadata (queries run, sources
   as numbered, complexity, sub-questions, conflicts, per-provider costs,
   any tool/shell transcript), status (`ok|error|disconnected`), timings,
   and the request id. Conventions that must ship with it:
   - **Truncation is explicit.** Per-field caps sized under the row-store
     ceiling (the reference: question 32K, answer 300K, conversation 400K,
     meta 200K chars, under D1's 2 MB row limit); a trimmed field ends with
     `…[truncated N chars]` so a partial log never poses as complete.
   - **Inline images are scrubbed** to size-stamped placeholders before the
     conversation is serialized — bytes never enter the log.
   - **The incognito opt-out.** A conversation flagged incognito on the chat
     API writes NO row, ever (metadata-only platform logs and quota
     accounting still happen). This is the anonymous-chat API promise:
     honor the flag from any client, even after UI affordances change.
   - **Lazy schema** (`CREATE TABLE IF NOT EXISTS`), no migration step; the
     table is a no-op without the DB binding.
   - Retention is an explicit product decision; if pruning is ever needed,
     make it an admin action — no silent TTLs.
4. **Client beacons.** Two fire-and-forget `navigator.sendBeacon` targets on
   the server tier: an error beacon (the CLIENT's view of a died stream —
   browser error string, visibility state, chars received, and the chat
   request id for correlation) and a general telemetry beacon (structured
   counters, e.g. sandbox boot stages). Handlers sanitize and clamp every
   field, log at `warn`/`info`, and always 204 — a beacon can never error a
   page.
5. **Admin read APIs + the CLI — the agentic debugging entry point.** A
   gated `GET /api/admin/<log>` per recorder with: `limit`/`before_id`
   paging, filters (`user`, `model`, `status`, `since`, `errors=1`), a
   literal-substring keyword search `q` over question AND answer, a `/:id`
   view returning the parsed conversation + meta, and — crucially —
   `?format=text`: a plain-text render written to be READ by an agent (the
   list view already carries full Q&A so one call answers most questions).
   Wrap each in a `scripts/<name>` CLI on break-glass credentials, and
   register it in the boards discovery index (see the `decision-boards`
   module) so a fresh session finds it in one call.
6. **Typed operational alerts.** A classifier maps caught pipeline/provider
   failures into a SMALL stable set of alert types (wallet depleted, connect
   failed, empty completion, dropped stream, generic) with severity and a
   human message; rows are **upserted by `type`** — a recurrence bumps
   `count`/`last_seen_at` and un-acknowledges itself — never one row per
   occurrence. Remediation text is looked up at READ time (keyed by type)
   so wording improves retroactively. Fail-soft without the DB. Surface as
   an admin panel + notification badge: alerts exist because logs are where
   nobody is looking.
7. **The live-verify discipline** (wire it, then write it down). Enable
   persistent platform logs; document the live tail command and the
   retroactive log-query API (filter on the platform's request-id metadata
   field, epoch-ms timeframe). Record which behaviors ONLY reproduce in
   production — in the reference: client-abort/cancel hooks never fire in
   local dev, disconnect survival needs `ctx.waitUntil`, SSE keepalives,
   heartbeat/stale-run detection, answer recovery. The module's rule:
   anything touching a provider, real storage, or a real device gets a live
   probe, not just a green unit suite (PA-10).
8. **The on-device-trace instruments** (for the bugs beacons can't see).
   Permanent: a visible build stamp line in the UI (bumped every deploy,
   with data-level counts, so any screenshot reports build + data state);
   self-explaining empty states (every branch that can render blank gets a
   distinct message — "empty" and "broken" must not look alike); a CSS↔JS
   version handshake with self-repair. On demand: a copyable event-trace
   overlay — in-memory ring buffer (~60 entries), ms offsets, terse codes,
   delivered-event flags, a delayed post-check snapshotting the real DOM,
   rendered in a fixed, ENTIRELY inline-styled overlay with one-tap
   select-all — iterated over chat with the user as the probe, removed once
   the fix is confirmed.
9. **No secrets in logs — scanned, not hoped.** The rule in the logger
   header is convention; back it with the dev-workflow module's secret
   scanner run over any committed log excerpt, and a periodic grep of live
   log output for key prefixes. A secret that ever appears in a log is a
   rotation incident, not a cleanup.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Structured JSON logger, levels, privacy header | `src/log.js` |
| Request id mint + `x-request-id` + `(ref …)` | `src/index.js`, `src/answer-stream.js` (error bubbles) |
| Interaction log: caps, truncation markers, image scrub, row assembly, incognito skip | `src/chatlog.js`, schema in `src/db.js` |
| Log write from the finally block, both channels | `src/chat.js`, `src/mcp.js` (`recordChatLog`) |
| Admin read API + keyword search + `?format=text` | `src/chatlog.js` (`/api/admin/chatlogs*`) |
| The CLI wrapper | `scripts/chatlogs` |
| Client error + telemetry beacons | `src/user-api.js` (`/api/client-error`, `/api/client-log`), `public/js/stream.js`, `public/js/sandbox.js` |
| Typed alerts, upsert-by-type, read-time remediation | `src/alerts.js` |
| Live-verify machinery (keepalive, recovery, heartbeat, watchdogs) | `src/answers.js`, `public/js/recovery.js`, `public/js/pending-answer.js`, `.claude/skills/live-verify/SKILL.md` |
| Retroactive Workers Logs query recipe | `.claude/skills/live-verify/SKILL.md` |
| Build stamp, empty states, trace overlay method | `public/js/history-ui.js`, `.claude/skills/on-device-trace/SKILL.md` |
| Client-side debug export ("copy research JSON") | `public/js/activity-core.js` (`buildResearchDebugJson`) |
| The full-visibility product decision + ghost opt-out | CLAUDE.md invariant 4, `.claude/skills/chat-logs/SKILL.md` |

## Acceptance checklist

- [ ] Logger emits one JSON object per line; `LOG_LEVEL` threshold works;
      no dependency added.
- [ ] Every response carries `x-request-id`; a user-facing error carries
      `(ref …)`; the same id appears on the interaction-log row and can be
      traced through the platform's live tail AND its retroactive query API
      against the live deployment.
- [ ] Interaction-log row shape, truncation markers, image scrubbing, and
      the incognito suppression are unit-tested; an incognito exchange
      provably writes no row.
- [ ] Log writes, alert upserts, and beacon handlers all fail soft (no DB →
      no-op; a throw never reaches the chat path) — tested.
- [ ] `GET /api/admin/<log>` supports paging, filters, `q` keyword search,
      `/:id`, and `?format=text`; the `scripts/<name>` CLI works on
      break-glass credentials; the list view carries full Q&A.
- [ ] Alert classification unit-tested; a repeated failure bumps one row's
      `count` and re-surfaces it (no row flood).
- [ ] The client shows a build stamp; every empty-capable UI branch has a
      distinct message; beacons are sanitized and never error the page.
- [ ] A secret-pattern scan over log output and committed excerpts is part
      of the workflow (see `agent-dev-workflow`) — and comes back clean.

## Pitfalls

- **Local dev lies about disconnects.** In `wrangler dev`, client aborts
  never fire the stream's `cancel()` hook — the reference's whole
  disconnect/recovery machinery only reproduces in production. Verify via
  live Workers Logs, never local.
- **The retroactive log-query API clamps silently.** An out-of-range
  `timeframe` is clamped to "now" (0 events, no error) — compute epoch ms
  with `date +%s%3N`. And filter on `$metadata.requestId`, not the message
  field, which is EMPTY for structured-JSON console lines.
- **The answer's text is not evidence of server state.** A logged answer
  saying "enable the feature in Settings" does not mean the knob was off —
  the reference's known failure mode (chat_logs #47) is a gate miss
  producing no context block, whereupon the model invents instructions.
  Read the meta counters, not the model's story.
- **The UI affordance and the API promise diverge over time.** The
  reference's ghost BUTTON changed meaning (2026-07-10: it now navigates to
  the client tier) but the `incognito: true` API contract still suppresses
  the log row for any client that sends it. Version the promise, not the
  button.
- **D1 rows have a 2 MB ceiling** — that is why the caps exist. Raising a
  cap without checking the sum re-introduces silent write failures.
- **The trace overlay must be entirely inline-styled** and out of the
  suspect container's flow — on the affected iOS device, broken CSS hid the
  instrument meant to debug broken CSS, twice.
- **Re-check what's actually live before theorizing** — the reference's
  "still blue status bar" retest was against a stale deploy. The build
  stamp exists to answer this in one screenshot.
- **`wrangler tail` through a sandboxed proxy is flaky** — background it
  and parse the stream as concatenated JSON objects, not lines.
- **Don't let observability grow rows-per-occurrence anywhere.** The
  upsert-by-type alert design exists because a provider outage at request
  rate would otherwise flood the table in minutes.
