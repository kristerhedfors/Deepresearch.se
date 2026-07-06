import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deriveHistoryKey, historyKeyConfigured } from "./history-key.js";

describe("historyKeyConfigured", () => {
  test("false when the secret is unset", () => {
    assert.equal(historyKeyConfigured({}), false);
  });
  test("true once the secret is set", () => {
    assert.equal(historyKeyConfigured({ HISTORY_KEY_SECRET: "s" }), true);
  });
});

describe("deriveHistoryKey", () => {
  const env = { HISTORY_KEY_SECRET: "test-secret" };

  test("returns 32 raw bytes, base64-encoded (valid AES-256 key material)", async () => {
    const key = await deriveHistoryKey(env, "42");
    const bytes = Buffer.from(key, "base64");
    assert.equal(bytes.length, 32);
  });

  test("deterministic: the same user gets the same key every time", async () => {
    const a = await deriveHistoryKey(env, "42");
    const b = await deriveHistoryKey(env, "42");
    assert.equal(a, b);
  });

  test("different users get different keys", async () => {
    const a = await deriveHistoryKey(env, "42");
    const b = await deriveHistoryKey(env, "43");
    assert.notEqual(a, b);
  });

  test("different secrets yield different keys for the same user (rotation invalidates)", async () => {
    const a = await deriveHistoryKey(env, "42");
    const b = await deriveHistoryKey({ HISTORY_KEY_SECRET: "other-secret" }, "42");
    assert.notEqual(a, b);
  });
});
