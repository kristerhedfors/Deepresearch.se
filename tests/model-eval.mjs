// Runs the deep-research pipeline against every "up" Berget model with a
// fixed battery of research queries, to find model-specific behavior
// differences (JSON-mode reliability, leaked tool-call-shaped tokens,
// citation adherence, etc). Hits the LIVE site directly via break-glass
// Basic Auth — real Berget/Exa cost, recorded under the admin usage row.
// Not a pass/fail test suite (see ./e2e/ for that) — a data-collection
// sweep; results are read and analyzed by hand afterward.
//
// Run: BASIC_AUTH_USER=... BASIC_AUTH_PASS=... node model-eval.mjs
// Results land in ./model-eval-results/<run-timestamp>/ (gitignored).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = process.env.BASE_URL || "https://deepresearch.se";
const USER = process.env.BASIC_AUTH_USER;
const PASS = process.env.BASIC_AUTH_PASS;
if (!USER || !PASS) {
  console.error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const BUDGET_S = Number(process.env.EVAL_BUDGET_S || 60);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 3);
// Only these models when set (comma-separated ids) — for a targeted re-run.
const ONLY_MODELS = process.env.EVAL_MODELS?.split(",").map((s) => s.trim()).filter(Boolean);

const QUERIES = [
  { key: "factual", text: "What is the latest stable version of Node.js and when was it released?" },
  { key: "comparison", text: "Compare the trade-offs between Server-Sent Events and WebSockets for streaming LLM responses in a web app." },
  { key: "vague", text: "How does it compare to the alternatives?" },
  { key: "narrow", text: "What are Berget.ai's documented rate limits and maximum request body size for the chat completions API?" },
  { key: "direct", text: "Explain what an exponentially weighted moving average is, in one paragraph." },
];

// Heuristic scan for the historical failure class (tool-call-shaped tokens
// leaking into a synthesized answer, or raw JSON leaking into prose) plus
// other coarse quality signals. NOT a full analysis — just enough to flag
// which runs deserve a closer look (e.g. a Workers Logs pull).
const SUSPECT_PATTERNS = [
  ["tool_call_tag", /<\s*\|?\s*tool_call/i],
  ["function_call_literal", /function_call\s*\{/i],
  ["raw_web_search_call", /\bweb_search\s*\{\s*"query"/i],
  ["leaked_triage_json", /^\s*\{\s*"(action|complete|verdict)"\s*:/m],
  ["markdown_fence_leak", /```json/i],
];

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

async function fetchModels() {
  const res = await fetch(`${BASE_URL}/api/models`, { headers: { authorization: AUTH } });
  if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
  const data = await res.json();
  let models = data.models.filter((m) => m.up !== false);
  if (ONLY_MODELS?.length) models = models.filter((m) => ONLY_MODELS.includes(m.id));
  return models;
}

async function runOne(model, query) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BUDGET_S * 1.15 * 1000 + 30_000);
  // Captured outside the try block so a mid-stream abort (the common case —
  // headers arrive immediately since /api/chat returns its Response before
  // the pipeline even starts, per src/chat.js) still reports which request
  // hung, instead of silently dropping it in the catch block.
  let requestId = null;
  const events = [];
  let text = "";
  let streamError = null;
  let doneStats = null;
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: query.text }],
        model: model.id,
        web_search: true,
        time_budget_s: BUDGET_S,
      }),
      signal: controller.signal,
    });
    requestId = res.headers.get("x-request-id");
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      return {
        model: model.id, query: query.key, request_id: requestId,
        ok: false, http_status: res.status, error: detail.slice(0, 500),
        duration_ms: Date.now() - startedAt,
      };
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

    const suspects = SUSPECT_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
    return {
      model: model.id, query: query.key, request_id: requestId,
      ok: !streamError, stream_error: streamError,
      duration_ms: Date.now() - startedAt,
      answer_length: text.length,
      answer_preview: text.slice(0, 500),
      events: events.map((e) => ({ type: e.type, id: e.id, label: e.label })),
      done_stats: doneStats,
      suspect_patterns: suspects,
      full_answer: text,
    };
  } catch (err) {
    // Report whatever arrived before the abort — request_id and the last
    // events seen tell us WHICH PHASE it hung in, which "client-side
    // timeout" alone does not.
    return {
      model: model.id, query: query.key, request_id: requestId,
      ok: false,
      error: err.name === "AbortError" ? "client-side timeout" : err.message,
      duration_ms: Date.now() - startedAt,
      answer_length: text.length,
      answer_preview: text.slice(0, 500),
      events: events.map((e) => ({ type: e.type, id: e.id, label: e.label })),
      last_event: events.at(-1) || null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Simple fixed-concurrency pool — keep production load bounded and
// predictable rather than firing everything at once.
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

async function main() {
  const models = await fetchModels();
  const jobs = models.flatMap((model) => QUERIES.map((query) => ({ model, query })));
  console.log(
    `Evaluating ${models.length} up model(s) × ${QUERIES.length} queries = ${jobs.length} runs, ` +
    `budget ${BUDGET_S}s each, concurrency ${CONCURRENCY}.`,
  );
  console.log(models.map((m) => m.id).join("\n"));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const runDir = path.join(here, "model-eval-results", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(runDir, { recursive: true });

  let completed = 0;
  const results = await pool(jobs, CONCURRENCY, async ({ model, query }) => {
    const result = await runOne(model, query);
    completed++;
    const status = result.ok
      ? `ok (${result.duration_ms}ms, ${result.answer_length} chars${result.suspect_patterns?.length ? ", SUSPECT: " + result.suspect_patterns.join(",") : ""})`
      : `FAIL: ${result.error || result.stream_error}`;
    console.log(`[${completed}/${jobs.length}] ${model.id} :: ${query.key} -> ${status}`);
    fs.writeFileSync(
      path.join(runDir, `${slug(model.id)}__${query.key}.json`),
      JSON.stringify(result, null, 2),
    );
    return {
      model: model.id, query: query.key, ok: result.ok, request_id: result.request_id,
      duration_ms: result.duration_ms, answer_length: result.answer_length,
      suspect_patterns: result.suspect_patterns || [], error: result.error || result.stream_error || null,
    };
  });

  fs.writeFileSync(path.join(runDir, "_summary.json"), JSON.stringify(results, null, 2));
  const issues = results.filter((r) => !r.ok || r.suspect_patterns.length);
  console.log(`\nDone. Results in ${runDir}`);
  console.log(`Runs with issues: ${issues.length} / ${results.length}`);
  for (const r of issues) {
    console.log(`  - ${r.model} :: ${r.query} — ${r.ok ? "suspects: " + r.suspect_patterns.join(",") : "error: " + r.error}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
