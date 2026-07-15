// @ts-check
// OpenAI (GPT) provider client — the third LLM provider alongside Berget
// (src/berget.js) and Anthropic (src/anthropic.js). Raw fetch against the
// OpenAI Chat Completions API — deliberately no SDK: the Worker has no build
// step and no runtime deps (CLAUDE.md invariant 5), and the only surface
// needed is streaming chat plus a rarely-used JSON completion.
//
// Unlike Anthropic, OpenAI needs NO stream adapter: its Chat Completions SSE
// IS the wire format the pipeline's shared consumer (berget.js
// `consumeChatStream`) parses — `choices[0].delta.content`, a finish_reason
// on the closing chunk, a usage chunk, `[DONE]`. The response body passes
// through untouched, so the idle/total guards, the finish_reason
// dropped-connection check, STREAM_MAX_CHARS, the empty-completion retry,
// and pipeline.js's model failover all apply unchanged. What DOES differ is
// wire PARAMETERS (see `toOpenAiPayload`): GPT-5-era reasoning models reject
// the legacy `max_tokens` (→ `max_completion_tokens`), streaming only
// reports usage when asked (`stream_options.include_usage`), and reasoning
// effort must be pinned explicitly (see REASONING_EFFORT below).
//
// Feature-gated on the OPENAI_API_KEY secret (a dashboard secret, same
// convention as BERGET_API_TOKEN / ANTHROPIC_API_KEY — never in the repo):
// absent, the models don't appear in the catalog and nothing routes here
// (src/providers.js).

import { eurPerTokenFromUsd, formatPricing, parseLooseJson } from "./berget.js";

// OPENAI_URL override exists solely so tests can point at a mock (the same
// convention as BERGET_URL/ANTHROPIC_URL); production always uses the default.
/** @param {import('./types.js').Env} env */
const apiBase = (env) => String(env.OPENAI_URL || "https://api.openai.com/v1");
/** @param {import('./types.js').Env} env */
const chatUrl = (env) => apiBase(env) + "/chat/completions";

// Same timeout discipline as berget.js — an unbounded fetch to an LLM
// backend has bitten this project before (berget.js round-2 note): bound
// the connect phase into a normal, catchable error.
const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const JSON_CALL_TIMEOUT_MS = 45_000;

// Matches berget.js's chatCompletion max_tokens — the synthesis answer cap.
// Sent as `max_completion_tokens` (the GPT-5-era param; it bounds visible
// output PLUS any hidden reasoning tokens — another reason reasoning stays
// off below, so the cap buys actual answer text).
const MAX_TOKENS = 4096;

// Every GPT model in the catalog is a reasoning model whose default effort
// spends hidden reasoning tokens inside max_completion_tokens and sits
// silent before the first text delta — both bad fits for this pipeline's
// time-budget planning and its 60s idle guard (the exact same tradeoff as
// Sonnet 5's adaptive thinking, which anthropic.js explicitly disables).
// `"none"` makes them behave like non-reasoning models (supported effort
// scale as of 2026-07: none/minimal/low/medium/high/xhigh). Revisit with a
// rubric-bench A/B (tests/eval-bench.mjs) if synthesis quality looks worth
// the latency on the flagship.
const REASONING_EFFORT = "none";

// Static catalog — the offered models are a deliberate product choice (the
// current mainstream GPT lineup: the three gpt-5.6 tiers plus the compact
// gpt-5.4-mini), and a live /v1/models fetch carries no pricing, so it would
// add a failure mode without adding information (the same reasoning as
// anthropic.js's static list). Prices are the standard USD per-1M rates from
// OpenAI's pricing page as of 2026-07. All four models accept image input
// (vision) and stream via Chat Completions.
const MODELS = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", usd_in: 5, usd_out: 30 },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", usd_in: 2.5, usd_out: 15 },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", usd_in: 1, usd_out: 6 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", usd_in: 0.75, usd_out: 4.5 },
];

