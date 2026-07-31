// @ts-check
// The corpus-agnostic dense-retrieval tier: embed the question, query a
// Vectorize index, rerank with a cross-encoder, apply a relevance floor.
//
// Extracted from src/arxiv-rag.js when PubMed became the second hosted corpus
// (2026-07-31). Everything a corpus differs in — which binding, how a match
// becomes a citable item, what text the cross-encoder judges — is a parameter;
// everything else was identical, and identical code that has to be kept in
// step in two files does not stay in step.
//
// Every constant below is a MEASURED value, and the measurements are recorded
// in docs/ARXIV-RAG.md (§4.3, §10.6) and docs/PUBMED-RAG.md. Read those before
// nudging one.

import { embedTexts } from "./berget.js";

// e5 asks for asymmetric prefixes; both indexes are built with "passage: ".
export const QUERY_PREFIX = "query: ";
export const RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
// Berget serves the reranker behind a 512-token window covering query AND
// document together, even though the model natively handles 8192. 900 chars is
// the cut that keeps a batch from being rejected outright.
export const RERANK_DOC_CHARS = 900;
// Vectorize's ceiling for `returnMetadata: "all"`, re-probed 2026-07-29 (it was
// 20 when this was first written). Going deeper means ids-only plus a
// hydrating get_by_ids pass — a second round trip that measured no better.
export const CANDIDATES = 50;

// ---- the time budget --------------------------------------------------------
// This tier runs INSIDE a search wave, so its latency is the user's latency.
// `embedTexts` is sized for document INDEXING and carries a 60 s default; one
// slow embedding call once stalled an arXiv search for close to a minute
// (feedback #44, 2026-07-27). So every leg is bounded and the whole call has a
// budget that stops the LAST leg being started at all once the earlier ones
// overspent. Every expiry is a fail-soft degrade, never an error.
export const EMBED_TIMEOUT_MS = 6000;
export const QUERY_TIMEOUT_MS = 6000;
export const RERANK_TIMEOUT_MS = 6000;
export const TOTAL_BUDGET_MS = 12_000;

// The relevance floor, applied to the CROSS-ENCODER score, never to the cosine.
// Dense retrieval always returns its nearest neighbours however far away they
// are, so an off-domain question gets confident nonsense instead of a miss. The
// floor restores the honest failure and lets the caller fall through to a live
// API. Judged on rerank score because cosine moved the WRONG WAY as the arXiv
// corpus grew and matches got better (0.8517 → 0.7890 for the top hit), while
// the rerank score rose ~6x; any cosine threshold would have been tuned to
// noise. 0.01, not the 0.1 tried first, which kept 1 of 20 candidates on a
// genuinely on-topic query.
export const RERANK_FLOOR = 0.01;

/**
 * Bound a promise that has no abort support of its own — Vectorize's `query`
 * takes no signal, so a race against a timer is the only bound available. The
 * losing promise is left to settle unobserved; what matters is that the wave
 * stops waiting.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Reorder candidates with the cross-encoder. Fails SOFT to the dense order —
 * reranking is the stage that measured +15/+17 points of recall@1 on arXiv, but
 * losing it must degrade the result, never the request. Every fallback is
 * logged: a silent one once made a whole eval report numbers for a pipeline
 * that never ran.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {any[]} matches
 * @param {{ docOf: (m: any) => string, tag: string }} opts
 * @returns {Promise<{ ordered: any[], scored: boolean }>} `scored` says whether
 *   the cross-encoder actually ran — the caller applies the relevance floor
 *   only then, since a fallback order carries no comparable scores.
 */
