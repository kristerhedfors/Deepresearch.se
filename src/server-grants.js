// @ts-check
// Se/rver TOKEN grants — the CONSOLIDATED ticket system: the mint subsystem,
// the per-permission quota METER, the two metered upstream services, and the
// admin control surface for ONE-JWT grants (src/server-token.js).
//
// This is where the earlier per-capability ticket families converge (owner
// directive, 2026-07-16: "one ticket, one JWT"). A single Se/rver token
// bundles what previously took a `wsk1` web-search grant plus a `prg1`/`prx1`
// proxy pair: one JWT, a permission SET (`perms`), one duration, one `jti` —
// metered by one D1 `server_tokens` row PER PERMISSION, so each service's
// quota is administered (adjusted, paused, topped up) independently while the
// token in circulation never changes. The legacy families keep working
// unchanged; new grants should be Se/rver tokens.
//
// ══════════════════════════════════════════════════════════════════════════
// THE SERVER-TOKEN GUARANTEE (owner directive, 2026-07-16 — load-bearing):
// an API call bearing a Se/rver token reaches the site's UPSTREAM APIs ONLY —
// web search on the server's Exa key, LLM completions on the server's Berget
// key. It is NEVER handed any of Se/rver's own data: no project contents, no
// chat contents, no history, no account data. This module enforces that
// structurally — its endpoints touch nothing but the `server_tokens` meter
// table and the upstream providers. It must NEVER import any data-bearing
// module (storage.js, vault.js, chatlog.js, accounts.js, rag.js, pub.js,
// answers.js, settings.js, …) — a unit test pins this module graph
// (src/server-grants.test.js), so adding such an import fails the suite.
// THE ONE WRITE EXCEPTION lives OUTSIDE this module by design (owner
// directive, 2026-07-24): POST /api/server-token/feedback lets a token WRITE
// one feedback row (Se/cure's confirmed feedback path) — write-only, never
// readable back. It is handled in src/feedback.js (the data module), verified
// there with the pure verifyServerToken leaf, precisely so this upstream-only
// module never has to import a data surface. See THE SERVER-TOKEN GUARANTEE
// in src/server-token.js.
// AND THE ADMIN INTERFACE IS NEVER REACHABLE WITH A TOKEN (owner directive,
// 2026-07-16): handleAdminServerToken below manages tokens, but the route
// that reaches it (/api/admin/server-token*) sits behind the identity gate's
// proper sign-in — a session identity with the admin role — like every other
// admin surface. A Se/rver token is not a login: src/auth.js's identify()
// can never be satisfied by one (pinned in src/server-token.test.js), so
// tokens are administered FROM the admin interface and can never open it.
// The name says the rest: it is called a SERVER token so nobody forgets that
// using one sends data to a server somewhere.
// ══════════════════════════════════════════════════════════════════════════
//
// TWO WAYS to receive a Se/rver token (mirroring the legacy families):
//   1. GHOST CROSSOVER — a signed-in Se/rver user crossing to Se/cure mints
//      (or reuses) THEIR token via authed POST /api/server-token/grant.
//   2. SHAREABLE mint — an admin mints via POST /api/admin/server-token and
//      hands out the JWT itself.
// Spending is PUBLIC (a Se/cure session has no identity — the token is the
// authority): POST /api/server-token/web (query-only Exa),
// /api/server-token/llm/* (OpenAI-wire Berget reverse proxy — /chat/completions
// and /embeddings, both `api`-metered so a borrowed session gets RAG parity —
// the JWT as bearer), POST /api/server-token/status (non-consuming read).
//
// Governance (config.js `server_token` block, PUT /api/admin/config):
// per-permission default quota, one default TTL, the master `enabled`
// switch, and a global `budget` ceiling on total outstanding-remaining
// across all live Se/rver-token rows. Fail-safe by construction: with NO D1
// the whole feature is OFF (503), so no unmetered server-paid usage is
// possible. The atomic reserve (`used < quota` row guard) + refund-on-
// failure discipline is identical to the legacy meters.

