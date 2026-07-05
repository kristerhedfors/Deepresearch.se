// Research quotas and usage accounting. Goal: complete, real-cost-grounded
// cost control.
//
// Quota dimensions per window:
//   - BUDGET_EUR (Berget): a COST cap. Different models bill different
//     per-token prices, so tokens alone can't cap spend — every request's
//     Berget cost is computed from the catalog's real per-token prices and
//     summed against the budget. Users see this only as an opaque
//     percentage bar — the EUR amount never leaves the admin surface.
//   - SEARCHES (Exa): a COUNT cap. Exa bills per search at one price, so
//     the count IS the cost; users may see the counts.
// Windows: a ROLLING last-5-hours window (Claude Code-style) plus UTC
// calendar day, ISO week (Monday), and calendar month. No time limits.
// 0 = uncapped.
//
// The admin additionally gets per-model token counts and cost
// (getUsageByModel) — granular ground truth for what the budget is spent
// on. Global defaults live in the config table; per-user overrides in
// users.quota_json (same shape, missing fields inherit). The break-glass
// admin identity is exempt from enforcement but still recorded.

import { getDb } from "./db.js";

export const PERIODS = ["h5", "day", "week", "month"];
const H5_MS = 5 * 3600 * 1000;

export const DEFAULT_CONFIG = {
  quotas: {
    h5: { budget_eur: 0.25, searches: 30 },
    day: { budget_eur: 0.5, searches: 100 },
    week: { budget_eur: 2, searches: 400 },
    month: { budget_eur: 6, searches: 1200 },
  },
  exa_cost_per_search_eur: 0.005,
  max_time_budget_s: 600, // cap for the UI slider value accepted server-side
  default_model: "", // empty = Worker default (BERGET_MODEL var / built-in)
  // Approval gate: new Google sign-ins land as status "pending" (waiting
  // page, no API access) until the admin approves them in /admin.
  require_approval: true,
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
      if (Number.isFinite(q.budget_eur)) out.quotas[p].budget_eur = Math.max(0, q.budget_eur);
      if (Number.isFinite(q.searches)) out.quotas[p].searches = Math.max(0, Math.round(q.searches));
    }
  }
  if (Number.isFinite(patch.exa_cost_per_search_eur)) {
    out.exa_cost_per_search_eur = Math.max(0, patch.exa_cost_per_search_eur);
  }
  if (Number.isFinite(patch.max_time_budget_s)) {
    out.max_time_budget_s = Math.min(600, Math.max(15, Math.round(patch.max_time_budget_s)));
  }
  if (typeof patch.default_model === "string") out.default_model = patch.default_model;
  if (typeof patch.require_approval === "boolean") out.require_approval = patch.require_approval;
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
    require_approval: patch?.require_approval,
  };
}
const numOr = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : undefined);

// ---- windows ---------------------------------------------------------------
// h5 is a rolling window (last 5 hours); day/week/month are UTC calendar.

export function windowStart(period, now = Date.now()) {
  if (period === "h5") return now - H5_MS;
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

// For the rolling window the "reset" is when the oldest event inside it
// ages out — pass that timestamp (getUsage exposes it as h5_oldest).
export function windowReset(period, now = Date.now(), h5Oldest = null) {
  if (period === "h5") return (h5Oldest || now) + H5_MS;
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
//   {"h5":{"budget_eur":1},"day":{"searches":200}}
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
      if (Number.isFinite(o.budget_eur)) out[p].budget_eur = Math.max(0, o.budget_eur);
      if (Number.isFinite(o.searches)) out[p].searches = Math.max(0, Math.round(o.searches));
    }
  }
  return out;
}

// ---- usage aggregation -----------------------------------------------------

const emptyWindow = () => ({
  tokens: 0,
  searches: 0,
  berget_cost: 0,
  exa_cost: 0,
  hours: 0,
  requests: 0,
});

// One scan over the widest window, bucketed per period in SQL. The filter
// uses the MINIMUM of all window starts: the ISO week can begin before the
// month does, and the rolling 5h window can reach past midnight or the
// start of the month.
// Also returns h5_oldest (oldest event inside the rolling window) for the
// rolling reset estimate.
export async function getUsage(env, userId, now = Date.now()) {
  const db = await getDb(env);
  const out = { h5: emptyWindow(), day: emptyWindow(), week: emptyWindow(), month: emptyWindow(), h5_oldest: null };
  if (!db) return out;
  const starts = Object.fromEntries(PERIODS.map((p) => [p, windowStart(p, now)]));
  const minStart = Math.min(...Object.values(starts));
  const bucket = (p, expr, alias) =>
    `SUM(CASE WHEN ts >= ${starts[p]} THEN ${expr} ELSE 0 END) AS ${p}_${alias}`;
  const cols = PERIODS.flatMap((p) => [
    bucket(p, "prompt_tokens + completion_tokens", "tokens"),
    bucket(p, "searches", "searches"),
    bucket(p, "berget_cost", "berget_cost"),
    bucket(p, "exa_cost", "exa_cost"),
    bucket(p, "duration_ms", "ms"),
    bucket(p, "1", "requests"),
  ]);
  const row = await db
    .prepare(
      `SELECT ${cols.join(", ")},
         MIN(CASE WHEN ts >= ${starts.h5} THEN ts END) AS h5_oldest
       FROM usage_events WHERE user_id = ?1 AND ts >= ?2`,
    )
    .bind(String(userId), minStart)
    .first();
  for (const p of PERIODS) {
    out[p].tokens = row?.[`${p}_tokens`] || 0;
    out[p].searches = row?.[`${p}_searches`] || 0;
    out[p].berget_cost = row?.[`${p}_berget_cost`] || 0;
    out[p].exa_cost = row?.[`${p}_exa_cost`] || 0;
    out[p].hours = (row?.[`${p}_ms`] || 0) / 3_600_000;
    out[p].requests = row?.[`${p}_requests`] || 0;
  }
  out.h5_oldest = row?.h5_oldest || null;
  return out;
}

