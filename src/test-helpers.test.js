// Tests for the shared test helpers (src/test-helpers/).
//
// The helpers are load-bearing for every suite built on them, and a fake that
// silently misbehaves turns other suites green for the wrong reason — the
// worst failure mode a test surface has. So the fakes get the same treatment
// as production code.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { fakeD1 } from "./test-helpers/d1.js";
import { fakeFetch, withFakeFetch } from "./test-helpers/fetch.js";
import { fakeEnv, fakeLog, fakeIdentity, fakeAdmin, fakeCtx, fakeR2, fakeAssets, jsonRequest } from "./test-helpers/env.js";

describe("fakeD1 — query results", () => {
  test("returns canned rows for a matching statement", async () => {
    const db = fakeD1({ rows: [[/SELECT \* FROM users/, [{ id: "u1" }, { id: "u2" }]]] });
    const r = await db.prepare("SELECT * FROM users WHERE approved = ?").bind(1).all();
    assert.deepEqual(r.results, [{ id: "u1" }, { id: "u2" }]);
  });

  test("first() returns one row, or null when nothing matches", async () => {
    const db = fakeD1({ rows: [[/FROM users/, { id: "u1", email: "a@b.test" }]] });
    assert.deepEqual(await db.prepare("SELECT * FROM users").first(), { id: "u1", email: "a@b.test" });
    assert.equal(await db.prepare("SELECT * FROM absent_table").first(), null);
  });

  test("first(column) projects a single column", async () => {
    const db = fakeD1({ rows: [[/COUNT/, { n: 7 }]] });
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM chat_logs").first("n"), 7);
  });

  test("a result function receives the bindings", async () => {
    const db = fakeD1({ rows: [[/FROM users WHERE id/, (b) => [{ id: b[0], seen: b.length }]]] });
    const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind("u9").first();
    assert.deepEqual(row, { id: "u9", seen: 1 });
  });

  test("unmatched statements record and return empty rather than throwing", async () => {
    const db = fakeD1();
    const r = await db.prepare("SELECT 1").all();
    assert.deepEqual(r.results, []);
    assert.equal(db.calls.length, 1);
  });

  test("first matching rule wins, in registration order", async () => {
    const db = fakeD1({
      rows: [
        [/FROM users/, [{ which: "specific" }]],
        [/SELECT/, [{ which: "catch-all" }]],
      ],
    });
    assert.deepEqual(await db.prepare("SELECT * FROM users").first(), { which: "specific" });
    assert.deepEqual(await db.prepare("SELECT * FROM other").first(), { which: "catch-all" });
  });

  test("onQuery registers a rule after construction", async () => {
    const db = fakeD1();
    db.onQuery(/FROM accounts/, [{ id: "a1" }]);
    assert.deepEqual(await db.prepare("SELECT * FROM accounts").first(), { id: "a1" });
  });
});

describe("fakeD1 — the recording surface", () => {
  test("records SQL, bindings and execution method in order", async () => {
    const db = fakeD1();
    await db.prepare("INSERT INTO chat_logs (id) VALUES (?)").bind("c1").run();
    await db.prepare("SELECT * FROM users").all();
    assert.deepEqual(
      db.calls.map((c) => c.method),
      ["run", "all"],
    );
    assert.deepEqual(db.calls[0].bindings, ["c1"]);
    assert.match(db.calls[0].sql, /^INSERT INTO chat_logs/);
  });

  test("normalizes whitespace so multi-line SQL is matchable", async () => {
    const db = fakeD1();
    await db.prepare("SELECT *\n  FROM   users\n  WHERE id = ?").bind("u1").first();
    assert.equal(db.statements()[0], "SELECT * FROM users WHERE id = ?");
    assert.ok(db.ran(/SELECT \* FROM users WHERE id/));
  });

  test("ran() supports the negative assertion — the whole point of the recorder", async () => {
    const db = fakeD1();
    await db.prepare("SELECT * FROM users").all();
    assert.equal(db.ran(/INSERT INTO chat_logs/), false);
  });

  test("callsMatching() exposes bindings for one statement family", async () => {
    const db = fakeD1();
    await db.prepare("INSERT INTO chat_logs (id, q) VALUES (?, ?)").bind("c1", "hello").run();
    await db.prepare("INSERT INTO chat_logs (id, q) VALUES (?, ?)").bind("c2", "world").run();
    const found = db.callsMatching(/INSERT INTO chat_logs/);
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((c) => c.bindings[1]),
      ["hello", "world"],
    );
  });

  test("bind() is not sticky across separate prepare() calls", async () => {
    const db = fakeD1();
    const a = db.prepare("SELECT ?");
    await a.bind("first").first();
    await db.prepare("SELECT ?").first();
    assert.deepEqual(db.calls[1].bindings, []);
  });

  test("reset() clears calls but keeps the rules", async () => {
    const db = fakeD1({ rows: [[/FROM users/, [{ id: "u1" }]]] });
    await db.prepare("SELECT * FROM users").all();
    db.reset();
    assert.equal(db.calls.length, 0);
    assert.deepEqual((await db.prepare("SELECT * FROM users").all()).results, [{ id: "u1" }]);
  });
});

