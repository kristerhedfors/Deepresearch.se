// @ts-check
// Testable interaction points (D1 `test_points`) — the "try-it queue".
//
// The problem this solves: when a fix ships or a feature lands, someone has
// to go find the exact spot in the app to try it. This turns that spot into
// a DECLARED, LINKABLE thing: a test point is a labelled queue entry that
// carries (a) WHERE in the app to go — a same-origin target path plus an
// ordered list of client ACTIONS that set the scene (open a panel, prefill
// the composer, flip a knob) — and (b) a plain-language "what was fixed"
// summary shown while trying it. The tester opens it (from the queue, or by
// the shareable /try/<id> link), lands exactly there, reads what changed,
// and records a verdict: 👍 works / 👎 doesn't / ❓ untestable — the deep
// link + actions never landed them somewhere the fix could actually be
// tried, or it's unclear what to do — with an optional note.
//
// The ❓ verdict is a DIALOGUE, not a dead end: every verdict note is stored
// as a message on the point's thread (author "tester"), the Claude Code loop
// answers with its own message (author "agent", POST …/:id/messages or
// scripts/testpoints --reply) and re-opens the point, and the banner shows
// the whole thread — so an unclear point is clarified back and forth at the
// point itself until a real 👍/👎 lands.
//
// The producer side is Claude Code (or the owner) declaring a point the
// moment a fix is testable — POST /api/admin/testpoints, or scripts/testpoints
// (see the **testable-interaction-points** skill for the full loop and the
// exact boundary of what "reachable" covers). The consumer side is the
// signed-in tester working the queue on the DRS app.
//
// Access: the whole surface is ADMIN-gated (the owner is the tester; a deep
// link can prefill the composer or open settings, so it is a developer tool,
// not an end-user one). The client fails soft for non-admins — the queue and
// banner simply do not render.
//
// Two API surfaces, both under /api/admin/testpoints (admin gate in
// index.js → admin-api.js):
//   GET    /api/admin/testpoints            the queue (open items), newest
//                                           first; ?status= ?open=1 ?q=
//                                           ?limit= ?format=text
//   POST   /api/admin/testpoints            declare a point {label, summary,
//                                           target, actions?, ref?}
//   GET    /api/admin/testpoints/:id        one point (the banner reads this)
//   PATCH  /api/admin/testpoints/:id        edit / lifecycle {label?, summary?,
//                                           target?, actions?, ref?, status?}
//   POST   /api/admin/testpoints/:id/result record a verdict {result, note?}
//   POST   /api/admin/testpoints/:id/messages append to the clarification
//                                           thread {body, author?}
//   DELETE /api/admin/testpoints/:id
//
// And the deep-link resolver, routed in index.js:
//   GET    /try/:id   302 → <target>?try=<id> (so the target page's client
//                     picks the point up); non-admin / missing → /rver.

import { getDb } from "./db.js";
import { jsonResponse, textResponse } from "./http.js";
import { cleanStr, likePattern } from "./chatlog.js";
import { parseUseCaseRef, useCaseTag } from "../public/js/testpoints-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */
/**
 * A D1 `test_points` row.
 * @typedef {{ id: number, created_at: number, updated_at: number, label: string, summary: string, target: string, actions_json?: string | null, status: string, result?: string | null, result_note?: string | null, result_at?: number | null, ref?: string | null }} TestPointRow
 */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/testpoints.test.js
// ---------------------------------------------------------------------------

export const TESTPOINT_CAPS = {
  label: 200,
  summary: 8_000,
  target: 500,
  note: 4_000,
  ref: 200,
  selector: 200,
  compose: 8_000,
  model: 100,
  knob: 60,
  actions: 25, // most points need a handful; a wall of actions is a smell
  message: 4_000, // one thread message (same budget as a verdict note)
  thread: 100, // messages read back per point — a longer thread is a smell
};

