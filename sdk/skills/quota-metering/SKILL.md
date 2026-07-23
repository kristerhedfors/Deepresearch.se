---
name: quota-metering
description: >-
  Load when building the server tier's spend-control plane for a
  platform — the multi-window quota model (rolling + calendar windows,
  month-boundary math, per-user overrides), split-billing cost math across
  up-to-three model buckets and depth-priced search, usage recording as the
  one spend ledger, per-user in-flight concurrency reservations with
  distinguishable 429 payloads, typed upserted operational alerts, and the
  metadata-only per-user message center with derived-at-read-time restored
  state. Also load when reviewing anything that prices a request, blocks
  one, or records what it cost.
---

# Quota & metering — real-cost-grounded spend control

The server tier fronts paid upstream APIs on the operator's keys, so the
platform needs genuine cost control, not token counting: different models price
tokens differently, one request runs several models, and searches carry
their own per-call price. This module builds the whole plane — quota windows
and enforcement, the split-billing math that prices each model bucket at its
own catalog rate, the usage ledger every request writes, the per-user
concurrency cap that bounds check-then-act overspend, typed operational
alerts that surface production failures to the admin, and a per-user message
center that tells users about their account without ever storing content.
The governing temperament: accounting and limits are abuse mitigation, never
correctness barriers — they fail open on infrastructure trouble and never
break a served answer. (Bridged grant meters are the opposite — PA-9 — and
live in the grant-bridge module, not here.)

## Capability class & tier story

Manifest class: **S — server-backed.** Layer 2; deps `identity-access`
(quotas are per-account; the break-glass admin is exempt but recorded).
Client-tier story: honestly server-only. The client tier spends the USER's
own keys, so the platform's quota question does not arise there — its only
metering is the bridged grants' (class B, `grant-bridge`), which reuse this
module's *conventions* (429 shapes, atomic-meter thinking) but none of its
code. Nothing here may enter the client tier's module graph.

## Contracts

- **PA-2 (carries, with a boundary)** — every piece here fails SOFT:
  recording never throws, alerts are best-effort, and the concurrency
  reservation fails OPEN on any database trouble (a D1 outage must never
  block a user or 500 a request). The boundary: this open-failing posture
  is correct ONLY because these caps bound the operator's own spend on
  signed-in users; a bridged grant's meter must fail SAFE instead (PA-9) —
  never blur the two.
- **PA-3 (carries the accounting half)** — split model routing implies
  split billing: token totals are kept per model bucket and each is priced
  at its own catalog rate, so the fixed JSON model's spend and the user's
  chosen model's spend are both true.
- **PA-4 (carries)** — the message center stores structured enums and
  timestamps ONLY (no content column exists); budget EUR amounts never
  leave the admin surface (users see a percentage and a reset time);
  usage rows hold counts, costs, and durations — never text.
- **PA-10 (carries)** — window math, breach detection, cost math, and
  alert classification are all pure and unit-tested; enforcement behavior
  is verified live (the 429s, the admin exemption).

## Build plan

1. **Define the windows.** Four periods: a ROLLING last-N-hours window
   (the one that actually gates the next message) plus UTC calendar day,
   ISO week (Monday-start), and calendar month. Two pure functions:
   `windowStart(period, now)` and `windowReset(period, now, oldest)` —
   calendar resets via `Date.UTC` arithmetic (day+1 / week−dow+7 /
   month+1, which rolls year boundaries for free), the rolling window's
   reset estimated from when its OLDEST event ages out (expose that
   timestamp from the usage query). Unit-test the month-boundary wraps and
   the Monday math explicitly.
2. **Define the quota dimensions per window** — one COST cap for LLM spend
   (budget in currency: models price tokens differently, so tokens alone
   cannot cap spend) and one COUNT cap for searches (the provider bills
   per search, so the count IS the cost). `0` means uncapped. Global
   defaults live in site config; per-user overrides are a JSON column on
   the user row merged field-by-field over the defaults (clamped: budgets
   `max(0, …)`, counts rounded non-negative; malformed JSON ignored).
3. **Write the usage aggregation as ONE scan.** All windows in one query:
   filter from the MINIMUM of all window starts (the ISO week can begin
   before the month does, and the rolling window can reach past both),
   then bucket each metric per period with
   `SUM(CASE WHEN ts >= <start> THEN <expr> ELSE 0 END)` columns. Build
   three views on the same shape: one user (quota checks + the account
   panel), all users (the admin dashboard), and per model (token counts
   and real cost per model — the granular ground truth behind budgets).
