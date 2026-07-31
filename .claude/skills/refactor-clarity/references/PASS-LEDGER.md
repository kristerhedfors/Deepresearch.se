# Pass ledger

One entry per whole-repo clarity pass. Read it for a worked instance of a seam
type, or for the last pass's SHA to diff from. Declines are summarized here and
recorded in full in `STANDING-DECLINES.md`.

Every pass held the same bar: byte-identical behavior, the whole unit suite
green throughout, typecheck clean.

## 1 — 2026-07-12, the founding pass

Five moves in one sweep:

- `index.js` (757→495) → `assets.js` + `security-headers.js`
- `chat.js` sanitizers → `validation.js`
- `resolveJsonModel`, byte-identical in `chat.js` and `mcp.js`, → `model-routing.js`
- `pipeline.js` (1148→1031) pure builders → `pipeline-inputs.js`
  (shellReplyMessages, notesSection, extractClaims, takeSearchBatch, …)
- `activity.js` pure functions → import-free `activity-core.js` (zoomToFov,
  sanitizeResearchEvent, searchServiceName, buildResearchDebugJson,
  formatStatsLine) — the unit target became DOM-free, matching `sse.js`

Each new module shipped with its own test file, covering logic that had none.
~1095 tests green.

## 2 — 2026-07-12, the de-dup pass

A follow-up after the survey showed `pipeline.js` fully extracted and
`stream.js` mostly irreducible orchestration. Two moves survived:

- **`billing.js`** (flagship): `summarizeSpend` (three-model-bucket split
  billing) + `exaCost` (depth tier + `/contents` surcharge) were defined in
  `chat.js` and re-inlined verbatim in `mcp.js`. New leaf imports only
  `bergetCost` / `CONTENTS_COST_MULTIPLIER`; `chat.js` re-exports
  `summarizeSpend` so `chat.test.js` is unchanged; `mcp.js` pulls it into its
  **dynamic** import block so the pipeline stays out of `mcp.test.js`.
  `billing.test.js` added the `exaCost` coverage that never existed.
- **`userTexts` → `message-content.js`**: a pure arrow function moved verbatim
  into the import-free core `stream.js` already imported, beside its consumer
  `asksDeviceLocation`.

First appearance of the `newRequestState` decline.

## 3 — 2026-07-13, the relocate-to-the-owner pass

Three survey fan-outs; `pipeline.js` (1290, grown purely by introspection
tool-calling *orchestration*) confirmed nothing left to extract. Four moves,
all "relocate an already-pure helper to the module that should own it":

- **`quotaBlockedResponse` (+`PERIOD_NAMES`) → `quota.js`** (flagship): the 429
  quota-window payload builder sat in `chat.js` but belongs beside
  `inflightLimitResponse` (whose comment already named it). `chat.js` imports
  it back and re-exports it; the three handlers that imported *only* this from
  `chat.js` (`quiz-api.js`, `bash-api.js`, `rag.js`) were repointed to
  `quota.js`, **dropping their whole `chat.js` dependency** — the decoupling
  win, not just tidiness.
- **`htmlResponse` + `textResponse` (×3 verbatim) → `http.js`**, completing the
  response-helper set the module's header comment already claimed.
  `htmlResponse` gained a `status = 200` default (behavior-neutral — every
  caller passed status explicitly).
- **`cleanStr` (×2 verbatim) → `chatlog.js`** beside `truncateForLog`, which it
  wraps and both files already imported; the now-unused `truncateForLog`
  imports dropped from both.

1318 tests green.

## 4 — 2026-07-15, the token-crypto pass

`chat.js` and `mcp.js` byte-unchanged since pass 1; `index.js` regrowth was
routing. Six moves:

- **`token-crypto.js`** (flagship de-dup): `b64url` / `b64urlDecode` / `toHex` /
  `safeEqual` + the namespaced HMAC `sign` were byte-identical across
  `websearch-key.js` and `proxy-grant.js` (`toHex` / `safeEqual` a third time
  in `auth.js`) — the proxy subsystem was born by copying the websearch token
  module. One leaf owns the primitives; **each token family keeps its own
  mint/verify** (the `svc` claim differs deliberately). Also carried
  `websearch.js`'s atomic-reserve concurrency comment onto `proxy.js`'s
  `reserveUnit`, where the generalization had dropped it.
