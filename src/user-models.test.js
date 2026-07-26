// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Unit tests for the accepted-model store (src/user-models.js) — the promotion
// pipeline's persistence — plus the settings_json merge that keeps it alive
// across a knob write (src/settings.js mergeStoredSettings).
//
// The load-bearing property tested here is the one that would silently corrupt
// billing if it broke: an accepted entry must carry a real per-token price, and
// it must survive every other write to the same D1 column.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPTED_KEY,
  acceptedFromBrowseItem,
  acceptedModels,
  acceptModel,
  hfRefreshNotes,
  MAX_STORED,
  normalizeAccepted,
  parseAcceptedModels,
  removeAcceptedModel,
} from "./user-models.js";
import { mergeStoredSettings, parseSettings } from "./settings.js";

// A minimal D1 fake, handed in as the env's DB binding — getDb applies the
// schema through `batch` and then returns it, so this covers both the migration
// path and the single UPDATE the store issues.
function fakeEnv() {
  const state = { sql: "", args: /** @type {any[]} */ ([]) };
  const db = {
    prepare(/** @type {string} */ sql) {
      if (sql.startsWith("UPDATE users")) state.sql = sql;
      return {
        bind(/** @type {any[]} */ ...args) {
          if (state.sql) state.args = args;
          return { run: async () => ({}) };
        },
        run: async () => ({}),
      };
    },
    batch: async () => [],
  };
  return { state, env: /** @type {any} */ ({ DB: db }) };
}

/** @param {any} settingsJson */
function identityWith(settingsJson) {
  return /** @type {any} */ ({ id: "7", role: "user", user: { id: 7, settings_json: settingsJson } });
}

const ROW = {
  id: "hf:meta-llama/Llama-3.1-8B-Instruct@nebius",
  name: "Llama-3.1-8B-Instruct",
  price_in: 1.84e-8,
  price_out: 5.52e-8,
  usd_in: 0.02,
  usd_out: 0.06,
  context: 131072,
  vision: false,
  accepted_at: 1700000000000,
};

describe("parsing stored entries", () => {
  test("an entry without a valid hf: id is dropped", () => {
    assert.equal(normalizeAccepted({ ...ROW, id: "meta-llama/Llama" }), null);
    assert.equal(normalizeAccepted({ ...ROW, id: "gpt-5.6-sol" }), null);
    assert.equal(normalizeAccepted(null), null);
  });

  test("a valid entry keeps its snapshot and derives hfId/provider from the id", () => {
    const m = normalizeAccepted(ROW);
    assert.ok(m);
    assert.equal(m.hfId, "meta-llama/Llama-3.1-8B-Instruct");
    assert.equal(m.provider, "nebius");
    assert.equal(m.price_out, 5.52e-8);
  });

  test("parseAcceptedModels tolerates junk, dedupes, and caps", () => {
    assert.deepEqual(parseAcceptedModels("not json"), []);
    assert.deepEqual(parseAcceptedModels(JSON.stringify({ developer_mode: true })), []);
    const dupes = { [ACCEPTED_KEY]: [ROW, ROW, { id: "bad" }] };
    assert.equal(parseAcceptedModels(JSON.stringify(dupes)).length, 1);
    const many = { [ACCEPTED_KEY]: Array.from({ length: MAX_STORED + 5 }, (_, i) => ({ ...ROW, id: `hf:o/m${i}` })) };
    assert.equal(parseAcceptedModels(many).length, MAX_STORED);
  });

  test("a model with no price is never storable", () => {
    // The one failure mode this store must not have: an entry with no rate
    // would bill every request that used it at zero.
    assert.equal(acceptedFromBrowseItem({ hfId: "o/m", price_in: 0, price_out: 0 }, 1), null);
    assert.equal(acceptedFromBrowseItem({ hfId: "not-a-path", price_in: 1, price_out: 1 }, 1), null);
    const ok = acceptedFromBrowseItem({ hfId: "o/m", provider: "together", price_in: 0, price_out: 3e-8, name: "m" }, 42);
    assert.equal(ok?.id, "hf:o/m@together");
    assert.equal(ok?.accepted_at, 42);
  });
});

