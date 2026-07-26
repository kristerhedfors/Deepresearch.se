// @ts-check
// The DENSE retrieval tier for the arXiv search source — the hosted half of
// docs/ARXIV-RAG.md, reachable from a Worker.
//
// src/arxiv.js is the LIVE-API tier: keyword-AND over abstracts, no hosting,
// but bounded by arXiv's published rate limit (1 request / 3 s, with no paid
// tier to buy past it) and by what a lexical AND can express. This module is
// the other half: the corpus embedded once into Vectorize and searched with
// the pipeline docs/ARXIV-RAG.md §4.3 settled on —
//
//     dense retrieval → bge-reranker-v2-m3, NO lexical arm
//
// which measured 87% recall@1 / 96% recall@10 English and 81% / 90% Swedish
// over all 326,814 papers. Two properties matter beyond the numbers: arXiv is
// no longer in the request path at all (so the rate limit stops mattering),
// and the user's question never reaches arXiv — it leaves this Worker only as
// an embedding call, which is the privacy posture the project exists to
// demonstrate.
//
// GATED ON ITS BINDING, like every optional resource here: with no
// ARXIV_INDEX binding this module reports itself unavailable and arxiv.js
// simply uses the live API. Adding the binding switches the tier on; removing
// it switches it off. Nothing else changes.
//
// ---- deviations from docs/ARXIV-RAG.md, and why ----------------------------
// * **The rerank pool is 20, not 50.** The doc's measured pipeline reranks the
//   top 50. Vectorize caps topK at 20 when `returnMetadata: "all"` (measured
//   in src/rag.js against this same account — the published limit of 50 does
//   not apply to the "all" mode). Fetching 50 ids without metadata and then
//   reading the text from a second store would restore the pool at the cost of
//   a second round trip per search; that trade is not obviously worth it and
//   has not been measured, so the shallower pool is DELIBERATE and its recall
//   is NOT the doc's 87% until re-measured. Do not quote that number for this
//   path without running the eval.
// * **No BM25 arm**, matching the doc: fusing lexical in made hand-written
//   queries WORSE in both languages. The live tier is the lexical arm, and it
//   is a fallback rather than a fusion input.

import { embedTexts } from "./berget.js";

/** @typedef {{ url: string, title: string, highlights: string[] }} ArxivItem */

// e5 asks for asymmetric prefixes; the index is built with "passage: ".
const QUERY_PREFIX = "query: ";
const RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
// Berget serves the reranker behind a 512-token window covering query AND
// document together, even though the model natively handles 8192 (measured
// 2026-07-26, recorded in the arxiv-rag skill). 900 chars is the cut that
// keeps a batch from being rejected outright.
const RERANK_DOC_CHARS = 900;
const CANDIDATES = 20; // the Vectorize returnMetadata:"all" ceiling
const RERANK_TIMEOUT_MS = 6000;
const MAX_ABSTRACT_CHARS = 420; // presentation cut, matches the live tier
// The relevance floor, applied to the CROSS-ENCODER score. Dense retrieval
// always returns its nearest neighbours, however far away they are — ask a
// graphene question of an index holding only LLM papers and you get confident
// nonsense rather than nothing. A keyword AND fails honestly in that case; a
// vector search does not, so the floor is what restores the honest failure and
// lets arxiv.js fall through to the live API.
//
// It matters most while the corpus is PARTIAL (a full harvest at arXiv's
// published request rate takes many hours, so the index grows over several
// runs), but it earns its keep afterwards too: a year of arXiv still does not
// contain every subject a user might ask about.
//
// Judged on bge-reranker-v2-m3's relevance_score, NOT on the e5 cosine. That
// choice and the value are both measured (2026-07-26, live index), at two
// corpus sizes:
//
//                                            512 papers        26,624 papers
//   query                                  cosine  rerank     cosine  rerank
//   "how do multiple LLM agents collab…"   0.8517  0.16638    0.7890  0.83008
//   "critical temperature of graphene…"    0.8503  0.05429    0.7703  0.36548
//   "best pizza recipe napoletana dough"   0.7925  0.00002    0.7112  0.00005
//
// Read the first pair of columns and the cosine already looks unusable as a
// gate: 0.85 for a good match, 0.85 for an unrelated one, and the outright
// nonsense query still at 0.79. Read ACROSS the two corpus sizes and it is
// settled — as the corpus grew and the top match got much better, its cosine
// went DOWN (0.8517 → 0.7890) while the rerank score went up fivefold. Any
// cosine threshold would have been tuned to noise and would drift with every
// upsert. The rerank scores separate the same three cases by four orders of
// magnitude at both sizes.
//
// The value is 0.01, not the 0.1 tried first: this reranker's scores are
// compressed toward zero, so 0.1 kept only 1 of 20 candidates on the
// genuinely on-topic query and rejected the graphene-superconductivity papers
// outright. 0.01 keeps weak-but-real relevance (0.054, 0.025) while still
// rejecting the pizza query's entire slate by 500x. Re-measure if the
// reranker model changes; do not nudge it by feel.
//
// When the rerank itself failed, no floor is applied: the scores would be
// missing, and silently dropping everything would be worse than passing the
// dense order on.
const RERANK_FLOOR = 0.01;

/**
 * Is the dense tier available in this deployment?
 * @param {any} env
 */
export function arxivRagAvailable(env) {
  return Boolean(env?.ARXIV_INDEX && env?.BERGET_API_TOKEN);
}

/**
 * One Vectorize match → a registry item, or null when the metadata is
 * unusable. Mirrors arxivMapEntry's shape exactly so both tiers produce
 * identical-looking sources.
 * @param {any} match
 * @returns {ArxivItem | null}
 */
