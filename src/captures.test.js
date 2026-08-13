// Unit tests for the video-capture review surface (src/captures.js): the
// create/patch/review/version validators (including THE product rule — a
// feedback swipe without a note is a 400), the status/verdict vocabulary, the
// projection contract the review feed reads, ?format=text, the Range parser
// behind the <video> element, and the handler end to end over a fake D1.
//
// The queue-v2 half is here too: the thread of versions (allocation, older
// versions surviving a new one, the v1 back-compat key fallback that keeps the
// four pre-versions captures playing), `answered_at` being set once and never
// cleared, the naming helpers, and queue-status's deficit + `used` list.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_CAPS,
  CAPTURE_QUEUE_TARGET,
  CAPTURE_SHAPES,
  CAPTURE_STATUSES,
  CAPTURE_VERDICTS,
  CAPTURE_WAIT_MODES,
  VERDICT_STATUS,
  VERDICT_SYMBOLS,
  deriveCaptureName,
  captureQueueStatus,
  captureSlug,
  captureTag,
  captureVersionNumber,
  countNewCaptures,
  formatCapturesText,
  handleAdminCaptures,
  normalizeCaptureStatus,
  normalizeShape,
  normalizeWaitMode,
  parseRange,
  posterUrl,
  projectCapture,
  projectCaptureReview,
  projectCaptureVersion,
  syntheticVersionRow,
  undoReviewState,
  validateCaptureCreate,
  validateCapturePatch,
  validateCaptureReview,
  validateCaptureVersion,
  versionPosterUrl,
  versionVideoUrl,
  videoUrl,
} from "./captures.js";

// A minimal well-formed create body, spread and overridden per test.
const CREATE = {
  label: "Deep Research answers a geothermal question",
  agent: "research",
  model: "mistral-small",
  prompt: "How much of Iceland's electricity comes from geothermal?",
  duration_ms: 8_400,
};

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

test("the lifecycle and the two swipe directions are fixed", () => {
  assert.deepEqual(CAPTURE_STATUSES, ["new", "liked", "needs_work", "archived"]);
  assert.deepEqual(CAPTURE_VERDICTS, ["like", "feedback"]);
});

test("every verdict has a symbol and drives exactly one status", () => {
  for (const v of CAPTURE_VERDICTS) {
    assert.ok(VERDICT_SYMBOLS[v], `missing symbol for ${v}`);
    assert.ok(CAPTURE_STATUSES.includes(VERDICT_STATUS[v]), `${v} drives an unknown status`);
  }
  assert.equal(VERDICT_SYMBOLS.like, "👍");
  assert.equal(VERDICT_SYMBOLS.feedback, "✍️");
  assert.equal(VERDICT_STATUS.like, "liked");
  assert.equal(VERDICT_STATUS.feedback, "needs_work");
});

test("undoReviewState: the last verdict comes off, the one before it stands", () => {
  // Pure half of the undo (owner directive, 2026-08-13). Read the three rules
  // straight off the assertions: only the LAST verdict, the status comes from
  // what REMAINS, and a like is un-counted rather than left on the row.
  const like = { id: 7, verdict: "like" };
  const fb = { id: 6, verdict: "feedback" };

  const only = undoReviewState([like], { likes: 1 });
  assert.deepEqual(only, { review_id: 7, verdict: "like", status: "new", likes: 0, clear_answered: true });

  const second = undoReviewState([fb, like], { likes: 1 });
  assert.equal(second?.status, "needs_work", "the verdict before it is restored");
  assert.equal(second?.clear_answered, false, "this capture HAS been answered");

  // Undoing a feedback leaves the like counter alone.
  assert.equal(undoReviewState([like, fb], { likes: 1 })?.likes, 1);
});

test("undoReviewState: nothing to undo, and junk that must not throw", () => {
  // The endpoint turns null into a 404 with a sentence in it, so this is the
  // difference between "there was no verdict" and a silent no-op.
  assert.equal(undoReviewState([], { likes: 0 }), null);
  assert.equal(undoReviewState(null, {}), null);
  assert.equal(undoReviewState([{ verdict: "like" }], {}), null, "a row with no id cannot be deleted");
  // A verdict this module does not know reads as feedback (the one that does
  // not touch the counter) — the same rule projectCaptureReview follows.
  assert.equal(undoReviewState([{ id: 1, verdict: "shrug" }], { likes: 2 })?.verdict, "feedback");
  assert.equal(undoReviewState([{ id: 1, verdict: "shrug" }], { likes: 2 })?.likes, 2);
  // The counter floors at zero: a row whose likes were reset by hand must not
  // go negative when its verdict is taken back.
  assert.equal(undoReviewState([{ id: 1, verdict: "like" }], { likes: 0 })?.likes, 0);
});

test("normalizeCaptureStatus accepts only the lifecycle enums", () => {
  for (const s of CAPTURE_STATUSES) assert.equal(normalizeCaptureStatus(s), s);
  assert.equal(normalizeCaptureStatus("done"), null);
  assert.equal(normalizeCaptureStatus(3), null);
  assert.equal(normalizeCaptureStatus(null), null);
});

// The harness owns the shape/wait vocabulary (scripts/capture-core.mjs); this
// module only records it, so an unknown value falls back instead of erroring.
test("shape and wait mode: absent stays null, unknown falls back", () => {
  for (const s of CAPTURE_SHAPES) assert.equal(normalizeShape(s), s);
  assert.equal(normalizeShape(null), null);
  assert.equal(normalizeShape("   "), null);
  assert.equal(normalizeShape("hexagonal"), "portrait");
  for (const w of CAPTURE_WAIT_MODES) assert.equal(normalizeWaitMode(w), w);
  assert.equal(normalizeWaitMode(undefined), null);
  assert.equal(normalizeWaitMode("blend"), "cut");
});

test("captureSlug derives a readable, filesystem-safe identity", () => {
  assert.equal(
    captureSlug({ agent: "research", model: "Mistral Small 3.1", starter: "geo-01" }),
    "research__mistral-small-3-1__geo-01",
  );
  // No starter: the label stands in, so a hand-made row still has an identity.
  assert.equal(captureSlug({ agent: "research", model: "m", label: "A clip!" }), "research__m__a-clip");
  assert.equal(captureSlug({ agent: "", model: "", starter: "" }), "capture");
  assert.ok(captureSlug({ agent: "a".repeat(200), model: "b".repeat(200) }).length <= CAPTURE_CAPS.slug);
});

// ---------------------------------------------------------------------------
// Identity: the number and the name (§1, §6 of the queue contract)
// ---------------------------------------------------------------------------

test("captureTag spells the increasing series the way the owner says it", () => {
  assert.equal(captureTag(12), "#CAP-12");
  assert.equal(captureTag(1), "#CAP-1");
  assert.equal(captureTag("7"), "#CAP-7");
});

test("deriveCaptureName derives a short name from the starter id, no network, no model", () => {
  assert.equal(deriveCaptureName({ agent: "research", starter: "res-sv-elpris" }), "Elpris");
  assert.equal(deriveCaptureName({ agent: "scholar", starter: "sch-vitamin-d" }), "Vitamin D");
  assert.equal(deriveCaptureName({ agent: "introspection", starter: "int-pipeline" }), "Pipeline");
  // Capped at four words, however long the id is.
  assert.equal(
    deriveCaptureName({ starter: "res-one-two-three-four-five-six" }),
    "One Two Three Four",
  );
  // A single-word starter IS the name — stripping the prefix would leave
  // nothing, so nothing is stripped.
  assert.equal(deriveCaptureName({ starter: "elpris" }), "Elpris");
});

test("deriveCaptureName falls back to the prompt, and is never empty", () => {
  assert.equal(
    deriveCaptureName({ agent: "research", prompt: "how much geothermal electricity does Iceland use" }),
    "how much geothermal electricity",
  );
  assert.equal(deriveCaptureName({}), "Untitled capture");
  assert.equal(deriveCaptureName({ starter: "   ", prompt: "  " }), "Untitled capture");
  assert.ok(deriveCaptureName({ starter: `res-${"x".repeat(300)}` }).length <= CAPTURE_CAPS.name);
});

test("captureVersionNumber reads a missing or nonsense version as 1", () => {
  assert.equal(captureVersionNumber(3), 3);
  assert.equal(captureVersionNumber("2"), 2);
  // The four live captures predate the column: absent must mean v1, or their
  // bytes become unreachable.
  assert.equal(captureVersionNumber(null), 1);
  assert.equal(captureVersionNumber(undefined), 1);
  assert.equal(captureVersionNumber(0), 1);
  assert.equal(captureVersionNumber("v2"), 1);
});

