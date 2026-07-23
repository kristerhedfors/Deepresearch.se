# Code layout — the per-module map

The AUTHORITATIVE per-module description of the codebase, moved out of
CLAUDE.md (2026-07-17) to keep the always-loaded guide lean. The mirror
discipline is unchanged: **one row per non-test `src/` module**, the client
prose covering every `public/js` module, updated in the SAME commit that
adds or moves a module (the update-docs skill's drift greps target this
file). Architecture rationale lives in `docs/ARCHITECTURE.md`; the
load-bearing invariants stay in `CLAUDE.md`.

Server (`src/`):

| File | Responsibility |
|---|---|
| `index.js` | Entrypoint: request id, identity gate, terms + approval gates, routing (`/api/*`, `/admin`, `/auth/google*`, `/login`, `/logout`, `/terms/accept`), sliding-cookie reissue, request logs (static-asset serving + the public allowlist live in `assets.js`; the response security headers + CSP in `security-headers.js`; the canonical-origin 301 in `canonical.js`) |
| `assets.js` | Static-asset serving (`serveAsset` — the caching policy + the cross-origin-isolation COEP shell) and `isPublicAsset` (the unauthenticated allowlist, dominated by the DRC `/cure` public module graph) — split out of the router so the entrypoint stays about routing |
| `security-headers.js` | The site-wide response security headers + the (currently opt-in) Content-Security-Policy, and `applySecurityHeaders` — the one function `index.js`'s `fetch` wraps every response with |
| `canonical.js` | The canonical-origin redirect (`canonicalRedirect` — 301 any www/http arrival to the https apex, preserving path + query): a pure leaf `index.js`'s `route` calls before anything else; carries the Firefox Focus / OAuth `redirect_uri_mismatch` institutional story |
| `auth.js` | Identity: session cookie (365 d, sliding) + admin-secrets break-glass Basic Auth (fail closed); OAuth state HMAC helpers |
| `token-crypto.js` | The shared HMAC-token crypto PRIMITIVES leaf (`b64url`/`b64urlDecode`/`toHex`/`safeEqual` + the namespaced `sign`): one implementation behind `auth.js` (toHex/safeEqual) and the `websearch-key.js`/`proxy-grant.js` token families, which each keep their OWN mint/verify (deliberately different claims) and stay mutually unforgeable via the namespace passed into `sign` |
| `google.js` | Google OIDC sign-in: state cookie, code exchange, claims validation, auto-provisioning (`ADMIN_EMAIL` → admin) |
| `login.js` | Sign-in, pending-approval, and one-time terms pages (PWAs can't answer a 401 challenge) |
| `accounts.js` | User accounts CRUD (D1; provisioned by Google sign-in, no passwords) |
| `db.js` | Optional D1 binding + lazy schema (no-op without the binding). Cost tracking rests on TWO ledgers: `usage_events` (ENFORCEMENT — one row per request, `berget_cost` = the SUM across every model that ran, all a cost cap needs) and `usage_model_events` (ATTRIBUTION — one row per model bucket that spent: answer/JSON/vision, so a user's spend stays attributable to the model that drove it; never read for enforcement) |
| `config.js` | Global site config (D1 `config` table, admin-edited, cached ~30 s) |
| `quota.js` | Window usage accounting, quota enforcement, cost calc, usage recording, the per-user in-flight concurrency reservation (`reserveInflight`/`releaseInflight`, `INFLIGHT_CAP`), and the two sibling 429-payload builders `quotaBlockedResponse` (quota-window block; also imported by quiz-api/bash-api/rag) and `inflightLimitResponse` (concurrency limit). Cost attribution lives here too: `recordModelUsage` writes the per-model rows into the `usage_model_events` attribution ledger (fail-soft, separate from the enforcement `recordUsage` so it can't disturb it), and `getUsageByModel` (site-wide) / `getUsageByModelForUser` (one user) read the per-model breakdown that answers "what did this budget go to" |
| `alerts.js` | Operational alerts (D1 `alerts` table): classifies caught pipeline/backend failures (Berget errors, wallet depletion) into a small stable set of alert types surfaced in the admin panel and as a notification badge — rows are upserted by `type` (a recurrence bumps `count`/`last_seen_at` and re-surfaces itself) rather than one row per occurrence; fails soft (a no-op without D1) — see the **access-control** skill |
| `user-api.js` | `/api/me` (usage vs quota) + `/api/models` (dropdown catalog) + `/api/client-error` (beacon) + `/api/client-log` (client telemetry beacon → Workers Logs; first user is the sandbox filesystem integration — see the **execution-sandbox** skill) |
| `user-messages.js` | Per-user message center (D1 `user_messages`): account-level notices (quota exhausted/restored, sign-in approved, quota changed by an admin) — structured enums + timestamps ONLY, deliberately no content column, so the feature stays inside the same zero-retention promise the privacy notice makes for conversations; "restored" isn't a separate write, it's derived at read time from the caller's CURRENT quota state (`quota.js`). Rendered by the client's `account-messages.js` |
| `settings.js` | Per-user settings (`users.settings_json`, additive column): the `shodan_mcp`, `google_maps`, `bash_lite_mcp` (experimental execution sandbox), and `developer_mode` (introspection mode) knobs — `GET/PUT /api/settings`. Cloud storage is deliberately NOT a knob (invariant 4): `cloudStorageEnabled` is pure availability (R2 binding + user row). Feedback is NOT a knob either (as of 2026-07-18): it's given from the chat — a message opening with "feedback" routes to the feedback pipeline |
| `introspect.js` | INTROSPECTION MODE's server enrichment (the `developer_mode` knob): whenever developer mode is on it appends the site's OWN source so answers (incl. code-example requests) come from the real code, never a denial. It RETRIEVES the source chunks most relevant to the question from a committed DENSE index (`public/introspect/source-rag.json` — int8 embeddings per source chunk, `scripts/bundle-source-rag.mjs` / `npm run bundle:rag`, a per-file-hash DELTA build that only re-embeds changed files), embedding the query with Berget e5 (same model the index was built with) — so it works for ANY phrasing with NO intent regex and NO Linux VM. Plus a CLAUDE.md orientation excerpt, the full file index for strong "how are you built" asks, named files inlined by path, the **HELP layer** (introspection is ALSO the interactive help, 2026-07-16: the documentation passages relevant to the question, retrieved from the committed docs corpus/index — `scripts/bundle-docs.mjs` → `docs-corpus.json` with resolved symbol references + images rewritten to served `docs-img/` URLs, `scripts/bundle-docs-rag.mjs` → `docs-rag.json` — quoted VERBATIM so usage questions get the documentation's own structure, images and captions, while follow-ups escalate into the source; see the **help-docs** skill), and the **skills catalog** — the repo's `.claude/skills/*/SKILL.md` playbooks surfaced as a first-class listing (`skillsCatalog`/`skillsIndex`/`mentionedSkills`) so ANY answer model in EITHER tier can quote or inline a playbook by name, the same institutional knowledge Claude Code works from (the vendor-neutral root `AGENTS.md` points external agents at the same catalog). Both artifacts (the source snapshot + the rag index) are COMMITTED, served by this deploy, read back through the ASSETS binding — by construction the exact source this deploy runs. `hasSource` flips the answer prompts' capabilities line (prompts.js/pipeline.js) so the model uses the source instead of saying it isn't a coding tool. Shared pure core (chunker/int8 codec/retrieval/block builder) is `public/js/introspect-core.js`; with the sandbox knob also on the tree mounts at `/src` — see the **introspection** skill |
| `introspect-tools.js` | The native source-investigation tools' server FAÇADE: a pure re-export of the ONE shared core `public/js/introspect-core.js` — the tool schemas (`INTROSPECTION_TOOLS`) and the pure snapshot executors `grepSource`/`readFileTool`/`listFilesTool` + `runIntrospectionTool` (the `grep_source`/`read_file`/`list_files` loop DRS drives server-side via `src/anthropic.js`'s tool run and `pipeline.js`'s `runSourceResearchTools`, DRC drives browser-side). The owner-authorized invariant-1 exception (developer mode + tool-capable answer models); the core lives under `public/` for the same reason `bash-agent.js` re-exports `bash-core.js` — see the **introspection** skill |
| `sdk-tools.js` | DistillSDK's server FAÇADE: a pure re-export of the ONE shared core `public/js/sdk-core.js` — the manifest operations (validate/close/order/render, shared with the `sdk/pair-cli.mjs` CLI), the SDK-mode native tool schemas + executors (`SDK_TOOLS` sdk_list_modules/sdk_show_module/sdk_plan/sdk_validate over the snapshot's `sdk/MANIFEST.json`; `BUILD_TOOLS` write_file/publish_app), the generated-app staging rules (`sanitizeBuildPath`/`stageBuildFile` caps), the deterministic `FILE:` fenced-block convention (`parseFileBlocks` — the no-function-calling path), and the SDK context block. Consumed by `pipeline.js` `runSdkBuild` and `mcp.js`'s sdk_* tools — see the **sdk-mode** skill |
| `agent-link.js` | Agent SHARE-LINK minting: the thin adapter that mints a **standard Se/rver token** (`server-token.js`) for an AgentSpec — loads the agent from the source snapshot, maps it with `agentTokenGrantParams`, and calls `mintServerTokenGrant` (`server-grants.js`). NO new crypto, NO new meter; the SERVER-TOKEN GUARANTEE holds unchanged (upstream APIs only, never Se/rver data, never a login). Admin-gated at `POST /api/admin/agent-link` like the other shareable mint — `handleAgentLink`; see `docs/AGENT-PLATFORM.md` §7 |
| `agent-spec.js` | The Agent Platform's server FAÇADE: a pure re-export of the ONE shared core `public/js/agent-spec-core.js` — the AgentSpec schema helpers (`validateAgentSpec`/`validateAgentRegistry`, `resolveControls`/`resolveTheme`/`resolveQuota`/`resolveExamples`, `composerMarkup`/`proveComposer`, `agentLinkPlan`, `agentsFromSnapshot`, and the text renderers). Loads the four shipped agents from `sdk/AGENTS.json` (via the source snapshot, like the manifest); the CLI (`sdk/pair-cli.mjs agents`/`agent`) re-exports the same core. Full docs: `docs/AGENT-PLATFORM.md`, the **agent-platform** SDK module skill |
| `bash-agent.js` | The bash-lite agent's server FAÇADE: a pure re-export of the ONE shared core `public/js/bash-core.js` — `bashIntent` (deterministic EN+SV "wants a shell" heuristic), `parseShellRequest` (the fenced ```bash convention — NO function calling), exec-result normalization/clamping, `buildShellTranscript` (the labeled synthesis block), `buildStepUserMessage` (the per-round step question both tiers send), and (client-only, not re-exported here) the exec BRIDGE's pure protocol codec — `execEnvelope`/`parseExecEnvelope` (the marker+base64 envelope incl. the RC-before-any-pipe fix), `concatChunks`/`base64ToBytes`, and `isExportablePath` (the which-guest-paths-may-leave-the-VM policy, next to `OUTBOX_PATH`) — that `sandbox.js`'s `execInSandbox`/`exportFile` drive. The core ALSO holds the OUTBOX download flow's pure side (2026-07-15, client-only — not re-exported here): ask for a file → the agent copies it into `/workspace/outbox` (`bashAgentPrompt` convention) → after the loop `sandbox.js` `collectDeliverables` lists (`outboxListCommand`/`parseOutboxListing`, capped) and exports each via the base64-through-exec round-trip → `turns.js` `renderDeliverables` attaches download chips with an add-to-project dropdown (`projects.js addFilesToProject`), and a synthetic `deliverablesRun` transcript entry tells synthesis the hand-over happened (rides the existing `shell_transcript` contract — no new API field). The core lives under `public/` because the browser can only import served modules while the Worker bundler can import from anywhere; this replaced the old hand-mirrored server/client copies (2026-07-11) — see the **execution-sandbox** skill |
| `ai-models.js` | The AI/LLM model-name recognizer's server FAÇADE: a pure re-export of the ONE shared core `public/js/ai-models.js` — `aiModelIntent`/`aiModelMentions` (does a message name a model FAMILY, alone or with a version like `glm-5.2`, `kimi k2`, `deepseek v3`? — language-neutral, so EN+SV parity is inherent) plus the two prompt notes `AI_MODEL_NOT_A_PACKAGE_NOTE` (spliced into `bashAgentPrompt`/`drcBashAgentPrompt` so the offline sandbox stops treating a model name as a local package — the IMG_5207 `apt-cache search glm-5.2` misfire) and `AI_MODEL_RESEARCH_NOTE` (spliced into `triagePrompt`/`drcTriagePrompt` so a model question is decomposed into a proper research plan). The core lives under `public/` for the same reason `bash-agent.js` re-exports `bash-core.js`; both tiers also SKIP the offline sandbox for a pure model question (`stream.js`/`drc-research.js`). Node-tested (`public/js/ai-models.test.js`) |
| `bash-api.js` | `POST /api/bash/step`: ONE turn of the client-orchestrated bash-lite loop — asks the reliable model (via `bashAgentPrompt`) what to run next given the transcript so far; quota-gated, usage-recorded, knob-gated (`bashLiteEnabled`), fail-soft (any failure returns `done` so the client stops). The sandbox runs in the BROWSER (`public/js/sandbox.js`); the server only decides commands |
| `sandbox-image.js` | Self-hosted Linux sandbox images (the admin-selectable small-image feature — `docs/SANDBOX-LOCAL-IMAGE.md`): `GET /sandbox/img/<id>.ext2` (streams a content-addressed, immutable ext2 image from R2 with HTTP Range support for CheerpX's HttpBytesDevice) + `GET /api/sandbox-image` (the effective image config both tiers read) — both PUBLIC, routed before the identity gate because Se/cure must reach them too; fail-soft by construction (no binding / unknown id / R2 miss → the client falls back to the built-in streamed default, invariant 2) |
| `storage.js` | Implicit R2 cloud storage (availability-gated, always on for signed-in accounts — invariant 4): encrypted conversation AND project records (`/api/convos*`, `/api/projects*` — same handler), original attached files (`/api/files*`), the account's one-call data wipe (`DELETE /api/storage` — vault objects excluded) |
| `vault.js` | The secret-keyed project vault (`/api/vault/:id`, R2 `vault/{uid}/{id}`): one CLIENT-encrypted project archive per id — key AND id both derived in the browser from a user-held secret the server never sees (`public/js/vault.js`), the strictest storage tier — the server can neither locate nor read an archive; each store is its own explicit consent act, and vault objects are excluded from the `DELETE /api/storage` wipe |
| — (DRC has no server module) | DRC — "deep research secure", C for CLIENT-side: the public tier at `DeepResearch.Se/cure` (saved projects at `/my/project-<hash>`; `/free*` legacy aliases — all routed BEFORE the identity gate in `index.js`; the root `/` serves the promotional landing to visitors — which links /cure — and 302s signed-in arrivals to /rver). MINIMAL SERVER BY DESIGN: the Worker serves the static page (`public/cure/`) and the public replay JSONs (`pub.js`) and is in no other DRC path — model calls go directly (cross-origin) from the browser to the user's own CORS-capable providers (OpenAI, Groq, Berget — `public/js/drc-providers.js`), the deep-research flow runs client-side (`drc-research.js`), and the sealed project state rests in BROWSER-LOCAL storage (`drc-store.js`). Its remote sibling DRS — "deep research server", R for REMOTE — is the signed-in app at `/rver` (sign-in/terms redirects land there; PWA manifest starts there): everything else in this table |
| `pub.js` | Published research replays — the `DeepResearch.Se/cure/<slug>` ("deep research SECURE <slug>") surface, R2 `pub/{slug}`: frozen deep-research sessions as read-only public pages (`GET /api/pub[/:slug]` public, routed pre-auth; `PUT/DELETE /api/pub/:slug` admin-only), each opened IN PLACE by the DRC app (`/cure/<slug>` seeds a DRC conversation, so continuing on the visitor's own keys is just typing; `/?continue=<slug>` legacy) — see the **publish-research** skill |
| `build-pub.js` | SDK-mode BUILD publications — the live `/app/<slug>/` "try it" surface (R2 `build/{slug}`): `publishBuild` (called from `pipeline.js` `runSdkBuild` — validates/caps the generated files, enforces slug ownership so only the minting user republishes their URL, prunes dropped files) and the PUBLIC serving face `handleBuildGet`, whose every response carries `Content-Security-Policy: sandbox allow-scripts …` — the published page runs in an OPAQUE ORIGIN (no cookies, no credentialed same-origin fetch), so a generated app can never act as the signed-in visitor despite being served from the site's hostname. Admin-only `DELETE /api/build/:slug` unpublishes — see the **sdk-mode** skill. `PUT /api/build/:slug` (`handleBuildManualPublish`, admin-only) is the ONE other write surface: a bypass of the chat/tool loop that calls the same `publishBuild` for a bundle already built elsewhere (the execution sandbox's outbox, a hand-assembled directory) — `scripts/publish-app`, see the **publish-app** skill |
| `grant-http.js` | The grant subsystems' shared pure PRESENTATION leaf (imports only `http.js`'s `jsonResponse`): the response fragments `websearch.js` and `proxy.js` must keep in lockstep — `budgetExceeded409`, the `adjustResultResponse` ladder, the `resolveQuotaPatch` set/±/pause clamp arithmetic, the granted-web-search result projections (`emptyWebResultResponse`/`webResultResponse`), `readTokenBody`, the `posInt` positive-int config clamp the defaults resolvers share, and the shared `QUERY_MAX`/`GRANTS_LIST_MAX`/`GRANT_DEPTH` constants. Each subsystem keeps its OWN mint/meter/adjust logic (deliberately different tables and claims); only the pure response/clamp layer lives here. Node-tested |
| `llm-proxy.js` | The shared LLM reverse-proxy FORWARDERS — a pure upstream leaf (imports only `http.js`'s `jsonResponse`) behind BOTH server-touching grant surfaces' `/llm/*` endpoints: `forwardLlmModels` (the thin Berget /models forward) and `forwardLlmCompletion` (one OpenAI-wire completion on the SERVER key — known-fields-only re-serialization, output clamp, the refund-on-failure discipline, SSE pipe-through). The caller owns token verification and the quota reserve. Kept a leaf so `server-grants.js`'s pinned module graph imports it without dragging in the proxy-bundle machinery. Node-tested |
| `websearch-key.js` | The temporary web-search GRANT TOKEN half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of `wsk1.<payload>.<hmac>` tokens (claims: `jti`, `uid`, `quota`, `iat`, `exp`) HMAC-signed with `SESSION_SECRET` under an independent `websearch.` namespace, so a grant token can never be confused with a session/state HMAC — the signed capability that lets an otherwise server-less Se/cure session run bounded web searches (invariant 4's ONE bounded exception). Node-tested |
| `websearch.js` | The web-search grant MINT subsystem + METER (D1 `websearch_grants`, keyed by the token's `jti`; defaults in `config.js`'s `websearch` block): `mintWebSearchGrant` (the shared minter — inserts a row + token, enforces the global `budget` ceiling), `grantWebSearch` (the GHOST path — reuse-the-active-`source='ghost'`-grant-per-user, so per-user Exa exposure is bounded to one quota per TTL window), `grantStatus` (non-consuming read), `adjustGrantQuota` (the secure-workspaces MINTER CONTROL, 2026-07-15: set/±/pause a live grant's quota on the D1 row — the token in circulation never changes; increases budget-checked like a mint, owner-scoped via `user_id`), `revokeGrant` (delete = instant kill). Endpoints: `handleWebSearchGrant` (AUTHED `POST /api/websearch/grant` — ghost crossover), `handleWebSearchAdjust` (AUTHED `POST /api/websearch/adjust` — the minter's self-service quota control over their own grants), `handleWebSearchStatus` (PUBLIC `POST /api/websearch/status` — a `…/cure?ws=<token>` link follower reads remaining), `handleWebSearch` (PUBLIC `POST /api/websearch` — verifies the token, atomically reserves one unit, runs Exa on the server key, refunds an empty/failed search), and `handleAdminWebSearch` (`/api/admin/websearch*` — GET list+defaults, POST mint→shareable link, PATCH /:jti quota adjust, DELETE revoke). Fail-SAFE: no D1 → 503, no unmetered server-paid search possible. Client: `public/cure/drc.js` (grant from the ghost intent marker OR a `?ws=` link + the settings toggle), `public/js/drc-research.js` (the injected `webSearch` fn → citation-aware harvest/synth), and the `/admin` → **Web search grants** panel (`public/js/admin.js`) |
| `proxy-grant.js` | The SECURE-RESEARCH-SPACE two-tier TOKEN half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of the GRANT token `prg1.<payload>.<hmac>` (the bundle's "token-granting token", namespace `proxygrant.`) and the PROXY token `prx1.…` (the post-exchange working credential, namespace `proxytoken.`) — both HMAC-signed with `SESSION_SECRET`, each under its own namespace so the two tiers (and the `wsk1`/session tokens) can never be confused; claims carry `svc` (`web`/`api`). Node-tested |
| `proxy.js` | The SECURE-RESEARCH-SPACE bundle MINT subsystem + per-service METER (D1 `proxy_grants`, one row per service keyed by `jti`, grouped by `bundle_id`; defaults in `config.js`'s `proxy` block — invariant 4's SECOND bounded exception): `mintBundle` (a row + grant token per service, sealed into one encrypted bundle via `public/js/proxy-bundle.js`, global `budget` enforced), `grantBundle` (the GHOST path, reuse-per-user), `exchangeGrant` (grant token → proxy token), `proxyStatus` (non-consuming). Endpoints: AUTHED `POST /api/proxy/grant` (ghost); PUBLIC `POST /api/proxy/exchange`, `POST /api/proxy/status`, `POST /api/proxy/web` (Exa on the server key, reserve/refund), and `/api/proxy/llm/*` (an OpenAI-wire REVERSE PROXY to the server's Berget key — `/models` + a metered `/chat/completions`, so the DRC provider registry drives it unchanged; the `api` grant is the one place a Se/cure conversation reaches the server); ADMIN `/api/admin/proxy*` (GET list+defaults, POST mint→`…/cure?rp=<blob>#rk=<key>` link, PATCH /:jti per-service quota adjust, DELETE revoke a bundle); plus `adjustProxyGrantQuota` + AUTHED `POST /api/proxy/adjust` (the secure-workspaces minter control — same set/±/pause semantics as `websearch.js`'s, per service row). Fail-SAFE (no D1 → 503) and Berget-ONLY. Client: `public/cure/drc.js` (open bundle from URL, exchange, connected-APIs banner + Settings toggle), `public/js/drc-providers.js` `proxyLlmProvider`, and the `/admin` → **Secure research space grants** panel |
| `server-token.js` | The CONSOLIDATED **Se/rver TOKEN**'s JWT half (near-leaf: imports only the `token-crypto.js` primitives) — "one ticket, one JWT" (2026-07-16 directive): mint/verify of a STANDARD HS256 JWT whose claims bundle the grant families' properties — a `perms` permission SET over the site's UPSTREAM APIs only (`web`/`api`, the CLOSED `SERVER_TOKEN_SERVICES` vocabulary), one `exp` duration for the whole grant, `jti` keying the D1 meter rows, `sub` accountability. Carries THE SERVER-TOKEN GUARANTEE (load-bearing): a Se/rver token grants upstream API access ONLY — NEVER any of Se/rver's own data (no project contents, no chat contents, no history, no accounts) — the name itself the reminder that using one sends data to a server somewhere. Family separation from `wsk1`/`prg1`/`prx1`/session HMACs under the one `SESSION_SECRET` is structural (canonical-header pinning kills alg:none/alg-swap; signing-input formats and signature encodings can't collide) and test-pinned. Node-tested; see `docs/SERVER-TOKENS.md` |
| `server-grants.js` | The Se/rver-token MINT subsystem + per-PERMISSION METER (D1 `server_tokens`, one row per (jti, service) so each permission's quota is administered independently while the ONE JWT in circulation never changes; defaults in `config.js`'s `server_token` block): `mintServerTokenGrant` (one row per permission + one JWT, global `budget` enforced), `grantServerToken` (the GHOST path, reuse-per-user), `serverTokenStatus` (non-consuming), `adjustServerTokenQuota` (the minter control, per permission), `revokeServerToken` (delete all rows = instant kill). Endpoints: AUTHED `POST /api/server-token/grant` + `/adjust`; PUBLIC `POST /api/server-token/status`, `POST /api/server-token/web` (query-only Exa, atomic reserve/refund), `/api/server-token/llm/*` (OpenAI-wire Berget reverse proxy, the JWT as bearer — reuses the shared `llm-proxy.js` forwarders); ADMIN `/api/admin/server-token*` (GET list grouped by jti, POST mint→`…/cure?st=<jwt>` link, PATCH /:jti/:svc adjust, DELETE /:jti revoke). Fail-SAFE (no D1 → 503); the legacy families stay unchanged. Its module graph must NEVER include a data-bearing module (storage/vault/chatlog/accounts/rag/pub…) — pinned by a unit test (THE GUARANTEE, enforced structurally). Client: `public/cure/drc.js` (the `?st=` link reader + the GHOST crossover, which asks for the consolidated token FIRST with legacy fallback; web-search spend first in priority; the `serverTokenLlmProvider` model-dropdown entry; the connected banner + Settings row) over the pure `serverTokenService`/`serverTokenLive` (`drc-page-core.js`) and `serverTokenLlmProvider` (`drc-providers.js`); admin panel: `/admin` → **Se/rver tokens** (`public/js/admin.js`, panels-board id `server_tokens`) |
| `pool-token.js` | The COMPUTE-SHARING pool-token half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of `pt1.<payload>.<hmac>` tokens (claims: `jti`, `pool`, `sub`, `iat`, `exp`) HMAC-signed with `SESSION_SECRET` under an independent `pool.` namespace, so a pool token can never be confused with another family. Carries THE POOL-TOKEN GUARANTEE: it authorizes ONLY submitting completion jobs to the ONE pool it names, is never a login, and unlocks no Se/rver data — its one disclosed difference from a Se/rver token is that the prompt is read by the pool owner's machine. Node-tested; see `docs/COMPUTE-SHARING.md` |
| `pool.js` | The COMPUTE-SHARING BROKER + per-token METER (D1 `pool_providers`/`pool_jobs`/`pool_consumers`/`pool_tokens`; defaults in `config.js`'s `pool` block): a signed-in sharer lends their local OpenAI-compatible model, the server parks a consumer's completion in a D1 job queue, the sharer's browser pulls/runs/returns it (HTTP long-poll, NO Durable Objects/WebSockets — no new infra). One pool per sharer account. `registerProvider`/`heartbeatProvider`/`claimJob`/`requeueStaleJobs` (the queue), `reservePoolUnit`/`refundPoolUnit` (0 = uncapped "any number of requests"), `bumpConsumer`/`setConsumerState` (the dashboard aggregate + block list = "remove user"), `listPool` (oversight), `mintPoolTokenGrant`/`adjustPoolTokenQuota`/`revokePoolToken`. Endpoints: AUTHED provider `POST /api/pool/register`+`/poll`+`/result`+`/unregister` and sharer `GET /api/pool`+`POST /api/pool/{token,adjust,block,revoke}`; PUBLIC consumer `POST /api/pool/status`, `/api/pool/llm/*` (OpenAI-wire — a job parked + waited on, `stream:false` in v1); ADMIN `/api/admin/pool*`. Fail-SAFE (no D1 → 503). Its module graph must NEVER include a data-bearing module — pinned by a unit test (THE POOL-TOKEN GUARANTEE). See `docs/COMPUTE-SHARING.md` |
| `rag.js` | Document RAG: `POST /api/embed` (Berget embedding proxy, used in BOTH storage modes) + `/api/rag/*` (Vectorize index/query, R2 export copies) |
| `answers.js` | `/api/chat/answer`: TTL'd (15 min) answer recovery cache for dropped connections — ack-purged on intact delivery |
| `chatlog.js` | Full-visibility chat interaction log (D1 `chat_logs`): complete Q&A + research metadata per exchange (chat AND mcp channels), skipped for incognito; `/api/admin/chatlogs*` read API built for the agentic debugging workflow — see the **chat-logs** skill + `scripts/chatlogs`. Also the home of the shared pure log helpers `truncateForLog`/`likePattern`/`cleanStr` (the last two imported by the `testpoints.js`/`feedback.js` board validators) |
| `feedback.js` | The feedback pipeline (D1 `feedback` + `feedback_messages` + `feedback_images`): user feedback as dialogue threads with the development agent. `feedbackIntent` (EN+SV, anchored at message start) is the chat-side gate — a message opening with "feedback" is routed by `src/pipeline.js` (`runFeedbackCapture`) and recorded via `createFeedbackEntry` (called from `chat.js`), which ALSO tags the `chat_logs` row (`meta.feedback`) so discovery is double (structured queue + chatlogs scan). Surfaces: user CRUD (`/api/feedback*`) + the agent/operator queue (`/api/admin/feedback*`, chatlogs-style, `?format=text`) — incl. optional SCREENSHOT attachments on entries and replies (client-downscaled data URLs, one D1 row each, metadata-only in projections, served back as real images via `…/:id/images/:imgId`; `scripts/feedback --image` downloads one) — see the **feedback-loop** skill + `scripts/feedback` |
| `board.js` | The decision-board CORE — the one shared mechanism behind every admin panel whose choices feed an agent loop (see the **decision-boards** skill): choice-state validation (votes/score/note/priority), the priority-vs-rank orderings (admin priority = the loop's fixed work order), `reviewState`, the `*_reviews` D1 upsert helpers, and `projectedBoardItem` (the single-item re-projection every board's vote/patch endpoint answers with) — a new board implements none of this itself. THREE consumers today: the two backlog priority boards `security-risks.js` and `features.js`, plus `panels.js` — the ATTENTION board, a votes-only variant (same core, `"priority"` ordering with no priorities ever set → pure votes-desc) |
| `security-risks.js` | The security-risk review board (D1 `security_reviews`) — the reference `board.js` consumer (façade-style: its pure surface re-exports the core): a code CATALOG mirroring `SECURITY-RISKS.md` §3 (same P-ids, same order — any register edit updates it in the same commit) + the admin's votes/manual score/note and the explicit per-item PRIORITY that is the security-fix loop's fixed work order (`/api/admin/security*`, `?format=text` = the loop's input; `scripts/security`) — see the **security-posture** skill |
| `features.js` | The features/priority review board (D1 `features_reviews`) — the SECOND loop channel next to security (façade over `board.js`): a code CATALOG mirroring `FEATURES.md` §3 (same F-ids, same order, same mirror-in-one-commit discipline) + the admin's votes/EFFORT (the shared "score" field, relabelled)/note and the explicit PRIORITY that is the feature-build loop's fixed work order (`/api/admin/features*`, `?format=text` = the build loop's input; `scripts/features`; impact rank instead of severity, build order instead of fix order) — see the **feature-board** skill and `docs/DECISION-BOARD-LOOPS.md` |
| `panels.js` | The panel-SELECTION board (D1 `panels_reviews`) — a THIRD `board.js` consumer but a different KIND of loop (the ATTENTION loop, not a backlog). Its catalog items ARE the admin panels themselves; it has NO board widget — each panel header on `/admin` carries ▲/▼ thumbs and voting reshapes the admin view in place (up floats to top, net-negative collapses + sinks). Reshapes PURELY on votes: no drag, no explicit priority (reuses the core's `"priority"` ordering with none ever set → votes-desc). The votes-driven focus order (`/api/admin/panels*`, `?format=text` = the attention loop's input; `scripts/panels`) tells a Claude Code session which admin surface the owner is working on now — read it, then read that surface's own board. See the **feature-board** skill §6 |
| `testpoints.js` | The testable-interaction-points queue (D1 `test_points`): declared, linkable "try-it" points — each a `label` + a "what was fixed" `summary` + a same-origin `target` path + an ordered list of client ACTIONS (the deep-link reachability grammar: open a panel/settings-knob, prefill the composer, flip search, set the budget, pick a model, highlight an element) — plus the 👍/👎/❓ verdict (pass / fail / untestable–needs-clarification; the ❓ opens a tester↔loop DIALOGUE THREAD on the point — D1 `test_point_messages`, verdict notes land as tester messages, the loop answers via `…/:id/messages` / `scripts/testpoints --reply` and re-opens the point). Pure core (validation/projection/`?format=text`/`deepLink`) + `handleAdminTestpoints` (CRUD + result + thread, admin-gated, `/api/admin/testpoints*`) + `handleTryRedirect` (the `/try/:id` deep link → 302 to `<target>?try=<id>`, home-on-miss). The banner + queue UI live in `public/js/testpoints.js` over the pure `public/js/testpoints-core.js`; `scripts/testpoints` is the producer/reader CLI. Each point is also a numbered **use case**: `useCaseTag` gives it a stable `#UC-<id>` tag (on the projection as `.tag`, prepended to `compose` starter prompts client-side); `parseUseCaseRef` (EN+SV) reads it back off a `feedback #UC-<id> …` chat message and `recordUseCaseFeedback` posts the note onto that point's thread (admin-gated, from `chat.js`) — see the **testable-interaction-points** skill |
| `admin-api.js` | `/api/admin/*`: overview, users, config, chatlogs, feedback, security, features, panels, testpoints, boards, and `user-cost` (one user's spend attribution — per-window LLM-vs-search totals + the per-model breakdown; `scripts/user-cost` is its CLI) |
| `admin-boards.js` | The admin-BOARDS discovery index (`GET /api/admin/boards`, `scripts/boards`): one pure static registry (`ADMIN_BOARDS`) of every Claude-fetchable admin list (security, features, panels, feedback, chatlogs) — id/purpose/api/`text_query`/orderings/`order_help`/script/skill — with a `?format=text` render that prints each board's exact fetch line. The one-call "pop up every board and act on the admin's priority order" entry point; no D1, no secrets (see the **decision-boards** skill) |
| `chat.js` | `/api/chat` handler: validation, model resolution, quota gate, per-user in-flight concurrency reservation (`reserveInflight`/`releaseInflight`, P-3), state, SSE scaffold, usage recording (the split-billing totals — `summarizeSpend`/`exaCost` now live in the shared `billing.js`, re-exported here) |
| `mcp.js` | `POST /mcp`: exposes the deep-research pipeline AS an MCP server — the single `deep_research` tool any MCP client (Claude, Cursor) can call. Hand-rolled Streamable HTTP / JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, plus the `notifications/initialized` ack) — no dependency; routed AFTER the identity gate so MCP inherits the site's access control. Pure protocol helpers are exported at the top for `mcp.test.js`; the heavy pipeline import is DYNAMIC inside `tools/call`, and it shares `resolveJsonModel` (`model-routing.js`) and the split-billing spend math (`billing.js`) with `chat.js` |
| `pipeline.js` | The research pipeline's phase FLOW (triage → search → gap → synth → validate); iterates the source registries, never names a source |
| `pipeline-inputs.js` | The pipeline's PURE input-block builders + output parsers (`shellReplyMessages`, `notesSection`, `subquestionsSection`, `conflictsSection`, `collectConflicts`, `extractClaims`, `takeSearchBatch`) — the byte-identical-input string/data shaping split out of `pipeline.js` so the flow reads as the flow; Node-tested |
| `notes.js` | Structured research notes — the pure representation/merge logic behind the budget-gated notes-digest phase (`pipeline.js`'s `maybeDigest`, `prompts.js`'s `notesPrompt`): each note distils one factual claim tied to numbered source ids; normalizes and MERGES notes across search waves (dedupe by claim, union ids/entities) so gap-check and synthesis reason over a compact claim set instead of re-reading every highlight. Pure and never throws — a bad note is dropped, matching the pipeline's fail-soft posture |
| `triage.js` | The pipeline's JSON-hardening layer: the declared schemas for every JSON planning phase + `hardenJson`, and `normalizeTriage` (the triage-failure fallback) — pure, no I/O |
| `schema.js` | A tiny, pure, dependency-free schema validator hardening the model-JSON → pipeline boundary: `validate(shape, value)` never throws — it coerces/normalizes where it safely can and returns `{ ok, value, errors }` (combinators: string/boolean/number/stringEnum/arrayOf/object/oneOf). Sits BEHIND the existing fail-soft fallbacks (`normalizeTriage` etc. stay the last-ditch net); the integration pattern is `ok ? value : original`, so a schema miss degrades exactly as before |
| `answer-stream.js` | The answer-streaming internals behind synthesis/direct/search-off replies: `streamCompletion` (reliable-model failover), the per-model attempt loop (connect retries, idle guard, finish_reason detection), `emitChunked` |
| `search-sources.js` | The auxiliary search-source REGISTRY (HF Hub + future sources): one declarative entry per source (intent/search/service/dedup/promptNote/diversity) — the parallel-work seam (see the **add-research-source** skill) |
| `sources.js` | The cross-search source registry: URL dedup, arrival-order numbering, per-origin diversity cap (per-domain; per-OWNER for huggingface.co) + overflow backfill, the numbered digest |
| `enrichment.js` | Opt-in pre-pipeline context enrichments: the ENRICHMENTS registry (run once via `runEnrichments`, blocks appended before any model call) + the Shodan runner; the Google Maps runners live in `maps-enrichment.js` |
| `maps-enrichment.js` | The Google Maps enrichment runners — one per lookup-target shape (address/place lookup, POV & map-view captures, jumps, nearby/relocation Places searches, cross-barrier crossings, the journey view) incl. the Street View vision-describe helper; orchestrates lookups → SSE events → context blocks, dispatched by `runGoogleMapsEnrichment` |
| `quiz.js` | The inline-quiz capability's pure logic: `quizIntent` (deterministic "quiz me…" gate, EN+SV, typo-tolerant, question-count parsing; triage carries a fail-soft `quiz:true` backup flag for phrasings the regexes miss), `normalizeQuiz` (hardens the quiz-generation JSON the client renders), grade-request validation/normalization — the pipeline phase is `pipeline.js`'s `runQuizGeneration` (JSON model, fail-soft to a normal answer), the interaction runs client-side (`public/js/quiz.js`) |
| `quiz-api.js` | `POST /api/quiz/grade`: grades a quiz's free-text answers (one JSON call on `DEFAULT_MODEL`, quota-gated, usage-recorded); multiple-choice picks grade client-side from the quiz payload |
| `games.js` | The games subsystem's REGISTRY + dispatch seam (the games counterpart of `providers.js`/`search-sources.js`): one declarative entry per game (id/name/emoji/tagline/path/`available(env)`/`handle`); `GET /api/games` serves the shelf the account panel renders, `/api/games/<id>/*` dispatches to the game's handler — adding a game touches no client shelf code |
| `tokemon.js` | The Tokemon game's PURE core (Node-tested): Pokémon Gen-1 mechanics verbatim under an AI-themed skin (stat/damage/catch/escape formulas, medium-fast XP, the official type chart renamed 1:1, species stats copied from documented Gen-1 species), seeded-RNG deterministic spawning per (geocell, 15-min bucket), the turn-based battle engine, and the client-view projections (`publicSave`/`publicBattle`/`publicCreature` — the anti-cheat boundary — plus `parseLatLng`) — see the **tokemon-game** skill |
| `tokemon-data.js` | The game core's static DATA tables (Gen-1 provenance): the renamed type chart, moves, species, starters, balls/heal items, spawn/item-drop tables — re-exported through `tokemon.js`, so consumers see one surface |
| `tokemon-api.js` | The first registered game: `/api/games/tokemon/*` (dispatched via `games.js`) — save persistence (D1 `tokemon_saves`), spawn re-derivation + proximity validation, server-side battle resolution; 503s without D1. Also the street-view AR mode: `…/scene` (a Street View frame at the player's position with spawns projected INTO the imagery, via `googlemaps.js`'s edge-cached POV capture, gated on the per-user `google_maps` knob) and `…/go` (text navigation) |
| `tokemon-nav.js` | The street-view mode's PURE side (Node-tested): the bilingual text-command grammar (`parseGoCommand` — "go north 200 m" / "gå till Kungsgatan 1" / "look right", EN+SV parity per invariant 6), spherical geodesy (`destinationPoint`/`bearingBetween`), and `projectSpawns` (bearing→x, distance→y/size placement of spawns inside a Street View frame) |
| `prompts.js` | All LLM prompt builders |
| `validation.js` | Request validation (messages, images) + model/vision resolution, plus the untrusted-client-input sanitizers (`resolveShellTranscript`, `sanitizeClientDiag`, `sanitizeFsSummary`) shared with `chat.js` |
| `model-routing.js` | The shared split-model-routing decision (`resolveJsonModel` — JSON planning phases stay on the fixed reliable model): a leaf module (imports nothing) so `chat.js` and `mcp.js` share ONE implementation instead of a verbatim copy |
| `billing.js` | The shared split-billing spend math for a completed request (`summarizeSpend` — the up-to-three-model-bucket token/cost totals COLLAPSED into one figure, each priced at its own catalog rate; `spendByModel` — the SAME buckets kept APART, one attribution row per model that spent, feeding the `usage_model_events` ledger so a user's spend stays attributable to the model that drove it; `exaCost` — searches at their depth-tier price plus the `/contents` fetch surcharge): a leaf module (only the pure cost primitives from `quota.js`/`budget.js`) so `chat.js` and `mcp.js` share ONE implementation instead of both re-inlining it (`mcp.js` pulls it in via its dynamic-import block so the pipeline still stays out of `mcp.test.js`) |
| `conversation.js` | Message-array utilities (textOf, image parts, formatting) |
| `budget.js` | Time-budget planner: per-model EWMA stats, plan, deadline checks — plus the report-comprehensiveness tiers (`reportTierFor`: the slider buys OUTPUT depth too, brief → standard → extended → full; the plan carries the tier and its synthesis/validation token caps, and prompts.js turns it into per-tier report structure; triage-`simple` questions are capped at the standard shape by `applyComplexityToPlan` — seam-battery evidence, EVAL-BENCH-FINDINGS 2026-07-15) |
| `model-profiles.js` | Evidence-driven per-model overrides (priors, JSON reinforcement, validation skip) |
| `berget.js` | Berget client (primary provider): streaming + JSON-mode completions (both fetch calls time-bounded — invariant 2), model catalog (incl. raw per-token pricing) |
| `anthropic.js` | Anthropic (Claude) client — second, `ANTHROPIC_API_KEY`-gated provider: raw-fetch Messages API with an SSE adapter re-emitting Anthropic streams as OpenAI-style SSE (so `consumeChatStream` + all its guards work unchanged), static EUR-priced catalog (opus/sonnet/haiku) — see the **add-llm-provider** skill |
| `openai.js` | OpenAI (GPT) client — third, `OPENAI_API_KEY`-gated provider: raw-fetch Chat Completions; NO stream adapter (OpenAI SSE is the native wire format `consumeChatStream` parses), only pinned wire params (`max_completion_tokens`, `reasoning_effort: "none"`, `stream_options.include_usage`), static EUR-priced catalog (gpt-5.6-sol/terra/luna + gpt-5.4-mini) |
| `providers.js` | The LLM-provider dispatch seam: merged model catalog (`listChatModels`) + `chatCompletion`/`completeJson` routed by model-id namespace via the `SECONDARY_PROVIDERS` registry (`claude-*` → Anthropic, bare `gpt-*` → OpenAI, else Berget) — everything downstream is provider-agnostic |
| `exa.js` | Exa web search — the DEFAULT web-search backend. `webSearch` first resolves the configured backend (`config.js`'s `search` block) and routes a non-`exa` selection to `websearch-backends.js`, falling back to Exa on failure; the cache key carries the backend id |
| `websearch-backends.js` | The pluggable web-search BACKEND — SERVER FAÇADE over the shared pure core `public/js/websearch-backends-core.js` (the bash-core.js arrangement, so Se/rver AND Se/cure share ONE implementation): adds only the server-shaped `resolveSearchBackend` (config + `SEARCH_BACKEND_URL`/`SEARCH_BACKEND_KEY` env) + the config allowlist (`["exa", …self-hosted]`). Default `exa` keeps the site unchanged; a non-`exa` selection routes through the core (SearXNG / Exa-compatible), Exa fallback on failure; `/contents` full-text stays Exa-only. Se/rver config is the admin, server-wide `/admin` **Web search service** panel; recipes for running your own service in the **local-web-search** skill. Node-tested |
| `edge-cache.js` | Fail-soft Workers Cache (caches.default) get/put helpers — the shared cross-request result-cache mechanics behind `exa.js` and `googlemaps.js` |
| `hf.js` | Hugging Face Hub search (models/datasets/papers) — joins each search wave as citable registry sources when the question explicitly targets Hugging Face (`hfIntent`); `HUGGINGFACE_API_TOKEN` secret optional |
| `shodan.js` | Shodan host-intelligence client + target extraction (opt-in `shodan_mcp` knob) — see the **integrations** skill |
| `geocode.js` | Reverse geocoding via OpenStreetMap Nominatim: resolves a photo's GPS EXIF coordinates (extracted client-side by `public/js/exif.js`) into a human-readable place name the model and Exa can reason and search with. Server-side like every other outbound call (so it's logged and rate-limited consistently); only the coordinates cross the wire — never the filename, question, or any account/session identity. Fail-soft (returns null on any failure/timeout) |
| `googlemaps.js` | Google Maps Platform clients (Places, Street View, Static Maps, Routes) and the edge-cached lookup orchestration (opt-in `google_maps` knob) |
| `googlemaps-blocks.js` | The Maps integration's pure labeled context-block builders (POV/jump/cross-barrier/nearby/map-view/lookup/journey blocks + the keyless `mapLink`/`panoLink` helpers and `compassDir`) — Node-tested; the API key never appears here |
| `googlemaps-text.js` | The Maps integration's pure text side: deterministic address/place extraction, every intent gate (street-view, moves, here-asks, nearby/relocation, barriers, journey), locality corrections, the conversation-state recovery (`pendingRelocation`, `extractJourneyPoints`), and `pickLookup` — the ORDERED LOOKUP_MATCHERS registry (one small matcher per ask shape; the order is the spec) — all Node-tested |
| `history-key.js` | Per-user key for the client's encrypted local chat history — see the **storage-privacy** skill |
| `log.js` | Structured JSON logger (`LOG_LEVEL` var) |
| `http.js` | Response helpers shared across modules: `jsonResponse`, `sseResponse`, `htmlResponse`, `textResponse` (the last is the `?format=text` plain-text renderer the admin-loop board endpoints return) |

Client (`public/`): `index.html` (markup only) + `css/app.css` +
ES modules in `js/` — `app.js` (bootstrap/wiring: scrolling, slider,
search knob, composer, and the Introspection/SDK composer-row status chips
(`#introroute`/`#sdkbuild`, 2026-07-20) that fill the space the slider leaves
in those two modes — CSS keyed on the same root theme class as the slider
hide; also wires the test-queue client
`testpoints.js` — the try-it banner + queue over the pure
`testpoints-core.js`, fed the app-specific action hooks so it never
reaches into `app.js` internals — see the
**testable-interaction-points** skill), `stream.js` (conversation history + `/api/chat`
SSE send loop, autosaves to encrypted local history after every turn;
`currentBuildSlug`/`resetBuildSlug` expose the SDK-mode build-status chip's
state — the conversation's remembered `/app/<slug>/`, and the chip's ↺ action
to forget it so the next send starts a fresh build),
`embeds.js` (the conversation embeds registry stream.js wires via
`initEmbeds`: record/prune/size-cap of pipeline-embedded elements, quiz
interaction hooks, the persisted `embeds` list — strict-checked),
`recovery.js` (the answer-recovery polling client for server-parked
answers — `recoverAnswer`'s rolling-deadline poll loop + `ackAnswer`;
delivery of a recovered answer stays in `stream.js`),
`pending-answer.js` (the RESUME-ACROSS-RELAUNCH pointer that closes the
gap `recovery.js` can't: iOS can discard a backgrounded PWA entirely, so
a cold relaunch loses the in-memory request id `recovery.js` would poll
with — this writes a metadata-ONLY marker (conversation id, request id,
settings, timestamp; NEVER message text, and nothing for incognito
chats) so the next launch collects the answer the server finished while
the tab was gone),
`sse.js` (the pure SSE line-buffer parser `stream.js`'s read loop feeds —
Node-tested), `message-content.js` (pure builders for the outgoing
message: labeled document / image-metadata / RAG-excerpt blocks, title
derivation, history image-stripping, `splitUserContent`, plus
`conversationCopyText`/`embedRef` — the header copy-button's plain-text
"User:/Assistant:" conversation export with images, appended blocks, and
pipeline-embedded elements (Street View panorama/frames, id-numbered)
reduced to one-line references — the
Node-testable core `stream.js` orchestrates around),
`models.js` (model dropdown; its country-of-processing flags come from the
shared `provider-region.js` — Berget EU/Sweden, OpenAI/Anthropic/Groq US,
local/on-device no flag — read here, in `cure/drc.js`, and in
`introspect-core.js`), `attachments.js` (pending images/docs;
the canvas downscaler itself lives in `image-downscale.js`, the shared
leaf `feedback-attach.js` — the feedback pipeline's add-a-screenshot
widget — also compresses through; `docs.js` extracts text AND metadata from
attachments — pdf via the vendored pdf.js, docx via a hand-rolled
ZIP/DecompressionStream reader that also surfaces tracked-changes /
`&lt;w:delText&gt;` leaks, plus md/txt — and owns the shared file-kind classifiers
`isParsableDoc`/`docExt`/`isImageFile` used by both `attachments.js`
and `projects.js`),
`account.js` (the account panel SHELL: `initAccountPanel`,
the shared `PanelCtx`, and the `showView` dispatcher — the views live in
`account-views.js` (summary, full usage,
games shelf + the shared building blocks: setting rows, info popovers,
notification badge, the Feedback-mode/sandbox knob rows the settings
view renders), `account-messages.js` (the message center),
`account-settings.js` (ALL configuration — the cloud-storage/Shodan/
Maps knobs plus the Feedback-mode and sandbox knobs; opened from the
summary's Settings button OR directly via the header's gear icon,
2026-07-11 directive),
`account-feedback.js` (the Feedback dialogue-threads view — thread
screenshots render as thumbnails off the per-image endpoint, and each
reply box carries the `feedback-attach.js` widget),
`account-articles.js` (the admin-only "Article collection" view — the
article series about the project as pure data + a pure HTML builder,
Node-tested; each entry carries a `body` abstract/intent plus an optional
full `article` imported from `account-articles-full.js`; the summary
button renders only for `role === "admin"`)),
`account-articles-full.js` (the expanded full-article HTML bodies,
Swedish — the mirror of the `docs/linkedin/*.md` drafts, kept separate so
the data module stays readable; imported by `account-articles.js`),
`notifications.js` (the small rendering fragments — alert severity
badges, pending-user rows, the K/M `formatCount` abbreviator — genuinely
shared between `account.js`'s
message-center admin section and `admin.js`'s full notification center;
their surrounding markup differs deliberately, so only the identical
pieces live here),
`turns.js`
(bubbles/content/tools — Raw/Copy/PDF — plus reconstructing a stored
conversation on load; feedback is given from the chat now, so there is
no per-reply Feedback button here — the account panel's Feedback view
`account-feedback.js` keeps the screenshot-attach widget
`feedback-attach.js` for thread replies), `quiz.js` (the interactive inline-quiz card a `quiz` SSE event
renders into the turn body: sequential questions with alternatives PLUS
a free-text field, local multiple-choice grading, `/api/quiz/grade` for
written answers, the score verdict/recap — answers persist via the
embeds registry, the completed summary is appended to the assistant
message in history; pure scoring/summary core Node-tested),
`activity.js` (step bars, stats, collapse, and the
Street View / map embeds; its PURE import-free logic —
`buildResearchDebugJson` (the "Copy research JSON" export of a turn's
COMPLETE response for pasting into Claude Code: the research process AND
the full resulting generation AND every error, server- or client-side),
`sanitizeResearchEvent`, `searchServiceName`, `zoomToFov`, `formatStatsLine`
— lives in `activity-core.js`, Node-tested, and is re-exported by
`activity.js` so importers are unchanged),
`imagedeck.js` (the conversation-wide IMAGE DECK: every Street View/map
frame a reply shows joins one ordered deck; clicking a thumbnail — in a
frames strip or a waypoint miniature on the interactive map — opens the
enlarged slideshow with ‹/› navigation, a mini-map of the image's
position linking to Google Maps, and a per-image chat panel whose
question continues the conversation anchored AT that image's position
via the map_view anchor; live-session only, pure registry core
Node-tested),
`introspect-ui.js` (INTROSPECTION MODE's DRS client — TIN the titanium
mascot and the private-vs-remote model picker, plus `introspectionRouteLabel`/
`openRoutePicker` (2026-07-20) backing the composer's `#introroute` chip —
app.js's compact readout of the picked route that reopens the picker on tap,
filling the space the research-depth slider leaves in Introspection; its
routing accessors are Node-tested, the DOM glue verified live) over the shared
`introspect-core.js` pure core (the EN+SV intent gate, the sticky
conversation-mode gate, the source-RAG chunker / int8 vector codec /
retrieval, and the capped context-block builder — the one implementation
behind `src/introspect.js` and both tiers' clients),
`markdown.js`
(sanitized rendering), `report.js` (the branded PDF report export of
an answer — lazy-injects the vendored jsPDF on first use only, so the
normal page load never pays for it), `timescale.js` (slider scale), `history-store.js`
(IndexedDB + AES-GCM: the conversation store itself — encrypted, except
project chats which rest readable because they're RAG-indexed — also
dual-writing each record to the cloud, always, per invariant 4),
`history-ui.js` (the left history sidebar: list/rename/delete/load — and, in
SDK mode only, it renders the showcase gallery at the top of the same pane;
a pick prefills the composer via app.js's `onShowcasePick`),
`sdk-showcase.js` (the SDK-mode SHOWCASE GALLERY: a curated, grouped catalog of
single-shot chatbot build briefs — each a ready-to-send SDK prompt sized for the
reference model Claude Sonnet 5 — plus a pure `renderShowcaseGallery`; data +
lookups are Node-tested, the one DOM export is guarded),
`settings.js` (cached `/api/settings` client; `storageAvailable()` is the
synchronous question every storage-touching module asks),
`canned-faq.js` (the prepackaged NON-LLM "get-started helper" both tiers show
BEFORE a model is reachable — Se/cure before an API key, Se/rver before
sign-in: short prewritten answers to the common questions, each carrying the
`CANNED_LABEL` badge so it is unmistakably not the AI; static markdown, EN+SV
per invariant 6, Node-tested), `dev-mode.js`
(developer mode's CLIENT presentation: the TITANIUM-GRAY theme — a `dev-mode`
class on the ROOT element re-pointing the nine palette variables, `:root.dev-mode`
in `css/app.css` — mirrored into a `dr_dev_mode` localStorage cache so a PWA
relaunch paints the titanium palette at first paint before `/api/settings`
answers; `app.js` applies the cache synchronously at boot then reconciles with
the server's authoritative `developer_mode`, and the Settings-panel Chat mode
dropdown flips it on pick — Node-tested), `chat-mode.js` (the chat MODE
dropdown's state —
Normal / Introspection / SDK, 2026-07-18 (the khaki SWE build mode was folded
into SDK 2026-07-19): the `dr_chat_mode` localStorage pick layered over the
developer_mode capability; decides which theme class the root carries —
`dev-mode` titanium for Introspection, `sdk-mode` GREEN for the SDK "lovable
experience" (distill this site — above all the Se/cure tier — into a new
flavour) — and which per-send fields `stream.js` declares
(`developer_mode:false` for Normal, `sdk_mode:true` + `build_slug` for SDK);
`reconcileChatMode` downgrades a stored pick when the knob is off; Node-tested),
`sdk-core.js` (DistillSDK's shared PURE core — see the `src/sdk-tools.js`
row above; lives under `public/` per the pure-core convention, imported by the
Worker, the `sdk/pair-cli.mjs` CLI, and Node tests — Node-tested),
`agent-spec-core.js` (the Agent Platform's shared PURE core — the AgentSpec
schema, the closed control vocabulary, validation/resolution, the
`composerMarkup` composer renderer + `proveComposer` visual-proof check,
`agentLinkPlan` share-link minting contract, and `agentsFromSnapshot`; server
façade `src/agent-spec.js`, CLI re-export, Node-tested `agent-spec-core.test.js`
— see `docs/AGENT-PLATFORM.md`), `agent-preview.js` (the `/agents/preview.html`
surface: renders each agent's composer from the registry, wires its example
questions as composer deep-links, shows the share-link quota), `deeplink-core.js`
(the pure composer deep-link parser `parseComposerDeepLink` behind the
`/?mode=…&ask=…` "ask the source" links the agent-platform docs use; Node-tested,
wired in `app.js`), `sandbox-mode.js` (the SANDBOX counterpart of
`dev-mode.js`: a `dr_bash_lite` localStorage mirror of the `bash_lite_mcp` knob
so the cross-origin-isolation self-heal fires SYNCHRONOUSLY at first paint from
the cache — closing the 2026-07-13 boot-race where a send before `/api/settings`
resolved fell back to a plain web answer with no sandbox activity, chat_logs
#306 — plus the single `isolateForSandbox`/`shouldIsolate`/`clearIsolationGuard`
self-heal helper `app.js`, the knob toggle, and the `pageshow` bfcache handler
all route through; Node-tested),
`sandbox-files.js` (the sandbox's file-mounting PURE core — the `/workspace`
+ `/mnt/<projname>-<hash>` layout, the mount manifest, and `buildSeedScript`
that cp's host bytes ingested via CheerpX DataDevices into the persistent
tree; Node-tested, the DOM glue is `sandbox.js` — see the **execution-sandbox**
skill),
`agent-backdrop.js` over the pure `agent-backdrop-core.js` (the AGENT ACTIVITY
BACKDROP — instead of popping the sandbox terminal open, raw commands + output
drift faintly across the page background; fed from `execInSandbox` in
`sandbox.js` so both tiers surface automatically; a ring-buffered
multi-channel transcript, Node-tested; transparency has been FIXED since the
2026-07-13 slider removal),
`boot-messages.js` (the pure, Node-tested rotating boot-bar quips shown on the
notification bar while the CheerpX Linux image streams and boots; ticked by
`sandbox.js`),
`bar-tint.js` (the iOS bar-tint re-assert
helper, an import-free PUBLIC-graph leaf both tiers boot with: iOS Safari can
keep the PREVIOUS page's `theme-color` chrome tint across the tier crossing —
2026-07-10, recurred 2026-07-17 with the bottom toolbar too — so `wireBarTint`
layers the changed-then-target meta nudge across first frame, `load`, every
`pageshow` (bfcache restores rerun no module code), visibility-restore, and
two lagged timers; wired in `app.js` (blue) and `cure/drc.js` (khaki),
allowlisted in `src/assets.js`, Node-tested), `balloon.js` (the Se/rver BALLOON GREETER —
the blue tier's symbol character, F-16, owner's pick 2026-07-15: the ghost's
counterpart, a little gold-and-blue balloon among clouds above the composer.
FIRST-VISIT ONLY since the round-4 directive (2026-07-15: NO persistent
figure follows the user around, on either tier): `showBalloonGreeter` is
chained onto the landing intro's `onDone` in `app.js` — never a routine
boot — swishes in, speaks a couple of pointer lines (`GREETER_LINES`: what
the tier does + the ghost button as the door to Se/cure; any tap dismisses,
UX-1), then climbs away (`departProgress`) and unmounts; burner flare +
climb + pennant per completed task via `stream.js`'s `done` event only
while on screen (a no-op afterwards), cloud swishes on ALL its transitions,
pure core Node-tested, DOM layer fail-soft/`pointer-events:none`/reduced-
motion-static — see `docs/SYMBOL-LANGUAGE.md`), `balloon-intro.js` (the
Se/rver first-visit LANDING intro — the blue tier's counterpart of /cure's
umbrella intro, deliberately FASTER (~4.1 s vs ~5.9 s, test-pinned): the logo
vortex untwists into WIRE balloons seen from above, the camera drops a full
**180°** (twice the umbrella's quarter-lap) rolling sideways as it descends —
clouds swishing up past the view, the guide's own vocabulary — and ends
looking UP from underneath at FIVE same-shape/different-size balloons, color
flooded back, baskets rigged, burners glowing in the mouths; pure timeline +
geometry core Node-tested, same watchdog/tap-to-skip/easter-egg/`anim_speed`
contract as `umbrella.js`, gated in `app.js` on first visit + reduced-motion
with `?anim=1`/`?anim=rev` as the forced replay; exports the shared
single-balloon renderer `drawBalloonFigure`), `balloon-spinner.js` (the blue
tier's WAITING SYMBOL — `mountBalloonSpinner`, the exact
`mountUmbrellaSpinner` contract, now wired in `turns.js`/`activity.js` where
the umbrella spinner used to be (the umbrella spinner remains Se/cure's, in
`cure/drc.js`): each loading slot boomerangs the balloon intro in miniature,
turning back JUST before the color revival; completion speed-runs INTO the
fully colored blue-and-gold balloon and folds it into a **BLUE ✓**
(`--check-blue`, app.css — Se/rver's counterpart of Se/cure's pink ✓);
reuses balloon-intro's timeline/renderer AND umbrella-spinner's pure
boomerang/tumble clocks, pure plan helpers Node-tested), `mode-theme.js`
(the MODE-THEME REGISTRY — the codified catalog of what makes each chat mode
its own: root class, accent + ✓ color, waiting-symbol spinner, theme
character, side-panel flavour, and optional theme features like the research
`depthSlider` (hidden in Introspection + SDK), one descriptor per mode (Normal
/ Introspection / SDK) plus the two tier reference entries (Se/cure first); pure/import-free,
Node-tested; the shape SDK mode distills into when it "creates new themes of
this kind" — see `docs/SYMBOL-LANGUAGE.md` §7), `mode-spinner.js` (the DOM
dispatch `turns.js`/`activity.js` call — mounts the CURRENT mode's spinner off
`mode-theme.js` `spinnerKind`: balloon in Normal/Introspection, the PLANT in
SDK; fail-soft to the balloon), `plant-spinner.js` (SDK mode's WAITING SYMBOL —
`mountPlantSpinner`, the sibling of the balloon/umbrella spinners: a seed HITS
THE GROUND, GETS PLANTED and boomerangs a settled sprout, turning back JUST
before real growth; completion GROWS it out (stem, leaves, a gold-green bloom)
and folds it into a **GREEN ✓** (`--check-green`, app.css); reuses
umbrella-spinner's boomerang/finale clocks, exports the shared `drawPlantFigure`
renderer, pure state/plan helpers Node-tested), `sdk-plant.js` (SPROUT — SDK
mode's theme CHARACTER, the ghost/balloon/TIN counterpart: a one-shot greeter
the first time a user enters SDK mode (`showSdkPlantGreeter`, dynamically
imported in `app.js`, once per browser), a little plant that grows in with the
SAME `drawPlantFigure` renderer, speaks a couple of pointer lines, then fades;
DOM fail-soft/`pointer-events:none`/reduced-motion-static, pure grow-in easing
Node-tested), `opfs.js`
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
knob at top, the vault store-with-secret section, dropzone, add-text
form, file/chat lists, header chip; plus the sidebar's
load-project-from-secret form), `vault-core.js` (the project vault's
dependency-free PURE core: the copy-safe 160-bit Crockford-base32
secret — generation, forgiving normalization — HKDF id+key derivation,
AES-256-GCM archive encrypt/decrypt, archive validation, base64
helpers; publicly served because DRC builds on it) + `vault.js` (the
DRS store/load orchestration over it, re-exporting the core: packing a
whole project — record, chats, decrypted file originals, RAG index
with vectors — into ONE blob the server only ever sees encrypted; its
static imports pull the DRS storage stack, so it must NEVER enter the
/cure module graph — public modules import `vault-core.js` instead;
pure core Node-tested). DRC's client modules — the whole public tier:
`drc-core.js` (DRC's pure core, built on `vault-core.js`: ONE master secret →
HKDF-independent public reference + blob id + blob key; the sealed
project-state archive — provider API keys live INSIDE it; the HKDF info
strings/state-kind constant are frozen pre-rename values; plus the
`.drc` encrypted BACKUP helpers (2026-07-15, Forever Agent §8 pick #1):
`drcBackupFileName` + `openDrcBackup` — the sealed blob exported as a
downloadable file and restored (file + secret) on any device, the guard
against silent localStorage eviction; import never clobbers a newer
local copy (newer state wins, the other's chats merge in — drc.js) —
Node-tested),
`drc-providers.js` (the client-side provider registry: the CORS-capable
providers ONLY — OpenAI, Groq and Berget (CORS confirmed live
2026-07-11), callable directly from the browser
with the user's key — PLUS the keyless `local` entry (2026-07-15,
Forever Agent §8 pick #2): the user's OWN OpenAI-compatible server
(Ollama / LM Studio / llama.cpp), "configured" by its base URL alone
(`configuredDrcProviders`' keyless generalization; the URL lives in the
sealed state as `localBaseUrl`, set in the /cure settings drawer with a
`GET /models` detection probe), no Authorization header sent, and with
no fixed `jsonModel` the planning phases fall back to the chosen model —
the strongest privacy mode: NO third party receives the conversation;
per-provider wire quirks, JSON mode, a fixed cheap
`jsonModel` per provider, live `/models` with a static fallback, plus
the per-provider `embed` entry + `drcEmbed` — browser-direct embeddings
on the user's key: OpenAI `text-embedding-3-small` dimension-reduced to
512, the deliberate small/fast/quota-friendly choice; Groq serves no
embeddings endpoint, so a Groq-only session runs without RAG —
Node-tested over mock HTTP), `drc-rag.js` (DRC's client-side RAG over
conversations and projects: each chat is an incrementally-indexed doc —
only not-yet-indexed turns embed, the chat-rag `srcMsgs` discipline —
and each send retrieves top-k across the project's chats (siblings in
full, the current chat only for turns outside the recent-turns window)
into a labeled context-not-instructions recall block threaded through
triage/synthesis/validation; the index — chunk text AND vectors — rests
INSIDE the sealed state, ciphertext at rest (stricter than DRS's
readable-when-indexed exception); an embedder change wipes + lazily
re-indexes; per-doc/total chunk caps sized for the localStorage quota;
pure over an injected embed fn, every call site fail-soft —
Node-tested), `drc-research.js` (the deep-research
pipeline PORTED TO THE BROWSER: triage → parallel knowledge HARVEST
(the search wave's offline counterpart — no web search, the model's
knowledge is the source pool and the prompts force that honesty) → gap
audit + one follow-up round → streamed synthesis on the chosen model →
validation with a revise-and-replace verdict via the discard_text
convention; deterministic, NO function calling, every helper phase
fail-soft — the pipeline invariants hold client-side; whole flow
Node-tested end to end against a mock provider), `drc-store.js`
(the BROWSER-LOCAL sealed-state storage adapter — localStorage rows of
ciphertext keyed by blob id, injectable backend, deliberately the seam
a future remote adapter would slot into — Node-tested),
`ondevice-core.js` + `ondevice-engine.js` + `ondevice-worker.js` (the
ON-DEVICE inference tier, 2026-07-16 — `docs/BONSAI-27B-PHONE-INFERENCE.md`:
1-bit Bonsai models run INSIDE the browser on WebGPU via the VENDORED
transformers.js (`public/vendor/transformers/`, SHA-256-pinned like xterm),
weights downloaded from Hugging Face into an OPFS cache with resume +
streaming-SHA-256 verification, behind the sealed-state `onDevice` knob
(v5) and the UX-4 consent popup (exact size in the button; dismissal is
never consent). The engine registers as a built-on-demand `engine` provider
(the proxyLlmProvider pattern) whose wire calls hit the in-browser engine —
drcChatStream/drcCompleteJson branch on `provider.engine`, with per-provider
`jsonTimeoutMs`/`streamIdleMs`/`serialize` overrides for phone-speed
inference; the pure core (catalog, HF-tree download plan, progress math,
streaming SHA-256, think-strip filter, capability verdict, wire shapes) is
Node-tested; the worker is browser-only glue like sandbox.js), and
`drc-page-core.js` (the DRC page's import-free PURE core — the small
fragments the `/cure` DOM-wiring layer (`drc.js`) would otherwise inline
or duplicate: `grantLive`/`grantFlagEnabled` (the ONE liveness + master-
toggle check both borrowed-capability subsystems — the web-search grant
AND the proxy bundle — share), `grantMeterLine` (the one borrowed-service
status-line wording the Se/rver-token and proxy-bundle Settings rows keep
in lockstep), `normalizeSearchBackend` (the web-search
backend config normalizer, one definition for the sealed-state read and
the settings-form persist), the deep-link path parsers
`parseProjectPath`/`parsePublicationRef` (with "workspace" a RESERVED slug),
`wmHtml` (the escape-first
Se/cure–Se/rver wordmark-slash renderer), and `privacyNoticeLines` (the ℹ
PRIVACY NOTICE's text, 2026-07-16: what this session's current configuration
sends where — model route, web-search route, recall, borrowed allowances,
shared-workspace provenance; the animations are tier identity again — UX-2,
SYMBOL-LANGUAGE.md §6)
— Node-tested), and
`workspace-core.js` (SECURE WORKSPACES' pure core, 2026-07-15: a fully
configured Se/cure session — keys, settings, chats, borrowed grant tokens —
sealed into ONE OFFLINE LINK, `/cure/workspace#w=<ciphertext>`; the
mechanism is CLONED from github.com/kristerhedfors/hacka.re (owner
directive) — the `[salt10][nonce10][cipher]` base64url fragment, the
8192-round iterative-SHA-512 KDF, the dual-key split (link key opens the
blob; a never-transmitted master key for local at-rest use), the
namespace-from-SHA-256(blob) — with AES-256-GCM as the one substitution
(no TweetNaCl dependency); the fragment never reaches any server, embedded
grants stay quota-metered and live-administered by their minter (the
adjust endpoints above); pane wiring in `cure/drc.js`, the Se/rver minting
row in `account-settings.js`, architecture in `docs/WORKSPACE-SECURITY.md`
— Node-tested).
DRC's page is `public/cure/` (`index.html` + `drc.js` wiring +
`drc.css`, plus `umbrella.js` — the first-visit intro animation, the
logo vortex untwisting into wireframe 3D umbrellas, pure
timeline/geometry core Node-tested, replay with `?anim=1`, pace =
2.5× base × the admin's `anim_speed` config slider (public
`GET /api/anim`); the landing
page carries the sibling first-visit onboarding — the does/doesn't
pane and the ghost mascot pointing out the ghost button, inline in
`public/welcome/index.html` — see the **ui-notes** skill):
a deliberate LOOK-AND-FEEL TWIN of the main app in a KHAKI
palette (2026-07-10 directive) — the same floating glass chrome, waves,
composer, spiderweb knob and slider shapes as `css/app.css`,
self-contained since app.css is auth-served. DRS-only features (ghost,
account, attach, camera) appear as DIMMED buttons
(`.drs`) exactly where the app has them; tapping one opens the
`#drspop` explainer pointing to `/rver`. The knob is REAL here — it
flips the client-side research phases — and so is the SLIDER
(2026-07-16): the Se/rver TIME slider MIRRORED (owner directive — same
`timescale.js` 15 s–10 min quadratic scale, same time-stacked-over-tier
readout naming what the setting buys): the seconds persist in the
sealed state (`budgetS`, absent-reads-as-60 s) and are BOTH the roof on
the client-side research — `drc-research.js`'s `drcPlanForBudget` plans
the phase shape from the budget's tier (triage angles, coverage-audit
rounds, the strict review, per-tier report structure + token caps —
`DRC_DEPTH_TIERS`, boundaries = `budgetTier` = `reportTierFor`) and
`phaseWithinBudget` wall-clock deadline guards skip an optional phase
whose budget share is spent (the client counterpart of `src/budget.js`'s
deadline checks; no EWMA here — no server, no latency history) — AND the
report format it buys; the 60 s default = the pre-slider behavior,
byte-identical. A left drawer (the history
sidebar mirrored) holds the local chat list and the Project panel; the
header's gear icon (between ghost and account, both tiers) opens the
settings drawer — ALL configuration: the ONE-FIELD API-key form whose
provider dropdown auto-follows the pasted key's prefix
(`detectDrcProvider`: sk-… OpenAI, gsk_… Groq, sk_ber_… Berget) plus
the sandbox knob; the ghost is the secure-tier marker in both tiers,
each its own way (2026-07-12): on the BLUE tier a glow + shimmer
sweep once every THREE minutes (the same ~4 s event in the first ~2%
of a 180 s CSS cycle since the 2026-07-15 "lower the UX animation
level" directive — app.css and the landing alike), on DRC the ghost
character's contours glow and breathe while it floats (`ghost-contour`
in drc.css, a 7.2 s breath since the same directive).
CHAT-FIRST (a visitor can type
immediately; the first send without a key gets a helpful
open-the-settings pointer, never an error wall), with a first-visit glass pane (`#intro`, doubling as the
publication shelf; the full landing at `/` / `/welcome/` links here),
an unsaved-session → save-as-project flow (the Project panel's one
submit opens OR creates a BROWSER-LOCAL project, merging this tab's
work in), and a project form that is a REAL username+password form
(`autocomplete="username"`/`current-password`, switched to
`new-password` on generate) so 1Password and Apple Passwords
save/autofill the master secret; served for `/cure/<slug>` published
replays (seeded as conversations, in place), `/my/project-<hash>` deep
links, and the `/free*` legacy aliases (`/?continue=<slug>` is the
legacy replay handoff).
Admin UI: `admin/index.html` + `js/admin.js` + `css/admin.css` (served
only to admins). Vendored libs in `vendor/` (`marked` and `DOMPurify`
for Markdown rendering + sanitizing; `jsPDF`, lazy-loaded by `report.js`
for the PDF report; `pdf.js` for parsing PDF attachments client-side;
`vendor/xterm/` — the sandbox terminal `@xterm/xterm@5.5.0` + fit addon,
vendored 2026-07-15 with SHA-256 pins recorded in `sandbox.js`, so a CDN
outage can't break the sandbox; the CheerpX engine stays a CDN load
pending its license question).

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
