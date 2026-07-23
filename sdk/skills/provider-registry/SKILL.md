---
name: provider-registry
description: >-
  Load when building a platform's LLM provider plane — the
  namespace-dispatched multi-provider registry on the server tier, the
  CORS-capable browser-direct registry (including the keyless local-server
  provider) on the client tier, a new provider client (foreign-wire SSE
  adapter or native-wire params-only), the merged model catalog with
  pricing, key-gated availability, or the hardened stream-consumption loop
  (connect retries, idle/total guards, finish_reason detection,
  reliable-model failover). Also load when a provider's models don't
  appear in a dropdown, streams hang or truncate silently, or a model
  answers correctly on one tier and fails on the other.
---

# Provider registry and stream consumption

One dispatch seam per tier through which every model call flows, so that
everything downstream — the pipeline, enrichments, validation, pricing, the
model dropdown — is provider-agnostic: it consumes a merged catalog and two
dispatched calls (`chatCompletion` streaming, `completeJson` non-streaming)
and never names a provider. The module's second half is the hardened stream
loop: the reference product's entire early bug history is silent stream
failure (hung fetches, missing finish_reason, runaway generations, empty
completions), and this is the one place those defenses live.

## Capability class & tier story

Class **X** (shared substrate) — but of an unusual kind: both tiers carry a
*registry with the same discipline* rather than one literal shared core,
because the admission bar differs per tier and that difference is
load-bearing:

- **Server tier**: a primary provider (always present, live-fetched catalog,
  serves the fixed JSON planning model) plus key-gated secondary providers
  in a registry, dispatched by **model-id namespace**. Secrets are server
  secrets; the server pays and meters.
