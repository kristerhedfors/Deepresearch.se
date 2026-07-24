// Unit tests for the shared feedback intent gate (public/js/feedback-core.js) —
// the single source of truth both tiers use. EN + SV parity (invariant 6).
import { test } from "node:test";
import assert from "node:assert/strict";

import { FEEDBACK_PATTERNS, feedbackIntent } from "./feedback-core.js";

test("feedbackIntent: a message opening with 'feedback' (any case) triggers", () => {
  assert.equal(feedbackIntent("feedback: the map view was cut off"), true);
  assert.equal(feedbackIntent("Feedback - please add a dark theme"), true);
  assert.equal(feedbackIntent("FEEDBACK the PDF export is broken"), true);
  assert.equal(feedbackIntent("  feedback"), true); // leading whitespace, bare word
  assert.equal(feedbackIntent("feedback."), true);
});

test("feedbackIntent: Swedish forms trigger with the same breadth (parity)", () => {
  assert.equal(feedbackIntent("Feedback: kartan var avklippt"), true);
  assert.equal(feedbackIntent("återkoppling: sökningen är långsam"), true);
  assert.equal(feedbackIntent("Återkopplingen: knappen fungerar inte"), true);
  assert.equal(feedbackIntent("synpunkt: lägg till mörkt tema"), true);
  assert.equal(feedbackIntent("Synpunkter på gränssnittet"), true);
});

test("feedbackIntent: an ordinary question is NOT feedback", () => {
  assert.equal(feedbackIntent("What is the capital of France?"), false);
  assert.equal(feedbackIntent("Explain how transformers work"), false);
  assert.equal(feedbackIntent("Ge mig en sammanfattning av rapporten"), false);
  assert.equal(feedbackIntent("The feedback loop in the pipeline is slow"), false); // mid-sentence
});

test("feedbackIntent: 'feedback loop(s)' is the excluded collision", () => {
  assert.equal(feedbackIntent("feedback loop design for a controller"), false);
  assert.equal(feedbackIntent("Feedback loops in reinforcement learning"), false);
  // but "feedback" followed by anything else still routes
  assert.equal(feedbackIntent("feedback looping is a great feature idea"), true);
});

test("feedbackIntent: non-string input never throws, returns false", () => {
  assert.equal(feedbackIntent(null), false);
  assert.equal(feedbackIntent(undefined), false);
  assert.equal(feedbackIntent(42), false);
  assert.equal(feedbackIntent({}), false);
});

test("FEEDBACK_PATTERNS is the shared array (three forms: EN/SV loanword + 2 SV natives)", () => {
  assert.equal(FEEDBACK_PATTERNS.length, 3);
});
