// Unit tests for the feedback pipeline's pure logic (src/feedback.js):
// create/reply validation, screenshot-image validation/decoding, status
// lifecycle, projection, ?format=text.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  approxImageBytes,
  decodeImageDataUrl,
  FEEDBACK_CAPS,
  FEEDBACK_IMAGE_CAPS,
  FEEDBACK_STATUSES,
  formatFeedbackText,
  isOpenStatus,
  normalizeStatus,
  projectFeedback,
  validateFeedbackCreate,
  validateFeedbackImages,
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

test("validateFeedbackReply: non-empty trimmed body required (unless images ride along)", () => {
  assert.equal(validateFeedbackReply(null).error !== undefined, true);
  assert.equal(validateFeedbackReply({}).error !== undefined, true);
  assert.equal(validateFeedbackReply({ body: "  " }).error !== undefined, true);
  assert.equal(validateFeedbackReply({ body: " hej " }).body, "hej");
});

// ---------------------------------------------------------------------------
// Screenshot images
// ---------------------------------------------------------------------------

// "hello" → base64; a small but fully valid data URL.
const PNG_URL = "data:image/png;base64,aGVsbG8=";
const JPEG_URL = "data:image/jpeg;base64,aGVsbG8=";

test("validateFeedbackImages: absent/empty is fine, junk shapes are errors", () => {
  assert.deepEqual(validateFeedbackImages(undefined), { images: [] });
  assert.deepEqual(validateFeedbackImages(null), { images: [] });
  assert.deepEqual(validateFeedbackImages([]), { images: [] });
  assert.equal(validateFeedbackImages("nope").error !== undefined, true);
  assert.equal(validateFeedbackImages({}).error !== undefined, true);
  assert.equal(validateFeedbackImages([null]).error !== undefined, true);
  assert.equal(validateFeedbackImages([{ name: "x.png" }]).error !== undefined, true);
});

test("validateFeedbackImages: strict data-URL shape — mime allowlist, no smuggling", () => {
  const ok = validateFeedbackImages([{ name: "shot.png", data: PNG_URL }]);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.images, [{ name: "shot.png", data: PNG_URL }]);
  // name is optional → null
  assert.equal(validateFeedbackImages([{ data: JPEG_URL }]).images[0].name, null);
  for (const bad of [
    "data:image/svg+xml;base64,aGVsbG8=", // scriptable mime
    "data:text/html;base64,aGVsbG8=",
    "http://example.com/x.png", // not a data URL
    "data:image/png;base64,aGVsbG8=\njunk", // trailing smuggle
    "data:image/png;base64,not base64!",
    "data:image/png,plainpayload", // not base64-flagged
  ]) {
    assert.equal(validateFeedbackImages([{ data: bad }]).error !== undefined, true, bad);
  }
});

test("validateFeedbackImages: count, per-image, and total caps", () => {
  const many = Array.from({ length: FEEDBACK_IMAGE_CAPS.count + 1 }, () => ({ data: PNG_URL }));
  assert.match(validateFeedbackImages(many).error, /At most/);
  const huge = "data:image/png;base64," + "A".repeat(FEEDBACK_IMAGE_CAPS.dataChars);
  assert.match(validateFeedbackImages([{ data: huge }]).error, /too large/);
  // Three images each under the per-image cap but over the total together.
  const big = "data:image/png;base64," + "A".repeat(FEEDBACK_IMAGE_CAPS.dataChars - 100);
  const total = validateFeedbackImages([{ data: big }, { data: big }, { data: big }]);
  assert.match(total.error, /together/);
});

test("validateFeedbackImages: oversize name truncates rather than erroring", () => {
  const v = validateFeedbackImages([{ name: "n".repeat(500), data: PNG_URL }]);
  assert.equal(v.error, undefined);
  assert.match(v.images[0].name, /…\[truncated 300 chars\]$/);
});

