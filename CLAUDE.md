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

### Code layout

| File | Responsibility |
|---|---|
| `src/index.js` | Entrypoint: request id, Basic Auth gate, routing, request logs |
| `src/auth.js` | Basic Auth (secrets only, fail closed) |
| `src/chat.js` | `/api/chat`: streaming tool-call loop (`MAX_TOOL_ROUNDS`), input validation |
| `src/berget.js` | Berget chat-completions client + SSE consumption |
| `src/exa.js` | Exa `web_search` tool |
| `src/log.js` | Structured JSON logger (`LOG_LEVEL` var) |
| `src/http.js` | Response helpers |

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
  The UI enables the attach button only for vision models; the Worker rejects
  images on non-vision models (400 listing vision-capable alternatives) and
  enforces caps (4 images/message, 8/request, ~4 MB each as data URLs, in
  `src/chat.js`). Image parts of the latest user message are forwarded to the
  synthesis call so research can use them; JSON helper phases are text-only
  and see an `[N image(s) attached]` marker.

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

The whole site (UI + API) is behind HTTP **Basic Auth**. Credentials are read
only from the `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` secrets — never hardcoded
in the repo. The Worker **fails closed**: if either secret is unset, every
request gets 401. `run_worker_first = true` in `wrangler.toml` ensures auth
also covers the static assets.

Set them once in the dashboard (Worker → Settings → Variables and Secrets) or
via CLI:

```bash
npx wrangler secret put BASIC_AUTH_USER   # enter the username when prompted
npx wrangler secret put BASIC_AUTH_PASS   # enter the password when prompted
```
