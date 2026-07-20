// @ts-check
// The features/priority review board (D1 `features_reviews`) — the admin-panel
// surface over FEATURES.md's §3 feature backlog. It is the SECOND channel that
// feeds a Claude Code loop (the first is the security-fix board): where
// security orders FIXES, this orders BUILD work.
//
// The ITEMS catalog below is a code MIRROR of FEATURES.md §3 (one entry per
// F-item, same ids, same default order). The register stays the source of
// truth for full descriptions/history; this catalog is what the admin panel
// renders and what the build loop orders by. KEEP THEM IN SYNC: any §3 edit
// (new item, status change) lands here in the same commit — the feature-board
// skill's checklist enforces it.
//
// What the admin adds on top (stored in D1, keyed by item id):
//   - votes    up/down signal on how much a feature matters
//   - score    a free-form EFFORT estimate (e.g. "S", "~2 days") — the shared
//              board "score" field, repurposed and relabelled for this board
//   - note     a short remark/direction
//   - priority an explicit rank — THE BUILD ORDER. Items with a priority set
//              come first (ascending); everything else follows by votes, then
//              documented impact, then register order. The Claude Code feature
//              loop reads this ordering (?format=text / scripts/features) and
//              builds top-down. Dragging the board headers writes this order.
//
// Endpoints (admin-gated in index.js, dispatched from admin-api.js):
//   GET   /api/admin/features          board (?order=priority|impact,
//                                      ?open=1, ?format=text)
//   POST  /api/admin/features/:id/vote {dir:"up"|"down"}
//   PATCH /api/admin/features/:id      {score?, note?, priority?} (null clears)

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
 * One catalog entry (code-maintained; mirrors FEATURES.md §3).
 * @typedef {{ id: string, title: string, impact: "high" | "medium" | "low", status: "open" | "shipped" | "dropped", summary: string }} FeatureItem
 */
/**
 * A D1 `features_reviews` row (admin-maintained state for one item) —
 * the shared board-review shape.
 * @typedef {import('./board.js').BoardReviewRow} ReviewRow
 */

// ---------------------------------------------------------------------------
// The catalog — mirrors FEATURES.md §3 (array order = register order)
// ---------------------------------------------------------------------------