import { getConfig } from "./config.js";
import { getDb } from "./db.js";
import { webSearch } from "./exa.js";
import {
  GRANT_DEPTH,
  GRANTS_LIST_MAX,
  QUERY_MAX,
  adjustResultResponse,
  budgetExceeded409,
  emptyWebResultResponse,
  posInt,
  readTokenBody,
  resolveQuotaPatch,
  webResultResponse,
} from "./grant-http.js";
import { jsonResponse } from "./http.js";
import { forwardLlmCompletion, forwardLlmEmbeddings, forwardLlmModels } from "./llm-proxy.js";
import { SERVER_TOKEN_SERVICES, mintServerToken, verifyServerToken } from "./server-token.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

/**
 * The effective mint defaults + governance, resolved from site config.
 * @typedef {Object} ServerTokenDefaults
 * @property {boolean} enabled
 * @property {{ web: number, api: number }} quotas default quota per permission
 * @property {number} ttlHours default lifetime of a token, in hours (ONE
 *   duration for the whole grant — "valid for a specific duration")
 * @property {number} budget global outstanding-remaining ceiling (0 = uncapped)
 */

/** @param {Env} env @returns {Promise<ServerTokenDefaults>} */
async function serverTokenDefaults(env) {
  const c = (await getConfig(env)).server_token || {};
  return {
    enabled: c.enabled !== false,
    quotas: { web: posInt(c.web_quota, 25), api: posInt(c.api_quota, 40) },
    ttlHours: posInt(c.ttl_hours, 24),
    budget: Number.isFinite(c.budget) && c.budget > 0 ? Math.floor(c.budget) : 0,
  };
}

/**
 * Sum of remaining quota across all live rows (the budget denominator).
 * @param {D1Database} db @returns {Promise<number>}
 */
async function outstandingRemaining(db) {
  const nowS = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT COALESCE(SUM(quota - used), 0) AS rem FROM server_tokens WHERE expires_at > ?1")
    .bind(nowS)
    .first()
    .catch(() => null);
  return row ? Number(row.rem) : 0;
}

/**
 * The per-permission view inside a token view.
 * @typedef {Object} PermView
 * @property {string} svc
 * @property {number} quota
 * @property {number} used
 * @property {number} remaining
 */

/** @param {any} row @returns {PermView} */
function permView(row) {
  const quota = Number(row.quota);
  const used = Number(row.used);
  return { svc: String(row.service), quota, used, remaining: Math.max(0, quota - used) };
}

/**
 * The public shape returned to clients / the admin panel for one token.
 * @typedef {Object} ServerTokenView
 * @property {string} [token] the signed JWT (present on mint/grant, never on adjust)
 * @property {string} jti
 * @property {string[]} perms the live permission set (from the rows)
 * @property {PermView[]} services per-permission live meter state
 * @property {number} expiresAt epoch ms
 * @property {string|null} [label]
 * @property {string|null} [source]
 */

/** @param {string} jti @param {any[]} rows @param {{ label?: string|null, source?: string|null }} [meta] @returns {Omit<ServerTokenView, "token">} */
function tokenView(jti, rows, meta = {}) {
  return {
    jti,
    perms: rows.map((r) => String(r.service)),
    services: rows.map(permView),
    expiresAt: rows.reduce((a, r) => Math.max(a, Number(r.expires_at)), 0) * 1000,
    label: meta.label != null ? meta.label : null,
    source: meta.source != null ? meta.source : null,
  };
}

/**
 * Mints a brand-new Se/rver token: one `server_tokens` row per requested
 * permission (same jti, same expiry) + ONE JWT carrying the permission set.
 * Shared by the admin mint and the ghost path. Enforces the global budget
 * ceiling (all permissions counted together). Returns the token view,
 * `{ error: "budget_exceeded", … }`, or null (no D1 / insert failure).
 * @param {Env} env @param {Logger} log
 * @param {{ userId: string, services?: string[], quotas?: Partial<Record<string, number>>, ttlHours?: number, label?: string|null, source?: string, defaults?: ServerTokenDefaults }} opts
 * @returns {Promise<(ServerTokenView & { error?: undefined }) | { error: string, outstanding?: number, budget?: number } | null>}
 */
