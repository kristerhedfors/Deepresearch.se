// @ts-check
// User feedback pipeline (D1 `feedback` + `feedback_messages`). Feedback is
// captured from the CHAT itself: a message whose text opens with the word
// "feedback" (feedbackIntent below, EN+SV) is routed by the research pipeline
// into the feedback case (src/pipeline.js runFeedbackCapture) instead of being
// researched — it lands here (createFeedbackEntry, called from chat.js) as an
// entry carrying the user's comment plus the turn it followed: the prior
// question and the reply it comments on, and the model. Entries can also be
// created directly via POST /api/feedback (this module), optionally with
// screenshot images (client-downscaled data URLs in D1 `feedback_images`, one
// row per image, served back via …/:id/images/:imgId). Each entry is a THREAD:
// the user and the development agent exchange messages on it until it's
// resolved — a user-friendly dialogue between end-users and the Claude Code
// loop that processes the queue (see the **feedback-loop** skill and
// scripts/feedback).
//
// Discovery is deliberately DOUBLE (owner directive, 2026-07-18): every
// feedback message is both stored as an entry here AND tagged on its
// chat_logs row (meta.feedback — src/chat.js), so the development loop can
// find feedback either through scripts/feedback (the structured queue) or a
// chatlogs scan.
//
// Two API surfaces:
//   - /api/feedback*        the signed-in user's own entries (create, list,
//                           reply, delete) — the account panel's Feedback view.
//   - /api/admin/feedback*  the agent/operator side (list queue, read thread,
//                           set status, reply, delete) — shaped like
//                           /api/admin/chatlogs: one curl, ?format=text for
//                           reading, built for the agentic workflow.
//
// Content posture: a feedback entry IS user content, stored readable by
// explicit user action — submitting is consented sharing with the site's
// developers (disclosed on the knob's popover and the form itself). That is
// the same footing as the chat interaction log (src/chatlog.js), except
// here nothing is written unless the user presses Send.
//
// Status lifecycle: new → seen → in_progress → resolved | declined.
// A user reply to a resolved/declined entry reopens it (status back to
// "new") so the open list stays the loop's single work queue.

import { getDb } from "./db.js";
import { jsonResponse, textResponse } from "./http.js";
import { cleanStr, likePattern } from "./chatlog.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */
/**
 * A D1 `feedback` row.
 * @typedef {{ id: number, user_id: string, created_at: number, updated_at: number, status: string, comment: string, question?: string | null, answer_excerpt?: string | null, model?: string | null, page?: string | null }} FeedbackRow
 */
/**
 * A D1 `feedback_messages` row (one turn of an entry's dialogue thread).
 * @typedef {{ id: number, feedback_id: number, author: "user" | "agent", body: string, created_at: number, read_at?: number | null }} FeedbackMessageRow
 */
/**
 * A D1 `feedback_images` row's metadata projection (the `data` column —
 * a client-downscaled data:image/… URL — is only ever loaded one image at
 * a time, by the serving endpoints). `message_id` null = attached to the
 * original entry; set = attached to that thread message.
 * @typedef {{ id: number, feedback_id: number, message_id?: number | null, name?: string | null, chars: number }} FeedbackImageMeta
 */
/** @typedef {{ name: string | null, data: string }} FeedbackImageInput */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/feedback.test.js
// ---------------------------------------------------------------------------

// Size caps: a feedback thread is prose, not a document dump. Truncation
// uses the chat log's explicit marker so a trimmed field never masquerades
// as complete.
export const FEEDBACK_CAPS = {
  comment: 4_000,
  question: 4_000,
  answer_excerpt: 8_000,
  message: 4_000,
  model: 100,
  page: 200,
};

// Screenshot attachments: the client downscales to JPEG data URLs (the same
// canvas walk chat attachments use), so these caps are a backstop against
// bypassing clients, not the working budget. Each image is its own D1 row
// (D1 allows ~2 MB per row; a capped data URL is well inside that).
export const FEEDBACK_IMAGE_CAPS = {
  count: 3, // images per submission (entry or reply)
  dataChars: 500_000, // per image, data-URL length (~375 KB decoded)
  totalChars: 1_200_000, // per submission
  name: 200,
};

