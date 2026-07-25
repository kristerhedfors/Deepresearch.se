// @ts-check
// The COMPUTE-SHARING broker (docs/COMPUTE-SHARING.md). A signed-in sharer
// lends their local OpenAI-compatible model; the server is a thin BROKER that
// parks a consumer's completion request in a D1 job queue, the sharer's browser
// pulls it, runs it locally, and posts the result back. No Durable Objects, no
// WebSockets — a D1-backed job queue with HTTP long-poll, mirroring the grant
// meters (src/server-grants.js) so the reserve/refund/adjust/revoke discipline
// is identical and the whole feature is FAIL-SAFE (no D1 ⇒ 503, never an
// unmetered path).
//
// Three actors, one pool per sharer account (pool_id == account id):
//   PROVIDER  — an online browser tab serving a pool (register → poll → result).
//   CONSUMER  — holds a pool token; submits jobs (POST /api/pool/llm/*).
//   BROKER    — this module + the pool_* tables.
//
// MUTUAL CONSENT (owner directive, 2026-07-25): holding a token is capacity,
// not consent. A pooled completion crosses a trust boundary twice and BOTH
// crossings are gated on a remembered, per-identity decision —
//   INGRESS  the SHARER allows this consumer identity onto their machine
//            (pool_consumers.state),
//   EGRESS   the CONSUMER allows their prompts to leave for this pool owner
//            (pool_egress.state).
// Each side is shown the other's PLATFORM-VERIFIED identity (resolved from a
// session by the router — never a self-asserted string in the request), the
// first job from an unknown pair parks both questions as `pending` and is
// refused, and once answered the answer sticks. The vocabulary is in the
// shared pure core (public/js/pool-core.js) so client and server ask exactly
// the same question.
//
// THE POOL-TOKEN GUARANTEE (src/pool-token.js): a pool token authorizes ONLY
// submitting completion jobs to the ONE pool it names; it is never a login and
// unlocks no Se/rver data. Its ONE disclosed difference from a Se/rver token is
// that the prompt is read by the pool owner's machine — the feature, disclosed
// at the point of use. This module touches ONLY the pool_* tables and relays to
// a pool's own providers; it imports no data-bearing module (pinned by
// src/pool.test.js's module-graph assertion).

import { getConfig } from "./config.js";
import { getDb } from "./db.js";
import {
  GRANTS_LIST_MAX,
  adjustResultResponse,
  budgetExceeded409,
  posInt,
  readTokenBody,
  resolveQuotaPatch,
} from "./grant-http.js";
import { jsonResponse } from "./http.js";
import { mintPoolToken, verifyPoolToken } from "./pool-token.js";
import {
  normalizeApproval,
  poolConsumerKey,
  poolEgressQuestion,
  poolIngressQuestion,
  sanitizePoolRequest,
} from "../public/js/pool-core.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./auth.js').Identity} Identity */

// Bound the request the broker will park + relay (a completion body). Same
// spirit as the proxy body cap: a pool must not be an amplifier.
const REQUEST_MAX_CHARS = 200_000;

/**
 * The effective defaults + governance, resolved from site config.
 * @typedef {Object} PoolDefaults
 * @property {boolean} enabled master switch
 * @property {number} quota default per-token quota (0 = uncapped)
 * @property {number} ttlHours default token lifetime
 * @property {number} budget global outstanding-remaining ceiling (0 = uncapped)
 * @property {number} providerStaleS a provider not seen in this many seconds is offline
 * @property {number} claimStaleS a claimed job not finished in this long requeues
 * @property {number} jobTtlS a job the consumer waits on this long, then times out
 * @property {number} waitMs how long a single poll / submit request blocks server-side
 */

/** @param {Env} env @returns {Promise<PoolDefaults>} */
export async function poolDefaults(env) {
  const c = (await getConfig(env)).pool || {};
  return {
    enabled: c.enabled !== false,
    quota: Number.isFinite(c.quota) && c.quota >= 0 ? Math.floor(c.quota) : 0,
    ttlHours: posInt(c.ttl_hours, 24),
    budget: Number.isFinite(c.budget) && c.budget > 0 ? Math.floor(c.budget) : 0,
    providerStaleS: posInt(c.provider_stale_s, 45),
    claimStaleS: posInt(c.claim_stale_s, 60),
    jobTtlS: posInt(c.job_ttl_s, 120),
    waitMs: posInt(c.wait_ms, 20_000),
  };
}

const nowS = () => Math.floor(Date.now() / 1000);
/** @param {number} ms @param {AbortSignal} [signal] */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });

// ── provider registry ──────────────────────────────────────────────────────

/**
 * Register (or refresh) an online provider tab for a pool. Returns the
 * provider_id the browser then polls with.
 * @param {D1Database} db
 * @param {{ poolId: string, userId: string, label?: string|null, owner?: string|null, models?: string[], concurrency?: number }} opts
 * @returns {Promise<string>}
 */
export async function registerProvider(db, opts) {
  const providerId = crypto.randomUUID();
  const t = nowS();
  const models = JSON.stringify((opts.models || []).slice(0, 100).map(String));
  const concurrency = Math.min(8, Math.max(1, Math.floor(Number(opts.concurrency) || 1)));
  await db
    .prepare(
      "INSERT INTO pool_providers (provider_id, pool_id, user_id, label, owner, models_json, concurrency, created_at, last_seen_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
    )
    .bind(
      providerId,
      String(opts.poolId),
      String(opts.userId),
      opts.label ? String(opts.label).slice(0, 80) : null,
      // The sharer's platform-verified identity, captured from the session at
      // registration — this is what a consumer is shown when asked to approve
      // egress, so it can never be a string the consumer's side made up.
      opts.owner ? String(opts.owner).slice(0, 120) : null,
      models,
      concurrency,
      t,
    )
    .run();
  return providerId;
}

/** Heartbeat: bump a provider's last_seen_at. Returns false if the row is gone.
 * @param {D1Database} db @param {string} providerId @param {string} poolId */
export async function heartbeatProvider(db, providerId, poolId) {
  const r = await db
    .prepare("UPDATE pool_providers SET last_seen_at = ?3 WHERE provider_id = ?1 AND pool_id = ?2")
    .bind(String(providerId), String(poolId), nowS())
    .run()
    .catch(() => null);
  return !!r && Number(r?.meta?.changes || 0) >= 1;
}

/** Drop a provider row (the sharer turned sharing off / closed the tab).
 * @param {D1Database} db @param {string} providerId @param {string} poolId */
export async function unregisterProvider(db, providerId, poolId) {
  await db
    .prepare("DELETE FROM pool_providers WHERE provider_id = ?1 AND pool_id = ?2")
    .bind(String(providerId), String(poolId))
    .run()
    .catch(() => {});
}

/**
 * Is a provider ONLINE for this pool (and, if `model` given, advertising it)?
 * The consumer's fast fail-soft check before parking a job.
 * @param {D1Database} db @param {string} poolId @param {string|null} model @param {number} staleS
 * @returns {Promise<boolean>}
 */
export async function poolHasCapacity(db, poolId, model, staleS) {
  const cutoff = nowS() - staleS;
  const res = await db
    .prepare("SELECT models_json FROM pool_providers WHERE pool_id = ?1 AND last_seen_at > ?2")
    .bind(String(poolId), cutoff)
    .all()
    .catch(() => ({ results: [] }));
  const rows = res.results || [];
  if (!rows.length) return false;
  if (!model) return true;
  // A provider advertising NO models is treated as accepting anything (a bare
  // local server the sharer didn't enumerate); otherwise the model must match.
  for (const r of rows) {
    let models = [];
    try { models = JSON.parse(String(r.models_json || "[]")); } catch { models = []; }
    if (!models.length || models.includes(model)) return true;
  }
  return false;
}

