// The account panel's core views + shared building blocks (the panel SHELL —
// initAccountPanel, PanelCtx, showView — lives in account.js):
// - "summary" (default): the rolling 5-hour window (the one that actually
//   governs whether you can send another message right now) plus navigation.
// - "full": drills into the calendar windows (today / this week / this
//   month) — reuses the cached /api/me response, no extra fetch.
// - "games": the games shelf (GET /api/games).
// Plus the pieces every view shares: the settings switch row (settingRow),
// its press-and-hold info popovers (wireSettingPopovers), the header's
// notification badge (renderNotifBadge), and the Settings view's
// execution-sandbox row + Chat mode dropdown (renderConfigKnobs +
// wireSandboxKnob / wireModeKnob — rendered by account-settings.js).

import { escapeHtml, formatCount as fmtN } from "./notifications.js";
import {
  bashLiteAvailable,
  bashLiteOn,
  developerModeAvailable,
  developerModeOn,
  setBashLiteMcp,
  setDeveloperMode,
} from "./settings.js";
import { storeDeveloperMode } from "./dev-mode.js";
import { applyChatModeTheme, cachedChatMode } from "./chat-mode.js";
import { isolateForSandbox, storeSandboxMode } from "./sandbox-mode.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

// One settings switch row — the shared building block of the Settings
// sub-view's knobs. A single line — one label,
// one info glyph, one switch — with the full explanation tucked into a
// press-and-hold popover (the same gesture the composer's web-search knob
// uses; see wireSettingPopovers). The switch itself is the original
// slide-toggle design the composer's web-search knob used before it became
// the spiderweb (generic .switch classes, not tied to the composer). A row
// is shown disabled (forced off) when the account can't use it —
// break-glass identity, or a server missing the feature's backing — rather
// than hidden, so the state stays explainable.
export function settingRow({ id, label, checked, disabled, popId, info }) {
  // The label may carry markup (the sandbox row's Experimental badge), which
  // is fine inside the visible span but must NOT be interpolated into the
  // aria-label ATTRIBUTE — its quotes break out of the attribute and leak
  // markup fragments as visible text. The accessible name gets a
  // tags-stripped, escaped copy.
  const plainLabel = escapeHtml(String(label).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  return `
    <div class="settings-item">
      <div class="settings-row">
        <span class="settings-label">${label}
          <button type="button" class="setting-info" data-pop="${popId}" aria-label="More about “${plainLabel}”">ⓘ</button>
        </span>
        <label class="switch">
          <input type="checkbox" id="${id}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="setting-pop" id="${popId}" hidden>${info}</div>
    </div>`;
}

// A settings row whose control is a DROPDOWN rather than a switch — the Chat
// mode picker. Same layout/label/info-popover chrome as settingRow, so the two
// row types line up in the panel. `options` is [{value,label}]; `value` is the
// selected one. Disabled rows render greyed and un-interactive (break-glass or
// a missing capability), matching settingRow's disabled treatment.
export function settingSelectRow({ id, label, options, value, disabled, popId, info }) {
  const plainLabel = escapeHtml(String(label).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
  const opts = options
    .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === value ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");
  return `
    <div class="settings-item">
      <div class="settings-row">
        <span class="settings-label">${label}
          <button type="button" class="setting-info" data-pop="${popId}" aria-label="More about “${plainLabel}”">ⓘ</button>
        </span>
        <select class="settings-select" id="${id}" aria-label="${plainLabel}"${disabled ? " disabled" : ""}>${opts}</select>
      </div>
      <div class="setting-pop" id="${popId}" hidden>${info}</div>
    </div>`;
}

// The Chat mode picker's dropdown options (account-views + the composer #modesel
// share the underlying chat-mode.js state). Kept in sync with CHAT_MODES.
const CHAT_MODE_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "introspection", label: "Introspection" },
  { value: "sdk", label: "Agent Builder" },
];

// The execution-sandbox knob sits in Settings (short note; the
// full story is in the /help pages). Enabling it reloads the page so the
// app comes back cross-origin isolated and the in-browser Linux VM can boot.
const SANDBOX_INFO = `<strong>Execution sandbox (bash) — Experimental</strong><br>
  Boots a real Linux <b>inside this browser</b> so the assistant can run shell
  commands to answer you (e.g. “run ls”). Everything runs on your device —
  nothing leaves the browser. The first use downloads a Linux image, so it's
  slow to start; enabling it reloads the page.`;