/** @type {FeatureItem[]} */
export const FEATURE_ITEMS = [
  {
    id: "F-1",
    title: "Graduate the in-browser execution sandbox out of experimental",
    impact: "high",
    status: "open",
    summary:
      "The CheerpX WASM Linux sandbox + bash-lite agent (bash_lite_mcp knob, default OFF) is wired end to end but still owes its live browser verification on real devices (iOS Safari COEP require-corp, the client_diag probe playbook) before it can graduate toward default-on. See the execution-sandbox skill.",
  },
  {
    id: "F-2",
    title: "Finish mounting user files into the sandbox across both tiers",
    impact: "medium",
    status: "open",
    summary:
      "sandbox-files.js + the sandbox.js device mounts land the tiered ingest (/workspace + /mnt/<proj>-<hash>) and the /src introspection mount exists. RESIDUAL: overlay-persistence UX and the DRC-side file provider need a live pass so attachments/project files reliably reach the VM on both DRS and DRC.",
  },
  {
    id: "F-3",
    title: "Expand the research-source registry beyond Exa + Hugging Face",
    impact: "medium",
    status: "open",
    summary:
      "The search-sources.js registry is the parallel-work seam for citable sources. Add one or more new sources (a search provider or platform API) via the add-research-source playbook — intent routing, triage-prompt note, diversity wiring, and the unit → live → bench validation ladder.",
  },
  {
    id: "F-4",
    title: "Grow the games shelf beyond Tokemon",
    impact: "low",
    status: "open",
    summary:
      "The games.js registry/dispatch seam makes a new game a register-one-entry-no-shelf-change addition. Add a second game to prove the seam and give the account panel's Games view more to show. See the tokemon-game skill.",
  },
  {
    id: "F-5",
    title: "Broaden and tune the model catalog",
    impact: "medium",
    status: "open",
    summary:
      "Keep the dropdown current as providers ship models: add/curate via the add-llm-provider seam (providers.js) and run each new model's first eval battery per tune-provider-models (synthesis / JSON / vision / quiz), recording evidence-driven model-profiles.js entries only.",
  },
  {
    id: "F-6",
    title: "Decision-board channels (security + features)",
    impact: "high",
    status: "shipped",
    summary:
      "The panel ⇄ loop mechanism (src/board.js core + per-board catalog/façade): the security-fix board and this features/priority board, both collapsed to draggable headers, both discoverable via scripts/boards. The two admin-decided priority orders that drive the owner's Claude Code loops.",
  },
  {
    id: "F-7",
    title: "Introspection mode — ask the site about its own source",
    impact: "medium",
    status: "shipped",
    summary:
      "The developer_mode knob: a committed dense source-RAG index answers 'how are you built' from the exact deployed source, on both tiers, with an optional /src sandbox mount. See the introspection skill.",
  },
  {
    id: "F-8",
    title: "DRC — the client-side secure tier at /cure",
    impact: "high",
    status: "shipped",
    summary:
      "The whole public no-accounts tier: browser-direct provider calls on the user's own keys, the research pipeline ported client-side, and browser-local sealed storage — the server in no data path. See the storage-privacy skill.",
  },
  {
    id: "F-9",
    title: "The secret-keyed project vault",
    impact: "medium",
    status: "shipped",
    summary:
      "One client-encrypted project archive per user-held secret, stored server-side as ciphertext the server can never read — backup/cross-device transport for a local-only project (src/vault.js + public/js/vault-core.js).",
  },
  {
    id: "F-10",
    title: "Published research replays (/cure/<slug>)",
    impact: "medium",
    status: "shipped",
    summary:
      "Frozen deep-research sessions as read-only public pages, opened in place by the DRC app so continuing on the visitor's own keys is just typing (src/pub.js). See the publish-research skill.",
  },
  {
    id: "F-11",
    title: "Feedback pipeline — chat-triggered dialogue with the dev agent",
    impact: "medium",
    status: "shipped",
    summary:
      "User feedback given straight from the chat — a message opening with the word \"feedback\" (feedbackIntent, EN+SV) routes to the feedback case (src/pipeline.js runFeedbackCapture), which answers warmly and records a dialogue-thread entry (src/feedback.js) the development agent gathers, decides on, acts on, and replies into. Discovery is double: the structured queue plus a chat_logs meta.feedback tag. Superseded the earlier per-reply Feedback button + settings knob (2026-07-18). See the feedback-loop skill.",
  },
  {
    id: "F-12",
    title: "Project pulse dashboard (/pulse)",
    impact: "low",
    status: "shipped",
    summary:
      "Public commit-analytics dashboard over the repo's own git history — commits / lines / new features with a day/week/month zoom (scripts/build-pulse.mjs). See the commit-analytics skill.",
  },
  {
    id: "F-13",
    title: "Secondary LLM providers (Anthropic + OpenAI)",
    impact: "high",
    status: "shipped",
    summary:
      "The providers.js dispatch seam plus anthropic.js (adapt-at-the-wire SSE) and openai.js (native wire) — synthesis models beyond Berget, JSON phases still on the fixed reliable model. See the add-llm-provider skill.",
  },
  {
    id: "F-14",
    title: "Google Maps / Street View enrichment + Tokemon AR",
    impact: "medium",
    status: "shipped",
    summary:
      "The opt-in google_maps enrichment (Places / Street View / Static Maps / Routes, POV vision-describe, the image deck) and the Tokemon street-view AR mode built on it. See the integrations and tokemon-game skills.",
  },
  {
    id: "F-15",
    title: "Panel selection board — the attention loop",
    impact: "medium",
    status: "shipped",
    summary:
      "A third decision-board channel of a new KIND: its items ARE the admin panels themselves, reshaped purely by the owner's ▲/▼ thumbs (no drag, no priority, no board widget). The votes-driven focus order is what a Claude Code session reads (scripts/panels) to know which admin surface the owner is working on now (src/panels.js, D1 panels_reviews, façade over board.js). See the feature-board skill (the attention board).",
  },
  {
    id: "F-16",
    title: "Symbol language for DeepResearch.Se/rver",
    impact: "medium",
    status: "open",
    summary:
      "DECIDED (owner, 2026-07-15) and shipped client-side: the BALLOON — the tier's symbol, the ghost's Se/rver counterpart. Three pieces: the first-visit GREETER (public/js/balloon.js — round 4 re-scope: NO persistent figure follows the user on either tier; the balloon appears once, chained onto the landing intro, speaks a couple of pointer lines — what the tier does + the ghost button as the door to Se/cure — then climbs away and unmounts; burner flare + climb + pennant per completed task only while on screen, cloud swishes in ALL transitions), the first-visit LANDING intro (public/js/balloon-intro.js — vortex → wire balloons → a 180° camera drop with a sideways roll and swishing clouds → five same-shape/different-size colored balloons from below; faster than the umbrella intro, test-pinned), and the WAITING SYMBOL (public/js/balloon-spinner.js — the typing/step spinners boomerang the intro in miniature and fold, on completion, into a BLUE check via the colored balloon, where Se/cure's umbrella folds to pink). Round 5 (owner, 2026-07-16) REVERTED round 3's per-task channel grammar — the waiting symbols are TIER IDENTITY again (Se/cure = umbrella on every step, Se/rver = balloon on every step, stringent and clean) and the privacy communication moved into Se/cure's PRIVACY NOTICE: a header info button pops a detailed what-this-session-sends-where read-up, shown automatically when a shared secure workspace opens (privacyNoticeLines in drc-page-core.js; UX-2 rewritten). Round 4 also LOWERED the ambient UX animation level (wave drift 26s→52s, ghost shimmer 60s→180s cycle, ghost-contour breathe 3.6s→7.2s; UX-3). Record: docs/SYMBOL-LANGUAGE.md. RESIDUAL: live device verification.",
  },
  {
    id: "F-17",
    title: "Manual publish bridge for SDK-mode builds",
    impact: "low",
    status: "shipped",
    summary:
      "A small bridge into SDK mode's existing /app/<slug>/ build+publish flow (src/build-pub.js), for output the execution sandbox or introspection-mode source work already produced without a live model conversation. handleBuildManualPublish (PUT /api/build/:slug, admin-only) calls the SAME publishBuild the pipeline uses — identical caps and opaque-origin CSP-sandboxed serving, no second publish system. scripts/publish-app bundles a local directory and publishes it via the break-glass admin auth. See the publish-app skill (built on the sdk-mode skill).",
  },
  {
    id: "F-18",
    title: "Distributed secure research spaces — seal-back & aggregate/merge",
    impact: "high",
    status: "open",
    summary:
      "Extends the secure-workspace mechanism (docs/WORKSPACE-SECURITY.md, public/js/workspace-core.js, the /cure/workspace flow) from one portable session into a distribution+collection loop for fan-out research; the subject of LinkedIn series article 3 (teased in docs/linkedin/). TWO capabilities: (1) SEAL-BACK with the origin's public key — an origin Se/rver user publishes a public key, a node that finishes its research seals its results to that key so once sealed ONLY the origin user (private-key holder) can open them; the distributor hands out spaces preloaded with material+conversations, workers hand back results readable only by the distributor. (2) AGGREGATE/MERGE — the origin user collects the sealed bundles, decrypts locally, and combines the conclusions from the whole set of distributed research agents into one aggregated view (the reduce step), keeping per-node provenance and staying consistent with the DRSW/1 workspace-bundle standard (docs/WORKSPACE-PROTOCOL.md). Follows the no-own-crypto rule (WebCrypto/vetted asymmetric primitives — see article 2 + docs/ENCRYPTION.md) and the privacy invariants (no server in a Se/cure data path; sealed envelope opaque to the server; keys never log). Spec the envelope + merged shape before wiring UI.",
  },
];

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/features.test.js
// ---------------------------------------------------------------------------

