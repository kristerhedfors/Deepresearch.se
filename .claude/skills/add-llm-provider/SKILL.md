---
name: add-llm-provider
description: >-
  Load when adding a NEW LLM provider (a chat-completions backend like
  Anthropic and OpenAI were added next to Berget) or new models to the
  model dropdown — "add provider X with models A, B", wiring
  pricing/billing, stream adapters, or model routing. Covers the provider
  registry seam (src/providers.js), the catalog contract, the two worked
  examples (src/anthropic.js — adapt-at-the-wire SSE; src/openai.js —
  native wire, params-only), the split-model-routing constraint, secrets
  and feature gating, and the validation ladder (unit tests → mock-HTTP
  smoke → live probe → bench A/B). Also load when debugging why a
  provider's models don't appear in the dropdown or answers fail on only
  one provider.
---

# Adding an LLM provider (or new models)

The playbook that added **Anthropic (Claude)** as the second provider next
to Berget and **OpenAI (GPT)** as the third (both 2026-07-09). Everything
here was done, not planned — there are now TWO worked examples covering
the two cases a new provider can fall into:

- `src/anthropic.js` — a **foreign-wire** provider (its own message shape
  and SSE vocabulary): convert the payload, adapt the stream.
- `src/openai.js` — an **already-OpenAI-shaped** provider: messages and
  SSE pass through untouched; only wire *parameters* differ.

## Architecture in one paragraph

`src/providers.js` is the ONLY seam. Everything downstream of it — the
pipeline, enrichments, validation, quota pricing, the UI dropdown — is
provider-agnostic: it consumes the merged model catalog
(`listChatModels`) and two dispatched calls (`chatCompletion`,
`completeJson`), and never names a provider. Secondary providers live in
the `SECONDARY_PROVIDERS` registry — one entry per provider carrying
`label` (error messages/logs), `matches` (the routing predicate),
`models` (the key-gated catalog), and the two call implementations;
Berget is the fallback when no entry matches. The routing key is the
model-id namespace (`claude-*` → Anthropic; bare `gpt-*` → OpenAI;
`vendor/model` paths → Berget). A new provider = one client module + one
registry entry + a distinct id namespace. **Do not** thread a `provider`
field through requests, state, or the client — the id namespace already
carries it.

**Namespace lookalikes:** Berget's catalog hosts `openai/gpt-oss-120b` —
a vendor-PATH id that must stay on Berget. Routing predicates match the
bare prefix only (`id.startsWith("gpt-")`), never a substring; when
choosing a new provider's namespace, grep the live Berget catalog for
collisions first.

## The two contracts a provider client must satisfy

1. **Catalog entries** in `ModelCatalogEntry` shape (types.d.ts): `id`,
   `name`, `pricing` (human tooltip — use berget.js's exported
   `formatPricing` so every entry reads identically), `price_in`/
   `price_out` (**EUR per token** — the quota system accounts in EUR;
   convert foreign currency with berget.js's shared `eurPerTokenFromUsd`
   / `USD_TO_EUR`, one documented rate for every USD-priced catalog),
   `up`, `vision`, and `provider`.
   A static list is FINE (Anthropic's and OpenAI's both are): prefer it
   when the provider's models API carries no pricing and the offered
   models are a product choice — a live fetch would add a failure mode
   without information.

