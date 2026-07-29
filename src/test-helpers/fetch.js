// @ts-check
// A shared outbound-fetch recorder for the unit suite.
//
// Thirteen test files assign `globalThis.fetch` directly; two wrap it in a
// local `mockFetch`. None share a request recorder, so assertions about WHAT
// WAS SENT UPSTREAM are written differently in every file — and invariant 4's
// "outbound requests to third parties carry the minimum (a query, a
// coordinate, a host) — never the conversation, filename, or identity" is
// asserted ad hoc where it is asserted at all.
//
// This module makes that property directly testable: every outbound request is
// captured with its URL, method, headers and body, and `assertNoneCarry()`
// scans all of them for strings that must never leave.

/**
 * @typedef {object} RecordedRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string,string>} headers lowercased header names
 * @property {string} body raw request body ("" when there is none)
 * @property {string} host
 */

/**
 * @typedef {RegExp | string | ((url: string) => boolean)} UrlMatcher
 */

/**
 * @param {UrlMatcher} matcher
 * @param {string} url
 */
function urlMatches(matcher, url) {
  if (typeof matcher === "function") return matcher(url);
  if (typeof matcher === "string") return url.includes(matcher);
  return matcher.test(url);
}

/**
 * Build a `fetch` stub that records every call.
 *
 * Routes are `[matcher, responder]` pairs; `responder` may be a `Response`, a
 * plain object (sent as JSON), a string (sent as text), or a function of the
 * recorded request returning any of those. An unmatched request gets 404 —
 * loudly enough to notice, without throwing, so fail-soft paths still exercise.
 *
 * @param {Array<[UrlMatcher, unknown]>} [routes]
 * @returns {any} the stub, with `.requests` and helpers attached
 */
export function fakeFetch(routes = []) {
  /** @type {RecordedRequest[]} */
  const requests = [];

  /**
   * @param {any} input
   * @param {any} [init]
   */
  const impl = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = req.url;
    /** @type {Record<string,string>} */
    const headers = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    let body = "";
    try {
      body = await req.clone().text();
    } catch {
      body = "";
    }
    const rec = { url, method: req.method, headers, body, host: new URL(url).host };
    requests.push(rec);

    for (const [matcher, responder] of routes) {
      if (!urlMatches(matcher, url)) continue;
      const out = typeof responder === "function" ? await responder(rec) : responder;
      if (out instanceof Response) return out;
      if (typeof out === "string") return new Response(out, { status: 200 });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "no route in fakeFetch", url }), { status: 404 });
  };

  /** Every request that went out, in order. */
  impl.requests = requests;
  /** Distinct hosts contacted, in first-contact order. */
  impl.hosts = () => [...new Set(requests.map((r) => r.host))];
  /**
   * @param {UrlMatcher} matcher
   * @returns {RecordedRequest[]}
   */
  impl.matching = (matcher) => requests.filter((r) => urlMatches(matcher, r.url));
  /**
   * Assert no outbound request carried any of these strings anywhere — URL,
   * headers or body. The mechanical form of invariant 4's minimum-disclosure
   * rule; also how "secrets never appear" gets checked at a seam.
   * @param {string[]} forbidden
   * @param {(msg: string) => never | void} [fail] injected so the caller's
   *   assert library produces the failure
   */
  impl.assertNoneCarry = (forbidden, fail) => {
    for (const r of requests) {
      const haystack = `${r.url}\n${JSON.stringify(r.headers)}\n${r.body}`;
      for (const needle of forbidden) {
        if (!needle) continue;
        if (haystack.includes(needle)) {
          const msg = `outbound ${r.method} ${r.url} carried forbidden value ${JSON.stringify(needle)}`;
          if (fail) return fail(msg);
          throw new Error(msg);
        }
      }
    }
    return true;
  };
  /** Forget every recorded request. */
  impl.reset = () => {
    requests.length = 0;
    return impl;
  };
  return impl;
}

/**
 * Install a `fakeFetch` as `globalThis.fetch` for the duration of `fn`,
 * restoring the real one afterwards even if `fn` throws.
 *
 * @template T
 * @param {Array<[UrlMatcher, unknown]>} routes
 * @param {(stub: any) => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withFakeFetch(routes, fn) {
  const stub = fakeFetch(routes);
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (stub);
  try {
    return await fn(stub);
  } finally {
    globalThis.fetch = real;
  }
}
