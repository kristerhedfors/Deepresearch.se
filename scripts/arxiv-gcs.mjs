#!/usr/bin/env node
// Enumerates arXiv paper ids from the PUBLIC Google Cloud Storage mirror —
// the unthrottled channel for answering "which papers exist in this window".
//
//   node scripts/arxiv-gcs.mjs --months 12 --out data/arxiv/gcs-ids.txt
//   node scripts/arxiv-gcs.mjs --months 1 --dry-run          # just count
//
// WHY THIS EXISTS: enumeration via OAI-PMH is the part that kept failing.
// arXiv's terms allow one request every three seconds on a single connection,
// which puts a year at ~15 hours, and in practice a harvest died 29 pages into
// a shard under sustained 503 flow control (scripts/arxiv-harvest.mjs records
// the incident). The GCS mirror has none of those properties.
//
// ---- what the mirror actually is, verified 2026-07-26 ----------------------
// `gs://arxiv-dataset/` is the bucket behind the Kaggle `Cornell-University/arxiv`
// dataset, and it is **publicly readable with no credentials at all** — plain
// HTTPS against the JSON API works, so no gsutil, no service account, no
// Kaggle token, and no requester-pays (that is the SEPARATE `s3://arxiv/`
// bucket, which is 9.2 TB of tarballs and does bill the downloader).
//
//   * `arxiv/arxiv/pdf/<YYMM>/<id>v<N>.pdf` — one object per paper VERSION,
//     not a tarball. **Current**: the 2607 shard existed with objects updated
//     2026-07-12 when this was written.
//   * Listing returns 1000 objects per page behind a `nextPageToken`, fast,
//     with no rate limit encountered.
//   * `metadata-v5/arxiv-metadata-oai.json` — 4.5 GB of titles+abstracts, and
//     **STALE: last updated 2020-08-19**. This is the trap. The bucket looks
//     like a complete metadata solution and is not; only the PDF tree is kept
//     current. Do not build an abstract corpus from it and expect recent work.
//
// So the mirror gives ENUMERATION and PDFs, not current abstracts. That is
// still the hard half: with the id list in hand, `arxiv.org/html/<id>` yields
// the abstract AND the body in one fetch (scripts/arxiv-html.mjs parses both),
// so neither OAI-PMH nor the rate-limited query API is needed at all.
//
// Old-style ids (`cs/0503001`) live under per-archive prefixes (`arxiv/cs/…`)
// and are pre-2007, so the `arxiv/arxiv/pdf/<YYMM>/` tree is exactly the modern
// id space this project's window covers.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://storage.googleapis.com/storage/v1/b/arxiv-dataset/o";
const PDF_PREFIX = "arxiv/arxiv/pdf/";
const PAGE_SIZE = 1000;
const TIMEOUT_MS = 45_000;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { months: 12, out: "data/arxiv/gcs-ids.txt", dryRun: false, until: "" };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--months") out.months = Number(value());
    else if (flag === "--out") out.out = String(value());
    else if (flag === "--until") out.until = String(value());
    else if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!Number.isFinite(out.months) || out.months < 1 || out.months > 240) {
    throw new Error("--months must be 1..240");
  }
  return out;
}

/**
 * The `YYMM` shard names covering the last `months` months, newest first —
 * the same id-prefix convention the OAI harvester filters on, so the two
 * enumeration paths agree on what "in window" means.
 * @param {string} todayISO e.g. "2026-07-26"
 * @param {number} months
 * @returns {string[]}
 */
export function shardMonths(todayISO, months) {
  const d = new Date(`${todayISO}T00:00:00Z`);
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < months; i++) {
    const y = String(d.getUTCFullYear() % 100).padStart(2, "0");
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    out.push(y + m);
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

/**
 * `arxiv/arxiv/pdf/2607/2607.00001v1.pdf` → `{ id: "2607.00001", version: 1 }`,
 * or null for anything that is not a versioned modern-id PDF object.
 * @param {string} name
 * @returns {{ id: string, version: number } | null}
 */
export function idFromObjectName(name) {
  const m = /(?:^|\/)(\d{4}\.\d{4,5})v(\d+)\.pdf$/i.exec(String(name || ""));
  if (!m) return null;
  return { id: m[1], version: Number(m[2]) };
}

/**
 * One listing page → the newest version seen per id, merged into `into`.
 * A paper with v1 and v3 objects yields one entry at 3, so the caller ends up
 * with the current version of each paper rather than a duplicate per revision.
 * @param {any} page the parsed JSON API response
 * @param {Map<string, number>} into
 * @returns {string | ""} the nextPageToken, or "" when the shard is exhausted
 */
export function mergeListingPage(page, into) {
  for (const item of page?.items || []) {
    const parsed = idFromObjectName(item?.name);
    if (!parsed) continue;
    const seen = into.get(parsed.id);
    if (seen === undefined || parsed.version > seen) into.set(parsed.id, parsed.version);
  }
  return typeof page?.nextPageToken === "string" ? page.nextPageToken : "";
}

/**
 * Every paper id in one `YYMM` shard, with its newest version.
 * @param {string} yymm
 * @param {(pages: number, ids: number) => void} [onProgress]
 * @returns {Promise<Map<string, number>>}
 */
export async function listShard(yymm, onProgress) {
  /** @type {Map<string, number>} */
  const ids = new Map();
  let token = "";
  let pages = 0;
  do {
    const params = new URLSearchParams({
      prefix: `${PDF_PREFIX}${yymm}/`,
      maxResults: String(PAGE_SIZE),
      fields: "items(name),nextPageToken",
    });
    if (token) params.set("pageToken", token);
    const res = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GCS listing ${yymm}: HTTP ${res.status}`);
    token = mergeListingPage(await res.json(), ids);
    pages++;
    onProgress?.(pages, ids.size);
  } while (token);
  return ids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/arxiv-gcs.mjs [--months 12] [--out FILE] [--until YYYY-MM-DD] [--dry-run]");
    return;
  }
  const today = args.until || new Date().toISOString().slice(0, 10);
  const months = shardMonths(today, args.months);
  console.log(`GCS enumeration: ${months.length} shards (${months[months.length - 1]}..${months[0]}), newest first`);

  /** @type {Map<string, number>} */
  const all = new Map();
  const started = Date.now();
  for (const yymm of months) {
    try {
      const shard = await listShard(yymm, (pages, n) => {
        if (pages % 10 === 0) process.stdout.write(`\r  [${yymm}] ${pages} pages, ${n} ids`);
      });
      for (const [id, v] of shard) all.set(id, v);
      process.stdout.write(`\r  [${yymm}] ${shard.size} papers (running total ${all.size})\n`);
    } catch (/** @type {any} */ err) {
      console.log(`\r  [${yymm}] FAILED: ${err?.message || err}`);
    }
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n${all.size} unique papers across ${months.length} months in ${mins} min`);
  if (args.dryRun) return;
  const path = join(ROOT, args.out);
  await mkdir(dirname(path), { recursive: true });
  const lines = [...all.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).map(([id, v]) => `${id}v${v}`);
  await writeFile(path, lines.join("\n") + "\n");
  console.log(`wrote ${args.out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