// Lifecycle. `open` = still to test (the queue). A verdict moves it to
// `passed`, `failed`, or `untestable`; `failed` is work to redo and is
// re-opened after the next fix (PATCH status:"open"); `untestable` sits with
// the loop — the tester never reached a state where the fix could be tried
// (or didn't understand what to do), so the loop answers on the point's
// thread and re-opens it. `archived` retires a point.
export const TESTPOINT_STATUSES = ["open", "passed", "failed", "untestable", "archived"];

// The three verdicts: 👍 pass / 👎 fail / ❓ untestable (couldn't reach it or
// needs clarification — starts/continues the thread instead of settling).
export const TESTPOINT_RESULTS = ["pass", "fail", "untestable"];

// The result verdict → the status it drives.
/** @type {Record<string, string>} */
const RESULT_STATUS = { pass: "passed", fail: "failed", untestable: "untestable" };

// Who wrote a thread message: the human tester (verdict notes, banner) or
// the Claude Code loop answering (scripts/testpoints --reply).
export const MESSAGE_AUTHORS = ["tester", "agent"];

// ---- the deep-link ACTION grammar (THE reachability boundary) -------------
// An action is one step the target page's client runs on arrival to set the
// scene. This list IS the boundary of what a point can reach automatically;
// anything outside it must be described in prose in the summary and reached
// by hand. Keep this in lockstep with the client executor in
// public/js/testpoints.js and the grammar table in the skill.
//
// Unknown action types (and malformed ones) are DROPPED, not rejected — a
// point declared against a newer/older grammar still opens, minus the steps
// this build can't run. validateActions reports how many were dropped so the
// producer can be told.
export const ACTION_TYPES = [
  "note", // {text} — extra inline guidance in the banner; no side effect
  "openAccount", // {view?} — open the account panel to a view
  "openSettings", // {knob?} — open Settings, optionally highlight a knob row
  "openProjects", // {} — open the project panel
  "openHistory", // {} — open the chat-history sidebar
  "newChat", // {} — start a fresh chat
  "compose", // {text, send?} — prefill the composer (send:true submits it)
  "setSearch", // {on} — flip the web-search knob
  "setBudget", // {seconds} — set the research time-target slider
  "selectModel", // {model} — pick a model in the dropdown
  "highlight", // {selector} — pulse-highlight + scroll to an element
];

const ACCOUNT_VIEWS = ["summary", "full", "messages", "settings", "feedback", "games", "docs"];

/** @param {unknown} v */
const asBool = (v) => v === true || v === "true" || v === 1 || v === "1";

// A target must be a SAME-ORIGIN relative path: one leading slash, not the
// protocol-relative "//host" form, no scheme. Query/hash are allowed (a
// point can land on /rver?x=1#y). This is a hard reject (a bad target has no
// safe fallback), unlike the soft action drop.
/**
 * @param {unknown} target
 * @returns {string | null} the cleaned path, or null when invalid
 */
export function cleanTarget(target) {
  if (typeof target !== "string") return null;
  const t = target.trim();
  if (!t || t.length > TESTPOINT_CAPS.target) return null;
  if (!t.startsWith("/") || t.startsWith("//")) return null;
  if (/[\x00-\x1f]/.test(t)) return null; // control chars
  return t;
}

// One raw action → a cleaned action, or null when its type is unknown or its
// required fields are missing/invalid (the caller drops nulls).
/**
 * @param {any} a
 * @returns {any | null}
 */
