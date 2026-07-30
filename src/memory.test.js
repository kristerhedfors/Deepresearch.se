// Unit tests for account memory's Worker side (src/memory.js).
//
// The emphasis is deliberately on the GATES rather than the happy path: "off
// by default", "never in incognito" and "only a signed-in account" are
// privacy promises the feature makes in its own UI copy, so each one gets a
// test that fails if the promise stops holding. The D1 seam is faked the same
// way the grant tests fake it — a tiny prepare/bind/all/run/batch stand-in.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { memoryUserId, runMemoryExtraction } from "./memory.js";
import { memoryEnabled, parseSettings } from "./settings.js";

/**
 * Minimal D1 fake: records every statement, returns [] for reads and a
 * changes-count for writes. Enough for the gate tests, which assert on whether
 * a query happened at all rather than on rows.
 */
function fakeDb() {
  const calls = [];
  const stmt = (sql) => ({
    sql,
    bind: (...args) => ({ sql, args, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }) }),
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 0 } }),
  });
  return {
    calls,
    prepare(sql) {
      calls.push(sql);
      return stmt(sql);
    },
    async batch(list) {
      return list.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

const envWith = (db) => ({ DB: db });
const signedIn = { user: { id: "u1", email: "a@b.c" } };
const breakGlass = { user: null, breakGlass: true };

describe("memoryUserId", () => {
  test("returns the id for a signed-in account", () => {
    assert.equal(memoryUserId(signedIn), "u1");
  });

  test("refuses a break-glass identity — a shared credential has no personal memory", () => {
    assert.equal(memoryUserId(breakGlass), null);
    assert.equal(memoryUserId(null), null);
    assert.equal(memoryUserId({}), null);
  });
});

describe("memoryEnabled — the knob gate", () => {
  const identityWith = (json) => ({ user: { id: "u1", settings_json: json } });

  test("off by default: a brand-new account writes nothing", () => {
    assert.equal(parseSettings(null).memory, false);
    assert.equal(memoryEnabled(envWith(fakeDb()), identityWith(null)), false);
  });

  test("only an explicit stored true enables it", () => {
    assert.equal(memoryEnabled(envWith(fakeDb()), identityWith('{"memory":true}')), true);
    for (const stored of ['{"memory":false}', '{"memory":"true"}', '{"memory":1}', "{}"]) {
      assert.equal(memoryEnabled(envWith(fakeDb()), identityWith(stored)), false, stored);
    }
  });

  test("no database binding means no memory, whatever the knob says", () => {
    assert.equal(memoryEnabled({}, identityWith('{"memory":true}')), false);
  });

  test("a break-glass identity is refused even with the knob stored on", () => {
    assert.equal(memoryEnabled(envWith(fakeDb()), breakGlass), false);
  });
});

describe("runMemoryExtraction — the write gates", () => {
  const base = {
    log: { info() {}, warn() {} },
    identity: signedIn,
    question: "What is Exa?",
    answer: "Exa is a web search API used for retrieval.".padEnd(120, "."),
  };
  /** A jsonPhase that records whether it was called at all. */
  const spyPhase = (result) => {
    const calls = [];
    return {
      calls,
      fn: async (args) => {
        calls.push(args);
        return result;
      },
    };
  };

  test("stores notes when everything is permitted", async () => {
    const db = fakeDb();
    const phase = spyPhase({ notes: [{ title: "Exa", type: "organisation", body: "A web search API." }] });
    const res = await runMemoryExtraction({
      ...base, env: envWith(db), incognito: false, enabled: true, jsonPhase: phase.fn,
    });
    assert.equal(res.stored, 1);
    assert.equal(phase.calls.length, 1);
    assert.ok(db.calls.some((s) => s.startsWith("INSERT INTO memory_notes")), "should have written");
  });

  test("writes nothing when the knob is off — and never calls the model", async () => {
    const phase = spyPhase({ notes: [{ title: "Exa", body: "b" }] });
    const res = await runMemoryExtraction({
      ...base, env: envWith(fakeDb()), incognito: false, enabled: false, jsonPhase: phase.fn,
    });
    assert.deepEqual(res, { stored: 0, reason: "off" });
    assert.equal(phase.calls.length, 0, "an off knob must not cost a model call either");
  });

  test("writes nothing for an incognito turn", async () => {
    // The ghost toggle already suppresses the chat-log row; a memory note
    // outlives that row, so incognito has to cover it or it means less than
    // the UI says it does.
    const phase = spyPhase({ notes: [{ title: "Exa", body: "b" }] });
    const res = await runMemoryExtraction({
      ...base, env: envWith(fakeDb()), incognito: true, enabled: true, jsonPhase: phase.fn,
    });
    assert.deepEqual(res, { stored: 0, reason: "incognito" });
    assert.equal(phase.calls.length, 0);
  });

  test("writes nothing without a signed-in account", async () => {
    const phase = spyPhase({ notes: [{ title: "Exa", body: "b" }] });
    const res = await runMemoryExtraction({
      ...base, identity: breakGlass, env: envWith(fakeDb()), incognito: false, enabled: true, jsonPhase: phase.fn,
    });
    assert.deepEqual(res, { stored: 0, reason: "no_account" });
    assert.equal(phase.calls.length, 0);
  });

  test("skips a thin answer rather than paying for a model call", async () => {
    const phase = spyPhase({ notes: [] });
    const res = await runMemoryExtraction({
      ...base, answer: "Yes.", env: envWith(fakeDb()), incognito: false, enabled: true, jsonPhase: phase.fn,
    });
    assert.deepEqual(res, { stored: 0, reason: "thin_answer" });
    assert.equal(phase.calls.length, 0);
  });

  test("a turn that taught nothing durable is a normal outcome, not an error", async () => {
    const res = await runMemoryExtraction({
      ...base, env: envWith(fakeDb()), incognito: false, enabled: true,
      jsonPhase: async () => ({ notes: [] }),
    });
    assert.deepEqual(res, { stored: 0, reason: "nothing_durable" });
  });

  test("a failing extraction degrades instead of throwing (invariant 2)", async () => {
    const warnings = [];
    const res = await runMemoryExtraction({
      ...base,
      log: { info() {}, warn: (...a) => warnings.push(a) },
      env: envWith(fakeDb()), incognito: false, enabled: true,
      jsonPhase: async () => { throw new Error("model unreachable"); },
    });
    assert.deepEqual(res, { stored: 0, reason: "error" });
    assert.equal(warnings.length, 1, "the failure should still be logged");
  });

  test("junk from the model is dropped, not stored", async () => {
    for (const junk of [null, "not json", { notes: "no" }, { notes: [{ title: "" }] }]) {
      const res = await runMemoryExtraction({
        ...base, env: envWith(fakeDb()), incognito: false, enabled: true,
        jsonPhase: async () => junk,
      });
      assert.equal(res.stored, 0, JSON.stringify(junk));
    }
  });

  test("passes the already-known titles to the prompt so re-mentions merge", async () => {
    const phase = spyPhase({ notes: [] });
    await runMemoryExtraction({
      ...base, env: envWith(fakeDb()), incognito: false, enabled: true, jsonPhase: phase.fn,
    });
    assert.match(phase.calls[0].system, /research memory/);
    assert.match(phase.calls[0].user, /What is Exa\?/);
  });
});
