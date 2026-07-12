// @ts-check
// Server-side chat interaction log (D1 `chat_logs`) — FULL question/answer
// visibility, by explicit product decision (2026-07-08): every completed
// /api/chat and /mcp research interaction is logged with its complete
// question, complete answer, the conversation as sent, the research metadata
// (queries, sources, phases' outputs), and any error — UNLESS the user
// pressed the ghost (incognito) toggle, in which case NOTHING content-derived
// is written (the ghost is the anonymous-chat escape hatch; the pre-existing
// metadata-only Workers Logs still fire for those requests).
//
// The log exists to improve the product: it is deliberately shaped for the
// AGENTIC DEVELOPMENT WORKFLOW — Claude Code pulls the latest interactions
// straight off the live site while debugging (see the **chat-logs** skill and
// scripts/chatlogs). That drives the design choices here:
//   - `GET /api/admin/chatlogs` defaults to the newest interactions with the
//     complete question AND answer inline — one curl, no joins, no follow-ups.
//   - `?format=text` renders a human/LLM-readable transcript instead of JSON,
//     so a debugging session can just read it.
//   - `?errors=1`, `?q=`, `?user=`, `?model=`, `?since=`, `?before_id=` cover
//     the "what just happened / what broke" questions without SQL access.
//   - request_id is logged, so a row correlates with Workers Logs and the
//     client's `(ref …)` error strings.
//
// Writes FAIL SOFT (invariant 2): a logging failure must never break the
// chat. No D1 binding → no-op.

import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { lastUserMessage, textOf } from "./conversation.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * What recordChatLog accepts. Only content-bearing fields are required in
 * practice; everything else defaults inside buildChatLogEntry.
 * @typedef {{
 *   request_id?: string | null,
 *   ts?: number,
 *   user_id?: number | string,
 *   channel?: string,
 *   model?: string | null,
 *   json_model?: string | null,
 *   question?: string,
 *   answer?: string,
 *   conversation?: any[],
 *   status?: string,
 *   error?: string | null,
 *   meta?: unknown,
 *   web_search?: boolean,
 *   budget_s?: number | null,
 *   rounds?: number,
 *   searches?: number,
 *   sources?: number,
 *   prompt_tokens?: number,
 *   completion_tokens?: number,
 *   duration_ms?: number,
 *   client_gone?: boolean,
 * }} ChatLogInput
 */

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/chatlog.test.js
// ---------------------------------------------------------------------------

// Size caps keep a row well under D1's 2 MB ceiling while preserving "full
// visibility" in practice (answers run tens of KB at most; a conversation
// with many inlined documents is the only thing that realistically trims).
export const LOG_CAPS = {
  question: 32_000,
  answer: 300_000,
  conversation: 400_000,
  meta: 200_000,
  error: 4_000,
};

// Truncates with an explicit marker so a trimmed log never silently
// masquerades as the complete text.
/**
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function truncateForLog(text, max) {
  const s = typeof text === "string" ? text : text == null ? "" : String(text);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
}

// Per-item caps for the shell tool-call record. `commands` re-caps below
// resolveShellTranscript's own MAX_SHELL_ROUNDS*8 ceiling; `output` matches
// the sandbox's MAX_OUTPUT_CHARS so a logged call shows the same bytes the
// pipeline actually saw, not more.
export const SHELL_LOG_CAPS = {
  commands: 48,
  command: 2_000,
  output: 4_000,
};

// The bash-lite agent's shell transcript, shaped for the interaction log: the
// exact commands the browser's agentic loop ran, their exit codes, and their
// (clamped) stdout/stderr. This is the ONE tool-calling-shaped capability the
// pipeline has — invariant 1 keeps it a plain fenced-block convention, never a
// function call, but from a visibility standpoint each command IS a tool call.
// Until now the log kept only a COUNT (client_diag.ran); this gives shell tool
// calls the same full visibility `queries`/`sources` give web search. Returns
// undefined when nothing ran, so JSON.stringify drops the key for ordinary
// chats (matching the failover_model/quiz convention in src/chat.js's meta).
/**
 * @param {unknown} transcript resolveShellTranscript output (src/validation.js)
 * @returns {Array<{ command: string, exitCode: number, stdout: string, stderr: string }> | undefined}
 */
