// The consolidated Se/rver-token grant subsystem (src/server-grants.js):
// ghost mint/reuse of the ONE JWT, the per-permission atomic reserve/refund
// meter, the non-consuming status, per-permission quota adjust, the global
// budget ceiling, revocation, the endpoint status codes — and THE
// SERVER-TOKEN GUARANTEE's module-graph pin (upstream APIs only, never any
// Se/rver data). D1 is a small in-memory fake keyed (jti, service); Exa and
// Berget are mocked global fetches; config defaults come from the real
// getConfig (the fake returns null for the config row so DEFAULT_CONFIG
// applies). The security-critical JWT half is covered in server-token.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adjustServerTokenQuota,
  grantServerToken,
  handleAdminServerToken,
  handleServerTokenAdjust,
  handleServerTokenGrant,
  handleServerTokenLlm,
  handleServerTokenStatus,
  handleServerTokenWeb,
  mintServerTokenGrant,
  revokeServerToken,
  serverTokenStatus,
} from "./server-grants.js";
import { verifyServerToken } from "./server-token.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const log = { info() {}, warn() {}, error() {}, debug() {} };

// A minimal in-memory D1 recognizing the statements server-grants.js + config.js
// run. Rows are keyed `${jti}|${service}` — the (jti, service) primary key.
function fakeDb() {
  const rows = new Map();
  const live = (t) => [...rows.values()].filter((r) => r.expires_at > t);
  const stmt = (sql) => ({
    _args: [],
    bind(...a) {
      this._args = a;
      return this;
    },
    async first() {
      if (sql.includes("SUM(quota - used)")) {
        const [t] = this._args;
        return { rem: live(t).reduce((a, r) => a + (r.quota - r.used), 0) };
      }
      if (sql.includes("source = 'ghost'")) {
        const [uid, t] = this._args;
        return (
          live(t)
            .filter((r) => r.user_id === uid && r.source === "ghost")
            .sort((a, b) => b.created_at - a.created_at)[0] || null
        );
      }
      if (sql.includes("WHERE jti = ?1 AND service = ?2")) {
        return rows.get(`${this._args[0]}|${this._args[1]}`) || null;
      }
      // config.js: SELECT value FROM config WHERE key='app' → no row → defaults
      return null;
    },
    async all() {
      if (sql.includes("WHERE jti = ?1 AND expires_at")) {
        const [jti, t] = this._args;
        return { results: live(t).filter((r) => r.jti === jti) };
      }
      if (sql.includes("WHERE jti = ?1")) {
        const [jti] = this._args;
        return { results: [...rows.values()].filter((r) => r.jti === jti) };
      }
      const [t] = this._args;
      return { results: live(t).sort((a, b) => b.created_at - a.created_at) };
    },
    async run() {
      if (sql.startsWith("INSERT")) {
        const [jti, service, user_id, quota, created_at, expires_at, label, source] = this._args;
        rows.set(`${jti}|${service}`, { jti, service, user_id, quota, used: 0, created_at, expires_at, label, source });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("used = used + 1")) {
        const [jti, service, t] = this._args;
        const r = rows.get(`${jti}|${service}`);
        if (r && r.used < r.quota && r.expires_at > t) {
          r.used++;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      if (sql.includes("used = used - 1")) {
        const r = rows.get(`${this._args[0]}|${this._args[1]}`);
        if (r && r.used > 0) {
          r.used--;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      if (sql.includes("SET quota =")) {
        const [jti, service, quota] = this._args;
        const r = rows.get(`${jti}|${service}`);
        if (!r) return { meta: { changes: 0 } };
        r.quota = quota;
        return { meta: { changes: 1 } };
      }
      if (sql.startsWith("DELETE")) {
        const [jti] = this._args;
        let n = 0;
        for (const k of [...rows.keys()]) {
          if (k.startsWith(`${jti}|`)) {
            rows.delete(k);
            n++;
          }
        }
        return { meta: { changes: n } };
      }
      return { meta: { changes: 0 } };
    },
  });
  return { _rows: rows, prepare: stmt, async batch() { return []; } };
}

const envWith = (db) => ({ DB: db, SESSION_SECRET: SECRET, EXA_API_KEY: "exa-test", BERGET_API_TOKEN: "berget-test" });
const identity = { id: "42", role: "user", email: "u@x", name: "U" };
const admin = { id: "admin", role: "admin", email: null, name: "Admin" };
const post = (path, body) => new Request("https://x" + path, { method: "POST", body: JSON.stringify(body) });
const adminReq = (path, method, body) =>
  new Request("https://x/api/admin/server-token" + path, { method, body: body ? JSON.stringify(body) : undefined });
const adminUrl = (path) => new URL("https://x/api/admin/server-token" + path);
const row = (db, jti, svc) => db._rows.get(`${jti}|${svc}`);

function mockFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (...a) => handler(...a);
  return () => {
    globalThis.fetch = orig;
  };
}
const mockExa = (results) => mockFetch(async () => new Response(JSON.stringify({ results }), { status: 200 }));

// ---- ghost-crossover grant ----------------------------------------------------------

test("grantServerToken mints ONE JWT covering web+api (config defaults), then reuses it", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g1 = await grantServerToken(env, log, identity);
  assert.ok(g1);
  assert.deepEqual(g1.perms, ["web", "api"]);
  assert.equal(db._rows.size, 2); // one row per permission, same jti
  assert.equal(row(db, g1.jti, "web").quota, 25); // DEFAULT_CONFIG.server_token.web_quota
  assert.equal(row(db, g1.jti, "api").quota, 40); // …api_quota
  const claims = await verifyServerToken(env, g1.token);
  assert.equal(claims.jti, g1.jti);
  assert.equal(claims.sub, "42");
  assert.deepEqual(claims.perms, ["web", "api"]);

  const g2 = await grantServerToken(env, log, identity);
  assert.equal(db._rows.size, 2); // reused, not stacked
  assert.equal(g2.jti, g1.jti);
  assert.ok(await verifyServerToken(env, g2.token)); // the re-minted JWT works too
});

test("grantServerToken returns null without D1; handler answers 503", async () => {
  assert.equal(await grantServerToken({ SESSION_SECRET: SECRET }, log, identity), null);
  const res = await handleServerTokenGrant(post("/api/server-token/grant", {}), { SESSION_SECRET: SECRET }, log, identity);
  assert.equal(res.status, 503);
});

// ---- mint + budget ceiling ----------------------------------------------------------

test("mintServerTokenGrant honors explicit per-permission quotas and the budget ceiling", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, {
    userId: "admin",
    services: ["web"],
    quotas: { web: 100 },
    ttlHours: 48,
    label: "campaign",
  });
  assert.deepEqual(g.perms, ["web"]);
  assert.equal(g.services[0].quota, 100);

  // A budget ceiling counts ALL outstanding remaining (the 100 above).
  const over = await mintServerTokenGrant(env, log, {
    userId: "admin",
    defaults: { enabled: true, quotas: { web: 25, api: 40 }, ttlHours: 24, budget: 120 },
  });
  assert.equal(over.error, "budget_exceeded");
});