- **`canonical.js`**: the canonical-origin 301 out of the untested entrypoint,
  with its Firefox Focus / `redirect_uri_mismatch` comment.
- **`idOk`**: `rag.js` ↔ `storage.js` byte-identical id validator, exported from
  `rag.js` (zero new graph edges — `storage.js` already imported from it).
- **Tokemon client views + `parseLatLng` → `tokemon.js`**: pure projections in
  `tokemon-api.js` (no test file) whose own header says game logic belongs in
  `tokemon.js`; now covered by `tokemon.test.js` (IVs / foe roster never leak).
- **`formatCount` → `notifications.js`** (client): the K/M abbreviator
  duplicated in `admin.js` / `account-views.js`, both of which already imported
  the shared-fragments module.
- **`wmHtml` → `drc-page-core.js`**: the one pure fragment the 2026-07-13 DRC
  pass (PR #66) left inlined in `drc.js`.

**Operational lesson:** a container reset destroyed the first, uncommitted
application of all six moves. Commit after *each* extraction.

## 5 — 2026-07-15, the grant-presentation pass

Two of three scopes came back "nothing left" — the PR #87 sandbox outbox flow
was authored with the convention already applied. Three moves:

- **`src/grant-http.js`** (flagship de-dup): `websearch.js` and `proxy.js` (born
  by generalizing it) carried six byte-identical inline blocks — the
  budget-exceeded 409 builder (×6), the adjust-result response ladder (×4, free
  variable = the not-found wording), the `resolveQuotaPatch` set/±/pause clamp
  arithmetic (×2), the web-result projections, the token-body parse guard, and
  three constants. One leaf (imports only `jsonResponse`) owns them; every
  moved symbol was **private**, so zero re-exports and zero test edits — the
  cleanest possible cut. *Note: none of these were function bodies, so the
  duplicate scanner cannot see this class of duplication.*
- **Exec bridge codec → `bash-core.js`** (client): the marker+base64 envelope
  inside `sandbox.js`'s `execInSandbox` — `execEnvelope` (carrying the
  RC-before-any-pipe exit-code fix comment verbatim, now pinned by a unit
  test), `parseExecEnvelope`, `concatChunks`, `base64ToBytes` — plus
  `exportFile`'s mount-tree guard as `isExportablePath`. `sandbox.js` keeps only
  VM glue (verified with `node --check`; the file is deliberately not
  Node-importable).
- **`workspacePayloadCarries` → `workspace-core.js`**: `drc.js`'s share-pane
  guard inlined the which-payload-keys-are-envelope-metadata fact.

## 6 — 2026-07-17, the grant-consolidation pass

Four fan-outs; `drc.js` and the introspection stack came back "nothing left".
Five moves:

- **`src/llm-proxy.js`** (flagship, a new seam type — *helper-in-orchestrator*,
  not a duplicate): `forwardLlmModels` / `forwardLlmCompletion` (+ `bergetBase`,
  the `LLM_*` bounds) were single-copy in `proxy.js` but consumed by
  `server-grants.js` **through** the bundle orchestrator, dragging
  `proxy-grant.js` and the bundle crypto into a graph that THE SERVER-TOKEN
  GUARANTEE test pins upstream-only. Moved verbatim to a leaf; the guarantee
  test's allowlist tightened `./proxy.js` → `./llm-proxy.js` and gained a leaf
  pin on the new module; new direct tests (key swap, field filter, clamp,
  refund ladder). Could not fold into `grant-http.js` — that leaf's charter
  forbids provider code.
- **`posInt` → `grant-http.js`**: the byte-identical config clamp in both
  defaults resolvers.
- **`projectedBoardItem` → `board.js`**: the boards' triple-copied single-item
  re-projection (table/catalog/projector — the `adjustResultResponse`
  free-variable precedent). Response wrapping stayed in each board so `board.js`
  keeps importing nothing.
