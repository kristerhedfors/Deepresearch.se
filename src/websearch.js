// @ts-check
// Temporary web-search GRANTS for DeepResearch.Se/cure (DRC) — the mint
// subsystem: the quota METER, the two public endpoints the browser calls, and
// the ADMIN control surface for minting shareable links and governing the
// overall budget. Built on the signed tokens in websearch-key.js.
//
// The deliberate, NARROW relaxation of invariant 4 (the server is in no DRC
// data path): a short-lived, quota-metered token lets an otherwise server-less
// Se/cure session run a bounded number of live web searches through THIS
// server's Exa key — so the session keeps the strong Se/cure posture (own/local
// model, browser-local storage) while still getting fresh web results. ONLY a
// query string crosses the wire (never the conversation); it is opt-in, and
// off for every visitor who didn't receive a grant.
//
// TWO WAYS to receive a grant, both ending as one row in D1 `websearch_grants`
// (keyed by the token's `jti` — a self-contained token can't decrement a
// counter across requests, so the token authenticates and the row meters):
//   1. GHOST CROSSOVER — a signed-in Se/rver user crossing to Se/cure mints
//      (or reuses) THEIR grant via authed POST /api/websearch/grant.
//   2. SHAREABLE LINK — an admin mints a grant in the control panel and gets a
//      `…/cure?ws=<token>` link anyone can follow (POST /api/admin/websearch);
//      the follower's browser calls PUBLIC POST /api/websearch/status to read
//      the grant, then spends it via PUBLIC POST /api/websearch.
//
// The admin control panel (src/config.js `websearch` block, edited via
// PUT /api/admin/config) sets the DEFAULT quota / TTL per minted key, the
// master `enabled` switch, and a global `budget` ceiling on the total
// OUTSTANDING remaining across all live grants (0 = uncapped) — "the entire set
// of quota" governance.
//
// Fail-safe by construction: with NO D1 the whole feature is OFF (grants can't
// be minted or metered → 503), so no unmetered server-paid search is possible.

import { getConfig } from "./config.js";
import { getDb } from "./db.js";
import { webSearch } from "./exa.js";
import { jsonResponse } from "./http.js";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";

const QUERY_MAX = 400; // bound the query the server will run
const GRANTS_LIST_MAX = 200; // admin list cap
// Modest, fixed server-side depth for a granted search — the DRC session has no
// time-budget slider, and this shares the server's Exa budget across all users.
const GRANT_DEPTH = { numResults: 6, type: "auto" };

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

/**
 * The effective mint defaults + governance, resolved from site config.
 * @typedef {Object} GrantDefaults
 * @property {boolean} enabled
 * @property {number} quota default searches per key
 * @property {number} ttlHours default lifetime in hours
 * @property {number} budget global outstanding-remaining ceiling (0 = uncapped)
 */

/** @param {Env} env @returns {Promise<GrantDefaults>} the config-driven defaults */
async function grantDefaults(env) {
  const w = (await getConfig(env)).websearch || {};
  return {
    enabled: w.enabled !== false,
    quota: Number.isFinite(w.quota) && w.quota > 0 ? Math.floor(w.quota) : 25,
    ttlHours: Number.isFinite(w.ttl_hours) && w.ttl_hours > 0 ? w.ttl_hours : 24,
    budget: Number.isFinite(w.budget) && w.budget > 0 ? Math.floor(w.budget) : 0,
  };
}

/**
 * The public shape returned to the client for an active grant.
 * @typedef {Object} GrantView
 * @property {string} token the signed wsk1.… token
 * @property {string} [jti]
 * @property {number} quota
 * @property {number} used
 * @property {number} remaining
 * @property {number} expiresAt epoch ms
 * @property {string|null} [label]
 * @property {string|null} [source]
 */

/**
 * Sum of remaining quota across all live grants (the budget denominator).
 * @param {D1Database} db
 * @returns {Promise<number>}
 */
async function outstandingRemaining(db) {
  const nowS = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT COALESCE(SUM(quota - used), 0) AS rem FROM websearch_grants WHERE expires_at > ?1")
    .bind(nowS)
    .first()
    .catch(() => null);
  return row ? Number(row.rem) : 0;
}

/**
 * Mints a brand-new grant row + token. Shared by the admin link path and the
 * ghost path (when a user has no active grant). Enforces the global budget
 * ceiling. Returns the grant view, `{ error: "budget_exceeded", … }`, or null
 * (no D1 / insert failure).
 * @param {Env} env
 * @param {Logger} log
 * @param {{ quota: number, ttlHours: number, userId: string, label?: string|null, source?: string, budget?: number }} opts
 * @returns {Promise<(GrantView & { error?: undefined }) | { error: string, outstanding?: number, budget?: number } | null>}
 */
