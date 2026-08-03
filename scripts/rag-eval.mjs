#!/usr/bin/env node
// The hosted-RAG evaluation harness — one instrument, every corpus.
//
//   node scripts/rag-eval.mjs sample   --corpus pubmed --months 2026/05-2026/07 --n 400
//   node scripts/rag-eval.mjs goldset  --corpus pubmed --sample data/eval/pubmed-sample.jsonl --queries 150
//   node scripts/rag-eval.mjs coverage --corpus pubmed --months 2026/06 --n 1500
//   node scripts/rag-eval.mjs run      --corpus pubmed --gold data/eval/pubmed-gold.json --label baseline
//   node scripts/rag-eval.mjs compare  --runs data/eval/a.json,data/eval/b.json
//   node scripts/rag-eval.mjs judge    --runs data/eval/a.json,data/eval/b.json
//   node scripts/rag-eval.mjs probe    --corpus pubmed
//
// ---- what this is for -------------------------------------------------------
//
// Hill-climbing a retrieval pipeline means running the SAME measurement before
// and after a change, on a gold set that cannot have been selected by the thing
// being measured, and deciding with a paired test rather than by eye. Each of
// those three is a place this subsystem has already been burned:
//
//  * measuring the wrong pipeline — the published "87% recall@1" described the
//    local binary pack, not the served path (docs/ARXIV-RAG.md §10.7);
//  * a gold set that measures itself — sampling papers by querying the index
//    selects for papers that retrieve well;
//  * eyeballing a delta — at n=150 the independent binomial CI is ±6.7 points,
//    so almost every real effect looks like noise and almost every noise looks
//    real. `compare` runs the paired McNemar the doc's verdicts were always
//    based on but which existed in no script until now.
//
// Every run is written to disk as EVIDENCE — per-query stage ranks, scores and
// latencies — and every table is a view over that file, recomputable without
// spending another query. That is what makes a comparison months apart honest.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ndcgAtK, tokenize } from "../public/js/arxiv-rag-core.js";
import { chatJson } from "./arxiv-berget.mjs";
import { CANDIDATES, RERANK_FLOOR, corpus } from "./rag-corpora.mjs";
import { getByIdsBatched, hostedSearch, vectorizeCount } from "./rag-hosted.mjs";
import {
  GRADER_OPTS,
  ageProfile,
  gradeMessages,
  langParity,
  lexicalOverlap,
  lossBreakdown,
  needleStats,
  pairedNeedle,
  pairedSign,
  parseGrades,
  rankOf,
  scoreProfile,
} from "./rag-eval-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS = 4;

/** @param {string[]} argv */
function arg(argv, flag, dflt) {
  const i = argv.indexOf(flag);
  return i < 0 ? dflt : argv[i + 1];
}

/** @param {string[]} argv */
function has(argv, flag) {
  return argv.includes(flag);
}

/** @param {string} p */
async function readJson(p) {
  return JSON.parse(await readFile(join(ROOT, p), "utf8"));
}

/**
 * @param {string} p
 * @param {any} data
 */
async function writeJson(p, data) {
  await mkdir(dirname(join(ROOT, p)), { recursive: true });
  await writeFile(join(ROOT, p), JSON.stringify(data) + "\n");
}

/**
 * Run `jobs` through `fn` with a fixed worker pool, reporting progress.
 * @template T, R
 * @param {T[]} jobs
 * @param {(job: T, i: number) => Promise<R>} fn
 * @param {number} [workers]
 * @returns {Promise<R[]>}
 */
async function pool(jobs, fn, workers = WORKERS) {
  /** @type {R[]} */
  const out = new Array(jobs.length);
  let cursor = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, jobs.length) }, async () => {
      for (;;) {
        const at = cursor++;
        if (at >= jobs.length) return;
        out[at] = await fn(jobs[at], at);
        process.stdout.write(`\r  ${++done}/${jobs.length}   `);
      }
    }),
  );
  if (jobs.length) process.stdout.write("\n");
  return out;
}

// ---- sample -----------------------------------------------------------------

/**
 * Build a needle CORPUS file: ids drawn from the corpus's INDEPENDENT
 * enumeration, hydrated with the title/abstract the hosted index actually
 * stores.
 *
 * Two properties this must keep. The ids never come from a query against the
 * index — that would select for documents that retrieve well and inflate every
 * number downstream. And an id present in the enumeration but ABSENT from the
 * index is reported rather than dropped quietly: that gap is itself a coverage
 * measurement, and the harness's own failure mode is work that reports success
 * while doing less than asked.
 */
