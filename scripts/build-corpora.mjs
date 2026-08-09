#!/usr/bin/env node
// Builds the dataset behind the public /corpora/ page — what the two hosted
// research indexes actually contain, measured rather than asserted.
//
//   node scripts/build-corpora.mjs                 # both corpora, full measurement
//   node scripts/build-corpora.mjs --skip-shape    # live counts only (seconds)
//   node scripts/build-corpora.mjs --only arxiv
//
// ---- why this is generated and not written by hand -------------------------
//
// A page that says "823,097 papers" is a claim with a shelf life. The same
// claim already went stale once inside the code: CORPUS_FACTS.arxiv.window told
// agents "anything before October 2023 is NOT in this index" while 42,307
// papers sat below that line, because named-list fills reach back thirty years
// and nobody re-derived the sentence after them. A hand-maintained public page
// would drift the same way, only where users rather than agents read it.
//
// So every number here comes from the index itself at build time. The two kinds
// are labelled differently in the output and on the page, because they age
// differently:
//
//   MEASURED — read from the live index by this script, with its timestamp.
//   RECORDED — a fact about a fill that already happened (what a harvest read,
//              what it dropped). It cannot be re-derived later and is quoted
//              from the build record, with the date it was measured on.
//
// ---- what can and cannot be measured per corpus -----------------------------
//
// An arXiv id encodes its own submission month (2401.12345 -> 2401), so paging
// the ids is enough to reconstruct the whole coverage shape with no metadata
// fetch. A PMID encodes nothing about publication date — but it does track LOAD
// order, which is the axis the PubMed corpus is actually defined on
// (docs/PUBMED-RAG.md §2), so bucketing PMIDs by magnitude shows the real shape
// of that window rather than a restatement of it.
//
// Cost: ~800 pages for arXiv (~200 s) and ~1,700 for PubMed (~7 min), both at
// 1,000 ids per request. Run it after a fill, not on every deploy.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { idMonth } from "./arxiv-harvest.mjs";
import { requireCloudflare } from "./arxiv-hosted.mjs";
import { bucketByMonth, listIds, sweptBand, windowSentence } from "./arxiv-window.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "public/corpora/data.json";
const API = "https://api.cloudflare.com/client/v4";

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { skipShape: false, only: "", out: OUT };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--skip-shape") out.skipShape = true;
    else if (flag === "--only") out.only = String(value());
    else if (flag === "--out") out.out = String(value());
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (out.only && !["arxiv", "pubmed"].includes(out.only)) {
    throw new Error(`--only takes arxiv or pubmed, got ${JSON.stringify(out.only)}`);
  }
  return out;
}

/**
 * PMIDs are assigned in load order, so their magnitude is a proxy for when NLM
 * took the record in — the axis the PubMed window is defined on. Buckets are
 * millions, which is coarse enough to be stable and fine enough to show that
 * the corpus is a recent-load slice rather than a publication-year range.
 * @param {Iterable<string>} ids
 */
export function bucketByPmidBand(ids) {
  const bands = new Map();
  let total = 0;
  let unparsed = 0;
  for (const raw of ids) {
    total++;
    const m = /^(?:pmid:)?(\d+)$/.exec(String(raw).trim());
    if (!m) {
      unparsed++;
      continue;
    }
    const band = Math.floor(Number(m[1]) / 1_000_000);
    bands.set(band, (bands.get(band) || 0) + 1);
  }
  return { bands, unparsed, total };
}

/** Live vector count for one index. One cheap call; never inferred from a fill. */
export async function vectorCount(index) {
  const { account, token } = requireCloudflare();
  const res = await fetch(`${API}/accounts/${account}/vectorize/v2/indexes/${index}/info`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`vectorize info ${index}: HTTP ${res.status}`);
  return json.result?.vectorCount ?? 0;
}

// RECORDED facts — see the header. Each carries the date it was measured on, so
// a reader can tell a live number from a historical one. These describe fills
// that already happened and cannot be re-derived from the index today.
const RECORDED = {
  arxiv: {
    measured: "2026-08-09",
    channel: "OAI-PMH ListRecords, plus named-id lists through the Atom query API",
    note:
      "The bulk band was swept month by month. Everything below it arrived through " +
      "topic-targeted named-list fills, which is why older coverage is dense for some " +
      "subjects and near-absent for others.",
  },
  pubmed: {
    measured: "2026-07-31",
    channel: "the NLM daily-update archive files, newest first",
    recordsRead: 3_776_137,
    recordsKept: 3_397_607,
    uniqueCitations: 1_639_403,
    repeatRate: 0.559,
    withDoi: 0.993,
    withMesh: 0.667,
    truncatedPassages: 0.88,
    note:
      "Defined as a PMID / load-order window — everything NLM has loaded or revised " +
      "since the 2026 baseline was cut on 2026-01-29 — NOT as a publication-date range. " +
      "The update files carry recent EDITS, so they include old papers that were revised.",
  },
};