export function shellLogSummary(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return undefined;
  /** @type {Array<{ command: string, exitCode: number, stdout: string, stderr: string }>} */
  const out = [];
  for (const r of transcript) {
    if (!r || typeof r.command !== "string" || !r.command.trim()) continue;
    out.push({
      command: truncateForLog(r.command, SHELL_LOG_CAPS.command),
      exitCode: Number.isFinite(r.exitCode) ? Math.trunc(r.exitCode) : 1,
      stdout: truncateForLog(r.stdout, SHELL_LOG_CAPS.output),
      stderr: truncateForLog(r.stderr, SHELL_LOG_CAPS.output),
    });
    if (out.length >= SHELL_LOG_CAPS.commands) break;
  }
  return out.length ? out : undefined;
}

// Renders the shell tool calls (meta.shell) as a readable block for the
// ?format=text view — the actual commands, exit codes, and output, indented —
// so a debugging session (human or agent) sees EXACTLY what the agent ran
// instead of just a count. Empty output lines are dropped so a no-output
// command reads cleanly.
/**
 * @param {Array<{ command: string, exitCode: number, stdout: string, stderr: string }>} shell
 * @returns {string}
 */
export function formatShellForLog(shell) {
  const lines = [`TOOLS: bash-lite ran ${shell.length} command${shell.length === 1 ? "" : "s"}`];
  for (const c of shell) {
    lines.push(`  $ ${c.command}   (exit ${c.exitCode})`);
    const body = String(c.stdout || "").replace(/\s+$/, "");
    if (body) for (const ln of body.split("\n")) lines.push(`    ${ln}`);
    const err = String(c.stderr || "").replace(/\s+$/, "");
    if (err) for (const ln of err.split("\n")) lines.push(`    [stderr] ${ln}`);
  }
  return lines.join("\n");
}

// The conversation as sent, minus inline image payloads: base64 data URLs
// run to megabytes and are useless in a text log — each is replaced by a
// size-stamped placeholder. Text parts (including appended document blocks)
// are kept verbatim; http(s) image URLs are kept (they're references, not
// payloads). Returns a NEW structure; never mutates the live conversation.
/**
 * @param {unknown} messages the conversation as sent (OpenAI-style array)
 * @returns {Array<{ role?: string, content?: any }>}
 */
export function sanitizeConversationForLog(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!Array.isArray(m?.content)) return { role: m?.role, content: m?.content };
    const content = m.content.map((/** @type {any} */ p) => {
      if (p?.type === "image_url") {
        const url = p.image_url?.url || "";
        if (/^data:/i.test(url)) {
          return { type: "image_url", image_url: { url: `[inline image omitted: ${url.length} chars]` } };
        }
      }
      return p;
    });
    return { role: m.role, content };
  });
}

// Assembles the row values recordChatLog binds — pure so the shape (and the
// truncation/serialization behavior) is testable without D1. `conversation`
// is the message array as sent; `meta` is the research metadata object
// (queries, sources, complexity, costs…).
/**
 * @param {ChatLogInput} input
 * @returns {Record<string, unknown>} the bind values, keyed by column name
 */