async function cmdSample(argv) {
  const c = corpus(arg(argv, "--corpus", "arxiv"));
  const months = arg(argv, "--months", "");
  const want = Number(arg(argv, "--n", 400));
  const seed = arg(argv, "--seed", "rag-eval-v1");
  const out = arg(argv, "--out", `data/eval/${c.id}-sample.jsonl`);
  const minAbstract = Number(arg(argv, "--min-abstract", 200));
  if (!months) throw new Error(`--months required (${c.id}: e.g. ${c.id === "arxiv" ? "2507-2607" : "2026/05-2026/07"})`);

  console.log(`${c.label}: enumerating ${months} independently of the index …`);
  // Over-ask, because some enumerated ids will not be in the index and the
  // point is to end with `want` usable needles, not `want` attempts.
  const ids = await c.enumerate(months, Math.ceil(want * 1.6), seed);
  console.log(`  ${ids.length.toLocaleString()} ids from the independent enumeration`);
  if (!ids.length) throw new Error("the enumeration returned nothing — refusing to write an empty sample");

  const rows = await getByIdsBatched(ids.map(c.vectorId), { corpus: c.id });
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  /** @type {any[]} */
  const kept = [];
  let missing = 0;
  let tooShort = 0;
  for (const bare of ids) {
    const row = byId.get(c.vectorId(bare));
    if (!row) {
      missing++;
      continue;
    }
    const title = String(row.metadata?.t || "").trim();
    const abstract = String(row.metadata?.a || "").trim();
    if (!title || abstract.length < minAbstract) {
      tooShort++;
      continue;
    }
    kept.push({ id: String(row.id), bare, title, abstract, d: String(row.metadata?.d || "") });
    if (kept.length >= want) break;
  }

  const asked = Math.min(ids.length, kept.length + missing + tooShort);
  console.log(
    `  present in index: ${asked - missing}/${asked} (${(((asked - missing) / Math.max(1, asked)) * 100).toFixed(1)}%)` +
      ` · ${tooShort} below the ${minAbstract}-char abstract floor · sampled ${kept.length}`,
  );
  if (missing / Math.max(1, asked) > 0.1) {
    console.log(`  WARNING: over 10% of enumerated ids are not in the index — run \`coverage\` before trusting any run`);
  }
  await mkdir(dirname(join(ROOT, out)), { recursive: true });
  await writeFile(join(ROOT, out), kept.map((k) => JSON.stringify(k)).join("\n") + "\n");
  console.log(`Wrote ${kept.length} → ${out}`);
}

// ---- goldset ----------------------------------------------------------------

const GOLDSET_SYSTEM = (/** @type {string} */ unit) => `You write realistic search queries for a scientific literature search engine.
Given one ${unit}, write the research question a researcher would type into the search box that this document answers.

Rules:
- Ask about the CONTRIBUTION or FINDING, not the document. Never write "this paper", "the authors", "the study".
- Paraphrase. Do NOT reuse the distinctive noun phrases of the title; use the field's ordinary
  vocabulary, synonyms, or a description of the problem instead.
- One sentence, 8-25 words, phrased as a question or an information need.
- Write it twice: "en" in English, "sv" in idiomatic Swedish (a natural Swedish research question,
  not a word-for-word translation; keep established English technical terms that Swedish
  researchers actually use, and use correct Swedish diacritics).
Respond with JSON: {"en": "...", "sv": "..."}`;

const MAX_OVERLAP = 0.5;

/**
 * Generate the needle gold set from a sample file.
 *
 * The leak guard measures overlap against the title AND the abstract, and
 * regenerates on a title leak. Measuring the title alone is what
 * docs/ARXIV-RAG.md §4.3 records as the mistake that mattered: the shipped set
 * read clean at 0.30 title overlap while carrying 0.68 of the ABSTRACT's
 * vocabulary, because the model writes from the abstract. The abstract figure
 * is reported with every set so a lexical arm's score can never again be
 * believed without it.
 *
 * The Swedish side exists per CLAUDE.md invariant 6, and is not decoration: a
 * multilingual embedder measured only in English is an untested claim.
 */
