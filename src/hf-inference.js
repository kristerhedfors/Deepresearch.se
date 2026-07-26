// @ts-check
// Hugging Face INFERENCE — the fourth LLM provider, and the only one whose
// catalog is OPEN: Berget, Anthropic and OpenAI each offer a curated handful
// of models this repo picked, while HF's router serves whatever the inference
// providers have live at the moment. That difference is the whole point of the
// Hugging Face agent (src/hf-agent.js): browse the open catalog, read what a
// model actually COSTS, accept one, and only then does it become a model this
// account can answer with — in the HF agent and, once promoted, in every other
// agent mode too (src/user-models.js).
//
// This module is the INFERENCE half of the Hugging Face integration. The other
// half — searching the Hub for models/datasets/papers as citable research
// sources — is src/hf.js, and the two are deliberately separate: hf.js answers
// "what exists and who says what about it", this one answers "run it".
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
// $0.03–$6.27 per 1M. Those numbers are why unpriced models are shown but
// never acceptable (see hfAllowance) — an unknown rate cannot be budgeted.

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

// The illustrative turn the browse UI prices a model against. Deliberately ONE
// documented pair of numbers rather than a per-model guess: a deep-research
// synthesis prompt carries the source block plus the conversation (~12k tokens)
// and answers in ~1.2k. It is shown as "≈ per research turn", never as a
// promise — the real bill is metered per request by src/billing.js off the same
// price_in/price_out this module publishes.
export const TYPICAL_TURN = { prompt: 12_000, completion: 1_200 };

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

// ---- search + cost ----------------------------------------------------------

/**
 * Rank the catalog against a free-text query. Deterministic and pure (no model
 * call — invariant 1): a lexical scan over the repo id, so "qwen vision" and
 * "swedish" behave predictably and the query never leaves the isolate.
 * An empty query returns the catalog cheapest-first, which is the sane default
 * for a page whose whole point is cost.
 * @param {HfModelInfo[]} models
 * @param {string} query
 * @returns {HfModelInfo[]}
 */
export function hfRankModels(models, query) {
  const terms = String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9.+-]+/)
    .filter((t) => t.length > 1);
  if (!terms.length) {
    return [...models].sort((a, b) => (a.best?.usdOut ?? Infinity) - (b.best?.usdOut ?? Infinity));
  }
  const scored = models
    .map((m) => {
      const hay = m.hfId.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (hay.includes(t)) score += hay.split("/").pop()?.includes(t) ? 2 : 1;
      }
      // A model whose repo NAME (not just the org) matches every term is what
      // the user meant; partial matches still surface, below it.
      if (score && terms.every((t) => hay.includes(t))) score += 3;
      return { m, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || (a.m.best?.usdOut ?? Infinity) - (b.m.best?.usdOut ?? Infinity));
  return scored.map((s) => s.m);
}

/**
 * The MODEL ALLOWANCE — the "start with this much, extend it later" rule the
 * Hugging Face agent hands out. Opening an unbounded provider catalog to a
 * signed-in account is a spend surface, so acceptance is bounded rather than
 * free: a ceiling on the model's output rate, and a cap on how many HF models
 * one account may keep accepted at once. Both are admin-tunable in the site
 * config (`hf.max_output_usd` / `hf.max_accepted`), which is exactly how the
 * allowance gets extended for an account that has earned it.
 * @typedef {{ maxOutputUsd: number, maxAccepted: number }} HfAllowance
 */

/** The built-in starting allowance, absent any admin config. */
export const DEFAULT_ALLOWANCE = { maxOutputUsd: 3, maxAccepted: 6 };

/**
 * Read the allowance out of the site config, falling back to the starting one.
 * @param {any} config the getConfig(env) object
 * @returns {HfAllowance}
 */