// ── the job queue ───────────────────────────────────────────────────────────

/**
 * Requeue any of a pool's jobs whose provider vanished mid-run (claimed but not
 * finished within claimStaleS). Keeps a dropped provider from stranding a
 * consumer. Returns the number requeued.
 * @param {D1Database} db @param {string} poolId @param {number} claimStaleS
 */
export async function requeueStaleJobs(db, poolId, claimStaleS) {
  const r = await db
    .prepare("UPDATE pool_jobs SET status = 'queued', provider_id = NULL WHERE pool_id = ?1 AND status = 'claimed' AND claimed_at < ?2")
    .bind(String(poolId), nowS() - claimStaleS)
    .run()
    .catch(() => null);
  return Number(r?.meta?.changes || 0);
}

/**
 * Atomically claim the oldest queued job for a pool. Selects a candidate, then
 * a guarded UPDATE (status still 'queued') wins it — a lost race (changes=0)
 * retries the next candidate. Returns the claimed job or null.
 * @param {D1Database} db @param {string} poolId @param {string} providerId
 * @returns {Promise<{ job_id: string, model: string|null, request: any } | null>}
 */
export async function claimJob(db, poolId, providerId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cand = await db
      .prepare("SELECT job_id, model, request_json FROM pool_jobs WHERE pool_id = ?1 AND status = 'queued' ORDER BY created_at LIMIT 1")
      .bind(String(poolId))
      .first()
      .catch(() => null);
    if (!cand) return null;
    const won = await db
      .prepare("UPDATE pool_jobs SET status = 'claimed', provider_id = ?2, claimed_at = ?3 WHERE job_id = ?1 AND status = 'queued'")
      .bind(String(cand.job_id), String(providerId), nowS())
      .run()
      .catch(() => null);
    if (won && Number(won?.meta?.changes || 0) >= 1) {
      let request = null;
      try { request = JSON.parse(String(cand.request_json)); } catch { request = null; }
      return { job_id: String(cand.job_id), model: cand.model ? String(cand.model) : null, request };
    }
  }
  return null;
}

/**
 * Enqueue a consumer's completion request. Returns the job_id.
 * @param {D1Database} db
 * @param {{ poolId: string, consumerKey: string, tokenJti: string, model: string|null, request: any, jobTtlS: number }} opts
 * @returns {Promise<string>}
 */
export async function enqueueJob(db, opts) {
  const jobId = crypto.randomUUID();
  const t = nowS();
  await db
    .prepare(
      "INSERT INTO pool_jobs (job_id, pool_id, consumer_key, token_jti, status, model, request_json, created_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, ?8)",
    )
    .bind(jobId, String(opts.poolId), String(opts.consumerKey), String(opts.tokenJti), opts.model ? String(opts.model) : null, JSON.stringify(opts.request), t, t + opts.jobTtlS)
    .run();
  return jobId;
}

/**
 * A provider posts a job's result (or error). Guarded on status='claimed' by
 * this provider so a stale/foreign post can't overwrite a requeued job.
 * @param {D1Database} db
 * @param {{ providerId: string, jobId: string, response?: any, error?: string, promptTokens?: number, completionTokens?: number }} opts
 * @returns {Promise<boolean>} whether the job was updated
 */
export async function completeJob(db, opts) {
  const isError = opts.error != null && opts.response == null;
  const r = await db
    .prepare(
      "UPDATE pool_jobs SET status = ?5, response_json = ?6, error = ?7, prompt_tokens = ?8, completion_tokens = ?9, done_at = ?4 " +
        "WHERE job_id = ?1 AND provider_id = ?2 AND status = 'claimed'",
    )
    .bind(
      String(opts.jobId),
      String(opts.providerId),
      null,
      nowS(),
      isError ? "error" : "done",
      isError ? null : JSON.stringify(opts.response ?? null),
      isError ? String(opts.error).slice(0, 500) : null,
      Math.max(0, Math.floor(Number(opts.promptTokens) || 0)),
      Math.max(0, Math.floor(Number(opts.completionTokens) || 0)),
    )
    .run()
    .catch(() => null);
  return !!r && Number(r?.meta?.changes || 0) >= 1;
}

/** Read a job's terminal state (the consumer's wait poll).
 * @param {D1Database} db @param {string} jobId */
export async function readJob(db, jobId) {
  return db
    .prepare("SELECT job_id, status, response_json, error, prompt_tokens, completion_tokens FROM pool_jobs WHERE job_id = ?1")
    .bind(String(jobId))
    .first()
    .catch(() => null);
}

/** Force-expire a job the consumer gave up waiting on (only if not yet done).
 * @param {D1Database} db @param {string} jobId */
export async function expireJob(db, jobId) {
  await db
    .prepare("UPDATE pool_jobs SET status = 'expired' WHERE job_id = ?1 AND status IN ('queued','claimed')")
    .bind(String(jobId))
    .run()
    .catch(() => {});
}

// ── consumers (dashboard aggregate + allow/block list) ───────────────────────

/**
 * Record a consumer's usage against a pool (upsert the aggregate row). Also the
 * place a consumer first appears in the sharer's dashboard.
 * @param {D1Database} db
 * @param {{ poolId: string, consumerKey: string, tokenJti: string, display?: string|null, promptTokens?: number, completionTokens?: number }} opts
 */
export async function bumpConsumer(db, opts) {
  const t = nowS();
  const pt = Math.max(0, Math.floor(Number(opts.promptTokens) || 0));
  const ct = Math.max(0, Math.floor(Number(opts.completionTokens) || 0));
  const display = opts.display ? String(opts.display).slice(0, 120) : String(opts.consumerKey).slice(0, 16);
  const upd = await db
    .prepare(
      "UPDATE pool_consumers SET jobs = jobs + 1, prompt_tokens = prompt_tokens + ?3, completion_tokens = completion_tokens + ?4, last_at = ?5, token_jti = ?6 " +
        "WHERE pool_id = ?1 AND consumer_key = ?2",
    )
    .bind(String(opts.poolId), String(opts.consumerKey), pt, ct, t, String(opts.tokenJti))
    .run()
    .catch(() => null);
  if (upd && Number(upd?.meta?.changes || 0) >= 1) return;
  // A job only ever runs after ingress was ALLOWED (handlePoolLlm), so this
  // insert is the belt-and-braces path for a row deleted mid-flight — it must
  // record the state the decision actually was, never re-open consent.
  await db
    .prepare(
      "INSERT INTO pool_consumers (pool_id, consumer_key, token_jti, display, state, jobs, prompt_tokens, completion_tokens, first_at, last_at) " +
        "VALUES (?1, ?2, ?3, ?4, 'allowed', 1, ?5, ?6, ?7, ?7)",
    )
    .bind(String(opts.poolId), String(opts.consumerKey), String(opts.tokenJti), display, pt, ct, t)
    .run()
    .catch(() => {});
}

/** Is a consumer blocked from a pool? Unknown consumer ⇒ not blocked.
 * @param {D1Database} db @param {string} poolId @param {string} consumerKey */
export async function consumerBlocked(db, poolId, consumerKey) {
  return (await ingressState(db, poolId, consumerKey)) === "blocked";
}

