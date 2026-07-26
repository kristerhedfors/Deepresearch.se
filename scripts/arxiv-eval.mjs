#!/usr/bin/env node
// The arXiv RAG pipeline bake-off: build several retrieval pipelines over the
// SAME sample corpus and the SAME queries, and report what each one actually
// retrieves. Nothing in docs/ARXIV-RAG.md's findings table is asserted from
// intuition — it is this script's output.
//
//   node scripts/arxiv-eval.mjs --sample 3000 --variants all
//   node scripts/arxiv-eval.mjs --sample 3000 --variants dense_ta,hybrid,hybrid_rerank --judge
//
// Design notes that matter for reading the numbers:
//
//   * Document embeddings are cached per (strategy, model, window) under
//     data/arxiv/cache/, so comparing eight variants costs one embed pass per
//     distinct passage family, not eight.
//   * Every variant scores the same two query families (needle, topical) in
//     both English and Swedish. A pipeline that wins on English and collapses
//     on Swedish has not won.
//   * The needle metric is recall@k over exactly one gold paper. With ~120
//     queries the standard error on recall@10 is roughly ±4 points, so
//     differences smaller than that are noise and are reported as such.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PASSAGE_PREFIX,
  QUERY_PREFIX,
  bm25Search,
  buildBm25,
  cosineF32Int8,
  denseSearch,
  denseSearchPacked,
  hitAtK,
  int8ToB64,
  b64ToInt8,
  ndcgAtK,
  paperPassages,
  quantizeInt8,
  reciprocalRank,
  rrfFuse,
} from "../public/js/arxiv-rag-core.js";
import { EMBED_MODEL, EMBED_MODEL_INSTRUCT, RERANK_DOC_CHARS, chatJson, embedAll, rerank } from "./arxiv-berget.mjs";
import { loadCorpus } from "./arxiv-corpus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, "data/arxiv/cache");

// ---- passage families (one embed pass each) --------------------------------

/**
 * A "family" is a way of turning papers into embedded passages. Variants that
 * share a family share its cached vectors.
 * @type {Record<string, { strategy: string, model: string, window: number, stride: number, note: string }>}
 */
const FAMILIES = {
  ta: { strategy: "title_abstract", model: EMBED_MODEL, window: 0, stride: 0, note: "title + abstract, one vector per paper" },
  abs: { strategy: "abstract", model: EMBED_MODEL, window: 0, stride: 0, note: "abstract only" },
  title: { strategy: "title", model: EMBED_MODEL, window: 0, stride: 0, note: "title only" },
  ctx: { strategy: "contextual", model: EMBED_MODEL, window: 0, stride: 0, note: "title + categories + authors + abstract" },
  ta_instruct: { strategy: "title_abstract", model: EMBED_MODEL_INSTRUCT, window: 0, stride: 0, note: "title + abstract on e5-large-instruct" },
  ta_chunked: { strategy: "title_abstract", model: EMBED_MODEL, window: 700, stride: 500, note: "title + abstract, sliding 700c/500c windows" },
};

// e5-instruct wants a task instruction glued to the QUERY only; documents stay
// bare. Getting this backwards is the classic e5-instruct mistake and shows up
// as a variant that looks mysteriously weak.
const INSTRUCT_TASK = "Instruct: Given a research question, retrieve the arXiv paper abstract that answers it\nQuery: ";

/** @param {string} family @param {string} q */
function queryText(family, q) {
  return family === "ta_instruct" ? INSTRUCT_TASK + q : QUERY_PREFIX + q;
}

// ---- variants ----------------------------------------------------------------

/**
 * Each variant is `{ family, retrieve(ctx, query) -> hits }`. `null` family
 * means the variant is lexical only and needs no document vectors.
 */
