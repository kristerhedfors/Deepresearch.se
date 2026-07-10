// @ts-check
// The inline-quiz turn element: an interactive card the pipeline's `quiz`
// status event renders into the turn body (like the Street View embeds, it
// persists beside the answer rather than collapsing with the activity
// steps). One question at a time — the alternatives as buttons PLUS a
// free-text "answer in your own words" field — with immediate feedback and
// an explanation after each answer, then a final score verdict with a
// per-question recap.
//
// Grading: multiple-choice picks grade locally (the quiz payload carries
// the correct index — this is a self-study tool, not an exam); a free-text
// answer grades via POST /api/quiz/grade (one small JSON call, meaning over
// wording). Grading failures are fail-soft: the answer is marked ungraded,
// shown with the reference answer, and excluded from the score with a
// visible note — never a broken quiz.
//
// State/persistence contract (stream.js owns both sides): `hooks.answers`
// seeds previously given answers (a reloaded conversation resumes, or shows
// the finished recap), `hooks.onAnswer(answers)` fires after every answer
// (recorded into the conversation's embeds registry), and
// `hooks.onComplete(summaryText)` fires once when the last question is
// answered — stream.js appends the summary to the assistant message in
// history so follow-up questions (and the copy-conversation export) carry
// the result, then persists.
//
// The scoring/summary helpers are pure and DOM-free at import time, so the
// Node unit suite (quiz.test.js) exercises them directly — the same
// pattern as rag.js's pure core.

// ---- pure core -------------------------------------------------------------

/**
 * One quiz question as normalizeQuiz (src/quiz.js) guarantees it: the
 * alternatives, the index of the correct one, an optional explanation.
 * @typedef {{question: string, alternatives: string[], correct: number, explanation?: string}} QuizQuestion
 */

/**
 * @typedef {{title?: string, questions?: QuizQuestion[]}} Quiz
 */

/**
 * One answer entry: either {pick: <alternative index>} or
 * {free: <text>, correct: true|false|null, comment} — null `correct` means
 * the grading call failed and the answer counts as ungraded.
 * @typedef {{pick?: number, free?: string, correct?: boolean | null, comment?: string}} QuizAnswer
 */

/**
 * renderQuiz's state/persistence contract (see the module header).
 * @typedef {object} QuizHooks
 * @property {QuizAnswer[]} [answers] previously given answers to resume from
 * @property {(answers: QuizAnswer[]) => void} [onAnswer]
 * @property {(summaryText: string) => void} [onComplete]
 */

/**
 * true | false | null (ungraded) for one answered question.
 * @param {QuizQuestion | undefined} question
 * @param {QuizAnswer | undefined} answer
 * @returns {boolean | null}
 */
export function answerVerdict(question, answer) {
  if (!question || !answer) return null;
  if (typeof answer.pick === "number") return answer.pick === question.correct;
  if (typeof answer.free === "string") return typeof answer.correct === "boolean" ? answer.correct : null;
  return null;
}

/**
 * Score across the answers given so far: `correct` out of `total` questions,
 * with `ungraded` free-text answers excluded from `correct` but counted so
 * the verdict can say so.
 * @param {Quiz | null | undefined} quiz
 * @param {QuizAnswer[] | null | undefined} answers
 * @returns {{correct: number, total: number, ungraded: number}}
 */
export function quizScore(quiz, answers) {
  const qs = quiz?.questions || [];
  let correct = 0;
  let ungraded = 0;
  (answers || []).forEach((a, i) => {
    const v = answerVerdict(qs[i], a);
    if (v === true) correct++;
    else if (v === null && a) ungraded++;
  });
  return { correct, total: qs.length, ungraded };
}

/**
 * @param {Quiz | null | undefined} quiz
 * @param {QuizAnswer[] | null | undefined} answers
 * @returns {boolean}
 */
export function quizDone(quiz, answers) {
  const total = quiz?.questions?.length || 0;
  return total > 0 && (answers || []).length >= total;
}

/**
 * @param {unknown} s
 * @param {number} max
 */
