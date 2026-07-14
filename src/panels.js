// @ts-check
// The panel-SELECTION board (D1 `panels_reviews`) — a THIRD decision-board
// consumer of src/board.js, but a different KIND of loop from security/features.
//
// Where the security and feature boards order a BACKLOG of work items, this
// board's items ARE the admin panels themselves (Notifications, Usage, Users,
// the Security/Features boards, Configuration). It has **no visual board
// widget of its own**: each panel header on /admin carries ▲/▼ thumbs, and
// voting reshapes the admin view IN PLACE — the most-upvoted panel (what the
// owner is working on) floats to the top, a net-negative panel is pushed down
// and collapsed. The board "populates and reshapes purely on thumbs up or
// down on the presented admin tables".
//
// So the ordering here is derived PURELY from votes — there is no explicit
// drag/priority UI (the security/features boards have that; this one
// deliberately does not). Reusing src/board.js's "priority" ordering with no
// priorities set gives exactly votes-desc, so the catalog stays a thin façade.
//
// The loop it feeds is the ATTENTION loop (the "focus" order below): a Claude
// Code session reads /api/admin/panels?format=text to learn which admin
// surface the owner is actively working on, and works that surface next —
// following the admin's up/down votes rather than a fixed backlog. This new
// loop type is documented in the **feature-board** skill (§ the attention
// board) and docs/DECISION-BOARD-LOOPS.md.
//
// Endpoints (admin-gated in index.js, dispatched from admin-api.js):
//   GET   /api/admin/panels           board (?order=focus|default, ?format=text)
//   POST  /api/admin/panels/:id/vote  {dir:"up"|"down"}
//   PATCH /api/admin/panels/:id       {note?} (null clears; score/priority
//                                     accepted by the shared core but unused)

import {
  BOARD_CAPS,
  getBoardReview,
  loadBoardReviews,
  orderBoardItems,
  patchBoardRow,
  reviewState,
  validateBoardPatch,
  validateBoardVote,
  voteBoardRow,
} from "./board.js";
import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/**
 * One catalog entry — an admin panel the selection board can pull up or push
 * down. `id` doubles as the DOM `data-panel` attribute the client matches on.
 * @typedef {{ id: string, title: string, summary: string }} PanelItem
 */
/**
 * A D1 `panels_reviews` row (admin choice state) — the shared board shape.
 * @typedef {import('./board.js').BoardReviewRow} ReviewRow
 */

// ---------------------------------------------------------------------------
// The catalog — one entry per admin panel. Array order = the DEFAULT (unvoted)
// admin-view order; it's also the tiebreak when votes are equal, so a silent
// board renders exactly as the page was authored. Adding a panel: append here
// AND give its <section> a matching data-panel attribute in admin/index.html.
// ---------------------------------------------------------------------------

/** @type {PanelItem[]} */
export const PANEL_ITEMS = [
  {
    id: "alerts",
    title: "Notifications",
    summary:
      "Sign-ins awaiting approval and operational alerts (Berget errors, wallet balance, dropped streams). The act-on-it queue.",
  },
  {
    id: "usage",
    title: "Usage (all users)",
    summary:
      "Aggregate spend cards across the four windows — the money view. Usually kept one layer down (collapsed) unless the owner is watching cost.",
  },
  {
    id: "models",
    title: "Usage by model",
    summary:
      "Per-model token counts and real per-token cost — the ground truth behind the budgets. Collapsed by default.",
  },
  {
    id: "users",
    title: "Users",
    summary:
      "Accounts (provisioned by Google sign-in) with role, status and per-user quota overrides — approve, disable, delete, re-quota.",
  },
  {
    id: "security",
    title: "Security risks board",
    summary:
      "SECURITY-RISKS.md §3's open-fix backlog with votes/score/note/priority — the security-fix loop's work order.",
  },
  {
    id: "features",
    title: "Features board",
    summary:
      "FEATURES.md §3's feature backlog with votes/effort/note/priority — the feature-build loop's work order.",
  },
  {
    id: "websearch_grants",
    title: "Web search grants",
    summary:
      "Mint shareable Se/cure links that carry a fixed live-web-search quota (metered server-side on the Exa key); list and revoke live grants. Defaults/budget live in Configuration.",
  },
  {
    id: "proxy_bundles",
    title: "Secure research space grants",
    summary:
      "Mint shareable Se/cure links that lend a bundle of account-connected proxy grants (web search + LLM API on Berget, metered server-side); list and revoke live bundles. Defaults/budget live in Configuration.",
  },
  {
    id: "config",
    title: "Configuration",
    summary:
      "Default quotas, research knobs (Exa cost, time budget, default model), account-approval toggle, and the intro-animation speed.",
  },
];

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/panels.test.js
// ---------------------------------------------------------------------------

