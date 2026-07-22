// @ts-check
// The response-helper leaf every module shares (baseplate-worker step 3).
// Imports nothing. Codifies the content-type + cache conventions in one place.

/**
 * @param {unknown} obj
 * @param {number} [status]
 * @param {Record<string,string>} [extraHeaders]
 * @returns {Response}
 */
export function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

/**
 * @param {string} html
 * @param {number} [status]
 * @param {Record<string,string>} [extraHeaders]
 * @returns {Response}
 */
export function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders },
  });
}

/**
 * A streaming Server-Sent-Events response. `no-transform` keeps proxies from
 * buffering the stream (which would defeat token-by-token rendering).
 * @param {ReadableStream} stream
 * @param {Record<string,string>} [extraHeaders]
 * @returns {Response}
 */
export function sseResponse(stream, extraHeaders = {}) {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      ...extraHeaders,
    },
  });
}

/**
 * @param {string} text
 * @param {number} [status]
 * @returns {Response}
 */
export function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