export function buildChatLogEntry(input) {
  const conversation = Array.isArray(input.conversation) ? input.conversation : [];
  const question = input.question ?? textOf(lastUserMessage(conversation)?.content);
  let metaJson = null;
  if (input.meta != null) {
    try {
      metaJson = truncateForLog(JSON.stringify(input.meta), LOG_CAPS.meta);
    } catch {
      metaJson = null; // meta must never sink the log write
    }
  }
  return {
    request_id: input.request_id || null,
    ts: input.ts ?? Date.now(),
    user_id: String(input.user_id ?? ""),
    channel: input.channel || "chat",
    model: input.model || null,
    json_model: input.json_model || null,
    question: truncateForLog(question, LOG_CAPS.question),
    answer: truncateForLog(input.answer ?? "", LOG_CAPS.answer),
    conversation_json: truncateForLog(
      JSON.stringify(sanitizeConversationForLog(conversation)),
      LOG_CAPS.conversation,
    ),
    status: input.status || "ok",
    error: input.error ? truncateForLog(input.error, LOG_CAPS.error) : null,
    meta_json: metaJson,
    web_search: input.web_search === false ? 0 : 1,
    budget_s: Number.isFinite(input.budget_s) ? input.budget_s : null,
    rounds: input.rounds ?? 0,
    searches: input.searches ?? 0,
    sources: input.sources ?? 0,
    prompt_tokens: input.prompt_tokens ?? 0,
    completion_tokens: input.completion_tokens ?? 0,
    duration_ms: input.duration_ms ?? 0,
    client_gone: input.client_gone ? 1 : 0,
  };
}

// DB row → API object. The list view carries the full question and answer
// (the point of the log); the conversation JSON and meta ride along only
// with `full` (the /:id view) to keep list responses scannable.
/**
 * @param {any} row a D1 chat_logs row
 * @param {{ full?: boolean }} [options]
 * @returns {any} the API projection (see the module header's read-API notes)
 */
export function projectChatLog(row, { full = false } = {}) {
  /** @type {any} */
  const out = {
    id: row.id,
    ts: row.ts,
    time: new Date(row.ts).toISOString(),
    request_id: row.request_id,
    user_id: row.user_id,
    channel: row.channel,
    model: row.model,
    json_model: row.json_model,
    status: row.status,
    error: row.error || null,
    web_search: !!row.web_search,
    budget_s: row.budget_s,
    rounds: row.rounds,
    searches: row.searches,
    sources: row.sources,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    duration_ms: row.duration_ms,
    client_gone: !!row.client_gone,
    question: row.question,
    answer: row.answer,
  };
  if (full) {
    out.conversation = safeParse(row.conversation_json);
    out.meta = safeParse(row.meta_json);
  }
  return out;
}

/** @param {string | null | undefined} json */
function safeParse(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return json; // a truncated blob is still worth returning raw
  }
}

// Plain-text rendering (?format=text): newest first, one bordered block per
// interaction — made to be READ (by a developer or an agent), not parsed.
/**
 * @param {any[]} logs projected entries (projectChatLog output)
 * @returns {string}
 */
