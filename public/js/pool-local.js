// @ts-check
// The LOCAL-MODEL half of shared compute, shared by BOTH tiers.
//
// A sharer lends the OpenAI-compatible server running on their own machine
// (Ollama / LM Studio / llama.cpp). Whichever tab is doing the lending — a
// Se/cure tab or the signed-in Se/rver app (feedback #31, 2026-07-26: sharing
// is not a Se/cure-only feature) — the two things it must do against that
// server are identical: list what the server has, and run one job against it.
// They live here once so the tiers cannot drift on the wire they speak to a
// user's own machine.
//
// Dependency-injected fetch, no DOM, no storage — Node-testable.

/** The non-chat modalities a local catalog lists beside its chat models.
 * Same curation the `local` DRC provider applies (drc-providers.js). */
const NON_CHAT = /(embed|whisper|rerank|guard|tts|moderation)/i;

/** How long a single local completion may take before the loop gives up on it.
 * Generous: a big model on a laptop CPU is slow, and the broker's job TTL is
 * the real ceiling. */
export const LOCAL_JOB_TIMEOUT_MS = 180_000;

/**
 * Normalize a user-typed local-server base URL: trim, drop trailing slashes.
 * Returns "" for anything empty so callers get one falsy shape to test.
 * @param {string | null | undefined} url
 * @returns {string}
 */
export function normalizePoolLocalUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/**
 * Ask a local OpenAI-compatible server what it serves. Returns chat-capable
 * model ids only. Never throws: an unreachable server advertises NOTHING,
 * which the broker reads as "accepts anything" — the same fail-soft posture
 * the provider loop already takes (pool-provider.js advertisedModels).
 * @param {string} baseUrl
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string[]>}
 */
export async function listLocalPoolModels(baseUrl, fetchFn) {
  const base = normalizePoolLocalUrl(baseUrl);
  if (!base) return [];
  const f = fetchFn || fetch;
  try {
    const res = await f(base + "/models");
    if (!res.ok) return [];
    const data = await res.json();
    /** @type {any[]} */
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list
      .map((/** @type {any} */ m) => (typeof m === "string" ? m : m && typeof m.id === "string" ? m.id : ""))
      .filter((/** @type {string} */ id) => id && !NON_CHAT.test(id));
  } catch {
    return [];
  }
}

/**
 * Run ONE pooled job against the local server. `body` is the plain OpenAI
 * chat-completions body the provider loop already stripped of the DRSC/1 wire
 * marker (pool-core.js poolRequestToOpenAiBody) — nothing is added to it here,
 * so what reaches the user's own machine is exactly what the broker relayed.
 *
 * THROWS on any failure. That is the contract the provider loop wants: a
 * thrown job is reported back as `upstream_error`, the consumer's reserved
 * unit is refunded, and the loop keeps serving (pool-provider.js).
 * @param {string} baseUrl
 * @param {any} body
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ response: any, usage?: any }>}
 */
export async function runLocalPoolJob(baseUrl, body, opts = {}) {
  const base = normalizePoolLocalUrl(baseUrl);
  if (!base) throw new Error("no local server URL is set");
  const f = opts.fetchFn || fetch;
  // A hung local server must not wedge the loop forever — bound it, and still
  // honor the caller's own abort (the toggle going off).
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl
    ? setTimeout(() => ctl.abort(), opts.timeoutMs || LOCAL_JOB_TIMEOUT_MS)
    : null;
  if (ctl && opts.signal) opts.signal.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const res = await f(base + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : opts.signal,
    });
    if (!res.ok) throw new Error("local server answered " + res.status);
    const data = await res.json();
    return { response: data, usage: data?.usage };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
