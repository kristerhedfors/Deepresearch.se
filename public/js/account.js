// Account & usage panel: /api/me rendered as quota bars (opaque budget
// percentage + search counts per window), documentation/admin links, and
// sign-out. Opened from the header's account button.
//
// Two levels: the default view keeps only the rolling 5-hour window (the
// one that actually governs whether you can send another message right
// now) plus navigation; "Full usage & history" drills into the calendar
// windows (today / this week / this month). Both views re-render from the
// same cached /api/me response — only the first open hits the network.

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

  // Fetched eagerly (not just on account-button click) so an admin sees
  // the notification badge — pending sign-in approvals + open operational
  // alerts — straight from the main chat view, not only after opening the
  // account panel or /admin. A no-op badge-wise for regular users:
  // /api/me only includes `notifications` for admins.
  fetch("/api/me")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) {
        me = data;
        renderBadge();
      }
    })
    .catch(() => {});

  const show = (view) => {
    body.innerHTML = view === "full" ? renderFullUsage(me) : renderSummary(me);
    if (view === "full") {
      document.getElementById("usagebackbtn").addEventListener("click", () => show("summary"));
    } else {
      document.getElementById("fullusagebtn")?.addEventListener("click", () => show("full"));
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
  return `
    <p class="who">${who}<span class="role-badge">${me.unlimited ? "admin · unlimited" : me.role}</span></p>
    ${me.unlimited ? '<p class="muted">Break-glass admin session — usage is tracked under the shared "admin" identity with no personal quota. Sign in with Google to see your own bars.</p>' : ""}
    ${!me.unlimited && !me.enforced ? '<p class="muted">Admin account: bars are shown for reference and keep counting past 100% — nothing blocks you.</p>' : ""}
    ${me.notifications?.total ? `<p class="notif-notice">⚠ ${me.notifications.total} notification${me.notifications.total === 1 ? "" : "s"} — ${me.notifications.open_alerts ? `${me.notifications.open_alerts} alert${me.notifications.open_alerts === 1 ? "" : "s"}` : ""}${me.notifications.open_alerts && me.notifications.pending_users ? " · " : ""}${me.notifications.pending_users ? `${me.notifications.pending_users} pending approval${me.notifications.pending_users === 1 ? "" : "s"}` : ""} — see <a href="/admin" target="_blank" rel="noopener">Admin interface</a></p>` : ""}
    ${usageBlock("Last 5 hours", me.windows.h5, true)}
    ${me.db_configured ? "" : '<p class="muted">Accounts database not configured yet — usage tracking and quotas are off.</p>'}
    <!-- Page links open NEW TABS: the conversation lives only in this
         tab's memory, so a same-tab navigation would destroy it. -->
    <div class="account-actions">
      <button id="fullusagebtn" type="button">Full usage &amp; history</button>
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
