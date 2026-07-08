# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

A Cloudflare Worker that serves a static chat UI (`public/`) and a streaming
`/api/chat` endpoint. Deployed via `npx wrangler deploy` (config in
`wrangler.toml`), git-connected to Cloudflare. The site is a *deep research*
assistant, matching its name: `/api/chat` runs a Worker-orchestrated pipeline
(triage → search → gap check → synthesis → validation) with **no function
calling** — every phase is a direct JSON-mode or streamed call, so it is
deterministic and works on any model in the catalog. The LLM provider is
**Berget.ai** (OpenAI-compatible, NOT Anthropic); web search is **Exa**.

## Git workflow

**Always push straight to `main` after every change.** This project does not use
feature branches or pull requests for normal work — commit each change and push
it directly to `main`.

```bash
git add -A
git commit -m "…"
git push origin main
```

## Load-bearing invariants

1. **Deterministic orchestration — NO function calling.** Every pipeline phase
   is a direct JSON-mode or streamed call, so the whole thing works across
   Berget's entire catalog, including models with unreliable tool-calling.
   Don't introduce function/tool-calling into the pipeline.
2. **Helper phases fail soft, never break the request.** Search, gap check,
   validation, and every enrichment (geocode/Shodan/Maps) degrade to a lesser
   result (fewer searches, accepted draft, conversation unchanged) rather than
   erroring the chat. Both Berget calls are time-bounded so a hung backend
   can't defeat that.
3. **Split model routing.** The three JSON planning phases (triage, gap check,
   validation) always run on the fixed reliable `DEFAULT_MODEL` (Mistral Small);
   only synthesis (and direct/search-off replies) run on the user's chosen
   model. Token accounting, budgeting, and profiles are all split accordingly.
4. **The privacy split.** Conversations and attached-file originals rest as
   ciphertext in BOTH the browser and (if the cloud knob is on) R2 — the ONLY
   readable exceptions are RAG-indexed material and project chats, because
   retrieval needs plaintext. The encryption key is derived server-side and
   held only in memory, never at rest beside the ciphertext. Logs are
   metadata-only (never secrets or message content). Outbound requests to
   third parties carry the minimum (a query, a coordinate, a host) — never the
   conversation, filename, or account identity.
5. **Minimal dependencies; evidence-driven exceptions.** No build step, no
   added runtime deps for the Worker/tests. Per-model overrides
   (`model-profiles.js`) and any special-casing must trace back to a reproduced
   finding, not a guess.

> **Plan status (current): this Cloudflare account is on Workers PAID.**
> `wrangler.toml` sets `[limits] cpu_ms = 300_000` (the Paid maximum, 5
> min of CPU time per request). The round-4 narrative (see the
> **pipeline-architecture** skill) is kept as the historical record of how the
> exceededCpu problem was found and fixed; the Free-plan constraints it
> describes are **no longer in effect**. When reasoning about a request being
> killed today, do NOT assume the old 10ms Free ceiling — CPU headroom is now
> 5 minutes (and note nearly all wall-clock here is idle fetch waiting, which
> never counted as CPU anyway), so an isolate dying is rare and not the routine
> outcome it once was.

## Code layout

Server (`src/`):

