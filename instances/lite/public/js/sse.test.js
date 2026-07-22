// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "./sse.js";

test("parses complete data events", () => {
  const p = createSseParser();
  const events = p.push('data: {"type":"delta","text":"hi"}\n\n');
  assert.deepEqual(events, [{ type: "delta", text: "hi" }]);
});

test("carries a partial trailing line between pushes", () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: {"type":"del'), []);
  const events = p.push('ta","text":"hi"}\n');
  assert.deepEqual(events, [{ type: "delta", text: "hi" }]);
});

test("ignores comments, keepalives, and [DONE]", () => {
  const p = createSseParser();
  const events = p.push(": keepalive\n\ndata: [DONE]\n\ndata: {\"a\":1}\n");
  assert.deepEqual(events, [{ a: 1 }]);
});

test("drops a malformed frame without throwing, keeps rendering after", () => {
  const p = createSseParser();
  const events = p.push('data: {bad json\ndata: {"ok":true}\n');
  assert.deepEqual(events, [{ ok: true }]);
});

test("handles several events in one chunk", () => {
  const p = createSseParser();
  const events = p.push('data: {"n":1}\ndata: {"n":2}\ndata: {"n":3}\n');
  assert.deepEqual(events.map((e) => e.n), [1, 2, 3]);
});
