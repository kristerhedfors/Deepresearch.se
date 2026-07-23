---
name: refactor-clarity
description: >-
  Load when asked to refactor for clarity/modularity, split a large file,
  extract a pure core out of an orchestrator, de-duplicate a copied helper, or
  "clean up" a module — anywhere the goal is structure, not behavior. Covers
  this repo's specific refactoring method: the pure-core convention it already
  follows (the `-text.js` / `-core.js` split), what MUST be preserved
  (byte-identical behavior, the load-bearing invariants, the institutional
  comments, the module-graph constraints, public import surfaces), what to
  focus on (residual pure helpers → testable companion modules; verbatim
  duplicates → leaf modules), the baseline→survey→extract→verify workflow, and
  the traps (local typedefs, the source-snapshot freshness, client vs server
  risk). Also how DistillSDK changed the calculus: the pure-core convention is
  now the SDK's class-X / PA-7 shared-core contract and SDK mode DISTILLS the
  Se/cure source, so client-side Se/cure core extractions gained value — and
  moving a file named in `SECURE_SOURCE_REFS` (sdk-core.js) or a
  `sdk/MANIFEST.json` `reference` list breaks the distiller with NO test
  catching it. Canonical worked example: the 2026-07-12 clarity pass that added
  assets.js / security-headers.js / model-routing.js / pipeline-inputs.js /
  activity-core.js.
---

# Refactoring for clarity and modularity

**This codebase is already heavily modular. The job is almost never a rewrite —
it is finishing a split the project's own convention already implies.** Every
large feature here is meant to be a *pure/testable core* + *orchestration* +
*block/text builders* (see `googlemaps.js` → `googlemaps-text.js` +
`googlemaps-blocks.js`; `sse.js` and `message-content.js` extracted out of
`stream.js`; the `board.js` core behind every admin panel). A good refactor
extends that pattern to the one place it hasn't reached yet. A bad refactor
manufactures churn, moves things that aren't pure, or changes behavior.

If you cannot name the *seam* — the pure function, the self-contained concern,
the verbatim duplicate — don't cut. Length alone is not a defect: a 1700-line
registry of small matchers (`googlemaps-text.js`) or a 1000-line runner-per-shape
file (`maps-enrichment.js`) is inherent complexity, not tangling.

## What to PRESERVE (non-negotiable)

1. **Byte-identical behavior.** Every extraction is a *verbatim move* of the
   function body, re-imported at the original call site. If the diff changes
   any logic, it is no longer this kind of refactor — stop and treat it as a
   feature change. The proof is the existing test suite staying green with no
   test-expectation edits (only import-path edits).

2. **The load-bearing invariants** (CLAUDE.md "Load-bearing invariants"). Never
   let a split touch: deterministic orchestration with NO function calling;
   fail-soft helper phases; split model routing (JSON phases on the fixed
   reliable model); the privacy split; minimal dependencies; EN+SV intent
   parity. In practice: **do not restructure `runPipeline`'s flow, `jsonPhase`,
   or the streaming/validation phases** — extract the *pure builders they call*,
   not the phases themselves.

3. **The institutional-knowledge comments.** The `// found live 2026-07-11:
   …` notes, the DRC `/cure` public-module-graph allowlist rationale, the COEP
   `require-corp` explanation — these encode bugs that cost real time. Carry
   them **verbatim** into the new module. They are load-bearing; losing them
   re-opens the incident.

4. **Module-graph constraints** (client side especially):
   - `public/js/vault.js` must NEVER enter the `/cure` (DRC) graph — public
     modules import `vault-core.js`. If you split a public module, keep its
     import chain public.
   - `src/mcp.js` keeps its heavy deps behind a **dynamic** `import()` so
     `mcp.test.js` can load it without the pipeline. A new shared module you
     make it import must be a **leaf** (imports nothing heavy), or it goes in
     the dynamic block, not the top.
   - Leaf modules (`model-routing.js`) import nothing so neither handler graph
     is pulled into the other.
   - **The Se/cure (`/cure`, `drc-*`) class-C boundary is now doubly
     load-bearing.** It was always a module-graph rule (keep the browser graph
     off server modules); DistillSDK formalized it as **PA-1's class rule** — a
     class-C module's graph may not import a class-S module — because SDK mode
     *distills the Se/cure source into standalone flavours*. A pure core you
     extract from a `drc-*.js` / `public/cure/*` file must stay class-C-safe
     (no server import, no DOM-only dependency), or you have quietly made that
     file harder to distill. Splitting Se/cure toward cleaner pure cores is a
     GOOD refactor for exactly this reason (see the DistillSDK reframing below).

