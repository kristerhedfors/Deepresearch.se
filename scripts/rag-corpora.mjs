#!/usr/bin/env node
// The corpus REGISTRY for the hosted-RAG evaluation harness.
//
// Two corpora are served by the identical dense pipeline (src/dense-rag.js):
// arXiv (src/arxiv-rag.js) and PubMed (src/pubmed-rag.js). Everything that
// differs between them — which Vectorize index, how a vector id spells a
// document, where an INDEPENDENT list of ids comes from, how a result's date is
// recovered — is a field here, and everything else is shared. That is the same
// split src/dense-rag.js already made on the serving side; the measurement side
// had not made it, which is why PubMed shipped with no retrieval numbers at all
// (docs/PUBMED-RAG.md §8.2).
//
// ---- the constants come from the SERVED module, deliberately ----------------
//
// scripts/arxiv-hosted.mjs carried its own `CANDIDATES = 20` with a comment
// explaining that this was what src/arxiv-rag.js asked for. It stopped being
// true when the pool was raised to 50 (docs/ARXIV-RAG.md §11) and nothing
// failed — the harness simply went on measuring a pipeline nobody runs. A
// replay whose constants are a COPY of production drifts silently and reports
// confident numbers for the wrong thing, which is this subsystem's signature
// failure mode. So the pool, the floor, the cross-encoder cut and the query
// prefix are imported from src/dense-rag.js and cannot drift again.

import { CANDIDATES, RERANK_DOC_CHARS, RERANK_FLOOR } from "../src/dense-rag.js";
import { QUERY_PREFIX } from "../public/js/arxiv-rag-core.js";

export { CANDIDATES, RERANK_DOC_CHARS, RERANK_FLOOR, QUERY_PREFIX };

/** Vectorize's measured ceiling when full metadata is requested (2026-07-29). */
export const MAX_TOPK_WITH_METADATA = 50;

/** Vectorize's measured ceiling when only ids are needed. */
export const MAX_TOPK = 100;

/** Measured: "40007 too many ids in payload; max id count is 20". */
export const GET_BY_IDS_BATCH = 20;

/**
 * @typedef {object} Corpus
 * @property {string} id            registry key, e.g. "arxiv"
 * @property {string} label         human name for tables
 * @property {string} index         the Vectorize index name
 * @property {string} unit          what one vector is ("paper", "citation")
 * @property {string} topical       path to the hand-written topical query set
 * @property {string} goldsetUnit   how the gold-set prompt names one document
 * @property {string} windowNote    one line describing the indexed window
 * @property {(id: string) => string} urlOf         vector id → public URL
 * @property {(id: string) => string} bareId        vector id → the corpus's own id
 * @property {(bare: string) => string} vectorId    the corpus's own id → vector id
 * @property {(id: string, doc?: any) => number} monthOf  → YYYYMM, 0 when unknown
 * @property {(spec: string, n: number, seed: string) => Promise<string[]>} enumerate
 *   an INDEPENDENT list of ids for the window — never a query against the index
 *   being measured, which would select for documents that retrieve well.
 * @property {number} [preWindow]   YYYYMM cutoff for the "older than the
 *   original window" share in the age profile; omitted when meaningless.
 */

/**
 * arXiv ids carry their submission month, which is the ONLY trustworthy date on
 * that corpus (docs/ARXIV-RAG.md §3 — the harvested datestamp tracks the last
 * revision). PubMed ids carry nothing, so its month comes from the stored `d`.
 * @param {string} id
 */
export function arxivMonth(id) {
  const m = /^(\d{2})(\d{2})\./.exec(String(id || "").trim());
  if (!m) return 0;
  return (2000 + Number(m[1])) * 100 + Number(m[2]);
}

/**
 * PubMed stores an ISO-ish date in the vector metadata's `d`. A citation with
 * no usable date is reported as 0 rather than guessed at — a fabricated date in
 * an age profile is worse than a gap in one.
 * @param {string} _id
 * @param {any} [doc]
 */
