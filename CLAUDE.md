# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project

A Cloudflare Worker that serves a static chat UI (`public/`) and a streaming
`/api/chat` endpoint. Deployed via `npx wrangler deploy` (config in
`wrangler.toml`), git-connected to Cloudflare. The site is a *deep research*
assistant, matching its name: `/api/chat` runs a Worker-orchestrated pipeline
(triage → search → gap check → synthesis → validation) with **no function
calling** — every phase is a direct JSON-mode or streamed call, so it is
deterministic and works on any model in the catalog. The primary LLM provider
is **Berget.ai** (OpenAI-compatible); **Anthropic (Claude)** and **OpenAI
(GPT)** are secondary, key-gated providers for answer/synthesis models
(claude-* opus/sonnet/haiku — `src/anthropic.js`; bare gpt-* —
`src/openai.js`; both dispatched via the `src/providers.js` registry; the
JSON planning phases always stay on Berget). Web search is **Exa**.

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
   model — regardless of which PROVIDER serves that model (an Anthropic answer
   model still gets Berget-Mistral JSON phases). Token accounting, budgeting,
   and profiles are all split accordingly.
4. **The privacy split.** Conversations and attached-file originals rest as
   ciphertext in BOTH the browser and (if the cloud knob is on) R2 — the ONLY
   readable exceptions are RAG-indexed material and project chats, because
   retrieval needs plaintext. The encryption key is derived server-side and
   held only in memory, never at rest beside the ciphertext. Since 2026-07-08
   (explicit product decision) the server ALSO keeps a full-visibility
   interaction log (`src/chatlog.js`, D1 `chat_logs`): every completed
   exchange's complete question, answer, and research metadata — UNLESS the
   conversation was started with the ghost (incognito) toggle, the
   anonymous-chat promise that must keep suppressing the log row
   (`incognito: true` on `/api/chat`). Secrets never appear in any log.
   Outbound requests to third parties carry the minimum (a query, a
   coordinate, a host) — never the conversation, filename, or account
   identity.
5. **Minimal dependencies; evidence-driven exceptions.** No build step, no
   added runtime deps for the Worker/tests. Per-model overrides
   (`model-profiles.js`) and any special-casing must trace back to a reproduced
   finding, not a guess.
