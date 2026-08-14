// Unit tests for the answer-recovery cache's pure projection (src/answers.js).
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
      trail: [],
    });
  });

  test("the research trail comes back so a recovered answer stays explorable", () => {
    // Feedback #67: a recovered run replayed text + stats only, so its whole
    // research trail was missing and the steps could not be explored.
    const trail = [
      { type: "search_start", round: 1, query: "a", source: "web" },
      { type: "search_done", round: 1, query: "a", source: "web", results: 3 },
    ];
    const out = projectAnswer(
      { status: "done", ts: 5, text: "hi", stats_json: null, trail_json: JSON.stringify(trail) },
      10,
    );
    assert.deepEqual(out.trail, trail);
  });

  test("a row written before the trail column reads back as no trail, not a throw", () => {
    // Every deployed row predates the column and returns NULL for it.
    assert.deepEqual(projectAnswer({ status: "done", ts: 5, text: "hi", stats_json: null }, 10).trail, []);
  });

  test("a malformed or non-array trail degrades to none, keeping the answer", () => {
    for (const trail_json of ["{bad", '"a string"', "42", "null", '{"not":"an array"}']) {
      const out = projectAnswer({ status: "done", ts: 5, text: "hi", stats_json: null, trail_json }, 10);
      assert.equal(out.text, "hi", trail_json);
      assert.deepEqual(out.trail, [], trail_json);
    }
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