test("unknown services never mint; an empty set is refused", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "admin", services: ["web", "projects"] });
  assert.deepEqual(g.perms, ["web"]); // the unknown value is dropped
  assert.equal(await mintServerTokenGrant(env, log, { userId: "admin", services: ["projects"] }), null);
});

// ---- status (non-consuming) ---------------------------------------------------------

test("status reads live per-permission state without consuming; revocation kills it", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "admin" });
  const s = await serverTokenStatus(env, g.token);
  assert.deepEqual(
    s.services.map((v) => [v.svc, v.remaining]),
    [["web", 25], ["api", 40]],
  );
  assert.equal(row(db, g.jti, "web").used, 0); // nothing consumed

  const res = await handleServerTokenStatus(post("/api/server-token/status", { token: g.token }), env);
  assert.equal(res.status, 200);

  await revokeServerToken(env, g.jti);
  assert.equal(await serverTokenStatus(env, g.token), null);
  assert.equal((await handleServerTokenStatus(post("/api/server-token/status", { token: g.token }), env)).status, 403);
});

// ---- the metered web search ---------------------------------------------------------

test("a web call meters one unit from the web row only, and returns results + remaining", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "admin" });
  const restore = mockExa([{ title: "T", url: "https://e/1", highlights: ["h"] }]);
  try {
    const res = await handleServerTokenWeb(post("/api/server-token/web", { token: g.token, query: "what is x" }), env, log);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.resultCount, 1);
    assert.equal(body.remaining, 24);
    assert.equal(row(db, g.jti, "api").used, 0); // the api permission is untouched
  } finally {
    restore();
  }
});