/** Set a consumer's state (block/unblock) — the dashboard "remove user" action.
 * Upserts so a sharer can pre-block a key that hasn't used the pool yet.
 * @param {D1Database} db @param {string} poolId @param {string} consumerKey @param {boolean} blocked */
export async function setConsumerState(db, poolId, consumerKey, blocked) {
  return setIngressDecision(db, poolId, consumerKey, blocked ? "blocked" : "allowed");
}

// ── MUTUAL CONSENT — INGRESS (the sharer's side) ─────────────────────────────

/**
 * The sharer's decision about a consumer identity. An unknown consumer is
 * `pending` (NOT allowed): consent is never implied by holding a token.
 * @param {D1Database} db @param {string} poolId @param {string} consumerKey
 * @returns {Promise<"pending"|"allowed"|"blocked">}
 */
export async function ingressState(db, poolId, consumerKey) {
  const r = await db
    .prepare("SELECT state FROM pool_consumers WHERE pool_id = ?1 AND consumer_key = ?2")
    .bind(String(poolId), String(consumerKey))
    .first()
    .catch(() => null);
  return r ? normalizeApproval(String(r.state)) : "pending";
}

/**
 * Park an ingress REQUEST: the first time an identity reaches a pool, a
 * `pending` row appears in the sharer's dashboard carrying who is asking.
 * Never downgrades an existing decision — this only creates the question.
 * @param {D1Database} db
 * @param {{ poolId: string, consumerKey: string, tokenJti: string, display?: string|null, verified?: boolean }} opts
 * @returns {Promise<"pending"|"allowed"|"blocked">} the state after the touch
 */
export async function touchIngressRequest(db, opts) {
  const t = nowS();
  const display = opts.display ? String(opts.display).slice(0, 120) : String(opts.consumerKey).slice(0, 32);
  // Refresh the identity we show the sharer, but never the state.
  const upd = await db
    .prepare("UPDATE pool_consumers SET display = ?3, identity = ?3, verified = ?4, token_jti = ?5 WHERE pool_id = ?1 AND consumer_key = ?2")
    .bind(String(opts.poolId), String(opts.consumerKey), display, opts.verified ? 1 : 0, String(opts.tokenJti))
    .run()
    .catch(() => null);
  if (upd && Number(upd?.meta?.changes || 0) >= 1) {
    return ingressState(db, opts.poolId, opts.consumerKey);
  }
  await db
    .prepare(
      "INSERT INTO pool_consumers (pool_id, consumer_key, token_jti, display, identity, verified, state, jobs, prompt_tokens, completion_tokens, first_at, last_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'pending', 0, 0, 0, ?6, ?6)",
    )
    .bind(String(opts.poolId), String(opts.consumerKey), String(opts.tokenJti), display, opts.verified ? 1 : 0, t)
    .run()
    .catch(() => {});
  return "pending";
}

/**
 * Record the sharer's answer. Remembered: the row persists, so the question
 * is never asked about this identity again (and a block survives re-mints,
 * because the key is the identity, not the token).
 * @param {D1Database} db @param {string} poolId @param {string} consumerKey
 * @param {"allowed"|"blocked"|"pending"} decision
 */
export async function setIngressDecision(db, poolId, consumerKey, decision) {
  const state = normalizeApproval(decision === "pending" ? "pending" : decision);
  const t = nowS();
  const upd = await db
    .prepare("UPDATE pool_consumers SET state = ?3, decided_at = ?4, last_at = ?4 WHERE pool_id = ?1 AND consumer_key = ?2")
    .bind(String(poolId), String(consumerKey), state, t)
    .run()
    .catch(() => null);
  if (upd && Number(upd?.meta?.changes || 0) >= 1) return true;
  await db
    .prepare(
      "INSERT INTO pool_consumers (pool_id, consumer_key, token_jti, display, identity, verified, state, jobs, prompt_tokens, completion_tokens, first_at, last_at, decided_at) " +
        "VALUES (?1, ?2, NULL, ?3, ?3, 0, ?4, 0, 0, 0, ?5, ?5, ?5)",
    )
    .bind(String(poolId), String(consumerKey), String(consumerKey).slice(0, 32), state, t)
    .run()
    .catch(() => {});
  return true;
}

// ── MUTUAL CONSENT — EGRESS (the consumer's side) ────────────────────────────

/**
 * This consumer's decision about letting their prompts leave for a pool.
 * Unknown ⇒ `pending`, same rule as ingress.
 * @param {D1Database} db @param {string} consumerKey @param {string} poolId
 * @returns {Promise<"pending"|"allowed"|"blocked">}
 */
export async function egressState(db, consumerKey, poolId) {
  const r = await db
    .prepare("SELECT state FROM pool_egress WHERE consumer_key = ?1 AND pool_id = ?2")
    .bind(String(consumerKey), String(poolId))
    .first()
    .catch(() => null);
  return r ? normalizeApproval(String(r.state)) : "pending";
}

/**
 * Park an egress REQUEST: the consumer's client sees this as "you are about
 * to send prompts to <owner> — allow?". Never downgrades an existing answer.
 * @param {D1Database} db
 * @param {{ consumerKey: string, poolId: string, ownerDisplay?: string|null, consumerDisplay?: string|null }} opts
 * @returns {Promise<"pending"|"allowed"|"blocked">}
 */
export async function touchEgressRequest(db, opts) {
  const t = nowS();
  const owner = opts.ownerDisplay ? String(opts.ownerDisplay).slice(0, 120) : null;
  const consumer = opts.consumerDisplay ? String(opts.consumerDisplay).slice(0, 120) : null;
  const upd = await db
    .prepare("UPDATE pool_egress SET owner_display = COALESCE(?3, owner_display), consumer_display = COALESCE(?4, consumer_display) WHERE consumer_key = ?1 AND pool_id = ?2")
    .bind(String(opts.consumerKey), String(opts.poolId), owner, consumer)
    .run()
    .catch(() => null);
  if (upd && Number(upd?.meta?.changes || 0) >= 1) {
    return egressState(db, opts.consumerKey, opts.poolId);
  }
  await db
    .prepare(
      "INSERT INTO pool_egress (consumer_key, pool_id, state, owner_display, consumer_display, first_at) VALUES (?1, ?2, 'pending', ?3, ?4, ?5)",
    )
    .bind(String(opts.consumerKey), String(opts.poolId), owner, consumer, t)
    .run()
    .catch(() => {});
  return "pending";
}

/**
 * Record the consumer's answer about a pool. Remembered per (consumer, pool).
 * @param {D1Database} db @param {string} consumerKey @param {string} poolId
 * @param {"allowed"|"blocked"|"pending"} decision
 */
