// @ts-check
// The security-risk review board (D1 `security_reviews`) — the admin-panel
// surface over SECURITY-RISKS.md's §3 open-fix backlog.
//
// The ITEMS catalog below is a code MIRROR of the register's §3 (one entry
// per P-item, same ids, same default order). The register stays the source
// of truth for full descriptions/history; this catalog is what the admin
// panel renders and what the fix loop orders by. KEEP THEM IN SYNC: any §3
// edit (new item, status change) lands here in the same commit — the
// security-posture skill's checklist enforces it.
//
// What the admin adds on top (stored in D1, keyed by item id):
//   - votes    up/down signal (net count) on how much an item matters
//   - score    a free-form manual severity note, e.g. a CVSS vector/number
//   - note     a short remark/suggestion
//   - priority an explicit rank — THE FIXED ORDER. Items with a priority set
//              come first (ascending) in the fix ordering; everything else
//              follows by votes, then documented severity, then register
//              order. The Claude Code security-fix loop reads this ordering
//              (?format=text / scripts/security) and works top-down.
//
// Endpoints (admin-gated in index.js, dispatched from admin-api.js):
//   GET   /api/admin/security          board (?order=priority|severity,
//                                      ?open=1, ?format=text)
//   POST  /api/admin/security/:id/vote {dir:"up"|"down"}
//   PATCH /api/admin/security/:id      {score?, note?, priority?} (null clears)

