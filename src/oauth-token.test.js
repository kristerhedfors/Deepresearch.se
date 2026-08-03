// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency. Same reason as src/budget.test.js.)
// POST /oauth/token (src/oauth-token.js) — the WIRE, which is what a hosted
// connector actually breaks on.
//
// The store (src/oauth-store.js) owns single-use, PKCE and rotation semantics
// and has its own suite; this one injects a faithful in-memory fake through
// the handler's store seam and pins the things Anthropic's and OpenAI's
// connector documentation require of the endpoint itself:
//
//   - the body is x-www-form-urlencoded for BOTH grants (a JSON-only parser
//     here answers 415 to every real client);
//   - the failure shape is RFC 6749 §5.2 with the registered code, HTTP 400 —
//     and a dead refresh token is `invalid_grant` SPECIFICALLY, because that
//     value is what tells a client to re-authorize instead of retrying;
//   - `client_credentials` is refused, both vendors having ruled it out;
//   - the rotated refresh token comes back in the same response that killed
//     the old one;
//   - `Cache-Control: no-store` on every response, success or failure.
//
// The fake enforces real S256 (WebCrypto) rather than a stub comparison, so
// the wrong-verifier test exercises the same rejection the store will.

import test from "node:test";
import assert from "node:assert/strict";

import { handleOAuthToken, parseTokenBody, scopeHasOffline } from "./oauth-token.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };
/** @type {any} */
const env = { SESSION_SECRET: "x".repeat(64) };

const CLIENT = "https://claude.ai/.well-known/oauth-client";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const SCOPE = "research offline_access";

// ---------------------------------------------------------------------------
// A faithful fake of the src/oauth-store.js contract
// ---------------------------------------------------------------------------

