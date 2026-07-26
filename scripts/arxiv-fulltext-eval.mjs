#!/usr/bin/env node
// Does the two-stage shape actually work? The open question from
// docs/ARXIV-RAG.md §9.3, measured against the SHIPPED code paths.
//
//   node scripts/arxiv-fulltext-eval.mjs --papers 120 --questions 60
//
// The claim under test: for a question whose answer lives in a paper's BODY,
// searching the abstract index for candidate PAPERS and then only their body
// chunks (two-stage) is at least as good as searching every body chunk of every
// paper at once (flat) — and it is what makes the tier affordable, since flat
// over the whole corpus is 13.3M vectors and past Vectorize's per-index limit.
//
// Questions are generated from randomly chosen body chunks, skipping
// introduction/related-work/conclusion sections: those restate the abstract, so
// a question drawn from them is not a body question and would flatter stage 1.
//
// The honest ceiling of two-stage is the abstract stage's paper recall@K — a
// body question whose paper never makes the candidate list can never be
// answered — so that number is reported alongside.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PASSAGE_PREFIX, QUERY_PREFIX, b64ToInt8, cosineF32Int8, hitAtK, quantizeInt8, reciprocalRank } from "../public/js/arxiv-rag-core.js";
import { chatJson } from "./arxiv-berget.mjs";
import { EMBED_MODEL, embedAll } from "./embed-providers.mjs";
import { FULLTEXT_DIR, warmPapers } from "./arxiv-fulltext.mjs";
import { loadCorpusFile } from "./arxiv-corpus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Sections whose prose paraphrases the abstract — not body questions. */
const RESTATES_ABSTRACT = /introduction|related work|background|conclusion|abstract|acknowledg/i;

