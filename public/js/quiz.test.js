import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { answerVerdict, quizDone, quizScore, quizSummaryText } from "./quiz.js";

const quiz = {
  title: "Nordic capitals",
  questions: [
    { question: "Capital of Sweden?", alternatives: ["Oslo", "Stockholm", "Malmö"], correct: 1, explanation: "" },
    { question: "Capital of Norway?", alternatives: ["Oslo", "Bergen"], correct: 0, explanation: "" },
    { question: "Capital of Denmark?", alternatives: ["Aarhus", "Copenhagen"], correct: 1, explanation: "" },
  ],
};

describe("answerVerdict", () => {
  test("grades multiple-choice picks against the correct index", () => {
    assert.equal(answerVerdict(quiz.questions[0], { pick: 1 }), true);
    assert.equal(answerVerdict(quiz.questions[0], { pick: 0 }), false);
  });

  test("free-text answers carry their graded verdict; ungraded is null", () => {
    assert.equal(answerVerdict(quiz.questions[0], { free: "stockholm", correct: true, comment: "" }), true);
    assert.equal(answerVerdict(quiz.questions[0], { free: "oslo", correct: false, comment: "" }), false);
    assert.equal(answerVerdict(quiz.questions[0], { free: "stockholm", correct: null, comment: "" }), null);
  });

  test("missing question or answer is null, never a throw", () => {
    assert.equal(answerVerdict(undefined, { pick: 1 }), null);
    assert.equal(answerVerdict(quiz.questions[0], undefined), null);
    assert.equal(answerVerdict(quiz.questions[0], {}), null);
  });
});

describe("quizScore / quizDone", () => {
  test("counts correct answers and tracks ungraded free text separately", () => {
    const answers = [{ pick: 1 }, { free: "Oslo", correct: null, comment: "" }, { pick: 0 }];
    assert.deepEqual(quizScore(quiz, answers), { correct: 1, total: 3, ungraded: 1 });
  });

  test("partial progress is not done; full is", () => {
    assert.equal(quizDone(quiz, [{ pick: 1 }]), false);
    assert.equal(quizDone(quiz, [{ pick: 1 }, { pick: 0 }, { pick: 1 }]), true);
    assert.equal(quizDone({ questions: [] }, []), false);
  });
});

describe("quizSummaryText", () => {
  test("produces the score header and one marked line per question", () => {
    const answers = [
      { pick: 1 },
      { pick: 1 }, // wrong (correct is 0)
      { free: "København", correct: true, comment: "" },
    ];
    const s = quizSummaryText(quiz, answers);
    const lines = s.split("\n");
    assert.equal(lines[0], '[Quiz completed: "Nordic capitals" — score 2/3]');
    assert.match(lines[1], /^1\. ✓ Capital of Sweden\?$/);
    assert.match(lines[2], /^2\. ✗ Capital of Norway\? — answered "Bergen"; correct: "Oslo"$/);
    assert.match(lines[3], /^3\. ✓ Capital of Denmark\? — answered in own words: "København"$/);
  });

  test("notes ungraded written answers in the header and marks their lines", () => {
    const answers = [{ pick: 1 }, { pick: 0 }, { free: "?", correct: null, comment: "" }];
    const s = quizSummaryText(quiz, answers);
    assert.match(s, /score 2\/3 \(1 written answer could not be graded\)/);
    assert.match(s, /3\. – .*\(ungraded\)/);
  });

  test("an incorrect written answer shows the correct alternative", () => {
    const answers = [{ pick: 1 }, { pick: 0 }, { free: "Aarhus is the capital", correct: false, comment: "" }];
    const s = quizSummaryText(quiz, answers);
    assert.match(s, /3\. ✗ .*answered in own words: "Aarhus is the capital"; correct: "Copenhagen"/);
  });
});