// Strict data-URL shape — the whole string is the base64 payload, so nothing
// smuggled after a comma or whitespace ever reaches storage.
const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export const FEEDBACK_STATUSES = ["new", "seen", "in_progress", "resolved", "declined"];

// The feedback intent gate (deterministic, no model call — same posture as
// quiz.js quizIntent / hf.js hfIntent). A message whose text OPENS with the
// word "feedback" (case-insensitive — "The word feedback, small or large caps"
// — the owner's whole trigger) is a report to the developers, not a research
// question, and the pipeline routes it to the feedback case. English + Swedish
// (invariant 6, EN/SV parity): "feedback" is used in both languages; the native
// Swedish terms are "återkoppling" and "synpunkt(er)", definite forms included.
//
// "feedback loop(s)" is the ONE excluded collision: it's a ubiquitous fixed
// phrase (control theory, ML, and this repo's own skill names), so a research
// question that opens with it must NOT be swallowed by the gate.
const FEEDBACK_PATTERNS = [
  /^\s*feedback\b(?!\s+loops?\b)/i, // EN + SV loanword: "feedback", "Feedback:", "feedback – …"
  /^\s*återkoppling(?:en)?\b/i, // SV: "återkoppling", "återkopplingen"
  /^\s*synpunkt(?:er|en|erna)?\b/i, // SV: "synpunkt", "synpunkter", "synpunkten"
];

/**
 * Whether the latest user message is feedback for the developers.
 * @param {unknown} text the user's message text
 * @returns {boolean}
 */
export function feedbackIntent(text) {
  const t = typeof text === "string" ? text : "";
  return FEEDBACK_PATTERNS.some((re) => re.test(t));
}

// Open = still on the loop's work queue.
/**
 * @param {string} status
 * @returns {boolean}
 */
export function isOpenStatus(status) {
  return status !== "resolved" && status !== "declined";
}

/**
 * @param {unknown} value
 * @returns {string | null} the status when valid, else null
 */
export function normalizeStatus(value) {
  return typeof value === "string" && FEEDBACK_STATUSES.includes(value) ? value : null;
}

// Optional `images` on create/reply bodies → validated list, or {error}.
// Rejecting (not silently dropping) a bad image is deliberate: the client
// downscales before sending, so an invalid or oversize image means a broken
// client — and silently losing the screenshot a user attached is worse than
// a clear 400.
/**
 * @param {unknown} value
 * @returns {{ error: string } | { error?: undefined, images: FeedbackImageInput[] }}
 */
export function validateFeedbackImages(value) {
  if (value === undefined || value === null) return { images: [] };
  if (!Array.isArray(value)) return { error: "images must be an array of {name, data}." };
  if (value.length > FEEDBACK_IMAGE_CAPS.count) {
    return { error: `At most ${FEEDBACK_IMAGE_CAPS.count} images per submission.` };
  }
  const images = [];
  let total = 0;
  for (const item of value) {
    const data = item && typeof item === "object" ? item.data : null;
    if (typeof data !== "string" || !IMAGE_DATA_RE.test(data)) {
      return { error: "Each image needs a data:image/…;base64 URL (png, jpeg, webp or gif)." };
    }
    if (data.length > FEEDBACK_IMAGE_CAPS.dataChars) {
      return { error: "An attached image is too large (~375 KB max after encoding)." };
    }
    total += data.length;
    if (total > FEEDBACK_IMAGE_CAPS.totalChars) {
      return { error: "The attached images are too large together (~900 KB max per submission)." };
    }
    images.push({ name: cleanStr(item.name, FEEDBACK_IMAGE_CAPS.name), data });
  }
  return { images };
}

// A stored data URL → {mime, bytes} for the image-serving endpoints, or
// null (which the handlers turn into a 404, not a crash).
/**
 * @param {unknown} data
 * @returns {{ mime: string, bytes: Uint8Array } | null}
 */
export function decodeImageDataUrl(data) {
  if (typeof data !== "string") return null;
  const m = data.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) return null;
  let binary;
  try {
    binary = atob(m[2]);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { mime: m[1], bytes };
}

