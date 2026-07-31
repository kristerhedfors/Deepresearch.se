#!/usr/bin/env node
// What did the harvest actually get? Reads the JSONL shards and reports the
// corpus the way it has to be reported — on the DEDUPLICATED set, with the
// drops named.
//
//   node scripts/pubmed-corpus.mjs
//   node scripts/pubmed-corpus.mjs --sample 20000 --out data/pubmed
//
// "Records kept" is not "unique documents", and on PubMed the gap is far wider
// than on arXiv. A daily update file carries NEW, REVISED and DELETED
// citations, so a paper corrected three times since the baseline appears in
// four shards. arXiv's equivalent double-count was 3.4% (339,263 kept →
// 327,742 unique); this script exists so the PubMed number is measured rather
// than assumed, and so a build plan is costed against unique vectors — which
// is what Vectorize bills for.
//
// It also reports the two things the embedder cares about and the harvest
// cannot know: the abstract-length distribution against the 1200-char passage
// budget (PubMed abstracts are markedly longer than arXiv's, so the budget
// bites here in a way it does not there), and the publication-year spread of a
// window that was selected on load order.

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_PASSAGE_CHARS, PASSAGE_PREFIX, buildPassage } from "../public/js/pubmed-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { out: "data/pubmed", sample: 0, top: 12, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--out") out.out = String(value());
    else if (flag === "--sample") out.sample = Number(value());
    else if (flag === "--top") out.top = Number(value());
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  return out;
}

/** @param {number[]} xs @param {number} q */
export function quantile(xs, q) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
}

/**
 * Deterministic sampling by PMID hash, so "the 20k sample" is the same 20k
 * records on every machine. A sample that reshuffles between runs measures the
 * sample rather than the corpus.
 * @param {string} pmid
 * @returns {number} 0..1
 */
export function sampleScore(pmid) {
  let h = 2166136261;
  for (const ch of String(pmid)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/**
 * @param {string} dir
 */
export async function* corpusRows(dir) {
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    throw new Error(`no corpus at ${dir} — run scripts/pubmed-harvest.mjs first`);
  }
  // An empty corpus directory is always a mistake and a silent one: the report
  // would print zeroes and exit 0. The usual way to hit it is passing --out's
  // root instead of its raw/ subdirectory.
  if (!files.length) throw new Error(`no .jsonl shards in ${dir} — did you mean ${dir.replace(/\/$/, "")}/raw ?`);
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        /* a torn last line from an interrupted harvest */
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/pubmed-corpus.mjs [--out DIR] [--sample N] [--top N]");
    return;
  }
  const dir = join(ROOT, args.out, "raw");

  const seen = new Set();
  let rows = 0;
  let truncated = 0;
  /** @type {number[]} */
  const absLens = [];
  /** @type {number[]} */
  const passLens = [];
  const years = {};
  const journals = {};
  const languages = {};
  const types = {};
  let withDoi = 0;
  let withMesh = 0;
  let minPmid = Infinity;
  let maxPmid = 0;

  for await (const row of corpusRows(dir)) {
    rows++;
    const pmid = String(row.pmid || "");
    if (!pmid || seen.has(pmid)) continue;
    seen.add(pmid);
    minPmid = Math.min(minPmid, Number(pmid));
    maxPmid = Math.max(maxPmid, Number(pmid));
    absLens.push((row.abstract || "").length);
    const passage = buildPassage(row, "title_abstract");
    passLens.push(passage.length);
    // The passage budget is a hard 512-token limit expressed in characters;
    // anything at the cap lost its tail, and on this corpus that is the norm
    // rather than the exception.
    if (passage.length >= MAX_PASSAGE_CHARS) truncated++;
    years[row.year || "?"] = (years[row.year || "?"] || 0) + 1;
    if (row.journal) journals[row.journal] = (journals[row.journal] || 0) + 1;
    for (const l of row.languages || []) languages[l] = (languages[l] || 0) + 1;
    for (const t of (row.types || []).slice(0, 1)) types[t] = (types[t] || 0) + 1;
    if (row.doi) withDoi++;
    if ((row.mesh || []).length) withMesh++;
  }

  const unique = seen.size;
  const dupes = rows - unique;
  const mean = (xs) => Math.round(xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length));
  // reduce, not Math.max(...xs): spreading a 600k-element array blows the call
  // stack, and it does it only once the corpus is big enough to matter.
  const max = (xs) => xs.reduce((m, x) => (x > m ? x : m), 0);
  const top = (obj, n) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} ${v.toLocaleString()}`)
      .join(" · ");

  console.log(`rows in shards      ${rows.toLocaleString()}`);
  console.log(`UNIQUE citations    ${unique.toLocaleString()}   (${dupes.toLocaleString()} repeats, ${((100 * dupes) / Math.max(1, rows)).toFixed(1)}% — a revised citation reappears in every update file that touched it)`);
  console.log(`PMID range          ${minPmid.toLocaleString()} … ${maxPmid.toLocaleString()}`);
  console.log(`with DOI            ${((100 * withDoi) / Math.max(1, unique)).toFixed(1)}%`);
  console.log(`with MeSH terms     ${((100 * withMesh) / Math.max(1, unique)).toFixed(1)}%   (MeSH indexing lags publication, so the most recent months are the thin part)`);
  console.log("");
  console.log(`abstract chars      mean ${mean(absLens)} · p5 ${quantile(absLens, 0.05)} · median ${quantile(absLens, 0.5)} · p95 ${quantile(absLens, 0.95)} · p99 ${quantile(absLens, 0.99)} · max ${max(absLens)}`);
  console.log(`passage chars       mean ${mean(passLens)} (budget ${MAX_PASSAGE_CHARS}, prefix "${PASSAGE_PREFIX.trim()}")`);
  console.log(`TRUNCATED passages  ${truncated.toLocaleString()} of ${unique.toLocaleString()} (${((100 * truncated) / Math.max(1, unique)).toFixed(1)}%) — the tail past ${MAX_PASSAGE_CHARS} chars is not embedded`);
  console.log("");
  console.log(`publication years   ${top(years, args.top)}`);
  console.log(`languages           ${top(languages, 6)}`);
  console.log(`publication types   ${top(types, 6)}`);
  console.log(`journals            ${top(journals, 6)}`);

  if (args.sample) {
    const cutoff = args.sample / Math.max(1, unique);
    console.log("");
    console.log(`a --sample ${args.sample} slice takes PMIDs with sampleScore < ${cutoff.toFixed(5)} — deterministic, so every eval sees the same records`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
