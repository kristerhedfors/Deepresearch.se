#!/usr/bin/env node
// The Vectorize REST client + a faithful replay of the SERVED arXiv retrieval
// path, so the hosted index can be measured with the same discipline the local
// pack already is.
//
// WHY THIS EXISTS: docs/ARXIV-RAG.md §10.7 records that the headline
// "87% recall@1 / 96% recall@10" was measured by scripts/arxiv-eval.mjs against
// the LOCAL binary pack, with a rerank pool of 50 — and that the hosted path is
// a different pipeline. Vectorize caps `topK` at 20 when `returnMetadata: "all"`
// is asked for, so the served rerank pool is 20, not 50, and nobody had ever
// run a query set through the thing users actually hit. Every number this file
// produces describes the deployed path.
//
// The replay is deliberately line-for-line with src/arxiv-rag.js: same
// `query: ` prefix, same topK, same cross-encoder over `title. abstract` cut to
// RERANK_DOC_CHARS, same 0.01 floor applied only when the reranker actually
// scored. The one thing NOT replicated is the served time budget (embed 6 s /
// query 6 s / rerank 6 s / 12 s total): an eval that silently dropped the
// rerank under load would measure a different pipeline per query and report the
// average of two things — exactly the failure §5 warns about. Latency is
// measured and reported instead, so budget overruns are visible rather than
// baked into the score.
//
// ---- the transport ----------------------------------------------------------
// The Worker reaches Vectorize through the ARXIV_INDEX binding, which does not
// exist in Node. The REST API is the same index and the same query semantics:
//   POST /accounts/{acct}/vectorize/v2/indexes/{name}/query
//   POST /accounts/{acct}/vectorize/v2/indexes/{name}/get_by_ids
// `get_by_ids` is what makes an unbiased gold set possible at all — see
// scripts/arxiv-hosted-eval.mjs.
//
// NODE_USE_ENV_PROXY=1 is required behind an agent proxy (Node's built-in fetch
// ignores HTTPS_PROXY without it, and every call then fails with a 503 that
// reads exactly like Cloudflare being down).

import { QUERY_PREFIX } from "../public/js/arxiv-rag-core.js";
import { RERANK_DOC_CHARS, embedBatch, rerank } from "./arxiv-berget.mjs";

/**
 * The pool src/arxiv-rag.js currently asks for.
 *
 * Its comment says 20 is Vectorize's ceiling with `returnMetadata: "all"`.
 * Measured against THIS index on 2026-07-29, that is not true:
 *
 *   topK=50  returnMetadata=all      → 200, 50 matches
 *   topK=100 returnMetadata=all      → 400 "max top K is 50 … retry with
 *                                      returnValues=false and returnMetadata=indexed"
 *   topK=100 returnMetadata=none     → 200, 100 matches
 *   topK=200 returnMetadata=none     → 400 "max top K is 100"
 *
 * So the real ceilings are 50 with full metadata and 100 without, and the
 * served path has been reranking a fifth of the candidates it could have had.
 * That matters more than any other knob here, because r@10 sits ON the pool
 * ceiling (see the BEFORE table in docs/ARXIV-RAG.md §11).
 */
export const CANDIDATES = 20;

/** Vectorize's measured ceiling when full metadata is requested. */
export const MAX_TOPK_WITH_METADATA = 50;

/** Vectorize's measured ceiling when only ids are needed. */
export const MAX_TOPK = 100;

/** src/arxiv-rag.js's RERANK_FLOOR, on the CROSS-ENCODER score (never cosine). */
export const RERANK_FLOOR = 0.01;

export const DEFAULT_INDEX = "deepresearch-se-arxiv";

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 60_000;

// Measured: "40007 too many ids in payload; max id count is 20".
const GET_BY_IDS_BATCH = 20;

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
    const detail = json?.errors?.map((/** @type {any} */ e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`vectorize ${path}: ${detail}`);
  }
  return json.result;
}

/**
 * Dense query against the hosted index, in served configuration.
 * @param {number[] | Float32Array} vector
 * @param {{ index?: string, topK?: number }} [opts]
 * @returns {Promise<any[]>} matches, descending by score
 */
