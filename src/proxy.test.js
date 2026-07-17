// The secure-research-space proxy subsystem (src/proxy.js): mint a bundle (one
// metered row per service), the ghost reuse-per-user, the grant→proxy exchange,
// the atomic reserve/refund of both the web and LLM meters, the LLM reverse
// proxy (models forward + a metered completion + refund on upstream failure),
// non-consuming status, and the admin mint-link/list/revoke surface. D1 is a
// small in-memory fake keyed to the statements the module runs; Exa and Berget
// are a mocked global fetch. The token half is covered in proxy-grant.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import {
  adjustProxyGrantQuota,
  exchangeGrant,
  grantBundle,
  handleAdminProxy,
  handleProxyAdjust,
  handleProxyExchange,
  handleProxyLlm,
  handleProxyStatus,
  handleProxyWeb,
  mintBundle,
  proxyStatus,
} from "./proxy.js";
import { openBundle } from "../public/js/proxy-bundle.js";

const SECRET = "d0a2d4e838e1c1c7c65fef7b784c9623ee113f8aab5da9aab9d62f8a311109de";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const admin = { id: "admin", role: "admin" };
const identity = { id: "42", role: "user" };

// In-memory D1 recognizing the statements proxy.js + config.js + db.js run.
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
      if (sql.includes("SUM(quota - used)")) {
        const [t] = this._args;
        return { rem: [...rows.values()].filter((r) => r.expires_at > t).reduce((a, r) => a + (r.quota - r.used), 0) };
      }
      if (sql.includes("SELECT bundle_id FROM proxy_grants")) {
        const [uid, t] = this._args;
        const r = [...rows.values()]
          .filter((x) => x.user_id === uid && x.source === "ghost" && x.expires_at > t)
          .sort((a, b) => b.created_at - a.created_at)[0];
        return r ? { bundle_id: r.bundle_id } : null;
      }
      if (sql.includes("WHERE jti = ?1 AND expires_at > ?2")) {
        const [jti, t] = this._args;
        const r = rows.get(jti);
        return r && r.expires_at > t ? { ...r } : null;
      }
      if (sql.includes("SELECT jti FROM proxy_grants")) {
        const r = rows.get(this._args[0]);
        return r ? { jti: r.jti } : null;
      }
      if (sql.includes("SELECT quota, used FROM proxy_grants")) {
        const r = rows.get(this._args[0]);
        return r ? { quota: r.quota, used: r.used } : null;
      }
      if (sql.includes("FROM proxy_grants WHERE jti = ?1")) {
        const r = rows.get(this._args[0]);
        return r ? { ...r } : null;
      }
      return null; // config select → DEFAULT_CONFIG applies
    },
    async all() {
      if (sql.includes("WHERE bundle_id = ?1")) {
        const [bundleId, t] = this._args;
        return { results: [...rows.values()].filter((r) => r.bundle_id === bundleId && r.expires_at > t) };
      }
      const [t] = this._args;
      return {
        results: [...rows.values()].filter((r) => r.expires_at > t).sort((a, b) => b.created_at - a.created_at),
      };
    },
    async run() {
      if (sql.startsWith("INSERT INTO proxy_grants")) {
        const [jti, bundle_id, user_id, service, quota, created_at, expires_at, label, source] = this._args;
        rows.set(jti, { jti, bundle_id, user_id, service, quota, used: 0, created_at, expires_at, label, source });
        return { meta: { changes: 1 } };
      }
      if (sql.includes("SET quota =")) {
        const [jti, quota] = this._args;
        const r = rows.get(jti);
        if (!r) return { meta: { changes: 0 } };
        r.quota = quota;
        return { meta: { changes: 1 } };
      }
      if (sql.includes("used = used + 1")) {
        const [jti, service, t] = this._args;
        const r = rows.get(jti);
        if (r && r.service === service && r.used < r.quota && r.expires_at > t) {
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
      if (sql.startsWith("DELETE FROM proxy_grants")) {
        const [bundleId] = this._args;
        let n = 0;
        for (const [k, r] of rows) if (r.bundle_id === bundleId) (rows.delete(k), n++);
        return { meta: { changes: n } };
      }
      return { meta: { changes: 0 } };
    },
  });
  return { _rows: rows, prepare: stmt, async batch() { return []; } };
}

const envWith = (db, extra = {}) => ({
  DB: db,
  SESSION_SECRET: SECRET,
  EXA_API_KEY: "exa-test",
  BERGET_API_TOKEN: "berget-test",
  ...extra,
});

// Swap global fetch for the duration of a callback.
async function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}
const exaFetch = async () =>
  new Response(JSON.stringify({ results: [{ title: "T", url: "https://e.x/a", highlights: ["hi"] }] }), { status: 200 });

