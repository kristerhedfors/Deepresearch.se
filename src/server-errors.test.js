// The server-ERROR fix queue's pure logic and D1 surface (src/server-errors.js):
// the dedup signature (method + normalized path + normalized message), the
// status lifecycle helpers, the projection + agent text render, the fail-soft
// UPSERT recorder (recurrence bumps count and reopens a `fixed` row), and the
// admin CRUD handler. The handler runs against a tiny in-memory D1 fake that
// models exactly the statements the module issues.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SERVER_ERROR_STATUSES,
  errorSignature,
  normalizePath,
  normalizeMessage,
  normalizeErrorStatus,
  isOpenErrorStatus,
  projectServerError,
  formatServerErrorsText,
  recordServerError,
  handleAdminServerErrors,
} from "./server-errors.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
// A minimal in-memory D1 fake — one `server_errors` table keyed by id, with a
// unique signature. Understands only the statements server-errors.js emits.
// ---------------------------------------------------------------------------
function fakeDb() {
  /** @type {any[]} */
  const rows = [];
  let nextId = 1;
  const stmt = (sql, args = []) => ({
    sql,
    bind: (...a) => stmt(sql, a),
    async run() {
      if (/^INSERT INTO server_errors/i.test(sql)) {
        const [signature, first, last, method, path, message, stack, requestId, updated] = args;
        const existing = rows.find((r) => r.signature === signature);
        if (existing) {
          existing.count += 1;
          existing.last_seen_at = last;
          existing.method = method;
          existing.path = path;
          existing.message = message;
          existing.stack = stack;
          existing.request_id = requestId;
          if (existing.status === "fixed") existing.status = "open";
          existing.updated_at = updated;
          return { success: true, meta: { changes: 1 } };
        }
        rows.push({
          id: nextId++, signature, first_seen_at: first, last_seen_at: last, count: 1,
          status: "open", method, path, message, stack, request_id: requestId, note: null, updated_at: updated,
        });
        return { success: true, meta: { changes: 1, last_row_id: nextId - 1 } };
      }
      if (/^UPDATE server_errors SET/i.test(sql)) {
        const id = args[args.length - 1];
        const row = rows.find((r) => r.id === id);
        if (!row) return { success: true, meta: { changes: 0 } };
        // Column list is in SQL order; the values are args[0..n-2], id is last.
        const cols = [...sql.matchAll(/(\w+)\s*=\s*\?/g)].map((m) => m[1]);
        cols.forEach((c, i) => { row[c] = args[i]; });
        return { success: true, meta: { changes: 1 } };
      }
      if (/^DELETE FROM server_errors/i.test(sql)) {
        const id = args[0];
        const i = rows.findIndex((r) => r.id === id);
        if (i >= 0) rows.splice(i, 1);
        return { success: true, meta: { changes: i >= 0 ? 1 : 0 } };
      }
      return { success: true, meta: {} };
    },
    async first() {
      if (/SELECT id FROM server_errors WHERE signature = \?/i.test(sql)) {
        const r = rows.find((x) => x.signature === args[0]);
        return r ? { id: r.id } : null;
      }
      if (/SELECT \* FROM server_errors WHERE id = \?/i.test(sql)) {
        return rows.find((x) => x.id === args[0]) || null;
      }
      return null;
    },
    async all() {
      // The list query: optional status/open filter, newest last_seen_at first.
      let out = [...rows];
      if (/status = 'open'/i.test(sql)) out = out.filter((r) => r.status === "open");
      if (/status = \?/i.test(sql)) out = out.filter((r) => r.status === args[0]);
      out.sort((a, b) => b.last_seen_at - a.last_seen_at || b.id - a.id);
      const limit = args[args.length - 1];
      return { results: out.slice(0, limit) };
    },
  });
  return { _rows: rows, prepare: (sql) => stmt(sql) };
}

const envWith = (db) => /** @type {any} */ ({ DB: db });
// getDb() applies schema lazily via db.batch on the FIRST call per isolate; our
// fake env skips that by giving getDb a db without batch — so we bypass getDb
// and hand recordServerError/handler an env whose getDb path still works. getDb
// only calls batch when `migrated` is false; since other test files in the same
// process may have flipped it, add a no-op batch to be safe.
function envDb() {
  const db = fakeDb();
  /** @type {any} */ (db).batch = async () => [];
  return { db, env: envWith(db) };
}

