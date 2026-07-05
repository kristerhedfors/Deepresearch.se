// Signed-in user JSON APIs (non-chat): the model dropdown catalog and the
// account/usage panel. Routed from src/index.js; admin endpoints live in
// src/admin-api.js.

import { defaultModel, listModels } from "./berget.js";
import { getConfig } from "./config.js";
import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { effectiveQuota, getUsage, PERIODS, windowReset } from "./quota.js";

// GET /api/models — model catalog for the UI dropdown (filtered + cached in
// src/berget.js), plus the effective default (admin-configured when valid
// and up, else the Worker default).
export async function handleModels(env, log) {
  try {
    const models = await listModels(env);
    const config = await getConfig(env);
    const configured = config.default_model && models.some((m) => m.id === config.default_model && m.up);
    log.debug("models.list", { count: models.length });
    return jsonResponse({ models, default: configured ? config.default_model : defaultModel(env) });
  } catch (err) {
    log.error("models.error", { error: err?.message || String(err) });
    return jsonResponse({ error: "Could not load the model catalog." }, 502);
  }
}

// GET /api/me — identity + usage vs quota for the user dashboard.
// The Berget budget is cost-based but OPAQUE to users: only a percentage
// leaves the server (never the EUR amounts). Searches are plain counts.
export async function handleMe(env, identity) {
  const config = await getConfig(env);
  const usage = await getUsage(env, identity.id);
  const quota = identity.isSecretAdmin ? null : effectiveQuota(config, identity.user);
  const windows = {};
  for (const p of PERIODS) {
    const budget = quota?.[p]?.budget_eur || 0;
    windows[p] = {
      budget_pct:
        budget > 0 ? Math.min(999, Math.round((100 * usage[p].berget_cost) / budget)) : null,
      searches: usage[p].searches,
      searches_limit: quota?.[p]?.searches || 0,
      reset: windowReset(p, Date.now(), usage.h5_oldest),
    };
  }
  return jsonResponse({
    id: identity.id,
    email: identity.email,
    name: identity.name,
    role: identity.role,
    unlimited: !!identity.isSecretAdmin,
    // Admins see their bars fill and overflow, but are never blocked.
    enforced: !identity.isSecretAdmin && identity.role !== "admin",
    windows,
    db_configured: !!(await getDb(env)),
  });
}