export async function mintServerTokenGrant(env, log, opts) {
  const db = await getDb(env);
  if (!db) return null;
  const defaults = opts.defaults || (await serverTokenDefaults(env));
  const services = (opts.services || SERVER_TOKEN_SERVICES).filter((s) => SERVER_TOKEN_SERVICES.includes(s));
  if (!services.length) return null;
  const uid = String(opts.userId || "");
  const label = opts.label ? String(opts.label).slice(0, 80) : null;
  const source = opts.source || "link";
  const ttlHours = Number(opts.ttlHours) > 0 ? Number(opts.ttlHours) : defaults.ttlHours;
  const quotaFor = (/** @type {string} */ s) => {
    const q = Number(opts.quotas?.[s]);
    return Number.isFinite(q) && q > 0 ? Math.floor(q) : defaults.quotas[/** @type {"web"|"api"} */ (s)];
  };

  const requested = services.reduce((a, s) => a + quotaFor(s), 0);
  if (defaults.budget > 0) {
    const outstanding = await outstandingRemaining(db);
    if (outstanding + requested > defaults.budget) {
      log.warn("servertoken.budget_exceeded", { outstanding, requested, budget: defaults.budget });
      return { error: "budget_exceeded", outstanding, budget: defaults.budget };
    }
  }

  const jti = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  const exp = nowS + Math.floor(ttlHours * 3600);
  /** @type {any[]} */
  const rows = [];
  for (const svc of services) {
    const quota = quotaFor(svc);
    const ok = await db
      .prepare(
        "INSERT INTO server_tokens (jti, service, user_id, quota, used, created_at, expires_at, label, source) " +
          "VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8)",
      )
      .bind(jti, svc, uid, quota, nowS, exp, label, source)
      .run()
      .then(() => true)
      .catch((e) => {
        log.warn("servertoken.mint_failed", { svc, error: String(e?.message || e) });
        return false;
      });
    if (ok) rows.push({ service: svc, quota, used: 0, expires_at: exp });
  }
  if (!rows.length) return null;

  const token = await mintServerToken(env, { jti, sub: uid, perms: rows.map((r) => String(r.service)), iat: nowS, exp });
  log.info("servertoken.minted", { jti, perms: rows.map((r) => r.service), source, by: uid });
  return { token, ...tokenView(jti, rows, { label, source }) };
}

/**
 * The GHOST-crossover grant: mints or REUSES the signed-in caller's active
 * token. Reuses the newest non-expired `source='ghost'` grant for the user —
 * even an exhausted one — re-minting a fresh JWT for its existing jti/rows,
 * so per-user upstream exposure is capped at one grant per TTL window.
 * Returns null when disabled / no D1 / over budget.
 * @param {Env} env @param {Logger} log @param {Identity} identity
 * @returns {Promise<ServerTokenView | null>}
 */
export async function grantServerToken(env, log, identity) {
  const defaults = await serverTokenDefaults(env);
  if (!defaults.enabled) return null;
  const db = await getDb(env);
  if (!db) return null;
  const uid = String(identity.id);
  const nowS = Math.floor(Date.now() / 1000);

  const head = await db
    .prepare(
      "SELECT jti FROM server_tokens WHERE user_id = ?1 AND source = 'ghost' AND expires_at > ?2 " +
        "ORDER BY created_at DESC LIMIT 1",
    )
    .bind(uid, nowS)
    .first()
    .catch(() => null);

  if (head) {
    const res = await db
      .prepare("SELECT jti, service, quota, used, expires_at, label, source FROM server_tokens WHERE jti = ?1 AND expires_at > ?2")
      .bind(String(head.jti), nowS)
      .all()
      .catch(() => ({ results: [] }));
    const rows = res.results || [];
    if (rows.length) {
      const exp = rows.reduce((a, r) => Math.max(a, Number(r.expires_at)), 0);
      const token = await mintServerToken(env, {
        jti: String(head.jti),
        sub: uid,
        perms: rows.map((r) => String(r.service)),
        iat: nowS,
        exp,
      });
      return { token, ...tokenView(String(head.jti), rows, { label: rows[0].label ? String(rows[0].label) : null, source: "ghost" }) };
    }
  }

  const minted = await mintServerTokenGrant(env, log, { userId: uid, source: "ghost", defaults });
  return minted && !minted.error ? /** @type {ServerTokenView} */ (minted) : null;
}

