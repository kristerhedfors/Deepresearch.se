import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSseParser } from "./sse.js";

describe("createSseParser", () => {
  test("parses complete data lines into events", () => {
    const p = createSseParser();
    const events = p.push('data: {"a":1}\n\ndata: {"b":2}\n\n');
    assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
  });

  test("carries a partial trailing line across pushes (chunk split mid-event)", () => {
    const p = createSseParser();
    assert.deepEqual(p.push('data: {"choices":[{"delta":{"con'), []);
    assert.deepEqual(p.push('tent":"hi"}}]}\n'), [{ choices: [{ delta: { content: "hi" } }] }]);
  });

  test("ignores keepalive comment lines and blank lines", () => {
    const p = createSseParser();
    assert.deepEqual(p.push(': keepalive\n\n: keepalive\n\ndata: {"x":1}\n'), [{ x: 1 }]);
  });

  test("ignores the [DONE] terminator", () => {
    const p = createSseParser();
    assert.deepEqual(p.push('data: {"x":1}\n\ndata: [DONE]\n\n'), [{ x: 1 }]);
  });

  test("drops malformed JSON instead of throwing", () => {
    const p = createSseParser();
    assert.deepEqual(p.push('data: {broken\n\ndata: {"ok":true}\n'), [{ ok: true }]);
  });

  test("a data line split exactly at the newline still parses", () => {
    const p = createSseParser();
    assert.deepEqual(p.push('data: {"x":1}'), []);
    assert.deepEqual(p.push("\n"), [{ x: 1 }]);
  });

  test("empty data payload is ignored", () => {
    const p = createSseParser();
    assert.deepEqual(p.push("data:\n\ndata:   \n"), []);
  });
});
