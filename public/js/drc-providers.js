// @ts-check
// Free mode's client-side LLM provider registry — the browser counterpart
// of src/providers.js, for providers whose APIs allow DIRECT cross-origin
// calls from JavaScript (CORS). That property is the admission ticket:
// OpenAI serves `Access-Control-Allow-Origin: *` on its chat-completions
// endpoints; Anthropic (api.anthropic.com) serves `*` too and allows
// x-api-key / anthropic-version plus the explicit browser opt-in header
// `anthropic-dangerous-direct-browser-access: true` (probed live
// 2026-07-23); and Berget (api.berget.ai) serves origin-reflecting CORS
// with POST + Authorization allowed on /chat/completions and /models
// (probed live 2026-07-11 — it used to have no browser CORS, which is why
// it was originally excluded here). So the user's browser can call all
// three with the user's own API key and Deepresearch's server is never in
// the request path at all.
//
// The three named providers are the SHIPPED shortcuts, not the boundary:
// the keyless `local` entry below takes ARBITRARY OpenAI-compatible base
// URLs, so any other service speaking that wire (or a model the user runs
// themselves) is reachable without a registry change.
//
// Anthropic joined the registry on 2026-07-26, replacing Groq (which spoke
// the plain OpenAI wire and is still reachable through the custom
// OpenAI-compatible entry). CORS was never what kept Anthropic out — the
// WIRE was: the Messages API is not OpenAI chat completions. The fix is
// the browser mirror of src/anthropic.js's stream adapter, below: an entry
// declares `wire: "anthropic"` and the four wire functions branch on it,
// so everything downstream keeps consuming OpenAI-shaped SSE. Adapt at the
// wire, don't fork the pipeline — the same rule the server seam follows.
//
// Same registry discipline as the server seam: one declarative entry per
// provider (id, label, base URL, wire dialect + param quirks, a JSON-phase
// default model, a static fallback catalog), and everything downstream —
// drc-research.js's pipeline phases and the /cure page — is
// provider-agnostic.
//
// Import-safe outside a browser (Node-tested); network calls take an
// optional baseUrl override so tests can point at a mock (the BERGET_URL
// convention).

// The Berget catalog curation rule (its ids are vendor paths like mistralai/…,
// zai-org/…; the catalog is chat-model-dominated, so curation means excluding
// the non-chat modalities it hosts — whisper speech-to-text, e5 embeddings, the
// bge reranker — not picking generations). Shared by the Berget registry entry
// AND the wire-identical secure-research-space proxy provider below, so the
// regex has ONE definition and the two can never drift apart.
export const bergetCatalogFilter = (/** @type {string} */ id) =>
  id.includes("/") && !/(whisper|rerank|embed|-e5-|tts|guard)/i.test(id);

// Per-provider wire quirks, mirroring what the server clients learned:
// OpenAI's GPT-5 family wants max_completion_tokens + reasoning_effort
// (src/openai.js); Berget speaks plain OpenAI chat completions (the same
// wire src/berget.js drives server-side); Anthropic speaks its own Messages
// API and is adapted at the wire (`wire: "anthropic"`).
/**
 * One registry entry. Every field past `id`/`label` is optional because the
 * entries differ by tier: a keyless local server has no key pattern, an
 * on-device engine has no wire at all, and only an embeddings-capable
 * provider carries `embed`.
 * @typedef {object} DrcProvider
 * @property {string} id
 * @property {string} label
 * @property {string} [base] the chat-completions base URL
 * @property {"openai"|"anthropic"} [wire] the wire dialect; absent means OpenAI chat completions
 * @property {boolean} [proxied] routed through one of the server's bounded exceptions
 * @property {boolean} [whole] answers un-streamed; drcChatWhole adapts it to SSE
 * @property {boolean} [keyless] send no Authorization header at all
 * @property {string|null} [jsonModel] the fixed model for the JSON planning phases
 * @property {string[]} [fallbackModels] shown until (or in place of) a live /models fetch
 * @property {(id: string) => boolean} [modelFilter] the dropdown curation rule
 * @property {(maxTokens: number) => Record<string, any>} [params] per-provider wire params
 * @property {number} [jsonTimeoutMs]
 * @property {RegExp|null} [keyPattern] null on a keyless entry
 * @property {string} [hint]
 * @property {{model: string, dimensions?: number, prefix?: string}} [embed]
 * @property {any} [engine] the on-device tier's in-browser callable
 */

/**
 * The options bag every wire call takes. `baseUrl` overrides the entry's
 * `base` so tests can point at a mock (the BERGET_URL convention).
 * @typedef {{signal?: AbortSignal, baseUrl?: string, maxTokens?: number}} DrcCallOpts
 */

