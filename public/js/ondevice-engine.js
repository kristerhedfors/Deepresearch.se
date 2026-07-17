// The on-device inference tier's main-thread façade (browser glue over the
// pure ondevice-core.js): worker lifecycle, the download/list/delete API the
// /cure settings drawer drives, the capability probe, and — the seam that
// makes the whole thing invisible to the pipeline — `onDeviceProvider()`,
// a drc-providers.js provider entry whose wire calls hit the in-browser
// engine instead of fetch (the src/anthropic.js adapt-at-the-wire pattern:
// the engine re-emits tokens as OpenAI SSE, so drc-research.js's readStream
// and every guard on it run unchanged).
//
// LAZY BY CONTRACT (the bandwidth guarantee): importing this module loads a
// few KB of glue and nothing else. The worker (and behind it the vendored
// runtime + wasm) spawns on first use; the weights download ONLY from the
// explicit consent flow in the settings drawer (docs/
// BONSAI-27B-PHONE-INFERENCE.md §6). /cure is already cross-origin-isolated,
// and the weights fetch with plain CORS from huggingface.co, so COEP holds.
//
// The VENDORED runtime (invariant 7 — never a runtime CDN fetch), pinned by
// SHA-256 like public/vendor/xterm/ (see sandbox.js):
//   @huggingface/transformers 4.2.0 → public/vendor/transformers/
//     transformers.min.js      e74bd32ed4453369ebb0edcaa27f6bc6204004a949a0233cdb87b62dda8d6978
//       (the SELF-CONTAINED dist bundle — ort JS API inlined. Its sibling
//       transformers.web.min.js was vendored first and is GONE: that build
//       externalizes onnxruntime as bare import specifiers, which cannot
//       resolve inside a worker — import maps apply to documents only.)
//   onnxruntime-web 1.26.0-dev.20260416-b7804b056c (the exact version 4.2.0 pins):
//     ort-wasm-simd-threaded.mjs            5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d
//     ort-wasm-simd-threaded.wasm           f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a
//     ort-wasm-simd-threaded.asyncify.mjs   5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9
//     ort-wasm-simd-threaded.asyncify.wasm  e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786

import {
  ONDEVICE_MAX_TOKENS,
  completionEnvelope,
  crashMessage,
  debugFlagFrom,
  errorEventDetail,
  formatTraceLine,
  pushTrace,
  sseDeltaLine,
  sseDoneLine,
  withDeadline,
} from "/js/ondevice-core.js";

export { ONDEVICE_MODELS, capabilityVerdict, fmtBytes, onDeviceModel } from "/js/ondevice-core.js";

export const ONDEVICE_PROVIDER_ID = "ondevice";

// ---- verbose debug switch ----------------------------------------------------------
//
// The sandbox's dr_sandbox_debug pattern (sandbox-debug skill) for THIS
// subsystem. OFF by default and byte-silent; when ON, both sides of the
// worker protocol narrate to the console — the only observability this tier
// can have, since Se/cure keeps the server out of every data path (no
// chatlogs, no Workers Logs). Toggle: localStorage dr_ondevice_debug="1",
// the ?oddebug=1 URL param, or window.__DR_ONDEVICE_DEBUG(true|false) from
// a device console.
let _odDebug = false;
try {
  _odDebug = debugFlagFrom(
    typeof location !== "undefined" ? location.search : "",
    typeof localStorage !== "undefined" ? localStorage.getItem("dr_ondevice_debug") : null,
  );
} catch {
  /* storage/location unavailable */
}

// The visible, copyable trace behind the debug switch (phones have no
// console — the settings drawer renders this next to the on-device rows).
// Crash lines are recorded even with debug OFF, so flipping the switch on
// after a failure still shows the tail that mattered.
const traceT0 = Date.now();
/** @type {string[]} */
const traceBuf = [];
/** @type {?(line: string) => void} */
let traceCb = null;