6. **Equal Swedish and English support in ALL deterministic intent routing**
   (explicit product expectation, 2026-07-09). Every regex gate / phrase set
   that routes behavior — street-view & maps intents, follow-up/scene
   references, relative moves and here-asks, locality corrections, quiz
   intent, and any FUTURE gate — must take Swedish forms with the same
   breadth as English (including definite forms like "gatuvyn", synonyms
   like "gatubild", and common typos, mirroring the English typo sets).
   When adding or extending a gate, add the Swedish forms AND a parity
   unit test in the same change — never English-only with Swedish "later".
   The LLM phases are language-agnostic by nature; the deterministic gates
   are where parity can drift, so that's where it is enforced (see the
   "Swedish language parity" test suite in `src/googlemaps.test.js`).

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
| `settings.js` | Per-user settings (`users.settings_json`, additive column): the `server_history` cloud-storage, `shodan_mcp`, `google_maps`, and `feedback_mode` knobs — `GET/PUT /api/settings` |
| `storage.js` | Opt-in R2 cloud storage (knob-gated writes): encrypted conversation AND project records (`/api/convos*`, `/api/projects*` — same handler), original attached files (`/api/files*`), full drain-wipe (`DELETE /api/storage`) |
| `rag.js` | Document RAG: `POST /api/embed` (Berget embedding proxy, used in BOTH storage modes) + `/api/rag/*` (Vectorize index/query, R2 export copies) |
| `answers.js` | `/api/chat/answer`: TTL'd (15 min) answer recovery cache for dropped connections — ack-purged on intact delivery |
| `chatlog.js` | Full-visibility chat interaction log (D1 `chat_logs`): complete Q&A + research metadata per exchange (chat AND mcp channels), skipped for incognito; `/api/admin/chatlogs*` read API built for the agentic debugging workflow — see the **chat-logs** skill + `scripts/chatlogs` |
| `feedback.js` | Feedback mode's pipeline (D1 `feedback` + `feedback_messages`): per-reply user feedback entries as dialogue threads with the development agent — user CRUD (`/api/feedback*`) + the agent/operator queue (`/api/admin/feedback*`, chatlogs-style, `?format=text`) — see the **feedback-loop** skill + `scripts/feedback` |
| `admin-api.js` | `/api/admin/*`: overview, users, config, chatlogs, feedback |
| `chat.js` | `/api/chat` handler: validation, model resolution, quota gate, state, SSE scaffold, usage recording (`summarizeSpend` — the split-billing totals) |
| `pipeline.js` | The research pipeline's phase FLOW (triage → search → gap → synth → validate); iterates the source registries, never names a source |
| `triage.js` | The pipeline's JSON-hardening layer: the declared schemas for every JSON planning phase + `hardenJson`, and `normalizeTriage` (the triage-failure fallback) — pure, no I/O |
| `answer-stream.js` | The answer-streaming internals behind synthesis/direct/search-off replies: `streamCompletion` (reliable-model failover), the per-model attempt loop (connect retries, idle guard, finish_reason detection), `emitChunked` |
| `search-sources.js` | The auxiliary search-source REGISTRY (HF Hub + future sources): one declarative entry per source (intent/search/service/dedup/promptNote/diversity) — the parallel-work seam (see the **add-research-source** skill) |
| `sources.js` | The cross-search source registry: URL dedup, arrival-order numbering, per-origin diversity cap (per-domain; per-OWNER for huggingface.co) + overflow backfill, the numbered digest |
| `enrichment.js` | Opt-in pre-pipeline context enrichments: the ENRICHMENTS registry (run once via `runEnrichments`, blocks appended before any model call) + the Shodan runner; the Google Maps runners live in `maps-enrichment.js` |
| `maps-enrichment.js` | The Google Maps enrichment runners — one per lookup-target shape (address/place lookup, POV & map-view captures, jumps, nearby/relocation Places searches, cross-barrier crossings, the journey view) incl. the Street View vision-describe helper; orchestrates lookups → SSE events → context blocks, dispatched by `runGoogleMapsEnrichment` |
| `quiz.js` | The inline-quiz capability's pure logic: `quizIntent` (deterministic "quiz me…" gate, EN+SV, typo-tolerant, question-count parsing; triage carries a fail-soft `quiz:true` backup flag for phrasings the regexes miss), `normalizeQuiz` (hardens the quiz-generation JSON the client renders), grade-request validation/normalization — the pipeline phase is `pipeline.js`'s `runQuizGeneration` (JSON model, fail-soft to a normal answer), the interaction runs client-side (`public/js/quiz.js`) |
| `quiz-api.js` | `POST /api/quiz/grade`: grades a quiz's free-text answers (one JSON call on `DEFAULT_MODEL`, quota-gated, usage-recorded); multiple-choice picks grade client-side from the quiz payload |
| `games.js` | The games subsystem's REGISTRY + dispatch seam (the games counterpart of `providers.js`/`search-sources.js`): one declarative entry per game (id/name/emoji/tagline/path/`available(env)`/`handle`); `GET /api/games` serves the shelf the account panel renders, `/api/games/<id>/*` dispatches to the game's handler — adding a game touches no client shelf code |
| `tokemon.js` | The Tokemon game's PURE core (Node-tested): Pokémon Gen-1 mechanics verbatim under an AI-themed skin (stat/damage/catch/escape formulas, medium-fast XP, the official type chart renamed 1:1, species stats copied from documented Gen-1 species), seeded-RNG deterministic spawning per (geocell, 15-min bucket), the turn-based battle engine — see the **tokemon-game** skill |
| `tokemon-data.js` | The game core's static DATA tables (Gen-1 provenance): the renamed type chart, moves, species, starters, balls/heal items, spawn/item-drop tables — re-exported through `tokemon.js`, so consumers see one surface |
| `tokemon-api.js` | The first registered game: `/api/games/tokemon/*` (dispatched via `games.js`) — save persistence (D1 `tokemon_saves`), spawn re-derivation + proximity validation, server-side battle resolution; 503s without D1. Also the street-view AR mode: `…/scene` (a Street View frame at the player's position with spawns projected INTO the imagery, via `googlemaps.js`'s edge-cached POV capture, gated on the per-user `google_maps` knob) and `…/go` (text navigation) |
| `tokemon-nav.js` | The street-view mode's PURE side (Node-tested): the bilingual text-command grammar (`parseGoCommand` — "go north 200 m" / "gå till Kungsgatan 1" / "look right", EN+SV parity per invariant 6), spherical geodesy (`destinationPoint`/`bearingBetween`), and `projectSpawns` (bearing→x, distance→y/size placement of spawns inside a Street View frame) |
| `prompts.js` | All LLM prompt builders |
| `validation.js` | Request validation (messages, images) + model/vision resolution |
| `conversation.js` | Message-array utilities (textOf, image parts, formatting) |
| `budget.js` | Time-budget planner: per-model EWMA stats, plan, deadline checks |
| `model-profiles.js` | Evidence-driven per-model overrides (priors, JSON reinforcement, validation skip) |
| `berget.js` | Berget client (primary provider): streaming + JSON-mode completions (both fetch calls time-bounded — see below), model catalog (incl. raw per-token pricing) |
| `anthropic.js` | Anthropic (Claude) client — second, `ANTHROPIC_API_KEY`-gated provider: raw-fetch Messages API with an SSE adapter re-emitting Anthropic streams as OpenAI-style SSE (so `consumeChatStream` + all its guards work unchanged), static EUR-priced catalog (opus/sonnet/haiku) — see the **add-llm-provider** skill |
| `openai.js` | OpenAI (GPT) client — third, `OPENAI_API_KEY`-gated provider: raw-fetch Chat Completions; NO stream adapter (OpenAI SSE is the native wire format `consumeChatStream` parses), only pinned wire params (`max_completion_tokens`, `reasoning_effort: "none"`, `stream_options.include_usage`), static EUR-priced catalog (gpt-5.6-sol/terra/luna + gpt-5.4-mini) |
| `providers.js` | The LLM-provider dispatch seam: merged model catalog (`listChatModels`) + `chatCompletion`/`completeJson` routed by model-id namespace via the `SECONDARY_PROVIDERS` registry (`claude-*` → Anthropic, bare `gpt-*` → OpenAI, else Berget) — everything downstream is provider-agnostic |
| `exa.js` | Exa web search |
| `edge-cache.js` | Fail-soft Workers Cache (caches.default) get/put helpers — the shared cross-request result-cache mechanics behind `exa.js` and `googlemaps.js` |
| `hf.js` | Hugging Face Hub search (models/datasets/papers) — joins each search wave as citable registry sources when the question explicitly targets Hugging Face (`hfIntent`); `HUGGINGFACE_API_TOKEN` secret optional |
| `shodan.js` | Shodan host-intelligence client + target extraction (opt-in `shodan_mcp` knob) — see "Shodan host intelligence" below |
| `googlemaps.js` | Google Maps Platform clients (Places, Street View, Static Maps, Routes) and the edge-cached lookup orchestration (opt-in `google_maps` knob) |
| `googlemaps-blocks.js` | The Maps integration's pure labeled context-block builders (POV/jump/cross-barrier/nearby/map-view/lookup/journey blocks + the keyless `mapLink`/`panoLink` helpers and `compassDir`) — Node-tested; the API key never appears here |
| `googlemaps-text.js` | The Maps integration's pure text side: deterministic address/place extraction, every intent gate (street-view, moves, here-asks, nearby/relocation, barriers, journey), locality corrections, the conversation-state recovery (`pendingRelocation`, `extractJourneyPoints`), and `pickLookup` — the ORDERED LOOKUP_MATCHERS registry (one small matcher per ask shape; the order is the spec) — all Node-tested |
| `history-key.js` | Per-user key for the client's encrypted local chat history — see "Chat history" below |
| `log.js` | Structured JSON logger (`LOG_LEVEL` var) |
| `http.js` | Response helpers (json, SSE) |

