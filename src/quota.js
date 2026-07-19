// @ts-check
// Research quotas and usage accounting. Goal: complete, real-cost-grounded
// cost control. (Global config defaults live in src/config.js.)
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

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {"h5" | "day" | "week" | "month"} Period */
/** @typedef {{ budget_eur: number, searches: number }} QuotaLimit */
/** @typedef {Record<string, QuotaLimit>} QuotaMap */
/** @typedef {{ tokens: number, searches: number, berget_cost: number, exa_cost: number, hours: number, requests: number }} UsageWindow */
/** @typedef {{ h5: UsageWindow, day: UsageWindow, week: UsageWindow, month: UsageWindow, h5_oldest: number | null }} Usage */

/** @type {Period[]} */
export const PERIODS = ["h5", "day", "week", "month"];
const H5_MS = 5 * 3600 * 1000;

// ---- windows ---------------------------------------------------------------
// h5 is a rolling window (last 5 hours); day/week/month are UTC calendar.

/**
 * Start timestamp (ms) of a quota window: rolling for h5, UTC calendar else.
 * @param {string} period
 * @param {number} [now]
 * @returns {number}
 */
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
/**
 * When a window resets: for h5, when the oldest event ages out.
 * @param {string} period
 * @param {number} [now]
 * @param {number | null} [h5Oldest]
 * @returns {number}
 */
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

// ---- quota reset (admin "Reset quota" button) ------------------------------
//
// A per-user `quota_reset_at` timestamp is a FLOOR on which usage_events count
// toward the windows: only events with ts >= quota_reset_at are summed. ONE
// field, and both behaviors the admin asked for fall out of it:
//   • Set to "now"        → every prior event drops out; all bars reset to 0.
//   • Set to now + N days → every event until then has ts < quota_reset_at, so
//                           nothing counts → the user is effectively uncapped
//                           for that whole period ("extend available quota by
//                           a whole week"). It self-expires, no cleanup needed.
// Crucially it NEVER deletes a row: usage_events (and the admin's cost
// analytics / the chat history in other tables) stay fully intact — "reset the
// quota without losing history". The button sets it to now + DEFAULT_RESET_DAYS.

export const DAY_MS = 24 * 3600 * 1000;
export const DEFAULT_RESET_DAYS = 7; // "a whole week long period at least"
export const MAX_RESET_DAYS = 90;

/**
 * The `quota_reset_at` timestamp for a reset of `days` (clamped to a sane
 * range) starting at `now`. Pure + unit-tested.
 * @param {number} now
 * @param {number} [days]
 * @returns {number}
 */
export function quotaResetAt(now, days = DEFAULT_RESET_DAYS) {
  const d = Number.isFinite(Number(days))
    ? Math.min(MAX_RESET_DAYS, Math.max(1, Math.round(Number(days))))
    : DEFAULT_RESET_DAYS;
  return now + d * DAY_MS;
}

/**
 * Clamps each window start (and the widest-window scan floor) UP to `resetAt`
 * when it is set, so usage counts only events at/after the reset. A no-op when
 * resetAt is unset/0/past-all-starts. Pure + unit-tested.
 * @param {Record<string, number>} starts
 * @param {number} minStart
 * @param {number | null | undefined} resetAt
 * @returns {{ starts: Record<string, number>, minStart: number }}
 */
export function applyResetFloor(starts, minStart, resetAt) {
  const floor = Number(resetAt);
  if (!(floor > 0)) return { starts, minStart };
  const clamped = Object.fromEntries(
    Object.entries(starts).map(([p, s]) => [p, Math.max(s, floor)]),
  );
  return { starts: clamped, minStart: Math.max(minStart, floor) };
}

// ---- per-user quota resolution --------------------------------------------

// A user's quota_json can override any subset:
//   {"h5":{"budget_eur":1},"day":{"searches":200}}
/**
 * Merges a user's quota_json overrides onto the global config defaults.
 * @param {{ quotas: QuotaMap }} config
 * @param {{ quota_json?: string | null } | null | undefined} user
 * @returns {QuotaMap}
 */
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
// All three queries share one shape: a single scan over the widest window,
// bucketed per period with SUM(CASE WHEN ts >= start ...). The scan filter
// uses the MINIMUM of all window starts: the ISO week can begin before the
// month does, and the rolling 5h window can reach past midnight or the
// start of the month.

