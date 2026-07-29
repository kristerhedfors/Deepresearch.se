// Unit tests for the shared request/response helpers (src/http.js).
//
// `readJsonBody` is the one with logic in it: thirteen endpoint handlers used
// to carry its try/catch verbatim, so the pair it returns — and above all the
// fact that a bad body yields a REJECTION rather than an empty object — is now
// asserted once here instead of implicitly at each site.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { htmlResponse, jsonResponse, readJsonBody, sseResponse, textResponse } from "./http.js";

/** @param {string} body */
const post = (body) => new Request("https://example.test/api/x", { method: "POST", body });

describe("readJsonBody", () => {
  test("a valid body comes back parsed, with no response to return", async () => {
    const { body, response } = await readJsonBody(post(JSON.stringify({ a: 1, b: ["x"] })));
    assert.equal(response, null);
    assert.deepEqual(body, { a: 1, b: ["x"] });
  });

  test("a JSON scalar body is still a body — only a PARSE failure rejects", async () => {
    const { body, response } = await readJsonBody(post("null"));
    assert.equal(response, null);
    assert.equal(body, null);
  });

  test("malformed JSON yields the 400 to return, and no body", async () => {
    const { body, response } = await readJsonBody(post("{not json"));
    assert.equal(body, null);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Request body must be valid JSON." });
  });

  test("an absent body rejects the same way (no empty-object fallback)", async () => {
    const { body, response } = await readJsonBody(new Request("https://example.test/api/x", { method: "POST" }));
    assert.equal(body, null);
    assert.equal(response?.status, 400);
  });
});

describe("response helpers", () => {
  test("jsonResponse sets the content type, status and extra headers", async () => {
    const r = jsonResponse({ ok: true }, 201, { "x-request-id": "abc" });
    assert.equal(r.status, 201);
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(r.headers.get("x-request-id"), "abc");
    assert.deepEqual(await r.json(), { ok: true });
  });

  test("sseResponse pins the no-transform cache control the stream depends on", () => {
    const r = sseResponse(new ReadableStream());
    assert.equal(r.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(r.headers.get("cache-control"), "no-cache, no-transform");
  });

  test("htmlResponse defaults to 200 and textResponse is always 200", async () => {
    assert.equal(htmlResponse("<p>hi</p>").status, 200);
    assert.equal(htmlResponse("<p>gone</p>", 404).status, 404);
    const t = textResponse("plain");
    assert.equal(t.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await t.text(), "plain");
  });
});
