// The Orchestrator executor's fail-soft seams (src/orchestrator.js).
//
// Everything the executor does end to end needs a real provider, Exa and D1 —
// that half is verified live (the live-verify discipline) and the plan/wave/
// prompt logic is pinned in public/js/orchestrator-core.test.js. What is
// testable here is the part that was MISSING until 2026-07-26 and that user
// feedback #26 ("two crashes in orchestrator… do you catch these?") was about:
// what a run remembers about a node that died, and what it lets go of.
//
// Forensic context for the shape of these tests: on the live site, the two
// reported crashes left NO chat_logs row, NO server_errors row and no
// `status="error"` anywhere — a failed sub-agent produced one `ctx.log.warn`
// into Workers Logs and a bare `failed: N` counter. These pin the record that
// now survives instead.

import test from "node:test";
import assert from "node:assert/strict";

import { MAX_LOGGED_FAILURES, nodeFailureRecord, nodeTextSink, pushFailure, withTimeout } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// nodeFailureRecord — "which sub-agent died, where, how"
// ---------------------------------------------------------------------------

test("nodeFailureRecord names the node, the wave (1-based) and the failure class", () => {
  const rec = nodeFailureRecord(
    { id: "market-scan", kind: "web_research" },
    1, // 0-based index → the SECOND wave
    new Error("Berget API error (500): upstream unavailable"),
    12_345,
  );
  assert.deepEqual(rec, {
    id: "market-scan",
    kind: "web_research",
    wave: 2,
    class: "upstream",
    ms: 12345,
    note: "Berget API error (500): upstream unavailable",
  });
});

test("nodeFailureRecord trusts the caller's deadline flag over the message", () => {
  // withTimeout's own rejection reads "timed out after 150s", but a node
  // cancelled by that deadline may reject with the provider's message instead
  // (it lost the race but still failed) — the token is what actually knows.
  const rec = nodeFailureRecord({ id: "a", kind: "custom" }, 0, new Error("socket hang up"), 150_000, { timedOut: true });
  assert.equal(rec.class, "timeout");
  assert.equal(rec.wave, 1);
});

test("nodeFailureRecord is total and bounded — a chat_logs field cannot grow with the failure", () => {
  const rec = nodeFailureRecord({}, 0, { message: "x".repeat(5000) }, Number.NaN);
  assert.equal(rec.id, "?");
  assert.equal(rec.kind, "?");
  assert.equal(rec.ms, 0, "a NaN duration is 0, never NaN in the log row");
  assert.equal(rec.note.length, 200);
  // Multi-line provider blobs collapse to one line so the text render stays readable.
  assert.equal(nodeFailureRecord({}, 0, new Error("a\n\n  b"), 1).note, "a b");
  assert.deepEqual(Object.keys(nodeFailureRecord({}, 0, null, 0)).sort(), ["class", "id", "kind", "ms", "note", "wave"]);
});

// ---------------------------------------------------------------------------
// pushFailure — the log field's ceiling
// ---------------------------------------------------------------------------

test("pushFailure caps what the chat log carries", () => {
  const list = [];
  for (let i = 0; i < MAX_LOGGED_FAILURES + 25; i++) pushFailure(list, { id: `a${i}` });
  assert.equal(list.length, MAX_LOGGED_FAILURES);
  assert.equal(list[0].id, "a0", "the FIRST failures are the ones worth keeping — they caused the rest");
  assert.ok(MAX_LOGGED_FAILURES > 6, "must not bind below the MAX_AGENTS ceiling on an ordinary run");
});

// ---------------------------------------------------------------------------
// withTimeout — the bound, and the cancellation hook that stops the growth
// ---------------------------------------------------------------------------

test("withTimeout resolves untouched when the work beats the deadline", async () => {
  let cancelled = false;
  const value = await withTimeout(Promise.resolve("brief"), 1000, () => { cancelled = true; });
  assert.equal(value, "brief");
  assert.equal(cancelled, false, "a node that finished must never be told it was cancelled");
});

test("withTimeout rejects at the deadline and fires the cancel hook first", async () => {
  const order = [];
  const never = new Promise(() => {});
  await assert.rejects(
    withTimeout(never, 10, () => order.push("cancel")),
    /timed out after 0s/,
  );
  order.push("reject");
  assert.deepEqual(order, ["cancel", "reject"], "the hook must run BEFORE the caller starts cleaning up");
});

test("withTimeout survives a cancel hook that itself throws", async () => {
  // The hook is caller code on an already-failing path; it must not be able to
  // replace the timeout with a different, more confusing error.
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, () => { throw new Error("hook exploded"); }),
    /timed out after 0s/,
  );
});

test("withTimeout leaves a LATE rejection handled — an unhandled one kills the isolate", async () => {
  // The abandoned node keeps running after its deadline and may reject much
  // later. Promise.race stays subscribed to it, so that rejection is consumed.
  // Regression guard: any refactor that stops racing the original promise
  // (e.g. racing a detached copy) reintroduces an unhandled rejection, which
  // in a Worker is not a soft failure.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    let boom;
    const late = new Promise((_, reject) => { boom = reject; });
    await assert.rejects(withTimeout(late, 5), /timed out/);
    boom(new Error("late provider failure"));
    // Two macrotask turns is enough for Node to report an unhandled rejection.
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---------------------------------------------------------------------------
// nodeTextSink — the abandoned node's memory bound
// ---------------------------------------------------------------------------

test("nodeTextSink accumulates a running node's tokens", () => {
  const sink = nodeTextSink({ cancelled: false });
  sink.push("Findings");
  sink.push(": three sources agree.");
  assert.equal(sink.text(), "Findings: three sources agree.");
});

test("nodeTextSink lets go the moment its node is cancelled", () => {
  // The user-visible bug this bounds: a wave-1 node times out at 150s, the run
  // moves to wave 2 and 3, and the abandoned provider stream keeps appending
  // into a buffer nothing will ever read — for the rest of the request.
  const token = { cancelled: false };
  const sink = nodeTextSink(token);
  sink.push("x".repeat(100_000));
  token.cancelled = true;
  sink.push("y".repeat(100_000));
  assert.equal(sink.text(), "", "an abandoned node contributes nothing to the merge");
  for (let i = 0; i < 1000; i++) sink.push("z".repeat(1000));
  assert.equal(sink.text(), "", "…and never starts growing again");
});

test("nodeTextSink's discard is the stall-retry reset, NOT a cancellation", () => {
  // streamCompletion's early-stall retry throws away a false start and streams
  // again; the node is still very much alive.
  const token = { cancelled: false };
  const sink = nodeTextSink(token);
  sink.push("false start");
  sink.discard();
  sink.push("the real brief");
  assert.equal(sink.text(), "the real brief");
});

test("nodeTextSink is total over junk deltas", () => {
  const sink = nodeTextSink({ cancelled: false });
  sink.push(/** @type {any} */ (undefined));
  sink.push(/** @type {any} */ (null));
  sink.push("ok");
  assert.equal(sink.text(), "ok");
});

test("withTimeout clears its timer, so a finished node holds nothing open", async () => {
  // A timer left armed keeps the isolate alive (and its closure reachable) for
  // the full node budget after the node is done — 150s × 6 nodes of retention
  // for work that finished in a second.
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await withTimeout(Promise.resolve(1), 60_000);
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before, `timer still armed (${before} → ${after})`);
});