export async function mintWebSearchGrant(env, log, opts) {
  const db = await getDb(env);
  if (!db) return null;
  const quota = Math.max(1, Math.floor(Number(opts.quota) || 25));
  const ttlS = Math.max(1, Number(opts.ttlHours) || 24) * 3600;
  const budget = Number(opts.budget) > 0 ? Math.floor(Number(opts.budget)) : 0;
  const label = opts.label ? String(opts.label).slice(0, 80) : null;
  const source = opts.source || "link";
  const uid = String(opts.userId || "");

  if (budget > 0) {
    const outstanding = await outstandingRemaining(db);
    if (outstanding + quota > budget) {
      log.warn("websearch.budget_exceeded", { outstanding, requested: quota, budget });
      return { error: "budget_exceeded", outstanding, budget };
    }
  }

  const jti = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  const exp = nowS + ttlS;
  const ok = await db
    .prepare(
      "INSERT INTO websearch_grants (jti, user_id, quota, used, created_at, expires_at, label, source) " +
        "VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6, ?7)",
    )
    .bind(jti, uid, quota, nowS, exp, label, source)
    .run()
    .then(() => true)
    .catch((e) => {
      log.warn("websearch.mint_failed", { error: String(e?.message || e) });
      return false;
    });
  if (!ok) return null;
  const token = await mintWebSearchToken(env, { jti, uid, quota, iat: nowS, exp });
  log.info("websearch.minted", { jti, quota, source, by: uid });
  return { token, jti, quota, used: 0, remaining: quota, expiresAt: exp * 1000, label, source };
}

/**
 * The GHOST-crossover grant: mints or REUSES the signed-in caller's active
 * grant. Reuses the newest non-expired `source='ghost'` grant for the user —
 * even an exhausted one — so per-user Exa exposure is capped at one grant per
 * TTL window. Returns null when disabled / no D1 / over budget.
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<GrantView | null>}
 */
export async function grantWebSearch(env, log, identity) {
  const cfg = await grantDefaults(env);
  if (!cfg.enabled) return null;
  const db = await getDb(env);
  if (!db) return null;
  const uid = String(identity.id);
  const nowS = Math.floor(Date.now() / 1000);

  const row = await db
    .prepare(
      "SELECT jti, quota, used, expires_at, label FROM websearch_grants " +
        "WHERE user_id = ?1 AND source = 'ghost' AND expires_at > ?2 ORDER BY expires_at DESC LIMIT 1",
    )
    .bind(uid, nowS)
    .first()
    .catch(() => null);

  if (row) {
    const quota = Number(row.quota);
    const used = Number(row.used);
    const exp = Number(row.expires_at);
    const token = await mintWebSearchToken(env, { jti: String(row.jti), uid, quota, iat: nowS, exp });
    return { token, jti: String(row.jti), quota, used, remaining: Math.max(0, quota - used), expiresAt: exp * 1000, label: row.label ? String(row.label) : null, source: "ghost" };
  }

  const minted = await mintWebSearchGrant(env, log, {
    quota: cfg.quota,
    ttlHours: cfg.ttlHours,
    userId: uid,
    source: "ghost",
    budget: cfg.budget,
  });
  // A budget-exceeded / failed mint simply means no server web search this
  // session — the feature stays quietly off (fail-soft).
  return minted && !minted.error ? /** @type {GrantView} */ (minted) : null;
}

/**
 * Reads a grant's live state from a token WITHOUT consuming quota (the link
 * follower's browser calls this to populate the toggle). Returns null on a bad/
 * expired token or a missing row (revoked).
 * @param {Env} env
 * @param {string} token
 * @returns {Promise<GrantView | null>}
 */
export async function grantStatus(env, token) {
  const claims = await verifyWebSearchToken(env, token);
  if (!claims) return null;
  const db = await getDb(env);
  if (!db) return null;
  const row = await db
    .prepare("SELECT quota, used, expires_at, label, source FROM websearch_grants WHERE jti = ?1")
    .bind(claims.jti)
    .first()
    .catch(() => null);
  if (!row) return null;
  const quota = Number(row.quota);
  const used = Number(row.used);
  const exp = Number(row.expires_at);
  return {
    token,
    quota,
    used,
    remaining: Math.max(0, quota - used),
    expiresAt: exp * 1000,
    label: row.label ? String(row.label) : null,
    source: row.source ? String(row.source) : null,
  };
}

