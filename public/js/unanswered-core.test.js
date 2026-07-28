// Node tests for unanswered-core.js — what happens to a question whose send
// produced no answer. The regression suite for feedback #45: the question must
// survive in the conversation so a "Try again" has something to point at.
import { test } from "node:test";
import assert from "node:assert/strict";

import { isUnansweredMarker, markUnanswered, unansweredMarker } from "./unanswered-core.js";

test("unansweredMarker: one bracketed line per cause", () => {
  assert.equal(unansweredMarker("empty"), "[The question above went unanswered — no answer was produced.]");
  assert.match(unansweredMarker("failed"), /the request failed before any answer arrived/);
  assert.match(unansweredMarker("dropped"), /the connection dropped before any answer arrived/);
  assert.match(unansweredMarker("stopped"), /it was stopped before any answer arrived/);
  // An unknown reason still produces a usable marker rather than "undefined".
  assert.equal(unansweredMarker("nonsense"), unansweredMarker("failed"));
  assert.equal(unansweredMarker(undefined), unansweredMarker("failed"));
});

// The regression this module exists for. Feedback #45: a question sent from a
// phone never reached the server, the client reverted it out of the history,
// and the user — still looking at their question on screen — typed "Try
// again", only to be told the question "never reached this conversation".
test("markUnanswered: the question SURVIVES a send that produced nothing (feedback #45)", () => {
  const history = [{ role: "user", content: "How does the quota window work?" }];
  assert.equal(markUnanswered(history, "dropped"), true);
  assert.equal(history.length, 2);
  // The question is still there — that is the whole point.
  assert.deepEqual(history[0], { role: "user", content: "How does the quota window work?" });
  assert.equal(history[1].role, "assistant");
  assert.match(String(history[1].content), /went unanswered/);
});

test("markUnanswered: a retry after it carries the original question", () => {
  const history = [{ role: "user", content: "How does the quota window work?" }];
  markUnanswered(history, "dropped");
  history.push({ role: "user", content: "Try again" });
  const users = history.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(users, ["How does the quota window work?", "Try again"]);
  // Roles alternate strictly, so no provider has to merge same-role turns.
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user"]);
});

test("markUnanswered: never appends after an answer, or twice", () => {
  const answered = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ];
  assert.equal(markUnanswered(answered, "empty"), false);
  assert.equal(answered.length, 2);

  // Double-settling one send must not stack markers.
  const history = [{ role: "user", content: "q" }];
  assert.equal(markUnanswered(history, "failed"), true);
  assert.equal(markUnanswered(history, "failed"), false);
  assert.equal(history.length, 2);
});

test("markUnanswered: empty and malformed histories are a no-op", () => {
  assert.equal(markUnanswered([], "empty"), false);
  assert.equal(markUnanswered(null, "empty"), false);
  assert.equal(markUnanswered(undefined, "empty"), false);
});

test("isUnansweredMarker: recognises our markers, not model prose", () => {
  for (const r of ["empty", "failed", "dropped", "stopped"]) {
    assert.equal(isUnansweredMarker(unansweredMarker(r)), true, r);
  }
  assert.equal(isUnansweredMarker("  " + unansweredMarker("empty") + "\n"), true);
  assert.equal(isUnansweredMarker("The question above went unanswered."), false);
  assert.equal(isUnansweredMarker("[This answer was cut off by a connection error.]"), false);
  assert.equal(isUnansweredMarker(""), false);
  assert.equal(isUnansweredMarker(null), false);
});
