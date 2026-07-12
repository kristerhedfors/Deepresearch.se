// @ts-check
// The admin-BOARDS discovery index — one declarative entry per admin list
// that exposes a Claude-fetch pathway (a `?format=text` view + a scripts/*
// wrapper, behind the admin gate). This module is the single place an agent
// can hit to learn WHERE every board lives, HOW to fetch its agent-ready
// prioritized text, and WHAT its ordering options mean — so "pop up all the
// boards and act on the user-selected order" is one call away.
//
// It is a PURE static registry: no secrets, no user data, no D1 — just the
// map of already-documented endpoints. That makes it safe in public source
// and lets the index answer even when D1 is absent.
//
// Adding a board: append an entry below (and give it a scripts/* wrapper +
// a `?format=text` view on its own endpoint) — nothing else here changes.
//
// Endpoint (admin-gated in index.js, dispatched from admin-api.js):
//   GET /api/admin/boards         the index (?format=text for the readable
//                                 "here is every board and how to fetch it"
//                                 view; JSON { boards: [...] } by default)

import { jsonResponse } from "./http.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * One discoverable admin board.
 * @typedef {Object} AdminBoard
 * @property {string} id            stable short id (matches the scripts/* name)
 * @property {string} title         human title for the index
 * @property {string} purpose       one line: what it is and which loop it feeds
 * @property {boolean} feeds_loop   true if a Claude Code loop consumes its order
 * @property {string} api           the base API path (admin-gated)
 * @property {string} text_query    query string yielding the agent-ready text view
 * @property {string[]} orderings   the user-selectable sort/filter options
 * @property {string} order_help    how to select an ordering + what they mean
 * @property {string} script        the scripts/* wrapper (the one-command view)
 * @property {string} skill         the skill that documents the loop
 */

/**
 * The registry — one entry per Claude-fetchable admin list.
 * @type {AdminBoard[]}
 */
export const ADMIN_BOARDS = [
  {
    id: "security",
    title: "Security fix board",
    purpose:
      "SECURITY-RISKS.md §3's open-fix backlog with the admin's votes/scores/notes and the explicit priority — the security-fix loop's fixed, work-top-down order.",
    feeds_loop: true,
    api: "/api/admin/security",
    text_query: "format=text&order=priority",
    orderings: ["priority", "severity"],
    order_help:
      "order=priority (default) is the admin-decided FIX order the loop works top-down; order=severity is the documented-severity view (votes/priority ignored). The text view always renders the fix order. Add open=1 to hide closed/accepted items.",
    script: "scripts/security",
    skill: "security-posture",
  },
  {
    id: "features",
    title: "Feature build board",
    purpose:
      "FEATURES.md §3's feature backlog with the admin's votes/effort/notes and the explicit priority — the feature-build loop's fixed, build-top-down order. The second loop channel next to security.",
    feeds_loop: true,
    api: "/api/admin/features",
    text_query: "format=text&order=priority",
    orderings: ["priority", "impact"],
    order_help:
      "order=priority (default) is the admin-decided BUILD order the loop works top-down; order=impact is the documented-impact view (votes/priority ignored). The text view always renders the build order. Add open=1 to hide shipped/dropped items.",
    script: "scripts/features",
    skill: "feature-board",
  },
  {
    id: "feedback",
    title: "Feedback queue",
    purpose:
      "Per-reply user feedback as dialogue threads with the dev agent — the work queue the feedback loop gathers, decides on, acts on, and replies into.",
    feeds_loop: true,
    api: "/api/admin/feedback",
    text_query: "format=text&open=1",
    orderings: ["open", "all"],
    order_help:
      "open=1 (default) is the actionable queue (unresolved entries); drop it for all entries regardless of status. Fetch one thread with /api/admin/feedback/:id?format=text.",
    script: "scripts/feedback",
    skill: "feedback-loop",
  },
  {
    id: "chatlogs",
    title: "Chat interaction log",
    purpose:
      "The full-visibility log of completed exchanges — question, answer, research metadata, errors — newest first; the debugging window into what users (and agents) actually asked.",
    feeds_loop: true,
    api: "/api/admin/chatlogs",
    text_query: "format=text&limit=10",
    orderings: ["recent", "errors"],
    order_help:
      "Always newest-first; limit=N sizes the window. errors=1 narrows to failed/disconnected exchanges; q=<term> substring-matches question OR answer. Fetch one exchange with /api/admin/chatlogs/:id.",
    script: "scripts/chatlogs",
    skill: "chat-logs",
  },
];

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/admin-boards.test.js
// ---------------------------------------------------------------------------

/**
 * Plain-text rendering of the index (?format=text) — the "pop up every board"
 * entry point. Self-contained: an agent reading only this output knows how to
 * fetch each board's prioritized list (the exact script + curl line) and what
 * each ordering means. `origin` seeds the concrete curl URL (the live host).
 * @param {AdminBoard[]} boards
 * @param {string} origin e.g. "https://deepresearch.se"
 * @returns {string}
 */
export function formatBoardsText(boards, origin) {
  const lines = [
    "ADMIN BOARDS — Claude Code discovery index",
    "Every admin list that feeds an agent loop, and how to fetch its",
    "agent-ready text view. Run either line under a board to pop it up",
    "(the script needs BASIC_AUTH_USER / BASIC_AUTH_PASS; curl uses the",
    "same break-glass credentials).",
    "",
  ];
  boards.forEach((b, n) => {
    lines.push(`${n + 1}. ${b.id} — ${b.title}`);
    lines.push(`   ${b.purpose}`);
    lines.push(
      `   ${b.feeds_loop ? "Feeds a Claude Code loop" : "Reference list"} — see the ${b.skill} skill.`,
    );
    lines.push(`   Orderings: ${b.orderings.join(", ")}`);
    lines.push(`   ${b.order_help}`);
    lines.push(`   Fetch:  ${b.script}`);
    lines.push(
      `           curl -sS -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" "${origin}${b.api}?${b.text_query}"`,
    );
    lines.push("");
  });
  lines.push(
    "This index itself: scripts/boards  (or GET " + origin + "/api/admin/boards?format=text)",
  );
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The admin endpoint — GET /api/admin/boards (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * Serves the discovery index. JSON `{ boards: [...] }` by default; a readable
 * text index with ?format=text. Static — needs no D1, so it answers even when
 * the database is unconfigured.
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminBoards(request, env, url, log) {
  if (url.searchParams.get("format") === "text") {
    const text = formatBoardsText(ADMIN_BOARDS, url.origin);
    return new Response(text, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return jsonResponse({ boards: ADMIN_BOARDS });
}