/**
 * Lists the live grants for the admin panel (newest first, capped).
 * @param {Env} env
 */
async function listGrants(env) {
  const db = await getDb(env);
  if (!db) return [];
  const nowS = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      "SELECT jti, quota, used, created_at, expires_at, label, source, user_id FROM websearch_grants " +
        "WHERE expires_at > ?1 ORDER BY created_at DESC LIMIT ?2",
    )
    .bind(nowS, GRANTS_LIST_MAX)
    .all()
    .catch(() => ({ results: [] }));
  return (res.results || []).map((r) => ({
    jti: String(r.jti),
    quota: Number(r.quota),
    used: Number(r.used),
    remaining: Math.max(0, Number(r.quota) - Number(r.used)),
    createdAt: Number(r.created_at) * 1000,
    expiresAt: Number(r.expires_at) * 1000,
    label: r.label ? String(r.label) : null,
    source: r.source ? String(r.source) : null,
    userId: r.user_id ? String(r.user_id) : null,
  }));
}

/**
 * ADJUST a live grant's quota — the minting user's per-token control (the
 * secure-workspaces directive, 2026-07-15: a grant embedded in a shared
 * workspace link stays FIXED as a token, while its allowance is administered
 * live — the minter adds or removes quota, and every holder of the link feels
 * it immediately, because the D1 row is the meter, not the token). Takes an
 * ABSOLUTE `quota` or a RELATIVE `delta`; the new quota is clamped to ≥ 0
 * (0 = paused — `used < quota` stops reserving; remaining reads clamp at 0
 * even when quota drops below used). An INCREASE is checked against the
 * global outstanding-remaining budget ceiling, exactly like a mint.
 * `opts.ownerId` restricts the adjustment to rows minted by that user (the
 * authed self-service path); a mismatch reads as not_found so the endpoint
 * never confirms someone else's jti.
 * @param {Env} env
 * @param {Logger} log
 * @param {string} jti
 * @param {{ quota?: number, delta?: number }} patch
 * @param {{ ownerId?: string, budget?: number }} [opts]
 * @returns {Promise<(Omit<GrantView, "token"> & { error?: undefined }) | { error: string, outstanding?: number, budget?: number } | null>}
 */
export async function adjustGrantQuota(env, log, jti, patch, opts = {}) {
  const db = await getDb(env);
  if (!db) return null;
  const row = await db
    .prepare("SELECT jti, user_id, quota, used, expires_at, label, source FROM websearch_grants WHERE jti = ?1")
    .bind(String(jti))
    .first()
    .catch(() => null);
  if (!row) return { error: "not_found" };
  if (opts.ownerId != null && String(row.user_id) !== String(opts.ownerId)) return { error: "not_found" };

  if (!patch || (patch.quota == null && patch.delta == null)) return { error: "bad_request" };
  const current = Number(row.quota);
  const next = patch.quota != null ? Math.floor(Number(patch.quota)) : current + Math.floor(Number(patch.delta));
  if (!Number.isFinite(next)) return { error: "bad_request" };
  const clamped = Math.max(0, next);

  const increase = clamped - current;
  const budget = Number(opts.budget) > 0 ? Math.floor(Number(opts.budget)) : 0;
  if (increase > 0 && budget > 0) {
    const outstanding = await outstandingRemaining(db);
    if (outstanding + increase > budget) {
      log.warn("websearch.adjust_budget_exceeded", { jti: String(jti), increase, outstanding, budget });
      return { error: "budget_exceeded", outstanding, budget };
    }
  }

  const ok = await db
    .prepare("UPDATE websearch_grants SET quota = ?2 WHERE jti = ?1")
    .bind(String(jti), clamped)
    .run()
    .then((r) => Number(r?.meta?.changes || 0) >= 1)
    .catch(() => false);
  if (!ok) return null;
  const used = Number(row.used);
  log.info("websearch.quota_adjusted", { jti: String(jti), from: current, to: clamped, by: opts.ownerId || "admin" });
  return {
    jti: String(row.jti),
    quota: clamped,
    used,
    remaining: Math.max(0, clamped - used),
    expiresAt: Number(row.expires_at) * 1000,
    label: row.label ? String(row.label) : null,
    source: row.source ? String(row.source) : null,
  };
}

/**
 * Revokes a grant by deleting its row — the token stops verifying immediately.
 * @param {Env} env
 * @param {string} jti
 * @returns {Promise<boolean>}
 */
