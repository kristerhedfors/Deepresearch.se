#!/usr/bin/env node
// Builds the evaluation gold set for the arXiv RAG bake-off.
//
//   node scripts/arxiv-goldset.mjs --sample 3000 --queries 120 --out data/arxiv/goldset.json
//
// Two query families, because they answer two different questions:
//
//   needle  "can it find THIS paper" — one known-relevant document per query.
//           Generated: an LLM reads a paper's abstract and writes the research
//           question that paper answers. Cheap, reproducible, and scales to
//           enough queries that a 3-point difference between pipelines means
//           something.
//   topical "is the top of the list any good" — hand-written questions with
//           many relevant papers, graded after the fact (scripts/arxiv-eval.mjs
//           --judge). This is the family that reflects real research use.
//
// The needle family has one failure mode that would invalidate the whole
// bake-off: if the generated question reuses the title's distinctive wording,
// BM25 finds it by string match and the benchmark measures nothing. So every
// generated query is scored for lexical overlap against the paper's own text
// and regenerated once when it overlaps too much; the surviving overlap is
// recorded per query so the results table can show how leaky the set is.
//
// Both languages are generated for every query (CLAUDE.md invariant 6): a
// multilingual embedder is only useful if it is measured multilingually.

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize } from "../public/js/arxiv-rag-core.js";
import { chatJson } from "./arxiv-berget.mjs";
import { hash01, loadCorpus } from "./arxiv-corpus.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SYSTEM = `You write realistic search queries for a scientific literature search engine.
Given one arXiv paper, write the research question a researcher would type into the search box
that this paper answers.

Rules:
- Ask about the CONTRIBUTION, not the paper. Never write "this paper", "the authors", "the study".
- Paraphrase. Do NOT reuse the distinctive noun phrases of the title; use the field's ordinary
  vocabulary, synonyms, or a description of the problem instead.
- One sentence, 8-25 words, phrased as a question or an information need.
- Write it twice: "en" in English, "sv" in idiomatic Swedish (a natural Swedish research question,
  not a word-for-word translation; keep established English technical terms that Swedish
  researchers actually use).
Respond with JSON: {"en": "...", "sv": "..."}`;

/**
 * Fraction of the query's content words that also appear in the paper's title.
 * The leak guard: 1.0 means the query is a restatement of the title.
 * @param {string} query
 * @param {string} title
 */
export function titleOverlap(query, title) {
  return lexicalOverlap(query, title);
}

/**
 * Fraction of the query's content words that also appear in `text`.
 *
 * Named generically because the title is the WRONG thing to measure alone.
 * docs/ARXIV-RAG.md §4.3: the shipped needle set looked clean at 0.30 mean
 * title overlap, but the model writes from the ABSTRACT and kept 0.68 of its
 * vocabulary — which silently handed BM25 a large head start and made it look
 * like the English winner. Always measure against the body too.
 * @param {string} query
 * @param {string} text
 */
export function lexicalOverlap(query, text) {
  const q = new Set(tokenize(query).filter((t) => t.length > 3));
  const t = new Set(tokenize(text).filter((t) => t.length > 3));
  if (!q.size || !t.size) return 0;
  let shared = 0;
  for (const w of q) if (t.has(w)) shared++;
  return shared / q.size;
}

const MAX_OVERLAP = 0.5;

/**
 * @param {import('../public/js/arxiv-rag-core.js').ArxivPaper} paper
 * @param {boolean} strict a retry after the first attempt leaked the title
 */
async function generateQuery(paper, strict) {
  const extra = strict
    ? "\n\nYour previous attempt copied the title's wording. Rewrite it using COMPLETELY different vocabulary — describe the problem and the method in the field's generic terms."
    : "";
  const user = `Title: ${paper.title}\nCategories: ${(paper.categories || []).join(" ")}\nAbstract: ${paper.abstract.slice(0, 1800)}${extra}`;
  const json = await chatJson([
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ], { temperature: strict ? 0.7 : 0.3, maxTokens: 300 });
  const en = typeof json?.en === "string" ? json.en.trim() : "";
  const sv = typeof json?.sv === "string" ? json.sv.trim() : "";
  if (!en || !sv) return null;
  return { en, sv };
}

async function main() {
  const argv = process.argv.slice(2);
  const get = (/** @type {string} */ f, /** @type {any} */ d) => {
    const i = argv.indexOf(f);
    return i < 0 ? d : argv[i + 1];
  };
  const sampleSize = Number(get("--sample", 3000));
  const wanted = Number(get("--queries", 120));
  const out = get("--out", "data/arxiv/goldset.json");
  const seed = get("--seed", "arxiv-rag-v1");

  const corpusFile = get("--corpus-file", "");
  // --dir picks WHICH harvest to draw needles from. Without it a second corpus
  // (a widened window harvested into its own directory) could only be sampled
  // by first materialising a corpus file, which defeats loadCorpus's sampler.
  const dir = get("--dir", "");
  const corpus = await loadCorpus(corpusFile ? { file: corpusFile } : { sample: sampleSize, seed, ...(dir ? { dir } : {}) });
  console.log(`Corpus sample: ${corpus.length} papers`);

  // The needle papers are drawn from the SAME sample the index is built over,
  // with an independent seed so they are not the sample's own head or tail.
  const needles = corpus
    .map((p) => ({ p, r: hash01("needle:" + seed + ":" + p.id) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, wanted)
    .map((x) => x.p);

  /** @type {any[]} */
  const queries = [];
  let cursor = 0;
  let leaky = 0;
  const worker = async () => {
    for (;;) {
      const at = cursor++;
      if (at >= needles.length) return;
      const paper = needles[at];
      let q = await generateQuery(paper, false).catch(() => null);
      let overlap = q ? titleOverlap(q.en, paper.title) : 1;
      if (q && overlap > MAX_OVERLAP) {
        const retry = await generateQuery(paper, true).catch(() => null);
        if (retry) {
          const o2 = titleOverlap(retry.en, paper.title);
          if (o2 < overlap) {
            q = retry;
            overlap = o2;
          }
        }
      }
      if (!q) continue;
      if (overlap > MAX_OVERLAP) leaky++;
      queries.push({
        gold: paper.id,
        en: q.en,
        sv: q.sv,
        titleOverlap: Math.round(overlap * 100) / 100,
        primary: paper.primary,
        title: paper.title,
      });
      if (queries.length % 10 === 0) process.stdout.write(`\r  ${queries.length}/${needles.length} queries`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  process.stdout.write("\n");
  queries.sort((a, b) => (a.gold < b.gold ? -1 : 1));

  const avgOverlap = queries.reduce((a, q) => a + q.titleOverlap, 0) / (queries.length || 1);
  const goldset = {
    v: 1,
    built: new Date().toISOString(),
    seed,
    sampleSize,
    needle: queries,
    stats: { queries: queries.length, avgTitleOverlap: Math.round(avgOverlap * 100) / 100, overLeakThreshold: leaky },
  };
  await writeFile(join(ROOT, out), JSON.stringify(goldset, null, 1) + "\n");
  console.log(
    `Wrote ${queries.length} needle queries → ${out}\n` +
      `  mean title overlap ${avgOverlap.toFixed(2)} (${leaky} still above ${MAX_OVERLAP} after the strict retry)`,
  );
}

if (process.argv[1]?.endsWith("arxiv-goldset.mjs")) {
  main().catch((err) => {
    console.error("arxiv-goldset failed:", err.message);
    process.exit(1);
  });
}
