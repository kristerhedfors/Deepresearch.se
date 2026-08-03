#!/usr/bin/env node
// Before/after evaluation of the HOSTED arXiv index — the deployed path, not
// the local pack.
//
//   node scripts/arxiv-hosted-eval.mjs sample --months 2507-2607 --n 400 --out data/eval/carryover.jsonl
//   node scripts/arxiv-hosted-eval.mjs run    --gold data/eval/carryover-gold.json --label before --out data/eval/before.json
//   node scripts/arxiv-hosted-eval.mjs judge  --runs data/eval/before.json,data/eval/after.json
//
// ---- why a separate harness from scripts/arxiv-eval.mjs ---------------------
// arxiv-eval.mjs measures the local binary pack: a brute-force scan with a
// rerank pool of 50. The hosted path is a different pipeline — src/arxiv-rag.js
// asks Vectorize for 20 candidates, so the cross-encoder sees 20.
// docs/ARXIV-RAG.md §10.7 flags the resulting gap explicitly ("the doc's 87%
// recall@1 does not describe the hosted path"). This harness closes it, and is
// the instrument for judging whether widening the corpus window costs
// retrieval quality.
//
// It also settles WHY the pool is 20. src/arxiv-rag.js says 20 is Vectorize's
// ceiling with `returnMetadata: "all"`; measured against this index it is 50
// (and 100 without metadata) — see MAX_TOPK_WITH_METADATA in arxiv-hosted.mjs.
// `--pool N` sweeps it, which turns "the pool is the ceiling" from an
// observation into a change with evidence behind it.
//
// ---- how the gold set avoids measuring itself -------------------------------
// The needle papers are sampled UNIFORMLY from the independent GCS enumeration
// (scripts/arxiv-gcs.mjs — the public mirror, no credentials, no rate limit)
// and then hydrated through Vectorize `get_by_ids`. Sampling by *querying* the
// index would have selected papers that retrieve well and inflated every number
// below; sampling by id cannot. It also costs zero arXiv requests, which
// matters while a harvest is using the whole rate budget.
//
// Two honest caveats, stated because they bound what these numbers mean:
//
//  * The abstracts used to WRITE the queries are the index's stored 900-char
//    metadata copies, not full abstracts. That is what the cross-encoder reads,
//    and a subset of what the embedder saw, so it slightly flatters the
//    pipeline in absolute terms. It is identical before and after, so the
//    DELTA — the thing this exercise is for — is unaffected.
//  * The served time budget (embed 6 s / query 6 s / rerank 6 s / 12 s total)
//    is NOT enforced here. Under it, a slow leg silently drops the rerank, and
//    an eval that did that would average two different pipelines together.
//    Latency is measured and reported instead.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hitAtK, ndcgAtK, reciprocalRank } from "../public/js/arxiv-rag-core.js";
import { chatJson } from "./arxiv-berget.mjs";
import { hash01 } from "./arxiv-corpus.mjs";
import { listShard } from "./arxiv-gcs.mjs";
import { bareId } from "./arxiv-crosscheck.mjs";
import { CANDIDATES, hostedSearch, vectorizeCount, vectorizeGetByIds } from "./arxiv-hosted.mjs";
import { GRADER_OPTS, expandMonths, gradeMessages, parseGrades, rankOf } from "./rag-eval-core.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Vectorize rejects a larger payload outright: "40007 too many ids in payload;
// max id count is 20". Measured, not documented — the v2 REST reference does
// not state it.
const GET_BY_IDS_BATCH = 20;
const WORKERS = 4;

// The window arithmetic and the rank bookkeeping are shared with the
// corpus-agnostic harness (scripts/rag-eval-core.mjs) rather than copied. They
// were byte-identical, and the two harnesses measure the SAME index: a range
// that walked its months differently in one of them would report a coverage
// hole that the other could not see.
export { expandMonths, rankOf };

/** @param {string[]} argv */
function arg(argv, flag, dflt) {
  const i = argv.indexOf(flag);
  return i < 0 ? dflt : argv[i + 1];
}

// ---- sample -----------------------------------------------------------------

/**
 * Build a needle CORPUS file: uniformly sampled ids from the GCS enumeration,
 * hydrated with the title/abstract the hosted index actually stores. The output
 * is the JSONL shape scripts/arxiv-goldset.mjs already reads via --corpus-file,
 * so query generation, the title-leak guard and the EN/SV pair are unchanged.
 */
