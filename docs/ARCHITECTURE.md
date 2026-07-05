# Architecture — Deepresearch.se

Complete technical architecture of the site: a single Cloudflare Worker that
serves a static chat UI and orchestrates a deterministic, time-budgeted deep
research pipeline over Berget.ai (LLM) and Exa (web search), streamed to the
browser as SSE.

**Diagrams:** the editable data-flow diagrams live in
[`architecture.drawio`](./architecture.drawio) (open with
[diagrams.net](https://app.diagrams.net) or the VS Code Draw.io extension).
Four pages:

1. **System context & deployment** — clients, Worker modules, external APIs,
   secrets, deploy path
2. **Request routing & auth** — the decision tree every request goes through
3. **Research pipeline data flow** — the five phases, budget checks, and the
   source registry
4. **SSE stream sequence** — the event choreography between client, Worker,
   Berget, and Exa

Inline [Mermaid](https://mermaid.js.org) versions of the key flows are
embedded below so GitHub renders them directly.

---

## 1. System context

Everything runs in **one Cloudflare Worker** (`deepresearch-se`), deployed at
the edge, git-connected to this repo (push to `main` → build → deploy; also
deployable via `npx wrangler deploy`). There is no origin server, no
database, and no server-side storage of any chat content — all conversation
state lives in the browser and is resent with each request.

```mermaid
flowchart LR
    subgraph Clients
        B[Browser]
        P[Installed PWA]
        C[curl / scripts]
    end

    subgraph CF["Cloudflare Worker · deepresearch-se"]
        IX["src/index.js<br/>routing · auth gate · request id"]
        A["env.ASSETS<br/>static UI (public/)"]
        CH["src/chat.js + src/pipeline.js<br/>research pipeline (SSE)"]
        M["/api/models<br/>filtered catalog"]
    end

    S[("Secrets<br/>BERGET_API_TOKEN · EXA_API_KEY<br/>BASIC_AUTH_USER · BASIC_AUTH_PASS")]
    BG["Berget.ai<br/>api.berget.ai/v1<br/>OpenAI-compatible LLM API"]
    EX["Exa<br/>api.exa.ai/search<br/>web search"]
    WL["Workers Logs<br/>structured JSON"]

    B & P & C -->|HTTPS| IX
    IX --> A
    IX --> CH
    IX --> M
    CH -->|"Bearer token"| BG
    CH -->|"x-api-key"| EX
    M -->|"GET /v1/models"| BG
    S -.-> CF
    CF -.->|one JSON object per log line| WL
```

### External dependencies

| Service | Endpoint | Auth | Used for |
|---|---|---|---|
| Berget.ai | `POST https://api.berget.ai/v1/chat/completions` | `Authorization: Bearer BERGET_API_TOKEN` | All LLM calls: streaming completions + non-streaming JSON-mode calls |
| Berget.ai | `GET https://api.berget.ai/v1/models` | same | Model catalog (filtered, cached ~5 min/isolate) |
| Exa | `POST https://api.exa.ai/search` | `x-api-key: EXA_API_KEY` | Web search: `type:"auto"`, `numResults:5`, `contents:{highlights:true}` |

Known provider limits baked into the design:

- **Berget rejects request bodies over ~1 MB** (measured: 1.0M chars OK,
  1.2M rejected) → client-side image downscaling + server-side caps
  (`src/validation.js`).
- Default model `mistralai/Mistral-Small-3.2-24B-Instruct-2506`
  (override: `BERGET_MODEL` var). Only text models with **streaming +
  JSON mode** are usable — the pipeline's helper phases depend on
  `response_format: {type:"json_object"}`.
- Exa returns HTTP 402 without a key; all Exa failures degrade to an error
  string, never a failed request.

## 2. Deployment & configuration

`wrangler.toml`:

- `main = "src/index.js"` — the Worker script (having a `main` is also what
  unlocks secrets on the Worker; assets-only Workers can't hold them).
- `[assets] directory = "./public"`, `binding = "ASSETS"`,
  **`run_worker_first = true`** — the Worker sees *every* request, so the
  auth gate covers the static UI as well; assets are served via
  `env.ASSETS.fetch()`.
- `routes` — custom domains `deepresearch.se` and `www.deepresearch.se`.
- `[vars] LOG_LEVEL = "info"`; `[observability] enabled = true` persists
  logs to Workers Logs.
- Secrets are set only in the dashboard/CLI, never in the repo:
  `BERGET_API_TOKEN`, `EXA_API_KEY`, `BASIC_AUTH_USER`, `BASIC_AUTH_PASS`.

## 3. Request lifecycle & auth

Every request flows through `src/index.js`
(draw.io page 2 shows the full tree):

1. **Request id** — `crypto.randomUUID()`, attached to every log line and
   returned on every response as `x-request-id`.
2. **Public-asset bypass** — `GET/HEAD` for `/favicon.ico`,
   `/manifest.webmanifest`, `/icons/*` skip auth entirely. Reason: iOS
   fetches `apple-touch-icon` and Chrome downloads manifest icons *without*
   credentials; behind auth they silently 401 and the PWA icon breaks.
   Nothing sensitive is exposed — branding only.
3. **Public auth endpoints** — `GET /login` (the sign-in page: a single
   "Continue with Google" button), `GET /auth/google` (starts the OAuth
   flow with a signed single-use state cookie), `GET /auth/google/callback`
   (finishes it). Reachable without identity by design.
4. **Identity gate** (`src/auth.js`) — resolves *who* is calling, and
   **fails closed** (missing admin secrets ⇒ everything is denied, since
   they also key the session HMAC):
   - **Users**: D1 accounts provisioned by Google sign-in (no passwords
     stored — Google proves the email). Identified by the session cookie
     `dr_session` = `u.<uid>.<exp>.<hmac(uid.exp)>`, HMAC-SHA-256 keyed
     from the admin credential pair, **365-day TTL with sliding renewal**
     (any authenticated request past the half-life gets a fresh cookie) —
     so an installed PWA never shows a login screen again while in use.
     HttpOnly + server-set also exempts it from Safari ITP's 7-day cap.
     User status is re-checked per request; disabling kills live sessions.
   - **Break-glass admin**: the `ADMIN_USER`/`ADMIN_PASS` secrets (fallback
     `BASIC_AUTH_USER`/`BASIC_AUTH_PASS`) over HTTP Basic Auth only — for
     curl/scripts/emergencies; no DB or Google needed. No
     `WWW-Authenticate` challenge is ever emitted (native dialog = black
     screen in installed PWAs); unauthenticated HTML navigation gets the
     sign-in page, unauthenticated `/api/*` a 401 JSON body.
   - Credential comparison is constant-time-ish (`safeEqual`).
5. **Routing** — `POST /api/chat` → pipeline (with quota gate);
   `GET /api/models` → catalog; `GET /api/me` → identity + usage;
   `/api/admin/*` and `/admin*` → admin role required (403 / 302);
   `POST /logout` → cookie cleared; everything else → `env.ASSETS.fetch()`.

## 4. `POST /api/chat` — the research pipeline

### 4.1 Handler (`src/chat.js`)

A thin ~110-line shell around the pipeline:

- Parse JSON body → `validateMessages` (`src/validation.js`): roles, 60
  messages max, 32K chars/message, image caps (4/message, 8/request, 300K
  chars/image, 750K total — sized under Berget's ~1 MB body limit).
- `resolveModel`: validates a requested model against the catalog (400 on
  unknown or down models), enforces vision capability when images are
  attached (the 400 lists vision-capable alternatives), and degrades to the
  default model if the catalog is unreachable.
- `clampBudget(body.time_budget_s)` (15–600 s, default 60) and
  `web_search !== false` (knob, default on).
- Builds the per-request `state`: the budget plan, dedupe set of ran
  queries, the **numbered source registry** (`sources[]` + `byUrl` map),
  and usage totals.
- Opens a `ReadableStream` and runs `runPipeline`; the `finally` block
  *always* emits the `done` stats event and `data: [DONE]`, even after an
  error mid-stream.

### 4.2 Pipeline (`src/pipeline.js`)

The Worker orchestrates every phase directly — **no function calling**.
Every planning/validation step is a plain JSON-mode completion, so the flow
is deterministic and works on any JSON-mode model (this design replaced an
earlier tool-calling loop after Mistral emitted pseudo tool calls as text).

```mermaid
flowchart TD
    IN([POST /api/chat]) --> WS{web_search on?}
    WS -- off --> SO["Single Berget completion<br/>(searchOffPrompt)"] --> DONE
    WS -- on --> T["Phase 1 · Triage (JSON)<br/>direct | clarify | research plan"]
    T -- direct --> DR["Stream direct answer"] --> DONE
    T -- clarify --> CL["Emit one clarifying question"] --> DONE
    T -- "research (or triage failed → fallback query)" --> SW["Phase 2 · Search wave<br/>planned queries → Exa<br/>dedupe · cap · source registry"]
    SW --> GAP{"Phase 3 · Gap loop<br/>fitsDeadline? searches < cap?"}
    GAP -- "budget cut / cap" --> SY
    GAP -- proceed --> GC["Gap check (JSON)<br/>audit coverage vs source digest"]
    GC -- "coverage sufficient" --> SY
    GC -- "follow-up queries" --> FS["Follow-up searches → registry"] --> GAP
    SY["Phase 4 · Synthesis (streamed)<br/>answer ONLY from numbered sources<br/>[n] citations + Sources list<br/>(+ image parts of latest msg)"]
    SY --> V{"Phase 5 · Validation<br/>fits deadline?"}
    V -- no --> VS["step: Validation skipped<br/>to meet time target"] --> DONE
    V -- yes --> FC["Fact-check draft vs sources (JSON)"]
    FC -- pass --> DONE
    FC -- "revise" --> RV["discard_text →<br/>stream revised answer"] --> DONE
    FC -- "inconclusive / failed" --> DONE
    DONE([done stats event + DONE])
```

Phase details:

1. **Triage** (JSON, ≤500 tokens): sees the formatted conversation + latest
   message; returns `direct` | `clarify` (one question) | `research` with
   multi-angle queries (count from the budget plan). If triage fails or
   returns junk, `normalizeTriage` falls back: substantial question (≥12
   chars) → research with the raw question as the single query; otherwise
   answer directly.
2. **Search wave** (`runSearches`): each planned query → Exa. Queries are
   deduped case-insensitively (`ranQueries`), capped at `plan.maxSearches`.
   Results feed `addSources`: **deduped by URL, numbered in arrival order**
   so `[n]` citations stay stable between synthesis and validation; capped
   at `plan.maxSources`, keeping ≤3 highlights per source.
3. **Gap check** (JSON, ≤400 tokens, up to `plan.gapIterations` rounds):
   audits the source digest against the question; returns follow-up queries
   for missing angles or `complete`. Each round first passes a deadline
   check (cost of gap + 2 searches + synthesis + validation must still fit).
4. **Synthesis** (streamed): system prompt demands an answer built **only**
   from the numbered source digest, with `[n]` citations and a "Sources:"
   list, in Markdown. Image parts of the latest user message ride along
   (multimodal content) so vision models can research with the image.
5. **Post-validation** (JSON, ≤3000 tokens): fact-checks the draft against
   the same digest. `pass` → done; `revise` → the UI is told to
   **`discard_text`** (clear the streamed draft) and the corrected answer is
   emitted through the same delta path (`emitChunked`, 80-char chunks);
   inconclusive → draft kept. Skipped visibly when the budget doesn't allow
   it.

**Fail-soft invariant:** every helper phase (triage, gap check, validation)
runs through `phase()`, which catches errors, records duration into the
budget stats, logs `chat.phase` / `chat.phase_failed`, and returns `null` —
the pipeline degrades (fewer searches, skipped iteration, accepted draft)
but never fails the request. Exa failures likewise return error strings,
not exceptions.

### 4.3 Time-budget planner (`src/budget.js`)

The UI slider sends `time_budget_s`; the planner decides how to spend it.

- **Rolling stats**: an EWMA (α = 0.3) of each phase's duration
  (`triage / search / gap / synth / validate`) is kept **per model** (models
  differ several-fold in speed), seeded with priors measured on production
  runs (6.0 / 1.3 / 4.5 / 16 / 13 s). Stats live per isolate; every
  completed phase feeds `recordPhase`.
- **Static allocation** (`planResearch`), before searching begins:
  - `fixed = triage + synth` — always paid; `avail = budget − fixed`.
  - Floor: if `avail ≤` one search, run 1 query and nothing else.
  - **Validation is the quality gate** — reserved first, unless the budget
    can't hold it plus a minimal two-search plan.
  - ~60% of the remainder buys initial search angles (1–4, up to 6 at
    ≥240 s budgets).
  - What's left buys gap rounds (each ≈ gap check + 2 searches; up to 4
    rounds at ≥300 s). Bigger budgets also raise follow-ups per round
    (3→5), the search cap (up to 20), the source registry (18→24) and the
    digest size (14K→18K chars).
- **Runtime deadline checks** (`fitsDeadline`): between phases the pipeline
  re-checks that upcoming work plus remaining mandatory phases fits within
  **budget + 15% grace**. Overruns cut optional work — extra gap rounds
  first, validation last, with a visible "Validation skipped" step.

### 4.4 SSE protocol

`Content-Type: text/event-stream`; OpenAI-style deltas plus custom `status`
events. **Clients must ignore unknown status types** (forward
compatibility). Draw.io page 4 shows the full sequence.

| Event | Meaning / UI behavior |
|---|---|
| `{"choices":[{"delta":{"content":"…"}}]}` | Text chunk — append to the answer |
| `status: step_start {id, label}` | Pipeline step spinner (plan / gapN / synth / validate) |
| `status: step_done {id, label, details[]}` | Checkmark; `details` renders as an expandable list |
| `status: search_start {round, query}` | "Searching the web: …" spinner |
| `status: search_done {round, query, results, duration_ms, sources[]}` | Resolved bar with counts + expandable source links |
| `status: discard_text` | Clear the streamed draft; corrected answer follows |
| `status: done {model, rounds, searches, duration_ms, prompt_tokens, completion_tokens, co2_grams}` | Stats footer |
| `{"error":"…"}` | Shown as an error inside the bubble |
| `data: [DONE]` | Stream end (always sent, even after errors) |

## 4.5 Accounts (Google sign-in) and research quotas (D1)

Multi-user features live in an optional **Cloudflare D1** database
(`[[d1_databases]]` in `wrangler.toml`; schema auto-applies on first use
from `src/db.js`, plus guarded additive ALTERs). Without the binding the
Worker degrades gracefully: break-glass auth only, Google sign-in bounces
with a clear message, no quotas — nothing throws.

Tables: `users` (role `user|admin`, status, Google `sub`, optional
`quota_json` override), `usage_events` (per-request tokens, searches,
Berget+Exa cost, duration — no content), `config` (one JSON row, ~30 s
isolate cache).

**Onboarding is Google sign-in itself** (`src/google.js`): server-side
OIDC code flow — signed single-use state cookie (CSRF), code exchanged
server-to-server, claims validated (`iss`, `aud`, `exp`, and
`email_verified === true`; the ID token arrives directly from Google's
token endpoint over TLS, so signature verification is not required in
this flow per Google's guidance). First sign-in auto-provisions the user
row: the `ADMIN_EMAIL` address (wrangler var) gets and keeps the admin
role, everyone else is a regular user under the default quotas — that is
the cost boundary for open sign-in, and the admin can disable any user
(effective immediately, live sessions included).

**Quotas** (Claude Code-inspired): caps on research **hours** and **cost**
(EUR) per UTC calendar day / ISO week (Mon) / calendar month.

- Cost = `prompt_tokens × price_in + completion_tokens × price_out`
  (raw per-token EUR prices from Berget's catalog, carried on each model
  entry) + `searches × exa_cost_per_search_eur` (config).
- Enforcement in `/api/chat`: one aggregate query over the month window
  buckets day/week/month usage; any exceeded cap → **429** with the limit,
  usage, and reset timestamp. The requested time budget is also clamped to
  the remaining hours in the tightest window, so a single request can't
  blow through a cap. After every stream a `usage_events` row is recorded
  (fail-soft — accounting never breaks a served answer).
- Defaults live in config; per-user overrides (`quota_json`) merge over
  them; `0` means uncapped. The break-glass admin is exempt but still
  recorded.

**Dashboards**: `/api/me` powers the in-app account panel (per-period
hours/cost bars + reset times, logout, admin link); `/api/admin/overview`
powers `/admin` — site totals, per-user usage bars, user management
(role, enable/disable, quota editor, delete), and configuration (default
quotas, Exa price, max time budget, default model).

## 5. `GET /api/models`

Proxies Berget's catalog filtered to `model_type === "text"` with
`capabilities.streaming && capabilities.json_mode`, mapped to
`{id, name, pricing, up, vision}` and cached ~5 min per isolate. Down models
(`status.up === false`, e.g. maintenance) are *included* with `up:false` so
the UI greys them out — they become selectable automatically when Berget
brings them back. The same cached list backs per-request model validation
in `/api/chat`.

## 6. Client architecture (`public/`)

`index.html` is 72 lines of pure markup; all styling in `css/app.css`, all
behavior in ES modules under `js/`, vendored libraries in `vendor/`
(`marked`, `DOMPurify` — **no CDN**, everything stays behind auth).

| Module | Responsibility |
|---|---|
| `js/app.js` | State + wiring: chat history (client-side only), send flow, SSE consumption → `handleEvent` dispatch, model dropdown, web-search knob, budget slider, image attach/downscale, auto-follow scrolling, privacy notice |
| `js/turns.js` | DOM for user bubbles and assistant turns (activity `<details>` wrapper, typing indicator, Raw/Copy tools, stats footer, `resetForRevision` for `discard_text`) |
| `js/activity.js` | Live step bars (generic steps + searches), stats rendering, end-of-run collapse into one expandable "Research process" bar |
| `js/markdown.js` | Sanitized rendering: `DOMPurify.sanitize(marked.parse(text), {FORBID_TAGS:["img"]})` — `<img>` forbidden so answers can't fire third-party requests; all links `target=_blank rel=noopener` |
| `js/timescale.js` | Pure functions: slider position 0–100 ↔ 15 s–10 min **quadratic** scale (fine low-end granularity), human-friendly snapping (5/15/30 s), label formatting |

Client-side behaviors that matter architecturally:

- **Answers render as Markdown by default** (synthesis asks for Markdown);
  Raw toggles plain text; Copy copies the raw text. Sanitization is
  mandatory — answers can quote hostile web content.
- **Image handling**: canvas → JPEG downscale (max 1280 px, quality ladder)
  to ≤280K chars/image and ≤700K/message; images are stripped from all but
  the latest message when resending history — together staying under
  Berget's ~1 MB body limit with headroom for text.
- **Reading-safe streaming**: scrolling up during generation detaches
  auto-follow; a jump-to-latest button appears; the jump uses instant
  `scrollTop` (smooth scrolling re-triggered the scroll detector and
  detached follow again); scrolling to the bottom re-attaches.
- **Immersive reading**: scrolling well up in the content adds
  `body.immersive` — the header slides up and the footer slides down
  (~200 ms, grid rows 1fr→0fr so natural heights animate without magic
  max-heights) leaving the whole screen to content (only the jump button
  stays). Returning to the bottom — by scrolling or the button — slides the
  chrome back while a short rAF loop keeps the view pinned to the true
  bottom throughout the animation. The enter threshold is the hidden
  chrome's height + 96 px: hiding the chrome grows `#chat` by exactly that
  height, so a smaller threshold would re-enter the exit band and flicker.
- **Ambient background**: `body::before` (fixed, `z-index:-1`) drifts a
  repeating 135° gradient of near-invisible white/navy bands diagonally
  across the sky-blue base — translated exactly one 280 px period per 26 s
  loop for a seamless cycle; disabled under `prefers-reduced-motion`.
- **Persistence**: model selection and budget position in `localStorage`;
  privacy acknowledgement in the `dr_privacy_ack` cookie (1 year); session
  auth in the `dr_session` cookie. Chat history is memory-only — "New chat"
  or a reload clears it.

## 7. Security model

- **Fail closed**: no auth secrets configured ⇒ every request denied.
- **Two auth mechanisms, one credential pair**; cookie signatures are keyed
  from the credentials, so a password rotation is also a global logout.
- No `WWW-Authenticate` challenge (prevents the PWA black screen); APIs get
  JSON 401s, HTML navigation gets the login form.
- **Secrets never in the repo**; the Worker reads them from Cloudflare
  secret bindings only.
- **Sanitized rendering** with `<img>` forbidden (XSS + tracking-pixel
  defense against hostile quoted web content).
- Public surface without auth is exactly: favicon, manifest, `/icons/*`.
- Timing-safe credential comparison; HMAC-SHA-256 session tokens with
  expiry; `Secure; HttpOnly; SameSite=Lax`.

## 8. Logging & observability

Structured JSON, one object per line: `{time, level, event, request_id, …}`,
level via `LOG_LEVEL` (default `info`), persisted by Workers Logs
(dashboard → Worker → Logs; live: `npx wrangler tail`).

- Event vocabulary: `request.complete` / `request.failed`, `auth.denied`,
  `login.success` / `login.failed`, `chat.phase` / `chat.phase_failed`,
  `chat.budget_cut`, `chat.complete`, `exa.search`, `exa.error`,
  `models.list` / `models.error`.
- **Privacy rule**: never log secrets or chat content. User-provided text
  (e.g. search queries) appears at `debug` only; `info`+ carries counts,
  durations, statuses, token usage.
- Correlation: every response carries `x-request-id`. On `/api/chat`,
  `request.complete` marks headers-sent; `chat.complete` (rounds, searches,
  sources, duration) marks the true end of the stream.

## 9. Data at rest

**Chat content is never stored.** Conversations exist only in the browser
and in flight to Berget/Exa — exactly what the first-visit privacy notice
states. What D1 does persist is account/metering metadata only:

- `users` — email, name, role/status, Google subject id, quota override
  (no passwords — Google is the only credential)
- `usage_events` — counts, costs, and durations per request (no content)
- `config` — the admin's settings

Per-isolate ephemeral caches remain: the 5-minute model catalog, the ~30 s
config cache, and the EWMA phase-duration stats (re-seeded from priors).
