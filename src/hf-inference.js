// @ts-check
// Hugging Face INFERENCE — the fourth LLM provider, and the only one whose
// catalog is OPEN: Berget, Anthropic and OpenAI each offer a curated handful
// of models this repo picked, while HF's router serves whatever the inference
// providers have live at the moment. That difference is the whole point of the
// Models agent (src/models-agent.js): browse the open catalog, read what a
// model actually COSTS, enable one, and only then does it become a model this
// account can answer with — in the Models agent and, once promoted, in every
// other agent mode too (src/user-models.js).
//
// This module is the INFERENCE half of the Hugging Face integration. The other
// half — searching the Hub for models/datasets/papers as citable research
// sources — is src/hf.js, and the two are deliberately separate: hf.js answers
// "what exists and who says what about it", this one answers "run it".
//
// SCOPE. Everything here is Hugging-Face-specific: the id namespace, the router
// wire, the catalog fetch, and the `explore` hook that translates HF's own
// vocabulary into provider-agnostic rows. Everything CROSS-provider — ranking,
// the lifecycle, the model allowance, the verification checklist — lives one
// layer up in src/model-catalog.js, which names no provider. That cut is what
// makes Hugging Face one marketplace among possible others rather than the
// feature itself.
//
// Wire: the HF router is OpenAI-compatible
// (https://router.huggingface.co/v1/chat/completions), so — like src/openai.js
// and unlike src/anthropic.js — no stream adapter is needed. The response body
// passes straight to berget.js's shared consumeChatStream.
//
// Id namespace: `hf:<owner>/<model>`, optionally `hf:<owner>/<model>@<provider>`
// when the user pinned one of the model's serving providers. The `hf:` prefix
// is what src/providers.js dispatches on, and it is REQUIRED rather than
// cosmetic: HF ids are bare `owner/model` paths, which is exactly Berget's id
// shape (`mistralai/…`), so an unprefixed HF id would be ambiguous. On the wire
// the prefix is stripped and a pinned provider becomes the router's documented
// `owner/model:provider` suffix.
//
// Feature-gated on HUGGINGFACE_API_TOKEN — the SAME secret src/hf.js uses for
// Hub search, where it is optional (it buys rate-limit headroom). Here it is
// mandatory: inference is billed, so without the token no HF model is
// browsable, acceptable, or routable, and the agent says so.
//
// Catalog shape verified live (2026-07-26, GET /v1/models): 129 models, each
// `{ id, owned_by, architecture: { input_modalities[] }, providers: [{ provider,
// status, context_length, pricing: { input, output } /* USD per 1M tokens */,
// is_free, supports_tools, supports_structured_output, first_token_latency_ms,
// throughput }] }`. 21 carried no pricing on any provider, 39 accept image
// input, every provider row read `status: "live"`, and output prices spanned
// $0.03–$6.27 per 1M. Those numbers are why unpriced models are shown but never
// enableable (src/model-catalog.js modelAllowance) — an unknown rate cannot be
// budgeted.

import { eurPerTokenFromUsd, formatPricing, parseLooseJson } from "./berget.js";

/** @typedef {import('./types.js').Env} Env */

// HF_ROUTER_URL exists solely so tests can point at a mock (the same
// convention as BERGET_URL / OPENAI_URL); production always uses the default.
/** @param {Env} env */
const apiBase = (env) => String(/** @type {any} */ (env).HF_ROUTER_URL || "https://router.huggingface.co/v1");
/** @param {Env} env */
const chatUrl = (env) => apiBase(env) + "/chat/completions";
/** @param {Env} env */
const modelsUrl = (env) => apiBase(env) + "/models";

// Same timeout discipline as every other provider client here: an unbounded
// fetch to a third-party backend has bitten this project before.
const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const JSON_CALL_TIMEOUT_MS = 45_000;
const CATALOG_TIMEOUT_MS = 8_000;

// Matches berget.js/openai.js chatCompletion max_tokens — the synthesis cap.
const MAX_TOKENS = 4096;

/** The id-namespace prefix. */
export const HF_PREFIX = "hf:";

