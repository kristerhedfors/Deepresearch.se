import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUIZ_QUESTIONS,
  MAX_QUIZ_QUESTIONS,
  normalizeGradeResults,
  normalizeQuiz,
  quizIntent,
  quizQuestionCount,
  validateGradeItems,
} from "./quiz.js";

// ---- quizIntent --------------------------------------------------------

describe("quizIntent", () => {
  test("detects request phrasings in English and Swedish", () => {
    for (const msg of [
      "quiz me on the French Revolution",
      "Quiz me!",
      "Please quiz me about the attached document",
      "can you make a quiz about chapter 3?",
      "create a quiz from these project files",
      "give me a quiz on Kubernetes networking",
      "förhör mig på kapitlet",
      "quizza mig om andra världskriget",
      "skapa ett quiz om dokumentet",
      "ge mig ett förhör på materialet",
      "test my knowledge of TCP/IP",
      "testa mina kunskaper om EU:s AI-förordning",
      "quiz: the uploaded report",
    ]) {
      assert.ok(quizIntent(msg), `should trigger: ${msg}`);
    }
  });

  test("does not trigger on mere mentions of quizzes or tests", () => {
    for (const msg of [
      "what is a pub quiz?",
      "the quiz last night was fun",
      "how do I write good quiz questions?",
      "what does förhör mean in Swedish law?",
      "run the test suite and report failures",
      "latest research on standardized testing",
      "",
      null,
    ]) {
      assert.equal(quizIntent(msg), null, `should NOT trigger: ${msg}`);
    }
  });

  test("defaults to the standard question count", () => {
    assert.deepEqual(quizIntent("quiz me on X"), { questions: DEFAULT_QUIZ_QUESTIONS });
  });

  test("parses a requested question count (English and Swedish) and clamps it", () => {
    assert.deepEqual(quizIntent("quiz me on X with 8 questions"), { questions: 8 });
    assert.deepEqual(quizIntent("förhör mig med 3 frågor om kapitlet"), { questions: 3 });
    assert.deepEqual(quizIntent("quiz me with 1 question"), { questions: 1 });
    assert.deepEqual(quizIntent("quiz me with 99 questions"), { questions: MAX_QUIZ_QUESTIONS });
  });

  test("survives the first production request verbatim: q→w typo AND words between count and noun", () => {
    // 2026-07-08, ref 614e6f19: this exact message fell through to a plain
    // research answer — "wuiz" defeated the word patterns and "10 varierade
    // frågor" defeated the count parse.
    assert.deepEqual(quizIntent("Bygg en wuiz på 10 varierade frågor från segelflyghandboken"), { questions: 10 });
    assert.deepEqual(quizIntent("wuiz me on chapter 3"), { questions: DEFAULT_QUIZ_QUESTIONS });
  });

  test("quizQuestionCount parses standalone counts with up to two intervening words, else null", () => {
    assert.equal(quizQuestionCount("på 10 varierade frågor"), 10);
    assert.equal(quizQuestionCount("give me 5 really hard questions"), 5);
    assert.equal(quizQuestionCount("quiz me on chapter 12"), null); // a number with no question noun
    assert.equal(quizQuestionCount("no numbers here"), null);
    assert.equal(quizQuestionCount(""), null);
  });
});

// ---- normalizeQuiz -----------------------------------------------------

const q = (over = {}) => ({
  question: "What year did X happen?",
  alternatives: ["1990", "1995", "2001"],
  correct: 1,
  explanation: "Because the source says 1995.",
  ...over,
});

