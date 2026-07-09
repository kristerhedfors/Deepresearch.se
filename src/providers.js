// @ts-check
// The LLM-provider dispatch seam. Berget (src/berget.js) is the primary
// provider and always present; SECONDARY_PROVIDERS below registers the
// key-gated additional providers — Anthropic (src/anthropic.js) and OpenAI
// (src/openai.js). Everything downstream of THIS module is
// provider-agnostic: the pipeline, enrichments, validation, quota pricing
// and the UI all consume the merged catalog and the two dispatched calls
// below, and never name a provider.
//
// Routing key: the model id namespace. Anthropic ids are `claude-*`; OpenAI
// ids are bare `gpt-*`; Berget ids are vendor/model paths (`mistralai/…` —
// including the LOOKALIKE `openai/gpt-oss-120b`, whose "openai/" path
// prefix keeps it on Berget). No id ambiguity, no per-request provider
// field to thread around. Adding a provider = one client module + one
// registry entry (see the add-llm-provider skill).
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
import {
  isOpenAiModel,
  openaiChatCompletion,
  openaiCompleteJson,
  openaiModels,
} from "./openai.js";

export { isAnthropicModel, isOpenAiModel };

/**
 * One key-gated secondary provider. `matches` is the id-namespace routing
 * predicate; `models` returns [] without the provider's secret (the
 * invisible-without-key convention); the two call shapes satisfy the same
 * contracts as their Berget counterparts (an OpenAI-style SSE body for
 * chatCompletion, the { value, usage, diagnostics } object for
 * completeJson), so everything downstream works unchanged.
 * @typedef {{
 *   label: string,
 *   matches: (id: unknown) => boolean,
 *   models: (env: import('./types.js').Env) => import('./types.js').ModelCatalogEntry[],
 *   chatCompletion: (env: import('./types.js').Env, messages: import('./types.js').Conversation, opts: { model?: string }) => Promise<any>,
 *   completeJson: (env: import('./types.js').Env, messages: import('./types.js').Conversation, opts: { model?: string, maxTokens?: number }) => Promise<any>,
 * }} SecondaryProvider
 */

/** @type {SecondaryProvider[]} */
const SECONDARY_PROVIDERS = [
  {
    label: "Anthropic",
    matches: isAnthropicModel,
    models: anthropicModels,
    chatCompletion: anthropicChatCompletion,
    completeJson: anthropicCompleteJson,
  },
  {
    label: "OpenAI",
    matches: isOpenAiModel,
    models: openaiModels,
    chatCompletion: openaiChatCompletion,
    completeJson: openaiCompleteJson,
  },
];

/** @param {string | undefined} model */
function providerFor(model) {
  return SECONDARY_PROVIDERS.find((p) => p.matches(model)) || null;
}

// For error messages and logs that used to hardcode "Berget".
/** @param {string | undefined} model */
export function providerName(model) {
  return providerFor(model)?.label || "Berget";
}

// The merged chat-model catalog: Berget's live-fetched list first (it
// carries the default model and the bulk of the dropdown), then the
// key-gated secondary entries. When Berget's catalog fetch fails but a
// secondary provider is configured, degrade to the reachable providers'
// models rather than reporting no catalog at all — model validation and
// pricing then still work for the models that can actually serve.
/**
 * @param {import('./types.js').Env} env
 * @returns {Promise<import('./types.js').ModelCatalogEntry[]>}
 */
export async function listChatModels(env) {
  const secondary = SECONDARY_PROVIDERS.flatMap((p) => p.models(env));
  try {
    const berget = await bergetListModels(env);
    return [...(berget || []), ...secondary];
  } catch (err) {
    if (secondary.length) return secondary;
    throw err;
  }
}

// Streaming chat completion, dispatched by model id. Every provider
// resolves to the same Response-shaped contract (`ok`/`status`/`body`/
// `text()`) with an OpenAI-style SSE body, so berget.js's
// consumeChatStream reads any of them.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string }} [opts]
 */
export function chatCompletion(env, messages, opts = {}) {
  const provider = providerFor(opts.model);
  return provider ? provider.chatCompletion(env, messages, opts) : bergetChatCompletion(env, messages, opts);
}

// Non-streaming JSON completion, dispatched the same way. Same
// { value, usage, diagnostics } contract from every provider.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number }} [opts]
 */
export function completeJson(env, messages, opts = {}) {
  const provider = providerFor(opts.model);
  return provider ? provider.completeJson(env, messages, opts) : bergetCompleteJson(env, messages, opts);
}
