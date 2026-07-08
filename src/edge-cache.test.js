import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { cacheGet, cachePut } from "./edge-cache.js";

// A log stub that records warn calls so the fail-soft paths can be asserted.
function stubLog() {
  const warns = [];
  return { warns, warn: (event, fields) => warns.push({ event, fields }) };
}

// Node has no Cache API, so `globalThis.caches` is installed per test with a
// minimal match/put double and removed afterwards.
function installCache(cache) {
  globalThis.caches = { default: cache };
}

afterEach(() => {
  delete globalThis.caches;
});

describe("cacheGet", () => {
  test("returns null without a Cache API (Node, tests)", async () => {
    const log = stubLog();
    assert.equal(await cacheGet(log, "x.cache", "https://c.internal/k"), null);
    assert.equal(log.warns.length, 0);
  });

  test("returns null on a miss", async () => {
    installCache({ match: async () => undefined });
    const log = stubLog();
    assert.equal(await cacheGet(log, "x.cache", "https://c.internal/k"), null);
    assert.equal(log.warns.length, 0);
  });

  test("returns the parsed payload on a hit", async () => {
    installCache({ match: async () => new Response(JSON.stringify({ a: 1 })) });
    const log = stubLog();
    assert.deepEqual(await cacheGet(stubLog(), "x.cache", "https://c.internal/k"), { a: 1 });
    assert.equal(log.warns.length, 0);
  });

  test("a read error is warned as <event>_read_failed and returns null", async () => {
    installCache({ match: async () => { throw new Error("boom"); } });
    const log = stubLog();
    assert.equal(await cacheGet(log, "x.cache", "https://c.internal/k"), null);
    assert.equal(log.warns.length, 1);
    assert.equal(log.warns[0].event, "x.cache_read_failed");
    assert.equal(log.warns[0].fields.error, "boom");
  });

  test("an unparseable cached body degrades to a miss (fail-soft)", async () => {
    installCache({ match: async () => new Response("not json") });
    const log = stubLog();
    assert.equal(await cacheGet(log, "x.cache", "https://c.internal/k"), null);
    assert.equal(log.warns.length, 1);
    assert.equal(log.warns[0].event, "x.cache_read_failed");
  });
});

describe("cachePut", () => {
  test("no-op without a Cache API", async () => {
    const log = stubLog();
    await cachePut(log, "x.cache", "https://c.internal/k", { a: 1 }, 600);
    assert.equal(log.warns.length, 0);
  });

  test("stores JSON with the max-age TTL", async () => {
    const puts = [];
    installCache({ put: async (req, resp) => puts.push({ req, resp }) });
    await cachePut(stubLog(), "x.cache", "https://c.internal/k", { a: 1 }, 600);
    assert.equal(puts.length, 1);
    assert.equal(puts[0].req.url, "https://c.internal/k");
    assert.equal(puts[0].resp.headers.get("cache-control"), "max-age=600");
    assert.equal(puts[0].resp.headers.get("content-type"), "application/json");
    assert.deepEqual(await puts[0].resp.json(), { a: 1 });
  });

  test("a write error is warned as <event>_write_failed and swallowed", async () => {
    installCache({ put: async () => { throw new Error("full"); } });
    const log = stubLog();
    await cachePut(log, "x.cache", "https://c.internal/k", { a: 1 }, 600);
    assert.equal(log.warns.length, 1);
    assert.equal(log.warns[0].event, "x.cache_write_failed");
    assert.equal(log.warns[0].fields.error, "full");
  });
});