describe("fakeD1 — failure injection", () => {
  test("failOn makes a matching statement throw", async () => {
    const db = fakeD1().failOn(/INSERT INTO chat_logs/);
    await assert.rejects(() => db.prepare("INSERT INTO chat_logs (id) VALUES (?)").bind("c1").run());
  });

  test("failOn leaves non-matching statements working", async () => {
    const db = fakeD1({ rows: [[/FROM users/, [{ id: "u1" }]]] }).failOn(/INSERT/);
    assert.deepEqual(await db.prepare("SELECT * FROM users").first(), { id: "u1" });
  });

  test("a custom Error instance is thrown verbatim", async () => {
    const boom = new Error("D1_ERROR: no such table");
    const db = fakeD1().failOn(/SELECT/, boom);
    await assert.rejects(
      () => db.prepare("SELECT 1").first(),
      (/** @type {Error} */ e) => e === boom,
    );
  });
});

describe("fakeD1 — batch and exec", () => {
  test("batch runs each statement and returns each result", async () => {
    const db = fakeD1({ rows: [[/INSERT/, [{ ok: 1 }]]] });
    const out = await db.batch([db.prepare("INSERT INTO a VALUES (1)"), db.prepare("INSERT INTO b VALUES (2)")]);
    assert.equal(out.length, 2);
    assert.equal(out[0].success, true);
    assert.equal(db.calls.length, 2);
  });

  test("exec records the statement and counts the semicolons", async () => {
    const db = fakeD1();
    const r = await db.exec("CREATE TABLE a (x); CREATE TABLE b (y);");
    assert.equal(r.count, 2);
    assert.ok(db.ran(/CREATE TABLE a/));
  });
});

describe("fakeFetch", () => {
  test("records url, method, headers and body", async () => {
    const f = fakeFetch([[/api\.test/, { ok: true }]]);
    await f("https://api.test/v1/search", {
      method: "POST",
      headers: { "x-api-key": "k1" },
      body: JSON.stringify({ q: "hello" }),
    });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, "POST");
    assert.equal(f.requests[0].host, "api.test");
    assert.equal(f.requests[0].headers["x-api-key"], "k1");
    assert.deepEqual(JSON.parse(f.requests[0].body), { q: "hello" });
  });

  test("a route may respond with an object, a string, or a Response", async () => {
    const f = fakeFetch([
      [/\/json/, { a: 1 }],
      [/\/text/, "plain"],
      [/\/resp/, new Response("custom", { status: 418 })],
    ]);
    assert.deepEqual(await (await f("https://x.test/json")).json(), { a: 1 });
    assert.equal(await (await f("https://x.test/text")).text(), "plain");
    assert.equal((await f("https://x.test/resp")).status, 418);
  });

  test("a route function sees the recorded request", async () => {
    const f = fakeFetch([[/echo/, (r) => ({ sawBody: r.body, sawHost: r.host })]]);
    const out = await (await f("https://echo.test/x", { method: "POST", body: "hi" })).json();
    assert.deepEqual(out, { sawBody: "hi", sawHost: "echo.test" });
  });

  test("an unmatched request 404s instead of throwing, so fail-soft paths still run", async () => {
    const f = fakeFetch();
    const r = await f("https://nowhere.test/x");
    assert.equal(r.status, 404);
    assert.equal(f.requests.length, 1);
  });

  test("hosts() lists distinct hosts in first-contact order", async () => {
    const f = fakeFetch([[/./, { ok: 1 }]]);
    await f("https://a.test/1");
    await f("https://b.test/1");
    await f("https://a.test/2");
    assert.deepEqual(f.hosts(), ["a.test", "b.test"]);
  });

  test("assertNoneCarry passes when nothing forbidden went out", async () => {
    const f = fakeFetch([[/./, { ok: 1 }]]);
    await f("https://search.test/?q=weather", { method: "GET" });
    assert.equal(f.assertNoneCarry(["secret-token", "user@example.test"]), true);
  });

  test("assertNoneCarry catches a forbidden value in the body", async () => {
    const f = fakeFetch([[/./, { ok: 1 }]]);
    await f("https://search.test/", { method: "POST", body: JSON.stringify({ q: "hi", who: "user@example.test" }) });
    assert.throws(() => f.assertNoneCarry(["user@example.test"]), /carried forbidden value/);
  });

  test("assertNoneCarry catches a forbidden value in a header or the URL", async () => {
    const f = fakeFetch([[/./, { ok: 1 }]]);
    await f("https://search.test/?q=x", { headers: { authorization: "Bearer sk-live-1" } });
    assert.throws(() => f.assertNoneCarry(["sk-live-1"]), /carried forbidden value/);
    f.reset();
    await f("https://search.test/?q=user@example.test");
    assert.throws(() => f.assertNoneCarry(["user@example.test"]), /carried forbidden value/);
  });

  test("withFakeFetch installs and always restores globalThis.fetch", async () => {
    const real = globalThis.fetch;
    await withFakeFetch([[/./, { ok: 1 }]], async (stub) => {
      assert.equal(globalThis.fetch, stub);
      await fetch("https://x.test/");
      assert.equal(stub.requests.length, 1);
    });
    assert.equal(globalThis.fetch, real);
  });

  test("withFakeFetch restores globalThis.fetch even when the body throws", async () => {
    const real = globalThis.fetch;
    await assert.rejects(() => withFakeFetch([], async () => { throw new Error("boom"); }), /boom/);
    assert.equal(globalThis.fetch, real);
  });
});

