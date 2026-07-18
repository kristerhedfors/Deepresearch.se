// Unit tests for the per-user settings knobs (src/settings.js): parseSettings
// coercion/defaults and the storage/feature availability gates.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bashLiteEnabled,
  cloudStorageEnabled,
  developerModeEnabled,
  featureAvailability,
  googleMapsEnabled,
  parseSettings,
  shodanEnabled,
  storageAvailability,
} from "./settings.js";

const DEFAULTS = { shodan_mcp: false, google_maps: false, bash_lite_mcp: false, developer_mode: false };

test("parseSettings defaults: every knob off", () => {
  assert.deepEqual(parseSettings(null), DEFAULTS);
  assert.deepEqual(parseSettings(undefined), DEFAULTS);
  assert.deepEqual(parseSettings(""), DEFAULTS);
});

test("parseSettings survives malformed JSON (falls back to defaults)", () => {
  assert.deepEqual(parseSettings("{not json"), DEFAULTS);
  assert.deepEqual(parseSettings("[1,2,3]"), DEFAULTS);
  assert.deepEqual(parseSettings('"a string"'), DEFAULTS);
});

test("parseSettings: a legacy stored server_history flag is dropped like any unknown key", () => {
  // Cloud storage is implicit on Se/rver (no knob) — accounts that stored an
  // opt-out under the old knob simply lose the key on the next parse.
  const s = parseSettings('{"server_history":false,"shodan_mcp":true}');
  assert.equal("server_history" in s, false);
  assert.equal(s.shodan_mcp, true);
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

test("cloudStorageEnabled is availability, nothing else: binding AND user row", () => {
  const env = { STORAGE: {} };
  const fresh = { user: { id: 2, settings_json: null } };
  // No stored setting can turn cloud storage off — a legacy opt-out included.
  const legacyOptOut = { user: { id: 1, settings_json: '{"server_history":false}' } };
  assert.equal(cloudStorageEnabled(env, fresh), true);
  assert.equal(cloudStorageEnabled(env, legacyOptOut), true);
  assert.equal(cloudStorageEnabled({}, fresh), false); // no R2 binding
  assert.equal(cloudStorageEnabled(env, {}), false); // break-glass: no user row
});

test("parseSettings drops unknown keys", () => {
  const s = parseSettings('{"shodan_mcp":true,"evil":"x"}');
  assert.deepEqual(Object.keys(s).sort(), ["bash_lite_mcp", "developer_mode", "google_maps", "shodan_mcp"]);
});

test("parseSettings: a legacy stored feedback_mode flag is dropped like any unknown key", () => {
  // Feedback is no longer a knob (given from the chat) — accounts that stored
  // the old flag simply lose the key on the next parse.
  const s = parseSettings('{"feedback_mode":true,"shodan_mcp":true}');
  assert.equal("feedback_mode" in s, false);
  assert.equal(s.shodan_mcp, true);
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

test("featureAvailability reports storage, rag, shodan, and google_maps independently", () => {
  const user = { id: 1 };
  // bash_lite is a pure browser capability: available whenever there's a user
  // row, regardless of any server secret.
  assert.deepEqual(featureAvailability({}, { user }), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: false,
    bash_lite: true,
    developer: true,
  });
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k" }, { user }), {
    storage: false,
    rag: false,
    shodan: true,
    google_maps: false,
    bash_lite: true,
    developer: true,
  });
  assert.deepEqual(featureAvailability({ GOOGLE_MAPS_API_KEY: "k" }, { user }), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: true,
    bash_lite: true,
    developer: true,
  });
  // An empty identity (no user row, not the admin) has nothing available.
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k", GOOGLE_MAPS_API_KEY: "k", DB: {} }, {}), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: false,
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
    bash_lite: true,
    developer: true,
  });
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