/**
 * Non-consuming status read from a token — the link follower's / settings
 * UI's live "remaining" source. Returns null on a bad/expired token or when
 * every row is gone (revoked).
 * @param {Env} env @param {string} token
 * @returns {Promise<Omit<ServerTokenView, "token"> | null>}
 */
export async function serverTokenStatus(env, token) {
  const claims = await verifyServerToken(env, token);
  if (!claims) return null;
  const db = await getDb(env);
  if (!db) return null;
  const res = await db
    .prepare("SELECT jti, service, quota, used, expires_at, label, source FROM server_tokens WHERE jti = ?1")
    .bind(claims.jti)
    .all()
    .catch(() => ({ results: [] }));
  const rows = res.results || [];
  if (!rows.length) return null;
  return tokenView(claims.jti, rows, {
    label: rows[0].label ? String(rows[0].label) : null,
    source: rows[0].source ? String(rows[0].source) : null,
  });
}

/**
 * Atomically reserve one unit from a token's per-permission row. Returns
 * "ok", "exhausted" (used up / expired / paused), or "error" (no row —
 * revoked or never held this permission). The row-level guard
 * `used < quota AND not expired` means a concurrent burst can't overrun the
 * grant — at most `quota` UPDATEs ever change a row (the same concurrency
 * proof as the legacy meters).
 * @param {D1Database} db @param {string} jti @param {string} svc
 * @returns {Promise<"ok"|"exhausted"|"error">}
 */
async function reserveUnit(db, jti, svc) {
  const nowS = Math.floor(Date.now() / 1000);
  const reserve = await db
    .prepare(
      "UPDATE server_tokens SET used = used + 1 WHERE jti = ?1 AND service = ?2 AND used < quota AND expires_at > ?3",
    )
    .bind(jti, svc, nowS)
    .run()
    .catch(() => null);
  if (reserve && Number(reserve?.meta?.changes || 0) >= 1) return "ok";
  const row = await db
    .prepare("SELECT jti FROM server_tokens WHERE jti = ?1 AND service = ?2")
    .bind(jti, svc)
    .first()
    .catch(() => null);
  return row ? "exhausted" : "error";
}

/**
 * Refund a previously reserved unit (a failed/empty operation must not burn quota).
 * @param {D1Database} db @param {string} jti @param {string} svc
 */
async function refundUnit(db, jti, svc) {
  await db
    .prepare("UPDATE server_tokens SET used = used - 1 WHERE jti = ?1 AND service = ?2 AND used > 0")
    .bind(jti, svc)
    .run()
    .catch(() => {});
}

/**
 * Read a permission's remaining after an operation (the client's live counter).
 * @param {D1Database} db @param {string} jti @param {string} svc
 */
async function remainingOf(db, jti, svc) {
  const row = await db
    .prepare("SELECT quota, used FROM server_tokens WHERE jti = ?1 AND service = ?2")
    .bind(jti, svc)
    .first()
    .catch(() => null);
  return row ? Math.max(0, Number(row.quota) - Number(row.used)) : null;
}