Client (`public/`): `index.html` (markup only) + `css/app.css` +
ES modules in `js/` — `app.js` (bootstrap/wiring: scrolling, slider,
search knob, composer), `stream.js` (conversation history + `/api/chat`
SSE send loop, autosaves to encrypted local history after every turn),
`embeds.js` (the conversation embeds registry stream.js wires via
`initEmbeds`: record/prune/size-cap of pipeline-embedded elements, quiz
interaction hooks, the persisted `embeds` list — strict-checked),
`recovery.js` (the answer-recovery polling client for server-parked
answers — `recoverAnswer`'s rolling-deadline poll loop + `ackAnswer`;
delivery of a recovered answer stays in `stream.js`),
`sse.js` (the pure SSE line-buffer parser `stream.js`'s read loop feeds —
Node-tested), `message-content.js` (pure builders for the outgoing
message: labeled document / image-metadata / RAG-excerpt blocks, title
derivation, history image-stripping, `splitUserContent`, plus
`conversationCopyText`/`embedRef` — the header copy-button's plain-text
"User:/Assistant:" conversation export with images, appended blocks, and
pipeline-embedded elements (Street View panorama/frames, id-numbered)
reduced to one-line references — the
Node-testable core `stream.js` orchestrates around),
`models.js` (model dropdown), `attachments.js` (pending images/docs,
downscaling), `account.js` (the account panel SHELL: `initAccountPanel`,
the shared `PanelCtx`, and the `showView` dispatcher — the views live in
`account-views.js` (summary incl. the Feedback-mode knob, full usage,
games shelf + the shared building blocks: setting rows, info popovers,
notification badge), `account-messages.js` (the message center),
`account-settings.js` (the cloud-storage/Shodan/Maps knobs),
`account-feedback.js` (the Feedback dialogue-threads view)),
`turns.js`
(bubbles/content/tools — incl. the per-reply Feedback button + inline
form, present on every turn and shown via the body's `feedback-mode`
class so flipping the knob covers existing replies — plus
reconstructing a stored conversation on load), `quiz.js` (the interactive inline-quiz card a `quiz` SSE event
renders into the turn body: sequential questions with alternatives PLUS
a free-text field, local multiple-choice grading, `/api/quiz/grade` for
written answers, the score verdict/recap — answers persist via the
embeds registry, the completed summary is appended to the assistant
message in history; pure scoring/summary core Node-tested),
`activity.js` (step bars, stats, collapse, and
`buildResearchDebugJson` — the "Copy research JSON" export of a turn's
COMPLETE response for pasting into Claude Code: the research process AND
the full resulting generation AND every error, server- or client-side),
`imagedeck.js` (the conversation-wide IMAGE DECK: every Street View/map
frame a reply shows joins one ordered deck; clicking a thumbnail — in a
frames strip or a waypoint miniature on the interactive map — opens the
enlarged slideshow with ‹/› navigation, a mini-map of the image's
position linking to Google Maps, and a per-image chat panel whose
question continues the conversation anchored AT that image's position
via the map_view anchor; live-session only, pure registry core
Node-tested),
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

