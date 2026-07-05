// /api/admin/* — JSON API behind the admin role (enforced in index.js).
//
// Endpoints:
//   GET    /api/admin/overview   users(+usage) + config + totals
//   PATCH  /api/admin/users/:id  {role?, status?, name?, quota?} quota={day:{hours,cost_eur},...}|null
//   DELETE /api/admin/users/:id
//   PUT    /api/admin/config     partial config patch -> full config
//
// Accounts are provisioned by Google sign-in (src/google.js) — there is no
// create-user endpoint; the admin manages roles, status, and quotas.

import { deleteUser, listUsers, updateUser } from "./accounts.js";
import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { getConfig, getUsageAllUsers, saveConfig } from "./quota.js";

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
    const userPath = path.match(/^\/users\/(\d+)$/);
    if (userPath && method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      // Role is deliberately NOT patchable: the only admin is ADMIN_EMAIL,
      // assigned by the Google sign-in flow. Sole-admin-forever policy.
      const patch = { status: body.status, name: body.name };
      if ("quota" in body) patch.quota_json = sanitizeQuota(body.quota);
      const user = await updateUser(env, Number(userPath[1]), patch);
      log.info("admin.user_updated", { user_id: userPath[1] });
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
    return jsonResponse({ error: "Not found." }, 404);
  } catch (err) {
    log.warn("admin.api_error", { error: err?.message || String(err) });
    return jsonResponse({ error: err?.message || "Admin API error." }, 400);
  }
}

async function overview(env) {
  const [users, config, usage] = await Promise.all([
    listUsers(env),
    getConfig(env),
    getUsageAllUsers(env),
  ]);
  const usageByUser = Object.fromEntries(usage.map((u) => [u.user_id, u]));
  // Aggregate counts AND cost per window across all identities.
  const totals = { month_requests: 0 };
  for (const p of ["h5", "day", "week", "month"]) {
    for (const k of ["tokens", "searches", "cost", "ms"]) totals[`${p}_${k}`] = 0;
  }
  for (const u of usage) {
    for (const k of Object.keys(totals)) totals[k] += u[k] || 0;
  }
  return jsonResponse({
    users: users.map((u) => ({ ...u, usage: usageByUser[String(u.id)] || null })),
    admin_usage: usageByUser["admin"] || null,
    config,
    totals,
  });
}

// Per-user quota overrides: keep only known numeric fields (tokens and
// searches per window); null clears the override entirely.
function sanitizeQuota(quota) {
  if (quota == null) return null;
  const out = {};
  for (const p of ["h5", "day", "week", "month"]) {
    const q = quota[p];
    if (!q || typeof q !== "object") continue;
    const entry = {};
    for (const k of ["tokens", "searches"]) {
      if (q[k] !== "" && q[k] != null && Number.isFinite(Number(q[k]))) {
        entry[k] = Math.max(0, Math.round(Number(q[k])));
      }
    }
    if (Object.keys(entry).length) out[p] = entry;
  }
  return Object.keys(out).length ? out : null;
}
