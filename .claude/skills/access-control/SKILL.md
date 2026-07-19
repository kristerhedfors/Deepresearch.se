---
name: access-control
description: >-
  Load when touching auth (src/auth.js, google.js, login.js, accounts.js),
  quotas (src/quota.js), the admin API/UI (src/admin-api.js, public/admin),
  alerts (src/alerts.js, its shared render fragments public/js/notifications.js,
  the per-user message-center view public/js/account-messages.js), or D1 setup
  (src/db.js). Covers Google OIDC sign-in,
  terms + approval gates, sessions/PWA longevity, break-glass Basic Auth, the
  four-window quota model, the admin interface, the notification/alerts center,
  and one-time D1 setup + secrets.
---

# Access control & accounts — Google sign-in only

The whole site (UI + API) is gated; `run_worker_first = true` ensures auth
also covers the static assets. **The only user-facing sign-in is Google**
(OIDC authorization-code flow, server side, no SDK — `src/google.js`;
secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, configured on the
Worker; setup reference: `docs/GOOGLE-AUTH.md`).

- **Terms gate (first sign-in)**: every D1 account must accept the terms
  of use ONCE before anything else — a single server-rendered page
  (`termsPage` in `src/login.js`, enforced in `src/index.js` ahead of the
  approval gate) condensing the `/build/` "About this project" text: what
  the site is, the EU AI Act Article 5 prohibited-use list, the privacy
  summary, one Accept button (`POST /terms/accept`). Acceptance is stamped
  as `terms_accepted_at` on the user row (additive D1 migration). `/build/`
  and `/story/` stay readable pre-acceptance (the full text the page
  summarizes); break-glass is exempt (no user row). Deliberately one
  page, once — keep it that way; no consent-page sprawl.
- **Auto-provisioning + approval gate**: any Google account with a
  **verified** email can sign in; the first sign-in creates the D1 user
  row. The `ADMIN_EMAIL` variable (set in the Cloudflare dashboard, not
  in wrangler.toml — kept out of the repo) gets — and keeps — the admin
  role, always active. Everyone else lands as status **`pending`** (config
  `require_approval`, default on): they hold a session but only ever see
  an auto-refreshing "awaiting approval" page — no APIs, no cost — until
  the admin clicks Approve in `/admin`, which takes effect on their next
  request with no re-login. Turning `require_approval` off makes new
  sign-ins active immediately (quota-capped). The admin can
  approve/disable/delete users and edit quotas in `/admin` (status is
  re-checked per request, so disabling is immediate; existing sessions
  die too). **Sole-admin policy**: the admin role is assigned only via
  `ADMIN_EMAIL` at sign-in — the admin API deliberately cannot change
  roles, so no other account can ever be promoted.
