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
    // reranker), not picking generations.
    modelFilter: (id) => id.includes("/") && !/(whisper|rerank|embed|-e5-|tts|guard)/i.test(id),
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
];

export function drcProvider(id) {
  return DRC_PROVIDERS.find((p) => p.id === id) || null;
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

/** The providers the user has stored a key for. */
export function configuredDrcProviders(keys) {
  return DRC_PROVIDERS.filter((p) => typeof keys?.[p.id] === "string" && keys[p.id]);
}

/**
 * The provider whose key can serve embeddings (client-side RAG), or null —
 * today that means OpenAI; a future embeddings-capable CORS provider joins
 * by declaring an `embed` entry, with no caller change.
 */
export function drcEmbedProvider(keys) {
  return DRC_PROVIDERS.find((p) => p.embed && typeof keys?.[p.id] === "string" && keys[p.id]) || null;
}

/**
 * Embed texts straight from the browser on the user's key. Returns
 * {vectors: number[][], dims, model}; throws on any failure (callers are
 * fail-soft — RAG is a helper, never a reason a send breaks).
 */
export async function drcEmbed(provider, apiKey, texts, { signal, baseUrl } = {}) {
  if (!provider?.embed) throw new Error("This provider serves no embeddings.");
  const timeout =
    signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(30_000) : undefined);
  const res = await fetch((baseUrl || provider.base) + "/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: provider.embed.model,
      input: texts,
      dimensions: provider.embed.dimensions,
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
 */
export function drcChatStream(provider, apiKey, model, messages, { signal, baseUrl, maxTokens } = {}) {
  return fetch((baseUrl || provider.base) + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify(buildDrcPayload(provider, model, messages, { stream: true, maxTokens })),
    signal,
  });
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
 */
export async function drcCompleteJson(provider, apiKey, model, messages, { signal, baseUrl, maxTokens = 1500 } = {}) {
  const timeout = signal || (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(45_000) : undefined);
  const res = await fetch((baseUrl || provider.base) + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify(buildDrcPayload(provider, model, messages, { json: true, maxTokens })),
    signal: timeout,
  });
  if (!res.ok) throw new Error(provider.label + " rejected the request (" + res.status + ").");
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
  const headers = { "content-type": "application/json", authorization: "Bearer " + apiKey };
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
 * The provider's chat-capable model list — live from the user's key, the
 * static fallback when the fetch fails (wrong key still gets a dropdown to
 * try; the send will surface the real error).
 */
export async function listDrcModels(provider, apiKey, { baseUrl } = {}) {
  try {
    const res = await fetch((baseUrl || provider.base) + "/models", {
      headers: { authorization: "Bearer " + apiKey },
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const ids = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => m?.id)
      .filter((id) => typeof id === "string" && provider.modelFilter(id))
      .sort()
      .reverse(); // newest generation first (gpt-5.6 above gpt-5.4)
    if (ids.length) return ids;
  } catch {
    // fall through to the static list
  }
  return [...provider.fallbackModels];
}
