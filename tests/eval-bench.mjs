// LLM-judged research benchmark RUNNER. For each question in
// bench-questions.mjs it hits the live /api/chat SSE endpoint (same
// break-glass Basic Auth + SSE parse as model-eval.mjs), captures the
// answer AND the source registry from the trace, computes the free
// non-LLM metrics (bench-score.mjs: source diversity, citation coverage),
// then asks a strong judge model to score citation faithfulness, rubric
// coverage, and calibration on 1-5 scales. Results land in
// ./eval-bench-results/<timestamp>/ (gitignored) with a _summary.json
// carrying aggregateScores, and a score table is printed to stdout.
//
// Unlike model-eval (raw traces read by hand), this produces a NUMBER: run
// it before a pipeline change to get a baseline, run it after to see
// whether the change earned its merge. Append the outcome to
// EVAL-BENCH-FINDINGS.md.
//
// Run: BASIC_AUTH_USER=... BASIC_AUTH_PASS=... node eval-bench.mjs
//   EVAL_MODELS=id1,id2      restrict to specific answer models (default: all up)
//   EVAL_JUDGE_MODEL=id      judge model (default: first up model in catalog)
//   EVAL_BUDGET_S=90         time budget per research question (default 90)
//   EVAL_CONCURRENCY=2       parallel questions (default 2)
//   EVAL_QUESTION_IDS=a,b    restrict to specific question ids
//   EVAL_QUESTION_KINDS=x,y  restrict to specific kinds
//
// NOTE (same rule as model-eval): don't deploy/push mid-battery — a
// Cloudflare auto-deploy can truncate in-flight streams and poison results.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_QUESTIONS, questionsByIds, questionsByKinds } from "./bench-questions.mjs";
import {
  buildJudgePrompt,
  sourceDiversity,
  citationCoverage,
  reportStructure,
  aggregateScores,
} from "./bench-score.mjs";

const BASE_URL = process.env.BASE_URL || "https://deepresearch.se";
const USER = process.env.BASIC_AUTH_USER;
const PASS = process.env.BASIC_AUTH_PASS;
if (!USER || !PASS) {
  console.error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const BUDGET_S = Number(process.env.EVAL_BUDGET_S || 90);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 2);
const ONLY_MODELS = process.env.EVAL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);
const JUDGE_MODEL_ENV = process.env.EVAL_JUDGE_MODEL?.trim() || null;
const ONLY_IDS = process.env.EVAL_QUESTION_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_KINDS = process.env.EVAL_QUESTION_KINDS?.split(",").map((s) => s.trim()).filter(Boolean);

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

async function fetchModels() {
  const res = await fetch(`${BASE_URL}/api/models`, { headers: { authorization: AUTH } });
  if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
  const data = await res.json();
  return data.models.filter((m) => m.up !== false);
}

// One /api/chat call — SSE parse copied from model-eval.mjs's postOnce (same
// shape returned whether it completed, errored, or aborted). `webSearch`
// lets the judge call reuse this in search-off mode.
async function postOnce(modelId, messages, { webSearch = true, budgetS = BUDGET_S } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), budgetS * 2 * 1000 + 90_000);
  let requestId = null;
  const events = [];
  let text = "";
  let streamError = null;
  let doneStats = null;
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      // developer_mode:false — the off-only override (src/chat.js): the
      // break-glass bench identity has developer mode FORCED on, and the
      // introspection enrichment would otherwise route every question to
      // source reading (and, pre-fix, to a quiz — chat_logs #360). The bench
      // measures the web-research pipeline, so decline introspection.
      body: JSON.stringify({ messages, model: modelId, web_search: webSearch, time_budget_s: budgetS, developer_mode: false }),
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
        if (chunk.status) {
          events.push(chunk.status);
          if (chunk.status.type === "done") doneStats = chunk.status;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) text += delta;
      }
    }
    return { ok: !streamError, request_id: requestId, stream_error: streamError, duration_ms: Date.now() - startedAt, events, text, done_stats: doneStats };
  } catch (err) {
    return { ok: false, request_id: requestId, error: err.name === "AbortError" ? "client-side timeout" : err.message, duration_ms: Date.now() - startedAt, events, text };
  } finally {
    clearTimeout(timeout);
  }
}

// Reconstruct the numbered source registry from the trace's search_done
// events (each carries sources:[{title,url}]). Deduped by url, numbered in
// first-seen order — a good stand-in for the registry the synthesis actually
// cited from, and exactly what sourceDiversity/the judge need.
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