const QUESTION_SYSTEM =
  "Given an excerpt from the body of a scientific paper, write the specific technical question a researcher " +
  "would ask whose answer is IN THIS EXCERPT — a parameter value, a method step, a condition, a measured " +
  'result. It must NOT be answerable from the paper\'s abstract alone. One sentence. Respond JSON: {"q": "..."}';

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f, /** @type {any} */ d) => {
    const i = argv.indexOf(f);
    return i < 0 ? d : argv[i + 1];
  };
  const wantPapers = Number(get("--papers", 120));
  const wantQuestions = Number(get("--questions", 60));
  const topPapers = Number(get("--top-papers", 12));
  const corpusFile = get("--corpus-file", "data/arxiv/eval-sample.jsonl");
  const outPath = get("--out", "data/arxiv/fulltext-eval.json");
  // The ceiling measured against the experiment's own handful of papers is
  // optimistic: the gold paper is one of 120. Pointing at the real index makes
  // stage 1 find it among 326,814, which is the number the design rests on.
  const indexDir = get("--index", "");

  // Warm a slice of the corpus so the experiment runs over real blobs built by
  // the same code path the search CLI uses.
  const corpus = await loadCorpusFile(corpusFile);
  const wanted = corpus.slice(0, wantPapers * 2).map((p) => p.id);
  console.log(`Warming up to ${wantPapers} papers from ${corpusFile} …`);
  let warmed = 0;
  await warmPapers(wanted.slice(0, Math.ceil(wantPapers * 1.35)), {
    onEach: (r) => {
      if (r.ok) warmed++;
      if (warmed % 20 === 0 && r.ok) process.stdout.write(`\r  ${warmed} warmed`);
    },
  });
  process.stdout.write("\n");

  const files = (await readdir(FULLTEXT_DIR)).filter((f) => f.endsWith(".json")).slice(0, wantPapers);
  /** @type {Array<{ id: string, chunks: any[], vectors: Int8Array[] }>} */
  const docs = [];
  for (const f of files) {
    const blob = JSON.parse(await readFile(join(FULLTEXT_DIR, f), "utf8"));
    if (blob?.v === 1 && blob.chunks?.length) docs.push({ id: blob.id, chunks: blob.chunks, vectors: blob.vectors.map(b64ToInt8) });
  }
  const byId = new Map(corpus.map((p) => [p.id, p]));
  const flat = [];
  docs.forEach((d, di) => d.chunks.forEach((c, ci) => flat.push({ di, ci, id: d.id, heading: c.heading, text: c.text })));
  console.log(`${docs.length} papers · ${flat.length} body chunks (${(flat.length / docs.length).toFixed(1)}/paper)`);

  // Abstract vectors for the same papers — the stage-1 index, scoped to this
  // experiment so the two arms see exactly the same paper set.
  const absTexts = docs.map((d) => {
    const p = byId.get(d.id);
    return PASSAGE_PREFIX + `${p?.title || ""}\n\n${p?.abstract || ""}`.slice(0, 1200);
  });
  const absVecs = (await embedAll(absTexts, { model: EMBED_MODEL })).vectors.map(quantizeInt8);

  // Body questions, from chunks that are not abstract restatements.
  const candidates = [];
  for (let i = 0; i < wantQuestions * 3 && candidates.length < wantQuestions; i++) {
    const at = Math.floor(((i + 0.5) / (wantQuestions * 3)) * flat.length);
    const f = flat[at];
    if (!f || RESTATES_ABSTRACT.test(f.heading || "")) continue;
    if (f.text.length < 400) continue;
    candidates.push({ at, f });
  }
  console.log(`Generating ${candidates.length} body-level questions …`);
  /** @type {Array<{ q: string, at: number, di: number }>} */
  const qs = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (;;) {
        const k = cursor++;
        if (k >= candidates.length) return;
        const { at, f } = candidates[k];
        const j = await chatJson(
          [
            { role: "system", content: QUESTION_SYSTEM },
            { role: "user", content: `Paper: ${byId.get(f.id)?.title || ""}\nSection: ${f.heading}\nExcerpt: ${f.text.slice(0, 1400)}` },
          ],
          { temperature: 0.3, maxTokens: 200 },
        ).catch(() => null);
        if (j?.q) qs.push({ q: String(j.q).trim(), at, di: f.di });
      }
    }),
  );
  console.log(`  ${qs.length} questions`);
  const qVecs = (await embedAll(qs.map((q) => QUERY_PREFIX + q.q), { model: EMBED_MODEL })).vectors;

  // Sweep the candidate count: two-stage can only answer a question whose
  // paper stage 1 surfaced, so the whole comparison hinges on K.
  const KS = [6, 12, 24, 48, 96].filter((k) => k <= docs.length);
  const rows = { flat: [], two: Object.fromEntries(KS.map((k) => [k, []])), ceiling: Object.fromEntries(KS.map((k) => [k, []])) };
  qs.forEach((q, i) => {
    const qv = qVecs[i];
    const chunkHits = flat.map((f, j) => ({ id: String(j), s: cosineF32Int8(qv, docs[f.di].vectors[f.ci]) }));

    // (a) FLAT — every body chunk of every paper competes.
    const all = [...chunkHits].sort((a, b) => b.s - a.s);
    rows.flat.push({ h1: hitAtK(all, String(q.at), 1), h5: hitAtK(all, String(q.at), 5), h10: hitAtK(all, String(q.at), 10), rr: reciprocalRank(all, String(q.at)) });

    const papers = absVecs.map((a, j) => ({ id: String(j), s: cosineF32Int8(qv, a) })).sort((a, b) => b.s - a.s);
    for (const k of KS) {
      rows.ceiling[k].push({ hK: hitAtK(papers, String(q.di), k) });
      const keep = new Set(papers.slice(0, k).map((x) => Number(x.id)));
      const scoped = chunkHits.filter((_, j) => keep.has(flat[j].di)).sort((a, b) => b.s - a.s);
      rows.two[k].push({ h1: hitAtK(scoped, String(q.at), 1), h5: hitAtK(scoped, String(q.at), 5), h10: hitAtK(scoped, String(q.at), 10), rr: reciprocalRank(scoped, String(q.at)) });
    }
  });

  // Stage-1 ceiling against the REAL abstract index, if one was given.
  /** @type {Record<number, number> | null} */
  let realCeiling = null;
  if (indexDir) {
    const { loadIndex } = await import("./arxiv-search.mjs");
    const { denseSearchPacked } = await import("../public/js/arxiv-rag-core.js");
    const index = await loadIndex(join(ROOT, indexDir));
    console.log(`\nStage-1 ceiling against the real index (${index.meta.papers} papers) …`);
    realCeiling = Object.fromEntries(KS.map((k) => [k, 0]));
    qs.forEach((q, i) => {
      const goldId = docs[q.di].id;
      const hits = denseSearchPacked(qVecs[i], index, Math.max(...KS));
      for (const k of KS) if (hits.slice(0, k).some((h) => h.id === goldId)) realCeiling[k]++;
    });
    for (const k of KS) realCeiling[k] = Math.round((realCeiling[k] / qs.length) * 1000) / 10;
  }

  const pct = (arr, f) => Math.round((arr.reduce((a, r) => a + f(r), 0) / (arr.length || 1)) * 1000) / 10;
  const summary = {
    papers: docs.length,
    chunks: flat.length,
    questions: qs.length,
    flat: { "r@1": pct(rows.flat, (r) => r.h1), "r@5": pct(rows.flat, (r) => r.h5), "r@10": pct(rows.flat, (r) => r.h10), mrr: pct(rows.flat, (r) => r.rr) },
    twoStage: Object.fromEntries(
      KS.map((k) => [
        k,
        {
          ceiling: pct(rows.ceiling[k], (r) => r.hK),
          "r@1": pct(rows.two[k], (r) => r.h1),
          "r@5": pct(rows.two[k], (r) => r.h5),
          "r@10": pct(rows.two[k], (r) => r.h10),
          mrr: pct(rows.two[k], (r) => r.rr),
        },
      ]),
    ),
  };
  console.log(`\n=== ${summary.questions} body-level questions · ${summary.papers} papers · ${summary.chunks} chunks ===`);
  console.log(`FLAT (all chunks)          chunk r@1 ${summary.flat["r@1"]}  r@5 ${summary.flat["r@5"]}  r@10 ${summary.flat["r@10"]}  MRR ${summary.flat.mrr}`);
  for (const k of KS) {
    const t = summary.twoStage[k];
    console.log(`TWO-STAGE top-${String(k).padStart(3)} papers  chunk r@1 ${String(t["r@1"]).padStart(4)}  r@5 ${String(t["r@5"]).padStart(4)}  r@10 ${String(t["r@10"]).padStart(4)}  MRR ${String(t.mrr).padStart(4)}   (stage-1 ceiling ${t.ceiling}%)`);
  }
  await writeFile(join(ROOT, outPath), JSON.stringify({ built: new Date().toISOString(), ...summary }, null, 1) + "\n");
  if (realCeiling) {
    console.log(`\nstage-1 ceiling over the FULL ${indexDir} index — how often a body question surfaces its own paper:`);
    for (const k of KS) console.log(`  top-${String(k).padStart(3)} papers: ${realCeiling[k]}%`);
    summary.realCeiling = realCeiling;
    await writeFile(join(ROOT, outPath), JSON.stringify({ built: new Date().toISOString(), ...summary }, null, 1) + "\n");
  }
  console.log(`\nWrote ${outPath}`);
}

if (process.argv[1]?.endsWith("arxiv-fulltext-eval.mjs")) {
  main().catch((err) => {
    console.error("arxiv-fulltext-eval failed:", err.stack || err.message);
    process.exit(1);
  });
}
