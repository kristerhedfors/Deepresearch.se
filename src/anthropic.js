// @ts-check
// Anthropic (Claude) provider client — the second LLM provider alongside
// Berget (src/berget.js). Raw fetch against the Anthropic Messages API —
// deliberately no SDK: the Worker has no build step and no runtime deps
// (CLAUDE.md invariant 5), and the only surface needed is streaming chat
// plus a rarely-used JSON completion.
//
// The load-bearing trick is the STREAM ADAPTER (`openAiStreamFromAnthropic`):
// it re-emits Anthropic's SSE event vocabulary (message_start /
// content_block_delta / message_delta / message_stop) as OpenAI-style SSE
// (`choices[0].delta.content`, `finish_reason`, a usage chunk, `[DONE]`), so
// the pipeline's shared consumer (berget.js `consumeChatStream`), its
// idle/total-budget guards, the finish_reason dropped-connection check, the
// empty-completion retry, and the model failover in pipeline.js all work
// UNCHANGED on Claude streams. New providers should follow this pattern:
// adapt at the wire, don't fork the pipeline.
//
// Feature-gated on the ANTHROPIC_API_KEY secret (a dashboard secret, same
// convention as BERGET_API_TOKEN — never in the repo): absent, the models
// don't appear in the catalog and nothing routes here (src/providers.js).

import { eurPerTokenFromUsd, formatPricing, parseLooseJson } from "./berget.js";

// ANTHROPIC_URL override exists solely so tests can point at a mock (the
// same convention as BERGET_URL); production always uses the default.
/** @param {import('./types.js').Env} env */
const apiBase = (env) => String(env.ANTHROPIC_URL || "https://api.anthropic.com");
/** @param {import('./types.js').Env} env */
const messagesUrl = (env) => apiBase(env) + "/v1/messages";

// Same timeout discipline as berget.js — an unbounded fetch to an LLM
// backend has bitten this project before (berget.js round-2 note): bound
// the connect phase into a normal, catchable error.
const STREAM_CONNECT_TIMEOUT_MS = 30_000;
const JSON_CALL_TIMEOUT_MS = 45_000;

// Matches berget.js's chatCompletion max_tokens — the synthesis answer cap.
const MAX_TOKENS = 4096;

// Anthropic prices are USD per 1M tokens; the quota system accounts in EUR
// — converted at the fixed shared rate documented in berget.js
// (USD_TO_EUR / eurPerTokenFromUsd, shared with src/openai.js).

// Static catalog — Anthropic's /v1/models carries no pricing, and the three
// offered models are a deliberate product choice (opus/sonnet/haiku), so a
// live fetch would add a failure mode without adding information. Prices
// are the standard (non-introductory) USD per-1M rates as of 2026-07.
// All three models accept image input (vision) and stream.
const MODELS = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", usd_in: 5, usd_out: 25 },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", usd_in: 3, usd_out: 15 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", usd_in: 1, usd_out: 5 },
];

// Anthropic model ids are a distinct namespace (claude-*); Berget ids are
// vendor/model paths (mistralai/…). The prefix is the routing key
// src/providers.js dispatches on.
/** @param {unknown} id */
export function isAnthropicModel(id) {
  return typeof id === "string" && id.startsWith("claude-");
}

/** @param {import('./types.js').Env} env */
export function anthropicConfigured(env) {
  return !!env.ANTHROPIC_API_KEY;
}

// Catalog entries in the exact shape berget.js's listModels produces
// (ModelCatalogEntry), so validation, the UI dropdown, and quota pricing
// consume them with no special-casing. Empty when the key isn't configured
// — the feature is invisible, same as Shodan/Maps without their secrets.
/**
 * @param {import('./types.js').Env} env
 * @returns {import('./types.js').ModelCatalogEntry[]}
 */
export function anthropicModels(env) {
  if (!anthropicConfigured(env)) return [];
  return MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    pricing: formatPricing({ input: eurPerTokenFromUsd(m.usd_in), output: eurPerTokenFromUsd(m.usd_out), currency: "EUR" }),
    price_in: eurPerTokenFromUsd(m.usd_in),
    price_out: eurPerTokenFromUsd(m.usd_out),
    up: true,
    vision: true,
    provider: "anthropic",
  }));
}

/** @param {import('./types.js').Env} env */
function headers(env) {
  return {
    "content-type": "application/json",
    "x-api-key": String(env.ANTHROPIC_API_KEY || ""),
    "anthropic-version": "2023-06-01",
  };
}

// Claude Sonnet 5 runs ADAPTIVE thinking when the `thinking` param is
// omitted (a silent default — unlike Opus 4.8 / Haiku 4.5, where omission
// means no thinking). Thinking spends output tokens inside max_tokens and
// adds a long silent pause before the first text delta — both bad fits for
// this pipeline's time-budget planning and its 60s idle guard — so it is
// explicitly disabled to match the other models' behavior. Revisit with a
// rubric-bench A/B (tests/eval-bench.mjs) if synthesis quality on Sonnet
// looks worth the latency.
/** @param {string | undefined} model */
function thinkingConfigFor(model) {
  return model === "claude-sonnet-5" ? { type: "disabled" } : null;
}

// data:image/jpeg;base64,… → its media type + raw base64 payload.
const DATA_URL_RE = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

// Converts the project's OpenAI-style message array into an Anthropic
// Messages API payload. Pure and exported for unit tests. Differences it
// bridges: `system` turns are a top-level field (not messages); image parts
// are base64 source blocks (not data-URL image_url parts); consecutive
// same-role messages are merged (defensive — appended context blocks and
// pipeline scaffolding can produce them, and Anthropic historically
// rejected non-alternating turns).
/**
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number, stream?: boolean }} opts
 */