test("an empty search refunds; exhaustion 429; revoked 403; a web-less token 403", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "admin", quotas: { web: 1 } });
  let restore = mockExa([]);
  try {
    const res = await handleServerTokenWeb(post("/api/server-token/web", { token: g.token, query: "no hits" }), env, log);
    assert.equal((await res.json()).resultCount, 0);
    assert.equal(row(db, g.jti, "web").used, 0); // refunded
  } finally {
    restore();
  }
  restore = mockExa([{ title: "T", url: "https://e/1", highlights: [] }]);
  try {
    assert.equal((await handleServerTokenWeb(post("/api/server-token/web", { token: g.token, query: "q1" }), env, log)).status, 200);
    assert.equal((await handleServerTokenWeb(post("/api/server-token/web", { token: g.token, query: "q2" }), env, log)).status, 429);
    await revokeServerToken(env, g.jti);
    assert.equal((await handleServerTokenWeb(post("/api/server-token/web", { token: g.token, query: "q3" }), env, log)).status, 403);

    // A token whose permission set never included web is refused up front.
    const apiOnly = await mintServerTokenGrant(env, log, { userId: "admin", services: ["api"] });
    assert.equal(
      (await handleServerTokenWeb(post("/api/server-token/web", { token: apiOnly.token, query: "q" }), env, log)).status,
      403,
    );
  } finally {
    restore();
  }
});

// ---- the metered LLM reverse proxy --------------------------------------------------

test("an LLM completion meters the api row, returns remaining; upstream failure refunds", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "admin" });
  const url = new URL("https://x/api/server-token/llm/chat/completions");
  const req = () =>
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${g.token}` },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });

  let restore = mockFetch(async () => new Response(JSON.stringify({ id: "c1", choices: [] }), { status: 200 }));
  try {
    const res = await handleServerTokenLlm(req(), env, log, url);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).remaining, 39);
    assert.equal(row(db, g.jti, "web").used, 0); // the web permission is untouched
  } finally {
    restore();
  }

  restore = mockFetch(async () => new Response("boom", { status: 500 }));
  try {
    const res = await handleServerTokenLlm(req(), env, log, url);
    assert.equal(res.status, 502);
    assert.equal(row(db, g.jti, "api").used, 1); // the failed attempt was refunded
  } finally {
    restore();
  }
});

test("an embeddings batch meters the api row (RAG parity), refunds an empty result", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "admin" });
  const url = new URL("https://x/api/server-token/llm/embeddings");
  const req = () =>
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${g.token}` },
      body: JSON.stringify({ model: "intfloat/multilingual-e5-large", input: ["query: hi"] }),
    });

  let restore = mockFetch(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), { status: 200 }));
  try {
    const res = await handleServerTokenLlm(req(), env, log, url);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data[0].embedding, [1, 2, 3]);
    assert.equal(body.remaining, 39);
    assert.equal(row(db, g.jti, "web").used, 0); // web permission untouched
  } finally {
    restore();
  }

  restore = mockFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  try {
    const res = await handleServerTokenLlm(req(), env, log, url);
    assert.equal(res.status, 502);
    assert.equal(row(db, g.jti, "api").used, 1); // empty result refunded
  } finally {
    restore();
  }
});

test("LLM endpoint: models is non-metered; missing/api-less bearer is 403", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "admin" });
  const modelsUrl = new URL("https://x/api/server-token/llm/models");
  const restore = mockFetch(async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }));
  try {
    const ok = await handleServerTokenLlm(
      new Request(modelsUrl, { headers: { authorization: `Bearer ${g.token}` } }),
      env,
      log,
      modelsUrl,
    );
    assert.equal(ok.status, 200);
    assert.equal(row(db, g.jti, "api").used, 0); // catalog reads spend nothing

    assert.equal((await handleServerTokenLlm(new Request(modelsUrl), env, log, modelsUrl)).status, 403);
    const webOnly = await mintServerTokenGrant(env, log, { userId: "admin", services: ["web"] });
    assert.equal(
      (
        await handleServerTokenLlm(
          new Request(modelsUrl, { headers: { authorization: `Bearer ${webOnly.token}` } }),
          env,
          log,
          modelsUrl,
        )
      ).status,
      403,
    );
  } finally {
    restore();
  }
});

// ---- quota adjust (the minter control: token fixed, rows metered) --------------------

test("adjust: set/delta/pause per permission; owner scoping; budget-checked increase", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g = await mintServerTokenGrant(env, log, { userId: "42", source: "ghost" });

  const set = await adjustServerTokenQuota(env, log, g.jti, "web", { quota: 50 }, { ownerId: "42" });
  assert.equal(set.quota, 50);
  const bump = await adjustServerTokenQuota(env, log, g.jti, "api", { delta: -10 }, { ownerId: "42" });
  assert.equal(bump.quota, 30);
  const pause = await adjustServerTokenQuota(env, log, g.jti, "web", { quota: 0 }, { ownerId: "42" });
  assert.equal(pause.quota, 0); // 0 = paused; the reserve guard stops spending

  // Another user's jti reads as not_found (never confirmed to exist).
  assert.equal((await adjustServerTokenQuota(env, log, g.jti, "web", { quota: 5 }, { ownerId: "99" })).error, "not_found");
  // An increase past the global ceiling is refused like a mint.
  const over = await adjustServerTokenQuota(env, log, g.jti, "api", { delta: 1000 }, { ownerId: "42", budget: 100 });
  assert.equal(over.error, "budget_exceeded");

  // The endpoint: bad svc 400, foreign jti 404, good adjust 200.
  assert.equal((await handleServerTokenAdjust(post("/x", { jti: g.jti, svc: "nope", quota: 5 }), env, log, identity)).status, 400);
  assert.equal((await handleServerTokenAdjust(post("/x", { jti: g.jti, svc: "web", quota: 5 }), env, log, { ...identity, id: "99" })).status, 404);
  const ok = await handleServerTokenAdjust(post("/x", { jti: g.jti, svc: "web", quota: 5 }), env, log, identity);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).quota, 5);
});