/**
 * ADJUST one permission's quota on a live token — the same minter control as
 * the legacy families (secure-workspaces directive): the JWT in circulation
 * stays FIXED while its allowance is administered live on the D1 row.
 * Absolute `quota` or relative `delta`, clamped ≥ 0 (0 = paused); an
 * increase is checked against the global budget ceiling like a mint;
 * `opts.ownerId` scopes to the minter's own rows (mismatch reads as
 * not_found so an endpoint never confirms someone else's jti).
 * @param {Env} env @param {Logger} log
 * @param {string} jti @param {string} svc
 * @param {{ quota?: number, delta?: number }} patch
 * @param {{ ownerId?: string, budget?: number }} [opts]
 * @returns {Promise<(PermView & { jti: string, expiresAt: number, error?: undefined }) | { error: string, outstanding?: number, budget?: number } | null>}
 */
export async function adjustServerTokenQuota(env, log, jti, svc, patch, opts = {}) {
  const db = await getDb(env);
  if (!db) return null;
  const row = await db
    .prepare("SELECT jti, service, user_id, quota, used, expires_at FROM server_tokens WHERE jti = ?1 AND service = ?2")
    .bind(String(jti), String(svc))
    .first()
    .catch(() => null);
  if (!row) return { error: "not_found" };
  if (opts.ownerId != null && String(row.user_id) !== String(opts.ownerId)) return { error: "not_found" };

  const current = Number(row.quota);
  const patched = resolveQuotaPatch(current, patch);
  if (patched.error) return { error: patched.error };
  const clamped = patched.clamped;

  const increase = clamped - current;
  const budget = Number(opts.budget) > 0 ? Math.floor(Number(opts.budget)) : 0;
  if (increase > 0 && budget > 0) {
    const outstanding = await outstandingRemaining(db);
    if (outstanding + increase > budget) {
      log.warn("servertoken.adjust_budget_exceeded", { jti: String(jti), svc: String(svc), increase, outstanding, budget });
      return { error: "budget_exceeded", outstanding, budget };
    }
  }

  const ok = await db
    .prepare("UPDATE server_tokens SET quota = ?3 WHERE jti = ?1 AND service = ?2")
    .bind(String(jti), String(svc), clamped)
    .run()
    .then((r) => Number(r?.meta?.changes || 0) >= 1)
    .catch(() => false);
  if (!ok) return null;
  log.info("servertoken.quota_adjusted", { jti: String(jti), svc: String(svc), from: current, to: clamped, by: opts.ownerId || "admin" });
  return { ...permView({ ...row, quota: clamped }), jti: String(row.jti), expiresAt: Number(row.expires_at) * 1000 };
}

/**
 * Revokes a whole token by deleting ALL its permission rows — the JWT stops
 * working immediately (verify still passes, but every meter read finds
 * nothing, which reads as revoked).
 * @param {Env} env @param {string} jti @returns {Promise<boolean>}
 */
export async function revokeServerToken(env, jti) {
  const db = await getDb(env);
  if (!db) return false;
  const res = await db
    .prepare("DELETE FROM server_tokens WHERE jti = ?1")
    .bind(String(jti))
    .run()
    .catch(() => null);
  return !!res && Number(res?.meta?.changes || 0) >= 1;
}

// ---- endpoints ------------------------------------------------------------------

/**
 * POST /api/server-token/grant — AUTHED. The ghost-crossover path: hands the
 * signed-in caller their active Se/rver token. 503 when disabled / no D1.
 * @param {Request} _request @param {Env} env @param {Logger} log @param {Identity} identity
 */
export async function handleServerTokenGrant(_request, env, log, identity) {
  const grant = await grantServerToken(env, log, identity);
  if (!grant) return jsonResponse({ error: "Se/rver tokens are unavailable." }, 503);
  return jsonResponse(grant);
}

/**
 * POST /api/server-token/adjust — AUTHED. Body: { jti, svc, quota | delta }.
 * The minting user's self-service quota control over their OWN tokens, per
 * permission — scoped to rows whose user_id is the caller, budget-checked on
 * increase. Admins adjust ANY token via PATCH /api/admin/server-token/:jti/:svc.
 * @param {Request} request @param {Env} env @param {Logger} log @param {Identity} identity
 */