/**
 * @param {number} now
 * @returns {{ starts: Record<string, number>, minStart: number }}
 */
function windowStarts(now) {
  const starts = Object.fromEntries(
    PERIODS.map((p) => /** @type {[string, number]} */ ([p, windowStart(p, now)])),
  );
  return { starts, minStart: Math.min(...Object.values(starts)) };
}

// SELECT columns bucketing each (expr → alias) pair into every period:
// `SUM(CASE WHEN ts >= <start> THEN <expr> ELSE 0 END) AS <period>_<alias>`.
/**
 * @param {Record<string, number>} starts
 * @param {Record<string, string>} exprs alias -> SQL expression
 * @returns {string}
 */
function bucketCols(starts, exprs) {
  return PERIODS.flatMap((p) =>
    Object.entries(exprs).map(
      ([alias, expr]) => `SUM(CASE WHEN ts >= ${starts[p]} THEN ${expr} ELSE 0 END) AS ${p}_${alias}`,
    ),
  ).join(", ");
}

const USAGE_EXPRS = {
  tokens: "prompt_tokens + completion_tokens",
  searches: "searches",
  berget_cost: "berget_cost",
  exa_cost: "exa_cost",
  ms: "duration_ms",
};

/** @returns {UsageWindow} */
const emptyWindow = () => ({
  tokens: 0,
  searches: 0,
  berget_cost: 0,
  exa_cost: 0,
  hours: 0,
  requests: 0,
});

// One user's usage per window, for quota checks and the account panel.
// Also returns h5_oldest (oldest event inside the rolling window) for the
// rolling reset estimate.
/**
 * One user's usage per window, plus h5_oldest for the rolling reset estimate.
 * `resetAt` (the user's quota_reset_at) floors which events count — see
 * applyResetFloor: a value at/after `now` zeroes every window, a future value
 * keeps them zero until it passes (the admin "Reset quota" grace).
 * @param {Env} env
 * @param {string | number} userId
 * @param {number} [now]
 * @param {number | null} [resetAt]
 * @returns {Promise<Usage>}
 */