export function pubmedMonth(_id, doc) {
  const d = String(doc?.d || doc?.metadata?.d || "").trim();
  const m = /^(\d{4})-(\d{2})/.exec(d);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/** @type {Record<string, Corpus>} */
export const CORPORA = {
  arxiv: {
    id: "arxiv",
    label: "arXiv",
    index: "deepresearch-se-arxiv",
    unit: "paper",
    topical: "scripts/arxiv-topical-queries.json",
    goldsetUnit: "arXiv preprint",
    windowNote: "submission months 2310–2607 (docs/ARXIV-RAG.md §11)",
    urlOf: (id) => `https://arxiv.org/abs/${id}`,
    bareId: (id) => String(id || "").trim().replace(/v\d+$/, ""),
    vectorId: (bare) => String(bare || "").trim().replace(/v\d+$/, ""),
    monthOf: arxivMonth,
    // The GCS mirror: public, no credentials, no rate limit, and entirely
    // independent of both the harvest and the index (docs/ARXIV-RAG.md §10.4).
    enumerate: async (spec, n, seed) => {
      const { expandMonths } = await import("./rag-eval-core.mjs");
      const { listShard } = await import("./arxiv-gcs.mjs");
      const { hash01 } = await import("./arxiv-corpus.mjs");
      const { bareId } = await import("./arxiv-crosscheck.mjs");
      const months = expandMonths(spec);
      /** @type {string[]} */
      const all = [];
      for (const month of months) {
        // listShard returns a MAP of id → latest version, not an array.
        // Iterating it directly yields [key, value] pairs, which stringify to
        // "2603.12345,2" and match nothing — the first version of this sampled
        // 256 ids and found 0 of them in the index. Keys only.
        for (const id of (await listShard(month)).keys()) all.push(bareId(id));
      }
      return all
        .map((id) => ({ id, r: hash01(`${seed}:${id}`) }))
        .sort((a, b) => a.r - b.r)
        .slice(0, n)
        .map((x) => x.id);
    },
    preWindow: 202507,
  },

  pubmed: {
    id: "pubmed",
    label: "PubMed",
    index: "deepresearch-se-pubmed",
    unit: "citation",
    topical: "scripts/pubmed-topical-queries.json",
    goldsetUnit: "PubMed citation",
    windowNote: "the 2026 update files above the annual baseline (docs/PUBMED-RAG.md §7)",
    urlOf: (id) => `https://pubmed.ncbi.nlm.nih.gov/${String(id).replace(/^pmid:/, "")}/`,
    bareId: (id) => String(id || "").trim().replace(/^pmid:/, ""),
    vectorId: (bare) => `pmid:${String(bare || "").trim().replace(/^pmid:/, "")}`,
    monthOf: pubmedMonth,
    // E-utilities: a different system from the archive files the index was
    // built from, which is the whole point (docs/PUBMED-RAG.md §6).
    //
    // `hasabstract` stays ON. Sampling all PMIDs compares two populations —
    // the index only holds citations that cleared the abstract floor — and
    // reports the harvester's own filter as a coverage hole. That mistake once
    // read as 4.6% missing where like-for-like was 0.1%.
    enumerate: async (spec, n, seed) => {
      const { hash01 } = await import("./arxiv-corpus.mjs");
      const { monthIds } = await import("./pubmed-enumerate.mjs");
      const months = expandPubmedMonths(spec);
      // esearch caps a page near 10k without the history server, so ask each
      // month for a generous slice and let the hash sampler do the choosing.
      const per = Math.max(500, Math.ceil((n * 4) / Math.max(1, months.length)));
      /** @type {string[]} */
      const all = [];
      for (const month of months) {
        const ids = await monthIds(month, Math.min(9999, per), { hasAbstract: true });
        all.push(...ids);
      }
      return all
        .map((id) => ({ id, r: hash01(`${seed}:${id}`) }))
        .sort((a, b) => a.r - b.r)
        .slice(0, n)
        .map((x) => x.id);
    },
  },
};

/**
 * "2026/05-2026/07" or "2026/06" or a comma list → E-utilities month strings.
 *
 * Deliberately a different function from the arXiv YYMM walker: PubMed windows
 * are EDAT months in `YYYY/MM`, and one parser trying to serve both spellings
 * is how a window silently becomes the wrong window.
 * @param {string} spec
 * @returns {string[]}
 */
export function expandPubmedMonths(spec) {
  const text = String(spec || "").trim();
  if (!text) return [];
  if (text.includes(",")) return text.split(",").map((s) => s.trim()).filter(Boolean);
  const m = /^(\d{4})\/(\d{2})-(\d{4})\/(\d{2})$/.exec(text);
  if (!m) return [text];
  const [, y1, m1, y2, m2] = m;
  const out = [];
  let year = Number(y1);
  let month = Number(m1);
  for (let guard = 0; guard < 600; guard++) {
    out.push(`${year}/${String(month).padStart(2, "0")}`);
    if (year === Number(y2) && month === Number(m2)) return out;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return out;
}

/**
 * @param {string} name
 * @returns {Corpus}
 */
export function corpus(name) {
  const c = CORPORA[String(name || "").trim().toLowerCase()];
  if (!c) throw new Error(`unknown corpus "${name}" — one of ${Object.keys(CORPORA).join(", ")}`);
  return c;
}