export async function handleServerTokenAdjust(request, env, log, identity) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const jti = typeof body?.jti === "string" ? body.jti : "";
  const svc = typeof body?.svc === "string" ? body.svc : "";
  if (!jti || !SERVER_TOKEN_SERVICES.includes(svc)) return jsonResponse({ error: "jti and a known svc are required." }, 400);
  const defaults = await serverTokenDefaults(env);
  const adjusted = await adjustServerTokenQuota(
    env,
    log,
    jti,
    svc,
    { quota: body.quota, delta: body.delta },
    { ownerId: String(identity.id), budget: defaults.budget },
  );
  return adjustResultResponse(adjusted, "No such grant of yours.");
}

/**
 * POST /api/server-token/status — PUBLIC. Body: { token }. Non-consuming read
 * of a token's live per-permission state.
 * @param {Request} request @param {Env} env
 */
export async function handleServerTokenStatus(request, env) {
  const token = await readTokenBody(request);
  if (!token) return jsonResponse({ error: "token is required." }, 400);
  const view = await serverTokenStatus(env, token);
  if (!view) return jsonResponse({ error: "Invalid, expired, or revoked token." }, 403);
  return jsonResponse(view);
}

/**
 * POST /api/server-token/web — PUBLIC. Body: { token, query }. The `web`
 * permission: verifies the JWT, reserves one unit from its `web` row
 * atomically, runs Exa on the server key, refunds an empty/failed search.
 * ONLY the query string reaches the server and Exa — never the conversation
 * (the guarantee above: upstream access, no Se/rver data in either direction).
 * @param {Request} request @param {Env} env @param {Logger} log
 */
export async function handleServerTokenWeb(request, env, log) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token : "";
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, QUERY_MAX) : "";
  if (!token || !query) return jsonResponse({ error: "token and query are required." }, 400);

  const defaults = await serverTokenDefaults(env);
  if (!defaults.enabled) return jsonResponse({ error: "Se/rver tokens are disabled." }, 503);
  const claims = await verifyServerToken(env, token);
  if (!claims || !claims.perms.includes("web")) {
    return jsonResponse({ error: "Invalid or expired Se/rver token (web permission required)." }, 403);
  }
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Web search is unavailable." }, 503);

  const reserved = await reserveUnit(db, claims.jti, "web");
  if (reserved === "error") return jsonResponse({ error: "Grant not found." }, 403);
  if (reserved === "exhausted") return jsonResponse({ error: "Web-search quota is used up.", remaining: 0 }, 429);

  const result = await webSearch(env, log, query, GRANT_DEPTH).catch(() => null);
  const usable = !!result && Number(result.resultCount) > 0;
  if (!usable) {
    await refundUnit(db, claims.jti, "web");
    log.info("servertoken.web_empty", { sub: claims.sub, jti: claims.jti });
    return emptyWebResultResponse(result);
  }
  const remaining = await remainingOf(db, claims.jti, "web");
  log.info("servertoken.web_served", { sub: claims.sub, jti: claims.jti, results: result.resultCount, remaining });
  return webResultResponse(result, remaining);
}

/**
 * /api/server-token/llm/* — PUBLIC. The `api` permission: an OpenAI-wire
 * reverse proxy to the server's Berget key, the JWT as the bearer — the same
 * wire (and the same shared forwarders) as the legacy bundle's LLM proxy, so
 * any OpenAI-compatible client drives it unchanged.
 *   GET  /api/server-token/llm/models           → the Berget catalog (non-metered)
 *   POST /api/server-token/llm/chat/completions → one metered completion
 * NOTE (the guarantee, stated for the one nuanced case): an LLM call carries
 * the caller's OWN prompt upstream — that is the caller's data flowing OUT to
 * a disclosed upstream, by their choice. Nothing flows the other way: the
 * token never unlocks any content Se/rver stores, and the exchange is not
 * written to any store.
 * @param {Request} request @param {Env} env @param {Logger} log @param {URL} url
 */
