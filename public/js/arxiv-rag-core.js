// @ts-check
// The pure core of the arXiv RAG search database: passage construction, the
// lexical (BM25) index, rank fusion and doc-level pooling. No I/O, no network,
// no DOM — the builder (scripts/arxiv-index.mjs), the search CLI
// (scripts/arxiv-search.mjs) and the bake-off harness (scripts/arxiv-eval.mjs)
// all drive the SAME functions, so what the evaluation measured is what the
// index actually does.
//
// Vector maths is NOT reimplemented here: quantizeInt8 / int8ToB64 /
// b64ToInt8 / cosineF32Int8 come from introspect-core.js, which already owns
// the project's int8 embedding convention (one shared implementation, per the
// refactor-clarity pure-core rule).
//
// The retrieval pipeline this core supports, in the order a query flows:
//
//   query → [optional LLM expansion] → embed("query: …")  ─┐
//                                    → bm25Search(tokens) ─┴→ rrfFuse → topK
//                                    → [optional cross-encoder rerank]
//
// Which of those stages are worth their cost is a measured question, and the
// answer is recorded in docs/ARXIV-RAG.md — not assumed here.

import { b64ToInt8, cosineF32Int8, int8ToB64, quantizeInt8 } from "./introspect-core.js";

export { b64ToInt8, cosineF32Int8, int8ToB64, quantizeInt8 };

/**
 * @typedef {{ id: string, title: string, abstract: string, authors?: string[], categories?: string[], primary?: string, updated?: string, doi?: string }} ArxivPaper
 */

// e5 asks for asymmetric prefixes: documents are "passage: …", questions are
// "query: …". Applied at the ONE seam every caller goes through, the same
// discipline src/rag.js uses server-side, so builder and searcher cannot
// drift onto different conventions.
export const PASSAGE_PREFIX = "passage: ";
export const QUERY_PREFIX = "query: ";

// e5's sequence window is 512 tokens. Berget does NOT silently truncate past
// it — it answers 400 "maximum context length is 512 tokens" and drops the
// whole batch (measured 2026-07-26), so the char budget is a correctness
// constraint on a 300k-paper build, not a nicety.
//
// Measured chars/token over a spread of real abstracts: median 4.26, p5 3.38,
// and a tail below 2.9 on LaTeX-dense and non-Latin-script abstracts — the
// 1600-char budget this started with produced 568-token inputs and failed.
// 1200 chars holds a whole typical abstract and stays inside 512 tokens down
// to 2.35 chars/token. The tail below THAT is handled by the adaptive
// re-truncation in scripts/arxiv-berget.mjs rather than by shrinking the
// budget for everyone.
export const MAX_PASSAGE_CHARS = 1200;

/**
 * Recovery from a 512-token rejection: the error reports how many tokens the
 * longest input in the batch actually came to, which pins down this batch's
 * real chars/token ratio. Re-cap every text to what that ratio allows, with a
 * safety margin, instead of blind-halving the whole batch.
 * @param {string[]} texts
 * @param {number} requestedTokens the count from the error message
 * @param {number} [limit] the model's window
 * @returns {string[]} same texts, over-long ones truncated
 */
export function recapForContext(texts, requestedTokens, limit = 512) {
  const longest = texts.reduce((m, t) => Math.max(m, t.length), 0);
  if (!longest) return texts;
  // Scale the char budget by how far over the window the batch came in, with
  // a margin. The reported count belongs to whichever input was densest, and
  // that is not necessarily the longest one — a 900-char CJK abstract can
  // out-token a 1200-char English one — so the estimate can be optimistic.
  // Hence the second term: every retry shortens by at least 15% regardless,
  // which makes the loop converge instead of creeping.
  const scaled = requestedTokens ? Math.floor((longest * (limit - 16)) / requestedTokens) : longest;
  const cap = Math.max(120, Math.min(scaled, Math.floor(longest * 0.85)));
  return texts.map((t) => (t.length > cap ? t.slice(0, cap) : t));
}

// ---- passage construction ---------------------------------------------------

/**
 * The passage-building strategies the bake-off compares. A "strategy" is
 * purely a function of the paper's metadata — no model call — so switching
 * one only costs a re-embed, never a re-harvest.
 *
 *   title          the title alone (cheap baseline; ~15 tokens/paper)
 *   abstract       the abstract alone
 *   title_abstract title + abstract (the conventional default)
 *   contextual     title + categories + authors' surnames + abstract, i.e. the
 *                  metadata a researcher would actually use to disambiguate
 *                  ("that Bengio paper on cs.LG diffusion"). Costs ~20 extra
 *                  tokens per paper.
 * @type {Record<string, (p: ArxivPaper) => string>}
 */
