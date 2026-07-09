---
name: model-tuning
description: >-
  Load when onboarding a NEW model or provider into the catalog ("tune the
  Claude models", "adapt model X for our use cases"), when a provider updates
  a served model, or when deciding what per-model adaptation a use case needs.
  The per-use-case tuning inventory (which knob tunes what: model-profiles,
  budget priors, prompts, validation caps) and the evidence-gathering run
  (preflight → model-eval battery → scored benches → codify → ledger).
  Complements model-eval (the harness mechanics) and add-llm-provider (the
  wiring) — this skill is WHAT to tune and HOW to decide.
---

# Tuning a model for the codified use cases

The procedure for adapting a newly available model (e.g. the Anthropic trio)
to every place a model serves in this app, without violating the
load-bearing rule: **per-model overrides trace back to reproduced findings,
not guesses** (CLAUDE.md invariant #5). Unknown models run with defaults and
self-tune via the EWMA — an onboarding run's job is to find where defaults
are WRONG for this model, prove it, and codify exactly that.

## The use-case inventory — what a model serves, and its tuning knobs

| Use case | Where it runs | Which model | Knobs (only with evidence) |
|---|---|---|---|
| **Synthesis / direct / clarify** (streamed answer) | `pipeline.js` `streamOnModel` | The user's chosen model | `priorsMs.synth` (cold-isolate planning for slow models), `maxCompletionAttempts` (clean-but-empty retries) |
| **JSON planning** (triage / gap / validate / claim extraction) | `pipeline.js` `runJsonPhase` | Fixed `DEFAULT_MODEL` (Mistral Small) — but the USER's model serves these when Mistral is down (`resolveJsonModel`), so every catalog model must be tested here too | `jsonReinforcement` (JSON-only reinforcement line), `maxTokensOverride` per phase, `skipValidation` (evidenced dead validate), `priorsMs.triage/gap/validate` |
| **Quiz generation** | `pipeline.js` `runQuizGeneration` | `jsonModel` (same routing as JSON planning) | Same JSON knobs; quiz JSON is bigger than triage JSON — watch truncation |
| **Quiz grading** | `quiz-api.js` | Always `DEFAULT_MODEL` | Nothing per-model (fixed) |
| **Vision describe** (Street View / map frames) | `enrichment.js` `describeStreetView` | The user's model when vision-capable, else ranked catalog vision models — a new vision model joins this pool automatically | `maxImages` (per-request image cap, like Mistral Medium's evidenced 2) |
| **Budget planning** | `budget.js` `planResearch` | Per-model EWMA, seeded from `PRIORS_MS` or `priorsMs` | `priorsMs` — only when a model is evidenced FAR off the global priors (GLM/Kimi precedent) |
| **Billing / quotas** | `chat.js` `summarizeSpend`, `quota.js` | Catalog `price_in`/`price_out` per bucket | Catalog pricing in the provider client — keep provider prices current |

Universal machinery needs NO per-model tuning (don't touch it for one model):
connect/idle/total stream guards, `STREAM_MAX_CHARS`, the finish_reason
dropped-connection tell, failover, `parseLooseJson` — those are
pipeline-level; a finding there is a universal fix (see model-eval's
"findings that turned out NOT to be model-specific").

## The run

### 0. Preflight (cheap, do first — a broken preflight voids the battery)

- `curl -u $BASIC_AUTH_USER:$BASIC_AUTH_PASS https://deepresearch.se/api/models`
  — the model must be listed, `up: true`, correct provider-branded name,
  pricing, and `vision` flag. **A provider's models missing here almost
  always means the provider secret isn't on the Worker** — check
  `npx wrangler secret list` (needs `CLOUDFLARE_API_TOKEN`; the exact secret
  NAME matters: e.g. `ANTHROPIC_API_KEY`, not an approximation). Found live
  2026-07-09: the Anthropic key had been added as `OPENAI_API_KEY` and the
  trio silently stayed out of the catalog — by design (missing key = invisible
  provider), but easy to misread as a code bug.
- Deployed code current (`/api/models` names carry the provider prefix; or
  probe per the **deploy** skill). Unit suite green locally.

### 1. Evidence battery (per the **model-eval** skill's methodology)

Run from `tests/`, targeted at just the new models so cost stays bounded:

```bash
EVAL_MODELS=claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 \
  EVAL_QUERY_SET=round1 EVAL_BUDGET_S=60 npm run eval:models
EVAL_MODELS=claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5 \
  EVAL_QUERY_SET=round3 EVAL_BUDGET_S=60 npm run eval:models   # vision + injection + unanswerable
```

- `round1` exercises factual/comparison/vague-clarify/narrow-gap/direct —
  the synthesis and planning paths. `round3` adds image input (the vision
  describe + image-triage rules), the honest-about-nothing path, topic
  switching, and prompt injection. Reuse existing sets for onboarding runs
  (reproducible against past rounds); add a NEW named set only for new
  probe ideas.
- **Don't deploy mid-battery** (auto-deploy truncates in-flight streams —
  reproduced round 2).
- Force the JSON phases onto the new model too — `resolveJsonModel` only
  routes there when Mistral is down, so a normal battery never exercises
  it. Cheapest probe: a direct `POST /api/chat` won't do it; instead run
  one quiz query per model ("quiz me with 3 questions about X") — quiz
  generation runs on the JSON model... which is also Mistral. So the ONLY
  honest JSON-phase evidence for a non-default model today is a temporary
  local `resolveJsonModel` override in a dev run, or waiting for a real
  Mistral outage. Record "untested as JSON model" in the ledger rather
  than guessing a `jsonReinforcement` entry.

### 2. Read the results — per use case, what to look for

- **Synthesis**: empty completions (→ `maxCompletionAttempts`), missing
  finish_reason (dropped connections), leaked tool-call tokens, per-phase
  durations vs the global priors (`_summary.json` + per-run timelines —
  only codify `priorsMs` when the gap is severalfold, the GLM/Kimi bar).
- **Provider refusals** (Anthropic-specific): a safety refusal surfaces as
  `stop_reason: "refusal"` → the transcoder passes `finish_reason:
  "refusal"` with empty text → pipeline treats it as a clean-but-empty
  completion → retries, then **fails over to the Berget fallback model**.
  That failover is the designed outcome; the round-4 cybersecurity set is
  the probe for whether legitimate infosec research over-triggers it.
- **Vision**: all 4 Street View frames accepted? (Mistral Medium's 2-image
  cap precedent → `maxImages`.) Image-direct vs image-research triage
  behavior.
- **Validation**: inconclusive verdicts across runs (gpt-oss precedent →
  `skipValidation` — but only after a confirmation battery, 6-of-7 bar).

### 3. Scored quality (optional, when the question is "is it BETTER")

`npm run eval:bench` / `npm run eval:hf` with `EVAL_MODELS=<new models>`,
fixed seed/judge/budget, multi-sample de-noise — per the **model-eval**
skill. Use when deciding default-model changes or admin recommendations,
not for mere onboarding.

### 4. Codify + record

- Reproduced finding → `model-profiles.js` entry with the dated evidence
  comment (existing entries are the template); universal finding → prompt/
  pipeline fix instead. New profile FIELDS need the merge test updated
  (`model-profiles.test.js`, `NESTED_OBJECT_FIELDS` rule).
- Append the dated round section to `tests/MODEL-EVAL-FINDINGS.md`
  (append-only), including negative results ("no override needed") — that's
  what makes the next onboarding cheap.
- Commit AFTER the battery finishes, never mid-run.

## Anthropic-specific watch list (from the 2026-07-09 integration)

- Sonnet 5 runs **adaptive thinking by default** — thinking time shows up
  as synthesis latency and thinking tokens bill as output tokens without
  visible text. If round data shows synth durations far past priors, that's
  the first suspect; the knob is `priorsMs.synth`, NOT disabling thinking
  (quality tradeoff — needs its own bench A/B).
- No `response_format` JSON mode exists on the Messages API — JSON phases
  rely purely on prompt instruction + `parseLooseJson`. Claude is reliably
  JSON-obedient, but this is exactly what `jsonReinforcement` exists for if
  evidence says otherwise.
- `temperature`/`top_p`/`top_k` must never be added to the request payloads
  (400 on Opus 4.8 / Sonnet 5).
- Pricing in `src/anthropic.js` is static (USD, 1:1 EUR over-count) —
  re-check against the **claude-api** skill when models are added/changed.
