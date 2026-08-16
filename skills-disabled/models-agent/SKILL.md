---
name: models-agent
description: >
  Load when working on the MODELS AGENT — the chat mode whose subject is the
  models themselves, and the model LIFECYCLE it owns (discovered → evaluated →
  enabled) — or on anything it is built from: src/model-catalog.js (the
  provider-agnostic catalog, the lifecycle states, the MODEL ALLOWANCE),
  src/model-checks.js (the established verification metrics and their runner),
  src/models-agent.js (the mode's enrichment: forced Hub search + the EN/SV
  model-lifecycle gate + the priced catalog block + the `model_cards` SSE
  event), src/models-api.js (`/api/models/{catalog,verify,enable,disable}`),
  src/user-models.js (the per-account enabled list + verification records), or
  the client board public/js/models-panel.js + models-core.js. ALSO load when
  asked to "let users pick any model", "show what a model costs before running
  it", "evaluate a model against our metrics", "add a verification check", "make
  a model from one mode available in the others", "raise the model allowance",
  or when debugging why an enabled model does not appear in the dropdown / is
  billed at zero / shows the wrong verification state. For adding a NEW PROVIDER
  see **add-llm-provider**; for Hub SEARCH as a research source (src/hf.js, a
  different thing entirely) see **integrations**.
---

# The Models agent

The sixth chat mode to ship (`models`, amber). Every other agent answers ON a model;
this one answers ABOUT them, and owns their whole life on the platform.

## The shape, in one paragraph

It is **not a new executor.** Its answer phase is the ordinary `research` one,
so it needed no row in `src/pipeline.js` `ANSWER_PHASE_RUNNERS`. What
it adds is one pre-pipeline enrichment (`src/models-agent.js`, registered in
`src/enrichment.js` `CORE_ENRICHMENTS`) that forces Hub search on via the
generic `state.forceAux` seam, raises the hub's per-request search ceiling via
the equally generic `state.auxMaxPerRequest` seam, and, when the message is
about models, folds the live cross-provider catalog into context and emits
`model_cards`.

