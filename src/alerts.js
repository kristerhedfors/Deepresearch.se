// Operational alerts: surfaces production issues (Berget errors, wallet
// depletion, etc.) in the admin panel and as a notification badge, instead
// of only living in Workers Logs where nobody's looking. Rows are
// upserted by `type` (a small, stable set of buckets) rather than one row
// per occurrence — a recurring issue bumps `count`/`last_seen_at` and
// un-acknowledges itself (worth re-surfacing), rather than flooding the
// table. Fails soft: no DB binding means alerts are silently a no-op, same
// as every other D1-backed feature in this app.

import { getDb } from "./db.js";

// Classifies a caught pipeline error into a stable alert type + severity +
// human message. Keep this list small and meaningful — it's read by admins,
// not a log dump. Unmatched errors fall into a generic bucket rather than
// each becoming their own type.
export function classifyChatError(message) {
  const msg = String(message || "");
  if (/INSUFFICIENT_WALLET_BALANCE|insufficient_quota/i.test(msg)) {
    return {
      type: "berget_insufficient_balance",
      severity: "critical",
      message: "Berget wallet balance is depleted — every research request will fail until it's topped up at berget.ai.",
    };
  }
  if (/empty response twice in a row/i.test(msg)) {
    return {
      type: "chat_empty_completion",
      severity: "warning",
      message: "A model returned an empty response twice in a row for a research request (auto-retried once, then gave up).",
    };
  }
  if (/finish_reason.*dropped connection/i.test(msg)) {
    return {
      type: "chat_dropped_stream",
      severity: "warning",
      message: "A model's response stream dropped mid-flight with no error frame (Berget-side connection instability).",
    };
  }
  return {
    type: "chat_stream_failed",
    severity: "warning",
    message: "A research request failed with an unexpected error.",
  };
}

export async function raiseAlert(env, type, severity, message, detail) {
  const db = await getDb(env);
  if (!db) return;
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO alerts (type, severity, message, detail, count, first_seen_at, last_seen_at, acknowledged_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, NULL)
       ON CONFLICT(type) DO UPDATE SET
         severity = excluded.severity,
         message = excluded.message,
         detail = excluded.detail,
         count = count + 1,
         last_seen_at = excluded.last_seen_at,
         acknowledged_at = NULL`,
    )
    .bind(type, severity, message, detail ? String(detail).slice(0, 500) : null, now, now)
    .run()
    .catch(() => {}); // best-effort — an alerting bug must never break the chat
}

export async function listAlerts(env) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare(`SELECT * FROM alerts ORDER BY (acknowledged_at IS NOT NULL), last_seen_at DESC`)
    .all();
  return results || [];
}

export async function countOpenAlerts(env) {
  const db = await getDb(env);
  if (!db) return 0;
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM alerts WHERE acknowledged_at IS NULL`).first();
  return row?.n || 0;
}

export async function acknowledgeAlert(env, id) {
  const db = await getDb(env);
  if (!db) return;
  await db.prepare(`UPDATE alerts SET acknowledged_at = ? WHERE id = ?`).bind(Date.now(), id).run();
}