describe("normalizeQuiz", () => {
  test("passes a clean quiz through, trimmed", () => {
    const out = normalizeQuiz({ title: " My quiz ", intro: "Ready?", questions: [q()] });
    assert.equal(out.title, "My quiz");
    assert.equal(out.intro, "Ready?");
    assert.deepEqual(out.questions, [q()]);
  });

  test("returns null when nothing usable came back", () => {
    assert.equal(normalizeQuiz(null), null);
    assert.equal(normalizeQuiz({}), null);
    assert.equal(normalizeQuiz({ questions: [] }), null);
    assert.equal(normalizeQuiz({ questions: [{ question: "", alternatives: ["a", "b"], correct: 0 }] }), null);
  });

  test("accepts `correct` as the alternative's text or a numeric string", () => {
    const byText = normalizeQuiz({ questions: [q({ correct: "1995" })] });
    assert.equal(byText.questions[0].correct, 1);
    const byString = normalizeQuiz({ questions: [q({ correct: "2" })] });
    assert.equal(byString.questions[0].correct, 2);
  });

  test("drops questions with an unresolvable or out-of-range key, keeps the rest", () => {
    const out = normalizeQuiz({
      questions: [q({ correct: 7 }), q({ correct: "not an alternative" }), q({ correct: null }), q()],
    });
    assert.equal(out.questions.length, 1);
    assert.equal(out.questions[0].correct, 1);
  });

  test("dedupes alternatives and drops questions left with fewer than two", () => {
    const out = normalizeQuiz({
      questions: [
        q({ alternatives: ["A", "a ", "B"], correct: 2 }), // dedupes to ["A","B"], correct index 2 now invalid → dropped
        q({ alternatives: ["A", "a"], correct: 0 }), // one alternative after dedup → dropped
        q(),
      ],
    });
    assert.equal(out.questions.length, 1);
  });

  test("caps the question count at the requested maximum", () => {
    const out = normalizeQuiz({ questions: Array.from({ length: 10 }, () => q()) }, 3);
    assert.equal(out.questions.length, 3);
  });

  test("builds a fallback title and intro when the model omits them", () => {
    const out = normalizeQuiz({ questions: [q()] });
    assert.equal(out.title, "Quiz");
    assert.match(out.intro, /1 question/);
    assert.match(out.intro, /score/);
  });

  test("coerces and clips junk field types instead of throwing", () => {
    const out = normalizeQuiz({
      title: 42,
      questions: [q({ question: "  padded  ", explanation: 7, alternatives: ["x".repeat(500), "b", 3] })],
    });
    assert.equal(out.questions[0].question, "padded");
    assert.equal(out.questions[0].explanation, "7");
    assert.equal(out.questions[0].alternatives[0].length, 300);
    assert.equal(out.questions[0].alternatives[2], "3");
  });
});

// ---- validateGradeItems --------------------------------------------------

describe("validateGradeItems", () => {
  const item = { question: "Q?", reference: "R", answer: "my answer" };

  test("accepts a well-formed request", () => {
    const { items, error } = validateGradeItems({ items: [item] });
    assert.equal(error, undefined);
    assert.deepEqual(items, [item]);
  });

  test("rejects missing, empty, or oversized item lists", () => {
    assert.ok(validateGradeItems({}).error);
    assert.ok(validateGradeItems({ items: [] }).error);
    assert.ok(validateGradeItems({ items: Array.from({ length: MAX_QUIZ_QUESTIONS + 1 }, () => item) }).error);
  });

  test("rejects items with a missing field", () => {
    assert.ok(validateGradeItems({ items: [{ ...item, answer: "  " }] }).error);
    assert.ok(validateGradeItems({ items: [{ ...item, question: "" }] }).error);
    assert.ok(validateGradeItems({ items: [item, {}] }).error);
  });

  test("clips oversized fields instead of rejecting them", () => {
    const { items, error } = validateGradeItems({ items: [{ ...item, answer: "x".repeat(5000) }] });
    assert.equal(error, undefined);
    assert.equal(items[0].answer.length, 1000);
  });
});

// ---- normalizeGradeResults -----------------------------------------------

describe("normalizeGradeResults", () => {
  test("passes clean verdicts through, in order", () => {
    const out = normalizeGradeResults({ results: [{ correct: true, comment: "Yes." }, { correct: false }] }, 2);
    assert.deepEqual(out, [
      { correct: true, comment: "Yes." },
      { correct: false, comment: "" },
    ]);
  });

  test("accepts a bare array and pads/nulls junk entries per item", () => {
    const out = normalizeGradeResults([{ correct: true }, { correct: "yes" }], 3);
    assert.deepEqual(out, [{ correct: true, comment: "" }, null, null]);
  });

  test("returns null when no verdict at all is usable", () => {
    assert.equal(normalizeGradeResults(null, 1), null);
    assert.equal(normalizeGradeResults({ verdicts: [] }, 1), null);
    assert.equal(normalizeGradeResults({ results: [{ correct: "yes" }] }, 1), null);
  });
});
