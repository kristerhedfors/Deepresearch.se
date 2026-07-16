// @ts-check
// The SECURE-RESEARCH-SPACE proxy BUNDLE — the mint subsystem, the per-service
// quota METER, the two-tier exchange, the two proxied services (web search +
// LLM API), and the admin control surface. Built on the two-tier tokens in
// src/proxy-grant.js and the bundle crypto in public/js/proxy-bundle.js.
//
// This is invariant 4's SECOND deliberate, bounded relaxation of "the server is
// in no DRC data path" (the first is src/websearch.js). Where the web-search
// grant lets only a QUERY cross the wire, the LLM API grant necessarily routes
// the CONVERSATION through the server (an LLM call carries the prompt) — so it
// is OPT-IN, clearly disclosed to the user in the Se/cure UI ("which APIs are
// connected"), account-connected, quota-metered, and time-limited. It exists to
// create a "secure research space": a signed-in Se/rver user (or an admin, via a
// shareable link) LENDS a Se/cure session bounded, temporary access to the
// minting account's server-side keys, so a keyless client-side session can still
// run real deep research.
//
// THE FLOW (the owner's two-tier directive):
//   1. MINT — on a ghost crossover (authed POST /api/proxy/grant) or an admin
//      link mint, the server creates one D1 `proxy_grants` row PER SERVICE and a
//      GRANT TOKEN ("token-granting token") for each, packs them into an
//      encrypted BUNDLE (public/js/proxy-bundle.js), and hands the client the
//      ciphertext in the URL query with the key in the URL anchor.
//   2. EXCHANGE — the client opens the bundle and trades each grant token for a
//      PROXY TOKEN (POST /api/proxy/exchange). The grant token stays in the URL;
//      the proxy token never does.
//   3. USE — the proxy token authorizes the metered service:
//        web → POST /api/proxy/web        (Exa on the server key; query only)
//        api → POST /api/proxy/llm/*      (Berget on the server key; OpenAI-wire
//                                          reverse proxy — /chat/completions,
//                                          /models — so the DRC provider registry
//                                          drives it unchanged)
//
// Governance (config.js `proxy` block, PUT /api/admin/config): per-service
// default quota/TTL, the master `enabled` switch, and a shared global `budget`
// ceiling on total outstanding-remaining across ALL live proxy grants.
//
// Fail-safe by construction: no D1 → the whole feature is OFF (503), so no
// unmetered server-paid search or completion is possible; scope is BERGET-ONLY
// for the LLM proxy (bounded, predictable account exposure).

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
  readTokenBody,
  resolveQuotaPatch,
  webResultResponse,
} from "./grant-http.js";
import { jsonResponse } from "./http.js";
import { mintGrantToken, mintProxyToken, verifyGrantToken, verifyProxyToken } from "./proxy-grant.js";
import { sealBundle } from "../public/js/proxy-bundle.js";

const LLM_MAX_TOKENS = 8192; // clamp a proxied completion's output ceiling
const LLM_CONNECT_TIMEOUT_MS = 30_000; // bound the upstream connect (streaming)
const LLM_JSON_TIMEOUT_MS = 60_000; // bound a non-streaming completion
/** The services a bundle can carry, in display order (secure-first mindset). */
const SERVICES = ["web", "api"];

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

/** @param {Env} env */
const bergetBase = (env) => env.BERGET_URL || "https://api.berget.ai/v1";

/**
 * The effective per-service mint defaults + governance, from site config.
 * @typedef {Object} ProxyDefaults
 * @property {boolean} enabled
 * @property {{ quota: number, ttlHours: number }} web
 * @property {{ quota: number, ttlHours: number }} api
 * @property {number} budget global outstanding-remaining ceiling (0 = uncapped)
 */

/** @param {Env} env @returns {Promise<ProxyDefaults>} */
async function proxyDefaults(env) {
  const p = (await getConfig(env)).proxy || {};
  const pos = (/** @type {number} */ v, /** @type {number} */ d) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  return {
    enabled: p.enabled !== false,
    web: { quota: pos(p.web_quota, 25), ttlHours: pos(p.web_ttl_hours, 24) },
    api: { quota: pos(p.api_quota, 40), ttlHours: pos(p.api_ttl_hours, 24) },
    budget: Number.isFinite(p.budget) && p.budget > 0 ? Math.floor(p.budget) : 0,
  };
}

