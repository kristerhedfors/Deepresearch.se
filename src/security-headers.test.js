// Unit tests for security-headers.js — the site-wide response headers and the
// CSP policy applied to every response by index.js's fetch().
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { applySecurityHeaders, _internals } from "./security-headers.js";

describe("applySecurityHeaders", () => {
  test("stamps the request id on the response", () => {
    const out = applySecurityHeaders(new Response("ok"), "req-123");
    assert.equal(out.headers.get("x-request-id"), "req-123");
  });

  test("adds every static security header", () => {
    const out = applySecurityHeaders(new Response("ok"), "r");
    assert.equal(out.headers.get("x-content-type-options"), "nosniff");
    assert.equal(out.headers.get("x-frame-options"), "DENY");
    assert.equal(out.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(out.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.match(out.headers.get("strict-transport-security"), /max-age=/);
    assert.match(out.headers.get("permissions-policy"), /geolocation=\(self\)/);
  });

  test("does not clobber a security header a handler set deliberately", () => {
    const res = new Response("ok", { headers: { "x-frame-options": "SAMEORIGIN" } });
    const out = applySecurityHeaders(res, "r");
    assert.equal(out.headers.get("x-frame-options"), "SAMEORIGIN");
  });

  test("preserves the original status and body", async () => {
    const res = new Response("boom", { status: 503 });
    const out = applySecurityHeaders(res, "r");
    assert.equal(out.status, 503);
    assert.equal(await out.text(), "boom");
  });

  test("CSP stays OFF by default (integrations in flux)", () => {
    const out = applySecurityHeaders(new Response("ok"), "r");
    assert.equal(_internals.CSP_ENABLED, false);
    assert.equal(out.headers.get("content-security-policy"), null);
  });
});

describe("CSP policy shape", () => {
  test("has no unsafe-inline / unsafe-eval in script-src", () => {
    const scriptSrc = _internals.CSP.split("; ").find((d) => d.startsWith("script-src"));
    assert.ok(scriptSrc, "script-src directive present");
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
  });

  test("locks down object-src and frame-ancestors", () => {
    assert.match(_internals.CSP, /object-src 'none'/);
    assert.match(_internals.CSP, /frame-ancestors 'none'/);
  });
});