export async function handleServerTokenLlm(request, env, log, url) {
  const defaults = await serverTokenDefaults(env);
  if (!defaults.enabled) return jsonResponse({ error: "Se/rver tokens are disabled." }, 503);
  if (!env.BERGET_API_TOKEN) return jsonResponse({ error: "LLM proxy is unavailable." }, 503);

  const suffix = url.pathname.replace(/^\/api\/server-token\/llm/, "");
  const auth = request.headers.get("authorization") || "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || "";
  const claims = await verifyServerToken(env, token);
  if (!claims || !claims.perms.includes("api")) {
    return jsonResponse({ error: "Invalid or expired Se/rver token (api permission required)." }, 403);
  }

  if (suffix === "/models" && request.method === "GET") {
    return forwardLlmModels(env);
  }

  // Embeddings (metered like a completion) — a borrowed Se/cure session runs
  // the SAME client-side RAG the signed-in tier does, on Berget's e5 model.
  // Same guarantee as the completion below: the caller's OWN text goes upstream
  // by their choice; the token never unlocks any content Se/rver stores.
  if (suffix === "/embeddings" && request.method === "POST") {
    const eb = /** @type {any} */ (await request.json().catch(() => null));
    if (!eb || typeof eb !== "object" || (typeof eb.input !== "string" && !Array.isArray(eb.input))) {
      return jsonResponse({ error: "An embeddings body with input is required." }, 400);
    }
    const edb = await getDb(env);
    if (!edb) return jsonResponse({ error: "LLM proxy is unavailable." }, 503);
    const er = await reserveUnit(edb, claims.jti, "api");
    if (er === "error") return jsonResponse({ error: "Grant not found." }, 403);
    if (er === "exhausted") return jsonResponse({ error: "LLM API quota is used up.", remaining: 0 }, 429);
    return forwardLlmEmbeddings(env, log, eb, {
      refund: () => refundUnit(edb, claims.jti, "api"),
      remainingAfter: () => remainingOf(edb, claims.jti, "api"),
      tagPrefix: "servertoken.embed",
      ids: { sub: claims.sub, jti: claims.jti },
    });
  }

  if (suffix !== "/chat/completions" || request.method !== "POST") {
    return jsonResponse({ error: "Not found." }, 404);
  }

  const body = /** @type {any} */ (await request.json().catch(() => null));
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    return jsonResponse({ error: "A chat-completions body with messages is required." }, 400);
  }
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "LLM proxy is unavailable." }, 503);

  const reserved = await reserveUnit(db, claims.jti, "api");
  if (reserved === "error") return jsonResponse({ error: "Grant not found." }, 403);
  if (reserved === "exhausted") return jsonResponse({ error: "LLM API quota is used up.", remaining: 0 }, 429);

  return forwardLlmCompletion(env, log, body, {
    refund: () => refundUnit(db, claims.jti, "api"),
    remainingAfter: () => remainingOf(db, claims.jti, "api"),
    tagPrefix: "servertoken.llm",
    ids: { sub: claims.sub, jti: claims.jti },
  });
}

// ---- admin ----------------------------------------------------------------------

/**
 * Lists the live tokens for the admin surface, grouped by jti (newest first).
 * @param {Env} env
 */
async function listServerTokens(env) {
  const db = await getDb(env);
  if (!db) return [];
  const nowS = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      "SELECT jti, service, quota, used, created_at, expires_at, label, source, user_id " +
        "FROM server_tokens WHERE expires_at > ?1 ORDER BY created_at DESC LIMIT ?2",
    )
    .bind(nowS, GRANTS_LIST_MAX)
    .all()
    .catch(() => ({ results: [] }));
  /** @type {Map<string, any>} */
  const byJti = new Map();
  for (const r of res.results || []) {
    const id = String(r.jti);
    if (!byJti.has(id)) {
      byJti.set(id, {
        jti: id,
        createdAt: Number(r.created_at) * 1000,
        expiresAt: Number(r.expires_at) * 1000,
        label: r.label ? String(r.label) : null,
        source: r.source ? String(r.source) : null,
        userId: r.user_id ? String(r.user_id) : null,
        services: [],
      });
    }
    byJti.get(id).services.push(permView(r));
  }
  return [...byJti.values()];
}