// The illustrative turn every model's price is expressed against, so two models
// from two providers are compared on one number rather than on two pricing
// pages. Deliberately ONE documented pair rather than a per-model guess: a
// deep-research synthesis prompt carries the source block plus the conversation
// (~12k tokens) and answers in ~1.2k. Shown as "≈ per research turn", never as
// a promise — the real bill is metered per request by src/billing.js off the
// same price_in/price_out this module publishes. Lives here because this is
// where per-token pricing first had to be made comparable; src/model-catalog.js
// re-exports it as the cross-provider definition.
export const TYPICAL_TURN = { prompt: 12_000, completion: 1_200 };

/**
 * Cost of the illustrative research turn at a model's rates, in EUR.
 * @param {number} priceIn EUR per prompt token
 * @param {number} priceOut EUR per completion token
 * @returns {number}
 */
export function turnCostEur(priceIn, priceOut) {
  return priceIn * TYPICAL_TURN.prompt + priceOut * TYPICAL_TURN.completion;
}

// ---- id namespace -----------------------------------------------------------

/**
 * The provider-registry routing predicate (src/providers.js).
 * @param {unknown} id
 * @returns {boolean}
 */
export function isHfModel(id) {
  return typeof id === "string" && id.startsWith(HF_PREFIX);
}

/** @param {Env} env */
export function hfInferenceConfigured(env) {
  return !!/** @type {any} */ (env).HUGGINGFACE_API_TOKEN;
}

/**
 * Build a catalog id from a Hub repo id and an optional pinned serving
 * provider. Returns null for anything that isn't a plausible `owner/model`
 * path, so a hand-rolled request can't mint an id pointing at an arbitrary
 * string.
 * @param {unknown} hfId e.g. "meta-llama/Llama-3.1-8B-Instruct"
 * @param {unknown} [provider] e.g. "together"; omit for the router's own choice
 * @returns {string | null}
 */
export function hfModelId(hfId, provider) {
  if (typeof hfId !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(hfId)) return null;
  if (provider === undefined || provider === null || provider === "") return HF_PREFIX + hfId;
  if (typeof provider !== "string" || !/^[\w.-]+$/.test(provider)) return null;
  return `${HF_PREFIX}${hfId}@${provider}`;
}

/**
 * Split a catalog id back into its Hub repo id and pinned provider.
 * @param {unknown} id
 * @returns {{ hfId: string, provider: string | null } | null}
 */
export function parseHfModelId(id) {
  if (!isHfModel(id)) return null;
  const rest = String(id).slice(HF_PREFIX.length);
  const at = rest.lastIndexOf("@");
  const hfId = at === -1 ? rest : rest.slice(0, at);
  const provider = at === -1 ? null : rest.slice(at + 1);
  if (!/^[\w.-]+\/[\w.-]+$/.test(hfId)) return null;
  if (provider !== null && !/^[\w.-]+$/.test(provider)) return null;
  return { hfId, provider };
}

/**
 * The id as the ROUTER wants it: the bare repo path, with a pinned provider
 * appended in the router's documented `owner/model:provider` form.
 * @param {string} id a catalog id (`hf:…`)
 * @returns {string}
 */
export function hfWireModel(id) {
  const parsed = parseHfModelId(id);
  if (!parsed) return String(id);
  return parsed.provider ? `${parsed.hfId}:${parsed.provider}` : parsed.hfId;
}

// ---- the open catalog -------------------------------------------------------

/**
 * One serving provider of one model, normalized out of the router's row.
 * `usdIn`/`usdOut` are USD per 1M tokens (the router's own unit) and are null
 * when that provider published no price.
 * @typedef {{
 *   provider: string,
 *   status: string,
 *   live: boolean,
 *   contextLength: number | null,
 *   usdIn: number | null,
 *   usdOut: number | null,
 *   free: boolean,
 *   tools: boolean,
 *   structured: boolean,
 *   latencyMs: number | null,
 *   throughput: number | null,
 * }} HfServing
 */

/**
 * One browsable model.
 * @typedef {{
 *   hfId: string,
 *   owner: string,
 *   name: string,
 *   vision: boolean,
 *   contextLength: number | null,
 *   servings: HfServing[],
 *   best: HfServing | null,
 *   priced: boolean,
 *   url: string,
 * }} HfModelInfo
 */

/** @param {unknown} v @returns {number | null} */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Normalize one row of the router's `/v1/models` response. Returns null for a
 * row without a usable id, so a shape change degrades to "fewer models" rather
 * than to a throw (invariant 2).
 * @param {any} raw
 * @returns {HfModelInfo | null}
 */
