// Unit tests for the feedback pipeline's pure logic (src/feedback.js):
// create/reply validation, status lifecycle, projection, ?format=text.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FEEDBACK_CAPS,
  FEEDBACK_STATUSES,
  formatFeedbackText,
  isOpenStatus,
  normalizeStatus,
  projectFeedback,
  validateFeedbackCreate,
  validateFeedbackReply,
} from "./feedback.js";

// ---------------------------------------------------------------------------
// Status lifecycle
// ---------------------------------------------------------------------------

test("isOpenStatus: resolved/declined are closed, everything else is open", () => {
  assert.equal(isOpenStatus("new"), true);
  assert.equal(isOpenStatus("seen"), true);
  assert.equal(isOpenStatus("in_progress"), true);
  assert.equal(isOpenStatus("resolved"), false);
  assert.equal(isOpenStatus("declined"), false);
});

test("normalizeStatus accepts only the lifecycle enums", () => {
  for (const s of FEEDBACK_STATUSES) assert.equal(normalizeStatus(s), s);
  assert.equal(normalizeStatus("fixed"), null);
  assert.equal(normalizeStatus(""), null);
  assert.equal(normalizeStatus(undefined), null);
  assert.equal(normalizeStatus(42), null);
});

// ---------------------------------------------------------------------------
// Create validation
// ---------------------------------------------------------------------------

test("validateFeedbackCreate: comment is required and trimmed", () => {
  assert.equal(validateFeedbackCreate(null).error !== undefined, true);
  assert.equal(validateFeedbackCreate("nope").error !== undefined, true);
  assert.equal(validateFeedbackCreate({}).error !== undefined, true);
  assert.equal(validateFeedbackCreate({ comment: "   " }).error !== undefined, true);
  assert.equal(validateFeedbackCreate({ comment: 42 }).error !== undefined, true);
  const v = validateFeedbackCreate({ comment: "  too slow  " });
  assert.equal(v.error, undefined);
  assert.equal(v.entry.comment, "too slow");
});

test("validateFeedbackCreate: context fields are optional and null when absent/junk", () => {
  const v = validateFeedbackCreate({ comment: "c", question: 7, model: "", page: null });
  assert.deepEqual(v.entry, {
    comment: "c",
    question: null,
    answer_excerpt: null,
    model: null,
    page: null,
  });
});

test("validateFeedbackCreate: oversize fields truncate with the explicit marker", () => {
  const long = "x".repeat(FEEDBACK_CAPS.comment + 500);
  const v = validateFeedbackCreate({ comment: long, answer_excerpt: "a".repeat(9000) });
  assert.equal(v.entry.comment.startsWith("x".repeat(FEEDBACK_CAPS.comment)), true);
  assert.match(v.entry.comment, /…\[truncated 500 chars\]$/);
  assert.match(v.entry.answer_excerpt, /…\[truncated 1000 chars\]$/);
});

test("validateFeedbackReply: non-empty trimmed body required", () => {
  assert.equal(validateFeedbackReply(null).error !== undefined, true);
  assert.equal(validateFeedbackReply({}).error !== undefined, true);
  assert.equal(validateFeedbackReply({ body: "  " }).error !== undefined, true);
  assert.equal(validateFeedbackReply({ body: " hej " }).body, "hej");
});

// ---------------------------------------------------------------------------
// Projection + text rendering
// ---------------------------------------------------------------------------

const ROW = {
  id: 7,
  user_id: "3",
  created_at: 1751970000000,
  updated_at: 1751971000000,
  status: "new",
  comment: "The answer missed my attached PDF",
  question: "Summarize the attached report",
  answer_excerpt: "Here is a summary…",
  model: "some-model",
  page: "/",
};

const MSGS = [
  { id: 1, feedback_id: 7, author: "agent", body: "Looking into it.", created_at: 1751970500000, read_at: null },
  { id: 2, feedback_id: 7, author: "user", body: "Thanks!", created_at: 1751970600000, read_at: 123 },
];

test("projectFeedback: row + messages → API object with open flag and ISO time", () => {
  const p = projectFeedback(ROW, MSGS);
  assert.equal(p.id, 7);
  assert.equal(p.open, true);
  assert.equal(p.time, new Date(ROW.created_at).toISOString());
  assert.equal(p.messages.length, 2);
  assert.deepEqual(p.messages[0], {
    id: 1,
    author: "agent",
    body: "Looking into it.",
    created_at: 1751970500000,
    time: new Date(1751970500000).toISOString(),
    read_at: null,
  });
  assert.equal(p.messages[1].read_at, 123);
  // Closed entries read closed.
  assert.equal(projectFeedback({ ...ROW, status: "resolved" }).open, false);
  // Empty optional fields project as null, messages default empty.
  const bare = projectFeedback({ ...ROW, question: null, answer_excerpt: "", model: undefined, page: null });
  assert.equal(bare.question, null);
  assert.equal(bare.answer_excerpt, null);
  assert.equal(bare.model, null);
  assert.deepEqual(bare.messages, []);
});

test("formatFeedbackText: readable blocks with thread; empty list says so", () => {
  assert.equal(formatFeedbackText([]), "(no feedback entries match)\n");
  const text = formatFeedbackText([projectFeedback(ROW, MSGS)]);
  assert.match(text, /── #7 .* \[new\] user=3 model=some-model page=\//);
  assert.match(text, /FEEDBACK: The answer missed my attached PDF/);
  assert.match(text, /ABOUT QUESTION: Summarize the attached report/);
  assert.match(text, /ABOUT REPLY: Here is a summary…/);
  assert.match(text, /AGENT \(.*\): Looking into it\./);
  assert.match(text, /USER \(.*\): Thanks!/);
});

test("formatFeedbackText omits absent context lines", () => {
  const p = projectFeedback({ ...ROW, question: null, answer_excerpt: null, model: null, page: null });
  const text = formatFeedbackText([p]);
  assert.doesNotMatch(text, /ABOUT QUESTION/);
  assert.doesNotMatch(text, /ABOUT REPLY/);
  assert.doesNotMatch(text, /model=/);
});
