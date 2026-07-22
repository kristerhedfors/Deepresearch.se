// @ts-check
// The LLM provider client — Berget (OpenAI-compatible). Dependency exception #1.
// Two calls, both time-bounded (an unbounded fetch that never settles would
// defeat the pipeline's fail-soft contract, PA-2): a JSON-mode completion for
// the planning phase, and a streamed completion for synthesis.
//
// Auth is the BERGET_API_TOKEN secret, swapped in server-side — it NEVER
// reaches the browser and NEVER appears in a log (PA-4).

const API_BASE = "https://api.berget.ai/v1";
const JSON_TIMEOUT_MS = 45_000;
const STREAM_TIMEOUT_MS = 120_000;

/** @param {any} env */
const chatUrl = (env) => (env.BERGET_API_BASE || API_BASE) + "/chat/completions";

/**
 * One JSON-mode completion. Returns the parsed object, or null on any failure
 * (the caller degrades — never throws into the request).
 * @param {any} env
 * @param {import('./log.js').Logger} log
 * @param {{ model: string, messages: any[], maxTokens?: number, temperature?: number }} req
 * @returns {Promise<any|null>}
 */
export async function jsonCompletion(env, log, req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), JSON_TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(chatUrl(env), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.BERGET_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 700,
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      log.warn("berget.json_http", { status: resp.status, ms: Date.now() - started });
      return null;
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    log.debug("berget.json_ok", { ms: Date.now() - started });
    return safeParseJson(content);
  } catch (e) {
    log.warn("berget.json_error", { message: errMsg(e), ms: Date.now() - started });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A streamed completion. Yields text deltas. Time-bounded; on any error it ends
 * the generator (the pipeline emits what it has and finishes cleanly).
 * @param {any} env
 * @param {import('./log.js').Logger} log
 * @param {{ model: string, messages: any[], maxTokens?: number, temperature?: number }} req
 * @returns {AsyncGenerator<string, void, void>}
 */
export async function* streamCompletion(env, log, req) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(chatUrl(env), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.BERGET_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 1500,
        stream: true,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok || !resp.body) {
      log.warn("berget.stream_http", { status: resp.status });
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) yield delta;
        } catch {
          // torn/partial frame — skip, never throw
        }
      }
    }
    log.debug("berget.stream_ok", { ms: Date.now() - started });
  } catch (e) {
    log.warn("berget.stream_error", { message: errMsg(e), ms: Date.now() - started });
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} s @returns {any|null} tolerant JSON parse (strips code fences) */
export function safeParseJson(s) {
  const trimmed = String(s).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Salvage the first {...} block a chatty model may wrap around the JSON.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** @param {unknown} e */
function errMsg(e) {
  return e && typeof e === "object" && "message" in e ? String(/** @type {any} */ (e).message) : String(e);
}