Games (`public/games/<id>/` — reached from the account panel's **Games**
view in `account.js`, which renders the shelf from `GET /api/games`, the
server-side registry in `src/games.js` — a new game appears on the shelf by
registering it, with no client shelf change). Tokemon
(`public/games/tokemon/`) is the first game: a standalone authed page —
`js/map.js` (a dependency-free slippy map over OSM raster tiles,
attribution included), `js/game.js` (movement — GPS follow, tap-to-walk,
and the TEXT-COMMAND bar posting to `…/go` — spawn polling, mode toggle,
party/bag/dex panels), `js/street.js` (street mode: renders `…/scene`'s
Street View frame with the server-projected spawn overlays inside the
imagery, turn buttons), `js/battle.js` (plays back the server's battle
event list), `js/api.js` (fetch wrappers), `tokemon.css`. All game RULES
live server-side (`src/tokemon.js`, `src/tokemon-nav.js`); the page only
presents. The
site-wide `Permissions-Policy` grants `geolocation=(self)` for this page.

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
(`quotaBlockedResponse`, `resolveJsonModel`, `summarizeSpend`), `berget.js`
(`consumeChatStream`: SSE parsing + the opt-in idle/total stream guards),
`anthropic.js` (payload conversion incl. system/image handling, the
Anthropic→OpenAI SSE adapter composed through the real `consumeChatStream`,
key-gated catalog, stop-reason mapping), `openai.js` (the GPT wire params —
`max_completion_tokens`/`reasoning_effort`/`stream_options` — native SSE
through the real `consumeChatStream`, key-gated catalog, plus an in-suite
mock-HTTP smoke over `node:http`), `providers.js` (the registry routing
predicates + the catalog merge/degrade path),
`triage.js`'s `normalizeTriage` (the triage-failure fallback),
`sources.js` (the source registry: `hostnameOf`, `addSources`,
`backfillOverflowSources`, `sourceDigest` — the domain-diversity logic),
`settings.js` (`parseSettings` coercion, `storageAvailability`),
`rag.js` (`validateRagIndexPayload`, the base64⇄Float32 vector codec),
`edge-cache.js` (the fail-soft Workers Cache get/put helpers, against a
mocked Cache API), `googlemaps.js` + `googlemaps-text.js` (block/link
builders; address/place extraction, intent gates, `pickLookup`), and
`chatlog.js` (the interaction log's pure logic: truncation markers,
inline-image scrubbing, row assembly/projection, the text rendering,
LIKE escaping), `quiz.js` (the inline-quiz pure logic: the
deterministic intent gate incl. question-count parsing, quiz-JSON
hardening, grade-request validation/normalization), and `feedback.js`
(the feedback pipeline's pure logic: create/reply validation incl.
truncation markers, the status lifecycle, row projection, the
`?format=text` rendering), and `games.js` (the
games registry/dispatch seam: entry shape, shelf payload, subpath
dispatch, unknown-game 404s, no-DB degrade), and `tokemon.js` (the
game core: type-chart parity vs the official matchups, Gen-1
stat/damage/catch/escape formula checks against hand-computed values,
spawn determinism + bucket scoping, battle flow incl. catching, fleeing,
villain rewards, XP/level-up/evolution, save normalization), and
`tokemon-nav.js` (the street-mode pure side: the bilingual command grammar
incl. the Swedish-parity suite, geodesy round-trips, spawn projection
geometry).

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
`stripOldImages`, `splitUserContent`, and `conversationCopyText` (the
copy-conversation export: turn labeling, image/attachment references,
block-body suppression), the pure
core extracted out of `stream.js`'s send path), `imagedeck.js`'s pure
core (the deck registry: entry validation/order, the latest-within-radius
waypoint lookup, reset scoping), `sse.js` (the SSE
line-buffer parser: partial-line carry, keepalive/`[DONE]` filtering,
malformed-JSON tolerance), `quiz.js`'s pure core (answer verdicts,
scoring incl. ungraded free-text handling, the completed-quiz summary
block), and `activity.js`'s
`buildResearchDebugJson` (the copy-to-clipboard debug record: step/service
projection, per-round searches, URL-deduped sources, the full generated
`answer`, the `errored` flag + `errors` list, and the ordered timeline).
These run in Node unmodified since `File`, `Blob`,
`DecompressionStream`, and `TextDecoder` are all standard Node globals
— no DOM needed for this subset of client code.