describe("the settings_json merge", () => {
  test("writing knobs preserves the accepted list, and vice versa", () => {
    // This is the bug the merge exists to prevent: parseSettings drops every
    // key it doesn't know, so writing its output back would delete the models
    // an account enabled the moment they toggled any knob.
    const stored = JSON.stringify({ developer_mode: true, [ACCEPTED_KEY]: [ROW] });
    const afterKnob = mergeStoredSettings(stored, parseSettings(stored));
    assert.equal(afterKnob[ACCEPTED_KEY].length, 1);
    assert.equal(afterKnob.developer_mode, true);
    const afterModels = mergeStoredSettings(stored, { [ACCEPTED_KEY]: [] });
    assert.equal(afterModels.developer_mode, true);
    assert.deepEqual(afterModels[ACCEPTED_KEY], []);
  });

  test("an unreadable column merges onto {} rather than throwing", () => {
    assert.deepEqual(mergeStoredSettings("{oops", { a: 1 }), { a: 1 });
    assert.deepEqual(mergeStoredSettings(null, { a: 1 }), { a: 1 });
    assert.deepEqual(mergeStoredSettings("[1,2]", { a: 1 }), { a: 1 });
  });
});

describe("accept and remove", () => {
  test("accepting writes through the merge and updates the in-request identity", async () => {
    const { env, state } = fakeEnv();
    const identity = identityWith(JSON.stringify({ developer_mode: true }));
    const list = await acceptModel(env, identity, /** @type {any} */ (normalizeAccepted(ROW)));
    assert.equal(list.length, 1);
    const written = JSON.parse(state.args[0]);
    assert.equal(written.developer_mode, true);
    assert.equal(written[ACCEPTED_KEY][0].hfId, "meta-llama/Llama-3.1-8B-Instruct");
    // The identity now reflects the write, so a handler answering with the
    // fresh catalog doesn't have to re-read D1.
    assert.equal(acceptedModels(identity).length, 1);
  });

  test("re-accepting refreshes in place instead of duplicating", async () => {
    const { env } = fakeEnv();
    const identity = identityWith(JSON.stringify({ [ACCEPTED_KEY]: [ROW] }));
    const cheaper = { ...ROW, usd_out: 0.03, price_out: 2.76e-8 };
    const list = await acceptModel(env, identity, /** @type {any} */ (normalizeAccepted(cheaper)));
    assert.equal(list.length, 1);
    assert.equal(list[0].usd_out, 0.03);
  });

  test("removing matches the full id OR the bare repo id", async () => {
    const { env } = fakeEnv();
    const identity = identityWith(JSON.stringify({ [ACCEPTED_KEY]: [ROW] }));
    const list = await removeAcceptedModel(env, identity, "hf:meta-llama/Llama-3.1-8B-Instruct");
    assert.deepEqual(list, []);
  });

  test("the break-glass identity has no accepted models (no row to hang them on)", () => {
    assert.deepEqual(acceptedModels(/** @type {any} */ ({ id: "admin", isSecretAdmin: true })), []);
    assert.deepEqual(acceptedModels(null), []);
  });
});

describe("snapshot drift", () => {
  test("a re-priced or withdrawn model is reported, an unchanged one is not", () => {
    const accepted = /** @type {any} */ ([normalizeAccepted(ROW)]);
    const same = /** @type {any} */ ([{ hfId: "meta-llama/Llama-3.1-8B-Instruct", best: { usdOut: 0.06 } }]);
    assert.deepEqual(hfRefreshNotes(accepted, same), []);
    const dearer = /** @type {any} */ ([{ hfId: "meta-llama/Llama-3.1-8B-Instruct", best: { usdOut: 0.12 } }]);
    assert.deepEqual(hfRefreshNotes(accepted, dearer), [{
      id: ROW.id,
      hfId: "meta-llama/Llama-3.1-8B-Instruct",
      gone: false,
      usd_out: 0.12,
      was_usd_out: 0.06,
    }]);
    assert.equal(hfRefreshNotes(accepted, [])[0].gone, true);
  });
});
