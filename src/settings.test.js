// Unit tests for the per-user settings knobs (src/settings.js): parseSettings
// coercion/defaults and the storage/feature availability gates.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bashLiteEnabled,
  chatModesAvailable,
  cloudStorageEnabled,
  extensionEnabled,
  extensionEnabledMap,
  featureAvailability,
  parseSettings,
  storageAvailability,
  storedChatMode,
} from "./settings.js";

const DEFAULTS = { shodan_mcp: false, google_maps: false, bash_lite_mcp: false, memory: false, chat_mode: "science" };

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
  assert.deepEqual(Object.keys(s).sort(), ["bash_lite_mcp", "chat_mode", "google_maps", "memory", "shodan_mcp"]);
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

test("parseSettings: chat_mode is the stored mode, clamped to a known one", () => {
  assert.equal(parseSettings('{"chat_mode":"sdk"}').chat_mode, "sdk");
  assert.equal(parseSettings('{"chat_mode":"introspection"}').chat_mode, "introspection");
  assert.equal(parseSettings('{"chat_mode":"models"}').chat_mode, "models");
  // Junk and retired modes clamp to normal rather than riding through.
  assert.equal(parseSettings('{"chat_mode":"swe"}').chat_mode, "science");
  assert.equal(parseSettings('{"chat_mode":7}').chat_mode, "science");
  assert.equal(parseSettings("{}").chat_mode, "science");
});

test("parseSettings: a legacy developer_mode row migrates to the introspection mode", () => {
  // Rows written before the 2026-07-26 collapse carry the boolean knob and no
  // chat_mode. Knob ON meant "some non-Normal mode", and introspection is the
  // mode it unlocked — so that is what it reads as. Knob OFF means normal.
  assert.equal(parseSettings('{"developer_mode":true}').chat_mode, "introspection");
  assert.equal(parseSettings('{"developer_mode":false}').chat_mode, "science");
  // Only an explicit stored `true` migrates — junk is not a knob-on row.
  assert.equal(parseSettings('{"developer_mode":1}').chat_mode, "science");
  assert.equal(parseSettings('{"developer_mode":"true"}').chat_mode, "science");
  // The dead key is dropped from the parsed shape like any other unknown key…
  assert.equal("developer_mode" in parseSettings('{"developer_mode":true}'), false);
  // …and once chat_mode exists it wins outright, however stale the old key is.
  // A STORED legacy id resolves to its successor rather than being clamped as
  // unknown: `normal` still names a mode a user once picked (RETIRED_CHAT_MODES).
  assert.equal(parseSettings('{"developer_mode":true,"chat_mode":"normal"}').chat_mode, "science");
  assert.equal(parseSettings('{"developer_mode":false,"chat_mode":"sdk"}').chat_mode, "sdk");
});

test("chatModesAvailable: any signed-in account OR the break-glass admin", () => {
  // Availability, not an opt-in: there is no stored flag left to consult, so a
  // fresh account with no settings row has the modes available to it.
  assert.equal(chatModesAvailable({}, { user: { id: 2, settings_json: null } }), true);
  assert.equal(chatModesAvailable({}, {}), false); // empty identity: nothing to gate on
  assert.equal(chatModesAvailable({}, { isSecretAdmin: true }), true);
});

test("storedChatMode: the account's pick; normal for break-glass", () => {
  assert.equal(storedChatMode({ user: { id: 1, settings_json: '{"chat_mode":"orchestrator"}' } }), "orchestrator");
  assert.equal(storedChatMode({ user: { id: 2, settings_json: null } }), "science");
  // Break-glass has no row to persist a pick in, so each request says which mode
  // it wants — and gets plain deep research when it says nothing. (The old knob
  // read as permanently ON here, which made every unflagged operator request
  // introspection.)
  assert.equal(storedChatMode({ isSecretAdmin: true }), "science");
  assert.equal(storedChatMode({}), "science");
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

// The knob gate is generic now (extensionEnabled by registry id) — settings.js
// no longer has a per-service helper. The rule it enforces is unchanged.
test("extensionEnabled: needs the backing secret, a user row, AND the knob on", () => {
  const env = { SHODAN_API_KEY: "k" };
  const on = { user: { id: 1, settings_json: '{"shodan_mcp":true}' } };
  const off = { user: { id: 2, settings_json: null } }; // default off
  assert.equal(extensionEnabled(env, on, "shodan"), true);
  assert.equal(extensionEnabled(env, off, "shodan"), false); // default off
  assert.equal(extensionEnabled({}, on, "shodan"), false); // no SHODAN_API_KEY
  assert.equal(extensionEnabled(env, {}, "shodan"), false); // break-glass: no user row
  assert.equal(extensionEnabled(env, on, "nope"), false); // unknown id is simply off
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
    exec_container: false,
  });
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k" }, { user }), {
    storage: false,
    rag: false,
    shodan: true,
    google_maps: false,
    bash_lite: true,
    developer: true,
    exec_container: false,
  });
  assert.deepEqual(featureAvailability({ GOOGLE_MAPS_API_KEY: "k" }, { user }), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: true,
    bash_lite: true,
    developer: true,
    exec_container: false,
  });
  // An empty identity (no user row, not the admin) has nothing available.
  assert.deepEqual(featureAvailability({ SHODAN_API_KEY: "k", GOOGLE_MAPS_API_KEY: "k", DB: {} }, {}), {
    storage: false,
    rag: false,
    shodan: false,
    google_maps: false,
    bash_lite: false,
    developer: false,
    exec_container: false,
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
    exec_container: false,
  });
});

test("exec_container follows the OPTIONAL container binding, not a secret", () => {
  const user = { id: 1 };
  // The server-side execution environment is the one availability entry backed
  // by a BINDING rather than a key: absent (the shipped default), the Settings
  // picker omits the option entirely.
  assert.equal(featureAvailability({}, { user }).exec_container, false);
  assert.equal(featureAvailability({ EXEC_SANDBOX: {} }, { user }).exec_container, true);
  // Break-glass admin gets it too, which keeps it testable with those creds.
  assert.equal(featureAvailability({ EXEC_SANDBOX: {} }, { isSecretAdmin: true }).exec_container, true);
  // No identity at all: nothing.
  assert.equal(featureAvailability({ EXEC_SANDBOX: {} }, {}).exec_container, false);
});

test("extensionEnabledMap resolves every registered extension at once", () => {
  const env = { GOOGLE_MAPS_API_KEY: "k" };
  const on = { user: { id: 1, settings_json: '{"google_maps":true}' } };
  const off = { user: { id: 2, settings_json: null } }; // default off
  assert.deepEqual(extensionEnabledMap(env, on), { shodan: false, maps: true });
  assert.deepEqual(extensionEnabledMap(env, off), { shodan: false, maps: false });
  assert.deepEqual(extensionEnabledMap({}, on), { shodan: false, maps: false }); // no key
  assert.deepEqual(extensionEnabledMap(env, {}), { shodan: false, maps: false }); // no user row
  assert.deepEqual(
    extensionEnabledMap(
      { SHODAN_API_KEY: "k", GOOGLE_MAPS_API_KEY: "k" },
      { user: { id: 3, settings_json: '{"shodan_mcp":true,"google_maps":true}' } },
    ),
    { shodan: true, maps: true },
  );
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