// ---------------------------------------------------------------------------
// Create validation
// ---------------------------------------------------------------------------

test("validateCaptureCreate: label, agent, model, prompt and a positive duration are required", () => {
  assert.ok(validateCaptureCreate(null).error);
  assert.ok(validateCaptureCreate("nope").error);
  for (const missing of ["label", "agent", "model", "prompt"]) {
    const body = { ...CREATE };
    delete body[missing];
    assert.ok(validateCaptureCreate(body).error, `${missing} should be required`);
    assert.ok(validateCaptureCreate({ ...CREATE, [missing]: "  " }).error, `blank ${missing} should be rejected`);
  }
  assert.ok(validateCaptureCreate({ ...CREATE, duration_ms: 0 }).error);
  assert.ok(validateCaptureCreate({ ...CREATE, duration_ms: -5 }).error);
  assert.ok(validateCaptureCreate({ ...CREATE, duration_ms: "soon" }).error);
});

test("validateCaptureCreate: the happy path trims, defaults the slug, keeps the facts", () => {
  const v = validateCaptureCreate({
    ...CREATE,
    label: "  A clip  ",
    starter: "geo-01",
    mode: "normal",
    lang: "en",
    shape: "square",
    source_ms: 41_000,
    cut_ms: 30_000,
    speed: 1.5,
    wait_mode: "speed",
    width: 1080,
    height: 1080,
    size_bytes: 12_345,
    ref: "PR #42",
    meta: { output_ms: 8400, linkedin: { ok: true } },
  });
  assert.equal(v.error, undefined);
  assert.equal(v.entry.label, "A clip");
  assert.equal(v.entry.slug, "research__mistral-small__geo-01");
  assert.equal(v.entry.shape, "square");
  assert.equal(v.entry.wait_mode, "speed");
  assert.equal(v.entry.speed, 1.5);
  assert.equal(v.entry.source_ms, 41_000);
  assert.equal(v.entry.cut_ms, 30_000);
  assert.equal(v.entry.width, 1080);
  assert.equal(v.entry.ref, "PR #42");
  assert.deepEqual(JSON.parse(String(v.entry.meta_json)).linkedin, { ok: true });
});

test("validateCaptureCreate: the descriptive fields clamp rather than reject", () => {
  const v = validateCaptureCreate({
    ...CREATE,
    shape: "hexagonal", // unknown -> the default shape
    wait_mode: "blend", // unknown -> the default wait mode
    speed: -3, // nonsense -> 1x
    source_ms: "later", // unparseable -> 0
    width: "wide", // unparseable -> null
    meta: "not an object", // -> no meta rather than a 400
  });
  assert.equal(v.error, undefined);
  assert.equal(v.entry.shape, "portrait");
  assert.equal(v.entry.wait_mode, "cut");
  assert.equal(v.entry.speed, 1);
  assert.equal(v.entry.source_ms, 0);
  assert.equal(v.entry.width, null);
  assert.equal(v.entry.meta_json, null);
  // An absurd speed is clamped into a playable range, not stored verbatim.
  assert.equal(validateCaptureCreate({ ...CREATE, speed: 5_000 }).entry.speed, 64);
});

test("validateCaptureCreate: an oversized meta blob is dropped, not stored", () => {
  const v = validateCaptureCreate({ ...CREATE, meta: { blob: "x".repeat(CAPTURE_CAPS.meta + 10) } });
  assert.equal(v.entry.meta_json, null);
});

test("validateCaptureCreate: a name is always present, and the commit rides along", () => {
  // Given → kept.
  assert.equal(validateCaptureCreate({ ...CREATE, name: "  Elpris  " }).entry.name, "Elpris");
  // Absent → derived from the starter, never empty.
  assert.equal(validateCaptureCreate({ ...CREATE, starter: "res-sv-elpris" }).entry.name, "Elpris");
  assert.ok(validateCaptureCreate(CREATE).entry.name);
  // The commit is what makes a clip reproducible; absent is null, not a guess.
  assert.equal(validateCaptureCreate({ ...CREATE, commit_sha: " abc1234 " }).entry.commit_sha, "abc1234");
  assert.equal(validateCaptureCreate(CREATE).entry.commit_sha, null);
});

// ---------------------------------------------------------------------------
// A new version of the same capture
// ---------------------------------------------------------------------------

test("validateCaptureVersion: a positive duration is required, the rest clamps", () => {
  assert.ok(validateCaptureVersion(null).error);
  assert.ok(validateCaptureVersion({}).error);
  assert.ok(validateCaptureVersion({ duration_ms: 0 }).error);
  const v = validateCaptureVersion({
    duration_ms: 9_000,
    source_ms: 40_000,
    cut_ms: 31_000,
    speed: 5_000, // clamped, not rejected
    wait_mode: "blend", // unknown -> the default
    width: "wide", // unparseable -> null
    commit_sha: "deadbeef",
    model: "mistral-small",
    note: "  re-cut with the dropdown in frame  ",
    meta: { output_ms: 9_000 },
  });
  assert.equal(v.error, undefined);
  assert.equal(v.entry.speed, 64);
  assert.equal(v.entry.wait_mode, "cut");
  assert.equal(v.entry.width, null);
  assert.equal(v.entry.commit_sha, "deadbeef");
  assert.equal(v.entry.note, "re-cut with the dropdown in frame");
  assert.deepEqual(JSON.parse(String(v.entry.meta_json)), { output_ms: 9_000 });
});

test("syntheticVersionRow reads a pre-versions capture as the v1 it is", () => {
  const v1 = syntheticVersionRow(/** @type {any} */ (ROW));
  assert.equal(v1.id, null); // no row of its own — yet
  assert.equal(v1.version, 1);
  assert.equal(v1.capture_id, 7);
  // THE back-compat fact: the unversioned key travels into the v1 row, which
  // is what keeps the four live captures playable.
  assert.equal(v1.video_key, "captures/7/video.mp4");
  assert.equal(v1.poster_key, "captures/7/poster.jpg");
  assert.equal(v1.duration_ms, 8_400);
  assert.equal(v1.speed, 1.5);
});

test("projectCaptureVersion exposes the documented key set and marks the current cut", () => {
  const rows = [
    { id: 2, capture_id: 7, version: 2, created_at: 1_700_000_100_000, video_key: "captures/7/v2/video.mp4" },
    { id: 1, capture_id: 7, version: 1, created_at: 1_700_000_000_000, video_key: null },
  ];
  const [v2, v1] = rows.map((r) => projectCaptureVersion(/** @type {any} */ (r), 2));
  assert.deepEqual(Object.keys(v2).sort(), [
    "commit_sha", "created_at", "cut_ms", "duration_ms", "has_video", "height", "id", "is_current",
    "meta", "model", "note", "poster_url", "size_bytes", "source_ms", "speed", "time", "version",
    "video_url", "wait_mode", "width",
  ]);
  assert.equal(v2.video_url, versionVideoUrl(7, 2));
  assert.equal(v1.poster_url, versionPosterUrl(7, 1));
  assert.equal(v2.is_current, true);
  assert.equal(v1.is_current, false);
  assert.equal(v2.has_video, true);
  assert.equal(v1.has_video, false);
  assert.equal(v1.speed, 1); // absent columns are null-safe
});

// Each cut has to carry its OWN edit report. #CAP-22 showed why: its parent row
// answered with v1's "all six app-e2e checks pass" while playing v2, whose last
// frame is the built app saying it could not get a response. A version's report
// was being written to D1 and never read back.
test("projectCaptureVersion returns each version's own edit report", () => {
  const graded = projectCaptureVersion(
    /** @type {any} */ ({
      id: 2, capture_id: 7, version: 2, created_at: 1_700_000_100_000,
      meta_json: JSON.stringify({ app_e2e: { pass: false, failures: ["app_answers"] } }),
    }),
    2,
  );
  assert.equal(graded.meta.app_e2e.pass, false);
  assert.deepEqual(graded.meta.app_e2e.failures, ["app_answers"]);
  // A cut published without a report says so, rather than borrowing one.
  const ungraded = projectCaptureVersion(
    /** @type {any} */ ({ id: 1, capture_id: 7, version: 1, created_at: 1_700_000_000_000 }),
    2,
  );
  // Empty, not null — the same shape the capture-level `meta` has always had,
  // so a reader needs no second case for "this cut was published without one".
  assert.deepEqual(ungraded.meta, {});
  // Unparseable JSON degrades the same way — a bad report is not a 500.
  const broken = projectCaptureVersion(
    /** @type {any} */ ({ id: 3, capture_id: 7, version: 3, created_at: 1, meta_json: "{not json" }),
    3,
  );
  assert.deepEqual(broken.meta, {});
});