- **Client sibling dedups over existing edges only**: `hex()` ×3 → exported from
  `public/cure/umbrella.js`; `canCanvas` / `reducedMotion` + three
  byte-identical `FINALE_*` pacing constants → exported from
  `umbrella-spinner.js` into `balloon-spinner.js`.
- **`grantMeterLine` → `drc-page-core.js`**: the two borrowed-capability
  Settings rows' status-line wording.

## 7 — 2026-07-19, the single-move pass

Four fan-outs. `pipeline.js` had grown 1290→1654 but entirely from SDK/SWE
build-mode and feedback-capture *orchestration* whose pure helpers were placed
in companions at authoring time. Exactly one move survived:

- **`withSources` → `sources.js`**: the numbered-source-list formatter (append a
  `Sources:` block unless the answer already carries one) was inline in
  `mcp.js` but belongs beside `sourceDigest`. Verbatim, with its
  double-print-guard comment; `mcp.js` pulls it via a **dynamic** import at the
  call site so `mcp.test.js` still loads without the source/search graph. New
  `sources.test.js` covers the append / no-sources / no-double-print paths.

The pass's real value was its decline reasoning — `bucket`, `sdkBuildTools`,
`newRequestState`, and the whole Se/cure client tier, including the hazard that
spawning a `-core.js` out of a `SECURE_SOURCE_REFS` file hides it from the SDK
distiller. 1843 tests green.

## 8 — 2026-07-23, the lockstep-mirror pass

Three fan-outs over code merged since pass 7 **plus an independent hash scan**
for byte-identical function bodies. All three fan-outs returned "none" — the
new subsystems were authored to the discipline (`pool-token.js` imports
`token-crypto.js` with a test pinning its import list to exactly that; `pool.js`
imports all six `grant-http.js` helpers; `server-errors.js` names its status
helper `normalizeErrorStatus` to dodge the `normalizeStatus` trap). The scan
found two cuts the fan-outs missed:

- **`useCaseTag` / `parseUseCaseRef` → `testpoints-core.js`** (flagship):
  byte-identical in `src/testpoints.js` and the client core, held together by a
  "keep the two in lockstep" comment — resolved by the class-X façade direction
  (the server imports the `public/js` core and re-exports), so `pipeline.js` and
  `src/testpoints.test.js` kept their import paths. The server side's richer
  comments carried onto the core verbatim.
- **`lerpCol` → exported from `public/cure/umbrella.js`**: byte-identical (with
  its `rgb` helper) in `umbrella-spinner.js`, which already imported the
  umbrella geometry/palette; the spinner's orphaned `hex` import dropped.

**Method lesson, now institutionalized:** keep the hash scan as a survey step —
agents reason about which duplications *should* exist; the scan finds the ones
that *do*. Pass 10 committed it as `scripts/dup-scan.mjs`.

## 9 — 2026-07-24, the new-subsystems pass

Three fan-outs (server growth including `pipeline.js` +258 and the
knowledge/space façades; the new client subsystems — space, source-peek,
ondevice, pool, the two seal cores; the Se/cure tier including `drc.js` +754)
plus the hash scan. The new subsystems were again authored to the discipline.
Five cuts:

- **`sdkReplyTail` cluster → `pipeline-inputs.js`**: the feedback-#13 closing
  shape (`sdkReplyTail`, `endsWithQuestion`, `SDK_ITERATION_QUESTION`), pure but
  inline among build orchestration and untested. Judgment call: it drags a pure
  `replyLinksTo` import from `build-pub.js` into the leaf — accepted, since
  `build-pub.js`'s top-level graph is only `http.js` + `sdk-tools.js`, and the
  alternative sink `sdk-core.js` is blocked (a client core cannot import server
  modules).
- **`drcFeedbackContext` → `drc-page-core.js`**: the feedback consent's pure
  prior-turn context builder out of `drc.js`'s DOM wiring. Both files stay
  `SECURE_SOURCE_REFS` / MANIFEST members, so no list edits. Its server twin
  `buildFeedbackContext` is a different shape — relocation, not unification.
