// Google sign-in callback (src/google.js handleGoogleCallback): the contract
// that EVERY failure path bounces to /login with a flash code — never a bare
// top-level 500. Regression guard for the reported "Internal server error."
// upon login: the new-user provisioning path (getConfig + createUserFromGoogle)
// touches D1 and used to run UNguarded, so a transient D1 error there escaped to
// index.js's top-level catch and surfaced the generic 500 JSON to a user who was
// mid-sign-in. The happy path (provisioning succeeds → 303 to /rver) is pinned
// alongside so the wrapping didn't break the success case.

import test from "node:test";
import assert from "node:assert/strict";

import { handleGoogleCallback } from "./google.js";
import { signState } from "./auth.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const ENV = {
  SESSION_SECRET: "test-session-secret-high-entropy",
  GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_TOKEN_URL: "https://token.example/token",
  ADMIN_EMAIL: "admin@example.com",
};

// A base64url-encoded id_token whose payload passes claim validation. Header
// and signature segments are inert — google.js DECODES (does not verify) the
// token because it arrives over TLS straight from Google's token endpoint.
function idTokenFor(email, extra = {}) {
  const payload = {
    iss: "https://accounts.google.com",
    aud: ENV.GOOGLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email_verified: true,
    email,
    name: "Test User",
    sub: "sub-123",
    ...extra,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

// A minimal in-memory D1 fake modelling exactly the statements the login path
// issues. `failInsertUsers` makes the INSERT throw, standing in for a transient
// D1 write failure during first-time provisioning.
function fakeDb({ failInsertUsers = false } = {}) {
  /** @type {any[]} */
  const users = [];
  let nextId = 1;
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (/^INSERT INTO users/i.test(sql)) {
        if (failInsertUsers) throw new Error("D1_ERROR: transient write failure");
        const [email, name, role, status, google_sub, created_at] = args;
        users.push({ id: nextId++, email, name, role, status, google_sub, created_at });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
    async first() {
      if (/^SELECT \* FROM users WHERE email/i.test(sql)) {
        return users.find((u) => u.email === args[0]) || null;
      }
      if (/^SELECT value FROM config/i.test(sql)) return null; // defaults apply
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    },
  };
}

async function callbackRequest() {
  const state = "0123456789abcdef0123456789abcdef";
  const cookie = `dr_oauth=${state}.${await signState(ENV, state)}`;
  const url = new URL(`https://deepresearch.se/auth/google/callback?state=${state}&code=auth-code`);
  const request = new Request(url, { headers: { Cookie: cookie } });
  return { request, url };
}

// Stub the token exchange (google.js fetches Google's token endpoint).
function withStubbedFetch(email, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id_token: idTokenFor(email) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return (async () => {
    try {
      return await fn();
    } finally {
      globalThis.fetch = original;
    }
  })();
}

test("callback: a D1 failure during provisioning bounces to /login (never a 500)", async () => {
  const env = { ...ENV, DB: fakeDb({ failInsertUsers: true }) };
  const { request, url } = await callbackRequest();
  const res = await withStubbedFetch("newuser@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  // Contract: a graceful 303 to the login page with a flash, NOT a thrown error
  // that would reach index.js's catch and become the generic 500 JSON.
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/login?flash=google-failed");
});

test("callback: successful first-time provisioning sets the session and 303s to /rver", async () => {
  const env = { ...ENV, DB: fakeDb() };
  const { request, url } = await callbackRequest();
  const res = await withStubbedFetch("someone@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/rver");
  const cookies = res.headers.getSetCookie();
  assert.ok(
    cookies.some((c) => c.startsWith("dr_session=u.")),
    "a signed session cookie is set on success",
  );
});
