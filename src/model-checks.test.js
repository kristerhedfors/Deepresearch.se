// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Unit tests for the model verification checks (src/model-checks.js).
//
// The checks themselves make network calls, so what is pinned here is
// everything AROUND them: which apply to what, that a thrown check becomes a
// recorded failure instead of an exception, and — most importantly — that the
// three-state checklist keeps "untested" distinct from "failed". A checklist
// that collapsed those two would turn "nobody has asked yet" into an
// accusation, which is the exact opposite of a non-blocking status.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  checkById,
  checklistFor,
  checkSummary,
  checksFor,
  LATENCY_BUDGET_MS,
  MODEL_CHECKS,
  runCheck,
  runChecks,
} from "./model-checks.js";

describe("the registry", () => {
  test("every check declares an id, a label and WHY it exists", () => {
    // The `why` is what the sidebar shows on hover. A check nobody can justify
    // in a sentence is a check that should not be on the card.
    for (const c of MODEL_CHECKS) {
      assert.ok(c.id && /^[a-z-]+$/.test(c.id), c.id);
      assert.ok(c.label && c.label.length < 24, `${c.id} label`);
      assert.ok(c.why && c.why.length > 40, `${c.id} why`);
      assert.equal(typeof c.applies, "function");
      assert.equal(typeof c.run, "function");
    }
    // Ids are unique — they key the stored results.
    assert.equal(new Set(MODEL_CHECKS.map((c) => c.id)).size, MODEL_CHECKS.length);
  });

  test("the established failure modes each have a check", () => {
    // Every one of these traces to a real incident in
    // tests/MODEL-EVAL-FINDINGS.md or to a CLAUDE.md invariant. Losing one
    // silently is how a checklist becomes decorative.
    for (const id of ["reachable", "completion", "json", "streaming", "swedish", "citations", "injection", "latency"]) {
      assert.ok(checkById(id), id);
    }
    assert.equal(checkById("nonsense"), null);
  });

  test("the latency budget is a real number the sidebar can quote", () => {
    assert.ok(LATENCY_BUDGET_MS > 1000);
    assert.match(checkById("latency").why, new RegExp(`${Math.round(LATENCY_BUDGET_MS / 1000)}s`));
  });
});

describe("applicability", () => {
  test("vision is skipped for a text-only model, not failed", () => {
    // An inapplicable check must read as ABSENT. Rendering it as a failure
    // would say "this model is broken" about a model that simply is not a
    // vision model.
    const textOnly = checksFor({ vision: false }).map((c) => c.id);
    assert.ok(!textOnly.includes("vision"));
    assert.ok(checksFor({ vision: true }).map((c) => c.id).includes("vision"));
    assert.equal(checksFor({ vision: true }).length, checksFor({ vision: false }).length + 1);
  });
});

describe("the checklist", () => {
  const entry = { vision: false };

  test("with nothing stored, every box is untested — never failed", () => {
    const list = checklistFor(entry, null);
    assert.ok(list.length > 0);
    assert.ok(list.every((c) => c.state === "untested"), "all untested");
    assert.ok(list.every((c) => c.at === null && c.note === ""));
    assert.equal(checkSummary(list).label, "not verified yet");
    assert.equal(checkSummary(list).fail, 0);
  });

  test("stored results become pass/fail and carry their note and timestamp", () => {
    const list = checklistFor(entry, {
      reachable: { id: "reachable", pass: true, note: "answered in 420 ms", ms: 420, at: 1750000000000 },
      json: { id: "json", pass: false, note: "parse mode: failed", ms: 900, at: 1750000000000 },
    });
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    assert.equal(byId.reachable.state, "pass");
    assert.equal(byId.reachable.note, "answered in 420 ms");
    assert.equal(byId.reachable.at, 1750000000000);
    assert.equal(byId.json.state, "fail");
    assert.equal(byId.swedish.state, "untested");
  });

  test("the summary counts three bands and never reports a score", () => {
    // Deliberately not a percentage: a model with one failed check and eight
    // passes is not "89% good", it is a model with one known limitation, and
    // the sidebar names which.
    const list = checklistFor(entry, {
      reachable: { id: "reachable", pass: true, note: "", ms: 1, at: 1 },
      json: { id: "json", pass: false, note: "", ms: 1, at: 1 },
    });
    const s = checkSummary(list);
    assert.equal(s.pass, 1);
    assert.equal(s.fail, 1);
    assert.equal(s.untested, list.length - 2);
    assert.match(s.label, /1\/\d+ verified, 1 failing, \d+ untried/);
    assert.doesNotMatch(s.label, /%/);
  });
});

