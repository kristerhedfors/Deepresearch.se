// Unit tests for the feedback pipeline's pure logic (src/feedback.js):
// create/reply validation, screenshot-image validation/decoding, status
// lifecycle, projection, ?format=text.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  approxImageBytes,
  buildFeedbackContext,
  createOrThreadFeedbackEntry,
  followUpFeedbackBody,
  priorFeedbackComment,
  decodeImageDataUrl,
  FEEDBACK_CAPS,
  FEEDBACK_IMAGE_CAPS,
  FEEDBACK_STATUSES,
  feedbackIntent,
  formatFeedbackText,
  handleServerTokenFeedback,
  isOpenStatus,
  normalizeStatus,
  projectFeedback,
  validateFeedbackCreate,
  validateFeedbackImages,
  validateFeedbackReply,
} from "./feedback.js";
import { mintServerToken } from "./server-token.js";

// ---------------------------------------------------------------------------
// feedbackIntent — the chat-side gate (EN + SV parity, invariant 6)
// ---------------------------------------------------------------------------

test("feedbackIntent: a message opening with 'feedback' (any case) triggers", () => {
  assert.equal(feedbackIntent("feedback: the map view was cut off"), true);
  assert.equal(feedbackIntent("Feedback - please add a dark theme"), true);
  assert.equal(feedbackIntent("FEEDBACK the PDF export is broken"), true);
  assert.equal(feedbackIntent("  feedback"), true); // leading whitespace, bare word
  assert.equal(feedbackIntent("feedback."), true);
});

test("feedbackIntent: Swedish forms trigger with the same breadth (parity)", () => {
  // "feedback" is used in Swedish too; the native terms are återkoppling /
  // synpunkt(er), definite forms included.
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
  // The word must OPEN the message — a mention mid-sentence doesn't route.
  assert.equal(feedbackIntent("How do I read my feedback threads?"), false);
});

test("feedbackIntent: 'feedback loop(s)' research questions are NOT swallowed", () => {
  // The one excluded collision: a ubiquitous fixed phrase must still research.
  assert.equal(feedbackIntent("feedback loops in machine learning, explain"), false);
  assert.equal(feedbackIntent("Feedback loop design in control theory"), false);
});

test("feedbackIntent: non-string input is safe", () => {
  assert.equal(feedbackIntent(null), false);
  assert.equal(feedbackIntent(undefined), false);
  assert.equal(feedbackIntent(42), false);
});

// ---------------------------------------------------------------------------
// buildFeedbackContext — the captured prior-turn context (pipeline.js
// runFeedbackCapture). The historical-chat guarantee: reopening an OLD session
// and giving feedback must capture that session's last Q&A, exactly like a
// fresh chat, so the entry enters the fix loop with the right context.
// ---------------------------------------------------------------------------

test("buildFeedbackContext: captures the prior question + answer of the turn being commented on", () => {
  const convo = [
    { role: "user", content: "Tell me about Northvolt latest news" },
    { role: "assistant", content: "Northvolt filed for bankruptcy in 2025 …" },
    { role: "user", content: "feedback: that answer was outdated" },
  ];
  const ctx = buildFeedbackContext(convo, { comment: "feedback: that answer was outdated", model: "gpt-x" });
  assert.deepEqual(ctx, {
    comment: "feedback: that answer was outdated",
    question: "Tell me about Northvolt latest news",
    answer_excerpt: "Northvolt filed for bankruptcy in 2025 …",
    model: "gpt-x",
  });
});

test("buildFeedbackContext: a REOPENED HISTORICAL chat captures the LAST Q&A, not an earlier one", () => {
  // A user opens an old multi-turn session from history and types feedback:
  // the whole restored conversation is re-sent, so the context must be the
  // final answer pair — never the first turn, never the feedback text itself.
  const historical = [
    { role: "user", content: "What is the capital of Sweden?" },
    { role: "assistant", content: "Stockholm." },
    { role: "user", content: "Now tell me about Northvolt" },
    { role: "assistant", content: "Northvolt is a Swedish battery maker …" },
    { role: "user", content: "feedback: the Northvolt part missed the 2026 restructuring" },
  ];
  const ctx = buildFeedbackContext(historical, {
    comment: "feedback: the Northvolt part missed the 2026 restructuring",
    model: "claude-x",
  });
  assert.equal(ctx.question, "Now tell me about Northvolt");
  assert.equal(ctx.answer_excerpt, "Northvolt is a Swedish battery maker …");
});

