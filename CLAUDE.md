# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Git workflow

**Always push straight to `main` after every change.** This project does not use
feature branches or pull requests for normal work — commit each change and push
it directly to `main`.

```bash
git add -A
git commit -m "…"
git push origin main
```

## Project

A Cloudflare Worker that serves a static chat UI (`public/`) and a streaming
`/api/chat` endpoint. Deployed via `npx wrangler deploy` (config in
`wrangler.toml`), git-connected to Cloudflare.

**Product intent:** the site is a *deep research* assistant, matching its
name. `/api/chat` runs a Worker-orchestrated pipeline (`src/pipeline.js`,
handler scaffold in `src/chat.js`) — no function calling; every phase is a
direct call, so it is deterministic and works on any JSON-mode model:

1. **Triage** (JSON mode): direct reply | one clarifying question | research
   plan with 2–4 queries covering different angles.
2. **Search wave**: planned queries via Exa, deduped, capped by the
   budget plan (`plan.maxSearches`).
3. **Gap check** (JSON, rounds set by the plan): audit coverage, run
   follow-up queries for missing angles.
4. **Synthesis** (streamed): answer built ONLY from the numbered source
   registry, `[n]` citations + "Sources:" list.
5. **Post-validation** (JSON): fact-check the draft against the sources; on
   "revise" the UI discards the draft (`discard_text`) and the corrected
   answer is emitted.

Helper phases fail soft (degrade to fewer searches / accepted draft — never
break the request). Search/round caps come from the time-budget planner
(`src/budget.js`).

**Time budget:** the UI slider (15 s–10 min; the clock symbol IS the thumb;
position maps quadratically to seconds for fine low-end granularity;
persisted) sends `time_budget_s` with each request; `src/budget.js` plans
the spend. Per-model EWMA stats of
each phase's duration (seeded with measured priors, per isolate, fed by
every completed phase) drive a static allocation — triage+synthesis always
paid, validation reserved next (quality gate, dropped only under tight
budgets), ~60% of the rest buys 1–4 search angles, the remainder buys gap
rounds — plus runtime deadline checks between phases (budget +15% grace;
extra gap rounds are cut first, validation last, with a visible
"Validation skipped" step when it happens).

### Code layout

Server (`src/`):

