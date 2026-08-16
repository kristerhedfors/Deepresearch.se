---
name: model-catalog-refresh
description: >-
  Load when a provider ships a new model release and you need to check
  which of THIS repo's model menus/catalogs need updating — "Anthropic
  just released Opus 5", "OpenAI shipped a new GPT", "is our model
  dropdown stale", "audit the provider catalogs for updates", "check
  which models need bumping". This is the recurring FRESHNESS-CHECK pass
  over already-wired providers' static catalogs (src/anthropic.js,
  src/openai.js) — distinct from add-llm-provider (wiring a BRAND NEW
  provider) and tune-provider-models (evidence-driven tuning once a model
  is already in the catalog, and the first eval battery). Covers the
  replace-vs-add decision for a flagship version bump, the "never invent
  a price" rule, every place a model id literal needs to follow the
  bump, what stays untouched by design, and the introspection-artifact
  regen step. Also load when unsure whether a model name from outside
  the project (a blog post, a release announcement) is something this
  site actually offers, vs. unrelated background noise.
---

# Refreshing the model catalogs when a provider ships something new

The playbook for the recurring maintenance task this project's static,
evidence-driven catalogs create: a provider (Anthropic, OpenAI — the two
key-gated `SECONDARY_PROVIDERS`) announces a new model, and someone needs
to decide what, if anything, changes in `src/anthropic.js` / `src/openai.js`
and everywhere their catalog ids echo. First run: the 2026-07-25 Opus 5
bump (worked example below).

## Why this is its own skill, not part of the other two

- **add-llm-provider** is for wiring a provider that doesn't exist in
  `SECONDARY_PROVIDERS` yet (a new client module + registry entry).
- **tune-provider-models** is for adapting a model ALREADY in the catalog
  to this pipeline's use cases, once there's a reproduced finding —
  the first-battery run order lives there.
- **This skill** is the step in between: deciding whether an *external*
  model release changes anything about a catalog THIS repo already has,
  before either of the other two skills' work is even relevant.

## Berget is out of scope for the "stale static catalog" problem

Only Anthropic and OpenAI have hand-maintained static `MODELS` arrays
(no pricing API, a deliberate product choice — see add-llm-provider).
Berget's catalog is fetched LIVE (`src/berget.js`), so a new Berget model
just appears — nothing to bump. Berget can still go stale in
`model-profiles.js` overrides (a model's known quirk changes on a
provider-side update), but that's a **tune-provider-models** concern, not
this one.

## The audit checklist, per affected provider

