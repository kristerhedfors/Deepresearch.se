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
  noteTexts,
  parseTryId,
  partitionActions,
  stripTryParam,
  targetPath,
  useCaseTag,
  parseUseCaseRef,
  tagStarterPrompt,
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

test("targetPath normalizes a target to its pathname", () => {
  assert.equal(targetPath("/cure"), "/cure");
  assert.equal(targetPath("/rver?x=1"), "/rver");
  assert.equal(targetPath("/admin#panel"), "/admin");
  assert.equal(targetPath("/cure", "https://deepresearch.se"), "/cure");
  // Same-page comparison works for the queue's cross-page decision.
  assert.equal(targetPath("/rver?try=3", "https://x.test") === "/rver", true);
});

test("noteTexts extracts note-action guidance, trimmed, in order", () => {
  assert.deepEqual(
    noteTexts([
      { type: "note", text: "  First read this. " },
      { type: "compose", text: "not a note" },
      { type: "note", text: "Then check that." },
      { type: "note", text: "   " }, // blank → dropped
      { type: "note" }, // no text → dropped
      null,
    ]),
    ["First read this.", "Then check that."],
  );
  assert.deepEqual(noteTexts([]), []);
  assert.deepEqual(noteTexts("bad"), []);
});

test("nextOpenPoint picks the oldest open point, skipping the just-done id", () => {
  const queue = [
    { id: 9, status: "open" },
    { id: 3, status: "open" },
    { id: 5, status: "passed" },
    { id: 2, status: "untestable" }, // with the loop, awaiting an answer — not on the queue
    { id: 7, status: "open" },
  ];
  assert.equal(nextOpenPoint(queue).id, 3); // oldest open
  assert.equal(nextOpenPoint(queue, 3).id, 7); // skip 3 → next oldest open
  assert.equal(nextOpenPoint([{ id: 1, status: "passed" }]), null);
  assert.equal(nextOpenPoint([]), null);
  assert.equal(nextOpenPoint(null), null);
});

// Use-case identity — mirror of src/testpoints.js (keep in lockstep).
test("useCaseTag renders #UC-<id>", () => {
  assert.equal(useCaseTag(34), "#UC-34");
  assert.equal(useCaseTag("7"), "#UC-7");
});

test("parseUseCaseRef mirrors the server: EN + SV, every accepted shape", () => {
  assert.deepEqual(parseUseCaseRef("feedback #UC-34 the map was cut off"), { id: 34, tag: "#UC-34" });
  assert.deepEqual(parseUseCaseRef("feedback UC 34 note"), { id: 34, tag: "#UC-34" });
  assert.deepEqual(parseUseCaseRef("feedback #34 note"), { id: 34, tag: "#UC-34" });
  assert.deepEqual(parseUseCaseRef("återkoppling #UC-7 kartan"), { id: 7, tag: "#UC-7" });
  assert.deepEqual(parseUseCaseRef("synpunkt #7 här"), { id: 7, tag: "#UC-7" });
  assert.equal(parseUseCaseRef("feedback no number here"), null);
  assert.equal(parseUseCaseRef("feedback #0 nope"), null);
  assert.equal(parseUseCaseRef(""), null);
});

test("tagStarterPrompt prepends the tag once, never doubling", () => {
  assert.equal(tagStarterPrompt(34, "Research quantum computing"), "#UC-34 Research quantum computing");
  assert.equal(tagStarterPrompt(34, ""), "#UC-34");
  // Already opens with its own tag → left as-is.
  assert.equal(tagStarterPrompt(34, "#UC-34 already tagged"), "#UC-34 already tagged");
  // A DIFFERENT tag in the text is not the point's own → still prepends.
  assert.equal(tagStarterPrompt(34, "#UC-9 other"), "#UC-34 #UC-9 other");
});