2. **`chatCompletion(env, messages, {model})`** resolving to a
   Response-shaped `{ok, status, body, text()}` whose `body` is
   **OpenAI-style SSE** (`choices[0].delta.content`, a `finish_reason`
   on the last chunk, a usage chunk, `[DONE]`). This is the load-bearing
   trick: **adapt at the wire, don't fork the pipeline.** berget.js's
   `consumeChatStream` (and with it the idle/total guards, the
   finish_reason dropped-connection check, STREAM_MAX_CHARS, the
   empty-completion retry, and answer-stream.js's model failover) then works
   unchanged.
   - Foreign wire (Anthropic): the adapter is `openAiStreamFromAnthropic`
     + `oaiChunksFromEvent` — map the provider's stream events to deltas,
     a finish_reason (map their stop reasons; the pipeline only needs it
     truthy on a clean end), and prompt/completion token usage. A
     provider `error` stream event must ERROR the adapted stream (reader
     rejects → the pipeline's stall/retry path engages).
   - Native wire (OpenAI): return the raw fetch Response — but the wire
     PARAMETERS still need pinning (see `toOpenAiPayload`): GPT-5-era
     models reject the legacy `max_tokens` (→ `max_completion_tokens`),
     the streaming usage chunk only arrives when requested
     (`stream_options: {include_usage: true}`), and reasoning must be
     pinned off explicitly (`reasoning_effort: "none"`).
   Either way, return non-2xx responses AS-IS so callers' `.text()`
   detail capture works.

   Optionally also `completeJson` (the `{value, usage, diagnostics}`
   contract) so the registry entry stays total — normally unused,
   because of:

## The constraint you must not break

**Split model routing (CLAUDE.md invariant 3):** the JSON planning phases
(triage/gap/validate) always run on Berget's `DEFAULT_MODEL`. This holds
by construction as long as the merged catalog contains that entry —
`resolveJsonModel` (chat.js) picks it regardless of the user's answer
model. Never route JSON phases to the new provider by default; a new
provider only ever serves synthesis/direct answers (and possibly the
vision-describe helper, which selects any `vision && up` catalog model).

Also: **no function calling** (invariant 1) — a new provider's client
exposes plain streamed/JSON completions only, whatever else its API
offers. And **minimal dependencies** (invariant 5) — raw `fetch`, no SDK.

## Step list

1. **Client module** (`src/<provider>.js`): `apiBase` with a test-only
   `<PROVIDER>_URL` env override (the BERGET_URL/ANTHROPIC_URL/OPENAI_URL
   convention); auth from a dashboard secret (`<PROVIDER>_API_KEY`,
   never in the repo); connect timeout ~30s on streams, ~45s on JSON
   calls (unbounded fetches have bitten this project — berget.js round-2
   note); message conversion if the provider isn't OpenAI-shaped
   (Anthropic: system turns → top-level `system`, image data URLs →
   base64 source blocks, consecutive same-role merged) — or a pure
   payload builder pinning the wire params if it is (OpenAI:
   `toOpenAiPayload`); the SSE adapter only if the wire is foreign.
   **ReadableStream gotcha** (adapter case): a `pull()` that enqueues
   nothing is NOT re-invoked — loop inside `pull` until you enqueue or
   the source ends, or zero-output events (pings, message_start)
   deadlock the stream.
2. **Feature gate**: no key → `<provider>Models(env)` returns `[]` — the
   models don't exist, nothing routes, the UI shows nothing (the same
   invisible-without-secret convention as Shodan/Maps).
3. **Registry entry** (`src/providers.js`): add one object to
   `SECONDARY_PROVIDERS` (label/matches/models/chatCompletion/
   completeJson) and re-export the routing predicate. The catalog merge
   and the degrade path (primary catalog unreachable → return the
   reachable providers' entries rather than nothing) come for free.
4. **Types** (`src/types.d.ts`): add the Env secret + URL override.
5. **Per-model behavior**: leave `model-profiles.js` alone at first —
   unknown models get DEFAULT, and overrides require reproduced
   evidence. Model-specific WIRE parameters (e.g. Sonnet 5's
   thinking-off, the GPT models' reasoning_effort) live in the provider
   client, not in profiles. See the **tune-provider-models** skill for
   the full tuning pass.
6. **Docs**: CLAUDE.md project paragraph + code-layout table + unit-test
   list; the **integrations** skill's LLM-provider sections.

## Validation ladder (all four rungs, in order)

1. **Unit tests** (`src/<provider>.test.js`): payload conversion, the
   stream composed through the REAL `consumeChatStream` (that's the
   production pairing — for a native-wire provider this asserts the
   no-adapter assumption itself), catalog gating on the secret,
   stop-reason mapping, the no-finish_reason dropped-connection tell,
   the error event. Run `npm test` and `npm run typecheck`.
2. **Mock-HTTP smoke**: point `<PROVIDER>_URL` at a local `node:http`
   server emitting the provider's real SSE shapes and drive
   `chatCompletion` → `consumeChatStream` end to end (verifies headers,
   payload, stream plumbing over real HTTP). openai.test.js keeps this
   rung IN the unit suite ("openai client over mock HTTP") — copy that
   pattern so the smoke reruns on every `npm test`.
3. **Live probe** (needs the secret on the Worker + a deploy — see the
   **deploy** and **live-verify** skills): `/api/models` lists the new
   entries; one `/api/chat` run per model with web search off (cheap,
   isolates the completion path); one with an image (vision); check
   Workers Logs for `chat.complete` with sane token totals and the
   usage_events row pricing at the new entries' rates.
4. **Bench A/B** (the **model-eval** + eval-bench harnesses): see
   **tune-provider-models**.

## Known sharp edges (encountered while adding Anthropic and OpenAI)

- **Pricing currency**: providers price in USD, quotas account in EUR —
  the fixed documented conversion is berget.js's `USD_TO_EUR` /
  `eurPerTokenFromUsd`, shared by every USD-priced catalog. Don't
  silently mix currencies; `bergetCost` (quota.js) multiplies whatever
  per-token numbers the catalog entry carries.
- **`finish_reason` is load-bearing**: pipeline.js treats its absence as
  a dropped connection and throws. The stream must emit it exactly once
  on a clean end, and must NOT invent one when the provider stream dies
  early — that absence is the tell.
- **Thinking/reasoning modes**: a model that spends output tokens on
  hidden reasoning inside its max-tokens cap, or sits silent before its
  first text delta, fights the budget planner and the 60s idle guard.
  Decide the wire config explicitly per model and leave a revisit note —
  Sonnet 5 (adaptive-by-default) → `thinking: {type:"disabled"}`; the
  GPT-5-era models (reasoning-by-default) → `reasoning_effort: "none"`.
- **"OpenAI-compatible" still differs in params**: even a provider whose
  stream needs no adapter can reject legacy params — GPT-5-era models
  400 on `max_tokens` (use `max_completion_tokens`) and omit the
  streaming usage chunk unless `stream_options.include_usage` is set.
  Diff the payload against the provider's CURRENT API reference, not
  against berget.js.
- **Error-message wording**: streamOnModel's messages used to hardcode
  "Berget"; they now use `providerName(model)` — keep new provider
  failures attributable in logs and alerts.