// ---- signature / normalization ---------------------------------------------

test("normalizePath collapses numeric ids and UUIDs to :id", () => {
  assert.equal(normalizePath("/api/feedback/12/messages"), "/api/feedback/:id/messages");
  assert.equal(
    normalizePath("/api/errors/6a02b3bd-ebbb-4c0e-bd6e-fafd35df69c2"),
    "/api/errors/:id",
  );
  assert.equal(normalizePath("/api/chat?x=1"), "/api/chat"); // query dropped
  assert.equal(normalizePath("/story/"), "/story/");
});

test("normalizeMessage masks volatile tokens so recurrences group", () => {
  const a = normalizeMessage("Cannot read property 'foo' of undefined at id 12345");
  const b = normalizeMessage("Cannot read property 'bar' of undefined at id 98");
  assert.equal(a, b, "quoted literals + numbers masked → identical");
});

test("errorSignature: same bug with different ids → same signature", () => {
  const s1 = errorSignature({ method: "post", path: "/api/feedback/12/messages", message: "boom 12" });
  const s2 = errorSignature({ method: "POST", path: "/api/feedback/98/messages", message: "boom 98" });
  assert.equal(s1, s2);
  assert.ok(s1.startsWith("POST "), "method uppercased");
});

test("errorSignature: different route → different signature", () => {
  assert.notEqual(
    errorSignature({ method: "GET", path: "/api/me", message: "x" }),
    errorSignature({ method: "GET", path: "/api/models", message: "x" }),
  );
});

// ---- status helpers ---------------------------------------------------------

test("status helpers", () => {
  assert.equal(isOpenErrorStatus("open"), true);
  assert.equal(isOpenErrorStatus("fixed"), false);
  assert.equal(isOpenErrorStatus("ignored"), false);
  assert.equal(normalizeErrorStatus("fixed"), "fixed");
  assert.equal(normalizeErrorStatus("bogus"), null);
  assert.equal(normalizeErrorStatus(42), null);
  assert.deepEqual(SERVER_ERROR_STATUSES, ["open", "fixed", "ignored"]);
});

// ---- projection + text render ----------------------------------------------

test("projectServerError shapes the API object", () => {
  const p = projectServerError({
    id: 3, signature: "GET /api/me :: boom", first_seen_at: 1000, last_seen_at: 2000,
    count: 4, status: "open", method: "GET", path: "/api/me", message: "boom",
    stack: "Error: boom\n  at x", request_id: "req-1", note: null, updated_at: 2000,
  });
  assert.equal(p.open, true);
  assert.equal(p.count, 4);
  assert.equal(p.last_time, new Date(2000).toISOString());
  assert.equal(p.request_id, "req-1");
});

