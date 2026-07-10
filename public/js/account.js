// Account & usage panel: /api/me rendered as quota bars (opaque budget
// percentage + search counts per window), documentation/admin links, and
// sign-out. Opened from the header's account button.
//
// Six views, all re-rendering the same overlay body via showView():
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
// - "settings": the cloud-storage / Shodan / Google Maps knobs.
// - "feedback": the user's feedback dialogue threads.
// - "games": the games shelf (GET /api/games).
//
// Each view is a top-level load*/render* function taking the shared panel
// context (created once by initAccountPanel) so the sections stay
// independently readable; the context carries the DOM refs plus the cached
// /api/me payload the badge and views render from.

import { alertSeverityBadge, escapeHtml, pendingApprovalLine } from "./notifications.js";
import {
  feedbackAvailable,
  feedbackModeOn,
  loadSettings,
  setFeedbackMode,
  setGoogleMaps,
  setServerHistory,
  setShodanMcp,
} from "./settings.js";
import { syncToClient, syncToServer } from "./sync.js";
import { applyFeedbackMode } from "./turns.js";

/**
 * The panel context shared by every view function below — created once in
 * initAccountPanel and threaded through explicitly.
 * @typedef {object} PanelCtx
 * @property {HTMLElement} overlay  #account — the full-screen overlay
 * @property {HTMLElement} body     #account-body — every view renders here
 * @property {HTMLElement} badge    #notif-badge — the header's counter
 * @property {?object} me           cached /api/me payload (null until fetched)
 * @property {(view: string) => void} show  switches the visible view
 */

// One settings switch row — the shared building block of the Settings
// sub-view AND the summary's Feedback-mode knob. A single line — one label,
// one info glyph, one switch — with the full explanation tucked into a
// press-and-hold popover (the same gesture the composer's web-search knob
// uses; see wireSettingPopovers). The switch itself is the original
// slide-toggle design the composer's web-search knob used before it became
// the spiderweb (generic .switch classes, not tied to the composer). A row
// is shown disabled (forced off) when the account can't use it —
// break-glass identity, or a server missing the feature's backing — rather
// than hidden, so the state stays explainable.
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

// ---- setting-knob info popover texts ----------------------------------------

// Feedback mode lives DIRECTLY on the account summary (not buried in the
// Settings sub-view): it's the dialogue-with-the-developers switch, meant
// to be one tap away.
const FEEDBACK_INFO = `<strong>Feedback mode</strong><br>
  <b>On:</b> every reply — including earlier ones — gets a <b>Feedback</b>
  button. Press it to tell the developers what was good or bad about that
  answer; your note is sent together with the question and the reply it's
  about. The development agent reads every submission, and its answers show
  up as a dialogue under <b>Feedback</b> here in the account panel.<br>
  <b>Off (default):</b> no feedback buttons, nothing is sent.<br>
  <b>Privacy:</b> only what you choose to submit is stored — the comment you
  write plus that one question and reply — readable by the site's
  developers. Withdrawing an entry deletes it, thread included.`;

const CLOUD_INFO = `<strong>Store history in the cloud</strong><br>
  <b>On (default):</b> conversations, attached files and the document index are
  kept in this site's Cloudflare storage, so your history follows your account
  across devices. Conversations <b>and</b> attached files (images included) stay
  <b>encrypted</b> with the same key mechanism they have in this browser; the
  readable exceptions are what's indexed for search — large documents, project
  files and notes, and chats inside a project (indexed so the project's other
  chats can draw on them) — plus the search index itself, since retrieval
  needs readable text.<br>
  <b>Off:</b> everything lives only in this browser — switching off downloads it
  all here and deletes the cloud copies.`;

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

const GOOGLEMAPS_INFO = `<strong>Google Maps &amp; Street View</strong><br>
  <b>On:</b> when your message names a street address (or you attach a photo
  with GPS location), the site looks it up on Google
  <a href="https://developers.google.com/maps" target="_blank" rel="noopener">Maps
  Platform</a> — resolving it with the Places API (name, address, type,
  rating), confirming Street View coverage and its capture date, and pulling
  a road map — then adds those details and clickable Maps/Street View links
  to the research, handing the Street View and map images to a vision-capable
  model to describe.<br>
  <b>Off (default):</b> nothing is sent to Google.<br>
  <b>Privacy:</b> only the address itself (or a photo's coordinates) is sent
  to Google — never your whole question or anything about your account. It
  runs only when your message names an address or you attach a located photo,
  and independently of the web-search switch.`;

