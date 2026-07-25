// Unit tests for the shared feedback intent gate (public/js/feedback-core.js) —
// the single source of truth both tiers use. EN + SV parity (invariant 6).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FEEDBACK_ACKS,
  FEEDBACK_ACKS_STANDALONE,
  FEEDBACK_PATTERNS,
  cannedFeedbackAck,
  feedbackForcesServerRoute,
  feedbackIntent,
  feedbackLangSv,
  feedbackPageTag,
  feedbackScope,
  feedbackScopeOfPrior,
  isStandalonePage,
  FEEDBACK_ACKS_STRATEGY,
  STRATEGY_PAGE_SUFFIX,
  isStrategyPage,
  scopeOfPage,
  strategyPageTag,
  DOC_PAGE_SUFFIX,
  FEEDBACK_ACKS_DOC,
  docPageTag,
  docPathOfPage,
  isDocPage,
} from "./feedback-core.js";
import { bashIntent } from "./bash-core.js";
import { onDeviceIdFromValue } from "./ondevice-core.js";

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
// Feedback #23 — the browser-direct routes. The Se/rver tier has two send
// routes that settle entirely in the browser and never call /api/chat: an
// on-device model pick (the "ondevice::" Bonsai group) and introspection's
// private own-key route. Both are checked at the very top of stream.js
// sendMessage, before any pipeline gate can run, so a "feedback …" message
// was answered by the locally selected model and no feedback entry was ever
// created — the reported case came back as 1.7B filler.
//
// feedbackForcesServerRoute is what both branches now consult, so the rule
// lives with the gate rather than inside one branch.
// ---------------------------------------------------------------------------

test("feedbackForcesServerRoute: a feedback report never takes a browser-direct route (feedback #23)", () => {
  const verbatim = "feedback the first message here missed the feedback pipeline and instead got a reply from the llm";
  assert.equal(feedbackForcesServerRoute(verbatim), true);
  // The message that actually went missing — sent while a Bonsai model was
  // picked, so the on-device branch claimed it.
  assert.equal(
    feedbackForcesServerRoute("feedback last chat crashed when running bonsai, did you catch that with logs?"),
    true,
  );
});

test("feedbackForcesServerRoute: agrees with feedbackIntent on every form, EN + SV (parity)", () => {
  const forced = [
    "feedback: the map view was cut off",
    "Feedback - please add a dark theme",
    "återkoppling: sökningen är långsam",
    "Återkopplingen: knappen fungerar inte",
    "synpunkt: lägg till mörkt tema",
    "Synpunkter på gränssnittet",
  ];
  for (const t of forced) assert.equal(feedbackForcesServerRoute(t), true, t);
});

test("feedbackForcesServerRoute: an ordinary question keeps its browser-direct route", () => {
  // The whole point of picking an on-device model is that research stays on
  // the device — so anything that is NOT feedback must be left alone, the
  // "feedback loop(s)" collision included.
  const free = [
    "What is the capital of France?",
    "Ge mig en sammanfattning av rapporten",
    "feedback loop design for a controller",
    "Feedback loops in reinforcement learning",
    "The feedback loop in the pipeline is slow",
  ];
  for (const t of free) assert.equal(feedbackForcesServerRoute(t), false, t);
});

test("feedbackForcesServerRoute: non-string input never throws, returns false", () => {
  assert.equal(feedbackForcesServerRoute(null), false);
  assert.equal(feedbackForcesServerRoute(undefined), false);
  assert.equal(feedbackForcesServerRoute(42), false);
});