export function cleanAction(a) {
  if (!a || typeof a !== "object" || !ACTION_TYPES.includes(a.type)) return null;
  switch (a.type) {
    case "note": {
      const text = cleanStr(a.text, TESTPOINT_CAPS.compose);
      return text ? { type: "note", text } : null;
    }
    case "openAccount": {
      const view = ACCOUNT_VIEWS.includes(a.view) ? a.view : "summary";
      return { type: "openAccount", view };
    }
    case "openSettings": {
      const knob = cleanStr(a.knob, TESTPOINT_CAPS.knob);
      return knob ? { type: "openSettings", knob } : { type: "openSettings" };
    }
    case "openProjects":
      return { type: "openProjects" };
    case "openHistory":
      return { type: "openHistory" };
    case "newChat":
      return { type: "newChat" };
    case "compose": {
      const text = cleanStr(a.text, TESTPOINT_CAPS.compose);
      if (!text) return null;
      return a.send ? { type: "compose", text, send: true } : { type: "compose", text };
    }
    case "setSearch":
      return { type: "setSearch", on: asBool(a.on) };
    case "setBudget": {
      const n = Math.round(Number(a.seconds));
      if (!Number.isFinite(n)) return null;
      return { type: "setBudget", seconds: Math.min(Math.max(n, 5), 1800) };
    }
    case "selectModel": {
      const model = cleanStr(a.model, TESTPOINT_CAPS.model);
      return model ? { type: "selectModel", model } : null;
    }
    case "highlight": {
      const selector = cleanStr(a.selector, TESTPOINT_CAPS.selector);
      return selector ? { type: "highlight", selector } : null;
    }
    default:
      return null;
  }
}

// Raw actions (or a JSON string of them) → {actions, dropped}. Never throws:
// a non-array, a bad JSON string, or a too-long list all degrade to as many
// valid actions as fit, capped at TESTPOINT_CAPS.actions.
/**
 * @param {unknown} raw
 * @returns {{ actions: any[], dropped: number }}
 */
export function validateActions(raw) {
  let arr = raw;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      arr = null;
    }
  }
  if (!Array.isArray(arr)) return { actions: [], dropped: 0 };
  const actions = [];
  let dropped = 0;
  for (const a of arr) {
    if (actions.length >= TESTPOINT_CAPS.actions) {
      dropped++;
      continue;
    }
    const c = cleanAction(a);
    if (c) actions.push(c);
    else dropped++;
  }
  return { actions, dropped };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeStatus(value) {
  return typeof value === "string" && TESTPOINT_STATUSES.includes(value) ? value : null;
}

// POST body → the row fields for a new point, or {error}. label, summary and
// a valid target are required; actions and ref ride along.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, entry: { label: string, summary: string, target: string, actions: any[], ref: string | null }, dropped: number }}
 */
export function validateTestpointCreate(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const label = cleanStr(body.label, TESTPOINT_CAPS.label);
  if (!label) return { error: "A test point needs a non-empty label." };
  const summary = cleanStr(body.summary, TESTPOINT_CAPS.summary);
  if (!summary) return { error: "A test point needs a non-empty summary (what was fixed)." };
  const target = cleanTarget(body.target);
  if (!target) return { error: "target must be a same-origin path starting with '/'." };
  const { actions, dropped } = validateActions(body.actions);
  return { entry: { label, summary, target, actions, ref: cleanStr(body.ref, TESTPOINT_CAPS.ref) }, dropped };
}

// PATCH body → only the present fields (edit or lifecycle move), or {error}.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, patch: Record<string, any>, dropped: number }}
 */
export function validateTestpointPatch(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  /** @type {Record<string, any>} */
  const patch = {};
  let dropped = 0;
  if ("label" in body) {
    const label = cleanStr(body.label, TESTPOINT_CAPS.label);
    if (!label) return { error: "label cannot be empty." };
    patch.label = label;
  }
  if ("summary" in body) {
    const summary = cleanStr(body.summary, TESTPOINT_CAPS.summary);
    if (!summary) return { error: "summary cannot be empty." };
    patch.summary = summary;
  }
  if ("target" in body) {
    const target = cleanTarget(body.target);
    if (!target) return { error: "target must be a same-origin path starting with '/'." };
    patch.target = target;
  }
  if ("actions" in body) {
    const v = validateActions(body.actions);
    patch.actions_json = JSON.stringify(v.actions);
    dropped = v.dropped;
  }
  if ("ref" in body) patch.ref = cleanStr(body.ref, TESTPOINT_CAPS.ref);
  if ("status" in body) {
    const status = normalizeStatus(body.status);
    if (!status) return { error: `status must be one of: ${TESTPOINT_STATUSES.join(", ")}.` };
    patch.status = status;
  }
  if (!Object.keys(patch).length) {
    return { error: "Nothing to update — send label, summary, target, actions, ref and/or status." };
  }
  return { patch, dropped };
}

