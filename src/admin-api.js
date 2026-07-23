// @ts-check
// /api/admin/* — JSON API behind the admin role (enforced in index.js).
//
// Endpoints:
//   GET    /api/admin/overview       users(+usage) + config + totals + alerts
//   GET    /api/admin/notifications  lightweight alerts + pending users, for
//                                    the in-app message center (account.js)
//   GET    /api/admin/user-cost      ?user_id=|email= — one user's spend
//                                    attribution: per-window LLM vs search
//                                    totals + per-model breakdown ("what has
//                                    cost so much for this user")
//   PATCH  /api/admin/users/:id      {status?, name?, quota?} quota={day:{budget_eur,searches},...}|null
//   POST   /api/admin/users/:id/quota/reset  {days?}|{clear} — zero a user's
//                                    usage + grant an uncapped grace window
//                                    (default a week) without deleting history
//   DELETE /api/admin/users/:id
//   PUT    /api/admin/config         partial config patch -> full config
//   POST   /api/admin/alerts/:id/ack dismiss one operational alert
//   GET    /api/admin/chatlogs       full-visibility chat interaction log,
//   GET    /api/admin/chatlogs/:id   newest first (src/chatlog.js — built for
//                                    the agentic debugging workflow; see the
//                                    chat-logs skill for query params)
//   *      /api/admin/feedback*      the Feedback-mode queue (src/feedback.js)
//   *      /api/admin/security*      the security-risk review board
//                                    (src/security-risks.js — votes/score/
//                                    note/priority over SECURITY-RISKS.md §3;
//                                    ?format=text is the fix loop's input)
//   *      /api/admin/features*      the features/priority review board
//                                    (src/features.js — votes/effort/note/
//                                    priority over FEATURES.md §3;
//                                    ?format=text is the build loop's input)
//   *      /api/admin/panels*        the panel-SELECTION board (src/panels.js —
//                                    the admin panels reshaped purely by ▲/▼
//                                    thumbs; ?format=text is the attention
//                                    loop's input — which surface is in focus)
//   *      /api/admin/websearch*     the temporary web-search grant control
//                                    surface (src/websearch.js): GET list +
//                                    defaults, POST mint a shareable link,
//                                    DELETE /:jti revoke
//   GET    /api/admin/boards         the admin-BOARDS discovery index
//                                    (src/admin-boards.js — one entry per
//                                    Claude-fetchable list + how to fetch its
//                                    text view; ?format=text is the "pop up
//                                    every board" entry point)
//
// Accounts are provisioned by Google sign-in (src/google.js) — there is no
// create-user endpoint; the admin manages status, names, and quotas.