export function formatChatLogsText(logs) {
  if (!logs.length) return "(no logged interactions match)\n";
  return logs
    .map((l) => {
      const head =
        `── #${l.id} ${l.time} [${l.status}] ${l.channel} ` +
        `user=${l.user_id} model=${l.model || "-"} ` +
        `${(l.duration_ms / 1000).toFixed(1)}s ${l.rounds}r/${l.searches}s/${l.sources}src ` +
        `${l.prompt_tokens}+${l.completion_tokens}tok` +
        (l.client_gone ? " client-gone" : "") +
        (l.request_id ? ` ref=${l.request_id}` : "");
      const lines = [head, `Q: ${l.question || "(empty)"}`];
      if (l.error) lines.push(`ERROR: ${l.error}`);
      lines.push(`A: ${l.answer || "(no answer)"}`);
      // Shell tool calls get their own readable block (full-view only, where
      // meta rides along) so the commands/output aren't buried in the META
      // one-liner — the "understand exactly what the agent ran" view.
      if (l.meta && Array.isArray(l.meta.shell) && l.meta.shell.length) {
        lines.push(formatShellForLog(l.meta.shell));
      }
      if (l.meta) lines.push(`META: ${JSON.stringify(l.meta)}`);
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}

// Escapes LIKE wildcards so ?q= is a literal substring match.
/**
 * @param {unknown} q
 * @returns {string}
 */
export function likePattern(q) {
  return "%" + String(q).replace(/([\\%_])/g, "\\$1") + "%";
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

// Inserts one interaction row. Fail-soft: any failure is logged as metadata
// and swallowed — chat delivery must never depend on the log.
// NOTE: incognito suppression happens at the CALL SITES (src/chat.js checks
// the ghost toggle before calling this) — a call here always writes.
/**
 * @param {Env} env
 * @param {Logger | null | undefined} log
 * @param {ChatLogInput} input
 */
export async function recordChatLog(env, log, input) {
  try {
    const db = await getDb(env);
    if (!db) return;
    const e = buildChatLogEntry(input);
    await db
      .prepare(
        `INSERT INTO chat_logs (
           request_id, ts, user_id, channel, model, json_model,
           question, answer, conversation_json, status, error, meta_json,
           web_search, budget_s, rounds, searches, sources,
           prompt_tokens, completion_tokens, duration_ms, client_gone
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        e.request_id, e.ts, e.user_id, e.channel, e.model, e.json_model,
        e.question, e.answer, e.conversation_json, e.status, e.error, e.meta_json,
        e.web_search, e.budget_s, e.rounds, e.searches, e.sources,
        e.prompt_tokens, e.completion_tokens, e.duration_ms, e.client_gone,
      )
      .run();
  } catch (err) {
    log?.warn?.("chatlog.write_failed", { error: (/** @type {any} */ (err))?.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// Read path — /api/admin/chatlogs (admin gate enforced in index.js)
// ---------------------------------------------------------------------------

const LIST_COLUMNS =
  "id, request_id, ts, user_id, channel, model, json_model, question, answer, " +
  "status, error, web_search, budget_s, rounds, searches, sources, " +
  "prompt_tokens, completion_tokens, duration_ms, client_gone";

// GET /api/admin/chatlogs        — newest interactions, full Q&A inline
//   ?limit=20 (max 200)  ?before_id=<id> (paging cursor, exclusive)
//   ?user=<id>  ?model=<id>  ?channel=chat|mcp  ?status=ok|error|disconnected
//   ?errors=1 (shorthand for status!=ok)  ?since=<epoch ms>
//   ?q=<substring> (matches question OR answer, literal)
//   ?format=text (readable transcript instead of JSON)
// GET /api/admin/chatlogs/<id>   — one row incl. conversation + meta
/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @returns {Promise<Response>}
 */
export async function handleChatLogs(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);

  const idMatch = url.pathname.match(/^\/api\/admin\/chatlogs\/(\d+)$/);
  if (idMatch) {
    const row = await db.prepare("SELECT * FROM chat_logs WHERE id = ?").bind(Number(idMatch[1])).first();
    if (!row) return jsonResponse({ error: "No such log entry." }, 404);
    const entry = projectChatLog(row, { full: true });
    if (url.searchParams.get("format") === "text") {
      return textResponse(formatChatLogsText([entry]));
    }
    return jsonResponse({ log: entry });
  }

  const p = url.searchParams;
  const limit = Math.min(Math.max(Number(p.get("limit")) || 20, 1), 200);
  const where = [];
  const binds = [];
  if (p.get("user")) { where.push("user_id = ?"); binds.push(p.get("user")); }
  if (p.get("model")) { where.push("model = ?"); binds.push(p.get("model")); }
  if (p.get("channel")) { where.push("channel = ?"); binds.push(p.get("channel")); }
  if (p.get("status")) { where.push("status = ?"); binds.push(p.get("status")); }
  if (p.get("errors") === "1") where.push("status != 'ok'");
  if (Number(p.get("since"))) { where.push("ts >= ?"); binds.push(Number(p.get("since"))); }
  if (Number(p.get("before_id"))) { where.push("id < ?"); binds.push(Number(p.get("before_id"))); }
  if (p.get("q")) {
    where.push("(question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')");
    const pat = likePattern(p.get("q"));
    binds.push(pat, pat);
  }
  const sql =
    `SELECT ${LIST_COLUMNS} FROM chat_logs` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY id DESC LIMIT ?";
  const { results } = await db.prepare(sql).bind(...binds, limit).all();
  const logs = (results || []).map((r) => projectChatLog(r));

  if (p.get("format") === "text") {
    return textResponse(formatChatLogsText(logs));
  }
  return jsonResponse({ logs, count: logs.length });
}

/** @param {string} text */
function textResponse(text) {
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