async function cmdGoldset(argv) {
  const c = corpus(arg(argv, "--corpus", "arxiv"));
  const samplePath = arg(argv, "--sample", `data/eval/${c.id}-sample.jsonl`);
  const wanted = Number(arg(argv, "--queries", 150));
  const out = arg(argv, "--out", `data/eval/${c.id}-gold.json`);

  const text = await readFile(join(ROOT, samplePath), "utf8");
  const docs = text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(0, wanted);
  if (!docs.length) throw new Error(`${samplePath} is empty — refusing to build a gold set from nothing`);
  console.log(`${c.label}: writing EN+SV needle queries for ${docs.length} documents …`);

  const generate = async (/** @type {any} */ doc, /** @type {boolean} */ strict) => {
    const extra = strict
      ? "\n\nYour previous attempt copied the title's wording. Rewrite it using COMPLETELY different vocabulary — describe the problem and the finding in the field's generic terms."
      : "";
    const json = await chatJson(
      [
        { role: "system", content: GOLDSET_SYSTEM(c.goldsetUnit) },
        { role: "user", content: `Title: ${doc.title}\nAbstract: ${doc.abstract.slice(0, 1800)}${extra}` },
      ],
      { temperature: strict ? 0.7 : 0.3, maxTokens: 300 },
    );
    const en = typeof json?.en === "string" ? json.en.trim() : "";
    const sv = typeof json?.sv === "string" ? json.sv.trim() : "";
    return en && sv ? { en, sv } : null;
  };

  const results = await pool(docs, async (doc) => {
    let q = await generate(doc, false).catch(() => null);
    let overlap = q ? lexicalOverlap(q.en, doc.title, tokenize) : 1;
    if (q && overlap > MAX_OVERLAP) {
      const retry = await generate(doc, true).catch(() => null);
      if (retry) {
        const o2 = lexicalOverlap(retry.en, doc.title, tokenize);
        if (o2 < overlap) {
          q = retry;
          overlap = o2;
        }
      }
    }
    if (!q) return null;
    return {
      gold: doc.id,
      en: q.en,
      sv: q.sv,
      titleOverlap: Math.round(overlap * 100) / 100,
      // Reported, never gated on: the English queries legitimately share the
      // abstract's technical vocabulary. It is the number that says how much
      // head start a lexical retriever would get, and it belongs beside any
      // result a lexical arm produces.
      abstractOverlapEn: Math.round(lexicalOverlap(q.en, doc.abstract, tokenize) * 100) / 100,
      abstractOverlapSv: Math.round(lexicalOverlap(q.sv, doc.abstract, tokenize) * 100) / 100,
      title: doc.title,
    };
  }, 6);

  const queries = results.filter(Boolean).sort((a, b) => (a.gold < b.gold ? -1 : 1));
  const mean = (/** @type {string} */ k) => Math.round((queries.reduce((a, q) => a + q[k], 0) / (queries.length || 1)) * 100) / 100;
  const leaky = queries.filter((q) => q.titleOverlap > MAX_OVERLAP).length;
  await writeJson(out, {
    v: 1,
    corpus: c.id,
    built: new Date().toISOString(),
    sample: samplePath,
    needle: queries,
    stats: {
      queries: queries.length,
      avgTitleOverlap: mean("titleOverlap"),
      avgAbstractOverlapEn: mean("abstractOverlapEn"),
      avgAbstractOverlapSv: mean("abstractOverlapSv"),
      overLeakThreshold: leaky,
    },
  });
  console.log(
    `Wrote ${queries.length} needle queries → ${out}\n` +
      `  title overlap ${mean("titleOverlap")} (${leaky} still above ${MAX_OVERLAP} after the strict retry)\n` +
      `  abstract overlap EN ${mean("abstractOverlapEn")} · SV ${mean("abstractOverlapSv")}`,
  );
}

// ---- coverage ---------------------------------------------------------------

/**
 * Index membership against an INDEPENDENT enumeration.
 *
 * Run this BEFORE any retrieval evaluation. A 73.5%-complete index produces
 * confident recall numbers, and the arXiv harvest's own counters agreed with
 * themselves to 0.04% while 48.1% of a month was missing. A run's counters
 * cannot detect the run's own gaps; only a second system can.
 */
async function cmdCoverage(argv) {
  const c = corpus(arg(argv, "--corpus", "arxiv"));
  const months = arg(argv, "--months", "");
  const n = Number(arg(argv, "--n", 600));
  const seed = arg(argv, "--seed", "coverage-v1");
  if (!months) throw new Error("--months required");

  const { vectorCount } = await vectorizeCount({ corpus: c.id });
  console.log(`${c.label} index ${c.index}: ${vectorCount.toLocaleString()} vectors`);
  console.log(`Sampling ${n} ids per window from the independent enumeration (${months}) …`);

  /** @type {any[]} */
  const table = [];
  const windows = months.includes(",") ? months.split(",").map((s) => s.trim()) : [months];
  for (const w of windows) {
    const ids = await c.enumerate(w, n, seed);
    if (!ids.length) {
      console.log(`  ${w}: enumeration returned NOTHING — that is a defect in the enumeration, not a coverage result`);
      continue;
    }
    const rows = await getByIdsBatched(ids.map(c.vectorId), { corpus: c.id });
    const present = new Set(rows.map((r) => String(r.id)));
    const missing = ids.filter((id) => !present.has(c.vectorId(id)));
    table.push({ window: w, sampled: ids.length, present: ids.length - missing.length, missing: missing.length, examples: missing.slice(0, 3) });
  }

  console.log(`\nwindow                sampled  present  missing`);
  for (const t of table) {
    const pctMissing = ((t.missing / t.sampled) * 100).toFixed(1);
    console.log(
      `${String(t.window).padEnd(21)} ${String(t.sampled).padStart(7)}  ${String(t.present).padStart(7)}  ` +
        `${String(t.missing).padStart(4)} (${pctMissing}%)${t.missing ? `  e.g. ${t.examples.join(" ")}` : ""}`,
    );
  }
  console.log(
    `\nA few tenths of a percent is the steady state (the index's abstract floor is stricter\n` +
      `than the enumeration's filter). Several percent on a settled window is a real hole.`,
  );
}