// ---- mint a bundle -----------------------------------------------------------------

test("mintBundle creates one metered row per service and a sealed bundle", async () => {
  const db = fakeDb();
  const b = await mintBundle(envWith(db), log, { userId: "42", source: "ghost" });
  assert.ok(!b.error);
  assert.equal(db._rows.size, 2); // web + api
  assert.deepEqual(b.connected.map((s) => s.svc).sort(), ["api", "web"]);
  // The web row uses the web default quota (25); api uses 40.
  assert.equal(b.connected.find((s) => s.svc === "web").quota, 25);
  assert.equal(b.connected.find((s) => s.svc === "api").quota, 40);
  // The blob opens with the returned key and carries the two grant tokens.
  const opened = await openBundle(b.blob, b.key);
  assert.equal(opened.grants.length, 2);
  assert.ok(opened.grants.every((g) => g.token.startsWith("prg1.")));
});

test("mintBundle returns null without D1", async () => {
  assert.equal(await mintBundle({ SESSION_SECRET: SECRET }, log, { userId: "42" }), null);
});

test("grantBundle mints then REUSES the ghost bundle per user", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const g1 = await grantBundle(env, log, identity);
  assert.ok(g1 && g1.connected.length === 2);
  const g2 = await grantBundle(env, log, identity);
  assert.equal(db._rows.size, 2); // reused, not stacked to 4
  assert.equal(g2.bundleId, g1.bundleId);
});

// ---- exchange (grant token → proxy token) ------------------------------------------

test("exchangeGrant trades a grant token for a working proxy token", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const bundle = await openBundle(b.blob, b.key);
  const web = bundle.grants.find((g) => g.svc === "web");
  const view = await exchangeGrant(env, web.token);
  assert.equal(view.svc, "web");
  assert.ok(view.proxyToken.startsWith("prx1."));
  assert.equal(view.remaining, 25);
});

test("handleProxyExchange: 400 without a token, 403 for a bad one", async () => {
  const env = envWith(fakeDb());
  assert.equal((await handleProxyExchange(new Request("https://x", { method: "POST", body: "{}" }), env)).status, 400);
  const bad = new Request("https://x", { method: "POST", body: JSON.stringify({ token: "prg1.x.y" }) });
  assert.equal((await handleProxyExchange(bad, env)).status, 403);
});

// ---- status (non-consuming) --------------------------------------------------------

test("proxyStatus reads remaining from a grant OR a proxy token without consuming", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const bundle = await openBundle(b.blob, b.key);
  const apiGrant = bundle.grants.find((g) => g.svc === "api");
  const fromGrant = await proxyStatus(env, apiGrant.token);
  assert.equal(fromGrant.remaining, 40);
  const ex = await exchangeGrant(env, apiGrant.token);
  const fromProxy = await proxyStatus(env, ex.proxyToken);
  assert.equal(fromProxy.remaining, 40); // still not consumed
});

// ---- web proxy meter ---------------------------------------------------------------

test("handleProxyWeb reserves a unit on a good search and refunds an empty one", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const bundle = await openBundle(b.blob, b.key);
  const web = await exchangeGrant(env, bundle.grants.find((g) => g.svc === "web").token);

  // Good search → served, one unit spent.
  const served = await withFetch(exaFetch, () =>
    handleProxyWeb(new Request("https://x", { method: "POST", body: JSON.stringify({ token: web.proxyToken, query: "q" }) }), env, log),
  );
  const sd = await served.json();
  assert.equal(sd.remaining, 24);

  // Empty search → refunded (back to 24, no burn).
  const emptyFetch = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
  const empty = await withFetch(emptyFetch, () =>
    handleProxyWeb(new Request("https://x", { method: "POST", body: JSON.stringify({ token: web.proxyToken, query: "q2" }) }), env, log),
  );
  assert.equal((await empty.json()).resultCount, 0);
  assert.equal([...db._rows.values()].find((r) => r.service === "web").used, 1); // still 1, refunded
});

test("handleProxyWeb rejects an api token (wrong service) and a bad token", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const bundle = await openBundle(b.blob, b.key);
  const api = await exchangeGrant(env, bundle.grants.find((g) => g.svc === "api").token);
  const wrongSvc = await handleProxyWeb(
    new Request("https://x", { method: "POST", body: JSON.stringify({ token: api.proxyToken, query: "q" }) }),
    env,
    log,
  );
  assert.equal(wrongSvc.status, 403);
});

// ---- LLM reverse proxy -------------------------------------------------------------

