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
import { loadSettings, setServerHistory, setSettings, setShodanMcp } from "./settings.js";
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
  // composer). Each row is a SINGLE line — one label, one info glyph, one
  // switch — with the full explanation tucked into a press-and-hold
  // popover (the same gesture the composer's web-search knob uses), so the
  // panel stays compact no matter how many knobs it grows. A row is shown
  // disabled (forced off) when the account can't use it — break-glass
  // identity, or a server missing the feature's backing — rather than
  // hidden, so the state stays explainable.
  function settingRow({ id, label, checked, disabled, popId, info }) {
    return `
      <div class="settings-item">
        <div class="settings-row">
          <span class="settings-label">${label}
            <button type="button" class="setting-info" data-pop="${popId}" aria-label="More about “${label}”">ⓘ</button>
          </span>
          <label class="switch">
            <input type="checkbox" id="${id}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}>
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </label>
        </div>
        <div class="setting-pop" id="${popId}" hidden>${info}</div>
      </div>`;
  }

  const CLOUD_INFO = `<strong>Store history in the cloud</strong><br>
    <b>On (default):</b> conversations, attached files and the document index are
    kept in this site's Cloudflare storage, so your history follows your account
    across devices. Conversations <b>and</b> attached files (images included) stay
    <b>encrypted</b> with the same key mechanism they have in this browser; the one
    readable exception is large documents indexed for search — and the search
    index itself — since retrieval needs readable text.<br>
    <b>Off:</b> everything lives only in this browser — switching off downloads it
    all here and deletes the cloud copies.`;

  // The three Google Maps photo-feature knobs share one privacy story: only
  // an attached photo's GPS coordinates are ever sent to Google, and only
  // while the knob is on. Each row explains its own feature.
  const STREETVIEW_INFO = `<strong>Street-level views (Google Street View)</strong><br>
    <b>On (default):</b> when you attach a photo that carries GPS coordinates,
    the research pipeline fetches Street View images of that spot (looking
    north, east, south and west) so vision-capable models can literally look
    around the location and describe what's there. Every answer also gets a
    clickable Street View link either way.<br>
    <b>Off:</b> no Street View images are fetched.<br>
    <b>Privacy:</b> only the photo's <b>coordinates</b> are sent to Google —
    never your question, your files, or anything about your account.`;

  const PLACES_INFO = `<strong>Nearby place details (Google Places)</strong><br>
    <b>On (default):</b> establishments around a photo's location come from
    Google Places — with ratings, review counts, open-now and
    permanently-closed status — instead of only the free OpenStreetMap data
    (which remains the fallback).<br>
    <b>Off:</b> nearby places still appear, from OpenStreetMap only.<br>
    <b>Privacy:</b> only the photo's <b>coordinates</b> are sent to Google.`;

  const MAP_INFO = `<strong>Area map context (Google Maps)</strong><br>
    <b>On (default):</b> vision-capable models also get a road-map image of the
    photo's location (marked with a pin) so answers can reason about the
    area's layout — street names, distances, what's around the corner.<br>
    <b>Off:</b> no map image is fetched.<br>
    <b>Privacy:</b> only the photo's <b>coordinates</b> are sent to Google.`;

  const SHODAN_INFO = `<strong>Shodan host intelligence (MCP)</strong><br>
    <b>On:</b> when a question mentions an IP address or hostname, the site looks it
    up on <a href="https://www.shodan.io" target="_blank" rel="noopener">Shodan</a>
    and adds what it finds — open ports, running services, organization/ASN,
    hosting location and known CVEs — to the research so the answer can use and
    cite it.<br>
    <b>Off (default):</b> nothing is sent to Shodan.<br>
    <b>Privacy:</b> only the IP/hostname itself is sent to Shodan — never your
    question or anything about your account. It runs only when your message
    actually names a host, and independently of the web-search switch.`;

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
    const shodanUsable = !!s?.available?.shodan;
    const mapsUsable = !!s?.available?.maps;
    const note = !me?.email
      ? "Settings need a signed-in account (break-glass sessions have none)."
      : s === null
        ? "Could not load settings — try again in a moment."
        : "";
    const cloudNote = usable
      ? ""
      : `<p class="muted setting-note">Cloud storage isn't configured on this server, so history stays in this browser only.</p>`;
    const shodanNote = shodanUsable
      ? ""
      : `<p class="muted setting-note">Shodan isn't configured on this server (no API key), so this stays off.</p>`;
    const mapsNote = mapsUsable
      ? ""
      : `<p class="muted setting-note">Google Maps features aren't configured on this server (no API key), so these stay off.</p>`;

    body.innerHTML = `
      <button id="settingsbackbtn" type="button" class="back-link">← Back</button>
      <p class="section-lbl">Settings</p>
      ${settingRow({
        id: "cloudknob",
        label: "Store history in the cloud",
        checked: usable && s?.server_history,
        disabled: !usable,
        popId: "cloudpop",
        info: CLOUD_INFO,
      })}
      ${cloudNote}
      <p id="syncstatus" class="muted setting-note" hidden></p>
      ${settingRow({
        id: "shodanknob",
        label: "Shodan host intelligence",
        checked: shodanUsable && s?.shodan_mcp,
        disabled: !shodanUsable,
        popId: "shodanpop",
        info: SHODAN_INFO,
      })}
      ${shodanNote}
      <p id="shodanstatus" class="muted setting-note" hidden></p>
      ${settingRow({
        id: "streetviewknob",
        label: "Street-level views",
        checked: mapsUsable && s?.street_view,
        disabled: !mapsUsable,
        popId: "streetviewpop",
        info: STREETVIEW_INFO,
      })}
      ${settingRow({
        id: "placesknob",
        label: "Nearby place details",
        checked: mapsUsable && s?.nearby_places,
        disabled: !mapsUsable,
        popId: "placespop",
        info: PLACES_INFO,
      })}
      ${settingRow({
        id: "mapknob",
        label: "Area map context",
        checked: mapsUsable && s?.map_context,
        disabled: !mapsUsable,
        popId: "mappop",
        info: MAP_INFO,
      })}
      ${mapsNote}
      <p id="mapsstatus" class="muted setting-note" hidden></p>
      ${note ? `<p class="muted setting-note">${note}</p>` : ""}`;
    document.getElementById("settingsbackbtn").addEventListener("click", () => show("summary"));
    wireSettingPopovers(body);

    if (usable) {
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

    if (shodanUsable) {
      const knob = document.getElementById("shodanknob");
      const status = document.getElementById("shodanstatus");
      knob.addEventListener("change", async () => {
        const on = knob.checked;
        knob.disabled = true;
        status.hidden = false;
        try {
          await setShodanMcp(on);
          status.textContent = on
            ? "Shodan is on — IPs and hostnames you mention are looked up during research."
            : "Shodan is off — nothing is sent to Shodan.";
        } catch (err) {
          knob.checked = !on;
          status.textContent = err?.message || "Could not update the setting.";
        } finally {
          knob.disabled = false;
        }
      });
    }

    if (mapsUsable) {
      const status = document.getElementById("mapsstatus");
      for (const [id, key, name] of [
        ["streetviewknob", "street_view", "Street-level views"],
        ["placesknob", "nearby_places", "Nearby place details"],
        ["mapknob", "map_context", "Area map context"],
      ]) {
        const knob = document.getElementById(id);
        knob.addEventListener("change", async () => {
          const on = knob.checked;
          knob.disabled = true;
          try {
            await setSettings({ [key]: on });
            status.hidden = true;
          } catch (err) {
            knob.checked = !on; // the setting didn't change server-side
            status.hidden = false;
            status.textContent = err?.message || `Could not update “${name}”.`;
          } finally {
            knob.disabled = false;
          }
        });
      }
    }
  }

  // Press-and-hold (or click the ⓘ) on a settings row opens its detail
  // popover — the same gesture the composer's web-search knob uses. Only one
  // popover is open at a time; a click anywhere outside closes it.
  function wireSettingPopovers(root) {
    const closeAll = () => root.querySelectorAll(".setting-pop").forEach((p) => (p.hidden = true));
    root.querySelectorAll(".setting-info").forEach((btn) => {
      const pop = root.querySelector(`#${btn.dataset.pop}`);
      if (!pop) return;
      let holdTimer = 0;
      const open = () => {
        const wasHidden = pop.hidden;
        closeAll();
        pop.hidden = !wasHidden;
      };
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        open();
      });
      btn.addEventListener("pointerdown", () => {
        holdTimer = setTimeout(() => {
          closeAll();
          pop.hidden = false;
        }, 500);
      });
      for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
        btn.addEventListener(ev, () => clearTimeout(holdTimer));
      }
    });
    // The info-button handlers above are on freshly rendered elements each
    // time, but the outside-click closer lives on the persistent
    // #account-body — bind it once so re-opening Settings doesn't stack it.
    if (!root._popCloserBound) {
      root._popCloserBound = true;
      root.addEventListener("click", (e) => {
        if (!e.target.closest(".setting-pop") && !e.target.closest(".setting-info")) {
          root.querySelectorAll(".setting-pop").forEach((p) => (p.hidden = true));
        }
      });
    }
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
