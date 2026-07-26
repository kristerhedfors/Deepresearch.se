#!/usr/bin/env node
// The embedding-provider registry for every build-time index in this repo:
// the arXiv RAG database (scripts/arxiv-*.mjs) and the committed introspection
// indexes (scripts/bundle-*-rag.mjs).
//
// Two backends serve the SAME model, so their vectors are interchangeable and
// an index can be built by either — or both at once:
//
//   berget  api.berget.ai/v1/embeddings          the primary
//   hf      router.huggingface.co/hf-inference   the fallback
//
// "Interchangeable" is measured, not assumed: re-embedding three chunks of the
// committed Berget-built docs index through Hugging Face and comparing against
// the stored int8 vectors gave cosine 0.9999 on all three (2026-07-26). That is
// the whole reason this registry can exist — a provider switch that changed the
// vectors would silently corrupt an index built across both.
//
//   EMBED_PROVIDER=berget  (default) Berget only
//   EMBED_PROVIDER=auto    Berget, failing over to HF mid-build
//   EMBED_PROVIDER=hf      Hugging Face only
//   EMBED_PROVIDER=both    both at once, work-stealing with a straggler guard
//
// The DEFAULT is berget-only (owner directive, 2026-07-26): the wallet now has
// auto top-up, so the failure this registry was built for — a build dying on
// `402 INSUFFICIENT_WALLET_BALANCE` mid-flight, which happened twice in one
// session — should no longer occur. `auto` remains one environment variable
// away and is still the right choice on an unattended long build.
//
// `both` is implemented, guarded and tested, but measured against THIS pair it
// buys nothing. On real 1100-char passages Berget runs at 180-270 passages/s
// and HF Inference at ~2/s, so HF's share of a job is ~1%, while Berget's own
// run-to-run variance is ±20%. The 1% is not resolvable, and without the
// straggler guard below HF's slow batches made a 12,000-passage run 8-16%
// SLOWER than Berget alone. `both` earns its keep only with a second provider
// within a few x of the first — a second Berget key, or a self-hosted TEI.

import { recapForContext } from "../public/js/arxiv-rag-core.js";

export const EMBED_MODEL = "intfloat/multilingual-e5-large";
export const EMBED_MODEL_INSTRUCT = "intfloat/multilingual-e5-large-instruct";

const BERGET_BASE = process.env.BERGET_BASE_URL || "https://api.berget.ai/v1";
const BERGET_KEY = () => process.env.BERGET_API_KEY || process.env.BERGET_API_TOKEN;
const HF_TOKEN = () => process.env.HUGGINGFACE_API_TOKEN || process.env.HF_TOKEN;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// How much bigger the remaining work must be than a slow provider's batch
// before that provider is allowed to take one. See mayTake().
const TAIL_MARGIN = Number(process.env.EMBED_TAIL_MARGIN) || 10;

// Berget-only unless asked otherwise — see the header.
export const DEFAULT_PROVIDER = "berget";

/** The 512-token rejection, in either provider's wording. */
const OVER_LENGTH = /maximum context length is (\d+) tokens.*?requested (\d+) tokens|too long|must have less than|maximum sequence length/is;

/**
 * @typedef {object} EmbedProvider
 * @property {string} id
 * @property {string} label
 * @property {number} batch      texts per request
 * @property {number} workers    concurrent requests
 * @property {number} rate       measured texts/s, used only to order `auto`
 * @property {() => boolean} available
 * @property {(texts: string[], model: string) => Promise<Float32Array[]>} call
 */

