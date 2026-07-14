// @ts-check
// Temporary web-search GRANTS for DeepResearch.Se/cure (DRC) — the quota METER
// and the two endpoints, built on the signed tokens in websearch-key.js.
//
// The deliberate, NARROW relaxation of invariant 4 (the server is in no DRC
// data path): a SIGNED-IN Se/rver user crossing to Se/cure gets a short-lived,
// quota-metered capability to run a bounded number of live web searches through
// this server's Exa key — so they can keep the strong Se/cure posture (own
// model, browser-local storage) while still getting fresh web results while,
// e.g., running a local model. ONLY a query string crosses the wire to the
// server (and onward to Exa); never the conversation, filenames, or — outbound
// to Exa — the account identity. The grant is opt-in (a toggle in Se/cure) and
// off for every visitor who did NOT cross over signed-in.
//
// TWO endpoints:
//   POST /api/websearch/grant  (AUTHED, behind the identity gate) — mints/reuses
//       the calling user's active grant and returns its token + remaining quota.
//   POST /api/websearch        (PUBLIC, before the identity gate) — the DRC
//       browser calls this with the token; it verifies, meters one search from
//       the D1 row keyed by the token's `jti`, runs Exa, and returns results.
//
// Fail-safe by construction: with NO D1 the feature is simply OFF (grants can't
// be issued and searches can't be metered → 503), so there is no way to run an
// unmetered server-paid search. Per-user Exa exposure is bounded to one grant's
// quota per TTL window (an exhausted grant is not re-minted within the window).

import { getDb } from "./db.js";
import { webSearch } from "./exa.js";
import { jsonResponse } from "./http.js";
import { mintWebSearchToken, verifyWebSearchToken } from "./websearch-key.js";

const DEFAULT_QUOTA = 25; // searches per grant (owner-tunable via WEBSEARCH_GRANT_QUOTA)
const GRANT_TTL_S = 24 * 3600; // one day — "this anonymous session" in Se/cure
const QUERY_MAX = 400; // bound the query the server will run
// Modest, fixed server-side depth for a granted search — the DRC session has no
// time-budget slider, and this shares the server's Exa budget across all users.
const GRANT_DEPTH = { numResults: 6, type: "auto" };

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

/** @param {Env} env @returns {number} the configured per-grant search quota */
function grantQuota(env) {
  const n = Number(env.WEBSEARCH_GRANT_QUOTA);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_QUOTA;
}

/**
 * The public shape returned to the client for an active grant.
 * @typedef {Object} GrantView
 * @property {string} token the signed wsk1.… token
 * @property {number} quota
 * @property {number} used
 * @property {number} remaining
 * @property {number} expiresAt epoch ms
 */

/**
 * Mints (or REUSES) the caller's active web-search grant. Reuses the newest
 * non-expired grant for the user — even an exhausted one — so per-user Exa
 * exposure is capped at `quota` searches per TTL window (a fresh crossing the
 * next day gets a fresh grant). Returns null when D1 is absent (feature off).
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<GrantView | null>}
 */
export async function grantWebSearch(env, log, identity) {
  const db = await getDb(env);
  if (!db) return null; // no D1 → the whole feature is off
  const uid = String(identity.id);
  const nowS = Math.floor(Date.now() / 1000);

  let row = await db
    .prepare(
      "SELECT jti, quota, used, expires_at FROM websearch_grants " +
        "WHERE user_id = ?1 AND expires_at > ?2 ORDER BY expires_at DESC LIMIT 1",
    )
    .bind(uid, nowS)
    .first()
    .catch(() => null);

  if (!row) {
    const jti = crypto.randomUUID();
    const quota = grantQuota(env);
    const exp = nowS + GRANT_TTL_S;
    const ok = await db
      .prepare(
        "INSERT INTO websearch_grants (jti, user_id, quota, used, created_at, expires_at) " +
          "VALUES (?1, ?2, ?3, 0, ?4, ?5)",
      )
      .bind(jti, uid, quota, nowS, exp)
      .run()
      .then(() => true)
      .catch((e) => {
        log.warn("websearch.grant_insert_failed", { error: String(e?.message || e) });
        return false;
      });
    if (!ok) return null;
    row = { jti, quota, used: 0, expires_at: exp };
  }

  const quota = Number(row.quota);
  const used = Number(row.used);
  const exp = Number(row.expires_at);
  const token = await mintWebSearchToken(env, { jti: String(row.jti), uid, quota, iat: nowS, exp });
  log.info("websearch.grant", { uid, quota, used, remaining: Math.max(0, quota - used) });
  return { token, quota, used, remaining: Math.max(0, quota - used), expiresAt: exp * 1000 };
}

/**
 * POST /api/websearch/grant — authed. Hands the signed-in caller their active
 * grant so the Se/cure session they are about to open can search through the
 * server. 503 when D1 is unconfigured.
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

  const claims = await verifyWebSearchToken(env, token);
  if (!claims) return jsonResponse({ error: "Invalid or expired web-search token." }, 403);

  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Web search is unavailable." }, 503);
  const nowS = Math.floor(Date.now() / 1000);

  // Reserve one unit ATOMICALLY: the row-level guard `used < quota AND not
  // expired` means a concurrent burst can't overrun the grant — at most `quota`
  // UPDATEs ever change a row. changes===0 → exhausted/expired/unknown.
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
