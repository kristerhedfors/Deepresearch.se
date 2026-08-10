// @ts-check
// Video captures (D1 `captures` + `capture_reviews`, R2 `captures/<id>/…`) —
// the review side of the capture pipeline.
//
// The pipeline this serves: `tests/capture.mjs` drives a real browser through
// a deepresearch run for a chosen agent x model x starter prompt and records
// it; `scripts/capture-edit.mjs` cuts the dead air, ramps the speed and
// encodes a LinkedIn-ready MP4 (both share the pure core
// `scripts/capture-core.mjs`, which is where a capture's vocabulary — shapes,
// wait modes, the slug — is DEFINED). What lands here is the finished
// artefact: one metadata row per clip, the MP4 and its poster frame in R2,
// and the owner's verdict on it.
//
// The review is a SWIPE, and that is the whole product rule this module
// exists to enforce: swiping RIGHT is 👍 like — the clip is publishable, no
// explanation owed — and swiping LEFT is ✍️ feedback, which is worth nothing
// without a note ("too slow", "the model dropdown is cut off"), so the client
// shows a text field and the server REJECTS a feedback verdict that arrives
// without one (400). A like just moves the row to `liked` and bumps a
// counter; feedback moves it to `needs_work` and the note is the work order
// for the next capture run. Every verdict is also appended to
// `capture_reviews`, so a clip re-shot three times keeps the history of why.
//
// Access: the whole surface is ADMIN-gated (the gate is applied upstream, in
// index.js → admin-api.js). Captures are unpublished marketing material, so
// nothing here is reachable by a signed-in user, let alone a stranger.
//
// Fail-soft posture (invariant 2): R2 is OPTIONAL. Without an `env.STORAGE`
// binding the four byte endpoints answer 503 with a clear message and the
// metadata board — list, create, patch, review, delete — keeps working; a
// missing R2 object never blocks a row delete either.
//
// Endpoints, all under /api/admin/captures:
//   GET    /api/admin/captures            newest first; ?status= ?agent=
//                                         ?model= ?q= ?queue=1 ?limit=
//                                         ?format=text
//   POST   /api/admin/captures            create the metadata row; the 201
//                                         carries the two upload URLs
//   GET    /api/admin/captures/:id        one capture (reviews attached)
//   PATCH  /api/admin/captures/:id        {label?, status?, ref?}
//   DELETE /api/admin/captures/:id        row + reviews + both R2 objects
//   PUT    /api/admin/captures/:id/video  raw MP4 bytes (200 MB cap)
//   GET    /api/admin/captures/:id/video  the MP4, with real Range support
//   PUT    /api/admin/captures/:id/poster raw JPEG bytes (4 MB cap)
//   GET    /api/admin/captures/:id/poster the poster frame
//   POST   /api/admin/captures/:id/review THE SWIPE — {verdict, note?}

import { getDb } from "./db.js";
import { jsonResponse, textResponse } from "./http.js";
import { cleanStr, likePattern } from "./chatlog.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/**
 * A D1 `captures` row.
 * @typedef {{ id: number, created_at: number, updated_at: number, slug: string, label: string,
 *   agent: string, mode?: string | null, model: string, prompt: string, starter?: string | null,
 *   lang?: string | null, shape?: string | null, duration_ms: number, source_ms: number,
 *   cut_ms: number, speed: number, wait_mode?: string | null, width?: number | null,
 *   height?: number | null, size_bytes: number, video_key?: string | null,
 *   poster_key?: string | null, status: string, likes: number, ref?: string | null,
 *   meta_json?: string | null }} CaptureRow
 */
/**
 * A D1 `capture_reviews` row.
 * @typedef {{ id: number, capture_id: number, created_at: number, verdict: string,
 *   note?: string | null, reviewer?: string | null }} CaptureReviewRow
 */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/captures.test.js
// ---------------------------------------------------------------------------

