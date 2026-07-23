---
name: research-pipeline
description: >-
  Load when building a platform's deterministic deep-research pipeline —
  the five phases (triage → search → gap → synthesis → validation) with NO
  function calling, the fail-soft helper-phase posture, split model routing
  with split token accounting, the time-budget/EWMA planner and report
  tiers, JSON hardening (declared schemas + never-throw validator +
  last-ditch normalizers), prompts as pure builders with structural tests,
  per-model profiles, or the client-side port of the whole flow
  (harvest-from-model-knowledge, offline-honesty prompts). Also load when a
  phase silently misroutes, a budget change alters answer depth, or a
  pipeline-quality idea needs the build-behind-a-flag-and-measure
  discipline.
---

# The deterministic deep-research pipeline

The platform's crown jewel: an orchestrator (worker on the server tier, browser
module on the client tier) that runs research as a fixed sequence of plain
model calls — triage, search, gap audit, synthesis, validation — where the
orchestrator picks every phase and every query and models only fill in JSON
or prose. This is what makes the product work identically across an entire
model catalog, including models with unreliable tool-calling, and what makes
every failure mode a bounded, observable degradation instead of an agent
wandering off.

## Capability class & tier story

Class **X** (shared substrate). The flow exists twice, deliberately shaped
the same:

- **Server tier**: the full pipeline — triage (JSON) → concurrent search
  wave against the web-search plane → gap-check loop (JSON) → streamed
  synthesis on the user's chosen model → post-validation (JSON) — plus
  enrichments before it and quota/billing around it. Pure pieces (input
  block builders, output parsers, schemas, note merging) are extracted into
  leaf modules so the flow file reads as the flow.
- **Client tier**: the browser twin. Same phase skeleton, same invariants
  (PA-1/2/3 hold client-side), with one honest substitution: there is no
  server and no search key, so the search wave becomes **harvest** — one
  parallel JSON call per sub-question extracting the model's own concrete
  knowledge as `{facts, uncertain}` notes — and the prompts force that
  honesty into the answer (no invented citations or URLs, training-cutoff
  hedges carried into the text). The whole client flow is Node-tested end
  to end against a mock provider. The client tier is not a demo: this
  module is the proof.

## Contracts

- **PA-1** — no function calling: every phase is a direct JSON-mode or
  streamed call. The ONE sanctioned exception pattern (the reference's
  developer-mode source-investigation tool loop) is opt-in, capability
  gated, scoped to the answer phase only, and leaves the deterministic path
  as the fallback for every model — the JSON planning phases never use
  tools.
- **PA-2** — every helper phase (triage, gap, validation, each enrichment)
  runs through a `phase()` wrapper that catches, records duration, logs,
  and returns null; the pipeline degrades (fewer searches, skipped round,
  accepted draft) but never errors the chat. Search failures come back as
  content strings, not exceptions.
- **PA-3** — the JSON planning phases always run on the fixed reliable
  cheap model; only synthesis and direct replies run on the user's chosen
  model. Token accounting, budgeting, and profiles split the same way.
- **PA-5** — the JSON validator is a tiny in-repo module, not a dependency;
  every per-model override traces to a reproduced finding.
- **PA-6** — the deterministic intent gates the pipeline consults before
  triage (quiz intent in the reference) carry full language parity with
  parity tests; the LLM phases are language-agnostic by nature.
- **PA-7** — pure input builders/parsers, schemas, notes logic, and the
  client port are Node-testable modules; nothing is hand-mirrored.
- **PA-10** — answer-quality changes land only behind a scored benchmark;
  the deep-tier trio (below) is the standing proof of why.

## Build plan