async function cmdSample(argv) {
  const months = expandMonths(arg(argv, "--months", ""));
  const want = Number(arg(argv, "--n", 400));
  const out = arg(argv, "--out", "data/eval/sample.jsonl");
  const seed = arg(argv, "--seed", "hosted-eval-v1");
  if (!months.length) throw new Error("--months 2507-2607 required");

  console.log(`Enumerating ${months.length} month shards from the GCS mirror …`);
  /** @type {string[]} */
  const all = [];
  for (const yymm of months) {
    const ids = await listShard(yymm);
    all.push(...ids.keys());
    process.stdout.write(`\r  ${yymm}: ${ids.size} ids (total ${all.length})   `);
  }
  process.stdout.write("\n");

  // Uniform by hash — deterministic, and independent of listing order so the
  // same sample comes back on any machine.
  const sampled = all
    .map((id) => ({ id, r: hash01(seed + ":" + id) }))
    .sort((a, b) => a.r - b.r)
    .slice(0, want)
    .map((x) => x.id);
  console.log(`Sampled ${sampled.length} of ${all.length} enumerated papers`);

  /** @type {any[]} */
  const papers = [];
  let missing = 0;
  for (let i = 0; i < sampled.length; i += GET_BY_IDS_BATCH) {
    const batch = sampled.slice(i, i + GET_BY_IDS_BATCH);
    const rows = await vectorizeGetByIds(batch);
    const byId = new Map(rows.map((/** @type {any} */ r) => [String(r.id), r]));
    for (const id of batch) {
      const row = byId.get(id);
      if (!row?.metadata?.t) {
        missing++;
        continue;
      }
      papers.push({
        id,
        title: String(row.metadata.t || ""),
        abstract: String(row.metadata.a || ""),
        primary: String(row.metadata.c || ""),
        categories: [String(row.metadata.c || "")].filter(Boolean),
      });
    }
    process.stdout.write(`\r  hydrated ${papers.length}/${sampled.length} (${missing} not in index)   `);
  }
  process.stdout.write("\n");

  await mkdir(dirname(join(ROOT, out)), { recursive: true });
  await writeFile(join(ROOT, out), papers.map((p) => JSON.stringify(p)).join("\n") + "\n");
  const coverage = ((papers.length / (sampled.length || 1)) * 100).toFixed(2);
  console.log(
    `Wrote ${papers.length} papers → ${out}\n` +
      `  hosted-index coverage of the sample: ${coverage}% (${missing} of ${sampled.length} absent)`,
  );
}

// ---- coverage ---------------------------------------------------------------

/**
 * Per-MONTH coverage of the hosted index against the independent GCS
 * enumeration, by sampling ids in each month and asking get_by_ids for them.
 *
 * Per-month is the whole point. docs/ARXIV-RAG.md §10.2: a harvest lost 48.1%
 * of its oldest month, the run exited 0, and the TOTALS agreed with the
 * enumeration to 0.04% — "only the per-month breakdown exposed the hole".
 * A single pooled percentage would hide exactly the failure this guards.
 */
