// Unit tests for the shared feedback intent gate (public/js/feedback-core.js) —
// the single source of truth both tiers use. EN + SV parity (invariant 6).
import { test } from "node:test";
import assert from "node:assert/strict";

import { FEEDBACK_PATTERNS, feedbackIntent } from "./feedback-core.js";
import { bashIntent } from "./bash-core.js";

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

// Feedback #18: with the bash-lite knob on, the sandbox pre-pass (stream.js
// maybeRunShellLoop) runs for EVERY send — the MODEL decides whether commands
// are needed, and a feedback text that talks about Linux commands lures it
// into proposing some. The pre-pass therefore hard-skips on feedbackIntent
// before anything else (the same hard-left the server pipeline and Se/cure
// already take). The verbatim reported message pins the gate's verdict.
test("feedbackIntent catches the verbatim sandbox-feedback message (feedback #18)", () => {
  const verbatim =
    'feedback also! often a bunch of Linux commands run when I start my message with "feedback" ! ' +
    "seems like misaligned pipeline? if it is feedback then take a hard-left to feedback so to speak, " +
    "don't do all the other stuff.";
  assert.equal(feedbackIntent(verbatim), true);
  // Note the bash heuristic does NOT even match this text — the commands came
  // from the model-decides pre-pass, which is why the skip must sit at the
  // top of maybeRunShellLoop rather than inside a bashIntent branch.
  assert.equal(bashIntent(verbatim), false);
  // Swedish parity: the same shape of report in Swedish routes the same way.
  const sv = "återkoppling: massa Linux-kommandon körs när jag skriver feedback";
  assert.equal(feedbackIntent(sv), true);
});