/**
 * Sum of remaining quota across all live proxy grants (the budget denominator).
 * @param {D1Database} db @returns {Promise<number>}
 */
async function outstandingRemaining(db) {
  const nowS = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT COALESCE(SUM(quota - used), 0) AS rem FROM proxy_grants WHERE expires_at > ?1")
    .bind(nowS)
    .first()
    .catch(() => null);
  return row ? Number(row.rem) : 0;
}

/**
 * The per-service view returned to clients / the admin panel.
 * @typedef {Object} ServiceView
 * @property {string} jti
 * @property {"web"|"api"} svc
 * @property {number} quota
 * @property {number} used
 * @property {number} remaining
 * @property {number} expiresAt epoch ms
 */

/** @param {any} row @returns {ServiceView} */
function serviceView(row) {
  const quota = Number(row.quota);
  const used = Number(row.used);
  return {
    jti: String(row.jti),
    svc: row.service === "api" ? "api" : "web",
    quota,
    used,
    remaining: Math.max(0, quota - used),
    expiresAt: Number(row.expires_at) * 1000,
  };
}

/**
 * The bundle a mint returns: the encrypted `{ blob, key }` transport plus the
 * plaintext `connected` summary (so the caller can display which APIs it holds
 * without opening the blob).
 * @typedef {Object} BundleView
 * @property {string} bundleId
 * @property {string} blob ciphertext (goes in the URL query `rp`)
 * @property {string} key AES key (goes in the URL anchor `rk`)
 * @property {ServiceView[]} connected
 */

/**
 * Mint a fresh bundle: one `proxy_grants` row + grant token per requested
 * service, sealed into one encrypted blob. Enforces the shared global budget
 * ceiling (counting ALL services requested together). Returns the bundle view,
 * `{ error: "budget_exceeded", … }`, or null (no D1 / insert failure).
 * @param {Env} env @param {Logger} log
 * @param {{ userId: string, source?: string, label?: string|null, services?: string[], defaults?: ProxyDefaults }} opts
 * @returns {Promise<(BundleView & { error?: undefined }) | { error: string, outstanding?: number, budget?: number } | null>}
 */
export async function mintBundle(env, log, opts) {
  const db = await getDb(env);
  if (!db) return null;
  const defaults = opts.defaults || (await proxyDefaults(env));
  const services = (opts.services || SERVICES).filter((s) => s === "web" || s === "api");
  if (!services.length) return null;
  const uid = String(opts.userId || "");
  const label = opts.label ? String(opts.label).slice(0, 80) : null;
  const source = opts.source || "link";

  const requested = services.reduce((a, s) => a + defaults[s].quota, 0);
  if (defaults.budget > 0) {
    const outstanding = await outstandingRemaining(db);
    if (outstanding + requested > defaults.budget) {
      log.warn("proxy.budget_exceeded", { outstanding, requested, budget: defaults.budget });
      return { error: "budget_exceeded", outstanding, budget: defaults.budget };
    }
  }

  const bundleId = crypto.randomUUID();
  const nowS = Math.floor(Date.now() / 1000);
  /** @type {ServiceView[]} */
  const connected = [];
  /** @type {{ svc: string, token: string }[]} */
  const grants = [];
  for (const svc of services) {
    const { quota, ttlHours } = defaults[svc];
    const jti = crypto.randomUUID();
    const exp = nowS + ttlHours * 3600;
    const ok = await db
      .prepare(
        "INSERT INTO proxy_grants (jti, bundle_id, user_id, service, quota, used, created_at, expires_at, label, source) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9)",
      )
      .bind(jti, bundleId, uid, svc, quota, nowS, exp, label, source)
      .run()
      .then(() => true)
      .catch((e) => {
        log.warn("proxy.mint_failed", { svc, error: String(e?.message || e) });
        return false;
      });
    if (!ok) continue;
    const token = await mintGrantToken(env, { jti, uid, svc: /** @type {"web"|"api"} */ (svc), quota, iat: nowS, exp });
    grants.push({ svc, token });
    connected.push(serviceView({ jti, service: svc, quota, used: 0, expires_at: exp }));
  }
  if (!grants.length) return null;

  const { blob, key } = await sealBundle({ v: 1, bundleId, grants });
  log.info("proxy.minted", { bundleId, services: grants.map((g) => g.svc), source, by: uid });
  return { bundleId, blob, key, connected };
}