test("formatServerErrorsText renders an agent-readable block", () => {
  const text = formatServerErrorsText([
    projectServerError({
      id: 7, signature: "POST /api/chat :: boom", first_seen_at: 1000, last_seen_at: 5000,
      count: 3, status: "open", method: "POST", path: "/api/chat", message: "boom",
      stack: "Error: boom", request_id: "req-9", note: "under investigation", updated_at: 5000,
    }),
  ]);
  assert.match(text, /#7/);
  assert.match(text, /×3/);
  assert.match(text, /POST \/api\/chat/);
  assert.match(text, /ref=req-9/);
  assert.match(text, /ERROR: boom/);
  assert.match(text, /NOTE: under investigation/);
  assert.match(text, /STACK:/);
  assert.match(text, /FIRST SEEN:/);
});

test("formatServerErrorsText: empty set", () => {
  assert.equal(formatServerErrorsText([]), "(no server errors match)\n");
});

// ---- recordServerError (the crash recorder) --------------------------------

test("recordServerError inserts one row, then dedups a recurrence", async () => {
  const { db, env } = envDb();
  const id1 = await recordServerError(env, noopLog, {
    requestId: "req-a", method: "POST", path: "/api/chat", message: "boom 1", stack: "s",
  });
  const id2 = await recordServerError(env, noopLog, {
    requestId: "req-b", method: "POST", path: "/api/chat", message: "boom 2", stack: "s",
  });
  assert.equal(id1, id2, "same signature → same row");
  assert.equal(db._rows.length, 1);
  assert.equal(db._rows[0].count, 2, "recurrence bumped count");
  assert.equal(db._rows[0].request_id, "req-b", "latest sample kept");
});

test("recordServerError reopens a fixed row on recurrence (regression)", async () => {
  const { db, env } = envDb();
  await recordServerError(env, noopLog, { requestId: "r1", method: "GET", path: "/api/me", message: "x" });
  db._rows[0].status = "fixed";
  await recordServerError(env, noopLog, { requestId: "r2", method: "GET", path: "/api/me", message: "x" });
  assert.equal(db._rows[0].status, "open", "fixed → reopened");
});

test("recordServerError leaves an ignored row ignored on recurrence", async () => {
  const { db, env } = envDb();
  await recordServerError(env, noopLog, { requestId: "r1", method: "GET", path: "/api/me", message: "x" });
  db._rows[0].status = "ignored";
  await recordServerError(env, noopLog, { requestId: "r2", method: "GET", path: "/api/me", message: "x" });
  assert.equal(db._rows[0].status, "ignored");
});

test("recordServerError is fail-soft with no DB", async () => {
  const id = await recordServerError(/** @type {any} */ ({}), noopLog, {
    requestId: "r", method: "GET", path: "/", message: "x",
  });
  assert.equal(id, null);
});

// ---- the admin handler ------------------------------------------------------

async function seed(env) {
  await recordServerError(env, noopLog, { requestId: "r1", method: "POST", path: "/api/chat", message: "chat boom", stack: "s1" });
  await recordServerError(env, noopLog, { requestId: "r2", method: "GET", path: "/api/me", message: "me boom", stack: "s2" });
}

test("GET /api/admin/errors lists newest-failure first", async () => {
  const { env } = envDb();
  await seed(env);
  const url = new URL("https://deepresearch.se/api/admin/errors");
  const res = await handleAdminServerErrors(new Request(url), env, url, noopLog);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 2);
  assert.equal(body.errors[0].path, "/api/me", "most recent first");
});

test("GET ?open=1 filters to the work queue", async () => {
  const { db, env } = envDb();
  await seed(env);
  db._rows.find((r) => r.path === "/api/me").status = "fixed";
  const url = new URL("https://deepresearch.se/api/admin/errors?open=1");
  const res = await handleAdminServerErrors(new Request(url), env, url, noopLog);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.errors[0].path, "/api/chat");
});

test("GET ?format=text renders the readable queue", async () => {
  const { env } = envDb();
  await seed(env);
  const url = new URL("https://deepresearch.se/api/admin/errors?format=text");
  const res = await handleAdminServerErrors(new Request(url), env, url, noopLog);
  assert.match(res.headers.get("content-type") || "", /text\/plain/);
  const text = await res.text();
  assert.match(text, /\/api\/chat/);
  assert.match(text, /\/api\/me/);
});

test("PATCH /api/admin/errors/:id sets status + note", async () => {
  const { db, env } = envDb();
  await seed(env);
  const id = db._rows[0].id;
  const url = new URL(`https://deepresearch.se/api/admin/errors/${id}`);
  const res = await handleAdminServerErrors(
    new Request(url, { method: "PATCH", body: JSON.stringify({ status: "fixed", note: "patched" }) }),
    env, url, noopLog,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.error_entry.status, "fixed");
  assert.equal(body.error_entry.note, "patched");
});

test("PATCH rejects a bad status", async () => {
  const { db, env } = envDb();
  await seed(env);
  const id = db._rows[0].id;
  const url = new URL(`https://deepresearch.se/api/admin/errors/${id}`);
  const res = await handleAdminServerErrors(
    new Request(url, { method: "PATCH", body: JSON.stringify({ status: "nope" }) }),
    env, url, noopLog,
  );
  assert.equal(res.status, 400);
});

test("DELETE /api/admin/errors/:id removes the row", async () => {
  const { db, env } = envDb();
  await seed(env);
  const id = db._rows[0].id;
  const url = new URL(`https://deepresearch.se/api/admin/errors/${id}`);
  const res = await handleAdminServerErrors(new Request(url, { method: "DELETE" }), env, url, noopLog);
  assert.equal(res.status, 200);
  assert.equal(db._rows.find((r) => r.id === id), undefined);
});

test("GET /api/admin/errors/:id 404s for an unknown id", async () => {
  const { env } = envDb();
  const url = new URL("https://deepresearch.se/api/admin/errors/999");
  const res = await handleAdminServerErrors(new Request(url), env, url, noopLog);
  assert.equal(res.status, 404);
});
