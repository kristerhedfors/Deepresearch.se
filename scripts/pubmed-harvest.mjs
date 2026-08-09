#!/usr/bin/env node
// Harvests PubMed citations into a local JSONL corpus — the raw material for
// the PubMed RAG index (scripts/pubmed-vectorize.mjs), and the sibling of
// scripts/arxiv-harvest.mjs.
//
//   node scripts/pubmed-harvest.mjs --max-files 4          # the 4 newest files
//   node scripts/pubmed-harvest.mjs --max-records 1500000  # ~the last 12 months
//   node scripts/pubmed-harvest.mjs --min-file 1200        # everything from n1200 up
//   node scripts/pubmed-harvest.mjs --pmids ids.txt        # exactly these citations
//
// ---- the channel, and why it is not E-utilities ---------------------------
//
// NLM publishes the whole of PubMed as numbered gzipped XML: an annual
// BASELINE plus DAILY UPDATE files carrying on from the last baseline number.
// The E-utilities guidelines cap an unkeyed client at three requests per
// second and tell data-mining projects to take a local copy of the database
// instead — 40.9 M citations at 3 req/s is not a plan. So this reads the
// archive, and scripts/pubmed-enumerate.mjs uses E-utilities for the second,
// independent count that cross-checks it.
//
// ---- --pmids: the one case the archive cannot serve ------------------------
//
// A NAMED list — "index exactly these 150 citations", a reading list, a
// bibliography, the references of one review — is the opposite problem. The
// PMIDs are scattered across the whole archive, most of them below any window
// worth harvesting, so serving 150 records from the files means downloading
// tens of gigabytes to keep a few hundred kilobytes. E-utilities `efetch` is
// the right channel for that shape and is nothing like the bulk sweep the
// guidelines warn against: 150 ids is ONE request (EFETCH_BATCH ids at a time,
// through the paced client in scripts/pubmed-enumerate.mjs).
//
// It returns the same DTD as the archive files, so it goes through the SAME
// takeBlocks → parseArticle → keepRecord path and the JSONL it writes is
// byte-identical in shape. That is the whole design: no second parser, no
// second record layout, no second set of filters to keep in step.
//
// What it does NOT share with the archive path is a window. There is no file
// order, no "newest first", no load-order note — the window is the list, and
// the run prints that rather than a windowNote() it would have to invent.
//
// ---- newest first, and what the window IS ---------------------------------
//
// The file number tracks the PMID, which tracks when NLM loaded the citation
// (measured: n0700 → PMIDs 21.75-21.78 M, n1200 → 32.8-37.6 M, n1334 →
// 41.60-41.61 M). So descending file order is "latest first" with no date
// arithmetic at all, and an interrupted harvest still leaves the most recent
// literature complete — which is what most research questions want.
//
// The window is therefore a PMID/LOAD-ORDER window, and the harvester prints
// that on every run. `--min-year` TRIMS it; it does not define one. The arXiv
// build lost 48.1% of a month and then 26.5% of a historical band to exactly
// that confusion (docs/ARXIV-RAG.md §10.2 and §3a of the bulk-corpus-etl
// skill), both times exiting 0 with self-consistent counters.
//
// ---- the disk constraint that shapes the loop -----------------------------
//
// The 2026 baseline is 51.8 GB gzipped and the update files another 12.4 GB;
// uncompressed the same data is roughly half a terabyte. A session container
// here has ~30 GB of writable disk. So the archive is never MIRRORED: one file
// is on disk at a time, gzipped, and is deleted as soon as it has been parsed
// down to the handful of fields the index needs. Only the JSONL comes to rest
// (~700 bytes per kept record — about 1 GB per 1.5 M citations).
//
// It parses FROM DISK rather than straight off the socket, and that is not an
// accident. Parsing 30,000 records takes ten-odd seconds of blocking CPU, and
// doing it inside the response stream's `data` handler stalls the socket for
// that whole time: the connection gets torn down mid-body and undici surfaces
// it as a bare `Error: terminated`, which reads like nothing at all. Measured
// here on 2026-07-31 — it killed four consecutive runs after one to three
// files, each time exiting 1 with a one-word message. Downloading at full
// speed and parsing afterwards costs one file's worth of disk and removes the
// failure mode entirely.
//
// ---- flow control ---------------------------------------------------------
//
// One connection, one file at a time, with a pause between files. A 429/503
// from NCBI on a bulk sweep is not an error but "slow down", and can persist
// for minutes, so it gets a generous attempt ceiling with progressive backoff
// while genuine errors keep a short one. NCBI asks bulk users to identify
// themselves; PUBMED_CONTACT sets the address in the User-Agent.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BOOK_TAG, deletedPmids, keepRecord, parseArticle, parseListing, planHarvest, takeBlocks, windowNote } from "../public/js/pubmed-core.js";
import { eutilsFetch } from "./pubmed-enumerate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FTP = "https://ftp.ncbi.nlm.nih.gov/pubmed";
const CONTACT = process.env.PUBMED_CONTACT || "https://deepresearch.se";
const UA = `deepresearch.se-pubmed-harvest/1.0 (+${CONTACT})`;