export async function setEgressDecision(db, consumerKey, poolId, decision) {
  const state = normalizeApproval(decision === "pending" ? "pending" : decision);
  const t = nowS();
  const upd = await db
    .prepare("UPDATE pool_egress SET state = ?3, decided_at = ?4 WHERE consumer_key = ?1 AND pool_id = ?2")
    .bind(String(consumerKey), String(poolId), state, t)
    .run()
    .catch(() => null);
  if (upd && Number(upd?.meta?.changes || 0) >= 1) return true;
  await db
    .prepare("INSERT INTO pool_egress (consumer_key, pool_id, state, first_at, decided_at) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(String(consumerKey), String(poolId), state, t)
    .run()
    .catch(() => {});
  return true;
}

/** The egress decisions a consumer has made (their "who may compute for me" list).
 * @param {D1Database} db @param {string} consumerKey */
export async function listEgress(db, consumerKey) {
  const res = await db
    .prepare("SELECT pool_id, state, owner_display, first_at, decided_at FROM pool_egress WHERE consumer_key = ?1 ORDER BY first_at DESC LIMIT ?2")
    .bind(String(consumerKey), GRANTS_LIST_MAX)
    .all()
    .catch(() => ({ results: [] }));
  return (res.results || []).map((r) => ({
    poolId: String(r.pool_id),
    state: normalizeApproval(String(r.state)),
    ownerDisplay: r.owner_display ? String(r.owner_display) : null,
    firstAt: Number(r.first_at) * 1000,
    decidedAt: r.decided_at ? Number(r.decided_at) * 1000 : null,
  }));
}

// ── the pool-token meter (mirrors src/server-grants.js) ──────────────────────

/** @param {D1Database} db @returns {Promise<number>} sum of remaining across live rows */
async function outstandingRemaining(db) {
  const row = await db
    .prepare("SELECT COALESCE(SUM(quota - used), 0) AS rem FROM pool_tokens WHERE quota > 0 AND expires_at > ?1")
    .bind(nowS())
    .first()
    .catch(() => null);
  return row ? Number(row.rem) : 0;
}

/**
 * Reserve one unit from a token's meter. A quota of 0 is UNCAPPED ("any number
 * of requests") — reservation always succeeds and never decrements. Returns
 * "ok", "exhausted", or "error" (revoked / no row).
 * @param {D1Database} db @param {string} jti
 * @returns {Promise<"ok"|"exhausted"|"error">}
 */
export async function reservePoolUnit(db, jti) {
  const t = nowS();
  // Uncapped rows (quota = 0): count nothing, just confirm the row is live.
  const uncapped = await db
    .prepare("UPDATE pool_tokens SET used = used + 1 WHERE jti = ?1 AND quota = 0 AND expires_at > ?2")
    .bind(String(jti), t)
    .run()
    .catch(() => null);
  if (uncapped && Number(uncapped?.meta?.changes || 0) >= 1) return "ok";
  // Capped rows: the atomic used < quota guard.
  const capped = await db
    .prepare("UPDATE pool_tokens SET used = used + 1 WHERE jti = ?1 AND quota > 0 AND used < quota AND expires_at > ?2")
    .bind(String(jti), t)
    .run()
    .catch(() => null);
  if (capped && Number(capped?.meta?.changes || 0) >= 1) return "ok";
  const row = await db.prepare("SELECT jti FROM pool_tokens WHERE jti = ?1").bind(String(jti)).first().catch(() => null);
  return row ? "exhausted" : "error";
}

/** Refund a reserved unit (a failed job must not burn quota).
 * @param {D1Database} db @param {string} jti */
export async function refundPoolUnit(db, jti) {
  await db
    .prepare("UPDATE pool_tokens SET used = used - 1 WHERE jti = ?1 AND used > 0")
    .bind(String(jti))
    .run()
    .catch(() => {});
}

/**
 * Mint a pool token for a sharer's own pool (pool_id == their account id).
 * @param {Env} env @param {Logger} log
 * @param {{ userId: string, quota?: number, ttlHours?: number, label?: string|null, owner?: string|null, source?: string, defaults?: PoolDefaults }} opts
 * @returns {Promise<{ token: string, jti: string, quota: number, expiresAt: number, label: string|null, source: string, owner: string|null } | { error: string, outstanding?: number, budget?: number } | null>}
 */
export async function mintPoolTokenGrant(env, log, opts) {
  const db = await getDb(env);
  if (!db) return null;
  const defaults = opts.defaults || (await poolDefaults(env));
  const uid = String(opts.userId || "");
  if (!uid) return null;
  const quota = Number.isFinite(opts.quota) && Number(opts.quota) >= 0 ? Math.floor(Number(opts.quota)) : defaults.quota;
  const ttlHours = Number(opts.ttlHours) > 0 ? Number(opts.ttlHours) : defaults.ttlHours;
  const label = opts.label ? String(opts.label).slice(0, 80) : null;
  const source = opts.source || "self";

  if (defaults.budget > 0 && quota > 0) {
    const outstanding = await outstandingRemaining(db);
    if (outstanding + quota > defaults.budget) {
      log.warn("pool.budget_exceeded", { outstanding, quota, budget: defaults.budget });
      return { error: "budget_exceeded", outstanding, budget: defaults.budget };
    }
  }

  const jti = crypto.randomUUID();
  const t = nowS();
  const exp = t + Math.floor(ttlHours * 3600);
  // The minter's verified identity travels with the token row: the consumer's
  // egress question must name the pool owner even before a provider tab is
  // online, and the name must come from the SERVER's view of the session.
  const owner = opts.owner ? String(opts.owner).slice(0, 120) : null;
  const ok = await db
    .prepare(
      "INSERT INTO pool_tokens (jti, pool_id, user_id, quota, used, created_at, expires_at, label, source, owner) " +
        "VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(jti, uid, uid, quota, t, exp, label, source, owner)
    .run()
    .then(() => true)
    .catch((e) => {
      log.warn("pool.mint_failed", { error: String(e?.message || e) });
      return false;
    });
  if (!ok) return null;
  const token = await mintPoolToken(env, { jti, pool: uid, sub: uid, iat: t, exp });
  log.info("pool.token_minted", { jti, pool: uid, source });
  return { token, jti, quota, expiresAt: exp * 1000, label, source, owner };
}

/**
 * The pool-owner identity a consumer is shown: the token row's captured
 * `owner`, falling back to the newest provider registration's, then the raw
 * pool id. Server-sourced in every branch.
 * @param {D1Database} db @param {string} poolId @param {string} jti
 * @returns {Promise<{ display: string, verified: boolean }>}
 */
export async function poolOwnerIdentity(db, poolId, jti) {
  const tok = await db
    .prepare("SELECT owner FROM pool_tokens WHERE jti = ?1")
    .bind(String(jti))
    .first()
    .catch(() => null);
  if (tok && tok.owner) return { display: String(tok.owner), verified: true };
  const prov = await db
    .prepare("SELECT owner FROM pool_providers WHERE pool_id = ?1 AND owner IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1")
    .bind(String(poolId))
    .first()
    .catch(() => null);
  if (prov && prov.owner) return { display: String(prov.owner), verified: true };
  return { display: String(poolId), verified: false };
}

/**
 * Non-consuming status read from a token — the intake client's / dashboard's
 * live "remaining" source.
 * @param {Env} env @param {string} token
 * @returns {Promise<{ jti: string, pool: string, quota: number, used: number, remaining: number|null, expiresAt: number } | null>}
 */
export async function poolTokenStatus(env, token) {
  const claims = await verifyPoolToken(env, token);
  if (!claims) return null;
  const db = await getDb(env);
  if (!db) return null;
  const row = await db
    .prepare("SELECT jti, pool_id, quota, used, expires_at FROM pool_tokens WHERE jti = ?1")
    .bind(claims.jti)
    .first()
    .catch(() => null);
  if (!row) return null;
  const quota = Number(row.quota);
  const used = Number(row.used);
  return {
    jti: String(row.jti),
    pool: String(row.pool_id),
    quota,
    used,
    remaining: quota > 0 ? Math.max(0, quota - used) : null,
    expiresAt: Number(row.expires_at) * 1000,
  };
}

/**
 * Adjust a pool token's quota live (owner-scoped) — the sharer's cap control.
 * @param {Env} env @param {Logger} log @param {string} jti
 * @param {{ quota?: number, delta?: number }} patch
 * @param {{ ownerId?: string, budget?: number }} [opts]
 */
export async function adjustPoolTokenQuota(env, log, jti, patch, opts = {}) {
  const db = await getDb(env);
  if (!db) return null;
  const row = await db
    .prepare("SELECT jti, user_id, quota, used, expires_at FROM pool_tokens WHERE jti = ?1")
    .bind(String(jti))
    .first()
    .catch(() => null);
  if (!row) return { error: "not_found" };
  if (opts.ownerId != null && String(row.user_id) !== String(opts.ownerId)) return { error: "not_found" };
  const current = Number(row.quota);
  const patched = resolveQuotaPatch(current, patch);
  if (patched.error) return { error: patched.error };
  const clamped = patched.clamped;
  const increase = clamped - current;
  const budget = Number(opts.budget) > 0 ? Math.floor(Number(opts.budget)) : 0;
  if (increase > 0 && budget > 0) {
    const outstanding = await outstandingRemaining(db);
    if (outstanding + increase > budget) return { error: "budget_exceeded", outstanding, budget };
  }
  const ok = await db
    .prepare("UPDATE pool_tokens SET quota = ?2 WHERE jti = ?1")
    .bind(String(jti), clamped)
    .run()
    .then((r) => Number(r?.meta?.changes || 0) >= 1)
    .catch(() => false);
  if (!ok) return null;
  log.info("pool.quota_adjusted", { jti: String(jti), from: current, to: clamped });
  return { jti: String(row.jti), quota: clamped, used: Number(row.used), remaining: clamped > 0 ? Math.max(0, clamped - Number(row.used)) : null, expiresAt: Number(row.expires_at) * 1000 };
}

/** Revoke a pool token (delete its meter row — stops working immediately).
 * @param {Env} env @param {string} jti @param {{ ownerId?: string }} [opts] */
export async function revokePoolToken(env, jti, opts = {}) {
  const db = await getDb(env);
  if (!db) return false;
  const q = opts.ownerId != null
    ? db.prepare("DELETE FROM pool_tokens WHERE jti = ?1 AND user_id = ?2").bind(String(jti), String(opts.ownerId))
    : db.prepare("DELETE FROM pool_tokens WHERE jti = ?1").bind(String(jti));
  const r = await q.run().catch(() => null);
  return !!r && Number(r?.meta?.changes || 0) >= 1;
}

/**
 * The sharer's dashboard: their online providers, live tokens, and consumer
 * roster. Scoped to one pool_id (== the owner's account id).
 * @param {D1Database} db @param {string} poolId @param {number} providerStaleS
 */
export async function listPool(db, poolId, providerStaleS) {
  const t = nowS();
  const [prov, toks, cons] = await Promise.all([
    db.prepare("SELECT provider_id, label, models_json, concurrency, created_at, last_seen_at FROM pool_providers WHERE pool_id = ?1 ORDER BY last_seen_at DESC")
      .bind(String(poolId)).all().catch(() => ({ results: [] })),
    db.prepare("SELECT jti, quota, used, created_at, expires_at, label, source FROM pool_tokens WHERE pool_id = ?1 AND expires_at > ?2 ORDER BY created_at DESC LIMIT ?3")
      .bind(String(poolId), t, GRANTS_LIST_MAX).all().catch(() => ({ results: [] })),
    // Pending ingress FIRST: an unanswered question is the one thing on this
    // screen that needs the sharer, so it must never sort below usage rows.
    db.prepare(
      "SELECT consumer_key, display, state, verified, decided_at, jobs, prompt_tokens, completion_tokens, first_at, last_at FROM pool_consumers " +
        "WHERE pool_id = ?1 ORDER BY (state = 'pending') DESC, last_at DESC LIMIT ?2",
    ).bind(String(poolId), GRANTS_LIST_MAX).all().catch(() => ({ results: [] })),
  ]);
  const cutoff = t - providerStaleS;
  return {
    poolId: String(poolId),
    providers: (prov.results || []).map((r) => ({
      providerId: String(r.provider_id),
      label: r.label ? String(r.label) : null,
      models: safeModels(r.models_json),
      concurrency: Number(r.concurrency),
      online: Number(r.last_seen_at) > cutoff,
      lastSeenAt: Number(r.last_seen_at) * 1000,
    })),
    tokens: (toks.results || []).map((r) => ({
      jti: String(r.jti),
      quota: Number(r.quota),
      used: Number(r.used),
      remaining: Number(r.quota) > 0 ? Math.max(0, Number(r.quota) - Number(r.used)) : null,
      label: r.label ? String(r.label) : null,
      source: r.source ? String(r.source) : null,
      createdAt: Number(r.created_at) * 1000,
      expiresAt: Number(r.expires_at) * 1000,
    })),
    consumers: (cons.results || []).map((r) => ({
      consumerKey: String(r.consumer_key),
      display: r.display ? String(r.display) : null,
      // The INGRESS decision, in the shared vocabulary (legacy `active` rows
      // normalize to `allowed`), plus whether the platform actually resolved
      // this consumer from a session — the sharer must be able to tell a
      // named account from a bare token holder before allowing them in.
      state: normalizeApproval(String(r.state)),
      verified: Number(r.verified) === 1,
      decidedAt: r.decided_at ? Number(r.decided_at) * 1000 : null,
      jobs: Number(r.jobs),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      firstAt: Number(r.first_at) * 1000,
      lastAt: Number(r.last_at) * 1000,
    })),
  };
}

/** @param {any} v */
function safeModels(v) {
  try { const m = JSON.parse(String(v || "[]")); return Array.isArray(m) ? m.map(String) : []; } catch { return []; }
}

/** The union of models advertised by a pool's ONLINE providers.
 * @param {D1Database} db @param {string} poolId @param {number} staleS */
export async function advertisedModels(db, poolId, staleS) {
  const res = await db
    .prepare("SELECT models_json FROM pool_providers WHERE pool_id = ?1 AND last_seen_at > ?2")
    .bind(String(poolId), nowS() - staleS)
    .all()
    .catch(() => ({ results: [] }));
  const set = new Set();
  for (const r of res.results || []) for (const m of safeModels(r.models_json)) set.add(m);
  return [...set];
}

// ── endpoints: PROVIDER (authed) ─────────────────────────────────────────────

/**
 * POST /api/pool/register — AUTHED. Register this browser as an online provider
 * for the caller's pool. Body: { label?, models?, concurrency? }.
 * @param {Request} request @param {Env} env @param {Logger} log @param {Identity} identity
 */
export async function handlePoolRegister(request, env, log, identity) {
  const defaults = await poolDefaults(env);
  if (!defaults.enabled) return jsonResponse({ error: "Compute sharing is disabled." }, 503);
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Compute sharing is unavailable." }, 503);
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const poolId = String(identity.id);
  const providerId = await registerProvider(db, {
    poolId,
    userId: poolId,
    label: typeof body.label === "string" ? body.label : null,
    owner: identity.email || identity.name || poolId,
    models: Array.isArray(body.models) ? body.models : [],
    concurrency: body.concurrency,
  });
  log.info("pool.registered", { pool: poolId, providerId });
  return jsonResponse({ providerId, poolId, config: { providerStaleS: defaults.providerStaleS, waitMs: defaults.waitMs } });
}

/**
 * POST /api/pool/poll — AUTHED. Heartbeat + requeue-stale + claim one job for
 * the caller's pool. Body: { providerId }. Blocks up to waitMs for a job.
 * @param {Request} request @param {Env} env @param {Logger} log @param {Identity} identity
 */
export async function handlePoolPoll(request, env, log, identity) {
  const defaults = await poolDefaults(env);
  if (!defaults.enabled) return jsonResponse({ error: "Compute sharing is disabled." }, 503);
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Compute sharing is unavailable." }, 503);
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  const poolId = String(identity.id);
  if (!providerId) return jsonResponse({ error: "providerId is required." }, 400);
  const live = await heartbeatProvider(db, providerId, poolId);
  if (!live) return jsonResponse({ error: "Unknown provider — re-register.", reregister: true }, 409);

  const signal = request.signal;
  const deadline = Date.now() + defaults.waitMs;
  do {
    await requeueStaleJobs(db, poolId, defaults.claimStaleS);
    const job = await claimJob(db, poolId, providerId);
    if (job) return jsonResponse({ job });
    if (Date.now() >= deadline || signal?.aborted) break;
    await sleep(Math.min(1000, Math.max(200, deadline - Date.now())), signal);
    await heartbeatProvider(db, providerId, poolId);
  } while (!signal?.aborted && Date.now() < deadline);
  return jsonResponse({ job: null });
}

/**
 * POST /api/pool/result — AUTHED. A provider posts a job's completion or error.
 * Body: { providerId, jobId, response?, error?, usage? }.
 * @param {Request} request @param {Env} env @param {Logger} log @param {Identity} identity
 */
export async function handlePoolResult(request, env, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Compute sharing is unavailable." }, 503);
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!providerId || !jobId) return jsonResponse({ error: "providerId and jobId are required." }, 400);
  // Confirm the provider belongs to this caller's pool (heartbeat too).
  const live = await heartbeatProvider(db, providerId, String(identity.id));
  if (!live) return jsonResponse({ error: "Unknown provider." }, 409);
  const usage = body.usage || {};
  const ok = await completeJob(db, {
    providerId,
    jobId,
    response: body.response,
    error: typeof body.error === "string" ? body.error : undefined,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
  });
  return jsonResponse({ ok });
}

/**
 * POST /api/pool/unregister — AUTHED. The sharer turned sharing off / the tab
 * is closing. Body: { providerId }.
 * @param {Request} request @param {Env} env @param {Logger} _log @param {Identity} identity
 */
export async function handlePoolUnregister(request, env, _log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ ok: true });
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const providerId = typeof body.providerId === "string" ? body.providerId : "";
  if (providerId) await unregisterProvider(db, providerId, String(identity.id));
  return jsonResponse({ ok: true });
}

