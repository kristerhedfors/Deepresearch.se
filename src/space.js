// @ts-check
// The SPACE-ANIMATIONS domain's server FAÇADE: a pure re-export of the ONE
// shared core public/js/space-core.js (the scene registry — one entry per
// "animation skill" answering a common space question — the deterministic
// EN+SV question matcher, and the feedback validator), plus the two endpoints
// the domain owns:
//
//   POST /api/space/feedback        PUBLIC — the showcase gallery at /space/
//                                   is unauthenticated, so its feedback is
//                                   too. The row carries scene id + verdict +
//                                   a short clamped comment ONLY: no identity
//                                   exists on that page and none is invented
//                                   (the privacy posture's default: outbound
//                                   and stored minimums).
//   GET  /api/admin/space-feedback  the operator read surface (admin-gated in
//                                   admin-api.js), chatlogs-style, with the
//                                   ?format=text render agent loops consume.
//
// Fail posture: no D1 → 503 with a clear message (there is nothing to store
// into), matching the other D1-backed queues. The PAGE keeps working — only
// the feedback button degrades.
//
// The core lives under public/ for the same reason bash-core.js does: the
// browser can only import served modules, the Worker bundler imports from
// anywhere — one implementation, two faces. See the space-animations skill.

import { jsonResponse, textResponse } from "./http.js";
import { getDb } from "./db.js";
import {
  SPACE_SCENES,
  SPACE_MATCHERS,
  sceneById,
  spaceIntent,
  validateSpaceFeedback,
  FEEDBACK_COMMENT_MAX,
} from "../public/js/space-core.js";

export { SPACE_SCENES, SPACE_MATCHERS, sceneById, spaceIntent, validateSpaceFeedback, FEEDBACK_COMMENT_MAX };

// A feedback POST is tiny by construction (scene id + verdict + a ≤500-char
// comment); anything larger is not a feedback body.
const BODY_MAX = 4096;

/**
 * PUBLIC POST /api/space/feedback — records one gallery verdict.
 * @param {Request} request
 * @param {Env} env
 * @param {{ info: Function, warn: Function }} log
 * @returns {Promise<Response>}
 */
export async function handleSpaceFeedback(request, env, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Feedback storage is not available." }, 503);
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return jsonResponse({ error: "Unreadable body." }, 400);
  }
  if (raw.length > BODY_MAX) return jsonResponse({ error: "Body too large." }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  const v = validateSpaceFeedback(body);
  if (!v.ok || !v.value) return jsonResponse({ error: v.error || "Invalid feedback body." }, 400);
  const { scene, verdict, comment } = v.value;
  await db
    .prepare("INSERT INTO space_feedback (ts, scene, verdict, comment) VALUES (?, ?, ?, ?)")
    .bind(Date.now(), scene, verdict, comment || null)
    .run();
  log.info("space.feedback", { scene, verdict, has_comment: comment ? 1 : 0 });
  return jsonResponse({ ok: true });
}

/**
 * ADMIN GET /api/admin/space-feedback — newest first, with per-scene tallies.
 * ?format=text renders the loop-consumable plain-text view; ?limit=N caps
 * the rows (default 200).
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleAdminSpaceFeedback(request, env, url) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database is not configured." }, 503);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit")) || 200));
  const rows =
    (
      await db
        .prepare("SELECT id, ts, scene, verdict, comment FROM space_feedback ORDER BY id DESC LIMIT ?")
        .bind(limit)
        .all()
    ).results || [];
  /** @type {Record<string, { up: number, down: number }>} */
  const tally = {};
  for (const s of SPACE_SCENES) tally[s.id] = { up: 0, down: 0 };
  const counts =
    (
      await db
        .prepare("SELECT scene, verdict, COUNT(*) AS n FROM space_feedback GROUP BY scene, verdict")
        .all()
    ).results || [];
  for (const c of counts) {
    const t = tally[String(c.scene)];
    const verdict = String(c.verdict);
    if (t && (verdict === "up" || verdict === "down")) t[verdict] = Number(c.n);
  }
  if (url.searchParams.get("format") === "text") {
    const lines = ["SPACE-ANIMATIONS FEEDBACK (newest first)", ""];
    for (const s of SPACE_SCENES) {
      lines.push(`${s.id}: 👍 ${tally[s.id].up} / 👎 ${tally[s.id].down}`);
    }
    lines.push("");
    for (const r of rows) {
      const when = new Date(Number(r.ts)).toISOString();
      lines.push(`#${r.id} ${when} ${r.scene} ${r.verdict === "up" ? "👍" : "👎"}${r.comment ? ` — ${r.comment}` : ""}`);
    }
    return textResponse(lines.join("\n") + "\n");
  }
  return jsonResponse({ tally, entries: rows });
}

/** @typedef {import('./types.js').Env} Env */