export function hfAllowance(config) {
  const hf = config?.hf || {};
  const maxOutputUsd = typeof hf.max_output_usd === "number" && hf.max_output_usd >= 0
    ? hf.max_output_usd
    : DEFAULT_ALLOWANCE.maxOutputUsd;
  const maxAccepted = Number.isInteger(hf.max_accepted) && hf.max_accepted >= 0
    ? hf.max_accepted
    : DEFAULT_ALLOWANCE.maxAccepted;
  return { maxOutputUsd, maxAccepted };
}

/**
 * A browse row: the model, its cost in both currencies, an illustrative
 * per-turn estimate, and whether the account's allowance covers it — with the
 * REASON when it doesn't, so the UI explains a greyed-out card instead of just
 * greying it out.
 * @typedef {{
 *   id: string,
 *   hfId: string,
 *   name: string,
 *   owner: string,
 *   url: string,
 *   vision: boolean,
 *   context: number | null,
 *   provider: string | null,
 *   providers: string[],
 *   usd_in: number | null,
 *   usd_out: number | null,
 *   price_in: number,
 *   price_out: number,
 *   pricing: string | null,
 *   turn_eur: number | null,
 *   tools: boolean,
 *   allowed: boolean,
 *   reason: string | null,
 *   accepted: boolean,
 * }} HfBrowseItem
 */

/**
 * Cost of the illustrative research turn at a model's rates, in EUR.
 * @param {number} priceIn EUR per prompt token
 * @param {number} priceOut EUR per completion token
 * @returns {number}
 */
export function turnCostEur(priceIn, priceOut) {
  return priceIn * TYPICAL_TURN.prompt + priceOut * TYPICAL_TURN.completion;
}

/**
 * Turn one catalog model into a browse row for the picker UI. `serving` pins
 * which of the model's providers the row is priced against — the picker offers
 * the cheapest live one by default, and a user who deliberately chose a
 * different provider gets THAT provider's rates, allowance check included.
 * @param {HfModelInfo} m
 * @param {{ allowance: HfAllowance, acceptedIds?: Set<string>, acceptedCount?: number, serving?: HfServing | null }} opts
 * @returns {HfBrowseItem}
 */
export function hfBrowseItem(m, { allowance, acceptedIds, acceptedCount = 0, serving }) {
  const best = serving || m.best;
  const priceIn = best?.usdIn !== null && best?.usdIn !== undefined ? eurPerTokenFromUsd(best.usdIn) : 0;
  const priceOut = best?.usdOut !== null && best?.usdOut !== undefined ? eurPerTokenFromUsd(best.usdOut) : 0;
  const id = hfModelId(m.hfId, best?.provider) || HF_PREFIX + m.hfId;
  const accepted = !!acceptedIds?.has(m.hfId);
  let allowed = true;
  /** @type {string | null} */
  let reason = null;
  if (!best) {
    allowed = false;
    reason = "No provider publishes a price for this model — it can't be budgeted, so it can't be enabled.";
  } else if (allowance.maxOutputUsd > 0 && (best.usdOut || 0) > allowance.maxOutputUsd) {
    allowed = false;
    reason = `Above your model allowance ($${allowance.maxOutputUsd.toFixed(2)} per 1M output tokens). Ask an admin to raise it.`;
  } else if (!accepted && allowance.maxAccepted > 0 && acceptedCount >= allowance.maxAccepted) {
    allowed = false;
    reason = `Your allowance holds ${allowance.maxAccepted} enabled models. Remove one to enable another.`;
  }
  return {
    id,
    hfId: m.hfId,
    name: m.name,
    owner: m.owner,
    url: m.url,
    vision: m.vision,
    context: best?.contextLength ?? m.contextLength,
    provider: best?.provider || null,
    providers: m.servings.filter((s) => s.live).map((s) => s.provider),
    usd_in: best?.usdIn ?? null,
    usd_out: best?.usdOut ?? null,
    price_in: priceIn,
    price_out: priceOut,
    pricing: best ? formatPricing({ input: priceIn, output: priceOut, currency: "EUR" }) : null,
    turn_eur: best ? turnCostEur(priceIn, priceOut) : null,
    tools: !!best?.tools,
    allowed,
    reason,
    accepted,
  };
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
