// Unit tests for turns.js's pure exports. The DOM rendering itself is verified
// live (this repo keeps zero test deps — no jsdom), but the reopened-chat
// feedback-cue predicate and its copy are pure and locked here.
import { test } from "node:test";
import assert from "node:assert/strict";

import { EMPTY_TEXT, FEEDBACK_HINT_TEXT, shouldShowFeedbackHint } from "./turns.js";

test("shouldShowFeedbackHint: a reopened conversation with an answered turn shows the cue", () => {
  const messages = [
    { role: "user", content: "Tell me about Northvolt" },
    { role: "assistant", content: "Northvolt is a Swedish battery maker …" },
  ];
  assert.equal(shouldShowFeedbackHint(messages), true);
});

test("shouldShowFeedbackHint: an empty or user-only record shows nothing", () => {
  assert.equal(shouldShowFeedbackHint([]), false);
  assert.equal(shouldShowFeedbackHint([{ role: "user", content: "hi" }]), false);
});

test("shouldShowFeedbackHint: non-array input is safe", () => {
  assert.equal(shouldShowFeedbackHint(null), false);
  assert.equal(shouldShowFeedbackHint(undefined), false);
  assert.equal(shouldShowFeedbackHint("not an array"), false);
});

test("both hints name the 'feedback' keyword so the how-to stays discoverable", () => {
  // The empty-state hint and the reopened-chat cue must both point at the same
  // deterministic gate word (src/feedback.js feedbackIntent).
  assert.match(EMPTY_TEXT, /feedback/i);
  assert.match(FEEDBACK_HINT_TEXT, /feedback/i);
});