// ---- panel bootstrap ---------------------------------------------------------

/**
 * Wires the account panel once at boot: the eager /api/me fetch that feeds
 * the header's notification badge, and the open/close handlers on the
 * header button and overlay.
 * @returns {void}
 */
export function initAccountPanel() {
  const ctx = {
    overlay: document.getElementById("account"),
    body: document.getElementById("account-body"),
    badge: document.getElementById("notif-badge"),
    me: null,
    show: null,
  };
  ctx.show = (view) => showView(ctx, view);

  // Fetched eagerly (not just on account-button click) so the notification
  // badge — personal messages, and for admins also pending approvals + open
  // alerts — shows straight from the main chat view, not only after opening
  // the account panel.
  fetch("/api/me")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) {
        ctx.me = data;
        renderNotifBadge(ctx);
      }
    })
    .catch(() => {});

  document.getElementById("accountbtn").addEventListener("click", async () => {
    ctx.overlay.hidden = false;
    ctx.body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error("HTTP " + res.status);
      ctx.me = await res.json();
      renderNotifBadge(ctx);
      ctx.show("summary");
    } catch {
      ctx.body.innerHTML = '<p class="muted">Could not load account info.</p>';
    }
  });
  document.getElementById("accountclose").addEventListener("click", () => {
    ctx.overlay.hidden = true;
  });
  ctx.overlay.addEventListener("click", (e) => {
    if (e.target === ctx.overlay) ctx.overlay.hidden = true;
  });
}

/**
 * Renders the header's notification counter from the cached /api/me
 * payload (hidden at zero).
 * @param {PanelCtx} ctx
 */
function renderNotifBadge(ctx) {
  const total = ctx.me?.notifications?.total || 0;
  if (total > 0) {
    ctx.badge.textContent = total > 99 ? "99+" : String(total);
    ctx.badge.hidden = false;
  } else {
    ctx.badge.hidden = true;
  }
}

/**
 * View dispatcher: renders the named view into the panel body and wires
 * its controls. The summary/full views render synchronously from the
 * cached /api/me; the rest fetch their own data.
 * @param {PanelCtx} ctx
 * @param {"summary"|"full"|"messages"|"settings"|"feedback"|"games"} view
 */
function showView(ctx, view) {
  if (view === "messages") {
    loadMessagesView(ctx);
    return;
  }
  if (view === "settings") {
    loadSettingsView(ctx);
    return;
  }
  if (view === "feedback") {
    loadFeedbackView(ctx);
    return;
  }
  if (view === "games") {
    loadGamesView(ctx);
    return;
  }
  ctx.body.innerHTML = view === "full" ? renderFullUsage(ctx.me) : renderSummary(ctx.me);
  if (view === "full") {
    document.getElementById("usagebackbtn").addEventListener("click", () => ctx.show("summary"));
  } else {
    document.getElementById("fullusagebtn")?.addEventListener("click", () => ctx.show("full"));
    document.getElementById("messagesbtn")?.addEventListener("click", () => ctx.show("messages"));
    document.getElementById("settingsbtn")?.addEventListener("click", () => ctx.show("settings"));
    document.getElementById("feedbackbtn")?.addEventListener("click", () => ctx.show("feedback"));
    wireFeedbackKnob(ctx);
    document.getElementById("gamesbtn")?.addEventListener("click", () => ctx.show("games"));
    document.getElementById("logoutbtn").addEventListener("click", async () => {
      await fetch("/logout", { method: "POST" });
      location.href = "/login";
    });
  }
}

// ---- messages view -----------------------------------------------------------

/**
 * Fetches the message-center data (and, for admins, the notifications
 * feed), marks personal messages read locally, and renders the view.
 * @param {PanelCtx} ctx
 */
