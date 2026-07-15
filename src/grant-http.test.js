// Unit tests for the grant subsystems' shared pure presentation helpers —
// the response fragments src/websearch.js and src/proxy.js must keep in
// lockstep (the endpoint-level behavior stays covered by websearch.test.js
// and proxy.test.js; these pin the shared layer directly).

import test from "node:test";
import assert from "node:assert/strict";

import {
  GRANT_DEPTH,
  GRANTS_LIST_MAX,
  QUERY_MAX,
  adjustResultResponse,
  budgetExceeded409,
  emptyWebResultResponse,
  readTokenBody,
  resolveQuotaPatch,
  webResultResponse,
} from "./grant-http.js";

test("shared constants keep the values both subsystems shipped with", () => {
  assert.equal(QUERY_MAX, 400);
  assert.equal(GRANTS_LIST_MAX, 200);
  assert.deepEqual(GRANT_DEPTH, { numResults: 6, type: "auto" });
});

test("budgetExceeded409 names both the ceiling and the outstanding total", async () => {
  const res = budgetExceeded409({ budget: 500, outstanding: 480 });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /Global budget of 500/);
  assert.match(body.error, /480 already outstanding/);
});

test("adjustResultResponse: null → 503 unavailable", async () => {
  const res = adjustResultResponse(null, "No such grant.");
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /unavailable/i);
});

test("adjustResultResponse: not_found → 404 with the caller's wording", async () => {
  const self = adjustResultResponse({ error: "not_found" }, "No such grant of yours.");
  assert.equal(self.status, 404);
  assert.equal((await self.json()).error, "No such grant of yours.");
  const admin = adjustResultResponse({ error: "not_found" }, "No such grant.");
  assert.equal(admin.status, 404);
  assert.equal((await admin.json()).error, "No such grant.");
});

test("adjustResultResponse: bad_request → 400, budget_exceeded → 409", async () => {
  const bad = adjustResultResponse({ error: "bad_request" }, "No such grant.");
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /quota or delta/);
  const over = adjustResultResponse({ error: "budget_exceeded", budget: 100, outstanding: 99 }, "No such grant.");
  assert.equal(over.status, 409);
});

test("adjustResultResponse: success passes the adjusted view through as 200 JSON", async () => {
  const view = { jti: "abc", quota: 30, used: 5, remaining: 25 };
  const res = adjustResultResponse(view, "No such grant.");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), view);
});

test("resolveQuotaPatch: absolute set floors and wins over delta", () => {
  assert.deepEqual(resolveQuotaPatch(10, { quota: 25.9 }), { clamped: 25 });
  assert.deepEqual(resolveQuotaPatch(10, { quota: 5, delta: 100 }), { clamped: 5 });
});

test("resolveQuotaPatch: relative delta adds to current, clamped at 0 (pause)", () => {
  assert.deepEqual(resolveQuotaPatch(10, { delta: 7 }), { clamped: 17 });
  assert.deepEqual(resolveQuotaPatch(10, { delta: -3.5 }), { clamped: 6 }); // Math.floor(-3.5) = -4
  assert.deepEqual(resolveQuotaPatch(10, { delta: -999 }), { clamped: 0 });
  assert.deepEqual(resolveQuotaPatch(3, { quota: 0 }), { clamped: 0 });
});

test("resolveQuotaPatch: missing/empty/non-numeric patches are bad_request", () => {
  assert.deepEqual(resolveQuotaPatch(10, null), { error: "bad_request" });
  assert.deepEqual(resolveQuotaPatch(10, {}), { error: "bad_request" });
  assert.deepEqual(resolveQuotaPatch(10, { quota: /** @type {any} */ ("abc") }), { error: "bad_request" });
  assert.deepEqual(resolveQuotaPatch(10, { delta: /** @type {any} */ ("x") }), { error: "bad_request" });
});

test("emptyWebResultResponse keeps any content but zeroes the result fields", async () => {
  const res = emptyWebResultResponse({ content: "partial text" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { content: "partial text", items: [], sources: [], resultCount: 0, remaining: null });
  const bare = await emptyWebResultResponse(null).json();
  assert.equal(bare.content, "");
});

test("webResultResponse projects exactly the client-consumed fields plus remaining", async () => {
  const result = { content: "c", items: [{ t: 1 }], sources: [{ url: "u" }], resultCount: 1, extra: "never" };
  const res = webResultResponse(result, 4);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { content: "c", items: [{ t: 1 }], sources: [{ url: "u" }], resultCount: 1, remaining: 4 });
});

test("readTokenBody: string token in, empty string for missing/malformed", async () => {
  const mk = (/** @type {BodyInit} */ body) => new Request("http://x/", { method: "POST", body });
  assert.equal(await readTokenBody(mk(JSON.stringify({ token: "wsk1.a.b" }))), "wsk1.a.b");
  assert.equal(await readTokenBody(mk(JSON.stringify({ token: 42 }))), "");
  assert.equal(await readTokenBody(mk(JSON.stringify({}))), "");
  assert.equal(await readTokenBody(mk("not json")), "");
});
