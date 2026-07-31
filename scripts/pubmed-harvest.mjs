#!/usr/bin/env node
// Harvests PubMed citations into a local JSONL corpus — the raw material for
// the PubMed RAG index (scripts/pubmed-vectorize.mjs), and the sibling of
// scripts/arxiv-harvest.mjs.
//
//   node scripts/pubmed-harvest.mjs --max-files 4          # the 4 newest files
//   node scripts/pubmed-harvest.mjs --max-records 1500000  # ~the last 12 months
//   node scripts/pubmed-harvest.mjs --min-file 1200        # everything from n1200 up
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deletedPmids, keepRecord, parseArticle, parseListing, planHarvest, takeBlocks, windowNote } from "../public/js/pubmed-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FTP = "https://ftp.ncbi.nlm.nih.gov/pubmed";
const CONTACT = process.env.PUBMED_CONTACT || "https://deepresearch.se";
const UA = `deepresearch.se-pubmed-harvest/1.0 (+${CONTACT})`;

// Flow control gets its own generous ceiling; genuine errors keep a short one,
// so a real 500 still fails fast instead of retrying for a quarter of an hour.
const THROTTLE_ATTEMPTS = 12;
const ERROR_ATTEMPTS = 4;
const FILE_PAUSE_MS = 1000;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    out: "data/pubmed",
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "usage: node scripts/pubmed-harvest.mjs [--out DIR] [--max-files N] [--max-records N]\n" +
        "                                      [--min-file N] [--min-year YYYY] [--min-abstract N]\n" +
        "                                      [--languages eng,swe]\n\n" +
        "Files are fetched NEWEST FIRST. The window is a PMID/load-order window;\n" +
        "--min-year trims it rather than defining one.",
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