export const CAPTURE_CAPS = {
  label: 200,
  prompt: 8_000,
  note: 4_000,
  ref: 200,
  agent: 120,
  model: 120,
  slug: 120,
  // The three descriptive strings the harness rides along with. Short by
  // nature (a mode id, a starter id, "en"/"sv") — capped so a malformed
  // harness run cannot write an essay into a column nobody reads.
  mode: 120,
  starter: 120,
  lang: 16,
  reviewer: 120,
  // The edit report (scripts/capture-edit.mjs writes edit.json) is stored
  // whole in meta_json: segments, the ffprobe result, the LinkedIn check.
  meta: 20_000,
  // Byte ceilings for the two R2 objects.
  //
  // 100 MB is not a taste judgement: Cloudflare's EDGE rejects a request body
  // larger than that on this plan before the Worker is ever invoked, so it is
  // the real ceiling whatever this constant says. Setting ours to match is
  // what makes the failure LEGIBLE — a 150 MB upload gets our own 413 with a
  // sentence in it instead of an opaque edge error from a layer the CLI cannot
  // see. It is headroom either way: a finished feed clip aims at ~40 MB
  // (capture-core.mjs LINKEDIN.target_bytes), so the cap catches a mistake
  // (the raw recording, the wrong file) rather than shaping the product.
  video_bytes: 100 * 1024 * 1024,
  poster_bytes: 4 * 1024 * 1024,
  // Reviews read back per capture. A clip with more than this many verdicts
  // is a clip nobody is deciding about.
  reviews: 100,
};

// Lifecycle. `new` = not yet swiped (the deck). A 👍 moves it to `liked`
// (publishable), a ✍️ to `needs_work` (re-shoot with the note as the brief);
// `archived` retires a clip without deleting the file.
export const CAPTURE_STATUSES = ["new", "liked", "needs_work", "archived"];

// The two swipe directions. Deliberately NOT a like/dislike pair: a clip that
// is wrong is re-shot, so the left swipe collects the reason instead of a
// thumbs-down that says nothing.
export const CAPTURE_VERDICTS = ["like", "feedback"];

// One glyph per verdict, used everywhere a verdict is rendered (the text view
// here, the swipe deck's buttons).
/** @type {Record<string, string>} */
export const VERDICT_SYMBOLS = { like: "👍", feedback: "✍️" };

// The verdict → the status it drives.
/** @type {Record<string, string>} */
export const VERDICT_STATUS = { like: "liked", feedback: "needs_work" };

/** @type {Record<string, string>} */
const VERDICT_WORDS = { like: "👍 liked", feedback: "✍️ needs work" };

// The capture vocabulary, MIRRORED from scripts/capture-core.mjs (SHAPES /
// WAIT_MODES / PLAN_DEFAULTS) rather than imported: that module pulls in the
// whole starter registry to build its run matrix, and none of it belongs in
// the Worker bundle. The mirror is safe because these values are RECORDED
// here, never acted on — an unknown one falls back instead of erroring, so a
// harness that grows a fourth shape writes rows this module still accepts.
export const CAPTURE_SHAPES = ["portrait", "square", "landscape", "raw"];
export const DEFAULT_CAPTURE_SHAPE = "portrait";
export const CAPTURE_WAIT_MODES = ["cut", "speed", "keep"];
export const DEFAULT_WAIT_MODE = "cut";

/**
 * @param {unknown} value
 * @returns {string | null} the status, or null when it is not one of ours
 */
export function normalizeCaptureStatus(value) {
  return typeof value === "string" && CAPTURE_STATUSES.includes(value) ? value : null;
}

// Absent → null (the column is nullable); present but unrecognised → the
// default. See CAPTURE_SHAPES above for why an unknown value is not an error.
/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeShape(value) {
  const s = cleanStr(value, 40);
  if (!s) return null;
  return CAPTURE_SHAPES.includes(s) ? s : DEFAULT_CAPTURE_SHAPE;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeWaitMode(value) {
  const s = cleanStr(value, 40);
  if (!s) return null;
  return CAPTURE_WAIT_MODES.includes(s) ? s : DEFAULT_WAIT_MODE;
}

/** @param {unknown} v @param {number} [fallback] */
function nonNegInt(v, fallback = 0) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {unknown} v @returns {number | null} */
function optionalInt(v) {
  if (v == null || v === "") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Playback multiplier. Clamped rather than rejected: the number is descriptive
// (what the edit did), and a nonsense value should not lose the row.
/** @param {unknown} v */
function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.max(n, 0.1), 64);
}

