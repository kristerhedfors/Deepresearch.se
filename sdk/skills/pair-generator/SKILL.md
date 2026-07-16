---
name: pair-generator
description: >-
  Load when actually GENERATING an agent pair from a module selection — or
  wiring an existing product to SDK modules in adoption mode. This is the
  SDK's execution skill: read sdk/MANIFEST.json, validate the selection
  (baseplate always included, dependency closure, class-violation refusal —
  there is no flag to put the server in the client tier's data path), order
  the modules topologically by dependencies with layers as the narrative,
  then build module-at-a-time with each module landing green (unit tests +
  its skill's acceptance checklist) before the next starts. Carries the three
  worked selections from sdk/DESIGN.md §3 expanded into exact module
  sequences, the per-module workflow, the adoption path for the existing
  reference product, the choose-the-wordplay-early rule, and the procedure
  for a wanted capability that has no module yet (write the SDK skill first,
  then generate).
---

# The pair generator — from a selection to a working pair

Turn a feature selection into a running agent pair — or bind an existing
product to the SDK module-by-module. The generator is deliberately thin:
the knowledge lives in the module skills (`sdk/skills/*/SKILL.md`), the
machine-readable graph lives in `sdk/MANIFEST.json`, and this skill is the
walk — selection → validation → dependency order → one module at a time,
each landing verified before the next begins. Per DESIGN.md §4, generation
is module-at-a-time and never a big-bang scaffold: each module lands with
its unit tests green and its acceptance checklist satisfied, **so every
intermediate state is a working product** — a big-bang scaffold would emit a
hundred files nobody has verified, exactly the failure mode PA-10 exists to
prevent.

## Capability class & tier story

**Class D — development system, layer 6.** The generator produces both
tiers but is itself neither: it is the workflow an agent session executes.
Its "tier story" is the selection's: every capability skill states whether
its capability is client-implementable (class C/X), honestly server-only
(class S), or bridged (class B), and the generator's job is to refuse any
selection or shortcut that would blur those stories. The generator also
covers the reverse direction — **adoption mode** — where the "generated
tree" already exists (the reference product) and the walk aligns it to the
SDK's names and acceptance gates instead of emitting files.

## Contracts

The generator carries no single contract — it ENFORCES all of them:

- **PA-1..PA-10 as gate criteria** — every module skill states which
  contracts it touches; a module is not "landed" until the acceptance items
  asserting those contracts pass.
- **The class rules as refusal rules** — a class-C module graph may not
  import a class-S module (pin it with a module-graph test, the reference's
  style); a class-B capability must ship opt-in + disclosed + metered +
  time-limited + fail-safe + minimal-payload or not at all; a class-X core
  must be Node-import-safe and dependency-free. **There is no flag to "just
  this once" put the server in the client tier's data path** (DESIGN.md's
  closing promise) — a selection that needs the server in that path is
  asking for a class-B grant bridge, and the generator's answer is that
  module, never an exception.
- **PA-10 as the cadence** — verify each module live where its skill says
  live verification is the evidence; never proceed on top of an unverified
  layer.

## Build plan

This build plan is the generation workflow itself.

1. **Read the manifest; hold the graph.** Parse `sdk/MANIFEST.json`:
   modules with `id`, `layer`, `class`, `deps`, `skill`, `reference`,
   `acceptance`; the `baseplate` list; the class definitions. The manifest
   is the machine truth. Read `sdk/ROADMAP.md` for the human rationale over
   the same graph — **the standing rule: generation follows the ROADMAP's
   phase rationale** where it exists. If the ROADMAP is absent or silent on
   an ordering question, derive the rationale from layers + deps yourself;
   if ROADMAP and manifest ever disagree, the manifest's `deps` win and the
   disagreement is a bug to fix in the same change.
2. **Choose the pair's name and wordplay EARLY — before generating
   anything.** The naming convention (DESIGN.md §1) is load-bearing input
   to multiple modules: the two tier paths (the reference's `/cure` and
   `/rver`), the publish-replays slug discipline (slugs must complete the
   wordplay phrase), the symbol-language wordmark and secure-first ordering,
   and — hardest to change later — any derivation constants that embed
   names (the reference's sealed-state HKDF info strings are FROZEN
   pre-rename values precisely because the product renamed after shipping
   and crypto constants cannot follow). Decide: brand stem, per-tier path
   words, display form (CamelCase bold-tail), short forms, and the internal
   code names that must never reach user-facing copy.
3. **Validate the selection.**
   - **Baseplate always included:** union the selection with
     `pair-architecture`, `baseplate-worker`, `baseplate-client`. Even a
     "zero servers" client-only pair keeps `baseplate-worker` in the build —
     the client tier must remain fully functional with that worker reduced
     to any static host, and the worker skeleton is how that property stays
     testable.
   - **Close over `deps`:** repeatedly add every dependency of every
     selected module until fixed point. Report what the closure added and
     why (the user asked for `grant-bridge`, they are getting
     `identity-access` + `quota-metering` + `secure-tier` + `web-search`
     too — say so before building).
   - **Refuse class violations:** a request phrased as "the client tier,
     but with server-side history" or "skip the grant tokens, just call the
     API" is refused with the contract it breaks named (PA-4/PA-8) and the
     legitimate module that provides the capability offered instead.
4. **Order the modules: topological by `deps`, layer as tiebreak and
   narrative.** Kahn's walk over the closed selection; when several modules
   are ready, prefer lower layer, then manifest order. **Dependencies
   override layer numbers** — the manifest contains at least one deliberate
   cross-layer edge (`secure-tier`, layer 2, depends on `sealed-crypto`,
   layer 3), so a naive layer-major sort emits a module before its
   dependency and fails. Layers are the roadmap's story; `deps` are the
   build order.
5. **Generate module-at-a-time.** For each module in order:
   1. **Load the module's SKILL.md** — in full, before touching files.
   2. **Execute its Build plan** — the numbered from-scratch sequence,
      creating the files it names with the responsibilities and seams it
      states, consulting the Reference implementation map when a step's
      intent needs the worked example.
   3. **Write its acceptance tests** — every checklist item that can be a
      unit test becomes one; live-verification items become a recorded
      probe procedure.
   4. **Verify** — unit suite green, typecheck clean, the checklist walked;
      live items verified against the deployed pair when the skill says
      live is the evidence.
   5. **Commit** — one module, one landing; the tree at every commit is a
      working product with all previously-landed modules still green.
   Do not start the next module on a red checklist — the whole point of
   the ordering is that nothing ever builds on an unverified layer.
6. **The three worked selections** (DESIGN.md §3), expanded to exact
   sequences over the current manifest:
   - **Minimal client-only assistant** — a bring-your-own-key chat with
     sealed local state, deployable on any static host:
     `pair-architecture → baseplate-worker → baseplate-client →
     provider-registry → sealed-crypto → secure-tier`.
     (Note the cross-layer edge in action: `sealed-crypto` (L3) lands
     before `secure-tier` (L2).) Acceptance for the whole selection: the
     client tier serves and chats from a plain static file host with the
     worker absent.
   - **Minimal pair** — both tiers, signed-in server-orchestrated research
     plus the client twin: the above plus
     `research-pipeline` (after `provider-registry`), then
     `identity-access → quota-metering`, then `sse-recovery` (after
     `research-pipeline` + `baseplate-client`). One valid full order:
     `pair-architecture → baseplate-worker → baseplate-client →
     provider-registry → research-pipeline → identity-access →
     quota-metering → sealed-crypto → secure-tier → sse-recovery`.
   - **Full reference product** — everything in the manifest. Phase view
     (each phase internally dep-ordered): layer 0 baseplate; layer 1 model
     & search plane (`provider-registry`, `research-pipeline`,
     `web-search`, `enrichments`); the tiers + privacy plane interleaved by
     deps (`identity-access`, `quota-metering`, `sealed-crypto`,
     `secure-tier`, `sse-recovery`, `ciphertext-storage`, `client-rag`,
     `grant-bridge`, `offline-workspaces`); layer 4 operations
     (`observability`, `decision-boards`, `feedback-loops`, `eval-harness`
     — and note `agent-dev-workflow` depends only on `pair-architecture`,
     so pull it EARLY: the git/test/skill discipline it installs is what
     keeps the rest of the walk honest); layer 5 extension surfaces
     (`execution-sandbox`, `introspection-help`, `mcp-surface`,
     `publish-replays`, `symbol-language`, `games-shelf`), which depend on
     the planes but not on each other — build them in any order, or in
     parallel sessions, one module per session.
7. **Adoption mode — wiring the EXISTING product** (DESIGN.md §5). Same
   walk, same order, but per module:
   1. Read the module skill's **Reference implementation map** — those are
      the files that already realize it.
   2. **Align** the reference files to the module's stated contract —
      usually a no-op, since the skills were distilled FROM the reference;
      where names or seams differ, prefer the smallest rename/split that
      satisfies the contract.
   3. **Add missing acceptance tests** — the checklist items the existing
      suite doesn't yet pin.
   4. **Record the binding** — the manifest's `reference` list is the
      pointer; update it if files moved, and note the module as adopted.
   Because each module holds the acceptance checklist constant, a later
   swap of reference files for SDK-generated equivalents is provably
   behavior-preserving.
8. **When a wanted capability has no module: grow the SDK first.** Do NOT
   improvise the capability inline. (a) Write a NEW SDK skill in the house
   format — purpose, capability class & tier story, contracts, a
   from-scratch Build plan, a reference map (which may point outside this
   repo if the pattern comes from elsewhere — cite it), acceptance,
   pitfalls; (b) add the manifest entry with honest `layer`, `class`,
   `deps`, and `acceptance`; (c) THEN generate it as an ordinary module in
   the walk. This is the same way the reference's skill library grew —
   solved tasks persist as skills before the session ends — and it keeps
   the manifest the complete registry of everything a pair can be built
   from.
9. **Keep the development system running while you generate.** The class-D
   modules are not garnish: the eval harness gates answer-quality changes,
   the boards/feedback loops carry the operator's priorities, and the git
   discipline (sync before building, one module per branch/PR, a landed
   module is DONE — branch fresh, never keep building on a merged branch)
   is what makes a multi-session generation coherent.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| The module registry (ids, layers, classes, deps, acceptance) | `sdk/MANIFEST.json` |
| The contracts PA-1..PA-10, class rules, worked selections | `sdk/DESIGN.md` (§1.1, §2, §3, §4, §5) |
| The phase rationale over the same graph | `sdk/ROADMAP.md` (the six phases, exit criteria, and the order-at-a-glance table; the manifest's `deps` win if the two ever disagree) |
| The module skills this walk executes | `sdk/skills/*/SKILL.md` |
| Class-violation pinning style (module-graph tests) | `src/server-grants.test.js` (the no-data-bearing-import pin), the `vault-core.js`/`vault.js` split keeping class-S imports out of the `/cure` graph |
| The persist-solved-tasks-as-skills growth pattern | CLAUDE.md (Skills section), `.claude/skills/` |
| The one-module-one-landing git discipline | `.claude/skills/sync-main`, `.claude/skills/merge-branches`, `.claude/skills/pr` |
| Frozen-constants naming lesson | `public/js/drc-core.js` (HKDF info strings frozen at pre-rename values) |
| Adoption-mode procedure | `sdk/DESIGN.md` §5 |

## Acceptance checklist

- [ ] The generator's selection step provably unions the baseplate and
      closes over `deps` (unit-test the closure against the manifest).
- [ ] The ordering step is a true topological sort: feeding it the current
      manifest emits `sealed-crypto` before `secure-tier` despite the layer
      inversion.
- [ ] A class-violating selection is REFUSED with the broken contract named
      and the legitimate module offered (test the "server-side history for
      the client tier" case).
- [ ] The minimal client-only selection generates to a product that chats
      from a static host with no worker running.
- [ ] Each generated module's commit leaves the full unit suite green and
      its skill's checklist satisfied before the next module's first file
      exists (audit the history).
- [ ] Adoption mode run against at least one reference module ends with
      its acceptance tests present and its `reference` binding recorded.
- [ ] A capability without a module triggered the grow-the-SDK path (new
      skill + manifest entry) rather than inline improvisation.

## Pitfalls

- **Layer-major sorting breaks on the manifest as it stands.**
  `secure-tier` (layer 2) depends on `sealed-crypto` (layer 3) — a real,
  deliberate edge (the client tier is BUILT ON the sealed-crypto core).
  Sort by dependencies; use layers only to break ties and tell the story.
- **The big-bang scaffold is the canonical failure.** DESIGN.md §4 states
  the rationale once: generating 100+ unverified files is exactly what
  PA-10 exists to prevent. If a session is tempted to "just emit the whole
  tree and fix it up", stop — that is not faster, it is unverifiable.
- **Renaming late collides with frozen constants.** The reference renamed
  its tiers after shipping and its sealed-state derivation strings still
  carry the old names forever — changing them would orphan every user's
  sealed data. Choose the wordplay in step 2, before any module writes a
  derivation constant, a path, or a slug.
- **Internal code names leak into user copy.** The reference codified it
  after it happened (a third name pair confuses readers): pick internal
  short names for code and skills, and enforce that user-facing copy only
  ever uses the display forms.
- **"The client tier is a demo" thinking.** Class C modules carry the same
  pipeline invariants as the server tier (the reference's client pipeline
  holds PA-1/2/3 in full). A generator that stubs the client tier's
  pipeline "for now" has built a teaser, not the mission's proof — and
  retrofitting the invariants is costlier than building them in.
- **Acceptance postponed is acceptance skipped.** The per-module workflow
  puts tests INSIDE the module's landing for a reason: the reference's bug
  history is integration behavior that only surfaced because verification
  was cheap and immediate. A stack of "test debt" modules is a stack of
  unverified layers everything above them trusts.
- **Skipping the dev-system modules on a long build.** `agent-dev-workflow`
  needs only the baseplate — land it early. Multi-session generation
  without the sync/branch/ledger discipline produces exactly the divergent
  half-merged state the reference's merge-barrier machinery exists to
  clean up.
- **Hand-mirrored "shared" code instead of class-X façades.** The reference
  converged on the pure-core + re-export-façade pattern after real drift
  between hand-mirrored server/client copies; the identity-pinning test
  ("the façade's surface IS the core") is part of every X module's
  acceptance — don't waive it to save an import path.
- **Verifying against nothing.** Several skills' acceptance items require a
  live deployment (real devices, real providers). Stand up the deploy
  target with the baseplate — the first module landing includes "it
  serves" — so every later module has something real to verify against.