/**
 * The GHOST-crossover bundle: mints or REUSES the signed-in caller's active
 * bundle. Reuses the newest non-expired `source='ghost'` bundle for the user
 * (re-minting fresh grant tokens for its live rows, re-sealing) so per-user
 * server exposure is capped at one bundle per TTL window. Returns null when
 * disabled / no D1 / over budget.
 * @param {Env} env @param {Logger} log @param {Identity} identity
 * @returns {Promise<BundleView | null>}
 */
export async function grantBundle(env, log, identity) {
  const defaults = await proxyDefaults(env);
  if (!defaults.enabled) return null;
  const db = await getDb(env);
  if (!db) return null;
  const uid = String(identity.id);
  const nowS = Math.floor(Date.now() / 1000);

  // The newest live ghost bundle for this user (by its most-recent row).
  const head = await db
    .prepare(
      "SELECT bundle_id FROM proxy_grants WHERE user_id = ?1 AND source = 'ghost' AND expires_at > ?2 " +
        "ORDER BY created_at DESC LIMIT 1",
    )
    .bind(uid, nowS)
    .first()
    .catch(() => null);

  if (head) {
    const res = await db
      .prepare("SELECT jti, service, quota, used, expires_at FROM proxy_grants WHERE bundle_id = ?1 AND expires_at > ?2")
      .bind(String(head.bundle_id), nowS)
      .all()
      .catch(() => ({ results: [] }));
    const rows = res.results || [];
    if (rows.length) {
      /** @type {ServiceView[]} */
      const connected = [];
      /** @type {{ svc: string, token: string }[]} */
      const grants = [];
      for (const r of rows) {
        const svc = r.service === "api" ? "api" : "web";
        const token = await mintGrantToken(env, {
          jti: String(r.jti),
          uid,
          svc: /** @type {"web"|"api"} */ (svc),
          quota: Number(r.quota),
          iat: nowS,
          exp: Number(r.expires_at),
        });
        grants.push({ svc, token });
        connected.push(serviceView(r));
      }
      const { blob, key } = await sealBundle({ v: 1, bundleId: String(head.bundle_id), grants });
      return { bundleId: String(head.bundle_id), blob, key, connected };
    }
  }

  const minted = await mintBundle(env, log, { userId: uid, source: "ghost", services: SERVICES, defaults });
  return minted && !minted.error ? /** @type {BundleView} */ (minted) : null;
}

/**
 * EXCHANGE: verify a grant token, confirm its D1 row is still live (not
 * expired/revoked), and issue the working proxy token for it. Non-consuming —
 * issuing a proxy token spends no quota. Idempotent (re-exchange while alive
 * re-issues), because the D1 row is the true limiter. Returns the service view
 * with `proxyToken`, or null on a bad/expired grant token or a missing row.
 * @param {Env} env @param {string} token a grant token (prg1.…)
 * @returns {Promise<(ServiceView & { proxyToken: string }) | null>}
 */
export async function exchangeGrant(env, token) {
  const claims = await verifyGrantToken(env, token);
  if (!claims) return null;
  const db = await getDb(env);
  if (!db) return null;
  const nowS = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT jti, service, quota, used, expires_at FROM proxy_grants WHERE jti = ?1 AND expires_at > ?2")
    .bind(claims.jti, nowS)
    .first()
    .catch(() => null);
  if (!row) return null;
  const view = serviceView(row);
  const proxyToken = await mintProxyToken(env, {
    jti: claims.jti,
    uid: claims.uid,
    svc: view.svc,
    quota: view.quota,
    iat: nowS,
    exp: Number(row.expires_at),
  });
  return { ...view, proxyToken };
}

/**
 * Non-consuming status read from a grant OR proxy token (whichever the caller
 * holds) — the link follower's / settings UI's live "remaining" source.
 * @param {Env} env @param {string} token
 * @returns {Promise<ServiceView | null>}
 */
export async function proxyStatus(env, token) {
  const claims = (await verifyProxyToken(env, token)) || (await verifyGrantToken(env, token));
  if (!claims) return null;
  const db = await getDb(env);
  if (!db) return null;
  const row = await db
    .prepare("SELECT jti, service, quota, used, expires_at FROM proxy_grants WHERE jti = ?1")
    .bind(claims.jti)
    .first()
    .catch(() => null);
  return row ? serviceView(row) : null;
}