// Site-wide per-user aggregates for the admin dashboard: counts AND costs
// for every window. Keys: <period>_tokens/_searches/_berget_cost/_exa_cost/
// _ms + month_requests.
export async function getUsageAllUsers(env, now = Date.now()) {
  const db = await getDb(env);
  if (!db) return [];
  const starts = Object.fromEntries(PERIODS.map((p) => [p, windowStart(p, now)]));
  const minStart = Math.min(...Object.values(starts));
  const bucket = (p, expr, alias) =>
    `SUM(CASE WHEN ts >= ${starts[p]} THEN ${expr} ELSE 0 END) AS ${p}_${alias}`;
  const cols = PERIODS.flatMap((p) => [
    bucket(p, "prompt_tokens + completion_tokens", "tokens"),
    bucket(p, "searches", "searches"),
    bucket(p, "berget_cost", "berget_cost"),
    bucket(p, "exa_cost", "exa_cost"),
    bucket(p, "duration_ms", "ms"),
  ]);
  const { results } = await db
    .prepare(
      `SELECT user_id, ${cols.join(", ")},
         SUM(CASE WHEN ts >= ${starts.month} THEN 1 ELSE 0 END) AS month_requests
       FROM usage_events WHERE ts >= ?1 GROUP BY user_id`,
    )
    .bind(minStart)
    .all();
  return results || [];
}

// Per-model breakdown for the admin: token counts and Berget cost per
// window, plus prompt/completion split for the month — the granular
// ground truth behind the cost budgets. Sorted by month cost.
export async function getUsageByModel(env, now = Date.now()) {
  const db = await getDb(env);
  if (!db) return [];
  const starts = Object.fromEntries(PERIODS.map((p) => [p, windowStart(p, now)]));
  const minStart = Math.min(...Object.values(starts));
  const bucket = (p, expr, alias) =>
    `SUM(CASE WHEN ts >= ${starts[p]} THEN ${expr} ELSE 0 END) AS ${p}_${alias}`;
  const cols = PERIODS.flatMap((p) => [
    bucket(p, "prompt_tokens + completion_tokens", "tokens"),
    bucket(p, "berget_cost", "cost"),
  ]);
  const { results } = await db
    .prepare(
      `SELECT COALESCE(model, '(unknown)') AS model, ${cols.join(", ")},
         SUM(CASE WHEN ts >= ${starts.month} THEN prompt_tokens ELSE 0 END) AS month_prompt,
         SUM(CASE WHEN ts >= ${starts.month} THEN completion_tokens ELSE 0 END) AS month_completion,
         SUM(CASE WHEN ts >= ${starts.month} THEN 1 ELSE 0 END) AS month_requests
       FROM usage_events WHERE ts >= ?1 AND (prompt_tokens + completion_tokens) > 0
       GROUP BY COALESCE(model, '(unknown)')
       ORDER BY month_cost DESC`,
    )
    .bind(minStart)
    .all();
  return results || [];
}

// ---- enforcement -----------------------------------------------------------

// Returns null when within quota, else {period, kind, limit, used, reset_at}.
// kind "budget" compares accumulated Berget COST against budget_eur (real
// cost grounding — models price tokens differently); kind "searches" is a
// straight count. Callers must not expose budget limit/used to users.
export function quotaExceeded(usage, quota, now = Date.now()) {
  for (const p of PERIODS) {
    if (quota[p].budget_eur > 0 && usage[p].berget_cost >= quota[p].budget_eur) {
      return {
        period: p,
        kind: "budget",
        limit: quota[p].budget_eur,
        used: usage[p].berget_cost,
        reset_at: windowReset(p, now, usage.h5_oldest),
      };
    }
    if (quota[p].searches > 0 && usage[p].searches >= quota[p].searches) {
      return {
        period: p,
        kind: "searches",
        limit: quota[p].searches,
        used: usage[p].searches,
        reset_at: windowReset(p, now, usage.h5_oldest),
      };
    }
  }
  return null;
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