export async function getUsage(env, userId, now = Date.now(), resetAt = 0) {
  const db = await getDb(env);
  /** @type {Usage} */
  const out = { h5: emptyWindow(), day: emptyWindow(), week: emptyWindow(), month: emptyWindow(), h5_oldest: null };
  if (!db) return out;
  const base = windowStarts(now);
  const { starts, minStart } = applyResetFloor(base.starts, base.minStart, resetAt);
  const cols = bucketCols(starts, { ...USAGE_EXPRS, requests: "1" });
  // Every selected column is a numeric aggregate (NULL on an empty scan).
  const row = /** @type {Record<string, number | null> | null} */ (
    await db
      .prepare(
        `SELECT ${cols},
           MIN(CASE WHEN ts >= ${starts.h5} THEN ts END) AS h5_oldest
         FROM usage_events WHERE user_id = ?1 AND ts >= ?2`,
      )
      .bind(String(userId), minStart)
      .first()
  );
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
/**
 * Site-wide per-user usage aggregates for the admin dashboard.
 * @param {Env} env
 * @param {number} [now]
 * @returns {Promise<any[]>}
 */
export async function getUsageAllUsers(env, now = Date.now()) {
  const db = await getDb(env);
  if (!db) return [];
  const { starts, minStart } = windowStarts(now);
  const { results } = await db
    .prepare(
      `SELECT user_id, ${bucketCols(starts, USAGE_EXPRS)},
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
/**
 * Per-model token/cost breakdown for the admin, sorted by month cost.
 * @param {Env} env
 * @param {number} [now]
 * @returns {Promise<any[]>}
 */
export async function getUsageByModel(env, now = Date.now()) {
  const db = await getDb(env);
  if (!db) return [];
  const { starts, minStart } = windowStarts(now);
  const cols = bucketCols(starts, {
    tokens: "prompt_tokens + completion_tokens",
    cost: "berget_cost",
  });
  const { results } = await db
    .prepare(
      `SELECT COALESCE(model, '(unknown)') AS model, ${cols},
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
/**
 * First breached window/dimension, or null when within all quotas.
 * @param {Usage} usage
 * @param {QuotaMap} quota
 * @param {number} [now]
 * @returns {{ period: string, kind: "budget" | "searches", limit: number, used: number, reset_at: number } | null}
 */
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

// ---- in-flight concurrency reservation (M-1 / M-2) -------------------------
//
// The quota gate above is check-then-act: admission reads accumulated usage,
// but a request's spend is only recorded AFTER it finishes. N requests firing
// concurrently near the cap all read the same pre-spend usage, all pass, and
// overspend by ~N×. There is also no ceiling on how many expensive requests a
// single user can have running at once. A per-user CONCURRENT-request cap
// bounds both: a small D1-backed reservation held for the life of a request.
//
// CAP = 5: comfortably above any honest user (a few browser tabs / a retry
// mid-flight), low enough that a burst can't multiply spend by a large factor.
// TTL = 300 s: a crashed request's row can't hold a slot forever — it ages out
// on the next reservation sweep. Aligned with wrangler.toml's cpu_ms=300000
// (the Paid maximum); a request that has legitimately been alive longer than
// this is an outlier, and the only cost of sweeping it early is that its slot
// frees a little sooner (a softer cap, never a broken request).
//
// FAIL-SOFT ABOVE ALL (invariant 2): every D1 touch here degrades to "allowed"
// — a database outage must never turn into a blocked user or a 500. The cap is
// abuse mitigation, not a correctness barrier, so failing open is correct.

export const INFLIGHT_CAP = 5;
export const INFLIGHT_TTL_MS = 300_000;

/**
 * Pure decision: is a user at/over the concurrency cap? At EXACTLY the cap the
 * user already holds `cap` slots, so a further request is refused. Unit-tested.
 * @param {number} activeCount reservations currently held by the user
 * @param {number} cap
 * @returns {boolean}
 */
export function overCap(activeCount, cap) {
  return activeCount >= cap;
}

/**
 * Reserves one in-flight slot for a user, enforcing the per-user concurrency
 * cap. Sweeps stale rows first, counts the user's live reservations, and
 * either inserts the reservation (ok) or refuses without inserting (limited).
 * FAIL-SOFT: no db, or ANY D1 error, returns `{ ok: true, degraded: true }`
 * (fail open — never block on infrastructure failure).
 * @param {Env} env
 * @param {string | number} userId
 * @param {string} reqId unique per request (reuse the request id, or mint one)
 * @param {number} [now]
 * @returns {Promise<{ ok: true, degraded?: boolean } | { ok: false, limit: number, active: number }>}
 */
export async function reserveInflight(env, userId, reqId, now = Date.now()) {
  try {
    const db = await getDb(env);
    if (!db) return { ok: true, degraded: true };
    // Age out crashed/abandoned reservations before counting.
    await db.prepare("DELETE FROM inflight WHERE ts < ?1").bind(now - INFLIGHT_TTL_MS).run();
    const row = /** @type {{ n: number } | null} */ (
      await db.prepare("SELECT COUNT(*) AS n FROM inflight WHERE user_id = ?1").bind(String(userId)).first()
    );
    const active = row?.n || 0;
    if (overCap(active, INFLIGHT_CAP)) return { ok: false, limit: INFLIGHT_CAP, active };
    await db
      .prepare("INSERT INTO inflight (req_id, user_id, ts) VALUES (?1, ?2, ?3)")
      .bind(String(reqId), String(userId), now)
      .run();
    return { ok: true };
  } catch {
    // Fail open: a D1 outage must never block a user or 500 the request.
    return { ok: true, degraded: true };
  }
}

/**
 * Releases a user's in-flight reservation. Fully fail-soft (swallows errors):
 * a failed release only leaves a row that the next sweep ages out.
 * @param {Env} env
 * @param {string | number} reqId
 * @returns {Promise<void>}
 */
export async function releaseInflight(env, reqId) {
  try {
    const db = await getDb(env);
    if (!db) return;
    await db.prepare("DELETE FROM inflight WHERE req_id = ?1").bind(String(reqId)).run();
  } catch {
    // Swallow — accounting/limits must never break the request.
  }
}

/** @type {Record<string, string>} */
const PERIOD_NAMES = { h5: "5-hour", day: "daily", week: "weekly", month: "monthly" };

/**
 * Human "time remaining" phrase for a reset that is `ms` milliseconds away, so
 * a blocked user reads when they're free WITHOUT doing clock arithmetic on a
 * UTC timestamp ("in about 2h 15m" beats "resets 2026-07-17 14:30 UTC" alone).
 * Coarsens as the distance grows: minutes → h+m → d+h. Pure and unit-tested.
 * @param {number} ms milliseconds until the reset (reset_at - now)
 * @returns {string}
 */
export function formatResetRelative(ms) {
  if (ms <= 60_000) return "any moment now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in about ${mins} min`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  if (hours < 24) return m ? `in about ${hours}h ${m}m` : `in about ${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `in about ${days}d ${h}h` : `in about ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Builds the 429 payload for a blocked quota window: a plain-language
 * message (period + reset time — budget amounts are EUR, admin-only
 * information, never sent to users) and the public quota object the
 * client renders.
 * @param {{ period: string, kind: string, limit?: number, reset_at: number }} blocked
 * @param {number} [now]
 * @returns {{ error: string, quota: object }}
 */
export function quotaBlockedResponse(blocked, now = Date.now()) {
  const periodName = PERIOD_NAMES[blocked.period];
  const verb = blocked.period === "h5" ? "frees up" : "resets";
  // Relative first (no clock math for the user), exact UTC in parens.
  const rel = formatResetRelative(blocked.reset_at - now);
  const when = `${new Date(blocked.reset_at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const error =
    blocked.kind === "budget"
      ? `You've used your ${periodName} research budget. It ${verb} ${rel} (${when}).`
      : `You've used your ${periodName} search budget ` +
        `(${Number(blocked.limit).toLocaleString("en-US")} searches). It ${verb} ${rel} (${when}).`;
  const publicQuota =
    blocked.kind === "budget"
      ? { period: blocked.period, kind: blocked.kind, reset_at: blocked.reset_at }
      : blocked;
  return { error, quota: publicQuota };
}

/**
 * The 429 payload for a refused concurrency reservation — plain-language, no
 * internal cost figures (mirrors quotaBlockedResponse's shape, but this is a
 * rate/concurrency limit, said so explicitly).
 * @param {{ limit: number, active: number }} limited
 * @returns {{ error: string, rate_limit: { limit: number, active: number } }}
 */
export function inflightLimitResponse(limited) {
  return {
    error:
      `You already have ${limited.limit} research requests running at once, ` +
      `which is the limit. Please wait for one to finish, then try again.`,
    rate_limit: { limit: limited.limit, active: limited.active },
  };
}

// ---- recording -------------------------------------------------------------

// Accumulates one Berget usage report into a running {prompt_tokens,
// completion_tokens} totals bucket. The pipeline keeps a separate bucket per
// model that ran (answer / JSON planning / vision helper) so each is billed
// at its own catalog rate — see summarizeSpend in chat.js.
/**
 * @param {{ prompt_tokens: number, completion_tokens: number }} totals
 * @param {{ prompt_tokens?: number, completion_tokens?: number } | null | undefined} usage
 */
export function addUsage(totals, usage) {
  if (!usage) return;
  totals.prompt_tokens += usage.prompt_tokens || 0;
  totals.completion_tokens += usage.completion_tokens || 0;
}

// Berget prices are EUR per token in the catalog (price_in/price_out).
/**
 * Berget cost (EUR) for a token spend against a catalog entry's prices.
 * @param {{ price_in?: number, price_out?: number } | null | undefined} catalogEntry
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number}
 */
export function bergetCost(catalogEntry, promptTokens, completionTokens) {
  if (!catalogEntry) return 0;
  return (
    (catalogEntry.price_in || 0) * (promptTokens || 0) +
    (catalogEntry.price_out || 0) * (completionTokens || 0)
  );
}

/**
 * Records one usage_events row. Never throws — accounting must not break a
 * served answer.
 * @param {Env} env
 * @param {Logger} log
 * @param {any} evt the usage record ({ user_id, model?, prompt_tokens?, ... })
 * @returns {Promise<void>}
 */
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
    log.error("quota.record_failed", { error: (/** @type {any} */ (err))?.message || String(err) });
  }
}
