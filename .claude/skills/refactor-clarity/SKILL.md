---
name: refactor-clarity
description: >-
  Load when asked to refactor for clarity/modularity, split a large file,
  extract a pure core out of an orchestrator, de-duplicate a copied helper, or
  "clean up" a module — anywhere the goal is structure, not behavior. Covers
  the FIVE GATES a cut must pass here (purity, verbatim, home, tier, bar), what
  MUST be preserved (byte-identical behavior, the load-bearing invariants, the
  institutional comments, module-graph constraints, public import surfaces),
  where this repo's seams actually are, the survey → extract → verify workflow
  built on the committed duplicate scanner `scripts/dup-scan.mjs`, and the
  finishing checklist (docs mirror, `SECURE_SOURCE_REFS` + `sdk/MANIFEST.json`
  reference lists — both drift SILENTLY — then `npm run bundle` and
  `bundle:rag`). Also load when moving a file named in either of those two
  lists, since nothing goes red if you forget them. The decline register
  (`references/STANDING-DECLINES.md`) and the ten-pass record
  (`references/PASS-LEDGER.md`) live beside this file — read the register
  before surveying so you do not re-derive a settled decline.
---

# Refactoring for clarity and modularity

**This codebase is already heavily modular. The job is almost never a rewrite —
it is finishing a split the project's own convention already implies.** Every
large feature here is a *pure/testable core* + *orchestration* + *block/text
builders* (`googlemaps.js` → `googlemaps-text.js` + `googlemaps-blocks.js`;
`sse.js` and `message-content.js` out of `stream.js`; the `board.js` core behind
every admin panel). A good refactor extends that pattern to the one place it
hasn't reached. A bad refactor manufactures churn, moves things that aren't
pure, or changes behavior.

If you cannot name the *seam* — the pure function, the self-contained concern,
the verbatim duplicate — don't cut. Length alone is not a defect: a 1700-line
registry of small matchers (`googlemaps-text.js`) or a 1000-line
runner-per-shape file (`maps-enrichment.js`) is inherent complexity, not
tangling.

**Calibrate your expectations from the record.** Ten whole-repo passes since
2026-07-12 have yielded between one and six cuts each, and the seventh yielded
exactly one. New subsystems now arrive already factored, because their authors
follow this same skill. **A pass that ends with one cut and a page of reasoned
declines is a successful pass**, not a shortfall — and the declines are the
durable output, because they are what makes pass N+1 cheap.

## The five gates

Nine passes' worth of accept/decline reasoning reduces to five tests. **A
candidate must pass all five.** Anything that fails one goes into
`references/STANDING-DECLINES.md` with the gate it failed, so no later pass
re-argues it.

1. **Purity gate — is it actually pure?** No `ctx` / `env` / `emit`, no
   `await`, no DOM, no module-local free variable read at call time. Read the
   body; do not infer purity from the name. *The trap:* the spinner
   `finalePhaseBucket` / `spinnerStyle` pair is byte-identical TEXT bound to
   module-local `MARKS` / `FLEET` constants — same text, different behavior.

2. **Verbatim gate — is the move byte-identical?** An extraction copies the
   body and its comments unchanged and re-imports it at the original call site.
   The moment you parameterize a free variable, change a signature, or rewrite
   an expression to make two near-copies match, it stops being this kind of
   refactor and becomes a feature change — stop and treat it as one.
   *Precedents:* `newRequestState` (same shape, different fields — needs
   base+extend), `normalizeStatus`, `sdkBuildTitle` (not `ctx`-free without a
   signature change), `posInt` where the sibling open-codes the same clamp
   inline.

3. **Home gate — does a sink already exist, and does the edge already exist?**
   The best cut moves a symbol to a module that (a) already owns that role, and
   (b) is already in the importer's graph. A cut that invents a module *and*
   new edges for a five-line helper is churn. Watch for cycles and for pulling
   weight into a graph that a test pins: `storage.js` can't host the `bucket`
   one-liner (it imports `rag.js` — circular), `settings.js` isn't a leaf, and
   `http.js` is a semantic mismatch for storage. *Positive precedents:*
   `escapeHtml` → `markdown.js` over the existing `renderMarkdownInto` edge;
   `hex` / `lerpCol` → `public/cure/umbrella.js`, which the spinner already
   imported.

4. **Tier gate — does it stay on its side?** The Se/cure (`/cure`, `drc-*`)
   class-C boundary may not import a class-S module, and the server and browser
   module graphs do not share code just because two functions look alike
   (`f32ToB64` / `b64ToF32` exist in both `src/rag.js` and `public/js/rag.js`
   deliberately; likewise `src/token-crypto.js` ↔ `public/js/proxy-bundle.js`).
   Cross-tier sharing goes through the class-X façade direction — the server
   imports the `public/js` core and re-exports it (`agent-spec-core.js`,
   `testpoints-core.js`) — or it doesn't happen.