export const PASSAGE_STRATEGIES = {
  title: (p) => String(p.title || ""),
  abstract: (p) => String(p.abstract || ""),
  title_abstract: (p) => `${p.title || ""}\n\n${p.abstract || ""}`.trim(),
  contextual: (p) => {
    const cats = (p.categories || []).join(" ");
    const who = (p.authors || []).slice(0, 6).map((a) => a.split(/\s+/).pop()).filter(Boolean).join(", ");
    const head = [p.title || "", cats && `[${cats}]`, who && `by ${who}`].filter(Boolean).join(" ");
    return `${head}\n\n${p.abstract || ""}`.trim();
  },
};

/**
 * @param {ArxivPaper} paper
 * @param {string} strategy a key of PASSAGE_STRATEGIES
 * @returns {string} the text to embed, truncated to the e5 window
 */
export function buildPassage(paper, strategy = "title_abstract") {
  const fn = PASSAGE_STRATEGIES[strategy];
  if (!fn) throw new Error(`Unknown passage strategy: ${strategy}`);
  return fn(paper).replace(/\s+/g, " ").trim().slice(0, MAX_PASSAGE_CHARS);
}

/**
 * Split one paper into 1..n passages. `window`/`stride` are in characters; a
 * window of 0 means "never split" (one passage per paper, the single-vector
 * pipelines). Splitting is sentence-aware: a boundary is pulled back to the
 * last sentence end inside the window so a chunk never begins mid-clause.
 *
 * Multi-vector is only interesting for long abstracts — a 900-char abstract
 * under a 1600-char window yields exactly one chunk, so the two families
 * coincide on most of the corpus and differ only on the long tail.
 * @param {ArxivPaper} paper
 * @param {{ strategy?: string, window?: number, stride?: number }} [opts]
 * @returns {string[]}
 */
export function paperPassages(paper, opts = {}) {
  const strategy = opts.strategy || "title_abstract";
  const window = Number(opts.window) || 0;
  const full = PASSAGE_STRATEGIES[strategy]
    ? PASSAGE_STRATEGIES[strategy](paper).replace(/\s+/g, " ").trim()
    : "";
  if (!full) return [];
  if (!window || full.length <= Math.min(window, MAX_PASSAGE_CHARS)) {
    return [full.slice(0, MAX_PASSAGE_CHARS)];
  }
  const stride = Math.max(1, Number(opts.stride) || Math.round(window * 0.75));
  /** @type {string[]} */
  const out = [];
  let start = 0;
  while (start < full.length && out.length < 12) {
    let end = Math.min(start + window, full.length);
    if (end < full.length) {
      const brk = full.slice(start, end).lastIndexOf(". ");
      if (brk > window * 0.5) end = start + brk + 1;
    }
    const piece = full.slice(start, end).trim();
    if (piece) out.push(piece.slice(0, MAX_PASSAGE_CHARS));
    if (end >= full.length) break;
    start = Math.max(end - (window - stride), start + 1);
  }
  return out;
}

// ---- tokenization + BM25 ----------------------------------------------------

// Deliberately Unicode-aware rather than /[a-z0-9]+/: the project supports
// Swedish everywhere it routes on text (CLAUDE.md invariant 6), and a query
// like "självövervakad inlärning" must not shatter on å/ä/ö. Intra-word
// hyphens are kept (self-supervised stays one term AND is also indexed as its
// parts, so both "self-supervised" and "supervised" hit).
/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const raw = String(text || "").toLowerCase().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
  /** @type {string[]} */
  const out = [];
  for (const t of raw) {
    out.push(t);
    if (t.includes("-")) for (const part of t.split("-")) if (part.length > 1) out.push(part);
  }
  return out;
}

// A tiny English+Swedish stopword set. Kept small on purpose: BM25's IDF
// already discounts ubiquitous terms, and over-pruning costs recall on
// phrase-like queries ("attention is all you need").
const STOPWORDS = new Set(
  ("a an the of and or to in for on with by is are we our this that these those from as at be been " +
    "och att en ett den det som för med av på till är vi den här de vid om")
    .split(" "),
);

/**
 * Build a BM25 index over documents. Returns a plain-JSON-serialisable
 * structure so the index can be written to disk next to the vectors.
 * @param {Array<{ id: string, text: string }>} docs
 * @param {{ k1?: number, b?: number }} [opts]
 */
