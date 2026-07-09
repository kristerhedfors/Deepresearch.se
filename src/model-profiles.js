// @ts-check
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

/** @type {import('./types.js').ModelProfile} */
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
  // Total attempts (not extra retries) streamCompletion makes when a
  // completion comes back clean but empty (finish_reason set, zero
  // content) — see round 4/5's model-eval findings for the failure mode
  // this guards against. 2 = today's universal one-retry behavior.
  maxCompletionAttempts: 2,
  // The most images this model accepts on one request at Berget, when a
  // reproduced limit exists. null = no known limit (bounded only by the
  // global validation caps). Consulted by validation.js (reject an
  // over-limit attach with a clear message instead of an opaque Berget 400)
  // and enrichment.js (cap the Street View frames handed to the
  // vision-describe helper).
  maxImages: null,
};

/** @type {Record<string, Partial<import('./types.js').ModelProfile>>} */
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
  // Only `synth` (and `search`) priors are consulted for GLM now: the JSON
  // planning phases (triage/gap/validate) run on the fixed reliable JSON
  // model (Mistral Small — see pipeline.js/chat.js), NOT on GLM, precisely
  // because GLM's reasoning made its triage JSON unreliable in production
  // (it was echoing the raw user message as the search query). The
  // triage/gap/validate priors below are therefore effectively dead for GLM
  // (planResearch takes those from the JSON model) — kept only so the entry
  // stays a complete, self-documenting record; GLM's real remaining cost is
  // its slow synthesis.
  "zai-org/GLM-4.7-FP8": {
    priorsMs: { triage: 45_000, search: 3_000, gap: 12_000, synth: 40_000, validate: 25_000 },
  },
  // maxCompletionAttempts bumped to 3: rounds 4-5's evidence shows this
  // model's clean-but-empty completion isn't a per-query determinism
  // issue (the exact same query succeeds cleanly on some runs, needs the
  // retry on others) — a combined sample across two independent battery
  // rounds (cybersecurity + science/genetics, 90-150s budgets) found the
  // single retry insufficient about half the time at a 90s budget (5 of
  // 10 runs exhausted both attempts). Each attempt costs real latency
  // (~60-70s when it comes back empty) but a slow, correct answer beats a
  // fast, empty one — worth the extra attempt specifically for this model.
  "moonshotai/Kimi-K2.6": {
    priorsMs: { triage: 15_000, search: 2_500, gap: 8_000, synth: 35_000, validate: 20_000 },
    maxCompletionAttempts: 3,
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

  // 2026-07-08 live probe (production /api/chat, web search off, break-glass):
  // this model 400s ("invalid_request", opaque) on any request carrying MORE
  // THAN 2 images — 1 ✓, 2 ✓, 3 ✗, 4 ✗ — and it is COUNT, not size: four
  // 64×64 JPEGs totalling ~4 KB were rejected identically to four 120 KB
  // frames. Kimi-K2.6 and gemma-4-31B-it accepted the same 4-image request,
  // so it's model-specific, not a Berget gateway limit. Found via the Street
  // View vision-describe helper (4 cardinal frames → googlemaps.describe_failed
  // status 400 on every lookup with this model selected).
  "mistralai/Mistral-Medium-3.5-128B": {
    maxImages: 2,
  },

  // The Anthropic trio (claude-opus-4-8 / claude-sonnet-5 / claude-haiku-4-5,
  // added 2026-07-09) deliberately has NO entries here: new models start at
  // DEFAULT until a reproduced finding says otherwise (the rule at the top of
  // this file). Their one model-specific adaptation so far is WIRE-level, not
  // behavioral, so it lives in the provider client instead: Sonnet 5's
  // adaptive-by-default thinking is explicitly disabled in src/anthropic.js.
  // First-battery run order + which knob belongs where: the
  // tune-provider-models skill.
};

// Fields whose value is itself a lookup object (phase -> number) rather than
// a scalar — these need a fresh copy per call instead of a shared reference,
// and must be listed here so a future nested field can't be added without
// also teaching getModelProfile() how to merge it.
/** @type {Array<"priorsMs" | "maxTokensOverride">} */
const NESTED_OBJECT_FIELDS = ["priorsMs", "maxTokensOverride"];

/**
 * Returns the effective profile for a model: DEFAULT for an unknown model,
 * else DEFAULT merged with its override (nested lookup fields deep-copied).
 * @param {string} modelId
 * @returns {import('./types.js').ModelProfile}
 */
export function getModelProfile(modelId) {
  const override = OVERRIDES[modelId];
  if (!override) return DEFAULT;
  /** @type {import('./types.js').ModelProfile} */
  const merged = { ...DEFAULT, ...override };
  for (const field of NESTED_OBJECT_FIELDS) {
    const o = override[field];
    merged[field] = o ? { ...o } : DEFAULT[field];
  }
  return merged;
}