4. **Write breach detection pure**: walk the periods, return the FIRST
   breached `{period, kind, limit, used, reset_at}` or null. Enforcement
   at the request gate: regular users get a 429; admins (and break-glass)
   are exempt from enforcement but their usage is still recorded and their
   bars keep counting past 100% (`enforced: false` in the me-endpoint) —
   no spend is ever invisible.
5. **Build the two sibling 429 payloads, distinguishable by clients.** The
   quota-window block: a plain-language message (period name + reset time
   — budget AMOUNTS are admin-only and never sent to users; search blocks
   may include the count) plus a public `quota` object. The concurrency
   block: its own message plus a `rate_limit: {limit, active}` object.
   Same status code, different top-level keys — clients branch on the
   payload shape, so keep both builders next to each other and treat their
   shapes as API.
6. **Write the split-billing math as a pure leaf.** A request runs up to
   three models — the answer model, the fixed JSON-planning model, and any
   vision helper — so keep one token-totals bucket PER model and price
   each at its own catalog rate (`prompt × price_in + completion ×
   price_out`) in a `summarizeSpend(state, catalog)` function. Search
   spend: live (non-cached) searches × the configured per-search price ×
   the depth tier's cost multiplier, PLUS the full-content fetches priced
   per URL at their cheaper surcharge rate. Keep this a leaf module (only
   the pure cost primitives) so every request channel — chat, MCP, future
   surfaces — shares ONE implementation instead of re-inlining it.
7. **Record usage as the one spend ledger.** After every stream, one
   row: user id, timestamp, model, prompt/completion tokens, searches,
   the LLM-cost and search-cost split, duration. Wrapped so it NEVER
   throws — accounting must not break a served answer; log the failure
   instead.
8. **Add the per-user in-flight concurrency reservation.** The quota gate
   is check-then-act: admission reads accumulated usage but spend is
   recorded only after completion, so N concurrent requests near the cap
   all pass and overspend ~N×. Bound it with a small reservation table:
   sweep rows older than a TTL (a crashed request must not hold a slot
   forever; align the TTL with the platform's per-request ceiling), count
   the user's live rows, refuse at the cap (a pure `overCap` predicate,
   unit-tested), else insert; release in the request's finally block.
   Pick the cap comfortably above honest use (a few tabs + a retry) and
   low enough to bound burst overspend. FAIL OPEN on any database error —
   `{ok: true, degraded: true}` — and make release swallow errors (a
   leaked row ages out on the next sweep).
9. **Build typed operational alerts.** Classify caught pipeline/backend
   errors into a SMALL, stable set of types (wallet depleted, connect
   exhaustion, empty completion, dropped stream, a generic fallback) —
   this list is read by admins, not a log dump. Upsert BY TYPE: a
   recurrence bumps `count`/`last_seen_at` and clears the acknowledgement
   (worth re-surfacing) instead of piling up rows. Attach remediation
   text at READ time from a lookup keyed by type — wording improvements
   then apply retroactively with no migration. Everything best-effort:
   no database → silently a no-op.
10. **Build the metadata-only message center.** Per-user account notices
    (quota exhausted, sign-in approved, quota changed) as rows of
    structured enums + timestamps with deliberately NO content column —
    nothing derived from a question or an answer can pass through it
    (PA-4). Dedupe inserts per (user, type, period, kind) within a
    ~1-hour window so a user hammering send while blocked gets one
    message, not one per attempt. "Quota restored" is NOT a second
    write: annotate a stored quota-exceeded row as `resolved` at READ
    time by comparing its (period, kind) against the caller's CURRENT
    quota state — a lifted block resolves itself. Unread count feeds the
    header badge; opening the list marks all read.
11. **Project it to users safely.** The me-endpoint emits, per window: a
    budget PERCENTAGE (never the EUR amount or limit), the search count
    and limit, the reset estimate, the `enforced` flag, and the
    notification counts. The admin overview gets everything: per-user
    and per-model costs in real currency, window totals, and the alert
    list with remediations.
12. **Verify live**: a blocked user's 429 renders the plain-language
    message; the concurrency cap refuses a burst; an admin sails past
    100% with usage still recorded; an induced provider failure raises
    (then re-raises) its typed alert.

## Reference implementation map

