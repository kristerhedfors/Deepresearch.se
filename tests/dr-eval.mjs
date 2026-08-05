#!/usr/bin/env node
// @ts-check
// GROUND-TRUTH deep-research battery, driven over the MCP server.
//
// What this adds to the harnesses already here. `eval-bench.mjs` judges 20
// hand-written questions BLIND — a strong model reads the answer and scores it
// 1-5 on citation/coverage/calibration. That measures whether an answer reads
// well. It cannot measure whether the answer is RIGHT, because no right answer
// is written down, and the ledger records the cost of that: the whole battery
// has sat ~0.6 below its baseline since 2026-07-29 with no way to attribute the
// drop (tests/EVAL-BENCH-FINDINGS.md). `hf-bench.mjs` does grade against gold
// answers, but only over SealQA/DeepSearchQA, and it discards the gold URLs
// those sets ship.
//
// This battery:
//   * grades against PUBLISHED gold answers (tests/evalsets/),
//   * scores RETRIEVAL separately from SYNTHESIS, using the gold source URLs
//     the benchmarks name, so a loss says which stage to work on rather than
//     just that something is wrong,
//   * runs a NO-SEARCH CONTROL arm on the same questions, which is the only way
//     to tell research from recall — a benchmark answer the model already knows
//     measures the model, not the pipeline,
//   * reports the three-way correct / incorrect / NOT-ATTEMPTED split, so
//     declining to guess is not scored the same as fabricating,
//   * decides before/after by PAIRED McNemar (scripts/rag-eval-core.mjs), the
//     discipline the retrieval side settled on and the bench side never adopted,
//   * goes over MCP rather than /api/chat — which is both what an external
//     caller actually experiences and a fifth copy of `postOnce` avoided.
//
// Usage:
//   BASIC_AUTH_USER=… BASIC_AUTH_PASS=… node tests/dr-eval.mjs --set frames
//   node tests/dr-eval.mjs --set frames,simpleqa --label baseline
//   node tests/dr-eval.mjs --set frames --arm nosearch --label control
//   node tests/dr-eval.mjs --compare data/dr-eval/frames-baseline.json data/dr-eval/frames-after.json
//
// Flags: --set a,b   --label NAME   --arm search|nosearch   --limit N
//        --budget S  --model ID     --judge ID  --workers N  --url URL
//
// NEVER deploy or push mid-battery: a Cloudflare auto-deploy truncates
// in-flight responses and poisons the run. Same rule as every other harness here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chatJson } from "../scripts/arxiv-berget.mjs";
import { detectBenchmarkLeak } from "./hf-bench-lib.mjs";
import { citationMetrics, goldSourceOverlap, parseCitations } from "./dr-evalset-core.mjs";
import {
  aggregate,
  buildJudgePrompt,
  classifyLoss,
  deepResearchArgs,
  initializeParams,
  objectiveGrade,
  pairedVerdict,
  parseJudgeVerdict,
  resolveItem,
  rpc,
  tally,
  toolResultText,
  wilson,
} from "./dr-eval-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETS_DIR = path.join(HERE, "evalsets");
const OUT_DIR = path.join(HERE, "..", "data", "dr-eval");