test("buildFeedbackContext: feedback with no prior turn yields null context, not junk", () => {
  const ctx = buildFeedbackContext([{ role: "user", content: "feedback: love the site" }], {
    comment: "feedback: love the site",
    model: "m",
  });
  assert.equal(ctx.question, null);
  assert.equal(ctx.answer_excerpt, null);
  assert.equal(ctx.comment, "feedback: love the site");
});

test("buildFeedbackContext: the answer excerpt is capped to FEEDBACK_CAPS.answer_excerpt", () => {
  const longAnswer = "x".repeat(FEEDBACK_CAPS.answer_excerpt + 500);
  const ctx = buildFeedbackContext(
    [
      { role: "user", content: "a question" },
      { role: "assistant", content: longAnswer },
      { role: "user", content: "feedback: too long" },
    ],
    { comment: "feedback: too long", model: "m" },
  );
  assert.equal(ctx.answer_excerpt.length, FEEDBACK_CAPS.answer_excerpt);
});

test("buildFeedbackContext: reads text out of multimodal prior turns and tolerates junk input", () => {
  const convo = [
    { role: "user", content: [{ type: "text", text: "look at this photo" }, { type: "image_url", image_url: { url: "data:…" } }] },
    { role: "assistant", content: "That looks like Gamla stan." },
    { role: "user", content: "feedback: nice" },
  ];
  const ctx = buildFeedbackContext(convo, { comment: "feedback: nice", model: "m" });
  assert.match(ctx.question, /look at this photo/);
  assert.equal(ctx.answer_excerpt, "That looks like Gamla stan.");
  // Non-array conversation must not throw.
  const safe = buildFeedbackContext(/** @type {any} */ (null), { comment: "c", model: "m" });
  assert.deepEqual(safe, { comment: "c", question: null, answer_excerpt: null, model: "m" });
});

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

// ---------------------------------------------------------------------------
// Same-conversation follow-up threading (entries #8/#9, the mermaid case):
// a second "feedback …" message in one conversation must land on the FIRST
// message's entry as a thread reply, not open a disconnected entry.
// ---------------------------------------------------------------------------

test("priorFeedbackComment: no earlier feedback turn → null (the current turn never matches itself)", () => {
  assert.equal(
    priorFeedbackComment([
      { role: "user", content: "a question" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "feedback: first report" },
    ]),
    null,
  );
  assert.equal(priorFeedbackComment([]), null);
  assert.equal(priorFeedbackComment(/** @type {any} */ (null)), null);
});

test("priorFeedbackComment: finds the earlier feedback turn, most recent first", () => {
  const convo = [
    { role: "user", content: "feedback: oldest report" },
    { role: "assistant", content: "warm ack" },
    { role: "user", content: "feedback: the diagrams have no text in the boxes" },
    { role: "assistant", content: "re-rendered diagrams…" },
    { role: "user", content: "feedback still no text inside the boxes" },
  ];
  assert.equal(priorFeedbackComment(convo), "feedback: the diagrams have no text in the boxes");
});

test("priorFeedbackComment: Swedish forms are found with the same breadth (parity)", () => {
  const convo = [
    { role: "user", content: "Återkoppling: kartan var avklippt" },
    { role: "assistant", content: "tack!" },
    { role: "user", content: "synpunkt: fortfarande avklippt" },
  ];
  assert.equal(priorFeedbackComment(convo), "Återkoppling: kartan var avklippt");
});

test("priorFeedbackComment: caps the text exactly like a stored comment", () => {
  const long = "feedback " + "x".repeat(FEEDBACK_CAPS.comment + 500);
  const convo = [
    { role: "user", content: long },
    { role: "assistant", content: "ack" },
    { role: "user", content: "feedback: still broken" },
  ];
  const prior = priorFeedbackComment(convo);
  assert.match(prior, /…\[truncated \d+ chars\]$/);
  // Identical to what createFeedbackEntry would have stored for that turn.
  assert.equal(prior.length <= FEEDBACK_CAPS.comment + 30, true);
});

test("followUpFeedbackBody: comment plus clearly-marked context, trimmed with […]", () => {
  assert.equal(followUpFeedbackBody({ comment: "still broken" }), "still broken");
  const body = followUpFeedbackBody({
    comment: "feedback still no text inside the boxes",
    question: "ok but re-render then",
    answer_excerpt: "y".repeat(2_000),
  });
  assert.match(body, /^feedback still no text inside the boxes/);
  assert.match(body, /— about question: ok but re-render then/);
  assert.match(body, /— about reply: y{1500} \[…\]/);
  assert.equal(body.length <= FEEDBACK_CAPS.message + 30, true);
});

