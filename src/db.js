// @ts-check
// D1 database access. The binding is optional: until the database exists
// (npx wrangler d1 create deepresearch-se + uncomment the block in
// wrangler.toml) `getDb` returns null and every account/quota feature
// degrades to the pre-multiuser behavior — admin-secrets auth only, no
// quotas. Nothing may throw just because DB is absent.
//
// Schema is applied lazily, once per isolate (CREATE TABLE IF NOT EXISTS is
// idempotent), so there is no separate migration step to operate.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  google_sub TEXT,
  quota_json TEXT,
  terms_accepted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  berget_cost REAL NOT NULL DEFAULT 0,
  exa_cost REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_events(user_id, ts);
CREATE TABLE IF NOT EXISTS inflight (
  req_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inflight_user ON inflight(user_id, ts);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS answers (
  request_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,
  text TEXT,
  stats_json TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT UNIQUE NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  detail TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  acknowledged_at INTEGER
);
CREATE TABLE IF NOT EXISTS chat_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  ts INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'chat',
  model TEXT,
  json_model TEXT,
  question TEXT,
  answer TEXT,
  conversation_json TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  meta_json TEXT,
  web_search INTEGER NOT NULL DEFAULT 1,
  budget_s INTEGER,
  rounds INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  sources INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  client_gone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_logs_ts ON chat_logs(ts);
CREATE INDEX IF NOT EXISTS idx_chat_logs_user_ts ON chat_logs(user_id, ts);
CREATE TABLE IF NOT EXISTS tokemon_saves (
  user_id TEXT PRIMARY KEY,
  save_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  period TEXT,
  kind TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_user_messages_user_created ON user_messages(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  comment TEXT NOT NULL,
  question TEXT,
  answer_excerpt TEXT,
  model TEXT,
  page TEXT
);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, id DESC);
CREATE TABLE IF NOT EXISTS security_reviews (
  item_id TEXT PRIMARY KEY,
  votes INTEGER NOT NULL DEFAULT 0,
  score TEXT,
  note TEXT,
  priority INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS features_reviews (
  item_id TEXT PRIMARY KEY,
  votes INTEGER NOT NULL DEFAULT 0,
  score TEXT,
  note TEXT,
  priority INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS panels_reviews (
  item_id TEXT PRIMARY KEY,
  votes INTEGER NOT NULL DEFAULT 0,
  score TEXT,
  note TEXT,
  priority INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_feedback_messages_fb ON feedback_messages(feedback_id, id);
CREATE TABLE IF NOT EXISTS test_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  target TEXT NOT NULL,
  actions_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT,
  result_note TEXT,
  result_at INTEGER,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_test_points_status ON test_points(status, id DESC);
CREATE TABLE IF NOT EXISTS websearch_grants (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  quota INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_websearch_grants_user ON websearch_grants(user_id, expires_at DESC);
`;

// Additive migrations for databases created before the column existed.
// "duplicate column" failures are expected and swallowed; anything else in
// here must stay idempotent-or-ignorable.
const ALTERS = [
  "ALTER TABLE users ADD COLUMN google_sub TEXT",
  "ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER",
  "ALTER TABLE users ADD COLUMN settings_json TEXT",
];

let migrated = false; // per isolate

/**
 * Returns the D1 binding with schema applied, or null when the database is
 * not configured. Callers must handle null (feature off, not an error).
 * @param {import('./types.js').Env} env
 * @returns {Promise<D1Database | null>}
 */
export async function getDb(env) {
  const db = env.DB;
  if (!db) return null;
  if (!migrated) {
    const statements = SCHEMA.split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s));
    await db.batch(statements);
    for (const alter of ALTERS) {
      await db.prepare(alter).run().catch(() => {});
    }
    migrated = true;
  }
  return db;
}