export async function revokeGrant(env, jti) {
  const db = await getDb(env);
  if (!db) return false;
  const res = await db
    .prepare("DELETE FROM websearch_grants WHERE jti = ?1")
    .bind(String(jti))
    .run()
    .catch(() => null);
  return !!res && Number(res?.meta?.changes || 0) >= 1;
}

// ---- endpoints ------------------------------------------------------------------

/**
 * POST /api/websearch/grant — authed. The ghost-crossover path: hands the
 * signed-in caller their active grant. 503 when disabled / no D1.
 * @param {Request} _request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleWebSearchGrant(_request, env, log, identity) {
  const grant = await grantWebSearch(env, log, identity);
  if (!grant) return jsonResponse({ error: "Web-search grants are unavailable." }, 503);
  return jsonResponse(grant);
}

/**
 * POST /api/websearch/adjust — AUTHED. Body: { jti, quota | delta }. The
 * minting user's self-service quota control over their OWN grants (the
 * secure-workspaces "control the tokens you minted" surface): raise, lower,
 * or pause (quota 0) a grant they minted — scoped to rows whose user_id is
 * the caller, and budget-checked on increase like a mint. Admins adjust ANY
 * grant via PATCH /api/admin/websearch/:jti instead.
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleWebSearchAdjust(request, env, log, identity) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const jti = typeof body?.jti === "string" ? body.jti : "";
  if (!jti) return jsonResponse({ error: "jti is required." }, 400);
  const cfg = await grantDefaults(env);
  const adjusted = await adjustGrantQuota(
    env,
    log,
    jti,
    { quota: body.quota, delta: body.delta },
    { ownerId: String(identity.id), budget: cfg.budget },
  );
  if (!adjusted) return jsonResponse({ error: "Quota adjustment unavailable." }, 503);
  if (adjusted.error === "not_found") return jsonResponse({ error: "No such grant of yours." }, 404);
  if (adjusted.error === "bad_request") return jsonResponse({ error: "quota or delta must be a number." }, 400);
  if (adjusted.error === "budget_exceeded") {
    return jsonResponse(
      { error: `Global budget of ${adjusted.budget} would be exceeded (${adjusted.outstanding} already outstanding).` },
      409,
    );
  }
  return jsonResponse(adjusted);
}

/**
 * POST /api/websearch/status — PUBLIC. Body: { token }. Non-consuming read of a
 * grant's remaining quota, for a link follower's browser to populate the toggle.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
export async function handleWebSearchStatus(request, env) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token) return jsonResponse({ error: "token is required." }, 400);
  const view = await grantStatus(env, token);
  if (!view) return jsonResponse({ error: "Invalid, expired, or revoked token." }, 403);
  return jsonResponse(view);
}

/**
 * POST /api/websearch — PUBLIC. Body: { token, query }. Verifies the token,
 * reserves one search from its D1 grant row atomically, runs Exa on the
 * server's key, and returns the results. A failed/empty search refunds the
 * reservation so quota only pays for usable results.
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleWebSearch(request, env, log) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token : "";
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, QUERY_MAX) : "";
  if (!token || !query) return jsonResponse({ error: "token and query are required." }, 400);

  const cfg = await grantDefaults(env);
  if (!cfg.enabled) return jsonResponse({ error: "Web search is disabled." }, 503);

  const claims = await verifyWebSearchToken(env, token);
  if (!claims) return jsonResponse({ error: "Invalid or expired web-search token." }, 403);

  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Web search is unavailable." }, 503);
  const nowS = Math.floor(Date.now() / 1000);

  // Reserve one unit ATOMICALLY: the row-level guard `used < quota AND not
  // expired` means a concurrent burst can't overrun the grant — at most `quota`
  // UPDATEs ever change a row. changes===0 → exhausted/expired/revoked.
  const reserve = await db
    .prepare("UPDATE websearch_grants SET used = used + 1 WHERE jti = ?1 AND used < quota AND expires_at > ?2")
    .bind(claims.jti, nowS)
    .run()
    .catch(() => null);
  if (!reserve || Number(reserve?.meta?.changes || 0) < 1) {
    const row = await db
      .prepare("SELECT quota, used FROM websearch_grants WHERE jti = ?1")
      .bind(claims.jti)
      .first()
      .catch(() => null);
    if (!row) return jsonResponse({ error: "Web-search grant not found." }, 403);
    return jsonResponse(
      { error: "Web-search quota for this session is used up.", remaining: 0, quota: Number(row.quota) },
      429,
    );
  }

  const result = await webSearch(env, log, query, GRANT_DEPTH).catch(() => null);
  const usable = !!result && Number(result.resultCount) > 0;

  if (!usable) {
    // Refund — a failed or empty search must not burn the session's quota.
    await db
      .prepare("UPDATE websearch_grants SET used = used - 1 WHERE jti = ?1 AND used > 0")
      .bind(claims.jti)
      .run()
      .catch(() => {});
    log.info("websearch.empty", { uid: claims.uid, jti: claims.jti });
    return jsonResponse({ content: result?.content || "", items: [], sources: [], resultCount: 0, remaining: null });
  }

  const row = await db
    .prepare("SELECT quota, used FROM websearch_grants WHERE jti = ?1")
    .bind(claims.jti)
    .first()
    .catch(() => null);
  const remaining = row ? Math.max(0, Number(row.quota) - Number(row.used)) : null;
  log.info("websearch.served", { uid: claims.uid, jti: claims.jti, results: result.resultCount, remaining });

  return jsonResponse({
    content: result.content,
    items: result.items,
    sources: result.sources,
    resultCount: result.resultCount,
    remaining,
  });
}

/**
 * /api/admin/websearch* — ADMIN control surface for the mint subsystem.
 *   GET    → { config (defaults), grants (live list), outstanding, budget }
 *   POST   → mint a grant, returns the grant view + a shareable `link`
 *   DELETE /:jti → revoke a grant
 * The config DEFAULTS themselves are edited via the shared PUT /api/admin/config.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {{ id: string | number }} identity the admin identity (only `id` is read)
 * @returns {Promise<Response>}
 */
