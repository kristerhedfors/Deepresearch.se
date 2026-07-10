// @ts-check
// Fail-soft helpers for the Workers Cache API (caches.default) — the
// cross-request result cache exa.js and googlemaps.js share the pattern of:
// durable across requests in a colo, shared across isolates, TTL'd via
// Cache-Control, no binding needed. Both directions fail soft: any cache
// error just means a live call (read) or an uncached response (write), never
// a failed request. Cache keys are synthetic `.internal` URLs built by each
// caller (they namespace the entries and never leave the isolate).
//
// The hit/miss decision (and its per-caller log line with per-caller fields)
// stays at the call site — these helpers own only the mechanics and the
// `<event>_read_failed` / `<event>_write_failed` warnings, keeping every
// pre-existing log event name intact.

// Reads and JSON-parses a cached entry. Returns the parsed payload, or null
// on a miss, a parse failure, or when the Cache API isn't available (e.g.
// unit tests in Node). `event` is the log-event prefix (e.g. "exa.cache").
/**
 * @param {import('./types.js').Logger} log
 * @param {string} event log-event prefix, e.g. "exa.cache"
 * @param {string} cacheKey synthetic `.internal` URL key
 * @returns {Promise<any | null>}
 */
export async function cacheGet(log, event, cacheKey) {
  const cache = /** @type {any} */ (globalThis).caches?.default;
  if (!cache) return null;
  try {
    const hit = await cache.match(new Request(cacheKey));
    if (!hit) return null;
    return await hit.json();
  } catch (err) {
    log.warn(`${event}_read_failed`, { error: /** @type {any} */ (err)?.message || String(err) });
    return null;
  }
}

// Stores a JSON payload under the key with a max-age TTL. A write failure is
// logged and swallowed — it never affects the response being served.
/**
 * @param {import('./types.js').Logger} log
 * @param {string} event log-event prefix, e.g. "exa.cache"
 * @param {string} cacheKey synthetic `.internal` URL key
 * @param {unknown} value JSON-serializable payload to store
 * @param {number} ttlS max-age TTL in seconds
 * @returns {Promise<void>}
 */
export async function cachePut(log, event, cacheKey, value, ttlS) {
  const cache = /** @type {any} */ (globalThis).caches?.default;
  if (!cache) return;
  try {
    await cache.put(
      new Request(cacheKey),
      new Response(JSON.stringify(value), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${ttlS}`,
        },
      }),
    );
  } catch (err) {
    log.warn(`${event}_write_failed`, { error: /** @type {any} */ (err)?.message || String(err) });
  }
}