export function toAnthropicPayload(messages, { model, maxTokens = MAX_TOKENS, stream = false } = {}) {
  const system = [];
  /** @type {Array<{role: string, content: any[]}>} */
  const out = [];
  for (const m of messages || []) {
    if (m?.role === "system") {
      const text = partsText(m.content);
      if (text) system.push(text);
      continue;
    }
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = toContentBlocks(m?.content);
    if (!content.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...content);
    else out.push({ role, content });
  }
  /** @type {Record<string, unknown>} */
  const payload = { model, max_tokens: maxTokens, stream, messages: out };
  const sys = system.join("\n\n");
  if (sys) payload.system = sys;
  const thinking = thinkingConfigFor(model);
  if (thinking) payload.thinking = thinking;
  return payload;
}

/** @param {import('./types.js').MessageContent | undefined} content */
function partsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((p) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : []))
    .join("\n");
}

/** @param {import('./types.js').MessageContent | undefined} content */
function toContentBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
      const m = DATA_URL_RE.exec(part.image_url.url);
      // Only data:image URLs pass validation.js, so a non-match is a
      // malformed part — skip it rather than erroring the request.
      if (m) blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
  }
  return blocks;
}

// Anthropic stop_reason → OpenAI finish_reason. The pipeline only checks
// truthiness (a missing finish_reason marks a dropped connection), but the
// mapped values keep logs/diagnostics reading consistently.
/** @type {Record<string, string>} */
const STOP_REASON_MAP = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
};

// Wraps an Anthropic SSE body in a ReadableStream that emits the SAME wire
// format berget.js's consumeChatStream parses. Event mapping:
//   message_start          → remember input_tokens (prompt side of usage)
//   content_block_delta    → `{choices:[{delta:{content}}]}` per text_delta
//                            (thinking/tool deltas are dropped — text only)
//   message_delta          → finish_reason chunk + merged usage totals
//   message_stop           → `[DONE]`
//   error                  → the stream ERRORS (reader.read() rejects), so
//                            the consumer's try/catch and the pipeline's
//                            stall/retry handling engage normally
//   ping / block start-stop→ ignored
/** @param {ReadableStream} body */
export function openAiStreamFromAnthropic(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  return new ReadableStream({
    // Loops until at least one chunk is enqueued (or the source ends):
    // a pull that enqueues nothing is NOT re-invoked by the stream
    // machinery, so events that map to zero output (message_start, ping,
    // block start/stop) would otherwise deadlock the read.
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
            controller.error(new Error(`Anthropic stream error: ${evt.error?.message || "unknown"}`));
            return;
          }
          for (const chunk of oaiChunksFromEvent(evt, usage)) {
            controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
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

// One Anthropic event → zero or more OpenAI-style SSE data payloads
// (pre-serialized strings; "[DONE]" is the literal terminator). Mutates
// the shared usage accumulator. Exported for unit tests.
/**
 * @param {any} evt one parsed Anthropic SSE event
 * @param {import('./types.js').TokenTotals} usage shared accumulator
 * @returns {string[]} pre-serialized OpenAI-style data payloads
 */
export function oaiChunksFromEvent(evt, usage) {
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
      return [];
    }
    case "message_delta": {
      if (typeof evt.usage?.output_tokens === "number") usage.completion_tokens = evt.usage.output_tokens;
      const stop = evt.delta?.stop_reason;
      if (!stop) return [];
      return [
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: STOP_REASON_MAP[stop] || String(stop) }],
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

// Streaming chat completion, same calling contract as berget.js's
// chatCompletion: resolves to a Response-shaped object with `ok`, `status`,
// `body` (already adapted to OpenAI-style SSE) and `text()`. A non-2xx or
// bodyless response is returned AS-IS (the real Response), so callers'
// existing error paths (`upstream.text()` for the detail) work unchanged.
// The abort signal bounds only the connect phase, exactly like Berget's.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string }} opts
 */
export async function anthropicChatCompletion(env, messages, { model } = {}) {
  const payload = toAnthropicPayload(messages, { model, stream: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_CONNECT_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(messagesUrl(env), {
      method: "POST",
      headers: headers(env),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok || !resp.body) return resp;
  return {
    ok: true,
    status: resp.status,
    body: openAiStreamFromAnthropic(resp.body),
    text: async () => "",
  };
}

// Non-streaming JSON completion, same contract as berget.js's completeJson
// ({ value, usage, diagnostics }; value null on parse failure — callers
// fall back gracefully). Normally UNUSED: the JSON planning phases run on
// Berget's fixed DEFAULT_MODEL (split model routing — CLAUDE.md invariant
// 3). This exists so the dispatch stays total if a deployment ever routes
// JSON to a Claude model (e.g. Berget catalog outage fallback). Anthropic
// has no response_format param; the prompts already demand JSON-only and
// parseLooseJson repairs prose-wrapped objects.
/**
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Conversation} messages
 * @param {{ model?: string, maxTokens?: number }} opts
 */
export async function anthropicCompleteJson(env, messages, { model, maxTokens = 900 } = {}) {
  const payload = toAnthropicPayload(messages, { model, maxTokens, stream: false });
  const resp = await fetch(messagesUrl(env), {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(JSON_CALL_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`Anthropic JSON call failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = /** @type {any} */ (await resp.json());
  /** @type {any[]} */
  const blocks = Array.isArray(data.content) ? data.content : [];
  const content = blocks
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
      finish_reason: data.stop_reason || null,
      content_length: content.length,
    },
  };
}
