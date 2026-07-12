// @ts-check
// /api/admin/* — JSON API behind the admin role (enforced in index.js).
//
// Endpoints:
//   GET    /api/admin/overview       users(+usage) + config + totals + alerts
//   GET    /api/admin/notifications  lightweight alerts + pending users, for
//                                    the in-app message center (account.js)
//   PATCH  /api/admin/users/:id      {status?, name?, quota?} quota={day:{budget_eur,searches},...}|null
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
import { handleAdminBoards } from "./admin-boards.js";
import { deleteUser, getUserById, listUsers, updateUser } from "./accounts.js";
import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { getConfig, saveConfig } from "./config.js";
import { getUsageAllUsers, getUsageByModel, PERIODS } from "./quota.js";
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
    // Feedback mode — list, read, set status, reply, delete.
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
    // The admin-BOARDS discovery index (src/admin-boards.js): one call that
    // lists every Claude-fetchable board and how to pull its prioritized
    // text view — the "pop up all the boards" entry point.
    if (path === "/boards" && method === "GET") {
      return handleAdminBoards(request, env, url, log);
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
