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

import { handleGoogleCallback, safeNextPath } from "./google.js";
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
function fakeDb({ failInsertUsers = false, seed = [] } = {}) {
  /** @type {any[]} */
  const users = [];
  let nextId = 1;
  for (const u of seed) users.push({ id: nextId++, google_sub: null, name: null, ...u });
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (/^INSERT INTO users/i.test(sql)) {
        if (failInsertUsers) throw new Error("D1_ERROR: transient write failure");
        const [email, name, role, status, google_sub, created_at] = args;
        users.push({ id: nextId++, email, name, role, status, google_sub, created_at });
        return { success: true, meta: { changes: 1 } };
      }
      // linkGoogleIdentity — the invite-claim UPDATE. Modelled faithfully,
      // including the `google_sub IS NULL` guard that makes it fill-blanks-only.
      if (/^UPDATE users SET google_sub/i.test(sql)) {
        const [sub, name, id] = args;
        const u = users.find((x) => x.id === id && !x.google_sub);
        if (u) {
          u.google_sub = sub;
          u.name = u.name || name;
        }
        return { success: true, meta: { changes: u ? 1 : 0 } };
      }
      return { success: true, meta: { changes: 0 } };
    },
    async first() {
      if (/^SELECT \* FROM users WHERE email/i.test(sql)) {
        return users.find((u) => u.email === args[0]) || null;
      }
      if (/^SELECT \* FROM users WHERE id/i.test(sql)) {
        return users.find((u) => u.id === args[0]) || null;
      }
      if (/^SELECT value FROM config/i.test(sql)) return null; // defaults apply
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return {
    users, // the test's window into what provisioning actually wrote
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

// --- admin-created (invited) accounts --------------------------------------
// An admin can create a row from /admin before its owner has ever signed in
// (POST /api/admin/users → createInvitedUser). Such a row is keyed by email
// with no google_sub; the first sign-in for that address must ADOPT it rather
// than trip over it, so the invited person keeps the id, status and quota the
// admin set up — that adoption is the whole point of pre-approving.

test("callback: a pre-approved invite is claimed on first sign-in, not re-provisioned", async () => {
  const db = fakeDb({
    seed: [{ email: "invited@example.com", role: "user", status: "active", created_at: 1 }],
  });
  const env = { ...ENV, DB: db };
  const { request, url } = await callbackRequest();
  const res = await withStubbedFetch("invited@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/rver");
  assert.equal(db.users.length, 1, "the invite row is adopted — no duplicate account");
  const user = db.users[0];
  assert.equal(user.google_sub, "sub-123", "the row is now pinned to the Google identity");
  assert.equal(user.name, "Test User", "the Google profile name fills the blank the admin left");
  // Pre-approved is the point: this user must NOT be sent to the approval gate.
  assert.equal(user.status, "active");
  // The session belongs to the pre-created row, so its quota/history carry over.
  assert.ok(
    res.headers.getSetCookie().some((c) => c.startsWith(`dr_session=u.${user.id}.`)),
    "the session is minted for the invited row's id",
  );
});

test("callback: claiming an invite never overwrites an admin-supplied name", async () => {
  const db = fakeDb({
    seed: [
      { email: "invited@example.com", name: "Ada L", role: "user", status: "active", created_at: 1 },
    ],
  });
  const env = { ...ENV, DB: db };
  const { request, url } = await callbackRequest();
  await withStubbedFetch("invited@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  assert.equal(db.users[0].name, "Ada L");
  assert.equal(db.users[0].google_sub, "sub-123");
});

test("callback: a row already pinned to a Google identity is never repointed", async () => {
  // Fill-blanks-only: linkGoogleIdentity's `WHERE google_sub IS NULL` guard is
  // what keeps this from being an account-takeover path if an address were
  // ever reused by a different Google subject.
  const db = fakeDb({
    seed: [
      {
        email: "existing@example.com",
        role: "user",
        status: "active",
        google_sub: "original-sub",
        created_at: 1,
      },
    ],
  });
  const env = { ...ENV, DB: db };
  const { request, url } = await callbackRequest();
  const res = await withStubbedFetch("existing@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  assert.equal(res.status, 303);
  assert.equal(db.users[0].google_sub, "original-sub");
});

test("callback: an invite staged as pending still lands on the approval gate", async () => {
  // Unticking "pre-approved" stages the account without granting access —
  // claiming the row must not quietly activate it.
  const db = fakeDb({
    seed: [{ email: "staged@example.com", role: "user", status: "pending", created_at: 1 }],
  });
  const env = { ...ENV, DB: db };
  const { request, url } = await callbackRequest();
  await withStubbedFetch("staged@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  assert.equal(db.users[0].status, "pending");
  assert.equal(db.users[0].google_sub, "sub-123");
});

// ---- resuming an OAuth authorization request across sign-in -----------------
//
// The connector's authorization request needs a signed-in account. Before this,
// an unauthenticated arrival met the generic sign-in card and the callback
// hard-redirected to /rver — so the user signed in, landed in the app, and the
// request they arrived with (with its PKCE challenge and the client's state)
// was gone. The popup waited for a code nobody could still mint. That is why
// the one live Claude run reached consent (the owner was already signed in)
// and a first-time connection could not.

test("safeNextPath accepts an authorization request and nothing else", () => {
  assert.equal(
    safeNextPath("/oauth/authorize?client_id=x&code_challenge=y"),
    "/oauth/authorize?client_id=x&code_challenge=y",
  );
  // A CLOSED list, not "any same-origin path": this value arrives in a query
  // string, so treating it as a general redirect target is how open
  // redirectors get built.
  for (const bad of [
    "https://evil.test/",
    "//evil.test/",
    "/\\evil.test",
    "/rver",
    "/admin",
    "/oauth/authorize/../../admin",
    "",
    null,
    undefined,
  ]) {
    assert.equal(safeNextPath(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test("sign-in returns to the authorization request instead of the app", async () => {
  const env = { ...ENV, DB: fakeDb() };
  const state = "0123456789abcdef0123456789abcdef";
  const url = new URL(`https://deepresearch.se/auth/google/callback?state=${state}&code=auth-code`);
  const request = new Request(url, {
    headers: {
      Cookie:
        `dr_oauth=${state}.${await signState(ENV, state)}; ` +
        `dr_oauth_next=${encodeURIComponent("/oauth/authorize?client_id=x&state=s")}`,
    },
  });
  const res = await withStubbedFetch("user@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  assert.equal(res.headers.get("Location"), "/oauth/authorize?client_id=x&state=s");
  // The return path is single-use: cleared in the same response that consumes
  // it, so a later sign-in cannot be steered by a stale cookie.
  assert.match(res.headers.getSetCookie().join("\n"), /dr_oauth_next=; Max-Age=0/);
});

test("a tampered return-path cookie falls back to the app", async () => {
  // Re-validated on the way OUT, not trusted because it was validated on the
  // way in: the cookie is ours, but a stored value is still an input.
  const env = { ...ENV, DB: fakeDb() };
  const state = "0123456789abcdef0123456789abcdef";
  const url = new URL(`https://deepresearch.se/auth/google/callback?state=${state}&code=auth-code`);
  const request = new Request(url, {
    headers: {
      Cookie:
        `dr_oauth=${state}.${await signState(ENV, state)}; ` +
        `dr_oauth_next=${encodeURIComponent("https://evil.test/steal")}`,
    },
  });
  const res = await withStubbedFetch("user@example.com", () =>
    handleGoogleCallback(request, env, url, noopLog),
  );
  assert.equal(res.headers.get("Location"), "/rver");
});