| File | Responsibility |
|---|---|
| `index.js` | Entrypoint: request id, identity gate, terms + approval gates, routing (`/api/*`, `/admin`, `/auth/google*`, `/login`, `/logout`, `/terms/accept`), sliding-cookie reissue, request logs |
| `auth.js` | Identity: session cookie (365 d, sliding) + admin-secrets break-glass Basic Auth (fail closed); OAuth state HMAC helpers |
| `google.js` | Google OIDC sign-in: state cookie, code exchange, claims validation, auto-provisioning (`ADMIN_EMAIL` → admin) |
| `login.js` | Sign-in, pending-approval, and one-time terms pages (PWAs can't answer a 401 challenge) |
| `accounts.js` | User accounts CRUD (D1; provisioned by Google sign-in, no passwords) |
| `db.js` | Optional D1 binding + lazy schema (no-op without the binding) |
| `config.js` | Global site config (D1 `config` table, admin-edited, cached ~30 s) |
| `quota.js` | Window usage accounting, quota enforcement, cost calc, usage recording |
| `user-api.js` | `/api/me` (usage vs quota) + `/api/models` (dropdown catalog) + `/api/client-error` (beacon) |
| `settings.js` | Per-user settings (`users.settings_json`, additive column): the `server_history` cloud-storage knob — `GET/PUT /api/settings` |
| `storage.js` | Opt-in R2 cloud storage (knob-gated writes): encrypted conversation AND project records (`/api/convos*`, `/api/projects*` — same handler), original attached files (`/api/files*`), full drain-wipe (`DELETE /api/storage`) |
| `rag.js` | Document RAG: `POST /api/embed` (Berget embedding proxy, used in BOTH storage modes) + `/api/rag/*` (Vectorize index/query, R2 export copies) |
| `answers.js` | `/api/chat/answer`: TTL'd (15 min) answer recovery cache for dropped connections — ack-purged on intact delivery |
| `admin-api.js` | `/api/admin/*`: overview, invites, requests, users, config |
| `chat.js` | `/api/chat` handler: validation, model resolution, quota gate, state, SSE scaffold, usage recording (`summarizeSpend` — the split-billing totals) |
| `pipeline.js` | The research pipeline's phase FLOW (triage → search → gap → synth → validate) |
| `sources.js` | The cross-search source registry: URL dedup, arrival-order numbering, per-domain diversity cap + overflow backfill, the numbered digest |
| `enrichment.js` | Opt-in pre-pipeline context enrichments (Shodan, Google Maps incl. the Street View vision-describe helper) — appended as labeled blocks before any model call |
| `prompts.js` | All LLM prompt builders |
| `validation.js` | Request validation (messages, images) + model/vision resolution |
| `conversation.js` | Message-array utilities (textOf, image parts, formatting) |
| `budget.js` | Time-budget planner: per-model EWMA stats, plan, deadline checks |
| `model-profiles.js` | Evidence-driven per-model overrides (priors, JSON reinforcement, validation skip) |
| `berget.js` | Berget client: streaming + JSON-mode completions (both fetch calls time-bounded — see below), model catalog (incl. raw per-token pricing) |
| `exa.js` | Exa web search |
| `shodan.js` | Shodan host-intelligence client + target extraction (opt-in `shodan_mcp` knob) — see "Shodan host intelligence" below |
| `history-key.js` | Per-user key for the client's encrypted local chat history — see "Chat history" below |
| `log.js` | Structured JSON logger (`LOG_LEVEL` var) |
| `http.js` | Response helpers (json, SSE) |

Client (`public/`): `index.html` (markup only) + `css/app.css` +
ES modules in `js/` — `app.js` (bootstrap/wiring: scrolling, slider,
search knob, composer), `stream.js` (conversation history + `/api/chat`
SSE send loop, autosaves to encrypted local history after every turn),
`sse.js` (the pure SSE line-buffer parser `stream.js`'s read loop feeds —
Node-tested), `message-content.js` (pure builders for the outgoing
message: labeled document / image-metadata / RAG-excerpt blocks, title
derivation, history image-stripping, `splitUserContent` — the
Node-testable core `stream.js` orchestrates around),
`models.js` (model dropdown), `attachments.js` (pending images/docs,
downscaling), `account.js` (account & usage panel), `turns.js`
(bubbles/content/tools, plus reconstructing a stored conversation on
load), `activity.js` (step bars, stats, collapse, and
`buildResearchDebugJson` — the "Copy research JSON" export of a turn's
COMPLETE response for pasting into Claude Code: the research process AND
the full resulting generation AND every error, server- or client-side),
`markdown.js`
(sanitized rendering), `timescale.js` (slider scale), `history-store.js`
(IndexedDB + AES-GCM: the conversation store itself — encrypted, except
project chats which rest readable because they're RAG-indexed — now also
dual-writing each record to the cloud while the knob is on),
`history-ui.js` (the left history sidebar: list/rename/delete/load),
`settings.js` (cached `/api/settings` client; `serverHistoryOn()` is the
synchronous question every storage-touching module asks), `opfs.js`
(original attached-file bytes in OPFS), `rag.js` (client RAG: chunking,
`/api/embed` batches, the `dr_rag` IndexedDB vector store, cosine top-k,
server-index push/import), `chat-rag.js` (project-chat RAG: incremental
turn indexing as a conversation grows, the `chat-<convId>` doc ids, the
sibling-chat retrieval scope, index deletion — pure text-extraction core
Node-tested), `sync.js` (bulk sync when the account knob
flips, either direction, + `pullNewer` reconciliation + the per-project
`pushProjectScope`/`drainProjectScope`), `projects.js` (project records,
file/note ingestion + indexing, the per-project knob, scope helpers),
`project-context.js` (pure builders: the project-materials block,
`projectDocIds` — Node-testable), `projects-ui.js` (the project panel:
knob at top, dropzone, add-text form, file/chat lists, header chip).
Admin UI: `admin/index.html` + `js/admin.js` + `css/admin.css` (served
only to admins). Vendored libs in `vendor/` (`marked`, `DOMPurify`).

## Unit tests (`src/*.test.js`, `public/js/*.test.js`)

Node's built-in test runner (`node:test` + `node:assert/strict` — no
dependency added, matching the project's minimal-dependency stance),
covering the pure logic that doesn't need Berget/Exa/D1: `budget.js`
(time-tier planning, deadline grace math), `quota.js` (window
start/reset including month-boundary wraps, quota merging/clamping,
breach detection, cost calc), `model-profiles.js` (override merging,
clone-not-share of nested fields), `alerts.js` (error classification),
`conversation.js` (message/content helpers), `validation.js` (message
and image caps, model resolution), `prompts.js` (structural assertions
on every prompt builder — the anti-injection note, the independent-
source rule, the JSON-only reinforcement toggle), `chat.js`
(`quotaBlockedResponse`, `resolveJsonModel`, `summarizeSpend`),
`pipeline.js`'s `normalizeTriage` (the triage-failure fallback),
`sources.js` (the source registry: `hostnameOf`, `addSources`,
`backfillOverflowSources`, `sourceDigest` — the domain-diversity logic),
`settings.js` (`parseSettings` coercion, `storageAvailability`), and
`rag.js` (`validateRagIndexPayload`, the base64⇄Float32 vector codec).

Client-side pure logic gets the same treatment even though it ships as
`public/js/`, not `src/` — `exif.js` (TIFF/EXIF parsing: GPS/camera/
timestamp extraction, byte-order handling, malformed-input safety) and
`docs.js` (the docx ZIP reader + core/app property and tracked-change/
comment extraction), `rag.js`'s pure core (`chunkText` coverage/
overlap/termination properties, `cosineSim`, `topKChunks`, the vector
codec — the module is written to be import-safe outside a browser),
`project-context.js` (the project-materials block builder, doc-id
scoping, note/name normalization), `chat-rag.js`'s pure core (chat doc
ids, the appended-block-stripping turn-text extraction, the
sibling-chat scope picker), `message-content.js` (the
outgoing-message block builders — inline document, image-metadata, and
RAG-excerpt blocks incl. the project-chat variant — plus `deriveTitle`,
`stripOldImages`, and `splitUserContent`, the pure
core extracted out of `stream.js`'s send path), `sse.js` (the SSE
line-buffer parser: partial-line carry, keepalive/`[DONE]` filtering,
malformed-JSON tolerance), and `activity.js`'s
`buildResearchDebugJson` (the copy-to-clipboard debug record: step/service
projection, per-round searches, URL-deduped sources, the full generated
`answer`, the `errored` flag + `errors` list, and the ordered timeline).
These run in Node unmodified since `File`, `Blob`,
`DecompressionStream`, and `TextDecoder` are all standard Node globals
— no DOM needed for this subset of client code.