5. **Public import surfaces.** If other modules or tests import a symbol you're
   moving, **re-export it from the original file** (`export { x } from
   "./core.js"` or import-then-export) so importers are unchanged — then
   optionally repoint the test to the new pure module to get a DOM-free target.
   Grep for every importer before moving (`grep -rn "symbolName"
   public/js src`).

## What to FOCUS on (the high-value, low-risk moves)

In rough priority order (all behavior-preserving, all verified by tests):

1. **Residual pure helpers → a companion module.** Input-block builders,
   output parsers, sanitizers, formatters mixed in among orchestration
   functions. Confirm each is *truly pure* — no `ctx`/`env`/`emit`/`await`, no
   DOM — then move it. This is the biggest win: it shrinks the orchestrator to
   its flow AND unlocks direct unit tests for logic that usually had none.
   *Example:* `pipeline.js` → `pipeline-inputs.js` (shellReplyMessages,
   notesSection, extractClaims, takeSearchBatch, …).

2. **Verbatim duplicates → one leaf module.** A function copied into two files
   (with a comment apologizing for the copy) is drift waiting to happen. Move
   it to a leaf module both import. *Example:* `resolveJsonModel`, byte-identical
   in `chat.js` and `mcp.js`, → `model-routing.js`.

3. **Self-contained concerns out of an untested entrypoint.** `src/index.js`
   has no test and nothing imports it, so anything moved OUT of it into a
   module becomes testable — a strict improvement. *Example:* asset serving +
   the public allowlist → `assets.js`; the CSP/security headers →
   `security-headers.js`.

4. **Client pure logic → an import-free core**, re-exported by the original.
   Lower priority (client is live-verified, not just unit-tested), so keep it
   to a *pure relocation only*. *Example:* `activity.js` → `activity-core.js`
   (zoomToFov, sanitizeResearchEvent, searchServiceName, buildResearchDebugJson,
   formatStatsLine). Bonus: the unit target becomes DOM-free (no
   settings.js/imagedeck.js in its graph), matching `sse.js`.

Prefer **server-side splits** (protected by the unit suite) over **client
splits** (verified live). When you must split client code, do the smallest
possible pure relocation and confirm the original file still *links* in Node.

## DistillSDK reframing (2026-07-19) — the pure core is now a shipped contract