export async function rerankMatches(env, log, query, matches, { docOf, tag }) {
  if (matches.length < 2) return { ordered: matches, scored: false };
  try {
    const res = await fetch(`${env.BERGET_URL || "https://api.berget.ai/v1"}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BERGET_API_TOKEN}` },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents: matches.map(docOf), top_n: matches.length }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`${tag}.rerank_http`, { status: res.status });
      return { ordered: matches, scored: false };
    }
    const json = await res.json();
    const rows = json?.results || json?.data || [];
    if (!Array.isArray(rows) || !rows.length) {
      log.warn(`${tag}.rerank_empty`, {});
      return { ordered: matches, scored: false };
    }
    const ordered = rows
      .map((/** @type {any} */ r) => ({ i: r.index ?? 0, score: r.relevance_score ?? r.score ?? 0 }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score)
      .map((r) => (matches[r.i] ? { ...matches[r.i], rerankScore: r.score } : null))
      .filter(Boolean);
    return ordered.length ? { ordered, scored: true } : { ordered: matches, scored: false };
  } catch (/** @type {any} */ err) {
    log.warn(`${tag}.rerank_failed`, { error: err?.message || String(err) });
    return { ordered: matches, scored: false };
  }
}

/**
 * Search one hosted corpus. Returns null when the tier is unavailable or the
 * lookup fails — the caller then uses its live API, so a missing binding, a
 * cold index or a dead embedder all degrade to exactly the previous behaviour.
 * An empty array means "the index was asked and had nothing above the floor",
 * which is a different answer and callers treat it as one.
 *
 * @template T
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query the natural question, NOT keyword-AND terms — dense
 *   retrieval wants the prose a lexical tier would strip.
 * @param {{
 *   index: any,
 *   itemOf: (m: any) => T | null,
 *   docOf: (m: any) => string,
 *   tag: string,
 *   limit?: number,
 * }} opts
 * @returns {Promise<T[] | null>}
 */
export async function denseSearch(env, log, query, { index, itemOf, docOf, tag, limit = 5 }) {
  const started = Date.now();
  const text = String(query || "").trim();
  if (!index || !text) return null;
  try {
    const { vectors } = await embedTexts(env, [QUERY_PREFIX + text], { timeoutMs: EMBED_TIMEOUT_MS });
    const qvec = vectors?.[0];
    if (!Array.isArray(qvec)) return null;
    const res = await withTimeout(
      index.query(qvec, { topK: CANDIDATES, returnMetadata: "all" }),
      QUERY_TIMEOUT_MS,
      "vectorize query",
    );
    const matches = res?.matches || [];
    if (!matches.length) {
      log.info(`${tag}.search`, { results: 0, duration_ms: Date.now() - started });
      return [];
    }
    // Out of budget → keep the dense order rather than spending another 6 s on
    // a cross-encoder.
    const spent = Date.now() - started;
    const overBudget = spent > TOTAL_BUDGET_MS - RERANK_TIMEOUT_MS;
    if (overBudget) log.warn(`${tag}.rerank_skipped`, { spent_ms: spent });
    /** @type {{ ordered: any[], scored: boolean }} */
    const { ordered, scored } = overBudget
      ? { ordered: matches, scored: false }
      : await rerankMatches(env, log, text, matches, { docOf, tag });
    // The floor only applies when the cross-encoder actually scored: a fallback
    // order carries no comparable numbers, and dropping everything on the
    // strength of absent scores would turn a degraded result into no result.
    const kept = scored ? ordered.filter((m) => (m.rerankScore ?? 0) >= RERANK_FLOOR) : ordered;
    const items = /** @type {T[]} */ (kept.map(itemOf).filter(Boolean).slice(0, limit));
    log.info(`${tag}.search`, {
      candidates: matches.length,
      reranked: scored,
      above_floor: kept.length,
      results: items.length,
      duration_ms: Date.now() - started,
    });
    return items;
  } catch (/** @type {any} */ err) {
    log.warn(`${tag}.failed`, { error: err?.message || String(err) });
    return null;
  }
}

/**
 * The text a cross-encoder judges a candidate on: title plus abstract, cut to
 * the served window. Both corpora store the same two short metadata keys, so
 * this is one function rather than two.
 * @param {any} match
 * @returns {string}
 */
export function titleAbstractDoc(match) {
  const m = match?.metadata || {};
  const title = String(m.t || "").trim();
  const abstract = String(m.a || "").trim();
  // Joined only when both halves exist — a bare "." for an empty match would
  // be a document the cross-encoder still has to score.
  const text = [title, abstract].filter(Boolean).join(". ");
  return text.length > RERANK_DOC_CHARS ? text.slice(0, RERANK_DOC_CHARS) : text;
}