export function buildBm25(docs, opts = {}) {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  /** @type {Record<string, Array<[number, number]>>} postings: term → [docIndex, tf][] */
  const postings = Object.create(null);
  /** @type {number[]} */
  const lengths = [];
  /** @type {string[]} */
  const ids = [];
  docs.forEach((doc, i) => {
    ids.push(doc.id);
    /** @type {Map<string, number>} */
    const tf = new Map();
    let len = 0;
    for (const t of tokenize(doc.text)) {
      if (STOPWORDS.has(t)) continue;
      tf.set(t, (tf.get(t) || 0) + 1);
      len++;
    }
    lengths.push(len);
    for (const [term, count] of tf) {
      (postings[term] || (postings[term] = [])).push([i, count]);
    }
  });
  const avgdl = lengths.reduce((a, c) => a + c, 0) / (lengths.length || 1);
  return { k1, b, avgdl, ids, lengths, postings, n: docs.length };
}

/**
 * @typedef {ReturnType<typeof buildBm25>} Bm25Index
 * @typedef {{ id: string, score: number, i: number }} Hit
 */

/**
 * @param {Bm25Index} index
 * @param {string} query
 * @param {number} [topK]
 * @returns {Hit[]} descending by score
 */
export function bm25Search(index, query, topK = 20) {
  /** @type {Map<number, number>} */
  const scores = new Map();
  const terms = tokenize(query).filter((t) => !STOPWORDS.has(t));
  for (const term of new Set(terms)) {
    const posting = index.postings[term];
    if (!posting) continue;
    // Robertson/Sparck-Jones IDF with the +1 that keeps it non-negative for
    // terms appearing in more than half the corpus.
    const idf = Math.log(1 + (index.n - posting.length + 0.5) / (posting.length + 0.5));
    for (const [i, tf] of posting) {
      const norm = tf * (index.k1 + 1) / (tf + index.k1 * (1 - index.b + index.b * (index.lengths[i] / index.avgdl)));
      scores.set(i, (scores.get(i) || 0) + idf * norm);
    }
  }
  return [...scores.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topK)
    .map(([i, score]) => ({ id: index.ids[i], score, i }));
}

// ---- dense search over an int8 shard ---------------------------------------

/**
 * Brute-force cosine top-k of a float query vector against int8 passage
 * vectors, pooling multiple passages of one paper by their best score
 * (max-pool: a paper is as relevant as its most relevant passage).
 *
 * Brute force is a deliberate choice at this corpus size. 300k × 1024 int8 is
 * ~300 MB and one scan costs a few hundred ms in plain JS — an ANN structure
 * would add a dependency, an index-build step and recall loss to save time
 * this workload does not need.
 * @param {ArrayLike<number>} qvec
 * @param {{ vectors: Int8Array[], docIds: string[] }} shard passage-aligned
 * @param {number} [topK]
 * @returns {Hit[]}
 */
export function denseSearch(qvec, shard, topK = 20) {
  /** @type {Map<string, number>} */
  const best = new Map();
  for (let i = 0; i < shard.vectors.length; i++) {
    const s = cosineF32Int8(qvec, shard.vectors[i]);
    const id = shard.docIds[i];
    const prev = best.get(id);
    if (prev === undefined || s > prev) best.set(id, s);
  }
  return [...best.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topK)
    .map(([id, score], i) => ({ id, score, i }));
}

/**
 * Precompute each row's L2 norm once. The naive scan recomputes the document norm
 * inside every query, which at 326k × 1024 is ~334M redundant operations per
 * query — the single biggest cost in searching the full index.
 * @param {Int8Array} packed flat rows of `dims` int8 values
 * @param {number} dims
 * @returns {Float32Array} one norm per row
 */
export function packedNorms(packed, dims) {
  const rows = Math.floor(packed.length / dims);
  const norms = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let n = 0;
    const base = r * dims;
    for (let j = 0; j < dims; j++) n += packed[base + j] * packed[base + j];
    norms[r] = Math.sqrt(n) || 1;
  }
  return norms;
}

/**
 * Top-k cosine over a packed int8 matrix, max-pooled per paper. Same ranking
 * as denseSearch, but over the flat binary layout the full-scale index uses
 * and with document norms supplied rather than recomputed.
 * @param {ArrayLike<number>} qvec
 * @param {{ packed: Int8Array, dims: number, norms: Float32Array, docIds: string[] }} index
 * @param {number} [topK]
 * @returns {Hit[]}
 */
export function denseSearchPacked(qvec, index, topK = 20) {
  const { packed, dims, norms, docIds } = index;
  const rows = docIds.length;
  let qn = 0;
  for (let j = 0; j < dims; j++) qn += qvec[j] * qvec[j];
  qn = Math.sqrt(qn) || 1;
  /** @type {Map<string, number>} */
  const best = new Map();
  for (let r = 0; r < rows; r++) {
    const base = r * dims;
    let dot = 0;
    for (let j = 0; j < dims; j++) dot += qvec[j] * packed[base + j];
    const s = dot / (qn * norms[r]);
    const id = docIds[r];
    const prev = best.get(id);
    if (prev === undefined || s > prev) best.set(id, s);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score], i) => ({ id, score, i }));
}

