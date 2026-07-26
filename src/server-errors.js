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
// SECOND SOURCE (2026-07-26): SUBSYSTEM failures that invariant 2 makes
// FAIL-SOFT. A helper phase that degrades instead of erroring the chat is the
// right behaviour — but until now it left nothing durable behind: an
// Orchestrator sub-agent that timed out wrote one `ctx.log.warn` into Workers
// Logs (retention-bounded, unqueryable after the fact) and a counter in the
// chat_logs row, and a run that died BEFORE its chat_logs row was written left
// no trace at all. `recordSubsystemFailure` gives those swallowed failures the
// same durable, deduped, findable home as a 500 — a fail-soft failure is still
// a bug someone should see. Rows from this path are content-free by
// construction (see the posture note below): the human-readable half — which
// sub-agent, its task — belongs in the chat_logs row, which is the surface that
// honours the incognito promise.
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
// body). Nothing here is conversation, identity, or a secret. Subsystem rows
// hold to the SAME line: the pseudo-path and message carry only closed-
// vocabulary tokens (subsystem, operation, sub-agent KIND, wave index, failure
// class) — never a model-invented agent id or name, which is derived from the
// user's request and therefore belongs only in the incognito-gated chat log.
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

// ---- Failure classification (shared by every fail-soft subsystem) ----------
//
// "It failed" is not actionable; "it TIMED OUT" vs "the upstream 400'd on
// context length" vs "the client went away" are three different bugs with
// three different fixes. The classes are a closed vocabulary so they group in
// the queue and can be counted in a chat_logs row:
//
//   timeout   a deadline we set fired (our bound, not the upstream's)
//   abort     the work was cancelled — a client disconnect, an AbortSignal
//   oversized the payload/context/generation blew a size ceiling
//   quota     a rate limit or quota refusal
//   upstream  a provider/service answered with an error status
//   throw     anything else — an ordinary exception
export const FAILURE_CLASSES = ["timeout", "abort", "oversized", "quota", "upstream", "throw"];

/**
 * Classify a swallowed failure. Pure and total: any input yields a class.
 * Order matters — an upstream 400 whose body says "maximum context length" is
 * an OVERSIZED bug, not a generic upstream one, so the size test runs first.
 * @param {unknown} err the thrown value (or its message)
 * @param {{ timedOut?: boolean }} [opts] `timedOut` when OUR deadline fired —
 *   authoritative, because a wall-clock abort is indistinguishable by message
 * @returns {string} one of FAILURE_CLASSES
 */
export function classifyFailure(err, opts = {}) {
  if (opts.timedOut) return "timeout";
  const msg = String(
    err && typeof err === "object" && "message" in /** @type {any} */ (err)
      ? /** @type {any} */ (err).message ?? ""
      : err ?? "",
  );
  if (/\btimed?\s?out\b|\btimeout\b|deadline exceeded/i.test(msg)) return "timeout";
  if (/context length|too (?:large|long|many tokens)|safety cap|payload too|maximum length|exceeds? the maximum/i.test(msg)) {
    return "oversized";
  }
  if (/\bquota\b|rate limit|too many requests|\b429\b/i.test(msg)) return "quota";
  if (/abort|cancell?ed|client (?:gone|disconnected)|stream closed/i.test(msg)) return "abort";
  if (/API error \(\d+\)|\bHTTP \d{3}\b|fetch failed|network error|\b5\d{2}\b error/i.test(msg)) return "upstream";
  return "throw";
}

/**
 * @param {unknown} value
 * @returns {string} the class when valid, else "throw"
 */
export function normalizeFailureClass(value) {
  return typeof value === "string" && FAILURE_CLASSES.includes(value) ? value : "throw";
}

// The pseudo-path a subsystem failure is filed under. It is NOT a route — the
// leading `_subsystem` segment marks it as such, so it can never collide with
// a real path in the queue and `scripts/errors --q _subsystem` pulls exactly
// this family. Segments are hard-sanitized to the closed-vocabulary shape
// (lowercase word chars) so nothing user-derived can ride in on a caller's
// mistake, and empty segments are dropped.
/**
 * @param {string} subsystem
 * @param {...unknown} parts
 * @returns {string}
 */
export function subsystemPath(subsystem, ...parts) {
  const seg = (/** @type {unknown} */ v) =>
    String(v ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const tail = [seg(subsystem) || "unknown", ...parts.map(seg)].filter(Boolean);
  return `/_subsystem/${tail.join("/")}`;
}

/**
 * Record ONE fail-soft subsystem failure into the queue. Same dedup, same
 * lifecycle, same `scripts/errors` surface as a top-level 500 — but filed
 * under a `/_subsystem/...` pseudo-path and tagged with its failure class, so
 * a recurring "Orchestrator deep_research nodes time out" shows up as one row
 * with a rising count instead of vanishing into Workers Logs.
 *
 * Fail-soft like `recordServerError` and for the stronger reason: the caller
 * is ALREADY on a degraded path that must not break the request. Never throws.
 * @param {Env} env
 * @param {Logger | null | undefined} log
 * @param {{
 *   subsystem: string,
 *   op: string,
 *   failureClass?: string,
 *   detail?: unknown,
 *   requestId?: string | null,
 *   context?: Record<string, string | number | null | undefined>,
 *   stack?: unknown,
 * }} fields
 * @returns {Promise<number | null>}
 */
export async function recordSubsystemFailure(env, log, fields) {
  try {
    const cls = normalizeFailureClass(fields.failureClass);
    // Context pairs join the MESSAGE (not the path) so the signature stays
    // coarse enough to dedup across waves while the row still says which one.
    const ctxPairs = Object.entries(fields.context || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
    const detail = String(fields.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const message =
      `${fields.subsystem}.${fields.op} failed [${cls}]` +
      (ctxPairs.length ? ` (${ctxPairs.join(", ")})` : "") +
      (detail ? `: ${detail}` : "");
    return await recordServerError(env, log, {
      requestId: fields.requestId || null,
      method: "SUB",
      path: subsystemPath(fields.subsystem, fields.op, cls),
      message,
      stack: fields.stack == null ? null : fields.stack,
    });
  } catch (err) {
    log?.warn?.("server_error.subsystem_record_failed", {
      error: (/** @type {any} */ (err))?.message || String(err),
    });
    return null;
  }
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
