// Route-layer tests for the Worker entrypoint (src/index.js).
//
// 964 lines and ~93 path branches, and before this file NO test called the
// fetch handler — no route table test, no method matrix, no auth-gate matrix.
// It is the first code every request touches and the last thing standing
// between an unauthenticated caller and everything behind the gate.
//
// The tests are deliberately written as PROPERTIES OF THE ENVELOPE rather than
// as a route-by-route table. A hand-maintained list of 93 routes rots the day
// someone adds the 94th, and its passing tells you nothing about the one that
// was forgotten. What is worth pinning is what must be true of EVERY response:
// it is authenticated or explicitly public, it carries the security headers,
// it carries a request id, and a crash inside it becomes a clean 500 that
// leaks nothing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import worker from "./index.js";
import { fakeD1 } from "./test-helpers/d1.js";
import { fakeEnv, fakeCtx, fakeAssets } from "./test-helpers/env.js";

const ORIGIN = "https://deepresearch.test";

/** @param {Record<string, any>} [overrides] */
function env(overrides = {}) {
  return fakeEnv({
    DB: fakeD1(),
    ASSETS: fakeAssets({
      "/index.html": "<html>app</html>",
      "/welcome/index.html": "<html>landing</html>",
      "/login.html": "<html>login</html>",
    }),
    ...overrides,
  });
}

/**
 * @param {string} path
 * @param {{ method?: string, headers?: Record<string,string>, env?: any }} [opts]
 */
async function call(path, opts = {}) {
  const ctx = fakeCtx();
  const request = new Request(ORIGIN + path, { method: opts.method || "GET", headers: opts.headers });
  const response = await worker.fetch(request, opts.env || env(), ctx);
  await ctx.settle();
  return response;
}

/** The Basic header for the break-glass admin credentials below. */
const ADMIN = { ADMIN_USER: "root", ADMIN_PASS: "hunter2" };
const adminHeader = { authorization: `Basic ${Buffer.from("root:hunter2").toString("base64")}` };

// API paths that live BEHIND the identity gate. Not exhaustive by design —
// a representative sample across the surfaces, enough that a gate that stops
// applying to a whole family fails here.
const GATED_API = [
  ["POST", "/api/chat"],
  ["GET", "/api/models"],
  ["GET", "/api/health"],
  ["GET", "/api/admin/config"],
  ["GET", "/api/admin/chatlogs"],
  ["GET", "/api/admin/users"],
  ["POST", "/api/bash/step"],
  ["POST", "/api/quiz/grade"],
  ["GET", "/api/projects"],
  ["GET", "/api/history"],
];