/**
 * Atomically reserve one unit from a proxy grant's row. Returns "ok",
 * "exhausted" (used up / expired / revoked), or "error" (no row).
 * The row-level guard `used < quota AND not expired` means a concurrent burst
 * can't overrun the grant — at most `quota` UPDATEs ever change a row (the
 * same concurrency proof as src/websearch.js's inline reserve).
 * @param {D1Database} db @param {string} jti @param {"web"|"api"} svc
 * @returns {Promise<"ok"|"exhausted"|"error">}
 */
async function reserveUnit(db, jti, svc) {
  const nowS = Math.floor(Date.now() / 1000);
  const reserve = await db
    .prepare(
      "UPDATE proxy_grants SET used = used + 1 WHERE jti = ?1 AND service = ?2 AND used < quota AND expires_at > ?3",
    )
    .bind(jti, svc, nowS)
    .run()
    .catch(() => null);
  if (reserve && Number(reserve?.meta?.changes || 0) >= 1) return "ok";
  const row = await db.prepare("SELECT jti FROM proxy_grants WHERE jti = ?1").bind(jti).first().catch(() => null);
  return row ? "exhausted" : "error";
}

/**
 * Refund a previously reserved unit (a failed/empty operation must not burn quota).
 * @param {D1Database} db @param {string} jti
 */
async function refundUnit(db, jti) {
  await db
    .prepare("UPDATE proxy_grants SET used = used - 1 WHERE jti = ?1 AND used > 0")
    .bind(jti)
    .run()
    .catch(() => {});
}

/**
 * Read a grant's remaining after an operation (for the client's live counter).
 * @param {D1Database} db @param {string} jti
 */
async function remainingOf(db, jti) {
  const row = await db.prepare("SELECT quota, used FROM proxy_grants WHERE jti = ?1").bind(jti).first().catch(() => null);
  return row ? Math.max(0, Number(row.quota) - Number(row.used)) : null;
}

/**
 * ADJUST a live proxy grant's quota — the same per-token minter control as
 * src/websearch.js's adjustGrantQuota (the secure-workspaces directive,
 * 2026-07-15): the token in circulation stays fixed while its allowance is
 * administered live on the D1 row. Absolute `quota` or relative `delta`,
 * clamped ≥ 0; an increase is checked against the shared global budget
 * ceiling; `opts.ownerId` scopes to the minter's own rows (mismatch reads as
 * not_found so an endpoint never confirms someone else's jti).
 * @param {Env} env
 * @param {Logger} log
 * @param {string} jti
 * @param {{ quota?: number, delta?: number }} patch
 * @param {{ ownerId?: string, budget?: number }} [opts]
 * @returns {Promise<(ServiceView & { error?: undefined }) | { error: string, outstanding?: number, budget?: number } | null>}
 */
export async function adjustProxyGrantQuota(env, log, jti, patch, opts = {}) {
  const db = await getDb(env);
  if (!db) return null;
  const row = await db
    .prepare("SELECT jti, user_id, service, quota, used, expires_at FROM proxy_grants WHERE jti = ?1")
    .bind(String(jti))
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
      log.warn("proxy.adjust_budget_exceeded", { jti: String(jti), increase, outstanding, budget });
      return { error: "budget_exceeded", outstanding, budget };
    }
  }

  const ok = await db
    .prepare("UPDATE proxy_grants SET quota = ?2 WHERE jti = ?1")
    .bind(String(jti), clamped)
    .run()
    .then((r) => Number(r?.meta?.changes || 0) >= 1)
    .catch(() => false);
  if (!ok) return null;
  log.info("proxy.quota_adjusted", { jti: String(jti), from: current, to: clamped, by: opts.ownerId || "admin" });
  return serviceView({ ...row, quota: clamped });
}

// ---- endpoints ------------------------------------------------------------------

/**
 * POST /api/proxy/grant — AUTHED. The ghost-crossover path: hands the signed-in
 * caller their active bundle (mint or reuse). 503 when disabled / no D1.
 * @param {Request} _request @param {Env} env @param {Logger} log @param {Identity} identity
 */
export async function handleProxyGrant(_request, env, log, identity) {
  const bundle = await grantBundle(env, log, identity);
  if (!bundle) return jsonResponse({ error: "Secure-research-space grants are unavailable." }, 503);
  return jsonResponse(bundle);
}

