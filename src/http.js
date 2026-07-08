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
 * @returns {Response}
 */
export function sseResponse(stream) {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
