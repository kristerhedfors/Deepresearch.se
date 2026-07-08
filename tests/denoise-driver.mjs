// De-noise driver for the scored benchmark: runs eval-bench.mjs N times over a
// diagnostic question set at a fixed budget, then aggregates all samples per
// question into mean ± spread so single-sample judge/generation variance (the
// ±2.3 per-cell swings) averages out into a trustworthy signal. Pair two runs
// at different budgets to A/B the budget-gated pipeline phases.
// Usage: BUDGET=240 SAMPLES=4 node denoise-driver.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUDGET = Number(process.env.BUDGET || 240);
const SAMPLES = Number(process.env.SAMPLES || 4);
const QIDS = process.env.QIDS || "mh_semiconductor_export,rec_eu_ai_act_timeline,div_openai_safety,con_coffee_health";
const MODEL = process.env.MODEL || "mistralai/Mistral-Small-3.2-24B-Instruct-2506";
const tag = `denoise-b${BUDGET}`;
const outRoot = path.join(here, "eval-bench-results", tag);
fs.mkdirSync(outRoot, { recursive: true });

const samples = {}; // qid -> [{citation,coverage,calibration,overall}]
for (let i = 1; i <= SAMPLES; i++) {
  console.log(`\n=== ${tag} sample ${i}/${SAMPLES} ===`);
  const env = { ...process.env, EVAL_MODELS: MODEL, EVAL_QUESTION_IDS: QIDS, EVAL_BUDGET_S: String(BUDGET), EVAL_CONCURRENCY: "2" };
  const r = spawnSync("node", ["eval-bench.mjs"], { cwd: here, env, encoding: "utf8", timeout: 1000 * 1000 });
  if (r.status !== 0) { console.log("sample failed:", r.stderr?.slice(-300)); continue; }
  // find newest results dir and harvest per-question scores
  const dirs = fs.readdirSync(path.join(here, "eval-bench-results"))
    .filter((d) => /^\d{4}-/.test(d))
    .map((d) => ({ d, t: fs.statSync(path.join(here, "eval-bench-results", d)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!dirs.length) continue;
  const dir = path.join(here, "eval-bench-results", dirs[0].d);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "_summary.json") continue;
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!j.scores) continue;
    (samples[j.id] ||= []).push({ ...j.scores, overall: j.overall });
  }
}

const stats = (xs) => {
  const n = xs.length; if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean: +mean.toFixed(2), sd: +sd.toFixed(2), min: Math.min(...xs), max: Math.max(...xs) };
};

const summary = {};
console.log(`\n===== ${tag} AGGREGATE (${SAMPLES} samples) =====`);
console.log("question".padEnd(24), "n", "overall(mean±sd)", "cite", "cov", "cal");
for (const qid of QIDS.split(",")) {
  const s = samples[qid] || [];
  const ov = stats(s.map((x) => x.overall));
  const ci = stats(s.map((x) => x.citation));
  const co = stats(s.map((x) => x.coverage));
  const ca = stats(s.map((x) => x.calibration));
  summary[qid] = { overall: ov, citation: ci, coverage: co, calibration: ca };
  console.log(qid.padEnd(24), ov.n, `${ov.mean}±${ov.sd} [${ov.min}-${ov.max}]`.padEnd(18), ci.mean, co.mean, ca.mean);
}
const allOverall = Object.values(summary).map((s) => s.overall.mean);
console.log("BATCH MEAN overall:", +(allOverall.reduce((a, b) => a + b, 0) / allOverall.length).toFixed(3));
fs.writeFileSync(path.join(outRoot, "aggregate.json"), JSON.stringify(summary, null, 2));
console.log("written:", path.join(outRoot, "aggregate.json"));