async function loadMessagesView(ctx) {
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

// ---- settings view -----------------------------------------------------------

/**
 * Fetches fresh settings and renders the Settings sub-view: the
 * cloud-storage, Shodan, and Google Maps knobs, each disabled (with a
 * note) when the server can't back it.
 * @param {PanelCtx} ctx
 */
async function loadSettingsView(ctx) {
  ctx.body.innerHTML = `
    <button id="settingsbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Settings</p>
    <p class="muted">Loading…</p>`;
  document.getElementById("settingsbackbtn").addEventListener("click", () => ctx.show("summary"));

  let s = null;
  if (ctx.me?.email) {
    try {
      s = await loadSettings(true); // fresh — another device may have flipped it
    } catch {
      s = null;
    }
  }
  const usable = !!s?.available?.storage;
  const shodanUsable = !!s?.available?.shodan;
  const googleMapsUsable = !!s?.available?.google_maps;
  const note = !ctx.me?.email
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
  const googleMapsNote = googleMapsUsable
    ? ""
    : `<p class="muted setting-note">Google Maps isn't configured on this server (no Google Maps API key), so this stays off.</p>`;

  ctx.body.innerHTML = `
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
      id: "gmapsknob",
      label: "Google Maps & Street View",
      checked: googleMapsUsable && s?.google_maps,
      disabled: !googleMapsUsable,
      popId: "gmapspop",
      info: GOOGLEMAPS_INFO,
    })}
    ${googleMapsNote}
    <p id="gmapsstatus" class="muted setting-note" hidden></p>
    ${note ? `<p class="muted setting-note">${note}</p>` : ""}`;
  document.getElementById("settingsbackbtn").addEventListener("click", () => ctx.show("summary"));
  wireSettingPopovers(ctx.body);

  if (usable) wireCloudStorageKnob();
  if (shodanUsable) {
    wireSimpleKnob("shodanknob", "shodanstatus", setShodanMcp, {
      on: "Shodan is on — IPs and hostnames you mention are looked up during research.",
      off: "Shodan is off — nothing is sent to Shodan.",
    });
  }
  if (googleMapsUsable) {
    wireSimpleKnob("gmapsknob", "gmapsstatus", setGoogleMaps, {
      on: "Google Maps is on — addresses you mention (and located photos) are looked up on Google Maps & Street View.",
      off: "Google Maps is off — nothing is sent to Google.",
    });
  }
}

// The cloud knob is the one setting whose flip triggers a bulk move
// (sync.js): ON pushes everything local up, OFF drains everything down and
// wipes the cloud — the status line narrates progress and the outcome.
function wireCloudStorageKnob() {
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

/**
 * Wires a settings knob whose flip is a single /api/settings write (the
 * Shodan and Google Maps rows): optimistic toggle, status text on the
 * outcome, revert on failure.
 * @param {string} knobId    checkbox element id
 * @param {string} statusId  status <p> element id
 * @param {(on: boolean) => Promise<any>} setter  settings.js write
 * @param {{on: string, off: string}} texts  status line per new state
 */
function wireSimpleKnob(knobId, statusId, setter, texts) {
  const knob = document.getElementById(knobId);
  const status = document.getElementById(statusId);
  knob.addEventListener("change", async () => {
    const on = knob.checked;
    knob.disabled = true;
    status.hidden = false;
    try {
      await setter(on);
      status.textContent = on ? texts.on : texts.off;
    } catch (err) {
      knob.checked = !on;
      status.textContent = err?.message || "Could not update the setting.";
    } finally {
      knob.disabled = false;
    }
  });
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

// ---- games view --------------------------------------------------------------

// The "games" view — the games shelf, rendered from the server's games
// registry (GET /api/games, src/games.js) so a newly registered game
// appears here with no client change. Games open in a NEW TAB like the
// other page links (same-tab navigation would abort an in-flight research
// request). A game whose backing is missing on this server is shown
// disabled with the reason — the same explain-don't-hide posture as the
// settings rows.
async function loadGamesView(ctx) {
  const shell = (inner) => `
    <button id="gamesbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Games</p>
    ${inner}`;
  const wireBack = () =>
    document.getElementById("gamesbackbtn").addEventListener("click", () => ctx.show("summary"));
  ctx.body.innerHTML = shell('<p class="muted">Loading…</p>');
  wireBack();
  let games = null;
  try {
    const res = await fetch("/api/games");
    if (res.ok) games = (await res.json()).games || [];
  } catch { /* games stays null → error state below */ }
  if (!games) {
    ctx.body.innerHTML = shell('<p class="muted">Could not load the games list — try again in a moment.</p>');
    wireBack();
    return;
  }
  const rows = games.length
    ? games
        .map((g) =>
          g.available
            ? `<div class="account-actions">
                 <a href="${escapeHtml(g.path)}" target="_blank" rel="noopener">${escapeHtml(g.emoji)} ${escapeHtml(g.name)} — ${escapeHtml(g.tagline)}</a>
               </div>
               <p class="muted">${escapeHtml(g.description)}</p>`
            : `<div class="account-actions"><a aria-disabled="true">${escapeHtml(g.emoji)} ${escapeHtml(g.name)}</a></div>
               <p class="muted">Needs ${escapeHtml(g.requires || "server configuration")} — not available on this server.</p>`,
        )
        .join("")
    : '<p class="muted">No games are registered on this server.</p>';
  ctx.body.innerHTML = shell(rows);
  wireBack();
}

// ---- feedback view -----------------------------------------------------------

// The summary's Feedback-mode knob: persists via /api/settings
// (feedback_mode) and flips the body's `feedback-mode` class so every
// on-screen reply — existing ones included — shows/hides its Feedback
// button immediately (turns.js).
function wireFeedbackKnob(ctx) {
  wireSettingPopovers(ctx.body);
  const knob = document.getElementById("fbknob");
  if (!knob || knob.disabled) return;
  const status = document.getElementById("fbstatus");
  knob.addEventListener("change", async () => {
    const on = knob.checked;
    knob.disabled = true;
    status.hidden = false;
    try {
      await setFeedbackMode(on);
      applyFeedbackMode(on);
      status.textContent = on
        ? "Feedback mode is on — every reply now has a Feedback button."
        : "Feedback mode is off. Your existing feedback dialogues stay under Feedback.";
    } catch (err) {
      knob.checked = !on;
      status.textContent = err?.message || "Could not update the setting.";
    } finally {
      knob.disabled = false;
    }
  });
}

// The Feedback view: the user's submitted entries as dialogue threads —
// the user-facing half of the development loop (the agent's half is the
// feedback-loop skill working /api/admin/feedback). Reply boxes keep the
// dialogue going; Withdraw deletes an entry, thread included. Opening the
// view marks the agent's replies read server-side (GET does it), so the
// badge clears like the message center's does.
async function loadFeedbackView(ctx) {
  ctx.body.innerHTML = `
    <button id="fbbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Feedback</p>
    <p class="muted">Loading…</p>`;
  document.getElementById("fbbackbtn").addEventListener("click", () => ctx.show("summary"));
  let entries = null;
  try {
    const res = await fetch("/api/feedback");
    if (res.ok) entries = (await res.json()).feedback || [];
  } catch { /* entries stays null → error note below */ }
  if (ctx.me?.notifications) {
    ctx.me.notifications.total -= ctx.me.notifications.unread_feedback || 0;
    ctx.me.notifications.unread_feedback = 0;
    renderNotifBadge(ctx);
  }
  const list =
    entries === null
      ? '<p class="muted">Could not load feedback — try again in a moment.</p>'
      : entries.length
        ? entries.map(renderFeedbackEntry).join("")
        : `<p class="muted">No feedback yet. Switch on Feedback mode, then press
           <b>Feedback</b> under any reply to start a dialogue with the developers.</p>`;
  ctx.body.innerHTML = `
    <button id="fbbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Feedback</p>
    ${list}`;
  document.getElementById("fbbackbtn").addEventListener("click", () => ctx.show("summary"));
  ctx.body.querySelectorAll("[data-fb-reply]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.fbReply;
      const ta = ctx.body.querySelector(`textarea[data-fb-ta="${id}"]`);
      const text = ta?.value.trim();
      if (!text) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/feedback/${id}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || "HTTP " + res.status);
        await loadFeedbackView(ctx);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = err?.message || "Failed — try again";
      }
    });
  });
  ctx.body.querySelectorAll("[data-fb-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await fetch(`/api/feedback/${btn.dataset.fbDel}`, { method: "DELETE" });
      } catch { /* the reload below shows whatever the server now has */ }
      await loadFeedbackView(ctx);
    });
  });
}