/** @type {DrcProvider[]} */
export const DRC_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    // Key auto-detection (the one-field key panel): OpenAI keys are
    // sk-… (sk-proj-…, sk-svcacct-…) — hyphen, unlike Berget's sk_ber_
    // underscore form. But Anthropic's sk-ant-… is ALSO an sk- key, so it
    // is excluded explicitly: the most specific prefix owns the key, and a
    // key routed to the wrong wire is worse than one left undetected
    // (feedback #6, 2026-07-23 — an Anthropic key misdetected as OpenAI).
    keyPattern: /^sk-(?!ant-)/,
    // The fixed cheap model for the JSON planning phases (the client-side
    // mirror of the split-model-routing invariant — planning does not run
    // on the user's chosen answer model).
    jsonModel: "gpt-5.4-mini",
    // Shown until (or in place of) a live /models fetch; ids from the
    // server's static catalog (src/openai.js).
    fallbackModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"],
    // The dropdown is CURATED, not exhaustive (2026-07-10 directive):
    // only the most recent language-model generation — gpt-5.x and its
    // mini/nano variants — never legacy families (gpt-4*, gpt-3.5, o*)
    // and never non-chat modalities.
    modelFilter: (id) =>
      /^gpt-5\.\d/.test(id) && !/(audio|realtime|image|tts|transcribe|embedding|moderation|search|codex)/.test(id),
    params: (maxTokens) => ({ max_completion_tokens: maxTokens, reasoning_effort: "none" }),
    // Client-side RAG's embedding config (drc-rag.js). Deliberately the
    // SMALL model, dimension-reduced: DRC's index rests inside the sealed
    // state in localStorage (quota ~5 MB) and the embed call sits on the
    // send path, so latency and vector size beat the last few points of
    // retrieval quality text-embedding-3-large would buy.
    embed: { model: "text-embedding-3-small", dimensions: 512 },
  },
  {
    id: "anthropic",
    label: "Anthropic",
    // The Messages API root. Every path this module appends (/messages,
    // /models) hangs off it exactly like the OpenAI-wire providers'.
    base: "https://api.anthropic.com/v1",
    // sk-ant-… — the most specific sk- prefix, so it must win over OpenAI's
    // (whose pattern excludes it explicitly; feedback #6, 2026-07-23).
    keyPattern: /^sk-ant-/,
    // NOT the OpenAI chat-completions wire: the four wire functions below
    // branch on this and adapt the Messages API to OpenAI-shaped SSE, so
    // drc-research.js's phases never learn a second dialect.
    wire: "anthropic",
    // The fixed cheap model for the JSON planning phases (the client-side
    // mirror of split model routing — planning does not run on the user's
    // chosen answer model).
    jsonModel: "claude-haiku-4-5",
    // Shown until (or in place of) a live /models fetch; ids from the
    // server's static catalog (src/anthropic.js MODELS).
    fallbackModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    // The same CURATED-not-exhaustive rule the other entries follow: the
    // current generation only. Anthropic's /v1/models returns dated ids
    // (claude-haiku-4-5-20251001) alongside every legacy family, so the
    // prefixes are matched with a boundary. Bumped in the same pass the
    // server catalog is (the model-catalog-refresh skill).
    modelFilter: (id) => /^claude-(opus-5|sonnet-5|haiku-4-5)\b/.test(id),
    // Consumed only by the OpenAI-wire payload builder; the Anthropic wire
    // sets max_tokens itself. Kept so a generic caller can't produce a
    // payload with no token cap at all.
    params: (maxTokens) => ({ max_tokens: maxTokens }),
    // No `embed`: Anthropic serves no embeddings endpoint, so an
    // Anthropic-only session runs without client-side RAG (drc-rag.js
    // degrades to the plain recent-turns context — fail-soft, never an
    // error).
  },
  {
    id: "berget",
    label: "Berget",
    base: "https://api.berget.ai/v1",
    // sk_ber_… — the prefix Berget's own CLI redacts as its key shape
    // (npm `berget`, src/utils/logger.ts: /sk_ber_\w+/).
    keyPattern: /^sk_ber_/,
    // The same fixed reliable model the server pipeline uses as
    // DEFAULT_MODEL for its JSON planning phases (src/berget.js) — the
    // one Berget model with a long evidence trail behind it.
    jsonModel: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    // The text models from the live catalog (probed 2026-07-11),
    // newest-ish first; Berget's catalog is small and curated already.
    fallbackModels: [
      "moonshotai/Kimi-K2.6",
      "zai-org/GLM-4.7-FP8",
      "mistralai/Mistral-Medium-3.5-128B",
      "openai/gpt-oss-120b",
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    ],
    // Berget's ids are vendor paths (mistralai/…, zai-org/…). The catalog
    // is chat-model-dominated; curation here means excluding the non-chat
    // modalities it hosts (whisper speech-to-text, e5 embeddings, the bge
    // reranker), not picking generations. Shared with proxyLlmProvider below.
    modelFilter: bergetCatalogFilter,
    // Plain OpenAI chat-completions wire — same params the server's
    // Berget client sends (src/berget.js: max_tokens, response_format).
    params: (maxTokens) => ({ max_tokens: maxTokens }),
    // No `embed` yet: Berget DOES serve /embeddings with CORS
    // (intfloat/multilingual-e5-large), but the e5 family needs the
    // "passage: "/"query: " prefix convention (src/rag.js) threaded
    // through drc-rag.js, its vectors are 1024-dim (double the sealed
    // localStorage footprint of OpenAI's 512), and the wire is unverified
    // without a live key — a deliberate later step, not an oversight.
    // Until then a Berget-only session runs without RAG, like Anthropic.
  },
  {
    // ANY OpenAI-compatible endpoint — this is the escape hatch that keeps
    // the three named providers above from being the boundary. Point it at a
    // model server the user runs (Ollama, LM Studio, llama.cpp; localhost
    // included, because browsers treat http://localhost as a
    // potentially-trustworthy origin, so an https page may call it) or at any
    // other hosted service speaking that wire. Running it yourself is the
    // tier's strongest privacy mode — with it, the conversation reaches NO
    // third party at all — and the reason the entry exists (the project
    // mission; docs/FOREVERAGENT-GAP-ANALYSIS.md §8).
    // KEYLESS: no key exists, so "configured" means "a base URL is set"
    // (configuredDrcProviders below); the URL itself lives in the sealed state
    // (drc-core.js localBaseUrl) and always overrides `base` on the wire.
    id: "local",
    label: "Any OpenAI-compatible endpoint (Ollama / LM Studio / llama.cpp / your own)",
    base: "http://localhost:11434/v1", // Ollama's default; the settings URL overrides
    keyPattern: null,
    keyless: true,
    // One local server serves BOTH pipeline roles: with no fixed cheap model
    // to name (the catalog is whatever the user pulled), the JSON planning
    // phases fall back to the user's chosen model (drc-research.js) — the
    // split-model-routing invariant collapses honestly onto one model.
    jsonModel: null,
    fallbackModels: [], // no static catalog exists for a user's own server
    // A local catalog is whatever the user pulled — curate only the obvious
    // non-chat modalities out (Ollama lists embedding models beside chat ones).
    modelFilter: (id) => !/(embed|whisper|rerank|guard|tts|moderation)/i.test(id),
    params: (maxTokens) => ({ max_tokens: maxTokens }),
    // No `embed`: local embeddings (transformers.js or the server's own
    // /embeddings) are a deliberate later step — a local-only session runs
    // without client-side RAG, like Anthropic (fail-soft, never an error).
  },
];

