// @ts-check
// The server-ERROR fix queue (D1 `server_errors`). Every time the Worker's
// top-level request handler catches an UNhandled exception and hands the
// client the generic `{ error: "Internal server error.", request_id }` 500
// (src/index.js's fetch catch), the same failure is ALSO recorded here as a
// queue row — so those events don't only live in Workers Logs where nobody
// looks, they become a work item a Claude Code loop can pull and turn into a
// bug-fix task. This is the "type loop and get the next bug to fix" surface
// for server-side crashes.
//
// This is a dynamic-queue decision board (the feedback.js / chatlog.js family,
// NOT the code-catalog security/features boards): rows are created at RUNTIME
// by the crash itself, not authored in code. Recording is DEDUPED by a stable
// signature (method + normalized path + normalized message) so a recurring
// crash bumps one row's `count`/`last_seen_at` instead of flooding the queue —
// the same philosophy as src/alerts.js, but per-BUG with a fix lifecycle and
// the `?format=text` loop feed every board shares.
//
// Status lifecycle: open → fixed | ignored.
//   - open    still on the loop's work queue (a bug to fix).
//   - fixed   a fix shipped. If the SAME signature recurs afterwards the row
//             REOPENS (status back to open) — a regression signal, the most
//             valuable thing this queue produces.
//   - ignored acknowledged as not-worth-fixing (expected noise, a client
//             abuse pattern); a recurrence leaves it ignored.
//
// Content posture: a recorded error carries NO user content — only the request
// method, the URL PATH (never the query string or body), the exception message
// and stack, and the request id (which already ships to the client in the 500
// body). Nothing here is conversation, identity, or a secret.
//
// API surfaces (admin-gated in index.js, dispatched from admin-api.js):
//   GET    /api/admin/errors        the queue, newest-failure first
//     ?open=1 (the work queue: status = open)  ?status=<s>  ?q=<substring>
//     ?since=<epoch ms>  ?before_id=<id>  ?limit=20 (max 200)  ?format=text
//   GET    /api/admin/errors/:id    one row (?format=text)
//   PATCH  /api/admin/errors/:id    {status?: open|fixed|ignored, note?: string}
//   DELETE /api/admin/errors/:id

import { getDb } from "./db.js";
import { jsonResponse, textResponse } from "./http.js";
import { cleanStr, likePattern } from "./chatlog.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/**
 * A D1 `server_errors` row.
 * @typedef {{ id: number, signature: string, first_seen_at: number, last_seen_at: number, count: number, status: string, method?: string | null, path?: string | null, message?: string | null, stack?: string | null, request_id?: string | null, note?: string | null, updated_at: number }} ServerErrorRow
 */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/server-errors.test.js
// ---------------------------------------------------------------------------

export const SERVER_ERROR_CAPS = {
  message: 4_000,
  stack: 8_000,
  path: 400,
  method: 10,
  request_id: 100,
  note: 2_000,
  signature: 500,
};

export const SERVER_ERROR_STATUSES = ["open", "fixed", "ignored"];

// Open = still on the loop's work queue (a bug to fix). `fixed`/`ignored`
// leave the queue; a recurrence reopens a `fixed` row (see recordServerError).
/**
 * @param {string} status
 * @returns {boolean}
 */
export function isOpenErrorStatus(status) {
  return status === "open";
}

/**
 * @param {unknown} value
 * @returns {string | null} the status when valid, else null
 */
export function normalizeErrorStatus(value) {
  return typeof value === "string" && SERVER_ERROR_STATUSES.includes(value) ? value : null;
}

// Collapses the volatile tokens in a URL path so `/api/feedback/12/messages`
// and `/api/feedback/98/messages` share ONE signature: numeric ids and UUIDs
// become `:id`. Everything else (the route shape) is what identifies the bug.
/**
 * @param {unknown} path
 * @returns {string}
 */
