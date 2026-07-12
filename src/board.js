// @ts-check
// The decision-board core — the ONE shared mechanism behind the admin
// panels where Claude Code produces a list and the ADMIN's choices feed
// back into the agent loop's context (see the **decision-boards** skill).
//
// The loop every board implements:
//   1. Claude Code maintains a CATALOG of items (code, stable ids, mirroring
//      a source-of-truth doc) — the security board mirrors SECURITY-RISKS.md
//      §3; a features board mirrors its backlog doc; etc.
//   2. The admin panel renders the catalog with choice UX: ▲/▼ votes, a
//      manual score, a note, and an explicit PRIORITY per item.
//   3. Choices persist in a per-board D1 table keyed by the stable item id —
//      catalog edits never orphan them.
//   4. The loop reads the board back (?format=text) ordered by the admin's
//      choices: explicit priority IS the fixed work order; votes rank the
//      rest. The admin's ordering is the loop's plan — human-in-the-loop by
//      construction.
//   5. Acting on an item flips its catalog status in the same commit that
//      does the work, so the panel reflects reality on the next deploy.
//
// This module is the generic half: choice-state validation, the two
// orderings, and the D1 review-row helpers. Everything item-shaped
// (catalog, projection, text rendering, the endpoint) stays in the board's
// own module — src/security-risks.js is the reference consumer.
//
// Per-board D1 table shape (create per board, name is a CODE CONSTANT):
//   CREATE TABLE <board>_reviews (
//     item_id TEXT PRIMARY KEY, votes INTEGER NOT NULL DEFAULT 0,
//     score TEXT, note TEXT, priority INTEGER, updated_at INTEGER NOT NULL);

/**
 * A board review row (one item's admin choice state).
 * @typedef {{ item_id: string, votes: number, score?: string | null, note?: string | null, priority?: number | null, updated_at: number }} BoardReviewRow
 */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/board.test.js
// ---------------------------------------------------------------------------

// Size caps: a score is a short designation (a CVSS vector fits), a note is
// a remark, not a document.
export const BOARD_CAPS = { score: 120, note: 2_000 };

/** @param {unknown} v @param {number} max */
const cleanStr = (v, max) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

// PATCH body → {score?, note?, priority?} (only the fields present in the
// body; explicit null/"" clears a field), or {error}.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, patch: { score?: string | null, note?: string | null, priority?: number | null } }}
 */
export function validateBoardPatch(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  /** @type {{ score?: string | null, note?: string | null, priority?: number | null }} */
  const patch = {};
  if ("score" in body) patch.score = cleanStr(body.score, BOARD_CAPS.score);
  if ("note" in body) patch.note = cleanStr(body.note, BOARD_CAPS.note);
  if ("priority" in body) {
    if (body.priority == null || body.priority === "") {
      patch.priority = null;
    } else {
      const n = Number(body.priority);
      if (!Number.isInteger(n) || n < 1 || n > 999) {
        return { error: "priority must be an integer 1–999, or null to clear." };
      }
      patch.priority = n;
    }
  }
  if (!Object.keys(patch).length) {
    return { error: "Nothing to update — send score, note, and/or priority." };
  }
  return { patch };
}

// POST …/vote body → +1 | -1, or {error}.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, delta: number }}
 */
export function validateBoardVote(body) {
  const dir = body?.dir;
  if (dir === "up") return { delta: 1 };
  if (dir === "down") return { delta: -1 };
  return { error: 'vote body must be {"dir":"up"} or {"dir":"down"}.' };
}