/**
 * POST /api/proxy/adjust — AUTHED. Body: { jti, quota | delta }. The minting
 * user's self-service quota control over their OWN proxy grants (secure
 * workspaces: administer the tokens you handed out). Scoped to the caller's
 * rows; budget-checked on increase. Admins adjust ANY grant via
 * PATCH /api/admin/proxy/:jti instead.
 * @param {Request} request @param {Env} env @param {Logger} log @param {Identity} identity
 */
export async function handleProxyAdjust(request, env, log, identity) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const jti = typeof body?.jti === "string" ? body.jti : "";
  if (!jti) return jsonResponse({ error: "jti is required." }, 400);
  const defaults = await proxyDefaults(env);
  const adjusted = await adjustProxyGrantQuota(
    env,
    log,
    jti,
    { quota: body.quota, delta: body.delta },
    { ownerId: String(identity.id), budget: defaults.budget },
  );
  return adjustResultResponse(adjusted, "No such grant of yours.");
}

/**
 * POST /api/proxy/exchange — PUBLIC. Body: { token } (a grant token). Trades it
 * for the working proxy token. The bundle carries the grant tokens; this is how
 * the client turns them into usable credentials.
 * @param {Request} request @param {Env} env
 */
export async function handleProxyExchange(request, env) {
  const token = await readTokenBody(request);
  if (!token) return jsonResponse({ error: "token is required." }, 400);
  const view = await exchangeGrant(env, token);
  if (!view) return jsonResponse({ error: "Invalid, expired, or revoked grant token." }, 403);
  return jsonResponse(view);
}

/**
 * POST /api/proxy/status — PUBLIC. Body: { token }. Non-consuming remaining read.
 * @param {Request} request @param {Env} env
 */
export async function handleProxyStatus(request, env) {
  const token = await readTokenBody(request);
  if (!token) return jsonResponse({ error: "token is required." }, 400);
  const view = await proxyStatus(env, token);
  if (!view) return jsonResponse({ error: "Invalid, expired, or revoked token." }, 403);
  return jsonResponse(view);
}

/**
 * POST /api/proxy/web — PUBLIC. Body: { token (proxy), query }. Verifies the
 * web proxy token, reserves one unit atomically, runs Exa on the server key,
 * refunds on an empty/failed search. The web-search half of the bundle.
 * @param {Request} request @param {Env} env @param {Logger} log
 */
export async function handleProxyWeb(request, env, log) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body?.token === "string" ? body.token : "";
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, QUERY_MAX) : "";
  if (!token || !query) return jsonResponse({ error: "token and query are required." }, 400);

  const defaults = await proxyDefaults(env);
  if (!defaults.enabled) return jsonResponse({ error: "The secure research space is disabled." }, 503);
  const claims = await verifyProxyToken(env, token);
  if (!claims || claims.svc !== "web") return jsonResponse({ error: "Invalid or expired web proxy token." }, 403);
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Web search is unavailable." }, 503);

  const reserved = await reserveUnit(db, claims.jti, "web");
  if (reserved === "error") return jsonResponse({ error: "Grant not found." }, 403);
  if (reserved === "exhausted") return jsonResponse({ error: "Web-search quota is used up.", remaining: 0 }, 429);

  const result = await webSearch(env, log, query, GRANT_DEPTH).catch(() => null);
  const usable = !!result && Number(result.resultCount) > 0;
  if (!usable) {
    await refundUnit(db, claims.jti);
    log.info("proxy.web_empty", { uid: claims.uid, jti: claims.jti });
    return emptyWebResultResponse(result);
  }
  const remaining = await remainingOf(db, claims.jti);
  log.info("proxy.web_served", { uid: claims.uid, jti: claims.jti, results: result.resultCount, remaining });
  return webResultResponse(result, remaining);
}

/**
 * /api/proxy/llm/* — PUBLIC. The LLM API half of the bundle: an OpenAI-wire
 * REVERSE PROXY to the server's Berget key, so the DRC provider registry
 * (public/js/drc-providers.js) drives it byte-for-byte like any other provider,
 * with the proxy token as the bearer.
 *   GET  /api/proxy/llm/models            → the Berget catalog (non-metered)
 *   POST /api/proxy/llm/chat/completions  → one metered completion (stream or JSON)
 * The client's Authorization header carries the PROXY token; it is verified and
 * REPLACED with the server's Berget key upstream — the user key never exists.
 * @param {Request} request @param {Env} env @param {Logger} log @param {URL} url
 */