// ---- run --------------------------------------------------------------------

async function cmdRun(argv) {
  const c = corpus(arg(argv, "--corpus", "arxiv"));
  const goldPath = arg(argv, "--gold", "");
  const topicalPath = arg(argv, "--topical", c.topical);
  const label = arg(argv, "--label", "run");
  const out = arg(argv, "--out", `data/eval/${c.id}-${label}.json`);
  const langs = String(arg(argv, "--langs", "en,sv")).split(",").map((s) => s.trim()).filter(Boolean);
  const poolSize = Number(arg(argv, "--pool", CANDIDATES));
  const floor = Number(arg(argv, "--floor", RERANK_FLOOR));
  const limit = Number(arg(argv, "--limit", 0));
  // Raising this shortens wall clock but INFLATES every measured latency, so a
  // run whose latency will be compared against another must use the same value.
  // It is a flag rather than a constant because a pool-100 run makes ~5 extra
  // hydrating round trips per query and does not otherwise finish in one turn.
  const workers = Number(arg(argv, "--workers", WORKERS));

  const { vectorCount } = await vectorizeCount({ corpus: c.id });
  console.log(`${c.label} · ${vectorCount.toLocaleString()} vectors · label "${label}" · pool ${poolSize} · floor ${floor}`);

  /** @type {any[]} */
  let needle = [];
  if (goldPath) needle = (await readJson(goldPath)).needle || [];
  if (limit) needle = needle.slice(0, limit);
  /** @type {any[]} */
  let topicalQueries = [];
  try {
    const topical = await readJson(topicalPath);
    topicalQueries = Array.isArray(topical) ? topical : topical.topical || topical.queries || [];
  } catch {
    console.log(`  (no topical set at ${topicalPath} — needles only)`);
  }

  /** @type {any[]} */
  const jobs = [];
  for (const q of needle) for (const lang of langs) if (q[lang]) jobs.push({ kind: "needle", lang, query: q[lang], gold: q.gold, id: q.gold });
  for (const q of topicalQueries) for (const lang of langs) if (q[lang]) jobs.push({ kind: "topical", lang, query: q[lang], id: q.id });
  if (!jobs.length) throw new Error("no queries to run — pass --gold and/or provide a topical set");

  console.log(`Running ${jobs.length} queries (${needle.length} needles + ${topicalQueries.length} topical, ${langs.join("/")}) …`);
  let fallbacks = 0;
  const rows = await pool(jobs, async (job) => {
    try {
      const r = await hostedSearch(job.query, { corpus: c.id, topK: poolSize, floor });
      if (!r.scored) fallbacks++;
      return {
        ...job,
        dense: r.dense,
        ordered: r.ordered,
        kept: r.kept,
        scores: r.scores,
        scored: r.scored,
        ms: r.ms,
        denseRank: job.gold ? rankOf(r.dense, job.gold) : 0,
        finalRank: job.gold ? rankOf(r.kept, job.gold) : 0,
      };
    } catch (/** @type {any} */ err) {
      return { ...job, error: err?.message || String(err), dense: [], ordered: [], kept: [] };
    }
  }, workers);

  const errored = rows.filter((r) => r.error).length;
  if (fallbacks) console.log(`  WARNING: the cross-encoder fell back on ${fallbacks} queries — those rows measure dense order only`);
  if (errored) console.log(`  WARNING: ${errored} queries errored outright and are excluded from every table`);

  // Titles/abstracts/dates for everything returned, so `judge` can grade the
  // pooled union and `compare` can profile ages without another enumeration.
  const seen = new Set();
  for (const r of rows) for (const id of r?.ordered || []) seen.add(id);
  /** @type {Record<string, any>} */
  const docs = {};
  for (const row of await getByIdsBatched([...seen], { corpus: c.id })) {
    docs[String(row.id)] = { title: String(row.metadata?.t || ""), abstract: String(row.metadata?.a || ""), d: String(row.metadata?.d || "") };
  }

  const result = { v: 1, corpus: c.id, label, ran: new Date().toISOString(), vectorCount, candidates: poolSize, floor, workers, langs, rows, docs };
  await writeJson(out, result);
  console.log(`Wrote ${out}`);
  report(c, result);
}

