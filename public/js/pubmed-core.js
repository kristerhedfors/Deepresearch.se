// @ts-check
// The pure core of the PubMed corpus build — parsing, selection and passage
// construction, with no I/O in it, so the harvester, the corpus reporter, the
// vectorizer and the tests all run the same code.
//
// Same division as public/js/arxiv-rag-core.js, and it deliberately REUSES that
// module's passage seam (PASSAGE_PREFIX, buildPassage, MAX_PASSAGE_CHARS)
// rather than restating it: both corpora are embedded by the same
// intfloat/multilingual-e5-large into the same 1024 dimensions, and a second
// copy of the char budget is a second thing to forget to update.
//
// ---- why the FTP archive and not E-utilities ------------------------------
//
// PubMed publishes the whole database as a numbered set of gzipped XML files:
// an annual BASELINE (2026: pubmed26n0001…n1334, 1,334 files, 51.8 GB gzipped,
// released 2026-01-29) plus DAILY UPDATE files that carry on from the last
// baseline number (n1335… — 223 files and 12.4 GB by 2026-07-30). Measured
// 2026-07-31. That is the analogue of the GCS mirror the arXiv build enumerates
// from, and it is the channel NCBI itself points bulk users at: the E-utilities
// guidelines cap an unkeyed client at three requests per second and say in as
// many words that a data-mining project should "download a local copy of the
// database" instead. 40.9 M citations at 3 req/s is not a plan.
//
// E-utilities still earns a place — as the SECOND, INDEPENDENT enumeration
// (scripts/pubmed-enumerate.mjs). The bulk-corpus-etl skill's first rule is
// that one source cannot detect its own holes, and an esearch count over an
// Entrez-date window is derived from a different system than the file dumps.
//
// ---- the two axes, named up front -----------------------------------------
//
// The arXiv build lost 48% of one month and then 26.5% of a historical band to
// the same bug twice: it FILTERED on one date axis and SELECTED on another.
// PubMed has exactly the same pair, so they are named here and kept apart:
//
//   FETCH axis      the archive file number, which tracks PMID, which tracks
//                   the date NLM loaded the record. Measured: n0700 holds
//                   PMIDs 21.75 M–21.78 M (mostly published 2011), n1200 holds
//                   32.8 M–37.6 M (mostly 2023), n1334 holds 41.60 M–41.61 M
//                   (mostly 2026). Monotone, so descending file order is
//                   "latest first" and the harvest needs no guesswork.
//   SELECTION axis  the publication year on the record, which is NOT monotone
//                   in PMID — file n1200 also carries records published 2019.
//
// So the corpus this core defines is a PMID window: "every citation NLM has
// loaded since PMID P", which is exactly reproducible and is what the file
// order gives for free. `minYear` exists as a reporting/trim FILTER on top of
// that, and `windowNote()` states in one line that it does not define the
// window — because a publication-year window served by a PMID-ordered fetch is
// the §3a bug, and the honest fix is to not pretend otherwise.

import { MAX_PASSAGE_CHARS, PASSAGE_PREFIX, buildPassage, storedAuthors, truncateChars } from "./arxiv-rag-core.js";

export { MAX_PASSAGE_CHARS, PASSAGE_PREFIX, buildPassage };

/**
 * @typedef {{
 *   id: string, pmid: string, title: string, abstract: string,
 *   authors: string[], journal: string, year: string, date: string,
 *   doi: string, mesh: string[], languages: string[], types: string[]
 * }} PubmedRecord
 */

/** Abstracts shorter than this carry too little to embed usefully — the same
 * floor the arXiv corpus uses, so the two indexes are filtered alike. */
export const MIN_ABSTRACT_CHARS = 200;

/** Article container elements in the DTD. Books and book chapters (about 0.1%
 * of the archive) have a different title/abstract shape and are skipped, but
 * they are COUNTED — a skip that reports nothing is how a corpus quietly ends
 * up smaller than its own log says. */
export const ARTICLE_TAG = "PubmedArticle";
export const BOOK_TAG = "PubmedBookArticle";

/** @type {Record<string, string>} */
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * XML text → plain text. PubMed abstracts carry inline markup (`<i>`, `<sub>`,
 * `<sup>`, MathML) which the embedder should never see as tags.
 * @param {string} xml
 * @returns {string}
 */