| Concept | Reference file(s) |
|---|---|
| Windows, quota merge, breach detection, 429 builders, reservation, recording | `src/quota.js` |
| Split-billing spend math (three buckets; search depth + contents surcharge) | `src/billing.js` (`summarizeSpend`, `exaCost`) |
| Per-model catalog prices consumed by billing | `src/berget.js` / `src/anthropic.js` / `src/openai.js` catalogs via `src/providers.js` |
| The gate wired into a request (reserve → quota → record → release) | `src/chat.js` (also reused by `src/mcp.js`) |
| Typed upserted alerts + read-time remediations | `src/alerts.js` |
| Metadata-only message center + derived restored state | `src/user-messages.js`, `src/user-api.js` (the `resolved` annotation) |
| The user projection (budget_pct, enforced, notifications) | `src/user-api.js` (`/api/me`) |
| Message-center writers (blocked / approved / quota changed) | `src/chat.js`, `src/admin-api.js` |
| Admin dashboards (per-user €, per-model ground truth) | `src/admin-api.js`, `public/js/admin.js` |
| The four-window model + opacity rules as product decisions | `.claude/skills/access-control/SKILL.md`, `docs/ARCHITECTURE.md` §4.7 |
| Unit suites (window wraps, merge/clamp, breach, cost, classification) | `src/quota.test.js`, `src/billing.test.js`, `src/alerts.test.js`, `src/chat.test.js` |

## Acceptance checklist

- [ ] Window math unit-tested including month-boundary wraps, the
      Monday-start week, and the rolling window's oldest-event reset.
- [ ] Quota merge/clamp tested: per-user overrides merge field-by-field,
      malformed JSON ignored, negatives clamped, 0 = uncapped.
- [ ] Breach detection returns the FIRST breached window with reset time;
      both 429 payloads tested and shape-distinguishable.
- [ ] Split billing tested: three buckets each at its own catalog rate;
      search cost scales by depth tier and adds the per-URL contents
      surcharge; the sums match hand-computed values.
- [ ] Concurrency reservation tested: at-cap refusal (`overCap` at exactly
      the cap), TTL sweep, fail-OPEN on a throwing database fake.
- [ ] Alert classification tested per known error family; a recurrence
      bumps count and un-acknowledges; no-DB is a silent no-op.
- [ ] The message-center table has NO content column (schema-asserted);
      dedupe window tested; `resolved` derived correctly against a
      current-quota fake.
- [ ] Live probes: a real 429 with the plain-language message; admin
      exemption with recorded usage; no EUR amount reachable from any
      non-admin endpoint (grep the projections).

## Pitfalls

- **Check-then-act WILL overspend without the reservation.** Admission
  reads pre-spend usage; spend lands after completion. The reference added
  the in-flight cap after accepting that N concurrent requests near the
  cap all pass — the cap bounds the multiplier; it does not make the gate
  transactional, and it doesn't need to.
- **Fail open here, fail safe in the bridge — never mix them.** The
  reservation and recording fail open because they bound the operator's
  own spend on authenticated users; a bridged grant meter fails safe
  because the token holder is anonymous. Copying this module's
  `catch → {ok: true}` posture into a grant meter is a real, quiet way to
  create unmetered spend.
- **Scan from the MINIMUM window start.** The ISO week routinely begins
  before the month does, and the rolling window reaches past midnight and
  month boundaries. Filtering the usage scan from the month start
  silently under-counts the week — the reference's SQL comments exist
  because this is easy to "optimize" back into a bug.
- **Budget opacity is a promise, not a style.** EUR amounts appear ONLY
  on admin endpoints; users get a percentage and a reset time — even in
  the 429. Every new projection (message center, exports, debug JSON)
  must re-honor this, because one leaked limit exposes the operator's
  cost structure.
- **Tokens alone cannot cap spend.** The whole reason for cost-based
  budgets and per-bucket pricing is that catalog rates differ by an order
  of magnitude across models — a token cap is generosity to expensive
  models and a straitjacket on cheap ones.
- **Upsert alerts by type or drown.** One row per occurrence floods the
  table on a sustained provider outage; one row per type with
  count/last-seen and self-un-acknowledgement is what makes the panel
  readable. Keep the type list SMALL — unmatched errors go to the
  generic bucket, not a new type each.
- **Remediation text lives at read time.** Storing advice on the row
  freezes yesterday's wording; the lookup-at-read pattern let the
  reference improve remediation copy retroactively with no migration.
- **"Restored" as a second write is a trap.** Deriving it at read time
  from the current quota state means a lifted block resolves itself with
  zero writes and can never desync from reality.
- **Recording must never break the answer.** The usage insert runs in a
  try/catch that logs and moves on — an accounting outage that 500s
  served responses turns a bookkeeping bug into a product outage.