// ---------------------------------------------------------------------------
// The queue of twenty — what the top-up reads
// ---------------------------------------------------------------------------

test("captureQueueStatus counts the deficit against the target of twenty", () => {
  assert.equal(CAPTURE_QUEUE_TARGET, 20);
  const rows = [
    { agent: "research", starter: "res-a", status: "new" },
    { agent: "research", starter: "res-b", status: "new" },
    { agent: "scholar", starter: "sch-a", status: "liked" },
    { agent: "scholar", starter: "sch-b", status: "needs_work" },
    { agent: "introspection", starter: "int-a", status: "new" },
  ];
  const s = captureQueueStatus(rows);
  assert.equal(s.target, 20);
  assert.equal(s.unanswered, 3); // only `new` is on the deck
  assert.equal(s.deficit, 17);
  assert.deepEqual(s.by_agent, { research: 2, introspection: 1 });
  // A full deck asks for nothing, and never a negative number.
  assert.equal(captureQueueStatus(new Array(25).fill({ agent: "a", status: "new" })).deficit, 0);
  assert.equal(captureQueueStatus([], { target: 4 }).deficit, 4);
});

test("captureQueueStatus's `used` list is every (agent, starter) already captured", () => {
  const rows = [
    { agent: "research", starter: "res-a", status: "new" },
    { agent: "research", starter: "res-a", status: "archived" }, // same pair, once
    { agent: "research", starter: "res-b", status: "liked" }, // answered but SPOKEN FOR
    { agent: "scholar", starter: "res-a", status: "new" }, // same starter, other agent
    { agent: "research", starter: null, status: "new" }, // nothing to de-duplicate on
  ];
  const s = captureQueueStatus(rows);
  assert.deepEqual(s.used, [
    { agent: "research", starter: "res-a" },
    { agent: "research", starter: "res-b" },
    { agent: "scholar", starter: "res-a" },
  ]);
  // Named agents with nothing in the queue read as a gap, not an absent key.
  const seeded = captureQueueStatus(rows, { agents: ["research", "scholar", "orchestrator"] });
  assert.deepEqual(seeded.by_agent, { research: 2, scholar: 1, orchestrator: 0 });
  // An agent id is data off a row: it must be a counter, never a prototype.
  const poisoned = captureQueueStatus([{ agent: "__proto__", starter: "x", status: "new" }]);
  assert.equal(poisoned.by_agent.__proto__, 1);
  assert.equal(({}).x, undefined);
});

// ---------------------------------------------------------------------------
// Patch validation
// ---------------------------------------------------------------------------

test("validateCapturePatch: only label/status/ref, empties rejected, status enforced", () => {
  assert.ok(validateCapturePatch(null).error);
  assert.ok(validateCapturePatch({}).error); // nothing to update
  assert.ok(validateCapturePatch({ label: "  " }).error);
  assert.ok(validateCapturePatch({ status: "bogus" }).error);
  // The recording facts are not editable after the fact.
  assert.ok(validateCapturePatch({ prompt: "something else" }).error);
  const v = validateCapturePatch({ label: " Renamed ", status: "archived" });
  assert.deepEqual(Object.keys(v.patch).sort(), ["label", "status"]);
  assert.equal(v.patch.label, "Renamed");
  // ref can be cleared with null.
  assert.equal(validateCapturePatch({ ref: null }).patch.ref, null);
});

// ---------------------------------------------------------------------------
// THE product rule — the swipe
// ---------------------------------------------------------------------------

test("validateCaptureReview: a right swipe (like) needs no words", () => {
  const v = validateCaptureReview({ verdict: "like" });
  assert.equal(v.error, undefined);
  assert.equal(v.verdict, "like");
  assert.equal(v.note, null);
  assert.equal(validateCaptureReview({ verdict: "like", note: "  crisp  " }).note, "crisp");
});

test("validateCaptureReview: a LEFT swipe (feedback) without a note is rejected", () => {
  // The product rule: the client shows a feedback field precisely because the
  // server will not accept the verdict without one — a left swipe with no
  // words re-produces the same clip on the next run.
  for (const body of [
    { verdict: "feedback" },
    { verdict: "feedback", note: "" },
    { verdict: "feedback", note: "   " },
    { verdict: "feedback", note: null },
  ]) {
    const v = validateCaptureReview(body);
    assert.ok(v.error, `expected a rejection for ${JSON.stringify(body)}`);
    assert.match(v.error, /note/i);
  }
  const ok = validateCaptureReview({ verdict: "feedback", note: " the model dropdown is cut off " });
  assert.equal(ok.error, undefined);
  assert.equal(ok.note, "the model dropdown is cut off");
});

test("validateCaptureReview: only the two verdicts", () => {
  assert.ok(validateCaptureReview(null).error);
  assert.ok(validateCaptureReview({ verdict: "dislike" }).error);
  assert.ok(validateCaptureReview({ verdict: "" }).error);
});

// ---------------------------------------------------------------------------
// Projection — the contract the review feed reads
// ---------------------------------------------------------------------------

const ROW = {
  id: 7,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
  slug: "research__mistral-small__geo-01",
  label: "Geothermal",
  agent: "research",
  mode: "normal",
  model: "mistral-small",
  prompt: "How much of Iceland's electricity comes from geothermal?",
  starter: "geo-01",
  lang: "en",
  shape: "portrait",
  duration_ms: 8_400,
  source_ms: 41_000,
  cut_ms: 30_000,
  speed: 1.5,
  wait_mode: "speed",
  width: 1080,
  height: 1350,
  size_bytes: 3_145_728,
  video_key: "captures/7/video.mp4",
  poster_key: "captures/7/poster.jpg",
  status: "new",
  likes: 0,
  ref: "PR #42",
  meta_json: '{"output_ms":8400}',
};

// The client depends on this exact key set — a missing key is a blank card,
// an extra one is drift nobody notices until the deck stops rendering.
// `versions` is NOT in this list: it is attached only when the caller asked
// for the thread (see the version tests below), so the list view's cards do
// not carry a key that would always be an empty array.
const PROJECTED_KEYS = [
  "id", "tag", "created_at", "updated_at", "time", "slug", "label", "name", "agent", "mode", "model",
  "prompt", "starter", "lang", "shape", "duration_ms", "source_ms", "cut_ms", "speed", "wait_mode",
  "width", "height", "size_bytes", "status", "likes", "ref", "commit_sha", "version", "answered_at",
  "answered", "has_video", "has_poster", "video_url", "poster_url", "meta", "reviews",
];

test("projectCapture exposes exactly the documented key set", () => {
  assert.deepEqual(Object.keys(projectCapture(ROW)).sort(), [...PROJECTED_KEYS].sort());
});

test("projectCapture builds the media URLs and the has_* flags", () => {
  const p = projectCapture(ROW);
  assert.equal(p.video_url, "/api/admin/captures/7/video");
  assert.equal(p.poster_url, "/api/admin/captures/7/poster");
  assert.equal(videoUrl(7), p.video_url);
  assert.equal(posterUrl(7), p.poster_url);
  assert.equal(p.has_video, true);
  assert.equal(p.has_poster, true);
  assert.equal(typeof p.time, "string");
  assert.deepEqual(p.meta, { output_ms: 8400 });
  assert.deepEqual(p.reviews, []);
});

test("projectCapture survives null/absent optional columns", () => {
  const bare = {
    id: 1,
    created_at: 0,
    updated_at: 0,
    slug: "s",
    label: "L",
    agent: "research",
    model: "m",
    prompt: "p",
    status: "new",
    // every optional column absent, and no keys at all rather than nulls
  };
  const p = projectCapture(/** @type {any} */ (bare));
  assert.deepEqual(Object.keys(p).sort(), [...PROJECTED_KEYS].sort());
  assert.equal(p.mode, null);
  assert.equal(p.starter, null);
  assert.equal(p.lang, null);
  assert.equal(p.shape, null);
  assert.equal(p.wait_mode, null);
  assert.equal(p.width, null);
  assert.equal(p.height, null);
  assert.equal(p.ref, null);
  assert.equal(p.duration_ms, 0);
  assert.equal(p.source_ms, 0);
  assert.equal(p.cut_ms, 0);
  assert.equal(p.size_bytes, 0);
  assert.equal(p.likes, 0);
  assert.equal(p.speed, 1);
  assert.equal(p.has_video, false);
  assert.equal(p.has_poster, false);
  // Still linkable: the URLs describe where bytes WOULD be served from.
  assert.equal(p.video_url, "/api/admin/captures/1/video");
  assert.deepEqual(p.meta, {});
  // A row written before the queue existed: no name, no commit, never
  // answered — and version 1, because that is what it is.
  assert.equal(p.name, null);
  assert.equal(p.commit_sha, null);
  assert.equal(p.version, 1);
  assert.equal(p.answered_at, null);
  assert.equal(p.answered, false);
  assert.equal(p.tag, "#CAP-1");
});

