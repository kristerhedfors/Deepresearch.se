#!/usr/bin/env node
// Berget client for the arXiv RAG tooling: embeddings, reranking and JSON-mode
// chat, with the retry/concurrency behaviour a multi-hour index build needs.
//
// Deliberately separate from src/berget.js (the Worker's client): that one is
// bound to the Worker's Env/secret plumbing and quota accounting, this one is
// a build-time CLI client reading BERGET_API_KEY from the environment. Sharing
// it would drag Worker types into scripts for no gain.
//
// Measured on 2026-07-26 against api.berget.ai, and the numbers drive the
// defaults below:
//
//   intfloat/multilingual-e5-large  1024-d, e5 prefixes, 512-token window
//   throughput saturates at ~11.5k prompt-tokens/s regardless of how the work
//   is divided; batch 256 × concurrency 8 reaches it, larger batches and
//   higher concurrency do not go faster (and raise the cost of a retry).

import { recapForContext } from "../public/js/arxiv-rag-core.js";

const BASE = process.env.BERGET_BASE_URL || "https://api.berget.ai/v1";
const KEY = process.env.BERGET_API_KEY || process.env.BERGET_API_TOKEN;

export const EMBED_MODEL = "intfloat/multilingual-e5-large";
export const EMBED_MODEL_INSTRUCT = "intfloat/multilingual-e5-large-instruct";
export const RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
export const PLANNING_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506";

// See rerank(): Berget serves the reranker behind a 512-token window covering
// query + document together, so this is the per-document char budget.
export const RERANK_DOC_CHARS = Number(process.env.ARXIV_RERANK_DOC_CHARS) || 900;

export const EMBED_BATCH = Number(process.env.ARXIV_EMBED_BATCH) || 256;
export const EMBED_CONCURRENCY = Number(process.env.ARXIV_EMBED_CONCURRENCY) || 8;