// ── endpoints: CONSUMER (public — the token is the authority) ─────────────────

/**
 * /api/pool/llm/* — PUBLIC. The OpenAI-wire consumer surface, so a pool provider
 * entry drives it unchanged (parallel to /api/server-token/llm/*).
 *   GET  /api/pool/llm/models           → the union of online providers' models
 *   POST /api/pool/llm/chat/completions → park a job, wait, return the completion
 *
 * `viewer` is the consumer's PLATFORM-VERIFIED identity when the request also
 * carries a session (the router resolves it; this module never parses auth
 * headers for identity). It is what makes mutual consent about PEOPLE: with a
 * session the consumer is keyed by account and shown to the sharer by their
 * verified address; without one they are only ever as accountable as the
 * token they hold.
 * @param {Request} request @param {Env} env @param {Logger} log @param {URL} url
 * @param {Identity | null} [viewer]
 */
export async function handlePoolLlm(request, env, log, url, viewer = null) {
  const defaults = await poolDefaults(env);
  if (!defaults.enabled) return jsonResponse({ error: "Compute sharing is disabled." }, 503);
  const suffix = url.pathname.replace(/^\/api\/pool\/llm/, "");
  const auth = request.headers.get("authorization") || "";
  const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1] || "";
  const claims = await verifyPoolToken(env, token);
  if (!claims) return jsonResponse({ error: "Invalid or expired pool token." }, 403);
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Compute sharing is unavailable." }, 503);
  const poolId = claims.pool;
  const you = consumerView(viewer, claims.jti);
  const consumerKey = you.key;

  if (suffix === "/models" && request.method === "GET") {
    // Discovery only (no prompt content leaves) — deliberately available
    // before consent, so a consumer can see what they would be choosing.
    const models = await advertisedModels(db, poolId, defaults.providerStaleS);
    return jsonResponse({ object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "pool" })) });
  }

  if (suffix !== "/chat/completions" || request.method !== "POST") {
    return jsonResponse({ error: "Not found." }, 404);
  }

  // ── MUTUAL CONSENT, both gates, BEFORE the body is read ────────────────
  // Refusing here means an unapproved prompt is never parked, never relayed,
  // and never sits in a job row. Each refusal names the identity the other
  // side must approve so the client can render the exact question.
  const owner = await poolOwnerIdentity(db, poolId, claims.jti);
  const ingress = await touchIngressRequest(db, {
    poolId,
    consumerKey,
    tokenJti: claims.jti,
    display: you.display,
    verified: you.verified,
  });
  if (ingress !== "allowed") {
    const q = poolIngressQuestion(you);
    log.info("pool.ingress_" + ingress, { pool: poolId, consumer: consumerKey });
    return jsonResponse(
      {
        error:
          ingress === "blocked"
            ? "The owner of this shared model has blocked your access."
            : "Waiting for the owner of this shared model to approve you.",
        code: ingress === "blocked" ? "ingress_blocked" : "ingress_pending",
        pool: poolId,
        owner,
        you,
        question: q,
      },
      403,
    );
  }
  const egress = await touchEgressRequest(db, {
    consumerKey,
    poolId,
    ownerDisplay: owner.display,
    consumerDisplay: you.display,
  });
  if (egress !== "allowed") {
    const q = poolEgressQuestion(owner);
    log.info("pool.egress_" + egress, { pool: poolId, consumer: consumerKey });
    return jsonResponse(
      {
        error:
          egress === "blocked"
            ? "You declined to send prompts to this shared model."
            : "Approve sending your prompts to this shared model first.",
        code: egress === "blocked" ? "egress_blocked" : "egress_pending",
        pool: poolId,
        owner,
        you,
        question: q,
      },
      403,
    );
  }

  const raw = await request.text().catch(() => "");
  if (raw.length > REQUEST_MAX_CHARS) return jsonResponse({ error: "Request too large." }, 413);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  // The DRSC/1 gate (public/js/pool-core.js): a pooled job carries model +
  // messages + two tuning knobs and NOTHING else. Unknown fields strip, sizes
  // clamp, stream is forced false — the broker relays a fixed whitelisted
  // shape to a peer's machine, never an arbitrary passthrough body.
  const wire = sanitizePoolRequest(parsed);
  if ("error" in wire) return jsonResponse({ error: wire.error, code: wire.code }, 400);
  const bodyObj = wire.request;
  const model = bodyObj.model;

  if (!(await poolHasCapacity(db, poolId, model, defaults.providerStaleS))) {
    return jsonResponse({ error: "No shared compute is online for this pool right now.", code: "no_capacity" }, 503);
  }

  const reserved = await reservePoolUnit(db, claims.jti);
  if (reserved === "error") return jsonResponse({ error: "Pool token not found." }, 403);
  if (reserved === "exhausted") return jsonResponse({ error: "Pool token quota is used up.", remaining: 0 }, 429);

  const jobId = await enqueueJob(db, { poolId, consumerKey, tokenJti: claims.jti, model, request: bodyObj, jobTtlS: defaults.jobTtlS });

  // Wait (bounded by the job TTL) for a provider to answer.
  const signal = request.signal;
  const deadline = Date.now() + defaults.jobTtlS * 1000;
  let final = null;
  while (Date.now() < deadline && !signal?.aborted) {
    const j = await readJob(db, jobId);
    if (j && (j.status === "done" || j.status === "error" || j.status === "expired")) { final = j; break; }
    await sleep(400, signal);
  }

  if (!final || final.status !== "done") {
    await expireJob(db, jobId);
    await refundPoolUnit(db, claims.jti); // an unanswered job must not burn quota
    if (final && final.status === "error") {
      log.info("pool.job_error", { pool: poolId, jobId });
      return jsonResponse({ error: "The shared provider failed to complete the request.", code: "upstream_error" }, 502);
    }
    log.info("pool.job_timeout", { pool: poolId, jobId });
    return jsonResponse({ error: "The shared provider did not answer in time.", code: "timeout" }, 504);
  }

  // Success: attribute usage to the consumer for the sharer's dashboard.
  await bumpConsumer(db, {
    poolId,
    consumerKey,
    tokenJti: claims.jti,
    display: you.display,
    promptTokens: Number(final.prompt_tokens) || 0,
    completionTokens: Number(final.completion_tokens) || 0,
  });
  let response = null;
  try { response = JSON.parse(String(final.response_json)); } catch { response = null; }
  log.info("pool.job_done", { pool: poolId, jobId });
  return jsonResponse(response ?? { error: "Malformed provider response." }, response ? 200 : 502);
}

