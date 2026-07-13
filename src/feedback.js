// @ts-check
// User feedback pipeline (D1 `feedback` + `feedback_messages`) — the back
// end of the account panel's "Feedback mode" knob. With the knob on, every
// assistant reply grows a Feedback button; a submission lands here as an
// entry carrying the user's comment plus the reply it's about (question,
// answer excerpt, model). Each entry is a THREAD: the user and the
// development agent exchange messages on it until it's resolved — a
// user-friendly dialogue between end-users and the Claude Code loop that
// processes the queue (see the **feedback-loop** skill and
// scripts/feedback).
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
import { feedbackEnabled } from "./settings.js";

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

export const FEEDBACK_STATUSES = ["new", "seen", "in_progress", "resolved", "declined"];

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

// POST /api/feedback body → row fields, or {error}. Only `comment` is
// required — the reply context (question/answer/model) rides along when the
// client has it, but a submission must never fail for lacking it.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, entry: { comment: string, question: string | null, answer_excerpt: string | null, model: string | null, page: string | null } }}
 */
export function validateFeedbackCreate(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const comment = cleanStr(body.comment, FEEDBACK_CAPS.comment);
  if (!comment) return { error: "Feedback needs a non-empty comment." };
  return {
    entry: {
      comment,
      question: cleanStr(body.question, FEEDBACK_CAPS.question),
      answer_excerpt: cleanStr(body.answer_excerpt, FEEDBACK_CAPS.answer_excerpt),
      model: cleanStr(body.model, FEEDBACK_CAPS.model),
      page: cleanStr(body.page, FEEDBACK_CAPS.page),
    },
  };
}

// POST …/messages body → message text, or {error}.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, body: string }}
 */
export function validateFeedbackReply(body) {
  const text = cleanStr(body?.body, FEEDBACK_CAPS.message);
  if (!text) return { error: "A reply needs a non-empty body." };
  return { body: text };
}

// DB rows → API object. Messages ride inline: a thread is small (prose), and
// both the account panel and the agent loop want the whole dialogue in one
// fetch.
/**
 * @param {FeedbackRow} row
 * @param {FeedbackMessageRow[]} [messages]
 * @returns {any} the API projection
 */
export function projectFeedback(row, messages = []) {
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
    messages: messages.map((m) => ({
      id: m.id,
      author: m.author, // "user" | "agent"
      body: m.body,
      created_at: m.created_at,
      time: new Date(m.created_at).toISOString(),
      read_at: m.read_at || null,
    })),
  };
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
      if (e.question) lines.push(`ABOUT QUESTION: ${e.question}`);
      if (e.answer_excerpt) lines.push(`ABOUT REPLY: ${e.answer_excerpt}`);
      for (const m of e.messages) {
        lines.push(`${m.author === "agent" ? "AGENT" : "USER"} (${m.time}): ${m.body}`);
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
  return projectFeedback(/** @type {FeedbackRow} */ (row), messages.get(id) || []);
}

/**
 * @param {D1Database} db
 * @param {number} feedbackId
 * @param {"user" | "agent"} author
 * @param {string} body
 */
async function addMessage(db, feedbackId, author, body) {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO feedback_messages (feedback_id, author, body, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(feedbackId, author, body, now)
    .run();
  await db.prepare("UPDATE feedback SET updated_at = ? WHERE id = ?").bind(now, feedbackId).run();
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

  // POST /api/feedback — create an entry. Gated on the knob: the UI only
  // offers the button while Feedback mode is on, and the server enforces the
  // same so the knob is authoritative, not cosmetic.
  if (path === "" && method === "POST") {
    if (!feedbackEnabled(env, identity)) {
      return jsonResponse({ error: "Switch on Feedback mode in the account panel first." }, 403);
    }
    const body = await request.json().catch(() => null);
    const v = validateFeedbackCreate(body);
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const now = Date.now();
    const res = await db
      .prepare(
        `INSERT INTO feedback (user_id, created_at, updated_at, status, comment, question, answer_excerpt, model, page)
         VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId, now, now,
        v.entry.comment, v.entry.question, v.entry.answer_excerpt, v.entry.model, v.entry.page,
      )
      .run();
    const id = /** @type {number} */ (res.meta?.last_row_id);
    log.info("feedback.created", { user_id: userId, feedback_id: id });
    const row = await getEntry(db, id);
    return jsonResponse({ feedback: projectFeedback(/** @type {FeedbackRow} */ (row)) }, 201);
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
    const entries = rows.map((r) => projectFeedback(r, messages.get(r.id) || []));
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

  const idMatch = path.match(/^\/(\d+)(\/messages)?$/);
  if (!idMatch) return jsonResponse({ error: "Not found." }, 404);
  const entry = await getEntry(db, Number(idMatch[1]));
  if (!entry || entry.user_id !== userId) {
    return jsonResponse({ error: "No such feedback entry." }, 404);
  }

  // POST /api/feedback/:id/messages — the user's side of the dialogue.
  // Works regardless of the knob (an open thread must stay answerable), and
  // reopens a closed entry so it lands back on the loop's queue.
  if (idMatch[2] && method === "POST") {
    const v = validateFeedbackReply(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await addMessage(db, entry.id, "user", v.body);
    if (!isOpenStatus(entry.status)) {
      await db.prepare("UPDATE feedback SET status = 'new' WHERE id = ?").bind(entry.id).run();
    }
    log.info("feedback.user_reply", { user_id: userId, feedback_id: entry.id });
    return jsonResponse({ feedback: await projectedEntry(db, entry.id) }, 201);
  }

  // DELETE /api/feedback/:id — the user withdraws an entry (thread included).
  if (!idMatch[2] && method === "DELETE") {
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
    const entries = rows.map((r) => projectFeedback(r, messages.get(r.id) || []));
    if (p.get("format") === "text") return textResponse(formatFeedbackText(entries));
    return jsonResponse({ feedback: entries, count: entries.length });
  }

  const idMatch = path.match(/^\/(\d+)(\/messages)?$/);
  if (!idMatch) return jsonResponse({ error: "Not found." }, 404);
  const entry = await getEntry(db, Number(idMatch[1]));
  if (!entry) return jsonResponse({ error: "No such feedback entry." }, 404);

  if (!idMatch[2] && method === "GET") {
    const messages = await loadMessages(db, [entry.id]);
    const projected = projectFeedback(entry, messages.get(entry.id) || []);
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
    await addMessage(db, entry.id, "agent", v.body);
    log.info("feedback.agent_reply", { feedback_id: entry.id });
    return jsonResponse({ feedback: await projectedEntry(db, entry.id) }, 201);
  }

  if (!idMatch[2] && method === "DELETE") {
    await db.prepare("DELETE FROM feedback_messages WHERE feedback_id = ?").bind(entry.id).run();
    await db.prepare("DELETE FROM feedback WHERE id = ?").bind(entry.id).run();
    log.info("feedback.admin_deleted", { feedback_id: entry.id });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found." }, 404);
}