/** @param {string} id */
export function drcProvider(id) {
  return DRC_PROVIDERS.find((p) => p.id === id) || null;
}

// The SECURE-RESEARCH-SPACE LLM provider: not a user-key provider but the
// server's account-connected reverse proxy (src/proxy.js /api/proxy/llm). It is
// wire-identical to Berget (the proxy is Berget-only, OpenAI-compatible), so it
// reuses every function in this module unchanged — the only differences are the
// base URL (the server proxy) and that its "apiKey" is the temporary PROXY
// TOKEN, not a provider key. Built on demand (it needs the page origin) rather
// than living in DRC_PROVIDERS, because it exists only while a bundle is live.
// The id `proxy` never collides with a real provider, and its model ids are the
// Berget catalog the proxy forwards.
export const PROXY_LLM_PROVIDER_ID = "proxy";
/** @param {string} origin @returns {DrcProvider} */
export function proxyLlmProvider(origin) {
  return {
    id: PROXY_LLM_PROVIDER_ID,
    label: "Secure research space",
    base: (origin || "") + "/api/proxy/llm",
    proxied: true, // marks this as the server-proxied provider (no user key)
    jsonModel: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    fallbackModels: [
      "moonshotai/Kimi-K2.6",
      "zai-org/GLM-4.7-FP8",
      "mistralai/Mistral-Medium-3.5-128B",
      "openai/gpt-oss-120b",
      "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    ],
    modelFilter: bergetCatalogFilter, // wire-identical to Berget (see above)
    params: (maxTokens) => ({ max_tokens: maxTokens }),
    // Embeddings ride the SAME borrowed `api` grant as completions (owner
    // directive, 2026-07-17): the server proxies /embeddings to Berget's e5
    // model on its key, so a borrowed Se/cure session runs the same client-side
    // RAG the signed-in tier does — no user OpenAI key required. Reached at
    // <base>/embeddings (same-origin, so no CORS). `prefix: "e5"` triggers the
    // passage:/query: convention in drcEmbed; the vectors are fixed 1024-dim.
    embed: { model: "intfloat/multilingual-e5-large", dimensions: 1024, prefix: "e5" },
  };
}

// The consolidated Se/rver-TOKEN LLM provider ("one ticket, one JWT" —
// src/server-token.js + src/server-grants.js): the same account-connected
// Berget reverse proxy as above, reached through the token subsystem's own
// endpoint (/api/server-token/llm) with the ONE JWT itself as the bearer —
// no exchange tier, the token IS the working credential. Wire-identical to
// the proxy provider (the server reuses the same forwarders), so this is a
// two-field respin of it. Upstream APIs only, per THE SERVER-TOKEN GUARANTEE:
// the JWT can never read any Se/rver data, and it is never a login.
export const SERVER_TOKEN_LLM_PROVIDER_ID = "servertoken";
/** @param {string} origin @returns {DrcProvider} */
export function serverTokenLlmProvider(origin) {
  return {
    ...proxyLlmProvider(origin),
    id: SERVER_TOKEN_LLM_PROVIDER_ID,
    label: "Se/rver token",
    base: (origin || "") + "/api/server-token/llm",
  };
}

// Key shapes we RECOGNIZE but cannot serve browser-direct yet — known
// prefixes of providers outside the registry. Detection returns null for
// these (never a wrong provider), and foreignDrcKeyHint gives the key
// panel an honest one-liner instead of silence. Kept in sync with the
// prefixes scripts/scan-secrets already knows.
export const FOREIGN_KEY_SHAPES = [
  {
    pattern: /^gsk_/,
    label: "Groq",
    // Groq speaks plain OpenAI chat completions, so it is not unreachable —
    // it is just not one of the three shortcuts. Point the custom endpoint
    // at https://api.groq.com/openai/v1 and it works like any other
    // OpenAI-compatible service. (Groq WAS a registry entry until
    // 2026-07-26, when Anthropic took its slot.)
    hint:
      "That looks like a Groq key — Groq isn't one of the built-in providers, but it speaks the OpenAI wire: " +
      "add it under the custom OpenAI-compatible endpoint (https://api.groq.com/openai/v1).",
  },
  {
    pattern: /^hf_/,
    label: "Hugging Face",
    hint: "That looks like a Hugging Face token — not a chat provider this app can call.",
  },
];

/**
 * The honest message for a recognized-but-not-built-in key shape, or null
 * for anything else. The key panels show this instead of nothing, so a
 * paste that CANNOT work on the one-field flow says so up front rather than
 * failing downstream on the wrong provider.
 * @param {string} key
 * @returns {?string}
 */
export function foreignDrcKeyHint(key) {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) return null;
  const foreign = FOREIGN_KEY_SHAPES.find((f) => f.pattern.test(k));
  return foreign ? foreign.hint : null;
}