- **Client tier**: a browser-direct registry whose admission ticket is
  **CORS**. The rule, stated once and enforced forever: *a provider joins
  the client tier ONLY if it is callable browser-direct (serves CORS on its
  completions/models endpoints) with the user's own key.* A provider
  without CORS would need a proxy — which is exactly what the client tier
  exists to avoid. The registry also carries the **keyless local provider**
  (the user's own OpenAI-compatible server), the tier's strongest privacy
  mode: no third party receives the conversation at all.

Both registries are import-safe pure modules (Node-testable over mock HTTP
per PA-7's spirit); wire knowledge learned on one tier (parameter quirks,
catalog curation regexes) is mirrored into the other deliberately, with a
comment naming the sibling.

## Contracts

- **PA-1** — provider clients expose plain streamed/JSON completions only,
  whatever else the vendor API offers; no tool-calling surface enters the
  dispatch contract.
- **PA-2** — the stream loop converts every known hang/truncation mode into
  a caught, retryable, or honestly-surfaced error (timeouts, idle guards,
  finish_reason check), so callers' fail-soft paths can actually engage.
- **PA-3** — split routing holds *by construction*: the merged catalog
  always contains the fixed reliable JSON model, and the JSON-model
  resolver picks it regardless of the user's answer model; client entries
  carry a per-provider fixed cheap `jsonModel` for the same reason.
- **PA-5** — raw `fetch`, no vendor SDKs, no build step; every wire
  parameter pin traces to the provider's current API reference or a
  reproduced failure.
- **PA-10** — every provider lands through the four-rung ladder: unit tests
  → in-suite mock-HTTP smoke → live probe on the deployment → bench A/B.

## Build plan

1. **Server primary client** (`src/<primary>.js`): `apiBase` with a
   test-only `<PROVIDER>_URL` env override; auth from a dashboard secret;
   `chatCompletion(env, messages, {model, maxTokens})` returning a
   Response-shaped `{ok, status, body, text()}` with an OpenAI-style SSE
   body; `completeJson(env, messages, {model, maxTokens})` returning
   `{value, usage, diagnostics}`; `listModels(env)` (live catalog, cached
   ~5 min per isolate, entries carrying `up`/`vision`/pricing). Bound the
   JSON call's WHOLE fetch (~45 s) and the stream call's
   time-to-first-response only (~30 s, timer cleared once fetch settles)
   so a long legitimate stream can still be read.
2. **The stream consumer** (same module): `consumeChatStream(body, onText,
   {idleMs, maxMs, maxChars})` — parse SSE deltas, accumulate text and the
   usage chunk, record `finish_reason` from the last chunk, enforce a
   runaway-generation char cap (default ~32 k; caller-overridable so raised
   report-tier max_tokens gets matching headroom), and opt-in inter-chunk
   idle and total-duration guards. Export it — every provider's stream is
   consumed HERE.
3. **Catalog contract** (shared types): `id`, `name`, `pricing` (human
   tooltip, built with one shared formatter), `price_in`/`price_out` in
   ONE accounting currency per token (convert foreign currency through one
   documented fixed rate exported from the primary client), `up`,
   `vision`, `provider`. Static lists are fine for secondary providers
   whose models API carries no pricing — a live fetch there adds a failure
   mode without information.
4. **The registry** (`src/providers.js`): `SECONDARY_PROVIDERS` — one entry
   per provider carrying `label`, `matches` (the model-id namespace
   predicate), `models(env)` (returns `[]` without the provider's secret —
   the invisible-without-key convention), `chatCompletion`, `completeJson`.
   `providerFor(model)` finds the entry or falls back to the primary;
   `listChatModels(env)` merges primary-first, and when the primary catalog
   fetch fails but a secondary is configured, degrades to the reachable
   providers' entries rather than reporting no catalog. Export
   `providerName(model)` for error messages/logs.
5. **Adapter pattern A — foreign wire** (a provider with its own message
   shape and SSE vocabulary): convert the payload (system turns → the
   provider's system field, image data URLs → its source blocks,
   consecutive same-role merged) and write an SSE adapter that re-emits the
   provider's stream events as OpenAI-style SSE — deltas, a mapped
   `finish_reason` exactly once on clean end, a usage chunk, `[DONE]`. A
   provider `error` event must ERROR the adapted stream. This is the
   load-bearing trick: **adapt at the wire, don't fork the pipeline** —
   the shared consumer and all its guards then work unchanged.
6. **Adapter pattern B — native wire** (an already-OpenAI-shaped provider):
   return the raw fetch Response; pin only the wire PARAMETERS in a pure
   payload builder (current-generation token cap param, explicit
   reasoning/thinking OFF, the streaming-usage opt-in flag). Diff against
   the provider's CURRENT API reference, not against your primary client.
7. **The hardened answer loop** (`src/answer-stream.js`):
   `streamOnModel(ctx, messages, model, profile, totals)` — the per-model
   attempt loop: connect-phase failures retried when transient (status
   ≥500/429/408 or no body; a deterministic 4xx fails fast), the idle
   guard (~60 s inter-chunk silence) on consumption, an early stall
   (<~400 chars delivered) → emit `discard_text` and retry, a missing
   `finish_reason` after clean EOF → throw (the dropped-connection tell),
   a clean-but-empty completion → retry up to the profile's
   `maxCompletionAttempts`. Usage lands in the CALLER's totals bucket
   (split billing). On top: `streamCompletion(ctx, messages)` — the user's
   model gets its full retry budget; if it never delivered a visible byte,
   fail over ONCE to the fixed reliable JSON model, announced as a visible
   step, billed to that model's bucket, still raising the operational
   alert. Plus `emitChunked` (re-emit already-complete text as ~80-char
   deltas through the same path).
8. **Client registry** (`public/js/<pair>-providers.js`): one declarative
   entry per CORS-capable provider — `id`, `label`, `base`, `keyPattern`
   (key-prefix auto-detection for the one-field key form — see **Key-prefix
   detection** below for the collision table and the most-specific-prefix
   rule), `jsonModel`
   (the fixed cheap planning model — the client-side mirror of PA-3),
   `fallbackModels` (static list shown until/instead of a live `/models`
   fetch), `modelFilter` (curation: current generation only, non-chat
   modalities excluded), `params(maxTokens)` (the tier's wire quirks,
   mirrored from the server clients), optional `embed` (`{model,
   dimensions}`). Add the **keyless local entry**: `keyless: true`,
   "configured" means a base URL is set, NO Authorization header on the
   wire ("Bearer undefined" 401s some servers), `jsonModel: null` so the
   planning phases fall back honestly onto the user's chosen model, no
   static catalog. Provide `detectDrcProvider(key)`,
   `configuredDrcProviders(keys, {localBaseUrl})`, `listDrcModels` (live
   `/models` filtered+sorted, static fallback on failure), `drcEmbed`
   (browser-direct embeddings, results re-sorted by `index`, count
   verified), `buildDrcPayload` (JSON mode via `response_format:
   json_object` — every admitted provider must support it), and a
   streaming call with its own idle guard.
9. **Validate per the ladder**: unit tests composing each provider's stream
   through the REAL shared consumer (for native-wire providers that
   asserts the no-adapter assumption itself); an in-suite `node:http`
   mock-HTTP smoke driving `chatCompletion` → consumer end to end; a live
   probe after deploy (`/api/models` lists the entries; one cheap chat run
   per model; one vision run; token totals priced at the new rates); then
   the bench A/B.

## Key-prefix detection (the one-field key form)

Every one-field key UX — the reference client tier's key panel and any
distilled flavour of it — auto-detects the provider from the pasted key's
prefix. Two rules make it safe, both learned from a live misdetection
(feedback #6, 2026-07-23: an Anthropic key routed to OpenAI's wire, which
401s):

1. **The most specific prefix owns the key.** Prefixes NEST: `sk-ant-…`
   (Anthropic) is inside `sk-…` (OpenAI). Write each pattern to exclude its
   more specific siblings (`/^sk-(?!ant-)/` for OpenAI) so the patterns are
   mutually exclusive by construction and no registry ordering can decide a
   match. Pin that with a unit test asserting `sk-ant-…` has ZERO claimants.
2. **Never claim a key you can't serve.** A recognized shape whose provider
   is not in the registry detects as null plus an honest hint ("that's an
   Anthropic key — not supported here yet"), not as the nearest lookalike.
   A key routed to the wrong wire fails downstream with an opaque 401; the
   hint fails upfront with the reason.

The prefix table (mirror of the reference's `FOREIGN_KEY_SHAPES` +
`keyPattern` facts, and of its secret-scanner's shapes):

| Prefix | Provider | In the reference client registry? |
|---|---|---|
| `sk-ant-` | Anthropic | No (wire adapter needed — see below) |
| `sk_ber_` | Berget (underscore) | Yes |
| `gsk_` | Groq | Yes |
| `sk-` minus `sk-ant-` (incl. `sk-proj-`, `sk-svcacct-`) | OpenAI | Yes |
| `hf_` | Hugging Face token (not a chat key here) | No |

## Anthropic browser-direct (single-shot recipe)

Anthropic's API DOES serve browser CORS — re-probed live 2026-07-23
(`Access-Control-Allow-Origin: *`; earlier notes claiming no CORS are
stale) — gated on an explicit opt-in header acknowledging the key is
exposed in a browser. What keeps it out of the reference client registry
is only the WIRE: the Messages API is not OpenAI chat completions, so an
entry needs a client-side foreign-wire adapter (the browser mirror of
`src/anthropic.js`). A distilled flavour that wants Anthropic keys to work
first-shot wires it like this:

- **Endpoint**: `POST https://api.anthropic.com/v1/messages` (no
  `/chat/completions`).
- **Headers**: `x-api-key: <key>` (NOT `Authorization: Bearer`),
  `anthropic-version: 2023-06-01`, `content-type: application/json`, and
  `anthropic-dangerous-direct-browser-access: true` (mandatory for browser
  calls — without it the request is rejected).
- **Payload**: `{model, max_tokens (REQUIRED), messages, stream: true}`;
  system prompts go in a top-level `system` field, never as a
  `role: "system"` message; consecutive same-role turns must be merged.
- **SSE shape**: event-typed frames, not OpenAI deltas — text arrives in
  `content_block_delta` events (`delta.text`), the stop reason in
  `message_delta` (`delta.stop_reason`, e.g. `end_turn` ↔ `stop`), usage in
  `message_start`/`message_delta`, and an `error` event must error the
  stream. Adapt at the wire per pattern A above so the shared consumer
  stays unchanged.
- **Models**: the set the reference server client serves is the safe
  catalog to mirror (`src/anthropic.js`: `claude-opus-4-8`,
  `claude-sonnet-5`, `claude-haiku-4-5`), with its wire pins (thinking
  explicitly disabled where the model reasons by default).

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Server dispatch registry, merged catalog, degrade path | `src/providers.js` |
| Primary client + `consumeChatStream` + `STREAM_MAX_CHARS` + currency rate | `src/berget.js` |
| Foreign-wire adapter (Messages API → OpenAI SSE) | `src/anthropic.js` (`openAiStreamFromAnthropic`) |
| Native-wire params-only client | `src/openai.js` (`toOpenAiPayload`) |
| Hardened answer loop, failover, `emitChunked`, transient-status predicate | `src/answer-stream.js` |
| Client CORS registry, keyless local, key detection, embeddings, JSON mode | `public/js/drc-providers.js` |
| Model dropdown consuming the merged catalog | `public/js/models.js`, `src/user-api.js` (`/api/models`) |
| Per-model retry/JSON overrides consulted by the loop | `src/model-profiles.js` |
| Validation-ladder worked examples | `src/anthropic.test.js`, `src/openai.test.js` ("over mock HTTP"), `.claude/skills/add-llm-provider` |

## Acceptance checklist

- [ ] Unit: payload conversion per provider; stream composed through the
      REAL shared consumer; catalog gating on the secret (no key → `[]`);
      stop-reason mapping; the no-finish_reason tell throws; a provider
      error event errors the adapted stream.
- [ ] Unit: registry routing predicates (bare-prefix only), catalog merge,
      primary-unreachable degrade path.
- [ ] Unit (client): wire quirks per entry, JSON-mode payloads, lenient
      JSON extraction, model filter + newest-first sort, live-vs-fallback
      catalog over mock HTTP, key-prefix detection, keyless-local
      configuration + no-auth-header, embed wire shape + index re-ordering.
- [ ] Mock-HTTP smoke IN the unit suite (`node:http` emitting the
      provider's real SSE shapes) so it reruns on every test run.
- [ ] Live probe per key-gated provider: models listed, one chat run, one
      vision run, usage priced at catalog rates in the logs.
- [ ] Invariant pins: the fixed JSON model resolvable from the merged
      catalog whatever the user model; failover bills the fallback model's
      bucket; idle/total guards and char cap engaged on the answer path.

## Pitfalls

- **Unbounded fetches are the original sin.** The reference's round-2 eval
  battery found requests dying silently mid-pipeline — several phases
  logged, then nothing, completion log never fired: an awaited `fetch()`
  that never settles. Neither primary-client call had ANY timeout. Bound
  JSON calls whole (~45 s) and stream calls to first-response (~30 s).
- **`finish_reason` is load-bearing.** A dropped upstream connection can
  present as a clean EOF; a complete OpenAI-style stream always sets
  `finish_reason` on its last chunk. Throw when it's absent — and never
  invent one in an adapter when the provider stream dies early: that
  absence IS the tell.
- **ReadableStream `pull()` deadlock** (adapter pattern A): a `pull()` that
  enqueues nothing is NOT re-invoked — loop inside `pull` until you enqueue
  or the source ends, or zero-output events (pings, message_start) hang
  the stream forever.
- **"OpenAI-compatible" still differs in params.** Current-generation
  models have rejected the legacy `max_tokens` (→ `max_completion_tokens`),
  omit the streaming usage chunk unless `stream_options.include_usage` is
  set, and reason by default. Diff against the vendor's current reference.
- **Thinking/reasoning modes fight the budget planner and the idle guard**:
  hidden token spend inside the max-tokens cap plus a silent pre-answer
  pause. Decide the wire config explicitly per model (reference: Sonnet 5
  `thinking: {type:"disabled"}`; GPT-5-era `reasoning_effort: "none"`) and
  leave a bench-A/B revisit note.
- **Currency mixing**: vendors price in USD, the quota system accounts in
  EUR — one documented fixed rate (`USD_TO_EUR` / `eurPerTokenFromUsd` in
  berget.js), shared by every USD-priced catalog. Never silently mix.
- **Namespace lookalikes**: Berget hosts `openai/gpt-oss-120b` — a
  vendor-PATH id that must stay on the primary. Match bare prefixes only
  (`id.startsWith("gpt-")`), never substrings; grep the live primary
  catalog for collisions before choosing a namespace.
- **Empty completions are real**: streams that finish cleanly with zero
  content, transient per run (round-4 finding). Retry cheaply
  (`maxCompletionAttempts`, default 2, raised only on evidence).
- **The char cap is partial insurance**: `STREAM_MAX_CHARS` bounds a
  runaway generation, but the reference's exceededCpu deaths were
  cumulative across a request — the real fix was platform-level (CPU
  limit raise). Keep the valve anyway.
- **CORS status is empirical and dated**: Berget's browser CORS was
  probed live 2026-07-11 (origin-reflecting, POST+Authorization) — it
  previously had none; Anthropic's was absent once, then present on a
  2026-07-23 re-probe (behind the dangerous-direct-browser-access opt-in —
  see the recipe above), which is the cautionary tale itself: re-probe
  before admitting, relying on, or ruling out a provider.
- **Body-size ceilings**: the reference's primary rejects bodies over
  ~1 MB (measured), which is why the client downscales images and strips
  them from history resends. Probe the limit; don't discover it in prod.
- **Groq serves no `/embeddings` endpoint** — a client-tier session on
  that provider alone runs without RAG; the embed entry is per-provider
  and its absence must degrade fail-soft, never error a send.
- **Error wording**: use `providerName(model)` in every failure message —
  hardcoding the primary's name makes multi-provider incidents
  unattributable in logs and alerts.
