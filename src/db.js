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
  quota_reset_at INTEGER,
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
-- usage_events is the ENFORCEMENT ledger: one row per request, its berget_cost
-- the SUM across every model the request ran, which is all a cost cap needs.
-- usage_model_events is the ATTRIBUTION ledger: one row per model bucket that
-- actually spent (answer / JSON planning / vision), so a user's spend stays
-- attributable to the model that drove it. NEVER read for quota enforcement —
-- purely to answer "what did this user's budget go to" (getUsageByModelForUser).
CREATE TABLE IF NOT EXISTS usage_model_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  berget_cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_model_user_ts ON usage_model_events(user_id, ts);
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
-- The server-ERROR fix queue (src/server-errors.js): one row per DISTINCT
-- uncaught top-level exception (deduped by signature), recorded from
-- index.js's fetch catch so a 500 becomes a work item the fix loop pulls.
-- Recurrences bump count/last_seen_at; a recurrence of a fixed row reopens
-- it (regression). Carries no user content: method, path, message, stack,
-- request id only.
CREATE TABLE IF NOT EXISTS server_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT UNIQUE NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',
  method TEXT,
  path TEXT,
  message TEXT,
  stack TEXT,
  request_id TEXT,
  note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_errors_status ON server_errors(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_server_errors_seen ON server_errors(last_seen_at DESC);
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
CREATE TABLE IF NOT EXISTS feedback_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id INTEGER NOT NULL,
  message_id INTEGER,
  name TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_images_fb ON feedback_images(feedback_id, id);
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
CREATE TABLE IF NOT EXISTS test_point_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_point_messages_point ON test_point_messages(point_id, id);
CREATE TABLE IF NOT EXISTS websearch_grants (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  quota INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  label TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_websearch_grants_user ON websearch_grants(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_websearch_grants_exp ON websearch_grants(expires_at);
CREATE TABLE IF NOT EXISTS proxy_grants (
  jti TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,
  quota INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  label TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_proxy_grants_user ON proxy_grants(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_grants_bundle ON proxy_grants(bundle_id);
CREATE INDEX IF NOT EXISTS idx_proxy_grants_exp ON proxy_grants(expires_at);
CREATE TABLE IF NOT EXISTS server_tokens (
  jti TEXT NOT NULL,
  service TEXT NOT NULL,
  user_id TEXT NOT NULL,
  quota INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  label TEXT,
  source TEXT,
  PRIMARY KEY (jti, service)
);
CREATE INDEX IF NOT EXISTS idx_server_tokens_user ON server_tokens(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_server_tokens_exp ON server_tokens(expires_at);
-- Compute sharing (src/pool.js, docs/COMPUTE-SHARING.md): the broker for
-- lending a local LLM as pooled capacity. One pool per sharer account
-- (pool_id == account id). pool_providers = online sharer tabs (heartbeated);
-- pool_jobs = the completion job queue (the prompt rests here transiently, then
-- is deleted/expired); pool_consumers = the dashboard aggregate + allow/block
-- list; pool_tokens = the per-token quota meter (0 = uncapped).
CREATE TABLE IF NOT EXISTS pool_providers (
  provider_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT,
  models_json TEXT,
  concurrency INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_providers_pool ON pool_providers(pool_id, last_seen_at DESC);
CREATE TABLE IF NOT EXISTS pool_jobs (
  job_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  consumer_key TEXT NOT NULL,
  token_jti TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  request_json TEXT NOT NULL,
  response_json TEXT,
  error TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  done_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pool_jobs_dispatch ON pool_jobs(pool_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_pool_jobs_consumer ON pool_jobs(consumer_key, created_at DESC);
CREATE TABLE IF NOT EXISTS pool_consumers (
  pool_id TEXT NOT NULL,
  consumer_key TEXT NOT NULL,
  token_jti TEXT,
  display TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  jobs INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (pool_id, consumer_key)
);
CREATE TABLE IF NOT EXISTS pool_tokens (
  jti TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  quota INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  label TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_pool_tokens_pool ON pool_tokens(pool_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_pool_tokens_exp ON pool_tokens(expires_at);
`;

// Additive migrations for databases created before the column existed.
// "duplicate column" failures are expected and swallowed; anything else in
// here must stay idempotent-or-ignorable.
const ALTERS = [
  "ALTER TABLE users ADD COLUMN google_sub TEXT",
  "ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER",
  "ALTER TABLE users ADD COLUMN settings_json TEXT",
  // Per-user quota reset floor (admin "Reset quota" button) — usage counts
  // only events with ts >= this timestamp. Added 2026-07-19; additive.
  "ALTER TABLE users ADD COLUMN quota_reset_at INTEGER",
  // websearch_grants gained label/source after its first ship (2026-07-14) —
  // additive so a DB that created the table earlier picks them up.
  "ALTER TABLE websearch_grants ADD COLUMN label TEXT",
  "ALTER TABLE websearch_grants ADD COLUMN source TEXT",
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