const VARIANTS = {
  dense_ta: { family: "ta", kind: "dense", label: "dense · title+abstract · e5" },
  dense_abs: { family: "abs", kind: "dense", label: "dense · abstract only · e5" },
  dense_title: { family: "title", kind: "dense", label: "dense · title only · e5" },
  dense_ctx: { family: "ctx", kind: "dense", label: "dense · contextual · e5" },
  dense_instruct: { family: "ta_instruct", kind: "dense", label: "dense · title+abstract · e5-instruct" },
  dense_chunked: { family: "ta_chunked", kind: "dense", label: "dense · chunked 700/500 · e5 (max-pool)" },
  dense_ta_f32: { family: "ta", kind: "dense_f32", label: "dense · title+abstract · e5 · float32 (no int8)" },
  bm25: { family: null, kind: "bm25", label: "BM25 lexical · title+abstract" },
  hybrid: { family: "ta", kind: "hybrid", label: "hybrid RRF(dense_ta, bm25)" },
  hybrid_rerank: { family: "ta", kind: "hybrid_rerank", label: "hybrid RRF → bge-reranker-v2-m3 top-50" },
  dense_rerank: { family: "ta", kind: "dense_rerank", label: "dense_ta → bge-reranker-v2-m3 top-50" },
  hyde: { family: "ta", kind: "hyde", label: "dense_ta + HyDE (LLM writes a fake abstract first)" },
};

const DEFAULT_VARIANTS = ["dense_ta", "dense_abs", "dense_title", "dense_ctx", "dense_instruct", "dense_chunked", "dense_ta_f32", "bm25", "hybrid", "hybrid_rerank", "dense_rerank"];

// ---- document embedding, cached ------------------------------------------------

/**
 * @param {string} familyKey
 * @param {import('../public/js/arxiv-rag-core.js').ArxivPaper[]} papers
 * @param {string} cacheKey
 * @returns {Promise<{ vectors: Int8Array[], f32: Float32Array[] | null, docIds: string[], tokens: number }>}
 */
async function embedFamily(familyKey, papers, cacheKey, wantF32) {
  const fam = FAMILIES[familyKey];
  const file = join(CACHE, `${cacheKey}.${familyKey}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (cached.n === papers.length) {
      process.stdout.write(`  [${familyKey}] cached ${cached.vectors.length} vectors\n`);
      return {
        vectors: cached.vectors.map(b64ToInt8),
        f32: null,
        docIds: cached.docIds,
        tokens: 0,
      };
    }
  } catch {
    /* build it */
  }
  /** @type {string[]} */
  const texts = [];
  /** @type {string[]} */
  const docIds = [];
  for (const p of papers) {
    for (const piece of paperPassages(p, { strategy: fam.strategy, window: fam.window, stride: fam.stride })) {
      texts.push(PASSAGE_PREFIX + piece);
      docIds.push(p.id);
    }
  }
  const t0 = Date.now();
  const { vectors, tokens } = await embedAll(texts, {
    model: fam.model,
    onProgress: (done, total, tok) => {
      const s = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  [${familyKey}] ${done}/${total} passages · ${Math.round(tok / s)} tok/s`);
    },
  });
  process.stdout.write("\n");
  const int8 = vectors.map(quantizeInt8);
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify({ n: papers.length, docIds, vectors: int8.map(int8ToB64) }));
  return { vectors: int8, f32: wantF32 ? vectors : null, docIds, tokens };
}

// ---- retrieval per variant -------------------------------------------------------

/**
 * Cosine top-k against float32 document vectors — the control that says how
 * much ranking quality int8 quantization actually costs.
 * @param {Float32Array} q @param {Float32Array[]} docs @param {string[]} docIds @param {number} topK
 */
function denseSearchF32(q, docs, docIds, topK) {
  /** @type {Map<string, number>} */
  const best = new Map();
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    let dot = 0;
    let nq = 0;
    let nd = 0;
    for (let j = 0; j < d.length; j++) {
      dot += q[j] * d[j];
      nq += q[j] * q[j];
      nd += d[j] * d[j];
    }
    const s = nq && nd ? dot / (Math.sqrt(nq) * Math.sqrt(nd)) : 0;
    const id = docIds[i];
    const prev = best.get(id);
    if (prev === undefined || s > prev) best.set(id, s);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([id, score]) => ({ id, score }));
}

const RERANK_DEPTH = 50;
const TOP_K = 20;

