// Unit tests for the video-capture review surface (src/captures.js): the
// create/patch/review validators (including THE product rule — a feedback
// swipe without a note is a 400), the status/verdict vocabulary, the
// projection contract the swipe deck reads, ?format=text, the Range parser
// behind the <video> element, and the handler end to end over a fake D1.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_CAPS,
  CAPTURE_SHAPES,
  CAPTURE_STATUSES,
  CAPTURE_VERDICTS,
  CAPTURE_WAIT_MODES,
  VERDICT_STATUS,
  VERDICT_SYMBOLS,
  captureSlug,
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
  validateCaptureCreate,
  validateCapturePatch,
  validateCaptureReview,
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
// Projection — the contract the swipe deck reads
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
const PROJECTED_KEYS = [
  "id", "created_at", "updated_at", "time", "slug", "label", "agent", "mode", "model", "prompt",
  "starter", "lang", "shape", "duration_ms", "source_ms", "cut_ms", "speed", "wait_mode",
  "width", "height", "size_bytes", "status", "likes", "ref", "has_video", "has_poster",
  "video_url", "poster_url", "meta", "reviews",
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
  assert.match(txt, /── #7 \[new\] Geothermal/);
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
// table, and the generic UPDATE applier the PATCH/review paths need. Deliberately
// narrow — it interprets the statements src/captures.js actually issues.
function fakeDb(seed = []) {
  const captures = seed.map((r, i) => ({
    id: i + 1,
    created_at: 1_000,
    updated_at: 1_000,
    slug: "s",
    label: "L",
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
  const db = {
    captures,
    reviews,
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
              created_at, updated_at, slug, label, agent, mode, model, prompt, starter, lang, shape,
              duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, size_bytes, ref, meta_json,
            ] = binds;
            const row = {
              id: captures.length ? Math.max(...captures.map((c) => c.id)) + 1 : 1,
              created_at, updated_at, slug, label, agent, mode, model, prompt, starter, lang, shape,
              duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, size_bytes,
              video_key: null, poster_key: null, status: "new", likes: 0, ref, meta_json,
            };
            captures.push(row);
            return { meta: { last_row_id: row.id } };
          }
          if (/^INSERT INTO capture_reviews/.test(this._sql)) {
            const [capture_id, created_at, verdict, note, reviewer] = binds;
            reviews.push({ id: reviews.length + 1, capture_id, created_at, verdict, note, reviewer });
            return { meta: { last_row_id: reviews.length } };
          }
          const upd = this._sql.match(/^UPDATE captures SET (.+) WHERE id = \?$/s);
          if (upd) {
            const id = binds.pop();
            const row = captures.find((c) => c.id === id);
            for (const assign of upd[1].split(",")) {
              const [col, expr] = assign.split("=").map((s) => s.trim());
              if (!row) continue;
              if (expr === "?") row[col] = binds.shift();
              else if (/^likes \+ \?$/.test(expr)) row.likes = (row.likes || 0) + Number(binds.shift());
            }
            return {};
          }
          if (/^DELETE FROM capture_reviews/.test(this._sql)) {
            for (let i = reviews.length - 1; i >= 0; i--) if (reviews[i].capture_id === binds[0]) reviews.splice(i, 1);
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
  assert.match(text.text, /── #3 \[new\] three/);
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
  assert.ok(stored.has("captures/1/video.mp4"));

  // And the delete takes the object with it.
  await call(db, "DELETE", "/api/admin/captures/1", undefined, { STORAGE });
  assert.equal(stored.has("captures/1/video.mp4"), false);
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