/** The domains deliberately filled on top of the bulk sweep. */
const DOMAINS = [
  { id: "adna", name: "Ancient DNA / palaeogenomics", corpora: ["pubmed"], evalSet: "tests/evalsets/adna.json", questions: 180 },
  { id: "aisec", name: "AI cybersecurity", corpora: ["arxiv", "pubmed"], evalSet: "tests/evalsets/aisec.json", questions: 180 },
  { id: "aicon", name: "AI consciousness", corpora: ["arxiv", "pubmed"], evalSet: "tests/evalsets/aicon.json", questions: 180 },
  { id: "dalen", name: "Love Dalén bibliography", corpora: ["pubmed"], evalSet: "tests/evalsets/dalen.json", questions: 56 },
];

async function measureArxiv(index, skipShape) {
  const vectors = await vectorCount(index);
  const out = {
    id: "arxiv",
    name: "arXiv",
    kind: "Preprints — physics, mathematics, computer science, quantitative biology, statistics, economics, quantitative finance",
    index,
    vectors,
    idExample: "2401.12345",
    recorded: RECORDED.arxiv,
  };
  if (skipShape) return out;

  const ids = [];
  for await (const id of listIds(index, (n) => n % 200 === 0 && process.stderr.write(`  arxiv ${n} pages…\n`))) ids.push(id);
  if (ids.length !== vectors) {
    throw new Error(`listed ${ids.length} arXiv ids but the index reports ${vectors} — refusing to publish a partial shape`);
  }
  const hist = bucketByMonth(ids);
  const band = sweptBand(hist.months);
  const years = new Map();
  for (const [m, n] of hist.months) years.set(`20${m.slice(0, 2)}`, (years.get(`20${m.slice(0, 2)}`) || 0) + n);

  out.shape = {
    kind: "submission-month",
    measuredAt: new Date().toISOString(),
    band: band && { from: band.from, to: band.to, count: band.count },
    outsideBand: hist.total - (band?.count || 0),
    preModernIds: hist.old,
    byYear: Object.fromEntries([...years.entries()].sort()),
    sentence: windowSentence(hist),
  };
  return out;
}

async function measurePubmed(index, skipShape) {
  const vectors = await vectorCount(index);
  const out = {
    id: "pubmed",
    name: "PubMed",
    kind: "Biomedical and life-science literature — MEDLINE journals, plus bioRxiv and medRxiv records",
    index,
    vectors,
    idExample: "pmid:41787358",
    recorded: RECORDED.pubmed,
  };
  if (skipShape) return out;

  const ids = [];
  for await (const id of listIds(index, (n) => n % 200 === 0 && process.stderr.write(`  pubmed ${n} pages…\n`))) ids.push(id);
  if (ids.length !== vectors) {
    throw new Error(`listed ${ids.length} PMIDs but the index reports ${vectors} — refusing to publish a partial shape`);
  }
  const { bands, unparsed } = bucketByPmidBand(ids);
  out.shape = {
    kind: "pmid-load-order",
    measuredAt: new Date().toISOString(),
    unparsed,
    byBand: Object.fromEntries([...bands.entries()].sort((a, b) => a[0] - b[0]).map(([b, n]) => [`${b}M`, n])),
  };
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: node scripts/build-corpora.mjs [--skip-shape] [--only arxiv|pubmed] [--out FILE]");
    return;
  }
  const started = Date.now();
  const corpora = [];
  if (opts.only !== "pubmed") corpora.push(await measureArxiv("deepresearch-se-arxiv", opts.skipShape));
  if (opts.only !== "arxiv") corpora.push(await measurePubmed("deepresearch-se-pubmed", opts.skipShape));

  const payload = {
    v: 1,
    generated: new Date().toISOString(),
    corpora,
    domains: DOMAINS,
    totals: { vectors: corpora.reduce((a, c) => a + c.vectors, 0) },
  };
  const outPath = join(ROOT, opts.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `Wrote ${opts.out}: ${corpora.map((c) => `${c.name} ${c.vectors.toLocaleString("en-US")}`).join(", ")} ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
