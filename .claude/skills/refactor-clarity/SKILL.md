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
  risk). Canonical worked example: the 2026-07-12 clarity pass that added
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

7. **Document.** Add each new module to the CLAUDE.md **Code layout** table (and
   the client prose for client modules), and add this skill to the CLAUDE.md
   skills list if not present. Then re-bundle (step 6 order).

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