// Decoded size from a stored data URL's LENGTH() — close enough for the
// "how big is this screenshot" projections without loading the data column
// (23 ≈ the `data:image/…;base64,` prefix; base64 is 4 chars per 3 bytes).
/**
 * @param {number} dataChars
 * @returns {number}
 */
export function approxImageBytes(dataChars) {
  return Math.max(0, Math.round(((Number(dataChars) || 0) - 23) * 3 / 4));
}

// POST /api/feedback body → row fields, or {error}. Only `comment` is
// required — the reply context (question/answer/model) rides along when the
// client has it, but a submission must never fail for lacking it. Screenshot
// attachments are optional and validated as a unit (all-or-nothing).
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, entry: { comment: string, question: string | null, answer_excerpt: string | null, model: string | null, page: string | null }, images: FeedbackImageInput[] }}
 */
export function validateFeedbackCreate(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const comment = cleanStr(body.comment, FEEDBACK_CAPS.comment);
  if (!comment) return { error: "Feedback needs a non-empty comment." };
  const v = validateFeedbackImages(body.images);
  if (typeof v.error === "string") return { error: v.error };
  return {
    entry: {
      comment,
      question: cleanStr(body.question, FEEDBACK_CAPS.question),
      answer_excerpt: cleanStr(body.answer_excerpt, FEEDBACK_CAPS.answer_excerpt),
      model: cleanStr(body.model, FEEDBACK_CAPS.model),
      page: cleanStr(body.page, FEEDBACK_CAPS.page),
    },
    images: v.images,
  };
}

// POST …/messages body → message text + optional images, or {error}. A
// reply may be image-only (a screenshot IS an answer to "can you show me?"),
// so text is required only when no image rides along.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, body: string, images: FeedbackImageInput[] }}
 */
export function validateFeedbackReply(body) {
  const text = cleanStr(body?.body, FEEDBACK_CAPS.message);
  const v = validateFeedbackImages(body?.images);
  if (typeof v.error === "string") return { error: v.error };
  if (!text && !v.images.length) return { error: "A reply needs a non-empty body." };
  return { body: text || "", images: v.images };
}

/**
 * @param {FeedbackImageMeta} i
 */
function projectImage(i) {
  return { id: i.id, name: i.name || null, bytes: approxImageBytes(i.chars) };
}

// DB rows → API object. Messages ride inline: a thread is small (prose), and
// both the account panel and the agent loop want the whole dialogue in one
// fetch. Images ride as METADATA only (id/name/size) — the data column stays
// in D1 until the per-image endpoint (/api/feedback/:id/images/:imgId or the
// admin twin) serves it, so a 100-entry list never carries megabytes of
// base64. Entry-level images (message_id null) land on `images`; a reply's
// screenshots land on that message's own `images`.
/**
 * @param {FeedbackRow} row
 * @param {FeedbackMessageRow[]} [messages]
 * @param {FeedbackImageMeta[]} [images]
 * @returns {any} the API projection
 */
export function projectFeedback(row, messages = [], images = []) {
  return {
    id: row.id,
    user_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    time: new Date(row.created_at).toISOString(),
    status: row.status,
    open: isOpenStatus(row.status),
    comment: row.comment,
    question: row.question || null,
    answer_excerpt: row.answer_excerpt || null,
    model: row.model || null,
    page: row.page || null,
    images: images.filter((i) => !i.message_id).map(projectImage),
    messages: messages.map((m) => ({
      id: m.id,
      author: m.author, // "user" | "agent"
      body: m.body,
      created_at: m.created_at,
      time: new Date(m.created_at).toISOString(),
      read_at: m.read_at || null,
      images: images.filter((i) => i.message_id === m.id).map(projectImage),
    })),
  };
}

// One IMAGES line for the text rendering: ids + names + sizes, so the agent
// loop knows what to fetch (scripts/feedback --image <entry> <img>).
/**
 * @param {any[]} images projected image metadata
 * @returns {string}
 */
function imagesLine(images) {
  return (
    "IMAGES: " +
    images
      .map((i) => `#${i.id} ${i.name || "image"} (~${Math.max(1, Math.round(i.bytes / 1024))} KB)`)
      .join(", ")
  );
}

// Plain-text rendering (?format=text): newest first, one bordered block per
// entry with its full thread — made to be READ by the agent loop, not parsed.
/**
 * @param {any[]} entries projected entries (projectFeedback output)
 * @returns {string}
 */
