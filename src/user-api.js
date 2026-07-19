// @ts-check
// Signed-in user JSON APIs (non-chat): the model dropdown catalog, the
// account/usage panel, the history-key fetch, the message center, and the
// client-error beacon. Routed from src/index.js; admin endpoints live in
// src/admin-api.js.

import { countOpenAlerts } from "./alerts.js";
import { countPendingUsers } from "./accounts.js";
import { adminDefaultModelValid, defaultModel } from "./berget.js";
import { listChatModels } from "./providers.js";
import { getConfig } from "./config.js";
import { getDb } from "./db.js";
import { deriveHistoryKey, historyKeyConfigured } from "./history-key.js";
import { jsonResponse } from "./http.js";
import { effectiveQuota, getUsage, PERIODS, quotaExceeded, windowReset } from "./quota.js";
import { countUnreadFeedbackReplies } from "./feedback.js";
import { countUnreadUserMessages, listUserMessages, markAllRead } from "./user-messages.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

// GET /api/models — model catalog for the UI dropdown (filtered + cached in
// src/berget.js), plus the effective default (admin-configured when valid
// and up, else the Worker default).
/**
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleModels(env, log) {
  try {
    const models = await listChatModels(env);
    const config = await getConfig(env);
    const configured = adminDefaultModelValid(config, models);
    log.debug("models.list", { count: models.length });
    return jsonResponse({ models, default: configured ? config.default_model : defaultModel(env) });
  } catch (err) {
    log.error("models.error", { error: (/** @type {any} */ (err))?.message || String(err) });
    return jsonResponse({ error: "Could not load the model catalog." }, 502);
  }
}

// POST /api/client-error — navigator.sendBeacon target: the client reports
// why ITS side of a chat stream died (the server often can't tell — a
// download-triggered navigation or backgrounded tab kills the fetch without
// a clean disconnect). Whitelisted metadata only, hard-capped; the browser
// error string is not user content. Correlate via chat_request_id (the
// x-request-id the client read off the /api/chat response).
/**
 * @param {Request} request
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleClientError(request, log, identity) {
  /** @type {any} */
  let body = {};
  try {
    const raw = await request.text();
    if (raw.length <= 2048) body = JSON.parse(raw);
  } catch {
    body = {};
  }
  /** @param {unknown} v @param {number} max */
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

// POST /api/client-log — a general client telemetry beacon (navigator.sendBeacon
// / keepalive fetch). Its first user is the in-browser Linux sandbox filesystem
// integration (public/js/sandbox.js): booting, mounting user files, the seed
// script, exports — all of which run CLIENT-side and would otherwise be
// invisible to Workers Logs. The client batches events; the Worker re-emits each
// through the structured logger so they reach the log URL (`wrangler tail` /
// Workers Logs), correlated by user_id. Every event carries `client: true` so
// it's easy to distinguish from server-originated events.
//
// Levels are honored: a `debug` event only surfaces when LOG_LEVEL=debug, so
// heavy testing flips LOG_LEVEL to debug for per-file detail and back to info
// for production-level milestones — no client redeploy. Untrusted + bounded:
// event names and field values are clamped, the batch is capped, no message
// content is logged (invariant 4 / the log.js privacy rules). Fail-soft: always
// 204 so the client never blocks on telemetry.
/**
 * @param {Request} request
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleClientLog(request, log, identity) {
  /** @type {any} */
  let body = {};
  try {
    const raw = await request.text();
    if (raw.length <= 16384) body = JSON.parse(raw);
  } catch {
    body = {};
  }
  const scope = typeof body.scope === "string" ? body.scope.slice(0, 32) : "client";
  const ua = typeof body.ua === "string" ? body.ua.slice(0, 140) : "";
  const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
  const LEVELS = new Set(["debug", "info", "warn", "error"]);
  // Clamp one event's arbitrary extra fields into safe log values: short
  // strings, finite numbers, booleans. Drop everything else (no nested objects,
  // no message content). Keeps the log line bounded and injection-free.
  /** @param {any} ev */
  const fieldsOf = (ev) => {
    /** @type {Record<string, unknown>} */
    const out = {};
    if (!ev || typeof ev !== "object") return out;
    let n = 0;
    for (const [k, v] of Object.entries(ev)) {
      if (k === "level" || k === "event") continue;
      if (n++ >= 20) break;
      const key = String(k).slice(0, 40);
      if (typeof v === "string") out[key] = v.slice(0, 300);
      else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
      else if (typeof v === "boolean") out[key] = v;
    }
    return out;
  };
  for (const ev of events) {
    const level = LEVELS.has(ev && ev.level) ? ev.level : "info";
    const event = typeof (ev && ev.event) === "string" ? ev.event.slice(0, 80) : "client.event";
    const emit = /** @type {(e: string, f: Record<string, unknown>) => void} */ (
      (/** @type {any} */ (log))[level] || log.info
    );
    emit(event, { client: true, user_id: identity.id, scope, ua, ...fieldsOf(ev) });
  }
  return new Response(null, { status: 204 });
}

// GET /api/history-key — a per-user key (src/history-key.js) the client
// uses to encrypt/decrypt its own locally-stored chat history
// (public/js/history-store.js). Fails closed (503) when
// HISTORY_KEY_SECRET isn't configured — there is deliberately no
// plaintext fallback, since that would defeat the point of the feature.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
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
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMe(env, identity) {
  const config = await getConfig(env);
  const usage = await getUsage(env, identity.id, Date.now(), identity.user?.quota_reset_at);
  const quota = identity.isSecretAdmin ? null : effectiveQuota(config, identity.user);
  /** @type {Record<string, { budget_pct: number | null, searches: number, searches_limit: number, reset: number }>} */
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
  // Unread agent replies on the user's feedback threads count too — the
  // "the developers wrote back" signal the feedback dialogue depends on.
  const [unreadMessages, unreadFeedback] = await Promise.all([
    countUnreadUserMessages(env, identity.id),
    countUnreadFeedbackReplies(env, identity.id),
  ]);
  /** @type {{ unread_messages: number, unread_feedback: number, total: number, pending_users?: number, open_alerts?: number }} */
  let notifications = {
    unread_messages: unreadMessages,
    unread_feedback: unreadFeedback,
    total: unreadMessages + unreadFeedback,
  };
  if (isAdmin) {
    const [pendingUsers, openAlerts] = /** @type {[number, number]} */ (
      await Promise.all([countPendingUsers(env), countOpenAlerts(env)])
    );
    notifications = {
      unread_messages: unreadMessages,
      unread_feedback: unreadFeedback,
      pending_users: pendingUsers,
      open_alerts: openAlerts,
      total: unreadMessages + unreadFeedback + pendingUsers + openAlerts,
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
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMessages(env, identity) {
  const messages = await listUserMessages(env, identity.id, { limit: 50 });
  let currentBlock = null;
  if (messages.some((m) => m.type === "quota_exceeded")) {
    const config = await getConfig(env);
    const usage = await getUsage(env, identity.id, Date.now(), identity.user?.quota_reset_at);
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