// The Chat mode picker (the dropdown that replaced the Introspection on/off
// switch): one of three modes. The non-Normal modes all need the developer_mode
// capability, so picking one turns that on (and Normal turns it off) — see
// wireModeKnob. The composer's own mode dropdown (#modesel) shares this state.
const MODE_INFO = `<strong>Chat mode</strong><br>
  Pick how the assistant works. The composer's mode dropdown mirrors this.<br>
  <b>Normal (default):</b> ordinary web research.<br>
  <b>Introspection:</b> ask about this site's own implementation (“how are you
  built?”, “show me src/pipeline.js”) and it answers from a snapshot of the exact
  source this deployment runs — the composer pane turns white titanium. With the
  execution sandbox also on, the whole source tree mounts at <code>/src</code> in
  the in-browser Linux VM.<br>
  <b>Agent Builder:</b> the green “lovable” builder — describe an agent to distil
  from this site (above all the client-side Se/cure tier) with DistillSDK and get
  a live, self-contained web app at its own link.<br>
  The non-Normal modes turn on introspection access for this account.`;

/**
 * The execution-sandbox row + the Chat mode dropdown the Settings view renders
 * under the server-backed knobs (account-settings.js) — state from the cached
 * /api/settings copy, both gated on a signed-in account. The mode dropdown
 * REPLACED the old Introspection on/off switch (owner directive: the modes —
 * Normal / Introspection / SDK — should be CHOSEN from a dropdown here,
 * not just introspection on/off). Wire with wireSandboxKnob + wireModeKnob.
 * @param {object} me  cached /api/me payload
 * @returns {string} HTML
 */
export function renderConfigKnobs(me) {
  // Break-glass admin (no email): can't persist per-account settings — the
  // /api/settings PUT needs a D1 user row — but the two BROWSER-ONLY features
  // are ON for it by default (settings.js bashLiteEnabled/developerModeEnabled
  // force them true for isSecretAdmin). Show the sandbox as read-only ON and
  // the mode dropdown as ACTIVE (the mode is a browser-local choice; the
  // capability is implicit for the admin, so all four modes work) — the pick
  // persists locally and drives the theme, it just isn't saved server-side.
  if (!me?.email) {
    return (
      settingRow({
        id: "sbknob",
        label: `Execution sandbox <span class="exp-badge">Experimental</span>`,
        checked: true,
        disabled: true,
        popId: "sbpop",
        info: SANDBOX_INFO,
      }) +
      settingSelectRow({
        id: "modesetting",
        label: "Chat mode",
        options: CHAT_MODE_OPTIONS,
        value: cachedChatMode(),
        disabled: false,
        popId: "modepop",
        info: MODE_INFO,
      }) +
      '<p id="modestatus" class="muted setting-note" hidden></p>' +
      `<p class="muted setting-note">Admin session: the execution sandbox is on by default and the chat mode is a browser-local choice (not saved to an account). Sign in with a Google account to persist these per account.</p>`
    );
  }
  // The displayed mode reflects the authoritative capability: with developer
  // access off, the effective mode is Normal regardless of a stale stored pick
  // (reconcileChatMode does the same downgrade for the composer dropdown).
  const mode = developerModeAvailable() && developerModeOn() ? cachedChatMode() : "normal";
  return (
    settingRow({
      id: "sbknob",
      label: `Execution sandbox <span class="exp-badge">Experimental</span>`,
      checked: bashLiteAvailable() && bashLiteOn(),
      disabled: !bashLiteAvailable(),
      popId: "sbpop",
      info: SANDBOX_INFO,
    }) +
    '<p id="sbstatus" class="muted setting-note" hidden></p>' +
    settingSelectRow({
      id: "modesetting",
      label: "Chat mode",
      options: CHAT_MODE_OPTIONS,
      value: mode,
      disabled: !developerModeAvailable(),
      popId: "modepop",
      info: MODE_INFO,
    }) +
    '<p id="modestatus" class="muted setting-note" hidden></p>'
  );
}

/**
 * Renders the header's notification counter from the cached /api/me
 * payload (hidden at zero).
 * @param {PanelCtx} ctx
 */
