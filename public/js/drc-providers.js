// Free mode's client-side LLM provider registry — the browser counterpart
// of src/providers.js, for providers whose APIs allow DIRECT cross-origin
// calls from JavaScript (CORS). That property is the admission ticket:
// OpenAI and Groq (GroqCloud) both serve `Access-Control-Allow-Origin: *`
// on their OpenAI-compatible endpoints, and Berget (api.berget.ai) serves
// origin-reflecting CORS with POST + Authorization allowed on
// /chat/completions and /models (probed live 2026-07-11 — it used to have
// no browser CORS, which is why it was originally excluded here). So the
// user's browser can call all three with the user's own API key and
// Deepresearch's server is never in the request path at all. Providers
// without browser CORS (Anthropic) cannot join this registry — they'd
// need a proxy, which is exactly what DRC exists to avoid.
//
// Same registry discipline as the server seam: one declarative entry per
// provider (id, label, base URL, wire-param quirks, a JSON-phase default
// model, a static fallback catalog), and everything downstream —
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
export const bergetCatalogFilter = (id) =>
  id.includes("/") && !/(whisper|rerank|embed|-e5-|tts|guard)/i.test(id);

// Per-provider wire quirks, mirroring what the server clients learned:
// OpenAI's GPT-5 family wants max_completion_tokens + reasoning_effort
// (src/openai.js); Groq and Berget speak plain OpenAI chat completions
// (Berget: the same wire src/berget.js drives server-side).
export const DRC_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    base: "https://api.openai.com/v1",
    // Key auto-detection (the one-field key panel): OpenAI keys are
    // sk-… (sk-proj-…, sk-svcacct-…) — hyphen, unlike Berget's sk_ber_
    // underscore form, so the two never collide.
    keyPattern: /^sk-/,
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
    id: "groq",
    label: "Groq",
    base: "https://api.groq.com/openai/v1",
    keyPattern: /^gsk_/,
    jsonModel: "llama-3.1-8b-instant",
    fallbackModels: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
    ],
    // Same curation rule: the recent flagship + fast language models one
    // would actually pick here, not Groq's whole zoo (no whisper/tts/
    // guard/embedding, no older generations).
    modelFilter: (id) =>
      /^(llama-3\.3-|llama-3\.1-8b|llama-4|openai\/gpt-oss-|moonshotai\/kimi-k2|qwen)/.test(id) &&
      !/(whisper|tts|guard|embedding|allam)/i.test(id),
    params: (maxTokens) => ({ max_tokens: maxTokens }),
    // No `embed`: Groq serves no /embeddings endpoint, so a Groq-only
    // session runs without client-side RAG (drc-rag.js degrades to the
    // plain recent-turns context — fail-soft, never an error).
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
    // Until then a Berget-only session runs without RAG, like Groq.
  },
  {
    // The user's OWN inference server — Ollama, LM Studio, llama.cpp, or any
    // OpenAI-compatible endpoint the user controls (localhost included:
    // browsers treat http://localhost as a potentially-trustworthy origin, so
    // an https page may call it). This is the tier's strongest privacy mode —
    // with it, the conversation reaches NO third party at all — and the reason
    // it exists (the project mission; docs/FOREVERAGENT-GAP-ANALYSIS.md §8).
    // KEYLESS: no key exists, so "configured" means "a base URL is set"
    // (configuredDrcProviders below); the URL itself lives in the sealed state
    // (drc-core.js localBaseUrl) and always overrides `base` on the wire.
    id: "local",
    label: "Local (Ollama / LM Studio / llama.cpp)",
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
    // without client-side RAG, like Groq (fail-soft, never an error).
  },
];

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
export function serverTokenLlmProvider(origin) {
  return {
    ...proxyLlmProvider(origin),
    id: SERVER_TOKEN_LLM_PROVIDER_ID,
    label: "Se/rver token",
    base: (origin || "") + "/api/server-token/llm",
  };
}

/**
 * Identify the provider a pasted API key belongs to by its prefix
 * (sk_ber_… → Berget, gsk_… → Groq, sk-… → OpenAI), or null for an
 * unrecognized shape — the key panel's one-field UX: the provider
 * dropdown follows the detected prefix automatically, and stays
 * user-pickable for keys no pattern knows.
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
 */
export function drcEmbedProvider(keys) {
  return DRC_PROVIDERS.find((p) => p.embed && typeof keys?.[p.id] === "string" && keys[p.id]) || null;
}

// The wire headers for a call: keyless providers (the local entry) get NO
// Authorization header at all — "Bearer undefined" makes some servers 401 —
// while every keyed call keeps the exact header it always sent.
function wireHeaders(apiKey) {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: "Bearer " + apiKey } : {}),
  };
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
 * @param {"passage"|"query"} [opts.kind]
 */