export function normalizePath(path) {
  const p = (typeof path === "string" ? path : "").split(/[?#]/)[0]; // drop query/hash
  return p
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
      /^[0-9a-f]{16,}$/i.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
}

// Collapses the volatile tokens in an exception MESSAGE so two occurrences of
// the same crash with different ids/numbers/quotes group together: request
// ids, hex, standalone numbers, and quoted literals are masked. The result is
// only used to build the dedup signature — the real message is stored verbatim.
/**
 * @param {unknown} message
 * @returns {string}
 */
export function normalizeMessage(message) {
  return (typeof message === "string" ? message : "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/0x[0-9a-f]+/gi, "<hex>")
    .replace(/["'`][^"'`]*["'`]/g, "<str>")
    .replace(/\b\d[\d.,]*\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// The stable dedup key: METHOD + normalized PATH + normalized MESSAGE. Same
// bug → same signature → one queue row whose count bumps, however many times
// it fires and whatever ids rode along.
/**
 * @param {{ method?: unknown, path?: unknown, message?: unknown }} fields
 * @returns {string}
 */
export function errorSignature({ method, path, message } = {}) {
  const m = (typeof method === "string" ? method : "").toUpperCase().slice(0, SERVER_ERROR_CAPS.method) || "?";
  return `${m} ${normalizePath(path)} :: ${normalizeMessage(message)}`.slice(0, SERVER_ERROR_CAPS.signature);
}

// DB row → API object.
/**
 * @param {ServerErrorRow} row
 * @returns {any}
 */
export function projectServerError(row) {
  return {
    id: row.id,
    signature: row.signature,
    status: row.status,
    open: isOpenErrorStatus(row.status),
    count: row.count,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    first_time: new Date(row.first_seen_at).toISOString(),
    last_time: new Date(row.last_seen_at).toISOString(),
    method: row.method || null,
    path: row.path || null,
    message: row.message || null,
    stack: row.stack || null,
    request_id: row.request_id || null,
    note: row.note || null,
  };
}

// Plain-text rendering (?format=text): newest-failure first, one bordered
// block per bug — made to be READ by the agent loop, not parsed. The block
// carries everything a fix needs: the route, the message, the latest request
// id (to cross-reference Workers Logs / chatlogs), the recurrence count, and
// a stack when there is one.
/**
 * @param {any[]} entries projected rows (projectServerError output)
 * @returns {string}
 */
export function formatServerErrorsText(entries) {
  if (!entries.length) return "(no server errors match)\n";
  return (
    entries
      .map((e) => {
        const lines = [
          `── #${e.id} ${e.last_time} [${e.status}] ×${e.count}` +
            ` ${e.method || "?"} ${e.path || "?"}` +
            (e.request_id ? ` ref=${e.request_id}` : ""),
          `ERROR: ${e.message || "(no message)"}`,
        ];
        if (e.count > 1) lines.push(`FIRST SEEN: ${e.first_time}`);
        if (e.note) lines.push(`NOTE: ${e.note}`);
        if (e.stack) lines.push(`STACK:\n${e.stack}`);
        return lines.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// Write path — the crash recorder
// ---------------------------------------------------------------------------

// Record one caught top-level exception into the fix queue. Deduped by
// signature via an atomic UPSERT: a first occurrence inserts an `open` row; a
// recurrence bumps count/last_seen_at and refreshes the sample fields, and
// REOPENS the row if it had been marked `fixed` (a regression). An `ignored`
// row stays ignored.
//
// FAIL-SOFT and self-contained: it resolves its own DB, swallows every error,
// and returns the row id or null. It must NEVER throw — the caller is the
// request handler's catch block, already handling a failure; recording the
// crash cannot be allowed to cause a second one. Callers should not await it
// on the hot path (use ctx.waitUntil).
/**
 * @param {Env} env
 * @param {Logger | null | undefined} log
 * @param {{ requestId?: string | null, method?: string | null, path?: string | null, message?: unknown, stack?: unknown }} fields
 * @returns {Promise<number | null>}
 */
export async function recordServerError(env, log, fields) {
  try {
    const db = await getDb(env);
    if (!db) return null;
    const signature = errorSignature(fields);
    const now = Date.now();
    const method = cleanStr(fields.method, SERVER_ERROR_CAPS.method);
    const path = cleanStr(fields.path, SERVER_ERROR_CAPS.path);
    const message = cleanStr(fields.message == null ? null : String(fields.message), SERVER_ERROR_CAPS.message);
    const stack = cleanStr(fields.stack == null ? null : String(fields.stack), SERVER_ERROR_CAPS.stack);
    const requestId = cleanStr(fields.requestId, SERVER_ERROR_CAPS.request_id);
    await db
      .prepare(
        `INSERT INTO server_errors
           (signature, first_seen_at, last_seen_at, count, status, method, path, message, stack, request_id, updated_at)
         VALUES (?, ?, ?, 1, 'open', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(signature) DO UPDATE SET
           count = count + 1,
           last_seen_at = excluded.last_seen_at,
           method = excluded.method,
           path = excluded.path,
           message = excluded.message,
           stack = excluded.stack,
           request_id = excluded.request_id,
           status = CASE WHEN server_errors.status = 'fixed' THEN 'open' ELSE server_errors.status END,
           updated_at = excluded.updated_at`,
      )
      .bind(signature, now, now, method, path, message, stack, requestId, now)
      .run();
    // Insert-vs-update is irrelevant to the return value: re-read the row id by
    // its (unique) signature either way. On the DO UPDATE path last_row_id is
    // not reliably the conflicting row's id, so we never trust it.
    const row = await db
      .prepare("SELECT id FROM server_errors WHERE signature = ?")
      .bind(signature)
      .first()
      .catch(() => null);
    return /** @type {any} */ (row)?.id || null;
  } catch (err) {
    log?.warn?.("server_error.record_failed", {
      error: (/** @type {any} */ (err))?.message || String(err),
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<ServerErrorRow | null>}
 */
async function getRow(db, id) {
  return /** @type {Promise<ServerErrorRow | null>} */ (
    db.prepare("SELECT * FROM server_errors WHERE id = ?").bind(id).first()
  );
}

// ---------------------------------------------------------------------------
// Agent/operator surface — /api/admin/errors* (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminServerErrors(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/errors/, "");
  const method = request.method;

  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 20, 1), 200);
    const where = [];
    const binds = [];
    if (p.get("open") === "1") { where.push("status = 'open'"); }
    if (normalizeErrorStatus(p.get("status"))) { where.push("status = ?"); binds.push(p.get("status")); }
    if (Number(p.get("since"))) { where.push("last_seen_at >= ?"); binds.push(Number(p.get("since"))); }
    if (Number(p.get("before_id"))) { where.push("id < ?"); binds.push(Number(p.get("before_id"))); }
    if (p.get("q")) {
      where.push("(message LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\')");
      const pat = likePattern(p.get("q"));
      binds.push(pat, pat, pat);
    }
    const sql =
      "SELECT * FROM server_errors" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY last_seen_at DESC, id DESC LIMIT ?";
    const { results } = await db.prepare(sql).bind(...binds, limit).all();
    const entries = (/** @type {ServerErrorRow[]} */ (results || [])).map(projectServerError);
    if (p.get("format") === "text") return textResponse(formatServerErrorsText(entries));
    return jsonResponse({ errors: entries, count: entries.length });
  }

  const idMatch = path.match(/^\/(\d+)$/);
  if (!idMatch) return jsonResponse({ error: "Not found." }, 404);
  const row = await getRow(db, Number(idMatch[1]));
  if (!row) return jsonResponse({ error: "No such server error." }, 404);

  if (method === "GET") {
    const projected = projectServerError(row);
    if (url.searchParams.get("format") === "text") {
      return textResponse(formatServerErrorsText([projected]));
    }
    return jsonResponse({ error_entry: projected });
  }

  if (method === "PATCH") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const sets = [];
    const binds = [];
    if ("status" in body) {
      const status = normalizeErrorStatus(body.status);
      if (!status) {
        return jsonResponse({ error: `status must be one of: ${SERVER_ERROR_STATUSES.join(", ")}.` }, 400);
      }
      sets.push("status = ?");
      binds.push(status);
    }
    if ("note" in body) {
      sets.push("note = ?");
      binds.push(cleanStr(body.note, SERVER_ERROR_CAPS.note));
    }
    if (!sets.length) return jsonResponse({ error: "Nothing to update (status and/or note)." }, 400);
    sets.push("updated_at = ?");
    binds.push(Date.now());
    await db.prepare(`UPDATE server_errors SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, row.id).run();
    log.info("server_error.patched", { id: row.id, status: body.status });
    return jsonResponse({ error_entry: projectServerError(/** @type {ServerErrorRow} */ (await getRow(db, row.id))) });
  }

  if (method === "DELETE") {
    await db.prepare("DELETE FROM server_errors WHERE id = ?").bind(row.id).run();
    log.info("server_error.deleted", { id: row.id });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found." }, 404);
}
