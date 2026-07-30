// Probe (not a committed test): re-judge ARCHIVED answers with TODAY's judge.
//
// The bench gate has read REGRESSION on five consecutive runs while every
// per-question mean stayed flat between those runs — a broad, uniform drop
// against a baseline recorded 2026-07-23, not a step at any one commit. Two
// hypotheses fit that shape and only one of them is a code regression:
//
//   A. the ANSWERS got worse (pipeline / search / budget), or
//   B. the JUDGE got stricter (Berget re-pointed the model id at a new
//      checkpoint, or serving changed underneath it).
//
// This discriminates them without deploying anything. It replays the stored
// answer text and stored sources — byte-identical inputs to what the judge saw
// on the day — and asks today's judge to score them again. If the same answer
// now scores lower, the judge moved and the "regression" is measurement drift.
// If it scores the same, the drop is real and lives in the answers.
//
//   node rejudge-probe.mjs <archived-run-dir> [reps]
import fs from "node:fs";
import path from "node:path";
import { buildJudgePrompt } from "./bench-score.mjs";
import { BENCH_QUESTIONS as QUESTIONS } from "./bench-questions.mjs";

const BASE_URL = process.env.BASE_URL || "https://deepresearch.se";
const AUTH = "Basic " + Buffer.from(`${process.env.BASIC_AUTH_USER}:${process.env.BASIC_AUTH_PASS}`).toString("base64");
const JUDGE = process.env.GATE_JUDGE || "mistralai/Mistral-Small-3.2-24B-Instruct-2506";

async function ask(prompt) {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      model: JUDGE, web_search: false, time_budget_s: 45, chat_mode: "normal",
    }),
  });
  if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try {
        const c = JSON.parse(d);
        const delta = c.choices?.[0]?.delta?.content;
        if (delta) text += delta;
      } catch { /* partial frame */ }
    }
  }
  return { ok: true, text };
}

function extractJson(s) {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

const dir = process.argv[2];
const reps = Number(process.argv[3] || 3);
const rows = [];

for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json") || f === "_summary.json") continue;
  const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  if (!rec.scores || !rec.answer) continue;
  const q = QUESTIONS.find((x) => x.id === rec.id);
  if (!q) continue;
  const prompt = buildJudgePrompt({ question: rec.question, rubric: q.rubric, answer: rec.answer, sources: rec.sources || [] });
  const then = (rec.scores.citation + rec.scores.coverage + rec.scores.calibration) / 3;
  const now = [];
  for (let i = 0; i < reps; i++) {
    const r = await ask(prompt);
    const p = r.ok ? extractJson(r.text) : null;
    if (!p) { now.push(null); continue; }
    const trio = [p.citation, p.coverage, p.calibration].map(Number);
    if (trio.some((v) => !Number.isFinite(v))) { now.push(null); continue; }
    now.push(trio.reduce((a, b) => a + b, 0) / 3);
  }
  const good = now.filter((v) => v !== null);
  const mean = good.length ? good.reduce((a, b) => a + b, 0) / good.length : null;
  rows.push({ id: rec.id, then: +then.toFixed(3), now: mean === null ? null : +mean.toFixed(3), samples: now });
  console.log(`${rec.id.padEnd(26)} then ${then.toFixed(2)}  now ${mean === null ? "n/a" : mean.toFixed(2)}  [${now.join(", ")}]`);
}

const paired = rows.filter((r) => r.now !== null);
if (paired.length) {
  const d = paired.reduce((a, r) => a + (r.now - r.then), 0) / paired.length;
  console.log(`\nmean shift on IDENTICAL answers: ${d >= 0 ? "+" : ""}${d.toFixed(3)} across ${paired.length} questions`);
  console.log(d < -0.3
    ? "→ the JUDGE moved: the same text scores lower today. The gate's delta is measurement drift, not a code regression."
    : Math.abs(d) <= 0.3
      ? "→ the judge is STABLE on identical text. The drop lives in the answers, not the scoring."
      : "→ the judge scores identical text HIGHER today, which does not explain the gate's delta.");
}
