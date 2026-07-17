// @ts-check
// The shared LLM reverse-proxy FORWARDERS — a pure upstream leaf (imports only
// http.js's jsonResponse) behind BOTH server-touching grant surfaces: the
// secure-research-space bundle's /api/proxy/llm/* (src/proxy.js) and the
// consolidated Se/rver-token /api/server-token/llm/* (src/server-grants.js),
// so the two present the exact same catalog and completion behavior.
//
// Charter: the caller owns token VERIFICATION and the quota RESERVE; this
// module owns only the Berget fetch on the SERVER key, the refund-on-failure
// discipline, and the response shaping. Berget-ONLY by design (bounded,
// predictable account exposure — invariant 4's grant exceptions). Keeping it
// a leaf also keeps src/server-grants.js's module graph honest: THE
// SERVER-TOKEN GUARANTEE pins that graph to upstream-only modules, and this
// module drags in no bundle/token/D1 machinery.

import { jsonResponse } from "./http.js";

const LLM_MAX_TOKENS = 8192; // clamp a proxied completion's output ceiling
const LLM_CONNECT_TIMEOUT_MS = 30_000; // bound the upstream connect (streaming)
const LLM_JSON_TIMEOUT_MS = 60_000; // bound a non-streaming completion

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/** @param {Env} env */
const bergetBase = (env) => env.BERGET_URL || "https://api.berget.ai/v1";

/**
 * The thin Berget /models forward — SHARED by the bundle's LLM proxy
 * (src/proxy.js) and the consolidated Se/rver-token LLM endpoint
 * (src/server-grants.js), so the two server-touching grant surfaces present
 * the exact same catalog behavior.
 * Non-metered; the caller owns token verification.
 * @param {Env} env @returns {Promise<Response>}
 */
export async function forwardLlmModels(env) {
  try {
    const res = await fetch(bergetBase(env) + "/models", {
      headers: { authorization: `Bearer ${env.BERGET_API_TOKEN}` },
      signal: AbortSignal.timeout(LLM_CONNECT_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({ data: [] }));
    return jsonResponse(data, res.ok ? 200 : 502);
  } catch {
    return jsonResponse({ data: [] }, 502);
  }
}

/**
 * Forward ONE OpenAI-wire chat completion to Berget on the SERVER key —
 * SHARED by the bundle's LLM proxy (src/proxy.js) and the Se/rver-token LLM
 * endpoint (src/server-grants.js). The caller owns verification and the quota
 * RESERVE; this owns the upstream call, the refund-on-failure discipline
 * (never-connected / upstream-rejected → refund; a mid-stream failure does
 * NOT refund, matching the fail-soft posture), and the response shaping.
 * Re-serializes ONLY known fields onto the server key — the client's
 * Authorization header is never forwarded — and clamps the output ceiling.
 * Berget is OpenAI-compatible, so model/messages/stream/tools/
 * response_format pass straight through.
 * @param {Env} env @param {Logger} log
 * @param {any} body the client's chat-completions body (already validated)
 * @param {{ refund: () => Promise<void>, remainingAfter: () => Promise<number|null>, tagPrefix: string, ids: Record<string, unknown> }} opts
 * @returns {Promise<Response>}
 */
export async function forwardLlmCompletion(env, log, body, opts) {
  const stream = body.stream === true;
  const upstreamBody = {
    model: typeof body.model === "string" ? body.model : undefined,
    messages: body.messages,
    stream,
    max_tokens: Math.min(LLM_MAX_TOKENS, Number(body.max_tokens) > 0 ? Math.floor(Number(body.max_tokens)) : 4096),
    ...(body.response_format ? { response_format: body.response_format } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
  };

  let upstream;
  try {
    upstream = await fetch(bergetBase(env) + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BERGET_API_TOKEN}` },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(stream ? LLM_CONNECT_TIMEOUT_MS : LLM_JSON_TIMEOUT_MS),
    });
  } catch (e) {
    await opts.refund(); // never connected — don't burn quota
    log.warn(`${opts.tagPrefix}_failed`, { ...opts.ids, error: String(/** @type {any} */ (e)?.message || e) });
    return jsonResponse({ error: "The upstream model did not respond." }, 502);
  }
  if (!upstream.ok) {
    await opts.refund();
    const text = await upstream.text().catch(() => "");
    log.warn(`${opts.tagPrefix}_upstream_error`, { ...opts.ids, status: upstream.status });
    return jsonResponse({ error: "The upstream model rejected the request.", detail: text.slice(0, 500) }, 502);
  }
  const remaining = await opts.remainingAfter();
  log.info(`${opts.tagPrefix}_served`, { ...opts.ids, stream, remaining });

  if (stream) {
    // Pipe the upstream SSE straight back — consumeChatStream (server) and the
    // DRC client's parser both read this OpenAI-wire body unchanged.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-proxy-remaining": remaining == null ? "" : String(remaining),
      },
    });
  }
  const data = await upstream.json().catch(() => ({}));
  return jsonResponse({ ...data, remaining }, 200);
}