/**
 * @param {import('./rag-corpora.mjs').Corpus} c
 * @param {any} result
 */
function report(c, result) {
  const langs = result.langs || ["en", "sv"];
  const rows = result.rows || [];
  const table = langs.map((l) => ({ lang: l, s: needleStats(rows, l) })).filter((t) => t.s);
  if (table.length) {
    console.log(`\nNeedle · ${c.label} · ${result.vectorCount.toLocaleString()} vectors · pool ${result.candidates}`);
    console.log(`lang   n     inPool  r@1    r@5    r@10   MRR    floorLoss  ms(med)  ms(p95)`);
    for (const { lang, s } of table) {
      console.log(
        `${lang.padEnd(6)} ${String(s.n).padEnd(5)} ${String(s.inPool).padEnd(7)} ${String(s.r1).padEnd(6)} ` +
          `${String(s.r5).padEnd(6)} ${String(s.r10).padEnd(6)} ${String(s.mrr).padEnd(6)} ${String(s.floorLoss).padEnd(10)} ` +
          `${String(s.msMedian).padEnd(8)} ${s.msP95}`,
      );
    }
    console.log(`\nWhere the gold document was lost (% of needles)`);
    console.log(`lang   n     in top10  never retrieved  rerank demoted  floored out`);
    for (const { lang } of table) {
      const l = lossBreakdown(rows, lang);
      if (!l) continue;
      console.log(
        `${lang.padEnd(6)} ${String(l.n).padEnd(5)} ${String(l.top10).padEnd(9)} ${String(l.notRetrieved).padEnd(16)} ` +
          `${String(l.rerankDemoted).padEnd(15)} ${l.flooredOut}`,
      );
    }
  }
  const sp = scoreProfile(rows, "topical");
  if (sp) {
    console.log(`\nTop cross-encoder score on topical queries (the floor's operating range)`);
    console.log(`  n ${sp.n}  min ${sp.min}  p05 ${sp.p05}  median ${sp.median}  max ${sp.max}`);
    console.log(`  queries that would return NOTHING at floor 0.01 / 0.05 / 0.1: ${sp.zeroAt["0.01"]} / ${sp.zeroAt["0.05"]} / ${sp.zeroAt["0.1"]}`);
  }
}

// ---- compare ----------------------------------------------------------------

/**
 * Side-by-side of two or more runs, decided by a PAIRED test.
 *
 * The last column is the one that matters. At n=150 an independent binomial CI
 * is about ±6.7 points and calls almost every real effect noise; the runs share
 * their gold set, so the discordant pairs are the evidence. Reading only the
 * rate columns is how a corpus change ships on a swing that is not there.
 */