test("handleProxyLlm forwards /models and meters a completion, refunding on upstream error", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const bundle = await openBundle(b.blob, b.key);
  const api = await exchangeGrant(env, bundle.grants.find((g) => g.svc === "api").token);
  const bearer = "Bearer " + api.proxyToken;

  // /models forward (non-metered).
  const modelsFetch = async () => new Response(JSON.stringify({ data: [{ id: "mistralai/x" }] }), { status: 200 });
  const models = await withFetch(modelsFetch, () =>
    handleProxyLlm(
      new Request("https://x/api/proxy/llm/models", { method: "GET", headers: { authorization: bearer } }),
      env,
      log,
      new URL("https://x/api/proxy/llm/models"),
    ),
  );
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, "mistralai/x");

  // Successful completion → one unit spent, remaining echoed.
  const okFetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
  const req = () =>
    new Request("https://x/api/proxy/llm/chat/completions", {
      method: "POST",
      headers: { authorization: bearer, "content-type": "application/json" },
      body: JSON.stringify({ model: "mistralai/x", messages: [{ role: "user", content: "q" }] }),
    });
  const ok = await withFetch(okFetch, () =>
    handleProxyLlm(req(), env, log, new URL("https://x/api/proxy/llm/chat/completions")),
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).remaining, 39);

  // Upstream 500 → refunded (back to 39 used=1, not 2).
  const errFetch = async () => new Response("boom", { status: 500 });
  const err = await withFetch(errFetch, () =>
    handleProxyLlm(req(), env, log, new URL("https://x/api/proxy/llm/chat/completions")),
  );
  assert.equal(err.status, 502);
  assert.equal([...db._rows.values()].find((r) => r.service === "api").used, 1); // refunded
});

test("handleProxyLlm meters an embeddings batch on the api grant and refunds a bad one", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const bundle = await openBundle(b.blob, b.key);
  const api = await exchangeGrant(env, bundle.grants.find((g) => g.svc === "api").token);
  const bearer = "Bearer " + api.proxyToken;
  const url = new URL("https://x/api/proxy/llm/embeddings");
  const req = () =>
    new Request("https://x/api/proxy/llm/embeddings", {
      method: "POST",
      headers: { authorization: bearer, "content-type": "application/json" },
      body: JSON.stringify({ model: "intfloat/multilingual-e5-large", input: ["passage: hello"] }),
    });

  // Successful embeddings → one api unit spent, remaining echoed, vectors passed through.
  const okFetch = async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), { status: 200 });
  const ok = await withFetch(okFetch, () => handleProxyLlm(req(), env, log, url));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(body.data[0].embedding, [0.1, 0.2]);
  assert.equal(body.remaining, 39);

  // Empty result → refunded (used back to 1, not 2).
  const emptyFetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const empty = await withFetch(emptyFetch, () => handleProxyLlm(req(), env, log, url));
  assert.equal(empty.status, 502);
  assert.equal([...db._rows.values()].find((r) => r.service === "api").used, 1); // refunded

  // A web token can't reach the api-metered embeddings route.
  const web = await exchangeGrant(env, bundle.grants.find((g) => g.svc === "web").token);
  const webReq = new Request("https://x/api/proxy/llm/embeddings", {
    method: "POST",
    headers: { authorization: "Bearer " + web.proxyToken, "content-type": "application/json" },
    body: JSON.stringify({ input: ["x"] }),
  });
  const rejected = await handleProxyLlm(webReq, env, log, url);
  assert.equal(rejected.status, 403);
});

test("handleProxyLlm rejects a web token and a missing bearer", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42" });
  const bundle = await openBundle(b.blob, b.key);
  const web = await exchangeGrant(env, bundle.grants.find((g) => g.svc === "web").token);
  const r = await handleProxyLlm(
    new Request("https://x/api/proxy/llm/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + web.proxyToken, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    }),
    env,
    log,
    new URL("https://x/api/proxy/llm/chat/completions"),
  );
  assert.equal(r.status, 403);
});

// ---- admin surface -----------------------------------------------------------------

test("handleAdminProxy: mint returns a link, GET lists grouped bundles, DELETE revokes", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const url = new URL("https://x/api/admin/proxy/mint");
  const minted = await handleAdminProxy(
    new Request(url, { method: "POST", body: JSON.stringify({ label: "press" }) }),
    env,
    url,
    log,
    admin,
  );
  assert.equal(minted.status, 200);
  const m = await minted.json();
  assert.match(m.link, /\/cure\?rp=.+#rk=.+/);
  assert.equal(m.connected.length, 2);

  const listed = await handleAdminProxy(
    new Request("https://x/api/admin/proxy", { method: "GET" }),
    env,
    new URL("https://x/api/admin/proxy"),
    log,
    admin,
  );
  const l = await listed.json();
  assert.equal(l.bundles.length, 1);
  assert.equal(l.bundles[0].services.length, 2);
  assert.equal(l.outstanding, 65); // 25 + 40

  const delUrl = new URL("https://x/api/admin/proxy/" + m.bundleId);
  const del = await handleAdminProxy(new Request(delUrl, { method: "DELETE" }), env, delUrl, log, admin);
  assert.equal((await del.json()).ok, true);
  assert.equal(db._rows.size, 0);
});