5. **Bar gate — is it big enough to matter?** Roughly: four or more lines, or
   two or more copies, or logic that will drift if it diverges. A single-use
   four-liner inside one file is below the bar (`safeModels`); so is an idiom
   duplicated across seven unrelated graphs where every copy is obviously
   correct forever (`base64ToBytes`, `bucket = (env) => env.STORAGE`). Drift
   risk, not line count, is the real question: the CET date math cut in pass
   ten was worth it because a DST fix applied to one copy would silently
   desynchronize two published datasets.

## What to preserve (non-negotiable)

1. **Byte-identical behavior.** The proof is the existing suite staying green
   with no test-expectation edits — only import-path edits.

2. **The load-bearing invariants** (CLAUDE.md). A split may never touch:
   deterministic orchestration with no function calling; fail-soft helper
   phases; split model routing; the privacy split; minimal dependencies; EN+SV
   intent parity. In practice: **do not restructure `runPipeline`'s flow,
   `jsonPhase`, or the streaming/validation phases** — extract the *pure
   builders they call*, never the phases.

3. **The institutional-knowledge comments.** The `// found live 2026-07-11: …`
   notes, the `/cure` public-module-graph allowlist rationale, the COEP
   `require-corp` explanation. Each encodes a bug that cost real time; carry
   them **verbatim** into the new module. Losing one re-opens the incident.

4. **Module-graph constraints.**
   - `public/js/vault.js` must NEVER enter the `/cure` graph — public modules
     import `vault-core.js`. A split of a public module keeps its chain public.
   - `src/mcp.js` keeps heavy deps behind a **dynamic** `import()` so
     `mcp.test.js` loads without the pipeline. A new shared module it imports
     must be a leaf, or it belongs in the dynamic block (`billing.js`,
     `sources.js`).
   - Leaf modules (`model-routing.js`, `grant-http.js`, `llm-proxy.js`) import
     nothing heavy, so neither handler graph pulls in the other. The
     server-token guarantee test pins `llm-proxy.js`'s leafness — check the
     test before adding an import to it.

5. **Public import surfaces.** If anything imports a symbol you're moving,
   re-export it from the original file so importers are unchanged, then
   optionally repoint the test to the new module for a DOM-free target. Grep
   every importer first: `grep -rn "symbolName" src public/js public/cure sdk`.
   Use import-then-export (not `export { x } from …`) when the origin also uses
   `x` internally.

## Where the seams are

In descending value. Each has a worked instance in `references/PASS-LEDGER.md`.

1. **Residual pure helpers → a companion module.** Input builders, output
   parsers, sanitizers, formatters sitting among orchestration functions. The
   biggest win: the orchestrator shrinks to its flow, and logic that had no
   tests becomes directly testable. *`pipeline.js` → `pipeline-inputs.js`.*

2. **Verbatim duplicates → one leaf.** A body copied into two files — usually
   with a comment apologizing for the copy, or promising to keep the two "in
   lockstep" — is drift waiting to happen. Both the comment and the copy go.
   *`resolveJsonModel` → `model-routing.js`; `useCaseTag` → `testpoints-core.js`.*

3. **A helper in an orchestrator that drags a graph.** Single-copy, but a
   consumer reaches it *through* a heavy module and inherits that module's
   graph. Moving it to a leaf cuts the dependency, not just the line count.
   *`forwardLlmCompletion` → `llm-proxy.js`, which tightened the server-token
   guarantee test's allowlist.*

4. **Self-contained concerns out of an untested entrypoint.** Nothing imports
   `src/index.js` and it has no test, so anything moved out of it becomes
   testable — a strict improvement. *`assets.js`, `security-headers.js`,
   `canonical.js`.*

5. **Client pure logic → an import-free core**, re-exported by the original.
   This used to rank last because the client is live-verified rather than
   unit-tested. DistillSDK raised it: **SDK mode distills the deployed Se/cure
   source into new flavours**, and the `-core.js` convention is now the SDK's
   own class-X / PA-7 contract, so a clean pure core inside a `drc-*.js` /
   `public/cure/*` file is the exact boundary the distiller reshapes. A
   well-factored Se/cure is a more distillable Se/cure. It still buys no
   licence for behavior changes: smallest-possible relocation, class-C-safe,
   link-checked in Node. *`activity-core.js`, `drcFeedbackContext` →
   `drc-page-core.js`.*
   **Before cutting here, read `sdk/MANIFEST.json`.** Each module declares the
   `reference` files that realize it; a module whose references mix pure logic
   with orchestration is a pre-surveyed candidate, and its
   `sdk/skills/<id>/SKILL.md` acceptance checklist is a second statement of the
   behavior you must preserve. Spawning a new `-core.js` out of a file in
   `SECURE_SOURCE_REFS` **hides that code from the distiller** unless you add
   the new file to the list in the same commit.

## The workflow

1. **Baseline green first.** `npm test` and `npm run typecheck` (one
   `npm install` for the dev deps). You cannot attribute a later failure
   otherwise.

2. **Read `references/STANDING-DECLINES.md` before surveying.** Every entry is
   a candidate some pass already ruled out with reasoning. Re-deriving them is
   the single biggest waste in this job.