async function cmdCompare(argv) {
  const runPaths = String(arg(argv, "--runs", "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (runPaths.length < 2) throw new Error("--runs before.json,after.json required");
  const runs = [];
  for (const p of runPaths) runs.push(await readJson(p));
  const c = corpus(runs[0].corpus || arg(argv, "--corpus", "arxiv"));
  const alpha = Number(arg(argv, "--alpha", 0.05));

  for (const lang of runs[0].langs || ["en", "sv"]) {
    console.log(`\nNeedle · ${lang.toUpperCase()}`);
    console.log("run                    vectors   pool  floor  inPool  r@1    r@5    r@10   MRR");
    for (const run of runs) {
      const s = needleStats(run.rows, lang);
      if (!s) continue;
      console.log(
        `${String(run.label).padEnd(22)} ${String(run.vectorCount).padStart(8)}  ${String(run.candidates).padEnd(5)} ` +
          `${String(run.floor ?? "-").padEnd(6)} ${String(s.inPool).padEnd(7)} ${String(s.r1).padEnd(6)} ` +
          `${String(s.r5).padEnd(6)} ${String(s.r10).padEnd(6)} ${s.mrr}`,
      );
    }
    console.log(`\n  paired McNemar vs "${runs[0].label}" (b = lost, c = gained, on the SAME queries)`);
    for (const run of runs.slice(1)) {
      for (const k of [1, 10]) {
        const t = pairedNeedle(runs[0].rows, run.rows, k, lang);
        if (!t.nPaired) continue;
        const verdict = t.n === 0 ? "identical" : t.p < alpha ? (t.c > t.b ? "BETTER" : "WORSE") : "not significant";
        console.log(
          `    ${String(run.label).padEnd(20)} r@${String(k).padEnd(3)} paired ${String(t.nPaired).padStart(4)}  ` +
            `lost ${String(t.b).padStart(3)}  gained ${String(t.c).padStart(3)}  p=${t.p.toFixed(4)}  ${verdict}`,
        );
      }
    }
  }

  console.log(`\nLatency (needle + topical, ms)`);
  console.log("run                    median  p95   embed  query  rerank");
  for (const run of runs) {
    const ok = (run.rows || []).filter((/** @type {any} */ r) => !r.error && r.ms);
    if (!ok.length) continue;
    const tot = ok.map((/** @type {any} */ r) => r.ms.total).sort((a, b) => a - b);
    const mean = (/** @type {string} */ k) => Math.round(ok.reduce((a, r) => a + (r.ms[k] || 0), 0) / ok.length);
    console.log(
      `${String(run.label).padEnd(22)} ${String(tot[Math.floor(tot.length / 2)]).padStart(6)}  ${String(tot[Math.floor(tot.length * 0.95)]).padStart(5)} ` +
        `${String(mean("embed")).padStart(6)} ${String(mean("query")).padStart(6)} ${String(mean("rerank")).padStart(7)}`,
    );
  }
  const lat = (/** @type {any} */ run) => (run.rows || []).filter((/** @type {any} */ r) => !r.error && r.ms).map((/** @type {any} */ r) => r.ms.total);
  for (const run of runs.slice(1)) {
    const t = pairedSign(lat(runs[0]), lat(run), 5);
    if (t.n) console.log(`  paired sign vs "${runs[0].label}": ${run.label} slower on ${t.c}, faster on ${t.b}, p=${t.p.toFixed(4)}`);
  }

  console.log(`\nAge of what was SHOWN (top 10, topical queries) — a change can move this without moving a score`);
  console.log("run                    n     median    oldest    newest" + (c.preWindow ? `    pre-${c.preWindow}` : ""));
  for (const run of runs) {
    const a = ageProfile((run.rows || []).filter((/** @type {any} */ r) => r.kind === "topical"), {
      monthOf: c.monthOf,
      docs: run.docs || {},
      preWindow: c.preWindow || 0,
    });
    if (!a) continue;
    console.log(
      `${String(run.label).padEnd(22)} ${String(a.n).padEnd(5)} ${a.median.padEnd(9)} ${a.oldest.padEnd(9)} ${a.newest.padEnd(9)}` +
        (c.preWindow ? `  ${a.preWindowPct}%` : ""),
    );
  }
}

// ---- judge ------------------------------------------------------------------

/**
 * Grade the POOLED topical candidates from every run at once, then score each
 * run against the shared grade table.
 *
 * Pooling across runs is the whole point: grading each run separately would
 * give the same document different labels depending on which run returned it,
 * and the before/after delta would be measuring the judge rather than the
 * retrieval.
 */
async function cmdJudge(argv) {
  const runPaths = String(arg(argv, "--runs", "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!runPaths.length) throw new Error("--runs a.json[,b.json] required");
  const runs = [];
  for (const p of runPaths) runs.push(await readJson(p));
  const c = corpus(runs[0].corpus || arg(argv, "--corpus", "arxiv"));
  const out = arg(argv, "--out", `data/eval/${c.id}-graded.json`);
  const topicalPath = arg(argv, "--topical", c.topical);

  const topical = await readJson(topicalPath);
  const topicalQueries = Array.isArray(topical) ? topical : topical.topical || topical.queries || [];
  const byQ = new Map(topicalQueries.map((/** @type {any} */ q) => [q.id, q]));

  /** @type {Map<string, Set<string>>} */
  const pooled = new Map();
  /** @type {Record<string, any>} */
  const docs = {};
  for (const run of runs) {
    Object.assign(docs, run.docs || {});
    for (const r of run.rows || []) {
      if (r.kind !== "topical" || r.error) continue;
      const key = `${r.id}.${r.lang}`;
      if (!pooled.has(key)) pooled.set(key, new Set());
      for (const id of (r.kept || []).slice(0, 10)) pooled.get(key).add(id);
    }
  }
  if (!pooled.size) throw new Error("no topical rows in these runs — nothing to grade");

  console.log(`Grading ${pooled.size} pooled topical query sets across ${runs.length} run(s) …`);
  const keys = [...pooled.keys()];
  /** @type {Record<string, Record<string, number>>} */
  const gains = {};
  await pool(keys, async (key) => {
    const [qid, lang] = key.split(".");
    const q = byQ.get(qid);
    const ids = [...pooled.get(key)];
    const json = await chatJson(
      gradeMessages(q?.[lang] || qid, ids, (id) => docs[id]),
      GRADER_OPTS,
    ).catch(() => null);
    const g = parseGrades(json, ids);
    gains[key] = g;
    return g;
  });

  /** @type {Record<string, any>} */
  const summary = {};
  /** @type {Record<string, Record<string, number[]>>} */
  const perQuery = {};
  for (const run of runs) {
    summary[run.label] = { vectorCount: run.vectorCount, langs: {} };
    perQuery[run.label] = {};
    for (const lang of run.langs || ["en", "sv"]) {
      const scores = (run.rows || [])
        .filter((/** @type {any} */ r) => r.kind === "topical" && r.lang === lang && !r.error)
        .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.id < b.id ? -1 : 1))
        .map((/** @type {any} */ r) => ndcgAtK((r.kept || []).map((/** @type {string} */ id) => ({ id })), gains[`${r.id}.${r.lang}`] || {}, 10));
      if (!scores.length) continue;
      perQuery[run.label][lang] = scores;
      summary[run.label].langs[lang] = { ndcg10: Math.round((scores.reduce((a, s) => a + s, 0) / scores.length) * 1000) / 1000, n: scores.length };
    }
  }

  await writeJson(out, { v: 1, corpus: c.id, graded: new Date().toISOString(), gains, summary });
  console.log(`\nTopical nDCG@10 (pooled grades) · ${c.label}`);
  for (const [label, s] of Object.entries(summary)) {
    const parts = Object.entries(s.langs).map(([l, v]) => `${l.toUpperCase()} ${v.ndcg10}`).join("  ");
    console.log(`  ${label.padEnd(16)} ${String(s.vectorCount).padStart(9)} vectors   ${parts}`);
  }
  // A topical set is 14 queries: far too few for a rate difference to mean
  // anything by eye, so the same paired machinery decides it here too.
  if (runs.length > 1) {
    const base = runs[0].label;
    for (const run of runs.slice(1)) {
      for (const lang of Object.keys(perQuery[base])) {
        const a = perQuery[base][lang];
        const b = perQuery[run.label]?.[lang];
        if (!a || !b) continue;
        const t = pairedSign(a, b, 0.001);
        console.log(`  paired sign ${lang.toUpperCase()} ${base} → ${run.label}: worse ${t.b}, better ${t.c}, p=${t.p.toFixed(4)}`);
      }
    }
  }
  console.log(`Wrote ${out}`);
}

// ---- parity -----------------------------------------------------------------

/**
 * The invariant-6 measurement: does Swedish cost documents that English finds?
 *
 * CLAUDE.md invariant 6 requires equal Swedish and English support, and a
 * multilingual embedder measured only in English is an untested claim. Two
 * separate rate columns cannot answer this — the languages ask about the SAME
 * gold documents, so the discordant pairs are the evidence.
 *
 * It reports the DENSE stage beside the final one on purpose. If the dense
 * deficit equals the final deficit, every Swedish loss happened before the
 * cross-encoder ever saw the document, and reranking work cannot close it.
 *
 * It also prints the score floor's operating range per language, because that
 * is what says whether RERANK_FLOOR could be raised: a floor high enough to
 * reject an off-domain query is only safe if genuine Swedish queries sit well
 * above it, and they may not.
 */
async function cmdParity(argv) {
  const runPaths = String(arg(argv, "--runs", arg(argv, "--run", ""))).split(",").map((s) => s.trim()).filter(Boolean);
  if (!runPaths.length) throw new Error("--runs <run.json> required");
  const alpha = Number(arg(argv, "--alpha", 0.05));

  for (const p of runPaths) {
    const run = await readJson(p);
    const c = corpus(run.corpus || "arxiv");
    console.log(`\n${c.label} · ${run.label} · ${run.vectorCount.toLocaleString()} vectors · pool ${run.candidates}`);
    console.log(`stage   metric  paired  SV loses  SV wins  p        verdict`);
    for (const [stage, k] of [["final", 1], ["final", 10], ["dense", 10]]) {
      const t = langParity(run.rows, { k, stage });
      if (!t.nPaired) continue;
      const verdict = t.n === 0 ? "identical" : t.p < alpha ? (t.b > t.c ? "SWEDISH DEFICIT" : "Swedish ahead") : "parity holds";
      console.log(
        `${stage.padEnd(7)} ${(stage === "dense" ? "inPool" : `r@${k}`).padEnd(7)} ${String(t.nPaired).padStart(6)}  ` +
          `${String(t.b).padStart(8)}  ${String(t.c).padStart(7)}  ${t.p.toFixed(5).padEnd(8)} ${verdict}`,
      );
    }
    for (const lang of run.langs || ["en", "sv"]) {
      const sp = scoreProfile(run.rows.filter((/** @type {any} */ r) => r.lang === lang), "topical");
      if (sp) console.log(`  ${lang.toUpperCase()} topical top-score  min ${sp.min}  p05 ${sp.p05}  median ${sp.median}`);
    }
    console.log(
      `  A floor can only be raised to F if EVERY genuine query's top score stays above F.\n` +
        `  Compare the mins above against what \`probe\` scores for the off-domain controls.`,
    );
  }
}

// ---- probe ------------------------------------------------------------------

/**
 * A fast smoke test of the served path, in both languages, with a NONSENSE
 * CONTROL.
 *
 * The control is the important half. Dense retrieval always returns its nearest
 * neighbours however far away they are, so without a floor an off-domain
 * question gets confident nonsense instead of an honest miss, and the caller
 * never falls through to its live API. This is the check that the floor still
 * does its job — it is cheap enough to run after every deploy and answers the
 * one question a recall table cannot.
 *
 * Swedish queries here carry their DIACRITICS. Stripping them costs orders of
 * magnitude of score and has already manufactured a false invariant-6 bug
 * report once (docs/PUBMED-RAG.md §7.7).
 */
async function cmdProbe(argv) {
  const c = corpus(arg(argv, "--corpus", "arxiv"));
  const poolSize = Number(arg(argv, "--pool", CANDIDATES));
  const file = arg(argv, "--topical", c.topical);
  const controlOnly = has(argv, "--control-only");

  const topical = await readJson(file);
  const queries = (Array.isArray(topical) ? topical : topical.topical || topical.queries || []).slice(0, Number(arg(argv, "--n", 5)));
  const controls = (topical.controls || []).length
    ? topical.controls
    : [{ id: "ctl", en: "best pizza recipe napoletana dough", sv: "bästa receptet på napolitansk pizzadeg" }];

  const jobs = [];
  if (!controlOnly) for (const q of queries) for (const lang of ["en", "sv"]) if (q[lang]) jobs.push({ ...q, lang, kind: "topical" });
  for (const q of controls) for (const lang of ["en", "sv"]) if (q[lang]) jobs.push({ ...q, lang, kind: "control" });

  const { vectorCount } = await vectorizeCount({ corpus: c.id });
  console.log(`${c.label} · ${vectorCount.toLocaleString()} vectors · pool ${poolSize} · floor ${RERANK_FLOOR}\n`);
  const rows = await pool(jobs, async (job) => {
    try {
      const r = await hostedSearch(job[job.lang], { corpus: c.id, topK: poolSize });
      return { ...job, top: r.scores?.[0] ?? null, kept: r.kept.length, ms: r.ms.total, scored: r.scored };
    } catch (/** @type {any} */ err) {
      return { ...job, error: err?.message || String(err) };
    }
  });

  console.log(`kind     lang  top score   kept/${poolSize}   ms    query`);
  for (const r of rows) {
    if (r.error) {
      console.log(`${r.kind.padEnd(8)} ${r.lang.padEnd(5)} ERROR ${r.error}`);
      continue;
    }
    console.log(
      `${r.kind.padEnd(8)} ${r.lang.padEnd(5)} ${String(r.top === null ? "-" : r.top.toFixed(4)).padEnd(11)} ` +
        `${String(r.kept).padEnd(9)} ${String(r.ms).padEnd(5)} ${String(r[r.lang]).slice(0, 60)}`,
    );
  }
  const leaks = rows.filter((r) => r.kind === "control" && !r.error && r.kept > 0);
  console.log(
    leaks.length
      ? `\nFAIL: ${leaks.length} nonsense control(s) kept results above the floor — the fall-through to the live API is broken.`
      : `\nOK: every nonsense control was emptied by the relevance floor.`,
  );
}

// ---- main -------------------------------------------------------------------

const COMMANDS = { sample: cmdSample, goldset: cmdGoldset, coverage: cmdCoverage, run: cmdRun, compare: cmdCompare, judge: cmdJudge, parity: cmdParity, probe: cmdProbe };

async function main() {
  const argv = process.argv.slice(2);
  const fn = COMMANDS[argv[0]];
  if (fn) return fn(argv);
  console.log(
    `usage: rag-eval.mjs <command> --corpus arxiv|pubmed [flags]\n\n` +
      `  sample   --months <window> --n 400          ids from an INDEPENDENT enumeration, hydrated\n` +
      `  goldset  --sample <jsonl> --queries 150     EN+SV needle queries, leak-guarded\n` +
      `  coverage --months <window> --n 600          index membership vs that enumeration — run this FIRST\n` +
      `  run      --gold <json> --label <name>       replay the served path; writes the evidence file\n` +
      `  compare  --runs a.json,b.json               paired McNemar + latency + age profile\n` +
      `  judge    --runs a.json[,b.json]             pooled LLM grading → topical nDCG@10\n` +
      `  parity   --runs <run.json>                  invariant 6: paired EN vs SV on the same documents\n` +
      `  probe    [--control-only]                   fast smoke test incl. the nonsense control\n\n` +
      `The order is coverage → sample → goldset → run → compare/judge. A recall number\n` +
      `measured over an index whose coverage was never checked is a confident guess.`,
  );
}

if (process.argv[1]?.endsWith("rag-eval.mjs")) {
  main().catch((err) => {
    console.error(`rag-eval failed: ${err?.message || err}`);
    process.exit(1);
  });
}
