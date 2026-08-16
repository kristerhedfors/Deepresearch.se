# Code layout — the per-module map

The AUTHORITATIVE per-module description of the codebase, moved out of
CLAUDE.md (2026-07-17) to keep the always-loaded guide lean. The mirror
discipline is unchanged: **one row per non-test `src/` module**, the client
prose covering every `public/js` module, updated in the SAME commit that
adds or moves a module (the update-docs skill's drift greps target this
file). Architecture rationale lives in `docs/ARCHITECTURE.md`; the
load-bearing invariants stay in `CLAUDE.md`.

**Naming note (2026-07-25):** the `project*` identifiers below are the
Se/rver **workspace** in user-facing language. The code names deliberately do
not move (`docs/BRANDING.md`), so this map keeps them verbatim — that is the
point of the mirror. What a workspace is, in either tier: `docs/WORKSPACES.md`.

Server (`src/`):

| File | Responsibility |
|---|---|
| `index.js` | Entrypoint: request id, identity gate, terms + approval gates, routing (`/api/*`, `/admin`, `/auth/google*`, `/login`, `/logout`, `/terms/accept`), sliding-cookie reissue, request logs (static-asset serving + the public allowlist live in `assets.js`; the response security headers + CSP in `security-headers.js`; the canonical-origin 301 in `canonical.js`) |
| `assets.js` | Static-asset serving (`serveAsset` — the caching policy + the cross-origin-isolation COEP shell) and `isPublicAsset` (the unauthenticated allowlist, dominated by the DRC `/cure` public module graph) — split out of the router so the entrypoint stays about routing |
| `security-headers.js` | The site-wide response security headers + the (currently opt-in) Content-Security-Policy, and `applySecurityHeaders` — the one function `index.js`'s `fetch` wraps every response with |
| `canonical.js` | The canonical-origin redirect (`canonicalRedirect` — 301 any www/http arrival to the https apex, preserving path + query): a pure leaf `index.js`'s `route` calls before anything else; carries the Firefox Focus / OAuth `redirect_uri_mismatch` institutional story |
| `drsw-manifest.js` | The **DRSW/1** node discovery document `/.well-known/drsw.json` (`docs/WORKSPACE-PROTOCOL.md` §7.1) — a pure leaf over the request origin, routed in `index.js` immediately after the public-asset check so discovery needs no identity and no allowlist entry. States what the deployed code actually does: the payload `kind`/version the Se/cure workspace module reads, the portal path, the sections `validateWorkspacePayload` applies, the grant services `server-token.js` issues, the §6 conformance classes MET (R/W — not N, since the §5 interchange sections are specified but unimplemented), and a `spec` block linking the standards in `/docs/`. `drsw-manifest.test.js` reads those values back out of `public/js/workspace-core.js` and `server-token.js`, so the advertisement cannot drift from the behaviour (feedback #39) |
| `auth.js` | Identity: session cookie (365 d, sliding) + admin-secrets break-glass Basic Auth (fail closed); OAuth state HMAC helpers; `resolveRunAs` honors the RUN-AS picker (`run-as.js`) — an `X-Run-As` header on a break-glass request, or a `ra~…` uid inside a signed session cookie |
| `run-as.js` | The break-glass IDENTITY PICKER (pure; no env, no D1): parse `admin` / `user` / `<email>` / `#<id>` / `test:<name>`, build the SYNTHETIC persona (`runas:<slug>`, its own id so pools, consumer keys and consent decisions are per-persona, `synthetic:true` so no surface presents a test identity as a signed-in human), and encode a spec into the session-cookie uid. NEVER escalates — every form is equal or lesser privilege, an unrecognized spec resolves to nothing, and only a break-glass caller may mint one (`POST /api/admin/run-as`, `src/index.js`). Exists so multi-user flows — compute sharing's mutual consent above all — can actually be driven and tested; see `tests/e2e/llm-sharing.live.spec.js` |
| `token-crypto.js` | The shared HMAC-token crypto PRIMITIVES leaf (`b64url`/`b64urlDecode`/`toHex`/`safeEqual`, the raw tag `hmacRaw` and the namespaced `sign` over it, plus the mint/verify pair `sealedToken`/`verifiedClaims` — the render-into-the-wire-shape step every family's mint ends with and the tag check and payload decode every verify opens with): one implementation behind `auth.js` (toHex/safeEqual) and the `websearch-key.js`/`proxy-grant.js`/`pool-token.js`/`mcp-key.js`/`server-token.js` families. The FENCE: what is shared stops at the cryptography. Each family still parses its own wire prefix, passes its OWN namespace into `sign` (which is what keeps them mutually unforgeable under the one key), renders the tag its own way (hex, or base64url for the JWT), and validates its OWN claims — deliberately different, `svc` being the standing example. Do not merge the claim construction or validation, and do not grow either shared helper toward it. `pool-token.js` deliberately keeps its own mint: its `POOL_TOKEN_PREFIX` embeds the separator (`pt1.`), so its composition is not the same string |
| `google.js` | Google OIDC sign-in: state cookie, code exchange, claims validation, auto-provisioning (`ADMIN_EMAIL` → admin) |
| `login.js` | Sign-in, pending-approval, and one-time terms pages (PWAs can't answer a 401 challenge). Escapes through `http.js`'s shared `escapeHtml` |
| `accounts.js` | User accounts CRUD (D1; no passwords). Rows arrive from Google sign-in or from the admin ahead of it (`createInvitedUser`, claimed on first sign-in by `linkGoogleIdentity`) |
| `db.js` | Optional D1 binding + lazy schema (no-op without the binding; `outrospect_texts` — the fetched article bodies behind the outward feed, identity-free like `outrospect_items` — is part of it). Cost tracking rests on TWO ledgers: `usage_events` (ENFORCEMENT — one row per request, `berget_cost` = the SUM across every model that ran, all a cost cap needs) and `usage_model_events` (ATTRIBUTION — one row per model bucket that spent: answer/JSON/vision, so a user's spend stays attributable to the model that drove it; never read for enforcement) |
| `config.js` | Global site config (D1 `config` table, admin-edited, cached ~30 s) |
| `chat-modes.js` | The CHAT-MODE registry's server façade over the shared pure core `public/js/chat-mode-core.js` (the `introspect-tools.js` arrangement): `CHAT_MODES`, `MODE_REQUEST_FLAGS`, `normalizeChatMode`, `modeCarriesSource`, `resolveBodyChatMode` and `routingNeedsRegistry`. ONE table so the Worker and both tiers agree on which modes exist, which request field selects each, and which carry the site's own source. Introduced 2026-07-26 with the mode collapse that retired the `developer_mode` knob — adding a mode is a row here plus a `defaults` row in `sdk/AGENTS.json`, not a new boolean threaded through `chat.js`. Node-tested |
| `quota.js` | Window usage accounting, quota enforcement, cost calc, usage recording, the per-user in-flight concurrency reservation (`reserveInflight`/`releaseInflight`, `INFLIGHT_CAP`), and the two sibling 429-payload builders `quotaBlockedResponse` (quota-window block; also imported by `endpoint-gate.js`/`chat.js`/`rag.js`) and `inflightLimitResponse` (concurrency limit). `recordDefaultModelUsage` records a one-off spend on the fixed `DEFAULT_MODEL` priced from the catalog (fail-soft to zero cost) — the shape the side endpoints share. Cost attribution lives here too: `recordModelUsage` writes the per-model rows into the `usage_model_events` attribution ledger (fail-soft, separate from the enforcement `recordUsage` so it can't disturb it), and `getUsageByModel` (site-wide) / `getUsageByModelForUser` (one user) read the per-model breakdown that answers "what did this budget go to" |
| `endpoint-gate.js` | The side endpoints' shared ADMISSION preamble (`enforceQuotaAndReserve`): the quota gate `/api/chat` applies (admins never blocked) followed by the per-user in-flight reservation, returning either a ready 429 `Response` or the `reqId` the caller must release. `/api/orchestrator/plan`, `/api/quiz/grade` and `/api/bash/step` each re-inlined these nine lines before, so a change to who bypasses the gate could land in one copy and leave the other two endpoints unenforced. A leaf over `quota.js`/`config.js`/`http.js` — it cannot live IN `quota.js`, which has no access to `getConfig` (`config.js` imports `quota.js`) and deliberately returns plain objects rather than Responses. `chat.js` keeps its OWN copy, which additionally logs `chat.quota_blocked` and files a user-facing `quota_exceeded` message. Node-tested |
| `alerts.js` | Operational alerts (D1 `alerts` table): classifies caught pipeline/backend failures (Berget errors, wallet depletion) into a small stable set of alert types surfaced in the admin panel and as a notification badge — rows are upserted by `type` (a recurrence bumps `count`/`last_seen_at` and re-surfaces itself) rather than one row per occurrence; fails soft (a no-op without D1) — see the **access-control** skill |
| `user-api.js` | `/api/me` (usage vs quota) + `/api/models` (dropdown catalog — identity-aware, so the models this account enabled in the Models agent join it) + `/api/client-error` (beacon) + `/api/client-log` (client telemetry beacon → Workers Logs; first user is the sandbox filesystem integration — see the **execution-sandbox** skill) |
| `user-messages.js` | Per-user message center (D1 `user_messages`): account-level notices (quota exhausted/restored, sign-in approved, quota changed by an admin) — structured enums + timestamps ONLY, deliberately no content column, so the feature stays inside the same zero-retention promise the privacy notice makes for conversations; "restored" isn't a separate write, it's derived at read time from the caller's CURRENT quota state (`quota.js`). Rendered by the client's `account-messages.js` |
| `settings.js` | Per-user settings (`users.settings_json`, additive column): the CORE knob `bash_lite_mcp` (experimental execution sandbox) and the account's picked `chat_mode` (the one non-boolean setting — it REPLACED the `developer_mode` knob on 2026-07-26, which had become derived state the mode dropdown wrote on every change while also being introspection's only activation signal; `parseSettings` migrates a legacy `developer_mode:true` row to `introspection`, and `chatModesAvailable`/`storedChatMode` are the two accessors that replaced `developerModeEnabled`), plus one knob per registered EXTENSION whose key, availability and 503 message all come from `extensions.js` — this module names no third-party service. `GET/PUT /api/settings`; the generic gates are `extensionEnabled(env, identity, id)` and `extensionEnabledMap`. Cloud storage is deliberately NOT a knob (invariant 4): `cloudStorageEnabled` is pure availability (R2 binding + user row). Feedback is NOT a knob either (as of 2026-07-18): it's given from the chat — a message opening with "feedback" routes to the feedback pipeline |
| `introspect.js` | INTROSPECTION MODE's server enrichment (gated on the request's mode carrying source — `chat-mode-core.js modeCarriesSource`, i.e. any non-normal mode): whenever it is on it appends the site's OWN source so answers (incl. code-example requests) come from the real code, never a denial. It RETRIEVES the source chunks most relevant to the question from a committed DENSE index (`public/introspect/source-rag.json` — int8 embeddings per source chunk, `scripts/bundle-source-rag.mjs` / `npm run bundle:rag`, a per-file-hash DELTA build that only re-embeds changed files), embedding the query with Berget e5 (same model the index was built with) — so it works for ANY phrasing with NO intent regex and NO Linux VM. Plus a CLAUDE.md orientation excerpt, the full file index for strong "how are you built" asks, named files inlined by path, the **HELP layer** (introspection is ALSO the interactive help, 2026-07-16: the documentation passages relevant to the question, retrieved from the committed docs corpus/index — `scripts/bundle-docs.mjs` → `docs-corpus.json` with resolved symbol references + images rewritten to served `docs-img/` URLs, `scripts/bundle-docs-rag.mjs` → `docs-rag.json` — quoted VERBATIM so usage questions get the documentation's own structure, images and captions, while follow-ups escalate into the source; see the **help-docs** skill), and the **skills catalog** — the repo's `.claude/skills/*/SKILL.md` playbooks surfaced as a first-class listing (`skillsCatalog`/`skillsIndex`/`mentionedSkills`) so ANY answer model in EITHER tier can quote or inline a playbook by name, the same institutional knowledge Claude Code works from (the vendor-neutral root `AGENTS.md` points external agents at the same catalog). Both artifacts (the source snapshot + the rag index) are COMMITTED, served by this deploy, read back through the ASSETS binding — by construction the exact source this deploy runs. `hasSource` flips the answer prompts' capabilities line (prompts.js/pipeline.js) so the model uses the source instead of saying it isn't a coding tool. Shared pure core (chunker/int8 codec/retrieval/block builder) is `public/js/introspect-core.js`; with the sandbox knob also on the tree mounts at `/src` — see the **introspection** skill |
| `introspect-tools.js` | The native source-investigation tools' server FAÇADE: a pure re-export of the ONE shared core `public/js/introspect-core.js` — the tool schemas (`INTROSPECTION_TOOLS`) and the pure snapshot executors `grepSource`/`readFileTool`/`listFilesTool` + `runIntrospectionTool` (the `grep_source`/`read_file`/`list_files` loop DRS drives server-side via `src/anthropic.js`'s tool run and `pipeline.js`'s `runSourceResearchTools`, DRC drives browser-side). The owner-authorized invariant-1 exception (developer mode + tool-capable answer models); the core lives under `public/` for the same reason `bash-agent.js` re-exports `bash-core.js` — see the **introspection** skill |
| `sdk-tools.js` | The SDKs' server FAÇADE: a pure re-export of the ONE shared core `public/js/sdk-core.js` — the manifest operations (validate/close/order/render, shared with the `sdk/pair-cli.mjs` CLI), the SDK-mode native tool schemas + executors (`SDK_TOOLS` sdk_list_modules/sdk_show_module/sdk_plan/sdk_validate over the snapshot's `sdk/MANIFEST.json` — the PLATFORM SDK/DistillSDK side; `BUILD_TOOLS` write_file/publish_app — the AGENTS SDK's shipping tools, Agent Studio's only file pathway), the generated-app staging rules (`sanitizeBuildPath`/`stageBuildFile` caps), the deterministic `FILE:` fenced-block convention (`parseFileBlocks` — the no-function-calling path), and the SDK context block. Consumed by `pipeline.js` `runSdkBuild` — see the **sdk-mode** skill. NOT by `mcp.js` any more: the four `sdk_*` MCP tools were removed 2026-08-15 (a build-planning tool is one a voice caller cannot use) |
| `orchestrator.js` | ORCHESTRATOR MODE's executor (`chat_mode:"orchestrator"`, the violet dropdown entry — same availability gate as SDK mode): `runOrchestration(ctx)`, routed from `pipeline.js` before triage. One JSON plan phase on the fixed jsonModel (invariant 3) turns the request into a validated sub-agent workflow (the DAG lives in the shared core `public/js/orchestrator-core.js` — kinds `deep_research`/`introspection`/`custom`, wave resolution, caps); the Worker executes the nodes in parallel waves (each a buffered `streamCompletion` on the user's model — deep_research nodes run their PLANNED Exa queries through the shared source registry, introspection nodes get `retrieveSourceBlockFor` excerpts), emits the `workflow` + `agent_update` SSE events the client's workflow view renders, then streams one merged answer (`orchSynthPrompt`). Since 2026-07-26 (feedback #35) a node also publishes what it is DOING, for the workflow inspector: a second `running` `agent_update` carrying the head of the prompt it is actually working on (`MAX_PROMPT_PREVIEW` + the true `prompt_chars`), and an `agent` field on its own `search_start`/`search_done` events attributing each query to the node that planned it. Invariant 1 holds — the plan is DATA, no function calling; every node fails soft to an honest gap note (invariant 2) — see the **orchestrator-mode** skill. A failed node is fail-soft but no longer INVISIBLE (2026-07-26): it is classified (`nodeFailureRecord`), named in the `agent_update` note, listed in the chat log's `orchestration.failures` under `MAX_LOGGED_FAILURES`, and filed durably via `recordSubsystemFailure`. Bounded too — node text is stored `clampResult`-ed, and a node abandoned at `ORCH_NODE_TIMEOUT_MS` drops its buffer through `nodeTextSink` instead of accumulating for the rest of the run |
| `orchestrator-api.js` | `POST /api/orchestrator/plan` — the sub-agent team planned BEFORE the chat request, so the browser can run the workflow's `swarm` nodes on its own on-device models first (`docs/SWARM-REASONING.md`). Same shape as `bash-api.js`, and for the same reason (the other client-orchestrated loop): one JSON call on the fixed `DEFAULT_MODEL`, gated on the non-default modes being available to the identity (`chatModesAvailable`), quota-gated + concurrency-reserved through the shared `endpoint-gate.js`, spend recorded via `quota.js`'s `recordDefaultModelUsage`, fail-soft to `{plan: null}` so the client just sends an ordinary orchestrator request. Also owns `normalizeSwarmCapability` — the untrusted client descriptor whose presence is what lets a plan use the `swarm` kind at all (`chat.js` imports it for the same gate on the follow-up request) |
| `agent-link.js` | Agent SHARE-LINK minting: the thin adapter that mints a **standard Se/rver token** (`server-token.js`) for an AgentSpec — loads the agent from the source snapshot, maps it with `agentTokenGrantParams`, and calls `mintServerTokenGrant` (`server-grants.js`). NO new crypto, NO new meter; the SERVER-TOKEN GUARANTEE holds unchanged (upstream APIs only, never Se/rver data, never a login). Admin-gated at `POST /api/admin/agent-link` like the other shareable mint — `handleAgentLink`; see `docs/AGENT-PLATFORM.md` §7 |
| `agent-spec.js` | The AGENTS SDK's server FAÇADE (the SDK tailored to Agent Studio + the integrated Linux environment): a pure re-export of the ONE shared core `public/js/agent-spec-core.js` — the AgentSpec schema helpers (`validateAgentSpec`/`validateAgentRegistry`, `resolveControls`/`resolveTheme`/`resolveQuota`/`resolveExamples`, `composerMarkup`/`proveComposer`, `agentLinkPlan`, `agentsFromSnapshot`, and the text renderers). Also the CAPABILITY layer (spec 0.2.0 — `resolveCapability`/`validateCapability`, the closed `ANSWER_PHASES`/`TOOL_CLASSES`/`CONTEXT_BLOCKS`/`GATE_IDS` vocabularies, `serverOnlySelections`), the four NARROWING accessors that make a declared field executed (`capBound`/`capSearch`/`capHasTool`/`capHasContext` — the platform's limit is both the default and the ceiling; `capHasContext` joined them 2026-08-13, which is what turned `capability.context` from a pinned declaration into the gate on the enrichment and search-source registries), the request router `resolveRequestAgent` (three routes, most specific first: an inline `agent_spec`, an `agent` id address, then the registry's `defaults` table — falling through is the only failure), and the untrusted-spec boundary `resolveUntrustedAgent`/`requirementsFor`/`IMPLIED_REQUIREMENTS`, which fails closed and derives the needed knobs from what a capability SELECTS rather than from its self-declared `requires`. Loads the ten shipped agents from `sdk/AGENTS.json` (via the source snapshot, like the manifest); the CLI (`sdk/pair-cli.mjs agents`/`agent`) re-exports the same core. Full docs: `docs/AGENT-PLATFORM.md`, the **agent-platform** SDK module skill |
| `agent-registry.js` | The AGENT REGISTRY loading seam: one cached, fail-soft load of `sdk/AGENTS.json` per ASSETS binding — by construction the definition THIS deploy runs. This is what lets `chat.js` route a request by DATA (the registry's ordered `defaults` table → `capability.answerPhase`, and the whole resolved capability) instead of by a hand-written flag cascade; `agent-link.js` re-exports the loader for the mint. It reads the small dedicated artifact `public/introspect/agents.json` FIRST (`AGENTS_REGISTRY_PATH`, a byte copy written by `scripts/bundle-source.mjs`, shape-checked so a 200 carrying the SPA's index.html is not cached as an empty registry) and falls back to the multi-megabyte source snapshot, which is how this worked before the artifact existed. That artifact is what pays for `routingNeedsRegistry` returning `true` unconditionally since 2026-08-13: the shortcut it replaced skipped the load for the general Deep Research turn, and with the general agent retired a skipped load means a NULL capability — the unrestricted platform default, which is the opposite of what every domain agent's gates are for. The cache is keyed on the ASSETS BINDING rather than held in a module variable, so a caller with a different binding can never be served another env's registry. Every failure returns null and the caller keeps its built-in behaviour (invariant 2) |
| `bash-agent.js` | The bash-lite agent's server FAÇADE: a pure re-export of the ONE shared core `public/js/bash-core.js` — `bashIntent` (deterministic EN+SV "wants a shell" heuristic), `parseShellRequest` (the fenced ```bash convention — NO function calling), exec-result normalization/clamping, `buildShellTranscript` (the labeled synthesis block), `buildStepUserMessage` (the per-round step question both tiers send), and (client-only, not re-exported here) the exec BRIDGE's pure protocol codec — `execEnvelope`/`parseExecEnvelope` (the marker+base64 envelope incl. the RC-before-any-pipe fix), `concatChunks`/`base64ToBytes`, and `isExportablePath` (the which-guest-paths-may-leave-the-VM policy, next to `OUTBOX_PATH`) — that `sandbox.js`'s `execInSandbox`/`exportFile` drive. The core ALSO holds the OUTBOX download flow's pure side (2026-07-15, client-only — not re-exported here): ask for a file → the agent copies it into `/workspace/outbox` (`bashAgentPrompt` convention) → after the loop `sandbox.js` `collectDeliverables` lists (`outboxListCommand`/`parseOutboxListing`, capped) and exports each via the base64-through-exec round-trip → `turns.js` `renderDeliverables` attaches download chips with an add-to-project dropdown (`projects.js addFilesToProject`), and a synthetic `deliverablesRun` transcript entry tells synthesis the hand-over happened (rides the existing `shell_transcript` contract — no new API field). The core lives under `public/` because the browser can only import served modules while the Worker bundler can import from anywhere; this replaced the old hand-mirrored server/client copies (2026-07-11) — see the **execution-sandbox** skill |
| `ai-models.js` | The AI/LLM model-name recognizer's server FAÇADE: a pure re-export of the ONE shared core `public/js/ai-models.js` — `aiModelIntent`/`aiModelMentions` (does a message name a model FAMILY, alone or with a version like `glm-5.2`, `kimi k2`, `deepseek v3`? — language-neutral, so EN+SV parity is inherent) plus the two prompt notes `AI_MODEL_NOT_A_PACKAGE_NOTE` (spliced into `bashAgentPrompt`/`drcBashAgentPrompt` so the offline sandbox stops treating a model name as a local package — the IMG_5207 `apt-cache search glm-5.2` misfire) and `AI_MODEL_RESEARCH_NOTE` (spliced into `triagePrompt`/`drcTriagePrompt` so a model question is decomposed into a proper research plan). The core lives under `public/` for the same reason `bash-agent.js` re-exports `bash-core.js`; both tiers also SKIP the offline sandbox for a pure model question (`stream.js`/`drc-research.js`). Node-tested (`public/js/ai-models.test.js`) |
| `bash-api.js` | `POST /api/bash/step`: ONE turn of the client-orchestrated bash-lite loop — asks the reliable model (via `bashAgentPrompt`) what to run next given the transcript so far; quota-gated + concurrency-reserved through the shared `endpoint-gate.js`, usage-recorded, knob-gated (`bashLiteEnabled`), fail-soft (any failure returns `done` so the client stops). The sandbox runs in the BROWSER (`public/js/sandbox.js`); the server only decides commands |
| `exec-container.js` | WHERE those commands run when the user picks this platform's own machine: the SERVER-SIDE execution environment (Se/rver only). Exposes the same **DREE/1** wire the local runner speaks — `GET/POST /api/exec/{healthz,exec,mount,source}` + `DELETE /api/exec/session` — and drives ONE ephemeral Cloudflare Container per research session through the `ExecSandbox` Durable Object (re-exported from `index.js`, since a DO must be exported from the entrypoint). No service inside the image and no npm dependency: commands are `bash -lc` processes started with the DO's raw `ctx.container.exec`, bounded by our own deadline (a killed process returns exit 124, the vocabulary the browser VM already uses). Mounts match the CheerpX VM: the page pushes ONE ustar archive of `/workspace` + the project mount, and `/src` (the deploy's own source snapshot, `sdk/` included) is seeded HERE from the `ASSETS` binding — stamp-guarded, so a warm container pays nothing — which keeps the ~11 MB off the browser and makes the tree by construction the source this deploy runs. Availability-gated on the OPTIONAL `EXEC_SANDBOX` binding (declared in `wrangler.toml` since 2026-07-26 and pointing at the pushed image, but no deploy has carried it yet — and an undeclared resource fails every deploy, which is why it shipped commented out until the image existed) plus the account's sandbox knob; absent, `/api/settings` reports `available.exec_container:false` and the client omits the option. Per-session fences (idle destroy, lifetime, command budget) live here; the global one is `max_instances`. Se/rver only by construction — it sits behind the identity gate, and Se/cure has no identity — see `docs/EXECUTION-ENVIRONMENTS.md` |
| `sandbox-image.js` | Self-hosted Linux sandbox images (the admin-selectable small-image feature — `docs/SANDBOX-LOCAL-IMAGE.md`): `GET /sandbox/img/<id>.ext2` (streams a content-addressed, immutable ext2 image from R2 with HTTP Range support for CheerpX's HttpBytesDevice) + `GET /api/sandbox-image` (the effective image config both tiers read) — both PUBLIC, routed before the identity gate because Se/cure must reach them too; fail-soft by construction (no binding / unknown id / R2 miss → the client falls back to the built-in streamed default, invariant 2) |
| `storage.js` | Implicit R2 cloud storage (availability-gated, always on for signed-in accounts — invariant 4): encrypted conversation AND project records (`/api/convos*`, `/api/projects*` — same handler), original attached files (`/api/files*`), the account's one-call data wipe (`DELETE /api/storage` — vault objects excluded) |
| `vault.js` | The secret-keyed project vault (`/api/vault/:id`, R2 `vault/{uid}/{id}`): one CLIENT-encrypted project archive per id — key AND id both derived in the browser from a user-held secret the server never sees (`public/js/vault.js`), the strictest storage tier — the server can neither locate nor read an archive; each store is its own explicit consent act, and vault objects are excluded from the `DELETE /api/storage` wipe |
| — (DRC has no server module) | DRC — "deep research secure", C for CLIENT-side: the public tier at `DeepResearch.Se/cure` (saved projects at `/my/project-<hash>`; `/free*` legacy aliases — all routed BEFORE the identity gate in `index.js`; the root `/` serves the promotional landing to visitors — which links /cure — and 302s signed-in arrivals to /rver). MINIMAL SERVER BY DESIGN: the Worker serves the static page (`public/cure/`) and the public replay JSONs (`pub.js`) and is in no other DRC path — model calls go directly (cross-origin) from the browser to the user's own CORS-capable providers (OpenAI, Anthropic, Groq, Hugging Face, Berget, or any other OpenAI-compatible endpoint — `public/js/drc-providers.js`), the deep-research flow runs client-side (`drc-research.js`), and the sealed project state rests in BROWSER-LOCAL storage (`drc-store.js`). Its remote sibling DRS — "deep research server", R for REMOTE — is the signed-in app at `/rver` (sign-in/terms redirects land there; PWA manifest starts there): everything else in this table |
| `pub.js` | Published research replays — the `DeepResearch.Se/cure/<slug>` ("deep research SECURE <slug>") surface, R2 `pub/{slug}`: frozen deep-research sessions as read-only public pages (`GET /api/pub[/:slug]` public, routed pre-auth; `PUT/DELETE /api/pub/:slug` admin-only), each opened IN PLACE by the DRC app (`/cure/<slug>` seeds a DRC conversation, so continuing on the visitor's own keys is just typing; `/?continue=<slug>` legacy) — see the **publish-research** skill |
| `build-pub.js` | SDK-mode BUILD publications — the live `/app/<slug>/` "try it" surface (R2 `build/{slug}`): `publishBuild` (called from `pipeline.js` `runSdkBuild` — validates/caps the generated files, enforces slug ownership so only the minting user republishes their URL, prunes dropped files) and the PUBLIC serving face `handleBuildGet`, whose every response carries `Content-Security-Policy: sandbox allow-scripts …` — the published page runs in an OPAQUE ORIGIN (no cookies, no credentialed same-origin fetch), so a generated app can never act as the signed-in visitor despite being served from the site's hostname. Admin-only `DELETE /api/build/:slug` unpublishes — see the **sdk-mode** skill. `PUT /api/build/:slug` (`handleBuildManualPublish`, admin-only) is the ONE other write surface: a bypass of the chat/tool loop that calls the same `publishBuild` for a bundle already built elsewhere (the execution sandbox's outbox, a hand-assembled directory) — `scripts/publish-app`, see the **publish-app** skill |
| `app-kit.js` | The APP KIT's server side (feedback #66, 2026-08-10): reads the shipped `public/app-kit/dr-provider-kit.js` through the ASSETS binding (the `src/introspect.js` pattern, cached per binding) and `withAppKit` adds it to a published Agent Studio build. Called from `build-pub.js` `publishBuild` — the single publish choke point, so the tool path, the FILE-block fallback and the admin manual publish all get it on the same terms — and only when `buildNeedsAppKit` sees the build reference it. The kit's path inside a build (`js/dr-provider-kit.js`) is RESERVED: a file the model wrote there is replaced, so a generated app always runs the real kit rather than an approximation of its API. Fail-soft per invariant 2: an unreadable kit publishes the app without it. Node-tested (`build-pub.test.js`) |
| `app-token.js` | HOSTED model access for a published Agent Studio app (capture #CAP-22, 2026-08-12) — the reason a built agent no longer greets its first visitor with "you didn't provide an api key". `ensureAppGrant` mints the app its OWN Se/rver token (`perms: ["api"]` only, `source='app'`, `label='app:<slug>'`, quota `server_token.app_quota`, TTL `app_ttl_hours`) through the existing `server-grants.js` mint — no new crypto, no new meter, no new endpoint — and REUSES it across republishes so one app never accumulates allowances; `renderAppConfig` renders it as the classic one-global script `js/dr-app-config.js` that the app kit reads (`DRKit.hosted`). Called from `build-pub.js` `publishBuild`, the same choke point as the app kit, and only when `buildNeedsHostedLlm` sees the build reference it; the path is RESERVED like the kit's. The embedded token is public by construction and bounded by design — THE SERVER-TOKEN GUARANTEE (upstream completions only, never Se/rver data, never a login), metered, expiring, revocable. Fail-soft per invariant 2: with no D1/secret/budget the config still ships carrying `token: null` and a `reason`, so the app tells its visitor rather than throwing. Node-tested (`app-token.test.js`, plus the publish-boundary half in `build-pub.test.js`) |
| `apps.js` | The published-apps MANAGEMENT surface over the objects `build-pub.js` already writes (`build/<slug>/meta` + `build/<slug>/f/<path>`): `GET /api/apps` (the caller's own apps; admin `?all=1` for every account's; `?q=`, `?sort=`, `?format=text`), `GET|PATCH|DELETE /api/apps/:slug` (one app + its file list; `{title}` rename; unpublish) and `GET|PUT|DELETE /api/apps/:slug/file` (one file's text, by `?path=` on the reads and `{path, content}` on the write). Signed-in, but the per-app gate is OWNERSHIP rather than role — `canManageApp`, checked per app because the route is reachable by every signed-in user: an app belongs to the account that built it, not to the operator. That is why this is a SECOND face rather than a replacement for the admin-only `PUT|DELETE /api/build/:slug`, which `scripts/publish-app` depends on and which are left exactly as they are. There is no CREATE: apps are built in the chat, in Agent Studio, and the page's empty state points there. A file edit REPUBLISHES the whole collection through `publishBuild` — whole-collection by design, since unsent files are pruned — which keeps ONE publish path with one set of caps and one CSP posture, at the cost of an R2 read per file; a RENAME deliberately skips it and rewrites the meta object alone (rewriting every file object to change a title would be pure waste), preserving `createdAt` and stamping the `updatedAt` this surface owns. Façade for the shared pure core `public/js/apps-core.js` — re-exported, not mirrored, so `facade-contract.test.js` pins the identity — which is how the title cap, the sort orders, the diacritic-folding search, the ownership predicate, the two file-edit planners and the `?format=text` rendering cannot mean one thing in the API and another in the UI. Client: `public/apps/index.html` + `public/js/apps.js`; Node-tested against a mocked R2 (`apps.test.js`) — see the **sdk-mode** skill |
| `grant-http.js` | The grant subsystems' shared pure PRESENTATION leaf (imports only `http.js`'s `jsonResponse`): the response fragments `websearch.js` and `proxy.js` must keep in lockstep — `budgetExceeded409`, the `adjustResultResponse` ladder, the `resolveQuotaPatch` set/±/pause clamp arithmetic, the granted-web-search result projections (`emptyWebResultResponse`/`webResultResponse`), `readTokenBody`, the `posInt` positive-int config clamp the defaults resolvers share, and the shared `QUERY_MAX`/`GRANTS_LIST_MAX`/`GRANT_DEPTH` constants. Each subsystem keeps its OWN mint/meter/adjust logic (deliberately different tables and claims); only the pure response/clamp layer lives here. Node-tested |
| `llm-proxy.js` | The shared LLM reverse-proxy FORWARDERS — a pure upstream leaf (imports only `http.js`'s `jsonResponse`) behind BOTH server-touching grant surfaces' `/llm/*` endpoints: `forwardLlmModels` (the thin Berget /models forward) and `forwardLlmCompletion` (one OpenAI-wire completion on the SERVER key — known-fields-only re-serialization, output clamp, the refund-on-failure discipline, SSE pipe-through). The caller owns token verification and the quota reserve. Kept a leaf so `server-grants.js`'s pinned module graph imports it without dragging in the proxy-bundle machinery. Node-tested |
| `websearch-key.js` | The temporary web-search GRANT TOKEN half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of `wsk1.<payload>.<hmac>` tokens (claims: `jti`, `uid`, `quota`, `iat`, `exp`) HMAC-signed with `SESSION_SECRET` under an independent `websearch.` namespace, so a grant token can never be confused with a session/state HMAC — the signed capability that lets an otherwise server-less Se/cure session run bounded web searches (invariant 4's ONE bounded exception). Node-tested |
| `websearch.js` | The web-search grant MINT subsystem + METER (D1 `websearch_grants`, keyed by the token's `jti`; defaults in `config.js`'s `websearch` block): `mintWebSearchGrant` (the shared minter — inserts a row + token, enforces the global `budget` ceiling), `grantWebSearch` (the GHOST path — reuse-the-active-`source='ghost'`-grant-per-user, so per-user Exa exposure is bounded to one quota per TTL window), `grantStatus` (non-consuming read), `adjustGrantQuota` (the secure-workspaces MINTER CONTROL, 2026-07-15: set/±/pause a live grant's quota on the D1 row — the token in circulation never changes; increases budget-checked like a mint, owner-scoped via `user_id`), `revokeGrant` (delete = instant kill). Endpoints: `handleWebSearchGrant` (AUTHED `POST /api/websearch/grant` — ghost crossover), `handleWebSearchAdjust` (AUTHED `POST /api/websearch/adjust` — the minter's self-service quota control over their own grants), `handleWebSearchStatus` (PUBLIC `POST /api/websearch/status` — a `…/cure?ws=<token>` link follower reads remaining), `handleWebSearch` (PUBLIC `POST /api/websearch` — verifies the token, atomically reserves one unit, runs Exa on the server key, refunds an empty/failed search), and `handleAdminWebSearch` (`/api/admin/websearch*` — GET list+defaults, POST mint→shareable link, PATCH /:jti quota adjust, DELETE revoke). Fail-SAFE: no D1 → 503, no unmetered server-paid search possible. Client: `public/cure/drc.js` (grant from the ghost intent marker OR a `?ws=` link + the settings toggle), `public/js/drc-research.js` (the injected `webSearch` fn → citation-aware harvest/synth), and the `/admin` → **Web search grants** panel (`public/js/admin.js`) |
| `proxy-grant.js` | The SECURE-RESEARCH-SPACE two-tier TOKEN half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of the GRANT token `prg1.<payload>.<hmac>` (the bundle's "token-granting token", namespace `proxygrant.`) and the PROXY token `prx1.…` (the post-exchange working credential, namespace `proxytoken.`) — both HMAC-signed with `SESSION_SECRET`, each under its own namespace so the two tiers (and the `wsk1`/session tokens) can never be confused; claims carry `svc` (`web`/`api`). Node-tested |
| `proxy.js` | The SECURE-RESEARCH-SPACE bundle MINT subsystem + per-service METER (D1 `proxy_grants`, one row per service keyed by `jti`, grouped by `bundle_id`; defaults in `config.js`'s `proxy` block — invariant 4's SECOND bounded exception): `mintBundle` (a row + grant token per service, sealed into one encrypted bundle via `public/js/proxy-bundle.js`, global `budget` enforced), `grantBundle` (the GHOST path, reuse-per-user), `exchangeGrant` (grant token → proxy token), `proxyStatus` (non-consuming). Endpoints: AUTHED `POST /api/proxy/grant` (ghost); PUBLIC `POST /api/proxy/exchange`, `POST /api/proxy/status`, `POST /api/proxy/web` (Exa on the server key, reserve/refund), and `/api/proxy/llm/*` (an OpenAI-wire REVERSE PROXY to the server's Berget key — `/models` + a metered `/chat/completions`, so the DRC provider registry drives it unchanged; the `api` grant is the one place a Se/cure conversation reaches the server); ADMIN `/api/admin/proxy*` (GET list+defaults, POST mint→`…/cure?rp=<blob>#rk=<key>` link, PATCH /:jti per-service quota adjust, DELETE revoke a bundle); plus `adjustProxyGrantQuota` + AUTHED `POST /api/proxy/adjust` (the secure-workspaces minter control — same set/±/pause semantics as `websearch.js`'s, per service row). Fail-SAFE (no D1 → 503) and Berget-ONLY. Client: `public/cure/drc.js` (open bundle from URL, exchange, connected-APIs banner + Settings toggle), `public/js/drc-providers.js` `proxyLlmProvider`, and the `/admin` → **Secure research space grants** panel |
| `server-token.js` | The CONSOLIDATED **Se/rver TOKEN**'s JWT half (near-leaf: imports only the `token-crypto.js` primitives) — "one ticket, one JWT" (2026-07-16 directive): mint/verify of a STANDARD HS256 JWT whose claims bundle the grant families' properties — a `perms` permission SET over the site's UPSTREAM APIs only (`web`/`api`, the CLOSED `SERVER_TOKEN_SERVICES` vocabulary), one `exp` duration for the whole grant, `jti` keying the D1 meter rows, `sub` accountability. Carries THE SERVER-TOKEN GUARANTEE (load-bearing): a Se/rver token grants upstream API access ONLY — NEVER any of Se/rver's own data (no project contents, no chat contents, no history, no accounts) — the name itself the reminder that using one sends data to a server somewhere. Family separation from `wsk1`/`prg1`/`prx1`/session HMACs under the one `SESSION_SECRET` is structural (canonical-header pinning kills alg:none/alg-swap; signing-input formats and signature encodings can't collide) and test-pinned. Node-tested; see `docs/SERVER-TOKENS.md` |
| `server-grants.js` | The Se/rver-token MINT subsystem + per-PERMISSION METER (D1 `server_tokens`, one row per (jti, service) so each permission's quota is administered independently while the ONE JWT in circulation never changes; defaults in `config.js`'s `server_token` block): `mintServerTokenGrant` (one row per permission + one JWT, global `budget` enforced), `grantServerToken` (the GHOST path, reuse-per-user), `serverTokenStatus` (non-consuming), `adjustServerTokenQuota` (the minter control, per permission), `revokeServerToken` (delete all rows = instant kill). Endpoints: AUTHED `POST /api/server-token/grant` + `/adjust`; PUBLIC `POST /api/server-token/status`, `POST /api/server-token/web` (query-only Exa, atomic reserve/refund), `/api/server-token/llm/*` (OpenAI-wire Berget reverse proxy, the JWT as bearer — reuses the shared `llm-proxy.js` forwarders); ADMIN `/api/admin/server-token*` (GET list grouped by jti, POST mint→`…/cure?st=<jwt>` link, PATCH /:jti/:svc adjust, DELETE /:jti revoke). Fail-SAFE (no D1 → 503); the legacy families stay unchanged. Its module graph must NEVER include a data-bearing module (storage/vault/chatlog/accounts/rag/pub…) — pinned by a unit test (THE GUARANTEE, enforced structurally). Client: `public/cure/drc.js` (the `?st=` link reader + the GHOST crossover, which asks for the consolidated token FIRST with legacy fallback; web-search spend first in priority; the `serverTokenLlmProvider` model-dropdown entry; the connected banner + Settings row) over the pure `serverTokenService`/`serverTokenLive` (`drc-page-core.js`) and `serverTokenLlmProvider` (`drc-providers.js`); admin panel: `/admin` → **Se/rver tokens** (`public/js/admin.js`, panels-board id `server_tokens`) |
| `pool-token.js` | The COMPUTE-SHARING pool-token half (near-leaf: imports only the `token-crypto.js` primitives): mint/verify of `pt1.<payload>.<hmac>` tokens (claims: `jti`, `pool`, `sub`, `iat`, `exp`) HMAC-signed with `SESSION_SECRET` under an independent `pool.` namespace, so a pool token can never be confused with another family. Carries THE POOL-TOKEN GUARANTEE: it authorizes ONLY submitting completion jobs to the ONE pool it names, is never a login, and unlocks no Se/rver data — its one disclosed difference from a Se/rver token is that the prompt is read by the pool owner's machine. Node-tested; see `docs/COMPUTE-SHARING.md` |
| `pool.js` | The COMPUTE-SHARING BROKER + per-token METER (D1 `pool_providers`/`pool_jobs`/`pool_consumers`/`pool_tokens`; defaults in `config.js`'s `pool` block): a signed-in sharer lends their local OpenAI-compatible model, the server parks a consumer's completion in a D1 job queue, the sharer's browser pulls/runs/returns it (HTTP long-poll, NO Durable Objects/WebSockets — no new infra). One pool per sharer account. `registerProvider`/`heartbeatProvider`/`claimJob`/`requeueStaleJobs` (the queue), `reservePoolUnit`/`refundPoolUnit` (0 = uncapped "any number of requests"), `bumpConsumer`/`setConsumerState` (the dashboard aggregate + block list = "remove user"), MUTUAL CONSENT — `ingressState`/`touchIngressRequest`/`setIngressDecision` (the sharer's half, `pool_consumers.state` pending|allowed|blocked) and `egressState`/`touchEgressRequest`/`setEgressDecision`/`listEgress` (the consumer's half, D1 `pool_egress`), `poolOwnerIdentity`/`consumerView` (each side's PLATFORM-VERIFIED identity, resolved from a session by the router — never from the request), `listPool` (oversight), `mintPoolTokenGrant`/`adjustPoolTokenQuota`/`revokePoolToken`. Endpoints: AUTHED provider `POST /api/pool/register`+`/poll`+`/result`+`/unregister` and sharer `GET /api/pool`+`POST /api/pool/{token,adjust,block,ingress,revoke}`; PUBLIC consumer `POST /api/pool/status`, `POST /api/pool/peer` (the one mutual-consent answer both clients render their question from — asking it parks the question on the sharer's board) + `POST /api/pool/egress` (the consumer's answer, token- OR session-authorized), `/api/pool/llm/*` (OpenAI-wire — a job parked + waited on, `stream:false` in v1, every body forced through the strict DRSC/1 whitelist `sanitizePoolRequest` from the shared pure core `public/js/pool-core.js`); ADMIN `/api/admin/pool*`. Fail-SAFE (no D1 → 503). Its module graph must NEVER include a data-bearing module — pinned by a unit test (THE POOL-TOKEN GUARANTEE). Client: `public/js/pool-provider.js` (the sharer loop), `poolLlmProvider` (`drc-providers.js`, `whole:true` — the relay answers un-streamed and the client adapts), the `?pt=` / workspace `grants.pool` intake + rows + the `#poolconsent` egress pane in `public/cure/drc.js`, and the Se/rver "LLM sharing" screen `public/js/account-pool.js` (one level below Settings — BOTH halves of consent AND the sharer's own local-server URL + "Share my compute" toggle, resumed at app boot by `resumePoolSharing`: lending is not a Se/cure-only feature, feedback #31). A relayed prompt is refused BEFORE it is parsed, parked or metered unless BOTH halves say allowed. See `docs/COMPUTE-SHARING.md` |
| `knowledge.js` | WORKSPACE KNOWLEDGE's server half (D1 `knowledge_agent` + `knowledge_inbox`): the sealed-conclusions INBOX behind Se/cure's 👍-curation (pure core `public/js/knowledge-core.js`). Self-provisioning import-agent ECDH keypair (`ensureKnowledgeAgent`, generated once into D1 — the server CAN decrypt, deliberately: the owner asked for "sealed to the server agent"; envelopes rest as ciphertext, plaintext exists only in the moment the OWNER imports, nothing about a conclusion is logged). Endpoints: PUBLIC `GET /api/knowledge/key` (the public half) + `POST /api/knowledge/submit` (Bearer = a pt1 POOL token — the workspace's compute capability also routes its conclusions; revocation-aware, blocked-consumer-aware, backlog-capped); AUTHED owner `GET /api/knowledge` (metadata only) + `POST /api/knowledge/import` (decrypt one, mark imported) + `POST /api/knowledge/open` (an uploaded `.drskn` blob — refuses unless the bundle's `owner` IS the caller) + `DELETE /:id`. Module graph pinned inbox-only by test. Owner UI: `public/js/account-knowledge.js`. See `docs/COMPUTE-SHARING.md` §9b |
| `rag.js` | Document RAG: `POST /api/embed` (Berget embedding proxy, used in BOTH storage modes) + `/api/rag/*` (Vectorize index/query, R2 export copies) |
| `answers.js` | `/api/chat/answer`: TTL'd (15 min) answer recovery cache for dropped connections — ack-purged on intact delivery. Since 2026-08-14 the parked row also carries the run's RESEARCH TRAIL (`trail_json` — the `step_start`/`step_done`/`search_start`/`search_done` events, captured off chat.js's one `emit` funnel and capped at 400). Without it a recovered run came back as bare prose with its whole trail missing, which is what feedback #67 reported ("i cannot explorre the research steps taken here in the response as i used to") after a 244-second run from a phone. Additive and fail-soft on both sides: a row predating the column, or a corrupt value, projects as no trail rather than a failed recovery |
| `chatlog.js` | Full-visibility chat interaction log (D1 `chat_logs`): complete Q&A + research metadata per exchange (chat AND mcp channels), skipped for incognito; `/api/admin/chatlogs*` read API built for the agentic debugging workflow — see the **chat-logs** skill + `scripts/chatlogs`. Also the home of the shared pure log helpers `truncateForLog`/`likePattern`/`cleanStr` (the last two imported by the `testpoints.js`/`feedback.js` board validators) |
| `feedback.js` | The feedback pipeline (D1 `feedback` + `feedback_messages` + `feedback_images`): user feedback as dialogue threads with the development agent. `feedbackIntent` (EN+SV, anchored at message start) — since 2026-07-26 joined by the `/feedback` slash command, both behind `feedbackRequested`, with `feedbackComment` stripping the command token so the queue shows the user's words — and the CANNED acknowledgments (`cannedFeedbackAck` — feedback never runs through an LLM, owner directive 2026-07-24) are re-exported from the ONE shared pure core `public/js/feedback-core.js` (so Se/rver and Se/cure can't diverge on the gate); a message opening with "feedback" is routed by `src/pipeline.js` (`runFeedbackCapture`) and recorded via `createFeedbackEntry` (called from `chat.js`), which ALSO tags the `chat_logs` row (`meta.feedback`) so discovery is double (structured queue + chatlogs scan). Also re-exported from that core: the SCOPE classification (`feedbackScope`/`feedbackScopeOfPrior` — a "feedback …" message that is the FIRST message of a conversation is GENERIC developer feedback, a suggestion or next-steps note, not a report about a session; owner directive 2026-07-24), its `page` tagging (`feedbackPageTag` → `chat/standalone`, `se/cure/standalone`; read back by `isStandalonePage` into the projection's `standalone` flag and the `SCOPE:` line of the text rendering) and the canned-ack variant set the classification selects. TWO further scopes ride the same tag grammar: `strategy` (a note from the outrospection feed — direction, not a defect) and `doc` (owner directive 2026-07-25 — a passage comment from the `/docs` reader's comment mode, tagged `docs:<path>/doc` by `docPageTag`, read back by `isDocPage`/`docPathOfPage` into the projection's `doc`/`doc_path` and a `SCOPE: doc` block that states the doc⇄code CONTRACT: reconcile the documentation AND the implementation it describes, in the same change). `GET /api/feedback?page=<tag>` narrows the user list to one surface (the doc reader's per-document margin), marking read only what it returns. Every entry carries the user's exact text plus the ENTIRE conversation + request metadata (`context` column, `buildFeedbackDebugContext`, oldest-turns-trimmed cap; refreshed on threaded follow-ups; full text on the admin single-entry read, size-only on lists). Surfaces: user CRUD (`/api/feedback*`) + the agent/operator queue (`/api/admin/feedback*`, chatlogs-style, `?format=text`) — incl. optional SCREENSHOT attachments on entries and replies (client-downscaled data URLs, one D1 row each, metadata-only in projections, served back as real images via `…/:id/images/:imgId`; `scripts/feedback --image` downloads one). ALSO `handleServerTokenFeedback` (`POST /api/server-token/feedback`) — the SERVER-TOKEN GUARANTEE's THIRD bounded, WRITE-ONLY exception (owner directive, 2026-07-24): a DeepResearch/Se/rver token may create ONE feedback row (Se/cure's confirmed "feedback" path, attributed to the token's `sub`) but can never read it back; verified with the pure `verifyServerToken` leaf, kept OUT of `server-grants.js` so that module's graph stays upstream-only. ALSO re-exported from the core: `feedbackForcesServerRoute` — the gate decides not only what the PIPELINE does with a message but which ROUTE may claim it. The Se/rver tier has two browser-direct send routes that never call `/api/chat` (an `ondevice::` model pick, introspection's private own-key route); both used to swallow a report into the local model with no entry created (feedback #23, 2026-07-25), so `public/js/stream.js` `sendMessage` now consults this ABOVE every route decision and strips the `ondevice::` id (not in the server catalog) from the forced server send. Client: `public/cure/drc.js` (feedbackIntent → confirm dialog `#fbconsent` → POST — Se/cure's gate was always FIRST in `send`, before provider routing, so it never had the routing hole). See the **feedback-loop** skill + `scripts/feedback` |
| `server-errors.js` | The server-ERROR fix queue (D1 `server_errors`): every uncaught top-level exception caught by `index.js`'s `fetch` catch (the `{ error: "Internal server error.", request_id }` 500) is ALSO recorded here via `recordServerError` (fail-soft, off the hot path on `ctx.waitUntil`) — DEDUPED per distinct bug by a stable `signature` (method + normalized path + normalized message), so a recurring crash bumps one row's `count`/`last_seen_at` instead of flooding. A dynamic-queue board (the `feedback.js`/`chatlog.js` family, not a code catalog), status lifecycle `open → fixed | ignored` — a `fixed` row that recurs REOPENS (regression signal). Carries no user content (method/path/message/stack/request-id only). Agent/operator surface `/api/admin/errors*` (`?format=text` = the fix loop's input) + `scripts/errors`; registered in the `admin-boards.js` discovery index so `scripts/boards` surfaces it — see the **live-verify** skill. SECOND row source (2026-07-26): `recordSubsystemFailure` files the failures invariant 2 makes helper phases SWALLOW, under a `/_subsystem/<subsystem>/<op>/<class>` pseudo-path that can never collide with a real route, tagged with one of the closed `FAILURE_CLASSES` (`classifyFailure`: timeout / abort / oversized / quota / upstream / throw). Same content-free posture — closed-vocabulary tokens only, never a model-invented agent id, which belongs in the incognito-gated chat log |
| `board.js` | The decision-board CORE — the one shared mechanism behind every admin panel whose choices feed an agent loop (see the **decision-boards** skill): choice-state validation (votes/score/note/priority), the priority-vs-rank orderings (admin priority = the loop's fixed work order), `reviewState`, the `*_reviews` D1 upsert helpers, and `projectedBoardItem` (the single-item re-projection every board's vote/patch endpoint answers with) — a new board implements none of this itself. THREE consumers today: the two backlog priority boards `security-risks.js` and `features.js`, plus `panels.js` — the ATTENTION board, a votes-only variant (same core, `"priority"` ordering with no priorities ever set → pure votes-desc) |
| `security-risks.js` | The security-risk review board (D1 `security_reviews`) — the reference `board.js` consumer (façade-style: its pure surface re-exports the core): a code CATALOG mirroring `SECURITY-RISKS.md` §3 (same P-ids, same order — any register edit updates it in the same commit) + the admin's votes/manual score/note and the explicit per-item PRIORITY that is the security-fix loop's fixed work order (`/api/admin/security*`, `?format=text` = the loop's input; `scripts/security`) — see the **security-posture** skill |
| `features.js` | The features/priority review board (D1 `features_reviews`) — the SECOND loop channel next to security (façade over `board.js`): a code CATALOG mirroring `FEATURES.md` §3 (same F-ids, same order, same mirror-in-one-commit discipline) + the admin's votes/EFFORT (the shared "score" field, relabelled)/note and the explicit PRIORITY that is the feature-build loop's fixed work order (`/api/admin/features*`, `?format=text` = the build loop's input; `scripts/features`; impact rank instead of severity, build order instead of fix order) — see the **feature-board** skill and `docs/DECISION-BOARD-LOOPS.md` |
| `panels.js` | The panel-SELECTION board (D1 `panels_reviews`) — a THIRD `board.js` consumer but a different KIND of loop (the ATTENTION loop, not a backlog). Its catalog items ARE the admin panels themselves; it has NO board widget — each panel header on `/admin` carries ▲/▼ thumbs and voting reshapes the admin view in place (up floats to top, net-negative collapses + sinks). Reshapes PURELY on votes: no drag, no explicit priority (reuses the core's `"priority"` ordering with none ever set → votes-desc). The votes-driven focus order (`/api/admin/panels*`, `?format=text` = the attention loop's input; `scripts/panels`) tells a Claude Code session which admin surface the owner is working on now — read it, then read that surface's own board. See the **feature-board** skill §6 |
| `testpoints.js` | The testable-interaction-points queue (D1 `test_points`): declared, linkable "try-it" points — each a `label` + a "what was fixed" `summary` + a same-origin `target` path + an ordered list of client ACTIONS (the deep-link reachability grammar: open a panel/settings-knob, prefill the composer, flip search, set the budget, pick a model, highlight an element) — plus the 👍/👎/❓ verdict (pass / fail / untestable–needs-clarification; the ❓ opens a tester↔loop DIALOGUE THREAD on the point — D1 `test_point_messages`, verdict notes land as tester messages, the loop answers via `…/:id/messages` / `scripts/testpoints --reply` and re-opens the point). Pure core (validation/projection/`?format=text`/`deepLink`) + `handleAdminTestpoints` (CRUD + result + thread, admin-gated, `/api/admin/testpoints*`) + `handleTryRedirect` (the `/try/:id` deep link → 302 to `<target>?try=<id>`, home-on-miss). The banner + queue UI live in `public/js/testpoints.js` over the pure `public/js/testpoints-core.js`; `scripts/testpoints` is the producer/reader CLI. Each point is also a numbered **use case**: `useCaseTag` gives it a stable `#UC-<id>` tag (on the projection as `.tag`, prepended to `compose` starter prompts client-side); `parseUseCaseRef` (EN+SV) reads it back off a `feedback #UC-<id> …` chat message (both defined once in `public/js/testpoints-core.js`, re-exported here — the `agent-spec.js` façade pattern; the ACTION GRAMMAR itself is single-sourced the same way, `CLIENT_ACTION_TYPES` re-exported here as `ACTION_TYPES`, so the validator and the client executor cannot list different actions) and `recordUseCaseFeedback` posts the note onto that point's thread (admin-gated, from `chat.js`) — see the **testable-interaction-points** skill |
| `captures.js` | The VIDEO-CAPTURE review feed (D1 `captures` + `capture_reviews`, R2 `captures/<id>/`): one row per finished clip of the site answering — recorded by `tests/capture.mjs` (one agent × one model × one shipped example prompt) and cut down by `scripts/capture-edit.mjs` — carrying what was recorded (slug/agent/mode/model/prompt/starter/lang), what the EDIT did (shape, `duration_ms` the clip vs `source_ms` the real run, `cut_ms`, `speed`, `wait_mode`, dimensions, `size_bytes`) so a review can judge the edit and not just the footage, and the verdict (`status` new→liked/needs_work/archived, `likes`), plus `chat_json`, THE RUN ITSELF — the conversation the recording shows, read off the page by the driver — which is what makes a clip link back to a chat the viewer can continue (`GET /:id/chat`, `GET /chats`, `/?capture=<id>` → `public/js/capture-chat.js`). Pure core (the validators, `projectCapture`, `formatCapturesText` for `?format=text`, and `parseRange`) + `handleAdminCaptures` (`/api/admin/captures*`: list/`queue=1` queue, create, PATCH/DELETE, `PUT|GET /:id/video` and `/:id/poster` over R2 with REAL HTTP Range on the video — a card scrubs a `<video>`, and a stream without Range plays but cannot seek — `GET /chats` the drawer's naming-columns-only list and `GET /:id/chat` the reopenable conversation — always 200, `resumable` saying whether a transcript exists, because "this clip is older" and "this clip is gone" must not look the same, `POST /:id/review`, THE SWIPE: 👍 `like` or ✍️ `feedback`, the latter REQUIRING a note, because a left swipe with no words is a shrug rather than a review, and `DELETE /:id/review`, ITS UNDO: the last review row is deleted, a like is un-counted and the status reverts to the verdict before it — `answered_at`, set once everywhere else, clears only when no verdict is left). Bytes and metadata split for the same reason as `storage.js` (R2 has no meaningful object-size limit, D1 rows cap at 2 MB); the row is created BEFORE the upload, so a failed upload leaves a visible incomplete clip rather than an orphaned object. Without the R2 binding the four byte endpoints 503 and the metadata board keeps working. Feed UI: `public/js/captures.js` over the pure `public/js/captures-core.js`; CLI `scripts/captures`; the `needs_work` notes are the re-shoot loop's work order — see the **video-capture** skill and `docs/VIDEO-CAPTURE.md` |
| `starters.js` | The STARTER-PROMPT server FAÇADE: a pure re-export of the ONE shared core `public/js/starters-core.js` plus the registry `public/js/starters-data.js` (the `agent-spec.js` façade pattern) — the per-agent queue of opening questions offered on an empty chat (4 shown at a time, ≥20 deep), the exploit/explore selection + rotation (`selectStarters`/`nextCursor`), the local-only pick signal (`recordStarterUse`/`starterStanding`), the evaluation layer (`starterScore` over capability/firstImpression/quality with the `deadEnd` cap, `rankStarters`, `shortlistFor`, `starterJudgePrompt`/`parseJudgeReply`), the `#XP-<nn>` identity layer (`starterTag`/`parseStarterRef`/`stripStarterRef`/`tagStarterText`/`starterByXp`, plus the conversation-level `starterRefOf`/`withoutStarterTags` that `src/conversation.js` re-exports and Se/cure's browser pipeline imports directly) and the registry validator (`validateStarters` — depth, EN/SV parity per invariant 6, aspect spread, unique `xp` numbers across queues AND candidates, and "no `rank` without `evidence`" per invariant 5). Consumed by both tiers' empty state via `public/js/starters.js`, by `scripts/starters` and by the live battery `tests/starter-eval.mjs` (ledger `tests/STARTER-EVAL-FINDINGS.md`) — see the **starter-prompts** skill |
| `admin-api.js` | `/api/admin/*`: overview, users (incl. `POST /users` — add a pre-approved account before its owner's first sign-in), config, chatlogs, feedback, security, features, panels, testpoints, errors, boards, and `user-cost` (one user's spend attribution — per-window LLM-vs-search totals + the per-model breakdown; `scripts/user-cost` is its CLI) |
| `admin-boards.js` | The admin-BOARDS discovery index (`GET /api/admin/boards`, `scripts/boards`): one pure static registry (`ADMIN_BOARDS`) of every Claude-fetchable admin list (security, features, panels, feedback, errors, chatlogs) — id/purpose/api/`text_query`/orderings/`order_help`/script/skill — with a `?format=text` render that prints each board's exact fetch line. The one-call "pop up every board and act on the admin's priority order" entry point; no D1, no secrets (see the **decision-boards** skill) |
| `chat.js` | `/api/chat` handler: validation, model resolution, quota gate, per-user in-flight concurrency reservation (`reserveInflight`/`releaseInflight`, P-3), state, SSE scaffold, usage recording (the split-billing totals — `summarizeSpend`/`exaCost`/`denseSpend` now live in the shared `billing.js`, re-exported here; the search wave's hosted-retrieval spend is added into the SAME single `usage_events` row rather than a second one) |
| `mcp.js` | `POST /mcp`: exposes the deep-research pipeline AS an MCP server — the `deep_research` tool (which since 2026-08-15 takes an `agent` and a voice `style`), the four `literature_*` corpus tools, the two ChatGPT adapters, the three PLATFORM introspection tools from `platform-tools.js`, and the three EXTENSION tools from `extension-tools.js`, callable by any MCP client (Claude Code, Cursor, a voice client). Hand-rolled Streamable HTTP / JSON-RPC 2.0 — no dependency — serving TWO protocol revisions side by side: the handshake era (`initialize`, `tools/list`, `tools/call`, the `notifications/initialized` ack) and the stateless `2026-07-28` era (`server/discover`, per-request `_meta`, mirrored headers, `resultType`) via `mcp-modern.js`. Two ways in: AFTER the identity gate (session / break-glass) and, for external clients, an MCP key resolved above it (`mcp-api.js`). `tools/list` is filtered and `tools/call` enforced by the account's exposure config (`mcp-config.js`), and the research tool's arguments are reconciled against its defaults. Pure protocol helpers are exported at the top for `mcp.test.js`; the heavy pipeline import is DYNAMIC inside `tools/call`, and it shares `resolveJsonModel` (`model-routing.js`) and the split-billing spend math (`billing.js`) with `chat.js`. Spend is bounded twice, on the `SPENDING_TOOL_NAMES` set only (`deep_research`, `literature_search`, `literature_similar`, `search`, `explain_internals`, `improvement_areas`, plus the three extension tools — `platform_map` is outside it, reading committed artifacts of this same deploy): the four-window `researchQuotaBlock`, and — since 2026-08-05, closing P-3's `/mcp` gap — `quota.js`'s concurrency reservation, taken per request id and released in a `finally`, refusing as a JSON-RPC `isError` result rather than an HTTP 429 (`mcp-inflight.test.js`). Since 2026-08-13 a `tools/call` from a client that accepts `text/event-stream` is answered ON one: keepalive comments plus `notifications/progress` (only when the caller supplied a `progressToken`, carrying the pipeline's current phase label and elapsed seconds) while the tool runs, then the same JSON-RPC response as the last frame. A transport wrapper only — the dispatch, the envelopes and the results are untouched, and a client that did not ask for a stream keeps the buffered JSON. It exists because a research call that sends nothing for 50–90 s reads to a connector as a hung server (`mcp-progress.test.js`) |
| `mcp-key.js` | The MCP KEY token family (`mck1.<payload>.<hex sig>`, namespace `mcpkey.`, HS256 over `SESSION_SECRET`, 1-year TTL): the bearer credential an external MCP client carries, since it has no cookie jar. Mint/verify/`bearerToken`/`keyHint` only — a leaf (imports `token-crypto.js`), so `mcp.js` can import the config seam without breaking its keep-the-pipeline-out-of-the-test rule. SCOPE, pinned by `mcp-key.test.js`: it is never a login (`identify()` rejects it in every position — Bearer, Basic, cookie), it is verified in exactly one place (`mcp-api.js`, consulted by the router for the MCP endpoint alone), and it is revocable by rewriting the account's stored `jti`. Deliberately NOT the Se/rver token — that family's guarantee exists to protect Se/cure; this one acts for a Se/rver account inside the trust boundary |
| `memory.js` | ACCOUNT MEMORY (`docs/ACCOUNT-MEMORY.md`): the durable, linked note graph an account builds across conversations, stored in the shape Obsidian uses so the export is a layout rather than a conversion. Owns the `memory_notes` D1 access (`listMemoryNotes`, `saveMemoryNotes` — the accumulate-don't-overwrite upsert plus least-recently-touched eviction, `clearMemoryNotes`), the three endpoints (`GET /api/memory`, `GET /api/memory/export` → an Obsidian-ready .zip, `DELETE /api/memory`), and `runMemoryExtraction` — the fail-soft tail `chat.js` runs after a turn has streamed (one JSON call on the fixed `DEFAULT_MODEL`, no tools: invariants 1, 2 and 3 all hold). Se/rver-tier only and account-scoped: every path refuses an identity without a user row, which is also what keeps a Se/rver TOKEN out. The note model, Obsidian serialization and extraction prompt are the pure core `public/js/memory-core.js`; the archive is written by the pure `public/js/zip-core.js` |
| `mcp-config.js` | WHAT the MCP server exposes, per account — PURE (its two imports, `extension-tools.js` and `platform-tools.js`, are themselves pure): the exposable-tool `MCP_TOOL_CATALOG` (which mirrors `mcp.js`'s served tool list exactly; `mcp-config.test.js` fails the build when they drift), `parseMcpConfig` over `users.settings_json.mcp`, `toolExposed`/`filterMcpTools`, `resolveResearchArgs` (the account's defaults + override policy applied to one `deep_research` call), the `normalizeConfigPatch`/`applyConfigPatch` pair the PUT handler validates through, and the endpoint predicates `isMcpHost`/`isMcpEndpoint` (POST `/mcp` anywhere, plus the bare origin on the `mcp.` host) that both sides of the identity gate share. Since 2026-08-15 `resolveResearchArgs` also carries the `agent` and `style` arguments, and lowers the DEFAULT budget for `style: "voice"` (a spoken exchange dies waiting where a chat window merely spins). Since 2026-08-16 it has a sibling, `resolveIntrospectArgs`, for the platform tools: the same budget window and model-override policy, with the introspection agent and `web_search: false` FORCED (neither could widen anything, and offering them could only produce a worse answer) and `style` defaulting to voice instead of text |
| `mcp-modern.js` | The STATELESS MCP revision (protocol `2026-07-28`), served beside the handshake one — PURE, imports nothing. The supported-version list, the reserved `io.modelcontextprotocol/*` `_meta` keys, the MCP error codes `-32020`/`-32021`/`-32022`, per-request era detection (`isModernRequest` — an `initialize` always selects legacy), `validateModernRequest` (required `_meta`, a version we implement, and the three mirrored headers agreeing with the body, each with the code AND HTTP status the spec assigns it), `completeResult`/`discoverResult`, and `forbiddenOrigin` — the transport's Origin rule, narrowed to the one case it protects here: a cookie-authenticated cross-site POST. `mcp-modern.test.js`, `mcp-era.test.js` |
| `platform-tools.js` | The PLATFORM introspection family's PURE half — the three tools that ask this server about ITSELF, added 2026-08-16 for the voice surface. Imports NOTHING, so `mcp-config.js` takes its catalog rows without pulling anything into the config layer. `explain_internals` (how a part of this platform works) and `improvement_areas` (where it has room to improve) run the SAME pipeline `deep_research` runs with the introspection agent forced, differing only in the LENS note appended to the question — which also steers RETRIEVAL, since the enrichment embeds the user turn the note is part of. `platform_map` is the free orientation tool. The capability was already reachable (`deep_research` takes `agent: "introspection"`); what was missing was the ROUTING — a caller with no screen asks how the pipeline works, the client's model picks `deep_research` with no agent, and Deep Science answers about deep research as a FIELD, fluently and about somebody else. A tool NAME is what a model routes on reliably. Both answering tools default to `style: "voice"` where `deep_research` defaults to `text`, deliberately. The improvement lens carries the repository's own convention that settled negatives are recorded on purpose, so an answer separates an open lever from an experiment already run and rejected rather than sending someone to redo finished work |
| `platform-tools-run.js` | The same family's RUNNER, behind `mcp.js`'s dynamic import (the `literature-tools.js` ⇄ `literature-run.js` split). Only `platform_map` runs here — the two answering tools need no runner, because they ARE `runDeepResearch` with forced arguments, and giving them one would mean a second copy of the quota gate, the billing, the progress plumbing and the `chat_logs` write. It reads the committed source snapshot and docs corpus through `ASSETS` (so the map describes the code this deploy is actually running, by construction), derives the top-level areas from paths that EXIST rather than a curated list that would go stale silently, and matches a caller's `area` against the skills catalog with a name hit outranking a summary hit. Speaks its answer: no markdown, counts agreeing with their nouns, slugs said as words, list items joined with "with" rather than a second comma. A miss says the platform may still have the thing — an unexplained empty reads to a client's model as "this platform does not have that", which is the failure that ends a session |
| `extension-tools.js` | The MCP TOOL SEAM of the extension registry — PURE, importing only the two schema modules. One entry per integration: its tool definitions, its Settings catalog rows, which of its tools spend, and the `extension` id that ties each tool to the per-account knob. Separate from `extensions.js` (which is not pure) so `mcp-config.js` can import it; the rule it carries is that `mcp.js` names no third-party service. `extension-tools.test.js` |
| `extension-tools-run.js` | The extension tools' RUNNERS — everything they do that touches a network, a model or a binding, behind `mcp.js`'s dynamic import (the `literature-tools.js` ⇄ `literature-run.js` split, same reasons). Resolves a standpoint from arguments alone (a place, a coordinate, or a prior `view` handle), walks and turns with `movePoint`, snaps to the nearest panorama, hands ONE frame to the vision helper (`describeStreetView`) and returns its words, and bills the vision tokens in a `finally` |
| `maps-tools.js` | The street-imagery tools' PURE half: the `street_view_look`/`place_nearby` schemas, the EN+SV direction vocabulary (compass words, relative turns, tilts — token-matched rather than regex-matched, which sidesteps the `\b` trap that kills Swedish gates), the `view` handle codec, and the spoken renderers. `maps-tools.test.js` |
| `shodan-tools.js` | The host-intelligence tool's PURE half: the `host_intel` schema, target parsing (an array or a string, URLs stripped to their host, capped), and the spoken renderers — which keep "no record" and "no open ports" distinct. `shodan-tools.test.js` |
| `voice-answer.js` | Shaping an answer for someone who will HEAR it — PURE. `VOICE_NOTE` (appended to the question, so the MODEL writes prose) plus `spokenText`/`spokenSources` (run over the finished text, because a prompt is a request). Every rule is a REMOVAL of something a speech engine pronounces as itself; nothing paraphrases or reorders. `voice-answer.test.js` |
| `mcp-api.js` | The MCP CONTROL surface: `resolveMcpKeyIdentity` (bearer → identity + config, with distinct outcomes for "no key" / "key refused" so a revoked key gets a JSON-RPC error rather than a sign-in page), `mcpEndpointUrl` (the `mcp.` host's BARE ORIGIN in production — the advertised form since 2026-08-03, no `/mcp` tail; any other plain https host is told about its own `mcp.` subdomain, and a `.workers.dev` preview or a local run gets its origin plus `/mcp`, where the bare origin is the app and not the endpoint), and the four handlers behind the identity gate: `GET`/`PUT /api/mcp/config` and `POST`/`DELETE /api/mcp/key`. Config is stored through `settings.js`'s `mergeStoredSettings`, so an MCP write and a knob write never clobber each other's half of the column; the key's token is returned once at mint and never stored (only its `jti` + a six-character hint) |
| `oauth-metadata.js` | The OAuth DISCOVERY documents and the redirect allowlist — the pure leaf (imports nothing) of the connector authorization server that lets the MCP surface be added as a custom connector in Claude and ChatGPT (`docs/MCP-CONNECTOR.md`, F-20). Owns `protectedResourceMetadata` (RFC 9728, served by the MCP host; its `resource` must equal the URL the user typed, which is why exactly one canonical endpoint form is advertised) and `authorizationServerMetadata` (RFC 8414, served by the apex; advertises `client_id_metadata_document_supported` + `"none"` + S256 so a capable client picks CIMD, AND a `registration_endpoint` so one that cannot has somewhere to go — advertising CIMD alone is what made ChatGPT unable to connect at all), `wwwAuthenticateValue`/`resourceMetadataUrl` (the `401` pointer that starts the flow), the `REDIRECT_ALLOWLIST` + `redirectAllowed`/`isLoopbackRedirect`/`isChatgptConnectorRedirect` (exact match for the hosted clients, RFC 8252 port-agnostic loopback for Claude Code, and a bounded SHAPE match for ChatGPT's PER-CONNECTOR callback `…/connector/oauth/<id>`, which no exact string can cover — a LIST so a third client is data, not code), and `issuerFor`, the one function encoding the host split (`mcp.` host → apex; any other origin issues to itself, so the whole flow is exercisable on one host) |
| `oauth-store.js` | The connector's THREE token families and the records that govern them: the authorization code `oac1.` (60 s), the access token `oat1.` (1 h) and the refresh token `ort1.` (90 d), each HS256 over `SESSION_SECRET` under its own `token-crypto.js` namespace so no family can be forged from another. Codes and refresh tokens are signed AND carry a D1 row keyed by `jti`, because a signature cannot express single use or revocation (the same "token fixed, the record governs" split `mck1.` and the grant families use); access tokens are signed ONLY — no row, no lookup on the hot path, revocation by refusing the refresh. `redeemAuthCode` enforces signature, expiry, single use, `client_id`, `redirect_uri` and PKCE S256 in one call and answers RFC 6749 codes; `rotateRefreshToken` kills the old `jti` in the SAME call that mints the new one, so a public client's mandatory rotation cannot half-happen. Exports its own DDL as `OAUTH_SCHEMA_SQL`, which `db.js` carries as a PASTED copy (importing it back would be a cycle — this module imports `getDb`); `oauth-store.test.js` compares the two copies statement for statement in both directions, because nothing else would notice them diverging |
| `oauth-register.js` | `POST /oauth/register` — RFC 7591 DYNAMIC CLIENT REGISTRATION, the fallback `oauth-metadata.js` described from the start and did not build. Its absence was a root cause of the 2026-08-05 ChatGPT failure: a client that does not implement CIMD had nowhere to obtain a `client_id`, so the flow died at discovery with nothing to read. NOTHING ACCUMULATES PER CONNECTION — the property CIMD was chosen for is kept by issuing a SIGNED STATELESS identifier (`orc1.`, its own `oauthclient.` HMAC namespace) that CARRIES its own registration, so there is still no client table and no cleanup; `resolveRegisteredClient` verifies it on the way back and `looksRegistered` is what lets `oauth-authorize.js` tell a registration from a CIMD URL before fetching anything. A registration CANNOT WIDEN where a code may be sent: every `redirect_uris` entry is checked against the same `redirectAllowed` at registration and again at use, and a refusal is logged (`oauth.register_redirect_refused`) — an open endpoint that accepted arbitrary redirects would be an open redirector with a signature on it. Public client only (no `client_secret`), JSON body (NOT the token endpoint's form encoding — the two do not share a parser and the error message says so), and CORS so a browser-based connector dialog can call it |
| `oauth-authorize.js` | `GET`/`POST /oauth/authorize` — the one page a human sees in the whole connector flow: the CONSENT screen and authorization-code issuance. Needs a signed-in identity (an unauthenticated arrival gets a sign-in page, not a code), which is why the authorization server is the APEX and not the machine-facing `mcp.` host — the account, Google sign-in and the session cookie are already there, and a consent screen has to read as THIS SITE. VALIDATION ORDER IS SECURITY: `redirect_uri` is settled first through `oauth-metadata.js`'s `redirectAllowed` and its failure is the ONE error that renders a page instead of redirecting (an unvalidated redirect target is what an open redirector is made of), logging `oauth.redirect_refused` with the value — the only diagnostic anyone gets for the commonest connector failure; every other RFC 6749 §4.1.2.1 error bounces back to the client with `state` intact. CIMD (`fetchClientMetadata`, 4 s, 64 KB cap) buys a friendly name and a second statement of the client's own redirects, and degrades the DISPLAY only — a timeout costs the name, never the connection — but a fetched document that DOES list `redirect_uris` without the requested one is a hard refusal. CSRF: the GET mints a signed CONSENT token (`oct1.`, its own namespace, 10 min, bound to `sub`) carrying the request it just validated, so the POST reads no client parameters from the form and cannot be re-pointed at another redirect; `SameSite=Lax` plus an `Origin` check plus `frame-ancestors 'none'` sit under that. `mintAuthCode` arrives by dynamic `import()` (the file-layout rule), with a `deps` override as the test seam |
| `oauth-token.js` | `POST /oauth/token` — the RFC 6749 token endpoint, the one surface both hosted clients drive unattended forever (Claude refreshes reactively on a 401 and proactively 5 min before expiry). Four wire details are requirements rather than preferences: the body is `application/x-www-form-urlencoded` (`parseTokenBody`, with JSON as a fallback and never the reverse — a JSON-only parser answers 415 to every client that exists); failures land on RFC 6749 §5.2 codes at HTTP 400, because clients BRANCH on `error` and only `invalid_grant` gets a user out of a dead connection without re-adding the connector; refresh rotation is delegated whole to `oauth-store.js`'s `rotateRefreshToken` so a crash cannot strand a connection between two mints; and `client_credentials` is refused explicitly with `unsupported_grant_type`. No client authentication — the registered method is `none`, and the security is PKCE plus the redirect allowlist, not a shared secret. The store is a DYNAMIC import inside the handler (the file-layout rule), which is also the seam the tests inject a fake through |
| `pipeline.js` | The research pipeline's phase FLOW (triage → search → gap → synth → validate); iterates the source registries, never names a source. `runOneAuxSearch` also accumulates whatever provider spend a source reports (`SearchSourceResult.spend`) into `state.denseTotals`, generically — several dense legs per request, so it merges rather than overwrites. Every auxiliary-source gate (`planAuxSource`'s `intent`, `leadingSources`' `leadSourceIds`, the web-off fallback) reads `ctx.gateLastUser`, NEVER `ctx.lastUser`: whether a source applies is a fact about what the user asked, never about prose an enrichment appended to the message (feedback #61 — the third instance of that bug class, after the quiz gate and `externalSourceIntent`). `gateLastUser` is the clean pre-enrichment message PLUS `state.imageReadText`; the first fix used the clean message alone, which dropped the vision transcription of the user's own attachment — that is the user's question, not the pipeline's prose, and without it a photographed record page plus "what is this about" routed on a message with no subject. The three phases that WRITE web-search queries — `runTriage`, `runGapChecks`, `runSubquestionFanout` — read a THIRD view, `ctx.planLastUser` / `ctx.planConvText`: the enriched conversation minus the method blocks `runEnrichments` recorded (`withoutMethodBlocks` in `conversation.js`). Neither of the other two fits — the clean pair drops the DATA enrichments a planner legitimately searches from, the enriched pair carries method prose that is the shape of the answer and never a search target (feedback #65: a bare "Tiber style threat intel" planned against 945 appended words of TIBER-EU scaffold, so the first query went after the report format and quoted the block). Synthesis deliberately keeps reading `lastUser`/`convText`, since the block is the method it must follow. The FOURTH instance of that bug class and the first outside a deterministic gate — `runQuizGeneration` is a known unfixed sibling, reading the enriched pair while its own gate reads `ctx.cleanLastUser` (`docs/ARCHITECTURE.md` §4.2b). `state.issuedQueries` is likewise separate from `ranQueries`: recorded in `runWebLeg` and `absorbAuxResult`, it is the queries actually DISPATCHED, and it is the only set `searchLedgerSection` may be shown (`docs/ARCHITECTURE.md` §4.3e). When an aux source's first result reserves registry slots, `absorbAuxResult` widens `plan.digestCap` by the same count × `DIGEST_CHARS_PER_SOURCE` (1300, sized off the measured verbose block) alongside `plan.maxSources` — admitting sources without paying for their prose only pushes the highest-numbered ones out of the digest window — but stops at `DIGEST_CAP_CEILING` (36,000): unbounded, four aux sources took a 24,000-char digest to 65,600, and a synthesis context overflow is not failover-eligible, so the overrun costs the whole answer rather than a few tail sources |
| `pipeline-inputs.js` | The pipeline's PURE input-block builders + output parsers (`shellReplyMessages`, `notesSection`, `subquestionsSection`, `conflictsSection`, `searchLedgerSection` — the bounded list of queries actually ISSUED (`state.issuedQueries`, up to 40, above the planner's 34-search ceiling), so synthesis can tell "no source says this" from "we never looked"; its first cut read `state.ranQueries` — the angles the planner writes before the wave picks its legs — and claimed exhaustiveness over queries a stood-down leg never sent, so a truncated list now says "showing N of M issued" instead (`docs/ARCHITECTURE.md` §4.3e) — `collectConflicts`, `extractClaims`, `takeSearchBatch`, `mergeFanoutQueries`, and the SDK build turns' closing shape `auxReplyMessages` — the numbered digest a forced auxiliary source found, carried into a DIRECT reply, which both source-research direct exits used to drop although the user was already being shown those sources; `sdkReplyTail` + `endsWithQuestion` — the feedback-#13 summary/link/question tail both build paths share, whose build summary reads the SHIPPED paths off `publishBuild` (its staged-list fallback was unreachable — that function is the only producer of the value — and went in 2026-08-14), plus `sdkCutOffNote` and `buildContinuationTurns`, the feedback-#30 truncation pair; the latter joined its half of that fix here in 2026-08-07's refactor pass, and is the one builder in the module that never returns the empty default, being called only on the truncation branch) — the byte-identical-input string/data shaping split out of `pipeline.js` so the flow reads as the flow; Node-tested |
| `notes.js` | Structured research notes — the pure representation/merge logic behind the budget-gated notes-digest phase (`pipeline.js`'s `maybeDigest`, `prompts.js`'s `notesPrompt`): each note distils one factual claim tied to numbered source ids; normalizes and MERGES notes across search waves (dedupe by claim, union ids/entities) so gap-check and synthesis reason over a compact claim set instead of re-reading every highlight. Pure and never throws — a bad note is dropped, matching the pipeline's fail-soft posture |
| `triage.js` | The pipeline's JSON-hardening layer: the declared schemas for every JSON planning phase + `hardenJson`, and `normalizeTriage` (the triage-failure fallback) — pure, no I/O. Also the anti-loop guard on the clarify route: `looksLikeClarifyTurn` reads the previous assistant turn (the request carries roles and content only, so the reply text is the only trace of its route — structure and punctuation, never English phrasing, so Swedish behaves identically) and a second clarification in a row is converted into a search seeded from the conversation instead of another question (feedback #47) |
| `schema.js` | A tiny, pure, dependency-free schema validator hardening the model-JSON → pipeline boundary: `validate(shape, value)` never throws — it coerces/normalizes where it safely can and returns `{ ok, value, errors }` (combinators: string/boolean/number/stringEnum/arrayOf/object/oneOf). Sits BEHIND the existing fail-soft fallbacks (`normalizeTriage` etc. stay the last-ditch net); the integration pattern is `ok ? value : original`, so a schema miss degrades exactly as before |
| `answer-stream.js` | The answer-streaming internals behind synthesis/direct/search-off replies: `streamCompletion` (reliable-model failover), the per-model attempt loop (connect retries, idle guard, finish_reason detection), `emitChunked` |
| `search-sources.js` | The auxiliary search-source REGISTRY (HF Hub + future sources): one declarative entry per source (intent/search/service/dedup/promptNote/diversity) — the parallel-work seam (see the **add-research-source** skill). A source's RESULT may also report `spend` (2026-08-05), the dense-retrieval provider tally from `dense-rag.js`: most sources are a free HTTP query and omit it, the two hosted literature legs run a cross-encoder over 50 candidates and do not, and `pipeline.js` accumulates it across the request generically — declared here rather than in either source, so the orchestrator still never names one. Since 2026-08-13 an entry may also carry `requiresContext` — a `CONTEXT_BLOCKS` id the ANSWERING AGENT must declare for the source to run at all (`capabilityAllowsSource` here, `sourceAllowed` in `pipeline.js`, read generically so the orchestrator never learns which source a block belongs to). That is how the three literature legs became Deep Science's exclusively, with `palaeogenomics` keeping `literature-pubmed`; a source declaring nothing runs for everyone as before, and a NULL capability keeps every source because it means no agent was resolved rather than an agent that declared nothing — the `POST /mcp` channel and any deployment whose registry will not load (invariant 2). `sourcePromptNotes` takes the capability too, so triage is not taught the vocabulary of a leg that cannot run. Pinned by `literature-exclusivity.test.js` |
| `scholar.js` | The PEER-REVIEWED LITERATURE search source and the search half of the `scholar` (Deep Science) agent, added 2026-07-31. Runs whichever backends the deployment has keys for — OpenAlex (widest cross-domain, and the only one publishing every field the verdict needs; meters a small free DAILY BUDGET per caller and 429s once spent, so `OPENALEX_API_KEY` is what makes it real on Cloudflare's shared egress), Europe PMC's peer-reviewed slice (`NOT SRC:PPR`, free and key-less, which is what keeps the agent working on a bare deployment; biomed-strong and cross-domain-weak), Semantic Scholar (`SEMANTIC_SCHOLAR_API_KEY`; 429s unkeyed) a LICENSED Google Scholar search API (`SERPAPI_KEY`; fails with HTTP 200 + an `error` body, so detection is a body check) and, since 2026-08-12, THIS SITE'S OWN hosted PubMed index (`pubmedDenseSearch` over `pubmed-rag.js`, one dense lookup per search on the PROSE query while the rungs run on extracted terms, no outbound request at all) — merges them by DOI or normalized title, then keeps only records carrying POSITIVE evidence of peer review and drops the rest, retractions and preprints included. A Google Scholar hit carries NO peer-review signal and is admitted only by merging onto a record from a backend that publishes one; Crossref verifies the leftovers and is never used to discover (probed: its relevance ranking returns a zero-citation 2025 paper at rank 1, and `sort=is-referenced-by-count` returns lme4 because "effects" matched "Linear Mixed-Effects"). Query grammar is measured and OPPOSITE to Europe PMC's on quoting — quoting costs 38% of the recall AND worsens the top hit — so the ladder drops terms and never quotes. Items are DOI URLs, keyed by registrant prefix for diversity like `europepmc.js`. Two words were split apart after feedback #61, both because this gate LEADS and leading stands the whole web leg down: bare `scholar`/`scholars`, which in ordinary prose is a PERSON, now leads only through `SCHOLAR_AS_SOURCE` ("search scholar", "sök i scholar") — whose first cut broke invariant 6 in both directions and was rebuilt from four shared slots (verb + particle + short object + preposition) so a phrasing added to one language has an obvious counterpart in the other: it had accepted a BARE preposition in English with no Swedish counterpart, so "look it up in scholar" led while "slå upp det i scholar" did not, and the same bare preposition over-led on ordinary English prose ("the retention rate on scholar programs" stood the whole web leg down, which `AS_SOURCE_NOT_THE_SITE` now refuses); and `research`, which fires as the NOUN naming the record (`RESEARCH_NOUN` — qualified, determined, or governing a topic) and is vetoed as the IMPERATIVE VERB addressed to the assistant (`RESEARCH_IMPERATIVE`, EN + the Swedish loan and light verbs). The veto is scoped to that one clause, so a message that both instructs and asks about the literature still fires on its literature half. The hosted tier was added because the agent narrows every request to this one source (`state.auxOnly`) while the hosted corpora were wired only into `europepmc.js` and `arxiv.js`, which that narrowing EXCLUDES — so the site's own knowledge base was structurally unreachable from the agent whose subject it is, found by reviewing capture CAP-20 (`chat_logs` #1703). Its peer-review verdict is the weakest of the evidence-bearing rows and says so on every citation: the index stores no publication-type field, so `MED`-not-`PPR` is reconstructed from the journal name (`PREPRINT_VENUE`) plus a notice-shaped title (`RETRACTED_TITLE`, whose trailing colon is what separates "Retracted: …" from a paper ABOUT retraction). Its registry entry declares `requiresContext: "literature-peer-reviewed"` (2026-08-13): `auxOnly` already narrowed Deep Science's turn TO this leg, but nothing stopped another agent's turn from firing it on a "peer-reviewed" phrasing and spending the reranker budget of the agent whose subject it is. Full posture, probes and the robots.txt reasoning: `docs/SCHOLAR.md` |
| `scholar-metrics.js` | The GOOGLE SCHOLAR enrichment — the half that talks to Scholar itself, and the switch enforcing the Deep Science agent's restriction. Sets `state.forceAux`/`state.auxOnly`/`state.auxMaxPerRequest` on EVERY turn so the peer-reviewed source runs and no other auxiliary source may (without `auxOnly`, arXiv would still fire on a physics question and hand the agent preprints); reads a Google Scholar AUTHOR PROFILE from the robots-ALLOWED `citations?user=` page when the message carries a profile link or an explicit id (name, affiliation, verified email domain, h-index, i10-index, the 20 most-cited works with their counts) — there is no permitted way to look an author up by NAME, since `view_op=search_authors` is disallowed, and the code does not try; and folds in the venue-metrics block on a "where does this field publish" question. Gated on the resolved agent's declared `scholar-metrics` context block, like `aadr.js`: no chat mode, no knob, no request flag. Fails soft AND VISIBLY — a CAPTCHA page returns HTTP 200, so `parseProfile` returning null is the detection, and the step says the profile could not be read rather than going silent |
| `scholar-venues.js` | GOOGLE SCHOLAR METRICS as a lookup table: the committed `public/scholar/venues.json` (4,652 venues with h5-index and h5-median across Scholar's eight subject categories and their subcategories, harvested by `scripts/scholar-venues.mjs` from the robots-allowed `view_op=top_venues` pages). Cached per ASSETS BINDING like `aadr.js`, fail-soft to null on a missing or future-versioned artifact. Used two ways: `venueNote` annotates every citation's provenance line with Scholar's own h5-index, and `topVenues` builds the venue block. A build artifact rather than a live call for the privacy reason as much as the caching one — a per-turn lookup would tell Google which journals every research question here is about. `venueKey` deliberately does NOT expand abbreviations: a wrong expansion attaches the wrong h5-index to a citation, which is worse than attaching none, so abbreviated names simply miss |
| `sources.js` | The cross-search source registry: URL dedup, arrival-order numbering, per-origin diversity cap (per-domain; per-OWNER for huggingface.co) + overflow backfill. Also `sourceProgress` — the gap loop's saturation signal, which counts the domain-capped overflow as well as the admitted sources, because reading `sources.length` alone made a wave whose every find hit the cap look identical to a wave that found nothing. The prompt-facing RENDERING of the registry lives in its companion `source-digest.js`, whose two entry points are re-exported from here so importers reach for the registry module they already import |
| `source-digest.js` | The numbered-source digest — the only view the gap check, synthesis and validation get of the registry — bounded to the budget plan's `digestCap`. Pure string/number shaping, split out of `sources.js` 2026-08-06 so the registry reads as the registry and the budget rules get direct coverage (`source-digest.test.js`). The digest is a character budget, and filling it in pure arrival order let whichever source returned first decide what synthesis got to read: thirteen ~1,300-char paper blocks consumed an 18,000-char window and the sources that answered the question sat past the cut, unread (feedback #61). The budget is now SHARED — a max-min fair share per source, binary-searched — so a block over its share has its EXCERPT clipped with an explicit `[…]` marker and stays citable, while a block under it is untouched; nothing is reordered or renumbered. Dropping is the last resort, once even the floor share (320 chars) cannot fit, and is still counted and stated by `digestShownCount` plus the in-prompt truncation marker |
| `citations.js` | Façade over `public/js/citations-core.js` (shared with Se/cure): deterministic reconciliation of an answer's `[n]` markers against the numbered registry — `citationAudit` (cited / listed / **dangling** / unused), `citationNote` (the line handed to the fact-checker so it is given the offending numbers rather than asked to find them), `splitSourcesTail`, `citationNumbers`. Recorded, never enforced: a dangling marker is a finding for validation and the log, and deterministically deleting it would remove the one signal that says the answer went wrong |
| `aadr.js` | The ANCIENT-SAMPLE enrichment — the Worker façade over `public/js/aadr-core.js` and the structured half of the `palaeogenomics` agent (2026-07-29). Loads the committed corpus artifact (`public/aadr/samples.tsv.json`, 20,927 published individuals) through the ASSETS binding, caches it per BINDING rather than in a module variable (the `agent-registry.js` reasoning — one isolate, one binding, and no cross-env bleed), and on a structured sample question folds the exact matching rows and counts in as a labeled block. An ENRICHMENT and not a search source deliberately: a row is an individual in a dataset, not a URL, and registering it as a source would mean minting a plausible-looking link per row — the whole point of answering from a table is that nothing is invented. Gated on the resolved agent's DECLARED CONTEXT BLOCK (`capHasContext(state.capability, "ancient-samples")`), the first enrichment switched on by an agent spec alone: no chat mode, no knob, no request flag, and deleting the agent from `sdk/AGENTS.json` removes the capability. Se/rver-only (the block is `serverOnly`, so `validateCapability` refuses it to a client-tier agent) but reaches NO third party — there is no outbound request in the module at all |
| `owasp-context.js` | The OWASP REFERENCE CONTEXT (2026-08-13) — the OWASP Top 10 paragraphs a security-assessment turn is grounded in, retrieved from the committed corpus + its dense index through the ASSETS binding, diversified across categories (`OWASP_RETRIEVE_K` 8, `OWASP_PER_CATEGORY` 2) so the block spans several vulnerabilities the model can quote rather than the single closest one. Extracted from inside `introspect.js`, where it hung off `state.introspection` and so was reached by five modes as a side effect of carrying the source snapshot while exactly ONE agent declared it. Now gated on the resolved agent's declared `owasp` context block, which two agents hold and both correctly: `cyber` (a security assessment of somebody else's system) and `introspection` (an assessment OF THIS PLATFORM). Registered immediately AFTER `introspect` so the block lands where it always did and the query embed introspect stashed is reused rather than paid for twice. The corpus, its build (`scripts/fetch-owasp.mjs`), its index (`scripts/bundle-owasp-rag.mjs`) and its serving (`assets.js`) are capability-NEUTRAL and unmoved; Se/cure's client-side path (`public/cure/drc.js` `owaspBlockFor`) is unchanged and UNGATED, because that tier has no agent registry to resolve against. `prompts.js` splices `OWASP_ASSESSMENT_NOTE` on the SAME declaration — an agent told to cite `LLM01:2025` while holding none of the text those ids come from writes the classification from memory. Fail-soft in every branch: a missing corpus, a missing index, a dead embedder or a malformed conversation all degrade to no block |
| `image-read.js` | PHASE 0 — the IMAGE READ, and the FIRST core enrichment: one vision call that turns an attached picture into text before anything plans research. Nothing that decides WHAT to research can see an image — triage, the gap check and validation are JSON calls on the fixed planning model and read the conversation through `textOf`, which flattens image parts to "[N image(s) attached]" — so a LinkedIn screenshot with "write a report about this founder" planned ZERO queries and answered in 14 s against a 10-minute budget (`chat_logs` #1305 / feedback #60). The transcription (`IMAGE_READ_PROMPT`, `prompts.js`: verbatim text → named subjects → what the image is) is appended to the message the images are on as a labeled block whose closing paragraph tells the later phases it is the user's OWN attachment and not a source — never cite it, search the NAMES it contains rather than "the image", and treat a name read off a picture as unverified until a source confirms it. Runs on the ANSWER model, not the planning model: that is not invariant 3's business (the three JSON planners stay put) and is forced by capability, since `validation.js` rejects an image-bearing request whose model lacks vision, so whenever this phase runs the answer model is known to see images. Gated in the registry on `state.vision` (the cheap state-only fact) and silent — no step, no call, no change — when the turn carries no image, so a text turn costs nothing. Fail-soft in every branch (invariant 2): a bad status, a stalled stream (bounded by `IMAGE_READ_GUARDS` over `consumeChatStream`), a thrown fetch or an empty completion all leave the conversation unchanged and say so visibly. Counters land on `state.imageRead` (images, chars — the shape, never the text), and the transcription itself on the separate `state.imageReadText`, kept ONLY so the auxiliary-source gates can route on the user's own attachment (`pipeline.js`'s `ctx.gateLastUser`) and deliberately off the counters object, which is what `chat_logs` records: it is logged nowhere and never leaves the request |
| `person-research.js` | The PERSON-RESEARCH enrichment — the Worker façade over `public/js/person-research-core.js`, and the sibling of `image-read.js` in the feedback #60 fix (`chat_logs` #1305: a LinkedIn screenshot plus "Write a report about what you can find on this founder" was answered with a restatement of the screenshot). `image-read.js` supplies the name; this supplies the METHOD — when the latest message asks for research on a named individual's public professional record, an ~874-word methodology block is appended before triage, so the planner writes queries against a source ladder (statutory registries → IP → the scholarly record → independent press → company-controlled surfaces and the Wayback Machine → the profile itself, with only the subject-INDEPENDENT rungs 1-3 able to raise a claim to verified), the verification rules (two sources independent by ORIGIN, provenance labels, two dates plus a record identifier, and absence of a source as absence of a source) and the GUARDRAILS — public professional information only, no private contact details or identity numbers, no family, no special-category inference INCLUDING by assembling facts whose combination would disclose one, no de-anonymisation, no face matching, no pretext contact, and a founder is not automatically a public figure. The CHEAPEST enrichment in the registry: no outbound request, no model call, no asset read — the gate is a regex pair and the block is a constant, so invariant 2's fail-soft posture holds by construction. Logs counters only (`applied`, `words`), never the subject. Long form incl. the nine-phase protocol, each rung's traps, the legal grounding (Berkeley Protocol, ICD 203, GDPR Art. 5(1)(c)/Art. 9 with CJEU C-184/20, ICO vetting guidance) and the LinkedIn UA §8.2 / hiQ scraping rule: `docs/PERSON-RESEARCH.md` |
| `entity-research.js` | The ENTITY-RESEARCH enrichment — the Worker façade over `public/js/entity-research-core.js`, and the sibling of `person-research.js`. Answers feedback #64: "Osint on revsec" returned one report covering FOUR unrelated organisations sharing the name, at the same size it would have been at any research-time setting. Where person-research asks whether the SUBJECT is a person, this reads the REQUEST SHAPE — osint / due diligence / KYC / background check / dossier / threat intelligence / attack surface, and Swedish `bakgrundskoll`, `underrättelser`, `öppna källor om`, `hotbild`, `kartläggning av företaget`, `angreppsyta` (invariant 6, matched-pair suite). The gate stands ALONE with no referent conjunct, unlike person-research's: "revsec" is a bare token that no referent test can classify, and that is precisely the request needing the rule — which is why the phrase list is narrow enough to be safe unaccompanied ("report on", "research" and the rest of the ordinary research vocabulary are deliberately absent, as is "security assessment"/`säkerhetsgranskning` on BOTH arms, because it collides with introspection's OWASP code-review default). It appends two rules. SUBJECT RESOLUTION: count the distinct subjects the RETRIEVED sources show carrying the name; one → profile it and say what fixed the identification; two or more → write no merged report and pick nothing silently, but answer with a ≤250-word disambiguation turn (one cited line per candidate, then one closing question with numbered options) — braked by "an anchor already in the user's message IS the answer, so do not ask" and "never ask twice", because over-clarifying is this repo's most reported failure (feedback #47, #58). REPORT DEPTH, keyed on `state.plan.reportTier` (`src/budget.js` `reportTierFor`, so a dossier and an ordinary answer scale off ONE slider): `brief` a compact cited paragraph, `standard` a focused profile, `extended` a sectioned intelligence profile, `full` the structure of a TIBER-EU targeted threat intelligence report — the ECB prescribes required CONTENT and no section template (TTIR Guidance Jan 2025 §4, "may be drafted in any preferred format"), so the headings are TIBER-NO's published EXAMPLE structure and MITRE ATT&CK is named because the 2025 edition names it outright, while STIX / MISP / Admiralty 5x5x5 / ICD 203 / the Cyber Kill Chain are pinned OUT by test since no ECB TIBER document carries them. Its load-bearing line is SCOPE HONESTY: a real TIBER report is written under contract with the subject's consent by an engaged provider, this is a desk study from public sources, and the block forces the answer to say so and to claim no scanning, probing or purchased data. As cheap as its sibling — no outbound request, no model call, no asset read; a regex pair and a constant per tier, so invariant 2 holds by construction. Logs `tier` and `words` only, never the subject. Registered LAST in `CORE_ENRICHMENTS`, after `person_research`, so an OSINT question about a named individual reads the method and its guardrails first. Long form: `docs/ENTITY-RESEARCH.md` |
| `enrichment.js` | The pre-pipeline enrichment RUNNER — CORE, and deliberately ignorant of which services exist: it owns the `Enrichment` contract, the ordering, and the fail-soft containment (`runEnrichments`, blocks appended before any model call). Its registry is the EXTENSIONS from `extensions.js` followed by the core ones, none of which is an integration (the image read, introspection's committed snapshot, the OWASP reference, the model catalog, the ancient-sample corpus, Scholar's venue metrics, and the two method rows). Names no integration and behaves identically with an empty registry. What GATES a row changed on 2026-08-13: most core rows now depend on the answering agent's declared context block (`owasp`, `ancient-samples`, `scholar-metrics`, `entity-method`) instead of a mode flag or a knob, and the extension rows AND their knob with the same check. Since 2026-08-14 that gate is DATA on the entry (`contextBlock?: string`) rather than a `capHasContext` closure written out five times, matching what `search-sources.js` and `extensions.js` already declared; `enrichmentApplies(entry, state)` composes the two gates in the one place allowed to and is exported, because the AND is the invariant rather than either half (a test asserting `enabled` alone would pass with the capability gate deleted). The field is deliberately NOT named `requiresContext` like the search-source registry's: that one keeps every source when no agent resolved, this one drops the row, and the opposite directions are the point. `person_research` is the one row deliberately left unconditional, because its guardrails half is a privacy rail rather than a domain capability and the split is made in the runner. The contract's one optional field is `method?: boolean`, set by `person_research` and `entity_research` alone: those two append PROSE ABOUT HOW TO RESEARCH rather than data, so `runEnrichments` records what each appended — by diffing the last user message around the run (`noteMethodBlock` → `state.methodBlocks`), which keeps the knowledge here in the registry instead of in each runner — and the query-planning phases read the conversation without it (`pipeline.js`'s `ctx.planLastUser`, `conversation.js`'s `withoutMethodBlocks`, feedback #65). Absent means data, the right default: a block resolving something the message NAMES is exactly what a planner should write queries from. Fail-soft like everything else here — a frozen state or a runner returning a non-conversation records nothing, and with nothing recorded the planner sees what it saw before the flag existed |
| `extensions.js` | **The EXTENSION REGISTRY — the clean cut between the platform core and the third-party services woven into research** (owner directive, 2026-07-25). The ONE `src/` module allowed to name an individual integration at the architectural seam, and the only one core imports. One descriptor per extension owns SIX seams core consumes generically: `setting` (the per-account knob's wire key/availability/secret/503), `resolveState` (request body → its slice of `state.ext`), `enrichment` (the runner), `logMeta` (its `chat.complete`/`chat_logs` keys), `capability` (its numbered line in the grounded capabilities note), and — since 2026-08-13 — `contextBlock`, the `CONTEXT_BLOCKS` id naming WHICH AGENT may reach it. The sixth seam turned the knob from the whole answer into half of it: `extensionEnrichments()` ANDs the descriptor's `enabled` with `capHasContext`, and the capabilities seam is filtered by the same declaration so an agent that cannot run the lookup does not claim it can. The knob is the account's CONSENT to reach a third party; the block is which agent may use it, and neither subsumes the other. The state seam is deliberately NOT gated — `resolveState` runs before the agent is resolved and a sanitized slice nobody reads is harmless. The block ids are `host-intel` and `street-imagery`, never the vendors' names, so the vocabulary a core module reads stays service-blind (invariant 7); they are unique across the registry so an exclusivity guard can assert ownership per block. Today: Shodan and Google Maps — example integrations, not architecture. Adding one is ONE descriptor plus its own modules; NO core file is edited, and `extensions.test.js`'s core-purity guard fails the build if a core module names or imports a service again |
| `shodan-enrichment.js` | The Shodan enrichment runner (split out of `enrichment.js` 2026-07-25, mirroring `maps-enrichment.js`): turns whatever `shodan-text.js` resolved the turn into — a host lookup or a Shodan search — into a labeled context block, owns the `state.ext.shodan` slice, silent when the turn asks for nothing lookupable, fail-soft in every branch. Since 2026-08-07 it also writes `intent` (the deciding matcher, or `"none"`) to its slice, which the registry reports as `shodan_intent`: without it a `shodan_hosts: 0` row could not be told apart from a turn where the knob was off, which is what made `chat_logs` #1670 undiagnosable |
| `maps-enrichment.js` | The Google Maps enrichment runners — one per lookup-target shape (address/place lookup, POV & map-view captures, jumps, nearby/relocation Places searches, cross-barrier crossings, the journey view) incl. the Street View vision-describe helper; orchestrates lookups → SSE events → context blocks, dispatched by `runGoogleMapsEnrichment`. Also owns everything Maps-shaped that used to sit in core files (2026-07-25): the `state.ext.maps` slice (`MapsSlice`), the client-view sanitizers `validateStreetViewPov`/`validateMapView` (moved out of `validation.js`), and its own `streetview_embed`/`streetview_frames`/`map_embed` SSE status types (moved out of the core `SseStatus` union) |
| `slash.js` | **SLASH COMMANDS — the platform's composer command surface** (owner directive, 2026-07-26, feedback #26). A pure re-export of the ONE shared core `public/js/slash-core.js`: the two-entry registry (`/feedback`, `/help` — each with an EN+SV label, argument hint and description), the parser (`parseSlashCommand`/`slashEffect`/`slashArgs` — a leading slash plus an EXACT registry name; `/helper`, `/etc/passwd` and a mid-sentence slash are ordinary text), and the typeahead's pure half (`slashQuery`/`slashSuggestions`/`slashMenuItems`/`moveSlashIndex`). The commands are PLATFORM BASELINE, not an agent capability: `chat.js` resolves one from the message text BEFORE the mode routing and clears every executor phase for it, and `pipeline.js`'s feedback gate sits above the `ANSWER_PHASE_RUNNERS` dispatch — so the same two commands work in Deep Science, Cyber, Introspection, Agent Studio, Orchestrator, Outrospection and Models alike, and on Se/cure (`public/cure/drc.js` `send`). `/feedback` reaches the existing capture path (`feedbackRequested`/`feedbackComment` in `feedback-core.js`, then `runFeedbackCapture` and its canned EN+SV acknowledgment — still no LLM in the path); `/help` turns the introspection enrichment on for the request so the shipped help layer answers from the docs corpus. Every-mode routing is regression-locked in `src/slash.test.js`, which DISCOVERS the phases/booleans rather than listing them. Composer UI: `public/js/slash-menu.js` (UX-15) |
| `quiz.js` | The inline-quiz capability's pure logic: `quizIntent` (deterministic "quiz me…" gate, EN+SV, typo-tolerant, question-count parsing; triage carries a fail-soft `quiz:true` backup flag for phrasings the regexes miss), `normalizeQuiz` (hardens the quiz-generation JSON the client renders), grade-request validation/normalization — the pipeline phase is `pipeline.js`'s `runQuizGeneration` (JSON model, fail-soft to a normal answer), the interaction runs client-side (`public/js/quiz.js`) |
| `quiz-api.js` | `POST /api/quiz/grade`: grades a quiz's free-text answers (one JSON call on `DEFAULT_MODEL`, quota-gated + concurrency-reserved through the shared `endpoint-gate.js`, usage recorded via `quota.js`'s `recordDefaultModelUsage`); multiple-choice picks grade client-side from the quiz payload |
| `games.js` | The games subsystem's REGISTRY + dispatch seam (the games counterpart of `providers.js`/`search-sources.js`): one declarative entry per game (id/name/emoji/tagline/path/`available(env)`/`handle`); `GET /api/games` serves the shelf the account panel renders, `/api/games/<id>/*` dispatches to the game's handler — adding a game touches no client shelf code |
| `tokemon.js` | The Tokemon game's PURE core (Node-tested): Pokémon Gen-1 mechanics verbatim under an AI-themed skin (stat/damage/catch/escape formulas, medium-fast XP, the official type chart renamed 1:1, species stats copied from documented Gen-1 species), seeded-RNG deterministic spawning per (geocell, 15-min bucket), the turn-based battle engine, and the client-view projections (`publicSave`/`publicBattle`/`publicCreature` — the anti-cheat boundary — plus `parseLatLng`) — see the **tokemon-game** skill |
| `tokemon-data.js` | The game core's static DATA tables (Gen-1 provenance): the renamed type chart, moves, species, starters, balls/heal items, spawn/item-drop tables — re-exported through `tokemon.js`, so consumers see one surface |
| `tokemon-api.js` | The first registered game: `/api/games/tokemon/*` (dispatched via `games.js`) — save persistence (D1 `tokemon_saves`), spawn re-derivation + proximity validation, server-side battle resolution; 503s without D1. Also the street-view AR mode: `…/scene` (a Street View frame at the player's position with spawns projected INTO the imagery, via `googlemaps.js`'s edge-cached POV capture, gated on the per-user `google_maps` knob) and `…/go` (text navigation) |
| `tokemon-nav.js` | The street-view mode's PURE side (Node-tested): the bilingual text-command grammar (`parseGoCommand` — "go north 200 m" / "continue 50 m" / "gå till Kungsgatan 1" / "look right", EN+SV parity per invariant 6 enforced structurally, since one vocabulary table per word class declares both languages and everything — lookups, the reply-language flag, the parity test — derives from it), spherical geodesy (`destinationPoint`/`bearingBetween`/`absoluteBearing`, which resolves absolute and heading-relative commands alike), and `projectSpawns` (spawns placed inside a Street View frame under the same pinhole camera the imagery was shot with: tangent law → x, camera height over distance → y, 1/distance → size) |
| `demos.js` | The CAPABILITY-DEMO registry's server FAÇADE: a pure re-export of the ONE shared core `public/js/demo-core.js` (the registry of demonstrable surfaces, the deterministic EN+SV "show me X demo" gate, and the bare-visual-ask inheritance that lets "show me visually" take its subject from the turn before). No endpoint of its own — `pipeline.js` re-runs the SAME gate the chat clients mounted from, so the answer prompts' `spaceScene` / `demoSurface` cannot drift from what is actually displayed beside the reply (feedback #49/#50). TWO kinds of surface — `space` (inline scene) and `page` (a link card); which one mounts, and which module is fetched for it, is the clients' shared `public/js/demo-mount.js`. Adding a demonstrable surface is one entry in the core |
| `space.js` | The SPACE-ANIMATIONS domain's server FAÇADE: a pure re-export of the ONE shared core `public/js/space-core.js` (the scene registry — one "animation skill" per common space question, EN+SV — the deterministic `spaceIntent` matcher, zoom math, wireframe mesh builders, feedback validation) plus the domain's two endpoints: PUBLIC `POST /api/space/feedback` (the /space/ showcase gallery's 👍/👎 + short comment; validated against the registry, comment clamped, D1 `space_feedback` rows carry NO identity — the page is public) and admin `GET /api/admin/space-feedback` (newest-first entries + per-scene tallies, `?format=text` for loops). No D1 → 503, only the feedback button degrades — the animations are static assets and keep playing. See the **space-animations** skill and `docs/SPACE-ANIMATIONS.md` |
| `literature-tools.js` | The LITERATURE MCP tool family's PURE half — schemas, parsing, mapping, formatting, and it imports NOTHING (which is what lets `mcp.js` import it statically without breaking its keep-the-heavy-deps-dynamic file-layout rule). Four tools that turn the two hosted corpora into knowledge bases an external agent reads directly rather than through an answer: `literature_search` (up to 6 angles at once, both corpora, structured records with cross-encoder scores), `literature_fetch` (exact records by arXiv id / PMID — how an agent follows a citation), `literature_similar` (more-like-this from a known paper) and `literature_corpora` (what is actually indexed). Owns the record mappers that keep the fields `arxiv-rag.js`/`pubmed-rag.js` flatten into one `highlights` string — an agent's consumer is its own reasoning, not a numbered source list — the post-retrieval filters (`since`/`until`/`categories`/`journals`/`min_score`, applied to the candidate pool because neither index carries a Vectorize metadata index, and every filtered response SAYS so), the date padding that stops `since: "2024"` dropping January off an arXiv record's `YYYY-MM`, and `mergeRanked`, which de-duplicates a paper across angles and ranks corroboration above a slightly better lone score. `CORPUS_FACTS` carries each corpus's coverage WINDOW, because a miss inside the window means something different from a miss outside it |
| `literature-authors.js` | The literature family's AUTHOR half — "everything by this researcher", the one question the hosted corpora structurally cannot answer. Three causes stack: dense retrieval matches a personal name against TOPICS rather than authorship, neither index carries a Vectorize metadata index to filter on, and the stored author string was truncated from the FRONT — which on a life-science paper drops the senior author, exactly the name a body-of-work question is about. (A user asked an MCP client for a named palaeogeneticist's work; that researcher's own group's papers came back with their name in none of them.) So the `authors` argument on `literature_search` leaves the corpus and queries the LIVE Europe PMC (`AUTH:"Surname I"`) and arXiv (`au:`) author fields, fetching a most-cited and a most-recent slice and interleaving them — citation order is what makes "life works" answerable rather than "recent works". PURE (its one import is `literature-tools.js`, for `MAX_AUTHORS`), so the `mcp.js` file-layout rule holds. Owns the bilingual authorship gate that reads a name out of the query when no `authors` is passed (invariant 6, EN+SV at equal breadth, Unicode lookaround rather than `\b`), including the mixed-language genitive the bug report was written in ("elsa ekströms life works" — Swedish `-s` on the name, English noun after it). The bare-`s` genitive accepts only nouns that cannot follow anything but a person, because "mammoth genomics studies" otherwise reads as a researcher named Mammoth Genomic. Names are NOT disambiguated and the response says so: `queries` passed alongside are ANDed onto the author query, which is the lever that separates two people sharing a surname |
| `literature-run.js` | The same family's RUNNER — every call that touches a Vectorize binding, the embedder or the cross-encoder, loaded by `mcp.js` behind a dynamic `import()` inside `tools/call`. What makes it fast is two things: ONE batched embedding call for every angle (`dense-rag.js`'s `embedQueries`), then every (angle × corpus) retrieval running CONCURRENTLY through `denseRetrieve` — a six-angle sweep of both corpora is one embed plus twelve overlapping retrievals, not twelve searches. MEASURED against production 2026-08-02 (warm, median of 3): one angle over both corpora 814 ms, six angles 1690 ms — 2.1× the time for 6× the work, so the same angles one call at a time (~4.9 s) take **2–3×** as long (2.9× against these medians, 2.1× on a single-shot run minutes later). Real, and the reason to batch, but a factor of two or three rather than the order of magnitude the code's shape suggests. Concurrency is capped at `RETRIEVAL_POOL` (5) deliberately: a Worker holds only a handful of simultaneous outbound connections, and a queued fetch still counts down the 6 s abort signal it was created with, so an unbounded fan-out would not be faster — it would time out. The flat step from 6 legs (1180 ms) to 12 (1690 ms) says the pool is not the binding constraint at this size. `literature_fetch` and `literature_similar` are the only Worker-side users of Vectorize's `getByIds`; `similar` searches from the seed's OWN stored vector when the binding returns one (a true nearest-neighbour query) and re-embeds its title+abstract when it does not. Everything fails SOFT into a described `isError` result — a dead corpus degrades the answer and names itself in `degraded`, and a missing binding is reported as the deployment fact it is. Since 2026-08-05 it also METERS: `runLiteratureTool` records the call's provider spend in a `finally` (the shape `runDeepResearch` uses), from the cross-encoder's own `usage.total_tokens` plus the embedder's, priced through `billing.js`'s `priceRetrievalSpend` (`rawModelEntry` + `eurPerTokenFromBerget`, because neither model is in the chat catalog `quota.js`'s `bergetCost` prices from) — the tally shape and the pricer are SHARED with the `/api/chat` path, which had the identical hole (`dense-rag.js`, `billing.js`, `docs/MCP-COST.md` §4d). It lands in `berget_cost` and never in `searches` (that count is Exa's), and the two tools outside the quota gate — `literature_fetch`, `literature_corpora` — spend nothing and so record nothing. Recording is fail-soft in every direction: a missing `usage` block, an unreachable catalog or a D1 outage degrades the accounting, never the tool result |
| `outrospect.js` | OUTROSPECTION — introspection's mirror image (the outward-looking feed at `/outrospect/`): a pure re-export of the ONE shared core `public/js/outrospect-core.js` (the eight-LENS registry — one standing strategic question each: the one big dependency / browser-runnable models / edge RAG / LLM app architecture / provable privacy / agent standards / other deep-research systems / research over the scientific literature, each carrying its own literal Exa queries — more than one refresh issues, so the offset rotation widens the aperture instead of re-running a fixed set — and EN+SV routing terms per invariant 6 — plus item normalization, `deltaItems`, `mergeFeed`, `stalestLens`, the `?format=text` render) plus the domain's three endpoints: `GET /api/outrospect/feed` (the live D1 stream), `POST /api/outrospect/refresh` (runs ONE lens's searches on behalf of the visiting user, stores the delta, returns what is genuinely new — per-lens cooldown + per-user hourly cap off D1 `outrospect_runs`), and admin `GET /api/admin/outrospect` (feed + run log, `?format=text` for the agent loop). Fail-soft throughout (invariant 2: a dead search backend degrades to zero new items, never a 500); no D1 → the live half reports `live:false` and the page runs on the committed artifact alone. The stored `outrospect_items` rows carry the ARTICLE and never the reader (invariant 4). A refresh also INDEXES a bounded few of the lens's articles (`indexFeedTexts` → the existing Exa `/contents` client → `outrospect_texts`, four per run, capped and deadline-bounded, fail-soft), and the answer path reads them back (`loadTexts`) so a reply can QUOTE the article with its source link — the passages are chosen by the core's deterministic lexical scorer (`selectQuotes`), no model and no embeddings, so the reader's question never leaves the isolate (owner feedback #28). Offline bulk half: `scripts/outrospect-scan.mjs` (`npm run outrospect`) → `public/outrospect/feed.json`; read CLI `scripts/outrospect`. See the **outrospection** skill and `docs/OUTROSPECTION.md` |
| `prompt-sets.js` | The PROMPT-SET binding: the one place a capability block's `prompts` name becomes a real system-prompt builder. The pure core declares which sets exist and which of the six closed ROLES (`plan`/`worker`/`answer`/`answer-tools`/`answer-direct`/`answer-search-off`) each fills; this binds set+role → the function in `prompts.js` (plus the two pure ones, `orchestratorPlanPrompt` and `outrospectionAnswerPrompt`). `phasePrompt(state, phase, role)` is the call-site helper every answer phase now goes through, so prompt set and answer phase are INDEPENDENT choices. Total by construction — no state can leave a phase without a prompt; the binding is identity-pinned in `prompt-sets.test.js` |
| `prompts.js` | All LLM prompt builders |
| `tool-sets.js` | The TOOL-CLASS binding, `prompt-sets.js`'s sibling: the one place a capability block's `tools` names become real tool definitions. `TOOL_BINDINGS` maps each closed class (`source-read`/`sdk-plan`/`build-publish`/`shell`) to the array the phase used to import, plus what the deployment must `have` for it to be usable (the source snapshot). `toolsForRun(cap, fallback, have)` is the call-site helper: it walks the binding in REGISTRY order so a spec cannot reorder what a model sees, drops a class whose need is unmet rather than erroring (invariant 2), honours an explicitly-empty `tools` as none, and uses the phase's fallback classes only when NO capability resolved. Pinned in `tool-sets.test.js`, which also asserts `pipeline.js` never names a tool array directly |
| `validation.js` | Request validation (messages, images) + model/vision resolution, plus the untrusted-client-input sanitizers (`resolveShellTranscript`, `sanitizeClientDiag`, `sanitizeFsSummary`) shared with `chat.js`. Validates what EVERY request has and must not grow a field per integration — an extension sanitizes its own body fields in its `resolveState` hook (2026-07-25) |
| `model-routing.js` | The shared model-routing decisions, a leaf module (imports nothing) so `chat.js` and `mcp.js` share ONE implementation instead of a verbatim copy: `resolveJsonModel` (JSON planning phases stay on the fixed reliable model) and `resolveVisionModels` (the ranked describe-helper candidates, answer-model-first, capped at three because the describe fails over down the list) |
| `billing.js` | The shared split-billing spend math for a completed request (`summarizeSpend` — the up-to-three-model-bucket token/cost totals COLLAPSED into one figure, each priced at its own catalog rate; `spendByModel` — the SAME buckets kept APART, one attribution row per model that spent, feeding the `usage_model_events` ledger so a user's spend stays attributable to the model that drove it; `exaCost` — searches at their depth-tier price plus the `/contents` fetch surcharge): a leaf module (only the pure cost primitives from `quota.js`/`budget.js`) so `chat.js` and `mcp.js` share ONE implementation instead of both re-inlining it (`mcp.js` pulls it in via its dynamic-import block so the pipeline still stays out of `mcp.test.js`). Since 2026-08-05 it also owns the FOURTH bucket, the only one that is not a chat model: `denseSpend`/`priceRetrievalSpend` price the request's hosted-retrieval tally (`state.denseTotals`, filled by the search wave — `dense-rag.js`) from Berget's RAW `/v1/models`, because `fetchCatalog` filters the chat catalog to text models and neither the cross-encoder nor the embedder is in it, so `bergetCost` would price them at €0 forever. That lookup is async, which is why it is a separate call rather than a fourth row in `summarizeSpend`; the caller still writes ONE `usage_events` row and one `recordModelUsage` call, adding the EUR/tokens to the totals and `rerank`/`embed` rows to the attribution. Every failure direction is €0, never a guess (`docs/MCP-COST.md` §4d) |
| `conversation.js` | Message-array utilities (textOf, image parts, formatting, the non-mutating appenders); re-exports `starterRefOf`/`withoutStarterTags` from `public/js/starters-core.js` — the `#XP-<nn>` starter tag the pipeline reads for the record and strips before any model call. Also the two helpers the PRE-PIPELINE enrichments share (`src/aadr.js`, `src/models-agent.js`, which run before `pipeline.js` builds its ctx and so cannot reach `ctx.cleanLastUser`): `lastUserText`, the intent-gate reading of the latest user turn (text parts joined with a SPACE, no image marker — deliberately not `textOf`), and `appendToLast`, a multipart-safe append of a context block that adds a NEW text part so an attached photo survives it. `withoutMethodBlocks(conversation, blocks)` is that append's inverse, for one reader: the query-planning phases (`pipeline.js`'s `planLastUser`/`planConvText`). It removes the blocks `runEnrichments` recorded by EXACT substring — they are verbatim constants, so there is no matcher to drift — returns the SAME array reference when nothing was stripped, touches no assistant turn and no image part, and re-spaces only text it actually cut, because trimming every user message on every turn would be editing what the user wrote |
| `query-focus.js` | The QUERY-FOCUS server FAÇADE: a pure re-export of the ONE shared core `public/js/query-focus-core.js` (the `bash-agent.js` arrangement) — `contentWords`, `subjectTokens`, `isFormatChasingQuery`, `focusQueriesOnSubject`. The DETERMINISTIC half of feedback #65, and the second half of the fix `conversation.js`'s `withoutMethodBlocks` started: taking the method block away from the planner stopped it quoting the scaffold but not chasing the standard, so the angles that name a report FORMAT and none of the subject's own words are dropped after the planner returns. Prompt text alone was measured on the fixed JSON planner triage is pinned to (invariant 3) and did not hold there, and neither remedy was available — a stronger model is closed by invariant 3, a tool call by invariant 1. `pipeline.js` calls it at three points, all reading `ctx.cleanConvText` for the subject and the private `methodBlocksApplied(state)` for the gate: triage's `queries` (before the `plan.queries` slice), triage's `subquestions` (they steer every later round), and the gap round's `followups`; it logs `chat.query_focus {dropped, kept}` only when it drops something. `docs/ARCHITECTURE.md` §4.2c |
| `budget.js` | Time-budget planner: per-model EWMA stats, plan, deadline checks — plus the report-comprehensiveness tiers (`reportTierFor`: the slider buys OUTPUT depth too, brief → standard → extended → full; the plan carries the tier and its synthesis/validation token caps, and prompts.js turns it into per-tier report structure; triage-`simple` questions are capped at the standard shape by `applyComplexityToPlan` — seam-battery evidence, EVAL-BENCH-FINDINGS 2026-07-15) |
| `model-profiles.js` | Evidence-driven per-model overrides (priors, JSON reinforcement, validation skip) |
| `berget.js` | Berget client (primary provider): streaming + JSON-mode completions (both fetch calls time-bounded — invariant 2), model catalog (incl. raw per-token pricing). Also the home of the tolerant-JSON layer the OTHER providers share — `parseLooseJson` (imported by `anthropic.js`) and `jsonCompletionResult`, the `{ value, usage, diagnostics }` adapter over an OpenAI-shaped non-streaming body (imported by `openai.js` and `hf-inference.js`; `anthropic.js` keeps its own, since Anthropic returns content blocks and input/output counts) |
| `anthropic.js` | Anthropic (Claude) client — second, `ANTHROPIC_API_KEY`-gated provider: raw-fetch Messages API with an SSE adapter re-emitting Anthropic streams as OpenAI-style SSE (so `consumeChatStream` + all its guards work unchanged), static EUR-priced catalog (opus/sonnet/haiku) — see the **add-llm-provider** skill |
| `openai.js` | OpenAI (GPT) client — third, `OPENAI_API_KEY`-gated provider: raw-fetch Chat Completions; NO stream adapter (OpenAI SSE is the native wire format `consumeChatStream` parses), only pinned wire params (`max_completion_tokens`, `reasoning_effort: "none"`, `stream_options.include_usage`), static EUR-priced catalog (gpt-5.6-sol/terra/luna + gpt-5.4-mini) |
| `providers.js` | The LLM-provider dispatch seam: merged model catalog (`listChatModels(env, identity?)`) + `chatCompletion`/`completeJson` routed by model-id namespace via the `SECONDARY_PROVIDERS` registry (`claude-*` → Anthropic, bare `gpt-*` → OpenAI, `hf:*` → Hugging Face, else Berget) — everything downstream is provider-agnostic. The Hugging Face entry is the one whose menu is PER ACCOUNT: `models(env, accepted)` receives the identity's enabled list, so an open-catalog model appears only after that account enabled it. `providerDescriptors`/`providerIdFor`/`providerConfigured`/`exploreProvider` are the seam `model-catalog.js` reads, so the layer above names no provider |
| `exa.js` | Exa web search — the DEFAULT web-search backend. `webSearch(env, log, query, depth, { source })` first resolves the effective backend (the caller's user-picked source, then `config.js`'s `search` block, then Exa) and routes a non-`exa` selection to `websearch-backends.js`, falling back to Exa on failure; the cache key carries the backend id. Since 2026-08-07 the numbered result digest comes from `itemsDigest` through the `websearch-backends.js` facade rather than an open-coded copy, so every backend feeds synthesis one shape by construction |
| `websearch-backends.js` | The pluggable web-search BACKEND — SERVER FAÇADE over the shared pure core `public/js/websearch-backends-core.js` (the bash-core.js arrangement, so Se/rver AND Se/cure share ONE implementation): adds the server-shaped `resolveSearchBackend` (config + `SEARCH_BACKEND_URL`/`SEARCH_BACKEND_KEY` env + the per-request user pick), the config allowlist (`["exa", "cloudflare", …self-hosted]`), the user-pickable subset `USER_SEARCH_SOURCES` + `normalizeSearchSource`, and the dispatch of the Worker-native backend. Default `exa` keeps the site unchanged; a non-`exa` selection routes to `websearch-cf.js` or through the core (SearXNG / Exa-compatible), Exa fallback on failure; `/contents` full-text stays Exa-only. Se/rver config is the admin, server-wide `/admin` **Web search service** panel; recipes for running your own service in the **local-web-search** skill. Node-tested |
| `websearch-cf.js` | The CLOUDFLARE-ORIGINATING backend — this Worker IS the search engine: it runs an ORDERED CASCADE of results-page sources (`SERP_PROVIDERS` — DuckDuckGo no-JS, Marginalia, optionally Bing RSS; config `search.cf_serp`), MERGING them until the result limit is met, then (by default) fetches the top result pages, extracting text with pure string parsing. The cascade is measured, not defensive: DuckDuckGo returns an empty anti-bot shell to datacenter IPs, so the local browsing agent's technique does not transfer to the edge unchanged. Result QUALITY is likewise measured rather than assumed: a throttle interstitial served as HTTP 200 is detected and its retry token followed (`parseMarginaliaThrottle`) instead of being read as an empty index; results are ranked against the query with a relevance floor (`queryTerms`/`scoreItem`/`rankItems`); and a page excerpt is the passage that answers the query (`relevantExcerpt`) taken from text with the site furniture stripped (`pageText`), not the page's first 1200 characters — which on a real article is the part before the article. A source falls back to a class-free anchor scan only where its markup warrants one: DuckDuckGo carries it, Marginalia deliberately does NOT (the scan only ever ran on pages that had no results, and returned the engine's own links as sources). Where it does run it is fenced on both sides (`stripChromeRegions` + `looksLikeResultSet`), because a page that found nothing renders masthead and footer links and nothing else, and believing them handed six of the search engine's own about/donate/licence links to synthesis as sources (feedback #48). No search API, no key, no service to deploy, no new dependency; the parsers stay pure so they Node-test (HTMLRewriter would put them out of the suite's reach). Bounded + fail-soft throughout — an exhausted cascade returns `null` and `exa.js` falls back to Exa. Server-only by construction (a browser cannot fetch a SERP cross-origin), so it is deliberately NOT in the shared core Se/cure imports |
| `edge-cache.js` | Fail-soft Workers Cache (caches.default) get/put helpers — the shared cross-request result-cache mechanics behind `exa.js` and `googlemaps.js` |
| `named-urls.js` | DIRECT WEB BROWSING of the URLs a message names — the Worker fetching a page itself, as a COMPLEMENT to the search index rather than a backend for it (the sibling distinction to `websearch-cf.js`, which originates the SEARCH). `extractNamedUrls` pulls http(s) URLs out of the latest user message (deduped, capped at 6, sentence punctuation trimmed, the local network and cloud-metadata ranges refused); `readNamedUrls` fetches them concurrently under one deadline and returns search-result-shaped items the source registry takes unchanged. Wired as pipeline PHASE 1.5, before the first search wave, so a linked page is numbered first and is in front of every later phase. Written for feedback #67 (chat_logs #1729): a question carrying five URLs, each with its own instruction, was answered "not retrieved by any of the angles run" after fifteen search angles, because the pipeline could only rediscover pages by keyword and could not simply read one it had been handed. Only a GET to the user's own URL leaves the Worker — no conversation, identity, cookies or referrer (invariant 4) — and every failure mode (status, content-type, size, timeout, socket) degrades to one source fewer (invariant 2) |
| `europepmc.js` | Europe PMC search — the LIFE-SCIENCE LITERATURE leg (PubMed/MEDLINE, PubMed Central, bioRxiv/medRxiv behind one free key-less REST API), added 2026-07-29, and since 2026-08-13 gated on `requiresContext: "literature-pubmed"` — declared by Deep Science and, as the one explicit preservation in that division, by `palaeogenomics`, whose only literature leg this is because almost no genetics reaches arXiv: an ancient-DNA study appears in Nature, Cell or on bioRxiv, so a genetics question previously had only the generic web leg and answered from press coverage. Its query grammar is the INVERSE of arXiv's and the ladder is built on measured counts: the default operator is AND (`"ancient DNA" mammoth` and `"ancient DNA" AND "mammoth"` both return 490 where OR returns 13,793), quoted phrases WORK (arXiv returns zero for the same form), and `ABSTRACT:`-restriction cuts 490 → 57 — so the ladder climbs by DROPPING constraints (abstract → whole-record phrase → fewer concepts → unquoted) rather than by adding them, and a rung is accepted only once it has produced enough distinct records (a rung matching one paper does not end the wave). Two fetches per search — `CITED desc` and `P_PDATE_D desc`, interleaved — because one sort alone is either stale or untested. `resultType=core` is what carries the abstract, DOI and citation count. Items are DOI URLs, so `europepmcDiversityKey` keys on the REGISTRANT PREFIX (10.1038 = Nature Portfolio, 10.1101 = bioRxiv) or every publisher would share one origin and the per-origin cap would starve the leg. Intent is bilingual (invariant 6) but the QUERY is forced English by the prompt note — probed live, "mammutens arvsmassa" returns 0 down the whole ladder where its English equivalent returns hundreds. Like `arxiv.js`, it reports the hosted tier's `spend` on both exits (2026-08-05) so the wave can bill it. The combination gate was narrowed after feedback #61: an IMPERATIVE frame ("Research this founder", "granska den här personen") is neutralised before the research-word test, since a verb addressed to the assistant is not a reference to the published record. The words that are ordinary general English or Swedish however biomedical their other sense (health, heart, brain, immune, sequence, assembly, virus, muscle, minerals, singular patient; SV `hälsa`, `hjärta`, `lever`, bare `genom`) also moved out of `LIFE_SCIENCE_WORD` into `LIFE_SCIENCE_PHRASE`, where they count only inside a collocation no other domain writes. That narrowing over-shot twice and both were corrected. The frame was neutralised BEFORE the research-word test rather than instead of it, so when "research" was a message's only research word a plainly biomedical question routed to no source at all ("Research this drug's side effects", "Undersök den här sjukdomen", "Granska dessa symtom"): `europepmcIntent` now asks in a fixed order, and a strong biomedical SUBJECT satisfies a message that WAS framed as a task, while the veto still lands on "Research this founder". And the collocation tier assumed Swedish always compounds — it does when the concept has a compound, not when the ambiguous word is the topic ("hälsa och skiftarbete", "muskler hos äldre", "hjärnan under sömn"), so 7 of 13 matched EN/SV pairs fired in English and were silent in Swedish, breaking invariant 6. `LIFE_SCIENCE_SV_SEPARATED` carries the separated forms, disambiguated by the linking word rather than by a following noun and each arm naming the figurative sense it excludes; the same change closed a pre-existing gap, "hjärt- och kärlsjukdomar" (THE Swedish term for cardiovascular disease), which matched nothing at all because `sjukdom` cannot start inside `kärlsjukdomar`. A METABOLIC/ENDOCRINE strand was added 2026-08-12 from the same CAP-20 review: `diabetes` and `cholesterol` were in the gate but `insulin`, `glucose`, `metabolism` and `fasting` were not, so an endocrinology question ("intermittent fasting and insulin sensitivity") fell between them in BOTH languages, and the Swedish compounds `vitamintillskott` and `luftvägsinfektion` broke invariant 6 besides. Swedish `fasta` stays in the collocation tier rather than the word tier — it is also "fixed" (`fasta kostnader`, `fasta priser`) where English `fasting` has no such sense |
| `hf.js` | Hugging Face Hub search (models/datasets/papers) — joins each search wave as citable registry sources when the question explicitly targets Hugging Face (`hfIntent`); `HUGGINGFACE_API_TOKEN` secret optional |
| `arxiv.js` | arXiv search — joins each search wave as citable preprint sources when the question asks about scientific literature (`arxivIntent`: explicit arXiv/preprint/literature vocabulary fires alone; research phrasing fires with a scientific topic word, EN+SV per invariant 6). No API key. The query grammar is the whole design: `all:"multi word phrase"` returns ZERO and unquoted spaces are OR, so queries are built as fielded `abs:"term" AND …` (`arxivSearchQuery`) over noise-stripped topic terms (`arxivTerms`) with a bounded 4→2-term drop ladder (`arxivAttempts`) because over-specifying returns nothing; relevance ordering only (local date re-sorting was measured to demote the best hits and is recorded as tried-and-lost). Terms are picked by DISTINCTIVENESS rather than position (`arxivDistinctiveness`/`arxivSelectTerms` — capitalised acronyms outrank ordinary words, since taking the first four terms of a natural question spends the slots on discourse words and drops the subject). Atom parsed by regex (`arxivParseFeed` — no DOMParser in Workers), items carry an authors/category/date/id metadata highlight, and `arxivDiversityKey` keys by PAPER so the per-origin cap can't collapse the whole archive into 3 slots. arXiv rate-limits with 429, so a 429/503 aborts the ladder (a 400 stays per-rung), the ladder is total-time-bounded, and successful responses go through the shared `edge-cache.js` for an hour — the only cross-module import, and the main defence against the throttle. Owned EXCLUSIVELY by the Deep Science agent since 2026-08-13 — the registry entry declares `requiresContext: "literature-arxiv"`, and that agent reaches it only when the reader names the preprint record (`scholar-metrics.js` `preprintSources`). This is the live-API tier, and it is the FALLBACK: `arxiv-rag.js` is tried first when its index is bound — and since 2026-08-05 the result carries that tier's `spend` on BOTH exits, because a dense lookup that found nothing above the floor still paid for its embedding and its cross-encoder before falling through here |
| `arxiv-rag.js` | The HOSTED DENSE tier of the arXiv source — the corpus of `docs/ARXIV-RAG.md` embedded into Vectorize (`ARXIV_INDEX`) and searched with the settled pipeline: e5 query embedding → Vectorize top-50 → `bge-reranker-v2-m3`, no lexical arm. Gated on its binding, so removing it switches the tier off and `arxiv.js` simply uses the live API. Two deliberate deviations from the doc, both commented: the rerank pool matches the doc's 50 since 2026-07-29 (it was 20 because Vectorize used to cap topK there with `returnMetadata: "all"`; the cap is now 50, and raising it bought +4.0 points of EN recall@10 for no extra round trip and no extra rerank latency — `docs/ARXIV-RAG.md` §11), and the served path's own recall is MEASURED rather than inherited from the local pack: 78.7% r@1 / 85.3% r@10 EN, so the doc's 87%/96% still must not be quoted here; and a measured RELEVANCE FLOOR on the cross-encoder score (0.01) makes an off-topic question return nothing instead of the index's nearest neighbours — dense retrieval always returns something, which is how a partial index answers a pizza question with physics papers |
| `dense-rag.js` | The CORPUS-AGNOSTIC dense-retrieval tier, extracted from `arxiv-rag.js` on 2026-07-31 when PubMed became the second hosted corpus: embed the question (`query: ` prefix, 6 s), query a Vectorize index (top-50 with `returnMetadata: "all"`, 6 s, raced against a timer because Vectorize's `query` takes no abort signal), rerank with `bge-reranker-v2-m3` (6 s, documents cut to 900 chars for the served 512-token window), apply the 0.01 relevance floor — and a 12 s whole-call budget that SKIPS the rerank rather than starting it once the earlier legs overspent. Everything a corpus differs in is a parameter (`index`, `itemOf`, `docOf`, `tag`); every constant in it is a measured value whose provenance is in `docs/ARXIV-RAG.md`. `null` means the tier is unavailable or failed (use the live API); `[]` means it was asked and nothing cleared the floor — a different claim, and both callers treat it as one. Split further on 2026-08-01 for the MCP literature tools: `embedQueries` embeds a BATCH of questions in one request (six research angles cost one round trip, not six) and `denseRetrieve` is `denseSearch`'s body with the embedding lifted out and the mapping left to the caller, so a caller holding a pre-embedded vector — or wanting the cross-encoder scores themselves — gets the budget discipline and the floor without re-implementing them. `denseSearch` is now the one-query case of both. Both of those also stopped DISCARDING the provider's token report on 2026-08-05 — `embedQueries` returns `embedTexts`' `{ vectors, usage, model }` and `rerankMatches` returns the rerank call's `tokens` — because the MCP literature tools bill a quota on them and a measured count beats one inferred from string lengths (`RERANK_CHARS_PER_TOKEN` is the fallback for a response that carries no `usage` at all). Since the same day it also owns the SHAPE that carries that spend to whoever bills it — `RetrievalSpend` + `newRetrievalSpend`/`addEmbedSpend`/`addRerankSpend`/`mergeRetrievalSpend`, and an optional `spend` accumulator on `denseSearch` — because `/mcp` is not the tier's only caller: the `/api/chat` search wave runs it through `arxiv.js`/`europepmc.js` and had the identical unbilled hole (`docs/MCP-COST.md` §4d). Pricing the tally is `billing.js`'s (`priceRetrievalSpend`), not this module's: it needs Berget's raw catalog and this one stays a leaf over `berget.js`. It also owns the shared implementation of both per-corpus callbacks: `titleAbstractDoc` is `docOf`, what the cross-encoder reads, and since 2026-08-03 `authorsLine` + `citationHighlights` + `MAX_ABSTRACT_CHARS` are the common half of `itemOf`, what the user reads. Each tier's mapper exists to look exactly like its LIVE sibling's, so a reader of the numbered source list cannot tell which tier answered — and that breaks with no error and no failed request, which is why the 420-char presentation cut is one constant rather than two |
| `pubmed-rag.js` | The HOSTED DENSE tier for the BIOMEDICAL literature — PubMed embedded into Vectorize (`PUBMED_INDEX`) and searched through `dense-rag.js`, standing to `europepmc.js` exactly as `arxiv-rag.js` stands to `arxiv.js`. COMPLEMENTS arXiv rather than replacing anything: 40.9 M citations (29.3 M with abstracts) from MEDLINE and the life-science journals, which is the half of research almost none of which reaches arXiv. Deliberately adds NO intent gate — Europe PMC already owns "is this a life-science question" bilingually (invariant 6), and a second regex would be a second Swedish parity suite to keep in step; this is a retrieval tier behind the gate that exists. Vector ids are `pmid:NNNN` and `pubmedRagItem` produces the same item SHAPE the live tier does, so a user cannot tell which tier answered. Since 2026-08-12 it also exposes `pubmedRagRecord`/`pubmedRagRecords` — the identical retrieval mapped to the UNFORMATTED stored fields instead of one `highlights` string — because `scholar.js` has to JUDGE a paper (which journal, what year) rather than cite it, and the peer-review doctrine stays in the module whose promise it is. Gated on its binding, which is declared and live in `wrangler.toml` — the index was created 2026-07-31 and filled with 1,639,403 unique citations, and removing the binding switches the tier off so `europepmc.js` serves from the live API. The binding lands only after the index exists, because a declared Vectorize index that is missing fails every deploy. See `docs/PUBMED-RAG.md`, whose §3.3 records the constraint that matters: 88.0% of PubMed passages are cut at e5's 1200-char window, because the median PubMed abstract is 1,672 chars against arXiv's ~1,200 |
| `hf-inference.js` | Hugging Face INFERENCE — one LLM provider among four, and the only one with an OPEN catalog: the OpenAI-compatible router (`https://router.huggingface.co/v1`, no stream adapter needed), the `hf:<owner>/<model>[@<provider>]` id namespace (`isHfModel`/`hfModelId`/`parseHfModelId`/`hfWireModel` — the prefix is required, since a bare `owner/model` path is Berget's id shape), the cached catalog fetch + normalization (`hfRouterModels`/`normalizeRouterModel`, cheapest LIVE priced serving becomes `best`), the comparison turn every provider's price is expressed against (`TYPICAL_TURN`/`turnCostEur`), and the registry's `explore` hook (`hfExplore`) that translates HF's own vocabulary into provider-agnostic rows. Everything CROSS-provider lives one layer up in `model-catalog.js`. `HUGGINGFACE_API_TOKEN` REQUIRED here (inference is billed), unlike in `hf.js` |
| `model-catalog.js` | THE MODEL CATALOG — one list of every model this deployment can reach, from whichever provider, in whatever LIFECYCLE state (`discovered` → an open provider lists it; `available` → a configured provider ships it, already selectable; `enabled` → this account turned it on), with whatever is known about it. Names no provider: Berget/Anthropic/OpenAI/Hugging Face all arrive as descriptors from `providers.js`, so a fifth is a registry entry and nothing here changes. Owns `buildCatalog`, the deterministic `rankCatalog` (no model call, the query never leaves the isolate), the MODEL ALLOWANCE (`modelAllowance`/`enableVerdict`/`applyAllowance` over `config.js`'s `models` block — and it governs the `discovered → enabled` transition ONLY), and the `catalogBlock` the agent folds into a turn. Verification is ORTHOGONAL to the lifecycle by design |
| `model-checks.js` | MODEL VERIFICATION — the established metrics, and the deliberately soft way the result is used: none is a hard blocker, they report what is KNOWN rather than what is permitted. Nine checks, each a failure mode this project actually hit (`reachable`/`completion` ← the round-4/6 empty-completion bug, `json` ← invariant 3's whole reason, `streaming`, `swedish` ← invariant 6, `citations`, `injection` ← round 3, `vision`, `latency` ← round 1's GLM priors). Each is ONE bounded direct model call with a DETERMINISTIC assertion — no model judges another (invariant 1) — run through the same provider dispatch a real turn uses. `runCheck` never throws (an error IS a recorded failure) and clears its raced timeout; `checklistFor`/`checkSummary` keep `untested` distinct from `fail` |
| `models-agent.js` | The Models AGENT's mode behaviour — an ENRICHMENT, not an executor (its answer phase is the ordinary `research` one): forces Hub search on for every turn via the generic `state.forceAux` seam and raises the hub's per-request search ceiling through the equally generic `state.auxMaxPerRequest` seam (both carry into developer mode's source-research path via `runForcedAuxSearches` — feedback #36), and on a model-lifecycle message (`modelIntent`, EN+SV per invariant 6; ranking terms via `modelQuery`) folds the live cross-provider catalog in as a priced, verification-annotated context block and emits the `model_cards` SSE event the composer renders as pickable cards |
| `models-api.js` | The LIFECYCLE surface: `GET /api/models/catalog?q=` (every model, every provider, with state + price + checklist), `POST /api/models/verify` (run the checks and record them — evidence, never permission), `POST /api/models/enable` / `/disable` (the promotion, re-validated against the LIVE catalog so a hand-rolled request can't enable an unpriced or over-allowance model). Signed-in only; fail-soft to fewer rows + a spelled-out note |
| `user-models.js` | The PER-ACCOUNT MODEL RECORD, two independent maps in `users.settings_json` (no migration; `settings.js` `mergeStoredSettings` stops a knob write from wiping either). ENABLED (`hf_models` — a WIRE key kept from before the generalisation, internal-only, same split as `/api/projects*` vs "workspace") is the promotion pipeline; CHECKS (`model_checks`) is verification results for ANY model, which is why they are separate maps rather than one list. Enabled entries are PRICE SNAPSHOTS taken at enable time, deliberately: billing must not depend on a third-party fetch, and the price the user agreed to is the price they keep until they re-enable (`hfRefreshNotes` surfaces the drift instead of hiding it). A disable KEEPS the verification record — what was learned stays learned |
| `shodan.js` | Shodan host-intelligence clients (registered as an EXTENSION in `extensions.js`; two gates ANDed since 2026-08-13 — the opt-in `shodan_mcp` knob and the descriptor's `host-intel` context block, which today only the Cyber agent declares) — see the **integrations** skill. Two legs: the per-host lookup (`/dns/resolve` then `/shodan/host/{ip}`) and, since 2026-08-07, the SEARCH leg (`/shodan/host/search`) that answers "which machines belong to this organization". Every null return now logs a `shodan.skipped` reason — the silent no-op on an unresolved hostname is what left `chat_logs` #1670 with no trace at all |
| `shodan-text.js` | The pure text side of the Shodan integration (2026-08-07), split out the way `googlemaps-text.js` was split out of `googlemaps.js`. Owns the DECISION of what to ask Shodan about: `extractTargets` (the publicly-routable IPv4s and hostnames in one message, deduped and capped — moved here from `shodan.js` 2026-08-07, which is what finally made this module a leaf like `googlemaps-text.js`), the EN+SV intent gate (`shodanIntent` — ports, services, attack surface, known CVEs, plus naming the service; invariant 6, lookaround boundaries not `\b`), and an ordered matcher registry (`pickShodanTarget`) with four routes — `filter-query` (Shodan filter syntax the user typed, rebuilt from recognized tokens only), `latest-host` (the original intent-free route, unchanged), `walk-back` (a host an EARLIER user turn named; assistant turns are never scanned, so a follow-up cannot spray a cited source's host at Shodan), and `org-search` (a company name → an `org:` search). Before this the integration had no intent gate at all: naming the service could not trigger it, and neither could a follow-up — `chat_logs` #1670-#1672 |
| `geocode.js` | Reverse geocoding via OpenStreetMap Nominatim: resolves a photo's GPS EXIF coordinates (extracted client-side by `public/js/exif.js`) into a human-readable place name the model and Exa can reason and search with. Server-side like every other outbound call (so it's logged and rate-limited consistently); only the coordinates cross the wire — never the filename, question, or any account/session identity. Fail-soft (returns null on any failure/timeout) |
| `googlemaps.js` | Google Maps Platform clients (Places, Street View, Static Maps, Routes) and the edge-cached lookup orchestration (registered as an EXTENSION in `extensions.js`; two gates ANDed since 2026-08-13 — the opt-in `google_maps` knob and the descriptor's `street-imagery` context block, which today only the Cyber agent declares); also declares the `StreetViewPov` shape, moved out of the core `types.d.ts` 2026-07-25 |
| `googlemaps-blocks.js` | The Maps integration's pure labeled context-block builders (POV/jump/cross-barrier/nearby/map-view/lookup/journey blocks + the keyless `mapLink`/`panoLink` helpers and `compassDir`) — Node-tested; the API key never appears here |
| `googlemaps-text.js` | The Maps integration's pure text side: deterministic address/place extraction, every intent gate (street-view, moves, here-asks, nearby/relocation, barriers, journey), locality corrections, the conversation-state recovery (`pendingRelocation`, `extractJourneyPoints`), and `pickLookup` — the ORDERED LOOKUP_MATCHERS registry (one small matcher per ask shape; the order is the spec) — all Node-tested |
| `history-key.js` | Per-user key for the client's encrypted local chat history — see the **storage-privacy** skill |
| `log.js` | Structured JSON logger (`LOG_LEVEL` var). Also exposes each logger's bound base fields as a frozen `log.fields` (+ the total reader `loggerRequestId`), so a deep helper can pick the request id out of the one request-scoped object it already receives instead of threading a new field through `PipelineCtx` — used by the Orchestrator's fail-soft node guard when it writes a durable failure row |
| `http.js` | Request/response helpers shared across modules: `jsonResponse`, `sseResponse`, `htmlResponse`, `textResponse` (the last is the `?format=text` plain-text renderer the admin-loop board endpoints return), `escapeHtml` (the FIVE-character escape both server-rendered page modules — `login.js` and `oauth-authorize.js` — carried byte-identical; the apostrophe and quote are load-bearing, since both interpolate attacker-influenced values into attribute position, and it is NOT `public/js/markdown.js`'s deliberate four-character escape), and `readJsonBody` — the parse-or-400 thirteen endpoint handlers used to inline verbatim, returning the `{body, response}` pair (the `endpoint-gate.js` shape) so each caller keeps its own early return. The tolerant token-endpoint readings (`.catch(() => ({}))`, where a missing field is already its own 400) deliberately do not use it. Node-tested |

Client (`public/`): `index.html` (markup only) + `css/app.css` +
ES modules in `js/` — `app.js` (bootstrap/wiring: scrolling, slider,
search knob, composer, and the Introspection/SDK composer-row status chips
(`#introroute`/`#sdkbuild`, 2026-07-20) that fill the space the slider leaves
in those two modes — CSS keyed on the same root theme class as the slider
hide; also wires the test-queue client
`testpoints.js` — the try-it banner + queue over the pure
`testpoints-core.js`, fed the app-specific action hooks so it never
reaches into `app.js` internals — see the
**testable-interaction-points** skill; and the starter strip
`starters.js` — the four opening questions rendered inside the empty
state, drawn from the active chat mode's agent queue over the pure
`starters-core.js`/`starters-data.js`, re-rendered on a new chat and on
a mode switch, with the rotation cursor and pick counts kept in
`localStorage` and sent nowhere. With the Settings knob *Starter prompt
evaluation* on (browser-local, `dr_starter_eval`) the same module renders a
cross-agent REVIEW BATCH instead — one starter per band (proven / weak /
untried / candidate, the last from `starters-data.js`'s `CANDIDATES` trial
pool), each labelled. The batch serves NEW questions on every render (owner
directive, 2026-07-29): a browser-local seen ledger (`dr_starter_eval_seen`,
id → times shown) makes `selectEvalBatch` order every band least-seen first,
and the four rendered are recorded as the strip is shown, so nothing comes back
round while anything is unread. There is no rating control — the reviewer's
verdict is a `feedback …` message in the chat the chip opened, which is the
queue a human already reads. A chip switches the chat mode to its own agent
before sending, and prepends that starter's `#XP-<nn>` tag to the message so
that feedback note is tied to the exact starter (the ordinary visitor strip
never tags — the pick signal stays local; `src/pipeline.js` strips the tag
before any model call, and `src/chat.js` puts it on the chat-log row and the
feedback entry) — see the **starter-prompts** skill), `stream.js` (conversation history + `/api/chat`
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
`unanswered-core.js` (what happens to a question whose send produced NO
answer — an empty completion, a failed route, an unrecoverable drop, or
Stop before the first token. `markUnanswered` KEEPS the question in the
conversation and appends an assistant marker (`unansweredMarker`) saying it
went unanswered; `stream.js`'s `settleUnanswered` is the one caller, on
every such path in all three routes (server, private introspection,
on-device). It used to pop the question instead. But the question BUBBLE
stays on screen either way, so popping desynced what the user reads from
what the model gets: feedback #45 was a question that died on a phone
before reaching the server, followed by a "Try again" the model could only
answer with "the original question never reached this conversation". The
marker is an ASSISTANT turn so roles stay strictly alternating, and it
states only what happened — resolving the retry back to its question is
`conversation.js` `previousUserText` and `introspect-core.js`
`retrievalQuery`, not prompt-stuffing. Node-tested),
`session-core.js` (the PURE SESSION REGISTRY — a session is an **agent, a
workspace and a history** addressed by one id, and a tab merely attaches to
one. Owns the record shape, the id minting (inside
`[A-Za-z0-9._-]{1,64}` so it doubles as the `src/exec-container.js`
container session), the heartbeat LEASE that decides whether a session is
still held, `attachDecision` for the duplicate-tab case, `pruneRegistry`'s
bounded store, and above all `resumeTarget` — the rule that stops a second
tab adopting another tab's in-flight research while still letting a cold
relaunch collect an answer that finished while the app was gone. Records are
metadata only: ids, agent, send settings, timestamps, never message text.
Node-tested),
`session.js` (its BROWSER half — localStorage `dr_sessions` for the durable
shared registry, sessionStorage `dr_session_tab` for THIS tab's attachment,
the heartbeat timer, and the accessors every other client module reads
instead of a browser-global key: `sessionAgent`, `sessionConfig`,
`sessionConvId`, `claimResumeTarget`, `takeOverSession`. Every mutator is
read-modify-write over the live stored value and only ever patches this
tab's own record, because several tabs share one registry with no lock),
`pending-answer.js` (the RESUME-ACROSS-RELAUNCH pointer that closes the
gap `recovery.js` can't: iOS can discard a backgrounded PWA entirely, so
a cold relaunch loses the in-memory request id `recovery.js` would poll
with — this writes a metadata-ONLY marker (conversation id, request id,
settings, timestamp; NEVER message text, and nothing for incognito
chats) so the next launch collects the answer the server finished while
the tab was gone. Since 2026-07-27 the marker lives on the SESSION record
rather than in one browser-global slot — it stays DURABLE, which is what
keeps the iOS case working; the multi-tab rule is in `resumeTarget`),
`sse.js` (the pure SSE line-buffer parser `stream.js`'s read loop feeds —
Node-tested), `message-content.js` (pure builders for the outgoing
message: labeled document / image-metadata / RAG-excerpt blocks, title
derivation, history image-stripping, `splitUserContent`, plus
`conversationCopyText`/`embedRef` — the header copy-button's plain-text
"User:/Assistant:" conversation export with images, appended blocks, and
pipeline-embedded elements (Street View panorama/frames, id-numbered)
reduced to one-line references — the
Node-testable core `stream.js` orchestrates around),
`models.js` (model dropdown), `attachments.js` (pending images/docs;
the canvas downscaler itself lives in `image-downscale.js`, the shared
leaf `feedback-attach.js` — the feedback pipeline's add-a-screenshot
widget — also compresses through),
`account.js` (the account panel SHELL: `initAccountPanel`,
the shared `PanelCtx`, and the `showView` dispatcher — the views live in
`account-views.js` (summary, full usage,
games shelf + the shared building blocks: setting rows, info popovers,
notification badge, the chat-mode/sandbox knob rows the settings
view renders), `account-messages.js` (the message center),
`account-settings.js` (ALL configuration — the cloud-storage DISCLOSURE row,
which informs rather than switches because storage is implicit, then the
Exa web search / Shodan / Maps knobs, the sandbox knob and chat-mode pick,
and the starter-prompt-evaluation knob; feedback is given from the chat,
not a knob. Opened from the
summary's Settings button OR directly via the header's gear icon,
2026-07-11 directive),
`account-feedback.js` (the Feedback dialogue-threads view — thread
screenshots render as thumbnails off the per-image endpoint, and each
reply box carries the `feedback-attach.js` widget),
`account-mcp.js` (the Settings → **MCP server** view, 2026-07-26: mint /
rotate / revoke this account's one MCP key, choose which tools the `/mcp`
surface exposes and whether a caller may override the research defaults, and
copy the ready-made client config. The key is shown ONCE at mint — the view
holds no copy afterwards, which is why rotating is the only recovery — and
the panel states plainly that an MCP call is Se/rver-tier traffic: logged in
the account's name, on the account's quota. Server side:
`src/mcp-key.js` + `src/mcp-config.js`),
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
behind `src/introspect.js` and both tiers' clients; also the EN+SV
back-reference gate `backReferenceIntent` and `retrievalQuery`, which
decides what a turn RETRIEVES for. Normally that is the latest message,
but a bare back-reference names no subject of its own — "read those", and
since feedback #45 the retry family "try again" / "försök igen" — so it
resolves to the question it points back at instead of embedding its own
two words),
`source-peek.js` (SOURCE PEEK — in developer mode every inline-code repo
path an answer cites (`src/pipeline.js`, `agent-spec-core.js:34-45`) becomes
a tap target opening that file from the committed source snapshot in a
self-styled popover: syntax highlighted, markdown rendered with a raw
toggle, `:line` ranges scrolled to and marked; snapshot fetched lazily on
first tap, both tiers wire the same module over their own dev-mode gate)
over the `source-peek-core.js` pure core (reference parsing, snapshot path
resolution, the dependency-free tokenizer — Node-tested),
`markdown.js`
(sanitized rendering; a complete ```` ```mermaid ```` fence in an answer draws
as a real diagram — the vendored `mermaid.min.js` lazy-loads on first use
only, fail-soft to the plain code block), `report.js` (the branded PDF report export of
an answer — lazy-injects the vendored jsPDF on first use only, so the
normal page load never pays for it), `timescale.js` (slider scale), `search-source.js` (WHO runs the web
searches — the per-device preference behind the **Exa web search** settings
knob: on (default) means Exa, off means this site's own Cloudflare Worker.
The composer's web knob is on/off ONLY (2026-07-26 directive; it briefly
carried a picker). The ids mirror the server's `USER_SEARCH_SOURCES` and the
server re-validates, so this is a preference and never a trust boundary. One
module for BOTH tiers — the settings row is `account-settings.js` on DRS and
`#exarow` on DRC; DRS sends the source as `/api/chat`'s `search_source`, DRC
as the grant/token calls' `source` — Node-tested), `history-store.js`
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
synchronous question every storage-touching module asks), `dev-mode.js`
(introspection's CLIENT presentation: the TITANIUM-GRAY theme — a `dev-mode`
class on the ROOT element re-pointing the nine palette variables, `:root.dev-mode`
in `css/app.css`. Since 2026-07-26's mode collapse this module is the class
toggle and nothing else; it used to own a second `dr_dev_mode` cache mirroring
the retired `developer_mode` knob — Node-tested), `chat-mode-core.js` (THE MODE
TABLE, a pure core with no DOM and no storage, shared with the Worker through
the `src/chat-modes.js` façade: `CHAT_MODES`, `MODE_REQUEST_FLAGS` (mode → the
`/api/chat` boolean that selects it, ARRAY ORDER = precedence, mirroring
`sdk/AGENTS.json`'s `defaults`), `SOURCE_CARRYING_MODES`/`modeCarriesSource`
(which modes get the site's own source — a NAMED list since 2026-07-31, not
"every mode but the default": the two DOMAIN modes `science` and `cyber` are
deliberately absent, so the next domain mode inherits nothing by accident),
`RETIRED_CHAT_MODES` (`normal` → `science`, so a stored setting, a share link or
an unreloaded tab still resolves rather than being clamped as junk),
`resolveBodyChatMode` (the ONE wire resolution: no capability → the default,
`developer_mode:false` → the default, `chat_mode`, then a legacy flag, then the
account's stored pick — the terminal fallback is `science`, not a general mode,
because THERE IS NO GENERAL MODE since the owner directive of 2026-08-13), and
`routingNeedsRegistry`, which now returns `true` unconditionally: every mode is
a domain enforced by its resolved capability, so skipping the registry would
resolve a NULL capability and silently hand back the unrestricted platform
default — Node-tested),
`chat-mode.js` (the BROWSER half of the mode state —
Deep Science / Cyber / Introspection / Agent Studio / Orchestrator /
Outrospection / Models; Introspection and SDK shipped 2026-07-18 alongside the
retired `normal` (the khaki SWE build mode was folded into SDK 2026-07-19),
Orchestrator, Outrospection, Models, then Deep Science (2026-07-31) and Cyber
(2026-08-13) joined them: the `dr_chat_mode` localStorage entry, which since
2026-07-26 is a
first-paint CACHE of the account's stored `chat_mode` rather than a second
authority; decides which theme class the root carries —
`sci-mode` PARCHMENT for Deep Science's reading room, `cyber-mode` CRIMSON for
Cyber's operations room, `dev-mode` titanium for Introspection, `sdk-mode` GREEN
for the SDK "lovable
experience" (distill this site — above all the Se/cure tier — into a new
flavour), `orch-mode` VIOLET for the Orchestrator sub-agent workflow mode, `outro-mode`
NEWSPRINT for Outrospection's outward feed, `models-mode` AMBER for the Models
agent's lifecycle board —
and the mode `stream.js` declares per send, which is now the single
`chat_mode:"<mode>"` field (plus `build_slug` in SDK mode) instead of a
per-mode boolean; `adoptServerChatMode` takes the server's stored mode when
`/api/settings` resolves, replacing `reconcileChatMode`'s downgrade rule —
Node-tested),
`models-panel.js` + its pure core `models-core.js` (the MODEL LIFECYCLE BOARD —
the Models agent's LEFT SIDEBAR, and the one mode whose side panel is not chat
history (`mode-theme.js` `panel: "models"`), because in this agent the models
ARE the session. Three lanes — enabled / available / discovered — over every
provider, each card carrying its price and its VERIFICATION CHECKLIST: one box
per established check, in three states, which are status and never gates. The
same cards render inline in a turn when the `model_cards` SSE event arrives. The
core owns the formatting the whole feature rests on — cheap-end precision, the
estimate always reading as an estimate, `untested` staying visibly distinct from
`fail`, a blocked card always carrying its reason — and is Node-tested),
`slash-core.js` (SLASH COMMANDS' shared PURE core — the registry, the parser
and the typeahead's filtering/highlight logic; see the `src/slash.js` row
above — Node-tested) and `slash-menu.js` (the composer typeahead itself, UX-15:
ONE DOM module both tiers mount — `app.js` on Se/rver, `drc.js` on Se/cure —
because the commands belong to the platform rather than to a tier or a mode. A
`/` typed as the first character opens the list; ↑/↓ move, Enter or Tab picks,
Escape closes, a tap picks; the keydown listener is bound to `document` in the
CAPTURE phase so it out-ranks the composer's Enter-sends handler (UX-8)),
`sdk-core.js` (the shared PURE core behind BOTH SDKs' tool surfaces —
Platform-SDK manifest ops + the Agents SDK's build tools, plus the APP KIT's
pure half: `APP_KIT_PATH`, the `buildNeedsAppKit` injection trigger, and
`APP_KIT_NOTE`, the one briefing both the build prompts and the SDK context
block carry so the model cannot call the kit by an API it does not have; see the
`src/sdk-tools.js` row above; lives under `public/` per the pure-core
convention, imported by the
Worker, the `sdk/pair-cli.mjs` CLI, and Node tests — Node-tested),
`orchestrator-core.js` (ORCHESTRATOR MODE's shared PURE core — the closed
sub-agent kind vocabulary (`deep_research`/`introspection`/`swarm`/`custom`,
the last two downgrading to `custom` when the request carries no source
snapshot / no swarm-capable device), the
workflow plan schema with its never-throw validator + salvage normalizer,
dependency→wave resolution, the plan/node prompt builders (EN+SV parity in
the plan instruction), and the `workflow`/`agent_update` SSE event shapes;
`src/orchestrator.js` is the executor — Node-tested), `workflow-viz.js` (the
Orchestrator WORKFLOW VIEW: pure column-per-wave layout + XSS-safe SVG string
assembly (Node-tested), and the small DOM mount that renders the live
sub-agent graph in the turn body, persists as embeds-registry kind
`"workflow"` (statuses updated per `agent_update`, replayed from history by
`turns.js`), and is referenced in the copy-text export via `embedRef`; a
`swarm` node is drawn taller, with one dot per on-device member and the
round/agreement readout the `swarm_update` events drive; every node is also a
BUTTON opening the node INSPECTOR — a live panel under the graph showing that
sub-agent's task, persona, searches as they land, upstream/downstream links and
the PROMPT it is working on, repainted on every update while the answer streams
and bounded on what it retains; `inspectorModel`, `inspectorHtml`,
`nodeActivity`, `mergeSearch` and `nodeRenderState` are all pure and
Node-tested),
`pipeline-map-core.js` + `pipeline-map.js` (INTROSPECTION mode's live PIPELINE
MAP — the expandable in the left drawer that draws this site's own request path,
from the composer to the streamed answer, with the nodes the current chat passed
through lit and the loops counting their rounds. The core is pure and
Node-tested: the node/edge table (a declaration of shipped control flow across
`src/index.js` → `src/chat.js` → `src/pipeline.js` plus the client half in
`stream.js`), the layered two-lane layout sized for the 320px drawer, the
XSS-safe SVG string builder, and `nodesForStatus` — the SSE-status → node map,
which ignores anything it doesn't know (the forward-compatibility rule) and
reads the `route` field `src/pipeline.js` puts on the finished `plan` step rather
than sniffing an English label. The DOM module owns the run state, because the
drawer is usually CLOSED while a chat runs: `stream.js` feeds it every status
event, rendering is skipped while collapsed and caught up on expand. Three node
states only — idle / active (blinking) / passed — and a node lights ONLY on a
signal that the step ran, never on an inference from the answer text; see UX-16.
Shown in introspection mode alone, gated from `history-ui.js` beside the SDK
showcase gallery),
`graph-backdrop.js` (the Orchestrator GRAPH BACKDROP — the "graph" value of
the mode-theme `backdrop` axis: a hovering, slowly rotating wireframe
DIRECTED GRAPH drifting faintly behind the chat (fixed canvas, z-index -1
like the terminal layer), root + one node per sub-agent, each drawn as its
kind's wireframe symbol in its kind's color (balloon blue / TIN slate /
violet diamond; the root a violet baton star) with live statuses (pulse
running, ✓ done, ✕ failed); built ONLY on `space-core.js`'s own
rotY/projectPoint math — no dependencies; pure scene/frame core Node-tested,
idle scene = the root conducting one ghost node per kind; fed by `stream.js`
on the workflow/agent_update events; the `swarm` kind is a green satellite
cluster — the only node running on the user's own device), `memory-core.js` +
`zip-core.js` + `account-memory.js` (ACCOUNT MEMORY, 2026-07-30 — `docs/ACCOUNT-MEMORY.md`: the account's durable note graph. The core is the pure note
model, its Obsidian serialization (`noteToMarkdown` frontmatter + `[[wikilinks]]`,
`vaultFiles` folder layout, the generated index) and the conservative extraction
prompt; `zip-core.js` is the hand-rolled stored-entry ZIP writer with the UTF-8 name
flag set so Swedish note titles survive export, deterministic so two exports of an
unchanged vault match byte for byte; `account-memory.js` is the Settings → Memory
screen — the knob, the counts, every note shown in full, and the download/reset pair.
Server side: `src/memory.js`), `swarm-core.js` +
`swarm-runtime.js` (SWARM REASONING, 2026-07-25 — `docs/SWARM-REASONING.md`:
the Orchestrator's `swarm` node answered by N tiny Bonsai models running at
once in this browser. The core is the pure algorithm (diverge → ring critique
→ deterministic converge: manufactured member stances, three-line parsed
critiques, centrality-plus-vote scoring, the EN+SV agreement metric, the stop
condition, the provenance-led brief, the `swarm_update` event shape) and the
runtime is the loop over a worker pool of `ondevice-engine.js`
`spawnSwarmMember` handles — one isolated Worker with its own model instance
per member, `spawn` injected so the whole loop is Node-tested against a fake;
both fail soft to `null`, which degrades the node to a server-side `custom`
run. The runtime also owns the tier's MEMORY BUDGET (feedback #26, the Safari
tab crashes): one run at a time via `stopSwarms()`, one pool per run, a
model-size- and heap-aware pool size, retire-and-replace for an abandoned
generation, and the durable crash breadcrumb `swarmCrashDiag()` reads back
after a tab dies mid-run), `mode-backdrop.js` (the backdrop
DISPATCH — the mode-spinner.js sibling for the `backdrop` axis: mounts/
unmounts the graph layer as the mode changes; "terminal" needs no mount, the
sandbox layer is event-driven — called from `app.js` boot/reconcile/mode
switch and the Settings mode pick), `sandbox-mode.js` (the SANDBOX counterpart of
`dev-mode.js`: a `dr_bash_lite` localStorage mirror of the `bash_lite_mcp` knob
so the cross-origin-isolation self-heal fires SYNCHRONOUSLY at first paint from
the cache — closing the 2026-07-13 boot-race where a send before `/api/settings`
resolved fell back to a plain web answer with no sandbox activity, chat_logs
#306 — plus the single `isolateForSandbox`/`shouldIsolate`/`clearIsolationGuard`
self-heal helper `app.js`, the knob toggle, and the `pageshow` bfcache handler
all route through; Node-tested), `bar-tint.js` (the iOS bar-tint re-assert
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
`depthSlider` (hidden in Introspection + SDK + Orchestrator + Outrospection),
one descriptor per mode (Deep Science / Cyber / Introspection / Agent Studio /
Orchestrator / Outrospection / Models) plus the two tier reference entries
(Se/cure first); pure/import-free,
Node-tested; the shape SDK mode distills into when it "creates new themes of
this kind" — see `docs/SYMBOL-LANGUAGE.md` §7), `mode-spinner.js` (the DOM
dispatch `turns.js`/`activity.js` call — mounts the CURRENT mode's spinner off
`mode-theme.js` `spinnerKind`: the balloon everywhere except SDK, recoloured per
mode (titanium in Introspection, violet in Orchestrator, crimson in Cyber), and
the PLANT in
SDK; fail-soft to the balloon, and — where no canvas symbol can be drawn at all
— to the COIN), `logo-spinner.js` (the CANVAS-LESS waiting symbol, any mode:
the site icon in the slot is itself the spinner, spinning upright about its
vertical axis the way a coin spins on a flat surface (css/app.css `coin-spin`),
and on completion SETTLING — the turn slowing, the tilt growing, the rattle
faster and wobblier the flatter it gets — to rest LYING FLAT, face-on, seen
from 30° above the surface (`COIN_TILT_DEG` = 60° of rotateX), held a beat and
faded as the real ✓ takes the slot; the motion is CSS, this module is the clock
(the caught angle, the whole-turns left to land face-on, the durations) and it
IMPORTS the run/hold/check pacing from `umbrella-spinner.js` so it is a sibling
of the canvas finales by construction; pure clock/plan helpers Node-tested),
`plant-spinner.js` (SDK mode's WAITING SYMBOL —
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
Node-tested), `sync.js` (the boot background reconcile `syncToServer`,
pushing every local record the cloud is missing or has older; cloud storage
is implicit on Se/rver, so there is no knob to flip — plus the `pullNewer`
"anything newer up there?" pass), `projects.js` (project records,
file/note ingestion + indexing, scope helpers — cloud-stored implicitly,
with no per-project knob since the 2026-07-16 directive; a legacy
`serverStorage` field is ignored),
`project-context.js` (pure builders: the project-materials block,
`projectDocIds` — Node-testable), `projects-ui.js` (the project panel:
the vault store-with-secret section, dropzone, add-text
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
pure core Node-tested). DRC's client modules, the whole public tier:
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
providers ONLY — OpenAI, Anthropic, Groq, Hugging Face and Berget (Berget's CORS
confirmed live 2026-07-11; Anthropic joined 2026-07-26 and speaks its own
Messages API, adapted at the wire by `wire: "anthropic"` — the browser
mirror of `src/anthropic.js`, with `anthropic-dangerous-direct-browser-access`
as the header CORS requires before the browser-direct call is permitted;
Hugging Face joined 2026-07-27 on `router.huggingface.co/v1` — plain OpenAI
wire, `hf_…` keys, and the one OPEN catalog here, so its dropdown fills from
the live `/models` marketplace rather than a curated handful, the client-side
counterpart of the Models agent's per-account allowance on the server tier),
callable directly from the browser with the user's key — PLUS the keyless
`local` entry (2026-07-15,
Forever Agent §8 pick #2), which is ALSO the "any OpenAI-compatible
endpoint" escape hatch, so the five named providers are not the boundary:
usually the user's OWN server
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
512, the deliberate small/fast/quota-friendly choice; none of Anthropic,
Groq or the Hugging Face router serves an embeddings endpoint (the router has
no such route at all — probed 404, 2026-07-27), so a session on any of them
runs without RAG —
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
Node-tested; the worker is browser-only glue like sandbox.js; since
2026-07-24 the SAME engine also serves the Se/rver app through
`ondevice-drs.js` — the DRS glue owning the browser-local `dr_ondevice`
knob, the gear-panel section (download with the exact-size inline consent,
cancel/resume, delete, capability verdicts, and the GRAYED-OUT row for a
model whose upstream browser build has not shipped — declared by the
catalog's `browserBuild`, lifted by the live `probeModelPublished` tree
check, feedback #36), and the cached-model listing
behind models.js's "📱 On-device" dropdown group; a pick from that group
makes stream.js run the whole exchange through the client-side pipeline
(`runOnDeviceExchange`) instead of `/api/chat`, the "ondevice::" option
values shared between the tiers via ondevice-core.js. Memory is the tier's
failure mode, so the engine also exposes `unloadOnDeviceModel()` /
`terminateOnDeviceEngine()` (the singleton's resident model is otherwise
compiled for the life of the page) and the core carries the crash
BREADCRUMB helpers `runBreadcrumb`/`crashClass`/`crashDiag` plus
`heapUsedRatio`, shared with the swarm runtime), and
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
Se/cure–Se/rver wordmark-slash renderer), `drcFeedbackContext` (the
prior-turn question/answer excerpt the feedback consent dialog shows and
sends), and `privacyNoticeLines` (the ℹ
PRIVACY NOTICE's text, 2026-07-16: what this session's current configuration
sends where — model route, web-search route, recall, borrowed allowances,
shared-workspace provenance; the animations are tier identity again — UX-2,
SYMBOL-LANGUAGE.md §6)
— Node-tested),
`drc-attach-core.js` (Se/cure's ATTACHMENT INTAKE, 2026-08-05 — the pure half
of the composer's attach pane, with `public/cure/drc.js` keeping only the DOM
and the file reads: `sanitizeAttachName` (basename-only, control characters
stripped, length-capped, never empty — the name is used as the path a file
mounts at in the in-tab Linux VM, so traversal is stripped at intake rather
than at the mount) and `addPending`, a pure list transform that admits a file
against five independent bounds — image count, document count, per-file bytes,
total bytes, and the per-image plus total data-URL character budgets — and
refuses with a message that names the size, truncating a document's inlined
text at the character cap instead of dropping it. Class-C throughout: the
bounds exist because on Se/cure the attachment travels straight from the
browser to the user's own provider, so nothing server-side can size it),
and
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
`research-seal-core.js` (CROWD RESEARCH's pure core / DRCR/1 seed,
2026-07-23: the ASYMMETRIC result-sealing behind distributed secure
workspaces — an organizer fans out invite links carrying a per-campaign
project PUBLIC key, participants research in their own Se/cure sessions and
SEAL their conclusions back so ONLY the organizer's private key opens them.
The one new primitive in the stack — every other path is symmetric
password-KDF — as an ECIES composition of primitives already here: ECDH
P-256 → HKDF-SHA-256 → AES-256-GCM (`generateProjectKeypair` /
`exportProjectPublicKey` / `projectKid`, `sealResult` / `openResult`
fail-closed, `validateResultEnvelope`), plus the `drcr1:` QR chunk framing
(`chunkResult` / `reassembleChunks`) for phone-to-phone return. WebCrypto
only; imports `proxy-bundle.js`'s b64url + `sha256hex` helpers; spec + full workflow in
`docs/CROWD-RESEARCH.md`, schema `docs/schemas/drcr-result-1.schema.json`
— Node-tested).
`pool-core.js` (SHARED COMPUTE's pure core, 2026-07-23: the strict DRSC/1
wire profile for pooled completions — `sanitizePoolRequest` whitelists
model + role/content messages + two tuning knobs, strips everything else,
clamps sizes, forces `stream:false`; imported by BOTH the Worker's broker
(`src/pool.js` enforces it) and the /cure client, so the two can never
drift — plus `poolDataFlowNotice`, the ONE source of the data-flow
disclosure every workspace participant sees — Node-tested),
`pool-provider.js` (the SHARER's provider loop: register → long-poll →
run the job on the sharer's own local model → post the result; modeled on
`recovery.js`'s abortable fail-soft poll discipline, dependency-injected
transport so it Node-tests without a browser; wired to the "Share my
compute" toggle on BOTH tiers — /cure's local-model row and the Se/rver
panel's LLM sharing screen — Node-tested),
`pool-local.js` (the LOCAL-MODEL half both tiers lend through, 2026-07-26:
`normalizePoolLocalUrl` + `listLocalPoolModels` (fail-soft — an unreachable
server advertises nothing) + `runLocalPoolJob` (throws, so a failed job is
reported as `upstream_error` and the consumer's unit refunded); shared so a
Se/cure tab and a Se/rver tab speak one wire to a user's own machine —
Node-tested),
`secure-posture-core.js` (what Se/cure may honestly CLAIM given the config
it was entered with, 2026-07-26 — feedback #31: `securePosture` ranks the
session `local` < `direct` < `routed` < `peer` (largest disclosure wins),
and `securePostureQuips` / `securePostureBrief` / `securePostureLine` give
the ghost's speech bubbles, the first-visit greeter + intro pane, and the
tier explainer's one-liner. ONE source, so no surface can promise "nothing
leaves this browser" while shared compute relays prompts to a peer's
machine — Node-tested), and
`knowledge-core.js` (WORKSPACE KNOWLEDGE's pure core, 2026-07-23: 👍 on a
reply → a CONCLUSION — context summary (`summarizeContext`, deterministic)
+ query + the reply split into blocks (`splitBlocks`) the curator steers
with plus/neutral/minus tags through a pure reducer with full UNDO/REDO
(`curate`/`curationState`); minus blocks are REMOVED everywhere,
plus blocks render as key context (`conclusionToContext`); transport is
the `drskn-bundle` ECIES envelope (DRCR's suite with its own frozen kind
+ HKDF info) sealed to the site's import-agent key — the same envelope
rides the server inbox (`src/knowledge.js`) or downloads as a `.drskn`
file for out-of-band delivery; `account-knowledge.js` is the owner's
Se/rver-panel import view — Node-tested).
DRC's page is `public/cure/` (`index.html` + `drc.js` wiring +
`drc.css`, plus `umbrella.js` — the first-visit intro animation, the
logo vortex untwisting into wireframe 3D umbrellas, pure
timeline/geometry core Node-tested, replay with `?anim=1`, pace =
2.5× base × the admin's `anim_speed` config slider (public
`GET /api/anim`) — and `ghostwalk.js`, the ambient strolling ghost that takes
over after the intro: dynamically imported by `drc.js` so it costs the first
paint nothing, and split the usual way, with the stroll/turn/idle state machine
as a pure core Node-tested from `public/js/ghostwalk.test.js` while the module
itself owns the canvas. A click promotes the ambient stroll into a real play
(the same mascot beat the landing page runs, `docs/INTRO-BASELINE.md`); the landing
page carries the sibling first-visit onboarding — the does/doesn't
pane and the ghost mascot pointing out the ghost button, inline in
`public/welcome/index.html` — see the **ui-notes** skill):
a deliberate LOOK-AND-FEEL TWIN of the main app in a KHAKI
palette (2026-07-10 directive). The same floating glass chrome, waves,
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
(`detectDrcProvider`: sk-… OpenAI, sk-ant-… Anthropic, gsk_… Groq,
hf_… Hugging Face, sk_ber_… Berget) plus
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
only to admins). **Capture reviews** (`captures/index.html` + `css/captures.css`
+ `js/captures.js`) is its OWN admin-gated page at `/captures/`, not part of
the admin UI — it was a panel section there until 2026-08-10, when the owner
moved it up a level because watching a recorded research run and filing it is
a review task rather than an ops one (so it is deliberately NOT in
`src/panels.js`'s catalog; the gate in `index.js` mirrors `/admin`'s, and the
account panel carries the admin-only door beside "Admin interface").
`js/captures.js` is the review FEED — every capture in the open list on one
scrollable page (2026-08-13 owner directive; it was a one-card deck that
served only the next in queue), a clip mounted lazily as its card nears the
fold, a swipe RIGHT filing it as liked, a swipe LEFT opening a feedback input
field inside the card, a filed card staying in place with an UNDO that deletes
the verdict server-side, and the arrow keys plus two buttons doing the same
two things so a gesture is never the only way to act — over the Node-tested
pure `js/captures-core.js` (the swipe thresholds and direction test, the drag
tilt, the hint overlay, the per-card filed/undo state, the pending count, the
note validation and the fact formatting). Its server half is
`src/captures.js` and the clips it plays are made by the video pipeline — see
**`docs/VIDEO-CAPTURE.md`** and the **video-capture** skill.
`js/capture-chat.js` is the LINK BACK INTO THE CHAT a clip recorded (owner
directive, 2026-08-14): the card's "💬 Continue this chat" opens
`/?capture=<id>`, and `app.js` hands the id here, where the recorded
conversation (`GET /api/admin/captures/:id/chat`) is written into local
encrypted history under the stable id `capture-<id>` and opened — so it
continues like any other chat, and reopening a capture already continued
returns the READER's version rather than resetting it. The same module renders
the drawer's **Recorded runs** expandable (`#capturechats` in `index.html`,
called from `js/history-ui.js`), which lists the recent runs, hides itself
entirely for a session that cannot read the admin captures API, and shares its
pure half — the seed, the URL, the link wording, the rows — with the server in
`js/captures-core.js`.
**Published apps** (`apps/index.html` + `css/apps.css` + `js/apps.js`) is the
other standalone page, at `/apps/`: the management surface over what Agent
Studio has published to `/app/<slug>/`. Unlike `/captures/` it is NOT
admin-gated — every signed-in account sees its own apps, and an admin can
additionally ask for everyone's (`?all=1`), because an app belongs to the
account that built it. It is deliberately READ/UPDATE/DELETE only: the "C" of
CRUD stays in the chat, and the empty state's job is to say where rather than
the page growing a second builder. Rename, per-file editing (an edit
republishes the whole bundle at the same URL and keeps `createdAt`) and delete
all run over the Node-tested pure `js/apps-core.js` — the title cap, the four
sort orders, the diacritic-folding search that finds "Sökratisk handledare" by
typing `sokratisk` (invariant 6), `canManageApp`, the two edit planners, and
the byte/relative-time formatting — which `src/apps.js` re-exports rather than
restates, so a cap cannot mean one thing in the API and another in the UI. A
row whose meta failed to parse still LISTS, which is deliberate: this is the
only surface that can delete a broken build. Vendored libs in
`vendor/` (`marked` and `DOMPurify`
for Markdown rendering + sanitizing; `mermaid.min.js`, lazy-loaded by
`markdown.js` only when an answer contains a mermaid diagram block;
`jsPDF`, lazy-loaded by `report.js`
for the PDF report; `pdf.js` for parsing PDF attachments client-side;
`vendor/xterm/` — the sandbox terminal `@xterm/xterm@5.5.0` + fit addon,
vendored 2026-07-15 with SHA-256 pins recorded in `sandbox.js`, so a CDN
outage can't break the sandbox; `vendor/transformers/` — transformers.js +
its onnxruntime WASM, loaded only by the on-device inference worker; the
CheerpX engine stays a CDN load pending its license question). Per-library
versions, sizes, licenses, load triggers, rationale, and the full SHA-256
manifest: **`docs/DEPENDENCIES.md`**.

The app kit (`public/app-kit/dr-provider-kit.js` — the standard API-key +
model picker every Agent Studio build ships, feedback #66, 2026-08-10). It is
the one file here that is NOT part of this site's own UI: it is a dependency-free
CLASSIC script (one global, `DRKit`; no imports, because an opaque-origin
sandbox is the least forgiving place to rely on module resolution) that
`src/app-kit.js` INJECTS into a published build. It carries a copy of the
browser-callable provider registry — the same ids, base URLs, key patterns,
curation rules and static fallbacks as `public/js/drc-providers.js`, and the
country-of-processing flags of `public/js/provider-region.js` — plus the live
`/models` fetch, the flag-prefixed dropdown, and both wire dialects, so a
generated agent gets the site's own key→models→flags behaviour instead of
inventing a bare key field and a hardcoded model id. A copy that drifts is
worse than no copy (every published app carries a frozen snapshot of it), so
`dr-provider-kit.test.js` PINS the copy against both originals — evaluating the
script the way a browser does — and a provider added or re-curated on the site
must be added or re-curated here in the same commit. Since capture #CAP-22
(2026-08-12) the kit has a SECOND mode beside the key picker: `DRKit.hosted()`
reads the publish-time config `js/dr-app-config.js` and runs the app on the
site's own model access, pinned to a model, so a published agent works for
whoever opens it without a key being typed in. The two modes return the same
controller shape, so `DRKit.chat`/`chatStream` are unchanged; the difference is
a privacy difference, and `.note()` is the sentence that states it.

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
imagery, turn buttons) over its Node-tested pure core `js/street-core.js`
(the compass line, the escaped spawn captions, the overlay placement style),
`js/battle.js` (plays back the server's battle
event list), `js/api.js` (fetch wrappers), `tokemon.css`. All game RULES
live server-side (`src/tokemon.js`, `src/tokemon-nav.js`); the page only
presents. The
site-wide `Permissions-Policy` grants `geolocation=(self)` for this page.

Outrospection (`public/outrospect/` — the outward-looking control view at
`/outrospect/`, signed-in like the rest of the app): `index.html` (the
newsprint front-page styling — introspection's titanium is clinical, this is
a tabloid on purpose) + the page module `public/js/outrospect-view.js`, which
does three things in order. It RENDERS the merge of both halves of the feed —
the committed artifact `/outrospect/feed.json` (bulk-filled offline by
`scripts/outrospect-scan.mjs`) and the live rows from
`GET /api/outrospect/feed` — through the core's `mergeFeed`, so the page works
even signed out of one half or the other. It LOOKS: shortly after the first
paint it fires `POST /api/outrospect/refresh` on the visitor's behalf, the
server picks whichever lens has gone stalest, and anything new streams in at
the top with the NEW flash without a reload — visiting the page is what keeps
it current. And it offers the SHORTCUT back: a note written here posts to the
ordinary `/api/feedback` queue tagged with feedback-core's `strategy` scope
and the lens it was written under (`strategyPageTag`), so the development loop
reads it as an operative/strategic idea rather than triaging it as a defect.
Every item's title and teaser come from the open web, so the whole feed is
built with `createElement`/`textContent` — nothing on this page goes through
`innerHTML`. The page also reports how many articles a refresh read in full, since the
quoting the chat mode does depends on it. Deterministic logic lives in the shared pure core
`public/js/outrospect-core.js` (Node-tested), which `src/outrospect.js`
re-exports server-side and `scripts/outrospect-scan.mjs` imports in Node — one
implementation, three faces, so a scan and a visit can never disagree about
what counts as new. See `docs/OUTROSPECTION.md`.

The outward feed as the outrospection session's HISTORY
(`public/js/outrospect-feed.js`, owner directive 2026-07-26): entering the
outrospection agent no longer opens an empty chat — the feed IS the session's
history. `openFeedSession` loads both halves (committed artifact + live rows,
merged by the core's `mergeFeed`), `mountFeedHistory` renders the newest page
into the chat scroller with newest at the BOTTOM and older pages prepended on
demand (`feedPage`, scroll position pinned so loading older entries never
yanks the view), and `indexFeedLocally` indexes the WHOLE feed into this
browser's RAG store in the background. The reader/model split is the design:
the reader gets the full list paged, the model gets `FEED_RETRIEVE_K`
semantically retrieved entries (`outwardExcerptsFor` → `outwardExcerptBlock`),
because sending "the newest 24" would silently truncate the feed to recency.
The index is incremental (`unindexedItems` over a localStorage key hint, so a
revisit re-embeds only new entries) and is written with `mirror: false` — the
one RAG doc that must NOT mirror to the server, since `appendToDoc` re-pushes
the whole doc and this one is public web content the Worker already holds in
D1. Wired in `app.js` (`openOutrospectionFeed` on mode switch, new chat, and
boot; only ever into a BLANK session) and `stream.js` (the excerpt block rides
out with the question, exactly like document excerpts). Fail-soft end to end:
no feed, no index, or no network each leave the ordinary empty chat and the
server's own newest-first retrieval. Styles are the mode's own newsprint
variables (`.outro-*` in `public/css/app.css`).

Space animations (`public/space/` — the PUBLIC showcase at `/space/`,
allowlisted like `/pulse/`): an archive of playable wireframe 3D
animations answering common space questions, with log-scale zoom spanning
planet radii to light-years. `index.html` (markup + the dark space
styling; the one page that is dark by nature — the scene IS the night
sky) + `space.js` (the gallery chrome: cards, chips, the EN/SV language
toggle, the ask-box that routes a typed question to its scene via
`spaceIntent`, and the per-card 👍/👎 feedback POST). The playable canvas
itself lives in the EMBEDDABLE renderer `public/js/space-embed.js`
(feedback #18): the stage + play/pause/speed HUD, drag-to-rotate and
pinch/wheel zoom, the per-kind scene runners —
compare/orbits/launch/surface/rings/travel — and a shared
IntersectionObserver-gated play loop, all behind `mountSpaceScene(host,
sceneId, {lang, caption, moreLink})` with self-injected `sp-` scoped CSS.
The gallery mounts it per card, and BOTH tiers' chats mount it across the
response area when an outgoing question matches a scene — since feedback #49
through the capability-demo registry `public/js/demo-core.js` rather than
`spaceIntent` directly (`public/js/turns.js` `mountDemoEmbed` on Se/rver —
live sends and stored renders, by deterministic re-detection, no
embeds-registry entry; `public/cure/drc.js` `mountDrcSpaceEmbed` on
Se/cure), the research answer streaming below. The rendering rule is the domain's identity: background
stars — and only stars (the Sun, Proxima, the light pulse) — get real
additive glow; every body, craft and figure is unlit wireframe. All
deterministic logic lives in the shared pure core
`public/js/space-core.js` (Node-tested; served publicly — the same
public-module-graph rule as the /cure entries; `spaceIntentMatch` adds the
matched language for the embed's caption), which `src/space.js`
re-exports server-side. See `docs/SPACE-ANIMATIONS.md`.

The capability-demo registry (`public/js/demo-core.js`, façade `src/demos.js`;
the shared mount decision `public/js/demo-mount.js`; card renderer
`public/js/demo-embed.js`; all allowlisted under the same public-module-graph
rule as the /cure entries): the deterministic EN+SV gate that answers "is this
message asking to be SHOWN one of the site's own surfaces, and which one?" —
feedback #49's *"all individual capabilities should be callable like this,
show me x demo for instance"*. Two kinds: a `space` entry delegates subject
matching wholesale to `space-core.js`'s `SPACE_MATCHERS` (one space matcher,
no drift) and renders inline; a `page` entry renders a link card.
`demoIntent(text, priorText)` also lets a BARE visual ask ("show me visually",
"visa visuellt") inherit the subject of the turn before it — feedback #50's
real sequence. `demo-mount.js` owns which of the two mounts and which module
is fetched for it, so the two tiers cannot drift (`turns.js`
`mountDemoEmbed`, `drc.js` `mountDrcSpaceEmbed` keep only their DOM
placement); its synchronous `demoSurfacePossible` pre-gate answers "is it worth
placing a host element" using demo-core alone, so an ordinary turn never pays
for a renderer. `src/pipeline.js` re-runs the SAME gate to set the answer
prompts' `spaceScene` / `demoSurface`, so the model leads with the shipped tool
instead of researching the web for a capability the site already has. Decorative-additive throughout: the answer
streams below regardless, which is what lets the patterns be generous. A new
surface costs one registry entry and no edit anywhere else.

Project pulse (`public/pulse/` — public, allowlisted like `/space/`): the
commit-analytics dashboard. `index.html` (commits / lines / new features as
small-multiple bar charts over `data.json`, plus the code-size snapshot from
`size.json`) and `timeline.html` (the FEATURE FOCUS timeline over
`timeline.json`: which feature sets the commits were about, as competing
lines or a streamgraph, with wheel/drag/brush zoom-and-pan, the curve picker,
and a table fallback). All three datasets are committed and regenerated by
`scripts/build-pulse*.mjs`; no server code, no build step. What counts as a
"feature set" is one place only: the subject taxonomy in
`scripts/pulse-themes.mjs` — a key, label, colour, blurb and one RegExp per
subject, matched against the commit SUBJECT line, tagging each commit with
zero to many subjects. It is a keyword heuristic over git text — no model, no
network — and it takes Swedish forms alongside English like every other
routing pattern here. Treat a new subject as an ADDITION: renaming or dropping
a key silently drops it from every returning visitor's saved curve selection.
A SECOND surface draws the same dataset: the compact feature-focus card on
the landing page (`public/welcome/`, under the promo video), where chips turn
an individual feature's graph on and off, and which hides itself if the
dataset can't be read. That card adds one series the full page does not draw:
the CODE-VOLUME backdrop, a filled area behind the curves showing how many
lines the tree held at the end of each day, on its own right-hand scale in
thousands. Its readings are measured, not accumulated — `build-pulse-timeline`
counts the whole tree at each day's last commit and writes them into
`timeline.json`'s `volume` block, so the curve's right-hand end agrees with
`size.json`'s line total. So the timeline's maths — time bucketing, the metric,
how a commit tagged with several subjects is weighed in each mode, the
y-scale, the dark-mode colour lift, which subjects are "the busiest six", and
the volume area and its scale — lives in the shared pure core `public/js/pulse-timeline-core.js`
(Node-tested, public, no DOM and no fetch). Both pages import it, so neither
can drift into its own idea of what a curve means; the landing keeps only the
small drawing, the full page keeps the gestures. See the
**commit-analytics** skill.

Client modules not covered by a section above, each one file under
`public/js/`: `docs.js` (attachment parsing — pdf/docx/md/txt, entirely
in the browser, so file bytes never reach the server) and `docs-viewer.js`
(the public `/docs/` viewer, rendering every repo doc out of the committed
`docs-corpus.json`); `doc-comment-gate.js` + `docs-comments.js` +
`docs-comments-core.js` (documentation COMMENT MODE, in three layers. The
GATE is public and is the whole per-page cost — one script tag,
`mountCommentMode({path})` — doing the `/api/me` admin check and rendering a
visible note when the answer is no. The DOM half injects its own Read/Comment
dropdown, comment rail and styles as fixed chrome, so it mounts on ANY
documentation page without that page laying out for it; it is GATED,
dynamic-imported only after the admin check, and deliberately NOT on the
public allowlist. Taking no layout from the page means the rail can only
OVERLAY the prose, so it is something the reader opens rather than something
that appears: read-only mode never opens it, the counter in the mode slot is
the switch, a highlighted passage is the other way in, and the rail carries a
✕ (feedback #40, 2026-07-26 — an iPhone got a dark pane over the documentation
with no way to dismiss it). On a phone it sits along the BOTTOM, sized to its
content, with the marked passage scrolled clear of it. The pure core owns the
stored body grammar, quote anchoring, stale detection and `railVisible` (when
the rail is on screen). Live on `/help/` (the page the app links as
"documentation") and `/docs/`. A comment is filed into the ONE instruction
pipeline, the feedback queue, with feedback-core's `doc` scope and the
document's repo path in the `page` tag, so the loop reads it as an instruction
to reconcile the document AND the code it describes. See
`docs/DECISION-BOARD-LOOPS.md` §1a);
`provider-region.js` (the country-of-processing badges
on the model selector — the conversation goes wherever the chosen model is
hosted, so the selector says which country that is); `canned-faq.js` (the
deterministic, non-LLM get-started responder both tiers use before a model
is configured); `deeplink-core.js` (the pure parser behind shareable
"open with a question ready to ask" URLs) and `agent-preview.js` (the
agent-registry preview surface at `public/agents/preview.html`);
`sandbox-files.js` (the file-mounting pure core for EVERY execution
environment — `planMounts` (the one plan they all mount from, called by
`sandbox.js`'s `preparePlan` and by the remote runner), `planRemoteMount` (that
plan as one ustar archive + the symlink script), `planSourceMount`, the
`/workspace` + `/mnt` layout, the tiered ingest; see
`docs/SANDBOX-HOST-COMMANDS.md` part B) and `boot-messages.js`
(the rotating boot-bar quips shown while the CheerpX VM streams and boots);
`exec-backends-core.js` (the EXECUTION-ENVIRONMENT seam's shared pure core —
the execution counterpart of `websearch-backends-core.js`: the backend
registry (each entry declaring the `tiers` it may be offered in),
`normalizeExecBackend`, the **DREE/1** client (`GET /healthz` + `POST /exec`,
plus the two OPTIONAL capabilities `POST /mount` and `POST /source`,
`probeRunner`/`makeLocalRunner`/`makeContainerRunner`), and `selectRunner`,
which returns the in-browser-VM bridge UNCHANGED unless a remote environment is
fully configured AND allowed in the caller's tier — so the default path can
never regress and Se/cure can never select the server-side container
(invariant 4, pinned by `exec-backends-core.test.js`); both tiers import it)
with `exec-env.js` (its Se/rver glue: the browser-local `dr_exec_env` config —
per DEVICE, since a runner lives on one machine and its URL/key then never
reach the server — the per-tab `execSessionId()` that keeps one conversation on
one machine, `releaseExecSession()` on New chat, and the gear-panel section with
the ⓘ docs and Test connection), the reference runner
`public/cure/local-exec/runner.mjs` (one dependency-free Node file: auto-detects
Apple `container`/docker/podman/nerdctl, one throwaway container per research
session, `NETWORK=none` by default, and `POST /mount` streaming the page's files
into `tar`) and its setup page `public/cure/local-exec/index.html`
(`/cure/local-exec`, a reserved replay slug); the server-side third environment
is `src/exec-container.js`; see `docs/EXECUTION-ENVIRONMENTS.md`;
`agent-backdrop-core.js` + `agent-backdrop.js` (the agent activity
backdrop, split pure-core/DOM per the pure-core convention); and
`umbrella-spinner.js` (the Se/cure intro umbrella, shrunk and looped as a
waiting spinner).

Ancient-sample corpus (`public/js/aadr-core.js` + `scripts/aadr-build.mjs` +
the built `public/aadr/samples.tsv.json`, server façade `src/aadr.js`): the
structured half of the `palaeogenomics` agent. The pure core owns the artifact
parser (a JSON envelope whose bulk is one dictionary-encoded TSV blob, read into
columnar typed arrays), the bilingual query parser (radius with a Swedish `mil`
= 10 km, BP/BCE/CE date windows against the 1950 radiocarbon zero, haplogroup
prefixes, coverage floors, sex — invariant 6), the filter engine (haversine
radius, date-INTERVAL overlap rather than midpoint, one-way haplogroup prefix
matching) and the rendered block. Three design points carry the module: places
are resolved against the corpus's OWN dictionaries rather than a geocoder, so a
structured query makes no outbound request at all; `Ignore_`-prefixed
individuals — the AADR/Poseidon convention for contaminated, duplicated and
unusable samples — are excluded by default and reported; and a zero-match query
still emits a block SAYING so, which is what stops an answer reaching for
remembered sample ids. The build script fetches the Poseidon Web API once
(`/individuals` with the requested `.janno` columns — a 28 MB un-paginated
response), dedupes on `isLatest`, and repairs the upstream's double-encoded
UTF-8 so Swedish site names stay searchable in Swedish. The artifact is excluded
from the source snapshot (`scripts/bundle-source.mjs`) — it is generated data,
not source. See `docs/PALAEOGENOMICS.md`.

Person-research method (`public/js/person-research-core.js`, server façade
`src/person-research.js`): the pure core of the feedback #60 fix's second half.
It holds two things and nothing else — the CONJUNCTIVE bilingual gate
(`personResearchIntent` = `personResearchShape` AND `personReferent`, so "what
can you find on this founder" fires and "what can you find about this API" does
not) and `personResearchBlock`, an ~874-word constant carrying the OSINT method:
plan, source ladder, verification, guardrails, writeup, and the house-style
`USING THIS BLOCK` tail that stops a model citing the methodology as a finding.
No data, no lookup, no I/O — the whole module is a regex pair and a string, so
it is free to build and cannot fail. Invariant 6 is load-bearing here twice
over: every pattern uses lookaround boundaries with the `u` flag rather than
`\b`, and the bare Swedish subject pronouns (`han/hon/hen`) are admitted only
in a Swedish-shaped message, because in English "han" is the Han dynasty and
"hen" is a bird. See `docs/PERSON-RESEARCH.md`.

Entity-research method (`public/js/entity-research-core.js`, server façade
`src/entity-research.js`): the sibling module, from feedback #64, and built the
same way — a bilingual gate plus constant text, no data and no I/O. What differs
is what the gate reads. person-research's is CONJUNCTIVE because its phrase list
is broad and needs a person referent to be safe; this one stands ALONE, because
the request it exists for ("Osint on revsec") carries a bare token no referent
test can classify, and the name turned out to belong to four unrelated
organisations. Standing alone is paid for on the other side: the phrase list is
narrow enough that each entry means a dossier by itself (`osint`, `due
diligence`, `dossier`, `bakgrundskoll`, `hotbild`, `angreppsyta`), and the
ordinary research vocabulary is kept out — including "security assessment" and
`säkerhetsgranskning`, dropped from BOTH arms rather than one, since the pair is
equally ambiguous in either language against introspection's OWASP code review.
`entityResearchBlock(reportTier)` is a function of the tier rather than a flat
constant: the subject-resolution half is the same bytes every turn, the report
scaffold behind it is one of four. See `docs/ENTITY-RESEARCH.md`.

Query focus (`public/js/query-focus-core.js`, server façade
`src/query-focus.js`): the module that keeps a planned search angle pointed at
the subject rather than at the report the user named — feedback #65's
deterministic half, and pure like its two neighbours above (two word lists, four
functions, no I/O). `contentWords` tokenises with a `\p{L}`-class pattern rather
than `\w`/`\b`, which mangle å/ä/ö; `subjectTokens` is those words minus
stopwords minus the FORMAT vocabulary (report standards and format nouns —
tiber, gtir, cbest, swot, dossier, report, framework, template, guidance,
example, and rapport, hotbild, hotanalys, bakgrundskoll, underrättelse, ramverk,
mall at equal breadth per invariant 6), so an empty result means the request IS
about the format; `isFormatChasingQuery` is true when a query reaches for a
format word and for none of the subject's words, both halves load-bearing (the
first keeps an ordinary widening angle out of the way, the second lets a mostly
format-worded query stay when it is on topic); `focusQueriesOnSubject` drops
those angles, returns its input untouched whenever a gate fails or the input is
malformed, and falls back to one query built from the subject's own words rather
than to nothing. See `docs/ARCHITECTURE.md` §4.2c.

Google Scholar metrics table (`scripts/scholar-venues.mjs` + the built
`public/scholar/venues.json`, read by `src/scholar-venues.js`): 4,652 venues
with h5-index and h5-median, harvested once a year from the robots-ALLOWED
`citations?view_op=top_venues` pages — the landing top-100, Scholar's eight
subject categories, and every subcategory those link to (`--deep`, one page per
2.5 s). It is a build artifact for the privacy reason as much as the caching
one: a per-turn lookup would tell Google which journals every research question
on this site is about, and the artifact makes the number free and the request
count zero. Rows are positional (`[name, h5, h5median, cats]`) rather than
objects — 4,652 objects is roughly three times the bytes for no added meaning —
behind a `version` the runtime parser checks, so a future layout fails soft to
"no annotation" instead of being mis-read. Two traps are recorded in the script:
hrefs arrive entity-encoded, so a `[?&]vq=` match finds nothing and the first
`--deep` run harvested zero subcategories while reporting success; and the
`gsc_mvt_*` class names also appear in the page's inline stylesheet, so the
three cells of a row are matched as one unit or CSS selectors get harvested as
venues. See `docs/SCHOLAR.md`.

arXiv RAG search database (`public/js/arxiv-rag-core.js` + `scripts/arxiv-*.mjs`
— a research database over arXiv since late 2023; the build tooling is not part
of the deployed Worker, though `src/arxiv-rag.js` serves the resulting index): the pure core owns passage construction (the four embed strategies and
the sliding-window splitter), the Unicode-aware tokenizer and BM25 index, RRF
fusion, max-pool doc scoring over the packed int8 matrix (`denseSearchPacked` /
`packedNorms`), the evaluation metrics, and `recapForContext` — the recovery
from Berget's hard 512-token rejection. It also holds `INDEX_ABSTRACT_FLOOR`,
the 200-char membership rule (moved here 2026-08-09 from three separate
declarations): `arxiv-vectorize.mjs` APPLIES it, `arxiv-corpus.mjs` draws the
local pack from the same population so the local and hosted nDCG columns stay
comparable, and `arxiv-harvest.mjs` only PREDICTS the drop so a named `--ids`
list can be answered before a paid fill — three consumers of one number, where
a drifted copy reports confidently wrong and fails nothing.
`rag-eval.mjs`'s own `--min-abstract` default deliberately stays a literal: it
runs over BOTH corpora, so binding it here would make a PubMed sample follow an
arXiv constant. Vector maths is not reimplemented: the
int8 codec and cosine come from `introspect-core.js`, the project's one
implementation. Around it, `scripts/arxiv-harvest.mjs` (OAI-PMH bulk harvest,
month-sharded and resumable), `arxiv-corpus.mjs` (dedup + deterministic
sampling), `arxiv-berget.mjs` (the Berget-only surfaces — `bge-reranker-v2-m3` and JSON
chat; embedding moved to the registry below), `arxiv-index.mjs` (the binary index pack),
`arxiv-search.mjs` (the four retrieval pipelines) and `arxiv-goldset.mjs` +
`arxiv-eval.mjs` (the query sets and the measured bake-off). Three more cover the
HOSTED index rather than the local pack, which is a different pipeline and the
one users actually hit: `arxiv-hosted.mjs` (a Vectorize REST client plus a
faithful replay of `src/arxiv-rag.js`), `arxiv-hosted-eval.mjs`
(`sample`/`coverage`/`run`/`compare`/`judge` — gold papers sampled by id from an
independent enumeration, never by querying the index, which would select for
papers that retrieve well) and `arxiv-crosscheck.mjs` (per-month diff of a
harvest against that enumeration — a harvest cannot detect its own gaps, and
both recorded coverage holes reported themselves as successful runs). The
hosted-eval harness was then generalized across corpora on 2026-08-01, when
PubMed shipped 1.6 M vectors with no way to measure them at all:
`rag-corpora.mjs` is the corpus registry (and imports the pool, floor, rerank
cut and query prefix straight from `src/dense-rag.js`, so a replay cannot drift
from production the way `arxiv-hosted.mjs`'s own `CANDIDATES = 20` silently
did), `rag-hosted.mjs` is the Vectorize client and the replay,
`rag-eval-core.mjs` is everything pure — the window arithmetic, the rank
bookkeeping, the paired McNemar that decides each verdict, and the
graded-relevance JUDGE (`GRADER_SYSTEM` / `gradeMessages` / `parseGrades`,
shared since 2026-08-03 because gains are comparable only across runs that used
the same rubric) — and `rag-eval.mjs` is the CLI over all three
(`npm run rag:eval`, `pubmed:eval`). The `arxiv-hosted*.mjs` pair remains as
the arXiv-shaped entry point. The built database
lives under gitignored `data/`; the code, the query sets and the findings are
committed. PubMed RAG search database (`public/js/pubmed-core.js` + `scripts/pubmed-*.mjs`
— the biomedical corpus beside arXiv, added 2026-07-31; the build tooling is not
part of the deployed Worker, though `src/pubmed-rag.js` serves the resulting
index): the pure core owns the streaming XML block splitter, the record parser
(including the own-PMID trap — a naive `<PMID>` match also picks up every cited
PMID in `<CommentsCorrectionsList>`), structured-abstract assembly with its
section labels kept, PubMed's free-text `<MedlineDate>` forms, the keep/drop
filters that state their reason, the newest-first file plan and the
`windowNote()` that says on every run that `--min-year` TRIMS the window rather
than defining one. It REUSES `arxiv-rag-core.js`'s passage seam
(`PASSAGE_PREFIX`, `buildPassage`, `MAX_PASSAGE_CHARS`) because both corpora are
embedded by the same model into the same index shape. Around it,
`scripts/pubmed-harvest.mjs` (the NLM FTP baseline + daily update files, newest
file first, resumable, one archive file on disk at a time because the archive is
64 GB gzipped against ~30 GB of writable disk — and parsing FROM DISK rather than
off the socket, since ten seconds of blocking parse inside a response stream gets
the connection torn down and surfaces as a bare `Error: terminated`),
`pubmed-enumerate.mjs` (the SECOND, INDEPENDENT enumeration via E-utilities
`esearch` over the EDAT axis, plus a sampled PMID set-difference — a harvest
cannot detect its own gaps), `pubmed-corpus.mjs` (dedup — 25.9% of update-file
rows are revisions of a citation already seen, against arXiv's 3.4% — plus the
drop reasons, the abstract-length distribution against the embedder's budget, and
the publication-year spread of a window selected on load order) and
`pubmed-vectorize.mjs` (incremental embed + upsert, with `--prune` to delete
citations the archive has since withdrawn) and `pubmed-partition.mjs` (dedup
ONCE, then split by a hash of the PMID into N disjoint parts, which is what lets
the fill run as N parallel loaders — dedup has to precede the split or the 55.9%
repeats get embedded once per partition, and hashing rather than round-robin is
what keeps part membership stable so a resumed loader finds the work list its
checkpoint describes). `scripts/vectorize-upsert.mjs` is the corpus-agnostic
half of a fill — the append-only checkpoint, the plain-array `values` guard, and
the wrangler upsert — shared with `arxiv-vectorize.mjs`; its `WRANGLER_BIN`
override exists because eight concurrent `npx wrangler` calls race on the shared
npx cache and die with `ENOTEMPTY`, so a parallel fill points at an
already-installed binary instead. See `docs/PUBMED-RAG.md`.

Embedding for EVERY build-time index in the repo — the arXiv database and the
committed introspection artifacts alike — goes through
`scripts/embed-providers.mjs`, a two-backend registry (Berget and Hugging Face
Inference) over the SAME `intfloat/multilingual-e5-large` weights: verified
cosine 0.9999–1.0000, so the vectors are interchangeable and a build can fail
over mid-flight instead of dying on an empty wallet. `EMBED_PROVIDER` selects
`auto` (default), `berget`, `hf` or `both`; the work-stealing pool carries a
straggler guard so a much slower second backend can never lengthen a run.
See `docs/ARXIV-RAG.md`.

Test helpers (`src/test-helpers/`) — not product code, and therefore not rows
in the table above, but part of the `src/` tree and worth finding. Three
modules the unit suite builds on: `d1.js` (one D1 fake, replacing fifteen
hand-rolled ones of fifteen different fidelities — it does not parse SQL, it
matches on it, RECORDS every statement with its bindings so a test can assert
that some statement never ran, and can be told to fail on a pattern),
`fetch.js` (an outbound-request recorder, so "no outbound request carried the
user's identity" is one assertion rather than an ad-hoc check per suite), and
`env.js` (the `env`/`log`/`identity`/`ctx`/`assets`/`R2` factories that make
every `(request, env, log, identity)` handler in `src/` reachable from a unit
test without a browser, a credential, or the network). Tested by
`src/test-helpers.test.js`; excluded from the coverage measurement in
`scripts/coverage.mjs`. See `docs/TESTING-CAPABILITIES.md`.
