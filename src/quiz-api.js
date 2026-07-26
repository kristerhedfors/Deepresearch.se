// @ts-check
// POST /api/quiz/grade — grades a quiz's FREE-TEXT answers (the "answer in
// your own words" field public/js/quiz.js offers under the alternatives).
// Multiple-choice picks never come here — the quiz payload carries the key
// and the client grades them locally; only free text needs a model's
// judgement (meaning over wording, any language). One JSON-mode call on the
// fixed reliable DEFAULT_MODEL — same routing rationale as the pipeline's
// JSON phases — with the same quota gate and usage accounting as /api/embed:
// all spend is visible, admins are never blocked.
//
// Fail-soft contract with the client: any failure here is a plain error
// response, and the client marks the answer "ungraded" (excluded from the
// score with a visible note) rather than breaking the quiz.

import { completeJson, DEFAULT_MODEL } from "./berget.js";
import { quotaBlockedResponse } from "./quota.js";
import { getConfig } from "./config.js";
import { jsonResponse } from "./http.js";
import { quizGradePrompt } from "./prompts.js";
import {
  effectiveQuota,
  getUsage,
  inflightLimitResponse,
  quotaExceeded,
  recordDefaultModelUsage,
  releaseInflight,
  reserveInflight,
} from "./quota.js";
import { normalizeGradeResults, validateGradeItems } from "./quiz.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleQuizGrade(request, env, log, identity) {
  if (!env.BERGET_API_TOKEN) {
    return jsonResponse({ error: "Server not configured: BERGET_API_TOKEN secret is missing." }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const { items, error } = validateGradeItems(body);
  if (typeof error === "string" || !items) return jsonResponse({ error }, 400);

  // Same quota gate as /api/chat and /api/embed (admins never blocked).
  const config = await getConfig(env);
  const usage = await getUsage(env, identity.id, Date.now(), identity.user?.quota_reset_at);
  const quota =
    identity.isSecretAdmin || identity.role === "admin"
      ? null
      : effectiveQuota(config, identity.user);
  const blocked = quota ? quotaExceeded(usage, quota) : null;
  if (blocked) return jsonResponse(quotaBlockedResponse(blocked), 429);

  // Per-user concurrency reservation (M-1/M-2), released in the finally below
  // on every exit path. reqId minted locally (this endpoint isn't threaded a
  // request id). Fail-soft: reserve returns ok on any D1 trouble.
  const reqId = crypto.randomUUID();
  const reserved = await reserveInflight(env, identity.id, reqId);
  if (!reserved.ok) return jsonResponse(inflightLimitResponse(reserved), 429);

  const startedAt = Date.now();
  try {
    const r = await completeJson(
      env,
      [
        { role: "system", content: quizGradePrompt() },
        {
          role: "user",
          content: items
            .map(
              (it, i) =>
                `Item ${i + 1}:\nQuestion: ${it.question}\nReference answer: ${it.reference}\nUser's answer: ${it.answer}`,
            )
            .join("\n\n"),
        },
      ],
      { model: DEFAULT_MODEL, maxTokens: 150 * items.length + 200 },
    );
    await recordDefaultModelUsage(env, log, identity, r.usage, Date.now() - startedAt);
    const results = normalizeGradeResults(r.value, items.length);
    if (!results) {
      log.warn("quiz.grade_unparseable", { user_id: identity.id, items: items.length, ...r.diagnostics });
      return jsonResponse({ error: "Grading produced no usable verdict." }, 502);
    }
    log.info("quiz.grade", { user_id: identity.id, items: items.length });
    return jsonResponse({ results });
  } catch (err) {
    log.error("quiz.grade_failed", { user_id: identity.id, error: (/** @type {any} */ (err))?.message || String(err) });
    return jsonResponse({ error: "Grading service unavailable." }, 502);
  } finally {
    await releaseInflight(env, reqId);
  }
}

