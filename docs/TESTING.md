# Testing — what covers what

The full test-surface enumeration, moved out of CLAUDE.md (2026-07-17).
The commands and the live-verification rule stay in CLAUDE.md; this file
is the per-suite detail: what each unit suite covers, the end-to-end
(Playwright) projects and their fixtures/sandbox quirks, and the three
eval harnesses. Keep it current in the same commit that adds a test
suite (the update-docs skill's drift greps target this file).

## Unit tests (`src/*.test.js`, `public/js/*.test.js`)

Node's built-in test runner (`node:test` + `node:assert/strict` — no
dependency added, matching the project's minimal-dependency stance),
covering the pure logic and mockable seams that don't need a live
Berget/Exa/D1: `budget.js`
(time-tier planning, deadline grace math), `quota.js` (window
start/reset including month-boundary wraps, quota merging/clamping,
breach detection, cost calc), `model-profiles.js` (override merging,
clone-not-share of nested fields), `alerts.js` (error classification),
`conversation.js` (message/content helpers), `validation.js` (message
and image caps, model resolution), `prompts.js` (structural assertions
on every prompt builder — the anti-injection note, the independent-
source rule, the JSON-only reinforcement toggle), `chat.js`
(`quotaBlockedResponse` via its `quota.js` re-export, `resolveJsonModel`,
`summarizeSpend` via its `billing.js` re-export), `billing.js` (the shared split-billing spend
math directly: `summarizeSpend`'s three model buckets each at their own
catalog rate, `exaCost`'s depth-tier scaling + `/contents` surcharge),
`berget.js`
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
`rag.js` (`validateRagIndexPayload`, the base64⇄Float32 vector codec,
the `idOk` key-path id validator shared with `storage.js`),
`vault.js` (the project-vault endpoints against a mocked R2 bucket:
id validation, PUT/GET/DELETE round-trip, size/count caps, per-user
namespacing, and the works-with-the-knob-OFF guarantee),
`pub.js` (published research replays: slug rules incl. the dot-free
asset-collision guard, `validatePublication`, the publish → public read
→ index → unpublish round-trip against a mocked R2, storage-missing
503s),
`edge-cache.js` (the fail-soft Workers Cache get/put helpers, against a
mocked Cache API), `googlemaps.js` + `googlemaps-text.js` (block/link
builders; address/place extraction, intent gates, `pickLookup`), and
`chatlog.js` (the interaction log's pure logic: truncation markers,
inline-image scrubbing, row assembly/projection, the text rendering,
LIKE escaping), `quiz.js` (the inline-quiz pure logic: the
deterministic intent gate incl. question-count parsing, quiz-JSON
hardening, grade-request validation/normalization), and `feedback.js`
(the feedback pipeline's pure logic: create/reply validation incl.
truncation markers, screenshot-image validation/decoding/size caps, the
status lifecycle, row projection incl. image-metadata splitting, the
`?format=text` rendering incl. IMAGES lines), and `board.js` (the decision-board core:
patch/vote validation, the priority/rank orderings incl. stable-sort
tiebreaks and closed-item sinking, `reviewState` defaults, the D1
helpers' SQL shape, `projectedBoardItem`'s row-or-undefined + catalog-
index contract, and the façade contract pinning that a board's
re-exported surface IS the core), and `security-risks.js` (the review
board's own logic: catalog shape/mirror discipline, the fix-order vs
severity orderings, the `?format=text` fix-loop
rendering), and `features.js` (the features/priority board's own logic:
catalog shape/mirror discipline against `FEATURES.md` §3, the build-order
vs impact orderings, the façade-is-the-core identity check, the
`?format=text` build-loop rendering), and `panels.js` (the panel-selection
board's own logic: catalog shape (one lowercase-slug entry per admin panel),
the votes-driven FOCUS ordering vs the authored default order, the
façade-is-the-core identity check, and the `?format=text` attention-loop
rendering incl. the muted flag), and `games.js` (the
games registry/dispatch seam: entry shape, shelf payload, subpath
dispatch, unknown-game 404s, no-DB degrade), and `tokemon.js` (the
game core: type-chart parity vs the official matchups, Gen-1
stat/damage/catch/escape formula checks against hand-computed values,
spawn determinism + bucket scoping, battle flow incl. catching, fleeing,
villain rewards, XP/level-up/evolution, save normalization, and the
client-view projections — IVs and the foe roster never leak — plus
`parseLatLng`), and
`tokemon-nav.js` (the street-mode pure side: the bilingual command grammar
incl. the Swedish-parity suite, geodesy round-trips, spawn projection
geometry).

Additional server suites cover the request/routing and infra seams:
`mcp.js` (the PURE JSON-RPC / MCP protocol helpers, asserted to load
WITHOUT pulling in the pipeline), `model-routing.js` (the shared
`resolveJsonModel` split-routing decision `chat.js` and `mcp.js` both
delegate to), `pipeline.js` + `pipeline-inputs.js` (the flow's pure
pieces — `normalizeTriage`, `collectConflicts`,
`isTransientConnectStatus`, and the input-block builders/parsers),
`notes.js` (note normalization + cross-wave merge + the bounded digest),
`schema.js` (the validator combinators and the coerce-or-return-original
contract), `assets.js` (the public no-auth allowlist, the caching
policy, COEP request shaping) and `security-headers.js` (the site-wide
header set + the CSP policy), `auth.js` (the session-cookie HMAC keyed
SOLELY by `SESSION_SECRET` — the no-admin-fallback security properties),
`answers.js` (the answer-recovery cache's running/lost/done projection),
`canonical.js` (the canonical-origin 301: scheme/www normalization with
path + query preserved, pass-through on the https apex),
`token-crypto.js` (the shared HMAC-token primitives: the base64url codec
round-trip, `toHex`, `safeEqual` strictness, and `sign`'s namespace
separation + fail-closed no-secret behavior),
`grant-http.js` (the grant subsystems' shared pure presentation layer:
the budget-exceeded 409, the adjust-result response ladder incl. the
per-caller not_found wording, the `resolveQuotaPatch` set/±/pause clamp,
the web-result projections, `readTokenBody`, the `posInt` config clamp),
`llm-proxy.js` (the shared LLM reverse-proxy forwarders over a mocked
fetch: the server-key swap, known-fields-only re-serialization + the
max_tokens clamp, the refund-on-failure ladder incl. no-refund-on-
success/mid-stream, the SSE pipe-through with the remaining header),
`websearch-key.js` (the grant token's mint→verify round-trip, the
`SESSION_SECRET`/namespace/expiry/tamper rejections) and `websearch.js`
(the mint subsystem + grant meter over an in-memory D1 fake + mocked Exa:
ghost reuse-per-user, `mintWebSearchGrant` + the global budget ceiling,
`grantStatus`/`revokeGrant`, the atomic reserve/refund, the admin
list/mint-link/revoke surface, the 400/403/429/503 status codes),
`websearch-backends.js` (the pluggable search backends' SERVER façade:
`resolveSearchBackend` env/config resolution + clamping, and the re-exported
core parsers/dispatch over a mocked fetch — its client-core sibling
`public/js/websearch-backends-core.js` covers the browser-facing
`(log, resolved, query, depth)` contract directly),
`proxy-grant.js` (the secure-research-space two-tier tokens: grant→proxy
mint/verify, the namespace separation that keeps the tiers/websearch/session
tokens distinct, and the secret/expiry/tamper rejections) and `proxy.js`
(the bundle mint subsystem + per-service meter over an in-memory D1 fake +
mocked Exa/Berget: bundle mint one-row-per-service, ghost reuse-per-user, the
grant→proxy exchange, the atomic web + LLM reserve/refund incl. the LLM
reverse-proxy models-forward/metered-completion/refund-on-error, non-consuming
status, and the admin mint-link/list/revoke surface) and (client)
`proxy-bundle.js` (the AES-GCM seal→open round-trip, wrong-key/tamper/garbage
fail-soft to null, and the shape validator), and `server-token.js` (the
consolidated Se/rver-token JWT: mint→verify round-trip, the standard-JWT wire
shape, canonical-header pinning incl. alg:none/alg-swap/re-serialization
rejection, the CLOSED perms vocabulary, expiry/tamper/no-secret rejections,
and the cross-family forgery matrix vs `wsk1`/`prg1`/`prx1`) and
`server-grants.js` (the consolidated mint subsystem + per-permission meter
over an in-memory D1 fake + mocked Exa/Berget: ghost reuse of the ONE JWT,
one-row-per-permission mint, the budget ceiling, atomic reserve/refund per
permission incl. the shared-forwarder LLM path, non-consuming status,
per-permission adjust with owner scoping, the admin surface, and THE
SERVER-TOKEN GUARANTEE's module-graph pin — no data-bearing import may ever
appear), and `workspace-grants.js` — the
CROSS-subsystem secure-workspace grant-token invariants end to end, over ONE
combined in-memory D1 serving both grant tables (the token-fixed/row-metered
split under live quota adjusts, concurrency-burst overrun proofs, refund
floors, expiry boundaries incl. row-expiry-beats-token / adjust-can't-resurrect
/ expired-ghost-not-reused, budget ceilings freed by pause/expiry and
independent per subsystem, account binding with byte-identical foreign/missing
404s, the wsk1/prg1/prx1 prefix-swap forgery matrix, and the full mint → seal
→ open → hydrate → spend → minter pause/top-up → revoke workspace flow),
`history-key.js` (per-user key derivation determinism + the configured
gate), `admin-boards.js` (the boards-discovery registry shape +
`?format=text`), `testpoints.js` (the try-it queue's pure logic:
`cleanTarget` same-origin validation, the action-grammar `cleanAction`/
`validateActions` incl. unknown-drop + count cap, create/patch/result
validation incl. the three-verdict 👍/👎/❓ vocabulary + thread-message
validation/projection, `deepLink` query/hash preservation, projection + the
`?format=text` render incl. THREAD lines), `search-sources.js` (the `SEARCH_SOURCES` registry
contract, `sourcePromptNotes`, `platformDiversityKey`), and the outbound
clients' pure sides — `exa.js` (the normalized search cache key),
`hf.js` (intent detection, query/attempt planning, dedup keys, item
mappers), and `shodan.js` (target extraction + the key-gated
availability check). On the client, `pending-answer.js` covers the
resume-across-relaunch marker (metadata-only, incognito-suppressed), and
`testpoints-core.js` covers the try-it queue's client pure core
(`parseTryId`/`stripTryParam`/`deepLink`, `partitionActions` known-vs-unknown
against the client grammar, `nextOpenPoint` oldest-open selection,
`targetPath` same-page normalization, `noteTexts` note-action extraction for
the queue's read-before-you-go detail view).

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
`stripOldImages`, `splitUserContent`, `userTexts` (the text of every user
turn, oldest first — moved here next to its consumer `asksDeviceLocation`),
and `conversationCopyText` (the
copy-conversation export: turn labeling, image/attachment references,
block-body suppression), the pure
core extracted out of `stream.js`'s send path), `balloon.js`'s pure core
(the Se/rver balloon greeter: envelope profile, hover/climb/pennant/flare
params, the deterministic swish-cloud crossing guarantees, the first-visit
pointer script + bounded-stay/departure contract), `balloon-intro.js`'s
pure core (the Se/rver landing intro: timeline mark ordering, the 180° camera
drop's monotone descent, the sideways roll's crest-and-settle, the
same-shape/five-sizes fleet contract, projection/gore-depth math, the
faster-than-the-umbrella-intro directive pinned against `umbrella.js`'s own
constants), `balloon-spinner.js`'s pure side (the blue waiting symbol: the
loop apex that never reaches the color, the finale plan's speed-run buckets
into the blue apex, style cycling — plus the sibling contract of reusing
`umbrella-spinner.js`'s boomerang clock), `imagedeck.js`'s pure
core (the deck registry: entry validation/order, the latest-within-radius
waypoint lookup, reset scoping), `sse.js` (the SSE
line-buffer parser: partial-line carry, keepalive/`[DONE]` filtering,
malformed-JSON tolerance), `timescale.js` (the slider's position⇄seconds
curve, `fmtBudget`, and the `budgetTier` report-tier readout — its
boundaries pinned to mirror `src/budget.js`'s `reportTierFor`),
`quiz.js`'s pure core (answer verdicts,
scoring incl. ungraded free-text handling, the completed-quiz summary
block), `drc-core.js` (DRC's derivations: determinism,
format-insensitive input, independence of every derived value —
including from the vault's derivation for the same secret —
sealed-state round-trip with the API keys AND the RAG chunk text
unreadable in the stored form, v1/v2→v3 migration, state validation),
`drc-providers.js` (the
CORS-capable registry: per-provider wire quirks, JSON-mode payloads,
lenient JSON extraction, model filters, the `bergetCatalogFilter` shared
by the Berget entry AND the proxy provider, `filterAndSortModels`'s
curate-and-order-newest-first shaping, live-vs-fallback catalog over
mock HTTP, the embed config — small model, 512 dims, Groq has none —
and `drcEmbed`'s wire shape/index-ordering over mock HTTP),
`drc-rag.js` (DRC's client-side RAG: incremental chat indexing with
srcMsgs advance-on-success-only, embedder-mismatch wipe, the
recent-window exclusion for the current chat vs siblings-in-full,
recall-block rendering/bounding, per-doc + total cap eviction order),
`drc-research.js` (the client-side pipeline: triage/notes
normalizers, prompt-structure assertions incl. the offline-honesty
rules, and the FULL flow end to end against a mock provider —
phase order, parallel harvest count, client-side split model routing,
the user's key on every wire call, discard-and-replace revision,
clarify short-circuit, triage fail-soft, and the recall block threaded
into triage/synthesis/validation but never harvest), `drc-store.js` (the
browser-local storage adapter: round-trip over an injected backend,
ciphertext-only at rest, listing, quota/corruption fail-soft),
`drc-page-core.js` (the DRC page's pure core: `grantLive`'s
token/expiry/quota liveness, `grantFlagEnabled`'s default-ON master
toggle, `normalizeSearchBackend`'s backend/URL/key/results normalization,
the `parseProjectPath`/`parsePublicationRef` deep-link parsers incl. the
reserved "workspace" slug, and
`wmHtml`'s escape-then-tighten wordmark rendering),
`ondevice-core.js` (the on-device tier's pure core: the Bonsai model
catalog, `planModelFiles` over the HF tree listing, `downloadProgress`,
the incremental `createSha256`, `createThinkFilter`, `capabilityVerdict`,
the SSE/completion wire builders, `wasmPathsFor`),
`workspace-core.js` (secure workspaces: the seal→open round-trip incl.
wrong-password/tamper fail-soft, the hacka.re wire format, the 8192-round
KDF's determinism + salt sensitivity, the dual-key independence, the
namespace derivation, fragment/link parsing, and the payload
build→seal→open→apply flow end to end),
`public/cure/umbrella.js`'s pure core — via
`public/js/umbrella-intro.test.js` — (the DRC first-visit intro's
phase timeline and vortex→umbrella geometry: ramp
ordering/monotonicity, the quarter-circle camera projection,
twist/scallop/dome math),
`vault-core.js` — via `vault.js`'s re-exports — (secret
format/entropy/uniqueness, the forgiving normalization incl. misread
mapping and prefix stripping, the Crockford codec round-trip, HKDF
id/key derivation determinism, archive encrypt/decrypt incl. tamper
detection, archive-shape validation, the chunked base64 helpers), and
`activity.js`'s
`buildResearchDebugJson` (the copy-to-clipboard debug record: step/service
projection, per-round searches, URL-deduped sources, the full generated
`answer`, the `errored` flag + `errors` list, and the ordered timeline), and
`bash-core.js` (the bash-lite agent's SHARED pure core — the one
implementation behind the server façade `src/bash-agent.js`, the DRS driver,
and DRC: the `bashIntent` EN+SV gate incl. the Swedish-parity suite,
`parseShellRequest`, exec-result clamping, the transcript/step-message
builders, the exec bridge's marker+base64 envelope codec
(`execEnvelope`/`parseExecEnvelope` incl. the RC-before-any-pipe pin,
`concatChunks`/`base64ToBytes`, the `isExportablePath` host-read policy),
and the generic injected-step `runShellLoop` driver) plus
`bash-agent.js` (the DRS driver: `fetchShellStep` and the DRS-shaped
`runShellLoop` against a mock step endpoint + mock sandbox, and the re-export
contract pinning that its pure surface IS the core, not a mirror — the
browser VM glue in `public/js/sandbox.js` is deliberately NOT Node-testable
and carries no `@ts-check`) plus `agent-backdrop-core.js` (the agent-activity
BACKDROP's pure core — the faint page-background command/output layer that
replaced the auto-popping sandbox terminal: the ring-buffered multi-channel
transcript, the `clipToNextChannel` round-robin between agents, the
`ShellRun`→lines formatting, and the transparency-preference parse/clamp; the
DOM glue `agent-backdrop.js` is browser-only, fed from `execInSandbox`) plus
`sandbox-files.js` (the file-mounting pure
core: `sanitizeName`/`sanitizeProjName`/`projHash`, `dedupeNames`,
`applySizeCap` byte budgets, `buildManifest`, `buildSeedScript`,
`shellEscape`, `buildTar` (a pure ustar writer), and `planSourceMount` — the
introspection source-mount plan: one tar archive extracted in a single spawn
(the per-file cp script kept as the no-tar fallback) rebuilding /src each
boot — see the **execution-sandbox** skill and
`docs/SANDBOX-HOST-COMMANDS.md`) plus
`introspect-core.js` (introspection mode's SHARED pure core — the one
implementation behind the server enrichment `src/introspect.js` and both
tiers' clients: the `introspectionIntent` EN+SV gate incl. the
Swedish-parity suite, the sticky `introspectionActive` conversation gate,
snapshot validation, path-mention extraction, the capped context-block
builder, `groupIntrospectionModels`/`parseIntrospectionChoice` — the
private-vs-remote model-picker grouping — and the source-RAG core
(`chunkSourceText`/`snapshotChunks`, the scale-invariant int8 vector codec
`quantizeInt8`/`int8ToB64`/`b64ToInt8`/`cosineF32Int8`, `retrieveSourceChunks`,
`validateRagIndex`)) and `introspect-ui.test.js` (the
DRS routing accessors `privateIntrospectionRoute`/`introspectionRemoteModel`
over a localStorage stub — the rest of `introspect-ui.js` is the TIN
titanium-mascot + picker DOM glue, verified live) and
`src/introspect.test.js` (the always-inject-in-dev-mode enrichment + dense
retrieval against a mocked ASSETS binding & embed, PLUS two FRESHNESS checks
that fail `npm test`: the snapshot must match the tree (`npm run bundle`) and
the rag index's every chunk ref must still resolve against the snapshot
(`npm run bundle:rag`); see the **introspection** skill) and
`introspect-tools.test.js` (the native source-investigation tools' server
façade: the re-export contract pinning that its surface IS
`public/js/introspect-core.js`, not a mirror, and the tool schemas/executors
load without pulling in the pipeline).
These run in Node unmodified since `File`, `Blob`,
`DecompressionStream`, and `TextDecoder` are all standard Node globals
— no DOM needed for this subset of client code.

```bash
npm test            # from the repo root: node --test src/*.test.js public/js/*.test.js sdk/*.test.mjs
npm run typecheck   # zero-build-step tsc: src/ (tsconfig.json, Workers types)
                    # + public/ (tsconfig.public.json, DOM lib) — strict,
                    # opt-in per file via // @ts-check; both must stay clean
```

This adds to the live-verification convention rather than replacing it:
anything touching an external provider or D1 (or, on the client side, the
DOM/`<canvas>`/pdf.js) is still verified live, since that is where this
project's actual bugs have come from historically (see the **live-verify**
skill). The root `package.json`
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

> **The header must not reach cross-origin hosts.** `extraHTTPHeaders`
> attaches it to *every* request the context makes, third parties
> included. Any spec that boots the execution sandbox must call
> `stripCrossOriginAuth(context)` (`tests/e2e/helpers.js`) first: with an
> `authorization` header on it, the CheerpX runtime's
> `import(CHEERPX_CDN)` fails with `net::ERR_FAILED`, the VM dies at
> "loading CheerpX…" after ~3.2 s, and the spec silently tests only the
> fail-soft fallback. It also keeps the break-glass password off
> third-party hosts.

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

### Sandbox specs (own configs, not in the mocked/live projects)

Three specs drive a real CheerpX VM in Chromium and are matched by their own
configs, so the default projects do not pick them up:

```bash
cd tests
npx playwright test --config=sandbox.pw.config.js                          # the iOS "sandbox not ready" regression
npx playwright test --config=sandbox-perf.pw.config.js -g "performance"    # command-cost battery (~2 min)
npx playwright test --config=sandbox-perf.pw.config.js -g "agent trace"    # one turn, every event timestamped
```

- **`sandbox-perf.spec.js`** times ~45 one-liners in a booted VM, each run
  several times so the report separates cold (first run, streaming the binary's
  blocks off the wss disk) from warm (median of the rest). It also fits a
  fork-cost ladder and a read-size slope. The runner is self-healing: a command
  that hits the 30 s exec ceiling destroys the VM (`resetSandbox`), so it
  detects rc 124, re-boots, and re-creates its fixtures rather than losing the
  rest of the run.
- **`sandbox-agent-trace.spec.js`** runs one sandbox-backed chat turn and
  timestamps every `/api/bash/step` round, the exec window between rounds, every
  SSE frame, and the boot. `execInSandbox` is a module binding, not reachable on
  `window`, so the step gap is the non-invasive measure of in-VM time.

Results and the guidance drawn from them: **`docs/SANDBOX-PERFORMANCE.md`**.
These are exploration tools, not gates — they assert only that they produced
usable data, since the numbers vary with network conditions.

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

## The bench gate (routine, for pipeline-sensitive changes)

The rubric bench doubles as a routine merge gate — the P7 discipline from
`docs/ARCHITECTURE-GAP-ANALYSIS.md`. `tests/bench-gate.mjs` wraps it:

```bash
cd tests
npm run bench:gate -- --record   # (re)record tests/bench-baseline.json vs deployed main
npm run bench:gate               # compare current deployment to the baseline
```

Both modes run a pinned battery (fixed answer model, fixed judge, fixed
question ids, 240 s budget, `SAMPLES` × each — de-noised, because one judged
sample swings ±2+) and aggregate battery means ± SD. Compare mode takes every
pin FROM the committed baseline so a gate run can't drift from what the
baseline measured, prints a noise-aware verdict (REGRESSION exits non-zero,
with the bar scaled to the pooled standard error), and emits a ready-to-paste
ledger line for `tests/EVAL-BENCH-FINDINGS.md`.

The routine: a change touching pipeline-sensitive files (`src/pipeline.js`,
`prompts.js`, `budget.js`, `model-profiles.js`, and friends — the pre-push
hook prints the exact list when it fires) deploys, runs the gate, and appends
the ledger line; on IMPROVED, re-record the baseline in the same PR. The gate
needs the break-glass creds and a live deployment, so the hook only reminds —
it never blocks. Don't push mid-battery (the model-eval rule): an auto-deploy
truncates in-flight streams and poisons the run.
