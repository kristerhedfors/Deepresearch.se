import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runEnrichments, ENRICHMENTS } from "./index.js";

// A capturing emit: records every SSE object so tests can assert on the
// step_start / step_done / streetview_embed sequence.
function recorder() {
  const events = [];
  const emit = (obj) => events.push(obj);
  const steps = () => events.filter((e) => e.status?.type === "step_start").map((e) => e.status.id);
  const dones = () => events.filter((e) => e.status?.type === "step_done");
  return { events, emit, steps, dones };
}

const noopLog = { warn() {}, info() {}, debug() {}, error() {} };

// A last-message-only conversation the withAppendedText helper can append to.
function convo(text = "hello") {
  return [{ role: "user", content: text }];
}

describe("runEnrichments — registry iteration", () => {
  test("a descriptor whose detect() returns null contributes nothing and emits no step", async () => {
    const { emit, events } = recorder();
    let ran = false;
    const desc = {
      id: "x",
      startLabel: "X…",
      detect: () => null,
      run: () => {
        ran = true;
        return { block: "\n\nBLOCK", details: [], count: 1, doneLabel: "done" };
      },
    };
    const out = await runEnrichments({}, noopLog, emit, convo("keep me"), {}, undefined, [desc]);
    assert.equal(ran, false, "run() must not be called when detect returns null");
    assert.equal(events.length, 0, "no step events emitted");
    assert.deepEqual(out, convo("keep me"), "conversation unchanged");
  });

  test("a detecting descriptor emits step_start then step_done and appends its block", async () => {
    const { emit, steps, dones } = recorder();
    const desc = {
      id: "x",
      countKey: "xCount",
      startLabel: "X…",
      detect: () => ({ hit: true }),
      run: () => ({ block: "\n\nCONTEXT BLOCK", details: ["d1"], count: 2, doneLabel: "Found 2" }),
    };
    const state = {};
    const out = await runEnrichments({}, noopLog, emit, convo("q"), state, undefined, [desc]);
    assert.deepEqual(steps(), ["x"]);
    assert.equal(dones()[0].status.label, "Found 2");
    assert.deepEqual(dones()[0].status.details, ["d1"]);
    assert.equal(state.xCount, 2, "count stashed on state");
    assert.equal(out[0].content, "q\n\nCONTEXT BLOCK", "block appended to the last message");
  });

  test("preserves registry order across multiple detecting descriptors", async () => {
    const { emit, steps } = recorder();
    const mk = (id) => ({
      id,
      startLabel: `${id}…`,
      detect: () => ({}),
      run: () => ({ block: `\n\n${id}`, details: [], count: 0, doneLabel: id }),
    });
    const out = await runEnrichments({}, noopLog, emit, convo("base"), {}, undefined, [mk("a"), mk("b"), mk("c")]);
    assert.deepEqual(steps(), ["a", "b", "c"], "steps fire in registry order");
    // Blocks appended in the same order.
    assert.equal(out[0].content, "base\n\na\n\nb\n\nc");
  });
});

describe("runEnrichments — fail-soft", () => {
  test("a run() that throws leaves the conversation unchanged and emits the unavailable step", async () => {
    const { emit, dones } = recorder();
    const desc = {
      id: "boom",
      startLabel: "Boom…",
      unavailableLabel: "boom unavailable",
      detect: () => ({}),
      run: () => {
        throw new Error("kaboom");
      },
    };
    const out = await runEnrichments({}, noopLog, emit, convo("safe"), {}, undefined, [desc]);
    assert.deepEqual(out, convo("safe"), "conversation unchanged after a throwing run()");
    assert.equal(dones()[0].status.label, "boom unavailable");
  });

  test("a run() returning null emits the unavailable step and does not change the conversation", async () => {
    const { emit, dones } = recorder();
    const desc = {
      id: "empty",
      startLabel: "Empty…",
      unavailableLabel: "nothing here",
      detect: () => ({}),
      run: () => null,
    };
    const out = await runEnrichments({}, noopLog, emit, convo("x"), {}, undefined, [desc]);
    assert.deepEqual(out, convo("x"));
    assert.equal(dones()[0].status.label, "nothing here");
  });

  test("a throwing detect() degrades to silent (no step, no change) and does not stop later descriptors", async () => {
    const { emit, steps } = recorder();
    const bad = {
      id: "bad",
      startLabel: "Bad…",
      detect: () => {
        throw new Error("detect boom");
      },
      run: () => ({ block: "\n\nX", details: [], count: 0, doneLabel: "x" }),
    };
    const good = {
      id: "good",
      startLabel: "Good…",
      detect: () => ({}),
      run: () => ({ block: "\n\nGOOD", details: [], count: 0, doneLabel: "good" }),
    };
    const out = await runEnrichments({}, noopLog, emit, convo("c"), {}, undefined, [bad, good]);
    assert.deepEqual(steps(), ["good"], "bad detector emits no step; good one still runs");
    assert.equal(out[0].content, "c\n\nGOOD");
  });

  test("emits streetview_embed AFTER step_done when run() returns an embed", async () => {
    const { emit, events } = recorder();
    const desc = {
      id: "maps",
      startLabel: "Maps…",
      detect: () => ({}),
      run: () => ({ block: "\n\nM", details: [], count: 1, doneLabel: "map", embed: { lat: 1, lng: 2 } }),
    };
    await runEnrichments({}, noopLog, emit, convo("c"), {}, undefined, [desc]);
    const types = events.map((e) => e.status.type);
    const doneIdx = types.indexOf("step_done");
    const embedIdx = types.indexOf("streetview_embed");
    assert.ok(embedIdx > doneIdx, "streetview_embed comes after step_done");
    assert.deepEqual(events[embedIdx].status, { type: "streetview_embed", lat: 1, lng: 2 });
  });
});

describe("runEnrichments — gating", () => {
  test("without identity, gates on the pre-resolved state flag", async () => {
    const { emit, steps } = recorder();
    const desc = {
      id: "s",
      stateFlag: "shodan",
      startLabel: "S…",
      detect: () => ({}),
      run: () => ({ block: "\n\nS", details: [], count: 0, doneLabel: "s" }),
    };
    await runEnrichments({}, noopLog, emit, convo("c"), { shodan: false }, undefined, [desc]);
    assert.deepEqual(steps(), [], "state flag off → skipped entirely");

    const r2 = recorder();
    await runEnrichments({}, noopLog, r2.emit, convo("c"), { shodan: true }, undefined, [desc]);
    assert.deepEqual(r2.steps(), ["s"], "state flag on → runs");
  });

  test("with identity, gates on enabled(env, identity)", async () => {
    const { emit, steps } = recorder();
    const desc = {
      id: "e",
      stateFlag: "shodan",
      startLabel: "E…",
      enabled: (env, identity) => identity.allow === true,
      detect: () => ({}),
      run: () => ({ block: "\n\nE", details: [], count: 0, doneLabel: "e" }),
    };
    await runEnrichments({}, noopLog, emit, convo("c"), { shodan: true }, { allow: false }, [desc]);
    assert.deepEqual(steps(), [], "enabled() false wins over the state flag when identity is supplied");
  });

  test("the real registry is Shodan then Google Maps, and does nothing with both knobs off", async () => {
    assert.deepEqual(ENRICHMENTS.map((e) => e.id), ["shodan", "maps"]);
    const { emit, events } = recorder();
    const out = await runEnrichments({}, noopLog, emit, convo("ordinary question"), {
      shodan: false,
      googleMaps: false,
    });
    assert.equal(events.length, 0);
    assert.deepEqual(out, convo("ordinary question"));
  });
});
