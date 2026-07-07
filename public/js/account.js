// Account & usage panel: /api/me rendered as quota bars (opaque budget
// percentage + search counts per window), documentation/admin links, and
// sign-out. Opened from the header's account button.
//
// Three views, all re-rendering the same overlay:
// - "summary" (default): the rolling 5-hour window (the one that actually
//   governs whether you can send another message right now) plus navigation.
// - "full": drills into the calendar windows (today / this week / this
//   month) — reuses the cached /api/me response, no extra fetch.
// - "messages": the message center (src/user-api.js's /api/messages) — for
//   every user, account-level notices (quota exhausted/restored, sign-in
//   approved, quota changed by an admin); for admins, ALSO pending sign-in
//   approvals and operational alerts (same data /admin's Notifications
//   section shows, surfaced here too so an admin doesn't need to leave the
//   main app for routine Approve/Dismiss actions). Deliberately never
//   shows anything derived from actual chat content — see src/user-messages.js.

import { alertSeverityBadge, escapeHtml, pendingApprovalLine } from "./notifications.js";
import { loadSettings, setServerHistory } from "./settings.js";
import { syncToClient, syncToServer } from "./sync.js";

export function initAccountPanel() {
  const overlay = document.getElementById("account");
  const body = document.getElementById("account-body");
  const badge = document.getElementById("notif-badge");
  let me = null;

  const renderBadge = () => {
    const total = me?.notifications?.total || 0;
    if (total > 0) {
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  };

  // Fetched eagerly (not just on account-button click) so the notification
  // badge — personal messages, and for admins also pending approvals + open
  // alerts — shows straight from the main chat view, not only after opening
  // the account panel.
  fetch("/api/me")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) {
        me = data;
        renderBadge();
      }
    })
    .catch(() => {});

  async function loadMessages() {
    body.innerHTML = '<p class="muted">Loading…</p>';
    let personal = [];
    let admin = null;
    try {
      const res = await fetch("/api/messages");
      if (res.ok) personal = (await res.json()).messages || [];
    } catch { /* leave empty on failure */ }
    if (me?.role === "admin") {
      try {
        const res = await fetch("/api/admin/notifications");
        if (res.ok) admin = await res.json();
      } catch { /* admin section just won't render */ }
    }
    // Opening the list marks personal messages read server-side; reflect
    // that locally so the badge doesn't wait for the next /api/me poll.
    if (me?.notifications) {
      me.notifications.total -= me.notifications.unread_messages || 0;
      me.notifications.unread_messages = 0;
      renderBadge();
    }
    renderMessagesView(personal, admin);
  }

  function renderMessagesView(personal, admin) {
    body.innerHTML = renderMessages(personal, admin);
    document.getElementById("msgbackbtn").addEventListener("click", () => show("summary"));
    body.querySelectorAll('[data-act="approve"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await fetch(`/api/admin/users/${btn.dataset.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "active" }),
          });
        } catch { /* ignore — refetch below will just show the prior state */ }
        await loadMessages();
      });
    });
    body.querySelectorAll('[data-act="ack"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await fetch(`/api/admin/alerts/${btn.dataset.id}/ack`, { method: "POST" });
        } catch { /* ignore */ }
        await loadMessages();
      });
    });
  }

  // The "settings" view — its own level below the summary, like "Full
  // usage & history" and "Messages", built as a list of switch rows so
  // future settings just add rows. The switch itself is the original
  // slide-toggle design the composer's web-search knob used before it
  // became the spiderweb (generic .switch classes, not tied to the
  // composer). Cloud storage is ON by default; the row is shown disabled
  // (forced off) when the account can't use it — break-glass identity or a
  // server without the storage bindings — rather than hidden, so the state
  // is explainable.
  function settingRow({ id, label, checked, disabled }) {
    return `
      <div class="settings-row">
        <span class="settings-label">${label}</span>
        <label class="switch">
          <input type="checkbox" id="${id}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>`;
  }

  async function loadSettingsView() {
    body.innerHTML = `
      <button id="settingsbackbtn" type="button" class="back-link">← Back</button>
      <p class="section-lbl">Settings</p>
      <p class="muted">Loading…</p>`;
    document.getElementById("settingsbackbtn").addEventListener("click", () => show("summary"));

    let s = null;
    if (me?.email) {
      try {
        s = await loadSettings(true); // fresh — another device may have flipped it
      } catch {
        s = null;
      }
    }
    const usable = !!s?.available?.storage;
    const note = !me?.email
      ? "Settings need a signed-in account (break-glass sessions have none)."
      : s === null
        ? "Could not load settings — try again in a moment."
        : usable
          ? ""
          : "Cloud storage isn't configured on this server, so history stays in this browser only.";
    body.innerHTML = `
      <button id="settingsbackbtn" type="button" class="back-link">← Back</button>
      <p class="section-lbl">Settings</p>
      <div class="settings-item">
        ${settingRow({ id: "cloudknob", label: "Store history in the cloud", checked: usable && s.server_history, disabled: !usable })}
        <p class="muted setting-desc">On (default): conversations, attached files and the
          document index are kept in this site's Cloudflare storage, so history
          follows your account across devices. Conversations <b>and</b> attached
          files (images included) stay <b>encrypted</b> with the same key mechanism
          they have in this browser; the one readable exception is large
          documents indexed for search — and the search index itself — since
          retrieval needs readable text. Off: everything lives only in this
          browser — switching off downloads it all here and deletes the cloud
          copies.</p>
        <p id="syncstatus" class="muted" hidden></p>
        ${note ? `<p class="muted">${note}</p>` : ""}
      </div>`;
    document.getElementById("settingsbackbtn").addEventListener("click", () => show("summary"));
    if (!usable) return;

    const knob = document.getElementById("cloudknob");
    const status = document.getElementById("syncstatus");
    const progress = (msg) => { status.textContent = msg; };
    knob.addEventListener("change", async () => {
      const on = knob.checked;
      knob.disabled = true;
      status.hidden = false;
      try {
        await setServerHistory(on);
        if (on) {
          const r = await syncToServer(progress);
          status.textContent =
            `Cloud storage is on — ${r.pushed} item(s) uploaded.` +
            (r.errors.length ? ` ${r.errors.length} item(s) failed and will retry on the next sync.` : "");
        } else {
          const r = await syncToClient(progress);
          status.textContent = r.wiped
            ? r.checked
              ? `Cloud storage is off — all ${r.checked} cloud item(s) are in this browser` +
                ` (${r.pulled} newly downloaded, the rest were already here); cloud copies removed.`
              : "Cloud storage is off — the cloud held nothing to download; cloud copies removed."
            : "Downloaded what was reachable, but some items failed — the cloud copies were kept. Toggle again to retry.";
        }
      } catch (err) {
        knob.checked = !on; // the setting didn't change server-side
        status.textContent = err?.message || "Could not update the setting.";
      } finally {
        knob.disabled = false;
      }
    });
  }

  const show = (view) => {
    if (view === "messages") {
      loadMessages();
      return;
    }
    if (view === "settings") {
      loadSettingsView();
      return;
    }
    body.innerHTML = view === "full" ? renderFullUsage(me) : renderSummary(me);
    if (view === "full") {
      document.getElementById("usagebackbtn").addEventListener("click", () => show("summary"));
    } else {
      document.getElementById("fullusagebtn")?.addEventListener("click", () => show("full"));
      document.getElementById("messagesbtn")?.addEventListener("click", () => show("messages"));
      document.getElementById("settingsbtn")?.addEventListener("click", () => show("settings"));
      document.getElementById("logoutbtn").addEventListener("click", async () => {
        await fetch("/logout", { method: "POST" });
        location.href = "/login";
      });
    }
  };

  document.getElementById("accountbtn").addEventListener("click", async () => {
    overlay.hidden = false;
    body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error("HTTP " + res.status);
      me = await res.json();
      renderBadge();
      show("summary");
    } catch {
      body.innerHTML = '<p class="muted">Could not load account info.</p>';
    }
  });
  document.getElementById("accountclose").addEventListener("click", () => {
    overlay.hidden = true;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
}

function renderSummary(me) {
  const who = me.email
    ? `${me.name && me.name !== me.email ? me.name + " · " : ""}${me.email}`
    : "Site administrator";
  const msgCount = me.notifications?.total || 0;
  return `
    <p class="who">${who}<span class="role-badge">${me.unlimited ? "admin · unlimited" : me.role}</span></p>
    ${me.unlimited ? '<p class="muted">Break-glass admin session — usage is tracked under the shared "admin" identity with no personal quota. Sign in with Google to see your own bars.</p>' : ""}
    ${!me.unlimited && !me.enforced ? '<p class="muted">Admin account: bars are shown for reference and keep counting past 100% — nothing blocks you.</p>' : ""}
    ${usageBlock("Last 5 hours", me.windows.h5, true)}
    ${me.db_configured ? "" : '<p class="muted">Accounts database not configured yet — usage tracking and quotas are off.</p>'}
    <!-- Page links open NEW TABS: even though history now persists across
         reloads (encrypted, local — see /help/), a same-tab navigation
         would still abort any in-flight research request. -->
    <div class="account-actions">
      <button id="messagesbtn" type="button"${msgCount ? ' class="has-badge"' : ""}>Messages${msgCount ? ` (${msgCount})` : ""}</button>
      <button id="fullusagebtn" type="button">Full usage &amp; history</button>
      <button id="settingsbtn" type="button">Settings</button>
      <a href="/build/" target="_blank" rel="noopener">About this project</a>
      <a href="/story/" target="_blank" rel="noopener">The build story</a>
      <a href="/help/" target="_blank" rel="noopener">Documentation</a>
      ${me.role === "admin" ? '<a href="/admin" target="_blank" rel="noopener">Admin interface</a>' : ""}
      <button id="logoutbtn" type="button">Sign out</button>
    </div>`;
}

// Drill-down: the three windows that don't gate your next message (today /
// this week / this month), for when you actually want the full picture.
function renderFullUsage(me) {
  const periods = [
    ["Today", "day"],
    ["This week", "week"],
    ["This month", "month"],
  ];
  const blocks = periods.map(([label, p]) => usageBlock(label, me.windows[p], false)).join("");
  return `
    <button id="usagebackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Full usage history</p>
    ${blocks}`;
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
    const alertRows = (admin.alerts || [])
      .filter((a) => !a.acknowledged_at)
      .map(
        (a) => `
      <div class="msg-row">
        ${alertSeverityBadge(a)}
        <div><div>${escapeHtml(a.message)}</div>
        <div class="muted msg-when">${escapeHtml(a.remediation || "")}</div></div>
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

// Users see: an OPAQUE research-budget bar (cost-backed server-side, but
// only a percentage ever reaches the client — never amounts) and plain
// search counts. Currency is the admin's concern.
function usageBlock(label, win, rolling) {
  const fmtN = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
    return String(n);
  };
  const track = (pct) =>
    `<div class="usage-track"><div class="usage-fill${pct >= 90 ? " hot" : ""}" style="width:${Math.min(100, pct)}%"></div></div>`;
  const budgetPct = win.budget_pct;
  const budgetBar =
    budgetPct == null
      ? `<div class="usage-row"><span>Research budget</span><span>no cap</span></div>${track(0)}`
      : `<div class="usage-row"><span>Research budget</span><span>${budgetPct}%</span></div>${track(budgetPct)}`;
  const sPct = win.searches_limit > 0 ? (win.searches / win.searches_limit) * 100 : 0;
  const searchBar =
    `<div class="usage-row"><span>Web searches · ${fmtN(win.searches)}${win.searches_limit > 0 ? " of " + fmtN(win.searches_limit) : ""}</span>
      <span>${win.searches_limit > 0 ? Math.round(sPct) + "%" : ""}</span></div>${track(sPct)}`;
  const reset = win.reset
    ? `${rolling ? "frees up" : "resets"} ${new Date(win.reset).toLocaleString()}`
    : "";
  return `<div class="usage-block"><div class="lbl">${label}${reset ? " · " + reset : ""}</div>
    ${budgetBar}
    ${searchBar}
  </div>`;
}
