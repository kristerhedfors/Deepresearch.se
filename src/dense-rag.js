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

// ---- what a rerank costs ----------------------------------------------------
// The cross-encoder is the whole provider cost of a dense retrieval: CANDIDATES
// documents cut to RERANK_DOC_CHARS each, scored against the query, at Berget's
// €0.10 per 1M tokens — three orders of magnitude above the one embedding call
// that precedes it (docs/MCP-COST.md §1).
//
// Berget's /v1/rerank answers with a `usage` block, which this tier used to read
// past. It is plumbed out now (rerankMatches returns `tokens`) because a
// MEASURED count is always better than a count inferred from string lengths, and
// because src/literature-run.js and src/billing.js bill a quota on it.
//
// The ratio below is only for the case where the endpoint returns no `usage` at
// all. Its basis is the single measurement we have of the exact shape this tier
// sends: 50 documents cut to 900 chars scored `usage.total_tokens = 10,198` on a
// live call, 2026-08-05 — 45,000 / 10,198 = 4.41 chars per token. The query is
// re-tokenized once per (query, document) pair and is NOT added separately here:
// the measured call carried a query too, so its contribution is already inside
// the ratio, and a query is short beside a 900-char document.
export const RERANK_CHARS_PER_TOKEN = 4.41;

/**
 * Fallback token count for a rerank whose response carried no `usage` block.
 * Estimated, never measured — see the note above for the basis.
 * @param {string[]} docs the documents as sent
 * @returns {number}
 */
export function estimateRerankTokens(docs) {
  let chars = 0;
  for (const d of docs) chars += String(d || "").length;
  return Math.round(chars / RERANK_CHARS_PER_TOKEN);
}

// ---- the running tally ------------------------------------------------------
// Two callers spend this tier's money and both have to bill it: the MCP
// literature tools (src/literature-run.js, one tally per tool call) and the
// /api/chat research pipeline (src/pipeline.js, one tally per REQUEST, since a
// request can run several legs — multiple angles, two corpora, several search
// rounds). The tally shape and the folding are here, next to the numbers, so
// there is one definition of what a dense retrieval costs rather than one per
// caller. Pricing it is src/billing.js's job (priceRetrievalSpend): that needs
// Berget's raw catalog, and this module must stay a leaf over berget.js.
//
// Accumulate, never overwrite — legs run concurrently, but JS is
// single-threaded, so `+=` needs no coordination.

/**
 * One caller's provider spend from this tier, in tokens.
 * @typedef {Object} RetrievalSpend
 * @property {number} embedTokens
 * @property {number} rerankTokens
 * @property {number} rerankCalls how many cross-encoder calls reported a cost
 * @property {number} estimatedCalls how many of those were estimated, not measured
 * @property {string} embedModelId the model the embedder actually answered as
 */

/** @returns {RetrievalSpend} */
export function newRetrievalSpend() {
  return { embedTokens: 0, rerankTokens: 0, rerankCalls: 0, estimatedCalls: 0, embedModelId: "" };
}

/**
 * Fold one denseRetrieve result's cross-encoder cost into the running spend.
 * @param {RetrievalSpend | null | undefined} spend
 * @param {{ rerankTokens?: number, rerankEstimated?: boolean } | null | undefined} found
 */
export function addRerankSpend(spend, found) {
  if (!spend || !found?.rerankTokens) return;
  spend.rerankTokens += found.rerankTokens;
  spend.rerankCalls += 1;
  if (found.rerankEstimated) spend.estimatedCalls += 1;
}

/**
 * Fold one embedQueries result's cost into the running spend.
 * @param {RetrievalSpend | null | undefined} spend
 * @param {{ usage?: any, model?: string } | null | undefined} embedded
 */
export function addEmbedSpend(spend, embedded) {
  if (!spend || !embedded) return;
  spend.embedTokens += Number(embedded.usage?.prompt_tokens ?? embedded.usage?.total_tokens ?? 0) || 0;
  if (embedded.model) spend.embedModelId = embedded.model;
}

/**
 * Fold one tally into another — how a per-leg or per-source tally reaches the
 * per-request one. Fail-soft in both directions: either side missing is a
 * no-op, never a throw, because accounting must not break a search wave.
 * @param {RetrievalSpend | null | undefined} into
 * @param {RetrievalSpend | null | undefined} from
 */
export function mergeRetrievalSpend(into, from) {
  if (!into || !from) return;
  into.embedTokens += from.embedTokens || 0;
  into.rerankTokens += from.rerankTokens || 0;
  into.rerankCalls += from.rerankCalls || 0;
  into.estimatedCalls += from.estimatedCalls || 0;
  if (from.embedModelId) into.embedModelId = from.embedModelId;
}

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
 * @returns {Promise<{ ordered: any[], scored: boolean, tokens: number, estimated: boolean }>}
 *   `scored` says whether the cross-encoder actually ran — the caller applies
 *   the relevance floor only then, since a fallback order carries no comparable
 *   scores. `tokens` is what the call cost, taken from the endpoint's own
 *   `usage` block when it sends one and estimated from the documents' length
 *   when it does not (`estimated` says which). A leg that never reached the
 *   provider, or whose call failed, reports 0: what is billed is what a
 *   response said, and under-billing a failure is the fail-soft direction.
 */
