// @ts-check
// ACCOUNT MEMORY — the Worker side of the note graph whose pure core is
// public/js/memory-core.js (same pure-core/façade split as the other shared
// modules; the client's Settings screen imports the core directly).
//
// Endpoints, all behind the identity gate:
//   GET    /api/memory          the notes plus counts, for the Settings screen
//   GET    /api/memory/export   the whole vault as an Obsidian-ready .zip
//   DELETE /api/memory          reset — deletes every note for the account
//
// Plus `runMemoryExtraction`, the fail-soft tail src/chat.js runs after a turn.
//
// WHAT MAKES THIS SAFE TO ADD (invariant 4). Memory is Se/rver-only: it is
// account-scoped server-side state, which is only coherent in the tier where
// the server is inside the trust boundary (owner directive, 2026-07-24).
// Se/cure gets nothing here and must keep getting nothing — no endpoint below
// is reachable without a signed-in account, and a Se/rver TOKEN can never
// satisfy that gate (the server-token guarantee: a token reads nothing
// Se/rver stores). Three further limits are load-bearing rather than
// decorative, and each has a test:
//   - OFF BY DEFAULT. The `memory` knob is opt-in like every other knob.
//   - NEVER IN INCOGNITO. The ghost toggle already suppresses the chat-log
//     row; a memory note is a longer-lived record than that row, so the same
//     promise has to cover it or incognito would mean less than it says.
//   - RESET DELETES. No tombstones, no soft-delete column — the row is gone,
//     so "reset" means what a user assumes it means.

import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import {
  MAX_NOTES,
  mergeNote,
  memoryExtractInput,
  memoryExtractPrompt,
  normalizeMemoryNotes,
  vaultFiles,
} from "../public/js/memory-core.js";
import { zipText } from "../public/js/zip-core.js";

/** @typedef {import("./types.js").Env} Env */
/** @typedef {import("./auth.js").Identity} Identity */
/** @typedef {import("../public/js/memory-core.js").MemoryNote} MemoryNote */

/**
 * Only a real signed-in account has memory. Break-glass identities are
 * deliberately excluded: they are a shared operational credential, so writing
 * durable per-person notes under one would attribute several people's research
 * to a single row.
 * @param {Identity | null | undefined} identity
 * @returns {string | null} the user id, or null when memory does not apply
 */
export function memoryUserId(identity) {
  return identity?.user?.id ? String(identity.user.id) : null;
}

// ---- storage -----------------------------------------------------------------

/**
 * @param {any} row
 * @returns {MemoryNote}
 */
