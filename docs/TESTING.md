# Testing — what covers what

The full test-surface enumeration, moved out of CLAUDE.md (2026-07-17).
The commands and the live-verification rule stay in CLAUDE.md; this file
is the per-suite detail: what each unit suite covers, the end-to-end
(Playwright) projects and their fixtures/sandbox quirks, and the five
eval harnesses. Keep it current in the same commit that adds a test
suite (the update-docs skill's drift greps target this file).

Its companion is `docs/TESTING-GAP-ANALYSIS.md` (2026-07-24): the same
surface reviewed as a system — what is automated, what is covered, and
the ordered list of what is missing. This file says what exists; that
one says what does not.

A second companion, `docs/TESTING-CAPABILITIES.md` (2026-07-29), adds the
axis neither had: capability × how automatable it is, MEASURED rather than
inferred (`npm run coverage`), with the five testability tiers, a
capability-by-capability classification, and the coverage ratchet that keeps
the untested surface from growing back.

## Unit tests (`src/`, `public/js/`, `public/games/`, `sdk/`, `scripts/`, `tests/`)

`npm test` runs six globs: `src/*.test.js`, `public/js/*.test.js`,
`public/games/*/js/*.test.js`, `sdk/*.test.mjs`, `scripts/*.test.mjs` and
`tests/*.test.js`. The first three are the Worker and the client, described
below; the last three are the tooling suites, in their own section at the end.

Node's built-in test runner (`node:test` + `node:assert/strict` — no test
framework, matching the project's minimal-dependency stance; the suite does
need `npm install` first, see `docs/DEPENDENCIES.md` §5),
covering the pure logic and mockable seams that don't need a live
Berget/Exa/D1: `budget.js`
(time-tier planning, deadline grace math), `quota.js` (window
start/reset including month-boundary wraps, quota merging/clamping,
breach detection, cost calc), `model-profiles.js` (override merging,
clone-not-share of nested fields), `alerts.js` (error classification),
`conversation.js` (message/content helpers, plus `withoutMethodBlocks` — an
appended method block removed from string and multipart content, the
attachment surviving the strip, both method blocks removed when both
enrichments fired, assistant turns and the caller's array left alone, and the
same reference back when nothing was stripped), `validation.js` (message
and image caps, model resolution), `prompts.js` (structural assertions
on every prompt builder — the anti-injection note, the independent-
source rule, the JSON-only reinforcement toggle, and the subject-vs-format
rule in `triagePrompt` and `gapPrompt`: a named report format is the shape of
the answer and never a search target, a format-only message resolves its
subject from the conversation, and the Swedish formats named beside the
English ones per invariant 6), `chat.js`
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
`backfillOverflowSources`, `sourceDigest` — the domain-diversity logic, plus
the digest's SHARED budget: the measured feedback-#61 production shape
(thirteen ~1,300-char literature blocks ahead of twenty ~400-char web pages)
asserted visible in full at both the 18,000- and 24,000-char caps and at a
tighter 14,000, with only the verbose blocks clipped, the tail's excerpt
untouched and citation numbers stable and in order; dropping still happens,
and is still reported, once even the floor share cannot fit; and the fail-soft
cases where a malformed entry or an absent cap must degrade rather than cost
the prompt its evidence base. The digest MOVED to `source-digest.js` on
2026-08-06 and `sources.js` re-exports it, so these behavioural cases
now also pin that seam),
`source-digest.js` (the same digest at its own module, covering what the
behavioural cases above cannot state while the share solver is reached only
through rendered output: max-min fairness as a PROPERTY — a short source keeps
its slack rather than being clipped to an equal split of the budget, the share
chosen is the largest the budget affords, and both shown-count and digest
length are monotone in the cap across the whole range, which is where an
off-by-one in the binary search hides. Perturbation-checked: an equal-split
solver turns two of the three red. Plus an identity assertion that
`sources.js`'s re-export IS this module's function, so a later tidy into a
wrapper fails at the seam instead of downstream in a prompt),
`settings.js` (`parseSettings` coercion, `storageAvailability`, the
generic `extensionEnabled`/`extensionEnabledMap` knob gates),
`extensions.js` (the extension registry — the six seams core consumes
generically, the shipped knob/meta wire names, the `contextBlock` seam
added 2026-08-13 with its uniqueness and `serverOnly` assertions and the
knob-AND-capability truth table, and the CORE-PURITY GUARD:
it fails the build when a core module names a third-party service in code
or imports an integration module directly, which is what keeps CLAUDE.md
invariant 7 from rotting; see `docs/ARCHITECTURE.md` §4.2a),
`cyber-exclusivity.js` and `literature-exclusivity.js` (the two OWNERSHIP
guards, both over the SHIPPED `sdk/AGENTS.json` rather than a fixture, because
exclusivity is a claim about every OTHER agent and nothing fails when one
quietly gains a block. The cyber suite pins `entity-method`, `person-method`,
`host-intel` and `street-imagery` to `cyber` alone and `owasp` to `cyber` +
`introspection`; the literature suite pins `literature-arxiv` /
`literature-pubmed` / `literature-peer-reviewed` from both ends — which agents
may declare each, and which sources a real resolved capability then reaches —
including palaeogenomics keeping Europe PMC and NOT getting arXiv, and the
deliberate fail-soft hole where a NULL capability keeps every source, which is
how `POST /mcp` and the ground-truth batteries still reach both corpora),
`rag.js` (`validateRagIndexPayload`, the base64⇄Float32 vector codec,
the `idOk` key-path id validator shared with `storage.js`),
`vault.js` (the project-vault endpoints against a mocked R2 bucket:
id validation, PUT/GET/DELETE round-trip, size/count caps, per-user
namespacing, and the works-with-the-knob-OFF guarantee),
`pub.js` (published research replays: slug rules incl. the dot-free
asset-collision guard, `validatePublication`, the publish → public read
→ index → unpublish round-trip against a mocked R2, storage-missing
503s),
`apps.js` (the published-apps management surface against a mocked R2: a
listing scoped to the caller with `?all=1` widening it for an admin and
silently NOT for anyone else, `?q=`/`?sort=`/`?format=text` delegating to the
core, a corrupt `meta` still listing — the case that decides whether a broken
build can be deleted at all — `can_manage` reported as ownership rather than
readability, a rename that leaves `createdAt`/`owner`/`files` alone, a file
PUT that republishes in place with `createdAt` preserved and `updatedAt`
bumped, `index.html` undeletable, a non-owner refused EVERY write with the app
verified untouched afterwards, the slug-wide delete removing every object
under it, and the unknown/bad/method/no-bucket edges),
`agent-spec-core.js` (the AgentSpec pure core: the closed control
vocabulary, spec/registry validation, control/theme/quota/example
resolution, the composer renderer + `proveComposer`), plus its capability
suite `agent-capability.test.js` — which pins every DECLARED bound against
the constant that enforces it (so a spec describing behaviour the code
lacks fails here), gives each of the four invariant rules a passing AND a
failing case (a tool-bearing agent must name a non-tool fallback; a
planning phase may not leave the fixed JSON model; a client-platform agent
may select nothing server-only; a declared gate must carry EN and SV), and
CHARACTERIZES the mode routing, including the acceptance test that a sixth
agent added only as registry data routes with no code change —
`agent-registry.js` (the per-binding registry cache, every failure path
degrading to null, and both load routes — the small dedicated
`public/introspect/agents.json` artifact first, the source snapshot as the
fallback), `prompt-sets.js` (the prompt-set binding,
identity-checked against the shipped builders so a re-pointed prompt fails
the suite rather than a request, plus totality: no state can leave a phase
without a prompt), `agent-link.js` (the share-link mint against a mocked
D1 + ASSETS: the JWT verifies through the real verifier and the meter rows
carry the spec's quota),
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
incl. the Swedish-parity suite — which is STRUCTURAL, walking the exported
vocabulary tables so a Swedish word added without an English twin fails the
build — geodesy round-trips, and the pinhole-camera spawn projection checked
against its closed form), and `tokemon-api.js` (the street-view HANDLERS over
an in-memory D1 fake with the two Google calls stubbed at `globalThis.fetch`:
`…/go` validation, absolute vs heading-relative moves, bilingual replies, the
Maps-knob gate on place lookups, `…/scene`'s four fail-soft `available:false`
reasons, and the overlay decoration — `near` measured from the PLAYER while
the camera sits at the PANO).

Three REPO-WIDE guards sit alongside the per-module suites, scanning the tree
rather than importing one unit (the `sql-injection-guard.test.js` pattern):
`swedish-boundary.test.js` (invariant 6's silent killer, added 2026-07-30.
JavaScript defines `\b` over `[A-Za-z0-9_]`, so a regex alternative that starts
or ends in `å`/`ä`/`ö` can NEVER match when a `\b` sits against it. `/\bär\b/`
is dead, and so is the `nivå` half of `/\bvilken\s+(?:nivå|version)\b/`. It
fails in the worst way available: the English half of a bilingual gate keeps
matching, so an English-only suite stays green while the Swedish half is inert.
The guard scans every non-test module under `src/`, `public/js/`,
`public/cure/` and `public/games/`, parses each `\b(…|…)\b`-shaped group, and
fails naming every unmatchable alternative and the fix, which is lookaround
boundaries with the `u` flag: `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])`, the idiom
`src/europepmc.js:112` names `B`. A second test guards the guard, asserting the
trap shapes still read as dead so a scanner that stopped matching cannot report
a clean tree forever. The audit it landed with found ten dead alternatives
across five modules, two of them user-visible:
`extractPlace("Vad finns på Storallé?")` returned nothing at all, and
`"street view Storgatan på Gotland"` dropped the city);
`artifacts.test.js` (the committed-artifact SET: every `public/introspect/`
artifact present, git-tracked, over a size floor, and parsing — the existence
half the self-skipping freshness checks can't cover, plus the doc images the
corpus references) and `facade-contract.test.js` (the façade-IS-the-core
contract across all of `src/`: it DISCOVERS façades by scanning for
`../public/js/*` imports, so a new one is covered the day it lands, and asserts
every shared export is the same function object — deliberate server-signature
divergences are recorded in its `DELIBERATE_OVERRIDES` map, so a NEW divergence
still fails). `landing.test.js` reads the tree the same way for the front door:
that the unauthenticated root serves `public/welcome/` in place rather than
redirecting, that the page still carries the video / purpose / capability list
/ MIT source line, that the two data-path diagrams stay SHARED files
(`public/architecture/path-secure.svg`, `path-server.svg`) referenced by both
the landing and `/architecture/` instead of being re-inlined into either, and
that the feature-focus card keeps its code-volume backdrop UNDER the curves on
a right-hand scale of its own (two units in one plot is the thing that goes
wrong when someone tidies the axes).
`intro-phase.test.js` is its cross-surface companion — the contract for the
whole controlled new-visitor intro (`docs/INTRO-BASELINE.md`, invariant 8):
that the APPROVED-baseline marker is still on the landing, that every door the
intro offers is reachable signed out (each landing `href` must either pass
`isPublicAsset` or name a known pre-auth route, so a new door forces the
question), that no language model is in the signed-out path, that each
first-visit key still gates its surface with every storage access wrapped and
the "seen" flag set only after the intro actually played, that reduced-motion
and the `?anim=1` override survive on all three animated surfaces, that
Se/cure's head stays free of a chrome-hiding script, and that every repo path
the contract document names actually exists.