// Flow control gets its own generous ceiling; genuine errors keep a short one,
// so a real 500 still fails fast instead of retrying for a quarter of an hour.
const THROTTLE_ATTEMPTS = 12;
const ERROR_ATTEMPTS = 4;
const FILE_PAUSE_MS = 1000;

/** The archive-window flags. Meaningless against an explicit PMID list, and
 * silently ignoring one is how a run ends up harvesting something other than
 * what its command line says. */
const WINDOW_FLAGS = { maxFiles: "--max-files", maxRecords: "--max-records", minFile: "--min-file" };

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    out: "data/pubmed",
    pmids: "",
    maxFiles: 0,
    maxRecords: 0,
    minFile: 0,
    minYear: 0,
    minAbstract: undefined,
    languages: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--out") out.out = String(value());
    else if (flag === "--pmids") out.pmids = String(value());
    else if (flag === "--max-files") out.maxFiles = Number(value());
    else if (flag === "--max-records") out.maxRecords = Number(value());
    else if (flag === "--min-file") out.minFile = Number(value());
    else if (flag === "--min-year") out.minYear = Number(value());
    else if (flag === "--min-abstract") out.minAbstract = Number(value());
    else if (flag === "--languages") out.languages = String(value()).split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  for (const k of ["maxFiles", "maxRecords", "minFile", "minYear"]) {
    if (!Number.isFinite(out[k]) || out[k] < 0) throw new Error(`--${k} must be a non-negative number`);
  }
  if (out.pmids) {
    const clash = Object.entries(WINDOW_FLAGS).filter(([k]) => out[k]).map(([, flag]) => flag);
    if (clash.length) {
      throw new Error(`--pmids takes an explicit list, not a window: ${clash.join(", ")} cannot be combined with it`);
    }
  }
  return out;
}

/** ids per `efetch` call. NCBI's guideline is to switch to POST above a few
 * hundred ids; 200 keeps the URL near 2 KB, so a GET is safe and a 150-PMID
 * list is a single request. */
export const EFETCH_BATCH = 200;