export async function rerankMatches(env, log, query, matches, { docOf, tag }) {
  if (matches.length < 2) return { ordered: matches, scored: false, tokens: 0, estimated: false };
  const documents = matches.map(docOf);
  try {
    const res = await fetch(`${env.BERGET_URL || "https://api.berget.ai/v1"}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BERGET_API_TOKEN}` },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents, top_n: matches.length }),
      signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn(`${tag}.rerank_http`, { status: res.status });
      return { ordered: matches, scored: false, tokens: 0, estimated: false };
    }
    const json = await res.json();
    // The provider's own count, whatever the rest of the response turns out to
    // be: the tokens were spent before the rows were read.
    const reported = Number(json?.usage?.total_tokens ?? json?.usage?.prompt_tokens ?? 0);
    const estimated = !(reported > 0);
    const tokens = estimated ? estimateRerankTokens(documents) : reported;
    const rows = json?.results || json?.data || [];
    if (!Array.isArray(rows) || !rows.length) {
      log.warn(`${tag}.rerank_empty`, {});
      return { ordered: matches, scored: false, tokens, estimated };
    }
    const ordered = rows
      .map((/** @type {any} */ r) => ({ i: r.index ?? 0, score: r.relevance_score ?? r.score ?? 0 }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score)
      .map((r) => (matches[r.i] ? { ...matches[r.i], rerankScore: r.score } : null))
      .filter(Boolean);
    return ordered.length
      ? { ordered, scored: true, tokens, estimated }
      : { ordered: matches, scored: false, tokens, estimated };
  } catch (/** @type {any} */ err) {
    log.warn(`${tag}.rerank_failed`, { error: err?.message || String(err) });
    return { ordered: matches, scored: false, tokens: 0, estimated: false };
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
 * The return shape MIRRORS embedTexts' own — `{ vectors, usage, model }`. It
 * used to be the vectors alone, which threw away the provider's token report;
 * src/literature-run.js bills on it, and a caller that wants only the vectors
 * destructures one field.
 *
 * @param {any} env
 * @param {string[]} queries
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ vectors: number[][], usage: any, model: string }>} one
 *   vector per query, in the queries' order, plus the call's usage and model
 */
export async function embedQueries(env, queries, { timeoutMs = EMBED_TIMEOUT_MS } = {}) {
  const { vectors, usage, model } = await embedTexts(
    env,
    queries.map((q) => QUERY_PREFIX + q),
    { timeoutMs },
  );
  return { vectors: Array.isArray(vectors) ? vectors : [], usage: usage || null, model };
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
 * @returns {Promise<{ matches: any[], scored: boolean, candidates: number, aboveFloor: number, rerankTokens: number, rerankEstimated: boolean } | null>}
 *   `rerankTokens` is this leg's cross-encoder spend, which is what the leg
 *   costs — a caller that meters (src/literature-run.js) sums it across legs.
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
    if (!matches.length) {
      return { matches: [], scored: false, candidates: 0, aboveFloor: 0, rerankTokens: 0, rerankEstimated: false };
    }
    // Out of budget → keep the dense order rather than spending another 6 s on
    // a cross-encoder.
    const spent = Date.now() - started;
    const overBudget = spent > TOTAL_BUDGET_MS - RERANK_TIMEOUT_MS;
    if (overBudget) log.warn(`${tag}.rerank_skipped`, { spent_ms: spent });
    /** @type {{ ordered: any[], scored: boolean, tokens: number, estimated: boolean }} */
    const { ordered, scored, tokens, estimated } = overBudget
      ? { ordered: matches, scored: false, tokens: 0, estimated: false }
      : await rerankMatches(env, log, query, matches, { docOf, tag });
    // The floor only applies when the cross-encoder actually scored: a fallback
    // order carries no comparable numbers, and dropping everything on the
    // strength of absent scores would turn a degraded result into no result.
    const kept = scored ? ordered.filter((m) => (m.rerankScore ?? 0) >= floor) : ordered;
    return {
      matches: kept,
      scored,
      candidates: matches.length,
      aboveFloor: kept.length,
      rerankTokens: tokens,
      rerankEstimated: estimated,
    };
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
 *   spend?: RetrievalSpend | null,
 * }} opts `spend` is an OPTIONAL running tally the caller owns: this call folds
 *   its embedding and cross-encoder tokens into it so the caller can bill them.
 *   Omitting it is the pre-metering behaviour exactly — the tally is the only
 *   thing it changes, and a caller with no way to bill (a test, a probe) passes
 *   nothing. The folding is unconditional on the RESULT: an empty index, a
 *   below-floor result and a returned-null failure all still cost whatever
 *   reached the provider before they gave up.
 * @returns {Promise<T[] | null>}
 */
export async function denseSearch(env, log, query, { index, itemOf, docOf, tag, limit = 5, spend = null }) {
  const started = Date.now();
  const text = String(query || "").trim();
  if (!index || !text) return null;
  try {
    const embedded = await embedQueries(env, [text], { timeoutMs: EMBED_TIMEOUT_MS });
    addEmbedSpend(spend, embedded);
    const qvec = embedded.vectors[0];
    if (!Array.isArray(qvec)) return null;
    const found = await denseRetrieve(env, log, { index, qvec, query: text, docOf, tag, startedAt: started });
    addRerankSpend(spend, found);
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
