// Unit tests for the test-point client pure core
// (public/js/testpoints-core.js): deep-link parsing/building, action
// partitioning against the client's grammar, and next-in-queue selection.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_ACTION_TYPES,
  TRY_PARAM,
  deepLink,
  nextOpenPoint,
  parseTryId,
  partitionActions,
  stripTryParam,
} from "./testpoints-core.js";

test("parseTryId reads a positive integer, else null", () => {
  assert.equal(parseTryId("?try=5"), 5);
  assert.equal(parseTryId("try=5&x=1"), 5);
  assert.equal(parseTryId("?x=1"), null);
  assert.equal(parseTryId("?try=0"), null);
  assert.equal(parseTryId("?try=-2"), null);
  assert.equal(parseTryId("?try=abc"), null);
  assert.equal(parseTryId(""), null);
  assert.equal(parseTryId(null), null);
  assert.equal(TRY_PARAM, "try");
});

test("stripTryParam removes only the try param", () => {
  assert.equal(stripTryParam("https://x.test/rver?try=5"), "https://x.test/rver");
  assert.equal(stripTryParam("https://x.test/rver?a=1&try=5&b=2"), "https://x.test/rver?a=1&b=2");
  assert.equal(stripTryParam("https://x.test/rver#h"), "https://x.test/rver#h");
  // Non-URL input is returned as-is.
  assert.equal(stripTryParam("not a url"), "not a url");
});

test("deepLink merges ?try= and preserves query/hash", () => {
  assert.equal(deepLink("/rver", 7), "/rver?try=7");
  assert.equal(deepLink("/rver?x=1", 7), "/rver?x=1&try=7");
  assert.equal(deepLink("/rver#s", 7), "/rver?try=7#s");
});

test("partitionActions splits known vs unknown by the client grammar", () => {
  const { known, unknown } = partitionActions([
    { type: "newChat" },
    { type: "compose", text: "x" },
    { type: "teleport" }, // not in the grammar this build knows
    null,
    "nope",
  ]);
  assert.equal(known.length, 2);
  assert.equal(unknown.length, 3);
  assert.deepEqual(partitionActions("bad"), { known: [], unknown: [] });
  // Every advertised client type is recognised as known.
  for (const t of CLIENT_ACTION_TYPES) {
    assert.equal(partitionActions([{ type: t }]).known.length, 1);
  }
});

test("nextOpenPoint picks the oldest open point, skipping the just-done id", () => {
  const queue = [
    { id: 9, status: "open" },
    { id: 3, status: "open" },
    { id: 5, status: "passed" },
    { id: 7, status: "open" },
  ];
  assert.equal(nextOpenPoint(queue).id, 3); // oldest open
  assert.equal(nextOpenPoint(queue, 3).id, 7); // skip 3 → next oldest open
  assert.equal(nextOpenPoint([{ id: 1, status: "passed" }]), null);
  assert.equal(nextOpenPoint([]), null);
  assert.equal(nextOpenPoint(null), null);
});