/**
 * The PMID list file → unique PMIDs, in the order given.
 *
 * Accepts what a list pasted out of PubMed, a spreadsheet column or a
 * bibliography actually looks like: one id per line or comma/space separated,
 * blank lines, `#` comments, and the `PMID` label PubMed's own export puts in
 * front of the number. The label is stripped from the LINE rather than matched
 * as a prefix on the token, because PubMed writes it as `PMID: 41610285` —
 * with a space — so a token-level prefix leaves a bare `PMID:` behind and the
 * most common paste of all fails.
 *
 * Anything else THROWS rather than being skipped. A silently dropped id is
 * indistinguishable from an id PubMed does not hold, and the entire point of
 * this path is that the caller named the records — so "I asked for 150 and got
 * 149" has to have exactly one possible cause, reported at the end.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parsePmidList(text) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    const stripped = line.replace(/#.*$/, "").replace(/\bpmids?\s*:?\s*/gi, " ");
    for (const token of stripped.split(/[\s,;]+/)) {
      if (!token) continue;
      // Leading zeros are consumed by the pattern, not counted against the
      // 9-digit ceiling: a zero-padded column is still a valid list, and the
      // highest PMID as of 2026 is 8 digits (41.6 M).
      const pmid = (token.match(/^0*(\d{1,9})$/) || [])[1];
      // Number(), so "0033301246" and "33301246" are the same id rather than
      // two entries one of which can never be reconciled against a response.
      if (!pmid || !Number(pmid)) throw new Error(`not a PMID: ${JSON.stringify(token)}`);
      const bare = String(Number(pmid));
      if (seen.has(bare)) continue;
      seen.add(bare);
      out.push(bare);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with the two-counter retry policy. Returns the Response; the caller
 * streams the body.
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function get(url) {
  let throttles = 0;
  let errors = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" } });
    } catch (err) {
      if (++errors >= ERROR_ATTEMPTS) throw err;
      await sleep(2000 * errors);
      continue;
    }
    if (res.ok) return res;
    // 429/503 on a bulk sweep is flow control, not failure.
    if (res.status === 429 || res.status === 503) {
      if (++throttles >= THROTTLE_ATTEMPTS) throw new Error(`${url}: throttled ${throttles}x, giving up`);
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(120_000, 5000 * 2 ** (throttles - 1));
      console.log(`  throttled (${res.status}) — waiting ${Math.round(wait / 1000)}s [${throttles}/${THROTTLE_ATTEMPTS}]`);
      await sleep(wait);
      continue;
    }
    if (++errors >= ERROR_ATTEMPTS) throw new Error(`${url}: HTTP ${res.status}`);
    await sleep(2000 * errors);
  }
}

/**
 * Both directory listings, merged into one file table.
 * @returns {Promise<import('../public/js/pubmed-core.js').ArchiveFile[]>}
 */
export async function fetchListings() {
  const files = [];
  for (const [kind, path] of [["baseline", "baseline"], ["updates", "updatefiles"]]) {
    const res = await get(`${FTP}/${path}/`);
    const found = parseListing(await res.text(), /** @type {any} */ (kind));
    if (!found.length) throw new Error(`${path}: listing parsed to zero files — the page shape changed`);
    files.push(...found);
  }
  return files;
}

/**
 * Download one archive file to `dest`, retrying a torn body.
 *
 * A dropped connection mid-body is the common failure on this channel and it
 * arrives as undici's one-word `Error: terminated`, so it gets retried rather
 * than ending the run — the file is re-fetched from scratch, which is a few
 * seconds at this size.
 *
 * @param {string} url
 * @param {string} dest
 */
async function download(url, dest) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await get(url);
      if (!res.body) throw new Error(`${url}: empty body`);
      await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), createWriteStream(dest));
      return;
    } catch (err) {
      if (attempt >= ERROR_ATTEMPTS) throw err;
      console.log(`  download interrupted (${err?.message || err}) — retrying [${attempt}/${ERROR_ATTEMPTS - 1}]`);
      await sleep(2000 * attempt);
    }
  }
}

/**
 * Fetch one archive file, parse it, and append kept records to a shard.
 *
 * The shard is written to `<name>.part` and renamed only after the whole file
 * parsed, so an interrupted run can never be mistaken for a finished file: the
 * checkpoint records the shard name, and the name only exists once it is
 * complete.
 *
 * @param {import('../public/js/pubmed-core.js').ArchiveFile} file
 * @param {string} dir
 * @param {string} tmpDir
 * @param {{ minYear?: number, minAbstract?: number, languages?: string[] }} filters
 */