// Tolerant strict-JSON extraction from a judge answer that may carry a fence
// or a stray sentence around the object.
function extractJson(text) {
  if (typeof text !== "string") return null;
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const slice = t.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function clampScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

// Judge one answer: build the prompt, send it search-OFF (no Exa spend, pure
// synthesis) to the judge model, parse the strict JSON verdict.
async function judgeAnswer(judgeModelId, { question, rubric }, answer, sources) {
  const prompt = buildJudgePrompt({ question, rubric, answer, sources });
  const r = await postOnce(judgeModelId, [{ role: "user", content: prompt }], { webSearch: false, budgetS: 45 });
  const parsed = extractJson(r.text);
  if (!parsed) {
    return { ok: false, raw: r.text.slice(0, 800), request_id: r.request_id, error: r.error || r.stream_error || "judge JSON parse failed" };
  }
  const citation = clampScore(parsed.citation);
  const coverage = clampScore(parsed.coverage);
  const calibration = clampScore(parsed.calibration);
  if (citation === null || coverage === null || calibration === null) {
    return { ok: false, raw: r.text.slice(0, 800), request_id: r.request_id, error: "judge returned non-numeric scores", parsed };
  }
  return { ok: true, request_id: r.request_id, scores: { citation, coverage, calibration }, notes: String(parsed.notes || "").slice(0, 600) };
}

// Full pipeline for one (model, question): research -> metrics -> judge.
async function runOne(model, judgeModelId, question) {
  const research = await postOnce(model.id, [{ role: "user", content: question.question }], { webSearch: true, budgetS: BUDGET_S });
  const sources = sourcesFromEvents(research.events);
  const diversity = sourceDiversity(sources);
  const citations = citationCoverage(research.text);
  // Report-shape metrics for the tier A/B (free, deterministic): did the
  // budget's report tier actually deliver its structure/length? Kept out of
  // the judge overall — structure is what the tier bought, not quality.
  const structure = reportStructure(research.text);

  let judge = null;
  if (research.ok && research.text.trim()) {
    judge = await judgeAnswer(judgeModelId, question, research.text, sources);
  } else {
    judge = { ok: false, error: research.ok ? "empty answer" : research.error || research.stream_error || "research failed" };
  }

  const scores = judge.ok ? judge.scores : null;
  const overall = scores ? (scores.citation + scores.coverage + scores.calibration) / 3 : null;

  return {
    model: model.id,
    judge_model: judgeModelId,
    id: question.id,
    kind: question.kind,
    lang: question.lang,
    question: question.question,
    ok: research.ok,
    research_request_id: research.request_id,
    research_duration_ms: research.duration_ms,
    research_error: research.ok ? null : research.error || research.stream_error || null,
    answer_length: research.text.length,
    answer: research.text,
    sources,
    metrics: { diversity, citations, structure },
    judge: judge.ok
      ? { request_id: judge.request_id, scores: judge.scores, notes: judge.notes }
      : { ok: false, error: judge.error, raw: judge.raw || null },
    scores, // judge dims only -> aggregate overall is judge-based
    overall: overall === null ? undefined : Math.round(overall * 1000) / 1000,
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

function pickQuestions() {
  let qs = BENCH_QUESTIONS;
  if (ONLY_IDS?.length) qs = questionsByIds(ONLY_IDS);
  if (ONLY_KINDS?.length) qs = questionsByKinds(ONLY_KINDS).filter((q) => qs.includes(q));
  return qs;
}

async function main() {
  const models = await fetchModels();
  const answerModels = ONLY_MODELS?.length ? models.filter((m) => ONLY_MODELS.includes(m.id)) : models;
  if (!answerModels.length) {
    console.error("No matching answer models (check EVAL_MODELS / catalog).");
    process.exit(1);
  }
  const judgeModelId = JUDGE_MODEL_ENV || models[0].id;
  if (JUDGE_MODEL_ENV && !models.some((m) => m.id === JUDGE_MODEL_ENV)) {
    console.warn(`Judge model "${JUDGE_MODEL_ENV}" not found as up in the catalog — using it anyway.`);
  }

  const questions = pickQuestions();
  const jobs = answerModels.flatMap((model) => questions.map((q) => ({ model, q })));
  console.log(
    `Benchmark: ${answerModels.length} answer model(s) × ${questions.length} questions = ${jobs.length} runs, ` +
    `budget ${BUDGET_S}s each, concurrency ${CONCURRENCY}. Judge: ${judgeModelId}.`,
  );

  const here = path.dirname(fileURLToPath(import.meta.url));
  const runDir = path.join(here, "eval-bench-results", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(runDir, { recursive: true });

  let completed = 0;
  const results = await pool(jobs, CONCURRENCY, async ({ model, q }) => {
    const result = await runOne(model, judgeModelId, q);
    completed++;
    const status = result.scores
      ? `cit ${result.scores.citation} cov ${result.scores.coverage} cal ${result.scores.calibration} (overall ${result.overall}), div ${result.metrics.diversity.score}, ${result.metrics.structure.words}w/${result.metrics.structure.h2}h2`
      : `NO SCORE: ${result.research_error || (result.judge && result.judge.error) || "unknown"}`;
    console.log(`[${completed}/${jobs.length}] ${model.id} :: ${q.id} -> ${status}`);
    fs.writeFileSync(path.join(runDir, `${slug(model.id)}__${q.id}.json`), JSON.stringify(result, null, 2));
    return result;
  });

  // Aggregate: judge dimensions (per model), plus the non-LLM metrics.
  const byModel = {};
  for (const r of results) (byModel[r.model] || (byModel[r.model] = [])).push(r);

  const perModelSummary = {};
  for (const [modelId, rs] of Object.entries(byModel)) {
    const judged = rs.filter((r) => r.scores);
    const agg = aggregateScores(judged.map((r) => ({ scores: r.scores, overall: r.overall })));
    const divScores = rs.map((r) => r.metrics.diversity.score);
    const citScores = rs.map((r) => r.metrics.citations.score);
    perModelSummary[modelId] = {
      runs: rs.length,
      judged: judged.length,
      failed: rs.length - judged.length,
      judge: agg,
      source_diversity_mean: round3(avg(divScores)),
      citation_coverage_mean: round3(avg(citScores)),
      // Report-shape aggregate (mean/median per dimension) for the tier A/B:
      // only completed answers count, so a failed run doesn't drag words to 0.
      structure: aggregateScores(
        rs.filter((r) => r.ok && r.answer_length > 0).map((r) => ({ scores: r.metrics.structure })),
      ),
    };
  }

  const summary = {
    generated_at: new Date().toISOString(),
    base_url: BASE_URL,
    budget_s: BUDGET_S,
    judge_model: judgeModelId,
    answer_models: answerModels.map((m) => m.id),
    question_count: questions.length,
    per_model: perModelSummary,
    // overall aggregate across ALL runs regardless of model
    overall: aggregateScores(results.filter((r) => r.scores).map((r) => ({ scores: r.scores, overall: r.overall }))),
    // Report-shape aggregate across all completed answers (the tier A/B's
    // comprehensiveness readout: words, h2/h3, tableRows, hasLimitations…).
    structure: aggregateScores(
      results.filter((r) => r.ok && r.answer_length > 0).map((r) => ({ scores: r.metrics.structure })),
    ),
  };
  fs.writeFileSync(path.join(runDir, "_summary.json"), JSON.stringify(summary, null, 2));

  printTable(perModelSummary);
  console.log(`\nResults in ${runDir}`);
  console.log(`Overall judge mean across ${summary.overall.scored} scored runs: ${summary.overall.overall.mean}`);
}

function avg(arr) {
  const a = (arr || []).filter((v) => typeof v === "number" && Number.isFinite(v));
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

function printTable(perModel) {
  const rows = Object.entries(perModel).map(([model, s]) => ({
    model,
    judged: `${s.judged}/${s.runs}`,
    citation: fmt(s.judge.dimensions.citation?.mean),
    coverage: fmt(s.judge.dimensions.coverage?.mean),
    calibration: fmt(s.judge.dimensions.calibration?.mean),
    overall: fmt(s.judge.overall?.mean),
    diversity: fmt(s.source_diversity_mean),
    cite_cov: fmt(s.citation_coverage_mean),
    words: s.structure?.dimensions?.words ? String(Math.round(s.structure.dimensions.words.mean)) : "-",
    h2: fmt(s.structure?.dimensions?.h2?.mean),
    limits: fmt(s.structure?.dimensions?.hasLimitations?.mean),
  }));
  const cols = ["model", "judged", "citation", "coverage", "calibration", "overall", "diversity", "cite_cov", "words", "h2", "limits"];
  const width = {};
  for (const c of cols) width[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
  const line = (r) => cols.map((c) => String(r[c]).padEnd(width[c])).join("  ");
  console.log("\n" + line(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(cols.map((c) => "-".repeat(width[c])).join("  "));
  for (const r of rows) console.log(line(r));
}
function fmt(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "-";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
