---
name: add-llm-provider
description: >-
  Load when adding a NEW LLM provider (an alternative to Berget for
  answering/planning — "enable OpenAI/Anthropic/X as a provider", "add model Y
  to the dropdown"), when changing provider routing (src/llm.js), or when
  debugging why a non-Berget model misbehaves in the pipeline. The playbook:
  the provider-client contract, the OpenAI-SSE transcoding trick, catalog and
  pricing wiring, routing, secrets, and the validation protocol. Anthropic
  (src/anthropic.js) is the worked example.
---

# Adding an LLM provider

How the multi-provider layer works and the end-to-end recipe for adding a
provider, established when Anthropic (Claude Opus 4.8 / Sonnet 5 / Haiku 4.5)
was added alongside Berget (2026-07-09).

## Architecture (read this first)

```
pipeline.js / enrichment.js / chat.js / user-api.js / quiz-api.js / mcp.js
        │  import { chatCompletion, completeJson, listModels, … }
        ▼
   src/llm.js  ← the ROUTER: dispatches by model id, merges catalogs
        │
        ├── src/berget.js     (default provider, OpenAI-compatible)
        └── src/anthropic.js  (opt-in via ANTHROPIC_API_KEY)
```

**Nothing outside `llm.js` knows providers exist.** Call sites import from
`./llm.js` and pass a model id; the router picks the client. Do NOT import
`berget.js` directly from feature code for chat/catalog calls — the two
deliberate exceptions are embeddings (`embedTexts`/`rawModelEntry` in
`rag.js`, dimension-locked to Berget's e5 model and the Vectorize index) and
`consumeChatStream`, which `llm.js` re-exports from `berget.js`.

### The load-bearing trick: providers adapt to the OpenAI wire shape

The entire downstream machinery — `consumeChatStream`'s stall guards
(`idleMs`/`maxMs`), the `STREAM_MAX_CHARS` runaway cap, pipeline.js's
"stream ended without a finish_reason" dropped-connection check, the usage
accounting — parses **OpenAI-style SSE**. A new provider does not get its own
consumer; its client **transcodes its native stream into OpenAI chunk lines**
(a `TransformStream` inside the client) and returns a normal `Response`.
See `anthropicToOpenAiSse()` in `src/anthropic.js`: Anthropic's
`message_start`/`content_block_delta`/`message_delta`/`message_stop` events
become `data: {"choices":[{"delta":{"content":…}}]}` lines, with usage and a
mapped `finish_reason` emitted on the final chunk and `data: [DONE]` at the
end. This is why zero pipeline changes were needed.

## The provider-client contract

A provider module (`src/<provider>.js`) must export:

| Export | Contract |
|---|---|
| `is<Provider>Model(id)` | Exact-set membership over the provider's catalog ids — routing key. Never prefix-match loosely. |
| `list<Provider>Models(env)` | `ModelCatalogEntry[]` (src/types.d.ts): `{id, name, pricing, price_in, price_out, up, vision}`. **`name` is provider-branded: `"<Provider> <flag emoji> <model>"`** (e.g. `Berget.ai 🇸🇪 Mistral Small`, `Anthropic 🇺🇸 Claude Opus 4.8`) — the dropdown and error messages render it verbatim, so the prefix is how users see which provider serves a model. **`price_in`/`price_out` are EUR per token** (quota budgets are EUR — src/quota.js `bergetCost`). Return `[]` when the provider's secret is unset: catalog membership is the availability gate (resolveModel rejects unknown ids), so a missing key makes the provider invisible with no other code. |
| `chatCompletion(env, messages, {model})` | OpenAI-shaped messages in (roles `user`/`assistant`/`system`, content string or `[{type:"text"|"image_url"}]` parts) → `Response` whose body is OpenAI-style SSE. Non-2xx responses pass through **untransformed** so callers' `.text()` sees the provider's error body. Connect must be time-bounded (~30s abort) — invariant #2, a hung fetch defeats fail-soft. |
| `completeJson(env, messages, {model, maxTokens})` | `{ value, usage: {prompt_tokens, completion_tokens}, diagnostics: {parse_mode, finish_reason, content_length} }`, `value: null` on parse failure. Reuse `parseLooseJson` (exported from berget.js) so JSON recovery is identical everywhere. Time-bounded (~45s). |

Message-shape conversion is the provider's job (pure + unit-tested). For
Anthropic that meant: hoist `system` messages into the top-level `system`
param, convert `data:image/…;base64,` URLs into base64 image source blocks,
merge consecutive same-role messages (strict alternation), drop empty text
blocks (rejected by the API).

## Steps to add a provider

1. **Client module** `src/<provider>.js` implementing the contract above.
   Static catalog with hardcoded pricing is fine (and preferred over a live
   fetch when the provider's models API carries no pricing) — curate a small
   set of current models. Non-EUR pricing: convert with a named constant and
   document the rounding direction (Anthropic uses `USD_TO_EUR = 1.0`, a
   deliberate over-count so quotas trip early rather than under-bill).
   Add a `<PROVIDER>_URL` env override defaulting to the real API base, like
   `BERGET_URL`/`ANTHROPIC_URL`, so tests can point at a mock.
2. **Router branch** in `src/llm.js`: append the catalog in `listModels`
   (Berget first — keeps dropdown order and the default on top; fail-soft so
   one provider's catalog outage doesn't blank the other's models) and add
   the `is<Provider>Model` branch to `chatCompletion`/`completeJson`.
3. **Types + config**: `ANTHROPIC_API_KEY`-style entries in `src/types.d.ts`
   Env, and the secret named in wrangler.toml's secrets comment (secrets are
   set in the Cloudflare dashboard, never in the file).
4. **Nothing else.** Validation (`resolveModel`), the UI dropdown
   (`/api/models` → public/js/models.js), vision-helper selection, split
   billing (`summarizeSpend` prices each bucket at its catalog rate), quota
   accounting, and MCP all consume the merged catalog with no provider
   awareness. If you find yourself editing pipeline.js, stop — the
   abstraction is being broken.
5. **Model quirks stay evidence-driven**: no `model-profiles.js` entries for
   the new models until a reproduced finding demands one (invariant #5).
   Same for `budget.js` — unknown models get default EWMA priors and learn.

## Provider-specific facts (Anthropic)

- Native Messages API (`POST /v1/messages`), headers `x-api-key` +
  `anthropic-version: 2023-06-01`. NOT OpenAI-compatible — hence the
  transcoder.
- Models offered: `claude-opus-4-8` ($5/$25 per MTok), `claude-sonnet-5`
  ($3/$15), `claude-haiku-4-5` ($1/$5). All vision-capable. Model ids and
  prices from the bundled **claude-api** skill — consult it (not memory)
  before touching ids/pricing/API parameters.
- **Do not send `temperature`/`top_p`/`top_k`** — removed on Opus 4.8 and
  Sonnet 5 (400). We never sent them; keep it that way.
- Sonnet 5 runs **adaptive thinking by default**; thinking spends from the
  same `max_tokens` as the visible answer. Streaming path: thinking left on
  (quality), `max_tokens` 8192 (vs Berget's 4096) for headroom, thinking
  deltas dropped by the transcoder. `completeJson` sends
  `thinking: {type:"disabled"}` (accepted on all three models) so the small
  maxTokens JSON budgets can't be eaten by thinking.
- No generic `response_format: json_object` — the prompts' JSON-only
  instructions + `parseLooseJson` carry JSON mode (structured outputs would
  need per-call schemas this layer doesn't have).
- `stop_reason` mapping: `end_turn`→`stop`, `max_tokens`→`length`,
  `stop_sequence`→`stop`, `tool_use`→`tool_calls`, anything else passes
  through (pipeline only needs truthiness).
- Split model routing (invariant #3) is untouched: triage/gap/validation
  stay on Berget's Mistral Small; an Anthropic model is only the
  synthesis/direct/vision-describe model — unless Mistral is down and
  `resolveJsonModel` falls back to the user's model, which is why
  `completeJson` must work on every provider.

## Validation protocol

1. **Unit tests** (`src/<provider>.test.js` + `src/llm.test.js`): message
   conversion, catalog shape/pricing math, routing (stub `globalThis.fetch`),
   and the transcoder verified **through `consumeChatStream`** — including
   the no-finish_reason dropped-stream tell and the error-event rejection.
2. **Live probes** after the secret is set (see the **live-verify** skill):
   `/api/models` lists the new models; one `/api/chat` run per model with
   web search off (cheap, isolates the provider) checking streamed text,
   `done` stats tokens > 0, and a `usage_events` row with nonzero
   `berget_cost`; one vision probe with an attached image; one run with
   search on for the full pipeline.
3. **Bench A/B** only if the provider is meant to change answer quality —
   `npm run eval:bench` before/after, ledger appended (see **model-eval**).