import { acknowledgeAlert, listAlerts } from "./alerts.js";
import { handleChatLogs } from "./chatlog.js";
import { handleAdminFeedback } from "./feedback.js";
import { handleAdminSecurity } from "./security-risks.js";
import { handleAdminFeatures } from "./features.js";
import { handleAdminPanels } from "./panels.js";
import { handleAdminTestpoints } from "./testpoints.js";
import { handleAdminBoards } from "./admin-boards.js";
import { handleAdminServerErrors } from "./server-errors.js";
import { handleAdminWebSearch } from "./websearch.js";
import { webSearch } from "./exa.js";
import { resolveSearchBackend } from "./websearch-backends.js";
import { handleAdminProxy } from "./proxy.js";
import { handleAdminServerToken } from "./server-grants.js";
import { handleAdminPool } from "./pool.js";
import { handleAgentLink } from "./agent-link.js";
import { deleteUser, getUserByEmail, getUserById, listUsers, updateUser } from "./accounts.js";
import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { getConfig, saveConfig } from "./config.js";
import {
  getUsage,
  getUsageAllUsers,
  getUsageByModel,
  getUsageByModelForUser,
  PERIODS,
  quotaResetAt,
  DEFAULT_RESET_DAYS,
} from "./quota.js";
import { addUserMessage } from "./user-messages.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleAdminApi(request, env, url, log, identity) {
  const db = await getDb(env);
  if (!db) {
    return jsonResponse(
      {
        error: "Database not configured.",
        setup:
          "Run `npx wrangler d1 create deepresearch-se`, put the database_id into the [[d1_databases]] block in wrangler.toml, and redeploy.",
      },
      503,
    );
  }

  const path = url.pathname.replace(/^\/api\/admin/, "");
  const method = request.method;

  try {
    if (path === "/overview" && method === "GET") {
      return overview(env);
    }
    if (path === "/notifications" && method === "GET") {
      return notifications(env);
    }
    // Per-user cost attribution: "what has this user's budget gone to?" —
    // the per-window totals (berget_cost = LLM, exa_cost = search) plus the
    // per-model breakdown (usage_model_events). ?user_id= or ?email=.
    if (path === "/user-cost" && method === "GET") {
      return userCost(env, url);
    }
    const resetPath = path.match(/^\/users\/(\d+)\/quota\/reset$/);
    if (resetPath && method === "POST") {
      return resetUserQuota(request, env, log, Number(resetPath[1]));
    }
    const userPath = path.match(/^\/users\/(\d+)$/);
    if (userPath && method === "PATCH") {
      return patchUser(request, env, log, Number(userPath[1]));
    }
    if (userPath && method === "DELETE") {
      await deleteUser(env, Number(userPath[1]));
      log.info("admin.user_deleted", { user_id: userPath[1] });
      return jsonResponse({ ok: true });
    }
    if (path === "/config" && method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const config = await saveConfig(env, body);
      log.info("admin.config_saved", {});
      return jsonResponse({ config });
    }
    if ((path === "/chatlogs" || /^\/chatlogs\/\d+$/.test(path)) && method === "GET") {
      return handleChatLogs(request, env, url, log);
    }
    // The feedback queue (src/feedback.js): the agent/operator side of
    // Feedback pipeline — list, read, set status, reply, delete.
    if (path === "/feedback" || path.startsWith("/feedback/")) {
      return handleAdminFeedback(request, env, url, log);
    }
    // The security-risk review board (src/security-risks.js): the register's
    // §3 backlog with admin votes, manual scores, notes, and the explicit
    // priority order the security-fix loop works in.
    if (path === "/security" || path.startsWith("/security/")) {
      return handleAdminSecurity(request, env, url, log);
    }
    // The features/priority review board (src/features.js): FEATURES.md §3's
    // backlog with admin votes, effort estimates, notes, and the explicit
    // priority order the feature-build loop works in — the second loop channel.
    if (path === "/features" || path.startsWith("/features/")) {
      return handleAdminFeatures(request, env, url, log);
    }
    // The panel-selection board (src/panels.js): the admin panels themselves,
    // reshaped purely by the owner's ▲/▼ thumbs — the ATTENTION loop (which
    // admin surface the owner is working on now). ?format=text is its input.
    if (path === "/panels" || path.startsWith("/panels/")) {
      return handleAdminPanels(request, env, url, log);
    }
    // The testable-interaction-points queue (src/testpoints.js): declared,
    // linkable "try-it" points — CRUD + the 👍/👎 verdict. The banner and
    // queue UI on the DRS app read this surface; scripts/testpoints is the
    // producer/reader CLI. See the testable-interaction-points skill.
    if (path === "/testpoints" || path.startsWith("/testpoints/")) {
      return handleAdminTestpoints(request, env, url, log);
    }
    // The server-ERROR fix queue (src/server-errors.js): the runtime-recorded
    // uncaught top-level 500s, deduped per bug — list, read, set status
    // (open|fixed|ignored), note, delete. The "type loop → next crash to fix"
    // work queue.
    if (path === "/errors" || path.startsWith("/errors/")) {
      return handleAdminServerErrors(request, env, url, log);
    }
    // The admin-BOARDS discovery index (src/admin-boards.js): one call that
    // lists every Claude-fetchable board and how to pull its prioritized
    // text view — the "pop up all the boards" entry point.
    if (path === "/boards" && method === "GET") {
      return handleAdminBoards(request, env, url, log);
    }
    // The temporary web-search grant control surface (src/websearch.js): list
    // live grants + defaults, mint a shareable `…/cure?ws=<token>` link, revoke.
    // (The default quota/TTL/budget themselves are edited via PUT /config.)
    if (path === "/websearch" || path.startsWith("/websearch/")) {
      return handleAdminWebSearch(request, env, url, log, identity);
    }
    // The web-search BACKEND (src/websearch-backends.js): GET reports the
    // resolved backend + which env secrets are present; POST /test runs one
    // live search through the currently-configured backend so the admin can
    // verify a self-hosted service works. The backend SELECTION itself is
    // edited via PUT /config. See the local-web-search skill.
    if (path === "/search" && method === "GET") {
      const cfg = await getConfig(env);
      const resolved = resolveSearchBackend(env, cfg.search);
      return jsonResponse({
        config: cfg.search,
        resolved: { backend: resolved.backend, baseUrl: resolved.baseUrl, results: resolved.results, fallbackExa: resolved.fallbackExa },
        env: {
          hasBackendKey: !!resolved.key,
          hasBackendUrlOverride: !!(/** @type {any} */ (env)?.SEARCH_BACKEND_URL),
          hasExaKey: !!(/** @type {any} */ (env)?.EXA_API_KEY),
        },
      });
    }
    if (path === "/search/test" && method === "POST") {
      const body = /** @type {any} */ (await request.json().catch(() => ({})));
      const query = typeof body?.query === "string" ? body.query.trim().slice(0, 200) : "";
      if (!query) return jsonResponse({ error: "A test query is required." }, 400);
      const cfg = await getConfig(env);
      const resolved = resolveSearchBackend(env, cfg.search);
      const started = Date.now();
      const res = await webSearch(env, log, query, { numResults: resolved.results, type: "auto" }).catch((e) => ({
        content: String(e?.message || e),
        items: [],
        sources: [],
        resultCount: 0,
      }));
      log.info("admin.search_test", { backend: resolved.backend, results: res.resultCount });
      return jsonResponse({
        backend: resolved.backend,
        resultCount: res.resultCount,
        durationMs: Date.now() - started,
        cached: /** @type {any} */ (res).cached || false,
        sources: (res.sources || []).slice(0, 10),
        content: String(res.content || "").slice(0, 1500),
      });
    }
    // The secure-research-space proxy-bundle control surface (src/proxy.js):
    // list live bundles + defaults, mint a shareable `…/cure?rp=…#rk=…` link,
    // revoke a whole bundle. (Per-service defaults are edited via PUT /config.)
    if (path === "/proxy" || path.startsWith("/proxy/")) {
      return handleAdminProxy(request, env, url, log, identity);
    }
    // The consolidated Se/rver-token control surface (src/server-grants.js):
    // list live tokens + defaults, mint a one-JWT grant (a permission set over
    // upstream APIs only — never Se/rver data), per-permission quota adjust,
    // revoke. (Defaults are edited via PUT /config.)
    if (path === "/server-token" || path.startsWith("/server-token/")) {
      return handleAdminServerToken(request, env, url, log, identity);
    }
    // The compute-sharing oversight surface (src/pool.js): list live pool
    // tokens + online providers across ALL pools, revoke any token. (Defaults
    // are edited via PUT /config.)
    if (path === "/pool" || path.startsWith("/pool/")) {
      return handleAdminPool(request, env, url, log);
    }
    // Mint a shareable Se/rver token for an AgentSpec (src/agent-link.js):
    // the agent's spec sets the upstream services + quota; the token is a
    // standard Se/rver token, metered by the same rows, honoring the same
    // guarantee (upstream APIs only, never Se/rver data, never a login).
    if (path === "/agent-link" && method === "POST") {
      return handleAgentLink(request, env, url, log, identity);
    }
    const alertPath = path.match(/^\/alerts\/(\d+)\/ack$/);
    if (alertPath && method === "POST") {
      await acknowledgeAlert(env, Number(alertPath[1]));
      log.info("admin.alert_acknowledged", { alert_id: alertPath[1] });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "Not found." }, 404);
  } catch (err) {
    const message = (/** @type {any} */ (err))?.message;
    log.warn("admin.api_error", { error: message || String(err) });
    return jsonResponse({ error: message || "Admin API error." }, 400);
  }
}