// POST …/result body → {result, note}, or {error}.
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, result: string, note: string | null }}
 */
export function validateTestpointResult(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  if (!TESTPOINT_RESULTS.includes(body.result)) {
    return { error: `result must be one of: ${TESTPOINT_RESULTS.join(", ")}.` };
  }
  return { result: body.result, note: cleanStr(body.note, TESTPOINT_CAPS.note) };
}

// POST …/messages body → {author, body}, or {error}. The default author is
// "agent" — the loop is the usual caller; the banner sends author:"tester"
// explicitly (both sides sit behind the same admin gate, so the field is a
// label, not a privilege).
/**
 * @param {any} body
 * @returns {{ error: string } | { error?: undefined, author: string, body: string }}
 */
export function validateTestpointMessage(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be a JSON object." };
  const text = cleanStr(body.body, TESTPOINT_CAPS.message);
  if (!text) return { error: "A thread message needs a non-empty body." };
  const author = body.author === undefined ? "agent" : body.author;
  if (!MESSAGE_AUTHORS.includes(author)) {
    return { error: `author must be one of: ${MESSAGE_AUTHORS.join(", ")}.` };
  }
  return { author, body: text };
}

/** @param {number} id */
export function tryUrl(id) {
  return `/try/${id}`;
}

// Merge ?try=<id> into a target path, preserving its own query/hash. Used
// server-side by the /try redirect and mirrored client-side.
/**
 * @param {string} target a same-origin path (already cleaned)
 * @param {number|string} id
 * @returns {string}
 */
export function deepLink(target, id) {
  const [head, hash = ""] = target.split("#");
  const sep = head.includes("?") ? "&" : "?";
  const withTry = `${head}${sep}try=${encodeURIComponent(String(id))}`;
  return hash ? `${withTry}#${hash}` : withTry;
}

/** @param {string | null | undefined} json */
function parseActions(json) {
  if (!json) return [];
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** @param {string} status */
export function isOpenStatus(status) {
  return status === "open";
}

// ---------------------------------------------------------------------------
// Use-case identity — the #UC-<id> tag (owner directive, 2026-07-19)
// ---------------------------------------------------------------------------
//
// Each test point is a "use case": a starter prompt the owner runs to
// evaluate one front of the app, then feeds back on. The tag makes a point
// self-identifying: the client prepends it to the composed starter prompt
// (public/js/testpoints.js compose action) so a run carries its use-case
// number, and the feedback gate reads it back — a chat message like
//   feedback #UC-34 the map was cut off on mobile
// records the outcome straight onto point #34's thread (src/chat.js →
// recordUseCaseFeedback), so the outcome lands "as if answered in the list
// of use cases" without reopening the queue. useCaseTag/parseUseCaseRef live
// ONCE in the client pure core (public/js/testpoints-core.js — the
// agent-spec-core.js façade pattern: the browser can only import served
// modules, the Worker bundler can import from anywhere), re-exported here so
// server callers (pipeline.js, this module) and src/testpoints.test.js keep
// their import path. Do not reintroduce a copy.
export { parseUseCaseRef, useCaseTag };

// The verdict symbol vocabulary — one glyph per result, used everywhere a
// verdict is shown (text render here, the banner buttons, PR comments).
/** @type {Record<string, string>} */
export const RESULT_SYMBOLS = { pass: "👍", fail: "👎", untestable: "❓" };

/** @type {Record<string, string>} */
const RESULT_WORDS = { pass: "👍 works", fail: "👎 broken", untestable: "❓ untestable — needs clarification" };

// A D1 `test_point_messages` row → API object.
/**
 * @param {{ id: number, point_id: number, created_at: number, author: string, body: string }} row
 * @returns {any}
 */
export function projectTestpointMessage(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    time: new Date(row.created_at).toISOString(),
    author: row.author === "agent" ? "agent" : "tester",
    body: row.body,
  };
}

// Row → API object. `try_url` is the shareable deep link; `open` marks queue
// membership.
/**
 * @param {TestPointRow} row
 * @returns {any}
 */
