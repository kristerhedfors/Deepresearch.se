// @ts-check
// D1 database access. The binding is optional: until the database exists
// (npx wrangler d1 create deepresearch-se + uncomment the block in
// wrangler.toml) `getDb` returns null and every account/quota feature
// degrades to the pre-multiuser behavior — admin-secrets auth only, no
// quotas. Nothing may throw just because DB is absent.
//
// Schema is applied lazily, once per isolate (CREATE TABLE IF NOT EXISTS is
// idempotent), so there is no separate migration step to operate.

export const SCHEMA = `
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
-- ACCOUNT MEMORY (src/memory.js): the durable, linked notes an account builds
-- across conversations, stored in the shape Obsidian uses so the export is a
-- layout rather than a conversion. One row per note; (user_id, slug) is the
-- identity a re-mention merges into. links_json holds note slugs — the
-- graph's edges live here rather than in a join table because a note carries
-- at most MAX_LINKS_PER_NOTE of them and they are only ever read with the
-- note itself. Se/rver-tier only, opt-in, never written for an incognito turn,
-- and deleted outright by the reset button (docs/ACCOUNT-MEMORY.md).
CREATE TABLE IF NOT EXISTS memory_notes (
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  links_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_memory_notes_user_updated ON memory_notes(user_id, updated_at DESC);
-- The space-animations showcase's gallery feedback (src/space.js). The /space/
-- page is public, so rows deliberately carry NO identity column: scene id +
-- verdict + a clamped short comment is the whole record.
CREATE TABLE IF NOT EXISTS space_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  scene TEXT NOT NULL,
  verdict TEXT NOT NULL,
  comment TEXT
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
  page TEXT,
  context TEXT
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
-- VIDEO CAPTURES (src/captures.js, the video-capture skill). One row per
-- finished clip produced by the capture pipeline: tests/capture.mjs records a
-- deep-research run in a real browser, scripts/capture-edit.mjs cuts the dead
-- air and encodes a LinkedIn-ready MP4, and the row is what makes that clip
-- reviewable. The bytes themselves are NOT here — the MP4 and its poster live
-- in R2 under captures/<id>/, and video_key/poster_key are the pointers (both
-- null until the upload lands, which is why the row is created first).
--
-- The columns split three ways: WHAT WAS RECORDED (slug, agent, mode, model,
-- prompt, starter, lang) so a clip is traceable back to the run that made it;
-- WHAT THE EDIT DID (shape, duration_ms = the finished clip, source_ms = the
-- real run, cut_ms, speed, wait_mode, width/height, size_bytes) so a review
-- can judge the edit and not just the footage; and THE VERDICT (status, likes,
-- ref). meta_json carries the whole edit.json report verbatim for anything the
-- columns do not name.
--
-- capture_reviews is append-only: one row per swipe, so a clip re-shot three
-- times keeps the history of why. A 'feedback' verdict always carries a note
-- (enforced in the validator — a left swipe with no words is not a review).
--
-- A capture is a THREAD, not a file (queue v2, 2026-08-11). id is the
-- increasing series the owner refers a clip by (#CAP-12), name its short
-- few-word handle, version the cut currently on the card, commit_sha the code
-- that cut was recorded against (without it a clip is un-reproducible six
-- merges later), and answered_at the moment the FIRST verdict landed — set
-- once, never cleared, which is how the top-up tells a genuinely fresh capture
-- from a re-cut that went back on the deck.
--
-- chat_json is THE RUN ITSELF (2026-08-14): the conversation the recording
-- shows, read off the page by tests/capture.mjs as [{role, content}], so the
-- clip links to a chat the viewer can continue and explore from instead of an
-- answer that died with the browser that made it. It holds this site's own
-- output answering a shipped starter prompt, recorded by the operator — never
-- a row lifted out of chat_logs, which is a full-visibility log and not
-- consent to replay somebody's conversation (privacy invariant 4).
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  name TEXT,
  agent TEXT NOT NULL,
  mode TEXT,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  starter TEXT,
  lang TEXT,
  shape TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  source_ms INTEGER NOT NULL DEFAULT 0,
  cut_ms INTEGER NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 1,
  wait_mode TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  video_key TEXT,
  poster_key TEXT,
  commit_sha TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  answered_at INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  likes INTEGER NOT NULL DEFAULT 0,
  ref TEXT,
  meta_json TEXT,
  chat_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_status ON captures(status, id DESC);
-- Every version a capture has ever had, newest never overwriting oldest: a
-- 'feedback' verdict is answered by RE-CUTTING the clip, and the point of the
-- thread is that the earlier cut stays watchable next to the new one. One row
-- per version; the bytes sit at captures/<id>/v<version>/{video.mp4,poster.jpg}
-- in R2 and video_key/poster_key are the pointers (null until the upload
-- lands). The four captures recorded before this table existed have no rows at
-- all — src/captures.js reads their unversioned captures/<id>/… keys as v1 and
-- materialises that row the first time a second version is added, so nothing
-- recorded earlier is orphaned.
CREATE TABLE IF NOT EXISTS capture_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  commit_sha TEXT,
  model TEXT,
  video_key TEXT,
  poster_key TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  source_ms INTEGER NOT NULL DEFAULT 0,
  cut_ms INTEGER NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 1,
  wait_mode TEXT,
  width INTEGER,
  height INTEGER,
  note TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_versions_capture ON capture_versions(capture_id, version);
CREATE TABLE IF NOT EXISTS capture_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT,
  reviewer TEXT
);
CREATE INDEX IF NOT EXISTS idx_capture_reviews_capture ON capture_reviews(capture_id, id);
-- The OAUTH connector's two stateful tables (src/oauth-store.js, F-20). A
-- signed token carries its own claims, so these rows exist for the two things
-- a signature cannot express: an authorization code must be usable EXACTLY
-- once, and a refresh token must be revocable and rotatable. Access tokens
-- have no table on purpose — they are signed-only and short-lived, so the hot
-- path does no lookup at all. Kept here rather than created lazily by the
-- store, so the whole schema stays readable in one place.
CREATE TABLE IF NOT EXISTS oauth_codes (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_exp ON oauth_codes(expires_at);
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  jti TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_user ON oauth_refresh_tokens(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_exp ON oauth_refresh_tokens(expires_at);
-- The OUTROSPECTION feed (src/outrospect.js): the outward-looking counterpart
-- to introspection — what everyone else is building, through the lens registry
-- in public/js/outrospect-core.js. Rows are ARTICLES, deliberately carrying no
-- identity column: who happened to be visiting when a headline was found is
-- not part of the record. the key column (the normalized URL) is UNIQUE so two
-- simultaneous visitor refreshes cannot double-file the same article and the
-- earliest first_seen always wins.
CREATE TABLE IF NOT EXISTS outrospect_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  lens TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  teaser TEXT,
  source TEXT,
  first_seen INTEGER NOT NULL,
  query TEXT
);
CREATE INDEX IF NOT EXISTS idx_outrospect_items_seen ON outrospect_items(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_outrospect_items_lens ON outrospect_items(lens, first_seen DESC);
-- The refresh run log: what backs the per-lens cooldown and the per-user rate
-- limit, and nothing more. It records WHICH lens was searched, never what the
-- reader was looking for — the queries are the literal strings committed in
-- the lens registry, so the queries column is a count, not text.
CREATE TABLE IF NOT EXISTS outrospect_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  lens TEXT NOT NULL,
  queries INTEGER NOT NULL DEFAULT 0,
  found INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outrospect_runs_ts ON outrospect_runs(ts DESC);
-- The INDEXED ARTICLE TEXT behind the feed (owner feedback #28, 2026-07-26):
-- a headline and a teaser are enough to LIST what someone shipped and nowhere
-- near enough to QUOTE it. One row per article whose page text has been
-- fetched (src/outrospect.js indexFeedTexts → the existing Exa /contents
-- client), keyed by the same normalized URL as outrospect_items, so the two
-- tables join on that key and an article can only ever have one body.
--
-- Identity-free like outrospect_items: the row carries the ARTICLE, never the
-- reader — there is no user column and there must not be one. A chars value of
-- 0 is a deliberately stored NEGATIVE result ("we asked and got nothing
-- usable"), so a dead page is not re-fetched on every refresh forever.
--
-- The origin column names where the body came from ('web' for a fetched page).
-- It is the documented seam for other indexed corpora — arXiv papers above all
-- — to land in the same table and become quotable by the same retrieval
-- without any change to the reader side.
CREATE TABLE IF NOT EXISTS outrospect_texts (
  key TEXT PRIMARY KEY,
  lens TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  source TEXT,
  text TEXT NOT NULL,
  chars INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'web',
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outrospect_texts_lens ON outrospect_texts(lens, fetched_at DESC);
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
-- MUTUAL CONSENT, the consumer's half (owner directive, 2026-07-25). The
-- sharer's half lives in pool_consumers.state (pending|allowed|blocked); this
-- is the mirror image: one row per (consumer, pool) recording whether THIS
-- consumer agreed to let their prompts leave for THAT pool owner's machine.
-- Remembered, so the question is asked once per identity pair.
CREATE TABLE IF NOT EXISTS pool_egress (
  consumer_key TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  owner_display TEXT,
  consumer_display TEXT,
  first_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (consumer_key, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_pool_egress_pool ON pool_egress(pool_id, first_at DESC);

-- Workspace knowledge (src/knowledge.js, docs/COMPUTE-SHARING.md §9b).
-- knowledge_agent = the site's ONE import-agent ECDH keypair (generated on
-- first use; participants seal conclusions to its public half).
-- knowledge_inbox = sealed drskn envelopes, CIPHERTEXT at rest, routed to the
-- pool owner the submitting token named; plaintext exists only in the moment
-- the owner imports.
CREATE TABLE IF NOT EXISTS knowledge_agent (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_inbox (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_jti TEXT,
  envelope_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  imported_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_knowledge_inbox_owner ON knowledge_inbox(owner_id, created_at DESC);
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
  // The feedback redesign (owner directive, 2026-07-24): every entry carries
  // the whole conversation + request metadata as debugging context — additive
  // so the deployed DB picks it up.
  "ALTER TABLE feedback ADD COLUMN context TEXT",
  // Compute sharing gained MUTUAL CONSENT (2026-07-25): both parties are
  // shown the OTHER party's platform-verified identity, so both sides of the
  // relay now carry a display string, and an ingress decision records when
  // and by whom it was made. Additive — the deployed pool tables predate it.
  "ALTER TABLE pool_consumers ADD COLUMN identity TEXT",
  "ALTER TABLE pool_consumers ADD COLUMN verified INTEGER",
  "ALTER TABLE pool_consumers ADD COLUMN decided_at INTEGER",
  "ALTER TABLE pool_tokens ADD COLUMN owner TEXT",
  "ALTER TABLE pool_providers ADD COLUMN owner TEXT",
  // The capture QUEUE v2 (2026-08-11): a capture became a named, numbered
  // THREAD with successive versions. The table is already live with rows in
  // it, so these four are additive — a CREATE TABLE IF NOT EXISTS would not
  // touch an existing table, and the deployed rows must keep working.
  // The four rows recorded before the queue existed read back as version 1
  // (SQLite serves the constant DEFAULT for rows written before the column),
  // with no name, no commit and no answer — which is exactly what they are.
  // src/captures.js treats a falsy version as 1 either way.
  "ALTER TABLE captures ADD COLUMN name TEXT",
  "ALTER TABLE captures ADD COLUMN commit_sha TEXT",
  "ALTER TABLE captures ADD COLUMN version INTEGER DEFAULT 1",
  "ALTER TABLE captures ADD COLUMN answered_at INTEGER",
  // THE CHAT BEHIND THE CLIP (2026-08-14). Additive for the same reason as the
  // four above: the table is live. A row written before this column exists
  // reads back NULL, which src/captures.js reports as `has_chat: false` — the
  // capture still links to the app, it just opens the composer with the same
  // question instead of the recorded conversation.
  "ALTER TABLE captures ADD COLUMN chat_json TEXT",
];

let migrated = false; // per isolate

/**
 * Splits the multi-statement SCHEMA into individual SQL statements to prepare.
 *
 * SQL `--` line comments are STRIPPED FIRST, before splitting on `;`. This is
 * load-bearing: a comment may itself contain a semicolon (e.g. "bump
 * count/last_seen_at; a recurrence …"), and a naive `SCHEMA.split(";")` would
 * cut the comment mid-sentence, leaving a fragment like "a recurrence …" as its
 * own "statement". D1 then rejects it (`near "a": syntax error`), `db.batch`
 * throws, `getDb` throws, and EVERY database-backed feature — sign-in included —
 * 500s site-wide. Stripping comments (exactly what SQLite does with them anyway)
 * makes the split immune to punctuation in the prose.
 * @param {string} schema
 * @returns {string[]} trimmed, non-empty SQL statements
 */
export function splitStatements(schema) {
  return schema
    .replace(/--[^\n]*/g, "") // drop line comments (they can contain ';')
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    const statements = splitStatements(SCHEMA).map((s) => db.prepare(s));
    await db.batch(statements);
    for (const alter of ALTERS) {
      await db.prepare(alter).run().catch(() => {});
    }
    migrated = true;
  }
  return db;
}