describe("the identity gate is fail-closed", () => {
  for (const [method, path] of GATED_API) {
    test(`${method} ${path} is 401 without credentials`, async () => {
      const resp = await call(path, { method });
      assert.equal(resp.status, 401, `${method} ${path} must not be reachable unauthenticated`);
    });
  }

  test("an unauthenticated /mcp is refused as JSON-RPC, never as the sign-in page", async () => {
    // The endpoint speaks JSON-RPC even when refusing. An MCP client handed
    // HTML reports a TRANSPORT failure, so the one error its user needs to
    // read — "authenticate" — is the one they never see. src/index.js already
    // did this for a key that was presented and rejected; the commoner case is
    // no credential at all (key forgotten, or an authorization header a proxy
    // stripped), which used to fall through to loginPage. Caught by
    // scripts/mcp-probe.mjs's first live run, 2026-08-01.
    const resp = await call("/mcp", { method: "POST" });
    assert.equal(resp.status, 401);
    assert.match(resp.headers.get("content-type") || "", /application\/json/);
    const body = await resp.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.ok(body.error?.code, "carries a JSON-RPC error code");
    // The message has to say what to DO — this is the one response a
    // misconfigured client's user will actually see.
    assert.match(body.error.message, /Bearer/);
  });

  test("the bare origin on the mcp. host refuses the same way", async () => {
    // Clients disagree about whether the configured URL includes the path, so
    // isMcpEndpoint treats the bare origin on that host as the endpoint too —
    // and a refusal there must not become HTML either.
    const ctx = fakeCtx();
    const request = new Request("https://mcp.deepresearch.se/", { method: "POST" });
    const resp = await worker.fetch(request, env(), ctx);
    await ctx.settle();
    assert.equal(resp.status, 401);
    assert.equal((await resp.json()).jsonrpc, "2.0");
  });

  test("GET /mcp answers as an ENDPOINT (405), not with the setup page", async () => {
    // Streamable HTTP: a server offering no SSE stream on GET returns 405. This
    // used to serve the /connect/ HTML at 200, and a client reading HTML there
    // can conclude the URL is not an MCP endpoint at all — one of the 2026-08-05
    // ChatGPT connector failures.
    const ctx = fakeCtx();
    const resp = await worker.fetch(new Request("https://mcp.deepresearch.se/mcp"), env(), ctx);
    await ctx.settle();
    assert.equal(resp.status, 405);
    assert.equal(resp.headers.get("allow"), "POST");
    assert.equal((await resp.json()).jsonrpc, "2.0");
  });

  test("GET / on the mcp. host still serves the setup page", async () => {
    // The counterpart to the rule above: the bare origin is what a PERSON types
    // into a browser, and they get instructions rather than a protocol error.
    const ctx = fakeCtx();
    const assets = { ASSETS: fakeAssets({ "/connect/": "<html>connect</html>" }) };
    const resp = await worker.fetch(new Request("https://mcp.deepresearch.se/"), env(assets), ctx);
    await ctx.settle();
    assert.equal(resp.status, 200);
    assert.match(await resp.text(), /connect/);
  });

  test("the 401 pointer names the document for the URL that was typed", async () => {
    // `resource` must equal the typed URL character for character, and OpenAI
    // tells people to type the `/mcp` form while Claude gets the bare origin.
    // Pointing both at the origin document handed the ChatGPT user a mismatch
    // reported as an unreachable server.
    const ctx = fakeCtx();
    const withPath = await worker.fetch(
      new Request("https://mcp.deepresearch.se/mcp", { method: "POST" }),
      env(),
      ctx,
    );
    await ctx.settle();
    assert.match(
      withPath.headers.get("www-authenticate"),
      /resource_metadata="https:\/\/mcp\.deepresearch\.se\/\.well-known\/oauth-protected-resource\/mcp"/,
    );
    // The challenge is the point of the response, so a browser client must be
    // able to read it.
    assert.equal(withPath.headers.get("access-control-expose-headers"), "WWW-Authenticate");

    const ctx2 = fakeCtx();
    const bare = await worker.fetch(
      new Request("https://mcp.deepresearch.se/", { method: "POST" }),
      env(),
      ctx2,
    );
    await ctx2.settle();
    assert.match(
      bare.headers.get("www-authenticate"),
      /resource_metadata="https:\/\/mcp\.deepresearch\.se\/\.well-known\/oauth-protected-resource"/,
    );
  });

  test("both protected-resource documents are served and state their own resource", async () => {
    for (const [path, resource] of [
      ["/.well-known/oauth-protected-resource", "https://mcp.deepresearch.se"],
      ["/.well-known/oauth-protected-resource/mcp", "https://mcp.deepresearch.se/mcp"],
    ]) {
      const ctx = fakeCtx();
      const resp = await worker.fetch(new Request("https://mcp.deepresearch.se" + path), env(), ctx);
      await ctx.settle();
      assert.equal(resp.status, 200);
      assert.equal((await resp.json()).resource, resource);
      // Read cross-origin by a browser-based connector dialog, where a missing
      // header is indistinguishable from an unreachable server.
      assert.equal(resp.headers.get("access-control-allow-origin"), "*");
    }
  });

  test("an unauthenticated authorization request is resumed, not discarded", async () => {
    // It used to meet the generic sign-in card while the Google callback
    // hard-redirected to /rver, so the PKCE challenge and the client's state
    // were lost and the connector popup waited forever. This broke Claude too —
    // it only worked for someone already signed in.
    const resp = await call("/oauth/authorize?client_id=orc1.x&state=s&code_challenge=c");
    assert.equal(resp.status, 302);
    const loc = resp.headers.get("Location");
    assert.match(loc, /^\/auth\/google\?next=/);
    assert.match(decodeURIComponent(loc), /\/oauth\/authorize\?client_id=orc1\.x&state=s/);
  });

  test("/oauth/register is reachable WITHOUT a credential", async () => {
    // A client registers before it has any credential or any user, so requiring
    // one requires the flow to have already finished. It used to fall through
    // the identity gate and answer 401 with HTML.
    const resp = await call("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.notEqual(resp.status, 401);
    assert.equal(resp.headers.get("content-type"), "application/json; charset=utf-8");
  });

  test("an unknown path behind the gate is 401, not 404 — no route enumeration", async () => {
    // Answering 404 for unknown paths and 401 for real ones tells an
    // unauthenticated caller which routes exist. It answers 401 for both.
    const resp = await call("/api/definitely-not-a-route-xyz");
    assert.equal(resp.status, 401);
  });

  test("a wrong password is 401", async () => {
    const resp = await call("/api/health", {
      env: env(ADMIN),
      headers: { authorization: `Basic ${Buffer.from("root:wrong").toString("base64")}` },
    });
    assert.equal(resp.status, 401);
  });

  test("a malformed Authorization header is 401, not a crash", async () => {
    for (const authorization of ["Basic", "Basic !!!!", "Bearer abc", "", "Basic " + "A".repeat(500)]) {
      const resp = await call("/api/health", { env: env(ADMIN), headers: { authorization } });
      assert.equal(resp.status, 401, `authorization: ${JSON.stringify(authorization)}`);
    }
  });

  test("with NO credentials configured at all the site still fails closed", async () => {
    // adminCreds() returns null when the secrets are unset; that must deny,
    // never admit.
    const resp = await call("/api/health", { env: env({ ADMIN_USER: null, ADMIN_PASS: null }) });
    assert.equal(resp.status, 401);
  });

  test("break-glass Basic Auth admits the admin", async () => {
    const resp = await call("/api/health", { env: env(ADMIN), headers: adminHeader });
    assert.notEqual(resp.status, 401);
  });
});

describe("the response envelope", () => {
  // Every response leaves through applySecurityHeaders. These are the headers
  // whose ABSENCE is a vulnerability, so they are asserted on the paths most
  // likely to bypass the wrapper: an error, a denial, and a success.
  const REQUIRED = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin",
  };

  for (const [label, path, opts] of /** @type {Array<[string, string, any]>} */ ([
    ["a 401 denial", "/api/chat", { method: "POST" }],
    ["a served HTML page", "/login", {}],
    ["a redirect", "/", { env: env(ADMIN), headers: adminHeader }],
  ])) {
    test(`${label} carries the security headers`, async () => {
      const resp = await call(path, opts);
      for (const [header, value] of Object.entries(REQUIRED)) {
        assert.equal(resp.headers.get(header), value, `${label} missing ${header}`);
      }
      assert.match(resp.headers.get("strict-transport-security") || "", /max-age=\d+/);
    });
  }

  test("every response carries an x-request-id", async () => {
    for (const path of ["/api/health", "/login", "/api/unknown-xyz"]) {
      const resp = await call(path);
      assert.match(resp.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/, `${path} has no request id`);
    }
  });

  test("request ids are unique per request, so logs correlate to one request", async () => {
    const seen = new Set();
    for (let i = 0; i < 5; i++) seen.add((await call("/api/health")).headers.get("x-request-id"));
    assert.equal(seen.size, 5);
  });
});