export function projectTestpoint(row) {
  return {
    id: row.id,
    tag: useCaseTag(row.id),
    created_at: row.created_at,
    updated_at: row.updated_at,
    time: new Date(row.created_at).toISOString(),
    label: row.label,
    summary: row.summary,
    target: row.target,
    actions: parseActions(row.actions_json),
    status: row.status,
    open: isOpenStatus(row.status),
    result: row.result || null,
    result_note: row.result_note || null,
    result_at: row.result_at || null,
    result_time: row.result_at ? new Date(row.result_at).toISOString() : null,
    ref: row.ref || null,
    try_url: tryUrl(row.id),
  };
}

// Plain-text rendering (?format=text): newest first, one block per point.
// Made to be READ by the loop that produces and tracks points, not parsed.
/**
 * @param {any[]} entries projectTestpoint output
 * @returns {string}
 */
export function formatTestpointsText(entries) {
  if (!entries.length) return "(no test points match)\n";
  return (
    entries
      .map((e) => {
        const lines = [
          `── ${e.tag} [${e.status}] ${e.label}`,
          `TRY: ${e.try_url}   →  ${e.target}`,
          `FIXED: ${e.summary}`,
        ];
        if (e.actions.length) {
          lines.push(`ACTIONS: ${e.actions.map((/** @type {any} */ a) => a.type).join(" → ")}`);
        }
        if (e.ref) lines.push(`REF: ${e.ref}`);
        if (e.result) {
          lines.push(
            `VERDICT: ${RESULT_WORDS[e.result] || e.result}` +
              (e.result_time ? ` (${e.result_time})` : "") +
              (e.result_note ? ` — ${e.result_note}` : ""),
          );
        }
        if (Array.isArray(e.messages) && e.messages.length) {
          lines.push("THREAD:");
          for (const m of e.messages) {
            lines.push(`  ${m.author} (${m.time}): ${m.body}`);
          }
        }
        return lines.join("\n");
      })
      .join("\n\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// Shared queries
// ---------------------------------------------------------------------------

/**
 * @param {D1Database} db
 * @param {number} id
 * @returns {Promise<TestPointRow | null>}
 */
async function getPoint(db, id) {
  return /** @type {Promise<TestPointRow | null>} */ (
    db.prepare("SELECT * FROM test_points WHERE id = ?").bind(id).first()
  );
}

// Attach each point's clarification thread (oldest first, capped) to a list
// of projected points — one query for the whole page, not one per point.
// Fail-soft: a messages read that errors leaves the points without threads
// rather than failing the request.
/**
 * @param {D1Database} db
 * @param {any[]} entries projectTestpoint output (mutated in place)
 * @returns {Promise<any[]>}
 */
async function attachMessages(db, entries) {
  if (!entries.length) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) e.messages = [];
  const marks = entries.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT * FROM test_point_messages WHERE point_id IN (${marks}) ORDER BY id ASC`,
    )
    .bind(...entries.map((e) => e.id))
    .all()
    .catch(() => ({ results: [] }));
  for (const row of /** @type {any[]} */ (results || [])) {
    const e = byId.get(row.point_id);
    if (e && e.messages.length < TESTPOINT_CAPS.thread) e.messages.push(projectTestpointMessage(row));
  }
  return entries;
}

/**
 * @param {D1Database} db
 * @param {number} pointId
 * @param {string} author
 * @param {string} body
 */
async function insertMessage(db, pointId, author, body) {
  await db
    .prepare("INSERT INTO test_point_messages (point_id, created_at, author, body) VALUES (?, ?, ?, ?)")
    .bind(pointId, Date.now(), author, body)
    .run();
}

// Record use-case feedback captured from the chat (feedback #UC-<id> …) as a
// tester message on the point's thread — the same dialogue a queue verdict
// note joins — so the outcome lands "as if answered in the list of use
// cases" without reopening the try-it queue. A message on a point that
// already carries a verdict re-opens it (except an archived/retired one) so
// the development loop sees the new note on its queue, matching the
// reopen-on-reply posture of the feedback pipeline. Fail-soft: a missing
// point or a write error returns { ok: false } and never disturbs the chat.
// Admin-gated at the call site (src/chat.js) — the test-point surface is
// owner-only.
/**
 * @param {D1Database} db
 * @param {number} id the referenced test point id
 * @param {string} comment the feedback message (verbatim, tag included)
 * @returns {Promise<{ ok: false } | { ok: true, id: number, tag: string, label: string, reopened: boolean }>}
 */
export async function recordUseCaseFeedback(db, id, comment) {
  const point = await getPoint(db, id).catch(() => null);
  if (!point) return { ok: false };
  await insertMessage(db, id, "tester", comment).catch(() => {});
  const reopened = point.status !== "open" && point.status !== "archived";
  const now = Date.now();
  if (reopened) {
    await db
      .prepare("UPDATE test_points SET status = 'open', updated_at = ? WHERE id = ?")
      .bind(now, id)
      .run()
      .catch(() => {});
  } else {
    await db.prepare("UPDATE test_points SET updated_at = ? WHERE id = ?").bind(now, id).run().catch(() => {});
  }
  return { ok: true, id, tag: useCaseTag(id), label: point.label, reopened };
}

// Count of open (still-to-test) points — feeds the client queue badge.
/**
 * @param {Env} env
 * @returns {Promise<number>}
 */
export async function countOpenTestpoints(env) {
  const db = await getDb(env);
  if (!db) return 0;
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM test_points WHERE status = 'open'")
    .first()
    .catch(() => null);
  return /** @type {number} */ (row?.n) || 0;
}

// ---------------------------------------------------------------------------
// Admin surface — /api/admin/testpoints* (admin gate in index.js)
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleAdminTestpoints(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const path = url.pathname.replace(/^\/api\/admin\/testpoints/, "");
  const method = request.method;

  // GET /api/admin/testpoints — the queue (open by default), newest first.
  if (path === "" && method === "GET") {
    const p = url.searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 200);
    const where = [];
    const binds = [];
    if (p.get("open") === "1") where.push("status = 'open'");
    if (normalizeStatus(p.get("status"))) {
      where.push("status = ?");
      binds.push(p.get("status"));
    }
    if (p.get("q")) {
      where.push("(label LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
      const pat = likePattern(p.get("q"));
      binds.push(pat, pat);
    }
    const sql =
      "SELECT * FROM test_points" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      " ORDER BY id DESC LIMIT ?";
    const { results } = await db.prepare(sql).bind(...binds, limit).all();
    const entries = await attachMessages(
      db,
      (/** @type {TestPointRow[]} */ (results || [])).map(projectTestpoint),
    );
    if (p.get("format") === "text") return textResponse(formatTestpointsText(entries));
    return jsonResponse({ testpoints: entries, count: entries.length });
  }

  // POST /api/admin/testpoints — declare a point.
  if (path === "" && method === "POST") {
    const body = await request.json().catch(() => null);
    const v = validateTestpointCreate(body);
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const now = Date.now();
    const res = await db
      .prepare(
        `INSERT INTO test_points (created_at, updated_at, label, summary, target, actions_json, status, ref)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .bind(now, now, v.entry.label, v.entry.summary, v.entry.target, JSON.stringify(v.entry.actions), v.entry.ref)
      .run();
    const id = /** @type {number} */ (res.meta?.last_row_id);
    log.info("testpoint.created", { id, target: v.entry.target, dropped: v.dropped });
    const row = await getPoint(db, id);
    return jsonResponse(
      { testpoint: projectTestpoint(/** @type {TestPointRow} */ (row)), dropped_actions: v.dropped },
      201,
    );
  }

  const idMatch = path.match(/^\/(\d+)(\/result|\/messages)?$/);
  if (!idMatch) return jsonResponse({ error: "Not found." }, 404);
  const point = await getPoint(db, Number(idMatch[1]));
  if (!point) return jsonResponse({ error: "No such test point." }, 404);
  const sub = idMatch[2] || "";

  // GET /api/admin/testpoints/:id — the banner reads this (thread included).
  if (!sub && method === "GET") {
    const [projected] = await attachMessages(db, [projectTestpoint(point)]);
    if (url.searchParams.get("format") === "text") return textResponse(formatTestpointsText([projected]));
    return jsonResponse({ testpoint: projected });
  }

  // PATCH /api/admin/testpoints/:id — edit / lifecycle.
  if (!sub && method === "PATCH") {
    const v = validateTestpointPatch(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const sets = ["updated_at = ?"];
    const binds = [Date.now()];
    for (const [k, val] of Object.entries(v.patch)) {
      sets.push(`${k} = ?`);
      binds.push(val);
    }
    await db.prepare(`UPDATE test_points SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, point.id).run();
    log.info("testpoint.patched", { id: point.id, fields: Object.keys(v.patch) });
    const row = await getPoint(db, point.id);
    return jsonResponse({ testpoint: projectTestpoint(/** @type {TestPointRow} */ (row)), dropped_actions: v.dropped });
  }

  // POST /api/admin/testpoints/:id/result — the 👍/👎/❓ verdict. A note
  // also joins the point's thread as a tester message, so every verdict's
  // context is part of the same dialogue the loop replies into.
  if (sub === "/result" && method === "POST") {
    const v = validateTestpointResult(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    const now = Date.now();
    await db
      .prepare(
        "UPDATE test_points SET result = ?, result_note = ?, result_at = ?, status = ?, updated_at = ? WHERE id = ?",
      )
      .bind(v.result, v.note, now, RESULT_STATUS[v.result], now, point.id)
      .run();
    if (v.note) await insertMessage(db, point.id, "tester", v.note).catch(() => {});
    log.info("testpoint.result", { id: point.id, result: v.result });
    const row = await getPoint(db, point.id);
    const [projected] = await attachMessages(db, [projectTestpoint(/** @type {TestPointRow} */ (row))]);
    return jsonResponse({ testpoint: projected }, 201);
  }

  // POST /api/admin/testpoints/:id/messages — the clarification thread. The
  // loop answers an ❓ untestable point here (author "agent"), then re-opens
  // it (PATCH status:"open") so the answer reaches the tester's queue.
  if (sub === "/messages" && method === "POST") {
    const v = validateTestpointMessage(await request.json().catch(() => null));
    if (typeof v.error === "string") return jsonResponse({ error: v.error }, 400);
    await insertMessage(db, point.id, v.author, v.body);
    await db.prepare("UPDATE test_points SET updated_at = ? WHERE id = ?").bind(Date.now(), point.id).run();
    log.info("testpoint.message", { id: point.id, author: v.author });
    const [projected] = await attachMessages(db, [projectTestpoint(point)]);
    return jsonResponse({ testpoint: projected }, 201);
  }

  // DELETE /api/admin/testpoints/:id — the thread goes with the point.
  if (!sub && method === "DELETE") {
    await db.prepare("DELETE FROM test_point_messages WHERE point_id = ?").bind(point.id).run().catch(() => {});
    await db.prepare("DELETE FROM test_points WHERE id = ?").bind(point.id).run();
    log.info("testpoint.deleted", { id: point.id });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "Not found." }, 404);
}

// ---------------------------------------------------------------------------
// /try/:id — the shareable deep link (routed in index.js, admin-gated)
// ---------------------------------------------------------------------------

// Resolves a point's target and 302s to it with ?try=<id> merged, so the
// landing page's client picks the point up and shows the try-it banner.
// Anything that can't resolve (not admin, no DB, missing point) redirects
// home to /rver rather than erroring — a stale link should never dead-end.
/**
 * @param {Env} env
 * @param {number} id
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleTryRedirect(env, id, identity) {
  const home = () => new Response(null, { status: 302, headers: { Location: "/rver" } });
  if (identity.role !== "admin") return home();
  const db = await getDb(env);
  if (!db) return home();
  const point = await getPoint(db, id);
  if (!point) return home();
  return new Response(null, { status: 302, headers: { Location: deepLink(point.target, id) } });
}