describe("running a check", () => {
  const fakeCheck = (impl) => ({ id: "fake", label: "Fake", why: "x", applies: () => true, run: impl });

  test("a thrown check becomes a recorded FAILURE, not an exception", () => {
    // Fail-soft (invariant 2): one dead check must not take down a run, and
    // "we tried and it broke" is exactly the thing the checklist should show.
    return runCheck({}, fakeCheck(async () => { throw new Error("HTTP 429: rate limited"); }), "m").then((r) => {
      assert.equal(r.pass, false);
      assert.match(r.note, /rate limited/);
      assert.equal(r.id, "fake");
      assert.ok(r.at > 0 && r.ms >= 0);
    });
  });

  test("a passing check records its note and duration", async () => {
    const r = await runCheck({}, fakeCheck(async () => ({ pass: true, note: "all good" })), "m");
    assert.equal(r.pass, true);
    assert.equal(r.note, "all good");
  });

  test("the timeout race leaves no live timer behind", async () => {
    // Regression: the raced timeout used to be left to expire, so a check that
    // finished in 3 ms still held the event loop for the full 45 s ceiling —
    // a hung test suite locally, and a Worker isolate held open per check in
    // production. Measured rather than asserted structurally: if the timer
    // leaks, this test file itself stops exiting promptly.
    const started = Date.now();
    await runCheck({}, fakeCheck(async () => ({ pass: true, note: "fast" })), "m");
    assert.ok(Date.now() - started < 1000, "the check itself is instant");
    // Node reports pending timers as handles; none should reference this race.
    const handles = /** @type {any} */ (process)._getActiveHandles?.() || [];
    const longTimers = handles.filter((h) => typeof h?._idleTimeout === "number" && h._idleTimeout > 10_000);
    assert.deepEqual(longTimers, [], "a >10s timer is still pending after the check resolved");
  });

  // The orchestration tests stub `fetch` so they exercise WHICH checks ran, in
  // what order, with what recorded — without touching a provider or waiting out
  // a real timeout. Every stubbed call refuses, so every check records a
  // failure, which is itself the fail-soft property worth seeing.
  const withDeadFetch = async (/** @type {() => Promise<void>} */ body) => {
    const real = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("connection refused"); };
    try {
      await body();
    } finally {
      globalThis.fetch = real;
    }
  };
  const ENV = { BERGET_API_TOKEN: "x" };

  test("runChecks honours `only`, and an unknown id simply runs nothing", async () => {
    await withDeadFetch(async () => {
      const entry = { vision: false };
      const some = await runChecks(ENV, "m", entry, { only: ["json", "streaming"] });
      assert.deepEqual(some.map((r) => r.id), ["json", "streaming"]);
      // …and every one of them is a recorded failure rather than a throw.
      assert.ok(some.every((r) => r.pass === false && r.note));
      const none = await runChecks(ENV, "m", entry, { only: ["not-a-check"] });
      assert.deepEqual(none, []);
    });
  });

  test("checks run in registry order, so the checklist fills predictably", async () => {
    await withDeadFetch(async () => {
      const all = await runChecks(ENV, "m", { vision: true });
      assert.deepEqual(all.map((r) => r.id), MODEL_CHECKS.map((c) => c.id));
    });
  });

  test("onResult fires per check, so the UI can show progress rather than a spinner", async () => {
    await withDeadFetch(async () => {
      /** @type {string[]} */
      const seen = [];
      await runChecks(ENV, "m", { vision: false }, { only: ["json", "streaming"], onResult: (r) => seen.push(r.id) });
      assert.deepEqual(seen, ["json", "streaming"]);
    });
  });
});
