// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — same reason as slash.test.js.)
// The #XP starter tag, end to end through the real pipeline (feedback #37).
//
// An evaluation-mode starter chip prepends `#XP-07` to the question it sends
// (public/js/starters.js) so a reviewer's later feedback is tied to the exact
// starter. Two things have to be true at once, and a unit test on either half
// alone would miss the other:
//
//   · the pipeline REMEMBERS the tag (state.starterRef — chat.js puts it on the
//     chat-log row and the feedback entry), and
//   · nothing downstream SEES it: the question the developers read, and the
//     text every phase plans against, are the starter's own words.
//
// The feedback route is the seam that proves it without a model call: it is
// fully deterministic (no LLM anywhere, owner directive 2026-07-24) and it
// exposes the derived question on state.feedback.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "./pipeline.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

const STARTER = "Where does your own source code live in this environment, and how do you retrieve it?";

function stateFor() {
  return {
    startedAt: Date.now(), model: "m", jsonModel: "jm", webSearch: false, searchSource: "",
    ext: {}, introspection: false, introspectionCount: 0, vision: false, visionModels: [],
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 }, imageLocations: [], shellTranscript: [],
    totals: { prompt_tokens: 0, completion_tokens: 0 }, jsonTotals: { prompt_tokens: 0, completion_tokens: 0 },
    searchCount: 0, sources: [], budgetS: 60, plan: {},
    answerPhase: null,
    feedbackCapture: true,
  };
}

/** A reviewer's conversation: a tagged starter, an answer, then feedback on it. */
function conversation(opening) {
  return [
    { role: "user", content: opening },
    { role: "assistant", content: "…the answer the reviewer is about to judge…" },
    { role: "user", content: "feedback this answer never named a single file" },
  ];
}

describe("the #XP tag reaches the record and nothing else", () => {
  test("a tagged starter is remembered on the state and stripped from the question", async () => {
    const state = stateFor();
    await runPipeline(
      /** @type {any} */ ({}), log, () => {},
      conversation(`#XP-07 ${STARTER}`), "m", /** @type {any} */ (state),
    );
    assert.deepEqual(state.starterRef, { xp: 7, tag: "#XP-07" },
      "chat.js reads the tag off the state for the chat-log row and the feedback entry");
    assert.ok(state.feedback, "the feedback route ran");
    assert.equal(state.feedback.question, STARTER,
      "the developers read the starter's own words, not the starter plus a code");
  });

  test("an untagged conversation leaves no starter ref behind", async () => {
    const state = stateFor();
    await runPipeline(
      /** @type {any} */ ({}), log, () => {},
      conversation(STARTER), "m", /** @type {any} */ (state),
    );
    assert.equal(state.starterRef, undefined);
    assert.equal(state.feedback.question, STARTER);
  });

  test("the ordinary visitor path is untouched — a bare '#7' is not a starter tag", async () => {
    // `#7` belongs to the use-case grammar (testpoints-core.js). If the starter
    // grammar claimed it too, every "feedback #7 …" note would lose its use case.
    const state = stateFor();
    await runPipeline(
      /** @type {any} */ ({}), log, () => {},
      conversation(`#7 ${STARTER}`), "m", /** @type {any} */ (state),
    );
    assert.equal(state.starterRef, undefined);
    assert.equal(state.feedback.question, `#7 ${STARTER}`);
  });
});
