// @ts-check
// Small request/response helpers shared across modules.

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
 * Read a request's JSON body, or hand back the 400 to return instead.
 *
 * Twelve endpoint handlers carried this seven-line try/catch verbatim, down to
 * the wording of the rejection — the same shape of duplication
 * `enforceQuotaAndReserve` (src/endpoint-gate.js) was cut from, and answered the
 * same way: the helper returns the pair rather than throwing, so the caller
 * keeps its own early return and the control flow at each site is unchanged.
 *
 *   const { body, response } = await readJsonBody(request);
 *   if (response) return response;
 *
 * Deliberately NOT a `body ?? {}` fallback: a handler that cannot parse its
 * body must say so, not proceed over an empty object. The endpoints that DO
 * want the tolerant reading (the token endpoints' `.catch(() => ({}))`, where
 * a missing field is already its own 400) keep it and do not call this.
 * @param {Request} request
 * @returns {Promise<{ body: any, response: Response | null }>}
 */
export async function readJsonBody(request) {
  try {
    return { body: await request.json(), response: null };
  } catch {
    return { body: null, response: jsonResponse({ error: "Request body must be valid JSON." }, 400) };
  }
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
