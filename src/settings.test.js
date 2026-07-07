import { test } from "node:test";
import assert from "node:assert/strict";

import {
  featureAvailability,
  parseSettings,
  serverHistoryEnabled,
  shodanEnabled,
  storageAvailability,
} from "./settings.js";

test("parseSettings defaults: history on, shodan off", () => {
  assert.deepEqual(parseSettings(null), { server_history: true, shodan_mcp: false });
  assert.deepEqual(parseSettings(undefined), { server_history: true, shodan_mcp: false });
  assert.deepEqual(parseSettings(""), { server_history: true, shodan_mcp: false });
});

test("parseSettings survives malformed JSON (falls back to defaults)", () => {
  assert.deepEqual(parseSettings("{not json"), { server_history: true, shodan_mcp: false });
  assert.deepEqual(parseSettings("[1,2,3]"), { server_history: true, shodan_mcp: false });
  assert.deepEqual(parseSettings('"a string"'), { server_history: true, shodan_mcp: false });
});

test("parseSettings: only an explicit stored false opts out of history", () => {
  assert.equal(parseSettings('{"server_history":true}').server_history, true);
  assert.equal(parseSettings('{"server_history":false}').server_history, false);
  // Non-boolean junk means the default (on), not off.
  assert.equal(parseSettings('{"server_history":0}').server_history, true);
  assert.equal(parseSettings('{"server_history":"false"}').server_history, true);
});

test("parseSettings: only an explicit stored true enables shodan", () => {
  assert.equal(parseSettings('{"shodan_mcp":true}').shodan_mcp, true);
  assert.equal(parseSettings('{"shodan_mcp":false}').shodan_mcp, false);
  // Non-boolean junk means the default (off), not on.
  assert.equal(parseSettings('{"shodan_mcp":1}').shodan_mcp, false);
  assert.equal(parseSettings('{"shodan_mcp":"true"}').shodan_mcp, false);
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
  assert.deepEqual(Object.keys(s).sort(), ["server_history", "shodan_mcp"]);
});

test("shodanEnabled: needs the key, a user row, AND the knob on", () => {
  const env = { SHODAN_API_KEY: "k" };
  const on = { user: { id: 1, settings_json: '{"shodan_mcp":true}' } };
  const off = { user: { id: 2, settings_json: null } }; // default off
  assert.equal(shodanEnabled(env, on), true);
  assert.equal(shodanEnabled(env, off), false); // default off
  assert.equal(shodanEnabled({}, on), false); // no SHODAN_API_KEY
  assert.equal(shodanEnabled(env, {}), false); // break-glass: no user row
});

test("featureAvailability reports storage, rag, and shodan independently", () => {
  const user = { id: 1 };
  assert.deepEqual(featureAvailability({}, { user }), { storage: false, rag: false, shodan: false });
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k" }, { user }), {
    storage: false,
    rag: false,
    shodan: true,
  });
  // Shodan needs a user row too (break-glass has none).
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k" }, {}), {
    storage: false,
    rag: false,
    shodan: false,
  });
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