**A forced source has to survive every answer path, not just the wave.** The
declaration used to be honoured only inside `runSearches`, so turning developer
mode on in this mode routed the turn to `runSourceResearch` — which answers from
this repo's own files and never reaches a wave. The Models agent then answered
model questions having asked the hub nothing: `chat_logs` #670 and #671 both
recorded `0s/0src` (feedback #36, 2026-07-26). `runForcedAuxSearches` now runs
the forced sources on that path too and hands the digest to both its answer
paths, with the answer prompts taking `{ externalSources: true }` so their
"there are no external sources to cite" clause doesn't discard what was just
fetched. Adding another always-on source? Check every path that can END a turn,
not just the one you were looking at.

## The two orthogonal axes — the design's whole point

|  | What it says | Who sets it |
|---|---|---|
| **Lifecycle** | what is REACHABLE | the account (enable/disable) + which providers are configured |
| **Verification** | what is KNOWN | running the checks |

They do not gate each other. A model can be available and unverified, enabled
and failing four checks, discovered and never probed. **A failing check never
blocks selection.** If you find yourself adding "…and it must pass X to be
usable", stop: that turns a useful disclosure into a silent ban, and this
project ships models with reproduced quirks on purpose (`src/model-profiles.js`
exists for exactly that). The three check states — pass / fail / **untested** —
must stay visually distinct for the same reason: "nobody asked yet" and "we
asked and it failed" are different facts.

### The lifecycle states

```
discovered ──enable──> enabled          (only open providers produce `discovered`)
available                               (curated providers: born here, nothing to enable)
```

`available` is not a lesser `enabled` — it means the provider ships it and the
key is configured, so it is *already* selectable everywhere. Offering "Enable"
on one is a promise of a state change that does not exist; the API answers 409
and says so.

## Where the checks come from

Every check in `MODEL_CHECKS` is a failure mode this project actually hit. Most
cite the round in `tests/MODEL-EVAL-FINDINGS.md` that found it. **Do not add a
check because it sounds rigorous** — add it because something broke.

| check | earned its place |
|---|---|
| `reachable` | round 4's silent request deaths (the exceededCpu era) |
| `completion` | round 4/6: clean stream, `finish_reason` set, ZERO content — Kimi-K2.6 still does it. Three probes; any empty one fails |
| `json` | invariant 3's whole reason. A model failing this can still ANSWER — it must just never plan |
| `streaming` | a model that answers in one lump reads as a hang |
| `swedish` | invariant 6 |
| `citations` | synthesis is `[n]`-grounded; dropping the convention makes answers untraceable |
| `injection` | round 3: two models obeyed an instruction embedded in retrieved content |
| `vision` | claimed image input, actually accepts an image. Skipped (ABSENT, not failed) for text-only models |
| `latency` | `budget.js` plans against priors; round 1's GLM triage ran 24–95s against a 6s prior |

Each is **one bounded direct model call with a deterministic assertion**. No
model judges another (invariant 1) — a grader would be a second opinion
masquerading as a measurement. Checks run **sequentially**: they are billed
calls against a key that real user traffic is also using.

## Traps this code has already hit

1. **A raced timeout that is never cleared holds the event loop.** `runCheck`
   clears its timer in `finally`. Before that fix a suite of instant checks took
   45 seconds and a Worker isolate would be held open per check.
2. **`parseSettings` drops unknown keys.** Writing its output straight back
   would delete the enabled list and the verification records. `settings.js`
   `mergeStoredSettings` is the fix; do not bypass it.
3. **Never store an unpriced model.** An entry with no rate bills every request
   using it at **zero**. `acceptedFromBrowseItem` returns null; the API 400s.
4. **Re-validate enabling server-side** against the LIVE catalog, never against
   the client's numbers.
5. **A provider that contributed models is working**, whatever the secret check
   thinks — some catalogs read without a key. `buildCatalog` reports
   `configured || count > 0`, because "not configured" beside eight of its
   models makes the whole status line worth ignoring.
6. **`hfIntent` already fires on a bare `hf`** (`src/hf.js` — `\bhf\b`, any
   casing, either language, plus `hf:`-prefixed model ids people paste back).
   Test-pinned in `src/hf.test.js`. So "make `hf` trigger the hub" is a
   verification task, not a code change — check before widening a regex that
   already covers it.
7. **The `hf_models` / `hfId` storage keys are deliberate legacy.** They predate
   the generalisation from a Hugging Face agent to a Models agent and are kept
   so no account is stranded. Internal only — nothing user-facing says "hf".

## The allowance

`config.js` → `models: { max_output_usd, max_enabled }`, read by
`modelAllowance`. Raising these IS how an account's allowance is extended — no
code change. It governs the `discovered → enabled` transition **only**. The
structural ceiling above any allowance is `user-models.js` `MAX_STORED` (24): a
settings_json row is not a database table.

## Adding a check

1. A row in `MODEL_CHECKS` with `id`, `label`, a `why` that names the incident
   or invariant it defends, `applies`, and `run`.
2. `applies` must return false where the check is meaningless — an inapplicable
   check is ABSENT, never failed.
3. Deterministic assertion only. If you want a model to judge it, you want a
   bench (`tests/eval-bench.mjs`), not a check.
4. Extend `src/model-checks.test.js`'s established-failure-modes list.

## Adding a provider with an open catalog

`src/providers.js`: a registry entry with `id`, `explore(env, log)` returning
provider-agnostic rows, and `configured`. Nothing in `model-catalog.js`,
`models-api.js` or the client changes. That is the property to preserve — if a
change would make a second marketplace need edits up here, it is the wrong
change.

## Facts established by live probe (2026-07-26)

`GET https://router.huggingface.co/v1/models`, unauthenticated, 200:

- 129 models. Not "every model on the Hub" — the ones inference providers
  actually serve. Say so in UI copy; the distinction is real.
- 21 published no price on any provider. 39 accept image input. Every provider
  row read `status: "live"`. Output prices spanned **$0.03–$6.27** per 1M.
- Row shape: `{ id, owned_by, architecture.input_modalities[], providers: [{
  provider, status, context_length, pricing: {input, output} /* USD per 1M */,
  is_free, supports_tools, supports_structured_output, first_token_latency_ms,
  throughput }] }`.

Re-probe before assuming any of this still holds; the catalog is somebody
else's and moves.

## Verifying a change

```bash
node --test src/model-catalog.test.js src/model-checks.test.js \
            src/models-agent.test.js src/user-models.test.js \
            src/hf-inference.test.js public/js/models-core.test.js
npm test && npm run typecheck
```

Live, once deployed: pick **Models** in the mode dropdown, press ⚖, and check
that (a) the board shows three lanes with every configured provider's models,
(b) a discovered model's card shows a rate AND a per-turn estimate, (c) Enable
puts it in the `#model` dropdown under "⚖ Enabled by you" **without a reload**,
(d) Verify fills the checkboxes and a failing check leaves the model
**selectable**, and (e) a turn answered on it lands in `chat_logs` with a
non-zero `berget_cost` (the **chat-logs** skill). (e) is the one that catches a
broken price snapshot.