// The SHARED-COMPUTE POOL provider (src/pool.js /api/pool/llm): another
// user's machine — often the workspace creator's localhost Ollama — reached
// through the server's blind job-queue relay, with the pt1 POOL TOKEN as the
// bearer credential. Like the sharer's own `local` entry there is no static
// catalog (the models are whatever the sharer pulled) and no jsonModel (the
// JSON planning phases collapse onto the chosen model). `whole: true` because
// pooled jobs return complete (DRSC/1 relays no streams); drcChatStream
// adapts. No `embed`: the pool wire is chat completions ONLY — the strict
// DRSC/1 profile — so a pooled session runs without client-side RAG, like a
// local-only one (fail-soft, never an error).
export const POOL_LLM_PROVIDER_ID = "pool";
/** @param {string} origin @returns {DrcProvider} */
export function poolLlmProvider(origin) {
  return {
    id: POOL_LLM_PROVIDER_ID,
    label: "Shared compute (workspace)",
    base: (origin || "") + "/api/pool/llm",
    proxied: true,
    whole: true,
    jsonModel: null,
    fallbackModels: [],
    modelFilter: (id) => !/(embed|whisper|rerank|guard|tts|moderation)/i.test(id),
    params: (maxTokens) => ({ max_tokens: maxTokens }),
    // A pooled job crosses two hops (relay + a peer's model) bounded by the
    // broker's job TTL — give JSON phases the same patience.
    jsonTimeoutMs: 130_000,
  };
}

/**
 * Identify the provider a pasted API key belongs to by its prefix
 * (sk_ber_… → Berget, sk-ant-… → Anthropic, sk-… minus sk-ant-… → OpenAI),
 * or null for an unrecognized shape — the key panel's one-field UX: the
 * provider dropdown follows the detected prefix automatically, and stays
 * user-pickable for keys no pattern knows. The patterns are mutually
 * exclusive BY CONSTRUCTION (the most specific prefix owns the key —
 * OpenAI's pattern excludes Anthropic's sk-ant-…), so no entry's match
 * can depend on registry order.
 * @param {string} key
 * @returns {?{id: string, label: string}}
 */
export function detectDrcProvider(key) {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) return null;
  return DRC_PROVIDERS.find((p) => p.keyPattern && p.keyPattern.test(k)) || null;
}

/**
 * The providers this session can actually call: a key is stored for them —
 * or, for the keyless local entry, a base URL is configured (there is no key
 * to store; the URL is the whole configuration). The honest generalization
 * over "has a key", so the dropdown/refresh flow works unchanged for both.
 * @param {Record<string, string> | null | undefined} keys
 * @param {{localBaseUrl?: string}} [opts]
 */
export function configuredDrcProviders(keys, { localBaseUrl } = {}) {
  return DRC_PROVIDERS.filter((p) =>
    p.keyless
      ? typeof localBaseUrl === "string" && !!localBaseUrl.trim()
      : typeof keys?.[p.id] === "string" && keys[p.id],
  );
}

/**
 * The provider whose key can serve embeddings (client-side RAG), or null —
 * today that means OpenAI; a future embeddings-capable CORS provider joins
 * by declaring an `embed` entry, with no caller change.
 * @param {Record<string, unknown>|null|undefined} keys
 */
export function drcEmbedProvider(keys) {
  return DRC_PROVIDERS.find((p) => p.embed && typeof keys?.[p.id] === "string" && keys[p.id]) || null;
}

// ---- the Anthropic wire (the browser mirror of src/anthropic.js) ------------
//
// Anthropic's Messages API is the one non-OpenAI dialect in this registry.
// Rather than teach drc-research.js a second shape, it is adapted AT THE WIRE:
// requests are translated on the way out and the SSE stream is re-emitted as
// OpenAI-style chunks on the way back, so every consumer downstream — the
// pipeline phases, the /cure page, drcToolRun's callers — is unchanged. This
// is the same pattern (and largely the same code) as the server client's
// `openAiStreamFromAnthropic`; keep the two in step when either changes.

/** @param {DrcProvider|null|undefined} provider */
const isAnthropicWire = (provider) => provider?.wire === "anthropic";

// data:image/jpeg;base64,… → its media type + raw base64 payload.
const DATA_URL_RE = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

// The wire headers for a call. Anthropic authenticates with x-api-key plus a
// version header, and browser-direct calls need its EXPLICIT opt-in header
// (`anthropic-dangerous-direct-browser-access`) or the preflight is rejected —
// the one header that makes Se/cure's browser-direct promise work on Claude.
// Every other provider keeps the exact Bearer header it always sent, and
// keyless ones (the custom endpoint) get NO Authorization header at all —
// "Bearer undefined" makes some servers 401.
/** @param {DrcProvider|null|undefined} provider @param {string|undefined} apiKey */
function wireHeaders(provider, apiKey) {
  if (isAnthropicWire(provider)) {
    return {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    };
  }
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
  };
}

/**
 * One OpenAI-style message array → an Anthropic Messages payload. Bridges the
 * three differences that matter here: `system` turns are a top-level field (not
 * messages), image parts are base64 source blocks (not data-URL image_url
 * parts), and consecutive same-role messages are merged (the pipeline's
 * appended context blocks routinely produce them). Pure and exported for tests.
 * @param {any[]} messages
 * @param {{model?: string, maxTokens?: number, stream?: boolean, tools?: any[]}} [opts]
 */
export function toDrcAnthropicPayload(messages, { model, maxTokens = 4096, stream = false, tools } = {}) {
  const system = [];
  /** @type {Array<{role: string, content: any[]}>} */
  const out = [];
  for (const m of messages || []) {
    if (m?.role === "system") {
      const text = anthropicPartsText(m.content);
      if (text) system.push(text);
      continue;
    }
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = toAnthropicBlocks(m?.content);
    if (!content.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...content);
    else out.push({ role, content });
  }
  /** @type {Record<string, any>} */
  const payload = { model, max_tokens: maxTokens, stream, messages: out };
  const sys = system.join("\n\n");
  if (sys) payload.system = sys;
  if (Array.isArray(tools) && tools.length) payload.tools = tools;
  return payload;
}

