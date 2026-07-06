// /api/admin/* — JSON API behind the admin role (enforced in index.js).
//
// Endpoints:
//   GET    /api/admin/overview       users(+usage) + config + totals + alerts
//   GET    /api/admin/notifications  lightweight alerts + pending users, for
//                                    the in-app message center (account.js)
//   PATCH  /api/admin/users/:id      {role?, status?, name?, quota?} quota={day:{hours,cost_eur},...}|null
//   DELETE /api/admin/users/:id
//   PUT    /api/admin/config         partial config patch -> full config
//   POST   /api/admin/alerts/:id/ack dismiss one operational alert
//
// Accounts are provisioned by Google sign-in (src/google.js) — there is no
// create-user endpoint; the admin manages roles, status, and quotas.

import { acknowledgeAlert, listAlerts } from "./alerts.js";
import { deleteUser, getUserById, listUsers, updateUser } from "./accounts.js";
import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { getConfig, saveConfig } from "./config.js";
import { getUsageAllUsers, getUsageByModel, PERIODS } from "./quota.js";
import { addUserMessage } from "./user-messages.js";

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
      const body = await request.json().catch(() => ({}));
      const before = await getUserById(env, Number(userPath[1]));
      // Role is deliberately NOT patchable: the only admin is ADMIN_EMAIL,
      // assigned by the Google sign-in flow. Sole-admin-forever policy.
      const patch = { status: body.status, name: body.name };
      if ("quota" in body) patch.quota_json = sanitizeQuota(body.quota);
      const user = await updateUser(env, Number(userPath[1]), patch);
      log.info("admin.user_updated", { user_id: userPath[1] });
      // Message-center notices for the affected user — structured events
      // only (src/user-messages.js), never the actual quota numbers.
      if (before?.status === "pending" && patch.status === "active") {
        await addUserMessage(env, userPath[1], "account_approved");
      }
      if ("quota" in body) {
        await addUserMessage(env, userPath[1], "quota_changed");
      }
      return jsonResponse({ user });
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
    const alertPath = path.match(/^\/alerts\/(\d+)\/ack$/);
    if (alertPath && method === "POST") {
      await acknowledgeAlert(env, Number(alertPath[1]));
      log.info("admin.alert_acknowledged", { alert_id: alertPath[1] });
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "Not found." }, 404);
  } catch (err) {
    log.warn("admin.api_error", { error: err?.message || String(err) });
    return jsonResponse({ error: err?.message || "Admin API error." }, 400);
  }
}

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
async function notifications(env) {
  const [alerts, users] = await Promise.all([listAlerts(env), listUsers(env)]);
  const pending = users
    .filter((u) => u.status === "pending")
    .map((u) => ({ id: u.id, email: u.email, name: u.name }));
  return jsonResponse({ alerts, pending });
}

// Per-user quota overrides: keep only known numeric fields (budget_eur
// and searches per window); null clears the override entirely.
function sanitizeQuota(quota) {
  if (quota == null) return null;
  const out = {};
  for (const p of PERIODS) {
    const q = quota[p];
    if (!q || typeof q !== "object") continue;
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