- **Flow**: `GET /auth/google` (signed single-use state cookie, CSRF) →
  Google → `GET /auth/google/callback` (code exchange server-to-server;
  claims validated: `iss`, `aud`, `exp`, `email_verified === true`;
  Google's stable `sub` stored on the user row) → session cookie → `/`.
  ID-token signature is not verified — it arrives directly from Google's
  token endpoint over TLS (per Google's own guidance for this flow).
- **`redirect_uri` must match a canonical host — `www` broke it (fixed
  2026-07-11).** The Worker is routed on BOTH `deepresearch.se` and
  `www.deepresearch.se` (wrangler.toml), and `google.js` builds `redirect_uri`
  as `${url.origin}/auth/google/callback` from the REQUEST host. Google's
  authorized-redirect-URI list is EXACT-match (no wildcards — `…/*` never
  matches), and only the apex callback was registered, so a `www` sign-in
  (Firefox Focus) sent Google a `www` callback → "Error 400:
  redirect_uri_mismatch". Fix: **canonicalize `www.* → apex` with a 301 at the
  very top of `route()`** (before the identity gate), preserving path+query, so
  the whole flow — state cookie, `redirect_uri`, callback, session — stays on
  the one registered host. Pinning only the `redirect_uri` would have split the
  CSRF state cookie across hosts, so canonicalize the host itself.
  `/auth/google` sets a cookie (never edge-cached), so the fix takes effect
  immediately. Debug the exact URI a request builds via the `google.start`
  log line (host + `redirect_uri` + `client_id`) on a live `wrangler tail`.
- **Sessions (PWA longevity)**: `dr_session` = `u.<uid>.<exp>.<hmac>`,
  **365 days, sliding** — any authenticated request past the half-life
  gets a fresh cookie appended, so an installed PWA opened at least twice
  a year never re-logs-in. HttpOnly + server-set also exempts it from
  Safari ITP's 7-day cap on script-writable storage. **The HMAC is keyed by
  the dedicated `SESSION_SECRET` secret, deliberately NOT the admin
  password.** The cookie carries `<uid>.<exp>` and its HMAC tag together,
  so keying it with a human-typed `ADMIN_PASS` made every issued cookie an
  offline brute-force oracle for the break-glass credentials (HMAC-SHA-256
  is one fast hash — a weak password cracks quickly on a GPU, and the
  recovered key both leaks the admin credential and forges any session,
  admin included). Even a low-privilege / never-approved user gets a signed
  cookie (`google.js` mints it before approval), so this was crackable by
  anyone who could sign in at all. `src/auth.js` prefers `SESSION_SECRET`,
  falls back to the legacy admin-credential key when it's unset, and always
  verifies against BOTH — so adding the secret does not log existing
  sessions out (cookies minted under the old key keep verifying), and
  rotating `SESSION_SECRET` invalidates all sessions. Round-trip +
  backward-compat + decoupling asserted in `src/auth.test.js`.
- **Break-glass**: the `ADMIN_USER` / `ADMIN_PASS` secrets (legacy
  fallback `BASIC_AUTH_USER`/`BASIC_AUTH_PASS`) still work over HTTP Basic
  Auth (`curl -u …`; never via any form) — for scripts and emergencies;
  needs no DB, no Google; exempt from quotas (usage still recorded as
  user `admin`). The Worker **fails closed** if these secrets are unset
  (they back break-glass Basic Auth and, when `SESSION_SECRET` is unset,
  the legacy HMAC key). No `WWW-Authenticate` challenge is ever emitted.
- `GOOGLE_AUTH_URL` / `GOOGLE_TOKEN_URL` env overrides exist solely so
  local tests can point the flow at a mock; production uses the defaults.

**Quotas — real-cost-grounded**: per FOUR windows (a **rolling
last-5-hours** window, Claude Code-style, plus UTC calendar day / ISO
week / month), two dimensions:
- **budget_eur** (Berget): a genuine COST cap — every request's Berget
  cost is computed as tokens × that model's actual per-token catalog
  prices and summed against the budget (different models price
  differently, so tokens alone can't cap spend). **Opaque to users**:
  `/api/chat`/`/api/me` never emit amounts — users get only a percentage
  bar ("Research budget · 43%") and, on 429, the period + reset time.
- **searches** (Exa): a count cap — Exa bills per search, so the count IS
  the cost; users see the counts.
Deliberately NO time limits. Global defaults + per-user overrides (admin
"Quota…" editor); 0 = no cap. Rolling-window resets are estimated from
when the oldest event inside ages out.

**Reset a user's quota (admin "Reset quota" button)**: `POST
/api/admin/users/:id/quota/reset` `{days?}` sets the user's
`quota_reset_at` (additive `users` column). It is a FLOOR on which
`usage_events` count — `getUsage`/`applyResetFloor` sum only events with
`ts >= quota_reset_at`. The button sets it to `now + days`
(`DEFAULT_RESET_DAYS = 7`, `quotaResetAt` clamps 1..90), which does BOTH
things the owner asked for from one field: every bar drops to zero
immediately (prior events fall below the floor) AND the user is uncapped
until the timestamp passes (new events stay below the future floor), i.e.
their available quota is extended by at least a week. It NEVER deletes a
row — `usage_events`, the admin's cost analytics, and chat history all
stay intact ("reset the quota without losing history"). Self-expires; no
cleanup. `{clear:true}` removes it (normal counting resumes). The admin
user row shows a "quota reset · until <date>" badge while a grace window
is live; the admin site-wide dashboard (`getUsageAllUsers`) intentionally
still shows RAW usage so inflation stays investigable. Every stream records a
`usage_events` row (model, tokens, searches, berget/exa cost split,
duration). **Admins are never blocked**: enforcement (the 429 gate)
applies to regular users only — admin usage is still recorded and their
panel bars keep counting past 100% (`enforced: false` in `/api/me`).
Usage under the break-glass identity (secrets Basic Auth or legacy
pre-Google cookies) is recorded as user `admin` and shown as its own
row in `/admin`, so no spend is invisible. The ADMIN sees everything: `/admin` aggregates cost + counts
per window site-wide, per user (budget bars in €, tokens + total-cost
lines), and **per model** (token counts and what they actually cost —
the granular ground truth behind the budgets). Note the usage SQL
filters from the MINIMUM of all window starts — the ISO week can begin
before the month does.

**"What has cost so much for user X?"** Two ledgers, so an answer is never
an opaque lump. `usage_events` is the ENFORCEMENT ledger (one row per
request; `berget_cost` is the SUM across every model the request ran — all
a cost cap needs). `usage_model_events` (added 2026-07-19) is the
ATTRIBUTION ledger: `recordModelUsage` writes one row per model bucket that
actually spent (answer / JSON planning / vision, from `billing.js`
`spendByModel`), so LLM spend stays attributable to the model that drove it
instead of the whole request folding onto the answer model. It is NEVER
read for enforcement — pure analytics, fully fail-soft (its failure can't
touch the served answer or the enforcement row). To investigate one user:
`GET /api/admin/user-cost?user_id=|email=` (handler `userCost`) returns the
per-window totals (`berget_cost` = LLM vs `exa_cost` = search — the first
split) plus `getUsageByModelForUser` (the per-model breakdown — the second
split). The CLI is `scripts/user-cost <email>` (break-glass Basic Auth,
like `scripts/chatlogs`). The per-model breakdown is populated for requests
served AFTER this ledger shipped; older spend still shows in the totals and
in each request's `chat_logs.meta_json` (`berget_cost`/`exa_cost`).

**Admin interface** at `/admin` (role-gated; non-admins get 302 → `/`):
notifications, usage totals, user management (role/status/quota/delete),
config (default quotas, Exa cost, max time budget, default model — stored
in the D1 `config` table, cached ~30 s per isolate).

**Notification center (`src/alerts.js`, D1 `alerts` table)**: production
issues get surfaced instead of only living in Workers Logs where nobody's
looking — added after a real incident (round 4 of the model-eval work,
see `tests/MODEL-EVAL-FINDINGS.md`) where the Berget account's wallet
balance ran out mid-session with no visible signal beyond per-request
errors. `/admin`'s "Notifications" section unifies two sources, each item
rendered with a plain-language description AND a suggested remediation
(not just a raw error) — this is meant to be acted on, not skimmed:
- **Pending sign-in approvals** — existing `status: 'pending'` users,
  each with an inline Approve button (same action as the Users list's).
- **Operational alerts** — `chat.js`'s top-level pipeline catch
  classifies the caught error (`classifyChatError`) into one of a small,
  stable set of types — `berget_insufficient_balance` (critical),
  `chat_empty_completion`, `chat_dropped_stream`, or a generic
  `chat_stream_failed` fallback — and upserts a row keyed by `type`: a
  repeat occurrence bumps `count`/`last_seen_at` and un-acknowledges the
  row (worth re-surfacing) rather than piling up duplicate rows. A
  `REMEDIATIONS` lookup in `alerts.js` attaches a suggested action per
  type at READ time (not stored on the row), so wording improvements
  apply retroactively without a migration.

`/api/admin/overview` includes the alert list; `POST
/api/admin/alerts/:id/ack` dismisses one. `/api/me` adds a
`notifications` object for admin identities only (`pending_users` +
`open_alerts` + `total`) — the header's account button renders a white
circular badge with that count (`public/js/account.js`) so an admin sees
it from the main chat view, not only after opening `/admin`. Fails soft
like every other D1-backed feature: no DB binding means alerts are
silently a no-op.

**D1 setup (one-time)**: `npx wrangler d1 create deepresearch-se`, paste
the id into the `[[d1_databases]]` block in `wrangler.toml`, push. Schema
auto-applies on first use (plus guarded additive ALTERs). Without the
binding everything degrades gracefully: break-glass auth only, Google
sign-in bounces with a clear message, no quotas.

Secrets are set in the dashboard (Worker → Settings → Variables and
Secrets) or via CLI: `ADMIN_USER`, `ADMIN_PASS`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` (plus `BERGET_API_TOKEN`, `EXA_API_KEY`).
`ADMIN_EMAIL` is a plaintext dashboard *variable* (not in wrangler.toml,
so it stays out of the public repo). The full from-scratch install guide
is in `README.md`.