// A minimal D1 fake: enough surface (prepare/bind/first/run) for the
// threading decision — same spirit as the quota-grant combined-D1-fake.
function fakeThreadingDb({ existing = null } = {}) {
  const calls = { messages: [], statusUpdates: [], inserts: [] };
  const db = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/SELECT id, status FROM feedback/.test(sql)) {
            if (existing && existing.comment === this.args[1]) return { id: existing.id, status: existing.status };
            return null;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO feedback_messages/.test(sql)) calls.messages.push(this.args);
          else if (/UPDATE feedback SET status = 'new'/.test(sql)) calls.statusUpdates.push(this.args);
          else if (/INSERT INTO feedback\b/.test(sql)) { calls.inserts.push(this.args); return { meta: { last_row_id: 99 } }; }
          return { meta: { last_row_id: calls.messages.length } };
        },
      };
    },
  };
  return { db: /** @type {any} */ (db), calls };
}

const FOLLOW_UP_CONVO = [
  { role: "user", content: "visualise the pipeline with mermaid" },
  { role: "assistant", content: "three diagrams…" },
  { role: "user", content: "feedback: the diagrams have no text in the boxes" },
  { role: "assistant", content: "re-rendered…" },
  { role: "user", content: "feedback still no text inside the boxes" },
];

test("createOrThreadFeedbackEntry: a follow-up threads onto the earlier entry as a user message", async () => {
  const { db, calls } = fakeThreadingDb({
    existing: { id: 8, status: "in_progress", comment: "feedback: the diagrams have no text in the boxes" },
  });
  const res = await createOrThreadFeedbackEntry(db, "1", {
    comment: "feedback still no text inside the boxes",
    question: "ok but re-render then",
    answer_excerpt: "the re-rendered diagrams",
  }, FOLLOW_UP_CONVO);
  assert.deepEqual(res, { id: 8, threaded: true });
  assert.equal(calls.inserts.length, 0); // no new entry
  assert.equal(calls.messages.length, 1);
  const [feedbackId, author, body] = calls.messages[0];
  assert.equal(feedbackId, 8);
  assert.equal(author, "user");
  assert.match(body, /^feedback still no text inside the boxes/);
  assert.match(body, /— about reply: the re-rendered diagrams/);
  // The entry was already open — no status reset.
  assert.equal(calls.statusUpdates.length, 0);
});

test("createOrThreadFeedbackEntry: threading onto a CLOSED entry reopens it", async () => {
  const { db, calls } = fakeThreadingDb({
    existing: { id: 8, status: "resolved", comment: "feedback: the diagrams have no text in the boxes" },
  });
  const res = await createOrThreadFeedbackEntry(db, "1", { comment: "feedback still broken" }, FOLLOW_UP_CONVO);
  assert.deepEqual(res, { id: 8, threaded: true });
  assert.equal(calls.statusUpdates.length, 1);
  assert.equal(calls.statusUpdates[0][0], 8);
});

test("createOrThreadFeedbackEntry: first feedback in a conversation creates a fresh entry", async () => {
  const { db, calls } = fakeThreadingDb({});
  const res = await createOrThreadFeedbackEntry(db, "1", { comment: "feedback: first report" }, [
    { role: "user", content: "a question" },
    { role: "assistant", content: "an answer" },
    { role: "user", content: "feedback: first report" },
  ]);
  assert.deepEqual(res, { id: 99, threaded: false });
  assert.equal(calls.inserts.length, 1);
  assert.equal(calls.messages.length, 0);
});

test("createOrThreadFeedbackEntry: a withdrawn/unmatched earlier report falls back to a fresh entry", async () => {
  // Conversation carries an earlier feedback turn, but no stored entry
  // matches (e.g. the user withdrew it) — a fresh entry, never a crash.
  const { db, calls } = fakeThreadingDb({});
  const res = await createOrThreadFeedbackEntry(db, "1", { comment: "feedback still broken" }, FOLLOW_UP_CONVO);
  assert.deepEqual(res, { id: 99, threaded: false });
  assert.equal(calls.inserts.length, 1);
});

test("createOrThreadFeedbackEntry: no DB → null (fail-soft)", async () => {
  assert.equal(await createOrThreadFeedbackEntry(null, "1", { comment: "c" }, FOLLOW_UP_CONVO), null);
});