1. **Schemas + validator first** (`src/schema.js`, `src/triage.js`): a
   dependency-free combinator validator — `string`/`boolean`/`number`/
   `stringEnum`/`arrayOf`/`object`/`oneOf` — whose `validate(shape, value)`
   NEVER throws: it coerces/normalizes where safe and returns
   `{ok, value, errors}`. Declare one schema per JSON phase (triage, gap,
   validate, revise). The integration pattern is `hardenJson(schema, value)
   = ok ? value : original` — a schema miss degrades byte-identically to
   the pre-schema behavior, because behind it sits the last-ditch
   normalizer: `normalizeTriage(triage, lastUser, priorUser)` — usable
   clarify/research/direct pass through; junk falls back model-free (a
   short follow-up in an ongoing conversation seeds the search from the
   PRIOR question; a substantial message becomes a one-query research; a
   trivial one answers directly).
2. **Prompts as pure builders** (`src/prompts.js`): one exported function
   per phase, composed from named standing rules — the anti-injection note
   (on triage, direct, AND synthesis: synthesis reads raw web content, the
   same attack surface), the mandatory independent-source rule, the
   decomposition rule (complexity classification + 2–5 sub-questions), a
   `reinforceJsonOnly` toggle spliced per model profile, and the search
   plane's composed `sourcePromptNotes()`. Write STRUCTURAL unit tests
   asserting each rule is present, with the production failure quoted in
   the test comment — prompts are code here.
3. **The budget planner** (`src/budget.js` + the client slider module):
   the UI slider maps position⇄seconds QUADRATICALLY (fine low-end
   granularity; 15 s–10 min, default 60) and sends `time_budget_s`.
   Per-model, per-phase EWMA duration stats (α = 0.3, seeded with measured
   priors, fed by every completed phase via `recordPhase`) drive a static
   allocation in `planResearch(model, budgetS, jsonModel)`: triage+synth
   always paid; validation reserved next (the quality gate, dropped only
   under tight budgets); ~60 % of the remainder buys 1–4 initial search
   angles (more at generous tiers); the rest buys gap rounds. Bigger
   budgets also raise follow-ups per round, the search cap, the source
   registry size, and the digest chars. At runtime, `fitsDeadline` checks
   between phases against budget + 15 % grace — extra gap rounds are cut
   first, validation last, with a VISIBLE "Validation skipped" step.
4. **Report tiers**: `reportTierFor(budgetS)` — brief <60 s → standard
   <180 s → extended <420 s → full ≥420 s — carried on the plan; the
   synthesis prompt turns the tier into per-tier structure/length guidance,
   and the plan scales `synthMaxTokens` (4096→8192, threaded as `maxTokens`
   through the provider registry with a matching stream char-cap raise),
   `validateMaxTokens` (a revise verdict must hold the whole report), and
   at full a bigger registry/digest. The standard tier must be
   byte-identical to the pre-tier prompt so default-budget baselines hold.
   **Complexity caps the tier like it caps depth**: after triage, a
   `simple` verdict caps gap rounds at 1, searches at one wave + one
   follow-up, and the tier at standard (`applyComplexityToPlan`) — only
   ever scaling DOWN; the budget plan stays the ceiling.