/**
 * How a CONSUMER is identified to the sharer. A session makes them a person
 * (`u:<id>`, verified, shown by address); without one they are the token
 * (`t:<jti>`, unverified). `synthetic` marks a run-as test persona so no
 * surface ever presents a test identity as a signed-in human.
 * @param {Identity | null | undefined} viewer @param {string} jti
 * @returns {{ key: string, display: string, verified: boolean, synthetic: boolean }}
 */
export function consumerView(viewer, jti) {
  const id = viewer && viewer.id != null ? String(viewer.id) : null;
  return {
    key: poolConsumerKey({ identityId: id, jti }),
    display: id ? String(viewer?.email || viewer?.name || id) : "token " + String(jti).slice(0, 8),
    verified: !!id,
    synthetic: !!(viewer && viewer.synthetic),
  };
}

/**
 * POST /api/pool/status — PUBLIC. Non-consuming read of a pool token's live
 * state (the intake client's "is this still valid / how much left" source).
 * @param {Request} request @param {Env} env
 */
export async function handlePoolStatus(request, env) {
  const token = await readTokenBody(request);
  if (!token) return jsonResponse({ error: "token is required." }, 400);
  const view = await poolTokenStatus(env, token);
  if (!view) return jsonResponse({ error: "Invalid, expired, or revoked pool token." }, 403);
  return jsonResponse(view);
}