// ---------------------------------------------------------------------------
// handleServerTokenFeedback — the THIRD bounded exception (Se/cure feedback
// over the DeepResearch/Se/rver token; write-only, attributed to claims.sub)
// ---------------------------------------------------------------------------

const ST_SECRET = "test-session-secret-servertoken-feedback";

// A minimal in-memory D1 that recognizes the feedback INSERT (createFeedbackEntry)
// and image INSERT (insertImages). Enough for the write path; the token is never
// allowed to READ, so no SELECT surface is offered here.
function fakeFeedbackDb() {
  const rows = [];
  let seq = 0;
  const stmt = (sql) => ({
    _binds: [],
    bind(...b) { this._binds = b; return this; },
    async run() {
      if (/^INSERT INTO feedback\b/i.test(sql)) {
        seq += 1;
        rows.push({ id: seq, sql, binds: this._binds });
        return { meta: { last_row_id: seq } };
      }
      return { meta: {} };
    },
    async first() { return null; },
    async all() { return { results: [] }; },
  });
  return { _rows: rows, prepare: stmt, async batch() { return []; } };
}

const noopLog = { info() {}, warn() {}, error() {} };

async function stFeedbackToken(env, { perms = ["web"], sub = "user-42", expOffset = 3600 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return mintServerToken(env, {
    iss: "deepresearch.se",
    sub,
    jti: "jti-fb-1",
    perms,
    iat: now,
    exp: now + expOffset,
  });
}

function fbRequest(body) {
  return new Request("https://deepresearch.se/api/server-token/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("handleServerTokenFeedback: a valid token writes a row attributed to claims.sub", async () => {
  const db = fakeFeedbackDb();
  const env = { DB: db, SESSION_SECRET: ST_SECRET };
  const token = await stFeedbackToken(env, { sub: "user-99" });
  const res = await handleServerTokenFeedback(
    fbRequest({ token, comment: "feedback: the slash spacing looks off", page: "se/cure", model: "berget::x" }),
    env,
    noopLog,
  );
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(json.id > 0);
  // Attribution: the feedback row's user_id bind is the token's sub (write-only,
  // so the minting account owns it and can read replies back on Se/rver).
  const inserted = db._rows.find((r) => /^INSERT INTO feedback\b/i.test(r.sql));
  assert.equal(inserted.binds[0], "user-99");
});

test("handleServerTokenFeedback: an 'api'-only token qualifies too (any live perm)", async () => {
  const db = fakeFeedbackDb();
  const env = { DB: db, SESSION_SECRET: ST_SECRET };
  const token = await stFeedbackToken(env, { perms: ["api"] });
  const res = await handleServerTokenFeedback(fbRequest({ token, comment: "nice work" }), env, noopLog);
  assert.equal(res.status, 201);
});

test("handleServerTokenFeedback: an invalid/expired/missing token is 403 (never writes)", async () => {
  const db = fakeFeedbackDb();
  const env = { DB: db, SESSION_SECRET: ST_SECRET };
  // garbage token
  let res = await handleServerTokenFeedback(fbRequest({ token: "not.a.jwt", comment: "hi" }), env, noopLog);
  assert.equal(res.status, 403);
  // expired token
  const expired = await stFeedbackToken(env, { expOffset: -10 });
  res = await handleServerTokenFeedback(fbRequest({ token: expired, comment: "hi" }), env, noopLog);
  assert.equal(res.status, 403);
  // no token at all
  res = await handleServerTokenFeedback(fbRequest({ comment: "hi" }), env, noopLog);
  assert.equal(res.status, 403);
  assert.equal(db._rows.length, 0); // nothing written on any rejected path
});

test("handleServerTokenFeedback: a valid token but empty comment is 400", async () => {
  const db = fakeFeedbackDb();
  const env = { DB: db, SESSION_SECRET: ST_SECRET };
  const token = await stFeedbackToken(env);
  const res = await handleServerTokenFeedback(fbRequest({ token, comment: "   " }), env, noopLog);
  assert.equal(res.status, 400);
  assert.equal(db._rows.length, 0);
});

test("handleServerTokenFeedback: no D1 fails soft to 503", async () => {
  const env = { DB: null, SESSION_SECRET: ST_SECRET };
  const token = await stFeedbackToken({ SESSION_SECRET: ST_SECRET });
  const res = await handleServerTokenFeedback(fbRequest({ token, comment: "hi" }), env, noopLog);
  assert.equal(res.status, 503);
});