async function cmdCoverage(argv) {
  const months = expandMonths(arg(argv, "--months", ""));
  const perMonth = Number(arg(argv, "--per-month", 150));
  const seed = arg(argv, "--seed", "coverage-v1");
  const idsFile = arg(argv, "--ids", "");
  if (!months.length) throw new Error("--months 2310-2506 required");

  /** @type {Map<string, string[]>} month → ids */
  const byMonth = new Map(months.map((m) => [m, []]));
  if (idsFile) {
    // Reuse an enumeration already on disk rather than re-listing the mirror.
    // bareId, NOT the raw line: `arxiv-gcs.mjs --out` writes ids WITH the
    // version suffix (2507.23787v2) while the index is keyed by the bare id.
    // Skipping this asks Vectorize for ids that cannot exist and reports 0%
    // coverage on every month — which reads exactly like a lost corpus. This
    // is the same normalisation arxiv-crosscheck.mjs needs, so it is imported
    // rather than rewritten: the bug appeared twice from being written twice.
    for (const line of (await readFile(join(ROOT, idsFile), "utf8")).split("\n")) {
      const id = bareId(line);
      const m = id.slice(0, 4);
      if (byMonth.has(m)) byMonth.get(m).push(id);
    }
  } else {
    for (const m of months) {
      const ids = await listShard(m);
      byMonth.set(m, [...ids.keys()]);
      process.stdout.write(`\r  enumerated ${m}: ${ids.size}   `);
    }
    process.stdout.write("\n");
  }

  console.log(`month    enumerated  sampled  present  coverage`);
  let worst = { month: "", pct: 101 };
  let totalSampled = 0;
  let totalPresent = 0;
  for (const m of months) {
    const all = byMonth.get(m) || [];
    if (!all.length) {
      console.log(`${m}     ${String(0).padStart(10)}  — no ids enumerated`);
      continue;
    }
    const sample = all
      .map((id) => ({ id, r: hash01(seed + ":" + id) }))
      .sort((a, b) => a.r - b.r)
      .slice(0, perMonth)
      .map((x) => x.id);
    let present = 0;
    for (let i = 0; i < sample.length; i += GET_BY_IDS_BATCH) {
      const rows = await vectorizeGetByIds(sample.slice(i, i + GET_BY_IDS_BATCH));
      present += rows.filter((/** @type {any} */ r) => r?.metadata?.t).length;
    }
    const pct = Math.round((present / sample.length) * 1000) / 10;
    totalSampled += sample.length;
    totalPresent += present;
    if (pct < worst.pct) worst = { month: m, pct };
    console.log(
      `${m}     ${String(all.length).padStart(10)}  ${String(sample.length).padStart(7)}  ${String(present).padStart(7)}  ${pct}%`,
    );
  }
  const overall = Math.round((totalPresent / (totalSampled || 1)) * 1000) / 10;
  console.log(`\noverall ${overall}% of ${totalSampled} sampled — worst month ${worst.month} at ${worst.pct}%`);
}

// ---- run --------------------------------------------------------------------

/**
 * Push a gold set through the served path and record, per query, where the gold
 * paper landed at each stage. Nothing is scored here that cannot be recomputed
 * from the saved ranks — the run file is the evidence, the table is a view.
 */
async function cmdRun(argv) {
  const goldPath = arg(argv, "--gold", "");
  const topicalPath = arg(argv, "--topical", "scripts/arxiv-topical-queries.json");
  const label = arg(argv, "--label", "run");
  const out = arg(argv, "--out", `data/eval/${label}.json`);
  const langs = String(arg(argv, "--langs", "en,sv")).split(",");
  // The candidate pool handed to the cross-encoder. Defaults to what
  // src/arxiv-rag.js asks for today; --pool 50 / --pool 100 measure what the
  // index would actually allow.
  const pool = Number(arg(argv, "--pool", CANDIDATES));

  const { vectorCount } = await vectorizeCount();
  console.log(`Hosted index: ${vectorCount.toLocaleString()} vectors — label "${label}", pool ${pool}`);

  /** @type {any[]} */
  let needle = [];
  if (goldPath) {
    const gold = JSON.parse(await readFile(join(ROOT, goldPath), "utf8"));
    needle = gold.needle || [];
  }
  const topical = JSON.parse(await readFile(join(ROOT, topicalPath), "utf8"));
  const topicalQueries = Array.isArray(topical) ? topical : topical.topical || topical.queries || [];

  /** @type {any[]} */
  const jobs = [];
  for (const q of needle) for (const lang of langs) if (q[lang]) jobs.push({ kind: "needle", lang, query: q[lang], gold: q.gold, id: q.gold });
  for (const q of topicalQueries) for (const lang of langs) if (q[lang]) jobs.push({ kind: "topical", lang, query: q[lang], id: q.id });

  console.log(`Running ${jobs.length} queries (${needle.length} needles + ${topicalQueries.length} topical, ${langs.join("/")}) …`);
  /** @type {any[]} */
  const rows = new Array(jobs.length);
  let cursor = 0;
  let done = 0;
  let fallbacks = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (;;) {
        const at = cursor++;
        if (at >= jobs.length) return;
        const job = jobs[at];
        try {
          const r = await hostedSearch(job.query, { topK: pool });
          if (!r.scored) fallbacks++;
          rows[at] = {
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
        } catch (err) {
          rows[at] = { ...job, error: err?.message || String(err), dense: [], ordered: [], kept: [] };
        }
        process.stdout.write(`\r  ${++done}/${jobs.length}   `);
      }
    }),
  );
  process.stdout.write("\n");
  if (fallbacks) console.log(`  WARNING: the cross-encoder fell back on ${fallbacks} queries — those rows measure dense order only`);

  // Titles/abstracts for everything returned, so `judge` can grade the pooled
  // union later without another enumeration pass.
  const seen = new Set();
  for (const r of rows) for (const id of r?.ordered || []) seen.add(id);
  /** @type {Record<string, any>} */
  const docs = {};
  const ids = [...seen];
  for (let i = 0; i < ids.length; i += GET_BY_IDS_BATCH) {
    const got = await vectorizeGetByIds(ids.slice(i, i + GET_BY_IDS_BATCH));
    for (const row of got) docs[String(row.id)] = { title: String(row.metadata?.t || ""), abstract: String(row.metadata?.a || "") };
  }

  const result = { v: 1, label, ran: new Date().toISOString(), vectorCount, candidates: pool, langs, rows, docs };
  await mkdir(dirname(join(ROOT, out)), { recursive: true });
  await writeFile(join(ROOT, out), JSON.stringify(result) + "\n");
  console.log(`Wrote ${out}`);
  reportNeedle(result);
}

