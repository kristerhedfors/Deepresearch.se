// Research quotas and usage accounting, Claude Code-style: each user gets
// caps on research HOURS (wall-clock pipeline time) and COST (Berget token
// spend + Exa search spend, in EUR) per calendar day, week (ISO, Monday)
// and month, all UTC. Global defaults live in the config table; per-user
// overrides in users.quota_json (same shape, missing fields inherit).
// The admin identity is exempt from enforcement but still recorded.

import { getDb } from "./db.js";

export const PERIODS = ["day", "week", "month"];

export const DEFAULT_CONFIG = {
  quotas: {
    day: { hours: 1, cost_eur: 0.5 },
    week: { hours: 4, cost_eur: 2 },
    month: { hours: 12, cost_eur: 6 },
  },
  exa_cost_per_search_eur: 0.005,
  max_time_budget_s: 600, // cap for the UI slider value accepted server-side
  default_model: "", // empty = Worker default (BERGET_MODEL var / built-in)
};

// ---- global config -------------------------------------------------------

let configCache = { at: 0, value: null };
const CONFIG_TTL_MS = 30_000;

export async function getConfig(env) {
  const db = await getDb(env);
  if (!db) return structuredClone(DEFAULT_CONFIG);
  if (configCache.value && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.value;
  }
  const row = await db.prepare("SELECT value FROM config WHERE key='app'").first();
  let stored = {};
  try {
    stored = row ? JSON.parse(row.value) : {};
  } catch {
    stored = {};
  }
  const merged = mergeConfig(DEFAULT_CONFIG, stored);
  configCache = { at: Date.now(), value: merged };
  return merged;
}

export async function saveConfig(env, patch) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  const current = await getConfig(env);
  const next = mergeConfig(current, sanitizeConfigPatch(patch));
  await db
    .prepare("INSERT INTO config (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(JSON.stringify(next))
    .run();
  configCache = { at: Date.now(), value: next };
  return next;
}

function mergeConfig(base, patch) {
  const out = structuredClone(base);
  if (!patch || typeof patch !== "object") return out;
  for (const p of PERIODS) {
    const q = patch.quotas?.[p];
    if (q && typeof q === "object") {
      if (Number.isFinite(q.hours)) out.quotas[p].hours = Math.max(0, q.hours);
      if (Number.isFinite(q.cost_eur)) out.quotas[p].cost_eur = Math.max(0, q.cost_eur);
    }
  }
  if (Number.isFinite(patch.exa_cost_per_search_eur)) {
    out.exa_cost_per_search_eur = Math.max(0, patch.exa_cost_per_search_eur);
  }
  if (Number.isFinite(patch.max_time_budget_s)) {
    out.max_time_budget_s = Math.min(600, Math.max(15, Math.round(patch.max_time_budget_s)));
  }
  if (typeof patch.default_model === "string") out.default_model = patch.default_model;
  return out;
}

// Only known keys survive into storage (an admin API caller can't stuff
// arbitrary JSON into config).
function sanitizeConfigPatch(patch) {
  return {
    quotas: patch?.quotas,
    exa_cost_per_search_eur: numOr(patch?.exa_cost_per_search_eur),
    max_time_budget_s: numOr(patch?.max_time_budget_s),
    default_model: patch?.default_model,
  };
}
const numOr = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : undefined);

// ---- calendar windows (UTC) -----------------------------------------------

