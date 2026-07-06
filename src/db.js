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
`;

// Additive migrations for databases created before the column existed.
// "duplicate column" failures are expected and swallowed; anything else in
// here must stay idempotent-or-ignorable.
const ALTERS = [
  "ALTER TABLE users ADD COLUMN google_sub TEXT",
  "ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER",
];

let migrated = false; // per isolate

// Returns the D1 binding with schema applied, or null when the database is
// not configured. Callers must handle null (feature off, not an error).
export async function getDb(env) {
  if (!env.DB) return null;
  if (!migrated) {
    const statements = SCHEMA.split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => env.DB.prepare(s));
    await env.DB.batch(statements);
    for (const alter of ALTERS) {
      await env.DB.prepare(alter).run().catch(() => {});
    }
    migrated = true;
  }
  return env.DB;
}