export async function handleProxyLlm(request, env, log, url) {
  const defaults = await proxyDefaults(env);
  if (!defaults.enabled) return jsonResponse({ error: "The secure research space is disabled." }, 503);
  if (!env.BERGET_API_TOKEN) return jsonResponse({ error: "LLM proxy is unavailable." }, 503);

  const suffix = url.pathname.replace(/^\/api\/proxy\/llm/, "");
  const auth = request.headers.get("authorization") || "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || "";
  const claims = await verifyProxyToken(env, token);
  if (!claims || claims.svc !== "api") return jsonResponse({ error: "Invalid or expired API proxy token." }, 403);

  // Model catalog — a thin forward of Berget's /models (non-metered).
  if (suffix === "/models" && request.method === "GET") {
    return forwardLlmModels(env);
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
    refund: () => refundUnit(db, claims.jti),
    remainingAfter: () => remainingOf(db, claims.jti),
    tagPrefix: "proxy.llm",
    ids: { uid: claims.uid, jti: claims.jti },
  });
}

/**
 * The thin Berget /models forward — SHARED by this bundle's LLM proxy and the
 * consolidated Se/rver-token LLM endpoint (src/server-grants.js), so the two
 * server-touching grant surfaces present the exact same catalog behavior.
 * Non-metered; the caller owns token verification.
 * @param {Env} env @returns {Promise<Response>}
 */