/** @param {...unknown} parts */
function trace(...parts) {
  const line = formatTraceLine(Date.now() - traceT0, parts);
  pushTrace(traceBuf, line);
  try {
    traceCb?.(line);
  } catch {
    /* a broken subscriber must not break the engine */
  }
}

/** @returns {string[]} a copy of the recorded trace lines, oldest first */
export function onDeviceTrace() {
  return traceBuf.slice();
}

/** @param {?(line: string) => void} cb live-append hook for the trace pane */
export function onDeviceTraceHook(cb) {
  traceCb = cb;
}

/** @param {...unknown} args */
function dbg(...args) {
  if (!_odDebug) return;
  console.info("[ondevice]", ...args);
  trace(...args);
}

/**
 * Turn verbose on-device debugging on/off (persists in localStorage; also
 * flips a live worker). Call with no argument to read the current state.
 * Exposed as window.__DR_ONDEVICE_DEBUG so the operator can flip it from a
 * real device's console.
 * @param {boolean} [on]
 * @returns {boolean}
 */
export function onDeviceDebug(on) {
  if (on === undefined) return _odDebug;
  _odDebug = !!on;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem("dr_ondevice_debug", _odDebug ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
  worker?.postMessage({ t: "debug", on: _odDebug });
  console.info("[ondevice] debug " + (_odDebug ? "on" : "off"));
  return _odDebug;
}
if (typeof window !== "undefined") {
  try {
    /** @type {any} */ (window).__DR_ONDEVICE_DEBUG = onDeviceDebug;
  } catch {
    /* ignore */
  }
}

// ---- worker lifecycle ------------------------------------------------------------

let worker = null;
let genSeq = 0;
const genHandlers = new Map(); // id → {onToken, resolve, reject}
const dlHandlers = new Map(); // modelId → {onProgress, resolve, reject}
const planHandlers = new Map(); // modelId → {resolve, reject}
const deleteHandlers = new Map(); // modelId → {resolve, reject}
let listWaiters = []; // {resolve, reject}
let loadStatusCb = null;
// The most recent workerdiag detail: the worker-side error listener's full
// copy of an uncaught error that is ALSO propagating to worker.onerror below,
// which often arrives degraded ("Script error.", no location) — this is
// onerror's fallback message when its own event carries nothing.
let lastWorkerDiag = "";
// Did the current worker deliver ANY message? A worker that dies without ever
// speaking never ran — its script failed to load/evaluate (stale cached
// module graph, blocked fetch) — and crashMessage() names that case.
let workerSpoke = false;

// EVERY pending call fails together — including the list/plan/delete waiters.
// The first live device report was the settings drawer stuck on "Checking
// this device…" forever: the original onerror rejected only gen/dl handlers,
// so a worker that failed to even load left listCachedModels() pending with
// nothing to reject it. Nothing may wait on a dead worker.
function failAllPending(message) {
  const err = new Error(message);
  for (const [, h] of genHandlers) h.reject(err);
  genHandlers.clear();
  for (const [, h] of dlHandlers) h.reject(err);
  dlHandlers.clear();
  for (const [, h] of planHandlers) h.reject(err);
  planHandlers.clear();
  for (const [, h] of deleteHandlers) h.reject(err);
  deleteHandlers.clear();
  for (const w of listWaiters) w.reject(err);
  listWaiters = [];
}

function getWorker() {
  if (worker) return worker;
  // The debug flag rides the spawn URL — a worker can't read localStorage
  // (onDeviceDebug() covers flips while it's already alive).
  worker = new Worker("/js/ondevice-worker.js" + (_odDebug ? "?oddebug=1" : ""), { type: "module" });
  workerSpoke = false;
  dbg("worker spawned");
  worker.onmessage = (e) => {
    workerSpoke = true;
    const m = e.data || {};
    if (m.t !== "token" && m.t !== "progress") dbg("←", m.t, m.modelId ?? m.id ?? "", m.status ?? m.message ?? "");
    if (m.t === "token") genHandlers.get(m.id)?.onToken(m.text);
    else if (m.t === "gendone") {
      genHandlers.get(m.id)?.resolve(m.text);
      genHandlers.delete(m.id);
    } else if (m.t === "generror") {
      genHandlers.get(m.id)?.reject(new Error(m.message));
      genHandlers.delete(m.id);
    } else if (m.t === "progress") dlHandlers.get(m.modelId)?.onProgress(m);
    else if (m.t === "downloaded") {
      dlHandlers.get(m.modelId)?.resolve();
      dlHandlers.delete(m.modelId);
    } else if (m.t === "dlerror") {
      // Recorded even with debug OFF (the crash-line convention): a failed
      // download is the tier's #1 field report, and flipping the trace on
      // after the fact must still show why.
      trace("download failed:", m.modelId, m.message || "");
      dlHandlers.get(m.modelId)?.reject(new Error(m.message));
      dlHandlers.delete(m.modelId);
    } else if (m.t === "plan") {
      planHandlers.get(m.modelId)?.resolve({ published: !!m.published, reason: m.reason || null, totalBytes: m.totalBytes ?? null });
      planHandlers.delete(m.modelId);
    } else if (m.t === "deleted") {
      deleteHandlers.get(m.modelId)?.resolve(undefined);
      deleteHandlers.delete(m.modelId);
    } else if (m.t === "list") {
      for (const w of listWaiters) w.resolve(m.entries);
      listWaiters = [];
    } else if (m.t === "workererror") {
      // A dispatch-level throw in the worker (generate/download carry their
      // own error replies; this covers list/plan/delete). The worker itself
      // is still alive — fail the waiting calls so no caller hangs; the next
      // call retries normally.
      trace("worker failed:", m.message || "");
      failAllPending(m.message || "The on-device engine failed.");
    } else if (m.t === "workerdiag") {
      // Detail only — the paired crash surfaces through onerror below. Keep
      // it for onerror's message and put it on the page console either way
      // (the worker's own console context is easy to miss in devtools).
      lastWorkerDiag = m.message || "";
      if (lastWorkerDiag) {
        console.error("[ondevice] worker error:", lastWorkerDiag);
        trace("worker error:", lastWorkerDiag);
      }
    } else if (m.t === "loadstatus") loadStatusCb?.(m.status);
  };
  // A dead worker fails every pending call (fail-soft at the call sites)
  // and a fresh one spawns on next use. onerror also covers the worker
  // SCRIPT failing to load or parse at all — the pending calls are the only
  // place that failure can surface.
  worker.onerror = (e) => {
    // The full event always hits the page console — filename/lineno were
    // previously discarded, and there is no server log to fall back on.
    console.error("[ondevice] worker crashed:", e);
    const detail = errorEventDetail(e) || lastWorkerDiag;
    // A never-spoke worker means the SCRIPT failed to load — crashMessage
    // names that case (with the stale-cache remedy) instead of a bare crash.
    trace("worker crashed", workerSpoke ? "(mid-run)" : "(never started)", detail);
    failAllPending(crashMessage(workerSpoke, detail));
    lastWorkerDiag = "";
    worker = null;
  };
  worker.onmessageerror = () => failAllPending("The on-device engine sent an unreadable message.");
  return worker;
}

// ---- capability probe -------------------------------------------------------------

let probeCache = null;

// requestAdapter() has been observed to neither resolve nor reject on some
// devices (the "Checking this device…" hang) — the deadline turns that into
// an inconclusive-probe verdict instead of an eternal wait.
const GPU_PROBE_TIMEOUT_MS = 10_000;

/** @returns {Promise<{hasWebGpu: boolean, deviceMemoryGb: ?number, maxBufferBytes: ?number, gpuTimedOut: boolean}>} */
export async function probeOnDevice() {
  if (probeCache) return probeCache;
  let hasWebGpu = false;
  let maxBufferBytes = null;
  let gpuTimedOut = false;
  try {
    if (navigator.gpu) {
      const adapter = await withDeadline(navigator.gpu.requestAdapter(), GPU_PROBE_TIMEOUT_MS, "gpu probe timed out");
      if (adapter) {
        hasWebGpu = true;
        maxBufferBytes = adapter.limits?.maxBufferSize ?? null;
      }
    }
  } catch (err) {
    hasWebGpu = false;
    gpuTimedOut = /gpu probe timed out/.test(err?.message || "");
  }
  const deviceMemoryGb = typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : null;
  const probe = { hasWebGpu, deviceMemoryGb, maxBufferBytes, gpuTimedOut };
  dbg("gpu probe", probe);
  // A timed-out probe is inconclusive — don't cache it, so reopening the
  // drawer (or retrying) probes again instead of pinning the stale verdict.
  if (!gpuTimedOut) probeCache = probe;
  return probe;
}

// ---- settings-drawer API ------------------------------------------------------------

// Worker round-trip deadlines (the never-hang rule): a call that outlives
// its deadline rejects with a stage-naming message the settings drawer shows
// verbatim. LIST covers the first call's worker spawn + module fetch on a
// slow connection; PLAN additionally covers one small huggingface.co fetch.
const LIST_TIMEOUT_MS = 20_000;
const PLAN_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 10_000;

/** @returns {Promise<Array<{id: string, cachedBytes: ?number}>>} */
export function listCachedModels() {
  return withDeadline(
    new Promise((resolve, reject) => {
      listWaiters.push({ resolve, reject });
      getWorker().postMessage({ t: "list" });
    }),
    LIST_TIMEOUT_MS,
    "The on-device engine did not answer the device check — reload the page and try again.",
  );
}

/**
 * The pre-consent probe: is the browser build published, and exactly how big?
 * (The consent popup shows THIS number, not the catalog estimate.) A failed
 * probe distinguishes `reason: "unpublished"` from `"network"` — the wrong
 * message sends a user away from a working feature.
 * @param {string} modelId
 * @returns {Promise<{published: boolean, reason: ?string, totalBytes: ?number}>}
 */
export function planModelDownload(modelId) {
  return withDeadline(
    new Promise((resolve, reject) => {
      planHandlers.set(modelId, { resolve, reject });
      getWorker().postMessage({ t: "plan", modelId });
    }),
    PLAN_TIMEOUT_MS,
    "The on-device engine did not answer the size check — reload the page and try again.",
  );
}

/**
 * Start (or resume) the one-time weight download. Resolves when every file is
 * on disk and checksum-verified. ONLY the consent popup's Download button
 * calls this.
 * @param {string} modelId
 * @param {(p: {pct: number, loaded: number, total: number}) => void} onProgress
 */
export function downloadModel(modelId, onProgress) {
  return new Promise((resolve, reject) => {
    dlHandlers.set(modelId, { onProgress: onProgress || (() => {}), resolve, reject });
    getWorker().postMessage({ t: "download", modelId });
  });
}

/** @param {string} modelId */
export function cancelDownload(modelId) {
  getWorker().postMessage({ t: "canceldl", modelId });
}

/** Delete the cached weights — the consent's one-tap reversal. @param {string} modelId */
export function deleteModel(modelId) {
  return withDeadline(
    new Promise((resolve, reject) => {
      deleteHandlers.set(modelId, { resolve, reject });
      getWorker().postMessage({ t: "delete", modelId });
    }),
    DELETE_TIMEOUT_MS,
    "The on-device engine did not answer the delete — reload the page and try again.",
  );
}

/** @param {(status: string) => void} cb model-load status lines for the phase UI */
export function onLoadStatus(cb) {
  loadStatusCb = cb;
}

// ---- generation (the engine behind the provider seam) --------------------------------

// ONE decode at a time: a single GPU serves every phase, and parallel decode
// streams just steal each other's throughput (the provider also declares
// serialize:true so the pipeline doesn't fan out — this mutex is the hard
// guarantee either way).
let genChain = Promise.resolve();

function generateSerialized({ modelId, messages, maxTokens, json, signal, onToken }) {
  const run = () =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Aborted."));
      const id = ++genSeq;
      dbg("generate #" + id, modelId, json ? "(json)" : "");
      genHandlers.set(id, { onToken: onToken || (() => {}), resolve, reject });
      const w = getWorker();
      const onAbort = () => w.postMessage({ t: "abort", id });
      signal?.addEventListener("abort", onAbort, { once: true });
      w.postMessage({
        t: "generate",
        id,
        modelId,
        messages,
        maxTokens: Math.min(maxTokens || ONDEVICE_MAX_TOKENS, ONDEVICE_MAX_TOKENS),
        json: !!json,
      });
    });
  const next = genChain.then(run, run);
  genChain = next.catch(() => {}); // one failed generation must not jam the queue
  return next;
}