1. **Is this actually a change to an offered tier, or unrelated noise?**
   This project offers ONE model per tier (Anthropic: opus/sonnet/haiku;
   OpenAI: sol/terra/luna/mini) — a "product choice", not an exhaustive
   mirror of the provider's full lineup. A release note mentioning a
   model this site doesn't currently expose (a coding-agent's own model,
   a comparison-only mention in a blog post, a model in a different
   family) is NOT automatically a catalog change. Confirm the release is
   actually the NEXT VERSION of a tier this site already serves before
   touching anything. (Worked example below: `claude-fable-5` looked
   catalog-relevant on first grep but turned out to be the coding
   agent's OWN model recorded in `public/build/history.md`'s build
   log — nothing to do with the site's Anthropic catalog.)

2. **Replace the tier's row — don't accumulate extra rows.** A flagship
   version bump (Opus 4.8 → Opus 5) replaces the existing entry in the
   `MODELS` array; it is not a new 4th/5th catalog slot. Only add a
   genuinely NEW row if the release is a distinct new tier/product line,
   and flag that as a scope decision for the owner first (AskUserQuestion)
   rather than assuming it — adding a tier changes the dropdown, the
   pricing surface, and every doc that names "the trio"/"the four".

3. **Never invent a price.** Carry the outgoing model's `usd_in`/`usd_out`
   forward unchanged unless an official new rate is confirmed (the
   provider's pricing page, not a guess) — leave a dated comment next to
   the `MODELS` array noting pricing was carried over pending
   confirmation. This follows CLAUDE.md invariant 5 (evidence-driven
   exceptions) the same way `model-profiles.js` requires a reproduced
   finding before any behavioral override.

4. **Wire behavior (thinking / reasoning-effort defaults) stays as
   evidenced, not assumed.** Default the new id to the SAME treatment as
   the model it replaces (e.g. "thinking omitted" if the outgoing model
   had no `thinkingConfigFor` branch) rather than guessing whether the
   new release changed its default-thinking behavior. If you have reason
   to believe it changed (check the provider's current API docs), say so
   explicitly as an open question in the rollout status note — do not
   silently add a `thinking: {type:"disabled"}` branch without a
   documented reason; that is exactly the kind of override
   model-profiles.js's "no override without a reproduced finding" rule
   exists to prevent, applied one layer up at the wire-config level.

5. **Follow the id through every place it echoes.** After bumping the
   `MODELS` array entry itself, grep the repo for the OLD id
   (`grep -rn "claude-opus-4-8"` style) and update:
   - The provider client's own comments naming the model by version
     (`src/anthropic.js` / `src/openai.js`).
   - `model-profiles.js`'s explanatory comment about the trio/lineup
     (NOT the `OVERRIDES` object itself — that stays empty per the
     evidence rule until a battery finds something).
   - `src/<provider>.test.js` and `src/providers.test.js` — every
     assertion naming the old id.
   - The **integrations** skill's "Models (static catalog...)" line.
   - The **tune-provider-models** skill's `EVAL_MODELS=` example commands,
     plus a new dated "Status of the `<X>` rollout" section (follow the
     existing "Status of the Anthropic trio" / "Status of the OpenAI set"
     sections as the template — what was carried over unchanged, what's
     still unevidenced, what's pending).
   - `sdk/skills/provider-registry/SKILL.md`'s mirrored catalog list, if
     the DistillSDK manifest names the same models (it mirrors the
     server catalog as "the safe set to serve").
   - `docs/test-batches/providers.json` if you want a parallel test case
     for the new id (optional — not required for the routing check it
     performs, since the OLD id's test case still validates the same
     thing).
   Leave append-only ledgers (`tests/MODEL-EVAL-FINDINGS.md`,
   `EVAL-BENCH-FINDINGS.md`, `HF-BENCH-FINDINGS.md`) untouched — their
   existing entries are an accurate historical record of what ran against
   the OLD id; add a NEW dated entry once the first battery runs against
   the new one, per their own append-only convention.

6. **What does NOT need touching, by design** (confirmed by the id-namespace
   dispatch architecture — see add-llm-provider):
   - `src/providers.js` — dispatches by id-prefix (`claude-*`, `gpt-*`),
     no per-id literal.
   - `public/js/models.js` — fully catalog-driven from `/api/models`, zero
     hardcoded ids; the new id appears in the dropdown automatically.
   - `public/js/provider-region.js` — the country flag is keyed by
     `provider` ("anthropic"/"openai"), not model id.
   - `public/js/drc-providers.js` (the `/cure` tier's client-side registry)
     — only wires CORS-capable providers: OpenAI, Anthropic, Groq, Hugging
     Face, Berget,
     plus the keyless `local` entry that takes any OpenAI-compatible base URL.
     Since 2026-07-26 Anthropic IS wired here, so a Claude
     catalog bump has to follow into this file too: `fallbackModels` and
     `modelFilter` mirror `src/anthropic.js`'s `MODELS`, and `jsonModel` is
     the cheap planning model. The earlier note that Anthropic "has no CORS
     support" was wrong — it serves `Access-Control-Allow-Origin: *` with the
     `anthropic-dangerous-direct-browser-access` opt-in; what kept it out was
     its non-OpenAI wire, now adapted in-module.
   - `public/js/ai-models.js`'s chat-mention recognizer — its
     `VERSIONED_FAMILIES` regex already matches any version suffix on an
     existing family root (`opus|sonnet|haiku`), so "opus 5" is
     recognized with no code change. A genuinely NEW tier/family name
     (not a version bump) would need a new root added here — one more
     reason step 2's replace-vs-add distinction matters.

7. **Regenerate the introspection artifacts.** Any edit under `src/`
   (the provider client, `model-profiles.js`) drifts the committed
   snapshot artifacts introspection mode serves:
   ```bash
   npm run bundle       # public/introspect/source-snapshot.json
   npm run bundle:rag   # public/introspect/source-rag.json
   ```
   `npm test` names the drift explicitly if you skip this — never hand-edit
   either JSON file.

8. **Run the validation ladder** from add-llm-provider (unit tests first,
   `npm test` + `npm run typecheck`), then once the change is deployed:
   the live-probe rung (`/api/models`, one cheap `/api/chat` run) and the
   tune-provider-models first-battery run order, targeted at the new id
   via `EVAL_MODELS=`.

## Worked example: the Opus 5 rollout (2026-07-25)

Anthropic released Opus 5. Audit and changes made:

- **Scope check**: grepped the repo for every Claude model reference
  first. Found `claude-opus-4-8` (the outgoing catalog entry — this WAS
  in scope) and, separately, `claude-fable-5` in `public/build/history.md`
  — the coding agent's own model identity while building this site's
  history log, unrelated to the end-user chat catalog. Confirmed out of
  scope; left untouched. `claude-sonnet-5` and `claude-haiku-4-5` were
  already current (added 2026-07-09) — nothing to do there.
- **Replace, not add**: bumped the existing Opus row in place
  (`src/anthropic.js` `MODELS`) rather than adding a 4th entry — this is
  a flagship version bump of an existing tier.
- **Pricing carried over unchanged** ($5 in / $25 out per 1M) — no
  official new rate available; noted in a dated comment next to the
  array.
- **Thinking config left unevidenced**: `thinkingConfigFor` still has no
  `claude-opus-5` branch (matches the outgoing Opus 4.8's "omitted = off"
  treatment). Flagged as an open question to check against Anthropic's
  current API docs before the first eval battery, rather than guessing.
- **Followed the id through**: `src/anthropic.js` comments,
  `src/anthropic.test.js`, `src/providers.test.js`,
  `model-profiles.js`'s trio comment, the **integrations** skill, the
  **tune-provider-models** skill (EVAL_MODELS examples + a new "Status of
  the Opus 5 rollout" section), `sdk/skills/provider-registry/SKILL.md`'s
  mirrored list.
- **Regenerated** `public/introspect/source-snapshot.json` and
  `source-rag.json` via `npm run bundle` / `npm run bundle:rag`.
- **Left untouched, confirmed by design**: `src/providers.js`,
  `public/js/models.js`, `public/js/provider-region.js`,
  `public/js/drc-providers.js` (Anthropic isn't wired there), and every
  append-only eval ledger (new entries land there once the first battery
  runs, not as part of this pass).
- **Pending** (needs `ANTHROPIC_API_KEY` live + a deploy): the live-probe
  rung and the first-battery eval run
  (`EVAL_MODELS=claude-opus-5,claude-sonnet-5,claude-haiku-4-5`), whose
  findings will confirm or correct the carried-over thinking-config
  assumption above.