export async function handleAdminWebSearch(request, env, url, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const sub = url.pathname.replace(/^\/api\/admin\/websearch/, "");
  const method = request.method;

  if (sub === "" && method === "GET") {
    const [cfg, grants] = await Promise.all([grantDefaults(env), listGrants(env)]);
    const outstanding = grants.reduce((a, g) => a + g.remaining, 0);
    return jsonResponse({ config: cfg, grants, outstanding, budget: cfg.budget });
  }

  if ((sub === "" || sub === "/mint") && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const cfg = await grantDefaults(env);
    const quota = Number.isFinite(Number(body.quota)) && Number(body.quota) > 0 ? Math.floor(Number(body.quota)) : cfg.quota;
    const ttlHours = Number.isFinite(Number(body.ttlHours)) && Number(body.ttlHours) > 0 ? Number(body.ttlHours) : cfg.ttlHours;
    const label = typeof body.label === "string" ? body.label.slice(0, 80) : null;
    const minted = await mintWebSearchGrant(env, log, {
      quota,
      ttlHours,
      label,
      source: "link",
      userId: String(identity.id),
      budget: cfg.budget,
    });
    if (!minted) return jsonResponse({ error: "Minting unavailable." }, 503);
    if (minted.error === "budget_exceeded") {
      return jsonResponse(
        { error: `Global budget of ${minted.budget} would be exceeded (${minted.outstanding} already outstanding).` },
        409,
      );
    }
    const grant = /** @type {GrantView} */ (minted);
    const link = url.origin + "/cure?ws=" + encodeURIComponent(grant.token);
    return jsonResponse({ ...grant, link });
  }

  const del = sub.match(/^\/([A-Za-z0-9-]+)$/);
  if (del && method === "DELETE") {
    const ok = await revokeGrant(env, del[1]);
    log.info("websearch.revoked", { jti: del[1], ok });
    return jsonResponse({ ok });
  }

  // PATCH /:jti — adjust a grant's quota in place (absolute `quota` or
  // relative `delta`): the admin's per-token add/remove-quota control. The
  // token in circulation stays valid; only its metered allowance moves.
  if (del && method === "PATCH") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const cfg = await grantDefaults(env);
    const adjusted = await adjustGrantQuota(env, log, del[1], { quota: body.quota, delta: body.delta }, { budget: cfg.budget });
    if (!adjusted) return jsonResponse({ error: "Quota adjustment unavailable." }, 503);
    if (adjusted.error === "not_found") return jsonResponse({ error: "No such grant." }, 404);
    if (adjusted.error === "bad_request") return jsonResponse({ error: "quota or delta must be a number." }, 400);
    if (adjusted.error === "budget_exceeded") {
      return jsonResponse(
        { error: `Global budget of ${adjusted.budget} would be exceeded (${adjusted.outstanding} already outstanding).` },
        409,
      );
    }
    return jsonResponse(adjusted);
  }

  return jsonResponse({ error: "Not found." }, 404);
}
