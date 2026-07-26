// CROSS-AGENT STARTER PROMPT EVALUATION. For every starter in
// public/js/starters-data.js it opens a fresh conversation against the live
// /api/chat, sending the starter as the FIRST and only message with that
// agent's mode flags set — which is the whole point: a starter is only ever a
// first message, so evaluating it inside an existing conversation would
// measure something no visitor experiences.
//
// Each run is then judged on the three dimensions starters-core.js defines
// (capability / firstImpression / quality, plus the hard deadEnd flag) and
// folded into one score by starterScore(). The output is a per-agent SHORTLIST
// — the openers we can show a newcomer knowing what they produce — plus the
// rank lines to paste back into starters-data.js.
//
// WHY THIS EXISTS. chat_logs #636 and #637 were real first messages to the
// outrospection agent ("update", "vad finns på feeden?"); both produced an
// honest but empty-handed reply, and #638 was the user saying so. Nothing in
// the test suite could have caught that, because nothing tested the QUESTION.
// This harness does.
//
// Run: BASIC_AUTH_USER=... BASIC_AUTH_PASS=... node tests/starter-eval.mjs
//   STARTER_AGENTS=research,introspection   restrict to specific agents
//   STARTER_IDS=out-feed,res-news-tech      restrict to specific starters
//   STARTER_MODEL=id                        answer model (default: catalog default)
//   STARTER_JUDGE_MODEL=id                  judge model (default: first up model)
//   STARTER_BUDGET_S=90                     time budget per run (default 90)
//   STARTER_CONCURRENCY=2                   parallel runs (default 2)
//   STARTER_LIMIT=5                         first N starters per agent (smoke run)
//
// Results land in ./starter-eval-results/<timestamp>/ (gitignored). Append the
// outcome to tests/STARTER-EVAL-FINDINGS.md — that ledger is what a `rank` in
// starters-data.js cites as its evidence.
//
// NOTE (same rule as model-eval / eval-bench): don't deploy or push
// mid-battery — a Cloudflare auto-deploy truncates in-flight streams and
// poisons the results.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STARTERS, agentIds, resolveQueue, starterJudgePrompt, parseJudgeReply,
  starterScore, rankStarters, SHORTLIST_FLOOR,
} from "../src/starters.js";

const BASE_URL = process.env.BASE_URL || "https://deepresearch.se";
const USER = process.env.BASIC_AUTH_USER;
const PASS = process.env.BASIC_AUTH_PASS;
if (!USER || !PASS) {
  console.error("Set BASIC_AUTH_USER and BASIC_AUTH_PASS (break-glass credentials).");
  process.exit(1);
}
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const BUDGET_S = Number(process.env.STARTER_BUDGET_S || 90);
const CONCURRENCY = Number(process.env.STARTER_CONCURRENCY || 2);
const LIMIT = Number(process.env.STARTER_LIMIT || 0);
const ONLY_AGENTS = process.env.STARTER_AGENTS?.split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_IDS = process.env.STARTER_IDS?.split(",").map((s) => s.trim()).filter(Boolean);
const MODEL_ENV = process.env.STARTER_MODEL?.trim() || null;
const JUDGE_ENV = process.env.STARTER_JUDGE_MODEL?.trim() || null;

