// The BENCH GATE — the scored rubric benchmark as a routine before/after
// merge gate for pipeline-sensitive changes (the P7 discipline in
// docs/ARCHITECTURE-GAP-ANALYSIS.md).
//
// Two modes:
//
//   npm run bench:gate -- --record   (re)record tests/bench-baseline.json:
//       run the pinned battery (SAMPLES × the diagnostic question set at a
//       fixed budget, fixed answer model, fixed judge) against the CURRENTLY
//       DEPLOYED main and commit the aggregate as the baseline.
//
//   npm run bench:gate               run the same pinned battery against the
//       current deployment and compare to the committed baseline. Exit codes:
//       0 = NEUTRAL or IMPROVED (within/above the noise bar), 2 = REGRESSION
//       (below it), 1 = setup error (no baseline, missing creds, no samples).
//
// The gate re-runs eval-bench.mjs (same live SSE + judge protocol; see that
// file's header) and aggregates like denoise-driver.mjs: per-sample battery
// means, then mean ± SD across samples, because single-sample judge variance
// is ±2+ per cell and never trustworthy alone. All pins (model, judge,
// budget, question ids) come FROM the baseline in compare mode, so a gate run
// can't drift from what the baseline measured. SAMPLES is the one free knob.
//
// Discipline (also in docs/TESTING.md):
//   - Run the gate BEFORE a pipeline-sensitive change (or trust the committed
//     baseline if the deployment is unchanged), deploy the change, run it
//     AFTER; paste the printed ledger block into EVAL-BENCH-FINDINGS.md.
//   - Don't deploy/push mid-battery (the model-eval rule): an auto-deploy
//     truncates in-flight streams and poisons the run.
//   - On IMPROVED, re-record the baseline in the same PR that lands the win.
//
// Env: BASIC_AUTH_USER/PASS required; SAMPLES (default 3), BASE_URL optional.
// Record-mode-only pins: GATE_MODEL, GATE_JUDGE, GATE_BUDGET_S, GATE_QIDS.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(here, "bench-baseline.json");
const RESULTS_ROOT = path.join(here, "eval-bench-results");
const RECORD = process.argv.includes("--record");
const SAMPLES = Number(process.env.SAMPLES || 3);

if (!process.env.BASIC_AUTH_USER || !process.env.BASIC_AUTH_PASS) {
  console.error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
  process.exit(1);
}

// Pins: the same fixed generation model + judge the denoise batteries used
// (EVAL-BENCH-FINDINGS.md), the denoise diagnostic question set, extended-tier
// budget (240 s — the tier the budget-gated phases and fan-out live at).
const DEFAULT_PINS = {
  model: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
  judge: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
  budgetS: 240,
  qids: ["mh_semiconductor_export", "rec_eu_ai_act_timeline", "div_openai_safety", "con_coffee_health"],
};

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return null;
  }
}

const baseline = loadBaseline();
if (!RECORD && !baseline) {
  console.error(
    "No committed baseline (tests/bench-baseline.json).\n" +
      "Record one against the currently deployed main first:  npm run bench:gate -- --record",
  );
  process.exit(1);
}

const pins = RECORD
  ? {
      model: process.env.GATE_MODEL || DEFAULT_PINS.model,
      judge: process.env.GATE_JUDGE || DEFAULT_PINS.judge,
      budgetS: Number(process.env.GATE_BUDGET_S || DEFAULT_PINS.budgetS),
      qids: (process.env.GATE_QIDS?.split(",").map((s) => s.trim()).filter(Boolean)) || DEFAULT_PINS.qids,
    }
  : { model: baseline.model, judge: baseline.judge, budgetS: baseline.budgetS, qids: baseline.qids };

const stats = (xs) => {
  const n = xs.length;
  if (!n) return { n: 0, mean: null, sd: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, mean: +mean.toFixed(3), sd: +sd.toFixed(3) };
};

// One eval-bench run with the pinned env; returns per-question rows harvested
// from the results dir the run created (diffed against the dirs that existed
// before, not mtime-guessed).
function runSample(i) {
  const before = new Set(fs.existsSync(RESULTS_ROOT) ? fs.readdirSync(RESULTS_ROOT) : []);
  console.log(`\n=== bench-gate sample ${i}/${SAMPLES} (budget ${pins.budgetS}s, ${pins.qids.length} questions) ===`);
  const r = spawnSync("node", ["eval-bench.mjs"], {
    cwd: here,
    encoding: "utf8",
    timeout: 3_000_000,
    env: {
      ...process.env,
      EVAL_MODELS: pins.model,
      EVAL_JUDGE_MODEL: pins.judge,
      EVAL_QUESTION_IDS: pins.qids.join(","),
      EVAL_BUDGET_S: String(pins.budgetS),
      EVAL_CONCURRENCY: "2",
    },
  });
  if (r.status !== 0) {
    console.error(`sample ${i} failed:`, (r.stderr || r.stdout || "").slice(-400));
    return null;
  }
  const fresh = (fs.existsSync(RESULTS_ROOT) ? fs.readdirSync(RESULTS_ROOT) : []).filter((d) => !before.has(d));
  if (fresh.length !== 1) {
    console.error(`sample ${i}: expected one new results dir, found ${fresh.length}`);
    return null;
  }
  const dir = path.join(RESULTS_ROOT, fresh[0]);
  const rows = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "_summary.json") continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j.scores && typeof j.overall === "number") rows.push(j);
    } catch {
      /* skip unreadable row */
    }
  }
  return rows;
}

