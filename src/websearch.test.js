// The web-search grant subsystem (src/websearch.js): grant reuse-per-user, the
// atomic reserve/refund of the D1 quota, the mint/status/list/revoke surface,
// the global budget ceiling, and the endpoint status codes. D1 is a small
// in-memory fake keyed to the statements the module runs; Exa is a mocked
// global fetch; config defaults (quota 25, budget 0) come from the real
// getConfig — the fake returns null for the config row so DEFAULT_CONFIG applies.
// The security-critical token half is covered in websearch-key.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  grantStatus,
  grantWebSearch,
  handleAdminWebSearch,
  handleWebSearch,
  handleWebSearchGrant,
  handleWebSearchStatus,
  mintWebSearchGrant,
  revokeGrant,
} from "./websearch.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const log = { info() {}, warn() {}, error() {}, debug() {} };

// A minimal in-memory D1 recognizing the statements websearch.js + config.js run.
function fakeDb() {
  const rows = new Map();
  const nowS = () => Math.floor(Date.now() / 1000);
  const stmt = (sql) => ({
    _sql: sql,
    _args: [],
    bind(...a) {
      this._args = a;
      return this;
    },
    async first() {
      if (sql.includes("SUM(quota - used)")) {
        const [t] = this._args;
        const rem = [...rows.values()].filter((r) => r.expires_at > t).reduce((a, r) => a + (r.quota - r.used), 0);
        return { rem };
      }
      if (sql.includes("source = 'ghost'")) {
        const [uid, t] = this._args;
        return (
          [...rows.values()]
            .filter((r) => r.user_id === uid && r.source === "ghost" && r.expires_at > t)
            .sort((a, b) => b.expires_at - a.expires_at)[0] || null
        );
      }
      if (sql.includes("FROM websearch_grants WHERE jti")) {
        return rows.get(this._args[0]) || null;
      }
      // config.js: SELECT value FROM config WHERE key='app' → no row → defaults
      return null;
    },
    async all() {
      const [t] = this._args;
      return {
        results: [...rows.values()].filter((r) => r.expires_at > t).sort((a, b) => b.created_at - a.created_at),
      };
    },
    async run() {
      if (sql.startsWith("INSERT")) {
        const [jti, user_id, quota, created_at, expires_at, label, source] = this._args;
        rows.set(jti, { jti, user_id, quota, used: 0, created_at, expires_at, label, source });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("used = used + 1")) {
        const [jti, t] = this._args;
        const r = rows.get(jti);
        if (r && r.used < r.quota && r.expires_at > t) {
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
      if (sql.startsWith("DELETE")) {
        const had = rows.delete(this._args[0]);
        return { meta: { changes: had ? 1 : 0 } };
      }
      return { meta: { changes: 0 } };
    },
  });
  return { _rows: rows, _nowS: nowS, prepare: stmt, async batch() { return []; } };
}

const envWith = (db) => ({ DB: db, SESSION_SECRET: SECRET, EXA_API_KEY: "exa-test" });
const identity = { id: "42", role: "user", email: "u@x", name: "U" };
const admin = { id: "admin", role: "admin", email: null, name: "Admin" };
const post = (path, body) => new Request("https://x" + path, { method: "POST", body: JSON.stringify(body) });
const adminReq = (path, method, body) =>
  new Request("https://x/api/admin/websearch" + path, { method, body: body ? JSON.stringify(body) : undefined });

function mockFetch(results) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ results }), { status: 200 });
  return () => {
    globalThis.fetch = orig;
  };
}

// ---- ghost-crossover grant ----------------------------------------------------------

test("grantWebSearch creates a ghost grant (config default quota), then reuses it", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g1 = await grantWebSearch(env, log, identity);
  assert.ok(g1?.token.startsWith("wsk1."));
  assert.equal(g1.quota, 25); // DEFAULT_CONFIG.websearch.quota
  assert.equal(g1.source, "ghost");
  const g2 = await grantWebSearch(env, log, identity);
  assert.equal(db._rows.size, 1); // reused, not stacked
  assert.equal(g2.remaining, 25);
});

test("grantWebSearch returns null without D1", async () => {
  assert.equal(await grantWebSearch({ SESSION_SECRET: SECRET }, log, identity), null);
});

// ---- mint (the shareable-link path) -------------------------------------------------

test("mintWebSearchGrant mints a link grant with an explicit quota", async () => {
  const g = await mintWebSearchGrant(envWith(fakeDb()), log, { quota: 100, ttlHours: 48, userId: "admin", source: "link", label: "campaign" });
  assert.equal(g.quota, 100);
  assert.equal(g.source, "link");
  assert.equal(g.label, "campaign");
  assert.ok(g.token.startsWith("wsk1."));
});