// ---- the provider entry ----------------------------------------------------------------

/**
 * The drc-providers.js entry for this device — built on demand like
 * proxyLlmProvider (it exists only while the knob is on and a model is
 * cached). Its `engine` callables are the branch drcChatStream /
 * drcCompleteJson take instead of fetch; everything downstream is
 * provider-agnostic. The generous per-provider timeouts and serialize:true
 * are the phone-speed contract (plan §8): prompt processing alone can pass
 * the defaults tuned for hosted APIs.
 */
export function onDeviceProvider() {
  return {
    id: ONDEVICE_PROVIDER_ID,
    label: "On-device",
    base: "", // no wire — the engine below IS the transport
    keyPattern: null,
    keyless: true,
    onDevice: true, // the send path's "nothing leaves this device" disclosure hook
    jsonModel: null, // planning collapses onto the one local model, like `local`
    fallbackModels: [],
    modelFilter: () => true,
    params: (maxTokens) => ({ max_tokens: Math.min(maxTokens || ONDEVICE_MAX_TOKENS, ONDEVICE_MAX_TOKENS) }),
    jsonTimeoutMs: 600_000, // planning phases: 10 min beats the hosted 45 s default
    streamIdleMs: 300_000, // first token waits on prompt processing at phone speed
    serialize: true, // one GPU — the harvest fan-out runs sequentially
    engine: {
      /**
       * Streamed completion as an OpenAI-SSE Response — readStream consumes
       * it exactly like a fetch body. Engine failures become a status-500
       * Response with the OpenAI error shape so the existing error paths
       * (providerErrorDetail) explain them.
       */
      chatStream: async (model, messages, { signal, maxTokens } = {}) => {
        const encoder = new TextEncoder();
        let started = false;
        try {
          const stream = new ReadableStream({
            start: (controller) => {
              generateSerialized({
                modelId: model,
                messages,
                maxTokens,
                signal,
                onToken: (text) => {
                  started = true;
                  controller.enqueue(encoder.encode(sseDeltaLine(text)));
                },
              })
                .then(() => {
                  controller.enqueue(encoder.encode(sseDoneLine()));
                  controller.close();
                })
                .catch((err) => controller.error(err));
            },
            cancel: () => {
              /* reader gone — the abort signal is the caller's cancel path */
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        } catch (err) {
          void started;
          return engineErrorResponse(err);
        }
      },
      /** Non-streaming completion in the envelope drcCompleteJson reads. */
      complete: async (model, messages, { signal, maxTokens, json } = {}) => {
        const text = await generateSerialized({ modelId: model, messages, maxTokens, json, signal });
        return completionEnvelope(text);
      },
    },
  };
}

function engineErrorResponse(err) {
  return new Response(JSON.stringify({ error: { message: err?.message || String(err) } }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}
