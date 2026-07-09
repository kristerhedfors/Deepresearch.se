// Anthropic client (native Messages API), the second LLM provider next to
// Berget (src/berget.js). Enabled by the ANTHROPIC_API_KEY secret: without
// it the models simply don't appear in the catalog and nothing routes here.
//
// Design rule (see the add-llm-provider skill): a provider module adapts
// ITSELF to the Berget/OpenAI-shaped interface the rest of the code speaks —
// `chatCompletion` returns a Response whose body is OpenAI-style SSE (the
// raw Anthropic event stream is transcoded on the fly), so berget.js's
// `consumeChatStream` with all its stall guards, the STREAM_MAX_CHARS
// runaway cap, and pipeline.js's finish_reason dropped-connection check work
// on Anthropic streams completely unchanged. Routing between providers lives
// in src/llm.js; this file never imports pipeline/chat code.

import { parseLooseJson } from "./berget.js";

// ANTHROPIC_URL override exists solely so tests can point at a mock
// (mirroring BERGET_URL); production always uses the default.
const apiBase = (env) => env.ANTHROPIC_URL || "https://api.anthropic.com";
const messagesUrl = (env) => apiBase(env) + "/v1/messages";
const API_VERSION = "2023-06-01";

// Same timeout discipline as berget.js (load-bearing invariant #2: both
// fetch calls time-bounded so a hung backend can't defeat fail-soft).
const JSON_CALL_TIMEOUT_MS = 45_000;
const STREAM_CONNECT_TIMEOUT_MS = 30_000;

// Static catalog. Anthropic's /v1/models endpoint reports capabilities but
// not pricing, and this trio is deliberately curated (all three are current,
// vision-capable, and support the API shape below), so a live fetch buys
// nothing — model IDs and USD per-MTok prices from the claude-api skill
// (cached 2026-06). Sonnet 5 has intro pricing ($2/$10) through 2026-08-31;
// the sticker price is charged for quota accounting — deliberately
// conservative, never under-counting.
const USD_PER_MTOK = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", in: 5, out: 25 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", in: 3, out: 15 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", in: 1, out: 5 },
];

// Quota budgets are EUR (src/quota.js prices catalog entries in EUR/token).
// Anthropic bills USD; this deliberate 1:1 conversion over-counts by however
// much the dollar sits below the euro (~5-15% historically) — conservative
// by design: a quota that trips slightly early beats spend going
// under-counted. Tune here if precise accounting ever matters.
const USD_TO_EUR = 1.0;

const ANTHROPIC_MODEL_IDS = new Set(USD_PER_MTOK.map((m) => m.id));

export function isAnthropicModel(id) {
  return ANTHROPIC_MODEL_IDS.has(id);
}

export function anthropicEnabled(env) {
  return !!env.ANTHROPIC_API_KEY;
}

// Catalog entries in the exact ModelCatalogEntry shape berget.js produces
// (src/types.d.ts) — validation, the UI dropdown, and quota pricing consume
// them with no provider awareness. Empty when the key isn't configured, so
// resolveModel's catalog-membership check keeps the models unreachable.
export function listAnthropicModels(env) {
  if (!anthropicEnabled(env)) return [];
  return USD_PER_MTOK.map((m) => ({
    id: m.id,
    name: m.name,
    pricing: `$${m.in} in / $${m.out} out per 1M tokens`,
    price_in: (m.in / 1e6) * USD_TO_EUR,
    price_out: (m.out / 1e6) * USD_TO_EUR,
    up: true, // no status feed; a genuinely-down model fails over like any provider error
    vision: true, // all three accept image input
  }));
}

// Converts an OpenAI-shaped message array (what the whole app speaks —
// roles user/assistant/system, content string or [{type:"text"|"image_url"}]
// parts) into Anthropic's request shape: system messages hoisted into the
// top-level `system` string, data-URL images re-encoded as base64 source
// blocks, consecutive same-role messages merged (the API requires strict
// user/assistant alternation), empty parts dropped (empty text blocks are
// rejected). Pure — unit-tested in anthropic.test.js.
export function toAnthropicRequest(messages) {
  const system = [];
  const out = [];
  for (const m of messages || []) {
    if (m?.role === "system") {
      const text = typeof m.content === "string" ? m.content : textOfParts(m.content);
      if (text) system.push(text);
      continue;
    }
    const blocks = [];
    if (typeof m?.content === "string") {
      if (m.content) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m?.content)) {
      for (const part of m.content) {
        if (part?.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part?.type === "image_url") {
          const img = dataUrlToImageBlock(part.image_url?.url);
          if (img) blocks.push(img);
        }
      }
    }
    if (!blocks.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  return { system: system.join("\n\n") || undefined, messages: out };
}

function textOfParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

function dataUrlToImageBlock(url) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(url || "");
  if (!m) return null;
  return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
}