export function formatFeedbackText(entries) {
  if (!entries.length) return "(no feedback entries match)\n";
  return entries
    .map((e) => {
      const lines = [
        `── #${e.id} ${e.time} [${e.status}] user=${e.user_id}` +
          (e.model ? ` model=${e.model}` : "") +
          (e.page ? ` page=${e.page}` : ""),
        `FEEDBACK: ${e.comment}`,
      ];
      if (e.images?.length) lines.push(imagesLine(e.images));
      if (e.question) lines.push(`ABOUT QUESTION: ${e.question}`);
      if (e.answer_excerpt) lines.push(`ABOUT REPLY: ${e.answer_excerpt}`);
      for (const m of e.messages) {
        lines.push(`${m.author === "agent" ? "AGENT" : "USER"} (${m.time}): ${m.body}`);
        if (m.images?.length) lines.push("  " + imagesLine(m.images));
      }
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------

/**
 * @param {D1Database} db
 * @param {number[]} feedbackIds
 * @returns {Promise<Map<number, FeedbackMessageRow[]>>} feedback_id -> thread
 */
async function loadMessages(db, feedbackIds) {
  if (!feedbackIds.length) return new Map();
  const placeholders = feedbackIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT * FROM feedback_messages WHERE feedback_id IN (${placeholders}) ORDER BY id ASC`,
    )
    .bind(...feedbackIds)
    .all();
  const byId = new Map();
  for (const m of results || []) {
    if (!byId.has(m.feedback_id)) byId.set(m.feedback_id, []);
    byId.get(m.feedback_id).push(m);
  }
  return byId;
}

// Image METADATA per entry — LENGTH(data), never the data itself, so a list
// fetch stays list-sized however many screenshots are attached.
/**
 * @param {D1Database} db
 * @param {number[]} feedbackIds
 * @returns {Promise<Map<number, FeedbackImageMeta[]>>} feedback_id -> images
 */
async function loadImages(db, feedbackIds) {
  if (!feedbackIds.length) return new Map();
  const placeholders = feedbackIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT id, feedback_id, message_id, name, LENGTH(data) AS chars
       FROM feedback_images WHERE feedback_id IN (${placeholders}) ORDER BY id ASC`,
    )
    .bind(...feedbackIds)
    .all();
  const byId = new Map();
  for (const i of results || []) {
    if (!byId.has(i.feedback_id)) byId.set(i.feedback_id, []);
    byId.get(i.feedback_id).push(i);
  }
  return byId;
}

/**
 * @param {D1Database} db
 * @param {number} feedbackId
 * @param {number | null} messageId null = attached to the original entry
 * @param {FeedbackImageInput[]} images
 */
async function insertImages(db, feedbackId, messageId, images) {
  const now = Date.now();
  for (const img of images) {
    await db
      .prepare(
        "INSERT INTO feedback_images (feedback_id, message_id, name, data, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(feedbackId, messageId, img.name, img.data, now)
      .run();
  }
}

// One image WITH its data column — the serving endpoints' fetch. Scoped by
// feedback_id so an id can never be read across entries.
/**
 * @param {D1Database} db
 * @param {number} feedbackId
 * @param {number} imageId
 * @returns {Promise<{ id: number, feedback_id: number, name?: string | null, data: string } | null>}
 */
async function getImage(db, feedbackId, imageId) {
  return /** @type {any} */ (
    db
      .prepare("SELECT * FROM feedback_images WHERE id = ? AND feedback_id = ?")
      .bind(imageId, feedbackId)
      .first()
  );
}

// Decoded image → HTTP response (shared by the user and admin endpoints).
// Immutable content under a private id → a private cache is fine and saves
// the panel re-fetching thumbnails on every open.
/**
 * @param {{ data: string } | null} imageRow
 * @returns {Response}
 */
function imageResponse(imageRow) {
  const decoded = imageRow ? decodeImageDataUrl(imageRow.data) : null;
  if (!decoded) return jsonResponse({ error: "No such image." }, 404);
  return new Response(decoded.bytes, {
    headers: {
      "content-type": decoded.mime,
      "cache-control": "private, max-age=3600",
    },
  });
}

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<FeedbackRow | null>}
 */
async function getEntry(db, id) {
  return /** @type {Promise<FeedbackRow | null>} */ (
    db.prepare("SELECT * FROM feedback WHERE id = ?").bind(id).first()
  );
}

// Re-reads an entry after a write and projects it with its full thread —
// the response body every mutating endpoint returns. The row is known to
// exist (the caller just loaded or wrote it).
/**
 * @param {D1Database} db
 * @param {number} id
 */
async function projectedEntry(db, id) {
  const row = await getEntry(db, id);
  const messages = await loadMessages(db, [id]);
  const images = await loadImages(db, [id]);
  return projectFeedback(
    /** @type {FeedbackRow} */ (row),
    messages.get(id) || [],
    images.get(id) || [],
  );
}

/**
 * @param {D1Database} db
 * @param {number} feedbackId
 * @param {"user" | "agent"} author
 * @param {string} body
 * @returns {Promise<number>} the new message's id
 */
async function addMessage(db, feedbackId, author, body) {
  const now = Date.now();
  const res = await db
    .prepare(
      "INSERT INTO feedback_messages (feedback_id, author, body, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(feedbackId, author, body, now)
    .run();
  await db.prepare("UPDATE feedback SET updated_at = ? WHERE id = ?").bind(now, feedbackId).run();
  return /** @type {number} */ (res.meta?.last_row_id);
}

// Unread agent replies across a user's entries — feeds the /api/me
// notification badge so a user learns the agent wrote back without opening
// the panel.
/**
 * @param {Env} env
 * @param {number | string} userId
 * @returns {Promise<number>}
 */
export async function countUnreadFeedbackReplies(env, userId) {
  const db = await getDb(env);
  if (!db) return 0;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM feedback_messages m
       JOIN feedback f ON f.id = m.feedback_id
       WHERE f.user_id = ? AND m.author = 'agent' AND m.read_at IS NULL`,
    )
    .bind(String(userId))
    .first()
    .catch(() => null);
  return /** @type {number} */ (row?.n) || 0;
}

// Insert one feedback entry (the row only — images, when any, are added by the
// caller). Shared by the chat feedback pipeline (chat.js, from a "feedback …"
// message) and the direct POST /api/feedback create below. Applies the field
// caps; returns the new entry id, or null when there's no DB or no usable
// comment (fail-soft — a feedback capture must never break the request it
// rode in on).
/**
 * @param {D1Database | null} db
 * @param {string | number} userId
 * @param {{ comment: string, question?: string | null, answer_excerpt?: string | null, model?: string | null, page?: string | null }} entry
 * @returns {Promise<number | null>}
 */
export async function createFeedbackEntry(db, userId, entry) {
  if (!db) return null;
  const comment = cleanStr(entry.comment, FEEDBACK_CAPS.comment);
  if (!comment) return null;
  const now = Date.now();
  const res = await db
    .prepare(
      `INSERT INTO feedback (user_id, created_at, updated_at, status, comment, question, answer_excerpt, model, page)
       VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
    )
    .bind(
      String(userId), now, now,
      comment,
      cleanStr(entry.question, FEEDBACK_CAPS.question),
      cleanStr(entry.answer_excerpt, FEEDBACK_CAPS.answer_excerpt),
      cleanStr(entry.model, FEEDBACK_CAPS.model),
      cleanStr(entry.page, FEEDBACK_CAPS.page),
    )
    .run();
  return Number(res.meta?.last_row_id) || null;
}

// ---------------------------------------------------------------------------
// User surface — /api/feedback* (identity gate in index.js; own rows only)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleFeedbackApi(request, env, url, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  if (!identity.user) {
    return jsonResponse({ error: "Feedback needs a signed-in account (not break-glass)." }, 403);
  }
  const userId = String(identity.id);
  const path = url.pathname.replace(/^\/api\/feedback/, "");
  const method = request.method;

  // POST /api/feedback — create an entry directly (any signed-in account).
  // The primary capture path is now the chat feedback pipeline (a message that
  // opens with "feedback"); this endpoint stays for programmatic use and any
  // client that wants to submit an entry with screenshots attached.
  if (path === "" && method === "POST") {
    const body = await request.json().catch(() => null);
    const v = validateFeedbackCreate(body);
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const id = /** @type {number} */ (await createFeedbackEntry(db, userId, v.entry));
    await insertImages(db, id, null, v.images);
    log.info("feedback.created", { user_id: userId, feedback_id: id, images: v.images.length });
    return jsonResponse({ feedback: await projectedEntry(db, id) }, 201);
  }

  // GET /api/feedback — the user's own entries, newest first, threads
  // inline. Opening the list marks the agent's replies read (same one-shot
  // pattern as the message center).
  if (path === "" && method === "GET") {
    const { results } = await db
      .prepare("SELECT * FROM feedback WHERE user_id = ? ORDER BY id DESC LIMIT 100")
      .bind(userId)
      .all();
    const rows = /** @type {FeedbackRow[]} */ (results || []);
    const messages = await loadMessages(db, rows.map((r) => r.id));
    const images = await loadImages(db, rows.map((r) => r.id));
    const entries = rows.map((r) =>
      projectFeedback(r, messages.get(r.id) || [], images.get(r.id) || []),
    );
    await db
      .prepare(
        `UPDATE feedback_messages SET read_at = ?
         WHERE author = 'agent' AND read_at IS NULL
           AND feedback_id IN (SELECT id FROM feedback WHERE user_id = ?)`,
      )
      .bind(Date.now(), userId)
      .run()
      .catch(() => {});
    return jsonResponse({ feedback: entries });
  }

  const imgMatch = path.match(/^\/(\d+)\/images\/(\d+)$/);
  const idMatch = imgMatch || path.match(/^\/(\d+)(\/messages)?$/);
  if (!idMatch) return jsonResponse({ error: "Not found." }, 404);
  const entry = await getEntry(db, Number(idMatch[1]));
  if (!entry || entry.user_id !== userId) {
    return jsonResponse({ error: "No such feedback entry." }, 404);
  }

  // GET /api/feedback/:id/images/:imgId — a screenshot back as a real image
  // (the panel's <img> tags point here); own entries only, like everything
  // above.
  if (imgMatch && method === "GET") {
    return imageResponse(await getImage(db, entry.id, Number(imgMatch[2])));
  }
  if (imgMatch) return jsonResponse({ error: "Not found." }, 404);

  // POST /api/feedback/:id/messages — the user's side of the dialogue.
  // Works regardless of the knob (an open thread must stay answerable), and
  // reopens a closed entry so it lands back on the loop's queue.
  if (idMatch[2] && method === "POST") {
    const v = validateFeedbackReply(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const messageId = await addMessage(db, entry.id, "user", v.body);
    await insertImages(db, entry.id, messageId, v.images);
    if (!isOpenStatus(entry.status)) {
      await db.prepare("UPDATE feedback SET status = 'new' WHERE id = ?").bind(entry.id).run();
    }
    log.info("feedback.user_reply", { user_id: userId, feedback_id: entry.id, images: v.images.length });
    return jsonResponse({ feedback: await projectedEntry(db, entry.id) }, 201);
  }

  // DELETE /api/feedback/:id — the user withdraws an entry (thread and
  // screenshots included).
  if (!idMatch[2] && method === "DELETE") {
    await db.prepare("DELETE FROM feedback_images WHERE feedback_id = ?").bind(entry.id).run();
    await db.prepare("DELETE FROM feedback_messages WHERE feedback_id = ?").bind(entry.id).run();
    await db.prepare("DELETE FROM feedback WHERE id = ?").bind(entry.id).run();
    log.info("feedback.deleted", { user_id: userId, feedback_id: entry.id });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found." }, 404);
}

// ---------------------------------------------------------------------------
// Agent/operator surface — /api/admin/feedback* (admin gate in index.js)
// ---------------------------------------------------------------------------

// GET    /api/admin/feedback        queue, newest first, threads inline
//   ?open=1 (the work queue: status not resolved/declined)  ?status=<s>
//   ?user=<id>  ?since=<epoch ms>  ?before_id=<id>  ?q=<substring>
//   ?limit=20 (max 200)  ?format=text (readable transcript)
// GET    /api/admin/feedback/:id    one entry incl. thread (?format=text)
// GET    /api/admin/feedback/:id/images/:imgId  an attached screenshot (image bytes)
// PATCH  /api/admin/feedback/:id    {status: new|seen|in_progress|resolved|declined}
// POST   /api/admin/feedback/:id/messages  {body} — the agent's reply
// DELETE /api/admin/feedback/:id
/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminFeedback(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/feedback/, "");
  const method = request.method;

  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 20, 1), 200);
    const where = [];
    const binds = [];
    if (p.get("open") === "1") where.push("status NOT IN ('resolved','declined')");
    if (normalizeStatus(p.get("status"))) { where.push("status = ?"); binds.push(p.get("status")); }
    if (p.get("user")) { where.push("user_id = ?"); binds.push(p.get("user")); }
    if (Number(p.get("since"))) { where.push("updated_at >= ?"); binds.push(Number(p.get("since"))); }
    if (Number(p.get("before_id"))) { where.push("id < ?"); binds.push(Number(p.get("before_id"))); }
    if (p.get("q")) {
      where.push("(comment LIKE ? ESCAPE '\\' OR question LIKE ? ESCAPE '\\')");
      const pat = likePattern(p.get("q"));
      binds.push(pat, pat);
    }
    const sql =
      "SELECT * FROM feedback" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id DESC LIMIT ?";
    const { results } = await db.prepare(sql).bind(...binds, limit).all();
    const rows = /** @type {FeedbackRow[]} */ (results || []);
    const messages = await loadMessages(db, rows.map((r) => r.id));
    const images = await loadImages(db, rows.map((r) => r.id));
    const entries = rows.map((r) =>
      projectFeedback(r, messages.get(r.id) || [], images.get(r.id) || []),
    );
    if (p.get("format") === "text") return textResponse(formatFeedbackText(entries));
    return jsonResponse({ feedback: entries, count: entries.length });
  }

  const imgMatch = path.match(/^\/(\d+)\/images\/(\d+)$/);
  const idMatch = imgMatch || path.match(/^\/(\d+)(\/messages)?$/);
  if (!idMatch) return jsonResponse({ error: "Not found." }, 404);
  const entry = await getEntry(db, Number(idMatch[1]));
  if (!entry) return jsonResponse({ error: "No such feedback entry." }, 404);

  // GET /api/admin/feedback/:id/images/:imgId — the agent side's fetch for
  // an attached screenshot (scripts/feedback --image wraps it).
  if (imgMatch && method === "GET") {
    return imageResponse(await getImage(db, entry.id, Number(imgMatch[2])));
  }
  if (imgMatch) return jsonResponse({ error: "Not found." }, 404);

  if (!idMatch[2] && method === "GET") {
    const projected = await projectedEntry(db, entry.id);
    if (url.searchParams.get("format") === "text") {
      return textResponse(formatFeedbackText([projected]));
    }
    return jsonResponse({ feedback: projected });
  }

  if (!idMatch[2] && method === "PATCH") {
    const body = await request.json().catch(() => ({}));
    const status = normalizeStatus(body.status);
    if (!status) {
      return jsonResponse({ error: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}.` }, 400);
    }
    await db
      .prepare("UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, Date.now(), entry.id)
      .run();
    log.info("feedback.status", { feedback_id: entry.id, status });
    return jsonResponse({ feedback: await projectedEntry(db, entry.id) });
  }

  if (idMatch[2] && method === "POST") {
    const v = validateFeedbackReply(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const messageId = await addMessage(db, entry.id, "agent", v.body);
    await insertImages(db, entry.id, messageId, v.images);
    log.info("feedback.agent_reply", { feedback_id: entry.id });
    return jsonResponse({ feedback: await projectedEntry(db, entry.id) }, 201);
  }

  if (!idMatch[2] && method === "DELETE") {
    await db.prepare("DELETE FROM feedback_images WHERE feedback_id = ?").bind(entry.id).run();
    await db.prepare("DELETE FROM feedback_messages WHERE feedback_id = ?").bind(entry.id).run();
    await db.prepare("DELETE FROM feedback WHERE id = ?").bind(entry.id).run();
    log.info("feedback.admin_deleted", { feedback_id: entry.id });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found." }, 404);
}