/** @param {any} content */
function anthropicPartsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((p) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : []))
    .join("\n");
}

/** @param {any} content */
function toAnthropicBlocks(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
      const m = DATA_URL_RE.exec(part.image_url.url);
      // Only data:image URLs reach here; a non-match is a malformed part —
      // skip it rather than erroring the whole request.
      if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
  }
  return blocks;
}

// Anthropic stop_reason → OpenAI finish_reason. Consumers only check
// truthiness (a missing finish_reason marks a dropped stream), but mapped
// values keep diagnostics reading consistently across providers.
/** @type {Record<string, string>} */
const ANTHROPIC_STOP_REASONS = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

/**
 * One parsed Anthropic SSE event → zero or more OpenAI-style data payloads
 * (pre-serialized; "[DONE]" is the literal terminator). Mutates the shared
 * usage accumulator. Exported for tests.
 * @param {any} evt
 * @param {{prompt_tokens: number, completion_tokens: number}} usage
 * @returns {string[]}
 */
export function oaiChunksFromAnthropicEvent(evt, usage) {
  switch (evt?.type) {
    case "message_start": {
      const u = evt.message?.usage;
      if (typeof u?.input_tokens === "number") usage.prompt_tokens = u.input_tokens;
      if (typeof u?.output_tokens === "number") usage.completion_tokens = u.output_tokens;
      return [];
    }
    case "content_block_delta": {
      const d = evt.delta;
      if (d?.type === "text_delta" && d.text) {
        return [JSON.stringify({ choices: [{ delta: { content: d.text } }] })];
      }
      return []; // thinking / tool deltas are dropped — text only
    }
    case "message_delta": {
      if (typeof evt.usage?.output_tokens === "number") usage.completion_tokens = evt.usage.output_tokens;
      const stop = evt.delta?.stop_reason;
      if (!stop) return [];
      return [
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: ANTHROPIC_STOP_REASONS[stop] || String(stop) }],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.prompt_tokens + usage.completion_tokens,
          },
        }),
      ];
    }
    case "message_stop":
      return ["[DONE]"];
    default:
      return []; // ping, content_block_start/stop, unknown future events
  }
}

/**
 * Wrap an Anthropic SSE body in a stream emitting the OpenAI-style SSE every
 * downstream consumer already parses. An `error` event ERRORS the stream so
 * the caller's try/catch engages exactly as it does on a broken OpenAI stream.
 * @param {ReadableStream} body
 */