3. **Survey mechanically, then by reasoning — in that order.**

   ```bash
   node scripts/dup-scan.mjs                # duplicate bodies across files, ≥4 lines
   node scripts/dup-scan.mjs --collisions   # + same-name-different-body (never unify blind)
   git diff --stat <last-pass-sha>..HEAD -- src public/js public/cure sdk
   wc -l src/*.js public/js/*.js | sort -rn | head -20
   ```

   The scan is the high-yield step (pass eight: three reasoning fan-outs
   returned "nothing left", then the scan found two real cuts) — reasoning
   predicts which duplications *should* exist, the scan finds the ones that
   *do*. **Its blind spots are real, so the reading pass still happens:** it
   sees only function bodies of four-plus lines, so repeated *inline blocks*
   (the six that became `grant-http.js`), constants, and single-copy
   helper-in-orchestrator seams (type 3 above) are invisible to it. Read the
   modules that grew since the last pass, and read every scan hit before
   believing it.

4. **Extract one module at a time, and commit after each.** Create the new
   module (bodies *and* their comments verbatim), import them back, re-export
   the public ones, delete the originals, update the origin's module-map
   comment. A container reset mid-session once destroyed six uncommitted moves.

5. **Test as you go.** After each module: its own tests, the touched files'
   tests, `npm run typecheck`. Add unit tests for anything newly testable —
   that coverage is a large part of the value.

6. **Full verify.** `npm test` + `npm run typecheck`. For a client split, also
   confirm the file still links:
   `node -e "import('./public/js/<file>.js').then(()=>console.log('ok'))"` (use
   `node --check` for files that are deliberately not Node-importable, like
   `sandbox.js`).

7. **Finish** — the checklist below, in order.

## Finishing checklist

Do all of it in the same commit range, in this order. The first two drift
**silently**; nothing in the suite goes red if you skip them.

- [ ] **`SECURE_SOURCE_REFS`** (`public/js/sdk-core.js`) — if you renamed,
      moved, or split a file it names, fix the array. Add a new pure core the
      distiller should study.
- [ ] **`sdk/MANIFEST.json` `reference` paths** — `sdk_validate` /
      `snapshotFileCheck` verify only that SKILL files exist, never the
      reference paths. Also check `sdk/DESIGN.md` and `docs/DISTILLSDK.md` if
      the module's file map is described there.
      Grep both before finishing: `grep -rn "<oldpath>" sdk/ public/js/sdk-core.js`.
- [ ] **`docs/CODE-LAYOUT.md`** — one row per `src/` module, plus the client
      prose for client modules. Mirror discipline: same commit.
- [ ] **`references/STANDING-DECLINES.md`** — add every candidate you declined,
      with the gate it failed. This is how the next pass stays cheap.
- [ ] **`references/PASS-LEDGER.md`** — append the pass: what you cut, what you
      declined, and any method lesson.
- [ ] **`npm run bundle`** — LAST, after every text edit including CLAUDE.md and
      this skill, both of which are in the snapshot. Running it before a doc
      edit just makes it stale again.
- [ ] **`npm run bundle:rag`** — a refactor is the classic way to trip the
      *second* freshness test. Moving bodies out of a file shifts its chunk
      boundaries, so an indexed `(path, chunk)` stops resolving and `npm test`
      goes red on "source-rag index is consistent with the current snapshot".
      Re-embedding needs `BERGET_API_KEY` (present in these containers — check
      with `node -e "console.log(!!process.env.BERGET_API_KEY)"`) or the
      break-glass creds. If you genuinely cannot re-embed, say so explicitly
      rather than leaving `npm test` red without comment.
- [ ] **`npm test` + `npm run typecheck`** one final time.

## Traps that cost time here

- **Local typedefs aren't in `types.js`.** `PipelineState` is a `@typedef`
  local to `pipeline.js`. A moved function referencing it throws TS2694. Inline
  the *minimal structural shape* the function needs, or use
  `import('./origin.js').Type` if a type-only circular import is acceptable.
  Don't reach for `types.js`.
- **Inserting an export above a function detaches its JSDoc.** If the doc
  comment sits above your match point, the comment stays with the neighbor and
  the function loses its types (TS7006 catches it). Match on the comment and
  the function together.
- **The Bash working directory persists between calls.** A `cd public/js` in
  one call leaves the next call there, and "file not found" then lies to you.
  Use absolute paths.
- **Don't hand-edit the generated artifacts.** "source snapshot artifact
  matches the working tree" → `npm run bundle`. "source-rag index is
  consistent" → `npm run bundle:rag`. Never the JSON.
- **Two escapes exist on purpose.** `markdown.js` escapes four characters;
  `notifications.js` escapes five (it also encodes `'`). Collapsing them
  changes rendered output. The scan will keep offering you this one.

## The record

- **`references/STANDING-DECLINES.md`** — every settled decline, the gate it
  failed, and the pass that settled it. Read before surveying; append after.
- **`references/PASS-LEDGER.md`** — the ten passes to date, what each cut, and
  the method lessons they produced. Read when you want a worked instance of a
  seam type, or the last pass's SHA to diff from.
