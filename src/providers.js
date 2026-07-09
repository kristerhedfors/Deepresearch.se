// @ts-check
// The LLM-provider dispatch seam. Berget (src/berget.js) is the primary
// provider and always present; Anthropic (src/anthropic.js) is a second,
// key-gated provider. Everything downstream of THIS module is
// provider-agnostic: the pipeline, enrichments, validation, quota pricing
// and the UI all consume the merged catalog and the two dispatched calls
// below, and never name a provider.
//
// Routing key: the model id namespace. Anthropic ids are `claude-*`;
// Berget ids are vendor/model paths (`mistralai/…`). No id ambiguity, no
// per-request provider field to thread around.
//
// The split-model-routing invariant (CLAUDE.md #3) is preserved by
// construction: chat.js's resolveJsonModel picks Berget's DEFAULT_MODEL
// out of the merged catalog exactly as before, so the JSON planning
// phases (triage/gap/validate) run on Berget regardless of which
// provider's model the user chose to answer.

import {
  chatCompletion as bergetChatCompletion,
  completeJson as bergetCompleteJson,
  listModels as bergetListModels,
} from "./berget.js";
import {
  anthropicChatCompletion,
  anthropicCompleteJson,
  anthropicModels,
  isAnthropicModel,
} from "./anthropic.js";

export { isAnthropicModel };

// For error messages and logs that used to hardcode "Berget".
/** @param {string | undefined} model */
export function providerName(model) {
  return isAnthropicModel(model) ? "Anthropic" : "Berget";
}

// The merged chat-model catalog: Berget's live-fetched list first (it
// carries the default model and the bulk of the dropdown), then the
// key-gated Anthropic entries. When Berget's catalog fetch fails but
// Anthropic is configured, degrade to the reachable provider's models
// rather than reporting no catalog at all — model validation and pricing
// then still work for the models that can actually serve.
/**
 * @param {import('./types.js').Env} env
 * @returns {Promise<import('./types.js').ModelCatalogEntry[]>}
 */
export async function listChatModels(env) {
  const anthropic = anthropicModels(env);
  try {
    const berget = await bergetListModels(env);
    return [...(berget || []), ...anthropic];
  } catch (err) {
    if (anthropic.length) return anthropic;
    throw err;
  }
}

// Streaming chat completion, dispatched by model id. Both providers
// resolve to the same Response-shaped contract (`ok`/`status`/`body`/
// `text()`) with an OpenAI-style SSE body, so berget.js's
// consumeChatStream reads either.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string }} [opts]
 */
export function chatCompletion(env, messages, opts = {}) {
  return isAnthropicModel(opts.model)
    ? anthropicChatCompletion(env, messages, opts)
    : bergetChatCompletion(env, messages, opts);
}

// Non-streaming JSON completion, dispatched the same way. Same
// { value, usage, diagnostics } contract from both providers.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number }} [opts]
 */
export function completeJson(env, messages, opts = {}) {
  return isAnthropicModel(opts.model)
    ? anthropicCompleteJson(env, messages, opts)
    : bergetCompleteJson(env, messages, opts);
}