```bash
npm test            # from the repo root: node --test src/*.test.js public/js/*.test.js
npm run typecheck   # zero-build-step tsc: src/ (tsconfig.json, Workers types)
                    # + public/ (tsconfig.public.json, DOM lib) — strict,
                    # opt-in per file via // @ts-check; both must stay clean
```

This is additive to, not a replacement for, the live-verification
convention: anything touching an external provider or D1 (or, on
the client side, the DOM/`<canvas>`/pdf.js) is still verified live,
since that's where this project's actual bugs have come from
historically (see the **live-verify** skill). The root `package.json`
exists solely to run this suite and the type-checker — no build step,
dev-only dependencies (`typescript`, `@cloudflare/workers-types`);
deploy still reads `src/` and `public/` as plain JS/static assets via
`npx wrangler deploy`.

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

Two scored benchmarks complete the eval stool: the **rubric bench**
(`tests/eval-bench.mjs`, `npm run eval:bench`, ledger
`tests/EVAL-BENCH-FINDINGS.md`) — LLM-judged scores on ~27 fixed synthetic
questions — and the **HF bench** (`tests/hf-bench.mjs`, `npm run eval:hf`,
ledger `tests/HF-BENCH-FINDINGS.md`) — answer accuracy against external
Hugging Face question sets with gold answers, selected for low training-data
contamination vs the catalog models' cutoffs (`vtllms/sealqa`,
`google/deepsearchqa`; rows fetched from the datasets-server at run time,
never committed). Its pure helpers are unit-tested in
`tests/hf-bench-lib.test.js` (`node --test`). Same disciplines as the other
ledgers: fixed seed/judge/budget across a before/after comparison, don't
deploy mid-battery, append-only ledgers.

## Skills

Detailed guidance is split into on-demand skills under `.claude/skills/` — load
the relevant one before working in its area.

**Persist solved tasks as skills.** When a task gets solved in a session and
is likely to recur — a deployment path, a debugging workflow, an eval
procedure, an API quirk that cost real time to figure out — write (or extend)
a skill for it before the session ends, so the knowledge survives the session
instead of being re-derived next time. The **deploy** skill is the canonical
example: how deployment actually works here (git-connected auto-deploy vs
direct `wrangler deploy`, what the env's API token can and can't do, how to
verify a deploy went live) was figured out empirically and would otherwise
have to be rediscovered. Prefer extending an existing skill over creating a
near-duplicate; keep entries evidence-based (what was actually observed, not
what docs claim); and update the skill list below plus the skill's
`description` frontmatter so it gets loaded when relevant.