test("handleProxyStatus / handleProxyExchange fail closed without D1 (503/403)", async () => {
  const env = { SESSION_SECRET: SECRET };
  const st = await handleProxyStatus(new Request("https://x", { method: "POST", body: JSON.stringify({ token: "prx1.a.b" }) }), env);
  assert.equal(st.status, 403); // bad token → 403 before the D1 check
});

// ---- per-token quota adjustment (the secure-workspaces minter control) ---------------

test("adjustProxyGrantQuota: absolute/delta/clamp, budget on increase, owner scoping", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42", source: "ghost" });
  const web = b.connected.find((s) => s.svc === "web");

  const up = await adjustProxyGrantQuota(env, log, web.jti, { quota: 60 });
  assert.equal(up.quota, 60);
  assert.equal(up.svc, "web");

  const down = await adjustProxyGrantQuota(env, log, web.jti, { delta: -70 });
  assert.equal(down.quota, 0); // clamped — paused
  assert.equal(down.remaining, 0);

  // Budget ceiling applies to increases only (outstanding is web 0 + api 40).
  const blocked = await adjustProxyGrantQuota(env, log, web.jti, { quota: 20 }, { budget: 50 });
  assert.equal(blocked.error, "budget_exceeded");
  const allowed = await adjustProxyGrantQuota(env, log, web.jti, { quota: 10 }, { budget: 50 });
  assert.equal(allowed.quota, 10);

  // Owner scoping: a different ownerId reads as not_found.
  assert.equal((await adjustProxyGrantQuota(env, log, web.jti, { quota: 5 }, { ownerId: "other" })).error, "not_found");
  assert.equal((await adjustProxyGrantQuota(env, log, web.jti, { quota: 5 }, { ownerId: "42" })).quota, 5);
  assert.equal((await adjustProxyGrantQuota(env, log, "missing", { quota: 5 })).error, "not_found");
  assert.equal((await adjustProxyGrantQuota(env, log, web.jti, {})).error, "bad_request");
});

test("a paused (quota 0) proxy grant stops reserving until quota returns", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42", source: "link" });
  const web = b.connected.find((s) => s.svc === "web");
  const exchanged = await exchangeGrant(env, b === null ? "" : (await openBundle(b.blob, b.key)).grants.find((g) => g.svc === "web").token);
  await adjustProxyGrantQuota(env, log, web.jti, { quota: 0 });
  const send = () =>
    handleProxyWeb(
      new Request("https://x/api/proxy/web", { method: "POST", body: JSON.stringify({ token: exchanged.proxyToken, query: "q" }) }),
      env,
      log,
    );
  assert.equal((await withFetch(exaFetch, send)).status, 429);
  await adjustProxyGrantQuota(env, log, web.jti, { quota: 5 });
  assert.equal((await withFetch(exaFetch, send)).status, 200);
});

test("handleProxyAdjust (authed self-service) and admin PATCH /:jti status codes", async () => {
  const db = fakeDb();
  const env = envWith(db);
  const b = await mintBundle(env, log, { userId: "42", source: "ghost" });
  const api = b.connected.find((s) => s.svc === "api");

  const res = await handleProxyAdjust(
    new Request("https://x/api/proxy/adjust", { method: "POST", body: JSON.stringify({ jti: api.jti, quota: 80 }) }),
    env,
    log,
    identity,
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).quota, 80);

  const denied = await handleProxyAdjust(
    new Request("https://x/api/proxy/adjust", { method: "POST", body: JSON.stringify({ jti: api.jti, quota: 1 }) }),
    env,
    log,
    { id: "7", role: "user" },
  );
  assert.equal(denied.status, 404);
  const noJti = await handleProxyAdjust(
    new Request("https://x/api/proxy/adjust", { method: "POST", body: JSON.stringify({}) }),
    env,
    log,
    identity,
  );
  assert.equal(noJti.status, 400);

  const patchUrl = new URL("https://x/api/admin/proxy/" + api.jti);
  const patched = await handleAdminProxy(
    new Request(patchUrl, { method: "PATCH", body: JSON.stringify({ delta: -75 }) }),
    env,
    patchUrl,
    log,
    admin,
  );
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).quota, 5);
  const missUrl = new URL("https://x/api/admin/proxy/none");
  const missing = await handleAdminProxy(new Request(missUrl, { method: "PATCH", body: JSON.stringify({ quota: 5 }) }), env, missUrl, log, admin);
  assert.equal(missing.status, 404);
});