test("mintWebSearchGrant enforces the global budget ceiling", async () => {
  const db = fakeDb();
  const env = envWith(db);
  await mintWebSearchGrant(env, log, { quota: 40, ttlHours: 24, userId: "admin", budget: 50 });
  // 40 already outstanding, budget 50 → a 20-key would exceed.
  const blocked = await mintWebSearchGrant(env, log, { quota: 20, ttlHours: 24, userId: "admin", budget: 50 });
  assert.equal(blocked.error, "budget_exceeded");
  assert.equal(db._rows.size, 1); // no second row created
});

// ---- status (non-consuming) ---------------------------------------------------------

test("grantStatus reads remaining without consuming, null on revoke", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 10, ttlHours: 24, userId: "admin" });
  const s = await grantStatus(env, g.token);
  assert.equal(s.remaining, 10);
  assert.equal(g.used, 0); // status didn't consume
  await revokeGrant(env, g.jti);
  assert.equal(await grantStatus(env, g.token), null); // row gone
});

test("handleWebSearchStatus: 400 no token, 403 bad token, 200 ok", async () => {
  const db = fakeDb();
  const env = envWith(db);
  assert.equal((await handleWebSearchStatus(post("/api/websearch/status", {}), env)).status, 400);
  assert.equal((await handleWebSearchStatus(post("/api/websearch/status", { token: "wsk1.x.y" }), env)).status, 403);
  const g = await mintWebSearchGrant(env, log, { quota: 5, ttlHours: 24, userId: "admin" });
  const ok = await handleWebSearchStatus(post("/api/websearch/status", { token: g.token }), env);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).remaining, 5);
});

// ---- the metered search -------------------------------------------------------------

test("a granted search meters one unit and returns results + remaining", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 25, ttlHours: 24, userId: "admin" });
  const restore = mockFetch([{ title: "T", url: "https://e/1", highlights: ["h"] }]);
  try {
    const res = await handleWebSearch(post("/api/websearch", { token: g.token, query: "what is x" }), env, log);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resultCount, 1);
    assert.equal(body.remaining, 24);
  } finally {
    restore();
  }
});

test("an empty search refunds the reservation", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 5, ttlHours: 24, userId: "admin" });
  const restore = mockFetch([]);
  try {
    const res = await handleWebSearch(post("/api/websearch", { token: g.token, query: "no hits" }), env, log);
    assert.equal((await res.json()).resultCount, 0);
    assert.equal(db._rows.get(g.jti).used, 0);
  } finally {
    restore();
  }
});

test("an exhausted grant returns 429; a revoked grant returns 403", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintWebSearchGrant(env, log, { quota: 1, ttlHours: 24, userId: "admin" });
  const restore = mockFetch([{ title: "T", url: "https://e/1", highlights: [] }]);
  try {
    assert.equal((await handleWebSearch(post("/api/websearch", { token: g.token, query: "q1" }), env, log)).status, 200);
    assert.equal((await handleWebSearch(post("/api/websearch", { token: g.token, query: "q2" }), env, log)).status, 429);
    await revokeGrant(env, g.jti);
    assert.equal((await handleWebSearch(post("/api/websearch", { token: g.token, query: "q3" }), env, log)).status, 403);
  } finally {
    restore();
  }
});

// ---- the admin control surface ------------------------------------------------------

test("handleAdminWebSearch: mint returns a shareable link, GET lists it, DELETE revokes", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const minted = await handleAdminWebSearch(adminReq("/mint", "POST", { quota: 50, label: "press" }), env, new URL("https://x/api/admin/websearch/mint"), log, admin);
  assert.equal(minted.status, 200);
  const m = await minted.json();
  assert.match(m.link, /^https:\/\/x\/cure\?ws=wsk1\./);
  assert.equal(m.quota, 50);

  const listed = await handleAdminWebSearch(adminReq("", "GET"), env, new URL("https://x/api/admin/websearch"), log, admin);
  const l = await listed.json();
  assert.equal(l.grants.length, 1);
  assert.equal(l.grants[0].label, "press");
  assert.equal(l.config.quota, 25); // config defaults surfaced
  assert.equal(l.outstanding, 50);

  const del = await handleAdminWebSearch(adminReq("/" + m.jti, "DELETE"), env, new URL("https://x/api/admin/websearch/" + m.jti), log, admin);
  assert.equal((await del.json()).ok, true);
  const after = await handleAdminWebSearch(adminReq("", "GET"), env, new URL("https://x/api/admin/websearch"), log, admin);
  assert.equal((await after.json()).grants.length, 0);
});

test("handleWebSearchGrant: 503 without D1", async () => {
  const res = await handleWebSearchGrant(post("/api/websearch/grant", {}), { SESSION_SECRET: SECRET }, log, identity);
  assert.equal(res.status, 503);
});