export async function drcEmbed(provider, apiKey, texts, { signal, baseUrl, kind = "passage" } = {}) {
  if (!provider?.embed) throw new Error("This provider serves no embeddings.");
  const timeout =
    signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined);
  const e5 = provider.embed.prefix === "e5";
  const input = e5 ? texts.map((t) => (kind === "query" ? "query: " : "passage: ") + t) : texts;
  const res = await fetch((baseUrl || provider.base) + "/embeddings", {
    method: "POST",
    headers: wireHeaders(apiKey),
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
    .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
    .map((d) => d?.embedding)
    .filter((v) => Array.isArray(v));
  if (vectors.length !== texts.length) throw new Error(provider.label + " returned a mismatched embedding count.");
  return { vectors, dims: vectors[0]?.length || 0, model: provider.embed.model };
}

// One OpenAI-compatible chat-completions payload; `json` asks for JSON mode
// (all three providers support response_format json_object — Berget's
// catalog reports json_mode on every text model — so the pipeline's
// no-function-calling rule holds here too).
export function buildDrcPayload(provider, model, messages, { stream = false, json = false, maxTokens = 4096 } = {}) {
  const payload = {
    model,
    messages,
    stream,
    ...provider.params(maxTokens),
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
 */
export function drcChatStream(provider, apiKey, model, messages, { signal, baseUrl, maxTokens } = {}) {
  if (provider.engine) return provider.engine.chatStream(model, messages, { signal, maxTokens });
  return fetch((baseUrl || provider.base) + "/chat/completions", {
    method: "POST",
    headers: wireHeaders(apiKey),
    body: JSON.stringify(buildDrcPayload(provider, model, messages, { stream: true, maxTokens })),
    signal,
  });
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
  const res = await fetch((baseUrl || provider.base) + "/chat/completions", {
    method: "POST",
    headers: wireHeaders(apiKey),
    body: JSON.stringify(buildDrcPayload(provider, model, messages, { json: true, maxTokens })),
    signal: timeout,
  });
  if (!res.ok) {
    const detail = await providerErrorDetail(res);
    throw new Error(provider.label + " rejected the request (" + res.status + ")." + (detail ? " " + detail : ""));
  }
  const data = await res.json();
  const value = extractJson(data?.choices?.[0]?.message?.content || "");
  if (!value) throw new Error(provider.label + " returned no usable JSON.");
  return value;
}

// ---- native tool calling (developer mode's invariant-1 exception) -----------
//
// DRC's counterpart to the server's src/anthropic.js anthropicToolRun: the
// user's OWN provider drives an agentic tool loop straight from the browser.
// All three DRC providers speak the OpenAI tools / tool_calls wire, so the
// shared provider-neutral tool defs (introspect-core.js INTROSPECTION_TOOLS,
// {name, description, input_schema}) map onto `{type:"function", function:{…}}`
// here. Unlike the server, DRC can also expose a REAL run_bash tool (the CheerpX
// sandbox is browser-reachable) — the caller adds that entry and handles it in
// execTool. Non-streaming (tool rounds are request/response); the final answer
// text is returned whole for the caller to emit.

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
 * @returns {Promise<{ text: string, toolCalls: number, rounds: number }>}
 */
export async function drcToolRun(
  provider,
  apiKey,
  model,
  { system, userContent, tools, execTool, maxRounds = 6, maxTokens = 4096, onToolUse, signal, baseUrl } = {},
) {
  const url = (baseUrl || provider.base) + "/chat/completions";
  const headers = wireHeaders(apiKey);
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: userContent },
  ];
  const oaiTools = toOpenAiTools(tools);
  let toolCalls = 0;

  const call = async (body) => {
    const timeout =
      signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(60_000) : undefined);
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: timeout });
    if (!res.ok) throw new Error(provider.label + " rejected the tool request (" + res.status + ").");
    return res.json();
  };

  for (let round = 1; round <= maxRounds; round++) {
    const data = await call({ model, messages, tools: oaiTools, ...provider.params(maxTokens) });
    const msg = data?.choices?.[0]?.message || {};
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
        result = "Tool error: " + (err?.message || String(err));
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
  const finalData = await call({ model, messages, ...provider.params(maxTokens) });
  return { text: finalData?.choices?.[0]?.message?.content || "", toolCalls, rounds: maxRounds };
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
    // Groq /models entries carry no `status`).
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
 */
export async function listDrcModels(provider, apiKey, { baseUrl } = {}) {
  try {
    const res = await fetch((baseUrl || provider.base) + "/models", {
      headers: apiKey ? { authorization: "Bearer " + apiKey } : {},
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const ids = filterAndSortModels(data?.data, provider.modelFilter);
    if (ids.length) return ids;
  } catch {
    // fall through to the static list
  }
  return [...provider.fallbackModels];
}
