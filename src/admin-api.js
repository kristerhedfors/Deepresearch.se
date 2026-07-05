// /api/admin/* — JSON API behind the admin role (enforced in index.js).
//
// Endpoints:
//   GET    /api/admin/overview            requests + users(+usage) + invites + config + totals
//   POST   /api/admin/invites             {email, role?} -> {token, url}
//   DELETE /api/admin/invites/:token      revoke an unused invite
//   POST   /api/admin/requests/:id        {action: "approve"|"deny"} -> invite on approve
//   PATCH  /api/admin/users/:id           {role?, status?, name?, quota?} quota={day:{hours,cost_eur},...}|null
//   DELETE /api/admin/users/:id
//   PUT    /api/admin/config              partial config patch -> full config

import {
  createInvite,
  deleteUser,
  handleAccessRequest,
  listAccessRequests,
  listInvites,
  listUsers,
  revokeInvite,
  updateUser,
} from "./accounts.js";
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
      return overview(request, env, url);
    }
    if (path === "/invites" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const config = await getConfig(env);
      const invite = await createInvite(env, {
        email: body.email,
        role: body.role,
        expiryDays: config.invite_expiry_days,
        createdBy: identity.id,
      });
      log.info("admin.invite_created", { role: body.role === "admin" ? "admin" : "user" });
      return jsonResponse({ invite: withUrl(invite, url) });
    }
    const inviteDel = path.match(/^\/invites\/([a-f0-9]{48})$/);
    if (inviteDel && method === "DELETE") {
      await revokeInvite(env, inviteDel[1]);
      return jsonResponse({ ok: true });
    }
    const reqAction = path.match(/^\/requests\/(\d+)$/);
    if (reqAction && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const action = body.action === "deny" ? "deny" : "approve";
      const config = await getConfig(env);
      const invite = await handleAccessRequest(env, Number(reqAction[1]), action, config.invite_expiry_days);
      log.info("admin.request_handled", { action });
      return jsonResponse({ ok: true, invite: invite ? withUrl(invite, url) : null });
    }
    const userPatch = path.match(/^\/users\/(\d+)$/);
    if (userPatch && method === "PATCH") {
      const body = await request.json().catch(() => ({}));
      const patch = { role: body.role, status: body.status, name: body.name };
      if ("quota" in body) patch.quota_json = sanitizeQuota(body.quota);
      const user = await updateUser(env, Number(userPatch[1]), patch);
      log.info("admin.user_updated", { user_id: userPatch[1] });
      return jsonResponse({ user });
    }
    if (userPatch && method === "DELETE") {
      await deleteUser(env, Number(userPatch[1]));
      log.info("admin.user_deleted", { user_id: userPatch[1] });
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

async function overview(request, env, url) {
  const [requests, users, invites, config, usage] = await Promise.all([
    listAccessRequests(env, "pending"),
    listUsers(env),
    listInvites(env),
    getConfig(env),
    getUsageAllUsers(env),
  ]);
  const usageByUser = Object.fromEntries(usage.map((u) => [u.user_id, u]));
  const totals = { day_cost: 0, week_cost: 0, month_cost: 0, day_ms: 0, week_ms: 0, month_ms: 0, month_requests: 0 };
  for (const u of usage) {
    for (const k of Object.keys(totals)) totals[k] += u[k] || 0;
  }
  return jsonResponse({
    requests,
    users: users.map((u) => ({ ...u, usage: usageByUser[String(u.id)] || null })),
    admin_usage: usageByUser["admin"] || null,
    invites: invites.map((i) => (i.used_at ? i : withUrl(i, url))),
    config,
    totals,
  });
}

function withUrl(invite, url) {
  return { ...invite, url: `${url.origin}/invite?token=${invite.token}` };
}

// Per-user quota overrides: keep only known numeric fields; null clears.
function sanitizeQuota(quota) {
  if (quota == null) return null;
  const out = {};
  for (const p of ["day", "week", "month"]) {
    const q = quota[p];
    if (!q || typeof q !== "object") continue;
    const entry = {};
    if (Number.isFinite(Number(q.hours)) && q.hours !== "" && q.hours != null) entry.hours = Number(q.hours);
    if (Number.isFinite(Number(q.cost_eur)) && q.cost_eur !== "" && q.cost_eur != null) entry.cost_eur = Number(q.cost_eur);
    if (Object.keys(entry).length) out[p] = entry;
  }
  return Object.keys(out).length ? out : null;
}
