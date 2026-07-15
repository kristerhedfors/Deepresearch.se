// Account & usage panel: /api/me rendered as quota bars (opaque budget
// percentage + search counts per window), documentation/admin links, and
// sign-out. Opened from the header's account button.
//
// This file is the panel SHELL: initAccountPanel (the boot wiring), the
// shared PanelCtx, and the showView dispatcher. The views' renderers
// live in their own modules:
// - "summary" (default), "full", "games", and "docs" (the documentation
//   links gathered under one heading) — plus the shared building
//   blocks (settingRow, the info popovers, the notification badge, the
//   summary's Feedback-mode knob): account-views.js.
// - "messages" (the message center): account-messages.js.
// - "settings" (the cloud-storage / Shodan / Google Maps knobs):
//   account-settings.js.
// - "feedback" (the user's feedback dialogue threads): account-feedback.js.
//
// Each view is a top-level load*/render* function taking the shared panel
// context (created once by initAccountPanel) so the sections stay
// independently readable; the context carries the DOM refs plus the cached
// /api/me payload the badge and views render from.

import { loadFeedbackView } from "./account-feedback.js";
import { loadMessagesView } from "./account-messages.js";
import { loadSettingsView } from "./account-settings.js";
import { loadGamesView, renderDocs, renderFullUsage, renderNotifBadge, renderSummary } from "./account-views.js";

/**
 * The panel context shared by every view function in the account-* view
 * modules — created once in initAccountPanel and threaded through
 * explicitly.
 * @typedef {object} PanelCtx
 * @property {HTMLElement} overlay  #account — the full-screen overlay
 * @property {HTMLElement} body     #account-body — every view renders here
 * @property {HTMLElement} badge    #notif-badge — the header's counter
 * @property {?object} me           cached /api/me payload (null until fetched)
 * @property {(view: string) => void} show  switches the visible view
 */

// ---- panel bootstrap ---------------------------------------------------------

/**
 * Wires the account panel once at boot: the eager /api/me fetch that feeds
 * the header's notification badge, and the open/close handlers on the
 * header button and overlay.
 * @returns {{ open: (view: string) => Promise<void> }} an API to open the
 *   panel to a named view (used by the test-queue deep-link executor).
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

  // Two doors into the same panel: the account button opens the summary,
  // the header's gear opens the Settings view directly (all configuration
  // lives there — 2026-07-11 directive).
  const openPanel = async (view) => {
    ctx.overlay.hidden = false;
    ctx.body.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error("HTTP " + res.status);
      ctx.me = await res.json();
      renderNotifBadge(ctx);
      await ctx.show(view);
    } catch {
      ctx.body.innerHTML = '<p class="muted">Could not load account info.</p>';
    }
  };
  document.getElementById("accountbtn").addEventListener("click", () => openPanel("summary"));
  document.getElementById("gearbtn")?.addEventListener("click", () => openPanel("settings"));
  // The header's workspace-share icon (right of the ghost, 2026-07-15 owner
  // directive): a first-class door to "Share a Se/cure workspace" — opens the
  // Settings view and lands on the share section, whose widget (create link,
  // copy link/password) lives there (account-settings.js).
  document.getElementById("sharebtn")?.addEventListener("click", async () => {
    await openPanel("settings");
    const create = document.getElementById("wspcreate");
    create?.scrollIntoView({ block: "center" });
    create?.focus();
  });
  document.getElementById("accountclose").addEventListener("click", () => {
    ctx.overlay.hidden = true;
  });
  ctx.overlay.addEventListener("click", (e) => {
    if (e.target === ctx.overlay) ctx.overlay.hidden = true;
  });

  return { open: openPanel };
}

/**
 * View dispatcher: renders the named view into the panel body and wires
 * its controls. The summary/full views render synchronously from the
 * cached /api/me; the rest fetch their own data.
 * @param {PanelCtx} ctx
 * @param {"summary"|"full"|"messages"|"settings"|"feedback"|"games"|"docs"} view
 */
function showView(ctx, view) {
  if (view === "messages") {
    loadMessagesView(ctx);
    return;
  }
  if (view === "settings") {
    // Returned so a caller can act once the (async) view is in the DOM —
    // the header's share icon scrolls to the workspace section on it.
    return loadSettingsView(ctx);
  }
  if (view === "feedback") {
    loadFeedbackView(ctx);
    return;
  }
  if (view === "games") {
    loadGamesView(ctx);
    return;
  }
  if (view === "docs") {
    ctx.body.innerHTML = renderDocs();
    document.getElementById("docsbackbtn").addEventListener("click", () => ctx.show("summary"));
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
    document.getElementById("gamesbtn")?.addEventListener("click", () => ctx.show("games"));
    document.getElementById("docsbtn")?.addEventListener("click", () => ctx.show("docs"));
    document.getElementById("logoutbtn").addEventListener("click", async () => {
      await fetch("/logout", { method: "POST" });
      location.href = "/login";
    });
  }
}