// The other half of the #23 fix: an on-device model id is not in the server
// catalog (validation.js resolveModel → 400 "Unknown model."), so routing the
// report to the server also has to drop the pick. These two pure helpers are
// what stream.js composes to decide that — pinned together so the pairing
// can't drift apart.
test("an on-device pick is recognised as one, so a forced server route can strip it (feedback #23)", () => {
  assert.equal(onDeviceIdFromValue("ondevice::bonsai-1_7b-1bit"), "bonsai-1_7b-1bit");
  assert.equal(onDeviceIdFromValue(""), null);
  // A normal catalog model is not an on-device pick — nothing to strip, and
  // the server send keeps the user's model.
  assert.equal(onDeviceIdFromValue("claude-sonnet-5"), null);
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

// ---------------------------------------------------------------------------
// SCOPE classification (owner directive, 2026-07-24): a "feedback …" message
// that is the ABSOLUTE FIRST message of a conversation is generic developer
// feedback — a feature suggestion, next steps — NOT feedback about the
// (empty) session it arrived in. Both tiers classify with these functions.
// ---------------------------------------------------------------------------

test("feedbackScope: the first message of a conversation is STANDALONE", () => {
  assert.equal(feedbackScope([{ role: "user", content: "feedback: please add a dark theme" }]), "standalone");
  // Swedish parity — the classification is language-independent by construction.
  assert.equal(feedbackScope([{ role: "user", content: "synpunkt: lägg till mörkt tema" }]), "standalone");
});

test("feedbackScope: feedback arriving mid-conversation is SESSION scope", () => {
  assert.equal(
    feedbackScope([
      { role: "user", content: "Tell me about Northvolt" },
      { role: "assistant", content: "Northvolt is …" },
      { role: "user", content: "feedback: that answer was outdated" },
    ]),
    "session",
  );
  // A single prior turn is enough — even with no answer yet, the note follows
  // something the user asked.
  assert.equal(
    feedbackScope([
      { role: "user", content: "Tell me about Northvolt" },
      { role: "user", content: "feedback: still waiting" },
    ]),
    "session",
  );
});

test("feedbackScope: only user/assistant turns count as a session, junk never throws", () => {
  // A context block injected under some other role is not a conversation the
  // user had — a first-message note stays standalone.
  assert.equal(
    feedbackScope([
      { role: "system", content: "project context…" },
      { role: "user", content: "feedback: love the site" },
    ]),
    "standalone",
  );
  assert.equal(feedbackScope([]), "standalone");
  assert.equal(feedbackScope(null), "standalone");
  assert.equal(feedbackScope("junk"), "standalone");
  assert.equal(feedbackScope([null, undefined]), "standalone");
});

test("feedbackScopeOfPrior: Se/cure's shape (feedback text never enters the conversation)", () => {
  // Se/cure keeps the feedback message out of conv.messages, so the messages
  // ARE the prior turns: empty conversation → standalone, any turn → session.
  assert.equal(feedbackScopeOfPrior([]), "standalone");
  assert.equal(feedbackScopeOfPrior(undefined), "standalone");
  assert.equal(feedbackScopeOfPrior([{ role: "user", content: "hi" }]), "session");
  assert.equal(feedbackScopeOfPrior([{ role: "assistant", content: "an answer" }]), "session");
});

test("feedbackPageTag / isStandalonePage: the scope rides the entry's page column", () => {
  assert.equal(feedbackPageTag("chat", "session"), "chat");
  assert.equal(feedbackPageTag("chat", "standalone"), "chat/standalone");
  assert.equal(feedbackPageTag("se/cure", "standalone"), "se/cure/standalone");
  assert.equal(feedbackPageTag("se/cure", "session"), "se/cure");
  // Junk surface falls back to "chat" rather than producing an untagged entry.
  assert.equal(feedbackPageTag(null, "standalone"), "chat/standalone");
  assert.equal(isStandalonePage("chat/standalone"), true);
  assert.equal(isStandalonePage("se/cure/standalone"), true);
  assert.equal(isStandalonePage("chat"), false);
  assert.equal(isStandalonePage("usecase #UC-34"), false);
  assert.equal(isStandalonePage(null), false);
});

test("FEEDBACK_ACKS_STANDALONE: EN/SV parity, and NO promise of a conversation", () => {
  assert.equal(FEEDBACK_ACKS_STANDALONE.en.length, FEEDBACK_ACKS_STANDALONE.sv.length);
  assert.equal(FEEDBACK_ACKS_STANDALONE.en.length, FEEDBACK_ACKS.en.length);
  for (const v of FEEDBACK_ACKS_STANDALONE.en) {
    assert.match(v, /Feedback.*account panel/);
    // The session variants promise "this conversation for context" — untrue
    // for a note that opened the chat, so it must not appear here.
    assert.doesNotMatch(v, /this conversation|this chat attached/i);
  }
  for (const v of FEEDBACK_ACKS_STANDALONE.sv) {
    assert.match(v, /Feedback.*kontopanel/);
    assert.doesNotMatch(v, /den här konversationen|chatten bifogad/i);
  }
});

test("cannedFeedbackAck: scope picks the variant set; session stays the default", () => {
  const en = "feedback: please add a dark theme";
  assert.equal(FEEDBACK_ACKS_STANDALONE.en.includes(cannedFeedbackAck(en, { scope: "standalone" })), true);
  assert.equal(FEEDBACK_ACKS.en.includes(cannedFeedbackAck(en, { scope: "session" })), true);
  assert.equal(FEEDBACK_ACKS.en.includes(cannedFeedbackAck(en)), true); // default
  // Swedish parity, and deterministic (same message + scope → same reply).
  const sv = "synpunkt: lägg till mörkt tema";
  const ack = cannedFeedbackAck(sv, { scope: "standalone" });
  assert.equal(FEEDBACK_ACKS_STANDALONE.sv.includes(ack), true);
  assert.equal(cannedFeedbackAck(sv, { scope: "standalone" }), ack);
  // A use-case reference still gets its tail, in either scope.
  assert.match(
    cannedFeedbackAck("feedback #UC-34 the map was cut off", { useCaseTag: "#UC-34", scope: "standalone" }),
    /recorded against use case #UC-34\.$/,
  );
});

// ---------------------------------------------------------------------------
// The STRATEGY lane (owner directive, 2026-07-24): a note written from the
// outrospection view is an operative/strategic idea filed against a lens —
// direction for the project, not a defect to reproduce.
// ---------------------------------------------------------------------------

test("strategyPageTag carries the surface, the lens, and the strategy marker", () => {
  const tag = strategyPageTag("browser-models");
  assert.equal(tag, "outrospect:browser-models" + STRATEGY_PAGE_SUFFIX);
  assert.equal(isStrategyPage(tag), true);
  assert.equal(isStandalonePage(tag), false, "the two lanes must not collide");
});

test("strategyPageTag without a lens still marks the lane", () => {
  const tag = strategyPageTag(null);
  assert.equal(tag, "outrospect" + STRATEGY_PAGE_SUFFIX);
  assert.equal(isStrategyPage(tag), true);
});

test("strategyPageTag sanitizes a hostile lens value into the page column", () => {
  // The lens reaches the server from the client, so it is untrusted input to a
  // column the loop reads back — it must never carry punctuation or length.
  const tag = strategyPageTag("../../etc/passwd; DROP TABLE feedback");
  assert.match(tag, /^outrospect:[a-zA-Z0-9-]*\/strategy$/);
  assert.ok(tag.length < 80);
});

test("feedbackPageTag routes all four scopes, and session stays bare", () => {
  assert.equal(feedbackPageTag("chat", "session"), "chat");
  assert.equal(feedbackPageTag("chat", "standalone"), "chat/standalone");
  assert.equal(feedbackPageTag("chat", "strategy"), "chat/strategy");
  assert.equal(feedbackPageTag("chat", "doc"), "chat/doc");
});

test("scopeOfPage is the inverse of feedbackPageTag", () => {
  for (const scope of ["session", "standalone", "strategy", "doc"]) {
    assert.equal(scopeOfPage(feedbackPageTag("chat", scope)), scope);
  }
  assert.equal(scopeOfPage(null), "session");
  assert.equal(scopeOfPage("se/cure"), "session");
});

test("FEEDBACK_ACKS_STRATEGY: EN/SV parity, and no promise of a conversation", () => {
  assert.equal(FEEDBACK_ACKS_STRATEGY.en.length, FEEDBACK_ACKS_STRATEGY.sv.length);
  assert.equal(FEEDBACK_ACKS_STRATEGY.en.length, FEEDBACK_ACKS.en.length);
  for (const v of FEEDBACK_ACKS_STRATEGY.en) {
    assert.match(v, /Feedback.*account panel/);
    assert.doesNotMatch(v, /this conversation|this chat attached/i);
  }
  for (const v of FEEDBACK_ACKS_STRATEGY.sv) {
    assert.match(v, /Feedback.*kontopanel/);
    assert.doesNotMatch(v, /den här konversationen|chatten bifogad/i);
  }
});

test("cannedFeedbackAck: the strategy scope picks the strategy set, EN and SV", () => {
  const en = "feedback: this library should be our one dependency";
  assert.equal(FEEDBACK_ACKS_STRATEGY.en.includes(cannedFeedbackAck(en, { scope: "strategy" })), true);
  const sv = "synpunkt: det här biblioteket borde bli vårt enda beroende";
  const ack = cannedFeedbackAck(sv, { scope: "strategy" });
  assert.equal(FEEDBACK_ACKS_STRATEGY.sv.includes(ack), true);
  // Deterministic — same message + scope, same reply.
  assert.equal(cannedFeedbackAck(sv, { scope: "strategy" }), ack);
  // An unknown scope must never crash the ack; it falls back to the session set.
  assert.equal(FEEDBACK_ACKS.en.includes(cannedFeedbackAck(en, { scope: "nonsense" })), true);
});

// ---------------------------------------------------------------------------
// The DOC lane (owner directive, 2026-07-25): a passage comment written in the
// documentation reader's comment mode — an instruction about the documented
// system, doc and implementation together, not a copy-edit of the prose.
// ---------------------------------------------------------------------------

test("docPageTag carries the surface, the document path, and the doc marker", () => {
  const tag = docPageTag("docs/ENCRYPTION.md");
  assert.equal(tag, "docs:docs/ENCRYPTION.md" + DOC_PAGE_SUFFIX);
  assert.equal(isDocPage(tag), true);
  assert.equal(isStandalonePage(tag), false, "the lanes must not collide");
  assert.equal(isStrategyPage(tag), false, "the lanes must not collide");
});

test("docPathOfPage recovers the document the comment governs", () => {
  assert.equal(docPathOfPage(docPageTag("docs/ARCHITECTURE.md")), "docs/ARCHITECTURE.md");
  assert.equal(docPathOfPage(docPageTag("README.md")), "README.md");
  // Not a doc tag, or a doc tag with no path — null, never a bogus path.
  assert.equal(docPathOfPage("chat"), null);
  assert.equal(docPathOfPage("outrospect:browser-models/strategy"), null);
  assert.equal(docPathOfPage(docPageTag("")), null);
  assert.equal(docPathOfPage(null), null);
});

test("docPageTag sanitizes a hostile path into the page column", () => {
  // The path reaches the server from the client, so it is untrusted input to a
  // column the loop reads back. Nothing may smuggle the tag grammar.
  const tag = docPageTag("docs/x.md'; DROP TABLE feedback; --/doc");
  assert.match(tag, /^docs:[A-Za-z0-9._/-]*\/doc$/);
  assert.ok(tag.length < 200, "must fit FEEDBACK_CAPS.page");
  // A leading slash would make the path read as absolute in the loop's output.
  assert.equal(docPathOfPage(docPageTag("/docs/TESTING.md")), "docs/TESTING.md");
});

test("docPageTag: an over-long path is capped, and still round-trips as a doc tag", () => {
  const tag = docPageTag("docs/" + "a".repeat(400) + ".md");
  assert.equal(isDocPage(tag), true);
  assert.ok(tag.length <= 200);
  assert.ok((docPathOfPage(tag) || "").length <= 150);
});

test("FEEDBACK_ACKS_DOC: EN/SV parity, and it says the code is in scope too", () => {
  assert.equal(FEEDBACK_ACKS_DOC.en.length, FEEDBACK_ACKS_DOC.sv.length);
  assert.equal(FEEDBACK_ACKS_DOC.en.length, FEEDBACK_ACKS.en.length);
  for (const v of FEEDBACK_ACKS_DOC.en) {
    assert.match(v, /Feedback.*account panel/);
    assert.match(v, /implementation|code|documented behaviour/i);
    assert.doesNotMatch(v, /this conversation|this chat attached/i);
  }
  for (const v of FEEDBACK_ACKS_DOC.sv) {
    assert.match(v, /Feedback.*kontopanel/);
    assert.match(v, /implementation|koden|dokumenterade/i);
    assert.doesNotMatch(v, /den här konversationen|chatten bifogad/i);
  }
});

test("cannedFeedbackAck: the doc scope picks the doc set, EN and SV", () => {
  const en = "the key hierarchy paragraph is wrong — it is per device now";
  assert.equal(FEEDBACK_ACKS_DOC.en.includes(cannedFeedbackAck(en, { scope: "doc" })), true);
  const sv = "nyckelhierarkin stämmer inte, den är per enhet nu och koden borde visa det";
  const ack = cannedFeedbackAck(sv, { scope: "doc" });
  assert.equal(FEEDBACK_ACKS_DOC.sv.includes(ack), true);
  assert.equal(cannedFeedbackAck(sv, { scope: "doc" }), ack, "deterministic");
});
