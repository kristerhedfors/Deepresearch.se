// Free mode's client-side LLM provider registry — the browser counterpart
// of src/providers.js, for providers whose APIs allow DIRECT cross-origin
// calls from JavaScript (CORS). That property is the admission ticket:
// OpenAI and Groq (GroqCloud) both serve `Access-Control-Allow-Origin: *`
// on their OpenAI-compatible endpoints, so the user's browser can call
// them with the user's own API key and Deepresearch's server is never in
// the request path at all. Providers without browser CORS (Berget,
// Anthropic) cannot join this registry — they'd need a proxy, which is
// exactly what DRC exists to avoid.
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
// (src/openai.js); Groq speaks plain OpenAI chat completions.
export const DRC_PROVIDERS = [
  {
    id: "openai",
    label: "OpenAI",
    base: "https://api.openai.com/v1",
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
];

export function drcProvider(id) {
  return DRC_PROVIDERS.find((p) => p.id === id) || null;
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
// (both providers support response_format json_object — the pipeline's
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
