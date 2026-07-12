// Unit tests for the per-user settings knobs (src/settings.js): parseSettings
// coercion/defaults and the storage/feature availability gates.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bashLiteEnabled,
  developerModeEnabled,
  featureAvailability,
  feedbackEnabled,
  googleMapsEnabled,
  parseSettings,
  serverHistoryEnabled,
  shodanEnabled,
  storageAvailability,
} from "./settings.js";

const DEFAULTS = { server_history: true, shodan_mcp: false, google_maps: false, feedback_mode: false, bash_lite_mcp: false, developer_mode: false };

test("parseSettings defaults: history on, shodan off, google_maps off, feedback off", () => {
  assert.deepEqual(parseSettings(null), DEFAULTS);
  assert.deepEqual(parseSettings(undefined), DEFAULTS);
  assert.deepEqual(parseSettings(""), DEFAULTS);
});

test("parseSettings survives malformed JSON (falls back to defaults)", () => {
  assert.deepEqual(parseSettings("{not json"), DEFAULTS);
  assert.deepEqual(parseSettings("[1,2,3]"), DEFAULTS);
  assert.deepEqual(parseSettings('"a string"'), DEFAULTS);
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

test("parseSettings: only an explicit stored true enables google_maps", () => {
  assert.equal(parseSettings('{"google_maps":true}').google_maps, true);
  assert.equal(parseSettings('{"google_maps":false}').google_maps, false);
  // Non-boolean junk means the default (off), not on.
  assert.equal(parseSettings('{"google_maps":1}').google_maps, false);
  assert.equal(parseSettings('{"google_maps":"true"}').google_maps, false);
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
  assert.deepEqual(Object.keys(s).sort(), ["bash_lite_mcp", "developer_mode", "feedback_mode", "google_maps", "server_history", "shodan_mcp"]);
});

test("parseSettings: only an explicit stored true enables feedback_mode", () => {
  assert.equal(parseSettings('{"feedback_mode":true}').feedback_mode, true);
  assert.equal(parseSettings('{"feedback_mode":false}').feedback_mode, false);
  // Non-boolean junk means the default (off), not on.
  assert.equal(parseSettings('{"feedback_mode":1}').feedback_mode, false);
  assert.equal(parseSettings('{"feedback_mode":"true"}').feedback_mode, false);
});

test("parseSettings: only an explicit stored true enables bash_lite_mcp", () => {
  assert.equal(parseSettings('{"bash_lite_mcp":true}').bash_lite_mcp, true);
  assert.equal(parseSettings('{"bash_lite_mcp":false}').bash_lite_mcp, false);
  // Non-boolean junk means the default (off), not on.
  assert.equal(parseSettings('{"bash_lite_mcp":1}').bash_lite_mcp, false);
  assert.equal(parseSettings('{"bash_lite_mcp":"true"}').bash_lite_mcp, false);
});

test("parseSettings: only an explicit stored true enables developer_mode", () => {
  assert.equal(parseSettings('{"developer_mode":true}').developer_mode, true);
  assert.equal(parseSettings('{"developer_mode":false}').developer_mode, false);
  // Non-boolean junk means the default (off), not on.
  assert.equal(parseSettings('{"developer_mode":1}').developer_mode, false);
  assert.equal(parseSettings('{"developer_mode":"true"}').developer_mode, false);
});

test("developerModeEnabled: a user row + the knob on, OR the break-glass admin", () => {
  const on = { user: { id: 1, settings_json: '{"developer_mode":true}' } };
  const off = { user: { id: 2, settings_json: null } }; // default off
  assert.equal(developerModeEnabled({}, on), true); // no secret required
  assert.equal(developerModeEnabled({}, off), false); // default off
  assert.equal(developerModeEnabled({}, {}), false); // empty identity: nothing to gate on
  // Break-glass is a developer identity by definition — mode simply on.
  assert.equal(developerModeEnabled({}, { isSecretAdmin: true }), true);
});

test("bashLiteEnabled: a user row + the knob on, OR the break-glass admin", () => {
  const on = { user: { id: 1, settings_json: '{"bash_lite_mcp":true}' } };
  const off = { user: { id: 2, settings_json: null } }; // default off
  assert.equal(bashLiteEnabled({}, on), true); // no secret required
  assert.equal(bashLiteEnabled({}, off), false); // default off
  assert.equal(bashLiteEnabled({}, {}), false); // empty identity: nothing to gate on
  // The break-glass admin (an explicit operator identity, no D1 row) gets the
  // sandbox unconditionally — no stored knob to consult.
  assert.equal(bashLiteEnabled({}, { isSecretAdmin: true }), true);
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

test("featureAvailability reports storage, rag, shodan, google_maps, and feedback independently", () => {
  const user = { id: 1 };
  // bash_lite is a pure browser capability: available whenever there's a user
  // row, regardless of any server secret.
  assert.deepEqual(featureAvailability({}, { user }), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: false,
    feedback: false,
    bash_lite: true,
    developer: true,
  });
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k" }, { user }), {
    storage: false,
    rag: false,
    shodan: true,
    google_maps: false,
    feedback: false,
    bash_lite: true,
    developer: true,
  });
  // Feedback needs only D1 (+ a user row) — no external secret.
  assert.deepEqual(featureAvailability({ DB: {} }, { user }), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: false,
    feedback: true,
    bash_lite: true,
    developer: true,
  });
  assert.deepEqual(featureAvailability({ GOOGLE_MAPS_API_KEY: "k" }, { user }), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: true,
    feedback: false,
    bash_lite: true,
    developer: true,
  });
  // An empty identity (no user row, not the admin) has nothing available.
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k", GOOGLE_MAPS_API_KEY: "k", DB: {} }, {}), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: false,
    feedback: false,
    bash_lite: false,
    developer: false,
  });
  // The break-glass admin (isSecretAdmin, no user row) gets bash_lite and
  // developer — the features with no D1/secret dependency — but not the
  // row-backed ones.
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k", GOOGLE_MAPS_API_KEY: "k", DB: {} }, { isSecretAdmin: true }), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: false,
    feedback: false,
    bash_lite: true,
    developer: true,
  });
});

test("feedbackEnabled: needs D1, a user row, AND the knob on", () => {
  const env = { DB: {} };
  const on = { user: { id: 1, settings_json: '{"feedback_mode":true}' } };
  const off = { user: { id: 2, settings_json: null } }; // default off
  assert.equal(feedbackEnabled(env, on), true);
  assert.equal(feedbackEnabled(env, off), false); // default off
  assert.equal(feedbackEnabled({}, on), false); // no D1
  assert.equal(feedbackEnabled(env, {}), false); // break-glass: no user row
});

test("googleMapsEnabled: needs the key, a user row, AND the knob on", () => {
  const env = { GOOGLE_MAPS_API_KEY: "k" };
  const on = { user: { id: 1, settings_json: '{"google_maps":true}' } };
  const off = { user: { id: 2, settings_json: null } }; // default off
  assert.equal(googleMapsEnabled(env, on), true);
  assert.equal(googleMapsEnabled(env, off), false); // default off
  assert.equal(googleMapsEnabled({}, on), false); // no GOOGLE_MAPS_API_KEY
  assert.equal(googleMapsEnabled(env, {}), false); // break-glass: no user row
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