export async function forwardLlmModels(env) {
  try {
    const res = await fetch(bergetBase(env) + "/models", {
      headers: { authorization: `Bearer ${env.BERGET_API_TOKEN}` },
      signal: AbortSignal.timeout(LLM_CONNECT_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({ data: [] }));
    return jsonResponse(data, res.ok ? 200 : 502);
  } catch {
    return jsonResponse({ data: [] }, 502);
  }
}

/**
 * Forward ONE OpenAI-wire chat completion to Berget on the SERVER key —
 * SHARED by this bundle's LLM proxy and the Se/rver-token LLM endpoint
 * (src/server-grants.js). The caller owns verification and the quota
 * RESERVE; this owns the upstream call, the refund-on-failure discipline
 * (never-connected / upstream-rejected → refund; a mid-stream failure does
 * NOT refund, matching the fail-soft posture), and the response shaping.
 * Re-serializes ONLY known fields onto the server key — the client's
 * Authorization header is never forwarded — and clamps the output ceiling.
 * Berget is OpenAI-compatible, so model/messages/stream/tools/
 * response_format pass straight through.
 * @param {Env} env @param {Logger} log
 * @param {any} body the client's chat-completions body (already validated)
 * @param {{ refund: () => Promise<void>, remainingAfter: () => Promise<number|null>, tagPrefix: string, ids: Record<string, unknown> }} opts
 * @returns {Promise<Response>}
 */
export async function forwardLlmCompletion(env, log, body, opts) {
  const stream = body.stream === true;
  const upstreamBody = {
    model: typeof body.model === "string" ? body.model : undefined,
    messages: body.messages,
    stream,
    max_tokens: Math.min(LLM_MAX_TOKENS, Number(body.max_tokens) > 0 ? Math.floor(Number(body.max_tokens)) : 4096),
    ...(body.response_format ? { response_format: body.response_format } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
  };

  let upstream;
  try {
    upstream = await fetch(bergetBase(env) + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BERGET_API_TOKEN}` },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(stream ? LLM_CONNECT_TIMEOUT_MS : LLM_JSON_TIMEOUT_MS),
    });
  } catch (e) {
    await opts.refund(); // never connected — don't burn quota
    log.warn(`${opts.tagPrefix}_failed`, { ...opts.ids, error: String(/** @type {any} */ (e)?.message || e) });
    return jsonResponse({ error: "The upstream model did not respond." }, 502);
  }
  if (!upstream.ok) {
    await opts.refund();
    const text = await upstream.text().catch(() => "");
    log.warn(`${opts.tagPrefix}_upstream_error`, { ...opts.ids, status: upstream.status });
    return jsonResponse({ error: "The upstream model rejected the request.", detail: text.slice(0, 500) }, 502);
  }
  const remaining = await opts.remainingAfter();
  log.info(`${opts.tagPrefix}_served`, { ...opts.ids, stream, remaining });

  if (stream) {
    // Pipe the upstream SSE straight back — consumeChatStream (server) and the
    // DRC client's parser both read this OpenAI-wire body unchanged.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-proxy-remaining": remaining == null ? "" : String(remaining),
      },
    });
  }
  const data = await upstream.json().catch(() => ({}));
  return jsonResponse({ ...data, remaining }, 200);
}

// ---- admin ----------------------------------------------------------------------

/**
 * Lists the live grants for the admin panel, grouped by bundle (newest first).
 * @param {Env} env
 */
async function listBundles(env) {
  const db = await getDb(env);
  if (!db) return [];
  const nowS = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      "SELECT jti, bundle_id, service, quota, used, created_at, expires_at, label, source, user_id " +
        "FROM proxy_grants WHERE expires_at > ?1 ORDER BY created_at DESC LIMIT ?2",
    )
    .bind(nowS, GRANTS_LIST_MAX)
    .all()
    .catch(() => ({ results: [] }));
  /** @type {Map<string, any>} */
  const byBundle = new Map();
  for (const r of res.results || []) {
    const id = String(r.bundle_id);
    if (!byBundle.has(id)) {
      byBundle.set(id, {
        bundleId: id,
        createdAt: Number(r.created_at) * 1000,
        label: r.label ? String(r.label) : null,
        source: r.source ? String(r.source) : null,
        userId: r.user_id ? String(r.user_id) : null,
        services: [],
      });
    }
    byBundle.get(id).services.push(serviceView(r));
  }
  return [...byBundle.values()];
}

/**
 * /api/admin/proxy* — ADMIN control surface for the bundle subsystem.
 *   GET             → { config (defaults), bundles (live), outstanding, budget }
 *   POST (/ or /mint) → mint a shareable bundle, returns the view + `link`
 *   DELETE /:bundleId → revoke a whole bundle (all its service rows)
 * @param {Request} request @param {Env} env @param {URL} url @param {Logger} log
 * @param {{ id: string | number }} identity the admin identity (only `id` is read)
 */
export async function handleAdminProxy(request, env, url, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const sub = url.pathname.replace(/^\/api\/admin\/proxy/, "");
  const method = request.method;

  if (sub === "" && method === "GET") {
    const [defaults, bundles] = await Promise.all([proxyDefaults(env), listBundles(env)]);
    const outstanding = bundles.reduce(
      (/** @type {number} */ a, /** @type {any} */ b) =>
        a + b.services.reduce((/** @type {number} */ s, /** @type {ServiceView} */ v) => s + v.remaining, 0),
      0,
    );
    return jsonResponse({ config: defaults, bundles, outstanding, budget: defaults.budget });
  }

  if ((sub === "" || sub === "/mint") && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const label = typeof body.label === "string" ? body.label.slice(0, 80) : null;
    const services = Array.isArray(body.services) && body.services.length ? body.services : SERVICES;
    const minted = await mintBundle(env, log, { userId: String(identity.id), source: "link", label, services });
    if (!minted) return jsonResponse({ error: "Minting unavailable." }, 503);
    if (minted.error === "budget_exceeded") return budgetExceeded409(minted);
    const b = /** @type {BundleView} */ (minted);
    // The shareable link: ciphertext in the query, key in the anchor.
    const link = `${url.origin}/cure?rp=${encodeURIComponent(b.blob)}#rk=${encodeURIComponent(b.key)}`;
    return jsonResponse({ ...b, link });
  }

  const del = sub.match(/^\/([A-Za-z0-9-]+)$/);
  if (del && method === "DELETE") {
    const res = await db.prepare("DELETE FROM proxy_grants WHERE bundle_id = ?1").bind(del[1]).run().catch(() => null);
    const ok = !!res && Number(res?.meta?.changes || 0) >= 1;
    log.info("proxy.revoked", { bundleId: del[1], ok });
    return jsonResponse({ ok });
  }

  // PATCH /:jti — adjust ONE service row's quota in place (absolute `quota`
  // or relative `delta`): the admin's per-token add/remove-quota control.
  // Note the id here is a service row's JTI, not a bundle id — a bundle's
  // web and api allowances are administered independently.
  if (del && method === "PATCH") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const defaults = await proxyDefaults(env);
    const adjusted = await adjustProxyGrantQuota(env, log, del[1], { quota: body.quota, delta: body.delta }, { budget: defaults.budget });
    return adjustResultResponse(adjusted, "No such grant.");
  }

  return jsonResponse({ error: "Not found." }, 404);
}
