// The account panel's "messages" view — the message center
// (src/user-api.js's /api/messages): for every user, account-level notices
// (quota exhausted/restored, sign-in approved, quota changed by an admin);
// for admins, ALSO pending sign-in approvals and operational alerts (same
// data /admin's Notifications section shows, surfaced here too so an admin
// doesn't need to leave the main app for routine Approve/Dismiss actions).
// Deliberately never shows anything derived from actual chat content — see
// src/user-messages.js. The panel shell (showView) lives in account.js.

import { renderNotifBadge } from "./account-views.js";
import { alertSeverityBadge, escapeHtml, pendingApprovalLine } from "./notifications.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

/**
 * Fetches the message-center data (and, for admins, the notifications
 * feed), marks personal messages read locally, and renders the view.
 * @param {PanelCtx} ctx
 */
export async function loadMessagesView(ctx) {
  ctx.body.innerHTML = '<p class="muted">Loading…</p>';
  let personal = [];
  let admin = null;
  try {
    const res = await fetch("/api/messages");
    if (res.ok) personal = (await res.json()).messages || [];
  } catch { /* leave empty on failure */ }
  if (ctx.me?.role === "admin") {
    try {
      const res = await fetch("/api/admin/notifications");
      if (res.ok) admin = await res.json();
    } catch { /* admin section just won't render */ }
  }
  // Opening the list marks personal messages read server-side; reflect
  // that locally so the badge doesn't wait for the next /api/me poll.
  if (ctx.me?.notifications) {
    ctx.me.notifications.total -= ctx.me.notifications.unread_messages || 0;
    ctx.me.notifications.unread_messages = 0;
    renderNotifBadge(ctx);
  }
  renderMessagesView(ctx, personal, admin);
}

/**
 * Renders the message center and wires its back / Approve / Dismiss
 * buttons (the admin actions reload the view to reflect the outcome).
 * @param {PanelCtx} ctx
 * @param {object[]} personal  /api/messages rows
 * @param {?object} admin      /api/admin/notifications payload (admins only)
 */
function renderMessagesView(ctx, personal, admin) {
  ctx.body.innerHTML = renderMessages(personal, admin);
  document.getElementById("msgbackbtn").addEventListener("click", () => ctx.show("summary"));
  ctx.body.querySelectorAll('[data-act="approve"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await fetch(`/api/admin/users/${btn.dataset.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "active" }),
        });
      } catch { /* ignore — refetch below will just show the prior state */ }
      await loadMessagesView(ctx);
    });
  });
  ctx.body.querySelectorAll('[data-act="ack"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await fetch(`/api/admin/alerts/${btn.dataset.id}/ack`, { method: "POST" });
      } catch { /* ignore */ }
      await loadMessagesView(ctx);
    });
  });
}

const PERIOD_LABEL = { h5: "5-hour", day: "daily", week: "weekly", month: "monthly" };

// Renders one personal message — deliberately only ever formats the
// structured type/period/kind enums src/user-messages.js stores, never
// anything resembling free-text content.
function formatPersonalMessage(m) {
  const when = new Date(m.created_at).toLocaleString();
  const period = PERIOD_LABEL[m.period] || m.period || "";
  if (m.type === "quota_exceeded") {
    const kindLabel = m.kind === "budget" ? "research budget" : "search budget";
    return m.resolved
      ? { icon: "✓", text: `Your ${period} ${kindLabel} is available again`, when }
      : { icon: "⚠", text: `Your ${period} ${kindLabel} was used up`, when };
  }
  if (m.type === "account_approved") return { icon: "✓", text: "Your account was approved", when };
  if (m.type === "quota_changed") return { icon: "ℹ", text: "Your research quota was updated by an admin", when };
  return { icon: "ℹ", text: "Account update", when };
}

// "Seen 3× · first 08/07/2026, 21:40 · last 08/07/2026, 22:12" (or just the
// timestamp for a single occurrence) — an alert's when-line for the message
// center. Alerts dedupe into one row with a count (src/alerts.js), so the
// first/last spread is the honest picture of a repeating problem.
function alertTimestampLine(a) {
  const last = new Date(a.last_seen_at).toLocaleString();
  if (!a.count || a.count <= 1) return last;
  return `Seen ${a.count}× · first ${new Date(a.first_seen_at).toLocaleString()} · last ${last}`;
}

/**
 * The message-center view's HTML: personal notices, plus the admin
 * section (pending approvals + open alerts) when `admin` data is present.
 * @param {object[]} personal
 * @param {?object} admin
 * @returns {string} HTML
 */
function renderMessages(personal, admin) {
  const personalHtml = personal.length
    ? personal
        .map((m) => {
          const f = formatPersonalMessage(m);
          return `<div class="msg-row"><span class="msg-icon">${f.icon}</span>
            <div><div>${escapeHtml(f.text)}</div><div class="muted msg-when">${escapeHtml(f.when)}</div></div>
          </div>`;
        })
        .join("")
    : '<p class="muted">No messages yet.</p>';

  let adminHtml = "";
  if (admin) {
    const pendingRows = (admin.pending || [])
      .map(
        (u) => `
      <div class="msg-row">
        <span class="badge pending">pending</span>
        <div><div>${pendingApprovalLine(u)}</div>
        <div class="muted msg-when">${escapeHtml(u.email)}</div></div>
        <button data-act="approve" data-id="${u.id}">Approve</button>
      </div>`,
      )
      .join("");
    // Each alert row carries its timestamp (last occurrence, plus the count
    // and first occurrence when it repeated) — reported 2026-07-08: an
    // LLM-provider alert with no way to tell WHEN it happened, which is the
    // first thing needed to correlate it with a stuck run. Same fields the
    // /admin notification center already shows, compacted for this panel.
    const alertRows = (admin.alerts || [])
      .filter((a) => !a.acknowledged_at)
      .map(
        (a) => `
      <div class="msg-row">
        ${alertSeverityBadge(a)}
        <div><div>${escapeHtml(a.message)}</div>
        ${a.remediation ? `<div class="muted msg-when">${escapeHtml(a.remediation)}</div>` : ""}
        <div class="muted msg-when">${escapeHtml(alertTimestampLine(a))}</div></div>
        <button data-act="ack" data-id="${a.id}">Dismiss</button>
      </div>`,
      )
      .join("");
    adminHtml = `
      <p class="section-lbl">Admin</p>
      ${pendingRows || alertRows ? pendingRows + alertRows : '<p class="muted">No admin notifications.</p>'}`;
  }

  return `
    <button id="msgbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Message center</p>
    ${personalHtml}
    ${adminHtml}`;
}
