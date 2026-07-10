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

import { completeJson, DEFAULT_MODEL, listModels } from "./berget.js";
import { quotaBlockedResponse } from "./chat.js";
import { getConfig } from "./config.js";
import { jsonResponse } from "./http.js";
import { quizGradePrompt } from "./prompts.js";
import { bergetCost, effectiveQuota, getUsage, quotaExceeded, recordUsage } from "./quota.js";
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
  const usage = await getUsage(env, identity.id);
  const quota =
    identity.isSecretAdmin || identity.role === "admin"
      ? null
      : effectiveQuota(config, identity.user);
  const blocked = quota ? quotaExceeded(usage, quota) : null;
  if (blocked) return jsonResponse(quotaBlockedResponse(blocked), 429);

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
    await recordGradeUsage(env, log, identity, r.usage, Date.now() - startedAt);
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
  }
}

// Grading spends real (tiny) Berget money on DEFAULT_MODEL — record it like
// every other spend, priced from the catalog (fail-soft: an unreachable
// catalog records the tokens at zero cost rather than failing the grade).
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {{ prompt_tokens?: number, completion_tokens?: number } | null | undefined} usage
 * @param {number} durationMs
 */
async function recordGradeUsage(env, log, identity, usage, durationMs) {
  let entry = null;
  try {
    entry = (await listModels(env))?.find((m) => m.id === DEFAULT_MODEL) || null;
  } catch {
    entry = null;
  }
  const prompt_tokens = usage?.prompt_tokens || 0;
  const completion_tokens = usage?.completion_tokens || 0;
  await recordUsage(env, log, {
    user_id: identity.id,
    model: DEFAULT_MODEL,
    prompt_tokens,
    completion_tokens,
    searches: 0,
    berget_cost: bergetCost(entry, prompt_tokens, completion_tokens),
    exa_cost: 0,
    duration_ms: durationMs,
  });
}
