// The structured logger (src/log.js): level thresholding, the JSON line shape,
// and — added 2026-07-26 — the base fields the logger EXPOSES.
//
// Why the exposure is tested at all: the logger is the one request-scoped
// object every deep helper already receives, so it is where a subsystem reads
// the request id when it needs to write a durable record (server-errors.js
// recordSubsystemFailure, called from the Orchestrator's fail-soft node
// guard). If `fields` ever stops carrying request_id, those durable records go
// back to being uncorrelatable with Workers Logs — silently. Hence a pin.

import test from "node:test";
import assert from "node:assert/strict";

import { createLogger, loggerRequestId } from "./log.js";

/** Capture the JSON lines a logger writes, restoring the console afterwards. */
function capture(fn) {
  const lines = [];
  const log = console.log;
  const err = console.error;
  console.log = (s) => lines.push(String(s));
  console.error = (s) => lines.push(String(s));
  try {
    fn();
  } finally {
    console.log = log;
    console.error = err;
  }
  return lines.map((l) => JSON.parse(l));
}

test("emits one JSON object per line with the base fields merged in", () => {
  const log = createLogger(/** @type {any} */ ({ LOG_LEVEL: "info" }), { request_id: "req-1", path: "/api/chat" });
  const [entry] = capture(() => log.info("chat.complete", { rounds: 2 }));
  assert.equal(entry.level, "info");
  assert.equal(entry.event, "chat.complete");
  assert.equal(entry.request_id, "req-1");
  assert.equal(entry.path, "/api/chat");
  assert.equal(entry.rounds, 2);
  assert.ok(entry.time);
});

test("respects the LOG_LEVEL threshold", () => {
  const log = createLogger(/** @type {any} */ ({ LOG_LEVEL: "warn" }), {});
  const lines = capture(() => {
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  });
  assert.deepEqual(lines.map((l) => l.event), ["w", "e"]);
});

test("exposes its base fields as a frozen `fields`", () => {
  const log = createLogger(/** @type {any} */ ({}), { request_id: "req-2", method: "POST", path: "/api/chat" });
  assert.deepEqual({ ...log.fields }, { request_id: "req-2", method: "POST", path: "/api/chat" });
  assert.ok(Object.isFrozen(log.fields));
  // Read-only by construction: a helper mutating the logger's identity would
  // corrupt every line written after it.
  assert.throws(() => { /** @type {any} */ (log.fields).request_id = "spoofed"; }, TypeError);
  // A snapshot, not a live alias — mutating the caller's object changes nothing.
  const base = { request_id: "req-3" };
  const l2 = createLogger(/** @type {any} */ ({}), base);
  base.request_id = "changed";
  assert.equal(l2.fields.request_id, "req-3");
});

test("loggerRequestId is total — a stub logger yields \"\", never a throw", () => {
  assert.equal(loggerRequestId(createLogger(/** @type {any} */ ({}), { request_id: "req-4" })), "req-4");
  assert.equal(loggerRequestId(createLogger(/** @type {any} */ ({}))), "");
  // The shape every unit test in this repo hand-rolls for a logger.
  assert.equal(loggerRequestId({ info() {}, warn() {}, error() {}, debug() {} }), "");
  assert.equal(loggerRequestId(null), "");
  assert.equal(loggerRequestId(undefined), "");
  assert.equal(loggerRequestId({ fields: { request_id: 42 } }), "", "a non-string id is not an id");
});
