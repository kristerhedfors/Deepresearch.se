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

// How long a `running` row may go without a heartbeat before the poller
// treats the run as DEAD rather than merely slow. chat.js heartbeats the
// row every 15s for as long as the isolate is alive (even after the client
// disconnects); if the runtime kills the isolate for any reason (rare on
// the Workers Paid plan's 5-min CPU ceiling, but still possible — eviction,
// a waitUntil outliving its budget, a crash), the heartbeat stops and `ts`
// freezes. Past this window a poller can stop spinning on a "recovering…"
// step that would otherwise wait out the full budget+120s deadline for an
// answer that will never come. 50s = ~3 missed beats.
export const RUNNING_STALE_MS = 50 * 1000;

// Pure projection of a stored answer row into the GET response shape, given
// the current time. Split out so the running/lost/done decision is
// unit-tested without D1. Returns null for a missing row (404 upstream).
export function projectAnswer(row, now, staleMs = RUNNING_STALE_MS) {
  if (!row) return null;
  if (row.status !== "done") {
    // A `running` row whose heartbeat has gone stale means the server-side
    // run died (killed isolate / expired waitUntil) — tell the client so it
    // stops waiting instead of polling to the deadline.
    return now - Number(row.ts || 0) > staleMs ? { status: "lost" } : { status: "running" };
  }
  let stats = null;
  try {
    stats = row.stats_json ? JSON.parse(row.stats_json) : null;
  } catch {
    stats = null;
  }
  return { status: "done", text: row.text || "", stats };
}

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

// Called periodically by chat.js while the pipeline runs (independent of
// client presence): refreshes `ts` so a poller can tell a still-alive run
// from one the runtime killed (see RUNNING_STALE_MS). Guarded to `running`
// rows so it can never resurrect or disturb a completed answer.
export async function heartbeatAnswer(env, log, requestId, userId) {
  try {
    const db = await getDb(env);
    if (!db) return;
    await db
      .prepare("UPDATE answers SET ts = ? WHERE request_id = ? AND user_id = ? AND status = 'running'")
      .bind(Date.now(), requestId, String(userId))
      .run();
  } catch (err) {
    log.warn("answers.heartbeat_failed", { error: err?.message || String(err) });
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
    .prepare("SELECT status, ts, text, stats_json FROM answers WHERE request_id = ? AND user_id = ?")
    .bind(id, String(identity.id))
    .first();
  const projected = projectAnswer(row, Date.now());
  if (!projected) return jsonResponse({ error: "Not found." }, 404);
  return jsonResponse(projected);
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
