// Transient answer cache for connection recovery — a buffer, NOT storage.
//
// When a client loses its SSE stream mid-answer (backgrounded phone,
// download-triggered navigation), the pipeline finishes anyway
// (ctx.waitUntil) and parks the final answer here, keyed by the request id
// the client already holds from the x-request-id header. The client polls
// GET /api/chat/answer?id=… and re-renders the completed answer instead of
// asking the user to resend (and re-spend).
//
// Retention is deliberately minimal: the client DELETEs the row the moment
// an answer arrives intact (the normal case — content lives here for
// seconds), and every read/write purges rows older than ANSWER_TTL_MS, so
// even unclaimed answers are gone within minutes. Rows are only readable
// by the user who asked.

import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";

export const ANSWER_TTL_MS = 15 * 60 * 1000;

// Called at stream start (metadata only — no content yet): gives the
// recovery poller something to distinguish "still researching" from
// "nothing will ever come".
export async function markAnswerRunning(env, log, requestId, userId) {
  try {
    const db = await getDb(env);
    if (!db) return;
    await purgeExpired(db);
    await db
      .prepare("INSERT OR REPLACE INTO answers (request_id, user_id, ts, status) VALUES (?, ?, ?, 'running')")
      .bind(requestId, String(userId), Date.now())
      .run();
  } catch (err) {
    log.warn("answers.mark_failed", { error: err?.message || String(err) });
  }
}

// Called when the pipeline finishes: park the final answer + stats. The
// text overwrites the running marker; an empty text means the pipeline
// produced nothing (the poller gives up rather than rendering a blank).
export async function saveAnswer(env, log, requestId, userId, text, stats) {
  try {
    const db = await getDb(env);
    if (!db) return;
    await db
      .prepare(
        "INSERT OR REPLACE INTO answers (request_id, user_id, ts, status, text, stats_json) VALUES (?, ?, ?, 'done', ?, ?)",
      )
      .bind(requestId, String(userId), Date.now(), text, JSON.stringify(stats))
      .run();
  } catch (err) {
    log.warn("answers.save_failed", { error: err?.message || String(err) });
  }
}

// GET /api/chat/answer?id=… — {status:"running"} | {status:"done",text,stats} | 404.
export async function handleAnswerGet(env, url, identity) {
  const db = await getDb(env);
  const id = url.searchParams.get("id") || "";
  if (!db || !id) return jsonResponse({ error: "Not found." }, 404);
  await purgeExpired(db);
  const row = await db
    .prepare("SELECT status, text, stats_json FROM answers WHERE request_id = ? AND user_id = ?")
    .bind(id, String(identity.id))
    .first();
  if (!row) return jsonResponse({ error: "Not found." }, 404);
  if (row.status !== "done") return jsonResponse({ status: "running" });
  let stats = null;
  try {
    stats = row.stats_json ? JSON.parse(row.stats_json) : null;
  } catch {
    stats = null;
  }
  return jsonResponse({ status: "done", text: row.text || "", stats });
}

// DELETE /api/chat/answer?id=… — the client acks a fully received answer so
// its content is purged immediately (rather than waiting out the TTL).
export async function handleAnswerAck(env, url, identity) {
  const db = await getDb(env);
  const id = url.searchParams.get("id") || "";
  if (db && id) {
    await db
      .prepare("DELETE FROM answers WHERE request_id = ? AND user_id = ?")
      .bind(id, String(identity.id))
      .run();
  }
  return new Response(null, { status: 204 });
}

async function purgeExpired(db) {
  await db.prepare("DELETE FROM answers WHERE ts < ?").bind(Date.now() - ANSWER_TTL_MS).run();
}