| File | Responsibility |
|---|---|
| `index.js` | Entrypoint: request id, identity gate, routing (`/api/*`, `/admin`, `/auth/google*`, `/login`, `/logout`), sliding-cookie reissue, request logs |
| `auth.js` | Identity: session cookie (365 d, sliding) + admin-secrets break-glass Basic Auth (fail closed); OAuth state HMAC helpers |
| `google.js` | Google OIDC sign-in: state cookie, code exchange, claims validation, auto-provisioning (`ADMIN_EMAIL` → admin) |
| `login.js` | Sign-in page — Google button only (PWAs can't answer a 401 challenge) |
| `accounts.js` | User accounts CRUD (D1; provisioned by Google sign-in, no passwords) |
| `db.js` | Optional D1 binding + lazy schema (no-op without the binding) |
| `config.js` | Global site config (D1 `config` table, admin-edited, cached ~30 s) |
| `quota.js` | Window usage accounting, quota enforcement, cost calc, usage recording |
| `user-api.js` | `/api/me` (usage vs quota) + `/api/models` (dropdown catalog) |
| `admin-api.js` | `/api/admin/*`: overview, invites, requests, users, config |
| `chat.js` | `/api/chat` handler: validation, model resolution, quota gate, state, SSE scaffold, usage recording |
| `pipeline.js` | The research pipeline (triage → search → gap → synth → validate) |
| `prompts.js` | All LLM prompt builders |
| `validation.js` | Request validation (messages, images) + model/vision resolution |
| `conversation.js` | Message-array utilities (textOf, image parts, formatting) |
| `budget.js` | Time-budget planner: per-model EWMA stats, plan, deadline checks |
| `berget.js` | Berget client: streaming + JSON-mode completions, model catalog (incl. raw per-token pricing) |
| `exa.js` | Exa web search |
| `log.js` | Structured JSON logger (`LOG_LEVEL` var) |
| `http.js` | Response helpers (json, SSE) |

Client (`public/`): `index.html` (markup only) + `css/app.css` +
ES modules in `js/` — `app.js` (bootstrap/wiring: scrolling, slider,
search knob, composer), `stream.js` (conversation history + `/api/chat`
SSE send loop), `models.js` (model dropdown), `attachments.js` (pending
images/docs, downscaling), `account.js` (account & usage panel),
`turns.js` (bubbles/content/tools), `activity.js` (step bars, stats,
collapse), `markdown.js` (sanitized rendering), `timescale.js` (slider
scale). Admin UI: `admin/index.html` + `js/admin.js` + `css/admin.css`
(served only to admins). Vendored libs in `vendor/` (`marked`,
`DOMPurify`).

### /api/chat SSE protocol

OpenAI-style text deltas plus custom `status` events that the UI renders as
live activity (spinners, expandable sources, stats). Clients must ignore
unknown `status` types (forward compatibility).

- `{"choices":[{"delta":{"content":"…"}}]}` — text chunk
- `{"status":{"type":"step_start","id":"plan","label":"Analyzing request…"}}` — pipeline step spinner
- `{"status":{"type":"step_done","id":"plan","label":"Planned 3 search angles","details":["query …"]}}` — checkmark; `details` renders as an expandable list
- `{"status":{"type":"search_start","round":1,"query":"…"}}` — spinner on
- `{"status":{"type":"search_done","round":1,"query":"…","results":5,"duration_ms":830,"sources":[{"title":"…","url":"…"}]}}` — expandable source list
- `{"status":{"type":"discard_text"}}` — clear the answer streamed so far and
  keep waiting (post-validation found problems; the corrected answer follows)
- `{"status":{"type":"done","model":"mistralai/…","rounds":2,"searches":4,"duration_ms":6400,"prompt_tokens":1234,"completion_tokens":97,"co2_grams":0.013}}` — stats footer
- `{"error":"…"}` — shown as an error in the bubble
- Stream terminates with `data: [DONE]`

## UI notes

- Assistant answers render as **Markdown by default** (synthesis prompt asks
  for Markdown). Rendering is client-side with vendored `marked` +
  `DOMPurify` (`public/vendor/` — no CDN; everything stays behind auth).
  Always sanitize: answers can quote hostile web content. Each answer has
  Raw (plain-text toggle), Copy, and **PDF** buttons — PDF generates a
  branded DeepResearch.se report client-side via vendored jsPDF
  (`public/js/report.js`; the 360KB lib is script-injected on first use
  only).
- **Document attachments** (`public/js/docs.js`): the paperclip accepts
  images AND `pdf`/`docx`/`md`/`txt`. Docs are parsed entirely client-side
  (txt/md directly; pdf via vendored pdf.js, dynamically imported on first
  PDF; docx via a minimal ZIP reader + `DecompressionStream("deflate-raw")`
  — no library) and embedded as labeled text blocks in the API message
  (never shown in the bubble, which gets 📄 chips). Caps: 3 docs × 9K chars
  (fits the server's 32K message limit), 4 images. Attachments render as
  rounded cards with a white circular ✕, on their own line at the BOTTOM
  of the composer pane (`#pending` after the form).
- Processing indicators are the site icon pulsing (`pulse-screw` keyframes).
- **Floating chrome (no hide/show):** header and footer are FIXED,
  click-transparent strips (`pointer-events: none`) whose glass items
  re-enable pointer events — content scrolls beneath the chrome and
  stays visible between the items and through their translucency. The
  header stacks TWO rows: the brand as plain characters (no pane, soft
  white text-glow, never captures clicks) and beneath it the glass
  controls row (New chat, model selector, account button). `#chat`
  carries top/bottom padding (5.6rem / 8rem) so the first and last
  messages can scroll clear of the fixed items.
- **Background life:** `body::before` drifts a repeating diagonal gradient
  (tiny white/navy alphas) across the sky blue — one full 280px period per
  26s loop so it's seamless; disabled under `prefers-reduced-motion`.
- **Glass chrome:** the header is transparent with the title in smaller
  type and each control (New chat, model selector, account) as its own
  frosted-glass container; the whole input area is ONE glass pane
  (`#composer`, rounded, backdrop-blur over the drifting waves): a
  single-line auto-growing text input on top (Enter inserts a LINE BREAK
  — only the arrow button sends; grows to ~6 lines), and beneath it the
  attach button (round),
  **web-search knob** (default on; sends `web_search: false` when off →
  the Worker skips triage/Exa entirely and streams one Berget
  completion), 🔍 info popover, the slider filling the remaining space,
  then the spelled-out time value (loupe/slider/value all dim while
  search is off), and a round accent **arrow send button**. "New chat"
  in the header clears the client-side history.
- **User documentation** at `/help/` (auth-gated static page): every
  control explained with real screenshots (`public/help/img/`, captured
  via Playwright) and the privacy meaning of each — linked from the
  account panel. Re-capture the screenshots when the composer/header
  changes visibly.
- **Privacy notice** on first visit (Berget/Exa processing, nothing stored
  server-side, metadata-only logs); acknowledgement remembered for a year
  in the `dr_privacy_ack` cookie.
- **Icons/manifest are auth-exempt** (`isPublicAsset` in `src/index.js`):
  iOS fetches `apple-touch-icon` and Chrome downloads manifest icons
  *without* credentials, so behind Basic Auth the home-screen/PWA icon
  silently 401s. `/favicon.ico`, `/manifest.webmanifest`, and `/icons/*`
  are public (branding only — nothing sensitive).

## Logging & observability

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
  phases (triage/gap/validation emit nothing for tens of seconds). On
  client disconnect the pipeline aborts (no further Berget/Exa spend);
  detection is the stream's `cancel()` hook + enqueue failures — note
  neither fires in `wrangler dev` local (client aborts don't propagate
  there), so verify via production Workers Logs.
- **Disconnect survival**: the pipeline promise is registered with
  `ctx.waitUntil()` — without it the runtime kills the invocation the
  moment the client vanishes, silently dropping the `chat.complete` log
  AND the `usage_events` accounting row (observed in production: a trace
  that just stops mid-pipeline). With it, the finally block always runs.
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

## LLM provider — Berget.ai

**This project uses Berget.ai, NOT Anthropic.** Berget exposes an
OpenAI-compatible API at `https://api.berget.ai/v1`.

- **Auth:** the Worker reads the `BERGET_API_TOKEN` secret (already configured
  on the Worker in the Cloudflare dashboard) and sends it as
  `Authorization: Bearer <token>`. Never hardcode the token in the repo.
- **Model:** defaults to **Mistral Small**
  (`mistralai/Mistral-Small-3.2-24B-Instruct-2506`, alias `mistral-small`),
  overridable via the optional `BERGET_MODEL` env var. Other models available
  in Berget's repo can be found at `GET https://api.berget.ai/v1/models`.
- **Model dropdown:** the UI lets users pick a model. `GET /api/models`
  (Worker) proxies Berget's catalog filtered to text models that support
  streaming + JSON mode (the research pipeline's planning/validation calls
  require it), cached ~5 min per isolate (`src/berget.js`). Models Berget reports as down (e.g.
  `status.up: false`, lifecycle `maintenance`) are included with `up: false`
  and rendered greyed out/disabled — they become selectable automatically
  when Berget brings them back. The client sends `model` in the `POST
  /api/chat` body; the Worker validates it (400 on unknown or down models)
  and falls back to the default if the catalog is unreachable. Selection
  persists in `localStorage`.
- **API shape:** OpenAI-style `POST /v1/chat/completions` with
  `stream: true`; SSE deltas arrive as `choices[0].delta.content`, terminated
  by `data: [DONE]`.
- **Image input:** models with `capabilities.vision` (exposed as `vision` in
  `/api/models`) accept OpenAI-style multimodal content:
  `content: [{type:"text",text}, {type:"image_url",image_url:{url:"data:image/…"}}]`.
  The attach button stays tappable on non-vision models (dimmed, not
  disabled — tooltips don't exist on touch devices) and offers a one-tap
  switch to a vision-capable model; the Worker rejects
  images on non-vision models (400 listing vision-capable alternatives).
  **Berget rejects request bodies over ~1 MB** ("Request payload too large";
  measured 2026-07: 1.0M chars OK, 1.2M rejected), so the client downscales
  images before attaching (canvas → JPEG, max 1280px, quality ladder, ≤280K
  chars/image, ≤700K/message) and strips images from all but the latest
  message when resending history. Server caps in `src/validation.js`: 4
  images/message, 8/request, 300K chars/image, 750K total. Image parts of
  the latest user message are forwarded to the synthesis call so research
  can use them; image-only sends get an explicit analyze instruction; JSON
  helper phases are text-only and see an `[N image(s) attached]` marker.

## Web search — Exa

**Canonical reference:** https://docs.exa.ai/reference/search-api-guide-for-coding-agents
— the source of truth for search types, parameters, and response shape. Fetch it
if anything here looks stale, and report staleness back.

Searches are orchestrated by the Worker pipeline in `src/pipeline.js` (no
function calling): the triage/gap-check phases plan queries via JSON-mode
calls, the Worker runs them against Exa, and synthesis answers from the
accumulated numbered source registry.

- **Auth:** the Worker reads the `EXA_API_KEY` secret and sends it as the
  `x-api-key` header. Never hardcode it. (Exa returns HTTP 402 without a key.)
- **Endpoint:** `POST https://api.exa.ai/search` (REST — the Worker is JS, so we
  do NOT use the `exa_py` Python SDK).
- **Request:** `{ query, type: "auto", numResults: 5, contents: { highlights: true } }`.
  `type: "auto"` balances relevance/speed; `highlights` returns token-efficient
  excerpts (preferred for LLM use over full `text`).
- **Response:** `data.results[]`, each with `title`, `url`, `highlights[]`.
- **Common mistakes:** `text`/`summary`/`highlights` must be nested under
  `contents` on `/search` (they're top-level only on `/contents`); `useAutoprompt`,
  `livecrawl`, `numSentences` are deprecated; use `includeDomains`/`excludeDomains`
  (not `includeUrls`). Search volume is capped by the time-budget plan
  (`plan.maxSearches` — `src/budget.js`).

## Access control & accounts — Google sign-in only

The whole site (UI + API) is gated; `run_worker_first = true` ensures auth
also covers the static assets. **The only user-facing sign-in is Google**
(OIDC authorization-code flow, server side, no SDK — `src/google.js`;
secrets `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, configured on the
Worker; setup reference: `docs/GOOGLE-AUTH.md`).

- **Auto-provisioning + approval gate**: any Google account with a
  **verified** email can sign in; the first sign-in creates the D1 user
  row. The `ADMIN_EMAIL` var (wrangler.toml, currently
  krister.hedfors@gmail.com) gets — and keeps — the admin role, always
  active. Everyone else lands as status **`pending`** (config
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
- **Sessions (PWA longevity)**: `dr_session` = `u.<uid>.<exp>.<hmac>`,
  **365 days, sliding** — any authenticated request past the half-life
  gets a fresh cookie appended, so an installed PWA opened at least twice
  a year never re-logs-in. HttpOnly + server-set also exempts it from
  Safari ITP's 7-day cap on script-writable storage. HMAC is keyed from
  the admin credential pair — rotating `ADMIN_PASS` logs everyone out.
- **Break-glass**: the `ADMIN_USER` / `ADMIN_PASS` secrets (legacy
  fallback `BASIC_AUTH_USER`/`BASIC_AUTH_PASS`) still work over HTTP Basic
  Auth (`curl -u …`; never via any form) — for scripts and emergencies;
  needs no DB, no Google; exempt from quotas (usage still recorded as
  user `admin`). The Worker **fails closed** if these secrets are unset
  (they also key the session HMAC). No `WWW-Authenticate` challenge is
  ever emitted.
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
when the oldest event inside ages out. Every stream records a
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

**Admin interface** at `/admin` (role-gated; non-admins get 302 → `/`):
usage totals, user management (role/status/quota/delete), config (default
quotas, Exa cost, max time budget, default model — stored in the D1
`config` table, cached ~30 s per isolate).

**D1 setup (one-time)**: `npx wrangler d1 create deepresearch-se`, paste
the id into the commented `[[d1_databases]]` block in `wrangler.toml`,
push. Schema auto-applies on first use (plus guarded additive ALTERs).
Without the binding everything degrades gracefully: break-glass auth only,
Google sign-in bounces with a clear message, no quotas.

Secrets are set in the dashboard (Worker → Settings → Variables and
Secrets) or via CLI: `ADMIN_USER`, `ADMIN_PASS`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` (plus `BERGET_API_TOKEN`, `EXA_API_KEY`).
