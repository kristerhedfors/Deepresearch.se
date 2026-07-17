// @ts-check
// POST /api/bash/step — ONE turn of the experimental bash-lite agent loop
// (src/bash-agent.js; the `bash_lite_mcp` knob). The sandbox itself is an
// x86 Linux emulator running IN THE BROWSER (CheerpX), so the loop is
// client-orchestrated (public/js/bash-agent.js for DRS): the browser sends
// the conversation plus the transcript of commands it has already run, this
// endpoint asks the reliable model what to run NEXT, and returns the parsed
// command proposal for the browser to execute. When the model is done, the
// client stops looping and folds the transcript into the /api/chat request
// (chat.js `shell_transcript`) as a synthesis context block.
//
// NO function calling (invariant 1): the model replies with a plain fenced
// ```bash block (bashAgentPrompt); parseShellRequest turns it into commands.
// Runs on the fixed reliable DEFAULT_MODEL — command choice must be
// dependable regardless of the user's answer-model pick — with the same quota
// gate and usage accounting as /api/quiz/grade (all spend visible; admins
// never blocked). Fully fail-soft: any failure returns done=true so the
// client stops the loop and answers normally.

import { chatCompletion, listChatModels } from "./providers.js";
import { consumeChatStream, DEFAULT_MODEL } from "./berget.js";
import { quotaBlockedResponse } from "./quota.js";
import { formatConversation, lastUserMessage, textOf } from "./conversation.js";
import { getConfig } from "./config.js";
import { jsonResponse } from "./http.js";
import { bashAgentPrompt } from "./prompts.js";
import {
  bergetCost,
  effectiveQuota,
  getUsage,
  inflightLimitResponse,
  quotaExceeded,
  recordUsage,
  releaseInflight,
  reserveInflight,
} from "./quota.js";
import { bashLiteEnabled, developerModeEnabled } from "./settings.js";
import {
  MAX_SHELL_ROUNDS,
  buildShellTranscript,
  buildStepUserMessage,
  normalizeExecResult,
  parseShellRequest,
} from "./bash-agent.js";
import { validateMessages } from "./validation.js";

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
export async function handleBashStep(request, env, log, identity) {
  if (!env.BERGET_API_TOKEN) {
    return jsonResponse({ error: "Server not configured: BERGET_API_TOKEN secret is missing." }, 500);
  }
  // The knob must be on for this account (a browser capability, so this only
  // needs a user row + the stored flag). A client that calls this with the
  // knob off gets a clean stop, not an error.
  if (!bashLiteEnabled(env, identity)) {
    return jsonResponse({ error: "The execution sandbox is not enabled.", done: true }, 403);
  }

  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const invalid = validateMessages(body?.messages);
  if (invalid) return jsonResponse({ error: invalid }, 400);

  // The prior sandbox runs the client has already executed (untrusted — clamp
  // every field). Bounded so a client cannot grow the prompt without limit:
  // the loop caps at MAX_SHELL_ROUNDS rounds × a few commands each.
  const rawTranscript = Array.isArray(body?.transcript) ? body.transcript.slice(0, MAX_SHELL_ROUNDS * 8) : [];
  const transcript = rawTranscript
    .filter((/** @type {any} */ r) => r && typeof r === "object" && typeof r.command === "string" && r.command.trim())
    .map((/** @type {any} */ r) => normalizeExecResult(r.command, r));

  // Same quota gate as /api/chat and /api/quiz/grade (admins never blocked).
  const config = await getConfig(env);
  const usage = await getUsage(env, identity.id);
  const quota =
    identity.isSecretAdmin || identity.role === "admin" ? null : effectiveQuota(config, identity.user);
  const blocked = quota ? quotaExceeded(usage, quota) : null;
  if (blocked) return jsonResponse(quotaBlockedResponse(blocked), 429);

  // Per-user concurrency reservation (M-1/M-2), released in the finally below
  // on every exit path. reqId minted locally; fail-soft on any D1 trouble.
  const reqId = crypto.randomUUID();
  const reserved = await reserveInflight(env, identity.id, reqId);
  if (!reserved.ok) return jsonResponse(inflightLimitResponse(reserved), 429);

  // The per-round user message is the shared builder (bash-core.js), so DRS
  // and DRC ask the model the exact same step question.
  const userContent = buildStepUserMessage({
    task: textOf(lastUserMessage(body.messages)?.content),
    context: formatConversation(body.messages),
    priorBlock: buildShellTranscript(transcript),
  });

  const startedAt = Date.now();
  try {
    const resp = await chatCompletion(
      env,
      [
        // Developer mode mounts the site's own source at /src in the VM
        // (stream.js provider) — tell the step model so it explores it there.
        { role: "system", content: bashAgentPrompt({ sourceMounted: developerModeEnabled(env, identity) }) },
        { role: "user", content: userContent },
      ],
      { model: DEFAULT_MODEL },
    );
    if (!resp.ok || !resp.body) {
      const detail = resp.text ? await resp.text().catch(() => "") : "";
      log.warn("bash.step_upstream_error", { user_id: identity.id, status: resp.status, detail: detail.slice(0, 200) });
      // Fail soft: tell the client to stop the loop rather than erroring.
      return jsonResponse({ commands: [], done: true, reasoning: "" });
    }
    const { text, usage: streamUsage } = await consumeChatStream(resp.body, () => {}, { idleMs: 30_000, maxMs: 60_000 });
    await recordStepUsage(env, log, identity, streamUsage, Date.now() - startedAt);
    const proposal = parseShellRequest(text);
    log.info("bash.step", {
      user_id: identity.id,
      prior_runs: transcript.length,
      commands: proposal.commands.length,
      done: proposal.done,
    });
    // Debug: the actual proposed commands (model-generated, not user content),
    // bounded — so heavy testing can trace exactly what the loop ran via the
    // log URL when LOG_LEVEL=debug.
    log.debug("bash.step_commands", {
      user_id: identity.id,
      commands: proposal.commands.map((c) => String(c).slice(0, 200)).slice(0, 6),
    });
    return jsonResponse(proposal);
  } catch (err) {
    log.error("bash.step_failed", { user_id: identity.id, error: (/** @type {any} */ (err))?.message || String(err) });
    // Fail soft — the client stops the loop and the pipeline answers normally.
    return jsonResponse({ commands: [], done: true, reasoning: "" });
  } finally {
    await releaseInflight(env, reqId);
  }
}

// The step spends real (small) Berget money on DEFAULT_MODEL — record it like
// every other spend, priced from the catalog (fail-soft: an unreachable
// catalog records the tokens at zero cost rather than failing the step).
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {{ prompt_tokens?: number, completion_tokens?: number } | null | undefined} usage
 * @param {number} durationMs
 */
async function recordStepUsage(env, log, identity, usage, durationMs) {
  let entry = null;
  try {
    entry = (await listChatModels(env))?.find((m) => m.id === DEFAULT_MODEL) || null;
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