export function requireKey() {
  if (!KEY) throw new Error("Set BERGET_API_KEY (or BERGET_API_TOKEN) — the arXiv RAG tooling embeds through Berget.");
  return KEY;
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST with retry on the failures a long build actually hits: 429/5xx and
 * transport errors. 4xx other than 429 is a bug in the request, so it throws
 * immediately rather than burning eight retries on it.
 * @param {string} path
 * @param {any} body
 * @param {{ tries?: number, timeoutMs?: number }} [opts]
 */
export async function bergetPost(path, body, opts = {}) {
  requireKey();
  const tries = opts.tries ?? 6;
  let lastErr = "";
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
    try {
      const res = await fetch(BASE + path, {
        method: "POST",
        headers: { authorization: "Bearer " + KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) return await res.json();
      const text = (await res.text()).slice(0, 300);
      if (res.status !== 429 && res.status < 500) throw new Error(`Berget ${path} ${res.status}: ${text}`);
      lastErr = `${res.status}: ${text}`;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter ? retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** attempt));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Berget ")) throw err;
      lastErr = err?.message || String(err);
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Berget ${path} failed after ${tries} tries: ${lastErr}`);
}

/**
 * Embed one batch. Texts must ALREADY carry their e5 prefix — the prefix is
 * applied by the caller's passage/query seam so this stays a dumb transport.
 * @param {string[]} texts
 * @param {{ model?: string }} [opts]
 * @returns {Promise<{ vectors: Float32Array[], tokens: number }>}
 */
export async function embedBatch(texts, opts = {}) {
  let input = texts;
  let json;
  // e5 rejects (not truncates) input past its 512-token window, and the
  // rejection kills the whole batch. A build over hundreds of thousands of
  // abstracts WILL meet LaTeX-dense and non-Latin-script outliers no fixed
  // char budget covers, so re-cap from the token count the error reports and
  // retry rather than losing the batch.
  for (let shrink = 0; ; shrink++) {
    try {
      json = await bergetPost("/embeddings", { model: opts.model || EMBED_MODEL, input });
      break;
    } catch (err) {
      const m = /maximum context length is (\d+) tokens.*?requested (\d+) tokens/s.exec(err?.message || "");
      if (!m || shrink >= 6) throw err;
      input = recapForContext(input, Number(m[2]), Number(m[1]));
    }
  }
  const data = json?.data || [];
  if (data.length !== texts.length) throw new Error(`Berget returned ${data.length} vectors for ${texts.length} texts`);
  // The API is not contractually ordered; `index` is, so sort by it.
  const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return { vectors: sorted.map((d) => Float32Array.from(d.embedding)), tokens: json?.usage?.prompt_tokens || 0 };
}

/**
 * Embed many texts with a bounded worker pool, preserving input order.
 * `onProgress` gets (done, total, tokens) after each batch so a build can
 * print a live rate.
 * @param {string[]} texts
 * @param {{ model?: string, batch?: number, concurrency?: number, onProgress?: (done: number, total: number, tokens: number) => void }} [opts]
 * @returns {Promise<{ vectors: Float32Array[], tokens: number }>}
 */
export async function embedAll(texts, opts = {}) {
  const batch = opts.batch || EMBED_BATCH;
  const concurrency = opts.concurrency || EMBED_CONCURRENCY;
  /** @type {Float32Array[]} */
  const out = new Array(texts.length);
  /** @type {number[]} */
  const starts = [];
  for (let i = 0; i < texts.length; i += batch) starts.push(i);
  let done = 0;
  let tokens = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const at = cursor++;
      if (at >= starts.length) return;
      const start = starts[at];
      const slice = texts.slice(start, start + batch);
      const r = await embedBatch(slice, { model: opts.model });
      for (let j = 0; j < r.vectors.length; j++) out[start + j] = r.vectors[j];
      done += slice.length;
      tokens += r.tokens;
      opts.onProgress?.(done, texts.length, tokens);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, starts.length) }, worker));
  return { vectors: out, tokens };
}

/**
 * Cross-encoder rerank of candidate documents against a query.
 * @param {string} query
 * @param {string[]} documents
 * @param {{ model?: string, topN?: number }} [opts]
 * @returns {Promise<Array<{ index: number, score: number }>>} descending
 */
export async function rerank(query, documents, opts = {}) {
  // bge-reranker-v2-m3 natively handles 8192 tokens, but Berget serves it
  // behind the SAME 512-token window as the embedder (measured 2026-07-26:
  // a 2000-char abstract came back "you requested 809 tokens"). The window
  // covers query + document together, so long abstracts must be cut — and
  // the first 900 chars of an abstract is what the cross-encoder gets to
  // judge on. Same adaptive recovery as embedBatch, since a hard 400 here
  // would otherwise silently degrade every rerank to the candidate order.
  let docs = documents.map((d) => (d.length > RERANK_DOC_CHARS ? d.slice(0, RERANK_DOC_CHARS) : d));
  let json;
  for (let shrink = 0; ; shrink++) {
    try {
      json = await bergetPost("/rerank", {
        model: opts.model || RERANK_MODEL,
        query,
        documents: docs,
        top_n: opts.topN || docs.length,
      });
      break;
    } catch (err) {
      const m = /maximum context length is (\d+) tokens.*?requested (\d+) tokens/s.exec(err?.message || "");
      if (!m || shrink >= 6) throw err;
      // Charge the query's tokens against the window before re-capping docs.
      const budget = Math.max(64, Number(m[1]) - Math.ceil(query.length / 3) - 16);
      docs = recapForContext(docs, Number(m[2]), budget);
    }
  }
  const results = json?.results || json?.data || [];
  return results
    .map((/** @type {any} */ r) => ({ index: r.index ?? 0, score: r.relevance_score ?? r.score ?? 0 }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score);
}

/**
 * JSON-mode chat, used by the bake-off for synthetic query generation and by
 * the query-expansion pipeline variant. Planning-shaped work stays on the
 * fixed reliable small model, mirroring CLAUDE.md invariant 3.
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{ model?: string, temperature?: number, maxTokens?: number }} [opts]
 * @returns {Promise<any>} the parsed JSON object, or null when the model
 *   returned something unparseable (callers fail soft)
 */
export async function chatJson(messages, opts = {}) {
  const json = await bergetPost("/chat/completions", {
    model: opts.model || PLANNING_MODEL,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 800,
    response_format: { type: "json_object" },
  });
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(content);
  } catch {
    const m = /\{[\s\S]*\}/.exec(content);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
