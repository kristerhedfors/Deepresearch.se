// @ts-check
// Small response helpers shared across modules.

/**
 * JSON response with the correct content-type and any extra headers.
 * @param {unknown} obj serialized as the body
 * @param {number} [status]
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
export function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

/**
 * Wraps a stream as a text/event-stream response for SSE.
 * @param {ReadableStream} stream
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Response}
 */
export function sseResponse(stream, extraHeaders = {}) {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      ...extraHeaders,
    },
  });
}

/**
 * HTML response with the correct content-type.
 * @param {string} html
 * @param {number} [status]
 * @returns {Response}
 */
export function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Plain-text response (the `?format=text` renderings the admin loop tools read).
 * @param {string} text
 * @returns {Response}
 */
export function textResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