// The choice-state mechanics (caps, patch/vote validation, D1 review rows,
// ordering) are the shared decision-board core (src/board.js). This module
// re-exports its pure surface façade-style (the security/features precedent)
// and keeps only what is panel-shaped.
export const REVIEW_CAPS = BOARD_CAPS;
export const validateReviewPatch = validateBoardPatch;
export const validateVote = validateBoardVote;

// "focus"   — the ATTENTION order the loop reads: purely votes-desc (this
//             board sets no explicit priorities), ties fall back to catalog
//             order. Net-negative panels sink to the bottom.
// "default" — the authored catalog order, votes ignored — the "reset" view.
export const ORDER_MODES = ["focus", "default"];

/** @param {string} id */
export function findPanelItem(id) {
  return PANEL_ITEMS.find((i) => i.id === id) || null;
}

// Catalog entry + its D1 review row → one board item. Every panel is always
// "open" (there is no closed/shipped notion for a live admin surface), so the
// core's open/closed split is a no-op and the ordering is pure votes.
/**
 * @param {PanelItem} item
 * @param {ReviewRow | undefined} review
 * @param {number} registerOrder position in the catalog (the default order)
 */
export function projectPanelItem(item, review, registerOrder) {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    status: "open",
    register_order: registerOrder,
    ...reviewState(review),
  };
}

// The FOCUS order (mode "focus") — the attention loop's order and the admin
// view's live layout: highest net votes first, catalog order as tiebreak. No
// explicit priorities exist on this board, so orderBoardItems' "priority" mode
// collapses to exactly votes-desc. Mode "default" is the authored order.
/**
 * @param {ReturnType<typeof projectPanelItem>[]} items
 * @param {string} mode "focus" | "default"
 * @returns {ReturnType<typeof projectPanelItem>[]} a new sorted array
 */
export function orderPanelItems(items, mode) {
  return orderBoardItems(
    items,
    mode === "default" ? "rank" : "priority",
    (i) => i.register_order,
  );
}

// Plain-text rendering (?format=text) — the attention loop's input. Always the
// FOCUS order; every panel numbered top-down (the owner's current attention
// ranking), net-negative ones flagged as muted.
/**
 * @param {ReturnType<typeof projectPanelItem>[]} ordered orderPanelItems(..., "focus") output
 * @returns {string}
 */
export function formatPanelsText(ordered) {
  const lines = [
    "ADMIN FOCUS ORDER (panel selection board — the ATTENTION loop, not a backlog)",
    "",
    "The owner's ▲/▼ votes on the /admin panels; the admin view reshapes purely",
    "on those thumbs. The TOP panel is the surface the owner is working on now;",
    "net-negative panels are pushed down and collapsed. Follow this to decide",
    "which admin surface to work next — then read THAT surface's own board",
    "(e.g. scripts/security, scripts/features) for the work order within it.",
    "",
  ];
  ordered.forEach((p, n) => {
    lines.push(
      `${n + 1}. ${p.id} votes=${p.votes}${p.votes < 0 ? " (muted)" : ""} — ${p.title}`,
    );
    lines.push(`   ${p.summary}`);
    if (p.note) lines.push(`   ADMIN NOTE: ${p.note}`);
    lines.push("");
  });
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The admin endpoint — /api/admin/panels* (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminPanels(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/panels/, "");
  const method = request.method;

  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const mode = ORDER_MODES.includes(p.get("order") || "") ? /** @type {string} */ (p.get("order")) : "focus";
    const reviews = await loadBoardReviews(db, "panels_reviews");
    const items = PANEL_ITEMS.map((it, idx) => projectPanelItem(it, reviews.get(it.id), idx));
    const ordered = orderPanelItems(items, mode);
    if (p.get("format") === "text") {
      // Text is the attention loop's input — always the focus order.
      const text = formatPanelsText(mode === "focus" ? ordered : orderPanelItems(items, "focus"));
      return new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return jsonResponse({ items: ordered, order: mode, count: ordered.length });
  }

  const m = path.match(/^\/([a-z_]+)(\/vote)?$/);
  const item = m ? findPanelItem(m[1]) : null;
  if (!m || !item) return jsonResponse({ error: "No such panel." }, 404);

  // Upsert-friendly: the review row is created on first vote/patch.
  if (m[2] && method === "POST") {
    const v = validateBoardVote(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await voteBoardRow(db, "panels_reviews", item.id, v.delta);
    log.info("panels.vote", { item_id: item.id, delta: v.delta });
    return projectedItem(db, item);
  }

  if (!m[2] && method === "PATCH") {
    const v = validateBoardPatch(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await patchBoardRow(db, "panels_reviews", item.id, v.patch);
    log.info("panels.review", { item_id: item.id, fields: Object.keys(v.patch).join(",") });
    return projectedItem(db, item);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

/**
 * @param {D1Database} db
 * @param {PanelItem} item
 */
async function projectedItem(db, item) {
  const row = await getBoardReview(db, "panels_reviews", item.id);
  const idx = PANEL_ITEMS.findIndex((i) => i.id === item.id);
  return jsonResponse({ item: projectPanelItem(item, row || undefined, idx) });
}