export async function harvestFile(file, dir, tmpDir, filters) {
  const url = `${FTP}/${file.kind === "baseline" ? "baseline" : "updatefiles"}/${file.name}`;
  const gzPath = join(tmpDir, file.name);
  await download(url, gzPath);

  const partPath = join(dir, `${file.name.replace(/\.xml\.gz$/, "")}.jsonl.part`);
  const sink = createWriteStream(partPath);
  const stats = { records: 0, kept: 0, deleted: [], reasons: {}, years: {}, chars: 0 };
  let buffer = "";
  let pending = "";

  const consume = (text) => {
    buffer += text;
    const { blocks, rest } = takeBlocks(buffer);
    buffer = rest;
    for (const block of blocks) {
      stats.records++;
      const rec = parseArticle(block);
      const verdict = keepRecord(rec, filters);
      if (!verdict.keep) {
        stats.reasons[verdict.reason] = (stats.reasons[verdict.reason] || 0) + 1;
        continue;
      }
      stats.kept++;
      stats.chars += rec.abstract.length;
      stats.years[rec.year || "?"] = (stats.years[rec.year || "?"] || 0) + 1;
      pending += `${JSON.stringify(rec)}\n`;
      if (pending.length > 1 << 20) {
        sink.write(pending);
        pending = "";
      }
    }
    // Withdrawn citations arrive outside the article blocks, so they are read
    // off the same text before it is discarded.
    for (const pmid of deletedPmids(text)) stats.deleted.push(pmid);
  };

  const decoder = new TextDecoder("utf8");
  const gunzip = createGunzip();
  gunzip.on("data", (chunk) => consume(decoder.decode(chunk, { stream: true })));
  await pipeline(createReadStream(gzPath), gunzip);
  consume(decoder.decode());
  if (pending) sink.write(pending);
  await new Promise((resolve, reject) => sink.end((err) => (err ? reject(err) : resolve(undefined))));
  // One archive file on disk at a time — the whole set does not fit.
  await rm(gzPath, { force: true });

  // A file that parsed to zero records is ALWAYS a mistake — a changed DTD, a
  // truncated download, a listing pointing somewhere else — and a silent one,
  // because the run would carry on and report a smaller corpus as a success.
  if (!stats.records) throw new Error(`${file.name}: parsed 0 records — refusing to record it as done`);

  await rename(partPath, partPath.replace(/\.part$/, ""));
  return stats;
}

/**
 * One `efetch` call for a batch of PMIDs, as XML text.
 *
 * Split out from harvestPmids so a test can hand it canned XML: everything
 * interesting about this path is the RECONCILIATION, and reconciliation logic
 * that can only be exercised against the live NCBI is logic nobody tests.
 *
 * @param {string[]} ids
 * @returns {Promise<string>}
 */
export async function efetchArticles(ids) {
  return (await eutilsFetch("efetch.fcgi", { id: ids.join(","), retmode: "xml" })).text();
}

/** The PMID of a `<PubmedBookArticle>`, which lives under `<BookDocument>`
 * rather than `<MedlineCitation>` and so is invisible to parseArticle.
 * @param {string} block
 * @returns {string}
 */
function bookPmid(block) {
  const m = String(block).match(/<BookDocument>\s*<PMID[^>]*>(\d+)<\/PMID>/) || String(block).match(/<PMID[^>]*>(\d+)<\/PMID>/);
  return m ? m[1] : "";
}

/**
 * @typedef {{
 *   requested: number, batches: number, articles: number, books: number,
 *   kept: number, dropped: number, reasons: Record<string, number>,
 *   bookPmids: string[], missing: string[], unrequested: string[],
 *   nameless: number, shard: string
 * }} PmidHarvestStats
 */

/**
 * Harvest an EXPLICIT list of PMIDs through E-utilities into the same JSONL
 * the archive path writes — same takeBlocks, same parseArticle, same
 * keepRecord, so the rows are indistinguishable downstream.
 *
 * The return value is a full RECONCILIATION of requested against returned,
 * and that is the reason this function exists rather than a loop in main().
 * Both ways a citation can vanish here are SILENT at the transport level, and
 * both were reproduced against the live API on 2026-08-08:
 *
 *   * a PMID that names a BOOK (GeneReviews and friends — PMID 20301295) comes
 *     back as `<PubmedBookArticle>`, which takeBlocks does not match, so three
 *     ids in produced two blocks out with no error anywhere;
 *   * a PMID PubMed does not hold (999999999) is simply absent from the
 *     response — HTTP 200, no `<ERROR>` element, nothing.
 *
 * A run that reported "150 kept" while quietly indexing 148 would be exactly
 * the failure mode this corpus's whole verification discipline exists to
 * prevent, so every requested id ends in one of four buckets — kept, dropped
 * by a filter, book, or never returned — and the buckets are asserted to add
 * up before the shard is renamed into place.
 *
 * @param {string[]} pmids
 * @param {string} dir the corpus `raw/` directory
 * @param {{ minYear?: number, minAbstract?: number, languages?: string[] }} filters
 * @param {{ batch?: number, name?: string, fetchXml?: (ids: string[]) => Promise<string>,
 *           onBatch?: (done: number, total: number) => void }} [opts]
 * @returns {Promise<PmidHarvestStats>}
 */