/** base64url(SHA-256(verifier)) — the PKCE S256 challenge, computed for real. */
async function s256(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let s = "";
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeStore() {
  /** @type {Map<string, any>} */
  const codes = new Map();
  /** @type {Map<string, any>} */
  const refresh = new Map();
  let n = 0;
  const store = {
    ACCESS_TOKEN_TTL_S: 3600,
    calls: /** @type {string[]} */ ([]),
    /** Seed a code as the authorize endpoint would have. */
    async seedCode(opts = {}) {
      const verifier = opts.codeVerifier || "verifier-0123456789012345678901234567890123456789";
      const code = `oac1.code${++n}`;
      codes.set(code, {
        userId: opts.userId || "42",
        clientId: opts.clientId || CLIENT,
        redirectUri: opts.redirectUri || REDIRECT,
        codeChallenge: await s256(verifier),
        scope: opts.scope === undefined ? SCOPE : opts.scope,
        exp: opts.exp === undefined ? Math.floor(Date.now() / 1000) + 60 : opts.exp,
      });
      return { code, verifier };
    },
    /** Seed a refresh token directly (the rotate-path fixture). */
    seedRefresh(opts = {}) {
      const token = `ort1.refresh${++n}`;
      refresh.set(token, {
        userId: opts.userId || "42",
        clientId: opts.clientId || CLIENT,
        scope: opts.scope === undefined ? SCOPE : opts.scope,
        jti: `jti${n}`,
      });
      return token;
    },
    liveRefreshTokens: () => [...refresh.keys()],

    async redeemAuthCode(_env, code, { clientId, redirectUri, codeVerifier }) {
      store.calls.push("redeemAuthCode");
      const rec = codes.get(code);
      if (!rec) return { error: "invalid_grant" };
      codes.delete(code); // SINGLE USE, whatever happens next
      if (rec.exp * 1000 <= Date.now()) return { error: "invalid_grant" };
      if (rec.clientId !== clientId) return { error: "invalid_grant" };
      if (rec.redirectUri !== redirectUri) return { error: "invalid_grant" };
      if ((await s256(codeVerifier)) !== rec.codeChallenge) return { error: "invalid_grant" };
      return { userId: rec.userId, scope: rec.scope };
    },
    async mintAccessToken(_env, { userId, scope }) {
      store.calls.push(`mintAccessToken:${scope}`);
      return { token: `oat1.access-${userId}-${++n}`, exp: Math.floor(Date.now() / 1000) + 3600 };
    },
    async mintRefreshToken(_env, { userId, clientId, scope }) {
      store.calls.push("mintRefreshToken");
      const token = `ort1.refresh${++n}`;
      refresh.set(token, { userId, clientId, scope, jti: `jti${n}` });
      return { token, jti: `jti${n}` };
    },
    async rotateRefreshToken(_env, token, { clientId }) {
      store.calls.push("rotateRefreshToken");
      const rec = refresh.get(token);
      if (!rec) return { error: "invalid_grant" };
      refresh.delete(token); // the old jti dies in the SAME call
      if (rec.clientId !== clientId) return { error: "invalid_grant" };
      const next = `ort1.refresh${++n}`;
      refresh.set(next, { ...rec, jti: `jti${n}` });
      return { userId: rec.userId, scope: rec.scope, refresh: { token: next, jti: `jti${n}` } };
    },
  };
  return store;
}

/** A form-encoded POST, as both vendors send. */
function formRequest(params, headers = {}) {
  return new Request("https://deepresearch.se/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });
}

const post = (params, store, headers) => handleOAuthToken(formRequest(params, headers), env, log, store);

/** Every response must be uncacheable — asserted on success and failure alike. */
function assertNoStore(res) {
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("pragma"), "no-cache");
  assert.match(res.headers.get("content-type") || "", /application\/json/);
}

// ---------------------------------------------------------------------------
// Body parsing
// ---------------------------------------------------------------------------

test("parseTokenBody reads x-www-form-urlencoded, including + as space", () => {
  const params = parseTokenBody(
    "application/x-www-form-urlencoded; charset=UTF-8",
    "grant_type=authorization_code&code=abc%2Fdef&scope=research+offline_access",
  );
  assert.equal(params.grant_type, "authorization_code");
  assert.equal(params.code, "abc/def");
  assert.equal(params.scope, "research offline_access");
});

test("parseTokenBody accepts a JSON body too (a 415 here reads as an unexplained connect failure)", () => {
  const params = parseTokenBody("application/json", JSON.stringify({ grant_type: "refresh_token", refresh_token: "r" }));
  assert.equal(params.grant_type, "refresh_token");
  assert.equal(params.refresh_token, "r");
});

test("parseTokenBody sniffs an unlabelled body: JSON when it starts with {, form otherwise", () => {
  assert.equal(parseTokenBody("", '{"grant_type":"refresh_token"}').grant_type, "refresh_token");
  assert.equal(parseTokenBody("", "grant_type=refresh_token").grant_type, "refresh_token");
});

test("parseTokenBody never throws on garbage, and drops nested JSON values", () => {
  assert.deepEqual(parseTokenBody("application/json", "not json at all {"), {});
  assert.deepEqual(parseTokenBody("application/json", "[1,2]"), {});
  const nested = parseTokenBody("application/json", JSON.stringify({ client_id: "c", extra: { a: 1 }, n: 5 }));
  assert.deepEqual(nested, { client_id: "c", n: "5" });
});

test("scopeHasOffline only matches the whole token", () => {
  assert.equal(scopeHasOffline("research offline_access"), true);
  assert.equal(scopeHasOffline("offline_access"), true);
  assert.equal(scopeHasOffline("research"), false);
  assert.equal(scopeHasOffline("offline_access_x"), false);
  assert.equal(scopeHasOffline(""), false);
});

// ---------------------------------------------------------------------------
// grant_type=authorization_code
// ---------------------------------------------------------------------------

test("authorization_code: form-encoded exchange returns access + refresh + scope", async () => {
  const store = fakeStore();
  const { code, verifier } = await store.seedCode();
  const res = await post(
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier },
    store,
  );
  assert.equal(res.status, 200);
  assertNoStore(res);
  const body = await res.json();
  assert.match(body.access_token, /^oat1\./);
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.expires_in > 0 && body.expires_in <= 3600);
  assert.match(body.refresh_token, /^ort1\./);
  assert.equal(body.scope, SCOPE);
});