export function renderNotifBadge(ctx) {
  const total = ctx.me?.notifications?.total || 0;
  if (total > 0) {
    ctx.badge.textContent = total > 99 ? "99+" : String(total);
    ctx.badge.hidden = false;
  } else {
    ctx.badge.hidden = true;
  }
}

// Press-and-hold (or click the ⓘ) on a settings row opens its detail
// popover — the same gesture the composer's web-search knob uses. Only one
// popover is open at a time; a click anywhere outside closes it.
export function wireSettingPopovers(root) {
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
export async function loadGamesView(ctx) {
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

// The execution-sandbox knob (Settings view): persists via /api/settings
// (bash_lite_mcp). Enabling changes how the PAGE must be served (cross-origin
// isolation for the in-browser Linux VM), which only takes effect on the next
// load — so on enable we save then reload; disabling just saves.
export function wireSandboxKnob(ctx) {
  const knob = document.getElementById("sbknob");
  if (!knob || knob.disabled) return;
  const status = document.getElementById("sbstatus");
  knob.addEventListener("change", async () => {
    const on = knob.checked;
    knob.disabled = true;
    status.hidden = false;
    status.textContent = "Saving…";
    try {
      await setBashLiteMcp(on);
      // Seed the local cache so the NEXT load's synchronous boot self-heal
      // (app.js via sandbox-mode.js) reflects this flip without waiting on
      // /api/settings.
      storeSandboxMode(on);
      if (on) {
        status.textContent = "Sandbox enabled — reloading so it can start…";
        // NOT location.reload() (re-serves the device-cached non-isolated
        // shell on iOS): navigate to a fresh ?_coep= URL so the now-COEP /rver
        // is really fetched and the page comes back isolated. Guarded + deduped
        // in isolateForSandbox; falls back to a plain reload if it can't.
        setTimeout(() => { if (!isolateForSandbox(true, { resetGuard: true })) location.reload(); }, 800);
      } else {
        status.textContent = "Sandbox disabled.";
        knob.disabled = false;
      }
    } catch (err) {
      knob.checked = !on;
      status.textContent = err?.message || "Could not update the setting.";
      knob.disabled = false;
    }
  });
}

// The Chat mode dropdown (Settings view): the modes Normal / Introspection /
// SDK. Replaces the old Introspection on/off switch. The non-Normal modes
// need the developer_mode capability, so this drives that server knob too:
// picking any non-Normal mode turns developer_mode ON, Normal turns it OFF —
// exactly the capability the old switch controlled, now folded into the pick.
// The composer's own dropdown (#modesel) shares the underlying chat-mode.js
// state, so both stay in sync. Fail-soft: a rejected server write (break-glass
// admin) still applies the theme + local mode pick, which is all the admin
// needs since its capability is implicit.
/** @param {PanelCtx} ctx */
export function wireModeKnob(ctx) {
  const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById("modesetting"));
  if (!sel || sel.disabled) return;
  const status = document.getElementById("modestatus");
  const STATUS = {
    normal: "Normal — ordinary web research.",
    introspection: "Introspection — the composer pane turns white titanium, and asking about this site's own source answers from the deployed source.",
    sdk: "SDK — distill this site (above all the Se/cure tier) into a new flavour and get a live, self-contained web app at its own link.",
  };
  sel.addEventListener("change", async () => {
    const mode = sel.value;
    const needsCapability = mode !== "normal";
    // Apply the theme + persist the pick immediately (browser-local; the
    // composer dropdown reads the same cache). Sync the composer control too.
    applyChatModeTheme(mode);
    const modeSel = /** @type {HTMLSelectElement | null} */ (document.getElementById("modesel"));
    if (modeSel) modeSel.value = mode;
    sel.disabled = true;
    if (status) status.hidden = false;
    try {
      // Drive the developer_mode capability to match: on for any non-Normal
      // mode, off for Normal. Only persist the cache after the server accepts.
      await setDeveloperMode(needsCapability);
      storeDeveloperMode(needsCapability);
      if (status) status.textContent = STATUS[mode] || STATUS.normal;
    } catch (err) {
      // Break-glass (no D1 row) refuses the write — but its capability is
      // implicit, so the mode still works; keep the applied pick, just note it.
      if (status) {
        status.textContent = ctx?.me && !ctx.me.email
          ? STATUS[mode] || STATUS.normal
          : /** @type {any} */ (err)?.message || "Could not save the setting (the mode still applies for this session).";
      }
    } finally {
      sel.disabled = false;
    }
  });
}

// ---- summary & usage rendering (pure HTML builders) ---------------------------

/**
 * The summary view's HTML: identity line, the 5-hour usage block, and the
 * navigation buttons (Feedback among them — the account's feedback threads).
 * @param {object} me  cached /api/me payload
 * @returns {string} HTML
 */
export function renderSummary(me) {
  const who = me.email
    ? `${me.name && me.name !== me.email ? me.name + " · " : ""}${me.email}`
    : "Site administrator";
  const msgCount = me.notifications?.total || 0;
  const fbCount = me.notifications?.unread_feedback || 0;
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
      ${me.email ? `<button id="feedbackbtn" type="button">Feedback${fbCount ? ` (${fbCount})` : ""}</button>` : ""}
      <button id="fullusagebtn" type="button">Full usage &amp; history</button>
      <button id="settingsbtn" type="button">Settings</button>
      ${me.email ? '<button id="sharewsbtn" type="button">Share a workspace</button>' : ""}
      <button id="gamesbtn" type="button">Games</button>
      <button id="docsbtn" type="button">Documentation</button>
      ${me.role === "admin" ? '<button id="articlesbtn" type="button">Article collection</button>' : ""}
      ${me.role === "admin" ? '<a href="/admin" target="_blank" rel="noopener">Admin interface</a>' : ""}
      <button id="logoutbtn" type="button">Sign out</button>
    </div>`;
}

// Drill-down: the three windows that don't gate your next message (today /
// this week / this month), for when you actually want the full picture.
export function renderFullUsage(me) {
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

// The "documentation" view — every project-info / help page gathered under one
// heading instead of loose in the summary's button row. Each opens a NEW TAB
// (same-tab navigation would abort an in-flight research request), and each
// carries a one-line description so a first-time reader knows where to go.
// Static list; the pages themselves are served from public/ (see the ui-notes
// skill).
const DOC_LINKS = [
  // This tier's own docs; the page cross-links the Se/cure documentation
  // (/cure/help/) — the docs were split per tier 2026-07-16.
  ["/help/", "Documentation", "How this tier works — features, privacy, and the deep-research pipeline."],
  ["/build/", "About this project", "What DeepResearch is and the ideas behind it."],
  ["/story/", "The build story", "How the site was built, session by session."],
  ["/architecture/", "The architecture story", "How the Worker, pipeline, and privacy split fit together."],
  ["/pulse/", "Project pulse", "Live charts of commits, lines, and new features over the repo's history."],
  ["https://github.com/kristerhedfors/Deepresearch.se", "Source code", "MIT-licensed, on GitHub — every privacy claim is yours to verify."],
];

export function renderDocs() {
  const rows = DOC_LINKS.map(
    ([href, label, desc]) =>
      `<div class="account-actions">
         <a href="${href}" target="_blank" rel="noopener">${label}</a>
       </div>
       <p class="muted">${desc}</p>`,
  ).join("");
  return `
    <button id="docsbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Documentation</p>
    ${rows}`;
}

// "Time remaining" for a reset timestamp, so the label reads "frees up in
// 2h 15m" — the user learns when they're free without subtracting a clock
// time in their head. Mirrors src/quota.js formatResetRelative (that runs
// server-side for the 429; this one runs in the browser off win.reset), sans
// the "in about" prefix the label already supplies. Computed at render time.
function relReset(ts) {
  const ms = ts - Date.now();
  if (ms <= 60_000) return "under a minute";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  if (hours < 24) return m ? `${hours}h ${m}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${days}d ${h}h` : `${days} day${days === 1 ? "" : "s"}`;
}

// Users see: an OPAQUE research-budget bar (cost-backed server-side, but
// only a percentage ever reaches the client — never amounts) and plain
// search counts. Currency is the admin's concern.
function usageBlock(label, win, rolling) {
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
    ? `${rolling ? "frees up in" : "resets in"} ${relReset(win.reset)} · ${new Date(win.reset).toLocaleString()}`
    : "";
  return `<div class="usage-block"><div class="lbl">${label}${reset ? " · " + reset : ""}</div>
    ${budgetBar}
    ${searchBar}
  </div>`;
}
