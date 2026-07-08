// Berget.ai client (OpenAI-compatible chat completions API).
//
// Auth uses the BERGET_API_TOKEN secret. The default model is Mistral Small,
// overridable via the BERGET_MODEL var. See CLAUDE.md ("LLM provider").

// BERGET_URL env override exists solely so local tests can point at a
// mock (like GOOGLE_TOKEN_URL); production always uses the default.
const apiBase = (env) => env.BERGET_URL || "https://api.berget.ai/v1";
const chatUrl = (env) => apiBase(env) + "/chat/completions";
const modelsUrl = (env) => apiBase(env) + "/models";
const embeddingsUrl = (env) => apiBase(env) + "/embeddings";
export const DEFAULT_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506"; // alias: mistral-small
// Embedding model for the document-RAG feature (src/rag.js). Berget hosts
// intfloat/multilingual-e5-large (1024 dims, cosine, €0.03/1M tokens as of
// 2026-07) — the plain (non-instruct) variant, whose input convention is
// the well-defined "query: …" / "passage: …" prefix pair applied
// server-side in src/rag.js. Overridable via BERGET_EMBED_MODEL, but note
// the Vectorize index is created with a fixed dimension count — switching
// to a model with different dimensions requires recreating the index.
export const DEFAULT_EMBED_MODEL = "intfloat/multilingual-e5-large";
export const EMBED_DIMS = 1024;

export function embedModel(env) {
  return env.BERGET_EMBED_MODEL || DEFAULT_EMBED_MODEL;
}

// Neither Berget call below had a timeout until a live model-eval battery
// (2026-07-06, round 2) surfaced requests that silently died mid-pipeline
// for a few models: Workers Logs showed several phases logging normally
// (info level), then NOTHING — no warn/error, no chat.complete — for
// requests that succeed when simply re-run. That signature is consistent
// with an awaited fetch() that never settles: nothing throws for phase()'s
// try/catch to catch, so the fail-soft design this pipeline is built
// around never engages. These bound the hang into a normal, catchable
// error instead.
const JSON_CALL_TIMEOUT_MS = 45_000;
const STREAM_CONNECT_TIMEOUT_MS = 30_000;

// A round 4 model-eval battery (cybersecurity queries, mid-long time
// budget) found several models' synthesis stream just never completing:
// Workers Logs showed the request killed with outcome "exceededCpu" while
// still inside the synth phase, no chat.stream_failed, nothing — the
// client sees a clean EOF with 0 chars, "ok: true". `chatCompletion`
// already requests `max_tokens: 4096`, but Berget doesn't always honor it
// (the user's own account of Berget's infra: models run on hardware known
// to misbehave — a degenerate/repetitive generation that doesn't hit a
// natural stop can keep emitting well past the requested cap). Every
// legitimate synthesis answer observed across all eval rounds has stayed
// under ~13,000 characters; this is a generous safety valve, not a content
// limit — it exists purely so a runaway generation gets cut off by OUR
// code (a clean, catchable error) before Cloudflare's platform-level CPU
// limit kills the whole isolate with no error surfaced at all.
const STREAM_MAX_CHARS = 32_000;

export function defaultModel(env) {
  return env.BERGET_MODEL || DEFAULT_MODEL;
}

// True when the admin's configured site default model (src/config.js) is
// still present in the catalog and up — the only condition under which
// callers should treat it as authoritative over the Worker's built-in
// default. Shared by chat.js (applying it to an unset request) and
// user-api.js (reporting it as /api/models' `default`).
export function adminDefaultModelValid(config, catalog) {
  return !!(config.default_model && catalog?.some((m) => m.id === config.default_model && m.up));
}

// Berget's model catalog, filtered to models the chat can use: text models
// supporting streaming + JSON mode (the research pipeline's planning and
// validation calls depend on it). Models Berget reports as down are included
// with `up: false` so the UI can show them greyed out — they become
// selectable automatically once Berget brings them back. Cached per isolate
// to keep /api/models and per-request validation cheap.
let modelsCache = { at: 0, list: null, raw: null };
const MODELS_TTL_MS = 5 * 60 * 1000;

