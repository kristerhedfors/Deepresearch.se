import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { projectAnswer, RUNNING_STALE_MS } from "./answers.js";

// The D1 read/write paths are verified live; the running/lost/done decision
// is pure and is what stops the client spinning on a dead run, so it's tested.
describe("projectAnswer", () => {
  test("missing row → null (404 upstream)", () => {
    assert.equal(projectAnswer(null, 1000), null);
    assert.equal(projectAnswer(undefined, 1000), null);
  });

  test("running with a fresh heartbeat → running", () => {
    const now = 1_000_000;
    assert.deepEqual(projectAnswer({ status: "running", ts: now - 1000 }, now), { status: "running" });
    assert.deepEqual(projectAnswer({ status: "running", ts: now - (RUNNING_STALE_MS - 1) }, now), { status: "running" });
  });

  test("running with a stale heartbeat → lost (server run died)", () => {
    const now = 1_000_000;
    assert.deepEqual(projectAnswer({ status: "running", ts: now - (RUNNING_STALE_MS + 1) }, now), { status: "lost" });
  });

  test("done returns the text and parsed stats", () => {
    const out = projectAnswer(
      { status: "done", ts: 5, text: "the answer", stats_json: JSON.stringify({ model: "m", rounds: 2 }) },
      10,
    );
    assert.equal(out.status, "done");
    assert.equal(out.text, "the answer");
    assert.deepEqual(out.stats, { model: "m", rounds: 2 });
  });

  test("done with no/blank text still projects done (client treats empty as failed)", () => {
    assert.deepEqual(projectAnswer({ status: "done", ts: 5, text: "", stats_json: null }, 10), {
      status: "done",
      text: "",
      stats: null,
    });
  });

  test("done with malformed stats_json degrades stats to null, keeps the text", () => {
    const out = projectAnswer({ status: "done", ts: 5, text: "hi", stats_json: "{bad" }, 10);
    assert.equal(out.text, "hi");
    assert.equal(out.stats, null);
  });

  test("a done row is never treated as lost regardless of age", () => {
    const now = 10_000_000;
    const out = projectAnswer({ status: "done", ts: 0, text: "old but done", stats_json: null }, now);
    assert.equal(out.status, "done");
  });
});