describe("fakeEnv / fakeLog / fakeIdentity", () => {
  test("fakeEnv gives a configured deployment by default", () => {
    const env = fakeEnv();
    assert.ok(env.DB, "a D1 fake is present");
    assert.ok(env.ASSETS, "an assets binding is present");
    assert.equal(typeof env.BERGET_API_TOKEN, "string");
  });

  test("a null override DELETES a binding, for the degraded path", () => {
    const env = fakeEnv({ DB: null, BERGET_API_TOKEN: null });
    assert.equal("DB" in env, false);
    assert.equal("BERGET_API_TOKEN" in env, false);
  });

  test("overrides replace defaults", () => {
    const db = fakeD1();
    const env = fakeEnv({ DB: db, EXA_API_KEY: "exa-1" });
    assert.equal(env.DB, db);
    assert.equal(env.EXA_API_KEY, "exa-1");
  });

  test("fakeLog records by level and flattens to searchable text", () => {
    const log = fakeLog();
    log.info("started", { id: "r1" });
    log.error("failed");
    assert.equal(log.at("error").length, 1);
    assert.match(log.text(), /started/);
    assert.match(log.text(), /"id":"r1"/);
  });

  test("assertNoneLogged is the mechanical form of 'secrets never appear in any log'", () => {
    const log = fakeLog();
    log.info("calling provider", { model: "mistral-small" });
    assert.equal(log.assertNoneLogged(["test-berget-token"]), true);
    log.error("upstream rejected", { key: "test-berget-token" });
    assert.throws(() => log.assertNoneLogged(["test-berget-token"]), /forbidden value/);
  });

  test("fakeIdentity is an approved non-admin; fakeAdmin is the admin branch", () => {
    assert.equal(fakeIdentity().role, "user");
    assert.equal(fakeIdentity().user.approved, 1);
    assert.equal(fakeAdmin().role, "admin");
    assert.equal(fakeIdentity({ id: "u7" }).email, "u7@example.test");
  });

  test("fakeCtx captures waitUntil work and settle() awaits it", async () => {
    const ctx = fakeCtx();
    let done = false;
    ctx.waitUntil(Promise.resolve().then(() => { done = true; }));
    assert.equal(ctx.deferred.length, 1);
    await ctx.settle();
    assert.equal(done, true);
  });

  test("fakeCtx swallows a rejected background task, as the runtime does", async () => {
    const ctx = fakeCtx();
    ctx.waitUntil(Promise.reject(new Error("background boom")));
    await ctx.settle();
  });

  test("fakeAssets serves registered paths and 404s the rest", async () => {
    const assets = fakeAssets({ "/introspect/x.json": '{"v":1}' });
    assert.equal((await assets.fetch("https://site.test/introspect/x.json")).status, 200);
    assert.equal((await assets.fetch("https://site.test/nope")).status, 404);
  });

  test("fakeR2 round-trips put/get/list/delete", async () => {
    const r2 = fakeR2();
    await r2.put("projects/u1/a.json", '{"a":1}', { customMetadata: { owner: "u1" } });
    const obj = await r2.get("projects/u1/a.json");
    assert.deepEqual(await obj.json(), { a: 1 });
    assert.equal(obj.customMetadata.owner, "u1");
    assert.deepEqual((await r2.list({ prefix: "projects/u1/" })).objects, [{ key: "projects/u1/a.json" }]);
    await r2.delete("projects/u1/a.json");
    assert.equal(await r2.get("projects/u1/a.json"), null);
  });

  test("jsonRequest builds a POST with a JSON body, GET without one", async () => {
    const post = jsonRequest("https://site.test/api/chat", { messages: [] });
    assert.equal(post.method, "POST");
    assert.equal(post.headers.get("content-type"), "application/json");
    assert.deepEqual(await post.json(), { messages: [] });
    assert.equal(jsonRequest("https://site.test/api/health").method, "GET");
  });
});
