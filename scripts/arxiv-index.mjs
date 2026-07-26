#!/usr/bin/env node
// Builds the arXiv RAG search database from the harvested corpus.
//
//   node scripts/arxiv-index.mjs --out data/arxiv/index
//   node scripts/arxiv-index.mjs --out data/arxiv/index-cs --categories cs --strategy contextual
//
// Output is a BINARY PACK, not the committed-JSON-artifact shape the rest of
// this repo uses (public/introspect/*-rag.json). That convention exists for
// small corpora a browser fetches whole; a year of arXiv is ~340k papers,
// which is ~350 MB of int8 vectors and ~450 MB of abstracts — base64-in-JSON
// would add a third again and force a full parse to answer one query. So:
//
//   vectors.i8      N × dims raw int8, row-major, row i = passage i
//   passages.json   model/dims/strategy + docIds[i] → arXiv id per row
//   papers.jsonl    one paper per line, the retrievable metadata
//   papers.idx      uint32 byte offset per line, so a hit reads ONE line
//                   instead of loading half a gigabyte of abstracts
//   bm25.json       the lexical index, when --bm25 is set
//
// Everything is written incrementally and the build checkpoints after each
// batch: a run that dies at 90% resumes at 90% rather than re-paying for the
// embeddings. The pure logic (passage construction, quantization) is
// public/js/arxiv-rag-core.js — the same functions the bake-off measured.

