import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, serverHistoryEnabled, storageAvailability } from "./settings.js";

const ALL_ON = {
  server_history: true,
  street_view: true,
  nearby_places: true,
  map_context: true,
};

test("parseSettings defaults every knob to on", () => {
  assert.deepEqual(parseSettings(null), ALL_ON);
  assert.deepEqual(parseSettings(undefined), ALL_ON);
  assert.deepEqual(parseSettings(""), ALL_ON);
});

test("parseSettings survives malformed JSON (falls back to defaults on)", () => {
  assert.deepEqual(parseSettings("{not json"), ALL_ON);
  assert.deepEqual(parseSettings("[1,2,3]"), ALL_ON);
  assert.deepEqual(parseSettings('"a string"'), ALL_ON);
});

test("parseSettings: only an explicit stored false opts out, per knob", () => {
  assert.equal(parseSettings('{"server_history":true}').server_history, true);
  assert.equal(parseSettings('{"server_history":false}').server_history, false);
  // Non-boolean junk means the default (on), not off.
  assert.equal(parseSettings('{"server_history":0}').server_history, true);
  assert.equal(parseSettings('{"server_history":"false"}').server_history, true);
  // The maps knobs behave identically and independently.
  const s = parseSettings('{"street_view":false,"map_context":false}');
  assert.equal(s.street_view, false);
  assert.equal(s.map_context, false);
  assert.equal(s.nearby_places, true);
  assert.equal(s.server_history, true);
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
  assert.deepEqual(Object.keys(s).sort(), Object.keys(ALL_ON).sort());
});

test("storageAvailability needs both the binding and a user row; maps needs only the key", () => {
  const user = { id: 1 };
  assert.deepEqual(storageAvailability({}, { user }), { storage: false, rag: false, maps: false });
  assert.deepEqual(storageAvailability({ STORAGE: {} }, {}), { storage: false, rag: false, maps: false });
  assert.deepEqual(storageAvailability({ STORAGE: {} }, { user }), { storage: true, rag: false, maps: false });
  assert.deepEqual(storageAvailability({ STORAGE: {}, RAG_INDEX: {} }, { user }), {
    storage: true,
    rag: true,
    maps: false,
  });
  // Vectorize alone (no R2) is not a usable configuration.
  assert.deepEqual(storageAvailability({ RAG_INDEX: {} }, { user }), { storage: false, rag: false, maps: false });
  // The maps key is identity-independent: break-glass gets the features too.
  assert.equal(storageAvailability({ GOOGLE_MAPS_API_KEY: "k" }, {}).maps, true);
  assert.equal(storageAvailability({ GOOGLE_MAPS_API_KEY: "k" }, { user }).maps, true);
});
