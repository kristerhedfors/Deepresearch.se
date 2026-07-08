// The inline-quiz capability's PURE logic: detecting that the user asked to
// be quizzed, hardening the quiz-generation JSON into the shape the client
// renders, and validating/normalizing the free-text grading exchange. All
// deterministic and dependency-free so the Node unit suite exercises it
// directly (src/quiz.test.js); the pipeline phase lives in src/pipeline.js
// (runQuizGeneration) and the grading HTTP handler in src/quiz-api.js.
//
// The capability: "quiz me on <topic/this document>" turns the answer into
// an interactive quiz — the pipeline emits one `quiz` status event carrying
// the full question set (alternatives, the correct index, explanations) and
// the client (public/js/quiz.js) runs the whole interaction locally: one
// question at a time, 2-6 alternatives PLUS a free-text field, immediate
// feedback, and a final score verdict. Multiple-choice picks grade locally
// (the payload carries the key — this is a self-study tool, not an exam);
// free-text answers grade via POST /api/quiz/grade. Material comes from
// whatever the pipeline already has in front of it: the conversation
// (attached documents, project materials, RAG excerpts all ride inside it)
// plus the web-search source registry when triage chose research.

// How many questions when the request doesn't say ("quiz me on X").
export const DEFAULT_QUIZ_QUESTIONS = 5;
// Hard caps: a quiz is a focused exercise, not a question dump; and the
// grading endpoint reuses MAX_QUIZ_QUESTIONS as its per-request item cap.
export const MAX_QUIZ_QUESTIONS = 12;
export const MAX_QUIZ_ALTERNATIVES = 6;

// ---- intent ------------------------------------------------------------

// Whether the latest user message asks to be quizzed, and for how many
// questions. Returns { questions } or null. Deterministic (same pattern as
// hf.js's hfIntent — no model call), so an ordinary question can never
// accidentally become a quiz, and phrased-as-a-request patterns are required:
// bare mentions ("what is a pub quiz?") don't trigger. English + Swedish,
// matching the user base of the rest of the intent gates.
const QUIZ_REQUEST_PATTERNS = [
  /\b(?:quiz|quizza|förhör|grill|test|testa)\s+(?:me|mig|us|oss)\b/i, // "quiz me", "förhör mig", "testa mig"
  /\b(?:make|create|generate|build|prepare|start|run|give\s+me|skapa|gör|bygg|ge\s+mig|kör|starta)\b[^.?!\n]{0,60}?\b(?:quiz|kunskapstest|förhör)\b/i,
  /\btest(?:a)?\s+(?:my|our|mina|min|våra)\s+(?:knowledge|kunskap(?:er)?)\b/i,
  /^\s*quiz\b/i, // "quiz: chapter 3", "quiz om Frankrike"
];

// "with 8 questions" / "med 8 frågor" / "10 q" — the requested length.
const QUESTION_COUNT_RE = /(\d{1,2})\s*(?:questions?|frågor|fråga|q\b)/i;

export function quizIntent(text) {
  const s = String(text || "");
  if (!QUIZ_REQUEST_PATTERNS.some((re) => re.test(s))) return null;
  const m = s.match(QUESTION_COUNT_RE);
  const n = m ? Number(m[1]) : DEFAULT_QUIZ_QUESTIONS;
  return { questions: Math.min(MAX_QUIZ_QUESTIONS, Math.max(1, n || DEFAULT_QUIZ_QUESTIONS)) };
}

// ---- quiz JSON hardening -------------------------------------------------

const clip = (v, max) => String(v ?? "").trim().slice(0, max);