export function normalizeRouterModel(raw) {
  const hfId = typeof raw?.id === "string" ? raw.id : "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(hfId)) return null;
  const servings = /** @type {HfServing[]} */ ((Array.isArray(raw.providers) ? raw.providers : [])
    .map((/** @type {any} */ p) => ({
      provider: String(p?.provider || ""),
      status: String(p?.status || "unknown"),
      live: p?.status === "live",
      contextLength: num(p?.context_length),
      usdIn: num(p?.pricing?.input),
      usdOut: num(p?.pricing?.output),
      free: p?.is_free === true,
      tools: p?.supports_tools === true,
      structured: p?.supports_structured_output === true,
      latencyMs: num(p?.first_token_latency_ms),
      throughput: num(p?.throughput),
    }))
    .filter((/** @type {any} */ p) => p.provider));
  // "Best" = the cheapest LIVE serving with a published output price. Output
  // dominates the bill for a research answer (the completion is what the model
  // generates), so it is the ordering key, with input as the tiebreak.
  const priced = servings.filter((p) => p.live && p.usdOut !== null);
  priced.sort((a, b) => (a.usdOut || 0) - (b.usdOut || 0) || (a.usdIn || 0) - (b.usdIn || 0));
  const best = priced[0] || null;
  const modalities = raw?.architecture?.input_modalities;
  return {
    hfId,
    owner: String(raw.owned_by || hfId.split("/")[0] || ""),
    name: hfId.split("/").slice(1).join("/") || hfId,
    vision: Array.isArray(modalities) && modalities.includes("image"),
    contextLength: best?.contextLength ?? servings.find((/** @type {HfServing} */ p) => p.contextLength)?.contextLength ?? null,
    servings,
    best,
    priced: !!best,
    url: "https://huggingface.co/" + hfId,
  };
}

// The router catalog is the same for every caller and changes on the order of
// hours, so it is cached per isolate. Keyed on the resolved base URL so a test
// pointing HF_ROUTER_URL at a mock never reads production's cache (the same
// reasoning as agent-registry.js keying on the ASSETS binding).
const CATALOG_TTL_MS = 10 * 60 * 1000;
/** @type {Map<string, { at: number, models: HfModelInfo[] }>} */
const catalogCache = new Map();

/**
 * The open catalog: every model the HF router can currently serve. Fail-soft —
 * returns [] on any error, so a browse renders "catalog unavailable" instead of
 * erroring (invariant 2).
 * @param {Env} env
 * @param {import('./types.js').Logger} [log]
 * @returns {Promise<HfModelInfo[]>}
 */