5. **Split model routing**: a leaf `resolveJsonModel(catalog, userModel)`
   picks the fixed reliable model for all JSON phases (fall back to the
   user's model only if the default is explicitly down). Thread the
   consequences: (a) split token buckets (`state.totals` answer model,
   `state.jsonTotals` JSON model, `state.visionTotals` any vision helper),
   each priced at its own catalog rate; (b) the planner estimates each
   phase against the model that will RUN it and `recordPhase` attributes
   durations the same way, so the EWMA stays correct; (c) JSON phases
   consult the JSON model's profile, synthesis the user model's.
6. **The flow** (`src/pipeline.js` + pure `src/pipeline-inputs.js`): wire
   phases 1–5 with the `phase()` fail-soft wrapper around every helper.
   Triage returns direct | clarify (one question) | research with
   multi-angle queries + complexity + sub-questions. The search wave
   dedupes queries case-insensitively, caps at `plan.maxSearches`, fires
   the round CONCURRENTLY, and feeds the numbered source registry (the
   web-search module). The gap loop audits the source digest against the
   question AND each sub-question (a covered first hop can't mask an
   untouched second; single-origin dominance counts as a gap; dependent
   hop-2 queries are written WITH bridging facts learned from sources),
   optionally reporting `conflicts` (accumulated, deduped, capped ~6).
   Synthesis streams on the user's model, answers ONLY from the numbered
   digest with `[n]` citations + a Sources list, and must address every
   sub-question and conflict explicitly. Validation fact-checks the draft;
   `revise` → emit `discard_text` and stream the corrected answer through
   the same delta path; inconclusive → draft kept.
7. **Per-model profiles** (`src/model-profiles.js`): `priorsMs` (cold-start
   planning for evidenced-slow models), `jsonReinforcement`,
   `maxTokensOverride`, `skipValidation`, `maxCompletionAttempts`,
   `maxImages` — models with no entry behave as if the module didn't
   exist. NO override without a reproduced finding.
8. **Deep-tier phases behind a flag**: if you build notes digestion
   (structured `{claim, source_ids, entities, contradicts}` notes with
   cross-wave normalize/merge/digest), full-content fetch of top sources,
   or claim-level validation — gate ALL of them behind one
   `DEEP_TIER_FEATURES_ENABLED` constant, run the scored benchmark
   before/after, and **believe the number**. The reference built all three
   well, measured them net-negative at the deep tier (2.65 off → 2.43 on,
   with real regressions on focused questions), and switched them OFF —
   the code and the schema hardening remain, the flag stays false pending
   an intent-gated rework. This is the module's most transferable lesson.
9. **The client port** (`public/js/<pair>-research.js`): mirror the flow —
   triage (JSON on the provider's fixed cheap `jsonModel`; the keyless
   local provider has none, so planning collapses honestly onto the chosen
   model) → parallel harvest per sub-question → gap audit + ONE follow-up
   harvest round → streamed synthesis structured by the sub-questions →
   validation whose revise verdict carries the corrected answer, replacing
   the draft via the same `discard_text` convention. Prompts state the
   offline reality outright ("there is NO web search — the model's
   knowledge is the source pool"), forbid invented citations/bracket
   numbers/URLs, and require uncertainty and cutoff hedges. Emit
   onStatus/onDelta events only; the page supplies DOM. Node-test the
   WHOLE flow against a mock provider: phase order, harvest parallelism,
   client-side split routing, the user's key on every wire call,
   discard-and-replace revision, clarify short-circuit, triage fail-soft.
10. **Validate**: unit suites for every pure piece; then live probes on
    the deployment (a phase change only proves out against real providers);
    then the scored benches with fixed seed/judge/budget, appended to the
    ledgers.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Phase flow, `phase()` fail-soft wrapper, gap loop, quiz branch | `src/pipeline.js` |
| Pure input-block builders / output parsers | `src/pipeline-inputs.js` |
| Declared schemas, `hardenJson`, `normalizeTriage` | `src/triage.js` |
| Never-throw combinator validator | `src/schema.js` |
| EWMA planner, deadline checks, report tiers, complexity caps, deep-tier flag | `src/budget.js` |
| Slider position⇄seconds curve + tier readout (mirrored boundaries) | `public/js/timescale.js` |
| Prompt builders + standing rules + structural tests | `src/prompts.js`, `src/prompts.test.js` |
| Split-routing resolver / split billing | `src/model-routing.js`, `src/billing.js` |
| Per-model overrides | `src/model-profiles.js` |
| Notes trio (built, benchmark-gated OFF) | `src/notes.js`, `maybeDigest`/`wantsNotes` in `pipeline.js`/`budget.js` |
| The client-side port + offline-honesty prompts | `public/js/drc-research.js` (+ `drc-research.test.js`) |
| The scoped PA-1 exception (dev-mode tool loop) | `src/introspect-tools.js`, `public/js/introspect-core.js` |
| Incident history & evidence ledgers | `.claude/skills/pipeline-architecture`, `tests/MODEL-EVAL-FINDINGS.md`, `tests/EVAL-BENCH-FINDINGS.md` |

## Acceptance checklist

- [ ] Unit: `normalizeTriage` fallbacks (junk JSON, short-follow-up prior
      seeding, direct threshold); every schema's coerce-or-return-original
      contract; note normalize/merge if built.
- [ ] Unit: structural prompt tests — anti-injection note on triage AND
      synthesis, independent-source rule, JSON-only reinforcement toggle,
      decomposition rule, source prompt-note composition.
- [ ] Unit: planner math — tier boundaries, complexity scaling only ever
      down, deadline grace, EWMA attribution per model; the client slider's
      tier boundaries pinned to mirror the server's.
- [ ] Unit: flow end to end against a mock provider on BOTH tiers — phase
      order, split routing, fail-soft per phase, discard-and-replace,
      clarify short-circuit (PA-1/2/3 asserted by tests, per the manifest).
- [ ] Split billing verified: three token buckets, each priced at its own
      catalog rate, summed for the client counters.
- [ ] Live probe: one research run per triage outcome (direct, clarify,
      research) on the deployment; "Validation skipped" appears under a
      tight budget; a revise verdict visibly replaces the draft.
- [ ] Any deep-tier-style feature is flag-gated with a before/after scored
      bench in the ledger BEFORE the flag defaults on.

## Pitfalls

- **The no-function-calling rule has a body count.** The reference's
  earliest design was a tool-calling loop; models emitted pseudo tool
  calls as text. Later, a production report showed a reasoning model's
  triage corrupting into echoing the raw user message straight to the
  search engine as the query — the incident behind split model routing.
  Fix the class, not the model: JSON phases on the fixed reliable model.
- **A side benefit of split routing**: every request's JSON phases run on
  one model, so its per-phase EWMA warms fast and accurately — and slow
  reasoning models get a fast triage instead of their own.
- **Hung fetches defeat fail-soft.** No timeout on the provider calls
  meant a hung backend silently beat every degradation path (round-2
  incident). Time-bound every call; the fail-soft posture is only as good
  as its bounds.
- **Prompt injection needed TWO rounds**: the first anti-injection note
  fixed one model but not another — a second, explicit triage rule naming
  the exact override pattern was required. Verify resistance live per
  model, don't assume one note suffices.
- **The CPU-ceiling history**: silent mid-stream deaths at longer budgets
  were the platform killing the isolate (exceededCpu on the free plan's
  10 ms cap) — uncatchable from inside. Know your platform's CPU
  accounting; the stream char cap is insurance, not the fix. (The
  reference resolved it by upgrading to Workers Paid, `cpu_ms = 300_000`;
  a config the free plan's deploy API rejects outright — remove it before
  any downgrade.)
- **Over-researching measurably hurts.** The de-noised benchmark found
  more depth on simple questions net-negative, and report scaffolding on
  focused-lookup kinds went 0 wins / 7 losses — hence complexity capping
  both depth AND tier. More is not better; the number decides.
- **Deliberately not built, on evidence**: multi-agent parallel research
  with separate contexts (~15× token cost, coherence losses reported by
  those who tried), an extra outline-JSON phase, paraphrase-style query
  expansion (neutralized by dedup + fixed depth + domain caps). Revisit
  only with benchmark evidence.
- **Watch item**: the reference's reliable JSON model can stop CLEANLY
  mid-Sources-list at ~1.2–2.9 k output tokens on longer tiers — a
  model-side early stop, not a cap; distinguishable because finish_reason
  is set.
- **Don't deploy mid-battery**: a deploy truncates in-flight benchmark
  streams and poisons the A/B; ledgers are append-only, comparisons hold
  seed/judge/budget fixed.