Additional server suites cover the request/routing and infra seams:
`mcp.js` (the PURE JSON-RPC / MCP protocol helpers, asserted to load
WITHOUT pulling in the pipeline), and the three modules behind connecting an
external client to it — `mcp-key.js` (the bearer credential: the
`mck1.<payload>.<hex sig>` wire shape, a mint→verify round-trip preserving the
claims, a fresh unguessable `jti` per mint, and rejection of expired, tampered,
malformed, wrong-prefix and foreign-secret keys), `mcp-api.js` (resolving a key
to its account against a mocked D1: no bearer and another family's bearer both
fall through to the identity gate, while revocation, rotation, the master
switch, and a non-active or deleted account each stop a live key immediately,
plus the three connector strings that differ from one another — the advertised
bare origin, the `/mcp` form ChatGPT's setup form wants, and the prefilled
Claude install link, all derived from the request so a preview advertises the
preview),
and `mcp-config.js` (the per-account exposure policy: the catalog mirrors the
tool list `mcp.js` serves exactly, unreadable input degrades to the
everything-exposed default that preceded it, out-of-range budgets are clamped
rather than honoured, the master switch outranks every individual tool row, and
`filterMcpTools` drops uncatalogued names) and `mcp-inflight.js` (the
per-account concurrency gate over the spending tools: a slot is taken and
released, the refusal comes back as a JSON-RPC result rather than a transport
error so a client renders it, the free tools reserve nothing, and the two
failure directions are deliberately opposite — a reservation that cannot be
recorded fails OPEN, a quota gate that cannot be read fails CLOSED) and
`mcp-progress.js` (the SSE transport a long `tools/call` is answered on: the
last frame carries the same JSON-RPC envelope the buffered path returns,
keepalive comments and `notifications/progress` flow while the tool runs, the
progress value increases, a caller that sent no `progressToken` gets
keepalives and no notifications, and a client that did not ask for a stream
still gets plain JSON — driven through the real `handleMcp` with a fake index
that hangs until the test releases it, so the ticking is exercised without
waiting for the interval) — plus
the OAUTH CONNECTOR family that makes the surface addable in Claude and
ChatGPT (built 2026-08-03): `oauth-metadata.js` (redirect-URI matching as
DATA, so a new client is an allowlist entry and not an edit — both hosted
clients' callbacks, ChatGPT's per-connector callback as a bounded SHAPE rather
than a prefix anyone can extend, RFC 8252 loopback matching with the port
ignored but without becoming a hole, a lookalike host refused rather than
fuzzily accepted, and the protected-resource document naming exactly one
issuer at the URL the 401 points to), `oauth-register.js` (dynamic
registration: a minted `client_id` round-trips its own registration while an
identifier this server did not sign does not resolve, a CIMD id is never
mistaken for one, registration CANNOT widen where a code may be sent, one bad
`redirect_uri` refuses the whole request, and a form-encoded body is refused
with a reason that names the trap), `oauth-authorize.js` (the authorization
request: an unallowed or missing `redirect_uri` RENDERS the error instead of
bouncing to it — there is nowhere safe to bounce — while every other error
bounces with the state intact; `response_type=code` only, PKCE mandatory and
S256 only, and an unknown scope is dropped rather than fatal),
`oauth-store.js` (the code itself: the `oac1.<payload>.<hex sig>` wire shape
against RFC 7636's Appendix B vector, a code that discloses NOTHING but its
own id — user, scope and redirect stay in the row — single use enforced in D1
so two simultaneous redemptions produce exactly one winner, a wrong verifier
burning the code so there is one guess and no more while a MALFORMED one does
not, and a `plain` challenge refused at mint so no PKCE-less code can exist),
and `oauth-token.js` (the exchange: `parseTokenBody` reading form encoding
including `+` as space, accepting JSON too and sniffing an unlabelled body,
because a 415 here reads to a client as an unexplained connect failure; a
refresh token only when the granted scope carries `offline_access`; and every
rejection — wrong verifier, mismatched redirect, replayed code — as
`invalid_grant`, with each missing parameter naming itself) — plus the
LITERATURE tool family
the same clients reach (added 2026-08-01): `literature-tools.js` (the pure
half — four MCP-ready schemas, `normalizeQueries` merging `query` with
`queries` under a cap, `normalizeCorpora` defaulting to both, the date padding
that stops `since: "2024"` dropping January off an arXiv record's `YYYY-MM`,
the record mappers that keep the fields the presentation tier flattens away,
the post-retrieval filters — a category prefix matching its subcategories but
not a longer name, a corpus-specific filter that cannot empty the other
corpus, a record with no usable date surviving a date bound — `mergeRanked`
ranking corroboration above a slightly better lone score, and `capGroups`
holding the response under the record cap without starving a query) and
`literature-run.js` (the runner against fake bindings: six angles costing ONE
embedding call while the retrievals overlap, `mapPool` preserving order while
bounding concurrency, the relevance floor dropping the weak tail and an empty
result saying what it means, `similar` falling back to re-embedding when the
index returns no vector and naming the window when the seed is outside the
corpus, and every degrade path — one corpus down, the cross-encoder lost, the
embedder dead, a binding missing — reported as a described `isError` result
rather than thrown, which is invariant 2 at the tool boundary) and
`literature-authors.js` (the author leg: `authorIntent` in both languages with
its own Swedish-parity block per invariant 6 — including the ambiguous bare-s
genitive and the reported failure asserted verbatim — plus what it must NOT
fire on, the name heuristics, and the two corpora's author queries,
record mappers and interleave),
`model-routing.js` (the shared
`resolveJsonModel` split-routing decision `chat.js` and `mcp.js` both
delegate to), `pipeline.js` + `pipeline-inputs.js` (the flow's pure
pieces — `normalizeTriage`, `collectConflicts`,
`isTransientConnectStatus`, and the input-block builders/parsers, including
`searchLedgerSection`: the `Set` the pipeline actually keeps and the array
form agreeing, junk dropped, and the sentences feedback #61 turns on — that an
unsearched angle must be reported as unsearched, and that the list claims to be
every angle issued ONLY when it is one. The cap is pinned at 40 and pinned above
the planner's own 34-search ceiling, so a real request never reaches the partial
wording; a 55-angle list has to say "showing 40 of 55 issued" and drop the
exhaustiveness sentence. Guards over `pipeline.js`'s
SOURCE read the file rather than importing it, because the bug each pins was a
call site and not a unit: that every aux gate passes `ctx.gateLastUser` and none
passes `ctx.lastUser`, that the three query-writing phases (`runTriage`,
`runGapChecks`, `runSubquestionFanout`) plan from `planLastUser`/`planConvText`
and that `PipelineCtx` declares that third view built through
`withoutMethodBlocks` — the feedback-#65 guard, mutation-verified, and the first
instance of this bug class that landed outside a deterministic gate, which is
why the older guards stayed green through it — that `gateLastUser` is composed
of the clean message and
`state.imageReadText`, that the ledger is built from `state.issuedQueries` and
never from `state.ranQueries` with both dispatch points recording, that the aux
registry reserve moves `plan.digestCap` and `plan.maxSources` by the same
widening and clamps it at `DIGEST_CAP_CEILING`, and that synthesis logs
`chat.digest_coverage` off `digestShownCount`),
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
`resolveSearchBackend` env/config resolution + clamping, the user-pick
precedence — an allowed `search_source` outranks the site backend, an admin
pins it away with `allow_user_choice`, an unvalidated id selects nothing —
and the re-exported core parsers/dispatch over a mocked fetch; its client-core
sibling `public/js/websearch-backends-core.js` covers the browser-facing
`(log, resolved, query, depth)` contract directly), `websearch-cf.js` (the
Cloudflare-originating backend: the pure SERP/entity/page-text parsers, the
class-free anchor fallback and the floor that stops it believing a
no-results page's chrome, the anti-bot-shell retry, and the whole
SERP→page-excerpt flow over an INJECTED fetch — including every fail-soft
path, since "degrades instead of erroring the search wave" is the contract
that matters), `public/js/search-source.js` (the shared user pick: the
normalizer, the picker markup, and the storage helpers under a fake
localStorage AND with storage missing entirely),
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
`?format=text`), `admin-users.test.js` (the admin invite endpoint in
`admin-api.js` over an in-memory D1 — the suite is named for the endpoint, not
a module of its own: a pre-approved row for an address that has never signed
in, `pending` staging an account without granting access, an unrecognized
status falling back to `active` rather than being written raw, the sole-admin
policy that never takes a role from the request, and an address that already
has an account answering 409 both from the pre-check and from a UNIQUE
violation racing it — the sign-in side of that handshake, claiming the row, is
pinned in `google.test.js`), `testpoints.js` (the try-it queue's pure logic:
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

The surfaces added through 2026-07 are covered the same way. **Search sources:**
`arxiv.js` (the intent gate EN+SV, and the query grammar the live API actually
honours — fielded `abs:"…" AND …` ladders rather than the `all:`-with-spaces
form that silently returns nothing) and `arxiv-rag.js` (the dense tier: binding
+ embedder gating, an item shape identical to the live tier's, the rerank
document cut to the served 512-token window, and the fall-back-to-live path).
`pubmed-rag.js` covers the same ground for the biomedical corpus and adds the
one behaviour that would silently change what users see: a bound index takes
precedence over the live Europe PMC API, while an index result with nothing
above the relevance floor still falls THROUGH to it — the difference between
"the recent slice cannot answer this" and "there is no answer".
**Execution:** `exec-container.js` against a FAKE container that mimics the
documented Durable Object API — availability follows the optional binding then
the sandbox knob, session ids can't shape the DO name, `/exec` bodies are
validated rather than trusted, commands run through an explicit `bash -lc`
argv, the timeout→124 path, byte-boundary output caps, the command budget
across an eviction, and the stamp-guarded `/src` seed. **Agents and modes:**
`agent-spec.js` + `agent-bounds.js` (a declared bound NARROWS a run and can
never widen it; a malformed one falls back to the constant), `tool-sets.js`
(every tool class in the vocabulary is bound, the shipped agents reproduce
today's tool lists exactly, and REGISTRY order wins so a spec cannot reorder
it), `chat-modes.js`, and `agent-registry.js`'s ordered `defaults` table.
**Orchestrator:** `orchestrator.js` (bounded, total failure records that a
`chat_logs` field cannot grow with, and `withTimeout`'s cancel-first
ordering) and `orchestrator-api.js`. **Outrospection:** `outrospect.js` — the
façade re-exports the core registry by identity, plus refresh-body validation.
**Models:** `model-catalog.js`, `model-checks.js`, `models-agent.js`,
`user-models.js` and `hf-inference.js` cover the discovered → evaluated →
enabled lifecycle and the per-account record. **Compute sharing and
knowledge:** `pool.js` / `pool-token.js`, and `knowledge.js` (the agent key
generated once and never served private, ciphertext-only submission, revoked
tokens and blocked consumers refused, backlog cap → 429, and an owner list
that shows metadata until import decrypts). Plus the shared seams a refactor
pass extracted — `endpoint-gate.js` (the side-endpoint admission preamble),
`facade-contract.js`, `run-as.js`, `slash.js`, `starter-tag.js` (the `#XP-<nn>`
tags tying feedback back to one starter), `build-pub.js`, `sandbox-image.js`,
`static-pages.js`, `landing.js`, `server-errors.js`, `config.js`, `db.js`,
`google.js`, `log.js`, `http.js` (the shared fetch/timeout/JSON helpers every
outbound client is built on) and `sql-injection-guard.js`. **The domain
enrichments and surfaces** added since: `aadr.js` (the ancient-sample block —
corpus load through the ASSETS binding, per-binding caching, and the
declared-context gate that switches it on without a mode or a knob),
`europepmc.js` (the life-science literature leg, whose bilingual intent gates
are where the `\b` trap was first found — and, since feedback #61, where the
imperative frame is pinned silent in both languages ("Research this founder",
"Undersök denna grundare") while the NOUN keeps firing; where an ambiguous
word in passing stays out ("never infer ethnicity, health, religion"); and
where the same word inside a biomedical collocation still fires ("health
effects", "psykisk hälsa", "hjärtinfarkt"). The follow-up to that fix added
the two suites it needed: the frame vetoing the VERB rather than the message
("Research this drug's side effects" and "Undersök den här sjukdomen" fire,
"Research this founder" and "Undersök den här grundaren" do not, and a bare
subject with no framing is still the combination gate), and a MATCHED-PAIR
suite that walks each case through both languages against one shared verdict —
the shape invariant 6 needs, since a missing Swedish counterpart is invisible
in a list and impossible to miss in a pair), and the Deep Science pair added
2026-07-31 — `scholar.js` (the peer-reviewed search source: `scholarIntent`
EN+SV over the peer-reviewed and the "proven" family, minus the commercial
idiom, with `scholarLeadIntent` strictly narrower — and the two words feedback
#61 split apart: "research" the imperative verb silent where "research" the
noun fires, the veto scoped so a message that both instructs and asks about the
literature still fires on its literature half, and a bare "scholar" leading
only where it names the source and not where it names a person, with a matched
EN/SV pair suite over the lot — extended after the same review found the
destination gate asymmetric, so every phrasing is now asserted as one verdict
across both languages, plus the ASCII-typed Swedish forms and the compound
nouns that merely begin with the word ("scholar programs", "scholar-pristagare")
which must not lead even with a verb in front of them; the ladder that climbs by
DROPPING terms, because terms narrow; `peerReviewed` admitting only records
carrying positive evidence and rejecting preprints, repositories, retractions
and the unknown, with a Google Scholar hit admitted ONLY by merging onto a
record that has evidence; `titleKey` matching one paper across four house
styles; the OpenAlex inverted-abstract rebuild; `crossrefRecord` keeping the
type so the Faculty-Opinions trap stays visible; and `rankRecords` refusing to
let a citation magnet outrank the paper the question was about) and
`scholar-metrics.js` (the Google Scholar half: `profileId` reading an id out of
a profile URL or an explicit mention while staying off a bare lookalike token,
the profile fetch asserted against what Scholar's robots.txt ALLOWS,
`parseProfile` returning null for a page that is not a profile — which IS the
CAPTCHA detection, since that page answers 200 — the profile block attributing
every number to Scholar and refusing to imply peer review, `parseVenueTable`
refusing a layout it does not know, and the enrichment restricting EVERY turn
to the peer-reviewed source while folding in venue metrics with no outbound
request — plus, since 2026-08-13, `preprintSources`: the default turn still the
bare scholar leg, arXiv or Europe PMC admitted only when the message NAMES the
preprint record, in both languages, and an ordinary scientific question that
merely engages the wide gates admitting neither),
the OWASP reference block extracted out of `introspect.js` into
`owasp-context.js`, covered where it was before the extraction — `introspect.js`
drives `runOwaspContextEnrichment` against the corpus and index fixtures
(retrieval through the ASSETS binding, per-category diversification, and every
fail-soft branch degrading to no block), `enrichment.js` pins the
declared-`owasp` gate in its capability truth table, and `prompts.js` pins
`OWASP_ASSESSMENT_NOTE` being spliced on the same declaration and on no
other),
plus the two added 2026-08-05/06 — `image-read.js` (the attached-image
transcription: a turn without an image completely silent so the message array is
byte-identical, an attached image folded in as a labeled block that tells later
phases it is NOT a source, and the whole fail-soft surface of invariant 2 —
a provider error, a thrown fetch with the connect timeout's shape, an
accepted-then-stalled stream cut by the bound rather than waited out, and an
empty completion all leaving the conversation unchanged, with `readImages`
asserted to return a string on every path and never throw; the shipped guards
are asserted to actually bound the call, rather than the test's own) and
`person-research.js` + `public/js/person-research-core.js` (the person-research
gate, both tiers off the one core: what users actually sent in feedback #60
firing it, a topic, a company or a product NOT firing it, full Swedish parity
per invariant 6, the methodology block, and the enrichment silent when the
message names nobody — never throwing whatever it is handed; and since
2026-08-13 the GUARDRAIL SPLIT: an agent declaring `person-method` gets the full
protocol byte-identical to before, an agent that does not gets the
privacy-rail-only block, the two activity steps differ, and a missing or
malformed capability narrows to the rail rather than widening to the method).
`entity-research.js` + `public/js/entity-research-core.js` cover the sibling
method from feedback #64: the verbatim reported message firing the gate, an
ordinary research request not firing it, the matched EN/SV `PAIRS` table with a
live demonstration of the `\b` trap, the subject-resolution rule and both of its
brakes (an anchor already supplied resolves it, and it never asks twice), each
report tier carrying its own scaffold and no other with word count strictly
increasing across the tiers, the TIBER tier's content contract plus the
frameworks pinned OUT by name because no ECB TIBER document carries them, and
the enrichment contract — the tier read from `state.plan`, an unknown tier
falling back to standard, and a frozen state bag still yielding the block.
`enrichment.js` covers the registry's method/data split those two rows
introduced (feedback #65): a method row recording exactly the block it appended
rather than the whole message, what it records being what `withoutMethodBlocks`
needs to restore the planning view, a DATA row and a SILENT method row both
recording nothing, both method rows recording in registry order when both fire,
a runner returning a non-array recording nothing, a frozen state leaving the run
intact (invariant 2), and — read off the module source, since the flag is a
registry fact rather than a call — that `person_research` and `entity_research`
are the only core rows marked and that the extension seam carries no method flag
at all.
`public/js/query-focus-core.test.js` covers the deterministic half of the same
feedback (`docs/ARCHITECTURE.md` §4.2c): the reported conversation's format
angles dropped and its on-topic one kept, both disengagement gates asserted as
the untouched input back (no method block on the turn; a conversation that
resolves no subject, which is what keeps "what is TIBER-EU?" searching
TIBER-EU), the two halves of `isFormatChasingQuery` pinned against the cases
that shaped them — an ordinary widening angle naming no format left alone, and
"How has the Tiber-EU framework been applied in practice?" dropped, the one
observed case an earlier all-words-are-format draft let through — the
subject-only fallback when every angle was chasing the format, a matched EN/SV
pair suite over the format vocabulary per invariant 6 (including a Swedish
dossier turn cut and a Swedish question about the framework left alone), the
`\b` trap demonstrated live on `ångbåt` since a `\w`-class tokeniser would
shred every accented word into unmatchable fragments, and the invariant-2
surface — a non-array list, a missing context, blank members and an unparseable
query all degrading rather than throwing.
`answer-stream.js` covers the streaming failover seam:
`isTransientConnectStatus` retrying provider-side statuses ONLY,
`contextOverflowMessage` rewriting the context-window 400 and nothing else, and
`stripImageParts` returning the SAME array when there is nothing to strip (so
the retry sends byte-identical input), dropping images while keeping the text,
and leaving an image-only turn with non-empty content rather than an empty one.
`dense-rag.js` covers the shared presentation and accounting layer under both
hosted literature tiers: `authorsLine` and `citationHighlights` asserted to cut
an abstract and abbreviate an author list IDENTICALLY across the two tiers
(the drift that a third copy of the constant would reintroduce), and the token
tally — several legs ACCUMULATING into one tally rather than overwriting it,
omitting the tally leaving `denseSearch` exactly as it was, a rerank response
with no usage block ESTIMATED rather than dropped, and a dead reranker costing
nothing and still returning results, because accounting never breaks a wave.
**Account memory** (2026-07-30, `docs/ACCOUNT-MEMORY.md`):
`memory.js` covers the write gates rather than the note model — `memoryUserId`
refusing a break-glass identity, since a shared credential has no personal
memory; the knob off by default and only an explicit stored `true` enabling it;
and `runMemoryExtraction` writing nothing for an incognito turn, a signed-out
identity, a knob left off (without paying for a model call) or a thin answer,
dropping junk from the model instead of storing it, degrading rather than
throwing when extraction fails (invariant 2), and passing the already-known
titles to the prompt so re-mentions merge. **The interchange
standards** get the same treatment, and it is pointed specifically at the gap
between what a spec claims and what the code does: `drsw-manifest.js` pins that
`/.well-known/drsw.json` declares the payload kind and version the workspace
code actually reads, advertises only sections the payload validator accepts,
does NOT advertise the unimplemented §5 interchange sections, and claims the
higher conformance class only once those land; `standards-links.js` pins that
the help page says where the standards stand relative to the code.

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
mock HTTP, the embed config — small model, 512 dims, neither Anthropic nor
Groq has one — `drcEmbed`'s wire shape/index-ordering over mock HTTP, and
the ANTHROPIC WIRE adapter: payload translation (system hoisting, image
blocks, same-role merging), the SSE event mapping including the pull loop
that drains events mapping to no output, and the /messages + x-api-key call
shape end to end),
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
`drc-attach-core.js` (Se/cure's attachment intake, added 2026-08-05 — the
pure half of the pane `public/cure/drc.js` only calls into:
`sanitizeAttachName` keeping the basename of a traversal-looking name,
stripping control characters, capping length and never returning empty; and
`addPending` as a pure list transform that never mutates its input, refusing
past each of the five bounds — image count, document count, per-file bytes,
total bytes, per-image and total data-URL chars — with a message that names
the size rather than a bare failure, truncating a document's inlined text at
the character cap, and handling degenerate input without throwing),
`citations-core.js` (the citation audit shared by the server through the
one-line façade `src/citations.js`: `splitSourcesTail` separating a model's
own Sources section from its prose, `citationNumbers` reading the `[n]`
references out of it, `citationAudit` reconciling those against the registry,
and `citationNote` phrasing what validation is told),
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
`account-mcp.js`'s `connectorMarkup` (the Settings → MCP server connector
section: that the Claude install link and the ChatGPT URL come from the
`/api/mcp/config` payload rather than being assembled client-side, that the two
stay distinct because the vendors disagree about the `/mcp` path, that a
preview render leaks no production URL, that payload strings are escaped, and
that an older server sending neither field degrades to the walkthroughs instead
of a button pointing nowhere — the vendor MENU PATHS in that markup are
deliberately untested, since they describe someone else's UI and no test here
can notice a rename),
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

The client cores behind the newer surfaces are covered to the same standard.
`exec-backends-core.js` pins the environment choice, including the two
properties the privacy split rests on: `normalizeExecBackend` falls back to the
browser VM for anything unknown, and `selectRunner` demands an explicit server
tier — so Se/cure, and any caller that says nothing, gets the browser VM (the
suite also holds the "browser bridge returned untouched" property).
`chat-mode-core.js` pins that every non-normal mode has exactly one request
flag and carries the site's own source, which is what let the `developer_mode`
knob collapse into the mode. `orchestrator-core.js` covers plan validation that
reports problems rather than throwing, cycle and cap detection, and
deterministic wave resolution; `workflow-viz.js` covers the graph layout and
its XSS-safe SVG; `swarm-core.js` covers capacity planning that clamps every
input, tightens under live heap pressure and never loosens on a missing
measurement, plus the distinct-stance assignment. `outrospect-core.js` carries
the seven-lens registry with **full Swedish routing parity** (definite and
plural forms, not just base words — invariant 6's enforcement pattern outside
`googlemaps.test.js`), alongside `outrospect-feed.js` and `outrospect-view.js`.
`starters-core.js` pins that `MODE_AGENTS` mirrors `sdk/AGENTS.json`'s defaults
table and that the strip never repeats an id; `pipeline-map-core.js` pins a
connected, uniquely-identified graph whose POST node is proven by the wire
rather than by starting a send. Also here: `sdk-core.js`, `agent-spec-core.js`
and `agent-capability.js` (the SDK/AgentSpec cores), `arxiv-rag-core.js`, `pubmed-core.js` (the PubMed XML parse, the own-PMID
trap, structured abstracts, free-text dates, the streaming block boundaries and
the newest-first file plan),
`knowledge-core.js`, `pool-core.js` / `pool-local.js` / `pool-provider.js`,
`ondevice-core.js`, `models-core.js` / `ai-models.js` / `provider-region.js`,
`websearch-backends-core.js`, `secure-posture-core.js`,
`research-seal-core.js`, `feedback-core.js`, `markdown.js`, `turns.js`,
`report.js`, `deeplink-core.js`, `slash-core.js`, `source-peek-core.js`,
`docs-comments-core.js`, `canned-faq.js`, `space-core.js`,
`pulse-timeline-core.js`, `swarm-runtime.js` (the worker pool's hand-out and
queueing, and a full draft → critique → converge run emitting the member states
the graph renders), `search-source.js` (the client's user-selectable backend
set, mirroring the server's with Exa first and default), `sdk-showcase.js` (a
catalog whose every item carries a stable unique id and a real build prompt),
`sdk-plant.js`, `account-views.js` (the account panel's summary/row rendering,
including a Messages count that excludes feedback replies the badge folds in)
and `account-articles.js`, `memory-core.js` (account memory's note model:
`noteSlug` stripping path separators and Obsidian link syntax while keeping
non-ASCII letters, `normalizeMemoryNotes` dropping a note missing a title or a
body — neither is memory — mapping an unknown type to `note` rather than
storing junk, de-duplicating by slug case-insensitively and dropping a
self-link, `mergeNote` unioning links and tags so the graph only ever gains
edges while a vague type never overwrites a specific stored one, and
`noteToMarkdown` putting links in the BODY as wikilinks rather than only in
frontmatter, since that is what Obsidian follows) and `zip-core.js` (the
hand-rolled export archive: `crc32` against the published check value, a
pre-1980 date clamped instead of written as a negative year, entries STORED
rather than deflated and flagged UTF-8 so a Swedish vault's paths survive,
byte-identical output across two exports of one vault, and the archive read
back both by an independent reader and by the system `unzip`), plus the
presentation cores `mode-theme.js`,
`bar-tint.js`, `graph-backdrop.js`, `plant-spinner.js`, `boot-messages.js`,
`umbrella-intro.js`, `ghostwalk.js`, `sandbox-mode.js` and `dev-mode.js`.
`apps-core.js` covers the published-apps ruleset the `/apps/` page and
`src/apps.js` share, and it is written as the behaviours the module's comments
CLAIM rather than as a pass over its exports: that a malformed or absent `meta`
still yields a usable row (the tolerance that lets the management page delete a
broken build), that `updatedAt` falls back to `createdAt` so an app nobody has
edited does not sort as epoch 0, that `canManageApp` refuses an ownerless app
to everyone but an admin — the `Boolean(app.owner)` guard, without which
`"" === ""` hands every orphaned build to every session with no id — that
`appMatches` folds diacritics so `sokratisk` finds "Sökratisk handledare" and
`cafe` finds "Café" (invariant 6), that the `name` sort collates under `sv`
with the assertion pinned against the runner's default locale, which puts Ä
first and disagrees, that both file planners refuse the states that would
publish an app which 404s at its own URL (no `index.html`, or an empty
collection) and measure the size caps in BYTES rather than characters, and that
`formatWhen` takes `now` as a parameter — every relative-time assertion passes a
fixed clock, since a boundary read off `Date.now()` is the worst kind of flake.

The demo surface is the newest of these. `demo-core.js` covers the
capability-demo registry — the deterministic EN+SV "show me X demo" gate and the
bare-visual-ask inheritance that takes its subject from the turn before — and
`demo-mount.js` covers which module a matched surface fetches; between them they
pin that the answer prompt and the thing actually displayed cannot disagree
(feedback #49/#50). Also here: `aadr-core.js` (the ancient-sample corpus parse, the date-window and
radius grammar, and the bilingual intent gates), `chat-mode.js` (the browser
wrapper over the mode core), `session-core.js`, `starters.js` (the strip's
rendering over `starters-core.js`) and `unanswered-core.js`.

The games' client cores are tested the same way, one directory over
(`public/games/*/js/*.test.js`): `street-core.js` — the Tokemon street-view
pane's presentation logic (the compass line's wrap past north, the spawn
captions incl. escaping, since the pane writes them with `innerHTML`, and the
overlay placement style clamped against hostile numbers). The DOM wiring in
`street.js` / `map.js` / `game.js` stays browser-only and is verified live.