/** @param {string | null | undefined} s */
function slugPart(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// The harness sends the slug it used for the capture DIRECTORY (capture-core's
// captureSlug), which is what makes a row traceable back to the files on the
// machine that produced it. A hand-made row still needs an identity, so one is
// derived from the same three parts.
/**
 * @param {{ agent: string, model: string, starter?: string | null, label?: string | null }} run
 * @returns {string}
 */
export function captureSlug(run) {
  return (
    [run.agent, run.model, run.starter || run.label]
      .map(slugPart)
      .filter(Boolean)
      .join("__")
      .slice(0, CAPTURE_CAPS.slug) || "capture"
  );
}

// POST body → the row fields for a new capture, or {error}. The five required
// fields are the ones without which a clip cannot be reviewed at all: what it
// shows (label), what produced it (agent, model, prompt) and how long it runs
// (duration_ms — a zero-length clip is a failed edit, not a capture).
// Everything else is descriptive and is clamped, defaulted or dropped.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, entry: {
 *   slug: string, label: string, agent: string, mode: string | null, model: string,
 *   prompt: string, starter: string | null, lang: string | null, shape: string | null,
 *   duration_ms: number, source_ms: number, cut_ms: number, speed: number,
 *   wait_mode: string | null, width: number | null, height: number | null,
 *   size_bytes: number, ref: string | null, meta_json: string | null } }}
 */
export function validateCaptureCreate(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const label = cleanStr(body.label, CAPTURE_CAPS.label);
  if (!label) return { error: "A capture needs a non-empty label." };
  const agent = cleanStr(body.agent, CAPTURE_CAPS.agent);
  if (!agent) return { error: "A capture needs the agent it was recorded from." };
  const model = cleanStr(body.model, CAPTURE_CAPS.model);
  if (!model) return { error: "A capture needs the model it ran on." };
  const prompt = cleanStr(body.prompt, CAPTURE_CAPS.prompt);
  if (!prompt) return { error: "A capture needs the prompt that was sent." };
  const duration_ms = nonNegInt(body.duration_ms, 0);
  if (!duration_ms) return { error: "duration_ms must be a positive number of milliseconds." };

  const starter = cleanStr(body.starter, CAPTURE_CAPS.starter);
  const slug = cleanStr(body.slug, CAPTURE_CAPS.slug) || captureSlug({ agent, model, starter, label });
  return {
    entry: {
      slug,
      label,
      agent,
      mode: cleanStr(body.mode, CAPTURE_CAPS.mode),
      model,
      prompt,
      starter,
      lang: cleanStr(body.lang, CAPTURE_CAPS.lang),
      shape: normalizeShape(body.shape),
      duration_ms,
      source_ms: nonNegInt(body.source_ms, 0),
      cut_ms: nonNegInt(body.cut_ms, 0),
      speed: clampSpeed(body.speed),
      wait_mode: normalizeWaitMode(body.wait_mode),
      width: optionalInt(body.width),
      height: optionalInt(body.height),
      size_bytes: nonNegInt(body.size_bytes, 0),
      ref: cleanStr(body.ref, CAPTURE_CAPS.ref),
      meta_json: serializeMeta(body.meta),
    },
  };
}

// The edit report rides along as an opaque blob — this module reads none of
// it, so anything unserializable degrades to "no meta" rather than a 400.
/** @param {unknown} meta @returns {string | null} */
function serializeMeta(meta) {
  if (meta == null || typeof meta !== "object") return null;
  try {
    const json = JSON.stringify(meta);
    return json && json.length <= CAPTURE_CAPS.meta ? json : null;
  } catch {
    return null;
  }
}

// PATCH body → only the present fields, or {error}. Deliberately narrow: the
// recording facts (agent, model, prompt, timings) describe what was recorded
// and are not editable after the fact — a wrong one means re-capturing, not
// rewriting the record. Only the human-owned fields move.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, patch: Record<string, any> }}
 */