export async function harvestPmids(pmids, dir, filters, opts = {}) {
  const batchSize = opts.batch || EFETCH_BATCH;
  const fetchXml = opts.fetchXml || efetchArticles;
  // Two lists harvested into one --out must not clobber each other's shard,
  // so the name carries the list's identity rather than being a constant.
  const shard = `pmids-${String(opts.name || "list").replace(/[^a-z0-9._-]+/gi, "-")}.jsonl`;
  const wanted = [...new Set(pmids.map((p) => String(p).trim()).filter(Boolean))];

  const partPath = join(dir, `${shard}.part`);
  const sink = createWriteStream(partPath);
  /** How each PMID the response carried was disposed of. */
  const seen = new Map();
  /** @type {PmidHarvestStats} */
  const stats = {
    requested: wanted.length,
    batches: 0,
    articles: 0,
    books: 0,
    kept: 0,
    dropped: 0,
    reasons: {},
    bookPmids: [],
    missing: [],
    unrequested: [],
    nameless: 0,
    shard,
  };

  for (let i = 0; i < wanted.length; i += batchSize) {
    const slice = wanted.slice(i, i + batchSize);
    const xml = await fetchXml(slice);
    stats.batches++;
    const { blocks } = takeBlocks(xml);
    const books = takeBlocks(xml, BOOK_TAG).blocks;
    // Zero records for a whole batch is a changed DTD, a rejected request that
    // still came back 200, or a `retmode` that stopped being XML — never a
    // legitimate answer for a batch of real ids. Loud, like the archive path's
    // "parsed 0 records" guard, because the alternative is a smaller corpus
    // reported as a success.
    if (!blocks.length && !books.length) {
      throw new Error(`efetch returned 0 records for ${slice.length} ids (batch ${stats.batches}) — refusing to write a shard`);
    }
    let pending = "";
    for (const block of blocks) {
      stats.articles++;
      const rec = parseArticle(block);
      if (!rec) {
        // A block with no PMID cannot be attributed to a requested id, so it
        // is counted separately rather than folded into the drop reasons —
        // otherwise the four buckets stop adding up and the check below fires
        // for the wrong reason.
        stats.nameless++;
        continue;
      }
      const verdict = keepRecord(rec, filters);
      if (!verdict.keep) {
        stats.dropped++;
        stats.reasons[verdict.reason] = (stats.reasons[verdict.reason] || 0) + 1;
        seen.set(rec.pmid, `dropped:${verdict.reason}`);
        continue;
      }
      stats.kept++;
      seen.set(rec.pmid, "kept");
      pending += `${JSON.stringify(rec)}\n`;
      if (pending.length > 1 << 20) {
        sink.write(pending);
        pending = "";
      }
    }
    for (const block of books) {
      stats.books++;
      const pmid = bookPmid(block);
      if (pmid) {
        stats.bookPmids.push(pmid);
        seen.set(pmid, "book");
      }
    }
    if (pending) sink.write(pending);
    opts.onBatch?.(Math.min(i + batchSize, wanted.length), wanted.length);
  }

  await new Promise((resolve, reject) => sink.end((err) => (err ? reject(err) : resolve(undefined))));

  stats.missing = wanted.filter((p) => !seen.has(p));
  const wantedSet = new Set(wanted);
  // A PMID that was merged into another record comes back under its CURRENT
  // id, so the response can carry ids nobody asked for. The row is still the
  // right citation and is kept; it is named here because it is also why an id
  // can be "missing" while nothing went wrong.
  stats.unrequested = [...seen.keys()].filter((p) => !wantedSet.has(p));

  const accounted = wanted.filter((p) => seen.has(p)).length + stats.missing.length;
  if (accounted !== wanted.length) {
    throw new Error(`accounting is broken: ${accounted} dispositions for ${wanted.length} requested PMIDs`);
  }
  // Nothing kept means the shard would be an empty file that the fill happily
  // reports as "done — 0 vectors". At this scale that is always a mistake.
  if (!stats.kept) {
    throw new Error(
      `kept 0 of ${wanted.length} requested PMIDs (${stats.books} books, ${stats.missing.length} not returned, ` +
        `drops: ${JSON.stringify(stats.reasons)}) — refusing to write an empty shard; --min-abstract 0 keeps short abstracts`,
    );
  }

  await rename(partPath, partPath.replace(/\.part$/, ""));
  return stats;
}