const clip = (s, max) => {
  const t = String(s ?? "").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/**
 * The plain-text result block stream.js appends to the assistant message in
 * history when the quiz completes — model-readable context for follow-ups
 * ("what did I get wrong?") that also rides the copy-conversation export
 * and the reloaded bubble. Deliberately NOT one of the "--- … ---" labeled
 * context blocks: those are stripped by the export/indexing paths, and this
 * one should stay visible everywhere.
 * @param {Quiz | null | undefined} quiz
 * @param {QuizAnswer[] | null | undefined} answers
 * @returns {string}
 */
export function quizSummaryText(quiz, answers) {
  const { correct, total, ungraded } = quizScore(quiz, answers);
  const lines = [
    `[Quiz completed: "${clip(quiz?.title || "Quiz", 80)}" — score ${correct}/${total}` +
      (ungraded ? ` (${ungraded} written answer${ungraded === 1 ? "" : "s"} could not be graded)` : "") +
      "]",
  ];
  (quiz?.questions || []).forEach((q, i) => {
    const a = (answers || [])[i];
    const v = answerVerdict(q, a);
    const mark = v === true ? "✓" : v === false ? "✗" : "–";
    let detail = "";
    if (typeof a?.free === "string") {
      detail = ` — answered in own words: "${clip(a.free, 120)}"`;
      if (v === false) detail += `; correct: "${clip(q.alternatives[q.correct], 120)}"`;
      if (v === null) detail += " (ungraded)";
    } else if (v === false && a) {
      detail = ` — answered "${clip(q.alternatives[a.pick ?? -1] ?? "?", 120)}"; correct: "${clip(q.alternatives[q.correct], 120)}"`;
    }
    lines.push(`${i + 1}. ${mark} ${clip(q.question, 200)}${detail}`);
  });
  return lines.join("\n");
}

// ---- grading call ------------------------------------------------------

/**
 * Grades ONE free-text answer. Resolves to {correct, comment} or null
 * (service down / quota blocked / unparseable) — the caller renders null as
 * "ungraded", never an error.
 * @param {QuizQuestion} question
 * @param {string} answer
 * @returns {Promise<{correct: boolean, comment: string} | null>}
 */
async function gradeFreeText(question, answer) {
  try {
    const res = await fetch("/api/quiz/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          {
            question: question.question,
            reference: question.alternatives[question.correct],
            answer,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const r = Array.isArray(data?.results) ? data.results[0] : null;
    return r && typeof r.correct === "boolean" ? { correct: r.correct, comment: String(r.comment || "") } : null;
  } catch {
    return null;
  }
}

// ---- DOM ---------------------------------------------------------------

const ALT_LETTERS = "ABCDEFGH";

/**
 * The slice of turns.js's turn object the quiz card uses. `_quizCard` is
 * this module's own idempotence marker on it.
 * @typedef {{el: HTMLElement, stats: HTMLElement, _quizCard?: HTMLElement}} QuizTurn
 */

/**
 * Renders the interactive quiz card into the turn body (before the stats
 * footer). One quiz per turn — a repeat event for the same turn is ignored,
 * matching the panorama's behavior. `hooks`: see the module header.
 * @param {QuizTurn | null | undefined} turn
 * @param {Quiz | null | undefined} quiz
 * @param {QuizHooks} [hooks]
 */
export function renderQuiz(turn, quiz, hooks = {}) {
  if (!turn?.el || turn._quizCard) return;
  const questions = Array.isArray(quiz?.questions) ? quiz.questions : [];
  if (!questions.length || !quiz) return;

  const wrap = document.createElement("div");
  wrap.className = "quiz-card";
  turn.el.insertBefore(wrap, turn.stats);
  turn._quizCard = wrap;

  // Answers given so far (seeded from a stored conversation's embed record).
  const answers = (Array.isArray(hooks.answers) ? hooks.answers : []).slice(0, questions.length);

  // Guards double-answering while the current question's feedback is up (or
  // a grading call is in flight); reset when Next re-renders.
  let settled = false;

  const render = () => {
    wrap.replaceChildren();
    if (quizDone(quiz, answers)) renderVerdict();
    else renderQuestion(answers.length);
  };

  const head = (/** @type {string} */ label) => {
    const h = document.createElement("div");
    h.className = "quiz-head";
    const title = document.createElement("span");
    title.className = "quiz-title";
    title.textContent = quiz.title || "Quiz";
    const progress = document.createElement("span");
    progress.className = "quiz-progress";
    progress.textContent = label;
    h.append(title, progress);
    return h;
  };

  /** @param {number} idx */
  function renderQuestion(idx) {
    const q = questions[idx];
    wrap.appendChild(head(`Question ${idx + 1} of ${questions.length}`));
    const qEl = document.createElement("div");
    qEl.className = "quiz-question";
    qEl.textContent = q.question;
    wrap.appendChild(qEl);

    const alts = document.createElement("div");
    alts.className = "quiz-alts";
    const altBtns = q.alternatives.map((alt, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quiz-alt";
      const letter = document.createElement("span");
      letter.className = "quiz-alt-letter";
      letter.textContent = ALT_LETTERS[i] || String(i + 1);
      const text = document.createElement("span");
      text.textContent = alt;
      btn.append(letter, text);
      btn.addEventListener("click", () => {
        if (settled) return;
        settled = true;
        settle(q, { pick: i }, { altBtns, freeArea, freeBtn });
      });
      alts.appendChild(btn);
      return btn;
    });
    wrap.appendChild(alts);

    // The final alternative: answer in your own words.
    const freeWrap = document.createElement("div");
    freeWrap.className = "quiz-free";
    const freeLabel = document.createElement("div");
    freeLabel.className = "quiz-free-label";
    freeLabel.textContent = "…or answer in your own words:";
    const freeArea = document.createElement("textarea");
    freeArea.className = "quiz-free-input";
    freeArea.rows = 2;
    freeArea.placeholder = "Type your answer";
    const freeBtn = document.createElement("button");
    freeBtn.type = "button";
    freeBtn.className = "quiz-free-submit";
    freeBtn.textContent = "Submit answer";
    freeBtn.addEventListener("click", async () => {
      const text = freeArea.value.trim();
      if (!text || settled) return;
      settled = true;
      freeBtn.disabled = true;
      freeArea.disabled = true;
      for (const b of altBtns) b.disabled = true;
      freeBtn.textContent = "Grading…";
      const graded = await gradeFreeText(q, text);
      settle(
        q,
        { free: text, correct: graded ? graded.correct : null, comment: graded ? graded.comment : "" },
        { altBtns, freeArea, freeBtn },
      );
    });
    freeArea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        freeBtn.click();
      }
    });
    freeWrap.append(freeLabel, freeArea, freeBtn);
    wrap.appendChild(freeWrap);
  }

  /**
   * Record the answer, then show feedback in place: reveal the correct
   * alternative, the verdict for a free-text answer, the explanation, and
   * the Next / See result button.
   * @param {QuizQuestion} q
   * @param {QuizAnswer} answer
   * @param {{altBtns: HTMLButtonElement[], freeArea: HTMLTextAreaElement, freeBtn: HTMLButtonElement}} els
   */
  function settle(q, answer, els) {
    answers.push(answer);
    try {
      hooks.onAnswer?.(answers.slice());
    } catch {
      // persistence problems must never break the quiz interaction
    }
    const verdict = answerVerdict(q, answer);

    for (let i = 0; i < els.altBtns.length; i++) {
      const b = els.altBtns[i];
      b.disabled = true;
      if (i === q.correct) b.classList.add("correct");
      if (typeof answer.pick === "number" && i === answer.pick && verdict === false) b.classList.add("incorrect");
    }
    els.freeArea.disabled = true;
    els.freeBtn.disabled = true;
    els.freeBtn.textContent = "Submit answer";

    const fb = document.createElement("div");
    fb.className = "quiz-feedback " + (verdict === true ? "good" : verdict === false ? "bad" : "ungraded");
    const line = document.createElement("div");
    line.className = "quiz-verdict-line";
    line.textContent = verdict === true ? "✓ Correct" : verdict === false ? "✗ Not quite" : "– Couldn't grade this answer (it won't count toward your score)";
    fb.appendChild(line);
    if (typeof answer.free === "string") {
      const ref = document.createElement("div");
      ref.className = "quiz-reference";
      ref.textContent = (answer.comment ? answer.comment + " " : "") + `Reference answer: ${q.alternatives[q.correct]}`;
      fb.appendChild(ref);
    }
    if (q.explanation) {
      const ex = document.createElement("div");
      ex.className = "quiz-explain";
      ex.textContent = q.explanation;
      fb.appendChild(ex);
    }
    const next = document.createElement("button");
    next.type = "button";
    next.className = "quiz-next";
    next.textContent = answers.length >= questions.length ? "See your result" : "Next question";
    next.addEventListener("click", () => {
      settled = false;
      render();
    });
    fb.appendChild(next);
    wrap.appendChild(fb);
  }

  function renderVerdict() {
    const { correct, total, ungraded } = quizScore(quiz, answers);
    wrap.appendChild(head("Result"));
    const score = document.createElement("div");
    score.className = "quiz-score";
    score.textContent = `You scored ${correct} of ${total}`;
    wrap.appendChild(score);
    if (ungraded) {
      const note = document.createElement("div");
      note.className = "quiz-ungraded-note";
      note.textContent = `${ungraded} written answer${ungraded === 1 ? "" : "s"} couldn't be graded and ${ungraded === 1 ? "isn't" : "aren't"} counted.`;
      wrap.appendChild(note);
    }
    const recap = document.createElement("ol");
    recap.className = "quiz-recap";
    questions.forEach((q, i) => {
      const v = answerVerdict(q, answers[i]);
      const li = document.createElement("li");
      li.className = v === true ? "good" : v === false ? "bad" : "ungraded";
      const mark = document.createElement("span");
      mark.className = "quiz-recap-mark";
      mark.textContent = v === true ? "✓" : v === false ? "✗" : "–";
      const text = document.createElement("span");
      text.textContent = q.question;
      li.append(mark, text);
      if (v === false) {
        const fix = document.createElement("div");
        fix.className = "quiz-recap-fix";
        fix.textContent = `Correct: ${q.alternatives[q.correct]}`;
        li.appendChild(fix);
      }
      recap.appendChild(li);
    });
    wrap.appendChild(recap);
    try {
      hooks.onComplete?.(quizSummaryText(quiz, answers));
    } catch {
      // history/persistence problems must never break the verdict display
    }
  }

  render();
}