// One catalog fetch feeds both views: `list` (chat-capable text models, the
// shape the UI and validation consume) and `raw` (every catalog entry as
// Berget returns it — needed to price non-chat models like the embedding
// model, which the text-only filter below would otherwise hide).
async function fetchCatalog(env) {
  if (modelsCache.list && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache;
  }
  const resp = await fetch(modelsUrl(env), {
    headers: { authorization: `Bearer ${env.BERGET_API_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`Berget models fetch failed (${resp.status})`);
  const data = await resp.json();
  const raw = Array.isArray(data.data) ? data.data : [];

  const list = raw
    .filter(
      (m) =>
        m.model_type === "text" &&
        m.capabilities?.streaming &&
        m.capabilities?.json_mode,
    )
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      pricing: formatPricing(m.pricing),
      // Raw EUR-per-token prices, kept for quota cost accounting.
      price_in: typeof m.pricing?.input === "number" ? m.pricing.input : 0,
      price_out: typeof m.pricing?.output === "number" ? m.pricing.output : 0,
      up: m.status?.up !== false,
      vision: m.capabilities?.vision === true,
    }));

  modelsCache = { at: Date.now(), list, raw };
  return modelsCache;
}

export async function listModels(env) {
  return (await fetchCatalog(env)).list;
}

// Raw catalog entry lookup by id or alias — used to price embedding calls
// for quota accounting. Returns null (never throws) when the catalog is
// unreachable or the model unknown: cost accounting degrades to zero-cost
// rather than blocking the feature.
export async function rawModelEntry(env, id) {
  try {
    const { raw } = await fetchCatalog(env);
    return raw.find((m) => m.id === id || m.aliases?.includes(id)) || null;
  } catch {
    return null;
  }
}

// "€0.30 in / €0.30 out per 1M tokens" — shown as a tooltip in the UI.
function formatPricing(p) {
  if (!p || typeof p.input !== "number" || typeof p.output !== "number") return null;
  const perM = (v) => (v * 1e6).toFixed(2).replace(/\.?0+$/, "");
  const cur = p.currency === "EUR" ? "€" : (p.currency || "") + " ";
  return `${cur}${perM(p.input)} in / ${cur}${perM(p.output)} out per 1M tokens`;
}

// Starts a streaming chat completion. `model` overrides the default.
//
// The abort signal bounds only the time to receive a RESPONSE (headers) —
// once fetch() settles the timer is cleared, so a legitimately long
// stream can keep being read afterward without getting cut off mid-flight.
export function chatCompletion(env, messages, { model } = {}) {
  const payload = {
    model: model || defaultModel(env),
    stream: true,
    max_tokens: 4096,
    messages,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);
  return fetch(chatUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.BERGET_API_TOKEN}`,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

// Consumes one OpenAI-style SSE response body. Calls `onText` for each text
// delta as it arrives, and accumulates usage stats and the finish reason.
//
// Optional guards — the connect timeout above deliberately stops covering a
// stream once headers arrive, so a backend that ACCEPTS the request and then
// stalls mid-generation hangs the read loop forever (the same silent-hang
// family as the round-2 finding, one layer later). `idleMs` bounds the wait
// for each next chunk; `maxMs` bounds the whole consumption. Either tripping
// cancels the reader and THROWS a normal, catchable error. Both default OFF
// so the answer-synthesis path (where a long silent think can be legitimate
// on a reasoning model) is unchanged — helper calls that run BEFORE the
// pipeline (the Street View vision-describe, which blocks everything
// downstream) opt in.
//
// Returns { text, usage, finishReason }.
export async function consumeChatStream(body, onText, { idleMs = 0, maxMs = 0 } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let finishReason = null;
  const startedAt = Date.now();

  const nextChunk = async () => {
    if (!idleMs && !maxMs) return reader.read();
    const budgets = [];
    if (idleMs) budgets.push(idleMs);
    if (maxMs) budgets.push(maxMs - (Date.now() - startedAt));
    const waitMs = Math.min(...budgets);
    if (waitMs <= 0) {
      reader.cancel().catch(() => {});
      throw new Error(`Berget stream exceeded its ${maxMs}ms total budget — treating as hung`);
    }
    let timer;
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Berget stream produced nothing for ${waitMs}ms — treating as hung`)),
            waitMs,
          );
        }),
      ]);
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  while (true) {
    const { done, value } = await nextChunk();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue; // keep-alive / non-JSON line
      }

      // Berget appends a token-usage chunk with an empty `choices` array;
      // merge it in for logging/accounting.
      if (chunk.usage) usage = { ...(usage || {}), ...chunk.usage };

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        onText(delta.content);
        if (text.length > STREAM_MAX_CHARS) {
          await reader.cancel();
          throw new Error(
            `Berget stream exceeded the ${STREAM_MAX_CHARS}-char safety cap — likely a runaway/degenerate generation on the backend; aborted before it could exhaust the Worker's CPU budget`,
          );
        }
      }
    }
  }

  return { text, usage, finishReason };
}