export function openAiStreamFromAnthropic(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  return new ReadableStream({
    // Loops until at least one chunk is enqueued (or the source ends): a pull
    // that enqueues nothing is NOT re-invoked by the stream machinery, so
    // events mapping to zero output (message_start, ping, block start/stop)
    // would otherwise deadlock the read.
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let enqueued = false;
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          if (evt.type === "error") {
            reader.cancel().catch(() => {});
            controller.error(new Error("Anthropic stream error: " + (evt.error?.message || "unknown")));
            return;
          }
          for (const chunk of oaiChunksFromAnthropicEvent(evt, usage)) {
            controller.enqueue(encoder.encode("data: " + chunk + "\n\n"));
            enqueued = true;
          }
        }
        if (enqueued) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * The concatenated text of an Anthropic Messages response's content blocks.
 * @param {any} data
 */
function anthropicText(data) {
  return (Array.isArray(data?.content) ? data.content : [])
    .filter((/** @type {any} */ b) => b?.type === "text" && typeof b.text === "string")
    .map((/** @type {any} */ b) => b.text)
    .join("");
}

/**
 * Embed texts straight from the browser on the user's key (or, for the
 * proxy/Se/rver-token provider, through the same-origin server proxy on the
 * borrowed `api` grant). Returns {vectors: number[][], dims, model}; throws on
 * any failure (callers are fail-soft — RAG is a helper, never a reason a send
 * breaks).
 *
 * `kind` selects the e5 input-prefix convention some models require
 * (intfloat/multilingual-e5-large, Berget's embedding model): a document is
 * "passage: …", a query is "query: …" (src/rag.js applies the same prefixes
 * server-side). Applied only when the provider's embed config declares
 * `prefix: "e5"`; OpenAI needs no prefix and ignores `kind`. e5 also returns a
 * fixed 1024-dim vector, so the OpenAI-only `dimensions` reduction param is
 * omitted for prefixed models.
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {string[]} texts
 * @param {{signal?: AbortSignal, baseUrl?: string, kind?: "passage"|"query"}} [opts]
 */
export async function drcEmbed(provider, apiKey, texts, { signal, baseUrl, kind = "passage" } = {}) {
  if (!provider?.embed) throw new Error("This provider serves no embeddings.");
  const timeout =
    signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined);
  const e5 = provider.embed.prefix === "e5";
  const input = e5 ? texts.map((t) => (kind === "query" ? "query: " : "passage: ") + t) : texts;
  const res = await fetch((baseUrl || provider.base) + "/embeddings", {
    method: "POST",
    headers: wireHeaders(provider, apiKey),
    body: JSON.stringify({
      model: provider.embed.model,
      input,
      // The OpenAI dimensions-reduction param has no meaning for e5 (fixed
      // 1024-dim) — send it only for providers that actually project.
      ...(e5 ? {} : { dimensions: provider.embed.dimensions }),
      encoding_format: "float",
    }),
    signal: timeout,
  });
  if (!res.ok) throw new Error(provider.label + " rejected the embedding request (" + res.status + ").");
  const data = await res.json();
  const vectors = (Array.isArray(data?.data) ? data.data : [])
    .slice()
    .sort((/** @type {any} */ a, /** @type {any} */ b) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((/** @type {any} */ d) => d?.embedding)
    .filter((/** @type {any} */ v) => Array.isArray(v));
  if (vectors.length !== texts.length) throw new Error(provider.label + " returned a mismatched embedding count.");
  return { vectors, dims: vectors[0]?.length || 0, model: provider.embed.model };
}

// One OpenAI-compatible chat-completions payload; `json` asks for JSON mode
// (all three providers support response_format json_object — Berget's
// catalog reports json_mode on every text model — so the pipeline's
// no-function-calling rule holds here too).
/**
 * @param {DrcProvider} provider
 * @param {string} model
 * @param {any[]} messages
 * @param {{stream?: boolean, json?: boolean, maxTokens?: number}} [opts]
 */
export function buildDrcPayload(provider, model, messages, { stream = false, json = false, maxTokens = 4096 } = {}) {
  /** @type {Record<string, any>} */
  const payload = {
    model,
    messages,
    stream,
    ...(provider.params ? provider.params(maxTokens) : {}),
  };
  if (json) payload.response_format = { type: "json_object" };
  return payload;
}

/**
 * Streaming chat completion, straight from the browser to the provider.
 * Returns the raw fetch Response (an OpenAI-style SSE body on success).
 * An ENGINE provider (the on-device tier — ondevice-engine.js) has no wire
 * at all: its callable synthesizes the same OpenAI-SSE Response from the
 * in-browser engine, so every consumer downstream is unchanged (the
 * src/anthropic.js adapt-at-the-wire pattern, client-side).
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {string} model
 * @param {any[]} messages
 * @param {DrcCallOpts} [opts]
 */
export function drcChatStream(provider, apiKey, model, messages, { signal, baseUrl, maxTokens } = {}) {
  if (provider.engine) return provider.engine.chatStream(model, messages, { signal, maxTokens });
  if (provider.whole) return drcChatWhole(provider, apiKey, model, messages, { signal, baseUrl, maxTokens });
  if (isAnthropicWire(provider)) return drcChatStreamAnthropic(provider, apiKey, model, messages, { signal, baseUrl, maxTokens });
  return fetch((baseUrl || provider.base) + "/chat/completions", {
    method: "POST",
    headers: wireHeaders(provider, apiKey),
    body: JSON.stringify(buildDrcPayload(provider, model, messages, { stream: true, maxTokens })),
    signal,
  });
}

/**
 * The Anthropic-wire half of drcChatStream: POST /messages, then hand back a
 * Response whose body is already OpenAI-style SSE. A FAILED response is
 * returned untouched so providerErrorDetail reads its `{error:{message}}` —
 * Anthropic's error shape happens to match the OpenAI one.
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {string} model
 * @param {any[]} messages
 * @param {DrcCallOpts} [opts]
 */
async function drcChatStreamAnthropic(provider, apiKey, model, messages, { signal, baseUrl, maxTokens = 4096 } = {}) {
  const res = await fetch((baseUrl || provider.base) + "/messages", {
    method: "POST",
    headers: wireHeaders(provider, apiKey),
    body: JSON.stringify(toDrcAnthropicPayload(messages, { model, maxTokens, stream: true })),
    signal,
  });
  if (!res.ok || !res.body) return res;
  return new Response(openAiStreamFromAnthropic(res.body), {
    status: res.status,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * The WHOLE-completion adapter behind `provider.whole` (the shared-compute
 * pool): the broker relays completions un-streamed (DRSC/1 v1 has no relay
 * streaming), so fetch stream:false and synthesize the one-chunk OpenAI-SSE
 * Response every downstream consumer already parses — the engine providers'
 * adapt-at-the-wire pattern, for a wire that answers whole. Failed responses
 * return as-is so providerErrorDetail reads them unchanged.
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {string} model
 * @param {any[]} messages
 * @param {DrcCallOpts} [opts]
 */
async function drcChatWhole(provider, apiKey, model, messages, { signal, baseUrl, maxTokens } = {}) {
  const res = await fetch((baseUrl || provider.base) + "/chat/completions", {
    method: "POST",
    headers: wireHeaders(provider, apiKey),
    body: JSON.stringify(buildDrcPayload(provider, model, messages, { stream: false, maxTokens })),
    signal,
  });
  if (!res.ok) return res;
  const data = await res.json().catch(() => null);
  const text = data?.choices?.[0]?.message?.content || "";
  const sse =
    "data: " + JSON.stringify({ choices: [{ delta: { content: text } }] }) + "\n\n" + "data: [DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * A human-readable reason out of a FAILED provider response body, or "".
 * Reads both wire shapes a DRC call can fail with: the OpenAI-wire
 * `{error:{message}}` the direct providers return, and the secure-research-
 * space proxy's `{error, detail}` where `detail` carries the UPSTREAM
 * OpenAI-wire error text (src/proxy.js) — that detail is the difference
 * between a user seeing "rejected the request (502)" and "Model X is
 * currently undergoing maintenance" (test point #10, 2026-07-15). Consumes
 * the body, so error paths only; never throws.
 * @param {Response} res
 * @returns {Promise<string>}
 */
export async function providerErrorDetail(res) {
  try {
    const data = /** @type {any} */ (await res.json());
    const nested = typeof data?.detail === "string" ? extractJson(data.detail) : null;
    const msg =
      nested?.error?.message ||
      data?.error?.message ||
      (typeof data?.error === "string" ? data.error : "");
    return typeof msg === "string" ? msg.slice(0, 300) : "";
  } catch {
    return "";
  }
}

// Lenient JSON extraction — models wrap JSON in code fences or prose often
// enough that strict parsing alone loses good answers (the server's
// hardenJson lesson, in miniature).
/** @param {unknown} text @returns {any} */
export function extractJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.unshift(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next shape
    }
  }
  return null;
}

/**
 * Non-streaming JSON completion for the planning phases. Returns the parsed
 * object or throws (callers are fail-soft, matching the server pipeline).
 * The 45 s default deadline is tuned for hosted APIs; a provider can declare
 * its own `jsonTimeoutMs` — the on-device engine does (phone-speed prompt
 * processing alone can pass 45 s; plan §8, the most-likely-breakage row).
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {string} model
 * @param {any[]} messages
 * @param {DrcCallOpts} [opts]
 */
export async function drcCompleteJson(provider, apiKey, model, messages, { signal, baseUrl, maxTokens = 1500 } = {}) {
  const deadlineMs = provider.jsonTimeoutMs || 45_000;
  const timeout =
    signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(deadlineMs) : undefined);
  if (provider.engine) {
    // The engine has no JSON wire mode; it applies a JSON-only reminder and
    // the same lenient extraction below hardens the result.
    const data = await provider.engine.complete(model, messages, { signal: timeout, maxTokens, json: true });
    const value = extractJson(data?.choices?.[0]?.message?.content || "");
    if (!value) throw new Error(provider.label + " returned no usable JSON.");
    return value;
  }
  // Anthropic has no response_format param: the planning prompts already
  // demand JSON-only output and extractJson repairs prose-wrapped objects —
  // the same bargain src/anthropic.js's completeJson makes server-side.
  const anthropic = isAnthropicWire(provider);
  const res = await fetch((baseUrl || provider.base) + (anthropic ? "/messages" : "/chat/completions"), {
    method: "POST",
    headers: wireHeaders(provider, apiKey),
    body: JSON.stringify(
      anthropic
        ? toDrcAnthropicPayload(messages, { model, maxTokens })
        : buildDrcPayload(provider, model, messages, { json: true, maxTokens }),
    ),
    signal: timeout,
  });
  if (!res.ok) {
    const detail = await providerErrorDetail(res);
    throw new Error(provider.label + " rejected the request (" + res.status + ")." + (detail ? " " + detail : ""));
  }
  const data = await res.json();
  const value = extractJson(anthropic ? anthropicText(data) : data?.choices?.[0]?.message?.content || "");
  if (!value) throw new Error(provider.label + " returned no usable JSON.");
  return value;
}

// ---- native tool calling (developer mode's invariant-1 exception) -----------
//
// DRC's counterpart to the server's src/anthropic.js anthropicToolRun: the
// user's OWN provider drives an agentic tool loop straight from the browser.
// The shared provider-neutral tool defs (introspect-core.js
// INTROSPECTION_TOOLS, {name, description, input_schema}) are ALREADY the
// Anthropic shape, so the Anthropic wire passes them through untouched while
// the OpenAI wire maps them onto `{type:"function", function:{…}}`. Unlike the
// server, DRC can also expose a REAL run_bash tool (the CheerpX sandbox is
// browser-reachable) — the caller adds that entry and handles it in execTool.
// Non-streaming (tool rounds are request/response); the final answer text is
// returned whole for the caller to emit.

/**
 * Map the provider-neutral tool defs to the OpenAI function-tool shape.
 * @param {Array<{name:string,description:string,input_schema:object}>} tools
 */
export function toOpenAiTools(tools) {
  return (Array.isArray(tools) ? tools : []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * Run the browser-direct tool loop on the user's provider: each round the model
 * may return tool_calls; we execute them via `execTool` and feed the results
 * back as role:"tool" messages, until it stops calling tools and returns text.
 * Bounded by maxRounds (then one tools-off call forces an answer). Throws on a
 * hard HTTP failure (callers fall back to the normal flow).
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {string} model
 * @param {{system?: string, userContent?: any, tools: any[],
 *   execTool: (name: string, args: any) => any, maxRounds?: number,
 *   maxTokens?: number, onToolUse?: (u: any) => void, signal?: AbortSignal,
 *   baseUrl?: string}} opts
 * @returns {Promise<{ text: string, toolCalls: number, rounds: number }>}
 */
export async function drcToolRun(
  provider,
  apiKey,
  model,
  { system, userContent, tools, execTool, maxRounds = 6, maxTokens = 4096, onToolUse, signal, baseUrl },
) {
  if (isAnthropicWire(provider)) {
    return drcToolRunAnthropic(provider, apiKey, model, {
      system, userContent, tools, execTool, maxRounds, maxTokens, onToolUse, signal, baseUrl,
    });
  }
  const url = (baseUrl || provider.base) + "/chat/completions";
  const headers = wireHeaders(provider, apiKey);
  /** @type {any[]} */
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: userContent },
  ];
  const oaiTools = toOpenAiTools(tools);
  let toolCalls = 0;

  const call = async (/** @type {Record<string, any>} */ body) => {
    const timeout =
      signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(60_000) : undefined);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: timeout });
    if (!res.ok) throw new Error(provider.label + " rejected the tool request (" + res.status + ").");
    return res.json();
  };

  for (let round = 1; round <= maxRounds; round++) {
    const data = await call({
      model,
      messages,
      tools: oaiTools,
      ...(provider.params ? provider.params(maxTokens) : {}),
    });
    const msg = /** @type {any} */ (data?.choices?.[0]?.message || {});
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) return { text: typeof msg.content === "string" ? msg.content : "", toolCalls, rounds: round };
    // Echo the assistant tool-call turn, then answer each call with a tool msg.
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const c of calls) {
      toolCalls++;
      let args = {};
      try {
        args = JSON.parse(c?.function?.arguments || "{}");
      } catch {
        args = {};
      }
      let result;
      try {
        result = await execTool(c?.function?.name, args);
      } catch (err) {
        result = "Tool error: " + (/** @type {any} */ (err)?.message || String(err));
      }
      const content = typeof result === "string" ? result : JSON.stringify(result);
      if (onToolUse) onToolUse({ round, name: c?.function?.name, input: args, result: content });
      messages.push({ role: "tool", tool_call_id: c?.id, content });
    }
  }

  // Round cap: force a final answer with tools removed.
  messages.push({
    role: "user",
    content: "You have gathered enough. Do NOT call more tools — write the complete final answer now from what you found.",
  });
  const finalData = await call({
    model,
    messages,
    ...(provider.params ? provider.params(maxTokens) : {}),
  });
  return { text: finalData?.choices?.[0]?.message?.content || "", toolCalls, rounds: maxRounds };
}