export function validateCapturePatch(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  /** @type {Record<string, any>} */
  const patch = {};
  if ("label" in body) {
    const label = cleanStr(body.label, CAPTURE_CAPS.label);
    if (!label) return { error: "label cannot be empty." };
    patch.label = label;
  }
  if ("status" in body) {
    const status = normalizeCaptureStatus(body.status);
    if (!status) return { error: `status must be one of: ${CAPTURE_STATUSES.join(", ")}.` };
    patch.status = status;
  }
  if ("ref" in body) patch.ref = cleanStr(body.ref, CAPTURE_CAPS.ref);
  if (!Object.keys(patch).length) {
    return { error: "Nothing to update — send label, status and/or ref." };
  }
  return { patch };
}

// POST …/review body → {verdict, note}, or {error}.
//
// THE product rule: a LEFT swipe (feedback) without a note is rejected. A clip
// that "isn't right" and no record of why produces the same clip again on the
// next run, so the note is not optional decoration — it is the entire payload
// of that half of the gesture. The right swipe carries its meaning in the
// gesture itself, so its note stays optional.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, verdict: string, note: string | null }}
 */
export function validateCaptureReview(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  if (!CAPTURE_VERDICTS.includes(body.verdict)) {
    return { error: `verdict must be one of: ${CAPTURE_VERDICTS.join(", ")}.` };
  }
  const note = cleanStr(body.note, CAPTURE_CAPS.note);
  if (body.verdict === "feedback" && !note) {
    return { error: "A feedback swipe needs a note — say what is wrong with the clip." };
  }
  return { verdict: body.verdict, note };
}

/** @param {number} id */
export function videoUrl(id) {
  return `/api/admin/captures/${id}/video`;
}

/** @param {number} id */
export function posterUrl(id) {
  return `/api/admin/captures/${id}/poster`;
}

/** @param {string | null | undefined} json */
function parseMeta(json) {
  if (!json) return {};
  try {
    const m = JSON.parse(json);
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

// A D1 `capture_reviews` row → API object.
/**
 * @param {CaptureReviewRow} row
 * @returns {any}
 */
export function projectCaptureReview(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    time: new Date(row.created_at).toISOString(),
    verdict: CAPTURE_VERDICTS.includes(row.verdict) ? row.verdict : "feedback",
    note: row.note || null,
    reviewer: row.reviewer || null,
  };
}

// Row → API object. The key set is a CONTRACT with the swipe deck: it reads
// `video_url`/`poster_url` straight into the <video>/<img>, `has_video` to
// decide whether the card is playable at all, and `meta` for the edit report.
// Optional columns are null-safe because a hand-made row (or an older row
// created before a column was populated) must still render.
/**
 * @param {CaptureRow} row
 * @returns {any}
 */
export function projectCapture(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    time: new Date(row.created_at).toISOString(),
    slug: row.slug,
    label: row.label,
    agent: row.agent,
    mode: row.mode || null,
    model: row.model,
    prompt: row.prompt,
    starter: row.starter || null,
    lang: row.lang || null,
    shape: row.shape || null,
    duration_ms: row.duration_ms || 0,
    source_ms: row.source_ms || 0,
    cut_ms: row.cut_ms || 0,
    speed: row.speed || 1,
    wait_mode: row.wait_mode || null,
    width: row.width || null,
    height: row.height || null,
    size_bytes: row.size_bytes || 0,
    status: row.status,
    likes: row.likes || 0,
    ref: row.ref || null,
    has_video: !!row.video_key,
    has_poster: !!row.poster_key,
    video_url: videoUrl(row.id),
    poster_url: posterUrl(row.id),
    meta: parseMeta(row.meta_json),
    reviews: [],
  };
}