/**
 * The needle table. `inPool` is the number that matters when a corpus grows:
 * the cross-encoder can only rescue a paper dense retrieval already put in the
 * top-20, so inPool is a hard ceiling on everything to its right.
 */
export function needleStats(rows, lang) {
  const rs = rows.filter((r) => r.kind === "needle" && r.lang === lang && !r.error);
  if (!rs.length) return null;
  const hits = rs.map((r) => r.kept.map((/** @type {string} */ id) => ({ id })));
  const golds = rs.map((r) => r.gold);
  const pct = (/** @type {number} */ n) => Math.round((n / rs.length) * 1000) / 10;
  return {
    n: rs.length,
    inPool: pct(rs.filter((r) => r.denseRank > 0).length),
    r1: pct(hits.filter((h, i) => hitAtK(h, golds[i], 1)).length),
    r5: pct(hits.filter((h, i) => hitAtK(h, golds[i], 5)).length),
    r10: pct(hits.filter((h, i) => hitAtK(h, golds[i], 10)).length),
    mrr: Math.round((hits.reduce((a, h, i) => a + reciprocalRank(h, golds[i]), 0) / rs.length) * 1000) / 10,
    // How often the relevance floor dropped a gold paper the reranker had kept.
    floorLoss: pct(rs.filter((r) => r.finalRank === 0 && rankOf(r.ordered, r.gold) > 0).length),
    msTotal: Math.round(rs.reduce((a, r) => a + (r.ms?.total || 0), 0) / rs.length),
  };
}

function reportNeedle(result) {
  const langs = result.langs || ["en", "sv"];
  const table = [];
  for (const lang of langs) {
    const s = needleStats(result.rows, lang);
    if (s) table.push({ lang, ...s });
  }
  if (!table.length) return;
  console.log(`\nNeedle — hosted path, ${result.vectorCount.toLocaleString()} vectors, pool ${result.candidates}`);
  // inPool is the share of gold papers dense retrieval put in front of the
  // cross-encoder AT ALL. Everything to its right is bounded by it, so it is
  // the column to read first when the corpus changes size.
  console.log(`lang   n    inPool@${String(result.candidates).padEnd(4)} r@1    r@5    r@10   MRR    floorLoss  ms`);
  for (const t of table) {
    console.log(
      `${t.lang.padEnd(6)} ${String(t.n).padEnd(4)} ${String(t.inPool).padEnd(11)} ${String(t.r1).padEnd(6)} ` +
        `${String(t.r5).padEnd(6)} ${String(t.r10).padEnd(6)} ${String(t.mrr).padEnd(6)} ${String(t.floorLoss).padEnd(10)} ${t.msTotal}`,
    );
  }
}

// ---- compare ----------------------------------------------------------------

/**
 * Submission month of an arXiv id as a sortable YYMM integer; 0 for old-style
 * ids. The id prefix is the ONLY trustworthy submission date on this corpus —
 * the harvested `updated`/datestamp field tracks the last revision, and
 * <created> tracks the harvest window (docs/ARXIV-RAG.md §3).
 * @param {string} id
 */
