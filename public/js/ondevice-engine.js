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
//     transformers.web.min.js  0a96dcf4c48981b7d05f53827e6975ec239132606ad0d526bbc2db0fcdbc4ded
//   onnxruntime-web 1.26.0-dev.20260416-b7804b056c (the exact version 4.2.0 pins):
//     ort-wasm-simd-threaded.mjs            5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d
//     ort-wasm-simd-threaded.wasm           f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a
//     ort-wasm-simd-threaded.asyncify.mjs   5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9
//     ort-wasm-simd-threaded.asyncify.wasm  e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786

import { ONDEVICE_MAX_TOKENS, completionEnvelope, sseDeltaLine, sseDoneLine } from "/js/ondevice-core.js";

export { ONDEVICE_MODELS, capabilityVerdict, fmtBytes, onDeviceModel } from "/js/ondevice-core.js";

export const ONDEVICE_PROVIDER_ID = "ondevice";

// ---- worker lifecycle ------------------------------------------------------------

let worker = null;
let genSeq = 0;
const genHandlers = new Map(); // id → {onToken, resolve, reject}
const dlHandlers = new Map(); // modelId → {onProgress, resolve, reject}
let listWaiters = [];
let loadStatusCb = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker("/js/ondevice-worker.js", { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data || {};
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
      dlHandlers.get(m.modelId)?.reject(new Error(m.message));
      dlHandlers.delete(m.modelId);
    } else if (m.t === "list") {
      for (const w of listWaiters) w(m.entries);
      listWaiters = [];
    } else if (m.t === "loadstatus") loadStatusCb?.(m.status);
  };
  worker.onerror = () => {
    // A dead worker fails every pending call (fail-soft at the call sites)
    // and a fresh one spawns on next use.
    for (const [, h] of genHandlers) h.reject(new Error("The on-device engine crashed."));
    genHandlers.clear();
    for (const [, h] of dlHandlers) h.reject(new Error("The on-device engine crashed."));
    dlHandlers.clear();
    worker = null;
  };
  return worker;
}

// ---- capability probe -------------------------------------------------------------

let probeCache = null;

/** @returns {Promise<{hasWebGpu: boolean, deviceMemoryGb: ?number, maxBufferBytes: ?number}>} */
export async function probeOnDevice() {
  if (probeCache) return probeCache;
  let hasWebGpu = false;
  let maxBufferBytes = null;
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        hasWebGpu = true;
        maxBufferBytes = adapter.limits?.maxBufferSize ?? null;
      }
    }
  } catch {
    hasWebGpu = false;
  }
  const deviceMemoryGb = typeof navigator.deviceMemory === "number" ? navigator.deviceMemory : null;
  probeCache = { hasWebGpu, deviceMemoryGb, maxBufferBytes };
  return probeCache;
}

// ---- settings-drawer API ------------------------------------------------------------

/** @returns {Promise<Array<{id: string, cachedBytes: ?number}>>} */
export function listCachedModels() {
  return new Promise((resolve) => {
    listWaiters.push(resolve);
    getWorker().postMessage({ t: "list" });
  });
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
  return new Promise((resolve) => {
    const w = getWorker();
    const onMsg = (e) => {
      if (e.data?.t === "plan" && e.data.modelId === modelId) {
        w.removeEventListener("message", onMsg);
        resolve({ published: e.data.published, reason: e.data.reason || null, totalBytes: e.data.totalBytes });
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ t: "plan", modelId });
  });
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
  return new Promise((resolve) => {
    const w = getWorker();
    const onMsg = (e) => {
      if (e.data?.t === "deleted" && e.data.modelId === modelId) {
        w.removeEventListener("message", onMsg);
        resolve(undefined);
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ t: "delete", modelId });
  });
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