export function stripTags(xml) {
  return decodeEntities(String(xml || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return String(s || "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/**
 * Pull complete `<PubmedArticle>…</PubmedArticle>` blocks out of a streaming
 * buffer, returning the blocks and whatever tail is still incomplete.
 *
 * Written as a pure buffer→{blocks,rest} function rather than as a callback
 * inside the download loop, because getting it wrong is silent: an early
 * version searched backwards for the opening tag and dropped any record whose
 * opening tag had already been consumed by a previous chunk. A dropped record
 * looks exactly like a record that was never there.
 *
 * @param {string} buffer
 * @param {string} [tag]
 * @returns {{ blocks: string[], rest: string }}
 */
export function takeBlocks(buffer, tag = ARTICLE_TAG) {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  /** @type {string[]} */
  const blocks = [];
  let rest = String(buffer || "");
  for (;;) {
    const start = rest.indexOf(open);
    if (start === -1) {
      // Keep only enough tail to hold a split opening tag; the rest is either
      // preamble or already-consumed content and holding it grows the buffer
      // without bound over a 500 MB file.
      rest = rest.length > open.length ? rest.slice(rest.length - open.length) : rest;
      break;
    }
    const end = rest.indexOf(close, start);
    if (end === -1) {
      rest = rest.slice(start);
      break;
    }
    blocks.push(rest.slice(start, end + close.length));
    rest = rest.slice(end + close.length);
  }
  return { blocks, rest };
}

/**
 * PMIDs the update files mark as withdrawn. They arrive in their own
 * `<DeleteCitation>` block rather than as an article, and ignoring them leaves
 * retracted or duplicated citations in the index for as long as it lives.
 * @param {string} xml
 * @returns {string[]}
 */
export function deletedPmids(xml) {
  const out = [];
  for (const block of String(xml || "").match(/<DeleteCitation>[\s\S]*?<\/DeleteCitation>/g) || []) {
    for (const m of block.matchAll(/<PMID[^>]*>(\d+)<\/PMID>/g)) out.push(m[1]);
  }
  return out;
}

/** @param {string} xml @param {RegExp} re */
const first = (xml, re) => (String(xml).match(re) || [])[1] || "";

/**
 * One `<PubmedArticle>` block → the corpus row.
 *
 * The record's OWN PMID is the one directly under `<MedlineCitation>`. A naive
 * `<PMID>` match also picks up every cited and commented-on PMID in
 * `<CommentsCorrectionsList>`, which is how a first pass at this reported file
 * n1200 as spanning PMIDs 11 M–41.5 M when its own records span 32.8 M–37.6 M.
 *
 * @param {string} xml
 * @returns {PubmedRecord | null} null when the block carries no PMID
 */
export function parseArticle(xml) {
  const s = String(xml || "");
  const dataAt = s.indexOf("<PubmedData>");
  const citation = dataAt === -1 ? s : s.slice(0, dataAt);
  const pmid = first(citation, /<MedlineCitation[^>]*>\s*<PMID[^>]*>(\d+)<\/PMID>/);
  if (!pmid) return null;

  return {
    id: `pmid:${pmid}`,
    pmid,
    title: stripTags(first(s, /<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/)),
    abstract: abstractText(s),
    authors: authorNames(s),
    journal: stripTags(first(s, /<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/)),
    year: pubYear(s),
    date: pubDate(s),
    doi: first(s, /<ArticleId IdType="doi">([^<]+)<\/ArticleId>/).trim(),
    mesh: [...s.matchAll(/<DescriptorName[^>]*>([^<]+)<\/DescriptorName>/g)].map((m) => stripTags(m[1])).slice(0, 12),
    languages: [...s.matchAll(/<Language>([^<]+)<\/Language>/g)].map((m) => m[1].trim()),
    types: [...s.matchAll(/<PublicationType[^>]*>([^<]+)<\/PublicationType>/g)].map((m) => stripTags(m[1])).slice(0, 8),
  };
}

/**
 * Structured abstracts (`<AbstractText Label="METHODS">`) are the norm in
 * clinical literature. The labels are kept, because "METHODS: we randomised…"
 * is signal a reader and a cross-encoder both use, and dropping them glues
 * sections into one run-on paragraph.
 * @param {string} xml
 * @returns {string}
 */
export function abstractText(xml) {
  const parts = [];
  for (const m of String(xml || "").matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
    const label = first(m[1], /\bLabel="([^"]*)"/);
    const body = stripTags(m[2]);
    if (!body) continue;
    parts.push(label && !/^unlabelled$/i.test(label) ? `${label}: ${body}` : body);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * @param {string} xml
 * @returns {string[]}
 */
export function authorNames(xml) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<Author\b[^>]*>([\s\S]*?)<\/Author>/g)) {
    const last = stripTags(first(m[1], /<LastName>([^<]*)<\/LastName>/));
    const fore = stripTags(first(m[1], /<ForeName>([^<]*)<\/ForeName>/));
    const collective = stripTags(first(m[1], /<CollectiveName>([\s\S]*?)<\/CollectiveName>/));
    const name = last ? [fore, last].filter(Boolean).join(" ") : collective;
    if (name) out.push(name);
    if (out.length >= 12) break;
  }
  return out;
}

/**
 * The publication year, preferring the electronic `<ArticleDate>` when present
 * because it is the one that exists for ahead-of-print records; falling back to
 * the journal `<PubDate>`, including its free-text `<MedlineDate>` form
 * ("2025 Nov-Dec"), which carries no `<Year>` element at all.
 * @param {string} xml
 * @returns {string}
 */
export function pubYear(xml) {
  const s = String(xml || "");
  const article = first(s, /<ArticleDate[^>]*>\s*<Year>(\d{4})<\/Year>/);
  if (article) return article;
  const pub = s.match(/<PubDate>([\s\S]*?)<\/PubDate>/);
  if (!pub) return "";
  return first(pub[1], /<Year>(\d{4})<\/Year>/) || first(pub[1], /<MedlineDate>\s*(\d{4})/);
}

/**
 * A YYYY-MM-DD where the archive gives one, else YYYY-MM or YYYY. Stored as a
 * string rather than a Date because a third of PubMed's dates are not days.
 * @param {string} xml
 * @returns {string}
 */
export function pubDate(xml) {
  const s = String(xml || "");
  const block = (s.match(/<ArticleDate[^>]*>([\s\S]*?)<\/ArticleDate>/) || s.match(/<PubDate>([\s\S]*?)<\/PubDate>/) || [])[1];
  const year = pubYear(s);
  if (!year) return "";
  if (!block) return year;
  const month = MONTHS[first(block, /<Month>([^<]+)<\/Month>/).trim().slice(0, 3).toLowerCase()] || pad(first(block, /<Month>(\d{1,2})<\/Month>/));
  if (!month) return year;
  const day = pad(first(block, /<Day>(\d{1,2})<\/Day>/));
  return day ? `${year}-${month}-${day}` : `${year}-${month}`;
}

/** @type {Record<string, string>} */
const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** @param {string} n */
const pad = (n) => (n ? String(n).padStart(2, "0") : "");

/**
 * Does this record earn a vector?
 *
 * Deliberately FEW filters. Every one of them is a paid-for reduction in what
 * the index can answer, and the only ones here are the two that pay: a record
 * with no usable abstract has nothing to embed but its title (measured 17.3%
 * of the newest baseline file, and the arXiv build settled the same 200-char
 * floor), and a language filter is offered but OFF by default because e5 is
 * multilingual and the corpus is queried in Swedish as well as English
 * (invariant 6).
 *
 * @param {PubmedRecord | null} rec
 * @param {{ minAbstract?: number, minYear?: number, languages?: string[] }} [opts]
 * @returns {{ keep: boolean, reason: string }}
 */
export function keepRecord(rec, opts = {}) {
  const minAbstract = opts.minAbstract ?? MIN_ABSTRACT_CHARS;
  if (!rec) return { keep: false, reason: "no_pmid" };
  if (!rec.title) return { keep: false, reason: "no_title" };
  if ((rec.abstract || "").length < minAbstract) return { keep: false, reason: "short_abstract" };
  if (opts.minYear && (!rec.year || Number(rec.year) < opts.minYear)) return { keep: false, reason: "before_min_year" };
  const languages = opts.languages || [];
  if (languages.length && !rec.languages.some((l) => languages.includes(l))) {
    return { keep: false, reason: "language" };
  }
  return { keep: true, reason: "" };
}

/**
 * @param {string} pmid
 * @returns {string}
 */
export function pubmedUrl(pmid) {
  return `https://pubmed.ncbi.nlm.nih.gov/${String(pmid).replace(/\D/g, "")}/`;
}

/** `pmid:41610285` → `41610285`; anything else → "".
 * @param {string} id
 * @returns {string}
 */
export function pmidOf(id) {
  return (String(id || "").match(/^pmid:(\d+)$/) || [])[1] || "";
}

// ---- the archive listing ----------------------------------------------------

/** @typedef {{ name: string, n: number, kind: "baseline" | "updates", bytes: number }} ArchiveFile */

/** @type {Record<string, number>} */
const SIZE_UNITS = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/**
 * Parse one of NCBI's Apache directory listings into the file table.
 *
 * The size column is the human-readable "39M" form, so it is approximate — it
 * is used for planning a download budget, never for verifying one.
 *
 * @param {string} html
 * @param {"baseline" | "updates"} kind
 * @returns {ArchiveFile[]} sorted ASCENDING by file number
 */
export function parseListing(html, kind) {
  /** @type {ArchiveFile[]} */
  const out = [];
  const re = /href="(pubmed(\d+)n(\d+)\.xml\.gz)"[^>]*>[^<]*<\/a>\s*\S+\s+\S+\s+([\d.]+[KMGT]?)/g;
  for (const m of String(html || "").matchAll(re)) {
    const raw = m[4];
    const unit = SIZE_UNITS[raw[raw.length - 1]];
    out.push({ name: m[1], n: Number(m[3]), kind, bytes: Math.round(parseFloat(raw) * (unit || 1)) });
  }
  return out.sort((a, b) => a.n - b.n);
}

/**
 * The download plan: newest file first.
 *
 * "Newest first" is the whole point of the ordering — the file number tracks
 * the PMID, which tracks when NLM loaded the citation, so an interrupted
 * harvest still leaves the most recent literature complete. That is the
 * property the arXiv harvester got from running its month shards newest-first,
 * and it is the one that matters when a build is stopped early for cost.
 *
 * `maxRecords` is honoured against the archive's own ~30,000 records per full
 * file rather than against a count nobody has yet, so the plan is decidable
 * before a byte is fetched; the harvester stops for real on the actual count.
 *
 * @param {ArchiveFile[]} files every file from both listings
 * @param {{ maxRecords?: number, maxFiles?: number, minFile?: number, done?: Set<string>, perFile?: number }} [opts]
 * @returns {{ files: ArchiveFile[], skipped: number, estRecords: number, estBytes: number }}
 */
export function planHarvest(files, opts = {}) {
  const perFile = opts.perFile ?? RECORDS_PER_FILE;
  const ordered = [...files].sort((a, b) => b.n - a.n);
  /** @type {ArchiveFile[]} */
  const picked = [];
  let estRecords = 0;
  let estBytes = 0;
  let skipped = 0;
  for (const f of ordered) {
    if (opts.minFile && f.n < opts.minFile) continue;
    if (opts.done?.has(f.name)) {
      skipped++;
      continue;
    }
    if (opts.maxFiles && picked.length >= opts.maxFiles) break;
    if (opts.maxRecords && estRecords >= opts.maxRecords) break;
    picked.push(f);
    estRecords += perFile;
    estBytes += f.bytes;
  }
  return { files: picked, skipped, estRecords, estBytes };
}

/** Records in a full archive file. Fixed by NLM at 30,000 — verified on
 * n0100, n0700, n1000 and n1200, all exactly 30,000; only the final baseline
 * file is short (n1334 holds 4,989). */
export const RECORDS_PER_FILE = 30000;

/**
 * One line for the log and the docs, stating what the window IS and what it is
 * not. Printed by the harvester on every run because the distinction is the
 * one that has cost this project two silent 25-50% holes on the arXiv side.
 * @param {{ files: ArchiveFile[] }} plan
 * @param {{ minYear?: number }} [opts]
 * @returns {string}
 */
export function windowNote(plan, opts = {}) {
  const ns = plan.files.map((f) => f.n);
  const lo = Math.min(...ns);
  const hi = Math.max(...ns);
  const base = `window = archive files n${String(lo).padStart(4, "0")}…n${String(hi).padStart(4, "0")} (a PMID/load-order window, newest first)`;
  return opts.minYear
    ? `${base}; --min-year ${opts.minYear} TRIMS this window, it does not define one: a citation published ${opts.minYear} but loaded before file n${String(lo).padStart(4, "0")} is not in any file this run fetches`
    : base;
}

/**
 * The Vectorize metadata for one record. SHORT keys and a cut abstract: this
 * rides in every query response, and src/pubmed-rag.js reads exactly these.
 * @param {PubmedRecord} rec
 * @returns {Record<string, string>}
 */
export function vectorMetadata(rec) {
  return {
    // truncateChars, not .slice: a plain cut can land BETWEEN the two code
    // units of an astral character and leave an orphaned surrogate half. The
    // same cut in buildPassage crash-looped a whole PubMed fill for half an
    // hour (docs/PUBMED-RAG.md §7.3), and this copy was never converted. It is
    // less dangerous here — metadata is stored, not embedded, so it cannot 400
    // the tokenizer — but it is the same latent bug, and the corpus where 88%
    // of abstracts hit a cap is the one that exercises the boundary.
    t: truncateChars(String(rec.title || ""), 300),
    // What the cross-encoder gets to judge on: Berget serves bge-reranker-v2-m3
    // behind a 512-token window covering query AND document, so storing more
    // than 900 chars would be paid-for weight nothing reads.
    a: truncateChars(String(rec.abstract || ""), 900),
    // Head AND tail — storedAuthors explains why a plain head-cut drops the
    // senior author, which on a life-science paper is the name most often asked
    // for. This corpus is where that bites hardest: its author lists are long.
    au: storedAuthors(rec.authors || [], 300),
    j: String(rec.journal || "").slice(0, 160),
    d: String(rec.date || rec.year || "").slice(0, 10),
  };
}