/** @type {Record<string, EmbedProvider>} */
export const PROVIDERS = {
  berget: {
    id: "berget",
    label: "Berget",
    batch: Number(process.env.BERGET_EMBED_BATCH) || 256,
    workers: Number(process.env.BERGET_EMBED_CONCURRENCY) || 8,
    rate: 180,
    available: () => !!BERGET_KEY(),
    async call(texts, model) {
      const res = await fetch(BERGET_BASE + "/embeddings", {
        method: "POST",
        headers: { authorization: "Bearer " + BERGET_KEY(), "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        const err = new Error(`Berget embeddings ${res.status}: ${(await res.text()).slice(0, 220)}`);
        /** @type {any} */ (err).status = res.status;
        throw err;
      }
      const json = await res.json();
      const data = json?.data || [];
      if (data.length !== texts.length) throw new Error(`Berget returned ${data.length} vectors for ${texts.length} texts`);
      // The API is not contractually ordered; `index` is.
      return [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => Float32Array.from(d.embedding));
    },
  },
  hf: {
    // Measured 2026-07-26. Two different numbers, and the second is the one
    // that matters: 9.4 texts/s on short probe strings, but ~2/s on REAL
    // 1100-char passages. Concurrency does not help either way — the
    // serverless endpoint queues (8.2 texts/s at 4 concurrent requests, 7.1 at
    // 8). `rate` seeds the straggler guard before any batch has been timed, so
    // it is set from the realistic figure; guessing high there is what let HF
    // grab a batch it could not finish in time.
    id: "hf",
    label: "Hugging Face Inference",
    batch: Number(process.env.HF_EMBED_BATCH) || 32,
    workers: Number(process.env.HF_EMBED_CONCURRENCY) || 2,
    rate: 2,
    available: () => !!HF_TOKEN(),
    async call(texts, model) {
      const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}/pipeline/feature-extraction`, {
        method: "POST",
        headers: { authorization: "Bearer " + HF_TOKEN(), "content-type": "application/json" },
        body: JSON.stringify({ inputs: texts }),
      });
      if (!res.ok) {
        const err = new Error(`HF embeddings ${res.status}: ${(await res.text()).slice(0, 220)}`);
        /** @type {any} */ (err).status = res.status;
        throw err;
      }
      const data = await res.json();
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(`HF returned ${Array.isArray(data) ? data.length : typeof data} vectors for ${texts.length} texts`);
      }
      // feature-extraction returns [dims] per input for a sentence-embedding
      // model, but [tokens][dims] for some deployments — mean-pool if so.
      return data.map((d) => {
        if (!Array.isArray(d[0])) return Float32Array.from(d);
        const dims = d[0].length;
        const out = new Float32Array(dims);
        for (const tok of d) for (let i = 0; i < dims; i++) out[i] += tok[i] / d.length;
        return out;
      });
    },
  },
};

/**
 * A 402/401/403 is terminal for that provider — no wallet, no key, no access —
 * so the pool retires it and hands its work to the others instead of retrying
 * into the same wall.
 * @param {any} err
 */
export const isTerminal = (err) => [401, 402, 403].includes(err?.status);

/**
 * Turn a spec into an ordered provider list. `auto` and `both` both return
 * every available provider, fastest first; they differ in whether the slower
 * ones are started immediately (see embedWithProviders).
 * @param {string} [spec]
 * @param {Record<string, EmbedProvider>} [registry]
 * @returns {{ mode: string, providers: EmbedProvider[] }}
 */
export function resolveProviders(spec, registry = PROVIDERS) {
  const mode = String(spec || process.env.EMBED_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  const all = Object.values(registry).filter((p) => p.available());
  if (mode === "auto" || mode === "both") {
    if (!all.length) {
      throw new Error("No embedding provider is configured — set BERGET_API_KEY or HUGGINGFACE_API_TOKEN.");
    }
    return { mode, providers: [...all].sort((a, b) => b.rate - a.rate) };
  }
  const one = registry[mode];
  if (!one) throw new Error(`Unknown EMBED_PROVIDER "${mode}" — expected one of: ${Object.keys(registry).join(", ")}, auto, both.`);
  if (!one.available()) throw new Error(`Provider "${mode}" is not configured (missing key).`);
  return { mode, providers: [one] };
}

/**
 * Embed `texts` across one or more providers, preserving input order.
 *
 * Work-stealing over ONE shared cursor rather than a pre-computed split:
 * providers differ 20x in speed and each has its own batch size, so any static
 * division would leave the fast one idle. A batch that fails terminally is
 * requeued for whoever is still alive.
 *
 * @param {string[]} texts already carrying their e5 prefix
 * @param {EmbedProvider[]} providers
 * @param {{ model?: string, mode?: string, onProgress?: (done: number, total: number, by: Record<string, number>) => void, log?: (m: string) => void }} [opts]
 * @returns {Promise<{ vectors: Float32Array[], by: Record<string, number>, retired: string[] }>}
 */
export async function embedWithProviders(texts, providers, opts = {}) {
  const model = opts.model || EMBED_MODEL;
  const mode = opts.mode || "auto";
  const log = opts.log || (() => {});
  /** @type {Float32Array[]} */
  const out = new Array(texts.length);
  /** @type {Array<{ start: number, count: number }>} */
  const requeue = [];
  /** @type {Record<string, number>} */
  const by = {};
  /** @type {string[]} */
  const retired = [];
  const live = new Set(providers.map((p) => p.id));
  let cursor = 0;
  let done = 0;

  // Straggler guard. A heterogeneous pool has a tail problem: near the end of
  // the job the slow provider grabs a batch and the fast one sits idle waiting
  // for it. Measured on real 1113-char arXiv passages, that made `both` SLOWER
  // than Berget alone (165 vs 217 passages/s) even though HF did 2% of the
  // work. So a non-primary provider stops accepting new work once the primary
  // could finish everything left in less time than one slow batch takes:
  //
  //   slow batch duration  = p.batch / p.rate
  //   what the primary does in that time = primary.rate * that
  //
  // Below that threshold the remaining work is the primary's alone.
  // Observed throughput per provider, so the straggler guard below corrects
  // itself. The static `rate` on each descriptor is only a starting estimate,
  // and it can be badly wrong: HF measures ~9 texts/s on short probes but ~2/s
  // on real 1100-char passages, and a guard built on the wrong number lets the
  // slow provider grab a batch it cannot finish before the fast one drains the
  // whole queue.
  /** @type {Map<string, { texts: number, ms: number }>} */
  const observed = new Map();
  const rateOf = (/** @type {EmbedProvider} */ p) => {
    const o = observed.get(p.id);
    return o && o.texts >= p.batch && o.ms > 0 ? (o.texts / o.ms) * 1000 : p.rate;
  };

  /**
   * A heterogeneous pool has a tail problem: near the end of the job the slow
   * provider grabs a batch and the fast one sits idle waiting for it. Measured
   * on real 1113-char arXiv passages, an unguarded `both` ran at 165
   * passages/s against 217 for Berget alone — SLOWER, while HF did 2% of the
   * work. So a non-primary provider only takes a batch when it can plausibly
   * finish it before the fastest live provider would have drained everything
   * that is left.
   * @param {EmbedProvider} p
   * @param {number} remaining
   */
  const mayTake = (p, remaining) => {
    const alive = providers.filter((q) => live.has(q.id));
    if (alive.length <= 1) return true;
    const fastest = alive.reduce((a, q) => (rateOf(q) > rateOf(a) ? q : a), alive[0]);
    if (fastest.id === p.id) return true;
    const myBatchSeconds = Math.min(p.batch, remaining) / Math.max(0.01, rateOf(p));
    const drainSeconds = remaining / Math.max(0.01, rateOf(fastest));
    // A large margin, not ×1. The rate estimate is noisy before any batch has
    // been timed, and the cost is asymmetric: a batch that lands late delays
    // the WHOLE job, while one the slow provider never takes costs only its
    // own small share. Measured on 12,000 real passages, HF took 1.6% of the
    // work and made the run 8-16% SLOWER at margin 1 and margin 4 alike; at
    // margin 10 it stands down and `both` matches `berget` exactly.
    return drainSeconds > myBatchSeconds * TAIL_MARGIN;
  };

  // Three outcomes, and conflating the last two deadlocks the pool: a worker
  // told "not now" must WAIT, not exit — otherwise a provider parked by the
  // guard is gone when the primary dies and nobody is left to finish the job.
  const DONE = null;
  const WAIT = "wait";
  const takeWork = (/** @type {EmbedProvider} */ p) => {
    const again = requeue.shift();
    if (again) return again;
    const remaining = texts.length - cursor;
    if (remaining <= 0) return DONE;
    if (!mayTake(p, remaining)) return WAIT; // the faster provider runs it out
    const start = cursor;
    const count = Math.min(p.batch, remaining);
    cursor += count;
    return { start, count };
  };

  /** One request, with the shared over-length recovery both providers need. */
  const embedSlice = async (/** @type {EmbedProvider} */ p, /** @type {string[]} */ slice) => {
    let input = slice;
    for (let shrink = 0; ; shrink++) {
      try {
        return await p.call(input, model);
      } catch (err) {
        const m = OVER_LENGTH.exec(err?.message || "");
        if (!m || shrink >= 6) throw err;
        // Berget reports the token counts; HF only says "too long", in which
        // case recapForContext falls back to its mandatory 15% shrink.
        input = recapForContext(input, Number(m[2]) || 0, Number(m[1]) || 512);
      }
    }
  };

  const worker = async (/** @type {EmbedProvider} */ p) => {
    for (;;) {
      if (!live.has(p.id)) return;
      const work = takeWork(p);
      if (work === DONE) return;
      if (work === WAIT) {
        await sleep(50);
        continue;
      }
      const slice = texts.slice(work.start, work.start + work.count);
      let vecs = null;
      for (let attempt = 0; attempt < 5 && vecs === null; attempt++) {
        const t0 = Date.now();
        try {
          vecs = await embedSlice(p, slice);
          const o = observed.get(p.id) || { texts: 0, ms: 0 };
          observed.set(p.id, { texts: o.texts + slice.length, ms: o.ms + (Date.now() - t0) });
        } catch (err) {
          if (isTerminal(err)) {
            live.delete(p.id);
            retired.push(p.id);
            requeue.push(work);
            log(`${p.label} retired (${err.message.slice(0, 90)}) — its work goes to ${[...live].join(", ") || "nobody"}`);
            return;
          }
          if (attempt === 4) {
            requeue.push(work);
            log(`${p.label} gave up on a batch after 5 attempts (${err.message.slice(0, 90)}) — requeued`);
            return;
          }
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        }
      }
      if (!vecs) return;
      for (let i = 0; i < vecs.length; i++) out[work.start + i] = vecs[i];
      done += vecs.length;
      by[p.id] = (by[p.id] || 0) + vecs.length;
      opts.onProgress?.(done, texts.length, by);
    }
  };

  // `both` starts everyone; `auto` starts the fastest and promotes the rest
  // only when it dies, so the slow provider never drags a healthy build.
  const primary = providers[0];
  const startAll = mode === "both" ? providers : [primary];
  const pool = startAll.flatMap((p) => Array.from({ length: p.workers }, () => worker(p)));
  await Promise.all(pool);

  if (mode === "auto") {
    for (const p of providers.slice(1)) {
      if (done >= texts.length) break;
      if (!live.has(p.id)) continue;
      log(`failing over to ${p.label} for the remaining ${texts.length - done} texts`);
      await Promise.all(Array.from({ length: p.workers }, () => worker(p)));
    }
  }

  const missing = out.findIndex((v) => !v);
  if (missing >= 0) {
    throw new Error(`Embedding incomplete: ${texts.length - done}/${texts.length} texts unfilled (first gap at ${missing}). Providers retired: ${retired.join(", ") || "none"}.`);
  }
  return { vectors: out, by, retired };
}

/**
 * The convenience entry point every build script uses.
 * @param {string[]} texts
 * @param {{ model?: string, provider?: string, onProgress?: (done: number, total: number, by: Record<string, number>) => void, log?: (m: string) => void }} [opts]
 */
export async function embedAll(texts, opts = {}) {
  if (!texts.length) return { vectors: [], by: {}, retired: [] };
  const { mode, providers } = resolveProviders(opts.provider);
  return embedWithProviders(texts, providers, { ...opts, mode });
}

/**
 * Embed exactly one batch through the resolved providers. Used by the search
 * path, where a query is a single text and failover still matters.
 * @param {string[]} texts
 * @param {{ model?: string, provider?: string }} [opts]
 */
export async function embedBatch(texts, opts = {}) {
  const { vectors } = await embedAll(texts, opts);
  return { vectors };
}

/** One line describing what a run will use — printed by every build script. */
export function describeProviders(spec, registry = PROVIDERS) {
  const { mode, providers } = resolveProviders(spec, registry);
  const list = providers.map((p) => `${p.label} (batch ${p.batch} x ${p.workers})`);
  if (mode === "both") return `embedding via ${list.join(" + ")}, work-stealing`;
  if (mode === "auto") return `embedding via ${list[0]}${list[1] ? `, falling over to ${providers.slice(1).map((p) => p.label).join(", ")}` : ""}`;
  return `embedding via ${list[0]}`;
}