/**
 * The Anthropic-wire half of drcToolRun: the Messages API's tool_use /
 * tool_result loop. Same contract and same bounds as the OpenAI half — each
 * round may return tool_use blocks, which are executed and fed back as paired
 * tool_result blocks until the model stops calling tools; the round cap then
 * forces one tools-off answer. The provider-neutral tool defs need no mapping
 * here — they are already Anthropic-shaped.
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {string} model
 * @param {{system?: string, userContent?: any, tools: any[],
 *   execTool: (name: string, args: any) => any, maxRounds?: number,
 *   maxTokens?: number, onToolUse?: (u: any) => void, signal?: AbortSignal,
 *   baseUrl?: string}} opts
 * @returns {Promise<{ text: string, toolCalls: number, rounds: number }>}
 */
async function drcToolRunAnthropic(
  provider,
  apiKey,
  model,
  { system, userContent, tools, execTool, maxRounds = 6, maxTokens = 4096, onToolUse, signal, baseUrl },
) {
  const url = (baseUrl || provider.base) + "/messages";
  const headers = wireHeaders(provider, apiKey);
  /** @type {any[]} */
  const messages = [{ role: "user", content: userContent }];
  let toolCalls = 0;

  const call = async (/** @type {any[]} */ turns, /** @type {boolean} */ withTools) => {
    const timeout =
      signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(60_000) : undefined);
    /** @type {any} */
    const payload = { model, max_tokens: maxTokens, messages: turns };
    if (system) payload.system = system;
    if (withTools && Array.isArray(tools) && tools.length) payload.tools = tools;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: timeout });
    if (!res.ok) throw new Error(provider.label + " rejected the tool request (" + res.status + ").");
    return res.json();
  };

  for (let round = 1; round <= maxRounds; round++) {
    const data = /** @type {any} */ (await call(messages, true));
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const toolUses = blocks.filter((/** @type {any} */ b) => b?.type === "tool_use");
    if (data?.stop_reason !== "tool_use" || !toolUses.length) {
      return { text: anthropicText(data), toolCalls, rounds: round };
    }
    // Echo the assistant's tool_use turn, then answer every call — Anthropic
    // requires the tool_result blocks paired by id in ONE user turn.
    messages.push({ role: "assistant", content: blocks });
    /** @type {any[]} */
    const results = [];
    for (const tu of toolUses) {
      toolCalls++;
      let result;
      try {
        result = await execTool(tu?.name, tu?.input || {});
      } catch (err) {
        result = "Tool error: " + (/** @type {any} */ (err)?.message || String(err));
      }
      const content = typeof result === "string" ? result : JSON.stringify(result);
      if (onToolUse) onToolUse({ round, name: tu?.name, input: tu?.input, result: content });
      results.push({ type: "tool_result", tool_use_id: tu?.id, content });
    }
    messages.push({ role: "user", content: results });
  }

  messages.push({
    role: "user",
    content: "You have gathered enough. Do NOT call more tools — write the complete final answer now from what you found.",
  });
  return { text: anthropicText(await call(messages, false)), toolCalls, rounds: maxRounds };
}