const perQuestion = {}; // qid -> [{citation, coverage, calibration, overall}]
const batteryMeans = []; // one mean-overall per completed sample
for (let i = 1; i <= SAMPLES; i++) {
  const rows = runSample(i);
  if (!rows) continue;
  const overalls = [];
  for (const row of rows) {
    (perQuestion[row.id] ||= []).push({ ...row.scores, overall: row.overall });
    overalls.push(row.overall);
  }
  if (overalls.length === pins.qids.length) {
    batteryMeans.push(overalls.reduce((a, b) => a + b, 0) / overalls.length);
  } else {
    console.error(`sample ${i}: only ${overalls.length}/${pins.qids.length} questions scored — dropped from battery means`);
  }
}

if (!batteryMeans.length) {
  console.error("No complete samples — cannot record or compare.");
  process.exit(1);
}

const overall = stats(batteryMeans);
const perQuestionStats = {};
console.log(`\n===== bench-gate aggregate (${overall.n} complete samples) =====`);
console.log("question".padEnd(26), "n", "overall(mean±sd)", "cite", "cov", "cal");
for (const qid of pins.qids) {
  const s = perQuestion[qid] || [];
  const q = {
    overall: stats(s.map((x) => x.overall)),
    citation: stats(s.map((x) => x.citation)),
    coverage: stats(s.map((x) => x.coverage)),
    calibration: stats(s.map((x) => x.calibration)),
  };
  perQuestionStats[qid] = q;
  console.log(
    qid.padEnd(26),
    String(q.overall.n),
    `${q.overall.mean}±${q.overall.sd}`.padEnd(16),
    String(q.citation.mean),
    String(q.coverage.mean),
    String(q.calibration.mean),
  );
}
console.log("battery overall".padEnd(26), String(overall.n), `${overall.mean}±${overall.sd}`);

const gitSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.join(here, ".."), encoding: "utf8" })
  .stdout?.trim() || null;

if (RECORD) {
  const record = {
    version: 1,
    recordedAt: new Date().toISOString(),
    commit: gitSha,
    baseUrl: process.env.BASE_URL || "https://deepresearch.se",
    ...pins,
    samples: overall.n,
    batteryMeans: batteryMeans.map((m) => +m.toFixed(3)),
    overall,
    perQuestion: perQuestionStats,
  };
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nBaseline recorded → tests/bench-baseline.json (commit ${gitSha}, ${overall.n} samples).`);
  console.log("Commit it so gate runs compare against this measurement.");
  process.exit(0);
}

// ---- compare mode ---------------------------------------------------------
// Noise bar: the standard error of the difference between the two battery
// means, scaled ~1.7 (one-sided ~95% at these tiny n), floored at 0.15
// absolute so a fluke zero-SD baseline can't turn judge noise into verdicts.
const se = Math.sqrt(
  (baseline.overall.sd ** 2) / baseline.overall.n + (overall.sd ** 2) / overall.n,
);
const bar = Math.max(1.7 * se, 0.15);
const delta = +(overall.mean - baseline.overall.mean).toFixed(3);
const verdict = delta < -bar ? "REGRESSION" : delta > bar ? "IMPROVED" : "NEUTRAL";

console.log(`\nbaseline ${baseline.overall.mean}±${baseline.overall.sd} (n=${baseline.overall.n}, ${baseline.recordedAt?.slice(0, 10)}, commit ${baseline.commit})`);
console.log(`candidate ${overall.mean}±${overall.sd} (n=${overall.n}, commit ${gitSha})`);
console.log(`delta ${delta >= 0 ? "+" : ""}${delta}  noise bar ±${bar.toFixed(3)}  →  ${verdict}`);

console.log("\n--- paste into tests/EVAL-BENCH-FINDINGS.md ---");
console.log(
  `- bench-gate ${new Date().toISOString().slice(0, 10)} (commit ${gitSha} vs baseline ${baseline.commit}): ` +
    `overall ${overall.mean}±${overall.sd} vs ${baseline.overall.mean}±${baseline.overall.sd} ` +
    `(delta ${delta >= 0 ? "+" : ""}${delta}, bar ±${bar.toFixed(2)}) → ${verdict}. ` +
    `Pins: ${pins.model} / judge ${pins.judge} / ${pins.budgetS}s / ${pins.qids.join(",")}.`,
);
if (verdict === "IMPROVED") console.log("\nRe-record the baseline in the PR that lands this win:  npm run bench:gate -- --record");
process.exit(verdict === "REGRESSION" ? 2 : 0);