// OpenAI model ids are a distinct namespace (bare gpt-*); Berget ids are
// vendor/model paths — note Berget's catalog carries the LOOKALIKE
// `openai/gpt-oss-120b`, which starts with "openai/" and therefore stays on
// Berget. The bare prefix is the routing key src/providers.js dispatches on.
/** @param {unknown} id */
export function isOpenAiModel(id) {
  return typeof id === "string" && id.startsWith("gpt-");
}

/** @param {import('./types.js').Env} env */
export function openaiConfigured(env) {
  return !!env.OPENAI_API_KEY;
}

// Catalog entries in the exact shape berget.js's listModels produces
// (ModelCatalogEntry), so validation, the UI dropdown, and quota pricing
// consume them with no special-casing. Empty when the key isn't configured
// — the feature is invisible, same as Anthropic/Shodan/Maps without theirs.
/**
 * @param {import('./types.js').Env} env
 * @returns {import('./types.js').ModelCatalogEntry[]}
 */
export function openaiModels(env) {
  if (!openaiConfigured(env)) return [];
  return MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    pricing: formatPricing({ input: eurPerTokenFromUsd(m.usd_in), output: eurPerTokenFromUsd(m.usd_out), currency: "EUR" }),
    price_in: eurPerTokenFromUsd(m.usd_in),
    price_out: eurPerTokenFromUsd(m.usd_out),
    up: true,
    vision: true,
    provider: "openai",
  }));
}

/** @param {import('./types.js').Env} env */
function headers(env) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${env.OPENAI_API_KEY || ""}`,
  };
}

// The project's message arrays are already OpenAI-shaped (text parts +
// data-URL image_url parts), so `messages` passes through untouched — this
// builder only pins the GPT-5-era wire parameters. Pure and exported for
// unit tests.
/**
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number, stream?: boolean, json?: boolean }} opts
 */
export function toOpenAiPayload(messages, { model, maxTokens = MAX_TOKENS, stream = false, json = false } = {}) {
  /** @type {Record<string, unknown>} */
  const payload = {
    model,
    stream,
    // GPT-5-era models reject the legacy `max_tokens` on Chat Completions.
    max_completion_tokens: maxTokens,
    reasoning_effort: REASONING_EFFORT,
    messages,
  };
  // Streaming responses only carry the terminal usage chunk (empty
  // `choices` + totals — the shape consumeChatStream merges) when asked.
  if (stream) payload.stream_options = { include_usage: true };
  if (json) payload.response_format = { type: "json_object" };
  return payload;
}

// Streaming chat completion, same calling contract as berget.js's
// chatCompletion: resolves to a Response with an OpenAI-style SSE body —
// which is exactly what OpenAI serves, so the raw Response is returned
// as-is (non-2xx included, so callers' `.text()` detail capture works).
// The abort signal bounds only the connect phase, exactly like Berget's.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number }} opts maxTokens raises the answer cap for the longer report tiers (budget.js); default stays MAX_TOKENS
 */
export function openaiChatCompletion(env, messages, { model, maxTokens } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);
  return fetch(chatUrl(env), {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(toOpenAiPayload(messages, { model, maxTokens: maxTokens || MAX_TOKENS, stream: true })),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

// Non-streaming JSON completion, same contract as berget.js's completeJson
// ({ value, usage, diagnostics }; value null on parse failure — callers
// fall back gracefully). Normally UNUSED: the JSON planning phases run on
// Berget's fixed DEFAULT_MODEL (split model routing — CLAUDE.md invariant
// 3). This exists so the dispatch stays total if a deployment ever routes
// JSON to a GPT model (e.g. Berget catalog outage fallback). OpenAI does
// support `response_format: json_object`, so it is requested; parseLooseJson
// still repairs prose-wrapped objects as a belt-and-braces.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number }} opts
 */
export async function openaiCompleteJson(env, messages, { model, maxTokens = 900 } = {}) {
  const resp = await fetch(chatUrl(env), {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(toOpenAiPayload(messages, { model, maxTokens, json: true })),
    signal: AbortSignal.timeout(JSON_CALL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OpenAI JSON call failed (${resp.status}): ${detail.slice(0, 200)}`);
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