// ---------------------------------------------------------------------------
// How each agent is DRIVEN, and what "using its capability" means for it.
//
// `flags` are the /api/chat body fields that select the mode (src/chat.js).
// `expect` is handed to the judge so "did it exercise its capability" is
// scored against what this agent is actually for, rather than against a
// generic idea of a good answer.
//
// `runnable: false` marks an agent this harness structurally CANNOT drive, with
// the reason. Both cases are real rather than laziness: the Se/cure agent runs
// browser-direct on the user's own key with the server in no data path, so
// there is no server endpoint to evaluate it through, and the
// under-construction archetype is a copy-me template bound to no deployed
// surface. They are reported as skipped, loudly — a battery that silently
// covered 5 of 7 agents would read as full coverage.
// ---------------------------------------------------------------------------
const AGENT_RUNS = {
  research: {
    runnable: true,
    flags: { web_search: true, developer_mode: false },
    expect:
      "Run the deep-research pipeline: search the web across several rounds, and answer from numbered sources it actually retrieved. A confident answer with zero searches and zero sources has not used this agent's capability.",
  },
  introspection: {
    runnable: true,
    flags: { web_search: false, developer_mode: true },
    expect:
      "Answer from this site's OWN deployed source code and documentation, quoting real code and citing real file paths. A plausible architectural essay that cites no file has not used this agent's capability.",
  },
  orchestrator: {
    runnable: true,
    flags: { web_search: true, orchestrator_mode: true },
    expect:
      "Decompose the request into a team of sub-agents, run them in parallel waves, and merge their findings into one answer. A single-threaded answer with no visible workflow has not used this agent's capability.",
  },
  outrospection: {
    runnable: true,
    flags: { web_search: true, outrospection_mode: true },
    expect:
      "Answer from the outward feed — what everyone ELSE shipped — routing the question to one of the seven standing lenses and citing entries from that feed. An answer that only explains how the feed works, or admits it found nothing, has not used this agent's capability.",
  },
  "agent-builder": {
    runnable: true,
    flags: { web_search: false, sdk_mode: true },
    expect:
      "Actually BUILD something: produce the files for a working agent or app and publish it to a live URL. Asking the user a clarifying question, or describing what it would build, is the specific failure this agent is judged on.",
  },
  secure: {
    runnable: false,
    reason:
      "the Se/cure tier runs browser-direct with the server in no data path — there is no server endpoint to drive it through. Evaluate its queue from a browser session against /cure.",
  },
  "under-construction": {
    runnable: false,
    reason:
      "a copy-me archetype bound to no deployed surface; its starters shape a new agent rather than exercising a running one.",
  },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "starter-eval-results", new Date().toISOString().replace(/[:.]/g, "-"));

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
}

async function fetchModels() {
  const res = await fetch(`${BASE_URL}/api/models`, { headers: { authorization: AUTH } });
  if (!res.ok) throw new Error(`GET /api/models failed: ${res.status}`);
  const data = await res.json();
  return data.models.filter((m) => m.up !== false);
}

/**
 * One /api/chat call. Same SSE parse as eval-bench.mjs / model-eval.mjs, with
 * the per-agent mode flags merged into the body. Returns the same shape
 * whether it completed, errored or timed out — a starter whose run FAILS is a
 * result (a bad starter), not an exception to abort the battery on.
 */
async function postOnce(modelId, messages, { flags = {}, budgetS = BUDGET_S } = {}) {
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
      body: JSON.stringify({
        messages,
        model: modelId,
        time_budget_s: budgetS,
        // incognito: a battery of 150 synthetic starters would otherwise
        // dominate chat_logs and drown the real user traffic the loop reads.
        incognito: true,
        ...flags,
      }),
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
    for (;;) {
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

/**
 * The observable trace of a run, as the judge sees it. This is what makes
 * "did the agent exercise its capability" answerable at all: prose alone
 * cannot distinguish an introspection answer retrieved from source from one
 * confabulated about it.
 *
 * The `steps` timeline is the load-bearing half and was added after the first
 * battery got it wrong. Only the research pipeline reports through
 * search/search_done events; introspection retrieves source excerpts and
 * outrospection reads the outward feed, both of which surface as step_done
 * labels and neither of which touches the search counters. Judging those two
 * on counters alone scored a run that had read 24 feed items as fabricated
 * (run 2026-07-26T07-29-27Z, both outrospection starters at 1.35). The step
 * labels are the agent's own account of what it did, so they go to the judge
 * verbatim rather than being compressed into a number that only fits one mode.
 */
function traceOf(run) {
  const events = run.events || [];
  const urls = new Set();
  const steps = [];
  let rounds = 0;
  let searches = 0;
  let tools = 0;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "round" || e.type === "round_start") rounds++;
    if (e.type === "search" || e.type === "search_done") searches++;
    if (e.type === "tool" || e.type === "tool_call" || e.type === "agent_update") tools++;
    if (Array.isArray(e.sources)) for (const s of e.sources) if (s?.url) urls.add(s.url);
    // step_done carries the phase's outcome ("Introspection: 6 relevant source
    // excerpts", "24 items"); step_start alone only says a phase began, so it
    // is recorded without a label to keep the timeline honest about phases
    // that started and never reported.
    if (e.type === "step_done") steps.push(`${e.id || "step"}: ${e.label || "done"}`);
    else if (e.type === "done") {
      rounds = Number.isFinite(e.rounds) ? e.rounds : rounds;
      searches = Number.isFinite(e.searches) ? e.searches : searches;
    }
  }
  return {
    rounds: rounds || (searches ? 1 : 0),
    searches,
    sources: urls.size,
    tools,
    ms: run.duration_ms,
    events: events.length,
    steps,
  };
}

