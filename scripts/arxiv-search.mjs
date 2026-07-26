#!/usr/bin/env node
// Query the arXiv RAG search database built by scripts/arxiv-index.mjs.
//
//   node scripts/arxiv-search.mjs "how can LLM applications provably protect user data"
//   node scripts/arxiv-search.mjs --sv "kvantfelkorrigering med ytkoder" --top 10
//   node scripts/arxiv-search.mjs --pipeline hybrid_rerank --json "protein design"
//
// Pipelines mirror the bake-off's variants exactly (scripts/arxiv-eval.mjs), so
// the thing measured is the thing shipped:
//
//   dense_rerank    dense top-50 → bge-reranker-v2-m3   (default)
//   dense           embed the query, cosine over the packed int8 matrix
//   hybrid          RRF(dense, BM25) — needs an index built with --bm25
//   hybrid_rerank   hybrid top-50 → bge-reranker-v2-m3
//
// --deep adds the FULL-TEXT stage: the pipelines above pick candidate PAPERS
// from their abstracts, then the body chunks of those papers only are searched
// and reranked, so the answer can come from section 4 rather than the summary.
// Papers not yet in the full-text cache are warmed on the spot
// (scripts/arxiv-fulltext.mjs). Deliberately two-stage: a flat index over every
// paper's body would put mid-paper chunks in competition with abstracts for
// DISCOVERY, and abstracts are what discovery is good at (docs/ARXIV-RAG.md §9).
//
// `dense_rerank` is the default because it measured best on every unbiased
// metric in BOTH languages (docs/ARXIV-RAG.md §4.3): nDCG@10 0.759 EN / 0.795
// SV against 0.711 / 0.713 for plain dense, and +15/+17 points of recall@1.
// It costs ~2 s per query; `--pipeline dense` is the fast path.
//
// The lexical arm is deliberately NOT in the default. It looks strong on the
// synthetic needle set only because those queries inherit two-thirds of their
// vocabulary from the abstract they were written from; on hand-written queries
// fusing BM25 in scores WORSE than leaving it out, in both languages. `hybrid`
// stays available for exact-term lookups (an acronym, a method name, an
// author), which the topical query set does not cover.

import { open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUERY_PREFIX, bm25Search, cosineF32Int8, denseSearchPacked, packedNorms, rrfFuse } from "../public/js/arxiv-rag-core.js";
import { RERANK_DOC_CHARS, rerank } from "./arxiv-berget.mjs";
import { embedBatch } from "./embed-providers.mjs";
import { loadFullText, warmPapers } from "./arxiv-fulltext.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RERANK_DEPTH = 50;
// How many candidate PAPERS stage 1 hands to the full-text stage. 24 is where
// the measured curve flattens: over the real 326k index a body question
// surfaces its own paper 30% of the time in the top 12, 36.7% in the top 24 and
// only 38.3% in the top 48 — so doubling past 24 doubles the cold-cache warming
// cost for under two points (docs/ARXIV-RAG.md §9.8).
const DEEP_PAPERS = Number(process.env.ARXIV_DEEP_PAPERS) || 24;

/**
 * Load the packed index. Vectors are read as one Buffer and viewed as an
 * Int8Array — no copy, no parse — which is the whole reason the build writes
 * a binary pack rather than base64 JSON.
 * @param {string} dir
 */
export async function loadIndex(dir) {
  const meta = JSON.parse(await readFile(join(dir, "passages.json"), "utf8"));
  if (!meta.docIds) {
    throw new Error(`Index at ${dir} is incomplete (${meta.done}/${meta.total} passages embedded) — finish the build first.`);
  }
  const buf = await readFile(join(dir, "vectors.i8"));
  const packed = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const rows = Math.floor(packed.length / meta.dims);
  if (rows !== meta.docIds.length) {
    throw new Error(`Index is inconsistent: ${rows} vector rows vs ${meta.docIds.length} passage ids.`);
  }
  return { meta, packed, dims: meta.dims, docIds: meta.docIds, norms: packedNorms(packed, meta.dims), dir };
}

/**
 * Read the metadata for specific papers without loading papers.jsonl (half a
 * gigabyte at full scale): the uint32 offset index turns each hit into one
 * positioned read.
 * @param {string} dir
 * @param {string[]} ids
 * @returns {Promise<Map<string, any>>}
 */