// PATCH /api/admin/users/:id — {status?, name?, quota?}; quota=null clears
// the per-user override.
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {number} userId
 */
async function patchUser(request, env, log, userId) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const before = await getUserById(env, userId);
  // Role is deliberately NOT patchable: the only admin is ADMIN_EMAIL,
  // assigned by the Google sign-in flow. Sole-admin-forever policy.
  /** @type {{ status?: string, name?: string, quota_json?: any }} */
  const patch = { status: body.status, name: body.name };
  if ("quota" in body) patch.quota_json = sanitizeQuota(body.quota);
  const user = await updateUser(env, userId, patch);
  log.info("admin.user_updated", { user_id: String(userId) });
  // Message-center notices for the affected user — structured events
  // only (src/user-messages.js), never the actual quota numbers.
  if (before?.status === "pending" && patch.status === "active") {
    await addUserMessage(env, userId, "account_approved");
  }
  if ("quota" in body) {
    await addUserMessage(env, userId, "quota_changed");
  }
  return jsonResponse({ user });
}

// POST /api/admin/users/:id/quota/reset — {days?} | {clear:true}
// "Reset the entire quota for a user with a button tap." Sets the user's
// quota_reset_at (src/quota.js): usage before it stops counting, so every
// quota bar drops to zero immediately AND — because the timestamp is set into
// the FUTURE (now + days) — the user is uncapped until it passes, i.e. their
// available quota is extended by a whole week (DEFAULT_RESET_DAYS) at least.
// Nothing is deleted: usage_events, chat history, and the admin's cost
// analytics all stay intact. {clear:true} removes the reset (normal counting).
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {number} userId
 */
