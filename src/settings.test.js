import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, storageAvailability } from "./settings.js";

test("parseSettings defaults to server_history off", () => {
  assert.deepEqual(parseSettings(null), { server_history: false });
  assert.deepEqual(parseSettings(undefined), { server_history: false });
  assert.deepEqual(parseSettings(""), { server_history: false });
});

test("parseSettings survives malformed JSON", () => {
  assert.deepEqual(parseSettings("{not json"), { server_history: false });
  assert.deepEqual(parseSettings("[1,2,3]"), { server_history: false });
  assert.deepEqual(parseSettings('"a string"'), { server_history: false });
});

test("parseSettings reads the knob and coerces strictly to boolean", () => {
  assert.equal(parseSettings('{"server_history":true}').server_history, true);
  assert.equal(parseSettings('{"server_history":false}').server_history, false);
  // Truthy-but-not-true never switches the knob on.
  assert.equal(parseSettings('{"server_history":1}').server_history, false);
  assert.equal(parseSettings('{"server_history":"true"}').server_history, false);
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