/**
 * POST /api/pool/peer — PUBLIC (the token is the authority; a session, when
 * present, names the caller). The MUTUAL-CONSENT status read: who owns this
 * pool, who the platform says you are, and where both approvals stand. Both
 * clients render their question from this one answer, so the two sides can
 * never disagree about what is being asked.
 *
 * Calling it PARKS the questions (a pending row on each side) — that is how a
 * sharer learns someone is waiting without the consumer having to send a
 * prompt first.
 * @param {Request} request @param {Env} env @param {Identity | null} [viewer]
 */
export async function handlePoolPeer(request, env, viewer = null) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return jsonResponse({ error: "token is required." }, 400);
  const claims = await verifyPoolToken(env, token);
  if (!claims) return jsonResponse({ error: "Invalid or expired pool token." }, 403);
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Compute sharing is unavailable." }, 503);
  const poolId = claims.pool;
  const you = consumerView(viewer, claims.jti);
  const owner = await poolOwnerIdentity(db, poolId, claims.jti);
  const ingress = await touchIngressRequest(db, {
    poolId,
    consumerKey: you.key,
    tokenJti: claims.jti,
    display: you.display,
    verified: you.verified,
  });
  const egress = await touchEgressRequest(db, {
    consumerKey: you.key,
    poolId,
    ownerDisplay: owner.display,
    consumerDisplay: you.display,
  });
  return jsonResponse({
    pool: poolId,
    owner,
    you,
    ingress,
    egress,
    ready: ingress === "allowed" && egress === "allowed",
    ingressQuestion: poolIngressQuestion(you),
    egressQuestion: poolEgressQuestion(owner),
  });
}

/**
 * POST /api/pool/egress — PUBLIC (token-authorized). The CONSUMER's half of
 * mutual consent: "yes, my prompts may leave for this person's machine", or
 * no. Remembered per (consumer, pool) and reversible at any time.
 *
 * Deliberately NOT authed-only: a Se/cure consumer holding a workspace pool
 * token has no Se/rver account, and their consent still has to be theirs to
 * give. Holding the token is what proves they are the party being asked.
 * @param {Request} request @param {Env} env @param {Logger} log @param {Identity | null} [viewer]
 */
export async function handlePoolEgress(request, env, log, viewer = null) {
  const body = /** @type {any} */ (await request.json().catch(() => ({})));
  const token = typeof body.token === "string" ? body.token : "";
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Compute sharing is unavailable." }, 503);
  const decision = decisionFrom(body.decision);
  if (!decision) return jsonResponse({ error: "decision must be allow, deny, or reset." }, 400);

  // Two ways to prove you are the party being asked, because the same answer
  // is given from two places. A TOKEN proves it for a Se/cure consumer who
  // has no account; a SESSION proves it for a signed-in one revisiting the
  // decision in Settings → LLM sharing, where the token lives in another
  // browser entirely. Either way the row written is the caller's OWN.
  let poolId = "";
  let jti = "";
  if (token) {
    const claims = await verifyPoolToken(env, token);
    if (!claims) return jsonResponse({ error: "Invalid or expired pool token." }, 403);
    poolId = claims.pool;
    jti = claims.jti;
  } else if (viewer && viewer.id != null && typeof body.pool === "string" && body.pool) {
    poolId = String(body.pool);
  } else {
    return jsonResponse({ error: "token is required." }, 400);
  }
  const you = consumerView(viewer, jti);
  const owner = await poolOwnerIdentity(db, poolId, jti);
  await touchEgressRequest(db, { consumerKey: you.key, poolId, ownerDisplay: owner.display, consumerDisplay: you.display });
  await setEgressDecision(db, you.key, poolId, decision);
  log.info("pool.egress_decision", { pool: poolId, consumer: you.key, decision });
  return jsonResponse({ ok: true, pool: poolId, owner, you, egress: decision });
}

/** allow|deny|reset → the stored state, or null when the word isn't one of them.
 * @param {any} raw @returns {"allowed"|"blocked"|"pending"|null} */
export function decisionFrom(raw) {
  const d = String(raw || "").toLowerCase();
  if (d === "allow" || d === "allowed" || d === "yes") return "allowed";
  if (d === "deny" || d === "blocked" || d === "block" || d === "no") return "blocked";
  if (d === "reset" || d === "pending") return "pending";
  return null;
}

// ── endpoints: SHARER DASHBOARD (authed) ─────────────────────────────────────

