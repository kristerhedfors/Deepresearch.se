import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parsePending, PENDING_TTL_MS } from "./pending-answer.js";

// The localStorage/Date wrappers (writePending/readPending/clearPending)
// are browser glue, verified live; the pure freshness+shape validation is
// what decides whether a boot resumes or discards a pointer, so it's tested.
describe("parsePending", () => {
  const good = JSON.stringify({
    convId: "abc-123",
    requestId: "req-xyz",
    startedAt: 1_000_000,
    model: "m",
    budgetS: 60,
    webSearch: true,
  });

  test("returns the pointer when well-formed and fresh", () => {
    const p = parsePending(good, 1_000_000 + 1000);
    assert.equal(p.convId, "abc-123");
    assert.equal(p.requestId, "req-xyz");
  });

  test("returns null once older than the TTL (parked answer already purged)", () => {
    assert.equal(parsePending(good, 1_000_000 + PENDING_TTL_MS + 1), null);
    // exactly at the TTL boundary is treated as expired
    assert.equal(parsePending(good, 1_000_000 + PENDING_TTL_MS), null);
  });

  test("returns null for absent / empty / non-JSON input", () => {
    assert.equal(parsePending("", 0), null);
    assert.equal(parsePending(null, 0), null);
    assert.equal(parsePending(undefined, 0), null);
    assert.equal(parsePending("{not json", 0), null);
  });

  test("returns null when required identifiers are missing or wrong type", () => {
    assert.equal(parsePending(JSON.stringify({ requestId: "r", startedAt: 0 }), 0), null); // no convId
    assert.equal(parsePending(JSON.stringify({ convId: "c", startedAt: 0 }), 0), null); // no requestId
    assert.equal(parsePending(JSON.stringify({ convId: "c", requestId: "r" }), 0), null); // no startedAt
    assert.equal(parsePending(JSON.stringify({ convId: 1, requestId: "r", startedAt: 0 }), 0), null);
    assert.equal(parsePending(JSON.stringify({ convId: "c", requestId: "r", startedAt: "nope" }), 0), null);
  });

  test("respects a custom TTL", () => {
    assert.equal(parsePending(good, 1_000_000 + 4999, 5000).convId, "abc-123");
    assert.equal(parsePending(good, 1_000_000 + 5001, 5000), null);
  });
});
