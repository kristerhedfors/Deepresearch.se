import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, serverHistoryEnabled, storageAvailability } from "./settings.js";

test("parseSettings defaults to server_history on", () => {
  assert.deepEqual(parseSettings(null), { server_history: true });
  assert.deepEqual(parseSettings(undefined), { server_history: true });
  assert.deepEqual(parseSettings(""), { server_history: true });
});

test("parseSettings survives malformed JSON (falls back to default on)", () => {
  assert.deepEqual(parseSettings("{not json"), { server_history: true });
  assert.deepEqual(parseSettings("[1,2,3]"), { server_history: true });
  assert.deepEqual(parseSettings('"a string"'), { server_history: true });
});

test("parseSettings: only an explicit stored false opts out", () => {
  assert.equal(parseSettings('{"server_history":true}').server_history, true);
  assert.equal(parseSettings('{"server_history":false}').server_history, false);
  // Non-boolean junk means the default (on), not off.
  assert.equal(parseSettings('{"server_history":0}').server_history, true);
  assert.equal(parseSettings('{"server_history":"false"}').server_history, true);
});

test("serverHistoryEnabled is the effective state: binding AND user AND setting", () => {
  const env = { STORAGE: {} };
  const optedOut = { user: { id: 1, settings_json: '{"server_history":false}' } };
  const fresh = { user: { id: 2, settings_json: null } };
  assert.equal(serverHistoryEnabled(env, fresh), true); // default on
  assert.equal(serverHistoryEnabled(env, optedOut), false); // explicit opt-out
  assert.equal(serverHistoryEnabled({}, fresh), false); // no R2 binding
  assert.equal(serverHistoryEnabled(env, {}), false); // break-glass: no user row
});

test("parseSettings drops unknown keys", () => {
  const s = parseSettings('{"server_history":true,"evil":"x"}');
  assert.deepEqual(Object.keys(s), ["server_history"]);
});

test("storageAvailability needs both the binding and a user row", () => {
  const user = { id: 1 };
  assert.deepEqual(storageAvailability({}, { user }), { storage: false, rag: false });
  assert.deepEqual(storageAvailability({ STORAGE: {} }, {}), { storage: false, rag: false });
  assert.deepEqual(storageAvailability({ STORAGE: {} }, { user }), { storage: true, rag: false });
  assert.deepEqual(storageAvailability({ STORAGE: {}, RAG_INDEX: {} }, { user }), {
    storage: true,
    rag: true,
  });
  // Vectorize alone (no R2) is not a usable configuration.
  assert.deepEqual(storageAvailability({ RAG_INDEX: {} }, { user }), { storage: false, rag: false });
});