- **`sha256hex` → `proxy-bundle.js`** (scan flagship): byte-identical (JSDoc
  included) and private in both new seal cores, which already imported
  `proxy-bundle`'s `b64url` helpers. Each core keeps its own frozen HKDF
  info/kind binding, so the two envelope formats still can never cross-open.
- **`escapeHtml` (4-char) → `markdown.js`**: byte-identical in `source-peek.js`
  and `docs-viewer.js` over their existing `renderMarkdownInto` edge. **Trap
  logged:** `notifications.js` exports a different 5-char variant (also encodes
  `'`); collapsing the two changes rendered output.
- **`worldRot` → `space-core.js`**: the embed renderer's yaw-then-pitch view
  rotation, composing `rotX` / `rotY` the core already owns.

**Mechanical lesson:** inserting an export above a function whose JSDoc sits
above your match point detaches that JSDoc from its function (TS7006 catches
it) — match on the comment and the function together.

## 10 — 2026-07-24, the skill-revision pass

Scope: code merged since pass 9 (only PR #247, Orchestrator mode) plus a
whole-repo run of the newly committed scanner. The pass's main product is the
skill rewrite itself; the code cut is one.

**Skill rewrite.** The skill had grown to 565 lines, of which 310 were this
ledger. Six defects fixed: the pass record was moved here so `SKILL.md` carries
method only; the accept/decline reasoning nine passes had evolved implicitly was
stated as the **five gates**; scattered declines became
`STANDING-DECLINES.md`; the §FOCUS priority list and the appended DistillSDK
section (which silently retracted it) were merged; the finishing obligations,
previously stated three times across two workflow steps and the traps, became
one checklist; and the stale "you may not be able to re-embed" note was
corrected — `BERGET_API_KEY` is present in these containers, so
`npm run bundle:rag` is routine.

**`scripts/dup-scan.mjs`** — the hash scan pass 8 called the highest-yield
survey step, committed instead of re-improvised. A dependency-free brace matcher
(no AST, invariant 5) hashes normalized function bodies across `src/`,
`public/js/`, `public/cure/`, `sdk/`, `scripts/`, and reports bodies appearing
in more than one file, plus a `--collisions` mode for same-name-different-body
pairs. Validation: on the tree at pass 10 it independently reproduced every
duplication the previous passes had found by hand, which is the reason to trust
its misses less than its hits. It is advisory input to the gates, never a
verdict. Unit-tested in `scripts/dup-scan.test.mjs`, which runs in `npm test`.

**The one cut:**

- **`scripts/pulse-time.mjs`**: `CET_TZ`, `CET_PARTS`, `cetOffsetMinutes`, and
  `toCetIso` were byte-identical in `build-pulse.mjs` and
  `build-pulse-timeline.mjs`, under a comment reading "mirrored from
  build-pulse.mjs so both pages bucket the same instant onto the same calendar
  day" — the copy-with-apology of seam type 2. Both are build scripts with no
  runtime graph, and `build-pulse-timeline.mjs` already imported a `scripts/`
  sibling (`pulse-themes.mjs`), so the sink and the edge shape both existed.
  Drift risk is the point: a DST fix applied to one copy would silently
  desynchronize the two published datasets. `pulse-time.test.mjs` covers the
  CEST/CET offsets, the DST boundary, and the invalid-input passthrough — the
  date arithmetic had no test at all.

**Declines** (all in `STANDING-DECLINES.md`): `esc` ×3, `smooth` / `clamp01`,
`trackedFiles`, `fallbackPlan`, plus the standing rows the scan re-surfaced.
Orchestrator mode itself needed nothing — `orchestrator-core.js` is a textbook
class-X core, and `src/orchestrator.js` is wave orchestration around it.

## 11 — 2026-07-26, the merge-queue pass

Scope: everything merged since pass 10 — PRs #291–#303, about 37k inserted
lines across 218 files, including six new subsystems (the Models agent,
Outrospection, DREE/1 local execution, the swarm runtime, the arXiv RAG core,
Cloudflare-native web search). Survey: the hash scan, then a reading pass over
the 17 new `src/` modules, the six most-grown ones, and the new non-core client
modules. **Two cuts.**

The new subsystems were, again, authored to this discipline — `websearch-cf.js`
is pure parsers with tests, `model-catalog.js` / `model-checks.js` /
`user-models.js` are already split, and the new client work arrived with its
`-core.js` already carved (`swarm-core.js`, `outrospect-core.js`,
`starters-core.js`, `pipeline-map-core.js`, `arxiv-rag-core.js`). Both cuts came
from the same place: the three side LLM endpoints, which grew up in parallel and
each re-inlined what the others had.

- **`recordDefaultModelUsage` → `quota.js`** (scan flagship, 20 lines): the
  fail-soft catalog lookup feeding a `usage_events` row for a one-off spend on
  the fixed JSON model, byte-identical as `recordPlanUsage`
  (`orchestrator-api.js`) and `recordGradeUsage` (`quiz-api.js`). `quota.js`
  already owned both primitives the body composes (`recordUsage` +
  `bergetCost`) and both callers already imported it, so the call sites gained
  no new edge at all; the single new edge in the change is `quota.js` →
  `berget.js`, which imports nothing. `billing.js` was the semantic sink and is
  BLOCKED — its header pins it pure and leaf so `mcp.js` can dynamic-import it.
- **`enforceQuotaAndReserve` → a new leaf `endpoint-gate.js`** (the reading
  pass; invisible to the scan because it is an inline BLOCK, not a function):
  nine lines — config, usage, admin bypass, 429, mint reqId, reserve the
  concurrency slot — inlined in `orchestrator-api.js`, `quiz-api.js` and
  `bash-api.js`, each under the same apologetic comment naming the others
  ("Same quota gate as /api/chat and …"). Worth a NEW module (the `grant-http.js`
  precedent) because every existing sink is blocked: `quota.js` cannot reach
  `getConfig` (`config.js` imports `quota.js` — circular) and deliberately
  returns plain objects rather than Responses; `billing.js` is pinned pure;
  `grant-http.js` is explicitly fenced to the two grant subsystems and would
  lose its leafness. This one is drift control on a cost-control invariant, not
  tidying — a change to who bypasses the gate, applied to one copy, would leave
  two endpoints silently unenforced.

Both cuts made previously-private, previously-untested logic testable, which is
where most of the value landed: `endpoint-gate.test.js` (6 cases) and three
`quota.test.js` cases now cover the admit path, the withheld EUR amount, both
admin bypasses, the concurrency cap, the degraded price, and the absent-database
path.

**A finding, pinned rather than fixed.** The gate's fail-soft story is
ASYMMETRIC: an ABSENT database admits, but a database that THROWS propagates out
of the usage read, because `getUsage` has no catch where `reserveInflight`
explicitly fails open. That was equally true of all three inlined copies, so the
test asserts the real behaviour and says why. Whether the quota read should fail
open like the reservation does is an owner question, not something to change
under a refactor — the first draft of that test asserted the tidier behaviour
and was wrong, which is how it was found.

**Method lessons.** Two worth keeping:

- The scan found cut 1 and could not have found cut 2. Its stated blind spot —
  inline blocks are not function bodies — is exactly where the higher-value cut
  was, and the tell was in prose the scan cannot read: a comment in each copy
  naming its siblings. **Grep the apology, not just the code**
  (`grep -rn "Same .* as /api" src/`).
- A `// @ts-check` test file pays a real cost: `assert.ok(x)` does not narrow a
  discriminated union's property under this tsconfig, so pinning a
  `Response | null` return needs casts or locals. Only 13 of 96 `src/*.test.js`
  opt in, and the closest analogues (`billing.test.js`, `llm-proxy.test.js`) do
  not. Leave a new endpoint test unchecked unless it tests types.

## 12 — 2026-07-29, the inline-block pass

Scope: everything merged since pass 11 (75769134) — about 15.8k inserted lines
across 133 files in `src`/`public`/`sdk`/`scripts`, including six new
subsystems: the Cloudflare-container execution backend
(`src/exec-container.js`), the MCP key/config/API trio, the arXiv search client
and its RAG retrieval, the DRSW manifest endpoint, the client session lease
(`session.js` + `session-core.js`), and the chat-mode collapse that retired the
`developer_mode` knob. **Three cuts.**

`scripts/dup-scan.mjs` returned **fourteen groups, all of them already in
`STANDING-DECLINES.md`** — the reading pass over the new subsystems returned
nothing either, because every one of them shipped factored (see the "whole
files examined" list). All three cuts came from an ad-hoc **line-run scanner**
built for the pass: normalize away comments and blank lines, hash every window
of N consecutive lines, report windows appearing in two or more files. That is
the scan's declared blind spot — inline blocks are not function bodies — and it
is where pass 11's higher-value cut lived too.

- **`readJsonBody` → `http.js`** (the widest): thirteen endpoint handlers across
  nine modules carried the same seven-line try/catch around `request.json()`,
  down to the wording of the 400. Answered like `enforceQuotaAndReserve`: the
  helper returns the `{body, response}` pair instead of throwing, so each caller
  keeps its own early return and no site's control flow changes. Every one of
  the thirteen already imported `http.js`, so the change adds **no graph edge
  anywhere**. The tolerant token-endpoint readings
  (`.catch(() => ({}))`, where a missing field is already its own 400) are
  deliberately untouched. New `src/http.test.js` also covers the three response
  helpers, which had no direct test.
- **`scripts/corpus-rag.mjs`**: `bundle-docs-rag.mjs` and `bundle-owasp-rag.mjs`
  were the same ninety-line program twice, differing in a corpus path, an output
  path and a "run X first" hint. Drift here is not cosmetic — the two indexes
  must share ONE format because `src/introspect.js` resolves their text the same
  way and `src/introspect.test.js` checks the chunk counts line up, so a change
  to the quantization or the index envelope applied to one copy desynchronizes
  them silently. Each bundler keeps its header comment, its three values and its
  own failure label (which names the script the operator ran).
  `bundle-source-rag.mjs` stays separate: delta rebuilds and a pacing gate the
  small corpora don't need. `planCorpusChunks` split out and exported so the
  `(path, chunk index)` planning half is testable with no key and no network.
- **`hmacRaw` + `verifiedClaims` → `token-crypto.js`**: five token families —
  `wsk1`, `prg1`/`prx1`, `pt1`, `mck1` and the Se/rver JWT — each carried the
  same recompute-tag / constant-compare / decode-payload preamble, on the one
  code path where a subtle fix must not reach four sites out of five. Both
  additions land in the leaf that already owns exactly this layer and that all
  five already import, so `server-token.js`'s pinned import list
  (`src/server-grants.test.js`) is unchanged. `sign` becomes
  `toHex(await hmacRaw(…))` and `server-token.js`'s `hs256` becomes
  `b64url(new Uint8Array(await hmacRaw(…)))` — the rendering difference is
  load-bearing family separation, so it stays at the call site.

**On the fence.** Standing decline 22 says do not merge the families'
mint/verify, and this pass did not: `verifiedClaims` stops at the cryptography
and hands back an UNVALIDATED claims object. Each family still parses its own
wire prefix, passes its OWN namespace in, and validates its own claims — `svc`
being the standing example. The fence was **restated in the module header and
in `docs/CODE-LAYOUT.md`, not removed**, with an explicit "do not grow
`verifiedClaims` toward claim validation". When re-reading a fence, check what
property it protects rather than how wide its wording is.

**Method lesson.** Committing `dup-scan.mjs` (pass 10) worked: it now returns
only settled declines, which is what a converged codebase should look like. But
that also means **the scan alone can no longer find anything** — all three cuts
this pass were invisible to it. Keep a line-run scan in the survey beside it; it
finds constants, import clusters and early-return preambles that a
function-body hash never will. The tell is the same one pass 11 named: the
duplicated block usually sits under a comment apologizing for itself.

## 13 — 2026-07-29, the enrichment-and-renderer pass

Diffed from `b3e68a0e` (pass 12's own commit, earlier the same day). A lot of
new surface had landed since: the palaeogenomics agent
(`src/aadr.js` + `public/js/aadr-core.js` + `src/europepmc.js`), the NHxx watch
builder (`watch-core.js` 2,690 lines, `watch-render.js` 1,107, `src/watch.js`),
the Cloudflare web-search backend (`websearch-cf.js`), and the
demo/space embed pairs. **Two cuts.**

`dup-scan` returned eighteen groups; sixteen were already in
`STANDING-DECLINES.md` and the two new ones supplied one cut and one decline.
`line-scan --run 8` produced seventy-nine runs, most of them import clusters —
the declared cost of that scan. The reading pass over the new subsystems found
the second cut and nothing else, because every one of them shipped factored.

- **`lastUserText` + `appendToLast` → `src/conversation.js`**: `src/aadr.js`
  and `src/models-agent.js` each carried both, byte-identical, 23 lines. The
  sink is textbook — `conversation.js` opens by declaring itself "utilities
  over the OpenAI-style message array" and already holds `lastUserMessage`,
  `previousUserText`, `lastAssistantText` and the two non-mutating appenders,
  so `lastUserText` is a missing sibling rather than a new role. On the home
  gate's part (b): neither enrichment imported it, but `enrichment.js` is
  reached from `pipeline.js`, which imports `conversation.js` already, so the
  new edges add no module to the bundle. **`enrichment.js` itself is not the
  sink** even though it owns the enrichment contract — it imports both
  enrichments, so the edge would be circular. `appendToLast` moved with its
  message-level signature intact and the one-line
  `[...conversation.slice(0, -1), …]` wrapper stayed at both call sites;
  lifting it to a conversation-level helper would have been a signature change,
  which is the verbatim gate. New tests pin the two properties the copies
  existed for: the SPACE join (not `textOf`'s newline, and no image marker,
  because the callers are intent gates matching a phrase across parts) and the
  new-text-part append that lets an attached photo survive.
- **The matrix band → `public/js/watch-math.js`**: 143 lines of column-major
  4×4 maths, the camera and the sRGB→linear conversion, sitting among
  `watch-render.js`'s WebGL orchestration under a section header that already
  named them as a unit. Single-copy — so this is seam type 1, not type 2, and
  the payoff is coverage: the band was unreachable from any test because the
  module needs a GL context and imports its core by served path. **The sink is
  a new leaf and deliberately not `watch-core.js`**, which the Worker imports
  through the `src/watch.js` façade to serve `/api/watch/catalog`; camera
  matrices are dead weight in a JSON endpoint. 20 tests assert known points
  rather than array contents, since wrong matrix code still renders — including
  the degenerate `eye === center` case, where the two `|| 1` guards are all
  that stand between the scene and a NaN matrix that blanks it.

**The trap this pass nearly walked into.** `/watch/` is a PUBLIC surface and
`src/assets.js` allowlists its module graph FILE BY FILE. A new static import
of `watch-render.js` that is not in that list 401s for signed-out visitors and
kills the page — and nothing in the suite goes red. Add the allowlist entry in
the same commit as any client split under a public surface (`/space/`,
`/watch/`, `/cure/`, the demo embeds); it belongs on the finishing checklist
next to `SECURE_SOURCE_REFS`.

**Method lesson.** The two new dup-scan groups split cleanly on ONE question:
does the shared body read a module-local constant, and do the two sites bind it
to the same value? `lastUserText`/`appendToLast` read nothing and were cut;
`rerankDoc`/`arxivRerankDoc` read `RERANK_DOC_CHARS`, which is a fixed 900 on
the server and env-overridable in the eval scripts, and were declined. That is
the `finalePhaseBucket` trap for the third pass running, and it now has a
sharper tell than "read the body": **when two copies of a body look identical,
diff their CONSTANTS before anything else.** The same question also settled the
`HKDF_INFO` pair in one step, where the differing constant is the domain
separation itself.

## 14 — 2026-07-31, the whitelist pass

Base `1581efe4` (main after PR #345). Surveyed the whole repo: `dup-scan`
(17 groups), `line-scan --run 8` (76 runs), the diff since pass 13 —
`src/memory.js` + `public/js/memory-core.js`, `src/watch-tools.js`,
`public/js/watch-chat-core.js`, `watch-materials.js`, `zip-core.js`,
`demo-mount.js`, `src/test-helpers/` — and the apology-comment grep
(`lockstep|mirrors|keep in sync`). **Two cuts.**

Fourteen of `dup-scan`'s seventeen groups were already in
`STANDING-DECLINES.md`. Of the three new ones, one supplied a cut and two were
declined. Every new subsystem since pass 13 shipped factored again:
`memory.js` is storage+HTTP over a `memory-core.js` that was carved at
authoring time, `watch-materials.js` imports `linear` from pass 13's own
`watch-math.js` rather than re-deriving it, and `demo-mount.js` was created BY
a feature change to stop `turns.js` and the Se/cure tier deciding the same
thing twice — the pattern working without a refactor pass in the loop.

- **`jsonCompletionResult` → `src/berget.js`**: the eleven-line
  `{ value, usage, diagnostics }` block that follows a non-streaming JSON call
  was hand-copied into `berget.js`, `openai.js` and `hf-inference.js`. The sink
  was already decided by the code: all three import `parseLooseJson` from
  `berget.js`, whose docstring declares it "Exported for other providers' JSON
  completions", so the adapter is a missing sibling of the shared tolerant-JSON
  layer rather than a new role — the `lastUserText` → `conversation.js`
  reasoning from pass 13. **`src/anthropic.js` was correctly left out**: its
  body reads `data.content` blocks and `input_tokens`/`output_tokens`, so it is
  a different function that happens to return the same shape. Note this cut
  does NOT reopen decline #52 (`anthropicModels`/`openaiModels`, declined
  because `berget.js` is the Berget CLIENT and not a catalog utility): the
  distinction is that the tolerant-JSON layer already lives there and is
  already documented as cross-provider, where the pricing catalog is not.
- **The deep-link action grammar → `public/js/testpoints-core.js`**:
  `ACTION_TYPES` (server validator) and `CLIENT_ACTION_TYPES` (client executor)
  were the same eleven strings in the same order, each under a comment telling
  the reader to keep it in lockstep with the other — in a module that ALREADY
  carries "Do not reintroduce a copy" over `useCaseTag`/`deepLink` four hundred
  lines down. The server copy's per-action payload comments were the better
  documentation and travelled with the list. `src/testpoints.js` imports it and
  re-exports it as `ACTION_TYPES`, so both public surfaces are unchanged.

**Why the grammar was worth cutting when `esc` and `el` are not.** All three
are small duplications with a "someone should share this" smell. The
difference is what happens when the copies diverge. A second `esc` that drifts
produces visibly wrong HTML in one view. A second action list that drifts
produces NOTHING visible: the grammar's own drop-don't-reject rule means an
action on the producer's whitelist but not the executor's list is declared,
accepted, stored, and then silently skipped on arrival. **Drift that the
system is designed to swallow is worth a cut at a size that would not
otherwise earn one** — which is the bar gate's "will the copies drift"
question answered by consequence rather than by line count.

**Method lesson — read what a duplicated whitelist GUARDS before unifying it.**
The apology-comment grep turned up a third list family that looks exactly like
the action grammar: `["browser","local","cloudflare"]` in `src/bash-api.js`
and `src/validation.js`, both under "mirrors `EXEC_BACKENDS`" comments, with a
real source of truth sitting in `public/js/exec-backends-core.js` and a
one-line derivation available. It is the opposite call. Those two are
sanitizers over untrusted client input, and `validation.js` says so at the
site — "nothing here is allowed to widen it (invariant 4)". Deriving them
would make adding a row to a UI picker widen what the server accepts and logs,
in a subsystem whose whole job is to not do that. Shape and size sort these two
into the same bucket, so ask what the list is FOR instead: **a list two
components must AGREE on wants one copy; a list one component uses to DISTRUST
another wants two.** The action grammar is the first; the exec-backend
whitelists (and `SWARM_DIAG_PHASES`/`SWARM_DIAG_CLASSES` beside them) are the
second.