// ---- the admin control surface ------------------------------------------------------

test("handleAdminServerToken: mint returns the JWT, GET lists grouped by jti, PATCH adjusts, DELETE revokes", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const mint = await handleAdminServerToken(
    adminReq("", "POST", { label: "demo", quotas: { web: 10 }, ttlHours: 2 }),
    env,
    adminUrl(""),
    log,
    admin,
  );
  assert.equal(mint.status, 200);
  const minted = await mint.json();
  assert.ok(await verifyServerToken(env, minted.token));
  assert.deepEqual(minted.perms, ["web", "api"]);
  // The shareable link the /cure client reads (?st=), same convention as ?ws=.
  assert.ok(minted.link.startsWith("https://x/cure?st="), minted.link);
  assert.ok(await verifyServerToken(env, decodeURIComponent(minted.link.split("?st=")[1])));

  const list = await handleAdminServerToken(adminReq("", "GET"), env, adminUrl(""), log, admin);
  const body = await list.json();
  assert.equal(body.grants.length, 1);
  assert.equal(body.grants[0].services.length, 2);
  assert.equal(body.outstanding, 10 + 40);

  const patched = await handleAdminServerToken(
    adminReq(`/${minted.jti}/web`, "PATCH", { delta: 5 }),
    env,
    adminUrl(`/${minted.jti}/web`),
    log,
    admin,
  );
  assert.equal((await patched.json()).quota, 15);

  const del = await handleAdminServerToken(adminReq(`/${minted.jti}`, "DELETE"), env, adminUrl(`/${minted.jti}`), log, admin);
  assert.equal((await del.json()).ok, true);
  assert.equal(db._rows.size, 0);

  // No D1 → the whole surface is 503 (fail-safe).
  assert.equal((await handleAdminServerToken(adminReq("", "GET"), { SESSION_SECRET: SECRET }, adminUrl(""), log, admin)).status, 503);
});

// ---- THE SERVER-TOKEN GUARANTEE: the module-graph pin ---------------------------------
// A Se/rver token grants upstream API access ONLY. The endpoints live in a
// module that must never even IMPORT a data-bearing module — so "hand out
// project or chat contents to a token call" is impossible by module graph,
// not just by review. This test fails the suite if such an import appears.

test("server-grants.js imports stay inside the upstream-only allowlist (no data-bearing modules)", () => {
  const src = readFileSync(new URL("./server-grants.js", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import[^"']+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  const allowed = new Set([
    "./config.js",
    "./db.js",
    "./exa.js",
    "./grant-http.js",
    "./http.js",
    "./llm-proxy.js",
    "./server-token.js",
  ]);
  for (const spec of imports) {
    assert.ok(allowed.has(spec), `unexpected import in server-grants.js: ${spec} — see THE SERVER-TOKEN GUARANTEE`);
  }
  // The data-bearing modules, by name, never appear as imports.
  for (const banned of ["storage.js", "vault.js", "chatlog.js", "accounts.js", "rag.js", "pub.js", "answers.js", "settings.js", "history-key.js"]) {
    assert.ok(!imports.some((s) => s.endsWith("/" + banned)), `data-bearing import in server-grants.js: ${banned}`);
  }
  // And the token half is a near-leaf: crypto primitives only.
  const tok = readFileSync(new URL("./server-token.js", import.meta.url), "utf8");
  const tokImports = [...tok.matchAll(/^import[^"']+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  assert.deepEqual(tokImports, ["./token-crypto.js"]);
  // And the shared LLM forwarder is a LEAF (response helper only) — importing
  // it can never drag bundle/token/D1 machinery into this graph.
  const fwd = readFileSync(new URL("./llm-proxy.js", import.meta.url), "utf8");
  const fwdImports = [...fwd.matchAll(/^import[^"']+["']([^"']+)["'];?$/gm)].map((m) => m[1]);
  assert.deepEqual(fwdImports, ["./http.js"]);
});
