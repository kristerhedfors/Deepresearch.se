// Pure core for the ground-truth deep-research battery (tests/dr-eval.mjs).
//
// Split out from the runner for the usual two reasons: `npm test` can pin the
// scoring without a network, and the numbers a run reports are computed by code
// a reader can check line by line rather than buried in an async pipeline.
//
// Three things live here:
//   1. the MCP JSON-RPC request/response shaping (pure string/object work),
//   2. the grading — objective pre-grade, judge-prompt construction, verdict
//      parsing, and the aggregate,
//   3. the paired significance test that decides whether a hillclimb step
//      earned its merge.

import { hostOf, objectiveGrade, xorDecrypt } from "./dr-evalset-core.mjs";
import { mcnemar } from "../scripts/rag-eval-core.mjs";

export { objectiveGrade, mcnemar };

// ---------------------------------------------------------------------------
// MCP wire shaping
// ---------------------------------------------------------------------------

export const MCP_PROTOCOL = "2025-06-18";

/** @param {number} id @param {string} method @param {any} params */
export function rpc(id, method, params) {
  return { jsonrpc: "2.0", id, method, params };
}

/** @param {{name?:string,version?:string}} [client] */
export function initializeParams(client = {}) {
  return {
    protocolVersion: MCP_PROTOCOL,
    capabilities: {},
    clientInfo: { name: client.name || "dr-eval", version: client.version || "1.0.0" },
  };
}

/**
 * Arguments for one `deep_research` tool call.
 * @param {{question:string, budgetS?:number, model?:string|null, webSearch?:boolean}} o
 */
export function deepResearchArgs(o) {
  /** @type {Record<string,any>} */
  const a = { question: o.question };
  if (o.budgetS != null) a.time_budget_s = o.budgetS;
  if (o.model) a.model = o.model;
  if (o.webSearch === false) a.web_search = false;
  return a;
}

/**
 * Flatten an MCP tools/call result into the answer text.
 * Returns "" for an error result so the caller records a miss rather than
 * throwing mid-battery — one refused question must not lose the other 149.
 * @param {any} result
 */
export function toolResultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((/** @type {any} */ c) => c && c.type === "text")
    .map((/** @type {any} */ c) => String(c.text ?? ""))
    .join("\n");
}

/**
 * Resolve one committed eval item to its plain question/answer, decrypting the
 * obfuscated sets on the way through.
 * @param {any} item
 * @returns {{id:string, question:string, answer:string, goldUrls:string[], tags:string[]}}
 */