- **deploy** — how code reaches production: push-to-`main` git-connected
  auto-deploy, direct `npx wrangler deploy` (and the token's route-update
  limitation), verifying a deploy is actually live, and the
  don't-deploy-mid-battery interaction with the eval harnesses.

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
  Anthropic, OpenAI, Exa, OpenStreetMap Nominatim geocoding, Shodan, Google
  Maps / Street View, Hugging Face Hub search (`berget.js`, `anthropic.js`,
  `openai.js`, `exa.js`, `geocode.js`, `shodan.js`, `googlemaps.js`,
  `hf.js`).
- **add-llm-provider** — the playbook for adding a NEW LLM provider or new
  models to the dropdown (how Anthropic and OpenAI were added): the provider
  registry seam (`providers.js`), the catalog contract, the two worked
  examples (foreign wire → SSE adapter; native wire → params only),
  split-routing/no-function-calling constraints, secrets/feature gating, and
  the validation ladder (unit tests → mock-HTTP smoke → live probe → bench).
- **tune-provider-models** — tuning new models per codified use case
  (synthesis, JSON phases, vision describe, quiz) and running their first
  eval battery: which knob lives where (provider wire config vs
  `model-profiles.js` vs priors), which harness measures which use case,
  and the evidence-before-override rule.
- **add-research-source** — the end-to-end playbook for integrating a NEW
  deep-research source (like the HF Hub was): choosing the shape
  (search-phase source vs enrichment), intent routing, the triage-prompt
  layer, API client design with empirical probing, registry/diversity
  wiring, SSE visibility via `search_done`, and the validation protocol
  (unit tests → live probes → bench A/B → ledger).
- **sse-protocol** — the `/api/chat` SSE event vocabulary (delta/status/done)
  and the forward-compatibility rule.
- **live-verify** — logging & observability, Workers Logs / `wrangler tail`,
  `x-request-id` / `(ref …)` correlation, and the
  disconnect/answer-recovery/heartbeat/stall-watchdog machinery that only
  reproduces in production.
- **on-device-trace** — remote-debugging a bug that only reproduces on a
  user's real device (iOS PWA especially): the visible build stamp,
  self-explaining empty states, the CSS/JS version handshake, and the
  copyable on-device event-trace overlay, iterated over chat with the user
  as the probe — plus the iOS rendering/gesture facts the method
  established.
- **chat-logs** — the full-visibility chat interaction log (`src/chatlog.js`,
  D1 `chat_logs`): pulling the latest live questions/answers/errors for
  debugging (`scripts/chatlogs`, `/api/admin/chatlogs`), the ghost
  (incognito) opt-out rule, and the row shape/truncation conventions.
- **bugreport-bugfix** — the keyword-to-fix workflow for bug reports that
  are just a chat keyword ("some recent chat about X failed to do Y"):
  chatlogs keyword search, reading the meta counters, replaying the exact
  logged message through the deterministic gates, fixing at the right
  layer with the verbatim message as a regression test, and live
  verification.
- **feedback-loop** — Claude Code as the back end of Feedback mode
  (`src/feedback.js`, `scripts/feedback`, `/api/admin/feedback*`): the
  gather → decide (human-in-the-loop, EVERY entry) → act → verify →
  message-back loop over the user-feedback queue, the status lifecycle,
  the plain-language reply conventions, and running it as a standing loop.
- **access-control** — Google sign-in, accounts, terms + approval gates,
  sessions/PWA longevity, break-glass Basic Auth, the four-window quota model,
  the admin interface, the alerts/notification center, and D1 setup.
- **ui-notes** — the client UI/UX conventions: Markdown rendering, the PDF
  report, document/image attachments + metadata extraction, floating glass
  chrome, the `/help/` `/build/` `/story/` `/welcome/` pages, the message
  center, and the public (no-auth) surface.
- **tokemon-game** — the games subsystem (the `src/games.js` registry/dispatch
  seam + how to add a NEW game) and the Tokemon open-world AR game itself
  (account panel → Games): the no-invented-game-logic rule (Pokémon Gen-1
  mechanics verbatim, mapped species/moves), the pure-core/API/client split,
  deterministic spawning, and the server-authoritative battle protocol.
