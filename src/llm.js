// LLM provider router — the single import surface the app uses for chat
// completions and the model catalog. Berget (src/berget.js, the default,
// OpenAI-compatible) and Anthropic (src/anthropic.js, opt-in via the
// ANTHROPIC_API_KEY secret) sit behind it; dispatch is by model id, so call
// sites stay provider-blind. Adding a provider = a new client module that
// speaks this same interface + a routing branch here (see the
// add-llm-provider skill).
//
// The stream-consumption side needs NO routing: every provider's
// chatCompletion returns OpenAI-style SSE (Anthropic's client transcodes its
// native event stream), so berget.js's consumeChatStream — stall guards,
// runaway cap, finish_reason accounting — is the one shared consumer.
//
// Embeddings (embedTexts) deliberately stay Berget-only and are imported
// from berget.js directly: the Vectorize index is dimension-locked to
// Berget's e5 model (see wrangler.toml), so they can never route by model.

import * as anthropic from "./anthropic.js";
import * as berget from "./berget.js";

export { adminDefaultModelValid, consumeChatStream, DEFAULT_MODEL, defaultModel } from "./berget.js";

// Merged catalog: Berget's live-fetched list plus Anthropic's static one
// (empty without the key). Fail-soft on a Berget catalog outage when
// Anthropic can still serve — a one-provider blip must not blank the whole
// dropdown — but keep throwing when no provider has models, preserving
// callers' existing catalog-unreachable handling.
export async function listModels(env) {
  const anthropicModels = anthropic.listAnthropicModels(env);
  try {
    return [...(await berget.listModels(env)), ...anthropicModels];
  } catch (err) {
    if (anthropicModels.length) return anthropicModels;
    throw err;
  }
}

// Streaming completion → Response whose body is OpenAI-style SSE.
export function chatCompletion(env, messages, opts = {}) {
  const model = opts.model || berget.defaultModel(env);
  return anthropic.isAnthropicModel(model)
    ? anthropic.chatCompletion(env, messages, { ...opts, model })
    : berget.chatCompletion(env, messages, opts);
}

// Non-streaming JSON completion → { value, usage, diagnostics }.
export function completeJson(env, messages, opts = {}) {
  const model = opts.model || berget.defaultModel(env);
  return anthropic.isAnthropicModel(model)
    ? anthropic.completeJson(env, messages, { ...opts, model })
    : berget.completeJson(env, messages, opts);
}
