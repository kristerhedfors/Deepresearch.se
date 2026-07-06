// Berget.ai client (OpenAI-compatible chat completions API).
//
// Auth uses the BERGET_API_TOKEN secret. The default model is Mistral Small,
// overridable via the BERGET_MODEL var. See CLAUDE.md ("LLM provider").

// BERGET_URL env override exists solely so local tests can point at a
// mock (like GOOGLE_TOKEN_URL); production always uses the default.
const apiBase = (env) => env.BERGET_URL || "https://api.berget.ai/v1";
const chatUrl = (env) => apiBase(env) + "/chat/completions";
const modelsUrl = (env) => apiBase(env) + "/models";
export const DEFAULT_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506"; // alias: mistral-small

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

export function defaultModel(env) {
  return env.BERGET_MODEL || DEFAULT_MODEL;
}

// Berget's model catalog, filtered to models the chat can use: text models
// supporting streaming + JSON mode (the research pipeline's planning and
// validation calls depend on it). Models Berget reports as down are included
// with `up: false` so the UI can show them greyed out — they become
// selectable automatically once Berget brings them back. Cached per isolate
// to keep /api/models and per-request validation cheap.
let modelsCache = { at: 0, list: null };
const MODELS_TTL_MS = 5 * 60 * 1000;

export async function listModels(env) {
  if (modelsCache.list && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return modelsCache.list;
  }
  const resp = await fetch(modelsUrl(env), {
    headers: { authorization: `Bearer ${env.BERGET_API_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`Berget models fetch failed (${resp.status})`);
  const data = await resp.json();

  const list = (Array.isArray(data.data) ? data.data : [])
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

  modelsCache = { at: Date.now(), list };
  return list;
}

// "€0.30 in / €0.30 out per 1M tokens" — shown as a tooltip in the UI.
function formatPricing(p) {
  if (!p || typeof p.input !== "number" || typeof p.output !== "number") return null;
  const perM = (v) => (v * 1e6).toFixed(2).replace(/\.?0+$/, "");
  const cur = p.currency === "EUR" ? "€" : (p.currency || "") + " ";
  return `${cur}${perM(p.input)} in / ${cur}${perM(p.output)} out per 1M tokens`;
}

// Starts a streaming chat completion. Pass `tools` to enable function
// calling, and `model` to override the default.
//
// The abort signal bounds only the time to receive a RESPONSE (headers) —
// once fetch() settles the timer is cleared, so a legitimately long
// stream can keep being read afterward without getting cut off mid-flight.
export function chatCompletion(env, messages, { tools, model } = {}) {
  const payload = {
    model: model || defaultModel(env),
    stream: true,
    max_tokens: 4096,
    messages,
  };
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }
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
// delta as it arrives, and accumulates tool calls (which stream in fragments,
// addressed by index), usage stats, and the finish reason.
//
// Returns { text, toolCalls, usage, finishReason }.
export async function consumeChatStream(body, onText) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage = null;
  let finishReason = null;
  const toolCalls = []; // index -> { id, type, function: { name, arguments } }

  while (true) {
    const { done, value } = await reader.read();
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

      // Berget appends usage chunks (token counts, then energy/CO2 stats)
      // with an empty `choices` array; merge them for logging.
      if (chunk.usage) usage = { ...(usage || {}), ...chunk.usage };

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        onText(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? 0;
          const slot = (toolCalls[i] ||= {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          });
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.function.name = tc.function.name;
          if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
    }
  }

  return { text, toolCalls: toolCalls.filter(Boolean), usage, finishReason };
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