// Hardens the raw quiz-generation JSON into exactly what the client renders,
// or null when nothing usable came back (the pipeline then falls through to
// a normal answer — fail-soft, never an error). Lenient by design: junk
// questions are dropped rather than failing the set; `correct` may be the
// 0-based index OR the correct alternative's text (models mix these up);
// alternatives are deduped and capped; every string is trimmed and clipped.
export function normalizeQuiz(value, maxQuestions = MAX_QUIZ_QUESTIONS) {
  const list = Array.isArray(value?.questions) ? value.questions : [];
  const cap = Math.min(MAX_QUIZ_QUESTIONS, Math.max(1, maxQuestions || MAX_QUIZ_QUESTIONS));
  const questions = [];
  for (const raw of list) {
    const q = normalizeQuestion(raw);
    if (q) questions.push(q);
    if (questions.length >= cap) break;
  }
  if (!questions.length) return null;
  const title = clip(value.title, 120) || "Quiz";
  const intro =
    clip(value.intro, 600) ||
    `**${title}** — ${questions.length} question${questions.length === 1 ? "" : "s"}. ` +
      "Answer each one below; you'll get your score at the end.";
  return { title, intro, questions };
}

function normalizeQuestion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const question = clip(raw.question ?? raw.q, 500);
  if (!question) return null;
  const seen = new Set();
  const alternatives = [];
  for (const a of Array.isArray(raw.alternatives) ? raw.alternatives : []) {
    const alt = clip(a, 300);
    const key = alt.toLowerCase();
    if (!alt || seen.has(key)) continue;
    seen.add(key);
    alternatives.push(alt);
    if (alternatives.length >= MAX_QUIZ_ALTERNATIVES) break;
  }
  if (alternatives.length < 2) return null;
  const correct = resolveCorrect(raw.correct, alternatives);
  if (correct == null) return null;
  return { question, alternatives, correct, explanation: clip(raw.explanation, 600) };
}

// `correct` as a 0-based index into the DEDUPED alternatives, or as the
// correct alternative's text. For a string, the TEXT match is tried first —
// a numeric answer like "1995" is far more often the alternative itself than
// an index — and only an unmatched all-digit string falls back to being an
// index. Anything else → null (the question is dropped: a quiz question with
// an unknown key is useless).
function resolveCorrect(correct, alternatives) {
  if (typeof correct === "number") {
    return Number.isInteger(correct) && correct >= 0 && correct < alternatives.length ? correct : null;
  }
  if (typeof correct === "string") {
    const s = correct.trim();
    const i = alternatives.findIndex((a) => a.toLowerCase() === s.toLowerCase());
    if (i >= 0) return i;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return n < alternatives.length ? n : null;
    }
  }
  return null;
}

// ---- free-text grading (POST /api/quiz/grade) ------------------------------

const MAX_GRADE_QUESTION_CHARS = 500;
const MAX_GRADE_REFERENCE_CHARS = 300;
const MAX_GRADE_ANSWER_CHARS = 1000;

// Validates the grading request body. Returns { items } or { error } —
// items are the trimmed/clipped {question, reference, answer} triples the
// prompt is built from (reference = the quiz's correct alternative).
export function validateGradeItems(body) {
  const raw = body?.items;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_QUIZ_QUESTIONS) {
    return { error: `Expected 1-${MAX_QUIZ_QUESTIONS} items.` };
  }
  const items = [];
  for (const it of raw) {
    const question = clip(it?.question, MAX_GRADE_QUESTION_CHARS);
    const reference = clip(it?.reference, MAX_GRADE_REFERENCE_CHARS);
    const answer = clip(it?.answer, MAX_GRADE_ANSWER_CHARS);
    if (!question || !reference || !answer) {
      return { error: "Each item needs a non-empty question, reference, and answer." };
    }
    items.push({ question, reference, answer });
  }
  return { items };
}

// Hardens the grading model's JSON into exactly `count` {correct, comment}
// verdicts, or null when the shape is unusable (the client then treats those
// answers as ungraded — fail-soft, never a fabricated verdict). A short or
// junk-padded results array is padded with null entries per item so a
// partial grade never misattributes verdicts across items.
export function normalizeGradeResults(value, count) {
  const list = Array.isArray(value?.results) ? value.results : Array.isArray(value) ? value : null;
  if (!list) return null;
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = list[i];
    out.push(
      r && typeof r === "object" && typeof r.correct === "boolean"
        ? { correct: r.correct, comment: clip(r.comment, 300) }
        : null,
    );
  }
  return out.some((r) => r !== null) ? out : null;
}