/**
 * `ctx.dense(k)` is a closure over whichever vector store this run uses — the
 * in-memory per-family shard (sample mode) or the packed binary index
 * (--index mode). Everything below it is identical in both, so the two modes
 * cannot drift into measuring different pipelines.
 * @param {string} kind
 * @param {{ dense: (k: number) => Array<{ id: string, score: number }>, f32: any, bm25: any, byId: Map<string, any>, qvec: Float32Array, query: string }} ctx
 */
async function retrieve(kind, ctx) {
  if (kind === "dense") return ctx.dense(TOP_K);
  if (kind === "dense_f32") return denseSearchF32(ctx.qvec, ctx.f32.vectors, ctx.f32.docIds, TOP_K);
  if (kind === "bm25") return bm25Search(ctx.bm25, ctx.query, TOP_K);
  if (kind === "hybrid") {
    return rrfFuse([ctx.dense(RERANK_DEPTH), bm25Search(ctx.bm25, ctx.query, RERANK_DEPTH)], { topK: TOP_K });
  }
  if (kind === "hybrid_rerank" || kind === "dense_rerank") {
    const candidates =
      kind === "dense_rerank"
        ? ctx.dense(RERANK_DEPTH)
        : rrfFuse([ctx.dense(RERANK_DEPTH), bm25Search(ctx.bm25, ctx.query, RERANK_DEPTH)], { topK: RERANK_DEPTH });
    const docs = candidates.map((c) => {
      const p = ctx.byId.get(c.id);
      return `${p.title}\n${p.abstract}`.slice(0, RERANK_DOC_CHARS);
    });
    if (!docs.length) return [];
    try {
      const ranked = await rerank(ctx.query, docs, { topN: TOP_K });
      return ranked.map((r) => ({ id: candidates[r.index].id, score: r.score }));
    } catch (err) {
      // Fail soft, like every helper phase in this project: a reranker outage
      // degrades the variant to its candidate order rather than voiding the run.
      process.stderr.write(`\n  rerank failed (${err.message}) — falling back to candidate order\n`);
      return candidates.slice(0, TOP_K);
    }
  }
  throw new Error(`Unknown variant kind: ${kind}`);
}

// ---- HyDE ----------------------------------------------------------------------

/**
 * Hypothetical Document Embeddings: have the LLM write the abstract a paper
 * answering this question WOULD have, and search with that instead of the
 * question. Costs one small chat call per query, which is why it is measured
 * separately rather than assumed worthwhile.
 * @param {string} query
 */
async function hydeText(query) {
  const json = await chatJson(
    [
      { role: "system", content: 'Write the abstract of a plausible arXiv paper that would answer the user\'s research question. 90-140 words, in the register of a real abstract, no title, no preamble. Respond as JSON: {"abstract": "..."}' },
      { role: "user", content: query },
    ],
    { temperature: 0.3, maxTokens: 400 },
  );
  const a = typeof json?.abstract === "string" ? json.abstract.trim() : "";
  return a ? `${query}\n\n${a}` : query;
}

// ---- scoring --------------------------------------------------------------------

/** @param {any[]} rows */
function summarize(rows) {
  const n = rows.length || 1;
  const mean = (/** @type {(r: any) => number} */ f) => Math.round((rows.reduce((a, r) => a + f(r), 0) / n) * 1000) / 10;
  return {
    n: rows.length,
    "r@1": mean((r) => r.h1),
    "r@5": mean((r) => r.h5),
    "r@10": mean((r) => r.h10),
    "r@20": mean((r) => r.h20),
    mrr: mean((r) => r.rr),
  };
}

/** @param {number} p @param {number} n binomial standard error, in points */
const stderrPoints = (p, n) => Math.round(Math.sqrt(((p / 100) * (1 - p / 100)) / (n || 1)) * 1000) / 10;

// ---- --index mode: the retrieval stack at production scale ---------------------

/**
 * Experiment B. The sample-corpus mode above compares PASSAGE families, which
 * only needs relative ordering and so can run small. The retrieval STACK
 * (dense vs lexical vs fusion vs rerank) has to be judged at the size it will
 * actually serve: at 3k papers a needle query is nearly free and every
 * pipeline scores ~98%, which says nothing. This mode reuses the already-built
 * binary index, so it costs query embeddings and nothing else.
 * @param {string} indexDir
 * @param {any} opts
 */