async function resetUserQuota(request, env, log, userId) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  if (body?.clear) {
    const user = await updateUser(env, userId, { quota_reset_at: null });
    if (!user) return jsonResponse({ error: "Not found." }, 404);
    log.info("admin.quota_reset_cleared", { user_id: String(userId) });
    return jsonResponse({ user, quota_reset_at: null });
  }
  const days = Number.isFinite(Number(body?.days)) ? Number(body.days) : DEFAULT_RESET_DAYS;
  const resetAt = quotaResetAt(Date.now(), days);
  const user = await updateUser(env, userId, { quota_reset_at: resetAt });
  if (!user) return jsonResponse({ error: "Not found." }, 404);
  // Notify the affected user (structured event only — never the numbers).
  await addUserMessage(env, userId, "quota_changed");
  log.info("admin.quota_reset", { user_id: String(userId), reset_at: resetAt });
  return jsonResponse({ user, quota_reset_at: resetAt });
}

/** @param {Env} env */
async function overview(env) {
  const [users, config, usage, byModel, alerts] = await Promise.all([
    listUsers(env),
    getConfig(env),
    getUsageAllUsers(env),
    getUsageByModel(env),
    listAlerts(env),
  ]);
  const usageByUser = Object.fromEntries(usage.map((u) => [u.user_id, u]));
  // Aggregate counts AND costs per window across all identities.
  /** @type {Record<string, number>} */
  const totals = { month_requests: 0 };
  for (const p of PERIODS) {
    for (const k of ["tokens", "searches", "berget_cost", "exa_cost", "ms"]) {
      totals[`${p}_${k}`] = 0;
    }
  }
  for (const u of usage) {
    for (const k of Object.keys(totals)) totals[k] += u[k] || 0;
  }
  return jsonResponse({
    users: users.map((u) => ({ ...u, usage: usageByUser[String(u.id)] || null })),
    admin_usage: usageByUser["admin"] || null,
    by_model: byModel,
    config,
    totals,
    alerts,
  });
}