export async function hfRouterModels(env, log) {
  const key = apiBase(env);
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.models;
  try {
    const res = await fetch(modelsUrl(env), {
      headers: hfInferenceConfigured(env) ? { authorization: `Bearer ${/** @type {any} */ (env).HUGGINGFACE_API_TOKEN}` } : {},
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("status " + res.status);
    const data = /** @type {any} */ (await res.json());
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map(normalizeRouterModel)
      .filter(/** @type {(m: HfModelInfo | null) => m is HfModelInfo} */ ((m) => !!m));
    catalogCache.set(key, { at: Date.now(), models });
    return models;
  } catch (err) {
    log?.warn?.("hf.catalog_failed", { error: String(/** @type {any} */ (err)?.message || err) });
    return hit ? hit.models : [];
  }
}

/**
 * The provider registry's `explore` hook (src/providers.js): the OPEN catalog,
 * as provider-agnostic rows the model catalog can merge with every other
 * provider's. This is the ONE place Hugging Face's own vocabulary — repo ids,
 * serving providers, USD-per-1M pricing — is translated into the shape the
 * Models agent reasons about, which is what lets a second marketplace be added
 * later without touching src/model-catalog.js.
 * @param {Env} env
 * @param {import('./types.js').Logger} [log]
 * @returns {Promise<Array<{ id: string, name: string, provider: string, vision: boolean, tools: boolean, context: number | null, price_in: number, price_out: number, usd_in: number | null, usd_out: number | null, url: string, servedBy: string | null }>>}
 */
export async function hfExplore(env, log) {
  if (!hfInferenceConfigured(env)) return [];
  const catalog = await hfRouterModels(env, log);
  return catalog.map((m) => {
    const best = m.best;
    const usdIn = best?.usdIn ?? null;
    const usdOut = best?.usdOut ?? null;
    return {
      id: hfModelId(m.hfId, best?.provider) || HF_PREFIX + m.hfId,
      name: m.name,
      provider: "huggingface",
      vision: m.vision,
      tools: !!best?.tools,
      context: best?.contextLength ?? m.contextLength,
      price_in: usdIn === null ? 0 : eurPerTokenFromUsd(usdIn),
      price_out: usdOut === null ? 0 : eurPerTokenFromUsd(usdOut),
      usd_in: usdIn,
      usd_out: usdOut,
      url: m.url,
      servedBy: best?.provider || null,
    };
  });
}

// ---- provider contract ------------------------------------------------------

/**
 * Catalog entries for the models THIS account accepted — the promotion
 * pipeline's output. Unlike every other provider's `models(env)`, this one is
 * per-identity by design: an HF model is not on the menu until someone looked
 * at its price and said yes (src/user-models.js).
 * Empty without the token, so with HF unconfigured nothing routes here and the
 * feature is invisible — the same convention as Anthropic/OpenAI.
 * @param {Env} env
 * @param {import('./user-models.js').AcceptedModel[]} accepted
 * @returns {import('./types.js').ModelCatalogEntry[]}
 */
export function hfInferenceModels(env, accepted) {
  if (!hfInferenceConfigured(env) || !Array.isArray(accepted)) return [];
  return accepted.map((m) => ({
    id: m.id,
    name: m.name,
    pricing: formatPricing({ input: m.price_in, output: m.price_out, currency: "EUR" }),
    price_in: m.price_in,
    price_out: m.price_out,
    up: true,
    vision: !!m.vision,
    provider: "huggingface",
  }));
}

/** @param {Env} env */
function headers(env) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${/** @type {any} */ (env).HUGGINGFACE_API_TOKEN || ""}`,
  };
}

/**
 * The router payload. The project's message arrays are already OpenAI-shaped,
 * so `messages` passes through untouched; this only pins the wire parameters
 * and rewrites the model id into the router's form.
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number, stream?: boolean, json?: boolean }} opts
 */
export function toHfPayload(messages, { model, maxTokens = MAX_TOKENS, stream = false, json = false } = {}) {
  /** @type {Record<string, unknown>} */
  const payload = {
    model: model ? hfWireModel(model) : model,
    stream,
    max_tokens: maxTokens,
    messages,
  };
  if (stream) payload.stream_options = { include_usage: true };
  if (json) payload.response_format = { type: "json_object" };
  return payload;
}

/**
 * Streaming chat completion — same contract as berget.js's chatCompletion. The
 * router serves OpenAI-style SSE, so the raw Response is returned as-is
 * (non-2xx included, so callers' `.text()` detail capture works).
 * @param {Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number }} [opts]
 */
export function hfChatCompletion(env, messages, { model, maxTokens } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);
  return fetch(chatUrl(env), {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(toHfPayload(messages, { model, maxTokens: maxTokens || MAX_TOKENS, stream: true })),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

/**
 * Non-streaming JSON completion — same { value, usage, diagnostics } contract.
 * Normally UNUSED: the JSON planning phases stay on Berget's fixed
 * DEFAULT_MODEL (invariant 3), and an open-catalog model is exactly the kind of
 * model that invariant exists to keep away from triage. This exists so the
 * dispatch stays total. `response_format` is requested but many router
 * providers ignore it (supports_structured_output is false for most of them),
 * so parseLooseJson does the real work.
 * @param {Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number }} [opts]
 */
export async function hfCompleteJson(env, messages, { model, maxTokens = 900 } = {}) {
  const resp = await fetch(chatUrl(env), {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(toHfPayload(messages, { model, maxTokens, json: true })),
    signal: AbortSignal.timeout(JSON_CALL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Hugging Face JSON call failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = /** @type {any} */ (await resp.json());
  const choice = data.choices?.[0];
  const content = choice?.message?.content || "";
  const { value, parseMode } = parseLooseJson(content);
  return {
    value,
    usage: data.usage || null,
    diagnostics: {
      parse_mode: parseMode,
      finish_reason: choice?.finish_reason || null,
      content_length: content.length,
    },
  };
}
