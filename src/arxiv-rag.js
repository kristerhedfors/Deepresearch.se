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
// * **The rerank pool is 50, matching the doc's measured pipeline** (raised
//   from 20 on 2026-07-29). It was 20 because Vectorize used to cap topK at 20
//   whenever `returnMetadata: "all"` was requested. That cap has been raised;
//   probing this index directly (scripts/arxiv-hosted.mjs) now gives:
//     topK=50  returnMetadata=all  → 200, 50 matches
//     topK=100 returnMetadata=all  → 400 "max top K is 50"
//     topK=100 returnMetadata=none → 200, 100 matches
//   so 50 costs nothing extra: same single round trip, metadata still included,
//   no second store to read from. Measured over 150 needle queries (EN+SV)
//   through this exact path, pool 20 → 50 bought +4.0 points of English
//   recall@10 and +2.0 Swedish, and the cross-encoder leg did not get slower
//   (median 763 → 779 ms — its cost is request overhead, not document count).
//   docs/ARXIV-RAG.md §11 has the tables.
//   Going past 50 means `returnMetadata: "none"` plus a hydrating get_by_ids
//   pass (20 ids per call) — a second round trip that measured no better, so
//   it is deliberately not done.
// * **No BM25 arm**, matching the doc: fusing lexical in made hand-written
//   queries WORSE in both languages. The live tier is the lexical arm, and it
//   is a fallback rather than a fusion input.

import { PREPRINT_LABEL, authorsLine, citationHighlights, denseSearch, rerankMatches, titleAbstractDoc } from "./dense-rag.js";

/** @typedef {{ url: string, title: string, highlights: string[] }} ArxivItem */

// The retrieval machinery — embed, query, rerank, floor — every measured
// constant behind it, and the parts of the item mapping that both hosted
// corpora share now live in src/dense-rag.js. What stays here is what is
// arXiv-specific: the binding, the id convention, and which stored fields go
// on a source's metadata line.

/**
 * Is the dense tier available in this deployment?
 * @param {any} env
 */
export function arxivRagAvailable(env) {
  return Boolean(env?.ARXIV_INDEX && env?.BERGET_API_TOKEN);
}

/**
 * Submission month from an arXiv id ("2310.01234" → "2023-10"), or "" for
 * old-style pre-2007 ids that carry none.
 *
 * The stored `d` metadata is the paper's LAST REVISION (the harvester writes
 * OAI's <updated>, falling back to the datestamp), not its submission date —
 * arXiv's <created> is untrustworthy on that feed, so the id prefix is the only
 * reliable source (docs/ARXIV-RAG.md §3). Over a rolling 13-month window the
 * difference was cosmetic. Over 33 months it is not: a 2023 paper revised last
 * month displayed as 2026, in the one field the synthesis model uses to weigh
 * freshness — and src/arxiv.js's live tier shows the true submission date
 * (`published`) in the same slot, so the two tiers disagreed about what that
 * date meant.
 *
 * Free to fix: the id is already the vector's key, so no re-indexing is needed.
 * @param {string} id
 */
export function arxivSubmitted(id) {
  const m = /^(\d{2})(\d{2})\./.exec(String(id || "").trim());
  if (!m) return "";
  return `20${m[1]}-${m[2]}`;
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
  const meta = [
    // The same "this is a preprint" label the live tier leads with — the two
    // tiers must produce identical-looking sources (see this function's note),
    // and after 2026-08-13 that label is what stops a peer-review-only agent's
    // answer presenting an arXiv hit as reviewed work.
    PREPRINT_LABEL,
    authorsLine(m.au),
    String(m.c || ""),
    arxivSubmitted(id) || String(m.d || "").slice(0, 10),
    `arXiv:${id}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return { url: `https://arxiv.org/abs/${id}`, title, highlights: citationHighlights(meta, m.a) };
}

/**
 * The text the cross-encoder judges a candidate on: title plus abstract, cut to
 * the served window. Both hosted corpora store the same two metadata keys, so
 * this is the shared cut — kept as a named arXiv export because the unit tests
 * and any future arXiv-only tweak both address it here.
 * @param {any} match
 */
export function arxivRerankDoc(match) {
  return titleAbstractDoc(match);
}

/**
 * Reorder candidates with the cross-encoder. Fails SOFT to the dense order.
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {any[]} matches
 * @returns {Promise<{ ordered: any[], scored: boolean, tokens: number, estimated: boolean }>}
 */
export async function arxivRerank(env, log, query, matches) {
  return rerankMatches(env, log, query, matches, { docOf: arxivRerankDoc, tag: "arxiv_rag" });
}

/**
 * Search the hosted index. Returns null when the tier is unavailable or the
 * lookup fails — the caller then uses the live API, so a missing binding, a
 * cold index or a dead embedder all degrade to exactly the previous behaviour.
 * An empty array means the index was asked and nothing cleared the relevance
 * floor, which is a different answer: src/arxiv.js then falls through to the
 * live API rather than citing the index's nearest irrelevant papers.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query the user's/planner's natural question, NOT the
 *   keyword-AND terms — dense retrieval wants the prose, and the live tier's
 *   noise stripping would throw away the signal an embedder uses.
 * @param {{ limit?: number, spend?: import('./dense-rag.js').RetrievalSpend | null }} [opts]
 *   `spend` is the caller's running provider tally (src/dense-rag.js): the
 *   embedding and cross-encoder tokens this lookup costs are folded into it so
 *   the request that ran it can bill them. Omitted, nothing is tallied and the
 *   behaviour is exactly as before.
 * @returns {Promise<ArxivItem[] | null>}
 */
export async function arxivRagSearch(env, log, query, { limit = 5, spend = null } = {}) {
  if (!arxivRagAvailable(env)) return null;
  return denseSearch(env, log, query, {
    index: env.ARXIV_INDEX,
    itemOf: arxivRagItem,
    docOf: arxivRerankDoc,
    tag: "arxiv_rag",
    limit,
    spend,
  });
}
