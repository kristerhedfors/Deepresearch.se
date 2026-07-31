#!/usr/bin/env node
// Deduplicate the harvested PubMed corpus and split it into N disjoint parts,
// so scripts/pubmed-vectorize.mjs can be run N times in parallel.
//
//   node scripts/pubmed-partition.mjs --parts 8
//   node scripts/pubmed-vectorize.mjs --corpus data/pubmed/parts/00 --work data/pubmed/vectorize/00 &
//   … one per part
//
// ---- why this step exists --------------------------------------------------
//
// Parallelising a Vectorize fill is done by PARTITIONING THE INPUT, not by
// rewriting the loader: N processes over disjoint directories, each with its
// own checkpoint, took the arXiv fill from ~23/s to ~95/s with no change to the
// upsert code.
//
// But the naive split — hand each loader a slice of the SHARDS — is wrong here,
// and expensively so. A PubMed citation revised since the baseline appears in
// every update file that touched it: 3.7 M rows deduplicate to 1.64 M
// citations, 55.9% repeats (docs/PUBMED-RAG.md §3.1). Each loader dedupes only
// what it can see, so the same PMID landing in two partitions is embedded
// twice. Vectorize would still be correct — a repeated id overwrites — but the
// embedding bill is paid per call, so a shard-sliced 8-way fill would spend
// most of an extra €13 for nothing.
//
// So dedup happens ONCE, here, before anything is split. Partitioning is by a
// hash of the PMID rather than by position, which makes the parts stable across
// re-runs (a resumed loader sees the same work list) and evenly sized without
// counting anything first.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { corpus: "data/pubmed/raw", out: "data/pubmed/parts", parts: 8, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--corpus") out.corpus = String(value());
    else if (flag === "--out") out.out = String(value());
    else if (flag === "--parts") out.parts = Number(value());
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!Number.isInteger(out.parts) || out.parts < 1 || out.parts > 64) {
    throw new Error("--parts must be an integer in 1..64");
  }
  return out;
}

/**
 * Which part a PMID belongs to. FNV-1a over the id, so the assignment is
 * deterministic: a re-run puts every citation back in the part its checkpoint
 * already knows about.
 * @param {string} pmid
 * @param {number} parts
 * @returns {number}
 */
export function partOf(pmid, parts) {
  let h = 2166136261;
  for (const ch of String(pmid)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % parts;
}

/** @param {number} n */
const partName = (n) => String(n).padStart(2, "0");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/pubmed-partition.mjs [--corpus DIR] [--out DIR] [--parts N]");
    return;
  }
  const corpusDir = join(ROOT, args.corpus);
  const outDir = join(ROOT, args.out);

  let shards;
  try {
    shards = (await readdir(corpusDir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    throw new Error(`no corpus at ${corpusDir} — run scripts/pubmed-harvest.mjs first`);
  }
  // An empty corpus writes N empty parts and exits 0, and every loader then
  // prints "done — 0 vectors". Loud instead.
  if (!shards.length) throw new Error(`no .jsonl shards in ${corpusDir} — did you mean ${corpusDir}/raw ?`);

  await rm(outDir, { recursive: true, force: true });
  const sinks = [];
  for (let i = 0; i < args.parts; i++) {
    await mkdir(join(outDir, partName(i)), { recursive: true });
    sinks.push({ stream: createWriteStream(join(outDir, partName(i), "part.jsonl")), buf: "", rows: 0 });
  }

  // Shards are read NEWEST FIRST and the first sighting of a PMID wins, which
  // is also its freshest revision: the update files are cumulative, so the
  // highest-numbered shard holding a citation carries its latest text.
  const seen = new Set();
  let rows = 0;
  const started = Date.now();
  for (const shard of shards) {
    const rl = createInterface({ input: createReadStream(join(corpusDir, shard)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      rows++;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // a torn last line from an interrupted harvest
      }
      const pmid = String(row?.pmid || "");
      if (!pmid || seen.has(pmid)) continue;
      seen.add(pmid);
      const sink = sinks[partOf(pmid, args.parts)];
      sink.buf += `${line}\n`;
      sink.rows++;
      if (sink.buf.length > 1 << 20) {
        sink.stream.write(sink.buf);
        sink.buf = "";
      }
    }
  }
  for (const sink of sinks) {
    if (sink.buf) sink.stream.write(sink.buf);
    await new Promise((resolve, reject) => sink.stream.end((/** @type {any} */ err) => (err ? reject(err) : resolve(undefined))));
  }

  const unique = seen.size;
  console.log(
    `${rows.toLocaleString()} rows → ${unique.toLocaleString()} unique citations ` +
      `(${(100 * (rows - unique) / Math.max(1, rows)).toFixed(1)}% repeats) in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
  for (const [i, sink] of sinks.entries()) {
    console.log(`  part ${partName(i)}: ${sink.rows.toLocaleString()}`);
  }
  console.log(`\nfill them in parallel, one loader per part:`);
  console.log(
    `  for p in ${sinks.map((_, i) => partName(i)).join(" ")}; do \\\n` +
      `    NODE_USE_ENV_PROXY=1 node scripts/pubmed-vectorize.mjs --index deepresearch-se-pubmed \\\n` +
      `      --corpus ${args.out}/$p --work data/pubmed/vectorize/$p & done`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
