---
name: tune-provider-models
description: >-
  Load when tuning newly added models (any provider) for this pipeline's
  codified use cases — synthesis/direct answers, the JSON planning phases,
  the vision-describe helper, quiz generation/grading — or when running the
  first evaluation pass over new models: which knob lives where (provider
  wire config vs model-profiles.js vs budget priors), which eval harness
  measures which use case, and the run order for a new model's first
  battery. Also load when a new model behaves badly in exactly one use
  case (fine answers but broken quizzes, fine text but failing vision).
---

# Tuning models per use case

How a model that just entered the catalog (see **add-llm-provider**) gets
adapted to each thing this product actually uses models FOR, and how each
adaptation is evidenced. First applied to the Anthropic trio
(claude-opus-4-8 / claude-sonnet-5 / claude-haiku-4-5, 2026-07-09).

## The prime rule (inherited from model-profiles.js)

**No override without a reproduced finding.** New models start at
DEFAULT everywhere and are expected to just work; every deviation must
trace to a live observation or a bench result, recorded in the
appropriate ledger. The tuning pass below is therefore mostly
*measurement*, and only occasionally an edit.

## Knob map — where each kind of adaptation lives

| Kind of adaptation | Lives in | Example |
|---|---|---|
| Wire/request parameters a model NEEDS (thinking modes, format quirks) | The provider client (`src/anthropic.js`, `src/berget.js`) | Sonnet 5 runs adaptive thinking when the param is omitted → explicitly `{type:"disabled"}` (hidden token spend inside max_tokens + a silent pre-answer pause fight the budget planner and the 60s idle guard) |
| Cold-start phase duration expectations | `model-profiles.js` `priorsMs` (EWMA takes over in-isolate) | GLM's 45s triage prior |
| Empty-completion retry depth | `model-profiles.js` `maxCompletionAttempts` | Kimi's 3 attempts |
| JSON-phase reliability patches | `model-profiles.js` `jsonReinforcement` / `maxTokensOverride` / `skipValidation` | gpt-oss-120b skips validation |
| Per-model image caps | `model-profiles.js` `maxImages` | Mistral Medium's 2-image limit |
| Pricing / vision / availability | The provider's catalog entries | anthropic.js MODELS table |

## The codified use cases and their evaluations

1. **Synthesis & direct answers** (the user's chosen model —
   pipeline.js `streamCompletion`). Measured by all three benches:
   - `npm run eval:models` (tests/model-eval.mjs) — qualitative traces,
     failure-mode discovery. Ledger: `tests/MODEL-EVAL-FINDINGS.md`.
   - `npm run eval:bench` (tests/eval-bench.mjs) — LLM-judged scores on
     ~27 fixed questions. Ledger: `tests/EVAL-BENCH-FINDINGS.md`.
   - `npm run eval:hf` (tests/hf-bench.mjs) — accuracy vs gold answers.
     Ledger: `tests/HF-BENCH-FINDINGS.md`.
   Watch for: empty completions (→ maxCompletionAttempts), phase
   overruns vs plan (→ priorsMs), runaway generations (STREAM_MAX_CHARS
   trips), stop-reason/finish_reason anomalies in Workers Logs.

2. **JSON planning phases** (triage/gap/validate — ALWAYS Berget's
   DEFAULT_MODEL, invariant 3). A new answer-model does NOT need JSON
   tuning. Only tune a model's JSON knobs if it can actually become
   `jsonModel` (i.e. it IS the default, or the Berget-catalog-outage
   fallback routed to it). Evidence source: `parse_mode`/`finish_reason`
   diagnostics in phase logs.

3. **Vision-describe helper** (Street View frames — enrichment.js
   `describeStreetView`, any `vision && up` catalog model can be
   drafted). Tuning surface: `maxImages` (probe live with 1/2/3/4 tiny
   images before trusting 4-frame capture), describe latency (the 20s
   idle / 45s max guards). A new vision model silently joins the
   failover list — probe it even if users never select it.

4. **Quiz generation & grading** (pipeline.js `runQuizGeneration` on the
   JSON model; `/api/quiz/grade` on DEFAULT_MODEL). Same rule as use
   case 2 — only relevant for a model that can serve as the JSON model.

5. **Embeddings** (RAG) — Berget-only (`intfloat/multilingual-e5-large`);
   per-answer-model tuning never applies. Adding an embedding provider
   is a different job (Vectorize dimensions are fixed — see berget.js).

## First-battery run order for a new model set

Prereqs: the provider secret set on the Worker, the change deployed
(**deploy** skill), and the break-glass env vars for the harnesses.
Respect **don't deploy/push mid-battery** (model-eval skill).

```bash
cd tests && npm install               # once
# 1. Targeted qualitative battery — new models only:
EVAL_MODELS=claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 npm run eval:models
# 2. Read the traces; fix anything broken BEFORE scoring (a scored run
#    of a broken integration wastes budget and pollutes the ledger).
# 3. Scored benches, same targeting:
EVAL_MODELS=claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 npm run eval:bench
EVAL_MODELS=claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 npm run eval:hf
# 4. Append findings to the three ledgers (append-only, fixed
#    seed/judge/budget across any before/after comparison).
# 5. Only NOW add model-profiles.js overrides for reproduced findings,
#    and/or revisit wire config (e.g. A/B Sonnet 5 thinking on-vs-off:
#    two eval:bench runs differing only in that flag).
```

The harnesses fetch `/api/models` from the live site, so new catalog
entries join automatically — `EVAL_MODELS` is only a cost/time filter.
Costs are real (Berget/Anthropic + Exa + judge tokens): prefer targeted
runs for a new provider, full-catalog runs for regressions.

## Status of the Anthropic trio (2026-07-09)

Applied without needing evidence (wire-level, by API contract):
- Sonnet 5: thinking explicitly disabled (adaptive-by-default model);
  revisit with an eval:bench A/B once live.
- Opus 4.8 / Haiku 4.5: thinking omitted (off by default on both).
- All three: vision on, EUR-converted pricing in the catalog,
  `model-profiles.js` DEFAULT (deliberately no overrides yet).

Pending (blocked on the ANTHROPIC_API_KEY secret + deploy): the
first-battery run order above, ledger entries, and any evidence-driven
profile overrides that fall out of it.
