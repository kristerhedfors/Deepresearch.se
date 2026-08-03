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
 * Embed one or more QUERIES in a single call, applying e5's asymmetric prefix.
 *
 * Batching is the whole point of the plural form: Berget's embeddings endpoint
 * takes an array, so six research angles cost ONE round trip rather than six,
 * and the cost of asking a corpus several questions at once collapses to the
 * cost of asking it one. src/literature-run.js's parallel multi-angle search is
 * built on exactly this; denseSearch below is the one-element case.
 *
 * @param {any} env
 * @param {string[]} queries
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<number[][]>} one vector per query, in the queries' order
 */
export async function embedQueries(env, queries, { timeoutMs = EMBED_TIMEOUT_MS } = {}) {
  const { vectors } = await embedTexts(
    env,
    queries.map((q) => QUERY_PREFIX + q),
    { timeoutMs },
  );
  return Array.isArray(vectors) ? vectors : [];
}

/**
 * Retrieve and rerank ONE (query vector, index) pair, returning the SCORED
 * matches rather than mapped items.
 *
 * This is denseSearch's body with the embedding lifted out and the mapping left
 * to the caller — extracted so a caller that already holds a query vector (a
 * batch of angles embedded together) or that wants the cross-encoder scores
 * themselves (the MCP literature tools, which hand an agent the relevance
 * number it is going to sort on) does not have to re-implement the budget
 * discipline and the floor to get them.
 *
 * Returns null on failure, exactly as denseSearch does, so a dead index or a
 * rejected query degrades to the caller's fallback rather than to an error.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {{
 *   index: any,
 *   qvec: number[],
 *   query: string,
 *   docOf: (m: any) => string,
 *   tag: string,
 *   startedAt?: number,
 *   floor?: number,
 * }} opts `startedAt` lets a batched caller charge the shared embedding leg
 *   against this call's budget, so one slow embed cannot let every retrieval
 *   in the batch start a 6 s cross-encoder afterwards.
 * @returns {Promise<{ matches: any[], scored: boolean, candidates: number, aboveFloor: number } | null>}
 */
export async function denseRetrieve(env, log, { index, qvec, query, docOf, tag, startedAt, floor = RERANK_FLOOR }) {
  const started = typeof startedAt === "number" ? startedAt : Date.now();
  if (!index || !Array.isArray(qvec) || !qvec.length) return null;
  try {
    const res = await withTimeout(
      index.query(qvec, { topK: CANDIDATES, returnMetadata: "all" }),
      QUERY_TIMEOUT_MS,
      "vectorize query",
    );
    const matches = res?.matches || [];
    if (!matches.length) return { matches: [], scored: false, candidates: 0, aboveFloor: 0 };
    // Out of budget → keep the dense order rather than spending another 6 s on
    // a cross-encoder.
    const spent = Date.now() - started;
    const overBudget = spent > TOTAL_BUDGET_MS - RERANK_TIMEOUT_MS;
    if (overBudget) log.warn(`${tag}.rerank_skipped`, { spent_ms: spent });
    /** @type {{ ordered: any[], scored: boolean }} */
    const { ordered, scored } = overBudget
      ? { ordered: matches, scored: false }
      : await rerankMatches(env, log, query, matches, { docOf, tag });
    // The floor only applies when the cross-encoder actually scored: a fallback
    // order carries no comparable numbers, and dropping everything on the
    // strength of absent scores would turn a degraded result into no result.
    const kept = scored ? ordered.filter((m) => (m.rerankScore ?? 0) >= floor) : ordered;
    return { matches: kept, scored, candidates: matches.length, aboveFloor: kept.length };
  } catch (/** @type {any} */ err) {
    log.warn(`${tag}.failed`, { error: err?.message || String(err) });
    return null;
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
    const qvec = (await embedQueries(env, [text], { timeoutMs: EMBED_TIMEOUT_MS }))[0];
    if (!Array.isArray(qvec)) return null;
    const found = await denseRetrieve(env, log, { index, qvec, query: text, docOf, tag, startedAt: started });
    if (!found) return null;
    if (!found.candidates) {
      log.info(`${tag}.search`, { results: 0, duration_ms: Date.now() - started });
      return [];
    }
    const items = /** @type {T[]} */ (found.matches.map(itemOf).filter(Boolean).slice(0, limit));
    log.info(`${tag}.search`, {
      candidates: found.candidates,
      reranked: found.scored,
      above_floor: found.aboveFloor,
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

// ---- the shared half of `itemOf` --------------------------------------------
// `denseSearch` takes both per-corpus callbacks as parameters, and the shared
// implementation of the first one — `docOf` — is `titleAbstractDoc` above.
// These are the shared implementation of the second. What a corpus genuinely
// differs in (its URL, and which stored fields go on the metadata line) stays
// in src/arxiv-rag.js and src/pubmed-rag.js; the author formatting and the
// abstract cut are the same in both because they are REQUIRED to be: each
// tier's mapper exists to look exactly like its live sibling's, so a reader of
// the numbered source list cannot tell which tier answered. That property is
// invisible when it breaks, which is why the cut length is one constant.

// The presentation cut, matching the live tiers. Unrelated to RERANK_DOC_CHARS
// above: that one is what the cross-encoder reads, this is what the user does.
export const MAX_ABSTRACT_CHARS = 420;

/**
 * The stored `au` metadata ("A; B; C; D") → a citation author line, first three
 * names with "et al." for the rest, or "" when there are none.
 * @param {any} value
 * @returns {string}
 */
export function authorsLine(value) {
  const authors = String(value || "")
    .split(";")
    .map((a) => a.trim())
    .filter(Boolean);
  const shown = authors.slice(0, 3).join(", ");
  return authors.length ? `${shown}${authors.length > 3 ? " et al." : ""}` : "";
}

/**
 * The `highlights` array of a citable item: the metadata line, then the
 * abstract when there is one, cut to MAX_ABSTRACT_CHARS.
 * @param {string} metaLine
 * @param {any} abstract the stored `a` metadata, unparsed
 * @returns {string[]}
 */
export function citationHighlights(metaLine, abstract) {
  const text = String(abstract || "").trim();
  /** @type {string[]} */
  const highlights = [metaLine];
  if (text) {
    highlights.push(text.length > MAX_ABSTRACT_CHARS ? `${text.slice(0, MAX_ABSTRACT_CHARS).trimEnd()}…` : text);
  }
  return highlights;
}
