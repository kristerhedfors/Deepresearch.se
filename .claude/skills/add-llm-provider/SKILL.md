---
name: add-llm-provider
description: >-
  Load when adding a NEW LLM provider (a chat-completions backend like
  Anthropic was added next to Berget) or new models to the model dropdown —
  "add provider X with models A, B", wiring pricing/billing, stream
  adapters, or model routing. Covers the provider dispatch seam
  (src/providers.js), the catalog contract, the adapt-at-the-wire SSE
  pattern (src/anthropic.js), the split-model-routing constraint, secrets
  and feature gating, and the validation ladder (unit tests → mock-HTTP
  smoke → live probe → bench A/B). Also load when debugging why a
  provider's models don't appear in the dropdown or answers fail on only
  one provider.
---

# Adding an LLM provider (or new models)

The playbook that added **Anthropic (Claude)** as the second provider next
to Berget (2026-07-09). Everything here was done, not planned — the
Anthropic integration (`src/anthropic.js`, `src/providers.js`) is the
worked example to copy.

## Architecture in one paragraph

`src/providers.js` is the ONLY seam. Everything downstream of it — the
pipeline, enrichments, validation, quota pricing, the UI dropdown — is
provider-agnostic: it consumes the merged model catalog
(`listChatModels`) and two dispatched calls (`chatCompletion`,
`completeJson`), and never names a provider. The routing key is the
model-id namespace (`claude-*` → Anthropic; `vendor/model` paths →
Berget). A new provider = one client module + one dispatch branch + a
distinct id namespace. **Do not** thread a `provider` field through
requests, state, or the client — the id namespace already carries it.

## The two contracts a provider client must satisfy

1. **Catalog entries** in `ModelCatalogEntry` shape (types.d.ts): `id`,
   `name`, `pricing` (human tooltip — use berget.js's exported
   `formatPricing` so every entry reads identically), `price_in`/
   `price_out` (**EUR per token** — the quota system accounts in EUR;
   convert foreign currency at a documented fixed rate, see
   `USD_TO_EUR` in anthropic.js), `up`, `vision`, and `provider`.
   A static list is FINE (Anthropic's is): prefer it when the provider's
   models API carries no pricing and the offered models are a product
   choice — a live fetch would add a failure mode without information.

2. **`chatCompletion(env, messages, {model})`** resolving to a
   Response-shaped `{ok, status, body, text()}` whose `body` is
   **OpenAI-style SSE** (`choices[0].delta.content`, a `finish_reason`
   on the last chunk, a usage chunk, `[DONE]`). This is the load-bearing
   trick: **adapt at the wire, don't fork the pipeline.** berget.js's
   `consumeChatStream` (and with it the idle/total guards, the
   finish_reason dropped-connection check, STREAM_MAX_CHARS, the
   empty-completion retry, and pipeline.js's model failover) then works
   unchanged. Anthropic's adapter is `openAiStreamFromAnthropic` +
   `oaiChunksFromEvent` — map the provider's stream events to deltas, a
   finish_reason (map their stop reasons; the pipeline only needs it
   truthy on a clean end), and prompt/completion token usage. A provider
   `error` stream event must ERROR the adapted stream (reader rejects →
   the pipeline's stall/retry path engages). Return non-2xx responses
   AS-IS so callers' `.text()` detail capture works.

   Optionally also `completeJson` (the `{value, usage, diagnostics}`
   contract) so the dispatch stays total — normally unused, because of:

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
   `<PROVIDER>_URL` env override (the BERGET_URL/ANTHROPIC_URL
   convention); auth from a dashboard secret (`<PROVIDER>_API_KEY`,
   never in the repo); connect timeout ~30s on streams, ~45s on JSON
   calls (unbounded fetches have bitten this project — berget.js round-2
   note); message conversion if the provider isn't OpenAI-shaped
   (Anthropic: system turns → top-level `system`, image data URLs →
   base64 source blocks, consecutive same-role merged); the SSE adapter.
   **ReadableStream gotcha:** a `pull()` that enqueues nothing is NOT
   re-invoked — loop inside `pull` until you enqueue or the source ends,
   or zero-output events (pings, message_start) deadlock the stream.
2. **Feature gate**: no key → `<provider>Models(env)` returns `[]` — the
   models don't exist, nothing routes, the UI shows nothing (the same
   invisible-without-secret convention as Shodan/Maps).
3. **Dispatch** (`src/providers.js`): add the id-namespace branch to
   `chatCompletion`/`completeJson`/`providerName`, merge the catalog in
   `listChatModels` (keep the degrade path: primary catalog unreachable
   → return the reachable provider's entries rather than nothing).
4. **Types** (`src/types.d.ts`): add the Env secret + URL override.
5. **Per-model behavior**: leave `model-profiles.js` alone at first —
   unknown models get DEFAULT, and overrides require reproduced
   evidence. Model-specific WIRE parameters (e.g. Sonnet 5's
   thinking-off) live in the provider client, not in profiles. See the
   **tune-provider-models** skill for the full tuning pass.
6. **Docs**: CLAUDE.md project paragraph + code-layout table + unit-test
   list; the **integrations** skill's LLM-provider section.

## Validation ladder (all four rungs, in order)

1. **Unit tests** (`src/<provider>.test.js`): payload conversion, the
   adapter composed through the REAL `consumeChatStream` (that's the
   production pairing), catalog gating on the secret, stop-reason
   mapping, the no-finish_reason dropped-connection tell, the error
   event. Run `npm test` and `npm run typecheck`.
2. **Mock-HTTP smoke**: point `<PROVIDER>_URL` at a local `node:http`
   server emitting the provider's real SSE shapes and drive
   `chatCompletion` → `consumeChatStream` end to end (verifies headers,
   payload, stream plumbing over real HTTP).
3. **Live probe** (needs the secret on the Worker + a deploy — see the
   **deploy** and **live-verify** skills): `/api/models` lists the new
   entries; one `/api/chat` run per model with web search off (cheap,
   isolates the completion path); one with an image (vision); check
   Workers Logs for `chat.complete` with sane token totals and the
   usage_events row pricing at the new entries' rates.
4. **Bench A/B** (the **model-eval** + eval-bench harnesses): see
   **tune-provider-models**.

## Known sharp edges (encountered while adding Anthropic)

- **Pricing currency**: provider prices in USD, quotas account in EUR —
  a fixed documented conversion lives next to the price table. Don't
  silently mix currencies; `bergetCost` (quota.js) multiplies whatever
  per-token numbers the catalog entry carries.
- **`finish_reason` is load-bearing**: pipeline.js treats its absence as
  a dropped connection and throws. The adapter must emit it exactly once
  on a clean end, and must NOT invent one when the provider stream dies
  early — that absence is the tell.
- **Thinking/reasoning modes**: a model that spends output tokens on
  hidden reasoning inside `max_tokens`, or sits silent before its first
  text delta, fights the budget planner and the 60s idle guard. Decide
  the wire config explicitly per model (Sonnet 5 = adaptive-by-default →
  explicitly disabled) and leave a revisit note.
- **Error-message wording**: streamOnModel's messages used to hardcode
  "Berget"; they now use `providerName(model)` — keep new provider
  failures attributable in logs and alerts.
