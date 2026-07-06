// Per-user message center: account-level notices (quota exhausted/restored,
// sign-in approved, quota changed by an admin) — NOT a chat feature. Only
// structured enums (type/period/kind) and timestamps are ever stored, never
// free text — there is deliberately no content column. This keeps the
// feature inside the same zero-retention promise the privacy notice makes
// for actual conversations: nothing derived from a user's question or a
// model's answer ever passes through this module.
//
// "Restored" isn't a separately-logged event — it's derived at read time by
// comparing a stored quota_exceeded row's (period, kind) against the
// caller's CURRENT quota state (src/quota.js), so a stale block doesn't
// need a second write to resolve itself.

import { getDb } from "./db.js";

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1h: don't log a new row per blocked request

// type: "quota_exceeded" | "account_approved" | "quota_changed"
// period/kind: only meaningful for quota_exceeded (see src/quota.js's PERIODS
// and quotaExceeded()'s "budget"|"searches" kinds); null otherwise.
export async function addUserMessage(env, userId, type, { period = null, kind = null } = {}) {
  const db = await getDb(env);
  if (!db) return;
  const recent = await db
    .prepare(
      `SELECT id FROM user_messages
       WHERE user_id = ? AND type = ? AND period IS ? AND kind IS ? AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(String(userId), type, period, kind, Date.now() - DEDUP_WINDOW_MS)
    .first();
  if (recent) return;
  await db
    .prepare(`INSERT INTO user_messages (user_id, type, period, kind, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(String(userId), type, period, kind, Date.now())
    .run()
    .catch(() => {});
}

export async function listUserMessages(env, userId, { limit = 50 } = {}) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare(`SELECT * FROM user_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
    .bind(String(userId), limit)
    .all();
  return results || [];
}

export async function countUnreadUserMessages(env, userId) {
  const db = await getDb(env);
  if (!db) return 0;
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM user_messages WHERE user_id = ? AND read_at IS NULL`)
    .bind(String(userId))
    .first();
  return row?.n || 0;
}

export async function markAllRead(env, userId) {
  const db = await getDb(env);
  if (!db) return;
  await db
    .prepare(`UPDATE user_messages SET read_at = ? WHERE user_id = ? AND read_at IS NULL`)
    .bind(Date.now(), String(userId))
    .run();
}