// The choice-state mechanics (caps, patch/vote validation, D1 review rows,
// the ordering semantics) are the shared decision-board core (src/board.js —
// see the **decision-boards** / **feature-board** skills); this module
// re-exports its pure surface under the board's names, façade-style (the
// security-risks precedent), and keeps only what is item-shaped: the catalog,
// projection, the build-order text, and the endpoint.
export const REVIEW_CAPS = BOARD_CAPS;
export const validateReviewPatch = validateBoardPatch;
export const validateVote = validateBoardVote;

const IMPACT_RANK = { high: 0, medium: 1, low: 2 };
export const ORDER_MODES = ["priority", "impact"];

/** @param {string} id */
export function findFeatureItem(id) {
  return FEATURE_ITEMS.find((i) => i.id === id) || null;
}

// Catalog entry + its D1 review row → one board item. `register_order` is the
// item's position in the catalog (the register's §3 order).
/**
 * @param {FeatureItem} item
 * @param {ReviewRow | undefined} review
 * @param {number} registerOrder
 */
export function projectFeatureItem(item, review, registerOrder) {
  return {
    id: item.id,
    title: item.title,
    impact: item.impact,
    status: item.status,
    summary: item.summary,
    register_order: registerOrder,
    ...reviewState(review),
  };
}