/**
 * The curated, ordered model-id list from a raw /models `data` array: keep the
 * string ids the provider's `modelFilter` accepts, sorted newest-generation
 * first (gpt-5.6 above gpt-5.4). Pure — the shaping half of `listDrcModels`,
 * split out so it is unit-testable without a mock /models fetch (and reused by
 * any future keyless/local provider that lists models the same way).
 * @param {any} data the parsed `/models` response's `data` field
 * @param {(id: string) => boolean} modelFilter the provider's curation predicate
 * @returns {string[]}
 */
export function filterAndSortModels(data, modelFilter) {
  return (Array.isArray(data) ? data : [])
    // Berget's catalog keeps listing models that are DOWN for inference
    // (status.up false / lifecycle "maintenance") — picking one gets a 502 on
    // every call, and the newest-first sort loves to put exactly those first
    // (zai-org/GLM-5.2 landed as a borrowed session's DEFAULT while dark,
    // 2026-07-15, test point #10). Same treatment as the DRS dropdown's
    // `up === false` disable; fail-open when the field is absent (OpenAI and
    // Anthropic /models entries carry no `status`).
    .filter((m) => m?.status?.up !== false)
    .map((m) => m?.id)
    .filter((id) => typeof id === "string" && modelFilter(id))
    .sort()
    .reverse(); // newest generation first (gpt-5.6 above gpt-5.4)
}

/**
 * The provider's chat-capable model list — live from the user's key, the
 * static fallback when the fetch fails (wrong key still gets a dropdown to
 * try; the send will surface the real error).
 * @param {DrcProvider} provider
 * @param {string} apiKey
 * @param {{baseUrl?: string}} [opts]
 */
export async function listDrcModels(provider, apiKey, { baseUrl } = {}) {
  try {
    // GET, so only the auth headers matter — but Anthropic's are x-api-key +
    // the browser opt-in, not a Bearer, so the same helper the POSTs use
    // supplies them (content-type on a GET is inert).
    const res = await fetch((baseUrl || provider.base) + "/models", {
      headers: wireHeaders(provider, apiKey),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const ids = filterAndSortModels(data?.data, provider.modelFilter || (() => true));
    if (ids.length) return ids;
  } catch {
    // fall through to the static list
  }
  return [...(provider.fallbackModels || [])];
}
