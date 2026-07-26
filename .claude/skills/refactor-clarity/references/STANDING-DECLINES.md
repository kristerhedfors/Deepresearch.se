# Standing declines

Candidates a refactor pass already examined and ruled out, with the **gate**
(see the skill's five gates) each one fails. **Read this before surveying.** Most of
them resurface in `node scripts/dup-scan.mjs` output every time, because they
are genuinely byte-identical code that is genuinely correct to leave alone.

A decline is not permanent by decree. If the surrounding code changes so that a
gate now passes — a sink module appears, an edge already exists, a copy
diverges — cut it and move the row here to the pass ledger.

| Candidate | Sites | Gate | Why it stays | Since |
|---|---|---|---|---|
| `f32ToB64` / `b64ToF32` | `src/rag.js`, `public/js/rag.js` | Tier | Server and browser graphs must not share a module; the duplication is the boundary working | 2026-07-15 |
| `b64url` / `b64urlEncode`, `b64urlDecode` | `src/token-crypto.js`, `public/js/proxy-bundle.js` | Tier | Same cross-tier rule as `f32ToB64` | 2026-07-24 |
| `bytesToB64` / `b64ToBytes` | `public/js/drc-store.js`, `public/js/vault-core.js` | Tier | Se/cure store vs. Se/rver vault core — separate graphs by design | 2026-07-23 |
| `base64ToBytes` idiom | ~7 files across unrelated graphs | Bar + Home | Obviously-correct four-liner, no shared sink; unifying is churn, not drift control | 2026-07-15 |
| `bucket = (env) => env.STORAGE` | storage, build-pub, rag, vault, pub | Home | Every sink is wrong: `storage.js` would be circular (imports `rag.js`), `settings.js` is not a leaf, `http.js` is a semantic mismatch. A one-line `R2Bucket` cast with ~zero drift risk | 2026-07-19 |
| `newRequestState` | `src/chat.js`, `src/mcp.js` | Verbatim | Same `RequestState` shape, different fields (mcp forces enrichments off, takes `plan`); needs base+extend, which is a feature change | 2026-07-12 |
| `normalizeStatus` | `src/feedback.js`, `src/testpoints.js` | Verbatim | Same name, different bodies; sharing needs parameterizing | 2026-07-15 |
| Meter helpers (`outstandingRemaining`, reserve/refund) | websearch, proxy, pool | Verbatim | Table-name-parameterized; unifying means a signature change. Declined in four consecutive passes | 2026-07-15 |
| Token-family `mint` / `verify` | `websearch-key.js`, `proxy-grant.js`, `pool-token.js` | Verbatim | The `svc` claim differs deliberately; only the crypto primitives were shared (`token-crypto.js`). Do **not** merge the mint/verify pairs — a `token-crypto.js` comment fences this off | 2026-07-15 |
| `posInt` inline clamp | `src/websearch.js` | Verbatim | The sibling open-codes the same clamp as an expression; rewriting an expression is not a move (the shared version lives in `grant-http.js`) | 2026-07-17 |
| `sdkBuildTools`, `sdkBuildTitle` | `src/pipeline.js` | Home / Verbatim | The former composes constants from three modules, so it belongs where it composes them; the latter is not `ctx`-free without a signature change | 2026-07-19 |
| `fallbackPlan` | `src/orchestrator.js` | Verbatim + Tier | Reads `ctx.cleanLastUser` / `ctx.state.webSearch`; the natural sink (`orchestrator-core.js`) is a client core taking plain args, so the move needs a signature change | 2026-07-24 |
| FNV-1a hashes (`projHash`, `cacheIdFor`) | `public/js/sandbox-files.js`, `public/js/sandbox.js` | Purity of effect | `cacheIdFor` feeds the VM disk-cache identity; an equivalent-looking rewrite risks invalidating every user's cached VM image | 2026-07-15 |
| Spinner finale trio (`planFinale`, `finalePhaseBucket`, `spinnerStyle`) | `umbrella-spinner.js`, `balloon-spinner.js` | Purity | Byte-identical TEXT bound to module-local `MARKS` / `FLEET` / apex constants — same text, different behavior | 2026-07-17 |
| `clampAnimMult` | `public/cure/umbrella.js`, `public/js/plant-spinner.js` | Home | Its own comment declares the copy deliberate: "kept local so the plant doesn't couple to umbrella/balloon" | 2026-07-23 |
| `lerpCol` in `balloon-intro.js` | vs. `umbrella.js` | Verbatim | Different body (inline channel rounding, no `rgb` helper); replacing it is behavior-equivalent, not a verbatim move | 2026-07-23 |
| `smooth` / `clamp01` | `public/cure/umbrella.js`, `public/js/balloon.js` | Home | Four-line easing primitives with no existing edge between the two files; `balloon.js` imports only `drc-page-core.js` | 2026-07-24 |
| `esc` (5-char HTML escape) | `agent-spec-core.js`, `workflow-viz.js` (+ `notifications.js#escapeHtml`) | Home | No edge exists to any shared sink, and `agent-spec-core.js` is deliberately import-free (the server imports it through a façade). New edges for a five-line escape are churn. **Do not** point these at `markdown.js` — that escape covers four characters, not five | 2026-07-24 |
| `trackedFiles` (`git ls-files -z`) | `bundle-source.mjs`, `bundle-docs.mjs` | Bar | Four lines wrapping one stable git call; no drift risk | 2026-07-24 |
| `GENERATED` exclusion arrays | `build-pulse.mjs`, `build-pulse-timeline.mjs` | Verbatim | Near-identical under a "kept in sync" comment, but the timeline copy also excludes `public/pulse/timeline.json` and the main one does not. **Sharing them would change what the main dashboard counts as human churn** — a behavior question for the owner, not a refactor. Flagged 2026-07-24 when the CET helpers next to them were de-duped | 2026-07-24 |
| `safeModels` | `src/pool.js` | Bar | Four lines, single file, internal, un-duplicated | 2026-07-23 |
| `sumRemaining` | websearch, proxy endpoints | Bar | Tiny and inline in one endpoint each | 2026-07-17 |
| `nowS` clock one-liners | several | Purity + Bar | Not pure, not byte-identical | 2026-07-23 |
| `onDeviceModelLabel`, `scaleNoteFor`, `poolShareStatus` | ondevice, space, pool clients | Bar | Trivial wrapper / bound to a renderer-owned UI constant / a five-line pure branch inside a DOM writer | 2026-07-24 |
| `buildSourceToolUserContent` | DRS + DRC source loops | Bar | About two shared prompt lines | 2026-07-17 |
| DRS/DRC source-tool loop drivers | `src/pipeline.js`, `public/cure/drc.js` | Verbatim | Same shape, different WIRE protocols (Anthropic content-blocks vs. OpenAI `tool_calls`) — the opposite of `bash-core.js`'s one-protocol premise | 2026-07-17 |
| Dev-mode theme-toggle | DRS vs. DRC | Tier | Deliberate tier divergence plus the `/cure` public-module-graph allowlist | 2026-07-17 |
| `drc.js` Enter-send inline | DRC vs. DRS composer | Tier | Documented cross-tier separation | 2026-07-23 |
| Se/cure public route group | `src/index.js` | Purity | Dispatch-only glue, no seam | 2026-07-15 |
| `rankVisionModels` | `src/models.js` | Verbatim | A carve-out, not a relocation | 2026-07-15 |
| `b64urlEncode` / `b64urlDecode` | `src/run-as.js` vs. `src/token-crypto.js` | Verbatim | **Same-tier, so the usual b64url tier reasoning does NOT apply — it is declined on different grounds.** `run-as.js`'s pair is string↔string (TextEncoder/TextDecoder around the transform) where `token-crypto.js`'s is bytes↔bytes; its decode SWALLOWS a bad input and returns `""`, which `runAsSpecFromUid` relies on for a malformed cookie, where `token-crypto.js`'s throws; and it re-pads before `atob` where `token-crypto.js` does not. Expressing one via the other is a behaviour change, not a move | 2026-07-26 |
| `el` (create-element helper) | `public/js/outrospect-feed.js`, `public/js/outrospect-view.js` | Home | Byte-identical, but no DOM-helper sink exists anywhere in the repo (`grep "export function el"` is empty), and the ONE module both already import is `outrospect-core.js` — a pure core the SERVER imports through `src/outrospect.js`, so a `document.createElement` body cannot go there. Same shape as the `esc` row | 2026-07-26 |
| `send` (JSON response writer) | `public/cure/local-exec/runner.mjs`, `public/cure/local-search/agent.mjs` | Bar + Home | Both files are standalone "single file, no dependencies" scripts the USER downloads and runs on their own machine. Sharing anything between them destroys the property that makes them installable at all — the duplication IS the design | 2026-07-26 |
| `anthropicPartsText` / `partsText` | `public/js/drc-providers.js`, `src/anthropic.js` | Tier | The Se/cure browser mirror of the server's Anthropic wire adapter, deliberate since PR #301 (`drc-providers.js` "carries the browser mirror of `src/anthropic.js`"). Same cross-tier rule as `f32ToB64` | 2026-07-26 |
| `capacityFor` | `public/js/swarm-runtime.js` | Purity + Bar | Looks like a pure planner beside the pure `swarm-core.js`, but it reads `globalThis.performance.memory` at call time (via `currentHeapRatio`) and is otherwise a field-mapping wrapper over `planSwarmCapacity`, which already lives in the core | 2026-07-26 |
| `whenLabel`, `refreshStatusLine`, `knownKeys`, `noteLens` | `public/js/outrospect-view.js` | Bar | Genuinely pure, and `outrospect-core.js` is already imported — but they are single-copy and ALREADY exported and covered by `outrospect-view.test.js`, so moving them buys no coverage, no graph tightening and no drift control. Seam type 5's payoff is absent | 2026-07-26 |
| `recordStepUsage` | `src/bash-api.js` vs. `quota.js`'s `recordDefaultModelUsage` | Verbatim | The third copy of the DEFAULT_MODEL spend recorder, and the two identical ones WERE shared (pass 11). This one looks up the catalog through `providers.js` `listChatModels`, not `berget.js` `listModels`. The two are equivalent for a Berget `DEFAULT_MODEL` id, but swapping one for the other is a behaviour-equivalence argument, not a move. **Flagged for the owner:** if the two lookups are meant to be interchangeable here, folding this in is a one-line follow-up | 2026-07-26 |

## Whole files examined and left alone

- **`src/pipeline.js`** — surveyed in five consecutive passes. Its growth is
  always *orchestration* (introspection tool-calling, SDK build mode,
  feedback capture, orchestrator dispatch) whose pure helpers were placed in
  companions at authoring time: `pipeline-inputs.js`, `sdk-tools.js`,
  `build-tools.js`, `introspect-tools.js`. The pure-core split is complete;
  re-survey only what is genuinely new.
- **`src/index.js`** — regrowth is routing dispatch. Correct to leave.
- **`src/chat.js`, `src/mcp.js`** — byte-unchanged across several passes after
  the 2026-07-12 and 2026-07-13 cuts.
- **The Se/cure client tier (`drc-providers.js`, `drc-research.js`)** —
  `drc-providers.js` is import-free with its pure/impure split done *in file*
  (its `filterAndSortModels` docstring codifies "testable within the module,
  not a spawned `-core.js`"); `drc-research.js`'s pure prompts and normalizers
  are already exported and Node-tested, and no separate consumer imports them.
  **Hazard:** both files are in `SECURE_SOURCE_REFS` *and* `sdk/MANIFEST.json`
  reference lists, so spawning a `-core.js` without adding it to both lists
  would silently hide those prompts from the SDK distiller.
- **`src/report.js`** — its pure markdown/PDF helpers are already exported and
  Node-tested in place, and no sibling core exists (the `plant-spinner.js`
  pattern). A `report-core.js` carve-out would be churn.
- **`public/js/orchestrator-core.js`** — authored as a textbook class-X core;
  validate / normalize / waves / prompts / clamp / merge / events are all
  exported and pure already.