/** @param {number} ms */
function dur(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** @param {number} bytes */
function mb(bytes) {
  return `${Math.round((Math.max(0, Number(bytes) || 0) / (1024 * 1024)) * 10) / 10} MB`;
}

// Plain-text rendering (?format=text): newest first, one block per capture.
// Made to be READ by the Claude Code loop that produces captures and acts on
// the feedback — so every block carries the four things a re-shoot needs (which
// agent, which model, the exact prompt, what the edit did) and the verbatim
// notes. Not a parseable format.
/**
 * @param {any[]} entries projectCapture output
 * @returns {string}
 */
export function formatCapturesText(entries) {
  if (!entries.length) return "(no captures match)\n";
  return (
    entries
      .map((e) => {
        const lines = [`── #${e.id} [${e.status}] ${e.label}`];
        const facts = [`${e.agent} · ${e.model}`];
        if (e.mode) facts.push(`mode ${e.mode}`);
        if (e.lang) facts.push(e.lang);
        if (e.shape) facts.push(e.shape);
        if (e.starter) facts.push(`starter ${e.starter}`);
        lines.push(`RUN: ${facts.join(" · ")}`);
        lines.push(`PROMPT: ${e.prompt}`);
        const edit = [
          `${dur(e.duration_ms)} final`,
          `${dur(e.source_ms)} recorded`,
          `${dur(e.cut_ms)} cut`,
          `${e.speed}x`,
        ];
        if (e.wait_mode) edit.push(`waits ${e.wait_mode}`);
        lines.push(`EDIT: ${edit.join(" · ")}`);
        const media = [e.has_video ? `${e.video_url} (${mb(e.size_bytes)})` : "no video uploaded"];
        if (e.width && e.height) media.push(`${e.width}x${e.height}`);
        if (e.has_poster) media.push("poster");
        lines.push(`VIDEO: ${media.join(" · ")}`);
        if (e.likes) lines.push(`LIKES: ${e.likes}`);
        if (e.ref) lines.push(`REF: ${e.ref}`);
        if (Array.isArray(e.reviews) && e.reviews.length) {
          lines.push("REVIEWS:");
          for (const r of e.reviews) {
            lines.push(
              `  ${VERDICT_WORDS[r.verdict] || r.verdict} (${r.time})` +
                (r.reviewer ? ` ${r.reviewer}` : "") +
                (r.note ? ` — ${r.note}` : ""),
            );
          }
        }
        return lines.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// HTTP Range — because the deck is a <video> element someone scrubs
// ---------------------------------------------------------------------------
//
// A capture is reviewed by watching it, which means seeking: Safari in
// particular refuses to play a video at all unless the server answers a byte
// range with a 206. R2 takes {offset, length} directly, so all this has to do
// is turn the header into those two numbers.
//
// Returns null for anything not worth honouring — a malformed header, a
// multi-range request (we serve one range or the whole file, never
// multipart/byteranges), or a start past the end. The caller treats null as
// "ignore the header and send the whole object", which is what RFC 9110 says
// to do with a Range a server does not understand.
/**
 * @param {string | null | undefined} header the raw `Range` header
 * @param {number} size the object's total size in bytes
 * @returns {{ offset: number, length: number, end: number } | null}
 */
export function parseRange(header, size) {
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (typeof header !== "string") return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;
  let offset;
  let end;
  if (rawStart === "") {
    // Suffix form: "bytes=-500" is the LAST 500 bytes, not the first 500.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    offset = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    offset = Number(rawStart);
    if (!Number.isFinite(offset) || offset >= total) return null; // unsatisfiable
    end = rawEnd === "" ? total - 1 : Number(rawEnd);
    if (!Number.isFinite(end) || end < offset) return null;
    if (end > total - 1) end = total - 1; // an over-long end is clamped, not rejected
  }
  return { offset, length: end - offset + 1, end };
}

// ---------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------

/** @param {number} id */
const videoKey = (id) => `captures/${id}/video.mp4`;
/** @param {number} id */
const posterKey = (id) => `captures/${id}/poster.jpg`;

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<CaptureRow | null>}
 */
async function getCapture(db, id) {
  return /** @type {Promise<CaptureRow | null>} */ (
    db.prepare("SELECT * FROM captures WHERE id = ?").bind(id).first()
  );
}

// Attach each capture's reviews (oldest first, capped) to a list of projected
// captures — ONE query for the whole page, not one per capture. Fail-soft: a
// read that errors leaves the captures with empty review lists rather than
// failing the request.
/**
 * @param {D1Database} db
 * @param {any[]} entries projectCapture output (mutated in place)
 * @returns {Promise<any[]>}
 */
async function attachReviews(db, entries) {
  if (!entries.length) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) e.reviews = [];
  const marks = entries.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT * FROM capture_reviews WHERE capture_id IN (${marks}) ORDER BY id ASC`)
    .bind(...entries.map((e) => e.id))
    .all()
    .catch(() => ({ results: [] }));
  for (const row of /** @type {any[]} */ (results || [])) {
    const e = byId.get(row.capture_id);
    if (e && e.reviews.length < CAPTURE_CAPS.reviews) e.reviews.push(projectCaptureReview(row));
  }
  return entries;
}

// Count of un-swiped captures — feeds the admin panel's deck badge. Fail-soft
// to 0: a badge is never worth a 500.
/**
 * @param {Env} env
 * @returns {Promise<number>}
 */
export async function countNewCaptures(env) {
  const db = await getDb(env).catch(() => null);
  if (!db) return 0;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM captures WHERE status = 'new'")
    .first()
    .catch(() => null);
  return /** @type {number} */ (row?.n) || 0;
}

/** @param {Env} env @returns {R2Bucket | null} */
function bucket(env) {
  return /** @type {any} */ (env)?.STORAGE || null;
}

const NO_STORAGE = "Object storage (R2) is not configured on this server — the clip itself cannot be stored or served.";

// ---------------------------------------------------------------------------
// Admin surface — /api/admin/captures* (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminCaptures(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/captures/, "");
  const method = request.method;

  // GET /api/admin/captures — the board (or, with ?queue=1, the swipe deck).
  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 200);
    const where = [];
    /** @type {any[]} */
    const binds = [];
    if (p.get("queue") === "1") where.push("status = 'new'");
    if (normalizeCaptureStatus(p.get("status"))) {
      where.push("status = ?");
      binds.push(p.get("status"));
    }
    if (p.get("agent")) {
      where.push("agent = ?");
      binds.push(p.get("agent"));
    }
    if (p.get("model")) {
      where.push("model = ?");
      binds.push(p.get("model"));
    }
    if (p.get("q")) {
      where.push("(label LIKE ? ESCAPE '\\' OR prompt LIKE ? ESCAPE '\\')");
      const pat = likePattern(p.get("q"));
      binds.push(pat, pat);
    }
    const sql =
      "SELECT * FROM captures" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id DESC LIMIT ?";
    const { results } = await db.prepare(sql).bind(...binds, limit).all();
    const entries = await attachReviews(
      db,
      (/** @type {CaptureRow[]} */ (results || [])).map(projectCapture),
    );
    if (p.get("format") === "text") return textResponse(formatCapturesText(entries));
    return jsonResponse({ captures: entries, count: entries.length });
  }

  // POST /api/admin/captures — the metadata row. The bytes follow in two
  // separate PUTs, whose URLs the response hands back so the uploader never
  // has to build them.
  if (path === "" && method === "POST") {
    const body = await request.json().catch(() => null);
    const v = validateCaptureCreate(body);
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const e = v.entry;
    const now = Date.now();
    const res = await db
      .prepare(
        `INSERT INTO captures (created_at, updated_at, slug, label, agent, mode, model, prompt, starter,
           lang, shape, duration_ms, source_ms, cut_ms, speed, wait_mode, width, height, size_bytes,
           status, likes, ref, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 0, ?, ?)`,
      )
      .bind(
        now, now, e.slug, e.label, e.agent, e.mode, e.model, e.prompt, e.starter,
        e.lang, e.shape, e.duration_ms, e.source_ms, e.cut_ms, e.speed, e.wait_mode,
        e.width, e.height, e.size_bytes, e.ref, e.meta_json,
      )
      .run();
    const id = /** @type {number} */ (res.meta?.last_row_id);
    // Metadata only in the log line — the prompt is user-facing content and
    // already lives in the row.
    log.info("capture.created", { id, agent: e.agent, model: e.model, shape: e.shape });
    const row = await getCapture(db, id);
    return jsonResponse(
      {
        capture: projectCapture(/** @type {CaptureRow} */ (row)),
        upload: { video: videoUrl(id), poster: posterUrl(id) },
      },
      201,
    );
  }

  const idMatch = path.match(/^\/(\d+)(\/video|\/poster|\/review)?$/);
  if (!idMatch) return jsonResponse({ error: "Not found." }, 404);
  const capture = await getCapture(db, Number(idMatch[1]));
  if (!capture) return jsonResponse({ error: "No such capture." }, 404);
  const sub = idMatch[2] || "";

  // GET /api/admin/captures/:id — one card, reviews attached.
  if (!sub && method === "GET") {
    const [projected] = await attachReviews(db, [projectCapture(capture)]);
    if (url.searchParams.get("format") === "text") return textResponse(formatCapturesText([projected]));
    return jsonResponse({ capture: projected });
  }

  // PATCH /api/admin/captures/:id — rename, retire, re-reference.
  if (!sub && method === "PATCH") {
    const v = validateCapturePatch(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const sets = ["updated_at = ?"];
    /** @type {any[]} */
    const binds = [Date.now()];
    for (const [k, val] of Object.entries(v.patch)) {
      sets.push(`${k} = ?`);
      binds.push(val);
    }
    await db.prepare(`UPDATE captures SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, capture.id).run();
    log.info("capture.patched", { id: capture.id, fields: Object.keys(v.patch) });
    const row = await getCapture(db, capture.id);
    const [projected] = await attachReviews(db, [projectCapture(/** @type {CaptureRow} */ (row))]);
    return jsonResponse({ capture: projected });
  }

  // DELETE /api/admin/captures/:id — the clip, its reviews and its bytes.
  // The R2 deletes are fail-soft on purpose: an object that was never uploaded
  // (or that a previous half-finished delete already removed) must not strand
  // the row, which would leave an undeletable card in the deck forever.
  if (!sub && method === "DELETE") {
    const b = bucket(env);
    if (b) {
      await b.delete(videoKey(capture.id)).catch(() => {});
      await b.delete(posterKey(capture.id)).catch(() => {});
    }
    await db.prepare("DELETE FROM capture_reviews WHERE capture_id = ?").bind(capture.id).run().catch(() => {});
    await db.prepare("DELETE FROM captures WHERE id = ?").bind(capture.id).run();
    log.info("capture.deleted", { id: capture.id });
    return jsonResponse({ ok: true });
  }

  // PUT …/video, PUT …/poster — the raw bytes.
  if (sub === "/video" && method === "PUT") {
    return putMedia(request, env, log, db, capture, {
      kind: "video",
      key: videoKey(capture.id),
      contentType: "video/mp4",
      maxBytes: CAPTURE_CAPS.video_bytes,
    });
  }
  if (sub === "/poster" && method === "PUT") {
    return putMedia(request, env, log, db, capture, {
      kind: "poster",
      key: posterKey(capture.id),
      contentType: "image/jpeg",
      maxBytes: CAPTURE_CAPS.poster_bytes,
    });
  }

  // GET …/video — with real Range support (see parseRange).
  if (sub === "/video" && method === "GET") {
    return getMedia(request, env, capture.id, videoKey(capture.id), "video/mp4", true);
  }
  // GET …/poster — a poster frame is small; nothing seeks into a JPEG.
  if (sub === "/poster" && method === "GET") {
    return getMedia(request, env, capture.id, posterKey(capture.id), "image/jpeg", false);
  }

  // POST …/review — THE SWIPE. Right = 👍 like (status `liked`, likes+1),
  // left = ✍️ feedback (status `needs_work`, note required — validated above).
  // Both append a `capture_reviews` row, so re-shooting a clip keeps the
  // history of every verdict it ever drew.
  if (sub === "/review" && method === "POST") {
    const body = await request.json().catch(() => null);
    const v = validateCaptureReview(body);
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const reviewer = cleanStr(body?.reviewer, CAPTURE_CAPS.reviewer);
    const now = Date.now();
    await db
      .prepare(
        "INSERT INTO capture_reviews (capture_id, created_at, verdict, note, reviewer) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(capture.id, now, v.verdict, v.note, reviewer)
      .run();
    await db
      .prepare("UPDATE captures SET status = ?, likes = likes + ?, updated_at = ? WHERE id = ?")
      .bind(VERDICT_STATUS[v.verdict], v.verdict === "like" ? 1 : 0, now, capture.id)
      .run();
    // The note is the owner's own words about an unpublished clip — the row
    // holds it; the log line stays metadata.
    log.info("capture.review", { id: capture.id, verdict: v.verdict });
    const row = await getCapture(db, capture.id);
    const [projected] = await attachReviews(db, [projectCapture(/** @type {CaptureRow} */ (row))]);
    return jsonResponse({ capture: projected }, 201);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

// ---------------------------------------------------------------------------
// The two byte endpoints
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {D1Database} db
 * @param {CaptureRow} capture
 * @param {{ kind: "video" | "poster", key: string, contentType: string, maxBytes: number }} spec
 * @returns {Promise<Response>}
 */
async function putMedia(request, env, log, db, capture, spec) {
  const b = bucket(env);
  if (!b) return jsonResponse({ error: NO_STORAGE }, 503);
  // The content-type is REQUIRED, not sniffed: this endpoint stores bytes it
  // will later serve back with a fixed type, and an uploader that did not say
  // what it is sending is usually one that got the file wrong.
  const declaredType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (declaredType !== spec.contentType) {
    return jsonResponse(
      { error: `Expected a ${spec.contentType} body (send content-type: ${spec.contentType}).` },
      415,
    );
  }
  const declaredLength = Number(request.headers.get("content-length")) || 0;
  if (declaredLength > spec.maxBytes) {
    return jsonResponse({ error: `The ${spec.kind} exceeds the ${mb(spec.maxBytes)} limit.` }, 413);
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > spec.maxBytes) {
    return jsonResponse({ error: `The ${spec.kind} exceeds the ${mb(spec.maxBytes)} limit.` }, 413);
  }
  if (!bytes.byteLength) return jsonResponse({ error: `The ${spec.kind} body is empty.` }, 400);
  await b.put(spec.key, bytes, { httpMetadata: { contentType: spec.contentType } });
  const now = Date.now();
  // Two whole statements rather than one with an interpolated column name:
  // src/sql-injection-guard.test.js allows only hand-audited identifiers into
  // SQL, and "there are exactly two of these" is a better answer than another
  // allowlist entry. The MP4 IS the artefact, so only it writes size_bytes.
  if (spec.kind === "video") {
    await db
      .prepare("UPDATE captures SET video_key = ?, size_bytes = ?, updated_at = ? WHERE id = ?")
      .bind(spec.key, bytes.byteLength, now, capture.id)
      .run();
  } else {
    await db
      .prepare("UPDATE captures SET poster_key = ?, updated_at = ? WHERE id = ?")
      .bind(spec.key, now, capture.id)
      .run();
  }
  log.info("capture.media_put", { id: capture.id, kind: spec.kind, size: bytes.byteLength });
  const row = await getCapture(db, capture.id);
  return jsonResponse({ capture: projectCapture(/** @type {CaptureRow} */ (row)) });
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {number} id
 * @param {string} key
 * @param {string} contentType
 * @param {boolean} ranged
 * @returns {Promise<Response>}
 */
async function getMedia(request, env, id, key, contentType, ranged) {
  const b = bucket(env);
  if (!b) return jsonResponse({ error: NO_STORAGE }, 503);
  // HEAD first so the total size is known before the range is resolved — R2
  // needs {offset, length}, and `content-range` needs the total either way.
  const head = await b.head(key).catch(() => null);
  if (!head) return jsonResponse({ error: "No bytes stored for this capture yet." }, 404);
  const range = ranged ? parseRange(request.headers.get("range"), head.size) : null;
  const obj = await b
    .get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined)
    .catch(() => null);
  if (!obj) return jsonResponse({ error: "No bytes stored for this capture yet." }, 404);
  /** @type {Record<string, string>} */
  const headers = {
    "content-type": contentType,
    "content-length": String(range ? range.length : head.size),
    // Unpublished material behind the admin gate — no shared cache may hold a
    // copy. Seeking still works: it rides on Range, not on the cache.
    "cache-control": "private, no-store",
    "x-capture-id": String(id),
  };
  if (ranged) headers["accept-ranges"] = "bytes";
  if (range) {
    headers["content-range"] = `bytes ${range.offset}-${range.end}/${head.size}`;
    return new Response(obj.body, { status: 206, headers });
  }
  return new Response(obj.body, { status: 200, headers });
}
