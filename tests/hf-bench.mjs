// Hugging Face short-answer research benchmark RUNNER. Complements the
// synthetic rubric benchmark (eval-bench.mjs): instead of judge-scored
// rubrics on ~27 hand-written questions, this grades the pipeline against
// EXTERNAL question sets with known gold answers, selected for low training-
// data contamination against the Berget catalog's cutoffs (see
// hf-bench-lib.mjs's header and tests/HF-BENCH-FINDINGS.md for the vetting).
//
// Flow per question: fetch rows from the HF datasets-server at RUN TIME
// (nothing from the dataset is committed to this repo — SealQA's answers are
// refreshed upstream, so a committed copy would rot), seeded-sample a fixed
// subset, run the real research pipeline via the live /api/chat SSE endpoint
// (same break-glass auth + SSE parse as eval-bench.mjs), then grade the
// answer against the gold with one search-off judge call. Deterministic
// metrics ride along: benchmark-leak detection (did the pipeline cite the
// benchmark itself?) and the SealQA freshness tags.
//
// Run: cd tests && BASIC_AUTH_USER=… BASIC_AUTH_PASS=… npm run eval:hf
//   HF_DATASET=sealqa|deepsearchqa  which adapter (default sealqa)
//   HF_CONFIG=seal_0                config override (dataset-specific)
//   HF_SAMPLE=25                    questions to sample (default 25)
//   HF_SEED=1                       sampling seed — keep FIXED across a
//                                   before/after comparison (default 1)
//   EVAL_MODELS=id1,id2             answer models (default: first up model)
//   EVAL_JUDGE_MODEL=id             judge model (default: first up model)
//   EVAL_BUDGET_S=120               research budget per question (default 120)
//   EVAL_CONCURRENCY=2              parallel questions (default 2)
//   HUGGINGFACE_API_TOKEN           optional (both default sets are public)
//
// Same discipline as the other harnesses: don't deploy/push mid-battery, and
// append every run's outcome to tests/HF-BENCH-FINDINGS.md — results dirs
// (./hf-bench-results/<timestamp>/) are gitignored and ephemeral.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HF_DATASETS,
  aggregateHfScores,
  buildAnswerJudgePrompt,
  detectBenchmarkLeak,
  parseJudgeVerdict,
  sampleIndices,
} from "./hf-bench-lib.mjs";

const BASE_URL = process.env.BASE_URL || "https://deepresearch.se";
const USER = process.env.BASIC_AUTH_USER;
const PASS = process.env.BASIC_AUTH_PASS;
if (!USER || !PASS) {
  console.error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const DATASET_KEY = (process.env.HF_DATASET || "sealqa").trim();
const ADAPTER = HF_DATASETS[DATASET_KEY];
if (!ADAPTER) {
  console.error(`Unknown HF_DATASET "${DATASET_KEY}" — known: ${Object.keys(HF_DATASETS).join(", ")}`);
  process.exit(1);
}
const HF_CONFIG = process.env.HF_CONFIG?.trim() || ADAPTER.config;
const SAMPLE = Number(process.env.HF_SAMPLE || 25);
const SEED = Number(process.env.HF_SEED || 1);
const BUDGET_S = Number(process.env.EVAL_BUDGET_S || 120);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 2);
const ONLY_MODELS = process.env.EVAL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
const JUDGE_MODEL_ENV = process.env.EVAL_JUDGE_MODEL?.trim() || null;
const HF_TOKEN = process.env.HUGGINGFACE_API_TOKEN?.trim() || null;

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

// ---- HF datasets-server fetch (runtime, paginated) --------------------------

async function hfGet(url) {
  const headers = HF_TOKEN ? { authorization: `Bearer ${HF_TOKEN}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HF datasets-server ${res.status} for ${url}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

async function fetchAllRows() {
  const base = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(ADAPTER.dataset)}&config=${encodeURIComponent(HF_CONFIG)}&split=${encodeURIComponent(ADAPTER.split)}`;
  const first = await hfGet(`${base}&offset=0&length=100`);
  const total = first.num_rows_total ?? first.rows.length;
  const rows = first.rows.map((r) => r.row);
  while (rows.length < total) {
    const page = await hfGet(`${base}&offset=${rows.length}&length=100`);
    if (!page.rows?.length) break;
    rows.push(...page.rows.map((r) => r.row));
  }
  return rows;
}

// ---- live /api/chat SSE (same shape as eval-bench.mjs's postOnce) -----------

async function fetchModels() {
  const res = await fetch(`${BASE_URL}/api/models`, { headers: { authorization: AUTH } });
  if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
  const data = await res.json();
  return data.models.filter((m) => m.up !== false);
}

async function postOnce(modelId, messages, { webSearch = true, budgetS = BUDGET_S } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budgetS * 2 * 1000 + 90_000);
  let requestId = null;
  const events = [];
  let text = "";
  let streamError = null;
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify({ messages, model: modelId, web_search: webSearch, time_budget_s: budgetS }),
      signal: controller.signal,
    });
    requestId = res.headers.get("x-request-id");
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      return { ok: false, request_id: requestId, http_status: res.status, error: detail.slice(0, 500), duration_ms: Date.now() - startedAt, events, text };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) streamError = chunk.error;
        if (chunk.status) events.push(chunk.status);
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) text += delta;
      }
    }
    return { ok: !streamError, request_id: requestId, stream_error: streamError, duration_ms: Date.now() - startedAt, events, text };
  } catch (err) {
    return { ok: false, request_id: requestId, error: err.name === "AbortError" ? "client-side timeout" : err.message, duration_ms: Date.now() - startedAt, events, text };
  } finally {
    clearTimeout(timeout);
  }
}