// The BUILD ORDER (mode "priority") — the order the Claude Code feature loop
// builds in: admin-prioritized items first (ascending priority), then the
// rest by votes (desc), documented impact, register order. Non-open items
// (shipped/dropped) always sink to the bottom — they're the record, not work.
// Mode "impact": documented impact, then register order — the "how much does
// this move the product" view, votes/priority ignored.
/**
 * @param {ReturnType<typeof projectFeatureItem>[]} items
 * @param {string} mode "priority" | "impact"
 * @returns {ReturnType<typeof projectFeatureItem>[]} a new sorted array
 */
export function orderFeatureItems(items, mode) {
  return orderBoardItems(
    items,
    mode === "impact" ? "rank" : mode,
    (i) => IMPACT_RANK[/** @type {"high"|"medium"|"low"} */ (i.impact)] ?? 9,
  );
}

// Plain-text rendering (?format=text) — the feature loop's input. Always the
// BUILD ORDER; open items numbered top-down (this numbering IS the round's
// work order), shipped/dropped items as a short tail for context.
/**
 * @param {ReturnType<typeof projectFeatureItem>[]} ordered orderFeatureItems(..., "priority") output
 * @returns {string}
 */
export function formatFeaturesText(ordered) {
  const open = ordered.filter((i) => i.status === "open");
  const closed = ordered.filter((i) => i.status !== "open");
  const lines = ["FEATURE BUILD ORDER (admin-decided; build top-down — see FEATURES.md §3)", ""];
  open.forEach((i, n) => {
    lines.push(
      `${n + 1}. ${i.id} [${i.impact}]${i.priority != null ? ` (admin priority ${i.priority})` : ""}` +
        ` votes=${i.votes}${i.score ? ` effort=${i.score}` : ""} — ${i.title}`,
    );
    lines.push(`   ${i.summary}`);
    if (i.note) lines.push(`   ADMIN NOTE: ${i.note}`);
    lines.push("");
  });
  if (closed.length) {
    lines.push(
      "Shipped/dropped: " + closed.map((i) => `${i.id} [${i.status}]`).join(", "),
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The admin endpoint — /api/admin/features* (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminFeatures(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/features/, "");
  const method = request.method;

  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const mode = ORDER_MODES.includes(p.get("order") || "") ? /** @type {string} */ (p.get("order")) : "priority";
    const reviews = await loadBoardReviews(db, "features_reviews");
    let items = FEATURE_ITEMS.map((it, idx) => projectFeatureItem(it, reviews.get(it.id), idx));
    if (p.get("open") === "1") items = items.filter((i) => i.status === "open");
    const ordered = orderFeatureItems(items, mode);
    if (p.get("format") === "text") {
      // Text is the build loop's input — always the build (priority) order.
      const text = formatFeaturesText(mode === "priority" ? ordered : orderFeatureItems(items, "priority"));
      return new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return jsonResponse({ items: ordered, order: mode, count: ordered.length });
  }

  const m = path.match(/^\/(F-\d{1,3})(\/vote)?$/);
  const item = m ? findFeatureItem(m[1]) : null;
  if (!m || !item) return jsonResponse({ error: "No such feature item." }, 404);

  // Upsert-friendly: the review row is created on first vote/patch.
  if (m[2] && method === "POST") {
    const v = validateBoardVote(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await voteBoardRow(db, "features_reviews", item.id, v.delta);
    log.info("features.vote", { item_id: item.id, delta: v.delta });
    return projectedItem(db, item);
  }

  if (!m[2] && method === "PATCH") {
    const v = validateBoardPatch(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await patchBoardRow(db, "features_reviews", item.id, v.patch);
    log.info("features.review", { item_id: item.id, fields: Object.keys(v.patch).join(",") });
    return projectedItem(db, item);
  }

  return jsonResponse({ error: "Not found." }, 404);
}

/**
 * @param {D1Database} db
 * @param {FeatureItem} item
 */
async function projectedItem(db, item) {
  return jsonResponse({ item: await projectedBoardItem(db, "features_reviews", FEATURE_ITEMS, projectFeatureItem, item) });
}