test("authorization_code: a JSON body works the same way (the fallback encoding)", async () => {
  const store = fakeStore();
  const { code, verifier } = await store.seedCode();
  const req = new Request("https://deepresearch.se/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT,
      code_verifier: verifier,
    }),
  });
  const res = await handleOAuthToken(req, env, log, store);
  assert.equal(res.status, 200);
  assert.match((await res.json()).access_token, /^oat1\./);
});

test("authorization_code: no refresh token when the granted scope lacks offline_access", async () => {
  const store = fakeStore();
  const { code, verifier } = await store.seedCode({ scope: "research" });
  const res = await post(
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier },
    store,
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.scope, "research");
  assert.equal("refresh_token" in body, false);
  assert.equal(store.calls.includes("mintRefreshToken"), false);
});

test("authorization_code: a wrong code_verifier is invalid_grant, HTTP 400", async () => {
  const store = fakeStore();
  const { code } = await store.seedCode();
  const res = await post(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT,
      code_verifier: "some-other-verifier-000000000000000000000000000000000",
    },
    store,
  );
  assert.equal(res.status, 400);
  assertNoStore(res);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("authorization_code: a mismatched redirect_uri is invalid_grant", async () => {
  const store = fakeStore();
  const { code, verifier } = await store.seedCode();
  const res = await post(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      client_id: CLIENT,
      code_verifier: verifier,
    },
    store,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("authorization_code: replaying a code is invalid_grant (single use lives in the store)", async () => {
  const store = fakeStore();
  const { code, verifier } = await store.seedCode();
  const params = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier };
  assert.equal((await post(params, store)).status, 200);
  const replay = await post(params, store);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
});

test("authorization_code: each missing parameter is invalid_request, and names itself", async () => {
  const store = fakeStore();
  const { code, verifier } = await store.seedCode();
  const full = {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT,
    code_verifier: verifier,
  };
  for (const key of ["code", "redirect_uri", "code_verifier", "client_id"]) {
    const params = { ...full };
    delete params[key];
    const res = await post(params, store);
    assert.equal(res.status, 400, key);
    assertNoStore(res);
    const body = await res.json();
    assert.equal(body.error, "invalid_request", key);
    assert.match(body.error_description, new RegExp(key), key);
  }
  // Nothing reached the store: a malformed request must not consume the code.
  assert.deepEqual(store.calls, []);
});

test("the store's invalid_request is passed through rather than flattened to invalid_grant", async () => {
  const store = fakeStore();
  store.redeemAuthCode = async () => ({ error: "invalid_request" });
  const res = await post(
    { grant_type: "authorization_code", code: "x", redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: "v" },
    store,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_request");
});

test("an unrecognized store error still becomes a registered code, never a custom one", async () => {
  const store = fakeStore();
  store.redeemAuthCode = async () => ({ error: "code_already_used" });
  const res = await post(
    { grant_type: "authorization_code", code: "x", redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: "v" },
    store,
  );
  assert.equal((await res.json()).error, "invalid_grant");
});

// ---------------------------------------------------------------------------
// grant_type=refresh_token
// ---------------------------------------------------------------------------

test("refresh_token: the ROTATED token comes back in the same response", async () => {
  const store = fakeStore();
  const first = store.seedRefresh();
  const res = await post({ grant_type: "refresh_token", refresh_token: first, client_id: CLIENT }, store);
  assert.equal(res.status, 200);
  assertNoStore(res);
  const body = await res.json();
  assert.match(body.access_token, /^oat1\./);
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.scope, SCOPE);
  assert.match(body.refresh_token, /^ort1\./);
  assert.notEqual(body.refresh_token, first);
  // And the old one is gone in that same call — a public client's rotation.
  assert.deepEqual(store.liveRefreshTokens(), [body.refresh_token]);
});

test("refresh_token: a REUSED refresh token is invalid_grant — the value clients branch on", async () => {
  const store = fakeStore();
  const first = store.seedRefresh();
  const params = { grant_type: "refresh_token", refresh_token: first, client_id: CLIENT };
  assert.equal((await post(params, store)).status, 200);
  const reuse = await post(params, store);
  assert.equal(reuse.status, 400);
  assertNoStore(reuse);
  const body = await reuse.json();
  assert.equal(body.error, "invalid_grant");
  assert.equal(typeof body.error_description, "string");
});

test("refresh_token: an unknown token is invalid_grant, not a 401 and not a 500", async () => {
  const store = fakeStore();
  const res = await post({ grant_type: "refresh_token", refresh_token: "ort1.never-issued", client_id: CLIENT }, store);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("refresh_token: a token presented by a different client_id is invalid_grant", async () => {
  const store = fakeStore();
  const token = store.seedRefresh();
  const res = await post(
    { grant_type: "refresh_token", refresh_token: token, client_id: "https://chatgpt.com/.well-known/oauth-client" },
    store,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_grant");
});

test("refresh_token: missing refresh_token or client_id is invalid_request, and never touches the store", async () => {
  const store = fakeStore();
  for (const params of [
    { grant_type: "refresh_token", client_id: CLIENT },
    { grant_type: "refresh_token", refresh_token: "ort1.x" },
  ]) {
    const res = await post(params, store);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "invalid_request");
  }
  assert.deepEqual(store.calls, []);
});

// ---------------------------------------------------------------------------
// Grant types, method, and the public-client posture
// ---------------------------------------------------------------------------

test("client_credentials is refused with unsupported_grant_type and says why", async () => {
  const store = fakeStore();
  const res = await post({ grant_type: "client_credentials", client_id: CLIENT }, store);
  assert.equal(res.status, 400);
  assertNoStore(res);
  const body = await res.json();
  assert.equal(body.error, "unsupported_grant_type");
  assert.match(body.error_description, /consent|account/i);
  assert.deepEqual(store.calls, []);
});

test("any other grant type is unsupported_grant_type; a missing one is invalid_request", async () => {
  const store = fakeStore();
  for (const gt of ["password", "urn:ietf:params:oauth:grant-type:device_code", "implicit"]) {
    const res = await post({ grant_type: gt, client_id: CLIENT }, store);
    assert.equal(res.status, 400, gt);
    assert.equal((await res.json()).error, "unsupported_grant_type", gt);
  }
  const none = await post({ client_id: CLIENT }, store);
  assert.equal(none.status, 400);
  assert.equal((await none.json()).error, "invalid_request");
});

test("a non-POST is a 405 with Allow: POST, still uncacheable", async () => {
  const store = fakeStore();
  const res = await handleOAuthToken(
    new Request("https://deepresearch.se/oauth/token", { method: "GET" }),
    env,
    log,
    store,
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
  assertNoStore(res);
  assert.equal((await res.json()).error, "invalid_request");
});

test("PUBLIC CLIENT: no credential is required, and an Authorization header changes nothing", async () => {
  const store = fakeStore();
  const { code, verifier } = await store.seedCode();
  const res = await post(
    { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: verifier },
    store,
    { authorization: "Basic " + btoa("someone:secret") },
  );
  assert.equal(res.status, 200);
  assert.match((await res.json()).access_token, /^oat1\./);
});

test("a thrown store error is a 503, not an invalid_grant that would cost the user the connection", async () => {
  const store = fakeStore();
  store.rotateRefreshToken = async () => {
    throw new Error("D1 unreachable");
  };
  const res = await post({ grant_type: "refresh_token", refresh_token: "ort1.x", client_id: CLIENT }, store);
  assert.equal(res.status, 503);
  assertNoStore(res);
  assert.equal((await res.json()).error, "temporarily_unavailable");
});

test("expires_in is derived from the minted token's own expiry", async () => {
  const store = fakeStore();
  store.mintAccessToken = async () => ({ token: "oat1.short", exp: Math.floor(Date.now() / 1000) + 120 });
  const token = store.seedRefresh();
  const body = await (await post({ grant_type: "refresh_token", refresh_token: token, client_id: CLIENT }, store)).json();
  assert.ok(body.expires_in > 110 && body.expires_in <= 120, String(body.expires_in));
});

test("a store that reports no usable exp still advertises a positive lifetime", async () => {
  const store = fakeStore();
  store.mintAccessToken = async () => ({ token: "oat1.noexp" });
  const token = store.seedRefresh();
  const body = await (await post({ grant_type: "refresh_token", refresh_token: token, client_id: CLIENT }, store)).json();
  assert.equal(body.expires_in, 3600);
});