These run in Node unmodified since `File`, `Blob`,
`DecompressionStream`, and `TextDecoder` are all standard Node globals
— no DOM needed for this subset of client code.

**The request layer** (added 2026-07-29, on the shared helpers in
`src/test-helpers/` — see `docs/CODE-LAYOUT.md`). Three suites that call the
Worker's own entry points rather than their extracted pieces:

- `test-helpers.test.js` — the fakes themselves. A fake that silently
  misbehaves turns other suites green for the wrong reason, so they get the
  same treatment as production code.
- `chat-handler.test.js` — `handleChat` end to end against a fake Berget
  (a `/models` catalog plus a `/chat/completions` that answers JSON-mode
  planning calls with an object and streamed calls with an SSE body). Pins the
  invariants the request path *promises*: the **incognito** chat-log
  suppression in both directions and its exact boundary (invariant 4), that no
  outbound request carries the user's identity and no log line carries the
  provider secret (invariant 4), that the JSON planning phases stay on
  `DEFAULT_MODEL` while synthesis follows the user's pick (invariant 3), the
  fail-soft ladder (invariant 2), and the SSE frame contract. Took
  `src/chat.js` from 26% to 90% line coverage.
- `index.test.js` — the `fetch` handler: the identity gate is fail-closed
  across a representative slice of `/api/*` (an unknown path answers 401, not
  404, so the route table cannot be enumerated unauthenticated), the security
  headers and request id are on every response, and a crash becomes a clean
  500 that leaks no stack, message, or secret. Written as properties of the
  ENVELOPE rather than a route-by-route table, which would rot at route 94.

