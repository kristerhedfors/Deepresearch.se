// The web-search grant METER (src/websearch.js): grant reuse-per-user, the
// atomic reserve/refund of the D1 quota, and the endpoint status codes. D1 is a
// small in-memory fake keyed to the exact statements the module runs; Exa is a
// mocked global fetch. The security-critical token half is covered separately
// in websearch-key.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { grantWebSearch, handleWebSearch, handleWebSearchGrant } from "./websearch.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const log = { info() {}, warn() {}, error() {}, debug() {} };

// A minimal in-memory D1 recognizing only the statements websearch.js runs.
function fakeDb() {
  const rows = new Map();
  const stmt = (sql) => ({
    _sql: sql,
    _args: [],
    bind(...a) {
      this._args = a;
      return this;
    },
    async first() {
      if (sql.includes("expires_at DESC")) {
        const [uid, nowS] = this._args;
        return (
          [...rows.values()]
            .filter((r) => r.user_id === uid && r.expires_at > nowS)
            .sort((a, b) => b.expires_at - a.expires_at)[0] || null
        );
      }
      if (sql.includes("SELECT quota, used")) {
        const r = rows.get(this._args[0]);
        return r ? { quota: r.quota, used: r.used } : null;
      }
      return null;
    },
    async run() {
      if (sql.startsWith("INSERT")) {
        const [jti, user_id, quota, created_at, expires_at] = this._args;
        rows.set(jti, { jti, user_id, quota, used: 0, created_at, expires_at });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("used = used + 1")) {
        const [jti, nowS] = this._args;
        const r = rows.get(jti);
        if (r && r.used < r.quota && r.expires_at > nowS) {
          r.used++;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      if (sql.includes("used = used - 1")) {
        const r = rows.get(this._args[0]);
        if (r && r.used > 0) {
          r.used--;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      return { meta: { changes: 0 } };
    },
  });
  return { _rows: rows, prepare: stmt, async batch() { return []; } };
}

const envWith = (db, extra = {}) => ({ DB: db, SESSION_SECRET: SECRET, EXA_API_KEY: "exa-test", ...extra });
const identity = { id: "42", role: "user", email: "u@x", name: "U" };
const post = (body) => new Request("https://x/api/websearch", { method: "POST", body: JSON.stringify(body) });

// Mock Exa: `results` non-empty = a usable search; empty = a miss.
function mockFetch(results) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ results }), { status: 200 });
  return () => {
    globalThis.fetch = orig;
  };
}

test("grantWebSearch creates a grant, then reuses it for the same user", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g1 = await grantWebSearch(env, log, identity);
  assert.ok(g1?.token.startsWith("wsk1."));
  assert.equal(g1.quota, 25);
  assert.equal(g1.remaining, 25);
  const g2 = await grantWebSearch(env, log, identity);
  // Same underlying row reused → only one grant exists for the user.
  assert.equal(db._rows.size, 1);
  assert.equal(g2.remaining, 25);
});

test("grantWebSearch returns null without D1 (feature off)", async () => {
  assert.equal(await grantWebSearch({ SESSION_SECRET: SECRET }, log, identity), null);
});

test("WEBSEARCH_GRANT_QUOTA overrides the default quota", async () => {
  const g = await grantWebSearch(envWith(fakeDb(), { WEBSEARCH_GRANT_QUOTA: "3" }), log, identity);
  assert.equal(g.quota, 3);
});

test("handleWebSearch: 400 when token/query missing", async () => {
  const res = await handleWebSearch(post({ query: "hi" }), envWith(fakeDb()), log);
  assert.equal(res.status, 400);
});

test("handleWebSearch: 403 on a bad token", async () => {
  const res = await handleWebSearch(post({ token: "wsk1.bad.sig", query: "hi" }), envWith(fakeDb()), log);
  assert.equal(res.status, 403);
});

test("a granted search meters one unit and returns results + remaining", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const grant = await grantWebSearch(env, log, identity);
  const restore = mockFetch([{ title: "T", url: "https://e/1", highlights: ["h"] }]);
  try {
    const res = await handleWebSearch(post({ token: grant.token, query: "what is x" }), env, log);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resultCount, 1);
    assert.equal(body.remaining, 24);
    assert.equal([...db._rows.values()][0].used, 1);
  } finally {
    restore();
  }
});

test("an empty search refunds the reservation (quota not burned)", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const grant = await grantWebSearch(env, log, identity);
  const restore = mockFetch([]); // no results
  try {
    const res = await handleWebSearch(post({ token: grant.token, query: "no hits" }), env, log);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resultCount, 0);
    assert.equal([...db._rows.values()][0].used, 0); // refunded
  } finally {
    restore();
  }
});

test("an exhausted grant returns 429", async () => {
  const db = fakeDb();
  const env = envWith(db, { WEBSEARCH_GRANT_QUOTA: "1" });
  const grant = await grantWebSearch(env, log, identity);
  const restore = mockFetch([{ title: "T", url: "https://e/1", highlights: [] }]);
  try {
    const ok = await handleWebSearch(post({ token: grant.token, query: "q1" }), env, log);
    assert.equal(ok.status, 200);
    const blocked = await handleWebSearch(post({ token: grant.token, query: "q2" }), env, log);
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.remaining, 0);
  } finally {
    restore();
  }
});

test("handleWebSearchGrant: 503 without D1", async () => {
  const res = await handleWebSearchGrant(post({}), { SESSION_SECRET: SECRET }, log, identity);
  assert.equal(res.status, 503);
});
