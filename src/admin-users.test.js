// POST /api/admin/users — the admin "Add user" (invite) endpoint.
//
// The feature exists because auto-provisioning alone leaves an expected
// colleague parked on the awaiting-approval page until the admin happens to
// open /admin. Creating the row ahead of time pre-approves them, so their
// first Google sign-in lands them straight in the app (the sign-in side of
// that handshake — claiming the row — is pinned in src/google.test.js).
//
// What this suite guards is mostly what the endpoint must REFUSE: the
// sole-admin policy (no role may be minted here, exactly as patchUser may not
// promote), and the uniqueness of an email across accounts.

import test from "node:test";
import assert from "node:assert/strict";

import { handleAdminApi } from "./admin-api.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// A minimal in-memory D1 fake covering the statements this endpoint issues:
// the email lookup, the INSERT (with the users.email UNIQUE constraint
// modelled, because the duplicate answer depends on it), and the id lookup.
function fakeDb({ seed = [] } = {}) {
  /** @type {any[]} */
  const users = [];
  let nextId = 1;
  for (const u of seed) users.push({ id: nextId++, google_sub: null, name: null, ...u });
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (/^INSERT INTO users/i.test(sql)) {
        const [email, name, role, status, google_sub, created_at] = args;
        if (users.some((u) => u.email === email)) {
          throw new Error("D1_ERROR: UNIQUE constraint failed: users.email");
        }
        users.push({ id: nextId++, email, name, role, status, google_sub, created_at });
        return { success: true, meta: { changes: 1 } };
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
      return null;
    },
    async all() {
      return { results: [] };
    },
  });
  return {
    users,
    prepare: (sql) => stmt(sql),
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    },
  };
}

async function addUser(db, body) {
  const url = new URL("https://deepresearch.se/api/admin/users");
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleAdminApi(request, { DB: db }, url, noopLog, { userId: "1" });
  return { res, data: await res.json().catch(() => ({})) };
}

test("creates a pre-approved account for an address that has never signed in", async () => {
  const db = fakeDb();
  const { res, data } = await addUser(db, { email: "New.Person@Example.COM ", name: "New Person" });
  assert.equal(res.status, 201);
  assert.equal(data.user.email, "new.person@example.com", "the address is normalized");
  assert.equal(data.user.name, "New Person");
  // Active, not pending: skipping the approval queue is the whole point.
  assert.equal(data.user.status, "active");
  // No google_sub — the row waits for its owner's first sign-in to claim it.
  assert.equal(data.user.google_sub, null);
  assert.equal(db.users.length, 1);
});

test("status: pending stages an account without granting access", async () => {
  const db = fakeDb();
  const { res, data } = await addUser(db, { email: "staged@example.com", status: "pending" });
  assert.equal(res.status, 201);
  assert.equal(data.user.status, "pending");
});

test("an unrecognized status falls back to active rather than being written raw", async () => {
  const db = fakeDb();
  const { data } = await addUser(db, { email: "odd@example.com", status: "superuser" });
  assert.equal(data.user.status, "active");
});

test("the role is never taken from the request — sole-admin policy", async () => {
  // ADMIN_EMAIL at sign-in is the ONLY path to admin. An invite must be no
  // more able to mint one than PATCH /users/:id is able to promote one.
  const db = fakeDb();
  const { res, data } = await addUser(db, { email: "sneaky@example.com", role: "admin" });
  assert.equal(res.status, 201);
  assert.equal(data.user.role, "user");
  assert.equal(db.users[0].role, "user");
});

test("a malformed or missing email is refused, and nothing is written", async () => {
  for (const email of [undefined, "", "not-an-email", "no@tld", "  @example.com"]) {
    const db = fakeDb();
    const { res, data } = await addUser(db, { email });
    assert.equal(res.status, 400, `rejected: ${JSON.stringify(email)}`);
    assert.match(data.error, /valid email/i);
    assert.equal(db.users.length, 0);
  }
});

test("an address that already has an account is a 409, not a duplicate row", async () => {
  const db = fakeDb({
    seed: [{ email: "taken@example.com", role: "user", status: "active", created_at: 1 }],
  });
  // Also proves the check is case-insensitive: the lookup normalizes first.
  const { res, data } = await addUser(db, { email: "TAKEN@example.com" });
  assert.equal(res.status, 409);
  assert.match(data.error, /already has an account/i);
  assert.equal(db.users.length, 1);
});

test("a UNIQUE violation racing the pre-check answers 409, not a raw D1 400", async () => {
  // The pre-check and the INSERT are not atomic — a sign-in (or a second
  // admin) landing in between surfaces as a constraint error, which must give
  // the same answer as the pre-check rather than leaking D1's message.
  const db = fakeDb();
  const original = db.prepare;
  let firstLookup = true;
  db.prepare = (sql) => {
    // Make the existence check miss once, then let the INSERT hit the
    // constraint — the shape of the race, without any timing.
    if (/^SELECT \* FROM users WHERE email/i.test(sql) && firstLookup) {
      firstLookup = false;
      db.users.push({
        id: 99,
        email: "racer@example.com",
        role: "user",
        status: "active",
        created_at: 1,
      });
      return { bind: () => ({ async first() { return null; } }) };
    }
    return original(sql);
  };
  const { res, data } = await addUser(db, { email: "racer@example.com" });
  assert.equal(res.status, 409);
  assert.match(data.error, /already has an account/i);
  assert.doesNotMatch(data.error, /D1_ERROR|UNIQUE/i, "D1's message is not passed through");
});