test("projectCapture tolerates malformed meta_json", () => {
  assert.deepEqual(projectCapture({ ...ROW, meta_json: "not json" }).meta, {});
  assert.deepEqual(projectCapture({ ...ROW, meta_json: "[1,2]" }).meta, [1, 2]);
});

test("projectCaptureReview normalizes an unknown verdict", () => {
  const r = projectCaptureReview({
    id: 3,
    capture_id: 7,
    created_at: 1_700_000_000_000,
    verdict: "like",
    note: null,
    reviewer: "owner",
  });
  assert.deepEqual(Object.keys(r).sort(), ["created_at", "id", "note", "reviewer", "time", "verdict"]);
  assert.equal(r.verdict, "like");
  assert.equal(r.note, null);
  assert.equal(r.reviewer, "owner");
  // A row written by something that did not know the vocabulary reads as
  // feedback (the verdict that carries words) rather than as a like.
  assert.equal(
    projectCaptureReview({ id: 4, capture_id: 7, created_at: 0, verdict: "shrug" }).verdict,
    "feedback",
  );
});

// ---------------------------------------------------------------------------
// ?format=text
// ---------------------------------------------------------------------------

test("formatCapturesText renders the run, the prompt, the edit and every note", () => {
  const p = projectCapture(ROW);
  p.reviews = [
    projectCaptureReview({
      id: 1,
      capture_id: 7,
      created_at: 1_700_000_002_000,
      verdict: "feedback",
      note: "the model dropdown is cut off at the top",
      reviewer: null,
    }),
  ];
  const txt = formatCapturesText([p]);
  assert.match(txt, /── #CAP-7 \[new\] Geothermal/);
  assert.match(txt, /THREAD: v1 · UNANSWERED/);
  assert.match(txt, /RUN: research · mistral-small/);
  assert.match(txt, /mode normal/);
  assert.match(txt, /PROMPT: How much of Iceland/);
  assert.match(txt, /EDIT: 8s final · 41s recorded · 30s cut · 1\.5x · waits speed/);
  assert.match(txt, /VIDEO: \/api\/admin\/captures\/7\/video \(3 MB\) · 1080x1350 · poster/);
  assert.match(txt, /REF: PR #42/);
  assert.match(txt, /REVIEWS:/);
  assert.match(txt, /✍️ needs work \(.+\) — the model dropdown is cut off/);
  assert.equal(formatCapturesText([]), "(no captures match)\n");
});

test("formatCapturesText says so when no bytes have been uploaded", () => {
  const p = projectCapture({ ...ROW, video_key: null, poster_key: null, likes: 2 });
  const txt = formatCapturesText([p]);
  assert.match(txt, /VIDEO: no video uploaded/);
  assert.match(txt, /LIKES: 2/);
});

// ---------------------------------------------------------------------------
// Range parsing — the <video> element scrubbing the deck
// ---------------------------------------------------------------------------

test("parseRange: open-ended, closed and suffix forms", () => {
  assert.deepEqual(parseRange("bytes=0-", 1000), { offset: 0, length: 1000, end: 999 });
  assert.deepEqual(parseRange("bytes=100-199", 1000), { offset: 100, length: 100, end: 199 });
  assert.deepEqual(parseRange("bytes=-500", 1000), { offset: 500, length: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { offset: 900, length: 100, end: 999 });
  assert.deepEqual(parseRange(" BYTES=0-0 ", 1000), { offset: 0, length: 1, end: 0 });
  // A suffix longer than the file is the whole file, not an error.
  assert.deepEqual(parseRange("bytes=-5000", 1000), { offset: 0, length: 1000, end: 999 });
  // An end past the last byte is clamped, which is what every player sends.
  assert.deepEqual(parseRange("bytes=990-99999", 1000), { offset: 990, length: 10, end: 999 });
});

test("parseRange: malformed headers yield null (ignore the header, send it all)", () => {
  for (const h of [
    "",
    "items=0-10",
    "bytes=",
    "bytes=-",
    "bytes=abc-def",
    "bytes 0-10",
    "bytes=0-10,20-30", // multi-range: we never answer multipart/byteranges
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseRange(/** @type {any} */ (h), 1000), null, `expected null for ${JSON.stringify(h)}`);
  }
});

test("parseRange: out-of-range and impossible requests yield null", () => {
  assert.equal(parseRange("bytes=1000-1200", 1000), null); // starts past the end
  assert.equal(parseRange("bytes=5000-", 1000), null);
  assert.equal(parseRange("bytes=200-100", 1000), null); // end before start
  assert.equal(parseRange("bytes=-0", 1000), null); // a zero-length suffix
  assert.equal(parseRange("bytes=0-", 0), null); // nothing stored
  assert.equal(parseRange("bytes=0-", /** @type {any} */ ("big")), null);
});

// ---------------------------------------------------------------------------
// The handler, over a fake D1 (the combined-D1-fake technique)
// ---------------------------------------------------------------------------

// Enough of D1 to run this module's SQL: a captures table, a capture_reviews
// table, a capture_versions table, and the generic UPDATE applier the
// PATCH/review/version paths need. Deliberately narrow — it interprets the
// statements src/captures.js actually issues.
//
// `seedVersions` rows are (capture_id, version, …) partials: a capture with no
// seeded versions is one recorded BEFORE the table existed, which is exactly
// the state of the four live captures.
function fakeDb(seed = [], seedVersions = []) {
  const captures = seed.map((r, i) => ({
    id: i + 1,
    created_at: 1_000,
    updated_at: 1_000,
    slug: "s",
    label: "L",
    name: null,
    commit_sha: null,
    version: 1,
    answered_at: null,
    agent: "research",
    mode: "normal",
    model: "m",
    prompt: "p",
    starter: null,
    lang: "en",
    shape: "portrait",
    duration_ms: 1_000,
    source_ms: 2_000,
    cut_ms: 1_000,
    speed: 1,
    wait_mode: "cut",
    width: null,
    height: null,
    size_bytes: 0,
    video_key: null,
    poster_key: null,
    status: "new",
    likes: 0,
    ref: null,
    meta_json: null,
    ...r,
  }));
  const reviews = [];
  const versions = seedVersions.map((r, i) => ({
    id: i + 1,
    capture_id: 1,
    version: 1,
    created_at: 1_000,
    commit_sha: null,
    model: "m",
    video_key: null,
    poster_key: null,
    size_bytes: 0,
    duration_ms: 1_000,
    source_ms: 2_000,
    cut_ms: 1_000,
    speed: 1,
    wait_mode: "cut",
    width: null,
    height: null,
    note: null,
    meta_json: null,
    ...r,
  }));
  // `UPDATE … SET a = ?, b = NULL, c = 'new', likes = likes + ?` — the four
  // right-hand sides this module's statements actually use.
  const applySet = (row, clause, binds) => {
    for (const assign of clause.split(",")) {
      const eq = assign.indexOf("=");
      const col = assign.slice(0, eq).trim();
      const expr = assign.slice(eq + 1).trim();
      if (expr === "?") row[col] = binds.shift();
      else if (expr === "NULL") row[col] = null;
      else if (/^'.*'$/.test(expr)) row[col] = expr.slice(1, -1);
      else if (/^likes \+ \?$/.test(expr)) row.likes = (row.likes || 0) + Number(binds.shift());
    }
  };
  const db = {
    captures,
    reviews,
    versions,
    batch: async () => [],
    prepare(sql) {
      return {
        _sql: String(sql),
        /** @type {any[]} */
        _binds: [],
        bind(...b) {
          this._binds = b;
          return this;
        },
        async first() {
          if (/SELECT \* FROM captures WHERE id = \?/.test(this._sql)) {
            return captures.find((c) => c.id === this._binds[0]) || null;
          }
          if (/COUNT\(\*\) AS n FROM captures/.test(this._sql)) {
            return { n: captures.filter((c) => c.status === "new").length };
          }
          return null;
        },
        async all() {
          const binds = [...this._binds];
          if (/FROM capture_reviews/.test(this._sql)) {
            return { results: reviews.filter((r) => binds.includes(r.capture_id)).sort((a, b) => a.id - b.id) };
          }
          if (/FROM capture_versions/.test(this._sql)) {
            return {
              results: versions.filter((v) => v.capture_id === binds[0]).sort((a, b) => b.version - a.version),
            };
          }
          const limit = binds.pop();
          let rows = captures.slice().sort((a, b) => b.id - a.id);
          if (/status = 'new'/.test(this._sql)) rows = rows.filter((r) => r.status === "new");
          if (/status = \?/.test(this._sql)) {
            const v = binds.shift();
            rows = rows.filter((r) => r.status === v);
          }
          if (/agent = \?/.test(this._sql)) {
            const v = binds.shift();
            rows = rows.filter((r) => r.agent === v);
          }
          if (/model = \?/.test(this._sql)) {
            const v = binds.shift();
            rows = rows.filter((r) => r.model === v);
          }
          if (/label LIKE/.test(this._sql)) {
            const v = String(binds.shift()).replace(/%/g, "");
            binds.shift();
            rows = rows.filter((r) => `${r.label} ${r.prompt}`.toLowerCase().includes(v.toLowerCase()));
          }
          return { results: rows.slice(0, limit) };
        },
        async run() {
          const binds = [...this._binds];
          if (/^INSERT INTO captures/.test(this._sql)) {
            const [
              created_at, updated_at, slug, label, name, agent, mode, model, prompt, starter, lang, shape,
              duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, size_bytes, commit_sha,
              ref, meta_json,
            ] = binds;
            const row = {
              id: captures.length ? Math.max(...captures.map((c) => c.id)) + 1 : 1,
              created_at, updated_at, slug, label, name, agent, mode, model, prompt, starter, lang, shape,
              duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, size_bytes, commit_sha,
              video_key: null, poster_key: null, version: 1, answered_at: null,
              status: "new", likes: 0, ref, meta_json,
            };
            captures.push(row);
            return { meta: { last_row_id: row.id } };
          }
          if (/^INSERT INTO capture_reviews/.test(this._sql)) {
            const [capture_id, created_at, verdict, note, reviewer] = binds;
            reviews.push({ id: reviews.length + 1, capture_id, created_at, verdict, note, reviewer });
            return { meta: { last_row_id: reviews.length } };
          }
          if (/^INSERT INTO capture_versions/.test(this._sql)) {
            // Two shapes: materializeV1 pins `VALUES (?, 1, …)` and carries the
            // media keys; a new cut binds its own number and no keys at all.
            const row = /VALUES \(\?, 1,/.test(this._sql)
              ? (() => {
                  const [
                    capture_id, created_at, commit_sha, model, video_key, poster_key, size_bytes,
                    duration_ms, source_ms, cut_ms, speed, wait_mode, width, height,
                  ] = binds;
                  return {
                    capture_id, version: 1, created_at, commit_sha, model, video_key, poster_key,
                    size_bytes, duration_ms, source_ms, cut_ms, speed, wait_mode, width, height,
                    note: null, meta_json: null,
                  };
                })()
              : (() => {
                  const [
                    capture_id, version, created_at, commit_sha, model, size_bytes, duration_ms,
                    source_ms, cut_ms, speed, wait_mode, width, height, note, meta_json,
                  ] = binds;
                  return {
                    capture_id, version, created_at, commit_sha, model, video_key: null, poster_key: null,
                    size_bytes, duration_ms, source_ms, cut_ms, speed, wait_mode, width, height,
                    note, meta_json,
                  };
                })();
            versions.push({ id: versions.length + 1, ...row });
            return { meta: { last_row_id: versions.length } };
          }
          // The set-once stamp: it must not touch a capture that already has one.
          const stamp = this._sql.match(/^UPDATE captures SET (.+) WHERE id = \? AND answered_at IS NULL$/s);
          if (stamp) {
            const row = captures.find((c) => c.id === binds[1]);
            if (row && row.answered_at == null) applySet(row, stamp[1], [binds[0]]);
            return {};
          }
          const upd = this._sql.match(/^UPDATE captures SET (.+) WHERE id = \?$/s);
          if (upd) {
            const id = binds.pop();
            const row = captures.find((c) => c.id === id);
            if (row) applySet(row, upd[1], binds);
            return {};
          }
          const updV = this._sql.match(/^UPDATE capture_versions SET (.+) WHERE capture_id = \? AND version = \?$/s);
          if (updV) {
            const version = binds.pop();
            const capture_id = binds.pop();
            const row = versions.find((v) => v.capture_id === capture_id && v.version === version);
            if (row) applySet(row, updV[1], binds);
            return {};
          }
          // ONE review row, by its own id — the undo. Matched before the
          // by-capture delete below, which would otherwise read a review id as
          // a capture id and wipe the wrong thread.
          if (/^DELETE FROM capture_reviews WHERE id = \?/.test(this._sql)) {
            const i = reviews.findIndex((r) => r.id === binds[0]);
            if (i >= 0) reviews.splice(i, 1);
            return {};
          }
          if (/^DELETE FROM capture_reviews/.test(this._sql)) {
            for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].capture_id === binds[0]) reviews.splice(i, 1);
            return {};
          }
          if (/^DELETE FROM capture_versions/.test(this._sql)) {
            for (let i = versions.length - 1; i >= 0; i--) {
              if (versions[i].capture_id === binds[0]) versions.splice(i, 1);
            }
            return {};
          }
          if (/^DELETE FROM captures/.test(this._sql)) {
            const i = captures.findIndex((c) => c.id === binds[0]);
            if (i >= 0) captures.splice(i, 1);
            return {};
          }
          return {};
        },
      };
    },
  };
  return db;
}

const LOG = { info() {}, warn() {}, debug() {}, error() {} };

/**
 * Run one request through the handler.
 * @param {any} db
 * @param {string} method
 * @param {string} path e.g. "/api/admin/captures?queue=1"
 * @param {any} [body]
 * @param {any} [extraEnv]
 */
async function call(db, method, path, body, extraEnv = {}) {
  const url = new URL(`https://deepresearch.se${path}`);
  const init = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await handleAdminCaptures(new Request(url, init), { DB: db, ...extraEnv }, url, LOG);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text view */
  }
  return { res, json, text };
}

test("GET /captures lists newest first; ?queue=1 is the un-swiped deck", async () => {
  const db = fakeDb([
    { label: "one", status: "liked", agent: "research", model: "a" },
    { label: "two", status: "new", agent: "scholar", model: "b" },
    { label: "three", status: "new", agent: "research", model: "b" },
  ]);
  const all = await call(db, "GET", "/api/admin/captures");
  assert.equal(all.res.status, 200);
  assert.equal(all.json.count, 3);
  assert.deepEqual(all.json.captures.map((c) => c.label), ["three", "two", "one"]);

  const queue = await call(db, "GET", "/api/admin/captures?queue=1");
  assert.deepEqual(queue.json.captures.map((c) => c.label), ["three", "two"]);

  const byAgent = await call(db, "GET", "/api/admin/captures?agent=research&status=new");
  assert.deepEqual(byAgent.json.captures.map((c) => c.label), ["three"]);

  const byModel = await call(db, "GET", "/api/admin/captures?model=b");
  assert.equal(byModel.json.count, 2);

  const text = await call(db, "GET", "/api/admin/captures?queue=1&format=text");
  assert.match(text.res.headers.get("content-type") || "", /text\/plain/);
  assert.match(text.text, /── #CAP-3 \[new\] three/);
});

test("GET /captures?q= matches the label OR the prompt", async () => {
  const db = fakeDb([
    { label: "geothermal clip", prompt: "unrelated" },
    { label: "unrelated", prompt: "how much geothermal electricity" },
    { label: "nothing", prompt: "nothing" },
  ]);
  const hits = await call(db, "GET", "/api/admin/captures?q=geothermal");
  assert.equal(hits.json.count, 2);
});

test("POST /captures creates the row and hands back both upload URLs", async () => {
  const db = fakeDb();
  const bad = await call(db, "POST", "/api/admin/captures", { label: "no agent" });
  assert.equal(bad.res.status, 400);
  assert.ok(bad.json.error);

  const created = await call(db, "POST", "/api/admin/captures", { ...CREATE, starter: "geo-01" });
  assert.equal(created.res.status, 201);
  const id = created.json.capture.id;
  assert.equal(created.json.capture.status, "new");
  assert.equal(created.json.capture.has_video, false);
  assert.deepEqual(created.json.upload, {
    video: `/api/admin/captures/${id}/video`,
    poster: `/api/admin/captures/${id}/poster`,
  });
  assert.equal(db.captures.length, 1);
});

test("GET/PATCH/DELETE /captures/:id, and 404 for a clip that is not there", async () => {
  const db = fakeDb([{ label: "one" }]);
  const missing = await call(db, "GET", "/api/admin/captures/99");
  assert.equal(missing.res.status, 404);

  const one = await call(db, "GET", "/api/admin/captures/1");
  assert.equal(one.json.capture.label, "one");
  assert.deepEqual(one.json.capture.reviews, []);

  const patched = await call(db, "PATCH", "/api/admin/captures/1", { label: "renamed", status: "archived" });
  assert.equal(patched.json.capture.label, "renamed");
  assert.equal(patched.json.capture.status, "archived");
  assert.ok(patched.json.capture.updated_at >= 1_000);

  const badPatch = await call(db, "PATCH", "/api/admin/captures/1", { status: "nope" });
  assert.equal(badPatch.res.status, 400);

  const deleted = await call(db, "DELETE", "/api/admin/captures/1");
  assert.equal(deleted.res.status, 200);
  assert.equal(db.captures.length, 0);
});

test("POST /captures/:id/review — a right swipe likes it, and the reviews come back attached", async () => {
  const db = fakeDb([{ label: "one" }]);
  const liked = await call(db, "POST", "/api/admin/captures/1/review", { verdict: "like", reviewer: "owner" });
  assert.equal(liked.res.status, 201);
  assert.equal(liked.json.capture.status, "liked");
  assert.equal(liked.json.capture.likes, 1);
  assert.equal(liked.json.capture.reviews.length, 1);
  assert.equal(liked.json.capture.reviews[0].verdict, "like");
  assert.equal(liked.json.capture.reviews[0].reviewer, "owner");

  // A second like on the same clip appends rather than replacing.
  const again = await call(db, "POST", "/api/admin/captures/1/review", { verdict: "like" });
  assert.equal(again.json.capture.likes, 2);
  assert.equal(again.json.capture.reviews.length, 2);
});

test("POST /captures/:id/review — a LEFT swipe without a note is a 400 and writes nothing", async () => {
  const db = fakeDb([{ label: "one" }]);
  const shrug = await call(db, "POST", "/api/admin/captures/1/review", { verdict: "feedback" });
  assert.equal(shrug.res.status, 400);
  assert.match(shrug.json.error, /note/i);
  assert.equal(db.reviews.length, 0);
  assert.equal(db.captures[0].status, "new"); // untouched — still on the deck

  const sent = await call(db, "POST", "/api/admin/captures/1/review", {
    verdict: "feedback",
    note: "the answer is unreadable at 2x",
  });
  assert.equal(sent.res.status, 201);
  assert.equal(sent.json.capture.status, "needs_work");
  assert.equal(sent.json.capture.likes, 0); // feedback never bumps the counter
  assert.equal(sent.json.capture.reviews[0].note, "the answer is unreadable at 2x");
});

test("DELETE /captures/:id/review — the undo puts a mis-swiped clip back on the queue", async () => {
  // The directive this serves (2026-08-13): "revert the one I just swiped
  // right". A right swipe is a fast gesture with a permanent effect, so the
  // whole of it has to come back — the row, the counter and the status.
  const db = fakeDb([{ label: "one" }]);
  await call(db, "POST", "/api/admin/captures/1/review", { verdict: "like" });
  assert.equal(db.captures[0].status, "liked");
  assert.ok(db.captures[0].answered_at, "the first verdict stamps answered_at");

  const undone = await call(db, "DELETE", "/api/admin/captures/1/review");
  assert.equal(undone.res.status, 200);
  assert.equal(undone.json.undone.verdict, "like");
  assert.equal(undone.json.capture.status, "new", "back on the queue");
  assert.equal(undone.json.capture.likes, 0, "the like is un-counted, not just hidden");
  assert.deepEqual(undone.json.capture.reviews, [], "the verdict is gone from the thread");
  // The stamp is cleared ONLY here — with no verdict left it describes
  // something that did not happen, and leaving it would keep this capture out
  // of the top-up's unanswered count forever.
  assert.equal(undone.json.capture.answered_at, null);
  assert.equal(undone.json.capture.answered, false);
  assert.equal(db.reviews.length, 0);
});

test("DELETE /captures/:id/review — only the LAST verdict, restoring the one before it", async () => {
  const db = fakeDb([{ label: "one" }]);
  await call(db, "POST", "/api/admin/captures/1/review", { verdict: "feedback", note: "too fast" });
  await call(db, "POST", "/api/admin/captures/1/review", { verdict: "like" });
  assert.equal(db.captures[0].status, "liked");

  const undone = await call(db, "DELETE", "/api/admin/captures/1/review");
  assert.equal(undone.json.capture.status, "needs_work", "the verdict before it stands again");
  assert.equal(undone.json.capture.likes, 0);
  assert.equal(undone.json.capture.reviews.length, 1);
  assert.equal(undone.json.capture.reviews[0].note, "too fast");
  // Undo is for the swipe just made, not a way to erase a clip's history: the
  // thread is the whole input to the re-record loop. The stamp stays, because
  // this capture HAS been answered.
  assert.ok(undone.json.capture.answered_at);
});

test("DELETE /captures/:id/review — nothing to undo is a 404, not a silent no-op", async () => {
  const db = fakeDb([{ label: "one" }]);
  const nothing = await call(db, "DELETE", "/api/admin/captures/1/review");
  assert.equal(nothing.res.status, 404);
  assert.match(nothing.json.error, /nothing to undo/i);
  assert.equal(db.captures[0].status, "new");
  // And an undo on a capture that does not exist is the module's usual 404.
  assert.equal((await call(db, "DELETE", "/api/admin/captures/99/review")).res.status, 404);
});

test("the byte endpoints answer 503 without R2, and the metadata board still works", async () => {
  const db = fakeDb([{ label: "one" }]);
  for (const [method, path] of [
    ["GET", "/api/admin/captures/1/video"],
    ["GET", "/api/admin/captures/1/poster"],
  ]) {
    const r = await call(db, method, path);
    assert.equal(r.res.status, 503, `${method} ${path}`);
    assert.match(r.json.error, /R2|storage/i);
  }
  const put = await handleAdminCaptures(
    new Request("https://deepresearch.se/api/admin/captures/1/video", {
      method: "PUT",
      body: new Uint8Array([0, 1, 2]),
      headers: { "content-type": "video/mp4" },
    }),
    { DB: db },
    new URL("https://deepresearch.se/api/admin/captures/1/video"),
    LOG,
  );
  assert.equal(put.status, 503);
  // The board itself is unaffected.
  assert.equal((await call(db, "GET", "/api/admin/captures")).json.count, 1);
});

test("PUT /captures/:id/video: the content-type is required and the cap is enforced", async () => {
  const db = fakeDb([{ label: "one" }]);
  const stored = new Map();
  const STORAGE = {
    async put(key, bytes) {
      stored.set(key, bytes);
    },
    async head(key) {
      return stored.has(key) ? { size: stored.get(key).byteLength } : null;
    },
    async get(key) {
      return stored.has(key) ? { body: stored.get(key) } : null;
    },
    async delete(key) {
      stored.delete(key);
    },
  };
  const url = new URL("https://deepresearch.se/api/admin/captures/1/video");
  /** @param {any} headers @param {any} [body] */
  const put = (headers, body = new Uint8Array([1, 2, 3, 4])) =>
    handleAdminCaptures(new Request(url, { method: "PUT", body, headers }), { DB: db, STORAGE }, url, LOG);

  assert.equal((await put({})).status, 415); // no content-type at all
  assert.equal((await put({ "content-type": "application/octet-stream" })).status, 415);
  assert.equal(
    (await put({ "content-type": "video/mp4", "content-length": String(CAPTURE_CAPS.video_bytes + 1) })).status,
    413,
  );

  const ok = await put({ "content-type": "video/mp4; codecs=avc1" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.capture.has_video, true);
  assert.equal(body.capture.size_bytes, 4);
  // The unversioned PUT is the CURRENT version's PUT — v1 here.
  assert.ok(stored.has("captures/1/v1/video.mp4"));

  // And the delete takes the object with it.
  await call(db, "DELETE", "/api/admin/captures/1", undefined, { STORAGE });
  assert.equal(stored.has("captures/1/v1/video.mp4"), false);
});

test("GET /captures/:id/video answers a Range request with a 206 and a content-range", async () => {
  const db = fakeDb([{ label: "one", video_key: "captures/1/video.mp4", size_bytes: 1_000 }]);
  const STORAGE = {
    async head() {
      return { size: 1_000 };
    },
    async get(key, opts) {
      return { body: `bytes:${opts?.range?.offset ?? 0}+${opts?.range?.length ?? 1000}` };
    },
    async put() {},
    async delete() {},
  };
  const url = new URL("https://deepresearch.se/api/admin/captures/1/video");
  const ranged = await handleAdminCaptures(
    new Request(url, { headers: { range: "bytes=100-199" } }),
    { DB: db, STORAGE },
    url,
    LOG,
  );
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 100-199/1000");
  assert.equal(ranged.headers.get("content-length"), "100");
  assert.equal(ranged.headers.get("accept-ranges"), "bytes");
  assert.equal(ranged.headers.get("content-type"), "video/mp4");

  const whole = await handleAdminCaptures(new Request(url), { DB: db, STORAGE }, url, LOG);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-length"), "1000");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");

  // A malformed Range is ignored (whole object, 200), never a 500.
  const bad = await handleAdminCaptures(
    new Request(url, { headers: { range: "bytes=abc" } }),
    { DB: db, STORAGE },
    url,
    LOG,
  );
  assert.equal(bad.status, 200);
});

test("GET /captures/:id/video 404s when no bytes were ever uploaded", async () => {
  const db = fakeDb([{ label: "one" }]);
  const STORAGE = { async head() { return null; }, async get() { return null; }, async put() {}, async delete() {} };
  const r = await call(db, "GET", "/api/admin/captures/1/video", undefined, { STORAGE });
  assert.equal(r.res.status, 404);
});

test("unknown sub-paths and methods 404 rather than falling through", async () => {
  const db = fakeDb([{ label: "one" }]);
  assert.equal((await call(db, "GET", "/api/admin/captures/1/thumbnail")).res.status, 404);
  assert.equal((await call(db, "GET", "/api/admin/captures/nope")).res.status, 404);
  assert.equal((await call(db, "PUT", "/api/admin/captures/1")).res.status, 404);
});

test("the surface answers 503 when D1 is absent", async () => {
  const url = new URL("https://deepresearch.se/api/admin/captures");
  const res = await handleAdminCaptures(new Request(url), /** @type {any} */ ({}), url, LOG);
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// The thread: versions over the wire
// ---------------------------------------------------------------------------

// The R2 double the version tests share: a Map with the four methods this
// module calls, so what ended up under which key is directly assertable.
function fakeStorage(seed = {}) {
  const stored = new Map(Object.entries(seed));
  return {
    stored,
    async put(key, bytes) {
      stored.set(key, bytes);
    },
    async head(key) {
      return stored.has(key) ? { size: stored.get(key).byteLength ?? stored.get(key).length } : null;
    },
    async get(key) {
      return stored.has(key) ? { body: stored.get(key) } : null;
    },
    async delete(key) {
      stored.delete(key);
    },
  };
}

test("POST /captures/:id/versions allocates max+1 and puts the capture back on the deck", async () => {
  const db = fakeDb([{ label: "one", status: "needs_work", answered_at: 5_000, version: 1 }]);
  const bad = await call(db, "POST", "/api/admin/captures/1/versions", { speed: 2 });
  assert.equal(bad.res.status, 400); // no duration: a zero-length re-cut is a failed edit

  const v2 = await call(db, "POST", "/api/admin/captures/1/versions", {
    duration_ms: 9_000,
    source_ms: 40_000,
    commit_sha: "abc1234",
    note: "the dropdown is in frame now",
  });
  assert.equal(v2.res.status, 201);
  assert.equal(v2.json.capture.version, 2);
  assert.equal(v2.json.capture.commit_sha, "abc1234");
  // Back on the queue — but still marked as having been answered once, which
  // is what tells the top-up this is a re-cut and not a fresh capture.
  assert.equal(v2.json.capture.status, "new");
  assert.equal(v2.json.capture.answered_at, 5_000);
  assert.equal(v2.json.capture.answered, true);
  assert.deepEqual(v2.json.upload, {
    video: "/api/admin/captures/1/versions/2/video",
    poster: "/api/admin/captures/1/versions/2/poster",
  });
  // The bytes of the new cut are not there yet, so the card is not playable.
  assert.equal(v2.json.capture.has_video, false);

  const v3 = await call(db, "POST", "/api/admin/captures/1/versions", { duration_ms: 7_000 });
  assert.equal(v3.json.capture.version, 3);
  // max+1 over what exists — never a count, never a reuse.
  assert.deepEqual(db.versions.map((v) => v.version).sort(), [1, 2, 3]);
});

test("a new version RETAINS the older ones, bytes and all", async () => {
  const db = fakeDb([{ label: "one", video_key: "captures/1/video.mp4", size_bytes: 1_000, duration_ms: 8_000 }]);
  const STORAGE = fakeStorage({ "captures/1/video.mp4": new Uint8Array(1_000) });

  await call(db, "POST", "/api/admin/captures/1/versions", { duration_ms: 9_000 }, { STORAGE });
  // The pre-versions v1 became a real row, carrying the OLD unversioned key.
  const v1 = db.versions.find((v) => v.version === 1);
  assert.ok(v1, "v1 must be materialised before the parent row is overwritten");
  assert.equal(v1.video_key, "captures/1/video.mp4");
  assert.equal(v1.duration_ms, 8_000);
  // And its bytes were not touched.
  assert.ok(STORAGE.stored.has("captures/1/video.mp4"));

  const one = await call(db, "GET", "/api/admin/captures/1", undefined, { STORAGE });
  assert.deepEqual(one.json.capture.versions.map((v) => v.version), [2, 1]); // newest first
  assert.equal(one.json.capture.versions[0].is_current, true);
  assert.equal(one.json.capture.versions[1].video_url, "/api/admin/captures/1/versions/1/video");

  // The old cut still plays at its own path…
  const old = await call(db, "GET", "/api/admin/captures/1/versions/1/video", undefined, { STORAGE });
  assert.equal(old.res.status, 200);
  // …while the current version has no bytes yet, which is a 404 rather than
  // silently serving the previous cut.
  const current = await call(db, "GET", "/api/admin/captures/1/versions/2/video", undefined, { STORAGE });
  assert.equal(current.res.status, 404);
});

test("the v1 back-compat fallback: a capture with no version rows still plays", async () => {
  // Exactly the shape of the four live captures: bytes at the unversioned key,
  // no capture_versions rows, no name, no commit, no answer.
  const db = fakeDb([{ label: "live one", video_key: "captures/1/video.mp4", poster_key: "captures/1/poster.jpg" }]);
  const STORAGE = fakeStorage({
    "captures/1/video.mp4": new Uint8Array(1_000),
    "captures/1/poster.jpg": new Uint8Array(10),
  });
  for (const path of [
    "/api/admin/captures/1/video",
    "/api/admin/captures/1/poster",
    "/api/admin/captures/1/versions/1/video",
    "/api/admin/captures/1/versions/1/poster",
  ]) {
    const r = await call(db, "GET", path, undefined, { STORAGE });
    assert.equal(r.res.status, 200, path);
  }
  // The thread reads as a single synthetic v1 — no rows, but not empty either.
  const versions = await call(db, "GET", "/api/admin/captures/1/versions", undefined, { STORAGE });
  assert.equal(versions.json.versions.length, 1);
  assert.equal(versions.json.versions[0].id, null);
  assert.equal(versions.json.versions[0].version, 1);
  assert.equal(versions.json.versions[0].has_video, true);
  assert.equal(versions.json.tag, "#CAP-1");
  // A version that does not exist is a legible 404, not a throw.
  const missing = await call(db, "GET", "/api/admin/captures/1/versions/4/video", undefined, { STORAGE });
  assert.equal(missing.res.status, 404);
  assert.match(missing.json.error, /v4/);
});

test("PUT …/versions/:v/video stores at the version key and only the current one moves the card", async () => {
  const db = fakeDb([{ label: "one", duration_ms: 8_000 }]);
  const STORAGE = fakeStorage();
  await call(db, "POST", "/api/admin/captures/1/versions", { duration_ms: 9_000 }, { STORAGE });

  /** @param {string} path */
  const put = async (path, bytes = new Uint8Array([1, 2, 3, 4])) => {
    const url = new URL(`https://deepresearch.se${path}`);
    return handleAdminCaptures(
      new Request(url, { method: "PUT", body: bytes, headers: { "content-type": "video/mp4" } }),
      { DB: db, STORAGE },
      url,
      LOG,
    );
  };

  const v2 = await put("/api/admin/captures/1/versions/2/video");
  assert.equal(v2.status, 200);
  assert.ok(STORAGE.stored.has("captures/1/v2/video.mp4"));
  const after = await v2.json();
  assert.equal(after.capture.has_video, true); // v2 IS the card
  assert.equal(after.capture.size_bytes, 4);

  // Re-uploading the OLD cut updates that version and leaves the card alone.
  const v1 = await put("/api/admin/captures/1/versions/1/video", new Uint8Array([1, 2, 3, 4, 5, 6]));
  assert.equal(v1.status, 200);
  assert.ok(STORAGE.stored.has("captures/1/v1/video.mp4"));
  const back = await v1.json();
  assert.equal(back.capture.size_bytes, 4, "the current version's size must not be overwritten");
  assert.equal(db.versions.find((v) => v.version === 1).size_bytes, 6);

  // A version that was never allocated cannot receive bytes.
  assert.equal((await put("/api/admin/captures/1/versions/9/video")).status, 404);

  // The delete sweeps every version's object, not just the current one.
  await call(db, "DELETE", "/api/admin/captures/1", undefined, { STORAGE });
  assert.equal(STORAGE.stored.size, 0);
  assert.equal(db.versions.length, 0);
});

test("GET …/versions/:v/video answers a Range request with a 206", async () => {
  const db = fakeDb([{ label: "one", video_key: "captures/1/video.mp4" }]);
  const STORAGE = {
    async head() {
      return { size: 1_000 };
    },
    async get(key, opts) {
      return { body: `bytes:${opts?.range?.offset ?? 0}` };
    },
    async put() {},
    async delete() {},
  };
  const url = new URL("https://deepresearch.se/api/admin/captures/1/versions/1/video");
  const ranged = await handleAdminCaptures(
    new Request(url, { headers: { range: "bytes=100-199" } }),
    { DB: db, STORAGE },
    url,
    LOG,
  );
  // Scrubbing an OLD cut is the whole point of keeping it, so Range has to
  // work on the version paths and not only on the current one.
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 100-199/1000");
  assert.equal(ranged.headers.get("accept-ranges"), "bytes");
});

test("the version endpoints fail soft: 503 without R2, 404 for an unknown tail", async () => {
  const db = fakeDb([{ label: "one" }]);
  const noR2 = await call(db, "GET", "/api/admin/captures/1/versions/1/video");
  assert.equal(noR2.res.status, 503);
  assert.match(noR2.json.error, /R2|storage/i);
  assert.equal((await call(db, "GET", "/api/admin/captures/1/versions/1/thumb")).res.status, 404);
  assert.equal((await call(db, "DELETE", "/api/admin/captures/1/versions/1/video")).res.status, 404);
  assert.equal((await call(db, "POST", "/api/admin/captures/99/versions", { duration_ms: 1 })).res.status, 404);
});

// ---------------------------------------------------------------------------
// answered_at — set once, never cleared
// ---------------------------------------------------------------------------

test("the FIRST verdict stamps answered_at and no later one moves it", async () => {
  const db = fakeDb([{ label: "one" }]);
  const first = await call(db, "POST", "/api/admin/captures/1/review", { verdict: "feedback", note: "too slow" });
  const stamped = first.json.capture.answered_at;
  assert.ok(stamped, "the first verdict must stamp answered_at");
  assert.equal(first.json.capture.answered, true);

  // A second verdict, a new version, and a third verdict all leave it alone.
  const second = await call(db, "POST", "/api/admin/captures/1/review", { verdict: "like" });
  assert.equal(second.json.capture.answered_at, stamped);
  const recut = await call(db, "POST", "/api/admin/captures/1/versions", { duration_ms: 9_000 });
  assert.equal(recut.json.capture.status, "new");
  assert.equal(recut.json.capture.answered_at, stamped, "a re-cut must not un-answer the capture");
  const third = await call(db, "POST", "/api/admin/captures/1/review", { verdict: "like" });
  assert.equal(third.json.capture.answered_at, stamped);

  // And an unanswered capture stays unanswered until it is swiped.
  const fresh = fakeDb([{ label: "two" }]);
  assert.equal((await call(fresh, "GET", "/api/admin/captures/1")).json.capture.answered, false);
});

// ---------------------------------------------------------------------------
// queue-status — the top-up's whole input
// ---------------------------------------------------------------------------

test("GET /captures/queue-status reports the deficit, the spread and the used pairs", async () => {
  const db = fakeDb([
    { label: "a", agent: "research", starter: "res-a", status: "new" },
    { label: "b", agent: "research", starter: "res-b", status: "liked" },
    { label: "c", agent: "scholar", starter: "sch-a", status: "new" },
  ]);
  const s = await call(db, "GET", "/api/admin/captures/queue-status");
  assert.equal(s.res.status, 200);
  assert.deepEqual(Object.keys(s.json).sort(), ["by_agent", "deficit", "target", "unanswered", "used"]);
  assert.equal(s.json.target, 20);
  assert.equal(s.json.unanswered, 2);
  assert.equal(s.json.deficit, 18);
  assert.deepEqual(s.json.by_agent, { research: 1, scholar: 1 });
  // Newest first, like every other list here. A liked capture's prompt is
  // still spoken for — the top-up must not silently re-record it as if it
  // were new.
  assert.deepEqual(s.json.used, [
    { agent: "scholar", starter: "sch-a" },
    { agent: "research", starter: "res-b" },
    { agent: "research", starter: "res-a" },
  ]);

  const seeded = await call(db, "GET", "/api/admin/captures/queue-status?target=3&agents=research,orchestrator");
  assert.equal(seeded.json.target, 3);
  assert.equal(seeded.json.deficit, 1);
  assert.equal(seeded.json.by_agent.orchestrator, 0);
});

test("PATCH /captures/:id renames the capture", async () => {
  const db = fakeDb([{ label: "one" }]);
  const named = await call(db, "PATCH", "/api/admin/captures/1", { name: "  Sv Elpris  " });
  assert.equal(named.json.capture.name, "Sv Elpris");
  assert.equal((await call(db, "PATCH", "/api/admin/captures/1", { name: "  " })).res.status, 400);
});

test("POST /captures names the new capture and records the commit", async () => {
  const db = fakeDb();
  const created = await call(db, "POST", "/api/admin/captures", {
    ...CREATE,
    starter: "res-sv-elpris",
    commit_sha: "abc1234",
  });
  assert.equal(created.json.capture.name, "Elpris");
  assert.equal(created.json.capture.commit_sha, "abc1234");
  assert.equal(created.json.capture.version, 1);
  assert.equal(created.json.capture.answered, false);
  assert.equal(created.json.capture.tag, `#CAP-${created.json.capture.id}`);
});

test("countNewCaptures counts the deck and fails soft to 0", async () => {
  const db = fakeDb([{ status: "new" }, { status: "new" }, { status: "liked" }]);
  assert.equal(await countNewCaptures(/** @type {any} */ ({ DB: db })), 2);
  assert.equal(await countNewCaptures(/** @type {any} */ ({})), 0);
  const broken = {
    batch: async () => [],
    prepare() {
      return { bind() { return this; }, first: async () => { throw new Error("D1 is having a day"); } };
    },
  };
  assert.equal(await countNewCaptures(/** @type {any} */ ({ DB: broken })), 0);
});

test("commit_sha can be backfilled, but only as a real sha", () => {
  // The first four captures were published before the column existed. A
  // provenance field nobody can fill in afterwards is provenance those rows
  // never get — but it must not become a place to write "unknown", which
  // looks like an answer.
  const ok = validateCapturePatch({ commit_sha: "B49C68AA" });
  assert.equal(ok.error, undefined);
  assert.equal(ok.patch.commit_sha, "b49c68aa", "normalised to lower case");
  assert.equal(validateCapturePatch({ commit_sha: null }).patch.commit_sha, null);
  for (const bad of ["unknown", "main", "b49c68", "zzzzzzz", "b49c68aa-dirty", ""]) {
    assert.match(validateCapturePatch({ commit_sha: bad }).error || "", /commit_sha/, `${bad} must be refused`);
  }
});