export async function readPapers(dir, ids) {
  const offsets = new Uint32Array((await readFile(join(dir, "papers.idx"))).buffer);
  const fh = await open(join(dir, "papers.jsonl"), "r");
  /** @type {Map<string, any>} */
  const out = new Map();
  try {
    // papers.jsonl is written in the corpus's (sorted-by-id) order, so the
    // line for an id is findable by binary search over one probe read each.
    const total = offsets.length - 1;
    const readLine = async (/** @type {number} */ i) => {
      const start = offsets[i];
      const len = offsets[i + 1] - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return JSON.parse(buf.toString("utf8"));
    };
    for (const id of ids) {
      let lo = 0;
      let hi = total - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rec = await readLine(mid);
        if (rec.id === id) {
          out.set(id, rec);
          break;
        }
        if (rec.id < id) lo = mid + 1;
        else hi = mid - 1;
      }
    }
  } finally {
    await fh.close();
  }
  return out;
}

/**
 * @param {string} query
 * @param {Awaited<ReturnType<typeof loadIndex>>} index
 * @param {{ pipeline?: string, topK?: number, bm25?: any, embedProvider?: string, deep?: boolean, onWarm?: (r: any) => void }} [opts]
 */
export async function search(query, index, opts = {}) {
  const pipeline = opts.pipeline || "dense_rerank";
  const topK = opts.topK || 10;
  const timings = {};
  let t = Date.now();
  const { vectors } = await embedBatch([QUERY_PREFIX + query], { model: index.meta.model, provider: opts.embedProvider });
  timings.embed = Date.now() - t;

  t = Date.now();
  const depth = pipeline.includes("rerank") ? RERANK_DEPTH : topK;
  let hits = denseSearchPacked(vectors[0], index, depth);
  timings.dense = Date.now() - t;

  if (pipeline.startsWith("hybrid")) {
    if (!opts.bm25) throw new Error("The hybrid pipelines need an index built with --bm25.");
    t = Date.now();
    hits = rrfFuse([hits, bm25Search(opts.bm25, query, depth)], { topK: depth });
    timings.lexical = Date.now() - t;
  }

  if (pipeline.endsWith("rerank")) {
    t = Date.now();
    const papers = await readPapers(index.dir, hits.map((h) => h.id));
    const docs = hits.map((h) => {
      const p = papers.get(h.id);
      return p ? `${p.title}\n${p.abstract}`.slice(0, RERANK_DOC_CHARS) : h.id;
    });
    try {
      const ranked = await rerank(query, docs, { topN: topK });
      hits = ranked.map((r) => ({ id: hits[r.index].id, score: r.score }));
    } catch (err) {
      // Fail soft: a reranker outage degrades to the candidate order rather
      // than failing the search, the same contract the site's helper phases have.
      process.stderr.write(`rerank unavailable (${err.message}) — returning the candidate order\n`);
      hits = hits.slice(0, topK);
    }
    timings.rerank = Date.now() - t;
  }

  hits = hits.slice(0, opts.deep ? Math.max(topK, DEEP_PAPERS) : topK);
  const papers = await readPapers(index.dir, hits.map((h) => h.id));

  if (opts.deep) {
    t = Date.now();
    const ids = hits.map((h) => h.id);
    const warmed = await warmPapers(ids, { provider: opts.embedProvider, onEach: opts.onWarm });
    timings.warm = Date.now() - t;

    t = Date.now();
    const blobs = await loadFullText(ids);
    /** @type {Array<{ id: string, seq: number, heading: string, text: string, score: number }>} */
    const passages = [];
    for (const b of blobs) {
      for (let i = 0; i < b.vectors.length; i++) {
        passages.push({
          id: b.id,
          seq: b.chunks[i].seq,
          heading: b.chunks[i].heading,
          text: b.chunks[i].text,
          score: cosineF32Int8(vectors[0], b.vectors[i]),
        });
      }
    }
    passages.sort((a, b) => b.score - a.score);
    let top = passages.slice(0, RERANK_DEPTH);
    if (top.length) {
      try {
        const ranked = await rerank(query, top.map((p) => `${p.heading}\n${p.text}`.slice(0, RERANK_DOC_CHARS)), { topN: topK });
        top = ranked.map((r) => ({ ...top[r.index], score: r.score }));
      } catch (err) {
        // Same fail-soft contract as the abstract tier: a reranker outage
        // degrades to cosine order rather than failing the search.
        process.stderr.write(`rerank unavailable (${err.message}) — full-text results in cosine order\n`);
      }
    }
    timings.fulltext = Date.now() - t;
    return {
      hits: hits.slice(0, topK).map((h) => ({ ...h, paper: papers.get(h.id) || null })),
      passages: top.slice(0, topK).map((p) => ({ ...p, paper: papers.get(p.id) || null })),
      warmed: warmed.filter((w) => w.ok && !w.cached).length,
      skipped: warmed.filter((w) => !w.ok).length,
      timings,
    };
  }

  return {
    hits: hits.map((h) => ({ ...h, paper: papers.get(h.id) || null })),
    timings,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f, /** @type {any} */ d) => {
    const i = argv.indexOf(f);
    return i < 0 ? d : argv[i + 1];
  };
  const has = (/** @type {string} */ f) => argv.includes(f);
  const flags = new Set(["--index", "--pipeline", "--top", "--embed-provider"]);
  const query = argv.filter((a, i) => !a.startsWith("--") && !flags.has(argv[i - 1])).join(" ").trim();
  if (!query) {
    console.log('usage: node scripts/arxiv-search.mjs [--index data/arxiv/index] [--pipeline dense_rerank|dense|hybrid|hybrid_rerank] [--top 10] [--deep] [--json] "your question"');
    process.exit(1);
  }
  const dir = join(ROOT, get("--index", "data/arxiv/index"));
  const pipeline = get("--pipeline", "dense_rerank");
  const topK = Number(get("--top", 10));

  const t0 = Date.now();
  const index = await loadIndex(dir);
  const loadMs = Date.now() - t0;
  let bm25 = null;
  if (pipeline.startsWith("hybrid")) bm25 = JSON.parse(await readFile(join(dir, "bm25.json"), "utf8"));

  const deep = has("--deep");
  const { hits, passages, timings, warmed, skipped } = await search(query, index, {
    pipeline,
    topK,
    bm25,
    deep,
    embedProvider: get("--embed-provider", ""),
    onWarm: (r) => deep && !r.cached && process.stderr.write(`  warming ${r.id}: ${r.ok ? `${r.chunks} chunks` : r.reason}\n`),
  });
  if (has("--json")) {
    console.log(JSON.stringify({ query, pipeline, deep, timings, warmed, skipped, hits, passages }, null, 1));
    return;
  }
  console.log(
    `\n"${query}"\n${index.docIds.length} passages over ${index.meta.papers} papers · ${pipeline} · ` +
      `load ${loadMs}ms · ${Object.entries(timings).map(([k, v]) => `${k} ${v}ms`).join(" · ")}\n`,
  );
  hits.forEach((h, i) => {
    const p = h.paper;
    console.log(
      `${String(i + 1).padStart(2)}. [${h.score.toFixed(3)}] arXiv:${h.id}  ${(p?.categories || []).slice(0, 3).join(" ")}\n` +
        `    ${p?.title || "(metadata missing)"}\n` +
        `    ${(p?.abstract || "").slice(0, 190).replace(/\s+/g, " ")}…\n`,
    );
  });
  if (passages) {
    console.log(`— full text: ${warmed} papers warmed, ${skipped} without LaTeX source —\n`);
    passages.forEach((p, i) => {
      console.log(
        `${String(i + 1).padStart(2)}. [${p.score.toFixed(3)}] arXiv:${p.id} §${p.heading || "(untitled)"} #${p.seq}\n` +
          `    ${p.paper?.title || ""}\n` +
          `    ${p.text.slice(0, 320).replace(/\s+/g, " ")}…\n`,
      );
    });
  }
}

if (process.argv[1]?.endsWith("arxiv-search.mjs")) {
  main().catch((err) => {
    console.error("arxiv-search failed:", err.message);
    process.exit(1);
  });
}
