// @ts-check
// The SHARED admission preamble for the side LLM endpoints — the three
// request paths that spend on a model outside /api/chat and had each
// re-inlined the identical nine lines under the same apologetic comment
// ("Same quota gate as /api/chat and …"):
//
//   POST /api/orchestrator/plan  (src/orchestrator-api.js)
//   POST /api/quiz/grade         (src/quiz-api.js)
//   POST /api/bash/step          (src/bash-api.js)
//
// Sharing it is drift control on a cost-control invariant, not tidying: the
// gate is what keeps a quota enforceable and per-user concurrency bounded, so
// a fix applied to one copy — a new quota dimension, a change to who bypasses
// it — would leave the other endpoints silently unenforced.
//
// /api/chat deliberately does NOT use this. Its own gate (chat.js
// enforceQuotaGate) additionally logs `chat.quota_blocked` and files a
// user-facing `quota_exceeded` message; it is a richer variant, not a fourth
// copy of this one.
//
// A leaf over the pieces it composes (quota.js, config.js, http.js) and
// nothing else, so importing it pulls no endpoint's graph into another's.

import { getConfig } from "./config.js";
import { jsonResponse } from "./http.js";
import {
  effectiveQuota,
  getUsage,
  inflightLimitResponse,
  quotaBlockedResponse,
  quotaExceeded,
  reserveInflight,
} from "./quota.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./settings.js').Identity} Identity */

/**
 * Runs the quota gate, then reserves this request's concurrency slot.
 *
 * The quota gate is the same one /api/chat applies (admins are never blocked).
 * The reservation is the per-user concurrency limit (M-1/M-2) — the CALLER
 * still owns releasing it, in a `finally` covering every exit path, because
 * only the caller knows where its work ends. `reqId` is minted here because
 * none of these endpoints is threaded a request id. Fail-soft throughout:
 * reserveInflight returns ok on any D1 trouble, so accounting problems never
 * close an endpoint.
 *
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<{ response: Response, reqId: null } | { response: null, reqId: string }>}
 *   `response` set means STOP and return it (429). Otherwise the slot is
 *   reserved and `reqId` is the handle to release.
 */
export async function enforceQuotaAndReserve(env, identity) {
  const config = await getConfig(env);
  const usage = await getUsage(env, identity.id, Date.now(), identity.user?.quota_reset_at);
  const quota =
    identity.isSecretAdmin || identity.role === "admin" ? null : effectiveQuota(config, identity.user);
  const blocked = quota ? quotaExceeded(usage, quota) : null;
  if (blocked) return { response: jsonResponse(quotaBlockedResponse(blocked), 429), reqId: null };

  const reqId = crypto.randomUUID();
  const reserved = await reserveInflight(env, identity.id, reqId);
  if (!reserved.ok) return { response: jsonResponse(inflightLimitResponse(reserved), 429), reqId: null };

  return { response: null, reqId };
}