describe("the crash path", () => {
  // A binding that throws is the realistic shape of an internal failure, and
  // an asset route reaches it in a single hop. Deliberately NOT a failing D1:
  // `migrated` in src/db.js is a module-level per-isolate flag, so whether a
  // broken database throws depends on whether some earlier test in the same
  // process already migrated — a test that passes or fails on file ordering is
  // worse than no test.
  const CRASH = "ASSETS_BOOM: binding unavailable";
  const throwingAssets = {
    fetch() {
      throw new Error(CRASH);
    },
  };
  /** The asset path used throughout — reaches the assets binding directly. */
  const PATH = "/app.css";
  const crashingEnv = () => env({ ASSETS: throwingAssets, ...ADMIN });

  test("an internal error becomes a clean 500, not an unhandled rejection", async () => {
    const resp = await call(PATH, { env: crashingEnv(), headers: adminHeader });
    assert.equal(resp.status, 500);
    assert.match(resp.headers.get("content-type") || "", /application\/json/);
  });

  test("the 500 body carries a request id and NOTHING else about the failure", async () => {
    const resp = await call(PATH, { env: crashingEnv(), headers: adminHeader });
    const body = await resp.json();
    assert.deepEqual(Object.keys(body).sort(), ["error", "request_id"]);
    assert.equal(body.error, "Internal server error.");
    assert.match(body.request_id, /^[0-9a-f-]{36}$/);
  });

  test("no stack trace, internal message, or secret reaches the client on a crash", async () => {
    const e = crashingEnv();
    const resp = await call(PATH, { env: e, headers: adminHeader });
    const text = await resp.text();
    for (const leak of [CRASH, "ASSETS_BOOM", "at Object", ".js:", e.BERGET_API_TOKEN, "hunter2"]) {
      assert.ok(!text.includes(leak), `the 500 body leaked ${JSON.stringify(leak)}`);
    }
  });

  test("the 500 still carries the security headers", async () => {
    const resp = await call(PATH, { env: crashingEnv(), headers: adminHeader });
    assert.equal(resp.headers.get("x-content-type-options"), "nosniff");
    assert.equal(resp.headers.get("x-frame-options"), "DENY");
  });

  test("the body's request_id matches the x-request-id header, so a report is traceable", async () => {
    const resp = await call(PATH, { env: crashingEnv(), headers: adminHeader });
    const header = resp.headers.get("x-request-id");
    assert.equal((await resp.json()).request_id, header);
  });

  test("the crash is recorded into the server-error queue off the hot path", async () => {
    // index.js routes the failure into recordServerError via ctx.waitUntil so
    // a 500 becomes a work item rather than only a log line.
    const ctx = fakeCtx();
    const resp = await worker.fetch(new Request(ORIGIN + PATH, { headers: adminHeader }), crashingEnv(), ctx);
    assert.equal(resp.status, 500);
    assert.ok(ctx.deferred.length > 0, "the error record was deferred with waitUntil");
    await ctx.settle();
  });
});

describe("method handling", () => {
  test("a wrong method on a real route does not 500", async () => {
    for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
      const resp = await call("/api/chat", { method, env: env(ADMIN), headers: adminHeader });
      assert.notEqual(resp.status, 500, `${method} /api/chat produced a server error`);
    }
  });

  test("an unusual method does not crash the router", async () => {
    for (const method of ["OPTIONS", "HEAD"]) {
      const resp = await call("/api/health", { method, env: env(ADMIN), headers: adminHeader });
      assert.ok(resp.status < 500, `${method} produced ${resp.status}`);
    }
  });
});

describe("public surfaces are reachable signed out (invariant 8)", () => {
  // The intro baseline states every door on the landing is reachable signed
  // out. These are the ones served by the Worker rather than the asset
  // pipeline, so a gate creeping over them would be invisible until a stranger
  // hit it.
  test("/login serves without credentials", async () => {
    const resp = await call("/login");
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", /text\/html/);
  });

  test("the login page is not a redirect — it is served in place", async () => {
    const resp = await call("/login");
    assert.ok(resp.status < 300 || resp.status >= 400, `expected a served page, got ${resp.status}`);
  });
});