// The two board orderings. Items must carry {status, priority, votes}; ties
// keep the INPUT order (Array.prototype.sort is stable), so callers pass the
// catalog in its documented default order and never need an explicit
// order field.
//
//   "priority" — THE WORK ORDER the agent loop consumes: open items first,
//     admin-prioritized ones at the top (ascending priority — the fixed
//     order), then the rest by votes desc, then rankOf asc.
//   "rank"     — the documented view: open first, then rankOf asc (e.g.
//     severity); votes and priority ignored.
/**
 * @template {{ status: string, priority?: number | null, votes: number }} T
 * @param {T[]} items in the board's default (catalog) order
 * @param {string} mode "priority" | "rank"
 * @param {(item: T) => number} rankOf lower = more important (e.g. severity rank)
 * @returns {T[]} a new sorted array
 */
export function orderBoardItems(items, mode, rankOf) {
  /** @param {T} i */
  const openRank = (i) => (i.status === "open" ? 0 : 1);
  const out = [...items];
  if (mode !== "priority") {
    out.sort((a, b) => openRank(a) - openRank(b) || rankOf(a) - rankOf(b));
    return out;
  }
  out.sort((a, b) => {
    const d = openRank(a) - openRank(b);
    if (d) return d;
    const ap = a.priority, bp = b.priority;
    if (ap != null && bp != null) return ap - bp;
    if ((ap != null) !== (bp != null)) return ap != null ? -1 : 1;
    return b.votes - a.votes || rankOf(a) - rankOf(b);
  });
  return out;
}

// Review row → the choice-state fields every board projection spreads into
// its item objects (defaults when the admin hasn't touched the item yet).
/**
 * @param {BoardReviewRow | undefined | null} review
 */
export function reviewState(review) {
  return {
    votes: review?.votes ?? 0,
    score: review?.score ?? null,
    note: review?.note ?? null,
    priority: review?.priority ?? null,
    reviewed_at: review?.updated_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// D1 review-row helpers. `table` is interpolated and MUST be a code
// constant (a board's own module names its table), never user input.
// ---------------------------------------------------------------------------

/**
 * @param {D1Database} db
 * @param {string} table
 * @returns {Promise<Map<string, BoardReviewRow>>} item_id -> row
 */
export async function loadBoardReviews(db, table) {
  const { results } = await db.prepare(`SELECT * FROM ${table}`).all();
  return new Map((/** @type {BoardReviewRow[]} */ (results || [])).map((r) => [r.item_id, r]));
}

/**
 * @param {D1Database} db
 * @param {string} table
 * @param {string} itemId
 * @returns {Promise<BoardReviewRow | null>}
 */
export async function getBoardReview(db, table, itemId) {
  return /** @type {Promise<BoardReviewRow | null>} */ (
    db.prepare(`SELECT * FROM ${table} WHERE item_id = ?`).bind(itemId).first()
  );
}

// Upsert-friendly vote: the review row is created on first vote.
/**
 * @param {D1Database} db
 * @param {string} table
 * @param {string} itemId
 * @param {number} delta +1 | -1
 */
export async function voteBoardRow(db, table, itemId, delta) {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO ${table} (item_id, votes, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET votes = votes + ?, updated_at = ?`,
    )
    .bind(itemId, delta, now, delta, now)
    .run();
}

// Upsert-friendly patch: only the fields present in `patch` are updated on
// an existing row; a new row gets the patched fields and NULL for the rest.
/**
 * @param {D1Database} db
 * @param {string} table
 * @param {string} itemId
 * @param {{ score?: string | null, note?: string | null, priority?: number | null }} patch
 */
export async function patchBoardRow(db, table, itemId, patch) {
  const now = Date.now();
  const sets = ["updated_at = ?"];
  /** @type {any[]} */
  const binds = [now];
  for (const k of /** @type {const} */ (["score", "note", "priority"])) {
    if (k in patch) { sets.push(`${k} = ?`); binds.push(patch[k]); }
  }
  await db
    .prepare(
      `INSERT INTO ${table} (item_id, votes, score, note, priority, updated_at)
       VALUES (?, 0, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET ${sets.join(", ")}`,
    )
    .bind(itemId, patch.score ?? null, patch.note ?? null, patch.priority ?? null, now, ...binds)
    .run();
}