// ---- summary & usage rendering (pure HTML builders) ---------------------------

/**
 * The summary view's HTML: identity line, the 5-hour usage block, the
 * Feedback-mode knob (signed-in accounts), and the navigation buttons.
 * @param {object} me  cached /api/me payload
 * @returns {string} HTML
 */
function renderSummary(me) {
  const who = me.email
    ? `${me.name && me.name !== me.email ? me.name + " · " : ""}${me.email}`
    : "Site administrator";
  const msgCount = me.notifications?.total || 0;
  const fbCount = me.notifications?.unread_feedback || 0;
  // Feedback mode sits directly on the summary — knob state from the cached
  // /api/settings copy (fetched at boot in app.js; refreshed by the Settings
  // view). Disabled when the account can't use it (break-glass, no D1).
  const feedbackRow = me.email
    ? settingRow({
        id: "fbknob",
        label: "Feedback mode",
        checked: feedbackAvailable() && feedbackModeOn(),
        disabled: !feedbackAvailable(),
        popId: "fbpop",
        info: FEEDBACK_INFO,
      }) + '<p id="fbstatus" class="muted setting-note" hidden></p>'
    : "";
  return `
    <p class="who">${who}<span class="role-badge">${me.unlimited ? "admin · unlimited" : me.role}</span></p>
    ${me.unlimited ? '<p class="muted">Break-glass admin session — usage is tracked under the shared "admin" identity with no personal quota. Sign in with Google to see your own bars.</p>' : ""}
    ${!me.unlimited && !me.enforced ? '<p class="muted">Admin account: bars are shown for reference and keep counting past 100% — nothing blocks you.</p>' : ""}
    ${usageBlock("Last 5 hours", me.windows.h5, true)}
    ${me.db_configured ? "" : '<p class="muted">Accounts database not configured yet — usage tracking and quotas are off.</p>'}
    ${feedbackRow}
    <!-- Page links open NEW TABS: even though history now persists across
         reloads (encrypted, local — see /help/), a same-tab navigation
         would still abort any in-flight research request. -->
    <div class="account-actions">
      <button id="messagesbtn" type="button"${msgCount ? ' class="has-badge"' : ""}>Messages${msgCount ? ` (${msgCount})` : ""}</button>
      ${me.email ? `<button id="feedbackbtn" type="button">Feedback${fbCount ? ` (${fbCount})` : ""}</button>` : ""}
      <button id="fullusagebtn" type="button">Full usage &amp; history</button>
      <button id="settingsbtn" type="button">Settings</button>
      <button id="gamesbtn" type="button">Games</button>
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

// User-facing status labels for a feedback entry — friendlier than the raw
// lifecycle enums (src/feedback.js).
const FB_STATUS = {
  new: ["received", "new"],
  seen: ["seen", "seen"],
  in_progress: ["being worked on", "working"],
  resolved: ["resolved", "done"],
  declined: ["declined", "done"],
};

// One feedback entry: status + date header, the context line (which reply it
// was about), the dialogue (the original comment is the first user message,
// then the thread), a reply box, and Withdraw. All user/agent text is
// escaped — same posture as the message center.
function renderFeedbackEntry(e) {
  const [statusLabel, statusClass] = FB_STATUS[e.status] || [e.status, "new"];
  const about = e.question
    ? `<div class="muted fb-about">About: “${escapeHtml(e.question.length > 120 ? e.question.slice(0, 120) + "…" : e.question)}”</div>`
    : "";
  const thread = [{ author: "user", body: e.comment, created_at: e.created_at }, ...e.messages]
    .map(
      (m) => `
      <div class="fb-msg ${m.author === "agent" ? "agent" : "user"}">
        <div class="fb-msg-head muted">${m.author === "agent" ? "DeepResearch.se" : "You"} · ${escapeHtml(new Date(m.created_at).toLocaleString())}</div>
        <div>${escapeHtml(m.body)}</div>
      </div>`,
    )
    .join("");
  return `
    <div class="fb-entry">
      <div class="fb-head">
        <span class="fb-status ${statusClass}">${statusLabel}</span>
        <span class="muted">${escapeHtml(new Date(e.created_at).toLocaleString())}</span>
      </div>
      ${about}
      ${thread}
      <div class="fb-replybox">
        <textarea data-fb-ta="${e.id}" rows="2" placeholder="Reply…"></textarea>
        <div class="fb-actions">
          <button type="button" data-fb-reply="${e.id}">Send reply</button>
          <button type="button" class="fb-del" data-fb-del="${e.id}" title="Delete this feedback and its whole dialogue">Withdraw</button>
        </div>
      </div>
    </div>`;
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
