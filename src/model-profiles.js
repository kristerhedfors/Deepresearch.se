// Per-model behavioral/performance overrides layered on top of the
// pipeline's default, model-agnostic behavior. Unknown models get DEFAULT
// unchanged — this module exists ONLY to patch specific, empirically
// observed per-model quirks, found by running a fixed research-query
// battery against every model in Berget's catalog (tests/model-eval.mjs;
// methodology and raw results are reproducible, but results themselves
// aren't committed — see that file's header).
//
// Keep this evidence-driven: don't add an override without a reproduced
// finding. Unknown/new models always get DEFAULT — behavior for them is
// exactly what it was before this module existed.

const DEFAULT = {
  // Per-phase prior duration overrides (ms), consulted by budget.js's
  // phaseEstimates() ONLY until the model has its own in-isolate EWMA
  // measurement for that phase. null = no override, fall back to the
  // global PRIORS_MS every model started with.
  priorsMs: null,
  // Extra reinforcement line spliced into JSON-mode prompts (prompts.js)
  // for models that tend to preface their JSON with reasoning/prose,
  // risking truncation before a complete object forms.
  jsonReinforcement: false,
  // Per-phase max_tokens override for completeJson calls. Keys match
  // budget.js's phase names (triage/gap/validate); only set what's needed.
  maxTokensOverride: null,
  // Skip the post-validation phase entirely for this model — for a model
  // whose validate call has been evidenced to reliably fail to produce a
  // usable verdict, running it is pure wasted latency/tokens for the same
  // "draft kept as-is" outcome the fail-soft path already gives for free.
  skipValidation: false,
};

const OVERRIDES = {
  // 2026-07-06 battery: both models measured far slower than the global
  // priors. GLM's triage alone took 24-95s in isolated single-phase runs
  // (clarify-only queries) against a 6s global prior, and both models
  // routinely missed the 60s-budget pipeline's deadline on multi-phase
  // queries (GLM hung at the very start of synthesis on two different
  // queries, twice each, after triage+search+gap already completed;
  // Kimi completed full runs but often past the 60s target, once timing
  // out just after validation had already finished). Elevated priors
  // here make planResearch() plan conservatively for these models from a
  // COLD isolate — fewer search angles, validation skipped sooner —
  // instead of only adapting after the in-isolate EWMA warms up.
  // Approximate, not exact: derived from a handful of live observations,
  // not precise per-phase instrumentation. Expected to keep improving via
  // the existing EWMA mechanism as real traffic accumulates.
  "zai-org/GLM-4.7-FP8": {
    priorsMs: { triage: 45_000, search: 3_000, gap: 12_000, synth: 40_000, validate: 25_000 },
  },
  "moonshotai/Kimi-K2.6": {
    priorsMs: { triage: 15_000, search: 2_500, gap: 8_000, synth: 35_000, validate: 20_000 },
  },

  // gpt-oss-120b's post-validation phase returned neither "pass" nor a
  // usable "revise" on 3 of 4 research runs in the 2026-07-06 battery
  // ("Validation inconclusive — draft kept as-is") — every other model
  // verified cleanly. First attempt: a "JSON only, no preamble"
  // reinforcement line plus a bumped validate max_tokens, on the
  // hypothesis that a verbose/reasoning-leaning model was tripping the
  // token cap before completing its JSON. A follow-up confirmation
  // battery with that fix deployed showed NO improvement — inconclusive
  // on all 3 of 3 research runs that reached validation, same rate as
  // before. Root cause remains unconfirmed (the Cloudflare Workers Logs
  // telemetry query API only returns row-count aggregates from this
  // environment, not log content, so the parse_mode/finish_reason
  // diagnostics added for this purpose couldn't be pulled). With the
  // failure now reproduced 6 of 7 times across two independent batteries,
  // the pragmatic fix is to stop attempting the phase for this model
  // rather than keep guessing at prompt/token tweaks: skip validation
  // entirely, landing on the same "draft kept as-is" outcome the
  // inconclusive path already gives, without the wasted latency/tokens.
  // jsonReinforcement is kept (harmless, may still help triage/gap).
  "openai/gpt-oss-120b": {
    jsonReinforcement: true,
    skipValidation: true,
  },
};

// Fields whose value is itself a lookup object (phase -> number) rather than
// a scalar — these need a fresh copy per call instead of a shared reference,
// and must be listed here so a future nested field can't be added without
// also teaching getModelProfile() how to merge it.
const NESTED_OBJECT_FIELDS = ["priorsMs", "maxTokensOverride"];

export function getModelProfile(modelId) {
  const override = OVERRIDES[modelId];
  if (!override) return DEFAULT;
  const merged = { ...DEFAULT, ...override };
  for (const field of NESTED_OBJECT_FIELDS) {
    merged[field] = override[field] ? { ...override[field] } : DEFAULT[field];
  }
  return merged;
}