/**
 * Print the reconciliation. Every requested id lands in exactly one bucket and
 * the line says so out loud, because "150 requested / 150 in the index" is the
 * only claim this path is allowed to make without checking.
 * @param {PmidHarvestStats} stats
 * @param {string} missingPath
 */
function reportPmidHarvest(stats, missingPath) {
  console.log(
    `done — ${stats.kept} kept of ${stats.requested} requested ` +
      `(${stats.dropped} dropped by filters, ${stats.books} book records, ${stats.missing.length} not returned by efetch) ` +
      `in ${stats.batches} efetch call${stats.batches === 1 ? "" : "s"}`,
  );
  if (stats.dropped) console.log(`  drop reasons: ${JSON.stringify(stats.reasons)}`);
  if (stats.books) {
    console.log(
      `  ${stats.books} BOOK record(s) — <PubmedBookArticle> has no abstract element this corpus can embed, so they are skipped, not lost silently: ` +
        stats.bookPmids.slice(0, 10).join(", "),
    );
  }
  if (stats.nameless) console.log(`  ${stats.nameless} article block(s) carried no PMID — the response shape may have changed`);
  if (stats.unrequested.length) {
    console.log(`  ${stats.unrequested.length} record(s) came back under an id that was not asked for (merged PMIDs): ${stats.unrequested.slice(0, 10).join(", ")}`);
  }
  if (stats.missing.length) {
    console.log(`  ${stats.missing.length} PMID(s) NOT returned by efetch — written to ${missingPath}`);
    console.log(`    e.g. ${stats.missing.slice(0, 10).join(", ")}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "usage: node scripts/pubmed-harvest.mjs [--out DIR] [--max-files N] [--max-records N]\n" +
        "                                      [--min-file N] [--min-year YYYY] [--min-abstract N]\n" +
        "                                      [--languages eng,swe]\n" +
        "       node scripts/pubmed-harvest.mjs --pmids FILE [--out DIR] [--min-abstract N]\n\n" +
        "Files are fetched NEWEST FIRST. The window is a PMID/load-order window;\n" +
        "--min-year trims it rather than defining one.\n\n" +
        "--pmids reads an explicit list (one PMID per line, `#` comments allowed)\n" +
        "and fetches exactly those citations through E-utilities. It has no window,\n" +
        "so it cannot be combined with --min-file / --max-files / --max-records.",
    );
    return;
  }

  const outDir = join(ROOT, args.out);
  const rawDir = join(outDir, "raw");
  const stateDir = join(outDir, "state");
  const tmpDir = join(outDir, "tmp");
  await mkdir(rawDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  const statePath = join(stateDir, "done.json");

  if (args.pmids) {
    const listPath = join(ROOT, args.pmids);
    const pmids = parsePmidList(await readFile(listPath, "utf8"));
    if (!pmids.length) throw new Error(`${args.pmids}: no PMIDs in the list`);
    // Not windowNote(): there is no file order and no load-order window to
    // describe here, and printing one would be a claim about coverage that
    // this path cannot make. The window IS the list.
    console.log(`window = an EXPLICIT list of ${pmids.length} PMIDs (no archive listing, no load-order window)`);
    const filters = { minYear: args.minYear || undefined, minAbstract: args.minAbstract, languages: args.languages };
    const started = Date.now();
    const stats = await harvestPmids(pmids, rawDir, filters, {
      name: basename(listPath).replace(/\.[^.]*$/, ""),
      onBatch: (done, total) => console.log(`  efetch ${done}/${total}`),
    });
    // Written even when empty, so "which ids did PubMed not have" is a file
    // the next run can diff rather than something scrolled off a terminal.
    const missingPath = join(stateDir, `${stats.shard.replace(/\.jsonl$/, "")}-missing.txt`);
    await writeFile(missingPath, stats.missing.join("\n") + (stats.missing.length ? "\n" : ""));
    reportPmidHarvest(stats, missingPath);
    console.log(`  shard: ${join(args.out, "raw", stats.shard)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    // No done.json is written: efetch carries no <DeleteCitation>, so there is
    // no withdrawn set for this channel. The fill's --state reads an absent
    // file as "nothing withdrawn", which is exactly right here — and --prune
    // against a list is meaningless, not merely unnecessary.
    console.log(`fill it: node scripts/pubmed-vectorize.mjs --index deepresearch-se-pubmed --corpus ${join(args.out, "raw")} --work ${join(args.out, "vectorize")}`);
    return;
  }

  /** @type {{ files: Record<string, any>, deleted: string[] }} */
  let state = { files: {}, deleted: [] };
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    /* first run */
  }

  console.log("listing the archive…");
  const files = await fetchListings();
  const baseline = files.filter((f) => f.kind === "baseline").length;
  console.log(`  ${files.length} files (${baseline} baseline, ${files.length - baseline} daily updates)`);

  const plan = planHarvest(files, {
    maxFiles: args.maxFiles,
    maxRecords: args.maxRecords,
    minFile: args.minFile,
    done: new Set(Object.keys(state.files)),
  });
  if (!plan.files.length) {
    // Loud, not "done — 0 files": an empty plan is either "already complete" or
    // a mis-typed bound, and the two must not look the same in a log.
    console.log(`nothing to fetch — ${plan.skipped} files already harvested. Raise --max-files / --max-records, or lower --min-file.`);
    return;
  }
  console.log(windowNote(plan, { minYear: args.minYear }));
  console.log(
    `plan: ${plan.files.length} files, ~${plan.estRecords.toLocaleString()} records, ~${(plan.estBytes / 1e9).toFixed(1)} GB to stream` +
      (plan.skipped ? ` (${plan.skipped} already done)` : ""),
  );

  const filters = { minYear: args.minYear || undefined, minAbstract: args.minAbstract, languages: args.languages };
  const started = Date.now();
  let records = 0;
  let kept = 0;

  for (const [i, file] of plan.files.entries()) {
    const t0 = Date.now();
    const stats = await harvestFile(file, rawDir, tmpDir, filters);
    records += stats.records;
    kept += stats.kept;
    state.files[file.name] = { n: file.n, kind: file.kind, records: stats.records, kept: stats.kept, at: new Date().toISOString() };
    if (stats.deleted.length) state.deleted = [...new Set([...state.deleted, ...stats.deleted])];
    await writeFile(statePath, JSON.stringify(state, null, 2));
    const rate = kept / Math.max(1, (Date.now() - started) / 1000);
    console.log(
      `  [${i + 1}/${plan.files.length}] ${file.name}: ${stats.records} records, ${stats.kept} kept` +
        `${stats.deleted.length ? `, ${stats.deleted.length} deletions` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s, ${rate.toFixed(0)}/s overall)`,
    );
    if (i < plan.files.length - 1) await sleep(FILE_PAUSE_MS);
  }

  const dropped = records - kept;
  console.log(
    `done — ${kept.toLocaleString()} kept of ${records.toLocaleString()} records ` +
      `(${dropped.toLocaleString()} dropped, ${((100 * dropped) / Math.max(1, records)).toFixed(1)}%) ` +
      `in ${((Date.now() - started) / 60000).toFixed(1)} min`,
  );
  console.log("cross-check it before trusting it: node scripts/pubmed-enumerate.mjs --verify");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