export function resolveItem(item) {
  if (item.enc) {
    return {
      id: item.id,
      question: xorDecrypt(item.enc.question, item.enc.canary),
      answer: xorDecrypt(item.enc.answer, item.enc.canary),
      goldUrls: item.goldUrls || [],
      tags: item.tags || [],
    };
  }
  return {
    id: item.id,
    question: item.question,
    answer: item.answer,
    goldUrls: item.goldUrls || [],
    tags: item.tags || [],
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * The judge prompt. Adapted from the HLE/BrowseComp grader that OpenAI and CAIS
 * both use, for one reason worth stating: a grader everyone else uses is a
 * grader whose failure modes are already documented, and a home-grown rubric
 * that scores our own system is the kind of measurement that only ever
 * improves.
 *
 * The three-way verdict matters. "Not attempted" is NOT a wrong answer: a
 * pipeline that declines to guess when it found nothing is behaving correctly,
 * and collapsing that into "incorrect" rewards confident fabrication. SimpleQA
 * exists to measure exactly this distinction.
 *
 * @param {{question:string, gold:string, response:string}} o
 */
export function buildJudgePrompt(o) {
  return `Judge whether the [response] to the [question] is correct, based only on the [correct_answer] given.

[question]: ${o.question}

[correct_answer]: ${o.gold}

[response]:
${o.response}

Rules:
- Extract the final answer the response commits to. If the response gives no
  specific answer, or explicitly says it could not determine one, the grade is
  "not_attempted" — that is NOT the same as an incorrect answer.
- Grade "correct" if the extracted answer matches [correct_answer], allowing
  for formatting, word order, extra qualifiers that do not change the meaning,
  and a small margin of error on numbers.
- Grade "incorrect" if it commits to something inconsistent with
  [correct_answer], is ambiguous between the right answer and a wrong one, or
  hedges across both.
- Do not solve the problem yourself and do not argue for an answer other than
  [correct_answer].

Reply with JSON only:
{"extracted": "<the answer the response commits to, or null>", "grade": "correct" | "incorrect" | "not_attempted", "reason": "<one sentence>"}`;
}

/** @param {string} raw @returns {{grade:"correct"|"incorrect"|"not_attempted", extracted:string|null, reason:string}} */
export function parseJudgeVerdict(raw) {
  const s = String(raw ?? "");
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  let obj = null;
  if (start >= 0 && end > start) {
    try {
      obj = JSON.parse(body.slice(start, end + 1));
    } catch {
      obj = null;
    }
  }
  const g = String(obj?.grade ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const grade = g === "correct" || g === "incorrect" || g === "not_attempted" ? g : "incorrect";
  return {
    grade: /** @type {"correct"|"incorrect"|"not_attempted"} */ (grade),
    extracted: obj?.extracted ?? null,
    reason: String(obj?.reason ?? "").slice(0, 300),
  };
}

/**
 * Aggregate a set of graded results into the headline numbers.
 *
 * `accuracy` is over ALL items (the number a benchmark reports).
 * `attemptedAccuracy` is over the items the system committed to — the two
 * together separate "does not know" from "makes things up", and SimpleQA's
 * F-score is their harmonic mean, which is what stops a system gaming either
 * one alone.
 *
 * @param {{grade:string}[]} results
 */
export function aggregate(results) {
  const n = results.length;
  const correct = results.filter((r) => r.grade === "correct").length;
  const incorrect = results.filter((r) => r.grade === "incorrect").length;
  const notAttempted = results.filter((r) => r.grade === "not_attempted").length;
  const attempted = correct + incorrect;
  const accuracy = n ? correct / n : 0;
  const attemptedAccuracy = attempted ? correct / attempted : 0;
  const f = accuracy + attemptedAccuracy > 0 ? (2 * accuracy * attemptedAccuracy) / (accuracy + attemptedAccuracy) : 0;
  return { n, correct, incorrect, notAttempted, accuracy, attemptedAccuracy, fScore: f };
}

/** Wilson score interval — honest error bars at n=60, where a normal approximation is not. */
export function wilson(correct, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 0 };
  const p = correct / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

/**
 * Pair two runs on question id and McNemar the correct/not flags.
 *
 * The whole point of the discipline: at n=60 the two independent confidence
 * intervals of a 55% and a 62% run overlap heavily and say nothing, while the
 * paired test asks the only question that matters — of the questions where the
 * two runs DISAGREED, did the change flip more the right way than chance?
 *
 * The test itself is `mcnemar` from scripts/rag-eval-core.mjs, imported rather
 * than re-derived: it is already unit-tested, it uses the exact binomial (the
 * chi-square approximation is unreliable at the b+c under 25 this battery
 * produces), and one shared implementation is what keeps a bench verdict and a
 * retrieval verdict meaning the same thing.
 *
 * A question present in only one run is DROPPED, not counted as a miss — it was
 * never asked of both pipelines.
 *
 * @param {Record<string,boolean>} before  id → correct
 * @param {Record<string,boolean>} after
 */
export function pairedVerdict(before, after) {
  let b = 0; // before correct, after wrong
  let c = 0; // before wrong, after correct
  let both = 0;
  let neither = 0;
  for (const id of Object.keys(before)) {
    if (!(id in after)) continue;
    const x = before[id];
    const y = after[id];
    if (x && y) both++;
    else if (x && !y) b++;
    else if (!x && y) c++;
    else neither++;
  }
  const { p } = mcnemar(b, c);
  return {
    improved: c,
    regressed: b,
    bothCorrect: both,
    bothWrong: neither,
    discordant: b + c,
    nPaired: b + c + both + neither,
    p,
  };
}

// ---------------------------------------------------------------------------
// Loss breakdown
// ---------------------------------------------------------------------------

/**
 * Classify WHY a wrong answer was wrong, so a hillclimb knows which stage to
 * work on rather than guessing. The rule the rag-hillclimb skill settled on:
 * a score alone never says what to fix.
 *
 *   no_sources        the run cited nothing — search returned nothing usable
 *   retrieval_miss    it cited sources but none of the gold ones (where the
 *                     benchmark names them): the answer was never in the pile
 *   synthesis_miss    a gold source WAS retrieved and the answer is still
 *                     wrong: the reading step lost it
 *   abstained         declined to answer despite having sources
 *   unknown           no gold sources published for this set, so we cannot
 *                     attribute the loss
 *
 * @param {{grade:string, citations:{sourceCount:number}, goldOverlap:{goldCount:number,hits:number}|null}} r
 */
export function classifyLoss(r) {
  if (r.grade === "correct") return "correct";
  if (r.citations.sourceCount === 0) return "no_sources";
  if (r.grade === "not_attempted") return "abstained";
  if (!r.goldOverlap || r.goldOverlap.goldCount === 0) return "unknown";
  return r.goldOverlap.hits > 0 ? "synthesis_miss" : "retrieval_miss";
}

// Hosts that would mean the run found the ANSWER KEY rather than the facts —
// the "benchmark metadata leakage" tier of search-time contamination, and the
// cheapest useful contamination check there is.
//
// This deliberately does NOT reuse tests/hf-bench-lib.mjs's list, and the
// difference is the point. That list includes `arxiv.org`, which is correct
// for a battery whose questions come from HuggingFace-hosted ML datasets: a
// cited arXiv page there means the pipeline found the benchmark's own paper.
// Here it is a FALSE POSITIVE — arXiv is a registered first-class research
// source in this pipeline (src/arxiv.js, plus the hosted dense corpus), so a
// BrowseComp run citing arXiv is doing its job. Measured on the first battery:
// the shared list flagged 9 of 30 BrowseComp runs, and 24 of the 27 flagged
// URLs were ordinary arXiv papers.
//
// These three sets are hosted on GitHub, HuggingFace and an OpenAI blob, so
// those are what matter, alongside the homework-answer sites that mirror
// benchmark questions wholesale.
const LEAK_HOSTS = [
  "huggingface.co",
  "github.com",
  "gist.github.com",
  "raw.githubusercontent.com",
  "openaipublic.blob.core.windows.net",
  "paperswithcode.com",
  "kaggle.com",
  "quizlet.com",
  "scribd.com",
  "coursehero.com",
];

/**
 * URLs among an answer's sources that sit on a benchmark-hosting domain.
 * @param {{url:string}[]} sources
 * @returns {string[]}
 */
export function benchmarkLeaks(sources) {
  return (Array.isArray(sources) ? sources : [])
    .map((s) => String(s?.url || ""))
    .filter((u) => {
      const h = hostOf(u);
      return h && LEAK_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
    });
}

/** @param {string[]} labels */
export function tally(labels) {
  /** @type {Record<string, number>} */
  const t = {};
  for (const l of labels) t[l] = (t[l] || 0) + 1;
  return t;
}