// Non-streaming completion that asks Berget for a JSON object and parses it.
// Used by the research pipeline's triage / gap-check / validation phases.
// Returns { value, usage, diagnostics } — value is null when parsing fails
// (callers must fall back gracefully; a broken helper phase must never break
// the chat). diagnostics is metadata only (no content) for per-model
// observability: how the JSON was obtained and whether output was truncated.
export async function completeJson(env, messages, { model, maxTokens = 900 } = {}) {
  const resp = await fetch(chatUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.BERGET_API_TOKEN}`,
    },
    body: JSON.stringify({
      model: model || defaultModel(env),
      stream: false,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages,
    }),
    signal: AbortSignal.timeout(JSON_CALL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Berget JSON call failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content || "";
  const { value, parseMode } = parseLooseJson(content);
  return {
    value,
    usage: data.usage || null,
    diagnostics: {
      parse_mode: parseMode, // "strict" | "repaired" | "failed"
      finish_reason: choice?.finish_reason || null,
      content_length: content.length,
    },
  };
}

// Tolerant JSON extraction — models occasionally wrap the object in prose or
// code fences despite json_mode. Returns { value, parseMode }: "strict" when
// the whole string parsed as-is, "repaired" when a balanced {...} object had
// to be extracted from surrounding text, "failed" when neither worked.
function parseLooseJson(s) {
  try {
    return { value: JSON.parse(s), parseMode: "strict" };
  } catch {
    // fall through to embedded-object extraction
  }
  const extracted = extractFirstBalancedObject(String(s));
  if (extracted != null) {
    try {
      return { value: JSON.parse(extracted), parseMode: "repaired" };
    } catch {
      // give up
    }
  }
  return { value: null, parseMode: "failed" };
}

// Embeddings (OpenAI-compatible POST /v1/embeddings). Used by the document
// RAG feature: the client indexes large attachments through POST /api/embed
// and src/rag.js embeds queries server-side. Same timeout discipline as
// completeJson — an unbounded fetch to Berget has already bitten this
// project once (see the round 2 note above).
const EMBED_TIMEOUT_MS = 60_000;

export async function embedTexts(env, texts, { model } = {}) {
  const resp = await fetch(embeddingsUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.BERGET_API_TOKEN}`,
    },
    body: JSON.stringify({
      model: model || embedModel(env),
      input: texts,
    }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Berget embeddings call failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const rows = Array.isArray(data.data) ? data.data : [];
  if (rows.length !== texts.length) {
    throw new Error(`Berget embeddings returned ${rows.length} vectors for ${texts.length} inputs`);
  }
  // The API is allowed to return rows out of order; `index` is authoritative.
  const vectors = new Array(texts.length);
  for (const row of rows) {
    if (!Array.isArray(row?.embedding)) throw new Error("Berget embeddings returned a malformed vector");
    vectors[row.index ?? rows.indexOf(row)] = row.embedding;
  }
  return { vectors, usage: data.usage || null, model: data.model || model || embedModel(env) };
}

// Brace-counting scan for the first balanced {...} block, string-aware so
// braces inside quoted strings don't throw off the depth count. Safer than a
// greedy regex when a model emits more than one JSON-shaped chunk (e.g.
// reasoning prose containing an example object, followed by the real one).
function extractFirstBalancedObject(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
