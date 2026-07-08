---
name: model-eval
description: >-
  Load when running the model-matrix eval battery (tests/model-eval.mjs),
  investigating a per-model quirk/failure, editing src/model-profiles.js, or
  when Berget's model catalog changes. Covers QUERY_SETS discipline, the
  append-only findings ledger (tests/MODEL-EVAL-FINDINGS.md), the
  "don't commit mid-battery" rule, and how to decide model-profile entries
  (evidence-driven).
---

# Model-matrix eval harness

**Model-matrix eval (`tests/model-eval.mjs`)**: a separate tool from the
Playwright suite — a plain Node script (no deps) that runs a fixed
battery of research queries against every `up` model from `/api/models`
directly via the live SSE endpoint, to find per-model behavior
differences (see `src/model-profiles.js`). Not pass/fail; it's a
data-collection sweep whose output is read and analyzed by hand.
Multiple named query sets exist in `QUERY_SETS` (`round1`, `round2`, ...)
— add a new named set for a fresh sweep rather than editing an old one,
so past findings stay reproducible against the exact set that produced
them. Queries can be multi-turn (`turns: [...]`): the harness resends the
ACTUAL streamed answer as the assistant turn for the next request, the
same as the real client, to exercise conversation-context handling
(e.g. triage resolving "this"/"it" from a prior turn) rather than
simulating it.

```bash
cd tests && npm run eval:models   # BASIC_AUTH_USER/PASS required
# EVAL_QUERY_SET=round2 EVAL_MODELS=id1,id2 EVAL_BUDGET_S=60 EVAL_CONCURRENCY=3 are optional overrides
```

Results land in `tests/model-eval-results/<timestamp>/` (gitignored — raw
model output, no lasting repo value): one JSON file per model×query run
(full SSE event sequence, final answer, a heuristic scan for leaked
tool-call-shaped tokens) plus a `_summary.json`. Re-run this whenever
Berget's catalog changes materially (new model, or a model profiled in
`model-profiles.js` gets updated by its provider) to check whether
existing overrides still apply and whether new ones are needed.
`tests/MODEL-EVAL-FINDINGS.md` is the durable, append-only ledger of
every round's findings/decisions/open issues — read it before starting a
new round (don't re-discover a known issue) and append a new dated
section after every round (don't edit history) so evaluation actually
hillclimbs across rounds instead of restarting each time.

## Deciding `model-profiles.js` entries (evidence-driven)

**Keep this evidence-driven**: every entry should trace back to a
reproduced finding, not a guess. `getModelProfile(modelId)` returns
per-model overrides consulted at the few places that need them; models
with no entry behave exactly as if the module didn't exist. The eval
battery above is the tool for finding them. (Field-by-field detail — 
`priorsMs`, `jsonReinforcement`, `maxTokensOverride`, `skipValidation`,
`maxCompletionAttempts` — lives in the **pipeline-architecture** skill.)

## Findings that turned out NOT to be model-specific

Not every finding from the harness is model-specific — several rounds
surfaced universal gaps fixed at the prompt/pipeline/platform level
instead of via a model profile. Those incident *fixes* are documented in
the **pipeline-architecture** skill (round-2 hung-fetch timeouts, round-3
prompt-injection + finish_reason, round-4 exceededCpu / Workers Paid /
STREAM_MAX_CHARS) and in `tests/MODEL-EVAL-FINDINGS.md`. When a battery
surfaces something new, decide first whether it is model-specific (→ a
profile entry) or universal (→ a prompt/pipeline/platform fix), and record
the decision in the ledger.

## Don't commit (or otherwise deploy) mid-battery

**Don't commit (or otherwise deploy) mid-battery.** A push to `main`
triggers Cloudflare's auto-deploy, which can silently truncate in-flight
streamed requests the battery is relying on — this produced a batch of
confusing zero-answer results during the round 2 battery (traced to a
mid-run `git push`, not a real bug) before being caught and re-run clean.
Let a battery finish before pushing anything.