export function idYYMM(id) {
  const m = /^(\d{2})(\d{2})\./.exec(String(id || "").trim());
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

/**
 * Age profile of what a run actually SHOWED, from the ids alone.
 *
 * This exists to test an assumption the widening puts at risk. src/arxiv.js
 * records that a recency re-sort was tried and lost, and that the softer
 * "prefer the last 18 months" variant was a NO-OP "because every hit in a
 * realistic slice is already inside that window (the corpus grows, so relevance
 * is implicitly recent)". That reasoning holds for a rolling 13-month corpus by
 * construction. Over 33 months it is a claim about ranking, and this measures
 * whether it survived.
 *
 * @param {any[]} rows
 * @param {number} topN
 */
export function ageProfile(rows, topN = 10) {
  const months = [];
  for (const r of rows) {
    if (r.error) continue;
    for (const id of (r.kept || []).slice(0, topN)) {
      const m = idYYMM(id);
      if (m) months.push(m);
    }
  }
  if (!months.length) return null;
  months.sort((a, b) => a - b);
  const fmt = (/** @type {number} */ v) => `20${String(Math.floor(v / 100)).padStart(2, "0")}-${String(v % 100).padStart(2, "0")}`;
  const median = months[Math.floor(months.length / 2)];
  // The share that predates the original 13-month window — i.e. results that
  // only exist because of the widening.
  const preWindow = months.filter((m) => m < 2507).length;
  return {
    n: months.length,
    median: fmt(median),
    oldest: fmt(months[0]),
    newest: fmt(months.at(-1)),
    preWindowPct: Math.round((preWindow / months.length) * 1000) / 10,
  };
}

/**
 * Side-by-side of two runs: the needle table, then the age shift. Reads only
 * the saved run files, so it can be re-derived without spending another query.
 */
async function cmdCompare(argv) {
  const runPaths = String(arg(argv, "--runs", "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (runPaths.length < 2) throw new Error("--runs before.json,after.json required");
  const runs = [];
  for (const p of runPaths) runs.push(JSON.parse(await readFile(join(ROOT, p), "utf8")));

  for (const lang of ["en", "sv"]) {
    console.log(`\nNeedle · ${lang.toUpperCase()}`);
    console.log("run                    vectors   pool  inPool   r@1    r@5    r@10   MRR");
    for (const run of runs) {
      const s = needleStats(run.rows, lang);
      if (!s) continue;
      console.log(
        `${String(run.label).padEnd(22)} ${String(run.vectorCount).padStart(8)}  ${String(run.candidates).padEnd(5)} ` +
          `${String(s.inPool).padEnd(8)} ${String(s.r1).padEnd(6)} ${String(s.r5).padEnd(6)} ${String(s.r10).padEnd(6)} ${s.mrr}`,
      );
    }
  }

  console.log(`\nAge of what was shown (top 10, topical queries)`);
  console.log("run                    n     median    oldest    newest    pre-2507");
  for (const run of runs) {
    const a = ageProfile((run.rows || []).filter((/** @type {any} */ r) => r.kind === "topical"));
    if (!a) continue;
    console.log(
      `${String(run.label).padEnd(22)} ${String(a.n).padEnd(5)} ${a.median.padEnd(9)} ${a.oldest.padEnd(9)} ${a.newest.padEnd(9)} ${a.preWindowPct}%`,
    );
  }
}

// ---- judge ------------------------------------------------------------------

/**
 * Grade the POOLED topical candidates from every run at once, then score each
 * run against the shared grade table. Pooling across runs is the whole point:
 * grading each run separately would give the same paper different labels
 * depending on which index returned it, and the before/after delta would be
 * measuring the judge rather than the retrieval.
 */
async function cmdJudge(argv) {
  const runPaths = String(arg(argv, "--runs", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const out = arg(argv, "--out", "data/eval/graded.json");
  const topicalPath = arg(argv, "--topical", "scripts/arxiv-topical-queries.json");
  if (runPaths.length < 1) throw new Error("--runs a.json,b.json required");

  const runs = [];
  for (const p of runPaths) runs.push(JSON.parse(await readFile(join(ROOT, p), "utf8")));
  const topical = JSON.parse(await readFile(join(ROOT, topicalPath), "utf8"));
  const topicalQueries = Array.isArray(topical) ? topical : topical.topical || topical.queries || [];
  const byQ = new Map(topicalQueries.map((/** @type {any} */ q) => [q.id, q]));

  /** @type {Map<string, Set<string>>} `${qid}.${lang}` → pooled candidate ids */
  const pool = new Map();
  /** @type {Record<string, any>} */
  const docs = {};
  for (const run of runs) {
    Object.assign(docs, run.docs || {});
    for (const r of run.rows || []) {
      if (r.kind !== "topical" || r.error) continue;
      const key = `${r.id}.${r.lang}`;
      if (!pool.has(key)) pool.set(key, new Set());
      // Grade the top 10 each run would SHOW; deeper candidates cost tokens
      // without entering any nDCG@10.
      for (const id of (r.kept || []).slice(0, 10)) pool.get(key).add(id);
    }
  }

  console.log(`Grading ${pool.size} pooled topical query sets across ${runs.length} runs …`);
  /** @type {Record<string, Record<string, number>>} */
  const gains = {};
  const keys = [...pool.keys()];
  let cursor = 0;
  let graded = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (;;) {
        const at = cursor++;
        if (at >= keys.length) return;
        const key = keys[at];
        const [qid, lang] = key.split(".");
        const q = byQ.get(qid);
        const ids = [...pool.get(key)];
        const json = await chatJson(
          gradeMessages(q?.[lang] || qid, ids, (id) => docs[id]),
          GRADER_OPTS,
        ).catch(() => null);
        gains[key] = parseGrades(json, ids);
        process.stdout.write(`\r  graded ${++graded}/${keys.length}   `);
      }
    }),
  );
  process.stdout.write("\n");

  /** @type {Record<string, any>} */
  const summary = {};
  for (const run of runs) {
    summary[run.label] = { vectorCount: run.vectorCount, langs: {} };
    for (const lang of run.langs || ["en", "sv"]) {
      const scores = (run.rows || [])
        .filter((/** @type {any} */ r) => r.kind === "topical" && r.lang === lang && !r.error)
        .map((/** @type {any} */ r) => ndcgAtK((r.kept || []).map((/** @type {string} */ id) => ({ id })), gains[`${r.id}.${r.lang}`] || {}, 10));
      if (!scores.length) continue;
      summary[run.label].langs[lang] = {
        ndcg10: Math.round((scores.reduce((a, c) => a + c, 0) / scores.length) * 1000) / 1000,
        n: scores.length,
      };
    }
  }

  await mkdir(dirname(join(ROOT, out)), { recursive: true });
  await writeFile(join(ROOT, out), JSON.stringify({ v: 1, graded: new Date().toISOString(), gains, summary }, null, 1) + "\n");
  console.log(`\nTopical nDCG@10 (pooled grades)`);
  for (const [label, s] of Object.entries(summary)) {
    const parts = Object.entries(s.langs).map(([l, v]) => `${l.toUpperCase()} ${v.ndcg10}`).join("  ");
    console.log(`  ${label.padEnd(10)} ${String(s.vectorCount).padStart(9)} vectors   ${parts}`);
  }
  console.log(`Wrote ${out}`);
}

// ---- main -------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "sample") return cmdSample(argv);
  if (cmd === "coverage") return cmdCoverage(argv);
  if (cmd === "run") return cmdRun(argv);
  if (cmd === "compare") return cmdCompare(argv);
  if (cmd === "judge") return cmdJudge(argv);
  console.log(
    "usage:\n" +
      "  arxiv-hosted-eval.mjs sample --months 2507-2607 --n 400 --out data/eval/carryover.jsonl\n" +
      "  arxiv-hosted-eval.mjs coverage --months 2310-2506 --ids data/eval/gcs-2310-2506.txt\n" +
      "  arxiv-hosted-eval.mjs run --gold data/eval/gold.json --label before --out data/eval/before.json\n" +
      "  arxiv-hosted-eval.mjs compare --runs data/eval/before.json,data/eval/after.json\n" +
      "  arxiv-hosted-eval.mjs judge --runs data/eval/before.json,data/eval/after.json",
  );
}

if (process.argv[1]?.endsWith("arxiv-hosted-eval.mjs")) {
  main().catch((err) => {
    console.error("arxiv-hosted-eval failed:", err.message);
    process.exit(1);
  });
}