export async function vectorizeQuery(vector, opts = {}) {
  const topK = opts.topK || CANDIDATES;
  // Past 50 the index will not return metadata at all, so the candidates come
  // back as bare ids and are hydrated in a second pass. That costs
  // ceil(topK/20) extra round trips — the question the pool sweep exists to
  // answer is whether the recall it buys is worth them.
  const withMetadata = topK <= MAX_TOPK_WITH_METADATA;
  const result = await vectorizePost(opts.index || DEFAULT_INDEX, "query", {
    vector: Array.from(vector),
    topK: Math.min(topK, MAX_TOPK),
    returnMetadata: withMetadata ? "all" : "none",
    returnValues: false,
  });
  const matches = result?.matches || [];
  if (withMetadata || !matches.length) return matches;
  const hydrated = await hydrate(matches.map((m) => String(m.id)), opts);
  // Preserve the dense ORDER — get_by_ids returns rows in whatever order it
  // likes, and reordering the candidate list would silently change what the
  // cross-encoder is handed and what "dense rank" means.
  return matches.map((m) => ({ ...m, metadata: hydrated.get(String(m.id))?.metadata || null })).filter((m) => m.metadata);
}

/**
 * ids → their stored metadata, in ceil(n/20) batched calls.
 * @param {string[]} ids
 * @param {{ index?: string }} [opts]
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
 * Fetch specific vectors (with metadata) by arXiv id.
 *
 * This is the primitive that lets a gold set be sampled WITHOUT bias: ids come
 * from the independent GCS enumeration, and only their hydration touches the
 * index. Sampling papers by querying the index instead would select for papers
 * that retrieve well and inflate every recall number reported here.
 *
 * @param {string[]} ids
 * @param {{ index?: string }} [opts]
 */
export async function vectorizeGetByIds(ids, opts = {}) {
  if (!ids.length) return [];
  const result = await vectorizePost(opts.index || DEFAULT_INDEX, "get_by_ids", { ids });
  return Array.isArray(result) ? result : result?.vectors || [];
}

/** How many vectors the index currently holds (the before/after headline). */
export async function vectorizeCount(index = DEFAULT_INDEX) {
  const { account, token } = requireCloudflare();
  const res = await fetch(`${API}/accounts/${account}/vectorize/v2/indexes/${index}/info`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`vectorize info: HTTP ${res.status}`);
  return { vectorCount: json.result?.vectorCount ?? 0, dimensions: json.result?.dimensions ?? 0 };
}

/**
 * The text the cross-encoder judges a candidate on. Mirrors
 * src/arxiv-rag.js `arxivRerankDoc` exactly — including the ". " join and the
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
 * Returns the stages separately, because the interesting question when a
 * corpus grows is never "what is recall" but "where did the paper get lost":
 * `dense` is the pool the cross-encoder was allowed to see (the hard ceiling
 * §10.7 is about), `ordered` is what the user would get.
 *
 * @param {string} query the natural question — NOT keyword-AND terms
 * @param {{ index?: string, topK?: number, applyFloor?: boolean }} [opts]
 */
export async function hostedSearch(query, opts = {}) {
  const text = String(query || "").trim();
  const t0 = Date.now();
  const { vectors } = await embedBatch([QUERY_PREFIX + text]);
  const qvec = vectors?.[0];
  if (!qvec) throw new Error("embedder returned no vector for the query");
  const tEmbed = Date.now();
  const matches = await vectorizeQuery(qvec, opts);
  const tQuery = Date.now();

  const dense = matches.map((m) => String(m.id));
  if (matches.length < 2) {
    return { dense, ordered: dense, scored: false, kept: dense, ms: { embed: tEmbed - t0, query: tQuery - tEmbed, rerank: 0, total: Date.now() - t0 } };
  }

  // Fails soft exactly like the served path — but LOUDLY. A silent degradation
  // to the candidate order once made a whole bake-off report numbers for a
  // pipeline that never ran (docs/ARXIV-RAG.md §5), so the caller is told.
  let scored = false;
  let ordered = matches;
  try {
    const rows = await rerank(text, matches.map(rerankDoc), { topN: matches.length });
    if (rows.length) {
      ordered = rows.map((r) => (matches[r.index] ? { ...matches[r.index], rerankScore: r.score } : null)).filter(Boolean);
      scored = true;
    }
  } catch (err) {
    ordered = matches;
    scored = false;
    process.stderr.write(`\n  [rerank fell back: ${err?.message || err}]\n`);
  }
  const tRerank = Date.now();

  const floored = opts.applyFloor !== false && scored
    ? ordered.filter((m) => (m.rerankScore ?? 0) >= RERANK_FLOOR)
    : ordered;

  return {
    dense,
    ordered: ordered.map((m) => String(m.id)),
    kept: floored.map((m) => String(m.id)),
    scores: ordered.map((m) => m.rerankScore ?? null),
    scored,
    ms: { embed: tEmbed - t0, query: tQuery - tEmbed, rerank: tRerank - tQuery, total: tRerank - t0 },
  };
}