/**
 * /api/admin/server-token* — ADMIN control surface.
 *   GET                → { config (defaults), grants (live, grouped by jti), outstanding, budget }
 *   POST (/ or /mint)  → mint a token (body: { label?, services?, quotas?, ttlHours? }), returns the view incl. the JWT
 *   PATCH /:jti/:svc   → adjust one permission's quota in place (absolute `quota` or relative `delta`)
 *   DELETE /:jti       → revoke a whole token (all its permission rows)
 * The config DEFAULTS themselves are edited via the shared PUT /api/admin/config.
 * @param {Request} request @param {Env} env @param {URL} url @param {Logger} log
 * @param {{ id: string | number }} identity the admin identity (only `id` is read)
 */
export async function handleAdminServerToken(request, env, url, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const sub = url.pathname.replace(/^\/api\/admin\/server-token/, "");
  const method = request.method;

  if (sub === "" && method === "GET") {
    const [defaults, grants] = await Promise.all([serverTokenDefaults(env), listServerTokens(env)]);
    const outstanding = grants.reduce(
      (/** @type {number} */ a, /** @type {any} */ g) =>
        a + g.services.reduce((/** @type {number} */ s, /** @type {PermView} */ v) => s + v.remaining, 0),
      0,
    );
    return jsonResponse({ config: defaults, grants, outstanding, budget: defaults.budget });
  }

  if ((sub === "" || sub === "/mint") && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const label = typeof body.label === "string" ? body.label.slice(0, 80) : null;
    const services = Array.isArray(body.services) && body.services.length ? body.services : undefined;
    const quotas = body.quotas && typeof body.quotas === "object" ? body.quotas : undefined;
    const ttlHours = Number.isFinite(Number(body.ttlHours)) && Number(body.ttlHours) > 0 ? Number(body.ttlHours) : undefined;
    const minted = await mintServerTokenGrant(env, log, {
      userId: String(identity.id),
      source: "link",
      label,
      services,
      quotas,
      ttlHours,
    });
    if (!minted) return jsonResponse({ error: "Minting unavailable." }, 503);
    if (minted.error === "budget_exceeded") return budgetExceeded409(minted);
    const grant = /** @type {ServerTokenView} */ (minted);
    // The shareable link: the /cure client reads ?st=, verifies it via the
    // public status endpoint, and strips it from the URL (public/cure/drc.js).
    const link = url.origin + "/cure?st=" + encodeURIComponent(String(grant.token));
    return jsonResponse({ ...grant, link });
  }

  // PATCH /:jti/:svc — adjust ONE permission row's quota in place.
  const patch = sub.match(/^\/([A-Za-z0-9-]+)\/([a-z]+)$/);
  if (patch && method === "PATCH") {
    if (!SERVER_TOKEN_SERVICES.includes(patch[2])) return jsonResponse({ error: "Unknown service." }, 400);
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const defaults = await serverTokenDefaults(env);
    const adjusted = await adjustServerTokenQuota(env, log, patch[1], patch[2], { quota: body.quota, delta: body.delta }, { budget: defaults.budget });
    return adjustResultResponse(adjusted, "No such grant.");
  }

  const del = sub.match(/^\/([A-Za-z0-9-]+)$/);
  if (del && method === "DELETE") {
    const ok = await revokeServerToken(env, del[1]);
    log.info("servertoken.revoked", { jti: del[1], ok });
    return jsonResponse({ ok });
  }

  return jsonResponse({ error: "Not found." }, 404);
}