export function arxivRagItem(match) {
  const m = match?.metadata;
  if (!m) return null;
  const id = String(match.id || "").trim();
  const title = String(m.t || "").trim();
  if (!id || !title) return null;
  const authors = String(m.au || "")
    .split(";")
    .map((a) => a.trim())
    .filter(Boolean);
  const shown = authors.slice(0, 3).join(", ");
  const meta = [
    authors.length ? `${shown}${authors.length > 3 ? " et al." : ""}` : "",
    String(m.c || ""),
    String(m.d || "").slice(0, 10),
    `arXiv:${id}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const abstract = String(m.a || "").trim();
  /** @type {string[]} */
  const highlights = [meta];
  if (abstract) {
    highlights.push(
      abstract.length > MAX_ABSTRACT_CHARS ? `${abstract.slice(0, MAX_ABSTRACT_CHARS).trimEnd()}…` : abstract,
    );
  }
  return { url: `https://arxiv.org/abs/${id}`, title, highlights };
}

/**
 * The text the cross-encoder judges a candidate on: title plus abstract, cut
 * to the served window. Pure, so the cut is unit-testable.
 * @param {any} match
 */
export function arxivRerankDoc(match) {
  const m = match?.metadata || {};
  const title = String(m.t || "").trim();
  const abstract = String(m.a || "").trim();
  // Joined only when both halves exist — a bare "." for an empty match would
  // be a document the cross-encoder still has to score.
  const text = [title, abstract].filter(Boolean).join(". ");
  return text.length > RERANK_DOC_CHARS ? text.slice(0, RERANK_DOC_CHARS) : text;
}

/**
 * Reorder candidates with the cross-encoder. Fails SOFT to the dense order —
 * reranking is the stage that measured +15/+17 points of recall@1, but losing
 * it must degrade the result, never the request. (docs/ARXIV-RAG.md warns that
 * a silent fallback here once made a whole eval report numbers for a pipeline
 * that never ran, so every fallback is logged.)
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {any[]} matches
 * @returns {Promise<{ ordered: any[], scored: boolean }>} `scored` says whether
 *   the cross-encoder actually ran — the caller applies its relevance floor
 *   only then, since a fallback order carries no comparable scores.
 */
export async function arxivRerank(env, log, query, matches) {
  if (matches.length < 2) return { ordered: matches, scored: false };
  try {
    const res = await fetch(`${env.BERGET_URL || "https://api.berget.ai/v1"}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BERGET_API_TOKEN}` },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query,
        documents: matches.map(arxivRerankDoc),
        top_n: matches.length,
      }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("arxiv_rag.rerank_http", { status: res.status });
      return { ordered: matches, scored: false };
    }
    const json = await res.json();
    const rows = json?.results || json?.data || [];
    if (!Array.isArray(rows) || !rows.length) {
      log.warn("arxiv_rag.rerank_empty", {});
      return { ordered: matches, scored: false };
    }
    const ordered = rows
      .map((/** @type {any} */ r) => ({ i: r.index ?? 0, score: r.relevance_score ?? r.score ?? 0 }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score)
      .map((r) => (matches[r.i] ? { ...matches[r.i], rerankScore: r.score } : null))
      .filter(Boolean);
    return ordered.length ? { ordered, scored: true } : { ordered: matches, scored: false };
  } catch (/** @type {any} */ err) {
    log.warn("arxiv_rag.rerank_failed", { error: err?.message || String(err) });
    return { ordered: matches, scored: false };
  }
}

/**
 * Search the hosted index. Returns null when the tier is unavailable or the
 * lookup fails — the caller then uses the live API, so a missing binding, a
 * cold index or a dead embedder all degrade to exactly the previous behaviour.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query the user's/planner's natural question, NOT the
 *   keyword-AND terms — dense retrieval wants the prose, and the live tier's
 *   noise stripping would throw away the signal an embedder uses.
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<ArxivItem[] | null>}
 */
export async function arxivRagSearch(env, log, query, { limit = 5 } = {}) {
  if (!arxivRagAvailable(env)) return null;
  const started = Date.now();
  const text = String(query || "").trim();
  if (!text) return null;
  try {
    const { vectors } = await embedTexts(env, [QUERY_PREFIX + text]);
    const qvec = vectors?.[0];
    if (!Array.isArray(qvec)) return null;
    const res = await env.ARXIV_INDEX.query(qvec, { topK: CANDIDATES, returnMetadata: "all" });
    const matches = res?.matches || [];
    if (!matches.length) {
      log.info("arxiv_rag.search", { results: 0, duration_ms: Date.now() - started });
      return [];
    }
    const { ordered, scored } = await arxivRerank(env, log, text, matches);
    // The floor only applies when the cross-encoder actually scored: a
    // fallback order carries no comparable numbers, and dropping everything on
    // the strength of absent scores would turn a degraded result into no
    // result at all.
    const kept = scored ? ordered.filter((m) => (m.rerankScore ?? 0) >= RERANK_FLOOR) : ordered;
    const items = kept
      .map(arxivRagItem)
      .filter(/** @returns {i is ArxivItem} */ (i) => Boolean(i))
      .slice(0, limit);
    log.info("arxiv_rag.search", {
      candidates: matches.length,
      reranked: scored,
      above_floor: kept.length,
      results: items.length,
      duration_ms: Date.now() - started,
    });
    // Nothing cleared the floor → report a miss, so arxiv.js falls through to
    // the live API rather than citing the index's nearest irrelevant papers.
    return items;
  } catch (/** @type {any} */ err) {
    log.warn("arxiv_rag.failed", { error: err?.message || String(err) });
    return null;
  }
}