function sourcesFromEvents(events) {
  const seen = new Map();
  for (const e of events || []) {
    if (e && e.type === "search_done" && Array.isArray(e.sources)) {
      for (const s of e.sources) {
        const url = s && s.url;
        if (!url || seen.has(url)) continue;
        seen.set(url, { n: seen.size + 1, title: s.title || "", url });
      }
    }
  }
  return [...seen.values()];
}

// ---- one (model, question) run ----------------------------------------------

async function runOne(modelId, judgeModelId, q, index) {
  const research = await postOnce(modelId, [{ role: "user", content: q.question }], { webSearch: true });
  const sources = sourcesFromEvents(research.events);
  const leakUrls = detectBenchmarkLeak(sources);

  let verdict = null;
  let judgeMeta = null;
  if (research.ok && research.text.trim()) {
    const prompt = buildAnswerJudgePrompt({ question: q.question, gold: q.gold, answerType: q.answerType, answer: research.text });
    const j = await postOnce(judgeModelId, [{ role: "user", content: prompt }], { webSearch: false, budgetS: 45 });
    verdict = parseJudgeVerdict(j.text);
    judgeMeta = { request_id: j.request_id, error: verdict ? null : j.error || j.stream_error || "judge JSON parse failed", raw: verdict ? null : j.text.slice(0, 400) };
  }

  return {
    dataset: `${ADAPTER.dataset}/${HF_CONFIG}`,
    row_index: index,
    model: modelId,
    judge_model: judgeModelId,
    question: q.question,
    gold: q.gold,
    answer_type: q.answerType,
    meta: q.meta,
    ok: research.ok,
    research_request_id: research.request_id,
    research_duration_ms: research.duration_ms,
    research_error: research.ok ? null : research.error || research.stream_error || null,
    answer_length: research.text.length,
    answer: research.text,
    sources,
    leak_urls: leakUrls,
    judge: judgeMeta,
    verdict, // null → counted as failed/wrong in the aggregate
  };
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

// ---- main --------------------------------------------------------------------

const models = await fetchModels();
if (!models.length) {
  console.error("No up models in the catalog.");
  process.exit(1);
}
const answerModels = ONLY_MODELS?.length
  ? models.filter((m) => ONLY_MODELS.includes(m.id))
  : [models[0]];
const judgeModelId = JUDGE_MODEL_ENV || models[0].id;

console.log(`Fetching ${ADAPTER.dataset} (${HF_CONFIG}/${ADAPTER.split}) rows…`);
const allRows = await fetchAllRows();
const mapped = allRows.map((r, i) => ({ i, q: ADAPTER.mapRow(r) })).filter((x) => x.q);
console.log(`${allRows.length} rows fetched, ${mapped.length} usable; sampling ${Math.min(SAMPLE, mapped.length)} with seed ${SEED}.`);
const picked = sampleIndices(mapped.length, SAMPLE, SEED).map((k) => mapped[k]);

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(here, "hf-bench-results", `${stamp}-${DATASET_KEY}`);
fs.mkdirSync(outDir, { recursive: true });

const summary = { dataset: `${ADAPTER.dataset}/${HF_CONFIG}`, sample: picked.length, seed: SEED, budget_s: BUDGET_S, judge_model: judgeModelId, models: {} };
for (const model of answerModels) {
  console.log(`\n=== ${model.id} — ${picked.length} questions @ ${BUDGET_S}s ===`);
  const rows = await pool(picked, CONCURRENCY, async ({ i, q }) => {
    const r = await runOne(model.id, judgeModelId, q, i);
    const mark = r.verdict ? (r.verdict.correct ? "✓" : `✗ ${r.verdict.partial ? `(partial ${r.verdict.partial})` : ""}`) : "⚠ ungraded";
    console.log(`  [${i}] ${mark} ${q.question.slice(0, 90)}${r.leak_urls.length ? ` — LEAK: ${r.leak_urls[0]}` : ""}`);
    fs.writeFileSync(path.join(outDir, `${slug(model.id)}__row${i}.json`), JSON.stringify(r, null, 2));
    return r;
  });
  summary.models[model.id] = aggregateHfScores(rows);
  const s = summary.models[model.id];
  console.log(`  → accuracy ${(s.accuracy * 100).toFixed(1)}% (${s.correct}/${s.total}; partial-mean ${(s.mean_partial * 100).toFixed(1)}%; ${s.failed} failed; ${s.leaked_runs} leak-tainted)`);
}

fs.writeFileSync(path.join(outDir, "_summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nResults in ${outDir}`);
console.log("Append the outcome to tests/HF-BENCH-FINDINGS.md (same discipline as the other ledgers).");
