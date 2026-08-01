#!/usr/bin/env node
// The Vectorize REST client + a faithful replay of the SERVED dense-retrieval
// path, for ANY corpus in scripts/rag-corpora.mjs.
//
// Generalized out of scripts/arxiv-hosted.mjs on 2026-08-01, when PubMed became
// the second hosted corpus and turned out to have no measurement instrument at
// all (docs/PUBMED-RAG.md §8.2: "no retrieval numbers yet … nothing should
// [claim recall] until pubmed:eval exists"). The serving side had already made
// this split — src/dense-rag.js is corpus-agnostic and src/arxiv-rag.js /
// src/pubmed-rag.js are its two thin callers — and the measuring side not
// making it is why one corpus was measured to four decimal places and the other
// not at all.
//
// The replay is line-for-line with src/dense-rag.js: same `query: ` prefix,
// same topK, same cross-encoder over `title. abstract` cut to RERANK_DOC_CHARS,
// same floor applied only when the reranker actually scored. Two deliberate
// differences, both stated because they bound what the numbers mean:
//
//  * The served TIME BUDGET (embed 6 s / query 6 s / rerank 6 s / 12 s total)
//    is not enforced. Under it a slow leg silently drops the rerank, and an
//    eval that did that would average two different pipelines together —
//    exactly the failure docs/ARXIV-RAG.md §5 records. Latency is measured and
//    reported instead, so an overrun is visible rather than baked into a score.
//  * Fail-soft is LOUD here. A rerank that fell back silently once made a whole
//    bake-off report numbers for a pipeline that never ran.
//
// NODE_USE_ENV_PROXY=1 is required behind an agent proxy — Node's built-in
// fetch ignores HTTPS_PROXY without it, and every call then fails with a 503
// that reads exactly like Cloudflare being down.

import { embedBatch, rerank } from "./arxiv-berget.mjs";
import {
  CANDIDATES,
  GET_BY_IDS_BATCH,
  MAX_TOPK,
  MAX_TOPK_WITH_METADATA,
  QUERY_PREFIX,
  RERANK_DOC_CHARS,
  RERANK_FLOOR,
  corpus,
} from "./rag-corpora.mjs";

export { CANDIDATES, MAX_TOPK, MAX_TOPK_WITH_METADATA, RERANK_FLOOR };

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 60_000;

/** @returns {{ account: string, token: string }} */
export function requireCloudflare() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  // The deploy skill's two-token split: the plain API token is the one with
  // Vectorize scope; CLOUDFLARE_USER_API_TOKEN is for `wrangler containers`.
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set");
  }
  return { account, token };
}

/**
 * One authenticated Vectorize call.
 * @param {string} index
 * @param {string} path e.g. "query"
 * @param {any} body
 */