// ---- fusion ------------------------------------------------------------------

/**
 * Reciprocal-rank fusion. Combines rankings from retrievers whose scores are
 * not comparable (a BM25 score and a cosine live on different scales), by
 * using only each item's RANK. `k` damps the head so a single retriever's #1
 * cannot dominate; 60 is the value from the original Cormack et al. paper and
 * is what the bake-off measured.
 * @param {Array<Array<{ id: string }>>} rankings
 * @param {{ k?: number, weights?: number[], topK?: number }} [opts]
 * @returns {Array<{ id: string, score: number }>}
 */
export function rrfFuse(rankings, opts = {}) {
  const k = opts.k ?? 60;
  const weights = opts.weights || rankings.map(() => 1);
  /** @type {Map<string, number>} */
  const scores = new Map();
  rankings.forEach((ranking, r) => {
    const w = weights[r] ?? 1;
    ranking.forEach((hit, rank) => {
      scores.set(hit.id, (scores.get(hit.id) || 0) + w / (k + rank + 1));
    });
  });
  const out = [...scores.entries()].sort((a, c) => c[1] - a[1]).map(([id, score]) => ({ id, score }));
  return opts.topK ? out.slice(0, opts.topK) : out;
}

// ---- evaluation metrics -------------------------------------------------------

/**
 * Recall@k for a single query with exactly one known-relevant document.
 * @param {Array<{ id: string }>} hits
 * @param {string} goldId
 * @param {number} k
 */
export function hitAtK(hits, goldId, k) {
  return hits.slice(0, k).some((h) => h.id === goldId) ? 1 : 0;
}

/**
 * Reciprocal rank of the gold document, 0 when absent from `hits`.
 * @param {Array<{ id: string }>} hits
 * @param {string} goldId
 */
export function reciprocalRank(hits, goldId) {
  const i = hits.findIndex((h) => h.id === goldId);
  return i < 0 ? 0 : 1 / (i + 1);
}

/**
 * Normalized discounted cumulative gain over graded relevance labels.
 * Used for the topical (multi-relevant) query set, where "did it find THE
 * paper" is the wrong question and "is the top of the list good" is right.
 * @param {Array<{ id: string }>} hits
 * @param {Record<string, number>} gains id → graded relevance (0..3)
 * @param {number} k
 */
export function ndcgAtK(hits, gains, k) {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, hits.length); i++) {
    const g = gains[hits[i].id] || 0;
    if (g) dcg += (2 ** g - 1) / Math.log2(i + 2);
  }
  const ideal = Object.values(gains).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  ideal.forEach((g, i) => {
    if (g) idcg += (2 ** g - 1) / Math.log2(i + 2);
  });
  return idcg ? dcg / idcg : 0;
}

// ---- index shard (de)serialisation --------------------------------------------

/**
 * A shard is one JSON file: metadata + base64 int8 vectors + the passage→paper
 * map. JSON (not a binary format) keeps the artifact inspectable and portable
 * to the browser tier without a decoder, at ~1.33x the bytes; the int8
 * quantization already bought 4x over float32, so the net is still 3x smaller
 * than the naive form.
 * @typedef {{ v: 1, model: string, dims: number, strategy: string, window: number, stride: number, built: string, papers: ArxivPaper[], vectors: string[], map: number[] }} ArxivShard
 */

/**
 * Tolerant validation of a shard read off disk. Returns the shard, or null so
 * every caller can fail soft on a truncated/partial write.
 * @param {any} data
 * @returns {ArxivShard | null}
 */
export function validateShard(data) {
  if (!data || typeof data !== "object") return null;
  if (data.v !== 1 || !Array.isArray(data.vectors) || !Array.isArray(data.map) || !Array.isArray(data.papers)) return null;
  if (data.vectors.length !== data.map.length) return null;
  if (!data.vectors.length) return null;
  if (data.map.some((/** @type {any} */ i) => !Number.isInteger(i) || i < 0 || i >= data.papers.length)) return null;
  return /** @type {ArxivShard} */ (data);
}

/**
 * Decode a shard into the passage-aligned form denseSearch wants.
 * @param {ArxivShard} shard
 * @returns {{ vectors: Int8Array[], docIds: string[], byId: Map<string, ArxivPaper> }}
 */
export function decodeShard(shard) {
  const vectors = shard.vectors.map(b64ToInt8);
  const docIds = shard.map.map((i) => shard.papers[i].id);
  const byId = new Map(shard.papers.map((p) => [p.id, p]));
  return { vectors, docIds, byId };
}