test("validateFeedbackCreate carries validated images through (and their errors up)", () => {
  const v = validateFeedbackCreate({ comment: "c", images: [{ name: "s.png", data: PNG_URL }] });
  assert.equal(v.error, undefined);
  assert.deepEqual(v.images, [{ name: "s.png", data: PNG_URL }]);
  assert.deepEqual(validateFeedbackCreate({ comment: "c" }).images, []);
  assert.equal(
    validateFeedbackCreate({ comment: "c", images: [{ data: "junk" }] }).error !== undefined,
    true,
  );
});

test("validateFeedbackReply: image-only replies are allowed, images validated", () => {
  const v = validateFeedbackReply({ images: [{ data: PNG_URL }] });
  assert.equal(v.error, undefined);
  assert.equal(v.body, "");
  assert.equal(v.images.length, 1);
  const both = validateFeedbackReply({ body: "see attached", images: [{ data: JPEG_URL }] });
  assert.equal(both.body, "see attached");
  assert.equal(both.images.length, 1);
  assert.equal(validateFeedbackReply({ images: [{ data: "junk" }] }).error !== undefined, true);
  assert.deepEqual(validateFeedbackReply({ body: "hi" }).images, []);
});

test("decodeImageDataUrl: valid URL → mime + bytes, junk → null", () => {
  const d = decodeImageDataUrl(PNG_URL);
  assert.equal(d.mime, "image/png");
  assert.equal(new TextDecoder().decode(d.bytes), "hello");
  assert.equal(decodeImageDataUrl("data:image/svg+xml;base64,aGVsbG8="), null);
  assert.equal(decodeImageDataUrl("not a url"), null);
  assert.equal(decodeImageDataUrl(null), null);
});

test("approxImageBytes: prefix-adjusted base64 → bytes estimate", () => {
  assert.equal(approxImageBytes(23), 0);
  assert.equal(approxImageBytes(0), 0);
  // 8 payload chars (aGVsbG8= carries 5 bytes) → within a byte or two.
  const est = approxImageBytes(PNG_URL.length);
  assert.equal(Math.abs(est - 5) <= 2, true);
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
    images: [],
  });
  assert.equal(p.messages[1].read_at, 123);
  // Closed entries read closed.
  assert.equal(projectFeedback({ ...ROW, status: "resolved" }).open, false);
  // Empty optional fields project as null, messages/images default empty.
  const bare = projectFeedback({ ...ROW, question: null, answer_excerpt: "", model: undefined, page: null });
  assert.equal(bare.question, null);
  assert.equal(bare.answer_excerpt, null);
  assert.equal(bare.model, null);
  assert.deepEqual(bare.messages, []);
  assert.deepEqual(bare.images, []);
});

test("projectFeedback: image metadata splits entry-level vs per-message, data never leaks", () => {
  const IMGS = [
    { id: 11, feedback_id: 7, message_id: null, name: "shot.png", chars: 4023 },
    { id: 12, feedback_id: 7, message_id: 2, name: null, chars: 1023 },
  ];
  const p = projectFeedback(ROW, MSGS, IMGS);
  assert.deepEqual(p.images, [{ id: 11, name: "shot.png", bytes: 3000 }]);
  assert.deepEqual(p.messages[0].images, []);
  assert.deepEqual(p.messages[1].images, [{ id: 12, name: null, bytes: 750 }]);
  // Only metadata crosses — the data column must never appear in a projection.
  assert.equal(JSON.stringify(p).includes('"data"'), false);
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
  assert.doesNotMatch(text, /IMAGES:/);
});

test("formatFeedbackText lists screenshot ids/names/sizes, per message too", () => {
  const IMGS = [
    { id: 11, feedback_id: 7, message_id: null, name: "shot.png", chars: 42_000 },
    { id: 12, feedback_id: 7, message_id: 2, name: null, chars: 2_000 },
  ];
  const text = formatFeedbackText([projectFeedback(ROW, MSGS, IMGS)]);
  assert.match(text, /IMAGES: #11 shot\.png \(~31 KB\)/);
  assert.match(text, /USER \(.*\): Thanks!\n {2}IMAGES: #12 image \(~1 KB\)/);
});