async function runIndexEval(indexDir, opts) {
  const { needle, topical, langs, names, judge, outPath } = opts;
  const { loadIndex } = await import("./arxiv-search.mjs");
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");

  console.log(`Loading the packed index at ${indexDir} …`);
  const t0 = Date.now();
  const index = await loadIndex(indexDir);
  console.log(`  ${index.docIds.length} passages × ${index.dims}d over ${index.meta.papers} papers in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Only what reranking and grading need: an abstract slice, not the corpus.
  /** @type {Map<string, any>} */
  const byId = new Map();
  const rl = createInterface({ input: createReadStream(join(indexDir, "papers.jsonl")), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const p = JSON.parse(line);
      byId.set(p.id, { id: p.id, title: p.title, abstract: p.abstract.slice(0, RERANK_DOC_CHARS), categories: p.categories });
    } catch {
      /* torn line */
    }
  }
  console.log(`  ${byId.size} paper records in memory (${Math.round(process.memoryUsage().heapUsed / 1e6)} MB heap)`);

  let bm25 = null;
  if (names.some((/** @type {string} */ n) => VARIANTS[n].kind.includes("bm25") || VARIANTS[n].kind.startsWith("hybrid"))) {
    const t = Date.now();
    bm25 = JSON.parse(await readFile(join(indexDir, "bm25.json"), "utf8"));
    console.log(`  BM25 index loaded in ${((Date.now() - t) / 1000).toFixed(1)}s (${bm25.n} docs)`);
  }

  const present = needle.filter((/** @type {any} */ q) => byId.has(q.gold));
  console.log(`\n${present.length}/${needle.length} gold papers are in this index · variants: ${names.join(", ")}\n`);

  /** @type {Record<string, Float32Array[]>} */
  const qvecs = {};
  for (const lang of langs) {
    const texts = [...present.map((/** @type {any} */ q) => q[lang]), ...topical.map((/** @type {any} */ q) => q[lang])];
    qvecs[lang] = (await embedAll(texts.map((t) => QUERY_PREFIX + t), { model: index.meta.model })).vectors;
    if (names.includes("hyde")) {
      /** @type {string[]} */
      const expanded = new Array(texts.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (;;) {
            const at = cursor++;
            if (at >= texts.length) return;
            expanded[at] = await hydeText(texts[at]).catch(() => texts[at]);
          }
        }),
      );
      qvecs[lang + ".hyde"] = (await embedAll(expanded.map((t) => QUERY_PREFIX + t.slice(0, 1200)), { model: index.meta.model })).vectors;
    }
  }

  /** @type {Record<string, any>} */
  const results = {};
  /** @type {Map<string, Set<string>>} */
  const topicalPool = new Map();
  for (const name of names) {
    const v = VARIANTS[name];
    results[name] = { label: v.label, langs: {}, latencyMs: {}, topical: {} };
    for (const lang of langs) {
      const qv = v.kind === "hyde" ? qvecs[lang + ".hyde"] : qvecs[lang];
      /** @type {any[]} */
      const rows = [];
      const started = Date.now();
      for (let i = 0; i < present.length; i++) {
        const q = present[i];
        const hits = await retrieve(v.kind === "hyde" ? "dense" : v.kind, {
          dense: (k) => denseSearchPacked(qv[i], index, k),
          f32: null,
          bm25,
          byId,
          qvec: qv[i],
          query: q[lang],
        });
        rows.push({
          h1: hitAtK(hits, q.gold, 1),
          h5: hitAtK(hits, q.gold, 5),
          h10: hitAtK(hits, q.gold, 10),
          h20: hitAtK(hits, q.gold, 20),
          rr: reciprocalRank(hits, q.gold),
        });
      }
      const summary = summarize(rows);
      results[name].langs[lang] = { ...summary, "se@10": stderrPoints(summary["r@10"], rows.length) };
      results[name].latencyMs[lang] = Math.round((Date.now() - started) / (present.length || 1));
      for (let i = 0; i < topical.length; i++) {
        const q = topical[i];
        const hits = await retrieve(v.kind === "hyde" ? "dense" : v.kind, {
          dense: (k) => denseSearchPacked(qv[present.length + i], index, k),
          f32: null,
          bm25,
          byId,
          qvec: qv[present.length + i],
          query: q[lang],
        });
        const key = `${q.id}.${lang}`;
        results[name].topical[key] = hits.slice(0, 10).map((h) => h.id);
        if (!topicalPool.has(key)) topicalPool.set(key, new Set());
        for (const h of hits.slice(0, 10)) topicalPool.get(key).add(h.id);
      }
    }
    const en = results[name].langs.en;
    const sv = results[name].langs.sv;
    console.log(
      `${name.padEnd(16)} ${v.label}\n` +
        `  EN r@1 ${String(en["r@1"]).padStart(5)}  r@10 ${String(en["r@10"]).padStart(5)} ±${en["se@10"]}  MRR ${en.mrr}` +
        (sv ? `   |   SV r@1 ${String(sv["r@1"]).padStart(5)}  r@10 ${String(sv["r@10"]).padStart(5)} ±${sv["se@10"]}  MRR ${sv.mrr}` : "") +
        `   [${results[name].latencyMs.en} ms/query]`,
    );
  }

  if (judge) await gradeTopical(topicalPool, topical, byId, names, langs, results);

  await writeFile(
    join(ROOT, outPath),
    JSON.stringify(
      { built: new Date().toISOString(), mode: "index", indexDir, corpus: index.meta.papers, passages: index.docIds.length, needleQueries: present.length, topicalQueries: topical.length, results },
      null,
      1,
    ) + "\n",
  );
  console.log(`\nWrote ${outPath}`);
}

/**
 * Grade the pooled topical candidates once per query, then score every
 * variant's ranking against those grades. Pooling matters: grading each
 * variant's list separately would give the same paper different labels
 * depending on who retrieved it.
 */
async function gradeTopical(topicalPool, topical, byId, names, langs, results) {
  console.log(`\nGrading ${topicalPool.size} topical query pools …`);
  /** @type {Record<string, Record<string, number>>} */
  const gains = {};
  const keys = [...topicalPool.keys()];
  let cursor = 0;
  let graded = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (;;) {
        const at = cursor++;
        if (at >= keys.length) return;
        const key = keys[at];
        const [qid, lang] = key.split(".");
        const q = topical.find((/** @type {any} */ t) => t.id === qid);
        const ids = [...topicalPool.get(key)];
        const listing = ids
          .map((id, i) => `${i}. ${byId.get(id)?.title || ""} — ${(byId.get(id)?.abstract || "").slice(0, 400)}`)
          .join("\n");
        const json = await chatJson(
          [
            {
              role: "system",
              content:
                "You grade search results for a scientific literature search engine. For each numbered candidate, " +
                "rate how well it answers the research question: 3 = directly on topic and substantive, 2 = clearly " +
                'related, 1 = same broad field only, 0 = irrelevant. Respond as JSON: {"grades": {"0": 3, "1": 0, ...}} ' +
                "with an entry for every candidate.",
            },
            { role: "user", content: `Research question: ${q[lang]}\n\nCandidates:\n${listing}` },
          ],
          { temperature: 0, maxTokens: 1500 },
        ).catch(() => null);
        /** @type {Record<string, number>} */
        const g = {};
        for (let i = 0; i < ids.length; i++) {
          const raw = Number(json?.grades?.[String(i)]);
          g[ids[i]] = Number.isFinite(raw) ? Math.max(0, Math.min(3, Math.round(raw))) : 0;
        }
        gains[key] = g;
        process.stdout.write(`\r  graded ${++graded}/${keys.length}`);
      }
    }),
  );
  process.stdout.write("\n");
  for (const name of names) {
    for (const lang of langs) {
      const scores = topical.map((/** @type {any} */ q) => {
        const key = `${q.id}.${lang}`;
        return ndcgAtK((results[name].topical[key] || []).map((/** @type {string} */ id) => ({ id })), gains[key] || {}, 10);
      });
      results[name].langs[lang].ndcg10 = Math.round((scores.reduce((a, c) => a + c, 0) / (scores.length || 1)) * 1000) / 1000;
    }
    console.log(
      `${name.padEnd(16)} nDCG@10  EN ${results[name].langs.en.ndcg10}` +
        (results[name].langs.sv ? `  SV ${results[name].langs.sv.ndcg10}` : ""),
    );
  }
  results._gains = gains;
}

// ---- main ----------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f, /** @type {any} */ d) => {
    const i = argv.indexOf(f);
    return i < 0 ? d : argv[i + 1];
  };
  const has = (/** @type {string} */ f) => argv.includes(f);
  const sampleSize = Number(get("--sample", 3000));
  const seed = get("--seed", "arxiv-rag-v1");
  const goldPath = get("--goldset", "data/arxiv/goldset.json");
  const outPath = get("--out", "data/arxiv/eval-results.json");
  const langs = String(get("--langs", "en,sv")).split(",");
  const requested = String(get("--variants", "default"));
  const names = requested === "all" ? Object.keys(VARIANTS) : requested === "default" ? DEFAULT_VARIANTS : requested.split(",");
  for (const nm of names) if (!VARIANTS[nm]) throw new Error(`Unknown variant: ${nm}. Known: ${Object.keys(VARIANTS).join(", ")}`);

  const corpusFile = get("--corpus-file", "");
  const indexDir = get("--index", "");
  const goldRaw = JSON.parse(await readFile(join(ROOT, goldPath), "utf8"));
  const topicalRaw = JSON.parse(await readFile(join(ROOT, "scripts/arxiv-topical-queries.json"), "utf8")).queries;
  if (indexDir) {
    return runIndexEval(join(ROOT, indexDir), {
      needle: goldRaw.needle,
      topical: topicalRaw,
      langs,
      names,
      judge: has("--judge"),
      outPath,
    });
  }

  const papers = await loadCorpus(corpusFile ? { file: corpusFile } : { sample: sampleSize, seed });
  const byId = new Map(papers.map((p) => [p.id, p]));
  const gold = goldRaw;
  const needle = gold.needle.filter((/** @type {any} */ q) => byId.has(q.gold));
  const topical = topicalRaw;
  console.log(`Corpus ${papers.length} papers · ${needle.length} needle queries · ${topical.length} topical queries · variants: ${names.join(", ")}\n`);

  // BM25 over the same text the dense baseline embeds, so the comparison is
  // about the retrieval method and not about who got more text.
  const t0 = Date.now();
  const bm25 = buildBm25(papers.map((p) => ({ id: p.id, text: `${p.title}\n${p.abstract}` })));
  console.log(`BM25 index: ${Object.keys(bm25.postings).length} terms in ${Date.now() - t0}ms\n`);

  const cacheKey = `${(corpusFile || seed).replace(/[^A-Za-z0-9]+/g, "_")}.${papers.length}`;
  const neededFamilies = [...new Set(names.map((n) => VARIANTS[n].family).filter(Boolean))];
  const wantF32 = names.includes("dense_ta_f32");
  /** @type {Record<string, any>} */
  const shards = {};
  for (const fam of neededFamilies) {
    const r = await embedFamily(fam, papers, cacheKey, wantF32 && fam === "ta");
    shards[fam] = { vectors: r.vectors, docIds: r.docIds, f32: r.f32 };
  }
  // float32 control needs unquantized vectors; if the int8 cache served the
  // family we have to re-embed once to get them.
  if (wantF32 && !shards.ta.f32) {
    console.log("  [ta] float32 control: re-embedding (the cache stores int8 only)");
    const fam = FAMILIES.ta;
    const texts = papers.map((p) => PASSAGE_PREFIX + paperPassages(p, { strategy: fam.strategy })[0]);
    const { vectors } = await embedAll(texts, { model: fam.model, onProgress: (d, t) => process.stdout.write(`\r  [ta-f32] ${d}/${t}`) });
    process.stdout.write("\n");
    shards.ta.f32 = vectors;
    shards.ta.f32DocIds = papers.map((p) => p.id);
  }

  // Query vectors: one embed pass per (family-prefix-convention, language),
  // plus HyDE's rewritten queries when that variant is in play.
  /** @type {Record<string, Float32Array[]>} */
  const qvecs = {};
  const prefixKinds = [...new Set(neededFamilies.map((f) => (f === "ta_instruct" ? "instruct" : "e5")))];
  for (const lang of langs) {
    const texts = [...needle.map((/** @type {any} */ q) => q[lang]), ...topical.map((/** @type {any} */ q) => q[lang])];
    for (const kind of prefixKinds) {
      const prefixed = texts.map((t) => (kind === "instruct" ? INSTRUCT_TASK + t : QUERY_PREFIX + t));
      const { vectors } = await embedAll(prefixed, { model: kind === "instruct" ? EMBED_MODEL_INSTRUCT : EMBED_MODEL });
      qvecs[`${lang}.${kind}`] = vectors;
    }
  }
  if (names.includes("hyde")) {
    for (const lang of langs) {
      const texts = [...needle.map((/** @type {any} */ q) => q[lang]), ...topical.map((/** @type {any} */ q) => q[lang])];
      console.log(`  [hyde] generating ${texts.length} hypothetical abstracts (${lang}) …`);
      /** @type {string[]} */
      const expanded = new Array(texts.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (;;) {
            const at = cursor++;
            if (at >= texts.length) return;
            expanded[at] = await hydeText(texts[at]).catch(() => texts[at]);
          }
        }),
      );
      const { vectors } = await embedAll(expanded.map((t) => QUERY_PREFIX + t.slice(0, 1600)), { model: EMBED_MODEL });
      qvecs[`${lang}.hyde`] = vectors;
    }
  }

  /** @type {Record<string, any>} */
  const results = {};
  /** @type {Map<string, Set<string>>} judged-pool per topical query id */
  const topicalPool = new Map();

  for (const name of names) {
    const v = VARIANTS[name];
    const fam = v.family || "ta";
    const shard = shards[fam] || shards.ta;
    const prefixKind = fam === "ta_instruct" ? "instruct" : "e5";
    results[name] = { label: v.label, langs: {}, latencyMs: {}, topical: {} };
    for (const lang of langs) {
      const qv = v.kind === "hyde" ? qvecs[`${lang}.hyde`] : qvecs[`${lang}.${prefixKind}`];
      /** @type {any[]} */
      const rows = [];
      const started = Date.now();
      for (let i = 0; i < needle.length; i++) {
        const q = needle[i];
        const hits = await retrieve(v.kind === "hyde" ? "dense" : v.kind, {
          dense: (k) => denseSearch(qv[i], shard, k),
          f32: { vectors: shards.ta.f32, docIds: shards.ta.f32DocIds || shard.docIds },
          bm25,
          byId,
          qvec: qv[i],
          query: q[lang],
        });
        rows.push({
          h1: hitAtK(hits, q.gold, 1),
          h5: hitAtK(hits, q.gold, 5),
          h10: hitAtK(hits, q.gold, 10),
          h20: hitAtK(hits, q.gold, 20),
          rr: reciprocalRank(hits, q.gold),
        });
      }
      const summary = summarize(rows);
      results[name].langs[lang] = { ...summary, "se@10": stderrPoints(summary["r@10"], rows.length) };
      results[name].latencyMs[lang] = Math.round((Date.now() - started) / (needle.length || 1));

      // Topical: keep the ranked ids; grading happens after every variant has
      // contributed, so the judge sees one pooled candidate set per query.
      for (let i = 0; i < topical.length; i++) {
        const q = topical[i];
        const hits = await retrieve(v.kind === "hyde" ? "dense" : v.kind, {
          dense: (k) => denseSearch(qv[needle.length + i], shard, k),
          f32: { vectors: shards.ta.f32, docIds: shards.ta.f32DocIds || shard.docIds },
          bm25,
          byId,
          qvec: qv[needle.length + i],
          query: q[lang],
        });
        const key = `${q.id}.${lang}`;
        results[name].topical[key] = hits.slice(0, 10).map((h) => h.id);
        if (!topicalPool.has(key)) topicalPool.set(key, new Set());
        for (const h of hits.slice(0, 10)) topicalPool.get(key).add(h.id);
      }
    }
    const en = results[name].langs.en;
    const sv = results[name].langs.sv;
    console.log(
      `${name.padEnd(16)} ${v.label}\n` +
        `  EN r@1 ${String(en["r@1"]).padStart(5)}  r@10 ${String(en["r@10"]).padStart(5)} ±${en["se@10"]}  MRR ${en.mrr}` +
        (sv ? `   |   SV r@1 ${String(sv["r@1"]).padStart(5)}  r@10 ${String(sv["r@10"]).padStart(5)} ±${sv["se@10"]}  MRR ${sv.mrr}` : "") +
        `   [${results[name].latencyMs.en} ms/query]`,
    );
  }

  // ---- optional LLM grading of the topical pool -----------------------------
  if (has("--judge")) {
    console.log(`\nGrading ${topicalPool.size} topical query pools …`);
    /** @type {Record<string, Record<string, number>>} */
    const gains = {};
    let graded = 0;
    const keys = [...topicalPool.keys()];
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (;;) {
          const at = cursor++;
          if (at >= keys.length) return;
          const key = keys[at];
          const [qid, lang] = key.split(".");
          const q = topical.find((/** @type {any} */ t) => t.id === qid);
          const ids = [...topicalPool.get(key)];
          const listing = ids
            .map((id, i) => `${i}. ${byId.get(id)?.title || ""} — ${(byId.get(id)?.abstract || "").slice(0, 400)}`)
            .join("\n");
          const json = await chatJson(
            [
              {
                role: "system",
                content:
                  "You grade search results for a scientific literature search engine. For each numbered candidate, " +
                  "rate how well it answers the research question: 3 = directly on topic and substantive, 2 = clearly " +
                  'related, 1 = same broad field only, 0 = irrelevant. Respond as JSON: {"grades": {"0": 3, "1": 0, ...}} ' +
                  "with an entry for every candidate.",
              },
              { role: "user", content: `Research question: ${q[lang]}\n\nCandidates:\n${listing}` },
            ],
            { temperature: 0, maxTokens: 1500 },
          ).catch(() => null);
          /** @type {Record<string, number>} */
          const g = {};
          for (let i = 0; i < ids.length; i++) {
            const raw = Number(json?.grades?.[String(i)]);
            g[ids[i]] = Number.isFinite(raw) ? Math.max(0, Math.min(3, Math.round(raw))) : 0;
          }
          gains[key] = g;
          process.stdout.write(`\r  graded ${++graded}/${keys.length}`);
        }
      }),
    );
    process.stdout.write("\n");
    for (const name of names) {
      for (const lang of langs) {
        const scores = topical.map((/** @type {any} */ q) => {
          const key = `${q.id}.${lang}`;
          return ndcgAtK(
            (results[name].topical[key] || []).map((/** @type {string} */ id) => ({ id })),
            gains[key] || {},
            10,
          );
        });
        const mean = scores.reduce((/** @type {number} */ a, /** @type {number} */ c) => a + c, 0) / (scores.length || 1);
        results[name].langs[lang].ndcg10 = Math.round(mean * 1000) / 1000;
      }
      console.log(
        `${name.padEnd(16)} nDCG@10  EN ${results[name].langs.en.ndcg10}` +
          (results[name].langs.sv ? `  SV ${results[name].langs.sv.ndcg10}` : ""),
      );
    }
    results._gains = gains;
  }

  await mkdir(dirname(join(ROOT, outPath)), { recursive: true });
  await writeFile(
    join(ROOT, outPath),
    JSON.stringify(
      {
        built: new Date().toISOString(),
        corpus: papers.length,
        needleQueries: needle.length,
        topicalQueries: topical.length,
        seed,
        avgTitleOverlap: gold.stats?.avgTitleOverlap,
        results,
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`\nWrote ${outPath}`);
}

if (process.argv[1]?.endsWith("arxiv-eval.mjs")) {
  main().catch((err) => {
    console.error("arxiv-eval failed:", err.stack || err.message);
    process.exit(1);
  });
}

export { FAMILIES, VARIANTS, summarize, stderrPoints };
