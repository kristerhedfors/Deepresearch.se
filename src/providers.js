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
import {
  hfChatCompletion,
  hfCompleteJson,
  hfExplore,
  hfInferenceConfigured,
  hfInferenceModels,
  isHfModel,
} from "./hf-inference.js";
import { acceptedModels } from "./user-models.js";

export { isAnthropicModel, isOpenAiModel, isHfModel };

/**
 * One key-gated secondary provider. `matches` is the id-namespace routing
 * predicate; `models` returns [] without the provider's secret (the
 * invisible-without-key convention); the two call shapes satisfy the same
 * contracts as their Berget counterparts (an OpenAI-style SSE body for
 * chatCompletion, the { value, usage, diagnostics } object for
 * completeJson), so everything downstream works unchanged.
 *
 * `id` is the stable slug the catalog groups by and the client renders — it is
 * a WIRE name, so it must not change once shipped. `explore` is optional and
 * marks the provider whose catalog is OPEN: a provider that ships a curated
 * list needs none (its models are simply available), while one that fronts a
 * marketplace declares how to browse it. Today Hugging Face is the only one,
 * and src/model-catalog.js is written so it never has to be the last.
 * @typedef {{
 *   id: string,
 *   label: string,
 *   matches: (id: unknown) => boolean,
 *   models: (env: import('./types.js').Env, accepted: import('./user-models.js').AcceptedModel[]) => import('./types.js').ModelCatalogEntry[],
 *   chatCompletion: (env: import('./types.js').Env, messages: import('./types.js').Conversation, opts: { model?: string, maxTokens?: number }) => Promise<any>,
 *   completeJson: (env: import('./types.js').Env, messages: import('./types.js').Conversation, opts: { model?: string, maxTokens?: number }) => Promise<any>,
 *   configured?: (env: import('./types.js').Env) => boolean,
 *   explore?: (env: import('./types.js').Env, log: any) => Promise<any[]>,
 * }} SecondaryProvider
 */

/** @type {SecondaryProvider[]} */
const SECONDARY_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    matches: isAnthropicModel,
    models: anthropicModels,
    chatCompletion: anthropicChatCompletion,
    completeJson: anthropicCompleteJson,
  },
  {
    id: "openai",
    label: "OpenAI",
    matches: isOpenAiModel,
    models: openaiModels,
    chatCompletion: openaiChatCompletion,
    completeJson: openaiCompleteJson,
  },
  {
    // The one provider whose menu is PER ACCOUNT. Every other entry lists a
    // curated set the repo chose; Hugging Face's router serves an open catalog,
    // so a model appears here only after this account browsed it in the Hugging
    // Face agent, saw the price, and accepted it (src/user-models.js). The
    // second `models` argument is that accepted list — [] for every caller that
    // doesn't pass an identity, which is why an anonymous or unaware caller
    // simply sees the catalog it always saw.
    id: "huggingface",
    label: "Hugging Face",
    matches: isHfModel,
    models: hfInferenceModels,
    chatCompletion: hfChatCompletion,
    completeJson: hfCompleteJson,
    configured: hfInferenceConfigured,
    explore: hfExplore,
  },
];

/** Every registered provider, Berget first — the shape src/model-catalog.js
 * iterates so the Models agent can describe the whole landscape without naming
 * a provider. Berget is synthesised here rather than being a registry entry,
 * because it is the one provider that is always present and carries the
 * catalog default (see listChatModels below).
 * @returns {Array<{ id: string, label: string, open: boolean }>} */
export function providerDescriptors() {
  return [
    { id: "berget", label: "Berget", open: false },
    ...SECONDARY_PROVIDERS.map((p) => ({ id: p.id, label: p.label, open: typeof p.explore === "function" })),
  ];
}

/** The provider slug serving a model id — the catalog's grouping key. Berget
 * for anything no secondary provider claims, exactly as providerName reports.
 * @param {string | undefined} model
 * @returns {string} */
export function providerIdFor(model) {
  return providerFor(model)?.id || "berget";
}

/** Whether a provider's backing secret is configured on this deployment.
 * @param {import('./types.js').Env} env
 * @param {string} providerId
 * @returns {boolean} */
export function providerConfigured(env, providerId) {
  if (providerId === "berget") return !!(/** @type {any} */ (env).BERGET_API_TOKEN);
  const p = SECONDARY_PROVIDERS.find((x) => x.id === providerId);
  if (!p) return false;
  return p.configured ? p.configured(env) : p.models(env, []).length > 0;
}

/** Browse an OPEN provider's catalog. [] for a provider that ships a curated
 * list (nothing to browse) or one that isn't configured — never a throw, so a
 * dead marketplace costs the Models agent a lane, not the request.
 * @param {import('./types.js').Env} env
 * @param {any} log
 * @param {string} providerId
 * @returns {Promise<any[]>} */
export async function exploreProvider(env, log, providerId) {
  const p = SECONDARY_PROVIDERS.find((x) => x.id === providerId);
  if (!p?.explore) return [];
  try {
    return await p.explore(env, log);
  } catch {
    return [];
  }
}

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
 * @param {import('./settings.js').Identity | null} [identity] the signed-in
 *   account, when the caller has one: its accepted Hugging Face models join the
 *   catalog (src/user-models.js). Omitted → the shared catalog, unchanged.
 * @returns {Promise<import('./types.js').ModelCatalogEntry[]>}
 */
export async function listChatModels(env, identity) {
  return listChatModelsWith(env, identity ? acceptedModels(identity) : []);
}

/**
 * The same merged catalog from an ALREADY-RESOLVED enabled list. The seam
 * exists so a caller that has the account's models in hand — the Models agent's
 * enrichment, which runs inside the pipeline and deliberately holds no identity
 * — does not have to reconstruct one to ask for a catalog.
 * @param {import('./types.js').Env} env
 * @param {import('./user-models.js').AcceptedModel[]} accepted
 * @returns {Promise<import('./types.js').ModelCatalogEntry[]>}
 */
export async function listChatModelsWith(env, accepted) {
  const secondary = SECONDARY_PROVIDERS.flatMap((p) => p.models(env, accepted || []));
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
 * @param {{ model?: string, maxTokens?: number }} [opts] maxTokens: the report-tier answer cap (budget.js synthMaxTokens)
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