/**
 * The authed sharer surface, dispatched by method + subpath under /api/pool.
 *   GET    /api/pool               → the caller's dashboard (providers/tokens/consumers)
 *   POST   /api/pool/token         → mint a pool token for the caller's pool
 *   POST   /api/pool/adjust        → adjust a token's quota (owner-scoped)
 *   POST   /api/pool/block         → block/unblock a consumer_key ("remove user")
 *   POST   /api/pool/revoke        → revoke a token (delete its meter row)
 * (register/poll/result/unregister are their own handlers; routed separately.)
 * @param {Request} request @param {Env} env @param {URL} url @param {Logger} log @param {Identity} identity
 */
export async function handlePoolDashboard(request, env, url, log, identity) {
  const defaults = await poolDefaults(env);
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Compute sharing is unavailable." }, 503);
  const sub = url.pathname.replace(/^\/api\/pool/, "");
  const method = request.method;
  const poolId = String(identity.id);

  if (sub === "" && method === "GET") {
    const view = await listPool(db, poolId, defaults.providerStaleS);
    // BOTH halves of mutual consent on one screen: the ingress questions
    // waiting on you (inside `consumers`), and the egress decisions YOU made
    // about other people's pools — the same account is routinely both a
    // sharer and a consumer, and "LLM sharing" is one surface for both.
    const egress = await listEgress(db, poolConsumerKey({ identityId: poolId, jti: "" }));
    const me = { key: poolConsumerKey({ identityId: poolId, jti: "" }), display: identity.email || identity.name || poolId, verified: true, synthetic: !!identity.synthetic };
    return jsonResponse({
      ...view,
      me,
      egress,
      pendingIngress: view.consumers.filter((c) => c.state === "pending").length,
      pendingEgress: egress.filter((e) => e.state === "pending").length,
      config: { enabled: defaults.enabled, quota: defaults.quota, ttlHours: defaults.ttlHours },
    });
  }

  // The SHARER's half of mutual consent: answer an ingress question. The
  // answer is remembered against the consumer IDENTITY, so it survives token
  // re-mints and a denied peer cannot come back with a fresh link.
  if (sub === "/ingress" && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const key = typeof body.consumerKey === "string" ? body.consumerKey : "";
    const decision = decisionFrom(body.decision);
    if (!key) return jsonResponse({ error: "consumerKey is required." }, 400);
    if (!decision) return jsonResponse({ error: "decision must be allow, deny, or reset." }, 400);
    await setIngressDecision(db, poolId, key, decision);
    log.info("pool.ingress_decision", { pool: poolId, consumer: key, decision });
    return jsonResponse({ ok: true, consumerKey: key, state: decision });
  }

  if (sub === "/token" && method === "POST") {
    if (!defaults.enabled) return jsonResponse({ error: "Compute sharing is disabled." }, 503);
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const minted = await mintPoolTokenGrant(env, log, {
      userId: poolId,
      quota: body.quota,
      ttlHours: body.ttlHours,
      label: typeof body.label === "string" ? body.label : null,
      // Captured from the SESSION, never from the request body — this is the
      // string a consumer's egress question will name.
      owner: identity.email || identity.name || poolId,
      source: body.source === "workspace" ? "workspace" : "self",
      defaults,
    });
    if (!minted) return jsonResponse({ error: "Minting unavailable." }, 503);
    if (/** @type {any} */ (minted).error === "budget_exceeded") return budgetExceeded409(/** @type {any} */ (minted));
    const grant = /** @type {any} */ (minted);
    const link = url.origin + "/cure?pt=" + encodeURIComponent(String(grant.token));
    return jsonResponse({ ...grant, link });
  }

  if (sub === "/adjust" && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const jti = typeof body.jti === "string" ? body.jti : "";
    if (!jti) return jsonResponse({ error: "jti is required." }, 400);
    const adjusted = await adjustPoolTokenQuota(env, log, jti, { quota: body.quota, delta: body.delta }, { ownerId: poolId, budget: defaults.budget });
    return adjustResultResponse(adjusted, "No such token of yours.");
  }

  if (sub === "/block" && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const key = typeof body.consumerKey === "string" ? body.consumerKey : "";
    if (!key) return jsonResponse({ error: "consumerKey is required." }, 400);
    const blocked = body.blocked !== false; // default: block
    await setConsumerState(db, poolId, key, blocked);
    log.info("pool.consumer_state", { pool: poolId, key, blocked });
    return jsonResponse({ ok: true, consumerKey: key, state: blocked ? "blocked" : "active" });
  }

  if (sub === "/revoke" && method === "POST") {
    const body = /** @type {any} */ (await request.json().catch(() => ({})));
    const jti = typeof body.jti === "string" ? body.jti : "";
    if (!jti) return jsonResponse({ error: "jti is required." }, 400);
    const ok = await revokePoolToken(env, jti, { ownerId: poolId });
    log.info("pool.token_revoked", { pool: poolId, jti, ok });
    return jsonResponse({ ok });
  }

  return jsonResponse({ error: "Not found." }, 404);
}

// ── endpoint: ADMIN ──────────────────────────────────────────────────────────

/**
 * /api/admin/pool — ADMIN oversight across ALL pools.
 *   GET          → { config, tokens (live, newest first), providers (online) }
 *   DELETE /:jti → revoke any token
 * The config defaults are edited via the shared PUT /api/admin/config.
 * @param {Request} request @param {Env} env @param {URL} url @param {Logger} log
 */
export async function handleAdminPool(request, env, url, log) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database not configured." }, 503);
  const defaults = await poolDefaults(env);
  const sub = url.pathname.replace(/^\/api\/admin\/pool/, "");
  const method = request.method;

  if (sub === "" && method === "GET") {
    const t = nowS();
    const [toks, prov] = await Promise.all([
      db.prepare("SELECT jti, pool_id, user_id, quota, used, created_at, expires_at, label, source FROM pool_tokens WHERE expires_at > ?1 ORDER BY created_at DESC LIMIT ?2")
        .bind(t, GRANTS_LIST_MAX).all().catch(() => ({ results: [] })),
      db.prepare("SELECT provider_id, pool_id, label, models_json, last_seen_at FROM pool_providers WHERE last_seen_at > ?1 ORDER BY last_seen_at DESC LIMIT ?2")
        .bind(t - defaults.providerStaleS, GRANTS_LIST_MAX).all().catch(() => ({ results: [] })),
    ]);
    return jsonResponse({
      config: defaults,
      tokens: (toks.results || []).map((r) => ({
        jti: String(r.jti), poolId: String(r.pool_id), userId: String(r.user_id),
        quota: Number(r.quota), used: Number(r.used),
        remaining: Number(r.quota) > 0 ? Math.max(0, Number(r.quota) - Number(r.used)) : null,
        label: r.label ? String(r.label) : null, source: r.source ? String(r.source) : null,
        createdAt: Number(r.created_at) * 1000, expiresAt: Number(r.expires_at) * 1000,
      })),
      providers: (prov.results || []).map((r) => ({
        providerId: String(r.provider_id), poolId: String(r.pool_id),
        label: r.label ? String(r.label) : null, models: safeModels(r.models_json),
        lastSeenAt: Number(r.last_seen_at) * 1000,
      })),
    });
  }

  const del = sub.match(/^\/([A-Za-z0-9-]+)$/);
  if (del && method === "DELETE") {
    const ok = await revokePoolToken(env, del[1]);
    log.info("pool.admin_revoked", { jti: del[1], ok });
    return jsonResponse({ ok });
  }

  return jsonResponse({ error: "Not found." }, 404);
}