export function windowStart(period, now = Date.now()) {
  const d = new Date(now);
  if (period === "day") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (period === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // Monday=0
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function windowReset(period, now = Date.now()) {
  const d = new Date(now);
  if (period === "day") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  if (period === "week") {
    const dow = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow + 7);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// ---- per-user quota resolution --------------------------------------------

// A user's quota_json can override any subset:
//   {"day":{"hours":2,"cost_eur":1},"week":{"cost_eur":5}}
export function effectiveQuota(config, user) {
  const out = structuredClone(config.quotas);
  let override = null;
  try {
    override = user?.quota_json ? JSON.parse(user.quota_json) : null;
  } catch {
    override = null;
  }
  for (const p of PERIODS) {
    const o = override?.[p];
    if (o && typeof o === "object") {
      if (Number.isFinite(o.hours)) out[p].hours = Math.max(0, o.hours);
      if (Number.isFinite(o.cost_eur)) out[p].cost_eur = Math.max(0, o.cost_eur);
    }
  }
  return out;
}

// ---- usage aggregation -----------------------------------------------------

// {day:{cost_eur, hours, searches, tokens, requests}, week:{...}, month:{...}}
export async function getUsage(env, userId, now = Date.now()) {
  const db = await getDb(env);
  const empty = () => ({ cost_eur: 0, hours: 0, searches: 0, tokens: 0, requests: 0 });
  const out = { day: empty(), week: empty(), month: empty() };
  if (!db) return out;
  const monthStart = windowStart("month", now);
  const weekStart = windowStart("week", now);
  const dayStart = windowStart("day", now);
  // One scan of the month window; day/week are subsets bucketed in JS-free SQL.
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN ts >= ?1 THEN berget_cost + exa_cost ELSE 0 END) AS day_cost,
         SUM(CASE WHEN ts >= ?1 THEN duration_ms ELSE 0 END) AS day_ms,
         SUM(CASE WHEN ts >= ?1 THEN searches ELSE 0 END) AS day_searches,
         SUM(CASE WHEN ts >= ?1 THEN prompt_tokens + completion_tokens ELSE 0 END) AS day_tokens,
         SUM(CASE WHEN ts >= ?1 THEN 1 ELSE 0 END) AS day_requests,
         SUM(CASE WHEN ts >= ?2 THEN berget_cost + exa_cost ELSE 0 END) AS week_cost,
         SUM(CASE WHEN ts >= ?2 THEN duration_ms ELSE 0 END) AS week_ms,
         SUM(CASE WHEN ts >= ?2 THEN searches ELSE 0 END) AS week_searches,
         SUM(CASE WHEN ts >= ?2 THEN prompt_tokens + completion_tokens ELSE 0 END) AS week_tokens,
         SUM(CASE WHEN ts >= ?2 THEN 1 ELSE 0 END) AS week_requests,
         SUM(berget_cost + exa_cost) AS month_cost,
         SUM(duration_ms) AS month_ms,
         SUM(searches) AS month_searches,
         SUM(prompt_tokens + completion_tokens) AS month_tokens,
         COUNT(*) AS month_requests
       FROM usage_events WHERE user_id = ?3 AND ts >= ?4`,
    )
    .bind(dayStart, weekStart, String(userId), monthStart)
    .first();
  for (const p of PERIODS) {
    out[p].cost_eur = row?.[`${p}_cost`] || 0;
    out[p].hours = (row?.[`${p}_ms`] || 0) / 3_600_000;
    out[p].searches = row?.[`${p}_searches`] || 0;
    out[p].tokens = row?.[`${p}_tokens`] || 0;
    out[p].requests = row?.[`${p}_requests`] || 0;
  }
  return out;
}

// Site-wide aggregate for the admin dashboard (all users, current windows).
export async function getUsageAllUsers(env, now = Date.now()) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare(
      `SELECT user_id,
         SUM(CASE WHEN ts >= ?1 THEN berget_cost + exa_cost ELSE 0 END) AS day_cost,
         SUM(CASE WHEN ts >= ?1 THEN duration_ms ELSE 0 END) AS day_ms,
         SUM(CASE WHEN ts >= ?2 THEN berget_cost + exa_cost ELSE 0 END) AS week_cost,
         SUM(CASE WHEN ts >= ?2 THEN duration_ms ELSE 0 END) AS week_ms,
         SUM(berget_cost + exa_cost) AS month_cost,
         SUM(duration_ms) AS month_ms,
         SUM(searches) AS month_searches,
         SUM(prompt_tokens + completion_tokens) AS month_tokens,
         COUNT(*) AS month_requests
       FROM usage_events WHERE ts >= ?3 GROUP BY user_id`,
    )
    .bind(windowStart("day", now), windowStart("week", now), windowStart("month", now))
    .all();
  return results || [];
}

// ---- enforcement -----------------------------------------------------------

// Returns null when within quota, else {period, kind, limit, used, reset_at}.
export function quotaExceeded(usage, quota, now = Date.now()) {
  for (const p of PERIODS) {
    if (quota[p].cost_eur > 0 && usage[p].cost_eur >= quota[p].cost_eur) {
      return { period: p, kind: "cost", limit: quota[p].cost_eur, used: usage[p].cost_eur, reset_at: windowReset(p, now) };
    }
    if (quota[p].hours > 0 && usage[p].hours >= quota[p].hours) {
      return { period: p, kind: "hours", limit: quota[p].hours, used: usage[p].hours, reset_at: windowReset(p, now) };
    }
  }
  return null;
}

// Seconds of research time left in the tightest hour window — used to clamp
// the requested time budget so one request can't blow through the cap.
export function remainingSeconds(usage, quota) {
  let min = Infinity;
  for (const p of PERIODS) {
    if (quota[p].hours > 0) {
      min = Math.min(min, Math.max(0, (quota[p].hours - usage[p].hours) * 3600));
    }
  }
  return min;
}

// ---- recording -------------------------------------------------------------

// Berget prices are EUR per token in the catalog (price_in/price_out).
export function bergetCost(catalogEntry, promptTokens, completionTokens) {
  if (!catalogEntry) return 0;
  return (
    (catalogEntry.price_in || 0) * (promptTokens || 0) +
    (catalogEntry.price_out || 0) * (completionTokens || 0)
  );
}

export async function recordUsage(env, log, evt) {
  try {
    const db = await getDb(env);
    if (!db) return;
    await db
      .prepare(
        `INSERT INTO usage_events
           (user_id, ts, model, prompt_tokens, completion_tokens, searches, berget_cost, exa_cost, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        String(evt.user_id),
        Date.now(),
        evt.model || null,
        evt.prompt_tokens | 0,
        evt.completion_tokens | 0,
        evt.searches | 0,
        Number(evt.berget_cost) || 0,
        Number(evt.exa_cost) || 0,
        evt.duration_ms | 0,
      )
      .run();
  } catch (err) {
    // Accounting must never break a served answer.
    log.error("quota.record_failed", { error: err?.message || String(err) });
  }
}
