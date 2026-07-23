// @ts-check
// The SHARED-COMPUTE PROVIDER LOOP — the sharer's half of compute sharing
// (docs/COMPUTE-SHARING.md §6). While "Share my compute" is ON in a signed-in
// browser tab, this loop long-polls the broker for queued completion jobs,
// runs each against the sharer's LOCAL model (Ollama / LM Studio / llama.cpp
// — whatever serves the DRC `local` provider), and posts the result back.
// Modeled on recovery.js's recoverAnswer discipline: signal-abortable,
// fail-soft, exponential backoff on trouble, and a hard failure cap so a
// broken network can never spin a phone's battery flat.
//
// The loop itself is transport-only and dependency-injected (fetchFn,
// runJob), so it unit-tests in Node without a browser or a broker; drc.js
// wires the real pieces (same-origin fetch, the local-provider call).

import { poolRequestToOpenAiBody } from "./pool-core.js";

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const DEFAULT_MAX_FAILURES = 30; // consecutive transport failures → give up

/** @param {number} ms @param {AbortSignal} [signal] */
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });

/**
 * @param {{
 *   runJob: (openAiBody: any) => Promise<{ response: any, usage?: any }>,
 *   listModels?: () => Promise<string[]>,
 *   label?: string,
 *   fetchFn?: typeof fetch,
 *   onStatus?: (s: { state: "off"|"idle"|"job"|"error", detail?: string, jobs?: number }) => void,
 *   maxFailures?: number,
 * }} opts
 */
export function createPoolProvider(opts) {
  const fetchFn = opts.fetchFn || ((/** @type {any} */ url, /** @type {any} */ init) => fetch(url, init));
  const onStatus = opts.onStatus || (() => {});
  const maxFailures = opts.maxFailures || DEFAULT_MAX_FAILURES;
  /** @type {AbortController | null} */
  let ctl = null;
  /** @type {string | null} */
  let providerId = null;
  let jobsDone = 0;

  /** @param {string} path @param {any} body @param {AbortSignal} [signal] */
  function api(path, body, signal) {
    return fetchFn(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin", // the sharer's own session cookie is the auth
      body: JSON.stringify(body || {}),
      signal,
    });
  }

  async function advertisedModels() {
    try {
      return (await opts.listModels?.()) || [];
    } catch {
      return []; // an unreachable local server advertises nothing (accepts anything)
    }
  }

  /** @param {AbortSignal} signal */
  async function register(signal) {
    const res = await api("/api/pool/register", { label: opts.label || null, models: await advertisedModels(), concurrency: 1 }, signal);
    if (!res.ok) throw new Error("register failed (" + res.status + ")");
    const v = await res.json();
    providerId = String(v.providerId);
  }

  /** @param {AbortSignal} signal */
  async function loop(signal) {
    let failures = 0;
    while (ctl && !signal.aborted) {
      try {
        const res = await api("/api/pool/poll", { providerId }, signal);
        if (res.status === 409) {
          // The broker forgot us (stale heartbeat, restarted D1) — re-register.
          await register(signal);
          continue;
        }
        if (!res.ok) throw new Error("poll failed (" + res.status + ")");
        failures = 0;
        const { job } = await res.json();
        if (!job) {
          // The broker's bounded long-poll came back empty. Breathe one tick
          // before re-polling: the SERVER does the real waiting, and this
          // pause both yields the event loop (a fast-answering broker must
          // never microtask-starve the tab) and spares batteries.
          await sleep(250, signal);
          continue;
        }
        onStatus({ state: "job", jobs: jobsDone });
        try {
          // The broker enqueues only DRSC/1-sanitized requests; strip the wire
          // marker and run the plain OpenAI body against the local model.
          const done = await opts.runJob(poolRequestToOpenAiBody(job.request || {}));
          await api("/api/pool/result", { providerId, jobId: job.job_id, response: done.response, usage: done.usage || undefined }, signal);
          jobsDone++;
        } catch (e) {
          // The LOCAL model failed this one job — report it (the consumer gets
          // a clean upstream_error + refund) and keep serving.
          await api(
            "/api/pool/result",
            { providerId, jobId: job.job_id, error: String(/** @type {any} */ (e)?.message || e).slice(0, 300) },
            signal,
          ).catch(() => {});
        }
        onStatus({ state: "idle", jobs: jobsDone });
      } catch (e) {
        if (signal.aborted) break;
        failures++;
        if (failures >= maxFailures) {
          onStatus({ state: "error", detail: String(/** @type {any} */ (e)?.message || e) });
          await stop(false);
          return;
        }
        await sleep(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(5, failures)), signal);
      }
    }
  }

  async function start() {
    if (ctl) return true;
    ctl = new AbortController();
    const signal = ctl.signal;
    try {
      await register(signal);
    } catch {
      ctl = null;
      onStatus({ state: "error", detail: "Could not register — are you signed in?" });
      return false;
    }
    onStatus({ state: "idle", jobs: jobsDone });
    void loop(signal);
    return true;
  }

  /** @param {boolean} [unregister] tell the broker we're gone (default true) */
  async function stop(unregister = true) {
    const c = ctl;
    ctl = null;
    c?.abort();
    if (unregister && providerId) {
      // Best-effort so a closing tab never blocks on it.
      await api("/api/pool/unregister", { providerId }).catch(() => {});
    }
    providerId = null;
    onStatus({ state: "off", jobs: jobsDone });
  }

  return {
    start,
    stop,
    get active() {
      return !!ctl;
    },
    get jobsDone() {
      return jobsDone;
    },
  };
}