The `-core.js` convention this whole skill extends is no longer just *this
repo's* taste. **DistillSDK** (`sdk/`) codified it as two of its load-bearing
contracts — **class X** (shared substrate: "logic needed by both tiers is
written ONCE as a pure, Node-testable core under the client tree; the server
imports it through a façade re-export") and **PA-7** (the shared-core rule) —
and **SDK mode** (the green dropdown entry) now *reads the deployed source and
distills it into new flavours*. That changes the refactor calculus in three
concrete ways:

1. **Client-side Se/cure core extractions gained value.** This skill used to
   rank client splits LAST (priority 4) because the client is live-verified,
   not just unit-tested — so the payoff (a DOM-free unit target) was modest
   against the live-verify cost. DistillSDK adds a second payoff: a clean pure
   core inside a `drc-*.js` / `public/cure/*` file is exactly the class-C
   boundary SDK mode reshapes into a flavour. A well-factored Se/cure is a
   more distillable Se/cure. So a *pure relocation* out of a Se/cure file (kept
   class-C-safe, per the module-graph note above) is now a higher-value move
   than the old ordering implies — still smallest-possible, still link-checked
   in Node, but no longer bottom of the list. It does NOT license behavior
   changes or churn: the byte-identical bar (§"What to PRESERVE" #1) is
   unchanged.

2. **The manifest tells you where the next seam is.** `sdk/MANIFEST.json`
   already declares, per module, the exact `reference` files that realize it.
   A module whose `reference` names several files where pure logic is tangled
   with orchestration is a *pre-surveyed* refactor candidate — extracting the
   pure core aligns the code with the boundary the SDK already asserts. Read
   the module's `sdk/skills/<id>/SKILL.md` (its "reference implementation" map)
   before cutting; the acceptance checklist there is a second, SDK-level
   statement of the behavior you must preserve.

3. **Two new lists silently couple to file moves** — see the traps below.

None of this adds a step for a *server-side* dedup that touches neither Se/cure
nor a referenced file: the SDK reframing is a lens on WHICH client seams are
now worth cutting and a drift hazard when you move referenced files, not a new
mandate. A whole-repo pass still yields a short list of relocations — that
remains the correct outcome.

## The workflow

1. **Baseline GREEN first.** `npm test` and `npm run typecheck` must pass
   before you touch anything (`npm install` once for the dev deps —
   `typescript` + workers-types). If the baseline is red, fix or note that
   first; you can't attribute a later failure otherwise.

2. **Survey, don't guess.** `wc -l src/*.js public/js/*.js | sort -rn`. For the
   biggest orchestrators, fan out `Explore` agents to map the distinct concerns
   with line ranges and flag which are *cleanly separable* (pure) vs *coupled*.
   The agent's job is to find seams; yours is to verify each candidate is
   actually pure by reading it.

3. **Extract, one module at a time.** Create the new module (copy bodies +
   their comments verbatim); import them back into the origin; re-export the
   public ones; delete the originals. Update the origin's module-map comment.

4. **Test as you go.** After each module, run just its tests + the touched
   files' tests + `npm run typecheck`. Add unit tests for anything newly
   testable — that's a chunk of the value.

5. **Full verify.** `npm test` (whole suite) + `npm run typecheck`. For a
   client split, also `node -e "import('./public/js/<file>.js').then(...)"` to
   confirm it links.

6. **Regenerate the source snapshot LAST.** `npm run bundle` rebuilds
   `public/introspect/source-snapshot.json` from every tracked text file — and
   `CLAUDE.md` IS one of them. A unit test (`src/introspect.test.js`) fails
   `npm test` if the snapshot is stale. So: make ALL edits (code *and* CLAUDE.md
   *and* this skill) first, then `npm run bundle`, then the final `npm test`.
   Running bundle before a doc edit just makes it stale again.
   **There are TWO freshness tests, not one** — and a refactor is the classic
   way to trip the second. Besides the snapshot check, `src/introspect.test.js`
   also enforces that the committed source-RAG index
   (`public/introspect/source-rag.json`) has no stale chunk refs: removing a
   file, renaming it, or shrinking one enough to shift its chunk boundaries
   (i.e. exactly what moving function bodies OUT of an origin file does) makes an
   indexed `(path, chunk)` stop resolving, and `npm test` goes red. Fix with
   `npm run bundle:rag` and commit the regenerated index — but note it needs a
   Berget key or the break-glass creds to re-embed (unlike `npm run bundle`,
   which needs nothing), so run it after `npm run bundle` as part of the final
   pass. If you can't re-embed in-session, at minimum surface that the index is
   stale rather than leaving `npm test` red silently.

7. **Document.** Add each new module to the `docs/CODE-LAYOUT.md` **Code
   layout** table (and the client prose for client modules), and add this
   skill to the CLAUDE.md skills list if not present. **If any file you moved,
   renamed, or split is named in `SECURE_SOURCE_REFS` (public/js/sdk-core.js)
   or a `sdk/MANIFEST.json` `reference` list, fix those in this same commit**
   (see the two SILENT-drift traps below — nothing goes red if you forget).
   Then re-bundle (step 6 order).

## Traps that cost time here

- **Local typedefs aren't in `types.js`.** `PipelineState` is a `@typedef` local
  to `pipeline.js`, not an export of `types.js` — a moved function that
  references it throws TS2694. Fix: inline the *minimal structural shape* the
  moved function needs (e.g. `{ ranQueries: Set<string>, searchCount: number,
  plan: { maxSearches: number } }`), or `import('./origin.js').Type` if a
  circular type-only import is acceptable. Don't reach for `types.js`.
- **The Bash working directory persists between calls.** A `cd public/js` in one
  call leaves the next call there; `head public/js/x.js` then looks for
  `public/js/public/js/x.js` and "file not found" lies to you. Use absolute
  paths or re-`cd` to the repo root.
- **`export { x } from "./core.js"` vs import-then-export.** Both work; pick
  import-then-export when the origin also *uses* `x` internally (one local
  binding, one export), so you don't import and re-export the same name two
  ways.
- **Don't hand-edit the snapshot JSON.** It's generated. If `npm test` fails on
  "source snapshot artifact matches the working tree", the fix is `npm run
  bundle`, never editing the artifact. If it instead fails on "source-rag index
  is consistent with the current snapshot", that's the SECOND freshness test —
  the fix is `npm run bundle:rag` (needs a Berget key / break-glass creds),
  never hand-editing `source-rag.json` either.
- **`SECURE_SOURCE_REFS` drift is SILENT — no test guards it.** `export const
  SECURE_SOURCE_REFS` in `public/js/sdk-core.js` is the explicit allowlist of
  Se/cure files SDK mode points the distiller at (`public/cure/index.html`,
  `public/cure/drc.{js,css}`, the `public/js/drc-*.js` cores,
  `sdk/skills/secure-tier/SKILL.md`). If your refactor **renames, moves, or
  splits** one of these, the distiller reads a stale or missing ref and NO unit
  test fails (it only feeds a prompt string). Update the array in the SAME
  commit — treat it like the `/cure` public-module-graph allowlist. If a split
  produces a new pure core that the distiller should also study, add it.
- **`sdk/MANIFEST.json` `reference` paths drift SILENTLY too.** Each module's
  `reference: [...]` names the exact `src/`/`public/` files that realize it.
  `sdk_validate` / `snapshotFileCheck` only verify SKILL files exist — NOT the
  `reference` paths — so moving a referenced file leaves a dangling pointer with
  a green suite. When a moved/renamed file appears in a `reference` list, fix
  that list (and `sdk/DESIGN.md` / `docs/DISTILLSDK.md` if the module's file map
  is described there) alongside `docs/CODE-LAYOUT.md` in step 7's mirror
  discipline. Grep both before finishing: `grep -rn "<oldpath>" sdk/
  public/js/sdk-core.js`.

## Canonical worked example (2026-07-12)

A single clarity pass, all five moves above, ~1095 unit tests green throughout,
typecheck clean, no behavior change:
`index.js` (757→495) → `assets.js` + `security-headers.js`; `chat.js`
sanitizers → `validation.js`; `resolveJsonModel` dup → `model-routing.js`;
`pipeline.js` (1148→1031) pure builders → `pipeline-inputs.js`; `activity.js`
pure fns → import-free `activity-core.js`. Each new module shipped with its own
test file, adding coverage to logic that previously had none.

## Second worked example (2026-07-12) — the de-dup pass

A follow-up pass after the survey showed `pipeline.js` was already fully
extracted (no residual pure helpers) and `stream.js` was mostly irreducible
orchestration. Two clean moves survived that scrutiny — the point being that a
"run the skill on the whole repo" job often yields **fewer** cuts than expected,
and that's correct, not a shortfall:
- **`billing.js`** (server, flagship de-dup): `summarizeSpend` (the
  three-model-bucket split-billing totals) + `exaCost` (depth-tier + `/contents`
  surcharge) were defined in `chat.js` and **re-inlined verbatim** in `mcp.js`.
  Moved both to a new leaf module (imports only `bergetCost`/
  `CONTENTS_COST_MULTIPLIER`); `chat.js` re-exports `summarizeSpend` so
  `chat.test.js` is unchanged; `mcp.js` pulls `billing.js` into its **dynamic**
  import block (not the top) so the pipeline stays out of `mcp.test.js`. New
  `billing.test.js` adds the `exaCost` coverage that never existed.
- **`userTexts` → `message-content.js`** (client, smallest-possible relocation):
  a pure arrow fn moved verbatim into the import-free core `stream.js` already
  imports from, right next to its consumer `asksDeviceLocation`; a
  `message-content.test.js` case added.
The near-duplicate `newRequestState` (chat.js vs mcp.js) was deliberately NOT
unified — the two objects are different shapes, so sharing them needs a
base+extend split, which is a feature-shaped change, not a byte-identical move.

## Third worked example (2026-07-13) — the relocate-to-the-owner pass

Another whole-repo survey (three `Explore` fan-outs: pipeline.js, chat.js +
index.js, and an all-of-`src` duplicate sweep). `pipeline.js` (now 1290, grown
from the 2026-07-12 pass purely by introspection tool-calling *orchestration*,
not pure logic) confirmed **nothing left to extract** — the pure-core split is
complete. Four clean moves survived, all "relocate an already-pure helper to
the module that should own it," none new-extraction:
- **`quotaBlockedResponse` (+`PERIOD_NAMES`) → `quota.js`** (flagship): the 429
  quota-window payload builder lived in `chat.js` but sits naturally next to its
  sibling `inflightLimitResponse` in `quota.js` (whose comment already named it).
  `chat.js` imports it back for internal use AND re-exports it (the billing.js
  pattern) so `chat.test.js` is unchanged; the three handlers that imported ONLY
  this from `chat.js` (`quiz-api.js`, `bash-api.js`, `rag.js`) were **repointed
  to `quota.js`, dropping their whole `chat.js` dependency** — the decoupling
  win, not just tidiness.
- **`htmlResponse` (index.js) + `textResponse` (×3 verbatim: testpoints.js,
  chatlog.js, feedback.js) → `http.js`** — completes the response-helper set
  (`jsonResponse`/`sseResponse`/`htmlResponse`/`textResponse`) in the module
  whose header comment already claims that role. `htmlResponse` gained a
  `status = 200` default to match its siblings (behavior-neutral; every caller
  passed status explicitly).
- **`cleanStr` (×2 verbatim: testpoints.js, feedback.js) → `chatlog.js`** next to
  `truncateForLog` (which it wraps and both files already imported) — so the
  now-unused `truncateForLog` import dropped from both. New `chatlog.test.js`
  cases cover it directly.
As before, the point is that a "refactor the whole repo" job on an
already-modular codebase yields a **short** list of relocations, and that is the
correct outcome — 1318 logic tests green throughout, typecheck clean, zero
behavior change.

## Fourth worked example (2026-07-15) — the token-crypto pass

Whole-repo survey again (three `Explore` fan-outs: the new websearch/proxy
grant subsystems, index.js/chat.js/mcp.js regrowth, and an everything-else
duplicate sweep). chat.js and mcp.js were byte-unchanged since 2026-07-12 —
no new seams — and index.js's regrowth was all routing dispatch (correctly
left alone). Six moves survived:
- **`token-crypto.js`** (flagship de-dup): `b64url`/`b64urlDecode`/`toHex`/
  `safeEqual` + the namespaced HMAC `sign` were byte-identical across
  `websearch-key.js` and `proxy-grant.js` (toHex/safeEqual a THIRD time in
  `auth.js`) — the proxy subsystem was born by copying the websearch token
  module. One leaf now owns the primitives; each token family keeps its OWN
  mint/verify (the `svc` claim differs deliberately — do NOT merge those).
  Also carried websearch.js's atomic-reserve concurrency comment onto
  proxy.js's `reserveUnit`, where the generalization had dropped it.
- **`canonical.js`**: the canonical-origin 301 (pure over `url`) out of the
  untested entrypoint, with its Firefox Focus/redirect_uri_mismatch comment.
- **`idOk`**: rag.js ↔ storage.js byte-identical id validator; exported from
  rag.js (storage.js already imported from it — zero new graph edges).
- **Tokemon client views + `parseLatLng` → `tokemon.js`**: pure projections
  in tokemon-api.js (no test file) whose own header says game logic belongs
  in tokemon.js; now covered by tokemon.test.js (IVs/foe roster never leak).
- **`formatCount` → `notifications.js`** (client): the K/M abbreviator
  duplicated in admin.js/account-views.js; notifications.js is exactly the
  two-views-shared-fragments module and both already import it.
- **`wmHtml` → `drc-page-core.js`** (client): the one pure fragment the
  2026-07-13 DRC pass (PR #66) left inlined in drc.js.
Declined on principle: the Se/cure public route group (dispatch-only glue),
`rankVisionModels` (a carve-out, not a relocation), the table-name-
parameterized meter helpers, `normalizeStatus` (needs parameterizing), and
the cross-tier `b64ToF32` (server/client module graphs must not share).
OPERATIONAL LESSON: a container reset mid-session destroyed the first,
uncommitted application of all six moves — commit after EACH extraction,
not at the end of the pass.

## Fifth worked example (2026-07-15) — the grant-presentation pass

Whole-repo survey again (three `Explore` fan-outs: the websearch/proxy grant
subsystems incl. the new quota-adjust endpoints, the PR #87 sandbox outbox
flow, and drc.js/workspace + an everything-else src sweep). Two scopes came
back essentially "nothing left" — the outbox flow was AUTHORED with the
pure-core convention already applied, and the src-wide sweep found only
same-name-different-body pairs (feedback vs testpoints `normalizeStatus`) and
the intentional per-board façade parallels. Three moves survived:
- **`src/grant-http.js`** (flagship de-dup): websearch.js and proxy.js (born
  by generalizing it) carried six byte-identical inline blocks — the
  budget-exceeded 409 builder (×6!), the adjust-result response ladder (×4,
  free variable = the not_found wording), the `resolveQuotaPatch` set/±/pause
  clamp arithmetic (×2), the web-result projections, the token-body parse
  guard, and three constants. One leaf (imports only `jsonResponse`) now owns
  them; every moved symbol was PRIVATE, so zero re-exports and zero test
  edits — the cleanest possible cut. The table-name-parameterized meter set
  (`outstandingRemaining`, reserve/refund) stays declined per the prior pass,
  and the token-family mint/verify duplication stays fenced off by the
  token-crypto.js namespace comment.
- **Exec bridge codec → `bash-core.js`** (client): the marker+base64 envelope
  inside `sandbox.js`'s `execInSandbox` — `execEnvelope` (carrying the
  RC-before-any-pipe exit-code fix comment verbatim, now PINNED by a unit
  test), `parseExecEnvelope`, `concatChunks`, `base64ToBytes` — plus
  `exportFile`'s mount-tree guard as `isExportablePath` next to `OUTBOX_PATH`.
  An "output parser mixed into orchestration" carve-out that earns its keep
  because it makes the exec protocol testable; sandbox.js keeps only VM glue
  (verified with `node --check` — the file is deliberately not Node-importable).
- **`workspacePayloadCarries` → `workspace-core.js`**: drc.js's share-pane
  guard inlined the which-payload-keys-are-envelope-metadata fact
  (`v`/`kind`/`name`) that belongs beside `buildWorkspacePayload`.
Declined on principle: the repo-wide `base64ToBytes` idiom dedup (7 files
across separate module graphs — churn, not drift risk) and unifying the two
FNV-1a hashes (`sandbox-files.js` `projHash` vs `sandbox.js` `cacheIdFor` —
the latter feeds the VM disk-cache identity, where even an
equivalent-looking rewrite risks invalidating every user's cached VM image).

## Sixth worked example (2026-07-17) — the grant-consolidation pass

Whole-repo survey (four `Explore` fan-outs: drc.js, the new Se/rver-token
subsystem, the introspection/on-device stack, and an everything-else duplicate
sweep). Two scopes came back "nothing left" — drc.js's pure fragments had all
already moved to drc-page-core.js, and the introspection stack was authored
fully factored. Five moves survived:
- **`src/llm-proxy.js`** (flagship, a NEW kind of seam: *helper-in-orchestrator*,
  not a duplicate): `forwardLlmModels`/`forwardLlmCompletion` (+ `bergetBase`,
  the `LLM_*` bounds) were single-copy in proxy.js but consumed by
  server-grants.js THROUGH the bundle orchestrator — dragging proxy-grant.js
  and the bundle crypto into a module graph that THE SERVER-TOKEN GUARANTEE
  test pins upstream-only. Moved verbatim to a leaf (imports only
  `jsonResponse`); the guarantee test's allowlist tightened `./proxy.js` →
  `./llm-proxy.js` AND gained a leaf pin on the new module; new direct tests
  (key swap, field filter, clamp, refund ladder). Couldn't fold into
  grant-http.js — that leaf's charter forbids provider code.
- **`posInt` → grant-http.js**: the byte-identical positive-int config clamp in
  both defaults resolvers (websearch.js open-codes the same clamp inline — left
  alone: rewriting expressions isn't a verbatim move).
- **`projectedBoardItem` → board.js**: the boards' triple-copied single-item
  re-projection (table/catalog/projector = the three things that identify a
  board — the `adjustResultResponse` free-variable precedent). Response
  wrapping stayed in each board so board.js keeps importing nothing.
- **Client sibling dedups over EXISTING edges only**: `hex()` ×3 → exported
  from `public/cure/umbrella.js`; `canCanvas`/`reducedMotion` + the three
  byte-identical `FINALE_*` pacing constants → exported from
  umbrella-spinner.js into balloon-spinner.js (the boomerang-clock edge). The
  parameterization-needing trio (`planFinale`/`finalePhaseBucket`/
  `spinnerStyle` — read module-local MARKS/FLEET/apex) stayed declined per the
  `normalizeStatus` precedent.
- **`grantMeterLine` → drc-page-core.js**: the two borrowed-capability Settings
  rows' status-line wording (Se/rver token + proxy bundle), the client
  counterpart of grant-http.js's stay-in-lockstep rationale.
Declined: the DRS/DRC source-tool loop drivers (same shape, different WIRE
protocols — Anthropic content-blocks vs OpenAI tool_calls — the exact opposite
of bash-core's one-protocol premise), `buildSourceToolUserContent` (~2 shared
prompt lines), the dev-mode theme-toggle dedup (deliberate tier divergence +
/cure allowlist), `sumRemaining` (tiny, inline in one endpoint each), and the
table-parameterized meter cluster (standing decline, third pass running).

## Seventh worked example (2026-07-19) — the single-move pass

Whole-repo survey again (four `Explore` fan-outs: `pipeline.js` alone,
`chat.js`/`index.js`/`mcp.js`, an all-of-`src` verbatim-duplicate sweep, and the
Se/cure client tier `drc.js`/`drc-research.js`/`drc-providers.js`). `pipeline.js`
had grown 1290→1654 but ENTIRELY from SDK/SWE build-mode + feedback-capture
*orchestration* whose pure helpers were placed in companions at authoring time
(`sdk-tools.js`/`build-tools.js`/`introspect-tools.js`/`pipeline-inputs.js`) —
nothing left to extract. `chat.js`/`mcp.js` were byte-unchanged since prior
passes; `index.js` regrowth was routing dispatch (left alone). Exactly ONE clean
move survived, and the pass's real value is the DECLINE reasoning below:
- **`withSources` → `sources.js`** (the only cut): the numbered-source-list
  formatter (append a `Sources:` block unless the answer already carries one)
  was inline in `mcp.js` but is a pure string builder belonging beside its
  sibling `sourceDigest` in the source-registry module. Verbatim move with its
  double-print-guard comment; `mcp.js` pulls it via a **dynamic** import at the
  call site (next to `recordChatLog`) so `mcp.test.js` still loads without the
  source/search graph (`sources.js` → `search-sources.js` → `hf.js`). New
  `sources.test.js` cases cover the append / no-sources / no-double-print paths
  that had no coverage inline.
Declined this pass (record so the next pass doesn't re-survey them):
- **`bucket = (env) => (env.STORAGE)` ×5** (storage/build-pub/rag/vault/pub) —
  byte-identical, but every home is awkward: `storage.js` would be CIRCULAR
  (it imports `rag.js`), `settings.js` is NOT a leaf (pulls googlemaps/shodan
  into build-pub/pub), and `http.js` is a semantic mismatch (response helpers,
  not storage). A one-line `R2Bucket` type-cast with ~zero drift risk — matches
  the standing `base64ToBytes`-idiom decline ("churn, not drift risk").
- **`sdkBuildTools` / `sdkBuildTitle`** (pipeline.js one-liners) — the former
  composes constants from THREE modules (`INTROSPECTION_TOOLS`/`SDK_TOOLS`/
  `BUILD_TOOLS`) so it belongs where it composes them; the latter isn't
  `ctx`-free without a signature change (not a verbatim move).
- **`newRequestState`** (chat.js vs mcp.js) — same RequestState SHAPE, different
  fields (mcp forces enrichments off, takes `plan`); a base+extend split is a
  feature-shaped change, not a byte-identical move (standing decline since the
  2026-07-12 de-dup pass).
- **The whole Se/cure client tier** — `drc-providers.js` is already import-free
  with its pure/impure split done in-file (its own `filterAndSortModels`
  docstring codifies "testable *within* the module, not a spawned `-core.js`");
  `drc-research.js`'s pure prompts/normalizers are already exported + Node-tested
  and NO separate consumer imports them (only `runDrcResearch` is imported). NEW
  HAZARD LOGGED: both files are in `SECURE_SOURCE_REFS` **and** `sdk/MANIFEST.json`
  `reference` lists, so spawning a `-core.js` that isn't ALSO added to those
  lists would silently hide those prompts from the SDK distiller — a net negative
  no test catches. Extraction there carries downside with no consumer/graph win.
The lesson stands: on this codebase a "refactor the whole repo" job routinely
converges to a SINGLE relocation (or none), and that is the correct outcome —
1843 logic tests green throughout, typecheck clean, zero behavior change.

## Eighth worked example (2026-07-23) — the lockstep-mirror pass

Survey scoped to code merged since the seventh pass (three `Explore` fan-outs:
the new compute-sharing pool subsystem, server-errors.js + the grown src
modules, and the client changes) PLUS an independent hash-scan for
byte-identical function bodies across src/ + public/js/ + public/cure/. All
three fan-outs returned "none" — the new subsystems were AUTHORED to the
discipline (`pool-token.js` imports token-crypto.js with a test PINNING its
import list to exactly that; `pool.js` imports all six grant-http.js helpers;
`server-errors.js` names its status helper `normalizeErrorStatus` to dodge the
normalizeStatus trap and imports cleanStr/likePattern/textResponse instead of
copying them). The hash-scan earned its keep: it surfaced two cuts the
fan-outs missed, both fitting known precedents:
- **`useCaseTag`/`parseUseCaseRef` → single source in `testpoints-core.js`**
  (flagship): byte-identical in src/testpoints.js and the client core, held
  together by a "keep the two in lockstep" comment — the copy-with-apology of
  §FOCUS 2, resolved by the class-X façade direction (server imports the
  public/js core and re-exports, the agent-spec.js pattern), so pipeline.js
  and src/testpoints.test.js kept their import path. The server side's richer
  comments (invariant-6 note, ref grammar) carried onto the core verbatim.
- **`lerpCol` → exported from `public/cure/umbrella.js`**: byte-identical
  (with its `rgb` helper) in umbrella-spinner.js, which ALREADY imports the
  umbrella geometry/palette — the hex() ×3 precedent again; the spinner's
  orphaned `hex` import dropped with the copy.
Declined this pass: `balloon-intro.js`'s lerpCol (different body — inline
channel rounding, no rgb helper; replacing it is behavior-equivalent but not a
verbatim move), `plant-spinner.js`'s clampAnimMult (its own comment declares
the copy deliberate — "kept local so the plant doesn't couple to
umbrella/balloon"), pool.js's `safeModels` (4 lines, single-file, internal,
un-duplicated — below the bar), the `nowS` clock one-liners (not pure, not
byte-identical), and the standing declines re-confirmed by the scan
(src/rag.js ↔ public/js/rag.js f32ToB64/b64ToF32 cross-tier; drc-store ↔
vault-core base64 pair; the spinner finale trio — byte-identical TEXT but
free-variable-bound to module-local MARKS/FLEET, so same text ≠ same
behavior; the drc.js Enter-send inline, documented cross-tier separation).
METHOD NOTE: keep the hash-scan (normalize whitespace, hash function bodies
≥4 lines) as a survey step — agents reason about which duplications SHOULD
exist; the scan finds the ones that DO.
