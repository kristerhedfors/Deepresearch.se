---
name: hf-agent
description: >
  Load when working on the HUGGING FACE AGENT — the chat mode whose model
  catalog is OPEN — or on anything it is built from: src/hf-inference.js (the
  `hf:` provider over the router at router.huggingface.co, the catalog fetch,
  the cost normalization, the MODEL ALLOWANCE), src/hf-agent.js (the mode's
  enrichment: forced Hub search + the EN/SV model-shopping gate + the priced
  catalog block + the `hf_models` SSE event), src/hf-api.js (`/api/hf/models`
  browse/accept/remove), src/user-models.js (the accepted-model store in
  `users.settings_json`), or the client shelf public/js/hf-models.js +
  hf-models-core.js. ALSO load when asked to "let users pick any Hugging Face
  model", "show what a model costs before running it", "make a model from one
  mode available in the others", "raise the model allowance", or when debugging
  why an enabled model does not appear in the dropdown / is billed at zero.
  Distinct from the **integrations** skill's src/hf.js, which is Hub SEARCH
  (models/datasets/papers as citable sources), not inference.
---

# The Hugging Face agent

The sixth chat mode (`hf`, amber). Every other agent answers on a model
somebody at this site put in the dropdown; this one hands the user the whole
Hugging Face router catalog, with the price on the tag.

## The shape, in one paragraph

It is **not a new executor.** Its answer phase is the ordinary `research` one,
so a sixth mode needed no row in `src/pipeline.js` `ANSWER_PHASE_RUNNERS`. What
it adds is one pre-pipeline enrichment (`src/hf-agent.js`, registered in
`src/enrichment.js` `CORE_ENRICHMENTS`) that does two things: forces Hub search
on for every turn via the generic `state.forceAux` seam, and — when the message
is about choosing, pricing or starting a model — folds the live priced catalog
into the conversation and emits `hf_models` for the UI.

## The two Hugging Face modules, and why they are separate

| | `src/hf.js` | `src/hf-inference.js` |
|---|---|---|
| Answers | "what exists, and who says what about it" | "run it" |
| Wired as | a SEARCH SOURCE (`src/search-sources.js`) | an LLM PROVIDER (`src/providers.js`) |
| Token | `HUGGINGFACE_API_TOKEN` optional (rate-limit headroom) | **required** — inference is billed |
| Endpoint | `huggingface.co/api/{models,datasets,papers}` | `router.huggingface.co/v1` |

Do not merge them. One is research material, the other is spend.

## The promotion pipeline (the feature's point)

```
browse  GET  /api/hf/models?q=…      ranked rows + cost + allowance verdict
accept  POST /api/hf/models          {hfId, provider?}  → users.settings_json.hf_models
                                     ↓
        listChatModels(env, identity) merges the account's accepted entries
                                     ↓
        GET /api/models → the #model dropdown, in EVERY chat mode
```

`listChatModels` takes an **optional identity** precisely for this: Hugging
Face is the one provider whose menu is per-account. A caller that passes no
identity (`src/bash-api.js`) simply sees the shared catalog, unchanged.

## Rules that are load-bearing

1. **Never invent a number.** A model with no published price is shown but is
   never enableable — an unknown rate cannot be budgeted, and an entry with no
   rate would bill every request using it at **zero**. `acceptedFromBrowseItem`
   returns null for it; the API answers 400.
2. **Acceptance is re-validated server-side** against the LIVE catalog, never
   against the client's numbers. The browse row the UI showed is a rendering of
   the same data; re-deriving it in `handleHfModelAccept` is what stops a
   hand-rolled request from enabling an over-allowance model.
3. **Stored entries are price SNAPSHOTS, deliberately.** Billing must not
   depend on a third-party fetch, and the price the user agreed to is the price
   they keep. The staleness is real; `hfRefreshNotes` surfaces it in the shelf
   rather than hiding it. Re-accepting is how you take a new price.
4. **The `hf:` prefix is required, not cosmetic.** HF ids are bare
   `owner/model` paths — exactly Berget's id shape — so an unprefixed id would
   route to Berget. On the wire the prefix is stripped and a pinned provider
   becomes the router's `owner/model:provider` form.
5. **Invariant 3 still holds.** The JSON planning phases stay on Berget's
   `DEFAULT_MODEL`. `hfCompleteJson` exists so the dispatch is total, not
   because an open-catalog model should ever plan a research turn.
6. **Invariant 6.** `hfModelIntent` takes Swedish with the same breadth as
   English; the parity suite in `src/hf-agent.test.js` is the enforcement.
   Widen both languages in the same change or the suite fails.

## The allowance ("start here, extend later")

`config.js` → `hf: { max_output_usd, max_accepted }`, read by `hfAllowance`.
Raising these IS how an account's allowance is extended — no code change. The
structural ceiling above any allowance is `user-models.js` `MAX_STORED` (24): a
settings_json row is not a database table.

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
node --test src/hf-inference.test.js src/hf-agent.test.js src/user-models.test.js \
            public/js/hf-models-core.test.js
npm test && npm run typecheck
```

Live, once deployed: pick **Hugging Face** in the mode dropdown, press 🤗, and
check that (a) rows carry a rate AND a per-turn estimate, (b) Enable makes the
model appear in the `#model` dropdown under "🤗 Hugging Face — enabled by you"
**without a reload**, (c) switching to Deep Research keeps it selectable, and
(d) a turn answered on it lands in `chat_logs` with a non-zero `berget_cost`
(the **chat-logs** skill). (d) is the one that catches a broken price snapshot.