import {
  BOARD_CAPS,
  loadBoardReviews,
  orderBoardItems,
  patchBoardRow,
  projectedBoardItem,
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
 * One catalog entry (code-maintained; mirrors SECURITY-RISKS.md §3).
 * @typedef {{ id: string, title: string, severity: "high" | "medium" | "low", status: "open" | "fixed" | "accepted", recurring?: boolean, summary: string }} RiskItem
 */
/**
 * A D1 `security_reviews` row (admin-maintained state for one item) —
 * the shared board-review shape.
 * @typedef {import('./board.js').BoardReviewRow} ReviewRow
 */

// ---------------------------------------------------------------------------
// The catalog — mirrors SECURITY-RISKS.md §3 (array order = register order)
// ---------------------------------------------------------------------------

/** @type {RiskItem[]} */
export const SECURITY_RISK_ITEMS = [
  {
    id: "P-1",
    title: "Provider-side caps on every API key",
    severity: "high",
    status: "open",
    recurring: true,
    summary:
      "A leaked or abused key is unbounded spend unless the PROVIDER enforces a ceiling — in-app quota code cannot cap a key used from outside the app. Set/verify hard caps in each console (Berget, OpenAI, Anthropic, Exa, Google Cloud incl. the referrer-lock on the Embed key, Shodan) and record values + date in the register's history log. Re-verify quarterly.",
  },
  {
    id: "P-2",
    title: "Mechanical secret-leak prevention on the repo",
    severity: "high",
    status: "fixed",
    summary:
      "FIXED (2026-07-15): scripts/scan-secrets now gates BOTH commit (.githooks/pre-commit over the staged diff — a secret never enters history) and push (.githooks/pre-push over outgoing commits), and the hooks auto-activate in every remote session (SessionStart runs scripts/install-git-hooks). Full-history scan from an unshallowed clone (791 commits, git log --all -p over the §1 pattern set): CLEAN. GitHub secret scanning + push protection: default-on for public repos (server-side backstop; owner to eyeball Settings once). See docs/SECRET-SCANNING.md. Was: pre-push only, hooks inert in fresh clones, full-history verdict owed.",
  },
  {
    id: "P-3",
    title: "Quota race + no rate limiting on expensive endpoints (M-1/M-2)",
    severity: "medium",
    status: "open",
    summary:
      "PARTIAL (2026-07-12): a per-user CONCURRENCY cap now bounds the check-then-act race — a D1-backed inflight reservation (CAP=5, TTL=300s, fail-soft) taken at admission and released in a finally on /api/chat, /api/embed, /api/quiz/grade, /api/bash/step; caps the ≈N× overspend at ≈CAP× (closes the spend-abuse class with the P-1 provider caps). RESIDUAL: not a true spend reservation, and the simultaneous-isolate + disconnect-release paths need a live-verify pass; keep open until verified.",
  },
  {
    id: "P-4",
    title: "Flip the CSP on (H-2 follow-up)",
    severity: "high",
    status: "open",
    summary:
      "The CSP is fully authored in src/security-headers.js but CSP_ENABLED = false. Until flipped, one DOMPurify bypass is full session-context XSS reaching IndexedDB (history key, project chats) on DRS and the sealed-state surface on DRC. Re-verify inline-script hashes + Maps/sandbox origins, flip, watch a live console.",
  },
  {
    id: "P-5",
    title: "Plaintext chat_logs: retention, drain, accurate copy (M-3)",
    severity: "medium",
    status: "open",
    summary:
      "Every non-incognito exchange rests as plaintext in D1 — append-only, excluded from DELETE /api/storage, no TTL. The dominant server-side privacy exposure. Add the table to the user drain, add a retention TTL, and/or encrypt columns; make /help/ state the true exposure.",
  },
  {
    id: "P-6",
    title: "Server accepts plaintext for the convos family (M-4)",
    severity: "medium",
    status: "open",
    summary:
      "putEncRecord accepts {data} for both convos and projects, so the ciphertext-at-rest invariant for conversations is client-enforced only. Reject plaintext records for convos server-side; allow plaintext only where project/RAG membership is confirmable.",
  },
  {
    id: "P-7",
    title: "Anti-injection note missing on gap + validate prompts (M-6)",
    severity: "medium",
    status: "open",
    summary:
      "gapPrompt and validatePrompt read the untrusted source digest but lack ANTI_INJECTION_NOTE — and the exact prompt text is public, so injections can be crafted offline against these phases. Blast radius: research integrity only (fail-soft, no secrets in prompts). Cheap fix: append the note to both builders.",
  },
  {
    id: "P-8",
    title: "Two unbounded outbound fetches (M-5)",
    severity: "medium",
    status: "fixed",
    summary:
      "FIXED (2026-07-12): exa.js webSearch and berget.js fetchCatalog now fetch with signal: AbortSignal.timeout (15s each); a TimeoutError lands in each function's existing fail-soft catch, so a hung backend degrades instead of hanging (invariant 2). Was: both hot-path fetches were unbounded.",
  },
  {
    id: "P-9",
    title: "Low-severity backlog (L-1 … L-12)",
    severity: "low",
    status: "open",
    summary:
      "The assessment's Low findings, all re-verified open 2026-07-12: href scheme validation (L-1), RAG post-query uid assertion (L-2), no-store on /api/history-key (L-3), Content-Disposition on stored files (L-4), OAuth state timestamp / id_token verification (L-5/6), Shodan IP re-check, Maps image byte cap, lat/lon encoding, thumbnail escaping, admin-asset gating (L-7..11), aggregate size cap + vendored-lib SHA-256 manifest (L-12 — do the manifest half first).",
  },
  {
    id: "P-10",
    title: "Revert production LOG_LEVEL to info",
    severity: "low",
    status: "open",
    summary:
      "wrangler.toml sets LOG_LEVEL=debug in prod (2026-07-12, time-boxed for sandbox-filesystem testing). Debug paths log more request detail into Workers Logs — a server-side data pool. Revert when that testing round completes.",
  },
  {
    id: "P-11",
    title: "New write surface: manual SDK-build publish (PUT /api/build/:slug)",
    severity: "low",
    status: "open",
    summary:
      "A second admin-gated write path (F-17, 2026-07-18) alongside the pre-existing DELETE on SDK mode's /app/<slug>/ build surface (src/build-pub.js), letting an already-built bundle (execution-sandbox output, a hand-assembled directory) publish without a live model turn. Reuses the UNCHANGED publishBuild (same caps, traversal/extension validation, opaque-origin sandbox CSP serving) and the same admin gate as the existing DELETE — the isolation boundary is untouched. PARTIAL: ownership on a manual publish collapses to the shared break-glass admin identity; owed the same live-verify pass SDK mode's own build-publish flow still owes.",
  },
];

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/security-risks.test.js
// ---------------------------------------------------------------------------

// The choice-state mechanics (caps, patch/vote validation, D1 review rows,
// the ordering semantics) are the shared decision-board core (src/board.js —
// see the **decision-boards** skill); this module re-exports its pure
// surface under the board's historical names, façade-style (the bash-agent
// precedent), and keeps only what is item-shaped: the catalog, projection,
// the fix-order text, and the endpoint.
export const REVIEW_CAPS = BOARD_CAPS;
export const validateReviewPatch = validateBoardPatch;
export const validateVote = validateBoardVote;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
export const ORDER_MODES = ["priority", "severity"];

/** @param {string} id */
export function findRiskItem(id) {
  return SECURITY_RISK_ITEMS.find((i) => i.id === id) || null;
}

// Catalog entry + its D1 review row → one board item. `register_order` is
// the item's position in the catalog (the register's §3 order).
/**
 * @param {RiskItem} item
 * @param {ReviewRow | undefined} review
 * @param {number} registerOrder
 */
export function projectRiskItem(item, review, registerOrder) {
  return {
    id: item.id,
    title: item.title,
    severity: item.severity,
    status: item.status,
    recurring: !!item.recurring,
    summary: item.summary,
    register_order: registerOrder,
    ...reviewState(review),
  };
}

// The FIX ORDER (mode "priority") — the order the Claude Code security-fix
// loop works in: admin-prioritized items first (ascending priority), then
// the rest by votes (desc), documented severity, register order. Non-open
// items always sink to the bottom (they're done or consciously accepted).
// Mode "severity": documented severity, then register order — the
// "what does the assessment say" view, votes/priority ignored.
/**
 * @param {ReturnType<typeof projectRiskItem>[]} items
 * @param {string} mode "priority" | "severity"
 * @returns {ReturnType<typeof projectRiskItem>[]} a new sorted array
 */
export function orderRiskItems(items, mode) {
  return orderBoardItems(
    items,
    mode === "severity" ? "rank" : mode,
    (i) => SEVERITY_RANK[/** @type {"high"|"medium"|"low"} */ (i.severity)] ?? 9,
  );
}

// Plain-text rendering (?format=text) — the fix loop's input. Always the
// FIX ORDER; open items numbered top-down (this numbering IS the round's
// work order), closed items as a short tail for context.
/**
 * @param {ReturnType<typeof projectRiskItem>[]} ordered orderRiskItems(..., "priority") output
 * @returns {string}
 */
export function formatSecurityText(ordered) {
  const open = ordered.filter((i) => i.status === "open");
  const closed = ordered.filter((i) => i.status !== "open");
  const lines = ["SECURITY FIX ORDER (admin-decided; work top-down — see SECURITY-RISKS.md §3)", ""];
  open.forEach((i, n) => {
    lines.push(
      `${n + 1}. ${i.id} [${i.severity}]${i.priority != null ? ` (admin priority ${i.priority})` : ""}` +
        ` votes=${i.votes}${i.score ? ` score=${i.score}` : ""} — ${i.title}`,
    );
    lines.push(`   ${i.summary}`);
    if (i.note) lines.push(`   ADMIN NOTE: ${i.note}`);
    lines.push("");
  });
  if (closed.length) {
    lines.push(
      "Closed/accepted: " + closed.map((i) => `${i.id} [${i.status}]`).join(", "),
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The admin endpoint — /api/admin/security* (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminSecurity(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/security/, "");
  const method = request.method;

  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const mode = ORDER_MODES.includes(p.get("order") || "") ? /** @type {string} */ (p.get("order")) : "priority";
    const reviews = await loadBoardReviews(db, "security_reviews");
    let items = SECURITY_RISK_ITEMS.map((it, idx) => projectRiskItem(it, reviews.get(it.id), idx));
    if (p.get("open") === "1") items = items.filter((i) => i.status === "open");
    const ordered = orderRiskItems(items, mode);
    if (p.get("format") === "text") {
      // Text is the fix loop's input — always the fix (priority) order.
      const text = formatSecurityText(mode === "priority" ? ordered : orderRiskItems(items, "priority"));
      return new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return jsonResponse({ items: ordered, order: mode, count: ordered.length });
  }

  const m = path.match(/^\/(P-\d{1,3})(\/vote)?$/);
  const item = m ? findRiskItem(m[1]) : null;
  if (!m || !item) return jsonResponse({ error: "No such security item." }, 404);

  // Upsert-friendly: the review row is created on first vote/patch.
  if (m[2] && method === "POST") {
    const v = validateBoardVote(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await voteBoardRow(db, "security_reviews", item.id, v.delta);
    log.info("security.vote", { item_id: item.id, delta: v.delta });
    return projectedItem(db, item);
  }

  if (!m[2] && method === "PATCH") {
    const v = validateBoardPatch(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await patchBoardRow(db, "security_reviews", item.id, v.patch);
    log.info("security.review", { item_id: item.id, fields: Object.keys(v.patch).join(",") });
    return projectedItem(db, item);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

/**
 * @param {D1Database} db
 * @param {RiskItem} item
 */
async function projectedItem(db, item) {
  return jsonResponse({ item: await projectedBoardItem(db, "security_reviews", SECURITY_RISK_ITEMS, projectRiskItem, item) });
}