function rowToNote(row) {
  /** @param {unknown} s @returns {string[]} */
  const list = (s) => {
    try {
      const v = JSON.parse(typeof s === "string" ? s : "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    slug: row.slug,
    title: row.title,
    type: row.type,
    body: row.body,
    links: list(row.links_json),
    tags: list(row.tags_json),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

/**
 * Every note for an account, newest-touched first.
 * @param {Env} env
 * @param {string} userId
 * @returns {Promise<MemoryNote[]>}
 */
export async function listMemoryNotes(env, userId) {
  const db = await getDb(env);
  if (!db) return [];
  const { results } = await db
    .prepare(
      "SELECT slug, title, type, body, links_json, tags_json, created_at, updated_at " +
        "FROM memory_notes WHERE user_id = ? ORDER BY updated_at DESC, slug ASC",
    )
    .bind(userId)
    .all();
  return (results || []).map(rowToNote);
}

/**
 * Upsert freshly extracted notes, merging each into whatever is already stored
 * under its slug (memory-core's accumulate-don't-overwrite rule).
 *
 * Eviction is by LEAST RECENTLY TOUCHED once the account passes MAX_NOTES.
 * That is the right axis for a research memory: a note the user keeps
 * returning to stays fresh through `updated_at` on every merge, so the notes
 * that fall off are the ones nothing has referred to in a long time.
 * @param {Env} env
 * @param {string} userId
 * @param {MemoryNote[]} notes
 * @returns {Promise<{ written: number, evicted: number }>}
 */
export async function saveMemoryNotes(env, userId, notes) {
  const db = await getDb(env);
  if (!db || !notes.length) return { written: 0, evicted: 0 };
  const slugs = notes.map((n) => n.slug);
  const placeholders = slugs.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      "SELECT slug, title, type, body, links_json, tags_json, created_at, updated_at " +
        `FROM memory_notes WHERE user_id = ? AND slug IN (${placeholders})`,
    )
    .bind(userId, ...slugs)
    .all();
  const existing = new Map((results || []).map((r) => [r.slug, rowToNote(r)]));

  const statements = notes.map((incoming) => {
    const merged = mergeNote(existing.get(incoming.slug), incoming);
    return db
      .prepare(
        "INSERT INTO memory_notes (user_id, slug, title, type, body, links_json, tags_json, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(user_id, slug) DO UPDATE SET title = excluded.title, type = excluded.type, " +
          "body = excluded.body, links_json = excluded.links_json, tags_json = excluded.tags_json, " +
          "updated_at = excluded.updated_at",
      )
      .bind(
        userId,
        merged.slug,
        merged.title,
        merged.type,
        merged.body,
        JSON.stringify(merged.links),
        JSON.stringify(merged.tags),
        merged.created_at,
        merged.updated_at,
      );
  });
  await db.batch(statements);

  // Trim to the cap. One DELETE with a subselect rather than a read-then-write
  // so a concurrent request can't race the count.
  const trim = await db
    .prepare(
      "DELETE FROM memory_notes WHERE user_id = ? AND slug NOT IN " +
        "(SELECT slug FROM memory_notes WHERE user_id = ? ORDER BY updated_at DESC, slug ASC LIMIT ?)",
    )
    .bind(userId, userId, MAX_NOTES)
    .run();
  return { written: notes.length, evicted: Number(trim?.meta?.changes) || 0 };
}

/**
 * Reset: every note for the account, gone.
 * @param {Env} env
 * @param {string} userId
 * @returns {Promise<number>} rows removed
 */
export async function clearMemoryNotes(env, userId) {
  const db = await getDb(env);
  if (!db) return 0;
  const res = await db.prepare("DELETE FROM memory_notes WHERE user_id = ?").bind(userId).run();
  return Number(res?.meta?.changes) || 0;
}

// ---- the extraction tail -----------------------------------------------------

/**
 * Build memory from one finished turn. Called by src/chat.js AFTER the answer
 * has been streamed, so it can never delay or break a reply: everything here
 * is wrapped, and every failure path returns a count rather than throwing
 * (invariant 2 — a helper phase degrades, it does not error the request).
 *
 * The caller owns the gating decisions (knob on, not incognito, signed in);
 * this function re-checks the ones it can cheaply, because a memory write is
 * durable and a missed gate here is not recoverable by a later fix.
 *
 * @param {{
 *   env: Env, log: any, identity: Identity, incognito: boolean, enabled: boolean,
 *   question: string, answer: string,
 *   jsonPhase: (args: {system: string, user: string, maxTokens: number}) => Promise<any>,
 * }} args
 * @returns {Promise<{ stored: number, reason?: string }>}
 */
export async function runMemoryExtraction(args) {
  const { env, log, identity, incognito, enabled, question, answer, jsonPhase } = args;
  const userId = memoryUserId(identity);
  if (!enabled) return { stored: 0, reason: "off" };
  if (incognito) return { stored: 0, reason: "incognito" };
  if (!userId) return { stored: 0, reason: "no_account" };
  if (!answer || answer.length < 40) return { stored: 0, reason: "thin_answer" };
  try {
    const known = await listMemoryNotes(env, userId);
    const raw = await jsonPhase({
      system: memoryExtractPrompt({ existingSlugs: known.map((n) => n.slug) }),
      user: memoryExtractInput({ question, answer }),
      maxTokens: 900,
    });
    const notes = normalizeMemoryNotes(raw, { now: Date.now() });
    if (!notes.length) return { stored: 0, reason: "nothing_durable" };
    const { written, evicted } = await saveMemoryNotes(env, userId, notes);
    log?.info?.("memory.extract", { written, evicted });
    return { stored: written };
  } catch (err) {
    // A memory that fails is a memory that did not learn this turn. Nothing
    // about the answer the user already received changes.
    log?.warn?.("memory.extract_failed", { error: String(/** @type {any} */ (err)?.message || err) });
    return { stored: 0, reason: "error" };
  }
}

// ---- HTTP --------------------------------------------------------------------

/**
 * GET /api/memory — what the Settings → Memory screen renders.
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMemoryGet(env, identity) {
  const userId = memoryUserId(identity);
  if (!userId) {
    return jsonResponse({ error: "Memory needs a signed-in account (not break-glass)." }, 403);
  }
  const notes = await listMemoryNotes(env, userId);
  /** @type {Record<string, number>} */
  const byType = {};
  let links = 0;
  for (const n of notes) {
    byType[n.type] = (byType[n.type] || 0) + 1;
    links += n.links.length;
  }
  return jsonResponse({
    notes: notes.map((n) => ({
      slug: n.slug,
      title: n.title,
      type: n.type,
      body: n.body,
      links: n.links,
      tags: n.tags,
      updated_at: n.updated_at,
    })),
    count: notes.length,
    links,
    by_type: byType,
    max_notes: MAX_NOTES,
  });
}

/**
 * GET /api/memory/export — the vault, as a .zip of Markdown notes.
 *
 * The archive is built in memory because the note caps bound it to a size an
 * isolate handles comfortably (MAX_NOTES x MAX_BODY_CHARS is well under a
 * megabyte before zip overhead), and a streamed archive would buy nothing but
 * complexity at that size.
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMemoryExport(env, identity) {
  const userId = memoryUserId(identity);
  if (!userId) {
    return jsonResponse({ error: "Memory needs a signed-in account (not break-glass)." }, 403);
  }
  const notes = await listMemoryNotes(env, userId);
  const now = Date.now();
  const files = vaultFiles(notes, { generatedAt: now, account: identity.user?.email || "" });
  const bytes = zipText(files, { date: new Date(now) });
  const stamp = new Date(now).toISOString().slice(0, 10);
  return new Response(bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="deepresearch-memory-${stamp}.zip"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * DELETE /api/memory — the reset button.
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleMemoryDelete(env, identity) {
  const userId = memoryUserId(identity);
  if (!userId) {
    return jsonResponse({ error: "Memory needs a signed-in account (not break-glass)." }, 403);
  }
  const removed = await clearMemoryNotes(env, userId);
  return jsonResponse({ ok: true, removed });
}