```bash
npm test            # from the repo root: node --test src/*.test.js public/js/*.test.js
                    #                     public/games/*/js/*.test.js
                    #                     sdk/*.test.mjs scripts/*.test.mjs
                    #                     tests/*.test.js
npm run typecheck   # zero-build-step tsc: src/ (tsconfig.json, Workers types)
                    # + public/ (tsconfig.public.json, DOM lib) — strict,
                    # opt-in per file via // @ts-check; both must stay clean
```

### The tooling suites (`sdk/*.test.mjs`, `scripts/*.test.mjs`, `tests/*.test.js`)

Three more globs in the same `npm test` run. None of this ships, but the
shipped corpora and ledgers are built by it, so a bug here is a bug in the
data. They get a section because a suite nobody documents is a suite nobody
maintains.

**`sdk/`** — `pair-cli.test.mjs` pins the Platform SDK's CLI and registry:
`sdk/MANIFEST.json` parses, every module id resolves to a skill, `plan` orders
dependencies without cycles, and `validate` enforces the AgentSpec rules
(invariants 1, 3, 4 and 6 as machine-checked rules rather than prose; see
`docs/AGENT-PLATFORM.md` §3.1). `drpl.test.mjs` covers the DRPL/1 pipeline
tooling against `docs/PIPELINE-LANGUAGE.md`.

