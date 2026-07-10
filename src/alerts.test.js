// Unit tests for operational-alert classification (src/alerts.js): each known
// error pattern maps to its stable type/severity; unmatched to the catch-all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyChatError } from "./alerts.js";

describe("classifyChatError", () => {
  test("Berget wallet depletion classifies as critical", () => {
    const c = classifyChatError('Berget API error (402): {"error":{"code":"INSUFFICIENT_WALLET_BALANCE"}}');
    assert.equal(c.type, "berget_insufficient_balance");
    assert.equal(c.severity, "critical");
  });

  test("insufficient_quota variant also matches", () => {
    const c = classifyChatError('{"error":{"type":"insufficient_quota"}}');
    assert.equal(c.type, "berget_insufficient_balance");
  });

  test("empty-completion exhaustion classifies distinctly, regardless of attempt count", () => {
    const twoAttempts = classifyChatError("Berget returned an empty response 2 times in a row for this model");
    const threeAttempts = classifyChatError("Berget returned an empty response 3 times in a row for this model");
    assert.equal(twoAttempts.type, "chat_empty_completion");
    assert.equal(threeAttempts.type, "chat_empty_completion");
    assert.equal(twoAttempts.severity, "warning");
  });

  test("connect-phase failures (abort or provider-side HTTP error) classify distinctly", () => {
    const abort = classifyChatError("The operation was aborted");
    const http502 = classifyChatError("Berget API error (502): upstream unavailable");
    const http429 = classifyChatError("Berget API error (429): too many requests");
    assert.equal(abort.type, "chat_connect_failed");
    assert.equal(http502.type, "chat_connect_failed");
    assert.equal(http429.type, "chat_connect_failed");
  });

  test("deterministic 4xx Berget errors stay in the generic bucket, and wallet depletion is not shadowed", () => {
    assert.equal(classifyChatError("Berget API error (400): bad request").type, "chat_stream_failed");
    const wallet = classifyChatError('Berget API error (402): {"error":{"code":"INSUFFICIENT_WALLET_BALANCE"}}');
    assert.equal(wallet.type, "berget_insufficient_balance");
  });

  test("dropped stream (missing finish_reason) classifies distinctly", () => {
    const c = classifyChatError("Berget stream ended without a finish_reason (0 chars received) — likely a dropped connection");
    assert.equal(c.type, "chat_dropped_stream");
  });

  test("unrecognized errors fall back to the generic bucket, not a new type per message", () => {
    const c1 = classifyChatError("Some completely novel error message");
    const c2 = classifyChatError("A different novel error message");
    assert.equal(c1.type, "chat_stream_failed");
    assert.equal(c2.type, "chat_stream_failed");
  });

  test("handles non-string/undefined input without throwing", () => {
    assert.doesNotThrow(() => classifyChatError(undefined));
    assert.doesNotThrow(() => classifyChatError(null));
    assert.equal(classifyChatError(undefined).type, "chat_stream_failed");
  });
});
