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
// Feedback-mode / execution-sandbox rows (renderConfigKnobs +
// wireFeedbackKnob / wireSandboxKnob — rendered by account-settings.js).

import { escapeHtml, formatCount as fmtN } from "./notifications.js";
import {
  bashLiteAvailable,
  bashLiteOn,
  developerModeAvailable,
  developerModeOn,
  feedbackAvailable,
  feedbackModeOn,
  setBashLiteMcp,
  setDeveloperMode,
  setFeedbackMode,
} from "./settings.js";
import { applyFeedbackMode } from "./turns.js";
import { applyDeveloperTheme } from "./dev-mode.js";
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

// Feedback mode's knob lives in the Settings view with every other
// configuration knob (2026-07-11 directive: ALL configuration under the
// header's gear icon).
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

// The execution-sandbox knob sits beside it in Settings (short note; the
// full story is in the /help pages). Enabling it reloads the page so the
// app comes back cross-origin isolated and the in-browser Linux VM can boot.
const SANDBOX_INFO = `<strong>Execution sandbox (bash) — Experimental</strong><br>
  Boots a real Linux <b>inside this browser</b> so the assistant can run shell
  commands to answer you (e.g. “run ls”). Everything runs on your device —
  nothing leaves the browser. The first use downloads a Linux image, so it's
  slow to start; enabling it reloads the page.`;

// The developer-mode knob unlocks introspection: ask the assistant about the
// site's own implementation and it answers from the deployed source snapshot
// (and can explore the tree at /src when the sandbox is also enabled).
const DEVELOPER_INFO = `<strong>Introspection</strong><br>
  <b>On:</b> ask about this site's own implementation (“how are you built?”,
  “show me src/pipeline.js”) and the assistant answers from a snapshot of the
  exact source code this deployment runs — and the composer pane turns
  white titanium so you know you're in it. With the execution sandbox also on, the
  whole source tree is mounted at <code>/src</code> inside the in-browser Linux
  VM so the assistant can explore it with real shell commands.<br>
  <b>Off (default):</b> implementation questions are answered like any other
  research question.<br>
  The source is public on GitHub; this knob is about keeping the source
  tooling out of the way, not secrecy.`;

/**
 * The Feedback-mode and execution-sandbox rows the Settings view renders
 * under the server-backed knobs (account-settings.js) — knob state from
 * the cached /api/settings copy, both gated on a signed-in account.
 * Wire with wireFeedbackKnob + wireSandboxKnob after insertion.
 * @param {object} me  cached /api/me payload
 * @returns {string} HTML
 */
export function renderConfigKnobs(me) {
  // Break-glass admin (no email): can't persist per-account settings — the
  // /api/settings PUT needs a D1 user row — but the two BROWSER-ONLY features
  // are ON for it by default (settings.js bashLiteEnabled/developerModeEnabled
  // force them true for isSecretAdmin). Previously this returned "" and the
  // developer/introspection AND sandbox knobs were simply ABSENT from the
  // admin's Settings panel — reported as "the introspection knob doesn't
  // move": there was no knob to move. Show them as read-only ON instead, so
  // the admin sees the state honestly. Feedback needs a user row (it stores
  // per-user threads), so it stays out of the admin view.
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
      settingRow({
        id: "devknob",
        label: "Introspection",
        checked: true,
        disabled: true,
        popId: "devpop",
        info: DEVELOPER_INFO,
      }) +
      `<p class="muted setting-note">Admin session: the execution sandbox and introspection mode are on by default. Sign in with a Google account to switch these per account.</p>`
    );
  }
  return (
    settingRow({
      id: "fbknob",
      label: "Feedback mode",
      checked: feedbackAvailable() && feedbackModeOn(),
      disabled: !feedbackAvailable(),
      popId: "fbpop",
      info: FEEDBACK_INFO,
    }) +
    '<p id="fbstatus" class="muted setting-note" hidden></p>' +
    settingRow({
      id: "sbknob",
      label: `Execution sandbox <span class="exp-badge">Experimental</span>`,
      checked: bashLiteAvailable() && bashLiteOn(),
      disabled: !bashLiteAvailable(),
      popId: "sbpop",
      info: SANDBOX_INFO,
    }) +
    '<p id="sbstatus" class="muted setting-note" hidden></p>' +
    settingRow({
      id: "devknob",
      label: "Introspection",
      checked: developerModeAvailable() && developerModeOn(),
      disabled: !developerModeAvailable(),
      popId: "devpop",
      info: DEVELOPER_INFO,
    }) +
    '<p id="devstatus" class="muted setting-note" hidden></p>'
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

// The Feedback-mode knob (Settings view): persists via /api/settings
// (feedback_mode) and flips the body's `feedback-mode` class so every
// on-screen reply — existing ones included — shows/hides its Feedback
// button immediately (turns.js). Popovers are wired by the view
// (wireSettingPopovers once over the whole body), not here.
export function wireFeedbackKnob(ctx) {
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

// The developer-mode knob (Settings view): persists via /api/settings
// (developer_mode). Nothing about page serving changes (unlike the sandbox
// knob) — introspection engages per conversation from the next send.
/** @param {PanelCtx} ctx */
export function wireDeveloperKnob(ctx) {
  const knob = /** @type {HTMLInputElement | null} */ (document.getElementById("devknob"));
  if (!knob || knob.disabled) return;
  const status = document.getElementById("devstatus");
  knob.addEventListener("change", async () => {
    const on = knob.checked;
    knob.disabled = true;
    status.hidden = false;
    try {
      await setDeveloperMode(on);
      // Flip the white-titanium composer tint the instant the knob commits (and
      // cache it for the next load — dev-mode.js). Only after the server accepts
      // the write, so a rejected save leaves the pane untouched.
      applyDeveloperTheme(on);
      status.textContent = on
        ? "Introspection is on — the composer pane turns white titanium, and asking about this site's own source code answers from the deployed source."
        : "Introspection is off.";
    } catch (err) {
      knob.checked = !on;
      status.textContent = err?.message || "Could not update the setting.";
    } finally {
      knob.disabled = false;
    }
  });
}

// ---- summary & usage rendering (pure HTML builders) ---------------------------

/**
 * The summary view's HTML: identity line, the 5-hour usage block, the
 * Feedback-mode knob (signed-in accounts), and the navigation buttons.
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