import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PASSAGE_PREFIX, buildBm25, paperPassages, quantizeInt8 } from "../public/js/arxiv-rag-core.js";
import { EMBED_BATCH, EMBED_CONCURRENCY, EMBED_MODEL, embedBatch } from "./arxiv-berget.mjs";
import { loadCorpus } from "./arxiv-corpus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {number} n */
const human = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + " GB" : n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " KB");
/** @param {number} s */
const clock = (s) => `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f, /** @type {any} */ d) => {
    const i = argv.indexOf(f);
    return i < 0 ? d : argv[i + 1];
  };
  const has = (/** @type {string} */ f) => argv.includes(f);
  const outDir = join(ROOT, get("--out", "data/arxiv/index"));
  const strategy = get("--strategy", "title_abstract");
  const model = get("--model", EMBED_MODEL);
  const window = Number(get("--window", 0));
  const stride = Number(get("--stride", 0));
  const limit = Number(get("--limit", 0));
  const categories = get("--categories", "") ? String(get("--categories", "")).split(",") : [];
  const corpusFile = get("--corpus-file", "");

  await mkdir(outDir, { recursive: true });
  const papers = await loadCorpus(corpusFile ? { file: corpusFile } : { categories, sample: limit || 0, seed: get("--seed", "arxiv-rag-v1") });
  console.log(`Corpus: ${papers.length} papers${categories.length ? ` (categories ${categories.join(",")})` : ""}`);

  // Passage plan first: the whole build is a function of it, and it must be
  // identical on a resume or the vectors stop lining up with the rows.
  /** @type {string[]} */
  const texts = [];
  /** @type {string[]} */
  const docIds = [];
  for (const p of papers) {
    for (const piece of paperPassages(p, { strategy, window, stride })) {
      texts.push(PASSAGE_PREFIX + piece);
      docIds.push(p.id);
    }
  }
  console.log(`Passages: ${texts.length} (${(texts.length / papers.length).toFixed(2)} per paper, strategy=${strategy}${window ? `, window=${window}/${stride}` : ""})`);

  // ---- paper metadata + its offset index ----------------------------------
  const papersPath = join(outDir, "papers.jsonl");
  const idxPath = join(outDir, "papers.idx");
  if (!has("--vectors-only")) {
    const sink = createWriteStream(papersPath);
    const offsets = new Uint32Array(papers.length + 1);
    let at = 0;
    for (let i = 0; i < papers.length; i++) {
      offsets[i] = at;
      const line = JSON.stringify(papers[i]) + "\n";
      at += Buffer.byteLength(line);
      if (!sink.write(line)) await new Promise((r) => sink.once("drain", r));
    }
    offsets[papers.length] = at;
    await new Promise((r) => sink.end(r));
    // The offset index is uint32; a corpus past 4 GiB of metadata would wrap
    // it and make every lookup return the wrong paper, silently.
    if (at > 0xffffffff) throw new Error(`papers.jsonl is ${human(at)} — past the uint32 offset index's 4 GiB limit. Shard the corpus.`);
    await writeFile(idxPath, Buffer.from(offsets.buffer));
    console.log(`Metadata: ${human(at)} in papers.jsonl + ${human(offsets.byteLength)} offset index`);
  }

  // ---- vectors, resumable --------------------------------------------------
  const vecPath = join(outDir, "vectors.i8");
  const metaPath = join(outDir, "passages.json");
  let dims = 0;
  let done = 0;
  try {
    const prev = JSON.parse(await readFile(metaPath, "utf8"));
    if (prev.strategy === strategy && prev.model === model && prev.window === window && prev.total === texts.length) {
      dims = prev.dims;
      const size = (await stat(vecPath)).size;
      done = Math.floor(size / dims);
      // A crash mid-write can leave a partial row; drop back to a whole row.
      if (size !== done * dims) {
        await writeFile(vecPath, Buffer.from((await readFile(vecPath)).subarray(0, done * dims)));
      }
      console.log(`Resuming: ${done}/${texts.length} passages already embedded`);
    } else if (prev.total) {
      console.log("Existing index has a different plan — rebuilding from scratch");
      await writeFile(vecPath, Buffer.alloc(0));
    }
  } catch {
    await writeFile(vecPath, Buffer.alloc(0));
  }

  const started = Date.now();
  let tokens = 0;
  const startedAt = done;
  // Ordered append: batches are dispatched concurrently but written strictly
  // in sequence, because a row's position IS its identity in vectors.i8.
  for (let base = done; base < texts.length; base += EMBED_BATCH * EMBED_CONCURRENCY) {
    /** @type {Array<Promise<{ vectors: Float32Array[], tokens: number }>>} */
    const jobs = [];
    for (let k = 0; k < EMBED_CONCURRENCY; k++) {
      const start = base + k * EMBED_BATCH;
      if (start >= texts.length) break;
      jobs.push(embedBatch(texts.slice(start, Math.min(start + EMBED_BATCH, texts.length)), { model }));
    }
    const results = await Promise.all(jobs);
    /** @type {Buffer[]} */
    const buffers = [];
    for (const r of results) {
      tokens += r.tokens;
      for (const v of r.vectors) {
        if (!dims) dims = v.length;
        buffers.push(Buffer.from(quantizeInt8(v).buffer));
      }
      done += r.vectors.length;
    }
    await appendFile(vecPath, Buffer.concat(buffers));
    await writeFile(
      metaPath,
      JSON.stringify({ v: 1, model, dims, strategy, window, stride, total: texts.length, done, papers: papers.length, built: new Date().toISOString() }),
    );
    const elapsed = (Date.now() - started) / 1000;
    const rate = (done - startedAt) / elapsed;
    const eta = rate ? (texts.length - done) / rate : 0;
    process.stdout.write(
      `\r  ${done}/${texts.length} passages · ${Math.round(rate)}/s · ${Math.round(tokens / elapsed)} tok/s · elapsed ${clock(elapsed)} · ETA ${clock(eta)}   `,
    );
  }
  process.stdout.write("\n");

  // docIds is written LAST: its presence is the signal that vectors.i8 is
  // complete and the pack is safe to search.
  await writeFile(
    metaPath,
    JSON.stringify({ v: 1, model, dims, strategy, window, stride, total: texts.length, done, papers: papers.length, built: new Date().toISOString(), docIds }),
  );

  if (has("--bm25")) {
    console.log("Building the BM25 lexical index …");
    const t0 = Date.now();
    const bm25 = buildBm25(papers.map((p) => ({ id: p.id, text: `${p.title}\n${p.abstract}` })));
    await writeFile(join(outDir, "bm25.json"), JSON.stringify(bm25));
    console.log(`  ${Object.keys(bm25.postings).length} terms in ${clock((Date.now() - t0) / 1000)}`);
  }

  const vecSize = (await stat(vecPath)).size;
  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `\nIndex ready: ${papers.length} papers · ${done} passages × ${dims}d int8 · ${human(vecSize)} vectors\n` +
      `  ${clock(elapsed)} for ${done - startedAt} new passages (${Math.round(tokens / 1e6)}M prompt tokens)\n` +
      `  → ${outDir}`,
  );
}

if (process.argv[1]?.endsWith("arxiv-index.mjs")) {
  main().catch((err) => {
    console.error("\narxiv-index failed:", err.stack || err.message);
    process.exit(1);
  });
}
