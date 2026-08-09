#!/usr/bin/env node
// Reading the harvested arXiv corpus back off disk: dedup, filtering and
// deterministic sampling. Shared by the index builder, the bake-off and the
// search CLI so all three agree on what "the corpus" is.
//
//   node scripts/arxiv-corpus.mjs --stats            # what did the harvest get
//   node scripts/arxiv-corpus.mjs --sample 2000 --out data/arxiv/sample.jsonl

import { readdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { INDEX_ABSTRACT_FLOOR } from "../public/js/arxiv-rag-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Deterministic 32-bit hash — the sampler's source of randomness. Seeded by
 * the arXiv id, so "the 2000-paper sample" is the same set on every machine
 * and every rerun: an evaluation that resampled between variants would be
 * measuring the sample, not the pipeline.
 * @param {string} str
 * @returns {number} 0..1
 */
export function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1_000_003) / 1_000_003;
}

/**
 * Read a materialized JSONL corpus (one paper per line). The bake-off runs
 * against a FROZEN file rather than the live harvest directory: the sampler is
 * deterministic given a corpus, but the corpus itself grows while a harvest is
 * running, and a sample that shifts between variants would silently invalidate
 * every comparison.
 * @param {string} file path relative to the repo root
 * @returns {Promise<import('../public/js/arxiv-rag-core.js').ArxivPaper[]>}
 */
export async function loadCorpusFile(file) {
  /** @type {any[]} */
  const out = [];
  const rl = createInterface({ input: createReadStream(join(ROOT, file)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn line */
    }
  }
  return out;
}

/**
 * @param {{ dir?: string, categories?: string[], sample?: number, seed?: string, months?: string[], minAbstract?: number, file?: string }} [opts]
 * @returns {Promise<import('../public/js/arxiv-rag-core.js').ArxivPaper[]>}
 */
export async function loadCorpus(opts = {}) {
  if (opts.file) return loadCorpusFile(opts.file);
  const dir = join(ROOT, opts.dir || "data/arxiv", "raw");
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    throw new Error(`No harvested corpus at ${dir} — run \`npm run arxiv:harvest\` first.`);
  }
  if (opts.months?.length) files = files.filter((f) => opts.months.includes(f.replace(".jsonl", "")));
  const catFilter = opts.categories?.length ? new Set(opts.categories) : null;
  // The index's own floor, not a local one: the local pack and the hosted
  // index are reported side by side, so a sample drawn on a different floor
  // silently compares two different populations.
  const minAbstract = opts.minAbstract ?? INDEX_ABSTRACT_FLOOR;
  // A paper updated inside the window appears in every month shard it was
  // touched in, so dedup by id is mandatory, not defensive.
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(join(dir, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // a torn last line from an interrupted harvest
      }
      if (!rec?.id || !rec.abstract || rec.abstract.length < minAbstract) continue;
      if (catFilter && !(rec.categories || []).some((/** @type {string} */ c) => catFilter.has(c) || catFilter.has(c.split(".")[0]))) continue;
      byId.set(rec.id, rec);
    }
  }
  let papers = [...byId.values()];
  if (opts.sample && opts.sample < papers.length) {
    const seed = opts.seed || "arxiv-rag-v1";
    papers = papers
      .map((p) => ({ p, r: hash01(seed + ":" + p.id) }))
      .sort((a, b) => a.r - b.r)
      .slice(0, opts.sample)
      .map((x) => x.p);
  }
  papers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return papers;
}

/** @param {import('../public/js/arxiv-rag-core.js').ArxivPaper[]} papers */
export function corpusStats(papers) {
  /** @type {Map<string, number>} */
  const primary = new Map();
  /** @type {Map<string, number>} */
  const months = new Map();
  let abstractChars = 0;
  for (const p of papers) {
    const top = (p.primary || "").split(".")[0] || "?";
    primary.set(top, (primary.get(top) || 0) + 1);
    months.set(p.id.slice(0, 4), (months.get(p.id.slice(0, 4)) || 0) + 1);
    abstractChars += p.abstract.length;
  }
  return {
    papers: papers.length,
    avgAbstractChars: Math.round(abstractChars / (papers.length || 1)),
    estTokens: Math.round((abstractChars / 4 / 1e6) * 10) / 10 + "M",
    byArchive: [...primary.entries()].sort((a, b) => b[1] - a[1]),
    byMonth: [...months.entries()].sort(),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f, /** @type {any} */ d) => {
    const i = argv.indexOf(f);
    return i < 0 ? d : argv[i + 1];
  };
  const papers = await loadCorpus({
    dir: get("--dir", "data/arxiv"),
    sample: Number(get("--sample", 0)) || 0,
    seed: get("--seed", "arxiv-rag-v1"),
    categories: get("--categories", "") ? String(get("--categories", "")).split(",") : [],
  });
  const stats = corpusStats(papers);
  console.log(JSON.stringify(stats, null, 2));
  const out = get("--out", "");
  if (out) {
    await writeFile(join(ROOT, out), papers.map((p) => JSON.stringify(p)).join("\n") + "\n");
    console.log(`Wrote ${papers.length} papers → ${out}`);
  }
}

if (process.argv[1]?.endsWith("arxiv-corpus.mjs")) {
  main().catch((err) => {
    console.error("arxiv-corpus failed:", err.message);
    process.exit(1);
  });
}