// GET /api/admin/user-cost?user_id=<id>|email=<addr> — the drill-down that
// answers "what has cost so much for this user". Two axes, so the answer is
// never just an opaque lump:
//   - usage: per-window totals — berget_cost (LLM spend) vs exa_cost (search
//     spend), so the FIRST split (LLM vs search) is immediate;
//   - by_model: per-model breakdown from the attribution ledger, so LLM spend
//     is further attributable to the model that drove it (the user's answer
//     model, the cheap JSON planner, or the vision helper) instead of folded
//     onto one model. Populated for requests served after this ledger shipped.
// The break-glass admin identity (user_id "admin", no users row) is accepted
// directly so its own spend is inspectable too.
/**
 * @param {Env} env
 * @param {URL} url
 */
async function userCost(env, url) {
  const idParam = url.searchParams.get("user_id");
  const email = url.searchParams.get("email");
  let user = null;
  if (idParam && /^\d+$/.test(idParam)) user = await getUserById(env, Number(idParam));
  else if (email) user = await getUserByEmail(env, email);
  // usage_events.user_id is String(users.id) for signed-in users, or the
  // literal "admin" for the break-glass identity (which has no users row).
  const userId = user ? String(user.id) : idParam === "admin" ? "admin" : null;
  if (!userId) {
    return jsonResponse({ error: "Unknown user. Pass ?user_id=<id> or ?email=<address>." }, 404);
  }
  const [usage, byModel] = await Promise.all([
    getUsage(env, userId, Date.now(), user?.quota_reset_at || 0),
    getUsageByModelForUser(env, userId),
  ]);
  return jsonResponse({
    user: user ? { id: user.id, email: user.email, name: user.name } : { id: userId },
    usage,
    by_model: byModel,
  });
}

// Lighter-weight than /overview — just what the in-app message center
// needs (account.js), so opening it doesn't drag in the full usage/config
// payload the dedicated /admin dashboard already has cached.
/** @param {Env} env */
async function notifications(env) {
  const [alerts, users] = await Promise.all([listAlerts(env), listUsers(env)]);
  const pending = users
    .filter((u) => u.status === "pending")
    .map((u) => ({ id: u.id, email: u.email, name: u.name }));
  return jsonResponse({ alerts, pending });
}

// Per-user quota overrides: keep only known numeric fields (budget_eur
// and searches per window); null clears the override entirely.
/**
 * @param {any} quota the PATCH body's quota field
 * @returns {Record<string, { budget_eur?: number, searches?: number }> | null}
 */
function sanitizeQuota(quota) {
  if (quota == null) return null;
  /** @type {Record<string, { budget_eur?: number, searches?: number }>} */
  const out = {};
  for (const p of PERIODS) {
    const q = quota[p];
    if (!q || typeof q !== "object") continue;
    /** @type {{ budget_eur?: number, searches?: number }} */
    const entry = {};
    if (q.budget_eur !== "" && q.budget_eur != null && Number.isFinite(Number(q.budget_eur))) {
      entry.budget_eur = Math.max(0, Number(q.budget_eur));
    }
    if (q.searches !== "" && q.searches != null && Number.isFinite(Number(q.searches))) {
      entry.searches = Math.max(0, Math.round(Number(q.searches)));
    }
    if (Object.keys(entry).length) out[p] = entry;
  }
  return Object.keys(out).length ? out : null;
}
