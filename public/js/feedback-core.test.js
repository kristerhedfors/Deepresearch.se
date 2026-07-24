// Unit tests for the shared feedback intent gate (public/js/feedback-core.js) —
// the single source of truth both tiers use. EN + SV parity (invariant 6).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FEEDBACK_ACKS,
  FEEDBACK_PATTERNS,
  cannedFeedbackAck,
  feedbackIntent,
  feedbackLangSv,
} from "./feedback-core.js";
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

// ---------------------------------------------------------------------------
// Canned acknowledgments — deterministic, no model call (owner directive,
// 2026-07-24). EN + SV parity (invariant 6).
// ---------------------------------------------------------------------------

test("FEEDBACK_ACKS: same number of EN and SV variants, several of each, all mention the account panel", () => {
  assert.equal(FEEDBACK_ACKS.en.length, FEEDBACK_ACKS.sv.length);
  assert.equal(FEEDBACK_ACKS.en.length >= 3, true);
  for (const v of FEEDBACK_ACKS.en) assert.match(v, /Feedback.*account panel/);
  for (const v of FEEDBACK_ACKS.sv) assert.match(v, /Feedback.*kontopanel/);
});

test("cannedFeedbackAck: English feedback → an English canned variant, deterministically", () => {
  const comment = "feedback: the map view was cut off";
  const ack = cannedFeedbackAck(comment);
  assert.equal(FEEDBACK_ACKS.en.includes(ack), true);
  assert.equal(cannedFeedbackAck(comment), ack); // same message, same reply
});

test("cannedFeedbackAck: Swedish feedback → a Swedish canned variant (parity)", () => {
  for (const comment of [
    "återkoppling: sökningen är långsam",
    "feedback: kartan laddar inte",
    "synpunkt: lägg till mörkt tema",
    "Feedback — knappen fungerar inte på mobilen",
  ]) {
    const ack = cannedFeedbackAck(comment);
    assert.equal(FEEDBACK_ACKS.sv.includes(ack), true, comment);
  }
});

test("feedbackLangSv: English (and junk input) stays English", () => {
  assert.equal(feedbackLangSv("feedback: the PDF export is broken"), false);
  assert.equal(feedbackLangSv("feedback please add dark mode"), false);
  assert.equal(feedbackLangSv(null), false);
  assert.equal(feedbackLangSv(42), false);
});

test("cannedFeedbackAck: a use-case reference gets a language-matched confirmation tail", () => {
  const en = cannedFeedbackAck("feedback #UC-34 the map was cut off", { useCaseTag: "#UC-34" });
  assert.match(en, /recorded against use case #UC-34\.$/);
  const sv = cannedFeedbackAck("feedback #UC-34 kartan är avklippt", { useCaseTag: "#UC-34" });
  assert.match(sv, /registrerats mot användningsfall #UC-34\.$/);
});

test("cannedFeedbackAck: non-string input never throws, returns a canned English reply", () => {
  assert.equal(FEEDBACK_ACKS.en.includes(cannedFeedbackAck(null)), true);
  assert.equal(FEEDBACK_ACKS.en.includes(cannedFeedbackAck(undefined)), true);
});