async function vectorizePost(index, path, body) {
  const { account, token } = requireCloudflare();
  const res = await fetch(`${API}/accounts/${account}/vectorize/v2/indexes/${index}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const detail =
      json?.errors?.map((/** @type {any} */ e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`vectorize ${path} (${index}): ${detail}`);
  }
  return json.result;
}

/**
 * Dense query against a hosted index, in served configuration.
 * @param {number[] | Float32Array} vector
 * @param {{ corpus?: string, index?: string, topK?: number }} [opts]
 * @returns {Promise<any[]>} matches, descending by score
 */
export async function vectorizeQuery(vector, opts = {}) {
  const index = indexOf(opts);
  const topK = opts.topK || CANDIDATES;
  // Past 50 the index will not return metadata at all, so candidates come back
  // as bare ids and are hydrated in a second pass — ceil(topK/20) extra round
  // trips, measured no better than 50 (docs/ARXIV-RAG.md §11).
  const withMetadata = topK <= MAX_TOPK_WITH_METADATA;
  const result = await vectorizePost(index, "query", {
    vector: Array.from(vector),
    topK: Math.min(topK, MAX_TOPK),
    returnMetadata: withMetadata ? "all" : "none",
    returnValues: false,
  });
  const matches = result?.matches || [];
  if (withMetadata || !matches.length) return matches;
  const hydrated = await hydrate(matches.map((/** @type {any} */ m) => String(m.id)), opts);
  // Preserve the dense ORDER — get_by_ids returns rows in whatever order it
  // likes, and reordering the candidates would silently change what the
  // cross-encoder is handed and what "dense rank" means.
  return matches
    .map((/** @type {any} */ m) => ({ ...m, metadata: hydrated.get(String(m.id))?.metadata || null }))
    .filter((/** @type {any} */ m) => m.metadata);
}

/**
 * @param {{ corpus?: string, index?: string }} opts
 */
function indexOf(opts) {
  if (opts.index) return opts.index;
  return corpus(opts.corpus || "arxiv").index;
}

/**
 * ids → their stored metadata, in ceil(n/20) batched calls.
 * @param {string[]} ids
 * @param {{ corpus?: string, index?: string }} [opts]
 */
async function hydrate(ids, opts = {}) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH) {
    const rows = await vectorizeGetByIds(ids.slice(i, i + GET_BY_IDS_BATCH), opts);
    for (const r of rows) out.set(String(r.id), r);
  }
  return out;
}

/**
 * Fetch specific vectors (with metadata) by id.
 *
 * This is the primitive that lets a gold set be sampled WITHOUT bias: the ids
 * come from an enumeration independent of the index (the GCS mirror for arXiv,
 * E-utilities for PubMed) and only their hydration touches what is being
 * measured. Sampling by QUERYING the index instead would select for documents
 * that retrieve well and inflate every recall number reported.
 *
 * @param {string[]} ids
 * @param {{ corpus?: string, index?: string }} [opts]
 */
export async function vectorizeGetByIds(ids, opts = {}) {
  if (!ids.length) return [];
  const result = await vectorizePost(indexOf(opts), "get_by_ids", { ids });
  return Array.isArray(result) ? result : result?.vectors || [];
}

/**
 * Fetch by id in batches of 20, transparently.
 * @param {string[]} ids
 * @param {{ corpus?: string, index?: string }} [opts]
 */
export async function getByIdsBatched(ids, opts = {}) {
  /** @type {any[]} */
  const out = [];
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH) {
    out.push(...(await vectorizeGetByIds(ids.slice(i, i + GET_BY_IDS_BATCH), opts)));
  }
  return out;
}

/**
 * How many vectors the index currently holds.
 *
 * `vectorCount` is EVENTUALLY CONSISTENT — it tracks `processedUpToMutation`
 * and lagged a live fill by ~6k vectors / ~2 min. It confirms a finished build
 * and cannot confirm one in progress.
 * @param {{ corpus?: string, index?: string }} [opts]
 */
export async function vectorizeCount(opts = {}) {
  const { account, token } = requireCloudflare();
  const index = indexOf(typeof opts === "string" ? { index: opts } : opts);
  const res = await fetch(`${API}/accounts/${account}/vectorize/v2/indexes/${index}/info`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`vectorize info (${index}): HTTP ${res.status}`);
  return { vectorCount: json.result?.vectorCount ?? 0, dimensions: json.result?.dimensions ?? 0 };
}

/**
 * The text the cross-encoder judges a candidate on. Mirrors
 * src/dense-rag.js `titleAbstractDoc` exactly — including the ". " join and the
 * cut, because the cut is what the served reranker sees.
 * @param {any} match
 */
export function rerankDoc(match) {
  const m = match?.metadata || {};
  const title = String(m.t || "").trim();
  const abstract = String(m.a || "").trim();
  const text = [title, abstract].filter(Boolean).join(". ");
  return text.length > RERANK_DOC_CHARS ? text.slice(0, RERANK_DOC_CHARS) : text;
}

/**
 * Replay one query through the served path.
 *
 * Returns the stages SEPARATELY, because the interesting question when
 * something changes is never "what is recall" but "where did the document get
 * lost": `dense` is the pool the cross-encoder was allowed to see (the hard
 * ceiling), `ordered` is the reranked slate, `kept` is what the user gets.
 *
 * @param {string} query the natural question — NOT keyword-AND terms
 * @param {{ corpus?: string, index?: string, topK?: number, applyFloor?: boolean, floor?: number }} [opts]
 */
export async function hostedSearch(query, opts = {}) {
  const text = String(query || "").trim();
  const floor = opts.floor ?? RERANK_FLOOR;
  const t0 = Date.now();
  const { vectors } = await embedBatch([QUERY_PREFIX + text]);
  const qvec = vectors?.[0];
  if (!qvec) throw new Error("embedder returned no vector for the query");
  const tEmbed = Date.now();
  const matches = await vectorizeQuery(qvec, opts);
  const tQuery = Date.now();

  const dense = matches.map((/** @type {any} */ m) => String(m.id));
  if (matches.length < 2) {
    return {
      dense,
      ordered: dense,
      kept: dense,
      scores: [],
      scored: false,
      ms: { embed: tEmbed - t0, query: tQuery - tEmbed, rerank: 0, total: Date.now() - t0 },
    };
  }

  let scored = false;
  let ordered = matches;
  try {
    const rows = await rerank(text, matches.map(rerankDoc), { topN: matches.length });
    if (rows.length) {
      ordered = rows
        .map((/** @type {any} */ r) => (matches[r.index] ? { ...matches[r.index], rerankScore: r.score } : null))
        .filter(Boolean);
      scored = true;
    }
  } catch (/** @type {any} */ err) {
    ordered = matches;
    scored = false;
    process.stderr.write(`\n  [rerank fell back: ${err?.message || err}]\n`);
  }
  const tRerank = Date.now();

  const floored = opts.applyFloor !== false && scored
    ? ordered.filter((/** @type {any} */ m) => (m.rerankScore ?? 0) >= floor)
    : ordered;

  return {
    dense,
    ordered: ordered.map((/** @type {any} */ m) => String(m.id)),
    kept: floored.map((/** @type {any} */ m) => String(m.id)),
    scores: ordered.map((/** @type {any} */ m) => m.rerankScore ?? null),
    scored,
    ms: { embed: tEmbed - t0, query: tQuery - tEmbed, rerank: tRerank - tQuery, total: tRerank - t0 },
  };
}