const argv = process.argv.slice(2);
const flag = (/** @type {string} */ n, /** @type {string|null} */ d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const URL_ = flag("--url", process.env.MCP_URL || "https://mcp.deepresearch.se");
const ARM = flag("--arm", "search");
const LABEL = flag("--label", ARM === "nosearch" ? "control" : "run");
const LIMIT = flag("--limit") ? Number(flag("--limit")) : null;
const BUDGET_S = Number(flag("--budget", process.env.DR_EVAL_BUDGET_S || "120"));
const MODEL = flag("--model", process.env.DR_EVAL_MODEL || null);
// The judge only has to compare an extracted answer against a written gold
// answer — a job a mid-size instruct model does reliably. It is pinned rather
// than defaulted to "whatever the catalog lists first", because a battery whose
// grader silently changes between runs cannot support a before/after.
const JUDGE = flag("--judge", process.env.DR_EVAL_JUDGE || "mistralai/Mistral-Medium-3.5-128B");
// The server caps a single account at 5 concurrent SPENDING tool calls and
// admins are deliberately NOT exempt (src/quota.js INFLIGHT_CAP). Four leaves
// one slot of headroom so a straggler retry is not refused by our own battery.
const WORKERS = Math.min(Number(flag("--workers", process.env.DR_EVAL_WORKERS || "4")), 4);

const AUTH = process.env.MCP_KEY
  ? `Bearer ${process.env.MCP_KEY}`
  : process.env.BASIC_AUTH_USER && process.env.BASIC_AUTH_PASS
    ? `Basic ${Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString("base64")}`
    : "";

// ---------------------------------------------------------------------------
// MCP transport
// ---------------------------------------------------------------------------

let seq = 0;
/** @param {string} method @param {any} params @param {number} timeoutMs */
async function call(method, params, timeoutMs = 30_000) {
  const res = await fetch(String(URL_), {
    method: "POST",
    headers: { "content-type": "application/json", ...(AUTH ? { authorization: AUTH } : {}) },
    body: JSON.stringify(rpc(++seq, method, params)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new Error(`auth refused: ${(await res.text()).slice(0, 200)}`);
  if (!res.ok) throw new Error(`transport ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  if (json.error) throw new Error(`rpc ${json.error.code}: ${json.error.message}`);
  return json.result;
}

/** The concurrency refusal is a 200 with isError — not a 429. Detect it by shape. */
const isBusy = (/** @type {string} */ t) => /running at once|concurrent calls/i.test(t);
const isQuota = (/** @type {string} */ t) => /quota exceeded/i.test(t);

/**
 * One research call, with backoff on the concurrency refusal only. A quota
 * refusal is never retried — retrying a hard limit just burns the battery.
 * @param {string} question
 */
async function research(question) {
  const args = deepResearchArgs({ question, budgetS: BUDGET_S, model: MODEL, webSearch: ARM !== "nosearch" });
  for (let attempt = 0; attempt < 5; attempt++) {
    const startedAt = Date.now();
    try {
      const r = await call("tools/call", { name: "deep_research", arguments: args }, BUDGET_S * 1000 + 90_000);
      const text = toolResultText(r);
      if (r.isError) {
        if (isBusy(text) && attempt < 4) {
          await sleep(2000 * Math.pow(2, attempt));
          continue;
        }
        return { text: "", ms: Date.now() - startedAt, error: text.slice(0, 300), refused: isQuota(text) };
      }
      return { text, ms: Date.now() - startedAt, error: null, refused: false };
    } catch (e) {
      if (attempt < 4) {
        await sleep(2000 * Math.pow(2, attempt));
        continue;
      }
      return { text: "", ms: Date.now() - startedAt, error: String(e).slice(0, 300), refused: false };
    }
  }
  return { text: "", ms: 0, error: "exhausted retries", refused: false };
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Bounded-concurrency map that preserves input order. */
async function pool(items, workers, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(workers, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * Objective first, judge only when the objective pass is inconclusive.
 *
 * A verbatim gold answer in the text is not a judgement call, and skipping the
 * judge there removes both a cost and a source of variance. The judge still
 * sees every non-obvious case, so nothing is graded wrong by the normaliser
 * alone.
 */
async function grade(item, answer) {
  if (!answer) return { grade: /** @type {const} */ ("not_attempted"), extracted: null, reason: "empty answer", by: "empty" };
  if (objectiveGrade(answer, item.answer) === "hit") {
    return { grade: /** @type {const} */ ("correct"), extracted: item.answer, reason: "gold answer present verbatim", by: "objective" };
  }
  try {
    const out = await chatJson(
      [
        { role: "system", content: "You are a strict grader. Reply with JSON only." },
        { role: "user", content: buildJudgePrompt({ question: item.question, gold: item.answer, response: answer.slice(0, 12000) }) },
      ],
      { model: JUDGE, temperature: 0, maxTokens: 400 },
    );
    const v = parseJudgeVerdict(JSON.stringify(out ?? {}));
    return { ...v, by: "judge" };
  } catch (e) {
    return { grade: /** @type {const} */ ("incorrect"), extracted: null, reason: `judge failed: ${e}`, by: "judge_error" };
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function loadSet(name) {
  const file = path.join(SETS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no such set: ${name} (build it with scripts/dr-evalset.mjs)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function runSet(name) {
  const set = loadSet(name);
  let items = set.items.map(resolveItem);
  if (LIMIT) items = items.slice(0, LIMIT);
  console.log(`\n${name}: ${items.length} questions, arm=${ARM}, budget=${BUDGET_S}s, workers=${WORKERS}`);

  let done = 0;
  const rows = await pool(items, WORKERS, async (item) => {
    const r = await research(item.question);
    const citations = citationMetrics(r.text);
    const goldOverlap = item.goldUrls.length ? goldSourceOverlap(r.text, item.goldUrls) : null;
    // A run that cited the benchmark's own mirror found the answer key, not the
    // facts. Same detector hf-bench uses, so a leak means the same thing in
    // both ledgers.
    const leaks = detectBenchmarkLeak(parseCitations(r.text).sources);
    const g = await grade(item, r.text);
    done++;
    process.stdout.write(
      `  [${String(done).padStart(3)}/${items.length}] ${item.id} ${g.grade.padEnd(13)} ` +
        `${(r.ms / 1000).toFixed(1)}s src=${citations.sourceCount}` +
        `${goldOverlap ? ` gold=${goldOverlap.hits}/${goldOverlap.goldCount}` : ""}` +
        `${r.error ? ` ERR ${r.error.slice(0, 60)}` : ""}\n`,
    );
    return {
      id: item.id,
      question: item.question,
      gold: item.answer,
      tags: item.tags,
      answer: r.text,
      ms: r.ms,
      error: r.error,
      grade: g.grade,
      extracted: g.extracted,
      reason: g.reason,
      gradedBy: g.by,
      citations,
      goldOverlap,
      leaks,
    };
  });

  for (const r of rows) r.loss = classifyLoss(r);
  return { set: name, rows };
}

/** @param {any[]} rows */
function summarize(rows) {
  const agg = aggregate(rows);
  const ci = wilson(agg.correct, agg.n);
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const withGold = rows.filter((r) => r.goldOverlap && r.goldOverlap.goldCount > 0);
  const goldRecall = withGold.length
    ? withGold.reduce((s, r) => s + r.goldOverlap.hits / r.goldOverlap.goldCount, 0) / withGold.length
    : null;
  return {
    ...agg,
    ci,
    loss: tally(rows.map((r) => r.loss)),
    latencyMedianS: ms.length ? ms[Math.floor(ms.length / 2)] / 1000 : 0,
    latencyP95S: ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] / 1000 : 0,
    sourcesMean: mean(rows.map((r) => r.citations.sourceCount)),
    domainsMean: mean(rows.map((r) => r.citations.domainCount)),
    danglingTotal: rows.reduce((s, r) => s + r.citations.danglingCount, 0),
    danglingRuns: rows.filter((r) => r.citations.danglingCount > 0).length,
    goldSourceRecall: goldRecall,
    errors: rows.filter((r) => r.error).length,
    leakTainted: rows.filter((r) => r.leaks && r.leaks.length).length,
  };
}

const mean = (/** @type {number[]} */ a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (/** @type {number|null} */ x) => (x == null ? "  n/a" : `${(x * 100).toFixed(1)}%`);

/** @param {string} name @param {any} s */
function printSummary(name, s) {
  console.log(`\n── ${name} ──────────────────────────────────`);
  console.log(`  accuracy            ${pct(s.accuracy)}  (${s.correct}/${s.n})  95% CI ${pct(s.ci.lo)}–${pct(s.ci.hi)}`);
  console.log(`  accuracy|attempted  ${pct(s.attemptedAccuracy)}   F ${pct(s.fScore)}`);
  console.log(`  not attempted       ${s.notAttempted}   incorrect ${s.incorrect}   errors ${s.errors}`);
  console.log(`  gold-source recall  ${pct(s.goldSourceRecall)}`);
  console.log(`  sources/answer      ${s.sourcesMean.toFixed(1)}  domains ${s.domainsMean.toFixed(1)}`);
  console.log(`  dangling citations  ${s.danglingTotal} across ${s.danglingRuns} answers`);
  console.log(`  leak-tainted runs   ${s.leakTainted}`);
  console.log(`  latency             median ${s.latencyMedianS.toFixed(1)}s  p95 ${s.latencyP95S.toFixed(1)}s`);
  console.log(`  loss breakdown      ${JSON.stringify(s.loss)}`);
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

function compare(fileA, fileB) {
  const a = JSON.parse(fs.readFileSync(fileA, "utf8"));
  const b = JSON.parse(fs.readFileSync(fileB, "utf8"));
  const flags = (/** @type {any} */ run) =>
    Object.fromEntries(run.rows.map((/** @type {any} */ r) => [r.id, r.grade === "correct"]));
  const v = pairedVerdict(flags(a), flags(b));
  const sa = summarize(a.rows);
  const sb = summarize(b.rows);
  console.log(`\nA ${a.label} (${a.set}, ${a.arm})  accuracy ${pct(sa.accuracy)}`);
  console.log(`B ${b.label} (${b.set}, ${b.arm})  accuracy ${pct(sb.accuracy)}`);
  console.log(`\npaired over ${v.nPaired} questions`);
  console.log(`  gained ${v.improved}   lost ${v.regressed}   discordant ${v.discordant}`);
  console.log(`  exact McNemar p = ${v.p.toFixed(4)}`);
  const verdict =
    v.discordant === 0
      ? "IDENTICAL — no question changed outcome"
      : v.p >= 0.05
        ? "NOT SIGNIFICANT — the delta is inside paired noise"
        : v.improved > v.regressed
          ? "IMPROVED"
          : "REGRESSED";
  console.log(`  verdict: ${verdict}`);
  console.log(`\n  gold-source recall  ${pct(sa.goldSourceRecall)} → ${pct(sb.goldSourceRecall)}`);
  console.log(`  dangling citations  ${sa.danglingTotal} → ${sb.danglingTotal}`);
  console.log(`  latency median      ${sa.latencyMedianS.toFixed(1)}s → ${sb.latencyMedianS.toFixed(1)}s`);
  console.log(`  loss  A ${JSON.stringify(sa.loss)}\n        B ${JSON.stringify(sb.loss)}`);
  return v;
}

// ---------------------------------------------------------------------------

async function main() {
  const cmpIdx = argv.indexOf("--compare");
  if (cmpIdx >= 0) {
    compare(argv[cmpIdx + 1], argv[cmpIdx + 2]);
    return;
  }
  if (!AUTH) {
    console.error("Set BASIC_AUTH_USER + BASIC_AUTH_PASS (break-glass) or MCP_KEY.");
    process.exit(1);
  }
  if (!process.env.BERGET_API_KEY && !process.env.BERGET_API_TOKEN) {
    console.error("Set BERGET_API_KEY — the judge runs directly on Berget, off the site's own quota.");
    process.exit(1);
  }
  // Handshake once: cheap, and it fails loudly here rather than on question 1.
  const init = await call("initialize", initializeParams({ name: "dr-eval" }));
  console.log(`server ${init.serverInfo?.name} protocol ${init.protocolVersion} @ ${URL_}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const names = (flag("--set", "frames") || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    const started = Date.now();
    const run = await runSet(name);
    const summary = summarize(run.rows);
    printSummary(`${name} · ${LABEL} · ${ARM}`, summary);
    const out = {
      set: name,
      label: LABEL,
      arm: ARM,
      url: URL_,
      budgetS: BUDGET_S,
      model: MODEL,
      judge: JUDGE,
      workers: WORKERS,
      wallClockS: Math.round((Date.now() - started) / 1000),
      summary,
      rows: run.rows,
    };
    const file = path.join(OUT_DIR, `${name}-${LABEL}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
    console.log(`\n  → ${path.relative(process.cwd(), file)}  (${out.wallClockS}s wall clock)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