**`scripts/`** — the corpus and analytics tooling, all pure-logic halves of
scripts whose network legs are exercised by hand. The arXiv family:
`arxiv-harvest.test.mjs` (OAI-PMH windowing, including the `--until` boundary
that silently under-harvested a historical band), `arxiv-gcs.test.mjs` and
`arxiv-crosscheck.test.mjs` (the two independent enumerations, and why one
cannot detect its own gaps), `arxiv-fulltext.test.mjs`,
`arxiv-html.test.mjs` (the LaTeXML-aware DOM walk, and the one suite that needs
`cheerio`, so a bare checkout fails it on a missing module rather than an
assertion), `arxiv-hosted-eval.test.mjs`, `corpus-rag.test.mjs`,
`embed-providers.test.mjs` and `embed-truncate.test.mjs` (the 512-token
embedder limit that REJECTS rather than truncates). Beside them,
`pubmed-partition.test.mjs` covers the biomedical ingest's work split —
`partOf` deterministic, so a resumed loader sees the same work list, staying
inside the requested range and spreading PMIDs evenly enough to balance the
loaders, plus the parts count that cannot produce a usable fill being
rejected rather than run — and
`rag-eval-core.test.mjs` covers the retrieval-evaluation instrument:
`expandMonths` crossing a year boundary rather than comparing strings, the
PubMed month parser asserted NOT to be the arXiv one, every registered corpus
round-tripping its own id spelling while an unknown one is refused by name
rather than defaulted, the harness replaying the SERVED pool and floor rather
than a copy of them, and `mcnemar` reproducing the hand-computed verdicts
published in `docs/ARXIV-RAG.md` §11 while staying finite where a factorial
implementation would overflow. `mcp-probe.test.mjs` is the MCP surface's
live-probe helper: credentials read from both families and overridden by
flags, well-formed JSON-RPC 2.0 messages, an unauthenticated call that must
answer a JSON-RPC 401 rather than the sign-in page, and the corpora check
treating a live vector count as the binding proof so a bound-but-empty index
cannot pass. The rest:
`pulse-themes.test.mjs` + `pulse-time.test.mjs` (the commit-analytics tagger
and rollups), `dup-scan.test.mjs` + `line-scan.test.mjs` (the refactor-pass
surveys), `merge-markers.test.mjs` and `check-merged-branches.test.mjs` (the
merge hygiene guards behind the push hook). `capture-core.test.mjs` covers the
video pipeline's whole editing model — which spans of a recording are provably
dead air, what the cut plan does with them, the ffmpeg filter graph and argv,
and LinkedIn's delivery fences — WITHOUT ffmpeg, because no agent container
here has it and a plan that can only be checked by encoding is a plan nobody
checks.

**`tests/`** — the two eval harnesses' pure helpers, unit-tested so a scoring
change is a caught diff rather than a silently different ledger:
`bench-score.test.js` (the rubric bench's aggregation and the noise-aware gate
verdict) and `hf-bench-lib.test.js` (`aggregateHfScores`, including that it
counts leak-tainted runs separately instead of averaging them in), plus
`bench-sources.test.js`, the source-coverage guard described under "Source
coverage is a build-time invariant" below. The
Playwright specs in `tests/e2e/` are a different runner entirely; next
section.

This adds to the live-verification convention rather than replacing it:
anything touching an external provider or D1 (or, on the client side, the
DOM/`<canvas>`/pdf.js) is still verified live, since that is where this
project's actual bugs have come from historically (see the **live-verify**
skill). The root `package.json`
exists solely to run this suite and the type-checker — no build step,
dev-only dependencies (`typescript`, `@cloudflare/workers-types`);
deploy still reads `src/` and `public/` as plain JS/static assets via
`npx wrangler deploy`.

## CI (`.github/workflows/ci.yml`)

`npm ci && npm test && npm run typecheck` on every push, every pull request,
and on demand (`workflow_dispatch`), Node 22, per-branch concurrency so a new
push supersedes an in-flight run. The whole unit surface needs no credentials,
no D1, and no network, which is why it runs here; the e2e and eval harnesses
deliberately do NOT (they spend tokens and need the break-glass creds).

The `npm ci` step matters beyond CI: the root devDependencies
(`typescript`, `@cloudflare/workers-types`) are never installed automatically,
so `npm run typecheck` in a fresh clone fails with a confusing `TS2688` until
someone runs an install.

A second JOB (`e2e`) runs the **browser suite against a Worker started on the
runner** — `cd tests && npm run test:local`, 63 tests, no credentials and no
deployment. It installs Chromium, generates the fixtures (Pillow included, or
the EXIF fixture is skipped and the metadata specs fail on a missing file
rather than a real defect), and uploads `tests/test-results/` on failure. It is
a separate job from the unit gate so a browser failure is legible on its own
and does not delay the fast feedback.

A third step runs the **coverage ratchet** (`npm run coverage:check`,
`scripts/coverage.mjs`): the suite again under `node --test
--experimental-test-coverage`, compared against the committed floor
`docs/coverage-baseline.json`. It fails when line/branch/function coverage
falls more than 0.5% below the baseline, and fails with NO tolerance when a
module that was reached by some test stops being reached at all. It is a
separate step from `npm test` on purpose: a red ratchet on a green suite
should read "coverage regressed", not "tests failed". Raise the floor in the
same commit as a real gain with `npm run coverage -- --save`; find the
cheapest next climb with `npm run coverage -- --list`.

## End-to-end tests (`tests/`)

Playwright suite, self-contained npm project of its own
(`tests/package.json`) — distinct from the root `package.json` above, which
only runs the unit suite. It has **two targets**.

### Local (added 2026-07-29) — free, credential-less, and what CI runs

```bash
cd tests && npm install && npm run fixtures
npm run test:local        # 63 mocked tests, ~1.8 min, nothing spent
```

`test:local` (`E2E_TARGET=local`) brings up two servers of its own via
Playwright's `webServer` and points the suite at them:

- **`tests/fake-provider.mjs`** — a dependency-free loopback stand-in for the
  LLM provider, serving the OpenAI-compatible `/models`,
  `/chat/completions` and `/embeddings` that `src/berget.js` speaks. It is
  needed even though the mocked project intercepts `/api/chat` in the browser,
  because `/api/models` is *never* intercepted (the app fetches a real catalog
  on every page load and renders nothing without one) and because
  `e2e/api.spec.js` calls the Worker directly through the request context,
  past any page route. Its catalog deliberately carries an up vision model, an
  up non-vision model and a DOWN model, because the specs discover their
  fixtures from it and silently skip when one is missing.
- **`wrangler dev -c wrangler.dev.toml`** — the real Worker, local bindings.
  The separate config is not tidiness: `wrangler.toml`'s `routes` make
  `wrangler dev` rewrite the inbound Host to the first custom domain (so a
  request to `127.0.0.1` arrives as `deepresearch.se`), and its `containers`
  block refuses to start without a Docker daemon. Neither is removable from an
  `[env.*]` block. See the file's own header.

Two defects had to be fixed before any of it worked, both invisible while the
suite only ever ran against a deployment:

- **`src/canonical.js` looped on a local origin.** With the Host rewritten to
  the production domain, the http→https rule fired on every local request,
  wrangler's dev proxy rewrote the `Location` back, and a browser followed a
  301 to itself forever. Loopback hosts are now exempt (`canonical.test.js`
  pins the exemption *and* that it did not widen).
- **`helpers.js` hard-coded the production origin.** `stripCrossOriginAuth`
  strips the break-glass header from any origin that is not `BASE_URL`, so a
  local run lost its `Authorization` on every request and got served the
  signed-out landing. `playwright.config.js` now publishes the resolved target
  back into `process.env.BASE_URL`, which fixes that and the nine other specs
  reading the same variable.

