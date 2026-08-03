// @ts-check
// The DENSE retrieval tier for the biomedical literature — PubMed embedded
// into Vectorize and searched from the Worker, the hosted half of
// docs/PUBMED-RAG.md.
//
// It stands to src/europepmc.js exactly as src/arxiv-rag.js stands to
// src/arxiv.js: Europe PMC is the LIVE tier (keyword-AND over a free REST API,
// no hosting, current to the hour), this is the dense tier (a frozen slice of
// PubMed, retrieved by meaning and reranked by a cross-encoder). They are
// complementary rather than competing, and the live one is the fallback for
// everything this one cannot answer.
//
// ---- why PubMed COMPLEMENTS arXiv rather than replacing anything -----------
//
// arXiv is preprints in physics, maths, CS and q-bio; almost no clinical or
// life-science literature lands there. PubMed is the other half of the
// research surface — 40.9 M citations from MEDLINE and the life-science
// journals, of which 29.3 M carry an abstract (measured 2026-07-31 via
// E-utilities). A question about a drug trial, a pathogen, an assay or an
// epidemiological cohort had no dense tier at all before this one; it had the
// generic web and Europe PMC's keyword AND.
//
// ---- what is deliberately NOT here -----------------------------------------
//
// No new intent gate. Europe PMC already owns "is this a life-science
// question", in both languages (invariant 6), and adding a second gate here
// would mean two regexes to keep in step and two Swedish parity suites. This
// module is a RETRIEVAL tier behind the gate that already exists.
//
// GATED ON ITS BINDING like every optional resource: with no PUBMED_INDEX
// binding it reports itself unavailable and europepmc.js behaves exactly as it
// did before. Removing the binding switches the tier off; nothing else changes.
//
// ---- the constraint a reader should know about ------------------------------
//
// PubMed abstracts are about a third longer than arXiv's (median 1,635 chars
// against ~1,200), and e5's window is 512 tokens ≈ 1,200 chars. So most
// vectors in this index were built from a TRUNCATED abstract, and a question
// whose answer lives only in the closing sentences of a long structured
// abstract is one this tier can miss where a full-text search would not. That
// is a measured limitation of the embedding window, recorded in
// docs/PUBMED-RAG.md, not something to paper over here.

import { authorsLine, citationHighlights, denseSearch, rerankMatches, titleAbstractDoc } from "./dense-rag.js";

/** @typedef {{ url: string, title: string, highlights: string[] }} PubmedItem */

/**
 * Is the dense tier available in this deployment?
 * @param {any} env
 */
export function pubmedRagAvailable(env) {
  return Boolean(env?.PUBMED_INDEX && env?.BERGET_API_TOKEN);
}

/**
 * `pmid:41610285` → `41610285`. The vector id carries the prefix so the corpus
 * is self-describing in a mixed export; every URL and citation strips it.
 * @param {string} id
 */
export function pubmedPmid(id) {
  return (String(id || "").trim().match(/^pmid:(\d+)$/) || [])[1] || "";
}

/**
 * One Vectorize match → a registry item, or null when the metadata is
 * unusable. Deliberately the same SHAPE europepmc.js's toItem produces, so the
 * two tiers are indistinguishable in the numbered source list — a user should
 * not be able to tell which one answered.
 * @param {any} match
 * @returns {PubmedItem | null}
 */
export function pubmedRagItem(match) {
  const m = match?.metadata;
  if (!m) return null;
  const pmid = pubmedPmid(match.id);
  const title = String(m.t || "").trim();
  if (!pmid || !title) return null;
  const meta = [authorsLine(m.au), String(m.j || ""), String(m.d || "").slice(0, 10), `PMID:${pmid}`]
    .filter(Boolean)
    .join(" · ");
  return {
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    title,
    highlights: citationHighlights(meta, m.a),
  };
}

/**
 * The text the cross-encoder judges a candidate on.
 * @param {any} match
 */
export function pubmedRerankDoc(match) {
  return titleAbstractDoc(match);
}

/**
 * Reorder candidates with the cross-encoder. Fails SOFT to the dense order.
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {any[]} matches
 * @returns {Promise<{ ordered: any[], scored: boolean }>}
 */
export async function pubmedRerank(env, log, query, matches) {
  return rerankMatches(env, log, query, matches, { docOf: pubmedRerankDoc, tag: "pubmed_rag" });
}

/**
 * Search the hosted index.
 *
 * Returns null when the tier is unavailable or the lookup fails, and an empty
 * array when the index was asked and nothing cleared the relevance floor.
 * europepmc.js treats both as "use the live API", but they mean different
 * things in the log and only one of them is a defect.
 *
 * The floor matters more here than it does for arXiv, and will keep mattering:
 * this index holds the most recent slice of PubMed rather than all of it, so a
 * question about a 2009 cohort study is a legitimate miss that must fall
 * through to Europe PMC rather than be answered with the nearest recent paper.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} query the natural question, not keyword-AND terms
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<PubmedItem[] | null>}
 */
export async function pubmedRagSearch(env, log, query, { limit = 5 } = {}) {
  if (!pubmedRagAvailable(env)) return null;
  return denseSearch(env, log, query, {
    index: env.PUBMED_INDEX,
    itemOf: pubmedRagItem,
    docOf: pubmedRerankDoc,
    tag: "pubmed_rag",
    limit,
  });
}
