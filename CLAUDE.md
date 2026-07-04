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
name. `/api/chat` runs a Worker-orchestrated pipeline (`src/chat.js`) — no
function calling; every phase is a direct call, so it is deterministic and
works on any JSON-mode model:

1. **Triage** (JSON mode): direct reply | one clarifying question | research
   plan with 2–4 queries covering different angles.
2. **Search wave**: planned queries via Exa, deduped, capped
   (`MAX_TOTAL_SEARCHES`).
3. **Gap check** (JSON, up to `MAX_GAP_ITERATIONS`): audit coverage, run
   follow-up queries for missing angles.
4. **Synthesis** (streamed): answer built ONLY from the numbered source
   registry, `[n]` citations + "Sources:" list.
5. **Post-validation** (JSON): fact-check the draft against the sources; on
   "revise" the UI discards the draft (`discard_text`) and the corrected
   answer is emitted.

Helper phases fail soft (degrade to fewer searches / accepted draft — never
break the request). Pipeline constants at the top of `src/chat.js`.

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
| `index.js` | Entrypoint: request id, auth gate, routing, request logs, `/api/models` |
| `auth.js` | Basic Auth + session cookie (secrets only, fail closed) |
| `login.js` | HTML login page (PWAs can't answer a 401 challenge) |
| `chat.js` | `/api/chat` handler: validation, model resolution, state, SSE scaffold |
| `pipeline.js` | The research pipeline (triage → search → gap → synth → validate) |
| `prompts.js` | All LLM prompt builders |
| `validation.js` | Request validation (messages, images) + model/vision resolution |
| `conversation.js` | Message-array utilities (textOf, image parts, formatting) |
| `budget.js` | Time-budget planner: per-model EWMA stats, plan, deadline checks |
| `berget.js` | Berget client: streaming + JSON-mode completions, model catalog |
| `exa.js` | Exa web search |
| `log.js` | Structured JSON logger (`LOG_LEVEL` var) |
| `http.js` | Response helpers (json, SSE) |

Client (`public/`): `index.html` (markup only) + `css/app.css` +
ES modules in `js/` — `app.js` (state, wiring, SSE consumption),
`turns.js` (bubbles/content/tools), `activity.js` (step bars, stats,
collapse), `markdown.js` (sanitized rendering), `timescale.js` (slider
scale). Vendored libs in `vendor/`.

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
  `DOMPurify` (`public/vendor/` — no CDN; everything stays behind Basic
  Auth). Always sanitize: answers can quote hostile web content. Each answer
  has Raw (plain-text toggle) and Copy (raw text to clipboard) buttons.
- Processing indicators are the site icon pulsing (`pulse-screw` keyframes).
- **Immersive reading:** scrolling up in the content hides the header and
  the input/controls row (`body.immersive`) so the whole screen is content;
  only the jump-down button stays. Returning to the bottom (scroll or the
  button) restores the chrome and pins to the true bottom. Enter threshold
  is chrome height + 96px (hysteresis: hiding the chrome grows `#chat` by
  that height, so a smaller threshold would oscillate).
- Controls row above the input: **web-search knob** (default on; sends
  `web_search: false` when off → the Worker skips triage/Exa entirely and
  streams one Berget completion) and the research-time slider (dimmed while
  search is off). "New chat" in the header clears the client-side history.
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
  `chat.round`, `chat.complete`, `chat.upstream_error`, `exa.search`,
  `exa.error`.
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
  message when resending history. Server caps in `src/chat.js`: 4
  images/message, 8/request, 300K chars/image, 750K total. Image parts of
  the latest user message are forwarded to the synthesis call so research
  can use them; image-only sends get an explicit analyze instruction; JSON
  helper phases are text-only and see an `[N image(s) attached]` marker.

## Web search — Exa

**Canonical reference:** https://docs.exa.ai/reference/search-api-guide-for-coding-agents
— the source of truth for search types, parameters, and response shape. Fetch it
if anything here looks stale, and report staleness back.

Searches are orchestrated by the Worker pipeline in `src/chat.js` (no
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
  (not `includeUrls`). Search volume is capped by the pipeline constants
  (`MAX_TOTAL_SEARCHES` etc.) in `src/chat.js`.

## Access control

The whole site (UI + API) is gated. Two mechanisms, same credentials (the
`BASIC_AUTH_USER` / `BASIC_AUTH_PASS` secrets — never hardcoded; the Worker
**fails closed** if either is unset):

1. **HTTP Basic Auth** — accepted on every request (curl/scripts:
   `curl -u user:pass …`). No `WWW-Authenticate` challenge is emitted.
2. **Login page + session cookie** (`/login`, `src/login.js`) — what
   browsers and installed PWAs use. A standalone PWA cannot show the native
   Basic Auth dialog (401 challenge = black screen on iOS), so
   unauthenticated HTML navigation gets a login form; success sets a signed
   30-day `dr_session` cookie (`exp.hmac(exp)`, HMAC keyed from the
   credential pair — rotating the password invalidates sessions).

`run_worker_first = true` in `wrangler.toml` ensures auth also covers the
static assets.

Set them once in the dashboard (Worker → Settings → Variables and Secrets) or
via CLI:

```bash
npx wrangler secret put BASIC_AUTH_USER   # enter the username when prompted
npx wrangler secret put BASIC_AUTH_PASS   # enter the password when prompted
```
