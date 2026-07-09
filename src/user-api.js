// Signed-in user JSON APIs (non-chat): the model dropdown catalog, the
// account/usage panel, and the client-error beacon. Routed from
// src/index.js; admin endpoints live in src/admin-api.js.

import { countOpenAlerts } from "./alerts.js";
import { countPendingUsers } from "./accounts.js";
import { adminDefaultModelValid, defaultModel, listModels } from "./llm.js";
import { getConfig } from "./config.js";
import { getDb } from "./db.js";
import { deriveHistoryKey, historyKeyConfigured } from "./history-key.js";
import { jsonResponse } from "./http.js";
import { effectiveQuota, getUsage, PERIODS, quotaExceeded, windowReset } from "./quota.js";
import { countUnreadUserMessages, listUserMessages, markAllRead } from "./user-messages.js";

// GET /api/models — model catalog for the UI dropdown (the provider-merged
// list from src/llm.js: Berget's filtered+cached catalog plus the Anthropic
// models when configured), plus the effective default (admin-configured when
// valid and up, else the Worker default).
export async function handleModels(env, log) {
  try {
    const models = await listModels(env);
    const config = await getConfig(env);
    const configured = adminDefaultModelValid(config, models);
    log.debug("models.list", { count: models.length });
    return jsonResponse({ models, default: configured ? config.default_model : defaultModel(env) });
  } catch (err) {
    log.error("models.error", { error: err?.message || String(err) });
    return jsonResponse({ error: "Could not load the model catalog." }, 502);
  }
}

// POST /api/client-error — navigator.sendBeacon target: the client reports
// why ITS side of a chat stream died (the server often can't tell — a
// download-triggered navigation or backgrounded tab kills the fetch without
// a clean disconnect). Whitelisted metadata only, hard-capped; the browser
// error string is not user content. Correlate via chat_request_id (the
// x-request-id the client read off the /api/chat response).
export async function handleClientError(request, log, identity) {
  let body = {};
  try {
    const raw = await request.text();
    if (raw.length <= 2048) body = JSON.parse(raw);
  } catch {
    body = {};
  }
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);
  log.warn("chat.client_error", {
    user_id: identity.id,
    chat_request_id: str(body.request_id, 64),
    error: str(body.error, 200),
    was_hidden: body.was_hidden === true,
    received_chars: Number.isFinite(body.received_chars) ? body.received_chars : 0,
  });
  return new Response(null, { status: 204 });
}

// GET /api/history-key — a per-user key (src/history-key.js) the client
// uses to encrypt/decrypt its own locally-stored chat history
// (public/js/history-store.js). Fails closed (503) when
// HISTORY_KEY_SECRET isn't configured — there is deliberately no
// plaintext fallback, since that would defeat the point of the feature.
export async function handleHistoryKey(env, identity) {
  if (!historyKeyConfigured(env)) {
    return jsonResponse({ error: "Encrypted chat history is not configured on this server." }, 503);
  }
  const key = await deriveHistoryKey(env, identity.id);
  return jsonResponse({ key });
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
  const isAdmin = identity.isSecretAdmin || identity.role === "admin";
  // Notification badge (header account button, visible outside /admin and
  // the message center too): every identity gets its own unread message
  // count (quota exhausted/restored, approvals, quota changes — see
  // src/user-messages.js); admins additionally get pending sign-in
  // approvals + open operational alerts folded into the same total.
  const unreadMessages = await countUnreadUserMessages(env, identity.id);
  let notifications = { unread_messages: unreadMessages, total: unreadMessages };
  if (isAdmin) {
    const [pendingUsers, openAlerts] = await Promise.all([
      countPendingUsers(env),
      countOpenAlerts(env),
    ]);
    notifications = {
      unread_messages: unreadMessages,
      pending_users: pendingUsers,
      open_alerts: openAlerts,
      total: unreadMessages + pendingUsers + openAlerts,
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
    notifications,
    db_configured: !!(await getDb(env)),
  });
}

// GET /api/messages — the personal side of the message center (account.js):
// quota exhausted/restored, sign-in approved, quota changed by an admin.
// "Restored" isn't stored — a quota_exceeded row is annotated `resolved`
// here by checking the caller's CURRENT quota state, so a block that has
// since lifted reads as good news without a second write. Opening this
// list marks everything read (same one-shot pattern as the account panel
// already uses for /api/me).
export async function handleMessages(env, identity) {
  const messages = await listUserMessages(env, identity.id, { limit: 50 });
  let currentBlock = null;
  if (messages.some((m) => m.type === "quota_exceeded")) {
    const config = await getConfig(env);
    const usage = await getUsage(env, identity.id);
    const quota = identity.isSecretAdmin ? null : effectiveQuota(config, identity.user);
    currentBlock = quota ? quotaExceeded(usage, quota) : null;
  }
  const out = messages.map((m) => {
    if (m.type !== "quota_exceeded") return { ...m, resolved: null };
    const stillBlocked = currentBlock && currentBlock.period === m.period && currentBlock.kind === m.kind;
    return { ...m, resolved: !stillBlocked };
  });
  await markAllRead(env, identity.id);
  return jsonResponse({ messages: out });
}