> **A mid-run `wrangler dev` exit reads as four unrelated failures** (observed
> 2026-07-30, PR #343, run 30552749008). The dev server printed its shutdown
> line — `🪵 Logs were written to …/wrangler-*.log` — after 59 passing tests,
> and the remaining four failed together: three with
> `net::ERR_CONNECTION_REFUSED at http://127.0.0.1:8787/` in ~1.1 s each, and
> one already in flight that burned its full 30 s timeout waiting for a
> `.stats` element on a page whose server had gone. The 30 s timeout is the
> misleading part: it reads like a slow assertion or a real UI regression, and
> it is neither. **Diagnose by the shutdown line, not by the failure list** —
> `grep 'Logs were written to' the job log and check whether it lands before
> the failures. When it does, the failures are collateral and the suite proved
> nothing about the diff. The tell that it is infrastructure rather than the
> change under test: the run in question altered only `MERGED-BRANCHES.md` and
> the three generated artifacts, so its application code was byte-identical to
> the `main` commit whose e2e run had passed minutes earlier. Re-running the
> job is the correct response; there is no fix to write.

> **It recurs, and the failure COUNT is not the signal** (2026-07-31: three
> consecutive PRs — #354, #355, #356 — all red on this job, none of them at
> fault). The variant matters less than it looks: #354 lost 5 of 63 tests to a
> server that died late in the run, #356 lost **41 of 63** to one that died
> **17 seconds in**. Same cause, different arrival time, and a run that loses
> two thirds of its tests reads far more alarming than one that loses five
> while being no more meaningful.
>
> The 2026-07-31 crash is worth recording in full because it names what to look
> for. Startup was clean — `Ready on http://localhost:8787`, all bindings
> local, the fake provider up, ~17 s of `GET / 200 OK` — then:
>
> ```
> 21:51:04  ✘ [ERROR] kj::getCaughtExceptionAsKj() = kj/async-io-unix.c++:186:
>           disconnected: ::write(fd, …): Broken pipe        ← workerd, non-fatal
> 21:51:11  ✘ [ERROR]                                        ← EMPTY message; the crash
> 21:51:11  🪵 Logs were written to …/wrangler-2026-07-31_21-50-52_307.log
> ```
>
> **A blank `✘ [ERROR]` preceded by workerd `Broken pipe` disconnects is the
> fingerprint.** No `EADDRINUSE`, no bundling error, no OOM/`Killed` anywhere —
> so the usual suspects are all excluded, and `wrangler dev` (4.118.0, fetched
> per-run via `npx`) simply exits. Two independent confirmations that the diff
> is innocent are usually available and both are cheap: the first failing test
> is an *assertion timeout* on a page whose server has gone (not a connection
> error — that only starts with the NEXT test), and in #355's case the diff
> touched no `src/` or `public/` file at all.
>
> **The real crash reason was in a file CI threw away — FIXED 2026-08-01.** The
> shutdown line names `~/.config/.wrangler/logs/wrangler-*.log`, and the
> workflow uploaded only `tests/test-results/`. The fourth occurrence arrived on
> PR #357 (27 of 63 lost, server died 84 s in, diff touched no file in the
> Worker's or the browser's import graph), so `.github/workflows/ci.yml` now
> uploads that directory as the `wrangler-logs` artifact on failure.
>
> **The fifth occurrence arrived the same day, on the very next push of that
> same PR, and the capture worked** — a 195 KB `wrangler-logs` artifact on
> [run 30697545700](https://github.com/kristerhedfors/Deepresearch.se/actions/runs/30697545700).
> Two consecutive runs of the SAME commit range lost 27 of 63 and then 4 of 63,
> which is the clearest evidence yet that the blast radius is random and carries
> no information about the diff. The job log adds one fact the artifact does not
> need to supply: the server was serving normally until **22 ms** before it died
> (`GET /admin 307` at 11:25:44.915, blank `✘ [ERROR]` at 11:25:44.937), so this
> is not a slow leak or gradual degradation — it is an abrupt exit from full
> health. Read the artifact before theorising further; it has a 7-day retention.
>
> **The artifact was read, and the five-occurrence mystery is closed.** The
> blank `✘ [ERROR]` is a wrangler DISPLAY bug: the fatal it prints is an outer
> error whose own `message` is empty, and the real one is nested one level down
> in `cause`. The 2.4 MB log carries it in full:
>
> ```
> 11:25:44.928  Error in ProxyController: Error inside ProxyWorker
>               at castErrorCause (wrangler-dist/cli.js:178283)
>               at ProxyController2.emitErrorEvent (cli.js:278284)
>               at async #handleLoopbackCustomFetchService (miniflare/index.js:113376)
>               cause: { name: 'Error', message: 'Network connection lost.' }
> ```
>
> So the cause is **a transient socket drop on miniflare's internal loopback**,
> which wrangler's `ProxyController` escalates to a process-ending fatal. Three
> facts settle that this is wrangler's own plumbing and nothing of ours:
> `Error inside ProxyWorker` appears **exactly once** in the whole 160-second
> log (it is a single transient event, not a degradation that finally tipped
> over); the last request before it was a healthy `GET /admin 307` 215 ms
> earlier; and the failing frame is inside `node_modules/miniflare`, never in
> `src/`. The earlier workerd `Broken pipe` disconnects are the same class of
> event surviving non-fatally.
>
> **What follows for this repo.** Nothing to fix in our code, and re-running the
> job remains the correct response — but now for a stated reason rather than a
> shrug. Two things would reduce the frequency if it becomes intolerable:
> `.github/workflows/ci.yml` installs wrangler through a bare `npx wrangler`,
> so every run silently takes the newest release (4.118.0 at the time of
> writing) — **pinning it** makes the failure rate a property you control and
> can bisect, instead of one that changes under you. And Playwright's
> `webServer` has no restart-on-exit, so a single dropped socket costs the whole
> suite; a supervising wrapper would turn a fatal into a reconnect. Neither is
> written yet, and neither should be attempted while pretending the bug is ours.
>
> Either way the standing rule holds: **this fingerprint does not mean the PR is
> at fault.** Confirm innocence the two cheap ways — the first failing test is an
> assertion timeout on a page whose server has already gone (connection errors
> only start with the NEXT test), and check whether the diff reaches `src/` or a
> served `public/` module at all — then re-run the job.

> **Both mitigations were written (PR #365), and they were still not enough —
> because the restart was slower than the retry** (settled 2026-08-05 from the
> occurrence 9-12 artifacts; the running ledger is the "CI's e2e job" row in
> `docs/MAINTENANCE-OWNERS.md`). Wrangler is pinned and the `webServer` is
> supervised, and the supervisor demonstrably works: occurrence 10's
> `wrangler-logs` artifact holds **four** wrangler log files, one per crash plus
> the survivor, and the port came back every time. What kept the build red is in
> occurrence 11's job log, three lines apart:
>
> ```
> 08:31:28.244  [e2e] wrangler dev exited (1) — restarting
> 08:31:32.759  ✘ 65 [mocked] › e2e/ui.spec.js:164 (retry #1) (1.3s)
> 08:31:33.237  [wrangler:info] Ready on http://localhost:8787
> ```
>
> The one CI retry finished **0.48 s before the port returned**. So "a spec and
> its retry both got ERR_CONNECTION_REFUSED" never meant the supervisor failed;
> it meant the retry was spent inside a 5.0 s outage. About 3.2 s of that window
> was ours — a hard-coded `sleep 2` and ~1.2 s of `npx` re-resolving a package
> already in the cache (2.8 s through `npx` vs 1.7 s exec'ing the resolved entry
> point, measured on 4 vCPU) — leaving ~1.8 s that is wrangler starting.
>
> The supervisor now lives in **`tests/dev-server.sh`** rather than in a shell
> string inside `playwright.config.js`, resolves the pinned wrangler once before
> the loop, execs it with `node` on each restart, and sleeps 0.2 s instead of
> 2 s. Measured end to end — kill the supervised wrangler, poll until the port
> answers again, same box and same wrangler both ways — the outage went from
> **6049 / 6117 ms to 3597 / 3188 ms**, a 44% cut.
> `tests/dev-server.test.js` drives that loop offline (through the
> `E2E_WRANGLER_BIN` seam, so `npm test` resolves no package and binds no port)
> and fails if the delay grows back, if the loop starts calling `npx` again, or
> if someone answers the next occurrence by raising `retries` — which the record
> says is not the fix: occurrences 8 through 12 all had `retries: 1`.
>
> **The margin is thin and should be read as such.** Scaled onto occurrence 11
> the window becomes ~2.8 s against a retry that navigated ~3.2 s after the
> exit: a 0.48 s loss turns into roughly a 0.4 s win. That gives the retry its
> chance back; it does not make the failure impossible, and a runner as slow as
> occurrence 10's stretches both sides. If a later occurrence shows the retry
> running *after* `Ready on …` and still failing, the outage was never the
> binding constraint and the next lever is the mocked project's `workers`.
>
> One measurement worth keeping for the next reader, because it is the strongest
> evidence for the runner-capacity reading and it bounds it: counted at the
> Worker's own request log, occurrence 10 served **11.8-23.6 requests/s** where
> occurrences 9 and 11 served **37-43**, and its rate of client aborts (workerd
> `Broken pipe` / `Connection reset by peer`, i.e. the browser walking away from
> an in-flight response) was **0.16-0.29/s against 0.02-0.06/s**. A slow runner
> really does crash more often — 3 crashes in that job against 1 in the others.
> But it is not required: occurrence 9 crashed on a fast runner after 2 aborts
> in 114 s, and the wrangler process that survived to the end of run 10 carried
> that run's highest sustained request rate. Every fatal lands mid page-load,
> inside a burst of dozens of concurrent `/js/*.js` module fetches.

### Looking at a rendered page from a session container

A session container **can** open a real browser, and several PRs have shipped
with "not verified in a browser" written into them on the belief that it
cannot. Chromium is pre-installed under `/opt/pw-browsers/`, which is what
`PLAYWRIGHT_BROWSERS_PATH` already points at. This matters most for the WebGL
and canvas surfaces — `/space/`, the demo mounts — where a unit test
proves the arithmetic and says nothing about whether the shader compiled.

Three snags, each with its fix (established 2026-07-30 while reviewing PR #345,
whose own body reported no browser was available):

1. `cd tests && npm install` resolves a Playwright whose pinned browser
   revision is newer than the one shipped in the image, so `chromium.launch()`
   fails with *"Executable doesn't exist at …chromium_headless_shell-<n>"*. Do
   **not** run `npx playwright install`. Pass the shipped binary instead:
   `executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"`
   (check the directory — the revision moves with the image).
2. WebGL needs software rendering:
   `args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]`.
   With those, `getContext("webgl")` succeeds and the page's shaders really do
   compile — a compile failure shows up as a console error and a blank canvas,
   which is exactly the class of break that unit tests cannot see.
3. `wrangler dev` is the wrong host for a static showcase page: `/space/`
   **301s to itself** locally, while production serves 200. It is a local
   asset-routing artifact, not a defect. Serve the directory instead —
   `cd public && python3 -m http.server 8123` — since these pages are static
   HTML plus module imports rooted at `/js/`.

**Measure the render; do not only look at it — and do not only count lit
pixels.** The space-animations rule stands (a lit-pixel count passes happily on
a scene drawing the wrong thing), so the useful shape is a *paired* measurement
against `main` rendered at the same viewport. Reading the canvas back through a
2D copy and histogramming it caught a material regression no test asserted: on
`main` not one non-background pixel exceeded 235 on all channels, and on the
branch 25.9% did with 0.46% clipped at 255 — a bracelet that had lost all
tonal separation. Neither number means anything alone; the pair is the finding.
Render both, count the same way, and put the two numbers in the PR.

### Remote — against the deployed site or a branch preview

Set `BASE_URL` plus the break-glass credentials (`BASIC_AUTH_USER` /
`BASIC_AUTH_PASS`, sent as an `Authorization: Basic` header on every request —
the Worker never emits a challenge, so Playwright's `httpCredentials` would
not work). This is the original behaviour and is still how the `@live` project
runs. The config no longer *throws* when credentials are absent: with nothing
configured it selects the local target, so a first-time `npm test` works
instead of erroring.

> **The header must not reach cross-origin hosts.** `extraHTTPHeaders`
> attaches it to *every* request the context makes, third parties
> included. With an `authorization` header on it, the CheerpX runtime's
> `import(CHEERPX_CDN)` fails with `net::ERR_FAILED`, the VM dies at
> "loading CheerpX…" after ~3.2 s, and the spec silently tests only the
> fail-soft fallback. It also keeps the break-glass password off
> third-party hosts. `openApp` now calls `stripCrossOriginAuth(context)`
> for every spec (the app pre-warms the sandbox on load, so they all pull
> cross-origin resources); a spec that builds its own context still has to
> call it directly, as the sandbox specs do.

> **`openApp` PINS the per-account settings — don't remove that.** The suite
> authenticates as break-glass, and `src/settings.js` hard-codes the sandbox
> knob ON for an identity with no user row (`identity.user ? settings.x : true`),
> so `/api/settings` answers `bash_lite_mcp: true`
> here regardless of configuration. Inherited, that broke the mocked suite
> in a way that looked like flakiness (2026-07-25): a send with a DOCUMENT
> attached mounted it into a CheerpX VM and ran a bash-lite shell loop
> before the turn could finish, so `waitForDone`'s 30 s expired with an
> empty `.stats` — 15 failures across parsing/limits/metadata/projects,
> while image-only sends passed because they mount nothing. That clean
> split is what identified it. The since-retired `developer_mode` knob also
> made `cachedChatMode()` default to **introspection**, so specs asserting
> the ordinary chat surface were driving a different mode; the mode collapse
> (2026-07-26) removed that failure mode at the root — there is one mode
> value now. `openApp` patches the `/api/settings` GET to
> `bash_lite_mcp: false, chat_mode: "science"` and pins the matching
> `dr_chat_mode` cache; pass `{ sandbox: true }` to opt back in, or
> `{ chatMode: "introspection" }` to drive another mode. The default was
> `"normal"` until the general agent was retired (2026-08-13); a spec needing
> open-web research now has to name a mode, because Deep Science does not
> search the web. A spec that
> mocks `/api/settings` ITSELF must pass `{ pinSettings: false }` — routes
> match last-registered-first, so `openApp`'s handler would shadow it.

```bash
cd tests && npm install && npm run fixtures   # once
npm run test:mocked   # 46 tests, free: /api/chat (and /api/embed, /api/settings) intercepted
npm run test:live     # 5 tests, real Berget tokens + one Exa run
```

> **`npm run fixtures` is not optional, and it wants Pillow.** A fresh
> container has no `tests/fixtures/`, and every attachment spec then fails
> on a missing file — 13 of the 28 failures seen on 2026-07-25 were only
> that. `photo.jpg` (the EXIF/GPS fixture) additionally needs
> `pip install pillow`; the generator skips it with a warning rather than
> failing, so the four `metadata.spec.js` EXIF cases fail later instead.

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
  image attachment, and a stop-mid-stream check. Plus two multi-actor
  specs that need no LLM spend at all:
  - `workspace.live.spec.js` — a Se/rver-minted workspace link with
    borrowed proxy grants, unlocked in a fresh browser, answering on the
    default model.
  - `llm-sharing.live.spec.js` — **compute sharing, multi-user**: four
    distinct platform identities minted from ONE break-glass credential
    via run-as (`POST /api/admin/run-as`, `src/run-as.js`), one of them
    lending a model, a sealed workspace link carrying `grants.pool`, and
    both halves of mutual consent — the sharer allowing an identity in
    (ingress), the consumer allowing their prompts out (egress) — asserted
    at every step, including that decisions are remembered and that a
    denied participant stays out. The sharer's "local model" is stood in
    for by the test process running the provider loop (poll → answer →
    result); everything between the consumer and that answer is the real
    deployed broker. See `docs/COMPUTE-SHARING.md` §8b–8c.

> **Multi-user testing needs run-as.** Break-glass is ONE shared identity,
> which cannot exercise a feature whose whole point is that two different
> people approve each other. `X-Run-As: test:<name>` on a break-glass
> request — or the session cookie `POST /api/admin/run-as` mints, which is
> what lets a whole browser context be a persona — resolves to a synthetic
> `runas:<name>` identity with its own pool and its own consent decisions.
> It never escalates (see `src/run-as.test.js`), and only a break-glass
> caller may mint one.
>
> These specs write real rows (pool tokens, consent decisions) into the
> deployed D1, so they revoke every token and unregister every provider in
> a `finally`. They do leave `runas:*` roster and consent rows behind:
> those persist by design (a consent decision is remembered), and without a
> live token or provider they grant nothing.
- **Sandbox quirks** (encoded in `playwright.config.js`): Chromium must
  be pointed at the env's `HTTPS_PROXY` explicitly, `ignoreHTTPSErrors`
  for the re-signing CA, and `--ssl-version-max=tls1.2` because the
  proxy resets Chromium's TLS 1.3 ClientHello; the browser binary is the
  pre-installed `/opt/pw-browsers/chromium`.

### Sandbox specs (own configs, not in the mocked/live projects)

Four specs drive a real CheerpX VM in Chromium and are matched by their own
configs, so the default projects do not pick them up:

```bash
cd tests
npx playwright test --config=sandbox.pw.config.js                          # all three sandbox specs
npx playwright test --config=sandbox.pw.config.js e2e/sandbox.spec.js      # the iOS "sandbox not ready" regression
npx playwright test --config=sandbox.pw.config.js e2e/terminal-pane.spec.js  # what the user SEES of the boot
npx playwright test --config=sandbox.pw.config.js e2e/terminal-remote.spec.js  # …when the commands run elsewhere
npx playwright test --config=sandbox-perf.pw.config.js -g "performance"    # command-cost battery (~2 min)
npx playwright test --config=sandbox-perf.pw.config.js -g "agent trace"    # one turn, every event timestamped
```

- **`terminal-pane.spec.js`** covers the pane rather than the VM: it primes the
  cached sandbox knob so `#termbtn` is revealed at first paint, taps it during
  the cold boot, and asserts the pane holds a real boot transcript afterwards —
  never the `sandbox terminal idle` placeholder, and never silence when the boot
  failed. That silence was feedback #42 ("button looks pressed but no terminal
  in background"), the follow-on to #38.

- **`terminal-remote.spec.js`** covers the same pane when the commands run
  somewhere it cannot see for itself: a local runner or the cloud container,
  which narrate nothing (feedback #43). Unlike its sibling it boots no VM and
  spends nothing: the step model, the DREE/1 runner and `/api/chat` are all
  intercepted, so a canned command really travels the remote path and the spec
  asserts it reaches the pane. It uses the LOCAL backend because a local
  runner's base URL is client-configured and therefore interceptable, while
  `/api/exec` is same-origin and would need a real deploy binding. Both flow
  through the identical seam. A second case aborts the runner and asserts the
  pane says so rather than going blank under a lit-up icon.

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

### The capture harness (`tests/capture.mjs`) — a recorder, not a test

Driven by Playwright and living in `tests/`, but it asserts nothing: it
RECORDS the site running real queries across selected agents and selected
models, and writes a video plus an activity timeline per run for
`scripts/capture-edit.mjs` to cut into a shareable clip.

```bash
cd tests && npm install
npm run capture -- --agents research --models <id> --dry-run   # the matrix, no browser
npm run capture -- --agents research,introspection --models <id> --per-agent 2
```

It is listed here because it shares the e2e suite's plumbing and its traps —
break-glass Basic Auth, `stripCrossOriginAuth`, the pre-installed Chromium
path, the pinned settings that keep the app in a known state — so a change to
`tests/e2e/helpers.js` is a change to the recorder too. What it produces, and
what the second stage does with it: **`docs/VIDEO-CAPTURE.md`** and the
**video-capture** skill.

The parts that can be tested without a browser are, in the ordinary `npm test`
run: `tests/capture.test.js` (the argv parser, the content-signature composer,
the timeline assembler) and `scripts/capture-core.test.mjs` (the whole editing
model — dead-air detection, the cut plan, the ffmpeg filter graph and argv,
LinkedIn's delivery fences), which is deliberately free of ffmpeg so it runs
in a container that has none.

### The theme audit (`tests/theme-contrast.mjs`) — every agent switch, measured

A standalone Playwright script, not part of either project, because it walks
all 49 ordered mode pairs and samples computed colour on each — too slow for
the mocked run, and the two claims it makes are pinned there in cheaper form
(`ui.spec.js`'s switching matrix, `chat-mode.test.js`'s class algebra).

```bash
cd tests
node theme-contrast.mjs                                  # a local Worker on :8787
BASE_URL=https://deepresearch.se node theme-contrast.mjs # production, break-glass
VERBOSE=1 node theme-contrast.mjs                        # print every ratio, not just failures
```

It boots in each chat mode and switches to every other, asserting that `<html>`
ends up carrying **exactly** the target mode's root class and the header shows
**exactly one** mode tag; then it composites each text-bearing chrome element
against everything painted behind it — alpha-mixing up the ancestor chain — and
reports the WCAG ratio. Credentials follow the target the way
`playwright.config.js` resolves them, so a container carrying the production
break-glass pair does not accidentally send it to a loopback Worker.

Both halves earned their place on 2026-08-02. Deep Science was declared with
`rootClass: "sci-mode"` and applied by `index.html`'s parse-time script, but
`chat-mode.js` toggled five hand-written classes and `sci-mode` was not among
them — so the class could be turned on only by a reload and never turned off. A
browser that had booted in Science carried it into every other agent: two header
tags at once, and the palette, the composer pane and the dropdown text each from
a different theme. The audit reported 54 failures against production. The
contrast half then caught what the switching half did not explain — Science is
the one DARK theme, and its near-white `--text` over the composer's default
white glass measured **2.58:1** even with the classes correct.

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

A fourth harness measures something the other three do not — the **starter
evaluation** (`tests/starter-eval.mjs`, ledger
`tests/STARTER-EVAL-FINDINGS.md`). The benches above ask "was the answer
good"; this one asks "was the QUESTION a good opener", which is a different
question with a different answer. It sends each starter from
`public/js/starters-data.js` as the first and only message to its agent, with
that agent's mode flags, and judges the run on capability / firstImpression /
quality plus a hard `deadEnd` flag — a clarifying question or refusal caps the
score below the shortlist floor however well the reply reads, because the
visitor is back at an empty box either way. Its output is a per-agent
shortlist of openers we know produce good answers, promoted into the registry
as `rank` + `evidence`. Two agents cannot be driven from the server (`secure`
runs browser-direct; `under-construction` is an archetype) and are reported as
skipped rather than silently omitted. Same disciplines as the other ledgers,
plus one of its own: judge capability on the phase timeline, not the
web-search counters — the modes that retrieve from source or from the outward
feed legitimately show zero searches. See the **starter-prompts** skill.

A fifth measures RETRIEVAL rather than answers — the **hosted arXiv eval**
(`scripts/arxiv-hosted-eval.mjs`, added 2026-07-29). It exists because
`scripts/arxiv-eval.mjs` measures the local binary pack with a 50-candidate
rerank pool, while the Worker queries Vectorize: **different pipelines**, and
the published 87% recall@1 / 96% recall@10 turned out to describe the one users
do not hit (the served path measured 78.7% / 81.3% before the pool was
corrected). It replays `src/arxiv-rag.js` over the Vectorize REST API and has
five subcommands — `sample` (build a gold corpus by sampling ids from the
independent GCS enumeration and hydrating via `get_by_ids`, never by querying
the index, which would select for papers that retrieve well), `coverage`
(per-month index coverage against that enumeration), `run`, `compare` and
`judge` (topical grades pooled across runs and graded once, so a before/after
delta measures retrieval rather than the judge).

Its disciplines are the ledger ones plus three specific to retrieval: a
carryover gold set whose papers exist in both indexes so only the distractor
count varies; **paired McNemar** rather than an independent binomial CI, since
at n=150 the latter's ±6.7-point interval calls almost every real effect noise;
and reporting needle AND topical, which disagree by construction when a corpus
grows — more literature is more distractors for "find this paper" and more
relevant work for "give me a good first page". The served time budget is
deliberately NOT enforced during a run: under it a slow leg silently drops the
rerank, and the table would then average two pipelines. Latency is measured and
reported instead. Unit tests for the pure logic are in
`scripts/arxiv-hosted-eval.test.mjs` and `scripts/arxiv-crosscheck.test.mjs`;
see the **arxiv-rag** skill.

### The ground-truth battery (`tests/dr-eval.mjs`) — is the answer RIGHT?

Added 2026-08-05. The rubric bench judges answers blind, so it measures
whether an answer reads well; it cannot measure whether it is correct, because
no correct answer is written down. This battery grades against published gold
answers — **FRAMES** (824 multi-hop questions, each naming the Wikipedia pages
it was built from), **SimpleQA** (4 326 single-fact) and **BrowseComp** (1 266
deliberately hard to find) — sampled with a fixed seed into
`tests/evalsets/*.json` by `scripts/dr-evalset.mjs`. BrowseComp rows stay
XOR-obfuscated in the committed file and are decrypted at load: the
obfuscation exists so the answers do not reach a training corpus, and a public
repo committing them in clear would be the leak it guards against.

It runs over **`POST /mcp`**, not `/api/chat` — what an external caller
actually experiences, and a fifth copy of `postOnce` avoided.

Four things it measures that nothing else here does:

- **Three-way accuracy** — correct / incorrect / **not attempted**. Declining
  to guess is not fabricating, and scoring them alike rewards confident
  invention. The headline is accuracy, accuracy-given-attempted, and their
  harmonic mean.
- **Retrieval separately from synthesis.** FRAMES names its source pages, so a
  wrong answer says which stage lost it: nothing retrieved, the right page
  never found (`retrieval_miss`), or the right page found and misread
  (`synthesis_miss`). The first run read 14 synthesis misses to 1 retrieval
  miss — a score alone would only have said "61.7%".
- **Deterministic citation reconciliation** — `[n]` markers in the prose with
  no entry in the source list, counted rather than eyeballed.
- **`--uplift`, the contamination control.** These three sets were rejected
  here in 2026-07 as contaminated, correctly: they predate every training
  cutoff in the catalogue. The control arm (`--arm nosearch`) is what makes
  them usable anyway — it turns the memorised share from an assumption into a
  measurement. FRAMES publishes the same control (≈0.40 closed-book, ≈0.66
  with multi-step search), so both numbers have an external reference.
  Measured 2026-08-05: FRAMES 35.0% → 61.7% (+26.7 points, p=0.0015), SimpleQA
  6.7% → 88.3%. Note the second: SimpleQA turns out **not** to be memorised on
  this catalogue at all. Publication date is not contamination; the control is.

```bash
BASIC_AUTH_USER=… BASIC_AUTH_PASS=… BERGET_API_KEY=… \
  node tests/dr-eval.mjs --set frames,simpleqa --label base
node tests/dr-eval.mjs --set frames --arm nosearch --label control
node tests/dr-eval.mjs --uplift  data/dr-eval/frames-base.json data/dr-eval/frames-control.json
node tests/dr-eval.mjs --compare data/dr-eval/frames-base.json data/dr-eval/frames-after.json
```

Verdicts are by **paired exact McNemar**, importing the test from
`scripts/rag-eval-core.mjs` rather than re-deriving it — the discipline the
retrieval side settled on and the bench side never adopted. At n=60 the
independent binomial interval is ±12 points and calls almost every real effect
noise. Run files land in `data/dr-eval/` (gitignored); the durable record is
`tests/DR-EVAL-FINDINGS.md`. Pure logic is pinned in
`tests/dr-eval-core.test.js`.

One trap it already paid for: reusing `hf-bench-lib.mjs`'s
`detectBenchmarkLeak` reported 9 of 30 BrowseComp runs contaminated, and 24 of
the 27 flagged URLs were ordinary arXiv papers. That list includes `arxiv.org`,
which is right for a battery drawn from HuggingFace-hosted ML datasets and
wrong here, where arXiv is a registered research source. **A detector
calibrated for one question set does not transfer to another.**

Because a branch push ships to production in this account (the **deploy**
skill, measured 2026-07-30), a before/after arm cannot use a preview URL — the
worker's `workers.dev` subdomain is disabled, so `wrangler versions upload`
produces no preview host. The A/B procedure is the documented one: run the
baseline, `wrangler versions deploy <id>@100%`, verify the change is live with
a probe that could only pass on the new code, then run the after arm. Keep the
outgoing version id — rollback is one `versions deploy` away.

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

> **Before blaming a commit for a REGRESSION, check the judge.**
> `node rejudge-probe.mjs <eval-bench-results/…> [reps]` replays an archived
> run's stored answer and stored sources — byte-identical to what the judge saw
> that day — and re-scores them now. Nothing deploys and no answer is
> regenerated, so the only variable left is the scoring. Two things it answers
> cheaply: whether the judge has drifted (score the same text across days), and
> what the judge's floor noise actually is (score the same text N times in one
> session). Measured 2026-07-30: **≈0.54 sd per question on text that did not
> change**, so ≈0.27 on a four-question battery mean. Any baseline claiming a
> tighter sd than that is reporting a coincidence, not a dispersion — which is
> what `bench-baseline.json`'s 0.042 at n=2 turned out to be, and why the gate's
> 0.15 floor has been reading REGRESSION on runs carrying no signal. Record a
> baseline at **n≥8** or its sd cannot support a verdict.
> Full working: `tests/EVAL-BENCH-FINDINGS.md`, entry of 2026-07-30 run 5.

### Attribution: which question moved, and which retrieval leg it touches

A battery mean cannot say *where* a change landed, and for six consecutive runs
that is exactly what was missing: the mean sat ~0.6 below baseline while a
hand-read of the per-question values showed `mh_semiconductor_export` carrying
most of it on its own. That detail was in data the gate already collected and
discarded at print time.

Compare mode now prints two tables from `tests/bench-drift-core.mjs` (pure,
unit-tested in `tests/bench-sources.test.js`):

- **per-question drift** — baseline vs candidate per question, most-negative
  first, with anything past ±0.5 flagged `<-- moved`. A question present on only
  one side shows `n/a` rather than being dropped, because a battery that gained
  or lost a question between measurements is a fact about the comparison.
- **per-source drift** — the same deltas rolled up by the retrieval sources each
  question's intent gate reaches. **The buckets OVERLAP** (a question reaching
  arXiv and Europe PMC counts toward both), so a source's mean is "how the
  questions that can reach this leg moved", never an exclusive attribution.
  The `(none)` bucket — questions no source reaches — is the **control**: if it
  moved as much as the source buckets, the drift is not about retrieval at all.

Read the per-question table before reasoning about the pipeline as a whole. One
question falling 1.2 and three holding is a different investigation from four
questions each falling 0.3, and the battery mean renders them identically.

### Source coverage is a build-time invariant

`tests/bench-sources.test.js` fails the build when a registered
`SEARCH_SOURCES` entry is reached by **no** benchmark question, and again when a
source declaring a `leadIntent` has no question that triggers its lead path.

This is not hypothetical hygiene. Audited 2026-07-31, `europepmc` — the
life-science leg **PubMed feeds** — was reached by zero of 34 questions, while
PubMed was being ingested as a second hosted corpus (PR #352). arXiv had
arrived through the same gap: it landed between the 07-23 baseline and the first
re-measurement with nothing measuring it on the way in, and six runs then sat
~0.6 low with no way to attribute the fall. A source no question reaches is a
source the gate reports NEUTRAL on whatever it does to answers.

So: **register a source, add a question that reaches it, in the same change.**
The bank is append-only (new id, never edit an existing entry) so past scores
stay comparable — adding questions does not invalidate a baseline, it means the
*next* baseline can see a leg the current one is blind to. The lead path gets
its own question because leading stands the whole web leg down, which is a
different behaviour from the source merely contributing, and the more dangerous
one to ship unmeasured. Both languages are required for the life-science leg:
the intent gate is bilingual by design (invariant 6), and a bank testing it only
in English would let the Swedish half rot unnoticed.