// Anthropic stop_reason → OpenAI finish_reason. Anything unmapped passes
// through as-is: pipeline.js only requires a truthy finish_reason to accept
// the stream as complete.
function mapStopReason(reason) {
  return { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" }[reason] || reason;
}

// TransformStream transcoding Anthropic's SSE event vocabulary
// (message_start / content_block_delta / message_delta / message_stop) into
// the OpenAI chunk lines consumeChatStream parses. Usage arrives split
// across events (input_tokens on message_start, output_tokens on
// message_delta) and is re-emitted as one OpenAI-style usage object on the
// final chunk, alongside finish_reason — so the dropped-connection tell
// (stream EOF without finish_reason) keeps working. An `error` event fails
// the stream with a real Error, which surfaces through the reader as a
// normal, catchable rejection.
export function anthropicToOpenAiSse() {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason = null;
  const emit = (controller, obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue; // keep-alive / non-JSON line
        }
        switch (evt.type) {
          case "message_start":
            promptTokens = evt.message?.usage?.input_tokens || 0;
            completionTokens = evt.message?.usage?.output_tokens || 0;
            break;
          case "content_block_delta":
            // Only text reaches the client; thinking deltas (Sonnet 5 runs
            // adaptive thinking by default) are internal and dropped here.
            if (evt.delta?.type === "text_delta" && evt.delta.text) {
              emit(controller, { choices: [{ delta: { content: evt.delta.text } }] });
            }
            break;
          case "message_delta":
            if (typeof evt.usage?.output_tokens === "number") completionTokens = evt.usage.output_tokens;
            if (evt.delta?.stop_reason) finishReason = mapStopReason(evt.delta.stop_reason);
            break;
          case "message_stop":
            emit(controller, {
              choices: [{ delta: {}, finish_reason: finishReason || "stop" }],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            });
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            break;
          case "error":
            controller.error(new Error(`Anthropic stream error: ${evt.error?.message || "unknown"}`));
            break;
        }
      }
    },
  });
}

// Streaming completion — the Anthropic counterpart of berget.js's
// chatCompletion, same contract: returns a Response whose body is OpenAI-
// style SSE; the abort signal bounds only the time to headers. max_tokens is
// higher than Berget's 4096 because Sonnet 5's adaptive thinking (on by
// default, deliberately left on for answer quality) spends from the same
// output budget as the visible answer; the transcoder drops the thinking
// deltas and consumeChatStream's 32k-char cap still bounds the visible text.
export async function chatCompletion(env, messages, { model } = {}) {
  const { system, messages: anthropicMessages } = toAnthropicRequest(messages);
  const payload = {
    model,
    max_tokens: 8192,
    stream: true,
    ...(system ? { system } : {}),
    messages: anthropicMessages,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);
  const resp = await fetch(messagesUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY || "",
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  // Error responses pass through untransformed so callers' .text() sees
  // Anthropic's error body (the same diagnostics path as Berget 4xx/5xx).
  if (!resp.ok || !resp.body) return resp;
  return new Response(resp.body.pipeThrough(anthropicToOpenAiSse()), {
    status: resp.status,
    headers: { "content-type": "text/event-stream" },
  });
}

// Non-streaming JSON completion — the Anthropic counterpart of berget.js's
// completeJson, same contract ({ value, usage, diagnostics }; value null on
// parse failure — callers fall back, never break the chat). Anthropic has no
// generic json_object response_format; the prompts' own JSON-only
// instructions carry the weight and the same tolerant parseLooseJson
// recovers prose-wrapped objects. Thinking is explicitly disabled (accepted
// on all three catalog models) so the JSON phases stay deterministic and
// thinking can't eat the small maxTokens budget.
export async function completeJson(env, messages, { model, maxTokens = 900 } = {}) {
  const { system, messages: anthropicMessages } = toAnthropicRequest(messages);
  const resp = await fetch(messagesUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY || "",
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      thinking: { type: "disabled" },
      ...(system ? { system } : {}),
      messages: anthropicMessages,
    }),
    signal: AbortSignal.timeout(JSON_CALL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Anthropic JSON call failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = (data.content || [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  const { value, parseMode } = parseLooseJson(content);
  return {
    value,
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
    },
    diagnostics: {
      parse_mode: parseMode,
      finish_reason: data.stop_reason ? mapStopReason(data.stop_reason) : null,
      content_length: content.length,
    },
  };
}