/** Judge one run. A judge that cannot be parsed drops THIS result only. */
async function judge(judgeModelId, starter, agentMeta, run) {
  const prompt = starterJudgePrompt(starter, agentMeta, run.text, traceOf(run));
  const r = await postOnce(judgeModelId, [{ role: "user", content: prompt }], {
    flags: { web_search: false, developer_mode: false },
    budgetS: 45,
  });
  const parsed = parseJudgeReply(r.text);
  if (!parsed) return { ok: false, error: "judge JSON parse failed", raw: (r.text || "").slice(0, 600), request_id: r.request_id };
  return { ok: true, request_id: r.request_id, ...parsed };
}

/** Run + judge one starter. */
async function runOne(modelId, judgeModelId, agent, agentMeta, starter) {
  const cfg = AGENT_RUNS[agent];
  const run = await postOnce(modelId, [{ role: "user", content: starter.text }], {
    flags: cfg.flags,
    budgetS: BUDGET_S,
  });
  const trace = traceOf(run);

  // A run that never produced an answer is a dead end by definition — no need
  // to spend a judge call to learn that an error page is a bad opener.
  if (!run.ok || !run.text.trim()) {
    const verdict = {
      capability: 1,
      quality: 1,
      firstImpression: 1,
      deadEnd: true,
      notes: `run failed: ${run.error || run.stream_error || `HTTP ${run.http_status}`}`,
    };
    return { starter, agent, run: { ...run, text: run.text.slice(0, 4000) }, trace, verdict, score: starterScore(verdict) };
  }

  const verdict = await judge(judgeModelId, starter, agentMeta, run);
  if (!verdict.ok) {
    return { starter, agent, run: { ...run, text: run.text.slice(0, 4000) }, trace, verdict: null, score: null, judge_error: verdict.error };
  }
  return {
    starter,
    agent,
    run: { ...run, text: run.text.slice(0, 4000) },
    trace,
    verdict,
    score: starterScore(verdict),
  };
}