```bash
npm test   # from the repo root: node --test src/*.test.js public/js/*.test.js
```

This is additive to, not a replacement for, the live-verification
convention: anything touching an external provider or D1 (or, on
the client side, the DOM/`<canvas>`/pdf.js) is still verified live,
since that's where this project's actual bugs have come from
historically (see the **live-verify** skill). The root `package.json`
exists solely to run this suite — it carries no build step or
dependencies of its own; deploy still reads `src/` and `public/` as
plain JS/static assets via `npx wrangler deploy`.

## End-to-end tests (`tests/`)

Playwright suite that runs against the **live site** using the
break-glass credentials (`BASIC_AUTH_USER` / `BASIC_AUTH_PASS` env vars;
sent as an `Authorization: Basic` header on every request — the Worker
never emits a challenge, so Playwright's `httpCredentials` would not
work). Self-contained npm project of its own (`tests/package.json`) —
distinct from the root `package.json` above, which only runs the unit
suite.

```bash
cd tests && npm install && npm run fixtures   # once
npm run test:mocked   # 43 tests, free: /api/chat (and /api/embed, /api/settings) intercepted
npm run test:live     # 5 tests, real Berget tokens + one Exa run
```

- **Fixtures** are generated by `make_fixtures.py`: txt/md, a hand-built
  single-page PDF, deflated AND stored docx (with entities, tabs,
  breaks), solid-color PNGs, an over-cap txt, a rejected csv, a docx
  carrying tracked changes/comments/core-properties (`metadata.docx`,
  for `public/js/docs.js`'s metadata extraction), and a real JPEG with
  EXIF including GPS (`photo.jpg`, for `public/js/exif.js` — needs
  **Pillow** — `pip install pillow` — the one non-stdlib fixture in this
  otherwise dependency-free script; skipped with a warning, not a hard
  failure, if it isn't installed). Each text-bearing fixture carries a
  unique `*-SENTINEL-*` code.
- **mocked project**: uploads run through the real UI and the real
  client-side parsers (pdf.js, the ZIP reader, `exif.js`); assertions
  target the captured `/api/chat` request payload (sentinels, doc-block
  headers, multimodal parts, caps, truncation, extracted metadata) and
  the downloaded report PDF (attached JPEGs must appear byte-for-byte
  inside it). `api.spec.js` hits real server-side validation (400s — no
  spend).
- **live project**: serial, retried once (LLM wording varies): sentinel
  echo from parsed docs, vision reading an uploaded image + live report
  embed, one budget-capped web-search run combining Exa with a doc +
  image attachment, and a stop-mid-stream check.
- **Sandbox quirks** (encoded in `playwright.config.js`): Chromium must
  be pointed at the env's `HTTPS_PROXY` explicitly, `ignoreHTTPSErrors`
  for the re-signing CA, and `--ssl-version-max=tls1.2` because the
  proxy resets Chromium's TLS 1.3 ClientHello; the browser binary is the
  pre-installed `/opt/pw-browsers/chromium`.

The **model-matrix eval** (`tests/model-eval.mjs`, `npm run eval:models`) is a
separate data-collection tool — see the **model-eval** skill for its
methodology, the `QUERY_SETS` discipline, the `tests/MODEL-EVAL-FINDINGS.md`
ledger, and the "don't commit mid-battery" rule.

## Skills

Detailed guidance is split into on-demand skills under `.claude/skills/` — load
the relevant one before working in its area:

- **pipeline-architecture** — the research pipeline engine (`src/pipeline.js`,
  `budget.js`, `model-profiles.js`, `berget.js`): the 5 phases, split model
  routing, the time-budget/EWMA planner, per-model profiles, and the
  timeout/finish_reason/exceededCpu incident history.
- **model-eval** — the model-matrix eval harness, `QUERY_SETS`, the findings
  ledger, deciding evidence-driven `model-profiles.js` entries, and
  don't-commit-mid-battery.
- **storage-privacy** — chat-history encryption + key hierarchy, the
  `server_history` cloud knob, RAG documents, projects, and the
  encryption-asymmetry rule (`storage.js`, `settings.js`, `rag.js`,
  `history-store.js`, `sync.js`, `projects.js`).
- **integrations** — external providers and the enrichment pattern: Berget,
  Exa, OpenStreetMap Nominatim geocoding, Shodan, Google Maps / Street View
  (`berget.js`, `exa.js`, `geocode.js`, `shodan.js`, `googlemaps.js`).
- **sse-protocol** — the `/api/chat` SSE event vocabulary (delta/status/done)
  and the forward-compatibility rule.
- **live-verify** — logging & observability, Workers Logs / `wrangler tail`,
  `x-request-id` / `(ref …)` correlation, and the
  disconnect/answer-recovery/heartbeat/stall-watchdog machinery that only
  reproduces in production.
- **access-control** — Google sign-in, accounts, terms + approval gates,
  sessions/PWA longevity, break-glass Basic Auth, the four-window quota model,
  the admin interface, the alerts/notification center, and D1 setup.
- **ui-notes** — the client UI/UX conventions: Markdown rendering, the PDF
  report, document/image attachments + metadata extraction, floating glass
  chrome, the `/help/` `/build/` `/story/` `/welcome/` pages, the message
  center, and the public (no-auth) surface.