/** Bounded-concurrency map — the site is live and shared; do not stampede it. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const models = await fetchModels();
  const modelId = MODEL_ENV || models[0]?.id;
  const judgeModelId = JUDGE_ENV || models[0]?.id;
  if (!modelId) throw new Error("no models available");

  const agentsRegistry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sdk", "AGENTS.json"), "utf8"));
  const metaFor = (id) => agentsRegistry.agents.find((a) => a.id === id) || { id, name: id };

  const targets = agentIds(STARTERS).filter((a) => !ONLY_AGENTS || ONLY_AGENTS.includes(a));
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Starter evaluation — answer model ${modelId}, judge ${judgeModelId}, budget ${BUDGET_S}s, concurrency ${CONCURRENCY}`);
  console.log(`Base: ${BASE_URL}\nOut:  ${OUT_DIR}\n`);

  const summary = { started: new Date().toISOString(), base_url: BASE_URL, model: modelId, judge_model: judgeModelId, agents: {}, skipped: {} };

  for (const agent of targets) {
    const cfg = AGENT_RUNS[agent];
    if (!cfg || !cfg.runnable) {
      // Loud, not silent: a skipped agent is stated in the console AND in the
      // summary, so nobody reads this battery as full coverage.
      console.log(`SKIP ${agent} — ${cfg?.reason || "no run configuration"}\n`);
      summary.skipped[agent] = cfg?.reason || "no run configuration";
      continue;
    }

    let queue = resolveQueue(STARTERS, agent);
    if (ONLY_IDS) queue = queue.filter((e) => ONLY_IDS.includes(e.id));
    if (LIMIT > 0) queue = queue.slice(0, LIMIT);
    if (!queue.length) continue;

    const meta = { ...metaFor(agent), expect: cfg.expect };
    console.log(`── ${agent}: ${queue.length} starters ──`);

    const results = await mapLimit(queue, CONCURRENCY, async (starter) => {
      const r = await runOne(modelId, judgeModelId, agent, meta, starter);
      const mark = r.score === null ? "  ?  " : r.score.toFixed(2);
      const flag = r.verdict?.deadEnd ? " DEAD-END" : "";
      console.log(`  ${mark}  ${starter.id.padEnd(24)} ${r.trace.searches}s/${r.trace.sources}src/${r.trace.steps.length}step${flag}`);
      fs.writeFileSync(path.join(OUT_DIR, `${agent}--${slug(starter.id)}.json`), JSON.stringify(r, null, 2));
      return r;
    });

    // The ranked table + shortlist for this agent.
    const judged = {};
    for (const r of results) if (r.verdict) judged[r.starter.id] = r.verdict;
    const ranked = rankStarters(queue, judged);
    const shortlist = ranked.filter((e) => e.shortlisted);

    summary.agents[agent] = {
      total: queue.length,
      judged: Object.keys(judged).length,
      dead_ends: results.filter((r) => r.verdict?.deadEnd).length,
      mean: ranked.filter((e) => e.score !== null).reduce((a, e, _, arr) => a + e.score / arr.length, 0) || null,
      shortlist: shortlist.map((e) => ({ id: e.id, score: e.score, aspect: e.aspect, text: e.text })),
      ranked: ranked.map((e) => ({ id: e.id, score: e.score, deadEnd: e.deadEnd || false, notes: e.notes || "" })),
    };

    console.log(`  → ${shortlist.length}/${queue.length} above the shortlist floor (${SHORTLIST_FLOOR})\n`);
  }

  summary.finished = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, "_summary.json"), JSON.stringify(summary, null, 2));

  // ---- the deliverable: what to paste back into starters-data.js ----------
  const runId = path.basename(OUT_DIR);
  console.log("\n================ SHORTLIST ================\n");
  for (const [agent, a] of Object.entries(summary.agents)) {
    console.log(`${agent} — mean ${a.mean ? a.mean.toFixed(2) : "n/a"}, ${a.dead_ends} dead end(s)`);
    for (const s of a.shortlist) {
      console.log(`  ${s.score.toFixed(2)}  ${s.id}`);
      console.log(`        rank: ${s.score}, evidence: "${runId}"`);
    }
    if (!a.shortlist.length) console.log("  (nothing cleared the floor — the queue needs better openers, not better ranks)");
    console.log("");
  }
  if (Object.keys(summary.skipped).length) {
    console.log("SKIPPED AGENTS (not covered by this battery):");
    for (const [a, why] of Object.entries(summary.skipped)) console.log(`  ${a}: ${why}`);
    console.log("");
  }
  console.log(`Full results: ${OUT_DIR}`);
  console.log(`Record this run in tests/STARTER-EVAL-FINDINGS.md as ${runId} before promoting any rank.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
